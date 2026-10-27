# -*- coding: utf-8 -*-
"""Ventas por Live (2026-10-27).

El live es en TikTok, pero el «mío», la captura del live y el alias del
personaje llegan al WhatsApp del negocio. Un personaje es un CONJUNTO: el que
dice «mío» se lleva todas sus prendas (tabla Prendas de la sesión). Cada
personaje tiene N conjuntos; cuando se acaban, los siguientes «mío» quedan En
espera por orden de llegada del mensaje y suben solos si alguien cancela.

Flujo del pedido (FacEx Live Pedido):
  Por revisar → Mío / En espera → Confirmado → Pagado | Contra entrega → Facturado
  (Cancelado en cualquier momento antes de Facturado).

Por cliente se arma UNA cotización (Sales Invoice en borrador, vía save_draft)
con todos sus conjuntos y el flete de la lista; se envía con el diálogo de
WhatsApp de siempre. «Facturar listos» valida, certifica y registra el pago
con las mismas funciones del POS (submit → certify → save_payments).

Entrada automática: un bot POR NÚMERO de WhatsApp (live_bot/, whatsapp-web.js)
llama a `recibir_mio` con el usuario de API del bot y su propio número
(`linea`). Cada vendedor hace su live desde su número: la sesión guarda esa
línea (`linea_whatsapp`, precargada de FacEx Settings → `live_whatsapp`) y el
servidor manda cada «mío» a la sesión abierta de esa línea, nunca a la de otro.
Solo lee, nunca envía.

Permisos (FacEx Settings / Perfil → «Ventas por Live», deny-by-default):
  live_acceso   — página, bandeja, cotizaciones y guías.
  live_sesiones — crear y editar sesiones (personajes y prendas).
  live_facturar — facturar en lote (además exige puede_validar y puede_certificar).
"""
import base64
import re
import unicodedata

import frappe
from frappe.utils import cint, flt, get_datetime, now_datetime, today

SESION = "FacEx Live Sesion"
PEDIDO = "FacEx Live Pedido"

# Estados que ocupan un conjunto del personaje.
OCUPAN = ("Mío", "Confirmado", "Pagado", "Contra entrega", "Facturado")
# Estados que van a la cotización del cliente.
EN_COTIZACION = ("Mío", "Confirmado", "Pagado", "Contra entrega")
# Estados que el usuario puede poner a mano (Facturado solo lo pone el sistema;
# Mío / En espera los decide la cola).
ESTADOS_MANUALES = ("Mío", "Confirmado", "Pagado", "Contra entrega", "Cancelado")
TRANSPORTISTA_DEFAULT = "Cargo Expreso"

_MIO_RE = re.compile(r"\b(mio|mia|mios|mias)\b")


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def _norm(texto) -> str:
    """minúsculas, sin tildes ni signos, espacios simples."""
    s = unicodedata.normalize("NFKD", str(texto or "")).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", " ", s.lower())
    return s.strip()


def _tel8(raw) -> str:
    """Últimos 8 dígitos (Guatemala) para comparar teléfonos escritos distinto."""
    d = re.sub(r"\D", "", str(raw or ""))
    return d[-8:] if len(d) >= 8 else d


def _company(company=None) -> str:
    from facex_multi.api.invoice import get_effective_company
    return get_effective_company(company)


def _perms(company) -> dict:
    from facex_multi.api.permissions import get_facex_permissions_for_company
    return get_facex_permissions_for_company(company)


def _require(company, *flags):
    p = _perms(company)
    if any(not p.get(f) for f in flags):
        frappe.throw("No tiene permiso para esta acción de Ventas por Live.", frappe.PermissionError)


def _sesion(name, company=None):
    doc = frappe.get_doc(SESION, name)
    if doc.company != _company(company or doc.company):
        frappe.throw("La sesión es de otra compañía.", frappe.PermissionError)
    return doc


def _precio(item_code, price_list) -> float:
    if not price_list:
        return 0.0
    return flt(frappe.db.get_value(
        "Item Price", {"item_code": item_code, "price_list": price_list, "selling": 1}, "price_list_rate"))


def _personajes(ses) -> dict:
    """{alias_norm: {alias, unidades, foto, notas, prendas:[{item_code,item_name,qty,rate}], precio}}"""
    out = {}
    for p in ses.personajes:
        out[_norm(p.alias)] = {
            "alias": p.alias, "unidades": cint(p.unidades), "foto": p.foto or "",
            "notas": p.notas or "", "prendas": [], "precio": 0.0,
        }
    for r in ses.prendas:
        per = out.get(_norm(r.alias))
        if not per:
            continue
        rate = _precio(r.item_code, ses.lista_precios)
        qty = flt(r.qty) or 1
        per["prendas"].append({"item_code": r.item_code, "item_name": r.item_name or r.item_code,
                               "qty": qty, "rate": rate})
        per["precio"] += rate * qty
    return out


