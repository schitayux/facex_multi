# -*- coding: utf-8 -*-
"""Entero / Fracción (2026-10-05).

Neko vende docenas y medias docenas del mismo código. Antes la media se
registraba como qty 0.5 en Docena; ahora se registra con su propia unidad de
medida («Media Docena», factor 0.5 sobre la unidad base), en una línea aparte.

  * Configuración por compañía (FacEx Configuracion Compania):
    maneja_fraccion, fraccion_uom, fraccion_factor, fraccion_etiqueta y
    fraccion_unidades_base (unidades base que admiten fracción — Docena sí,
    Unidad/surtidos no).
  * Cada ítem de la compañía cuya unidad base admite fracción lleva en su
    tabla de UdM la unidad de fracción con el factor configurado: ERPNext
    convierte solo (stock_qty = qty × factor) y cotiza la lista de precios de
    la unidad base × factor — no hacen falta listas de precios nuevas.
  * El recargo Contra Entrega sale de UOM.custom_piezas_fisicas (Media Docena
    = 6 piezas) — se siembra al configurar.

Regla de reportes: una venta en la unidad de fracción debe dar EXACTAMENTE los
mismos números que daba qty 0.5 en la unidad base. Todo lo que suma cantidades
usa stock_qty (unidad base).
"""
import io

import frappe
from frappe.utils import cint, flt

CONFIG_DOCTYPE = "FacEx Configuracion Compania"
CHILD_DOCTYPE = "FacEx Unidad Fraccion"

# Códigos de los QR de modo. Sin guiones ni símbolos: los lectores con la
# distribución de teclado equivocada los cambian (ver item._variantes_layout_teclado);
# en pantalla se comparan solo letras y números.
QR_FRACCION = "FXFRACCION"
QR_ENTERO = "FXENTERO"

_OFF = {"activo": 0}


def get_fraction_config(company: str) -> dict:
    """Configuración Entero/Fracción vigente de la compañía ({"activo": 0} si no aplica)."""
    if not company:
        return dict(_OFF)
    cache = getattr(frappe.local, "facex_fraccion_cfg", None)
    if cache is None:
        cache = frappe.local.facex_fraccion_cfg = {}
    if company in cache:
        return cache[company]
    cfg = dict(_OFF)
    if frappe.db.table_exists(CONFIG_DOCTYPE) and frappe.get_meta(CONFIG_DOCTYPE).has_field("maneja_fraccion"):
        row = frappe.db.get_value(
            CONFIG_DOCTYPE, company,
            ["maneja_fraccion", "fraccion_uom", "fraccion_factor", "fraccion_etiqueta"], as_dict=True,
        )
        factor = flt(row.fraccion_factor) if row else 0
        if row and cint(row.maneja_fraccion) and row.fraccion_uom and 0 < factor < 1:
            bases = frappe.get_all(
                CHILD_DOCTYPE,
                filters={"parent": company, "parenttype": CONFIG_DOCTYPE},
                pluck="uom", order_by="idx asc",
            )
            if bases:
                cfg = {
                    "activo": 1,
                    "uom": row.fraccion_uom,
                    "factor": factor,
                    "etiqueta": (row.fraccion_etiqueta or "Media").strip(),
                    "unidades_base": bases,
                    "qr_fraccion": QR_FRACCION,
                    "qr_entero": QR_ENTERO,
                }
    cache[company] = cfg
    return cfg


def clear_cache():
    frappe.local.facex_fraccion_cfg = None


def item_admite_fraccion(stock_uom: str, cfg: dict) -> bool:
    return bool(cfg.get("activo") and stock_uom and stock_uom in cfg["unidades_base"])


def _item_uom_factor(item_code: str, uom: str):
    return frappe.db.get_value(
        "UOM Conversion Detail",
        {"parent": item_code, "parenttype": "Item", "uom": uom},
        "conversion_factor",
    )


def uom_conversion_factor(item_code: str, uom: str, stock_uom: str = None):
    """Factor de `uom` para el ítem según su ficha; 1 si es la unidad base;
    None si la ficha no la tiene."""
    stock_uom = stock_uom or frappe.db.get_value("Item", item_code, "stock_uom")
    if not uom or uom == stock_uom:
        return 1.0
    f = _item_uom_factor(item_code, uom)
    return flt(f) if f else None


# ---------------------------------------------------------------------------
# Ficha del ítem: la unidad de fracción en su tabla de UdM
# ---------------------------------------------------------------------------

def validate_item_fraccion(doc, method=None):
    """Hook Item.validate: un ítem cuya unidad base admite fracción lleva la
    unidad de fracción en su tabla de UdM (ítems nuevos o que cambian de base)."""
    company = doc.get("bfel_company")
    if not company:
        return
    cfg = get_fraction_config(company)
    if not item_admite_fraccion(doc.stock_uom, cfg):
        return
    for row in doc.get("uoms") or []:
        if row.uom == cfg["uom"]:
            if flt(row.conversion_factor) != cfg["factor"]:
                row.conversion_factor = cfg["factor"]
            return
    doc.append("uoms", {"uom": cfg["uom"], "conversion_factor": cfg["factor"]})


