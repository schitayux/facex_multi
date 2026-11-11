# -*- coding: utf-8 -*-
"""Página web de la compañía (2026-11-04).

Solo para compañías con «Tiene página web» en FacEx Configuracion Compania, y
solo para usuarios con «Ver pedidos en línea» / «Configurar la página web» en
su FacEx Settings (deny-by-default, ver permissions.pagina_web_habilitada).
Las demás compañías no ven nada de esto.

1. Categorías automáticas: al crear o editar un producto de la compañía se le
   asigna el grupo de la primera regla (tabla «Reglas» de la configuración)
   cuyas palabras aparezcan en su nombre. Un grupo que ya esté dentro del grupo
   raíz del catálogo se respeta (lo eligió alguien a mano).
2. Catálogo: los productos de la compañía marcados «Publicar en la página web»
   que estén bajo el grupo raíz se mandan a https://<dominio>/api/recibir.php
   (primero las imágenes que falten, después catalogo.json). Se manda solo
   cuando algo cambia, y cada 10 minutos si el catálogo cambió sin avisar.
3. Pedidos en línea: el carrito de la página manda el pedido (api/pedido.php →
   `pedido`, firmado). Se guarda como «FacEx Pedido en Linea» y se arma su
   COTIZACIÓN, que en FacEx es una factura en borrador (save_draft, como Live).
   El personal la revisa y la valida en FacEx como cualquier otra.

Firma: X-Puente-Empresa (abreviatura), X-Puente-Tiempo (hora unix) y
X-Puente-Firma = HMAC-SHA256(llave, "tiempo\\nruta\\ncuerpo"); la llave está en
la configuración de la compañía y en api/config.php de la página.
"""
import hashlib
import hmac
import json
import os
import re
import time
import unicodedata
from contextlib import contextmanager
from urllib.parse import urlencode

import frappe
import requests
from frappe.rate_limiter import rate_limit
from frappe.utils import cint, flt, get_datetime, now_datetime, strip_html
from frappe.utils.password import get_decrypted_password

CONFIG = "FacEx Configuracion Compania"
PEDIDO = "FacEx Pedido en Linea"
AGENTE = "FacExPuente/1.0"  # ModSecurity de algunos hostings rechaza «python-requests»
TOLERANCIA_FIRMA = 300  # segundos
LADO_MAXIMO = 1600  # px de las imágenes que se mandan a la página
MAX_IMAGENES = 8  # por producto (la principal primero)
NO_ES_IMAGEN = "-"
MAX_LINEAS = 60
MAX_CANTIDAD = 9999
# Lo que ve el cliente en la página según el estado del pedido.
ESTADO_PUBLICO = {
    "Recibido": "Recibido",
    "Cotizado": "En revisión",
    "Facturado": "Confirmado",
    "Cancelado": "Cancelado",
}


# ---------------------------------------------------------------------------
# Campos y configuración
# ---------------------------------------------------------------------------

def ensure_pagina_web_fields():
    """after_migrate: campos de la página web en Item y Sales Invoice. Idempotente."""
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    create_custom_fields(
        {
            "Item": [
                {
                    "fieldname": "facex_publicar_web",
                    "fieldtype": "Check",
                    "label": "Publicar en la página web",
                    "default": "1",
                    "insert_after": "item_group",
                    "description": "Solo si la compañía del producto tiene página web (Configuración de la Compañía).",
                    "module": "FacEx Multi",
                }
            ],
            "Sales Invoice": [
                {
                    "fieldname": "facex_pedido_en_linea",
                    "fieldtype": "Link",
                    "options": PEDIDO,
                    "label": "Pedido en línea",
                    "insert_after": "customer_name",
                    "read_only": 1,
                    "no_copy": 1,
                    "depends_on": "eval:doc.facex_pedido_en_linea",
                    "module": "FacEx Multi",
                }
            ],
        }
    )


def _tiene_campos() -> bool:
    return frappe.get_meta(CONFIG).has_field("pagina_web_activa")


def companias_con_pagina() -> list:
    if not frappe.db.table_exists(CONFIG) or not _tiene_campos():
        return []
    return frappe.get_all(CONFIG, filters={"pagina_web_activa": 1}, pluck="company")


@frappe.whitelist()
def compania_tiene_pagina(company: str) -> bool:
    """Para mostrar u ocultar la sección «Página web» de FacEx Settings."""
    from facex_multi.api.permissions import pagina_web_habilitada

    return pagina_web_habilitada(company)


def _conf(company: str) -> frappe._dict:
    campos = [
        "pagina_web_activa", "pagina_web_dominio", "pagina_web_usuario", "pagina_web_vendedor",
        "pagina_web_mostrar_precios", "pagina_web_lista_precios", "pagina_web_grupo_raiz",
        "pagina_web_grupo_sin_clasificar", "pagina_web_huella",
    ]
    v = frappe.db.get_value(CONFIG, company, campos, as_dict=True) or frappe._dict()
    dominio = re.sub(r"^https?://", "", (v.pagina_web_dominio or "").strip()).strip("/")
    return frappe._dict(
        company=company,
        activa=cint(v.pagina_web_activa),
        dominio=dominio,
        url=f"https://{dominio}" if dominio else "",
        llave=get_decrypted_password(CONFIG, company, "pagina_web_llave", raise_exception=False) or "",
        usuario=v.pagina_web_usuario,
        vendedor=v.pagina_web_vendedor,
        mostrar_precios=cint(v.pagina_web_mostrar_precios),
        lista_precios=v.pagina_web_lista_precios,
        raiz=v.pagina_web_grupo_raiz,
        sin_clasificar=v.pagina_web_grupo_sin_clasificar,
        huella=v.pagina_web_huella or "",
    )


