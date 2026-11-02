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
from frappe.utils import add_to_date, cint, flt, get_datetime, now_datetime, today

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
BFEL_STATUS_LIVE = ("00 No enviar", "01 Enviar")
MOTIVOS_CANCELACION = ("Error del cliente", "No hay producto", "Mala digitación", "Traducción incorrecta",
                       "Cliente canceló", "Cliente no confirmó")


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


def _bfel_status_live(valor) -> str:
    """En un live solo se arma en «00 No enviar» o «01 Enviar»."""
    return valor if valor in BFEL_STATUS_LIVE else "01 Enviar"


def _precio(item_code, price_list) -> float:
    if not price_list:
        return 0.0
    return flt(frappe.db.get_value(
        "Item Price", {"item_code": item_code, "price_list": price_list, "selling": 1}, "price_list_rate"))


def _uoms_item(item_code) -> list:
    """[{uom, factor}] de la prenda: su unidad de inventario (factor 1) y las
    conversiones del ítem (p. ej. Media Docena = 0.5 Docena)."""
    stock_uom = frappe.get_cached_value("Item", item_code, "stock_uom") if item_code else ""
    out = [{"uom": stock_uom, "factor": 1.0}] if stock_uom else []
    for r in frappe.get_all("UOM Conversion Detail", filters={"parenttype": "Item", "parent": item_code},
                            fields=["uom", "conversion_factor"], order_by="idx") if item_code else []:
        if r.uom and r.uom not in {u["uom"] for u in out} and flt(r.conversion_factor) > 0:
            out.append({"uom": r.uom, "factor": flt(r.conversion_factor)})
    return out


def _cant_stock(p, per) -> float:
    """Cantidad del pedido en la unidad de inventario de la prenda."""
    cant = cint(p.get("cantidad")) or 1
    uom = p.get("uom")
    if not uom or not per:
        return float(cant)
    f = next((u["factor"] for u in per.get("uoms") or [] if u["uom"] == uom), 1.0)
    return cant * f