def _alias_en_texto(texto, personajes: dict) -> str:
    """Alias del personaje mencionado en el texto (el más largo si hay varios)."""
    t = f" {_norm(texto)} "
    hits = [k for k in personajes if k and f" {k} " in t]
    return personajes[max(hits, key=len)]["alias"] if hits else ""


def _cantidad_en_texto(texto) -> int:
    t = _norm(texto)
    m = re.search(r"\bx\s*(\d{1,2})\b", t) or re.search(r"\b(\d{1,2})\s*(conjuntos?|juegos?|sets?)\b", t)
    return max(cint(m.group(1)), 1) if m else 1


# ---------------------------------------------------------------------------
# Cola por personaje
# ---------------------------------------------------------------------------

def _reacomodar(sesion: str, alias: str):
    """Recalcula Mío / En espera de un personaje por orden de llegada.

    Los pedidos ya Confirmados / Pagados / Contra entrega / Facturados
    conservan su conjunto. Luego, en orden de llegada, cada Mío o En espera
    toma conjuntos mientras alcancen; el resto queda En espera."""
    if not alias:
        return
    ses = frappe.get_doc(SESION, sesion)
    per = next((p for p in ses.personajes if _norm(p.alias) == _norm(alias)), None)
    unidades = cint(per.unidades) if per else 0
    pedidos = frappe.get_all(
        PEDIDO, filters={"sesion": sesion, "estado": ["in", OCUPAN + ("En espera",)]},
        fields=["name", "alias", "estado", "cantidad", "llegada"], order_by="llegada asc, creation asc",
    )
    pedidos = [p for p in pedidos if _norm(p.alias) == _norm(alias)]
    libres = unidades - sum(cint(p.cantidad) or 1 for p in pedidos if p.estado not in ("Mío", "En espera"))
    for p in pedidos:
        if p.estado not in ("Mío", "En espera"):
            continue
        cant = cint(p.cantidad) or 1
        nuevo = "Mío" if libres >= cant else "En espera"
        if nuevo == "Mío":
            libres -= cant
        if nuevo != p.estado:
            frappe.db.set_value(PEDIDO, p.name, "estado", nuevo)


# ---------------------------------------------------------------------------
# Contexto y sesiones
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_contexto(company: str = None) -> dict:
    """Permisos, valores por defecto del usuario (perfil de FacEx Settings) y
    sesiones recientes."""
    from facex_multi.api.permissions import (
        get_facex_allowed_price_lists, get_facex_allowed_warehouses, get_facex_can_edit_price,
        get_facex_default_price_list, get_facex_default_sales_partner, get_facex_default_warehouse,
        get_facex_flete_item, get_facex_user_sales_partner, _value,
    )
    from facex_multi.api.recargo import get_flete_rate
    from facex_multi.api.whatsapp import get_wa_for_user

    company = _company(company)
    p = _perms(company)
    if not p.get("live_acceso"):
        frappe.throw("No tiene acceso a Ventas por Live.", frappe.PermissionError)

    lista = get_facex_default_price_list(company) or ""
    sesiones = frappe.get_all(
        SESION, filters={"company": company},
        fields=["name", "titulo", "fecha", "estado", "lista_precios", "vendedor", "bodega", "linea_whatsapp"],
        order_by="fecha desc, creation desc", limit_page_length=40,
    )
    return {
        "company": company,
        "permisos": {
            k: cint(p.get(k)) for k in (
                "live_acceso", "live_sesiones", "live_facturar", "puede_guardar", "puede_validar",
                "puede_certificar", "crea_clientes", "puede_editar_guias_transporte", "puede_editar_precio",
            )
        },
        "defaults": {
            "vendedor": get_facex_default_sales_partner(company) or "",
            "vendedor_fijo": bool(get_facex_user_sales_partner(company)),
            "bodega": get_facex_default_warehouse(company) or "",
            "lista_precios": lista,
            "incluir_flete": 1,
            "linea_whatsapp": _tel8(_value(company, "live_whatsapp")),
        },
        "listas_permitidas": get_facex_allowed_price_lists(company),
        "bodegas_permitidas": get_facex_allowed_warehouses(company, "venta"),
        "flete": {
            "item": get_facex_flete_item(company) or "",
            "rate": get_flete_rate(company, lista) if lista else 0,
            "puede_quitar": bool(get_facex_can_edit_price(company)),
        },
        "wa": get_wa_for_user(company),
        "transportistas": frappe.get_all("FacEx Transportista", filters={"activo": 1}, pluck="name"),
        "transportista_default": TRANSPORTISTA_DEFAULT
        if frappe.db.exists("FacEx Transportista", TRANSPORTISTA_DEFAULT) else "",
        "sesiones": sesiones,
    }