def _exigir(company: str, flag: str):
    from facex_multi.api.invoice import get_effective_company
    from facex_multi.api.permissions import require_facex_permission

    company = get_effective_company(company)
    require_facex_permission(company, flag, msg="No tiene permiso para la página web en esta compañía.")
    return company


# ---------------------------------------------------------------------------
# Categorías automáticas
# ---------------------------------------------------------------------------

def _norm(texto) -> str:
    return unicodedata.normalize("NFD", str(texto or "").upper()).encode("ascii", "ignore").decode()


def _tokens(texto) -> list:
    return re.findall(r"[A-Z0-9]+", _norm(texto))


def _esta(palabra: str, tokens: list) -> bool:
    return any(t.startswith(palabra) for t in tokens)


def _reglas(company: str) -> list:
    return frappe.get_all(
        "FacEx Pagina Web Regla",
        filters={"parent": company, "parenttype": CONFIG, "activa": 1},
        fields=["palabras", "excluir", "grupo"],
        order_by="idx asc",
    )


def regla_que_aplica(nombre: str, reglas: list):
    """Primera regla cuyas palabras están todas en el nombre (y ninguna de «excluir»)."""
    tokens = _tokens(nombre)
    for r in reglas:
        palabras = _tokens(r.palabras)
        if not palabras or not all(_esta(p, tokens) for p in palabras):
            continue
        if any(_esta(p, tokens) for p in _tokens(r.excluir)):
            continue
        return r
    return None


def _rango(grupo: str):
    return frappe.db.get_value("Item Group", grupo, ["lft", "rgt"]) if grupo else None


def _bajo(grupo: str, raiz: str) -> bool:
    """¿`grupo` es `raiz` o está dentro de él?"""
    r, g = _rango(raiz), _rango(grupo)
    return bool(r and g and r[0] <= g[0] and g[1] <= r[1])


def grupo_sugerido(company: str, nombre: str, actual: str = None, conf=None, reglas=None):
    """Grupo que le toca a un producto, o None si se deja como está."""
    conf = conf or _conf(company)
    if not conf.activa:
        return None
    if actual and conf.raiz and _bajo(actual, conf.raiz):
        return None  # ya está en el catálogo: lo eligió alguien a mano
    reglas = _reglas(company) if reglas is None else reglas
    if not reglas:
        return None
    r = regla_que_aplica(nombre, reglas)
    if r:
        return r.grupo if r.grupo != actual else None
    return conf.sin_clasificar if conf.sin_clasificar and conf.sin_clasificar != actual else None


def asignar_grupo(doc, method=None):
    """Hook Item.validate: grupo automático para los productos de compañías con página web."""
    company = doc.get("bfel_company")
    if not company or not _tiene_campos() or company not in companias_con_pagina():
        return
    nuevo = grupo_sugerido(company, doc.item_name or doc.item_code, doc.item_group)
    if nuevo:
        doc.item_group = nuevo


@frappe.whitelist()
def vista_previa_categorias(company: str = None) -> dict:
    """Qué grupo le tocaría a cada producto de la compañía (no cambia nada)."""
    company = _exigir(company, "pagina_web_gestionar")
    conf, reglas = _conf(company), _reglas(company)
    filas = []
    for i in frappe.get_all(
        "Item", filters={"bfel_company": company, "disabled": 0}, fields=["name", "item_name", "item_group"],
        order_by="item_name asc",
    ):
        nuevo = grupo_sugerido(company, i.item_name or i.name, i.item_group, conf=conf, reglas=reglas)
        if nuevo:
            filas.append({"item_code": i.name, "item_name": i.item_name, "actual": i.item_group, "nuevo": nuevo})
    return {"cambios": filas, "total_productos": frappe.db.count("Item", {"bfel_company": company, "disabled": 0})}


@frappe.whitelist()
def aplicar_categorias(items, company: str = None) -> dict:
    """Aplica la vista previa a los productos elegidos (solo cambia su grupo)."""
    company = _exigir(company, "pagina_web_gestionar")
    items = frappe.parse_json(items) if isinstance(items, str) else (items or [])
    conf, reglas = _conf(company), _reglas(company)
    hechos = 0
    for codigo in items:
        i = frappe.db.get_value("Item", codigo, ["name", "item_name", "item_group", "bfel_company"], as_dict=True)
        if not i or i.bfel_company != company:
            continue
        nuevo = grupo_sugerido(company, i.item_name or i.name, i.item_group, conf=conf, reglas=reglas)
        if nuevo:
            frappe.db.set_value("Item", i.name, "item_group", nuevo)
            hechos += 1
    frappe.db.commit()
    programar_compania(company)
    return {"cambiados": hechos}