def ensure_item_fraction_uom(item_code: str, cfg: dict) -> bool:
    """Agrega (sin guardar toda la ficha) la unidad de fracción a un ítem que
    la admite. True si el ítem quedó con la unidad."""
    stock_uom = frappe.db.get_value("Item", item_code, "stock_uom")
    if not item_admite_fraccion(stock_uom, cfg):
        return False
    current = _item_uom_factor(item_code, cfg["uom"])
    if current is not None:
        if flt(current) != cfg["factor"]:
            frappe.db.set_value(
                "UOM Conversion Detail",
                {"parent": item_code, "parenttype": "Item", "uom": cfg["uom"]},
                "conversion_factor", cfg["factor"], update_modified=False,
            )
        return True
    idx = cint(frappe.db.sql(
        "SELECT MAX(idx) FROM `tabUOM Conversion Detail` WHERE parent=%s AND parenttype='Item'",
        item_code,
    )[0][0]) + 1
    child = frappe.get_doc({
        "doctype": "UOM Conversion Detail",
        "parent": item_code, "parenttype": "Item", "parentfield": "uoms",
        "idx": idx, "uom": cfg["uom"], "conversion_factor": cfg["factor"],
    })
    child.db_insert()
    frappe.clear_document_cache("Item", item_code)
    return True


def backfill_company_items(company: str) -> int:
    """Agrega la unidad de fracción a todos los ítems de la compañía que la admiten."""
    cfg = get_fraction_config(company)
    if not cfg.get("activo"):
        return 0
    items = frappe.get_all(
        "Item",
        filters={"bfel_company": company, "stock_uom": ["in", cfg["unidades_base"]]},
        pluck="name",
    )
    n = 0
    for code in items:
        if _item_uom_factor(code, cfg["uom"]) is None or flt(_item_uom_factor(code, cfg["uom"])) != cfg["factor"]:
            ensure_item_fraction_uom(code, cfg)
            n += 1
    return n


def setup_fraction_uom(cfg: dict):
    """La UdM de fracción existe, es entera (1.5 medias no tiene sentido) y
    lleva sus piezas físicas para el recargo Contra Entrega."""
    uom = cfg["uom"]
    if not frappe.db.exists("UOM", uom):
        frappe.get_doc({"doctype": "UOM", "uom_name": uom, "must_be_whole_number": 1}).insert(ignore_permissions=True)
    else:
        frappe.db.set_value("UOM", uom, "must_be_whole_number", 1, update_modified=False)
    if frappe.get_meta("UOM").has_field("custom_piezas_fisicas") and not cint(
        frappe.db.get_value("UOM", uom, "custom_piezas_fisicas")
    ):
        base = cfg["unidades_base"][0]
        piezas = flt(frappe.db.get_value("UOM", base, "custom_piezas_fisicas")) * cfg["factor"]
        if piezas and piezas == int(piezas):
            frappe.db.set_value("UOM", uom, "custom_piezas_fisicas", int(piezas), update_modified=False)


def on_config_update(company: str):
    """Configuración Compañía guardada: prepara la UdM y la ficha de los ítems."""
    clear_cache()
    cfg = get_fraction_config(company)
    if not cfg.get("activo"):
        return
    setup_fraction_uom(cfg)
    backfill_company_items(company)


# ---------------------------------------------------------------------------
# Validación del servidor (factura / movimientos de inventario)
# ---------------------------------------------------------------------------

def resolve_row_conversion(item_code: str, uom: str, company: str, where: str = ""):
    """Factor de conversión con el que se graba una fila. Para la unidad de
    fracción exige que el ítem la admita (y la agrega a la ficha si faltaba).
    Para otras unidades devuelve el de la ficha o None si no la tiene (el
    llamador decide: hoy se conserva el comportamiento previo)."""
    stock_uom = frappe.db.get_value("Item", item_code, "stock_uom")
    if not uom or uom == stock_uom:
        return 1.0
    cfg = get_fraction_config(company)
    if cfg.get("activo") and uom == cfg["uom"]:
        if not ensure_item_fraction_uom(item_code, cfg):
            frappe.throw(
                f"{where}{item_code}: su unidad base ({stock_uom}) no admite "
                f"«{uom}». Véndalo en {stock_uom}."
            )
        return cfg["factor"]
    return uom_conversion_factor(item_code, uom, stock_uom)


# ---------------------------------------------------------------------------
# Hoja de QR de modo
# ---------------------------------------------------------------------------

def _qr_svg(text: str) -> str:
    import pyqrcode
    buf = io.BytesIO()
    pyqrcode.create(text, error="M").svg(buf, scale=7, quiet_zone=2, xmldecl=False, svgns=True)
    return buf.getvalue().decode("utf-8")


@frappe.whitelist()
def get_mode_qr_sheet(company: str = None) -> dict:
    """SVG de los dos QR de modo (Fracción / Entero) para imprimir y pegar
    junto al lector."""
    from facex_multi.api.invoice import get_effective_company
    company = get_effective_company(company)
    cfg = get_fraction_config(company)
    if not cfg.get("activo"):
        frappe.throw("La compañía no tiene activo «Leer/Seleccionar Entero/Fracción».")
    return {
        "fraccion": {"code": QR_FRACCION, "label": cfg["etiqueta"], "uom": cfg["uom"], "svg": _qr_svg(QR_FRACCION)},
        "entero": {"code": QR_ENTERO, "label": "Entero", "svg": _qr_svg(QR_ENTERO)},
    }