@frappe.whitelist()
def guardar_sesion(data_json: str) -> dict:
    from facex_multi.api.permissions import (
        get_facex_allowed_price_lists, get_facex_can_edit_price, get_facex_flete_item,
        get_facex_user_sales_partner,
    )
    data = frappe.parse_json(data_json) or {}
    company = _company(data.get("company"))
    _require(company, "live_sesiones")

    name = (data.get("name") or "").strip()
    doc = _sesion(name, company) if name else frappe.new_doc(SESION)
    doc.company = company

    for f in ("titulo", "fecha", "vendedor", "bodega", "lista_precios"):
        if f in data:
            doc.set(f, data.get(f) or None)
    doc.fecha = doc.fecha or today()
    if "linea_whatsapp" in data:
        linea = _tel8(data.get("linea_whatsapp"))
        if linea and len(linea) != 8:
            frappe.throw("El WhatsApp del live debe tener 8 dígitos.")
        doc.linea_whatsapp = linea or None

    # Vendedor bloqueado en el perfil: siempre el suyo.
    fijo = get_facex_user_sales_partner(company)
    if fijo:
        doc.vendedor = fijo

    if doc.lista_precios:
        permitidas = get_facex_allowed_price_lists(company)
        if permitidas is not None and doc.lista_precios not in permitidas:
            frappe.throw(f"La lista de precios «{doc.lista_precios}» no está habilitada para su usuario.")

    # Flete: va marcado; solo quien puede editar precios lo quita (igual que en FacEx).
    doc.incluir_flete = 1 if not get_facex_can_edit_price(company) else cint(data.get("incluir_flete", 1))
    if doc.incluir_flete and not get_facex_flete_item(company):
        doc.incluir_flete = 0

    estado = data.get("estado") or doc.estado or "Abierta"
    if estado == "Abierta" and (doc.estado != "Abierta" or not doc.abierta_desde):
        doc.abierta_desde = now_datetime()
    doc.estado = estado
    # Una línea, un live abierto: si no, el bot no sabría a cuál mandar el «mío».
    if doc.estado == "Abierta" and doc.linea_whatsapp:
        otra = frappe.db.get_value(SESION, {"company": company, "estado": "Abierta",
                                            "linea_whatsapp": doc.linea_whatsapp, "name": ["!=", doc.name or ""]},
                                   ["name", "titulo"], as_dict=True)
        if otra:
            frappe.throw(f"El WhatsApp {doc.linea_whatsapp} ya tiene abierta la sesión «{otra.titulo or otra.name}». "
                         "Ciérrela primero.")

    if "personajes" in data:
        doc.personajes = []
        vistos = set()
        for r in data.get("personajes") or []:
            alias = (r.get("alias") or "").strip()
            if not alias:
                continue
            if _norm(alias) in vistos:
                frappe.throw(f"El personaje «{alias}» está repetido.")
            vistos.add(_norm(alias))
            doc.append("personajes", {"alias": alias, "unidades": max(cint(r.get("unidades")), 0),
                                      "foto": r.get("foto") or "", "notas": r.get("notas") or ""})
    if "prendas" in data:
        doc.prendas = []
        for r in data.get("prendas") or []:
            if not r.get("item_code"):
                continue
            doc.append("prendas", {"alias": (r.get("alias") or "").strip(), "item_code": r["item_code"],
                                   "qty": flt(r.get("qty")) or 1})

    aliases = {_norm(p.alias) for p in doc.personajes}
    huerfanas = sorted({r.alias for r in doc.prendas if _norm(r.alias) not in aliases})
    if huerfanas:
        frappe.throw("Hay prendas de personajes que no existen: " + ", ".join(huerfanas))
    sin_prendas = [p.alias for p in doc.personajes if not any(_norm(r.alias) == _norm(p.alias) for r in doc.prendas)]
    if sin_prendas:
        frappe.throw("Cada personaje necesita al menos una prenda. Sin prendas: " + ", ".join(sin_prendas))

    doc.flags.ignore_permissions = True
    doc.save()
    # Cambió el número de conjuntos o los alias: recalcular todas las colas.
    for p in doc.personajes:
        _reacomodar(doc.name, p.alias)
    frappe.db.commit()
    return {"name": doc.name}