def _personajes(ses) -> dict:
    """{alias_norm: {alias, unidades, foto, notas, prendas:[{item_code,item_name,qty,rate}], precio, uom, uoms}}
    `unidades` y `precio` van en la unidad de inventario de la prenda."""
    out = {}
    for p in ses.personajes:
        out[_norm(p.alias)] = {
            "alias": p.alias, "unidades": flt(p.unidades), "foto": p.foto or "",
            "notas": p.notas or "", "prendas": [], "precio": 0.0, "uom": "", "uoms": [],
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
        if not per["uoms"]:
            per["uoms"] = _uoms_item(r.item_code)
            per["uom"] = per["uoms"][0]["uom"] if per["uoms"] else ""
    return out


def _alias_en_texto(texto, personajes: dict) -> str:
    """Alias del personaje mencionado en el texto (el más largo si hay varios)."""
    t = f" {_norm(texto)} "
    hits = [k for k in personajes if k and f" {k} " in t]
    return personajes[max(hits, key=len)]["alias"] if hits else ""


def _cantidad_en_texto(texto) -> int:
    return _cantidad_uom_en_texto(texto)[0]


def _cantidad_uom_en_texto(texto, uoms=()) -> tuple:
    """(cantidad, unidad) del mensaje: «3 medias docenas» → (3, Media Docena)
    si la prenda maneja esa unidad; «x2» o «2 conjuntos» → (2, "")."""
    t = _norm(texto)
    for u in sorted((u for u in uoms if u), key=lambda u: -len(u)):
        patron = r"\s+".join(re.escape(w) + r"(?:es|s)?" for w in _norm(u).split())
        m = re.search(rf"\b(?:(\d{{1,3}})\s*)?{patron}\b", t)
        if m:
            return max(cint(m.group(1) or 1), 1), u
    m = re.search(r"\bx\s*(\d{1,2})\b", t) or re.search(r"\b(\d{1,2})\s*(conjuntos?|juegos?|sets?)\b", t)
    return (max(cint(m.group(1)), 1) if m else 1), ""


# Palabras que acompañan al «mío» sin decir nada más.
_RELLENO = set("""mio mia mios mias yo me lo la el los las de del un una uno quiero quisiera porfa porfavor
    por favor plis pls gracias si x conjunto conjuntos juego juegos set sets ese esa este esta ok va
    docena docenas media medias unidad unidades par pares""".split())


def _es_consulta(texto, alias="") -> bool:
    """El texto trae algo más que «mío», el personaje y la cantidad: una
    pregunta, una instrucción, una talla... El bot no lo interpreta; lo marca
    para que el vendedor lo lea."""
    if "?" in (texto or ""):
        return True
    t = f" {_norm(texto)} "
    if alias:
        t = t.replace(f" {_norm(alias)} ", " ")
    return any(w not in _RELLENO and not re.fullmatch(r"x?\d{1,2}", w) for w in t.split())


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
    per = _personajes(ses).get(_norm(alias))
    unidades = flt(per["unidades"]) if per else 0
    pedidos = frappe.get_all(
        PEDIDO, filters={"sesion": sesion, "estado": ["in", OCUPAN + ("En espera",)]},
        fields=["name", "alias", "estado", "cantidad", "uom", "llegada"], order_by="llegada asc, creation asc",
    )
    pedidos = [p for p in pedidos if _norm(p.alias) == _norm(alias)]
    libres = unidades - sum(_cant_stock(p, per) for p in pedidos if p.estado not in ("Mío", "En espera"))
    for p in pedidos:
        if p.estado not in ("Mío", "En espera"):
            continue
        cant = _cant_stock(p, per)
        nuevo = "Mío" if libres + 1e-9 >= cant else "En espera"
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
        get_facex_default_bfel_status, get_facex_default_price_list, get_facex_default_sales_partner, get_facex_default_warehouse,
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
                "puede_cambiar_password",
            )
        },
        "defaults": {
            "vendedor": get_facex_default_sales_partner(company) or "",
            "vendedor_fijo": bool(get_facex_user_sales_partner(company)),
            "bodega": get_facex_default_warehouse(company) or "",
            "lista_precios": lista,
            "incluir_flete": 1,
            "linea_whatsapp": _tel8(_value(company, "live_whatsapp")),
            "bfel_status": _bfel_status_live(get_facex_default_bfel_status(company)),
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
    if "bfel_status" in data:
        if data["bfel_status"] not in BFEL_STATUS_LIVE:
            frappe.throw("El estado FEL de la sesión debe ser «00 No enviar» o «01 Enviar».")
        doc.bfel_status = data["bfel_status"]
    elif not doc.bfel_status:
        from facex_multi.api.permissions import get_facex_default_bfel_status
        doc.bfel_status = _bfel_status_live(get_facex_default_bfel_status(company))
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
            doc.append("personajes", {"alias": alias, "unidades": max(flt(r.get("unidades")), 0),
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
        frappe.throw("Cada personaje necesita su prenda. Sin prenda: " + ", ".join(sin_prendas))
    # Un personaje = una prenda.
    varias = sorted({r.alias for r in doc.prendas
                     if sum(_norm(x.alias) == _norm(r.alias) for x in doc.prendas) > 1})
    if varias:
        frappe.throw("Cada personaje lleva una sola prenda. Con varias: " + ", ".join(varias))

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
                "alias", "cantidad", "uom", "motivo_cancelacion", "mensaje", "consulta", "captura", "cotizacion", "metodo_pago",
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
            per["ocupados"] += _cant_stock(p, per)
        elif p.estado == "En espera":
            per["en_espera"] += _cant_stock(p, per)

    # Cotizado / facturado por pedido, según el documento (puede haberse
    # validado desde FacEx clásico sin pasar por «Facturar listos»).
    docs = {d.name: d for d in frappe.get_all(
        "Sales Invoice", filters={"name": ["in", list({p.cotizacion for p in pedidos if p.cotizacion}) or [""]]},
        fields=["name", "docstatus", "grand_total", "bfel_status", "bfel_uuid", "bfel_pago_contra_entrega",
                "custom_pagado"])}
    for p in pedidos:
        d = docs.get(p.cotizacion)
        p["facturada"] = 1 if (p.estado == "Facturado" or (d and d.docstatus == 1)) else 0
        p["cotizada"] = 1 if (d and d.docstatus == 0) else 0
        p["uom"] = p.uom or (personajes.get(_norm(p.alias)) or {}).get("uom") or ""

    d = ses.as_dict()
    return {
        "sesion": {k: d.get(k) for k in ("name", "titulo", "company", "fecha", "estado", "abierta_desde", "linea_whatsapp",
                                          "vendedor", "bodega", "lista_precios", "incluir_flete", "bfel_status")},
        "personajes": list(personajes.values()),
        "prendas": [{"alias": r.alias, "item_code": r.item_code, "item_name": r.item_name, "qty": r.qty}
                    for r in ses.prendas],
        "pedidos": pedidos,
        "documentos": _documentos(pedidos, personajes, docs),
    }


def _documentos(pedidos, personajes, docs) -> list:
    """Pestaña «Cotizar y Facturar»: una tarjeta por documento de venta (y una
    por cliente con lo que aún no está en ninguno), en su grupo. Como en
    FacEx, la forma de pago se indica en la factura, no en la cotización:
    Cotizaciones → por_cotizar · por_confirmar
    Facturación  → listos (borrador confirmado) · por_forma_pago (facturada sin
    pago ni contra entrega) · pendiente_guia (contra entrega sin guía) ·
    facturadas (ciclo completo)."""
    out = {}
    for p in pedidos:
        if not p.cliente or p.estado in ("Cancelado", "Por revisar", "En espera"):
            continue
        d = docs.get(p.cotizacion) if p.cotizacion else None
        if not d and p.estado not in EN_COTIZACION:
            continue
        key = d.name if d else f"cli:{p.cliente}"
        doc = out.setdefault(key, {
            "key": key, "cliente": p.cliente, "nombre": p.cliente_nombre or p.cliente, "telefono": p.telefono,
            "cotizacion": d.name if d else "", "info": dict(d) if d else {}, "pedidos": [], "lineas": [],
            "estados": set(), "subtotal": 0.0, "numero_guia": "", "consultas": [], "tiene_consultas": 0,
        })
        per = personajes.get(_norm(p.alias)) or {}
        doc["pedidos"].append(p.name)
        doc["estados"].add(p.estado)
        doc["lineas"].append({"pedido": p.name, "alias": p.alias, "cantidad": cint(p.cantidad) or 1,
                              "uom": p.uom, "estado": p.estado})
        doc["subtotal"] += flt(per.get("precio")) * _cant_stock(p, per)
        if p.numero_guia:
            doc["numero_guia"] = p.numero_guia
        if p.mensaje:
            doc["consultas"].append({"pedido": p.name, "alias": p.alias, "llegada": str(p.llegada or ""),
                                     "mensaje": p.mensaje, "consulta": cint(p.consulta)})
            doc["tiene_consultas"] = doc["tiene_consultas"] or cint(p.consulta)
        if p.metodo_pago:
            doc["metodo_pago"], doc["referencia_pago"] = p.metodo_pago, p.referencia_pago or ""
    abiertas = {}
    for doc in out.values():
        if doc["info"].get("docstatus") == 0:
            abiertas.setdefault(doc["cliente"], []).append(doc["cotizacion"])
    for doc in out.values():
        doc["estados"] = sorted(doc["estados"])
        st = doc["info"].get("docstatus")
        if not doc["cotizacion"]:
            doc["grupo"] = "por_cotizar"
            doc["abiertas"] = abiertas.get(doc["cliente"], [])
        elif st == 0:
            doc["grupo"] = "listos" if _listo_para_facturar(doc["estados"]) else "por_confirmar"
        elif st == 2:
            doc["grupo"] = "facturadas"
        elif cint(doc["info"].get("bfel_pago_contra_entrega")):
            doc["grupo"] = "facturadas" if doc["numero_guia"] else "pendiente_guia"
        elif not cint(doc["info"].get("custom_pagado")):
            doc["grupo"] = "por_forma_pago"
        else:
            doc["grupo"] = "facturadas"
    return sorted(out.values(), key=lambda d: ((d["nombre"] or "").lower(), d["cotizacion"]))


def _listo_para_facturar(estados) -> bool:
    """Todos los pedidos confirmados (Pagado / Contra entrega son de antes,
    cuando el cobro se marcaba en la cotización)."""
    return bool(estados) and set(estados) <= {"Confirmado", "Pagado", "Contra entrega"}


def _info_item(item_code, bodega, price_list) -> dict:
    it = frappe.db.get_value("Item", item_code, ["item_name", "image", "stock_uom"], as_dict=True) or {}
    stock = flt(frappe.db.get_value("Bin", {"item_code": item_code, "warehouse": bodega}, "actual_qty")) if bodega else None
    return {"item_code": item_code, "item_name": it.get("item_name") or item_code, "image": it.get("image") or "",
            "uom": it.get("stock_uom") or "", "stock": stock, "precio": _precio(item_code, price_list)}


@frappe.whitelist()
def item_escaneado(txt: str, bodega: str = None, price_list: str = None, company: str = None) -> dict:
    """Código leído con el escáner (QR o barras) o escrito: código de barras
    exacto o código de producto exacto, de la compañía. Devuelve lo que la
    sesión muestra del ítem: nombre, foto principal, stock en la bodega y precio."""
    from facex_multi.api.item import _variantes_layout_teclado

    company = _company(company)
    _require(company, "live_sesiones")
    txt = (txt or "").strip()
    item_code = None
    for cand in _variantes_layout_teclado(txt) if txt else []:
        item_code = frappe.db.get_value("Item Barcode", {"barcode": cand}, "parent") or (
            cand if frappe.db.exists("Item", cand) else None)
        if item_code:
            break
    it = frappe.db.get_value("Item", item_code, ["disabled", "bfel_company"], as_dict=True) if item_code else None
    if not it or it.disabled or (it.bfel_company and it.bfel_company != company):
        frappe.throw(f"No se encontró un producto con el código «{txt}».")
    return _info_item(item_code, bodega, price_list)


@frappe.whitelist()
def info_items(items_json: str, bodega: str = None, price_list: str = None) -> dict:
    """Nombre, foto, stock en la bodega y precio de los ítems de la sesión."""
    items = frappe.parse_json(items_json) or []
    return {i: _info_item(i, bodega, price_list) for i in items if i and frappe.db.exists("Item", i)}


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
                  origen="Manual", wa_msg_id=None, cliente=None, uom="") -> "frappe.Document":
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
        "uom": _uom_valida(personajes.get(_norm(alias)), uom) or None,
        "mensaje": mensaje or "", "wa_msg_id": wa_msg_id or None,
    })
    ped.flags.ignore_permissions = True
    ped.insert()
    if ped.estado == "Mío":
        _reacomodar(ses.name, alias)
    return ped