def importar_preset(company: str, ruta: str, aplicar: int = 0) -> dict:
    """Solo desde consola (bench execute): crea el árbol de grupos y las reglas
    de un archivo JSON {"raiz", "sin_clasificar", "grupos": [[nombre, padre, es_grupo]],
    "reglas": [[palabras, excluir, grupo]]} y, con `aplicar`, clasifica los productos."""
    from frappe.utils.nestedset import get_root_of

    datos = json.load(open(ruta))
    raiz_arbol = get_root_of("Item Group")
    for nombre, padre, es_grupo in datos["grupos"]:
        if not frappe.db.exists("Item Group", nombre):
            frappe.get_doc({"doctype": "Item Group", "item_group_name": nombre, "parent_item_group": padre or raiz_arbol,
                            "is_group": cint(es_grupo)}).insert(ignore_permissions=True)
    conf = frappe.get_doc(CONFIG, company)
    conf.pagina_web_grupo_raiz = datos["raiz"]
    conf.pagina_web_grupo_sin_clasificar = datos["sin_clasificar"]
    conf.set("pagina_web_reglas", [{"palabras": p, "excluir": e or "", "grupo": g, "activa": 1} for p, e, g in datos["reglas"]])
    conf.save(ignore_permissions=True)
    frappe.db.commit()
    resultado = {"grupos": len(datos["grupos"]), "reglas": len(datos["reglas"])}
    if cint(aplicar):
        reglas, c = _reglas(company), _conf(company)
        cambios = 0
        for i in frappe.get_all("Item", filters={"bfel_company": company}, fields=["name", "item_name", "item_group"]):
            nuevo = grupo_sugerido(company, i.item_name or i.name, i.item_group, conf=c, reglas=reglas)
            if nuevo:
                frappe.db.set_value("Item", i.name, "item_group", nuevo)
                cambios += 1
        frappe.db.commit()
        resultado["productos_clasificados"] = cambios
    return resultado


# ---------------------------------------------------------------------------
# Firma y envío a la página
# ---------------------------------------------------------------------------

def firmar(llave: str, tiempo: str, ruta: str, cuerpo: bytes) -> str:
    mensaje = f"{tiempo}\n{ruta}\n".encode() + (cuerpo or b"")
    return hmac.new(llave.encode(), mensaje, hashlib.sha256).hexdigest()


class ErrorWeb(Exception):
    pass


def _enviar(c, accion: str, cuerpo: bytes, **params) -> dict:
    consulta = urlencode({"accion": accion, **params})
    tiempo = str(int(time.time()))
    try:
        r = requests.post(
            f"{c.url}/api/recibir.php?{consulta}",
            data=cuerpo,
            headers={
                "User-Agent": AGENTE,
                "Content-Type": "application/octet-stream",
                "X-Puente-Tiempo": tiempo,
                "X-Puente-Firma": firmar(c.llave, tiempo, consulta, cuerpo),
            },
            timeout=60,
        )
    except requests.RequestException as e:
        raise ErrorWeb(f"No se pudo conectar con la página: {e.__class__.__name__}") from e
    try:
        datos = r.json()
    except ValueError:
        datos = {}
    if r.status_code != 200 or not datos.get("ok"):
        raise ErrorWeb(f"La página respondió {r.status_code} a «{accion}»: {datos.get('error') or r.text[:200]}")
    return datos


def _verificar(ruta: str):
    """Mensaje de la página: compañía (por su abreviatura), firma y hora. Devuelve (conf, datos)."""
    abbr = (frappe.get_request_header("X-Puente-Empresa") or "").strip()
    tiempo = frappe.get_request_header("X-Puente-Tiempo") or ""
    firma = frappe.get_request_header("X-Puente-Firma") or ""
    cuerpo = frappe.request.get_data() or b""
    company = frappe.db.get_value("Company", {"abbr": abbr}, "name") if abbr else None
    c = _conf(company) if company and _tiene_campos() else None
    if (
        not c or not c.activa or not c.llave or not tiempo.isdigit()
        or abs(time.time() - int(tiempo)) > TOLERANCIA_FIRMA
        or not hmac.compare_digest(firmar(c.llave, tiempo, ruta, cuerpo), firma)
    ):
        frappe.throw("Firma no válida.", frappe.PermissionError)
    try:
        return c, json.loads(cuerpo or b"{}")
    except ValueError:
        frappe.throw("Mensaje no válido.")


# ---------------------------------------------------------------------------
# Catálogo
# ---------------------------------------------------------------------------

def _ruta_archivo(url):
    if not url:
        return None
    if url.startswith("/files/"):
        ruta = frappe.get_site_path("public", "files", url[len("/files/"):])
    elif url.startswith("/private/files/"):
        ruta = frappe.get_site_path("private", "files", url[len("/private/files/"):])
    else:
        return None
    ruta = os.path.realpath(ruta)
    if not ruta.startswith(os.path.realpath(frappe.get_site_path())) or not os.path.isfile(ruta):
        return None
    return ruta