@frappe.whitelist()
def get_sesion(name: str) -> dict:
    ses = _sesion(name)
    _require(ses.company, "live_acceso")
    personajes = _personajes(ses)

    pedidos = frappe.get_all(
        PEDIDO, filters={"sesion": ses.name},
        fields=["name", "llegada", "estado", "origen", "telefono", "nombre_wa", "cliente", "cliente_nombre",
                "alias", "cantidad", "mensaje", "captura", "cotizacion", "metodo_pago",
                "referencia_pago", "numero_guia", "notas"],
        order_by="llegada asc, creation asc",
    )
    for per in personajes.values():
        per.update({"ocupados": 0, "en_espera": 0})
    for p in pedidos:
        per = personajes.get(_norm(p.alias))
        if not per:
            continue
        if p.estado in OCUPAN:
            per["ocupados"] += cint(p.cantidad) or 1
        elif p.estado == "En espera":
            per["en_espera"] += cint(p.cantidad) or 1

    # Por cliente
    clientes = {}
    for p in pedidos:
        if not p.cliente or p.estado in ("Cancelado", "Por revisar"):
            continue
        c = clientes.setdefault(p.cliente, {
            "cliente": p.cliente, "nombre": p.cliente_nombre or p.cliente, "telefono": p.telefono,
            "pedidos": [], "conjuntos": 0, "subtotal": 0.0, "cotizacion": "", "estados": set(),
        })
        c["pedidos"].append(p.name)
        c["estados"].add(p.estado)
        if p.estado in EN_COTIZACION or p.estado == "Facturado":
            per = personajes.get(_norm(p.alias)) or {}
            c["conjuntos"] += cint(p.cantidad) or 1
            c["subtotal"] += flt(per.get("precio")) * (cint(p.cantidad) or 1)
        if p.cotizacion:
            c["cotizacion"] = p.cotizacion
    for c in clientes.values():
        c["estados"] = sorted(c["estados"])
        if c["cotizacion"]:
            c["cotizacion_info"] = frappe.db.get_value(
                "Sales Invoice", c["cotizacion"],
                ["docstatus", "grand_total", "bfel_status", "bfel_uuid", "bfel_pago_contra_entrega"], as_dict=True)

    d = ses.as_dict()
    return {
        "sesion": {k: d.get(k) for k in ("name", "titulo", "company", "fecha", "estado", "abierta_desde", "linea_whatsapp",
                                          "vendedor", "bodega", "lista_precios", "incluir_flete")},
        "personajes": list(personajes.values()),
        "prendas": [{"alias": r.alias, "item_code": r.item_code, "item_name": r.item_name, "qty": r.qty}
                    for r in ses.prendas],
        "pedidos": pedidos,
        "clientes": sorted(clientes.values(), key=lambda c: c["nombre"] or ""),
    }


@frappe.whitelist()
def precios_items(items_json: str, price_list: str) -> dict:
    """Precio de cada ítem en la lista (para mostrar el precio del conjunto al armar la sesión)."""
    items = frappe.parse_json(items_json) or []
    return {i: _precio(i, price_list) for i in items if i}


# ---------------------------------------------------------------------------
# Clientes por teléfono
# ---------------------------------------------------------------------------

def _cliente_por_telefono(company, telefono) -> str:
    t8 = _tel8(telefono)
    if len(t8) < 8:
        return ""
    like = f"%{t8}"
    row = frappe.db.sql(
        """SELECT name FROM `tabCustomer`
           WHERE disabled = 0 AND IFNULL(bfel_company, '') IN ('', %(c)s)
             AND REPLACE(REPLACE(REPLACE(IFNULL(mobile_no, ''), ' ', ''), '-', ''), '+', '') LIKE %(l)s
           ORDER BY modified DESC LIMIT 1""", {"c": company, "l": like})
    if row:
        return row[0][0]
    row = frappe.db.sql(
        """SELECT cu.name FROM `tabContact Phone` cp
           JOIN `tabDynamic Link` dl ON dl.parent = cp.parent AND dl.parenttype = 'Contact'
                AND dl.link_doctype = 'Customer'
           JOIN `tabCustomer` cu ON cu.name = dl.link_name
           WHERE cu.disabled = 0 AND IFNULL(cu.bfel_company, '') IN ('', %(c)s)
             AND REPLACE(REPLACE(REPLACE(cp.phone, ' ', ''), '-', ''), '+', '') LIKE %(l)s
           ORDER BY cu.modified DESC LIMIT 1""", {"c": company, "l": like})
    return row[0][0] if row else ""


def _crear_cliente(company, telefono, nombre) -> str:
    from facex_multi.api.customer import create_or_update_customer
    t8 = _tel8(telefono)
    nombre = (nombre or "").strip() or f"Cliente WA {t8}"
    res = create_or_update_customer({
        "customer_name": nombre,
        "contacto_nombre": nombre,
        "contacto_telefono": t8,
    }, company)
    frappe.db.set_value("Customer", res["name"], "mobile_no", t8)
    return res["name"]