@frappe.whitelist()
def registrar_mio(sesion: str, telefono: str, alias: str = "", cantidad: int = 1, nombre: str = "",
                  captura: str = "", mensaje: str = "", llegada: str = None, cliente: str = None,
                  uom: str = "") -> dict:
    """Registro manual desde la bandeja. `captura` = file_url ya subido (opcional)."""
    ses = _sesion(sesion)
    _require(ses.company, "live_acceso")
    if ses.estado != "Abierta":
        frappe.throw("La sesión está cerrada.")
    ped = _crear_pedido(ses, telefono, alias, cantidad, nombre, mensaje, llegada, "Manual", cliente=cliente, uom=uom)
    if captura:
        _adjuntar_url(ped, captura)
    frappe.db.commit()
    return {"name": ped.name, "estado": frappe.db.get_value(PEDIDO, ped.name, "estado")}


def _uom_valida(per, uom) -> str:
    """La unidad pedida si la prenda del personaje la maneja; si no, ninguna
    (= unidad de inventario)."""
    if not uom or not per:
        return ""
    return uom if uom in {u["uom"] for u in per.get("uoms") or []} else ""


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
    if "uom" in data:
        ped.uom = _uom_valida(_personajes(ses).get(_norm(data.get("alias", ped.alias))), data["uom"]) or None
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
        if nuevo == "Cancelado":
            if data.get("motivo_cancelacion") not in MOTIVOS_CANCELACION:
                frappe.throw("Elija el motivo de la cancelación.")
            ped.motivo_cancelacion = data["motivo_cancelacion"]
        ped.estado = nuevo
    elif ped.estado == "Por revisar" and ped.cliente and ped.alias:
        ped.estado = "Mío"  # ya revisado: entra a la cola en su orden de llegada

    antes = frappe.db.get_value(PEDIDO, ped.name, ["cliente", "alias", "cantidad", "uom", "estado"], as_dict=True)
    cotizacion_antes = ped.cotizacion
    cambio_conjuntos = ped.cotizacion and any(
        str(antes.get(f) or "") != str(ped.get(f) or "") for f in ("cliente", "alias", "cantidad", "uom", "estado"))
    if ped.cotizacion and (ped.cliente != antes.cliente or ped.estado == "Cancelado"):
        ped.cotizacion = None  # sale del documento: era de otro cliente o se canceló

    ped.flags.ignore_permissions = True
    ped.save()
    for a in {alias_antes, ped.alias}:
        _reacomodar(ses.name, a)
    aviso = _resincronizar(ses, cotizacion_antes) if cambio_conjuntos else ""
    frappe.db.commit()
    return {"name": ped.name, "estado": frappe.db.get_value(PEDIDO, ped.name, "estado"), "aviso": aviso}