def _reducir(ruta: str):
    from io import BytesIO

    from PIL import Image, ImageOps

    try:
        with Image.open(ruta) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA", "P"):
                im = im.convert("RGBA")
                fondo = Image.new("RGB", im.size, (255, 255, 255))
                fondo.paste(im, mask=im.split()[-1])
                im = fondo
            elif im.mode != "RGB":
                im = im.convert("RGB")
            im.thumbnail((LADO_MAXIMO, LADO_MAXIMO), Image.LANCZOS)
            # Lienzo cuadrado blanco con la imagen centrada (sin agrandarla):
            # el catálogo se ve parejo aunque las fotos tengan proporciones distintas.
            lado = max(im.size)
            if im.size != (lado, lado):
                lienzo = Image.new("RGB", (lado, lado), (255, 255, 255))
                lienzo.paste(im, ((lado - im.width) // 2, (lado - im.height) // 2))
                im = lienzo
            salida = BytesIO()
            im.save(salida, "JPEG", quality=84, optimize=True, progressive=True)
            return salida.getvalue()
    except Exception:
        return None


def _imagen(url, imagenes: dict):
    """Imagen lista para la página (máx. 1600 px, JPEG): su nombre allá o None."""
    ruta = _ruta_archivo(url)
    if not ruta:
        return None
    st = os.stat(ruta)
    clave = f"facex_web_img:v2:{ruta}:{st.st_mtime_ns}:{st.st_size}"  # v2: lienzo cuadrado
    carpeta = frappe.get_site_path("private", "facex_pagina_web")
    nombre = frappe.cache.get_value(clave)
    if nombre == NO_ES_IMAGEN:
        return None
    if not nombre or not os.path.isfile(os.path.join(carpeta, nombre)):
        datos = _reducir(ruta)
        if not datos:
            frappe.cache.set_value(clave, NO_ES_IMAGEN, expires_in_sec=30 * 24 * 3600)
            return None
        nombre = hashlib.sha256(datos).hexdigest()[:24] + ".jpg"
        os.makedirs(carpeta, exist_ok=True)
        with open(os.path.join(carpeta, nombre), "wb") as f:
            f.write(datos)
        frappe.cache.set_value(clave, nombre, expires_in_sec=30 * 24 * 3600)
    imagenes[nombre] = os.path.join(carpeta, nombre)
    return nombre


def _huella_visual(nombre: str, ruta):
    """dHash de 64 bits de la imagen ya reducida (en caché: el nombre es el hash del contenido)."""
    if not ruta:
        return None
    clave = f"facex_web_dhash:{nombre}"
    h = frappe.cache.get_value(clave)
    if h is not None:
        return int(h) if h != NO_ES_IMAGEN else None
    from PIL import Image

    try:
        with Image.open(ruta) as im:
            px = list(im.convert("L").resize((9, 8), Image.LANCZOS).getdata())
        h = 0
        for fila in range(8):
            for col in range(8):
                h = (h << 1) | (px[fila * 9 + col] > px[fila * 9 + col + 1])
    except Exception:
        frappe.cache.set_value(clave, NO_ES_IMAGEN, expires_in_sec=30 * 24 * 3600)
        return None
    frappe.cache.set_value(clave, str(h), expires_in_sec=30 * 24 * 3600)
    return h


def _parecidas(a: int, b: int) -> bool:
    return bin(a ^ b).count("1") <= 6


def _sin_sufijo(nombre: str, abbr: str) -> str:
    return re.sub(rf"\s*-\s*{re.escape(abbr)}$", "", nombre or "") if abbr else (nombre or "")


def _slug(texto: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", _norm(texto).lower()).strip("-")


def armar_catalogo(company: str):
    """(catálogo, {imagen: ruta}). Solo datos públicos de la compañía."""
    c = _conf(company)
    abbr = frappe.get_cached_value("Company", company, "abbr")
    imagenes = {}
    rango = _rango(c.raiz)
    if not rango:
        return {"version": 1, "empresa": abbr, "categorias": [], "productos": []}, imagenes
    grupos = frappe.get_all(
        "Item Group",
        filters={"lft": [">=", rango[0]], "rgt": ["<=", rango[1]]},
        fields=["name", "parent_item_group", "lft", "is_group"],
        order_by="lft asc",
    )
    en_catalogo = {g.name for g in grupos} - {c.raiz}
    precios = {}
    if c.mostrar_precios and c.lista_precios:
        precios = {
            p.item_code: flt(p.price_list_rate)
            for p in frappe.get_all("Item Price", filters={"price_list": c.lista_precios, "selling": 1},
                                    fields=["item_code", "price_list_rate"], order_by="valid_from asc")
        }
    productos, por_grupo = [], {}
    items = frappe.get_all(
        "Item",
        filters={"bfel_company": company, "disabled": 0, "is_sales_item": 1, "facex_publicar_web": 1,
                 "item_group": ["in", list(en_catalogo) or [""]]},
        fields=["name", "item_name", "item_group", "description", "stock_uom", "image"],
        order_by="item_name asc",
    )
    # Galería: imagen principal primero y después las demás imágenes del producto.
    from facex_multi.api.item_imagenes import es_extension_web

    adjuntas = {}
    if items:
        for f in frappe.get_all(
            "File",
            filters={"attached_to_doctype": "Item", "attached_to_name": ["in", [i.name for i in items]]},
            fields=["attached_to_name", "file_name", "file_url"],
            order_by="creation asc",
        ):
            if es_extension_web(f.file_name or f.file_url):
                adjuntas.setdefault(f.attached_to_name, []).append(f.file_url)
    for i in items:
        nombres_img, vistas = [], []
        for url in [i.image] + adjuntas.get(i.name, []):
            n = _imagen(url, imagenes) if url else None
            if not n or n in nombres_img:
                continue
            h = _huella_visual(n, imagenes.get(n))
            if h is not None and any(_parecidas(h, v) for v in vistas):
                continue  # la misma foto subida otra vez (otro tamaño o formato)
            nombres_img.append(n)
            if h is not None:
                vistas.append(h)
            if len(nombres_img) >= MAX_IMAGENES:
                break
        descripcion = strip_html(i.description or "").strip()
        fila = {
            "id": f"p-{i.name}",
            "codigo": i.name,
            "nombre": i.item_name,
            "descripcion": "" if _norm(descripcion) == _norm(i.item_name) else descripcion,
            "categoria": _slug(_sin_sufijo(i.item_group, abbr)),
            "unidad": i.stock_uom,
            "imagenes": nombres_img,
        }
        if c.mostrar_precios:
            fila["precio"] = precios.get(i.name)
        productos.append(fila)
        por_grupo[i.item_group] = por_grupo.get(i.item_group, 0) + 1
    categorias = [
        {
            "id": _slug(_sin_sufijo(g.name, abbr)),
            "nombre": _sin_sufijo(g.name, abbr),
            "padre": None if g.parent_item_group == c.raiz else _slug(_sin_sufijo(g.parent_item_group, abbr)),
            "productos": por_grupo.get(g.name, 0),
        }
        for g in grupos if g.name in en_catalogo
    ]
    catalogo = {
        "version": 1,
        "empresa": abbr,
        "nombre": frappe.get_cached_value("Company", company, "company_name"),
        "muestra_precios": bool(c.mostrar_precios),
        "moneda": frappe.get_cached_value("Company", company, "default_currency") or "GTQ",
        "categorias": categorias,
        "productos": productos,
    }
    return catalogo, imagenes


def _huella(catalogo: dict) -> str:
    return hashlib.sha256(json.dumps(catalogo, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _guardar_estado(company: str, texto: str, huella: str = None):
    valores = {"pagina_web_ultimo_envio": now_datetime(), "pagina_web_estado": texto[:1000]}
    if huella is not None:
        valores["pagina_web_huella"] = huella
    frappe.db.set_value(CONFIG, company, valores, update_modified=False)


def publicar(company: str, forzar: int = 0) -> dict:
    """Manda el catálogo de la compañía a su página si cambió (o siempre, con `forzar`)."""
    c = _conf(company)
    if not c.activa:
        return {"ok": False, "mensaje": "La compañía no tiene la página web activada."}
    if not c.dominio or not c.llave:
        return {"ok": False, "mensaje": "Falta el dominio o la llave de la página web."}
    from frappe.utils.synchronization import filelock

    with filelock(f"facex_pagina_web_{frappe.scrub(company)}", timeout=120):
        catalogo, imagenes = armar_catalogo(company)
        huella = _huella(catalogo)
        if not cint(forzar) and huella == _conf(company).huella:
            return {"ok": True, "sin_cambios": True, "mensaje": "La página ya tiene el catálogo al día."}
        try:
            faltan = _enviar(c, "faltantes", json.dumps(sorted(imagenes)).encode()).get("faltan") or []
            for nombre in faltan:
                if nombre in imagenes:
                    with open(imagenes[nombre], "rb") as f:
                        _enviar(c, "imagen", f.read(), nombre=nombre)
            catalogo["generado"] = now_datetime().isoformat(timespec="seconds")
            _enviar(c, "catalogo", json.dumps(catalogo, ensure_ascii=False).encode())
        except ErrorWeb as e:
            _guardar_estado(company, f"Error: {e}")
            frappe.db.commit()
            frappe.log_error(title=f"Página web: no se pudo publicar el catálogo de {company}", message=str(e))
            return {"ok": False, "mensaje": str(e)}
        texto = f"Enviado: {len(catalogo['productos'])} productos en {len(catalogo['categorias'])} categorías, {len(faltan)} imágenes nuevas."
        _guardar_estado(company, texto, huella)
        frappe.db.commit()
        return {"ok": True, "mensaje": texto}


def programar_compania(company: str):
    if company not in companias_con_pagina():
        return
    frappe.enqueue(
        "facex_multi.api.pagina_web.publicar",
        queue="short",
        company=company,
        job_id=f"facex_pagina_web:{company}",
        deduplicate=True,
        enqueue_after_commit=True,
    )


def programar(doc=None, method=None):
    """Hooks: algo del catálogo cambió → se publica en segundo plano."""
    if frappe.flags.in_install or frappe.flags.in_migrate or frappe.flags.in_import or frappe.flags.in_patch:
        return
    if not _tiene_campos():
        return
    if doc is not None and doc.doctype == "Item":
        if doc.get("bfel_company"):
            programar_compania(doc.bfel_company)
        return
    if doc is not None and doc.doctype == CONFIG:
        if cint(doc.get("pagina_web_activa")):
            programar_compania(doc.company)
        return
    for company in companias_con_pagina():  # grupos de ítems: los comparten todas
        programar_compania(company)


def tarea():
    """Cada 10 minutos: publica el catálogo de las compañías con página si cambió."""
    for company in companias_con_pagina():
        try:
            publicar(company)
        except Exception:
            frappe.log_error(title=f"Página web: error al publicar {company}")


@frappe.whitelist()
def publicar_ahora(company: str = None) -> dict:
    company = _exigir(company, "pagina_web_gestionar")
    return publicar(company, forzar=1)


@frappe.whitelist()
def generar_llave() -> str:
    """Llave nueva para copiar en api/config.php de la página (solo System Manager)."""
    frappe.only_for("System Manager")
    return frappe.generate_hash(length=48)


# ---------------------------------------------------------------------------
# Pedidos en línea
# ---------------------------------------------------------------------------

def _texto(valor, largo=140) -> str:
    return re.sub(r"\s+", " ", str(valor or "")).strip()[:largo]


@contextmanager
def _como(usuario: str):
    anterior = frappe.session.user
    frappe.set_user(usuario)
    try:
        yield
    finally:
        frappe.set_user(anterior)


def crear_pedido(c, datos: dict) -> dict:
    if datos.get("sitio_web"):  # campo trampa: lo llenan los robots
        frappe.throw("No se pudo procesar el pedido.")
    comprador = datos.get("comprador") or {}
    nombre = _texto(comprador.get("nombre"))
    empresa = _texto(comprador.get("empresa"))
    correo = _texto(comprador.get("correo")).lower()
    telefono = _texto(comprador.get("telefono"), 30)
    nit = re.sub(r"[\s-]", "", _texto(comprador.get("nit"), 20)).upper() or "CF"
    if not nombre:
        frappe.throw("Escriba su nombre.")
    if not correo or not frappe.utils.validate_email_address(correo):
        frappe.throw("Escriba un correo válido.")
    if not telefono:
        frappe.throw("Escriba su teléfono.")
    if nit != "CF" and not re.fullmatch(r"\d{1,12}K?", nit):
        frappe.throw("El NIT no es válido (solo números y, al final, K). Si no tiene, deje CF.")

    articulos = datos.get("articulos") or []
    if not isinstance(articulos, list) or not 1 <= len(articulos) <= MAX_LINEAS:
        frappe.throw("Agregue al menos un producto (máximo %s)." % MAX_LINEAS)
    rango = _rango(c.raiz)
    lineas, vistos = [], set()
    for a in articulos:
        codigo = _texto(a.get("id"), 160)
        codigo = codigo[2:] if codigo.startswith("p-") else codigo
        cantidad = flt(a.get("q"))
        if codigo in vistos:
            continue
        vistos.add(codigo)
        i = frappe.db.get_value(
            "Item", codigo,
            ["name", "item_name", "stock_uom", "disabled", "bfel_company", "facex_publicar_web", "item_group"],
            as_dict=True,
        )
        if not i or i.disabled or i.bfel_company != c.company or not i.facex_publicar_web or not rango or not _bajo(i.item_group, c.raiz):
            frappe.throw("Uno de los productos ya no está disponible. Actualice la página e intente de nuevo.")
        if not 0 < cantidad <= MAX_CANTIDAD:
            frappe.throw(f"La cantidad de «{i.item_name}» no es válida.")
        lineas.append({"item_code": i.name, "descripcion": i.item_name, "cantidad": cantidad, "uom": i.stock_uom})

    p = frappe.get_doc({
        "doctype": PEDIDO,
        "company": c.company,
        "abbr": frappe.get_cached_value("Company", c.company, "abbr"),
        "estado": "Recibido",
        "recibido_el": now_datetime(),
        "token": frappe.generate_hash(length=32),
        "comprador_nombre": nombre,
        "empresa_cliente": empresa,
        "nit": nit,
        "correo": correo,
        "telefono": telefono,
        "direccion": _texto(datos.get("direccion"), 300),
        "comentario": _texto(datos.get("comentario"), 1000),
        "articulos": lineas,
    })
    p.insert(ignore_permissions=True)
    frappe.db.commit()
    cotizar(p.name)
    p.reload()
    _avisar(p)
    return {"pedido": p.name, "token": p.token}


def _cliente(c, p) -> str:
    """Cliente FacEx de la compañía: por NIT, si ya existe; si no, se crea con la función de FacEx."""
    if p.nit != "CF":
        existente = frappe.db.sql(
            """SELECT name FROM `tabCustomer` WHERE bfel_company = %s AND (tax_id = %s OR bfel_id_receptor = %s)
            AND disabled = 0 LIMIT 1""",
            (c.company, p.nit, p.nit),
        )
        if existente:
            return existente[0][0]
    from facex_multi.api.customer import create_or_update_customer

    nombre = p.empresa_cliente or p.comprador_nombre
    if p.nit == "CF":
        existente = frappe.db.get_value("Customer", {"bfel_company": c.company, "customer_name": nombre, "disabled": 0}, "name")
        if existente:
            return existente
    partes = p.comprador_nombre.split(" ", 1)
    datos = {
        "customer_name": nombre,
        "bfel_identificacion": "NIT" if p.nit != "CF" else "CF",
        "bfel_id_receptor": p.nit,
        "contacto_nombre": partes[0],
        "contacto_apellido": partes[1] if len(partes) > 1 else "",
        "contacto_email": p.correo,
        "contacto_telefono": p.telefono,
    }
    if c.lista_precios:
        datos["default_price_list"] = c.lista_precios
    if c.vendedor:
        datos["default_sales_partner"] = c.vendedor
    return create_or_update_customer(frappe.as_json(datos), company=c.company)["name"]


@frappe.whitelist()
def reintentar_cotizacion(pedido: str) -> dict:
    p = frappe.get_doc(PEDIDO, pedido)
    _exigir(p.company, "pagina_web_acceso")
    if p.estado != "Recibido":
        frappe.throw(f"El pedido está {p.estado.lower()}: ya tiene cotización o se cerró.")
    cotizar(p.name)
    p.reload()
    if p.error:
        frappe.throw(f"No se pudo crear la cotización: {p.error}")
    return {"estado": p.estado, "cotizacion": p.cotizacion}


def cotizar(pedido: str):
    """Arma la cotización (factura en borrador) del pedido a nombre del usuario
    de pedidos en línea. Si algo falla, el pedido queda Recibido con el error."""
    p = frappe.get_doc(PEDIDO, pedido)
    c = _conf(p.company)
    if p.estado != "Recibido":
        return
    try:
        if not c.usuario:
            frappe.throw("Falta el «Usuario que registra los pedidos en línea» en la Configuración de la Compañía.")
        with _como(c.usuario):
            from facex_multi.api.invoice import get_defaults, save_draft

            cliente = _cliente(c, p)
            defaults = get_defaults(c.company)
            series = defaults.get("naming_series") or []
            est = (defaults.get("establishments") or [{}])[0].get("establecimiento_id")
            cust = frappe.db.get_value("Customer", cliente, ["customer_name", "tax_id", "bfel_id_receptor"], as_dict=True) or {}
            notas = [f"Pedido en línea {p.name} ({c.dominio})"]
            if p.direccion:
                notas.append(f"Entregar en: {p.direccion}")
            if p.comentario:
                notas.append(f"Comentario: {p.comentario}")
            payload = {
                "doctype": "Sales Invoice",
                "es_fiscal": 1,
                "update_stock": 1 if any(frappe.get_cached_value("Item", a.item_code, "is_stock_item") for a in p.articulos) else 0,
                "customer": cliente,
                "company": c.company,
                "posting_date": frappe.utils.today(),
                "due_date": frappe.utils.today(),
                "taxes_and_charges": defaults.get("default_taxes_and_charges") or "",
                "payment_terms_template": defaults.get("default_payment_terms_template") or "",
                "sales_partner": c.vendedor or defaults.get("default_sales_partner") or "",
                "selling_price_list": c.lista_precios or defaults.get("default_price_list") or "",
                "bfel_establecimiento": str(est) if est is not None else "",
                "bfel_status": defaults.get("bfel_status_default") or "01 Enviar",
                "bfel_nit": cust.get("bfel_id_receptor") or cust.get("tax_id") or "CF",
                "bfel_nombre": cust.get("customer_name") or "",
                "facex_pedido_en_linea": p.name,
                "terms": "\n".join(notas),
                "items": [{
                    "item_code": a.item_code, "qty": a.cantidad, "uom": a.uom,
                    "warehouse": defaults.get("default_warehouse") or "",
                    "cost_center": defaults.get("default_cost_center") or "",
                } for a in p.articulos],
            }
            if series:
                payload["naming_series"] = series[0]
            for campo in ("taxes_and_charges", "payment_terms_template", "selling_price_list", "sales_partner"):
                if not payload[campo]:
                    payload.pop(campo)
            doc = save_draft(frappe.as_json(payload))
        p.db_set({"estado": "Cotizado", "cotizacion": doc.get("name"), "cliente": cliente, "error": None})
        frappe.db.commit()
    except Exception as e:
        frappe.db.rollback()
        frappe.clear_messages()
        detalle = str(e)[:500] or e.__class__.__name__
        frappe.log_error(title=f"Pedido en línea {p.name}: no se pudo crear la cotización")
        frappe.db.set_value(PEDIDO, p.name, "error", detalle, update_modified=False)
        frappe.db.commit()


def _usuarios_con_acceso(company: str) -> list:
    if not frappe.get_meta("FacEx Settings").has_field("pagina_web_acceso"):
        return []
    return frappe.get_all("FacEx Settings", filters={"bfel_company": company, "pagina_web_acceso": 1}, pluck="user")


def _avisar(p):
    """Aviso en la campana de FacEx a los usuarios con «Ver pedidos en línea»."""
    usuarios = [u for u in _usuarios_con_acceso(p.company) if u]
    if not usuarios:
        return
    from frappe.desk.doctype.notification_log.notification_log import enqueue_create_notification

    quien = p.empresa_cliente or p.comprador_nombre
    asunto = f"Pedido en línea {p.name}: {quien}"
    if p.cotizacion:
        asunto += f" (cotización {p.cotizacion})"
    enqueue_create_notification(usuarios, {
        "type": "Alert",
        "subject": asunto,
        "email_content": frappe.utils.escape_html(f"{len(p.articulos)} productos. Tel. {p.telefono} · {p.correo}"),
        "link": "/app/facex-pedidos-web",
        "from_user": None,
    })


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=120, seconds=60 * 10)
def pedido() -> dict:
    """La página (api/pedido.php) manda aquí el carrito, firmado."""
    c, datos = _verificar("pedido")
    return crear_pedido(c, datos)


@frappe.whitelist(allow_guest=True, methods=["POST"])
@rate_limit(limit=600, seconds=60 * 10)
def estado() -> dict:
    """La página de «pedido recibido» pregunta aquí (por api/estado.php) cómo va."""
    c, datos = _verificar("estado")
    token = datos.get("token")
    nombre = frappe.db.get_value(PEDIDO, {"token": token, "company": c.company}, "name") if token and len(str(token)) >= 20 else None
    if not nombre:
        frappe.throw("El pedido no existe.", frappe.DoesNotExistError)
    p = frappe.get_doc(PEDIDO, nombre)
    return {
        "pedido": p.name,
        "estado": ESTADO_PUBLICO.get(p.estado, p.estado),
        "recibido_el": str(p.recibido_el or ""),
        "comprador": p.comprador_nombre,
        "empresa": p.empresa_cliente,
        "correo": p.correo,
        "articulos": [{"descripcion": a.descripcion, "cantidad": a.cantidad, "unidad": a.uom} for a in p.articulos],
    }


def al_validar_factura(doc, method=None):
    """Sales Invoice on_submit: la cotización de un pedido en línea se facturó."""
    if doc.get("facex_pedido_en_linea") and not doc.get("is_return"):
        frappe.db.set_value(PEDIDO, doc.facex_pedido_en_linea, {"estado": "Facturado", "facturado_el": now_datetime()},
                            update_modified=False)


def al_borrar_factura(doc, method=None):
    """Sales Invoice on_trash: se eliminó el borrador de un pedido en línea."""
    nombre = doc.get("facex_pedido_en_linea")
    if nombre and frappe.db.get_value(PEDIDO, nombre, "estado") == "Cotizado":
        frappe.db.set_value(PEDIDO, nombre, {"estado": "Cancelado", "cotizacion": None}, update_modified=False)


# ---------------------------------------------------------------------------
# Pantalla «Pedidos en línea» (page facex-pedidos-web)
# ---------------------------------------------------------------------------

LISTAS = {"activos": ["Recibido", "Cotizado"], "facturados": ["Facturado"], "cancelados": ["Cancelado"]}


@frappe.whitelist()
def pantalla(lista: str = "activos", company: str = None) -> dict:
    from facex_multi.api.permissions import get_facex_permissions_for_company

    company = _exigir(company, "pagina_web_acceso")
    c = _conf(company)
    pedidos = frappe.get_all(
        PEDIDO,
        filters={"company": company, "estado": ["in", LISTAS.get(lista) or LISTAS["activos"]]},
        fields=["name", "estado", "cotizacion", "recibido_el", "facturado_el", "comprador_nombre", "empresa_cliente",
                "nit", "correo", "telefono", "direccion", "comentario", "notas", "error", "cliente"],
        order_by="recibido_el desc",
        limit=200,
    )
    for p in pedidos:
        p.articulos = frappe.get_all("FacEx Pedido en Linea Articulo", filters={"parent": p.name, "parenttype": PEDIDO},
                                     fields=["item_code", "descripcion", "cantidad", "uom"], order_by="idx asc")
        if p.cotizacion:
            p.total = frappe.db.get_value("Sales Invoice", p.cotizacion, "grand_total")
    perms = get_facex_permissions_for_company(company)
    estado_envio = frappe.db.get_value(CONFIG, company, ["pagina_web_ultimo_envio", "pagina_web_estado"], as_dict=True) or {}
    return {
        "company": company,
        "dominio": c.dominio,
        "pedidos": pedidos,
        "cuantos": {k: frappe.db.count(PEDIDO, {"company": company, "estado": ["in", v]}) for k, v in LISTAS.items()},
        "puede_gestionar": cint(perms.get("pagina_web_gestionar")),
        "ultimo_envio": str(estado_envio.get("pagina_web_ultimo_envio") or ""),
        "estado_envio": estado_envio.get("pagina_web_estado") or "",
    }


@frappe.whitelist()
def cancelar_pedido(pedido: str, motivo: str = None) -> dict:
    """Cierra el pedido; su cotización en borrador se elimina si el usuario
    tiene permiso para eliminar borradores (si no, queda para hacerlo en FacEx)."""
    p = frappe.get_doc(PEDIDO, pedido)
    _exigir(p.company, "pagina_web_acceso")
    if p.estado not in ("Recibido", "Cotizado"):
        frappe.throw(f"Un pedido {p.estado.lower()} no se puede cancelar.")
    aviso = ""
    if p.cotizacion and frappe.db.get_value("Sales Invoice", p.cotizacion, "docstatus") == 0:
        from facex_multi.api.invoice import delete_draft_invoice

        try:
            delete_draft_invoice(p.cotizacion)
            aviso = f"Se eliminó la cotización {p.cotizacion}."
        except frappe.PermissionError:
            frappe.clear_messages()
            aviso = f"La cotización {p.cotizacion} quedó en borrador: no tiene permiso para eliminar borradores."
    notas = "\n".join(x for x in (p.notas, f"Cancelado: {motivo}" if motivo else "Cancelado") if x)
    frappe.db.set_value(PEDIDO, p.name, {"estado": "Cancelado", "notas": notas}, update_modified=True)
    frappe.db.commit()
    return {"estado": "Cancelado", "aviso": aviso}


@frappe.whitelist()
def guardar_notas(pedido: str, notas: str = None) -> dict:
    p = frappe.get_doc(PEDIDO, pedido)
    _exigir(p.company, "pagina_web_acceso")
    frappe.db.set_value(PEDIDO, p.name, "notas", _texto(notas, 2000))
    return {"ok": True}