@frappe.whitelist()
def buscar_cliente_telefono(telefono: str, company: str = None) -> dict:
    company = _company(company)
    _require(company, "live_acceso")
    name = _cliente_por_telefono(company, telefono)
    return {"cliente": name, "nombre": frappe.db.get_value("Customer", name, "customer_name") if name else ""}


# ---------------------------------------------------------------------------
# Pedidos
# ---------------------------------------------------------------------------

def _crear_pedido(ses, telefono, alias="", cantidad=1, nombre="", mensaje="", llegada=None,
                  origen="Manual", wa_msg_id=None, cliente=None) -> "frappe.Document":
    personajes = _personajes(ses)
    alias = (alias or "").strip()
    if alias:
        per = personajes.get(_norm(alias))
        alias = per["alias"] if per else alias
    reconocido = bool(alias) and _norm(alias) in personajes

    cliente = cliente or _cliente_por_telefono(ses.company, telefono)
    if not cliente and _tel8(telefono) and len(_tel8(telefono)) == 8 and _perms(ses.company).get("crea_clientes"):
        cliente = _crear_cliente(ses.company, telefono, nombre)

    ped = frappe.get_doc({
        "doctype": PEDIDO, "sesion": ses.name, "llegada": get_datetime(llegada) if llegada else now_datetime(),
        "estado": "Mío" if (reconocido and cliente) else "Por revisar",
        "origen": origen, "telefono": _tel8(telefono) or telefono, "nombre_wa": nombre or "",
        "cliente": cliente or None, "alias": alias, "cantidad": max(cint(cantidad), 1),
        "mensaje": mensaje or "", "wa_msg_id": wa_msg_id or None,
    })
    ped.flags.ignore_permissions = True
    ped.insert()
    if ped.estado == "Mío":
        _reacomodar(ses.name, alias)
    return ped


@frappe.whitelist()
def registrar_mio(sesion: str, telefono: str, alias: str = "", cantidad: int = 1, nombre: str = "",
                  captura: str = "", mensaje: str = "", llegada: str = None, cliente: str = None) -> dict:
    """Registro manual desde la bandeja. `captura` = file_url ya subido (opcional)."""
    ses = _sesion(sesion)
    _require(ses.company, "live_acceso")
    if ses.estado != "Abierta":
        frappe.throw("La sesión está cerrada.")
    ped = _crear_pedido(ses, telefono, alias, cantidad, nombre, mensaje, llegada, "Manual", cliente=cliente)
    if captura:
        _adjuntar_url(ped, captura)
    frappe.db.commit()
    return {"name": ped.name, "estado": frappe.db.get_value(PEDIDO, ped.name, "estado")}


def _adjuntar_url(ped, file_url):
    f = frappe.db.get_value("File", {"file_url": file_url}, "name")
    if f:
        frappe.db.set_value("File", f, {"attached_to_doctype": PEDIDO, "attached_to_name": ped.name,
                                        "attached_to_field": "captura"})
    frappe.db.set_value(PEDIDO, ped.name, "captura", file_url)


@frappe.whitelist()
def actualizar_pedido(name: str, data_json: str) -> dict:
    ped = frappe.get_doc(PEDIDO, name)
    ses = _sesion(ped.sesion)
    _require(ses.company, "live_acceso")
    data = frappe.parse_json(data_json) or {}
    if ped.estado == "Facturado":
        frappe.throw("El pedido ya está facturado.")

    alias_antes = ped.alias
    for f in ("telefono", "nombre_wa", "cantidad", "metodo_pago", "referencia_pago", "numero_guia", "notas"):
        if f in data:
            ped.set(f, data[f])
    if "cliente" in data:
        ped.cliente = data["cliente"] or None
    if "alias" in data:
        per = _personajes(ses).get(_norm(data["alias"]))
        if data["alias"] and not per:
            frappe.throw(f"No hay un personaje «{data['alias']}» en esta sesión.")
        ped.alias = per["alias"] if per else ""
    ped.cantidad = max(cint(ped.cantidad), 1)

    if "estado" in data and data["estado"] != ped.estado:
        nuevo = data["estado"]
        if nuevo not in ESTADOS_MANUALES:
            frappe.throw(f"No se puede poner el estado «{nuevo}» a mano.")
        if nuevo != "Cancelado" and (not ped.cliente or not ped.alias):
            frappe.throw("Primero asigne el cliente y el personaje.")
        # Confirmar / cobrar a alguien En espera solo si ya le tocó conjunto.
        if ped.estado == "En espera" and nuevo != "Cancelado":
            frappe.throw("El pedido está En espera: sube solo cuando se libere un conjunto.")
        ped.estado = nuevo
    elif ped.estado == "Por revisar" and ped.cliente and ped.alias:
        ped.estado = "Mío"  # ya revisado: entra a la cola en su orden de llegada

    ped.flags.ignore_permissions = True
    ped.save()
    for a in {alias_antes, ped.alias}:
        _reacomodar(ses.name, a)
    frappe.db.commit()
    return {"name": ped.name, "estado": frappe.db.get_value(PEDIDO, ped.name, "estado")}