def _resincronizar(ses, inv) -> str:
    """Un cambio en la bandeja (personaje, cantidad, unidad, cliente, cancelar)
    se refleja en la cotización en borrador: se vuelve a armar con los pedidos
    que siguen en ella. Si ya no le queda ninguno, se elimina el borrador
    (con el permiso de FacEx para eliminar borradores). Las facturas validadas
    no se tocan."""
    if not inv or frappe.db.get_value("Sales Invoice", inv, "docstatus") != 0:
        return ""
    if not _perms(ses.company).get("puede_guardar"):
        return f"La cotización {inv} no se actualizó: no tiene permiso para guardar."
    pedidos = _pedidos_doc(ses, inv)
    if pedidos:
        _armar(ses, pedidos[0].cliente, pedidos, inv)
        return ""
    return _eliminar_borrador(inv)


def _eliminar_borrador(inv) -> str:
    from facex_multi.api.invoice import delete_draft_invoice
    try:
        delete_draft_invoice(inv)
        return f"La cotización {inv} se eliminó (ya no tenía pedidos)."
    except frappe.PermissionError:
        frappe.clear_messages()
        return f"La cotización {inv} quedó en borrador: no tiene permiso para eliminar borradores."


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

_CAMPOS_PED = ["name", "cliente", "alias", "cantidad", "uom", "estado", "cotizacion", "metodo_pago",
               "referencia_pago", "numero_guia"]