@frappe.whitelist()
def subir_captura(name: str, filedata: str, filename: str = "captura.jpg") -> dict:
    """Captura pegada (Ctrl+V) o elegida en la bandeja: base64 → File privado del pedido."""
    ped = frappe.get_doc(PEDIDO, name)
    _require(_sesion(ped.sesion).company, "live_acceso")
    url = _guardar_imagen(ped, filedata, filename)
    frappe.db.commit()
    return {"captura": url}


@frappe.whitelist()
def ver_captura(name: str):
    """La captura es un archivo privado del pedido; el DocType solo lo lee System
    Manager, así que la página la pide por aquí con el permiso de Live."""
    ped = frappe.get_doc(PEDIDO, name)
    _require(_sesion(ped.sesion).company, "live_acceso")
    if not ped.captura:
        frappe.throw("El pedido no tiene captura.")
    f = frappe.get_doc("File", {"file_url": ped.captura})
    frappe.local.response.filename = f.file_name
    frappe.local.response.filecontent = f.get_content()
    frappe.local.response.display_content_as = "inline"
    frappe.local.response.type = "download"


def _guardar_imagen(ped, b64: str, filename: str) -> str:
    from frappe.utils.file_manager import save_file
    if "," in (b64 or "")[:100]:
        b64 = b64.split(",", 1)[1]
    content = base64.b64decode(b64)
    if len(content) > 8 * 1024 * 1024:
        frappe.throw("La imagen pesa más de 8 MB.")
    f = save_file(filename, content, PEDIDO, ped.name, is_private=1, df="captura")
    frappe.db.set_value(PEDIDO, ped.name, "captura", f.file_url)
    return f.file_url


# ---------------------------------------------------------------------------
# Cotización por cliente
# ---------------------------------------------------------------------------

def _pedidos_cliente(ses, cliente, estados=EN_COTIZACION):
    return frappe.get_all(PEDIDO, filters={"sesion": ses.name, "cliente": cliente, "estado": ["in", estados]},
                          fields=["name", "alias", "cantidad", "estado", "cotizacion", "metodo_pago",
                                  "referencia_pago"], order_by="llegada asc")


def _cotizacion_abierta(pedidos) -> str:
    for p in pedidos:
        if p.cotizacion and frappe.db.get_value("Sales Invoice", p.cotizacion, "docstatus") == 0:
            return p.cotizacion
    return ""


@frappe.whitelist()
def armar_cotizacion(sesion: str, cliente: str) -> dict:
    """Crea o actualiza la cotización (Sales Invoice en borrador) del cliente con
    todos sus conjuntos de la sesión, más el flete de la lista."""
    from facex_multi.api.invoice import get_defaults, save_draft

    ses = _sesion(sesion)
    _require(ses.company, "live_acceso", "puede_guardar")
    pedidos = _pedidos_cliente(ses, cliente)
    if not pedidos:
        frappe.throw("El cliente no tiene conjuntos apartados en esta sesión.")

    personajes = _personajes(ses)
    items = {}
    for p in pedidos:
        per = personajes.get(_norm(p.alias))
        if not per:
            frappe.throw(f"El personaje «{p.alias}» ya no está en la sesión.")
        for r in per["prendas"]:
            row = items.setdefault(r["item_code"], {"item_code": r["item_code"], "qty": 0, "rate": r["rate"]})
            row["qty"] += r["qty"] * (cint(p.cantidad) or 1)

    defaults = get_defaults(ses.company)
    series = defaults.get("naming_series") or []
    est = (defaults.get("establishments") or [{}])[0].get("establecimiento_id")
    cust = frappe.db.get_value("Customer", cliente, ["customer_name", "tax_id", "bfel_id_receptor"],
                               as_dict=True) or {}
    contra = any(p.estado == "Contra entrega" for p in pedidos)
    nombre = _cotizacion_abierta(pedidos)

    payload = {
        "doctype": "Sales Invoice",
        "name": nombre or None,
        "es_fiscal": 1,
        "update_stock": 1 if any(frappe.get_cached_value("Item", i, "is_stock_item") for i in items) else 0,
        "customer": cliente,
        "company": ses.company,
        "posting_date": today(),
        "due_date": today(),
        "taxes_and_charges": defaults.get("default_taxes_and_charges") or "",
        "payment_terms_template": defaults.get("default_payment_terms_template") or "",
        "sales_partner": ses.vendedor or "",
        "selling_price_list": ses.lista_precios or "",
        "bfel_establecimiento": str(est) if est is not None else "",
        "bfel_status": defaults.get("bfel_status_default") or "01 Enviar",
        "bfel_nit": cust.get("bfel_id_receptor") or cust.get("tax_id") or "CF",
        "bfel_nombre": cust.get("customer_name") or "",
        "bfel_pago_contra_entrega": 1 if contra else 0,
        "facex_incluir_flete": cint(ses.incluir_flete),
        "facex_flete_amount": 0,
        "terms": f"Live {ses.titulo or ses.name} — {', '.join(p.alias for p in pedidos)}",
        "items": [{
            "item_code": r["item_code"], "qty": r["qty"], "rate": r["rate"],
            "warehouse": ses.bodega or defaults.get("default_warehouse") or "",
            "cost_center": defaults.get("default_cost_center") or "",
        } for r in items.values()],
    }
    if not nombre:
        payload.pop("name")
        if series:
            payload["naming_series"] = series[0]
    if not payload["taxes_and_charges"]:
        payload.pop("taxes_and_charges")

    doc = save_draft(frappe.as_json(payload))
    inv = doc.get("name")
    for p in pedidos:
        frappe.db.set_value(PEDIDO, p.name, "cotizacion", inv)
    frappe.db.commit()
    return {"invoice": inv, "grand_total": doc.get("grand_total")}


# ---------------------------------------------------------------------------
# Guía de transporte (Contra entrega)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def anotar_guia(sesion: str, cliente: str, numero_guia: str, transportista: str = None) -> dict:
    """Solo se anota el número de guía; lo demás se llena solo. La liquidación
    del transportista sigue su flujo normal."""
    from facex_multi.api.invoice import clean_numero_guia, save_guias_transporte

    ses = _sesion(sesion)
    _require(ses.company, "live_acceso")
    numero = clean_numero_guia(numero_guia)
    if not numero:
        frappe.throw("Escriba el número de guía.")
    pedidos = _pedidos_cliente(ses, cliente, EN_COTIZACION + ("Facturado",))
    inv = next((p.cotizacion for p in pedidos if p.cotizacion), "")
    if not inv:
        frappe.throw("Primero arme la cotización del cliente.")

    si = frappe.get_doc("Sales Invoice", inv)
    transportista = transportista or (
        TRANSPORTISTA_DEFAULT if frappe.db.exists("FacEx Transportista", TRANSPORTISTA_DEFAULT) else None)
    if not transportista:
        frappe.throw("Elija el transportista.")
    destino = frappe.db.sql(
        """SELECT CONCAT_WS(', ', NULLIF(a.city, ''), NULLIF(a.state, '')) FROM `tabAddress` a
           JOIN `tabDynamic Link` dl ON dl.parent = a.name AND dl.parenttype = 'Address'
           WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s
           ORDER BY a.is_primary_address DESC, a.modified DESC LIMIT 1""", cliente)
    conjuntos = sum(cint(p.cantidad) or 1 for p in pedidos)
    row = {
        "transportista": transportista,
        "numero_guia": numero,
        "piezas": max(conjuntos, 1),
        "estado_entrega": "Pendiente",
        "fecha_envio": today(),
        "destino": (destino[0][0] if destino and destino[0][0] else "") or "",
        "monto_cod": flt(si.grand_total) if cint(si.bfel_pago_contra_entrega) else 0,
    }
    if si.docstatus == 1:
        save_guias_transporte(si.name, frappe.as_json([row]))
    else:
        si.append("bfel_guias_transportista", row)
        si.save()
    for p in pedidos:
        frappe.db.set_value(PEDIDO, p.name, "numero_guia", numero)
    frappe.db.commit()
    return {"invoice": si.name, "numero_guia": numero}


# ---------------------------------------------------------------------------
# Facturar en lote
# ---------------------------------------------------------------------------