def _pedidos_doc(ses, inv, estados=EN_COTIZACION):
    """Pedidos de la sesión que están en el documento de venta `inv`."""
    return frappe.get_all(PEDIDO, filters={"sesion": ses.name, "cotizacion": inv, "estado": ["in", estados]},
                          fields=_CAMPOS_PED, order_by="llegada asc")


def _pedidos_sin_documento(ses, cliente):
    return frappe.get_all(PEDIDO, filters={"sesion": ses.name, "cliente": cliente, "estado": ["in", EN_COTIZACION],
                                           "cotizacion": ["is", "not set"]},
                          fields=_CAMPOS_PED, order_by="llegada asc")


def _borradores_cliente(ses, cliente) -> list:
    invs = {p.cotizacion for p in frappe.get_all(
        PEDIDO, filters={"sesion": ses.name, "cliente": cliente, "cotizacion": ["is", "set"]}, fields=["cotizacion"])}
    return [i for i in invs if frappe.db.get_value("Sales Invoice", i, "docstatus") == 0]


def _doc_de_sesion(ses, inv, cliente=None):
    """Valida que `inv` sea un documento de esta sesión (y del cliente)."""
    filtros = {"sesion": ses.name, "cotizacion": inv}
    if cliente:
        filtros["cliente"] = cliente
    if not inv or not frappe.db.exists(PEDIDO, filtros):
        frappe.throw(f"El documento {inv} no es de esta sesión.")
    return frappe.db.get_value("Sales Invoice", inv, ["name", "docstatus", "customer"], as_dict=True)


@frappe.whitelist()
def armar_cotizacion(sesion: str, cliente: str, destino: str = "") -> dict:
    """Cotiza los pedidos del cliente que aún no están en ningún documento.
    `destino`: el número de una cotización en borrador del cliente para
    sumarlos a ella, o «nueva» para crear otra. Si el cliente ya tiene una
    abierta y no se indica, se pregunta (la pantalla manda el destino)."""
    ses = _sesion(sesion)
    _require(ses.company, "live_acceso", "puede_guardar")
    nuevos = _pedidos_sin_documento(ses, cliente)
    if not nuevos:
        frappe.throw("El cliente no tiene pedidos pendientes de cotizar en esta sesión.")
    abiertas = _borradores_cliente(ses, cliente)
    if not destino:
        if abiertas:
            frappe.throw("El cliente ya tiene una cotización abierta: elija si los suma a ella o crea una nueva.")
        destino = "nueva"
    if destino == "nueva":
        return _armar(ses, cliente, nuevos, None)
    if destino not in abiertas:
        frappe.throw(f"La cotización {destino} no está abierta para este cliente.")
    return _armar(ses, cliente, _pedidos_doc(ses, destino) + nuevos, destino)