@frappe.whitelist()
def facturar_listos(sesion: str) -> dict:
    """Por cada cliente cuyos conjuntos están todos Pagados o Contra entrega:
    actualiza la cotización, valida, certifica en FEL y registra el pago
    (mismo orden que FacEx Screen: submit → certify → save_payments)."""
    from facex_multi.api.invoice import certify_invoice, save_payments, submit_invoice

    ses = _sesion(sesion)
    _require(ses.company, "live_acceso", "live_facturar", "puede_guardar", "puede_validar", "puede_certificar")

    activos = frappe.get_all(PEDIDO, filters={"sesion": ses.name, "estado": ["in", EN_COTIZACION]},
                             fields=["cliente", "estado"])
    por_cliente = {}
    for p in activos:
        por_cliente.setdefault(p.cliente, set()).add(p.estado)
    listos = [c for c, est in por_cliente.items() if c and est <= {"Pagado", "Contra entrega"}]

    resultados = []
    for cliente in listos:
        res = {"cliente": cliente, "nombre": frappe.db.get_value("Customer", cliente, "customer_name")}
        try:
            cot = armar_cotizacion(ses.name, cliente)
            inv = cot["invoice"]
            res["invoice"] = inv
            submit_invoice(inv)
            frappe.db.commit()
            pedidos = _pedidos_cliente(ses, cliente)
            for p in pedidos:
                frappe.db.set_value(PEDIDO, p.name, "estado", "Facturado")
            frappe.db.commit()
        except Exception as e:
            frappe.db.rollback()
            res["error"] = _msg(e)
            resultados.append(res)
            continue

        si = frappe.db.get_value("Sales Invoice", inv, ["grand_total", "bfel_status"], as_dict=True)
        if si.bfel_status == "01 Enviar":
            try:
                certify_invoice(inv)
                frappe.db.commit()
                res["certificada"] = True
            except Exception as e:
                frappe.db.rollback()
                res["error_fel"] = _msg(e)

        try:
            contra = any(p.estado == "Contra entrega" for p in pedidos)
            pagado = next((p for p in pedidos if p.estado == "Pagado"), None)
            pago = {
                "payment_method": "Contra Entrega" if contra else ((pagado and pagado.metodo_pago) or "Transferencia"),
                "payment_date": today(),
                "reference": "" if contra else ((pagado and pagado.referencia_pago) or ""),
                "amount": flt(si.grand_total),
            }
            save_payments(inv, frappe.as_json([pago]), "1")
            frappe.db.commit()
        except Exception as e:
            frappe.db.rollback()
            res["error_pago"] = _msg(e)
        resultados.append(res)

    return {"resultados": resultados, "pendientes": len([c for c in por_cliente if c not in listos])}


def _msg(e) -> str:
    msgs = frappe.local.message_log or []
    frappe.clear_messages()
    texto = str(e) or (frappe.parse_json(msgs[-1]).get("message") if msgs else "") or e.__class__.__name__
    return re.sub(r"<[^>]+>", " ", texto).strip()


# ---------------------------------------------------------------------------
# Bot de WhatsApp (PC de la tienda)
# ---------------------------------------------------------------------------

@frappe.whitelist(methods=["POST"])
def recibir_mio(linea: str, telefono: str, texto: str = "", nombre: str = "", llegada: str = None,
                msg_id: str = None, imagen: str = None, imagen_nombre: str = "captura.jpg",
                company: str = None) -> dict:
    """Entrada del bot de la línea `linea` (su propio número). Solo se toman
    mensajes con «mío» que llegan mientras esa línea tiene una sesión Abierta y
    después de que se abrió (abierta_desde)."""
    company = _company(company)
    _require(company, "live_acceso")
    linea = _tel8(linea)
    if len(linea) != 8:
        frappe.throw("El bot debe indicar su número de WhatsApp (linea).")
    if not _MIO_RE.search(_norm(texto)):
        return {"ignorado": "sin «mío»"}
    if msg_id and frappe.db.exists(PEDIDO, {"wa_msg_id": msg_id}):
        return {"ignorado": "duplicado"}

    llegada_dt = get_datetime(llegada) if llegada else now_datetime()
    name = frappe.db.get_value(
        SESION, {"company": company, "estado": "Abierta", "linea_whatsapp": linea,
                 "abierta_desde": ["<=", llegada_dt]},
        "name", order_by="abierta_desde desc")
    if not name:
        return {"ignorado": f"la línea {linea} no tiene sesión abierta"}
    ses = frappe.get_doc(SESION, name)

    alias = _alias_en_texto(texto, _personajes(ses))
    ped = _crear_pedido(ses, telefono, alias, _cantidad_en_texto(texto), nombre, texto, llegada_dt,
                        "Bot WhatsApp", wa_msg_id=msg_id)
    if imagen:
        _guardar_imagen(ped, imagen, imagen_nombre or "captura.jpg")
    frappe.db.commit()
    return {"pedido": ped.name, "estado": frappe.db.get_value(PEDIDO, ped.name, "estado"), "alias": alias}


@frappe.whitelist()
def estado_bot(linea: str, company: str = None) -> dict:
    """Para el bot de la línea `linea`: compañía, su sesión abierta y sus personajes."""
    company = _company(company)
    _require(company, "live_acceso")
    linea = _tel8(linea)
    name = frappe.db.get_value(SESION, {"company": company, "estado": "Abierta", "linea_whatsapp": linea},
                               "name", order_by="abierta_desde desc") if len(linea) == 8 else None
    ses = frappe.get_doc(SESION, name) if name else None
    return {
        "company": company,
        "linea": linea,
        "sesion": name or "",
        "abierta_desde": str(ses.abierta_desde) if ses else "",
        "personajes": [p.alias for p in ses.personajes] if ses else [],
    }