def _armar(ses, cliente, pedidos, nombre) -> dict:
    """Crea (nombre=None) o rehace la cotización (Sales Invoice en borrador)
    con exactamente estos pedidos, más el flete de la lista."""
    from facex_multi.api.invoice import get_defaults, save_draft

    personajes = _personajes(ses)
    items = {}
    for p in pedidos:
        per = personajes.get(_norm(p.alias))
        if not per:
            frappe.throw(f"El personaje «{p.alias}» ya no está en la sesión.")
        uom = p.uom or per["uom"]
        factor = next((u["factor"] for u in per["uoms"] if u["uom"] == uom), 1.0)
        for r in per["prendas"]:
            row = items.setdefault((r["item_code"], uom), {
                "item_code": r["item_code"], "qty": 0, "uom": uom, "rate": r["rate"] * factor})
            row["qty"] += r["qty"] * (cint(p.cantidad) or 1)

    defaults = get_defaults(ses.company)
    series = defaults.get("naming_series") or []
    est = (defaults.get("establishments") or [{}])[0].get("establecimiento_id")
    cust = frappe.db.get_value("Customer", cliente, ["customer_name", "tax_id", "bfel_id_receptor"],
                               as_dict=True) or {}
    contra = any(p.estado == "Contra entrega" for p in pedidos)

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
        "bfel_status": ses.bfel_status or defaults.get("bfel_status_default") or "01 Enviar",
        "bfel_nit": cust.get("bfel_id_receptor") or cust.get("tax_id") or "CF",
        "bfel_nombre": cust.get("customer_name") or "",
        "bfel_pago_contra_entrega": 1 if contra else 0,
        "facex_incluir_flete": cint(ses.incluir_flete),
        "facex_flete_amount": 0,
        "terms": f"Live {ses.titulo or ses.name} — {', '.join(p.alias for p in pedidos)}",
        "items": [{
            "item_code": r["item_code"], "qty": r["qty"], "rate": r["rate"], "uom": r["uom"],
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
def anotar_guia(sesion: str, cotizacion: str, numero_guia: str, transportista: str = None) -> dict:
    """Solo se anota el número de guía; lo demás se llena solo. La liquidación
    del transportista sigue su flujo normal."""
    from facex_multi.api.invoice import clean_numero_guia, save_guias_transporte

    ses = _sesion(sesion)
    _require(ses.company, "live_acceso")
    numero = clean_numero_guia(numero_guia)
    if not numero:
        frappe.throw("Escriba el número de guía.")
    inv = _doc_de_sesion(ses, cotizacion).name
    pedidos = _pedidos_doc(ses, inv, EN_COTIZACION + ("Facturado",))
    si = frappe.get_doc("Sales Invoice", inv)
    cliente = si.customer
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
    # Cambiar la guía ya anotada reemplaza su fila en vez de sumar otra.
    anterior = next((p.numero_guia for p in pedidos if p.numero_guia), "")
    fila = next((g for g in si.get("bfel_guias_transportista") or [] if anterior and g.numero_guia == anterior), None)
    if fila:
        fila.update({"transportista": transportista, "numero_guia": numero, "monto_cod": row["monto_cod"]})
        si.save()
    elif si.docstatus == 1:
        save_guias_transporte(si.name, frappe.as_json([row]))
    else:
        si.append("bfel_guias_transportista", row)
        si.save()
    for p in pedidos:
        frappe.db.set_value(PEDIDO, p.name, "numero_guia", numero)
    frappe.db.commit()
    return {"invoice": si.name, "numero_guia": numero}


# ---------------------------------------------------------------------------
# Acciones por documento (pestaña «Cotizar y Facturar»)
# ---------------------------------------------------------------------------

# En la cotización solo se confirma; la forma de pago va en la factura.
ESTADOS_DOCUMENTO = ("Confirmado", "Pagado", "Contra entrega")
METODOS_PAGO = ("Transferencia", "Depósito", "Efectivo", "Tarjeta de Crédito")


@frappe.whitelist()
def estado_documento(sesion: str, cotizacion: str, estado: str, metodo_pago: str = "",
                     referencia_pago: str = "") -> dict:
    """Cotización en borrador: Confirmado (lo confirmó el cliente por WA).
    Factura ya validada: indicar la forma de pago, Pagado (método y
    referencia) o Contra entrega, con los pagos de FacEx (save_payments)."""
    ses = _sesion(sesion)
    _require(ses.company, "live_acceso")
    if estado not in ESTADOS_DOCUMENTO:
        frappe.throw(f"Estado no válido: {estado}")
    si = _doc_de_sesion(ses, cotizacion)
    if si.docstatus == 0:
        if estado != "Confirmado":
            frappe.throw("La forma de pago se indica después de facturar.")
        pedidos = _pedidos_doc(ses, cotizacion)
        if not pedidos:
            frappe.throw("El documento no tiene pedidos activos.")
        for p in pedidos:
            frappe.db.set_value(PEDIDO, p.name, {"estado": "Confirmado", "metodo_pago": None, "referencia_pago": None})
        aviso = _resincronizar(ses, cotizacion)
        frappe.db.commit()
        return {"cotizacion": cotizacion, "estado": estado, "aviso": aviso}

    if si.docstatus != 1:
        frappe.throw("El documento está anulado.")
    if estado == "Confirmado":
        frappe.throw("La factura ya está validada.")
    _registrar_pago(si, estado, metodo_pago, referencia_pago)
    for p in _pedidos_doc(ses, cotizacion, ("Facturado",)):
        frappe.db.set_value(PEDIDO, p.name, {
            "metodo_pago": metodo_pago if estado == "Pagado" else "Contra Entrega",
            "referencia_pago": referencia_pago if estado == "Pagado" else None,
        })
    frappe.db.commit()
    return {"cotizacion": cotizacion, "estado": estado}


def _registrar_pago(si, estado, metodo_pago="", referencia_pago=""):
    """Pago por el total de la factura con save_payments (como la pestaña
    Pagos de FacEx). Contra Entrega no genera Payment Entry y marca la
    factura contra entrega."""
    from facex_multi.api.invoice import save_payments

    if estado == "Pagado" and metodo_pago not in METODOS_PAGO:
        frappe.throw("Elija el método de pago.")
    if cint(si.get("custom_pagado")):
        frappe.throw("La factura ya tiene forma de pago; se cambia desde FacEx.")
    pago = {
        "payment_method": "Contra Entrega" if estado == "Contra entrega" else metodo_pago,
        "payment_date": today(),
        "reference": "" if estado == "Contra entrega" else (referencia_pago or ""),
        "amount": flt(si.grand_total),
    }
    save_payments(si.name, frappe.as_json([pago]), "1")


@frappe.whitelist()
def cancelar_documento(sesion: str, cotizacion: str, motivo: str) -> dict:
    """Cancela con su motivo todos los pedidos de una cotización en borrador
    (ya tiene correlativo) y elimina el borrador con el permiso de FacEx para
    eliminar borradores. Los conjuntos se liberan para los que estén en espera."""
    ses = _sesion(sesion)
    _require(ses.company, "live_acceso")
    if motivo not in MOTIVOS_CANCELACION:
        frappe.throw("Elija el motivo de la cancelación.")
    si = _doc_de_sesion(ses, cotizacion)
    if si.docstatus != 0:
        frappe.throw("El documento ya está facturado: se anula desde FacEx, no desde el live.")
    pedidos = _pedidos_doc(ses, cotizacion)
    for p in pedidos:
        frappe.db.set_value(PEDIDO, p.name, {"estado": "Cancelado", "motivo_cancelacion": motivo, "cotizacion": None})
    for alias in {p.alias for p in pedidos}:
        _reacomodar(ses.name, alias)
    aviso = _eliminar_borrador(cotizacion)
    frappe.db.commit()
    return {"cancelados": len(pedidos), "aviso": aviso}


@frappe.whitelist()
def formato_vista(sesion: str, cotizacion: str) -> dict:
    """Formato de impresión para la vista rápida del documento: el de
    cotización en borrador, el de factura certificada si ya se validó."""
    from facex_multi.api.whatsapp import _print_format

    ses = _sesion(sesion)
    _require(ses.company, "live_acceso")
    si = _doc_de_sesion(ses, cotizacion)
    return {"format": _print_format(ses.company, "factura" if si.docstatus == 1 else "cotizacion") or ""}


# ---------------------------------------------------------------------------
# Facturar en lote
# ---------------------------------------------------------------------------

@frappe.whitelist()
def facturar_listos(sesion: str, cotizacion: str = None) -> dict:
    """Por cada cotización en borrador con todos sus pedidos confirmados: la
    rehace, valida y certifica en FEL (submit → certify, como FacEx Screen).
    La forma de pago se indica después en la tarjeta de la factura; solo si
    el pedido ya traía Pagado / Contra entrega (flujo anterior) se registra aquí.
    Con `cotizacion`, solo esa (botón Facturar de la tarjeta)."""
    from facex_multi.api.invoice import certify_invoice, submit_invoice

    ses = _sesion(sesion)
    _require(ses.company, "live_acceso", "live_facturar", "puede_guardar", "puede_validar", "puede_certificar")

    activos = frappe.get_all(PEDIDO, filters={"sesion": ses.name, "estado": ["in", EN_COTIZACION],
                                              "cotizacion": ["is", "set"]},
                             fields=["cotizacion", "cliente", "estado"])
    por_doc = {}
    for p in activos:
        por_doc.setdefault(p.cotizacion, {"cliente": p.cliente, "estados": set()})["estados"].add(p.estado)
    listos = [inv for inv, x in por_doc.items()
              if _listo_para_facturar(x["estados"])
              and frappe.db.get_value("Sales Invoice", inv, "docstatus") == 0]
    if cotizacion:
        if cotizacion not in listos:
            frappe.throw(f"{cotizacion} no está lista para facturar (todos sus pedidos deben estar confirmados).")
        listos = [cotizacion]

    resultados = []
    for inv in listos:
        cliente = por_doc[inv]["cliente"]
        res = {"cliente": cliente, "nombre": frappe.db.get_value("Customer", cliente, "customer_name"), "invoice": inv}
        try:
            pedidos = _pedidos_doc(ses, inv)
            _armar(ses, cliente, pedidos, inv)
            submit_invoice(inv)
            frappe.db.commit()
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

        contra = any(p.estado == "Contra entrega" for p in pedidos)
        pagado = next((p for p in pedidos if p.estado == "Pagado"), None)
        if contra or pagado:
            try:
                _registrar_pago(frappe.get_doc("Sales Invoice", inv), "Contra entrega" if contra else "Pagado",
                                (pagado and pagado.metodo_pago) or "Transferencia",
                                (pagado and pagado.referencia_pago) or "")
                frappe.db.commit()
                res["pago"] = True
            except Exception as e:
                frappe.db.rollback()
                res["error_pago"] = _msg(e)
        resultados.append(res)

    return {"resultados": resultados, "pendientes": len([i for i in por_doc if i not in listos])}


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

    personajes = _personajes(ses)
    alias = _alias_en_texto(texto, personajes)
    cant, uom = _cantidad_uom_en_texto(texto, [u["uom"] for u in (personajes.get(_norm(alias)) or {}).get("uoms", [])])
    ped = _crear_pedido(ses, telefono, alias, cant, nombre, texto, llegada_dt,
                        "Bot WhatsApp", wa_msg_id=msg_id, uom=uom)
    if _es_consulta(texto, alias):
        # «¿todavía hay Luffy? mío» no es un pedido seguro: lo decide el vendedor.
        ped.db_set({"consulta": 1, "estado": "Por revisar"} if "?" in texto else {"consulta": 1})
        if "?" in texto and alias:
            _reacomodar(ses.name, alias)
    if imagen:
        _guardar_imagen(ped, imagen, imagen_nombre or "captura.jpg")
    frappe.db.commit()
    return {"pedido": ped.name, "estado": frappe.db.get_value(PEDIDO, ped.name, "estado"), "alias": alias}


SEGUIMIENTO_MIN = 5  # minutos después del «mío» en que los mensajes del cliente se le juntan


@frappe.whitelist()
def recibir_seguimiento(linea: str, telefono: str, texto: str = "", llegada: str = None, msg_id: str = None,
                        imagen: str = None, imagen_nombre: str = "captura.jpg", company: str = None) -> dict:
    """Mensaje SIN «mío» que el cliente manda poco después de su «mío»: se le
    junta a su último pedido del bot. Si el pedido no tiene personaje y el
    texto lo nombra, se lo pone; si no tiene captura y llega una imagen, la
    usa. Cualquier otra cosa (preguntas, tallas, instrucciones) queda en el
    mensaje del pedido y lo marca «Tiene consultas»; nunca crea pedidos."""
    company = _company(company)
    _require(company, "live_acceso")
    linea, tel = _tel8(linea), _tel8(telefono)
    llegada_dt = get_datetime(llegada) if llegada else now_datetime()
    ses_name = frappe.db.get_value(
        SESION, {"company": company, "estado": "Abierta", "linea_whatsapp": linea,
                 "abierta_desde": ["<=", llegada_dt]}, "name", order_by="abierta_desde desc")
    if not ses_name:
        return {"ignorado": f"la línea {linea} no tiene sesión abierta"}
    name = frappe.db.get_value(
        PEDIDO, {"sesion": ses_name, "telefono": tel, "origen": "Bot WhatsApp",
                 "estado": ["not in", ("Cancelado", "Facturado")],
                 "llegada": ["between", (add_to_date(llegada_dt, minutes=-SEGUIMIENTO_MIN), llegada_dt)]},
        "name", order_by="llegada desc, creation desc")
    if not name:
        return {"ignorado": "sin «mío» reciente de ese teléfono"}
    ped = frappe.get_doc(PEDIDO, name)
    vistos = (ped.wa_seguimiento or "").split()
    if msg_id and msg_id in vistos:
        return {"ignorado": "duplicado", "pedido": name}

    cambios, uso = {}, []
    if imagen and not ped.captura:
        _guardar_imagen(ped, imagen, imagen_nombre or "captura.jpg")
        uso.append("captura")
    texto = (texto or "").strip()
    if texto:
        alias = ""
        if not ped.alias:
            personajes = _personajes(frappe.get_doc(SESION, ses_name))
            alias = _alias_en_texto(texto, personajes)
            if alias:
                cant, uom = _cantidad_uom_en_texto(
                    f"{ped.mensaje or ''} {texto}", [u["uom"] for u in personajes[_norm(alias)]["uoms"]])
                cambios.update({"alias": alias, "cantidad": cant, "uom": uom or None})
                if ped.estado == "Por revisar" and ped.cliente and not ped.consulta:
                    cambios["estado"] = "Mío"
                uso.append("personaje")
        if _es_consulta(texto, alias or ped.alias):
            cambios["consulta"] = 1
            uso.append("consulta")
        cambios["mensaje"] = f"{ped.mensaje or ''}\n[{llegada_dt.strftime('%H:%M')}] {texto}".strip()
    if msg_id:
        cambios["wa_seguimiento"] = " ".join(vistos + [msg_id])
    if cambios:
        ped.db_set(cambios)
    if "personaje" in uso:
        _reacomodar(ses_name, cambios["alias"])
    frappe.db.commit()
    return {"pedido": name, "uso": uso, "estado": frappe.db.get_value(PEDIDO, name, "estado"),
            "alias": cambios.get("alias") or ped.alias}


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
