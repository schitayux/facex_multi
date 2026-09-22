# -*- coding: utf-8 -*-
"""Recargo "Contra entrega" por pieza física y Flete como cargos del documento.

Contexto (Neko, 2026-09): las listas de precios COD llevaban embebido en el
`rate` un recargo de Q1.00 por pieza física (Docena = 12 piezas, Unidad = 1)
que se le paga al repartidor. Ese dinero no es ingreso de la empresa, pero al
ir dentro del precio del ítem se contabilizaba como venta. Lo mismo pasaba con
"Incluir Flete", que agregaba una línea con el ítem FLETE-xxx.

Diseño:
  * `UOM.custom_piezas_fisicas`  → piezas físicas por unidad de venta (12 / 1).
    Las UdM se quedan con factor de conversión 1 (así lo usa inventario).
  * `Price List.custom_recargo_por_pieza` → Q por pieza. > 0 = la lista lleva
    recargo. Es el ÚNICO disparador (no la condición de pago).
  * Por línea: `Sales Invoice Item.facex_recargo` = qty × piezas × Q/pieza y
    `facex_total_con_recargo` = importe + recargo (informativos, read-only).
  * Por documento: filas tipo "Actual" en `taxes` (Sales Taxes and Charges)
    marcadas con `facex_tipo_cargo` — "Recargo" (Σ líneas) y "Flete"
    (`facex_flete_amount`) — contra las cuentas de pasivo configuradas en
    FacEx Settings (registro de la compañía). El Grand Total que paga el
    cliente no cambia; lo que cambia es que el ítem se factura a precio neto
    y el recargo/flete no toca la cuenta de Ingresos.
  * `recargo_flete_con_iva` (FacEx Settings): si está ON cada cargo se parte
    en neto (cuenta pasivo) + IVA (cuenta del IVA de la plantilla). Pendiente
    de definición del contador; por defecto OFF (fila sin IVA).

Las filas se reconstruyen en `before_validate` porque ERPNext calcula los
totales dentro de su propio `validate` (accounts_controller.validate →
calculate_taxes_and_totals) y los hooks `validate` corren después.
"""
from __future__ import annotations

import frappe
from frappe.utils import cint, flt

TIPO_RECARGO = "Recargo"
TIPO_FLETE = "Flete"
TIPO_IVA_RECARGO = "IVA Recargo"
TIPO_IVA_FLETE = "IVA Flete"
TIPOS_CARGO = (TIPO_RECARGO, TIPO_FLETE, TIPO_IVA_RECARGO, TIPO_IVA_FLETE)

DESC_RECARGO = "Recargo por entrega"
DESC_FLETE = "Flete"

# Piezas físicas sugeridas para las UdM conocidas cuando el campo está en 0.
_PIEZAS_SEED = {"Docena": 12, "Unidad": 1, "Nos.": 1, "Unit": 1}


# ---------------------------------------------------------------------------
# Custom fields (after_migrate, idempotente)
# ---------------------------------------------------------------------------

def ensure_recargo_flete_fields():
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    create_custom_fields(
        {
            "UOM": [
                {
                    "fieldname": "custom_piezas_fisicas",
                    "label": "Piezas físicas por unidad (FacEx)",
                    "fieldtype": "Int",
                    "insert_after": "must_be_whole_number",
                    "description": "Cuántas piezas físicas representa 1 de esta UdM al vender "
                                   "(Docena = 12, Unidad = 1). Se usa para el recargo por pieza "
                                   "de las listas Contra Entrega; NO altera el factor de conversión.",
                },
            ],
            "Price List": [
                {
                    "fieldname": "custom_recargo_por_pieza",
                    "label": "Recargo por pieza (Contra Entrega)",
                    "fieldtype": "Currency",
                    "insert_after": "custom_es_contra_entrega",
                    "description": "Q por pieza física que se cobra al cliente y se paga al "
                                   "repartidor. > 0 = las facturas con esta lista llevan la fila "
                                   "\"Recargo por entrega\" en cargos (no es ingreso). Los precios "
                                   "de la lista deben ser NETOS (sin el recargo).",
                },
            ],
            "Sales Taxes and Charges": [
                {
                    "fieldname": "facex_tipo_cargo",
                    "label": "Tipo de cargo FacEx",
                    "fieldtype": "Data",
                    "insert_after": "description",
                    "read_only": 1,
                    "hidden": 1,
                    "description": "Recargo / Flete / IVA Recargo / IVA Flete — fila generada por FacEx.",
                },
            ],
            "Sales Invoice Item": [
                {
                    "fieldname": "facex_recargo",
                    "label": "Recargo entrega",
                    "fieldtype": "Currency",
                    "insert_after": "amount",
                    "read_only": 1,
                    "no_copy": 1,
                    "print_hide": 1,
                    "description": "qty × piezas físicas × recargo por pieza de la lista. Informativo: "
                                   "el monto real va en la fila de cargos del documento.",
                },
                {
                    "fieldname": "facex_total_con_recargo",
                    "label": "Total c/recargo",
                    "fieldtype": "Currency",
                    "insert_after": "facex_recargo",
                    "read_only": 1,
                    "no_copy": 1,
                    "print_hide": 1,
                    "description": "Importe + recargo. Informativo, no participa en los totales.",
                },
            ],
            "Sales Invoice": [
                {
                    "fieldname": "facex_recargo_section",
                    "label": "Recargo / Flete (FacEx)",
                    "fieldtype": "Section Break",
                    "insert_after": "bfel_pago_contra_entrega",
                    "collapsible": 1,
                },
                {
                    "fieldname": "facex_incluir_flete",
                    "label": "Incluir Flete",
                    "fieldtype": "Check",
                    "insert_after": "facex_recargo_section",
                },
                {
                    "fieldname": "facex_flete_amount",
                    "label": "Monto de Flete",
                    "fieldtype": "Currency",
                    "insert_after": "facex_incluir_flete",
                    "read_only": 1,
                    "description": "Se toma del precio del Ítem de Flete en la lista de precios de la "
                                   "factura. Solo editable con el permiso 'Editar Precio Manualmente en Venta'.",
                },
                {
                    "fieldname": "facex_flete_amount_original",
                    "label": "Flete según lista (auditoría)",
                    "fieldtype": "Currency",
                    "insert_after": "facex_flete_amount",
                    "read_only": 1,
                    "hidden": 1,
                    "no_copy": 1,
                },
                {
                    "fieldname": "facex_recargo_total",
                    "label": "Recargo por entrega (total)",
                    "fieldtype": "Currency",
                    "insert_after": "facex_flete_amount_original",
                    "read_only": 1,
                    "no_copy": 1,
                },
            ],
        },
        ignore_validate=True,
        update=True,
    )

    # Semilla de piezas físicas para las UdM conocidas (solo si están en 0).
    for uom, piezas in _PIEZAS_SEED.items():
        if frappe.db.exists("UOM", uom) and not cint(frappe.db.get_value("UOM", uom, "custom_piezas_fisicas")):
            frappe.db.set_value("UOM", uom, "custom_piezas_fisicas", piezas, update_modified=False)
    frappe.db.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _meta_ready(doc) -> bool:
    """Entre desplegar el código y correr `bench migrate` los campos pueden no
    existir todavía; en ese caso no hacemos nada (código defensivo)."""
    return (
        doc.meta.has_field("facex_recargo_total")
        and frappe.get_meta("Sales Taxes and Charges").has_field("facex_tipo_cargo")
        and frappe.get_meta("Price List").has_field("custom_recargo_por_pieza")
    )


def get_recargo_por_pieza(price_list: str) -> float:
    if not price_list or not frappe.get_meta("Price List").has_field("custom_recargo_por_pieza"):
        return 0.0
    return flt(frappe.db.get_value("Price List", price_list, "custom_recargo_por_pieza"))


def get_piezas_map() -> dict:
    """{uom: piezas físicas} para todas las UdM con valor > 0."""
    if not frappe.get_meta("UOM").has_field("custom_piezas_fisicas"):
        return {}
    rows = frappe.get_all("UOM", filters={"custom_piezas_fisicas": [">", 0]},
                          fields=["name", "custom_piezas_fisicas"])
    return {r.name: cint(r.custom_piezas_fisicas) for r in rows}


def _piezas(uom: str, cache: dict) -> int:
    if not uom:
        return 0
    if uom not in cache:
        cache[uom] = cint(frappe.db.get_value("UOM", uom, "custom_piezas_fisicas")) if frappe.get_meta("UOM").has_field("custom_piezas_fisicas") else 0
    return cache[uom]


def get_flete_rate(company: str, price_list: str) -> float:
    """Precio del Ítem de Flete (FacEx Settings.item_flete) en la lista dada."""
    from facex_multi.api.permissions import get_facex_flete_item
    item = get_facex_flete_item(company)
    if not item or not price_list:
        return 0.0
    return flt(frappe.db.get_value(
        "Item Price", {"item_code": item, "price_list": price_list, "selling": 1},
        "price_list_rate", order_by="valid_from desc",
    ))


def _cargo_accounts(company: str) -> dict:
    from facex_multi.api.permissions import get_facex_company_config
    cfg = get_facex_company_config(company)
    return {
        "recargo": cfg.get("cuenta_recargo_entrega") or "",
        "flete": cfg.get("cuenta_flete") or "",
        "con_iva": cint(cfg.get("recargo_flete_con_iva")),
    }


def _iva_row(doc):
    """Fila de IVA de la plantilla (no generada por FacEx) con tasa > 0, o None."""
    for t in doc.get("taxes") or []:
        if t.get("facex_tipo_cargo"):
            continue
        if t.charge_type == "On Net Total" and flt(t.rate) > 0:
            return t
    return None


# ---------------------------------------------------------------------------
# Hooks Sales Invoice
# ---------------------------------------------------------------------------

def apply_recargo_y_flete(doc, method=None):
    """Hook Sales Invoice.before_validate.

    1. Calcula `facex_recargo` por línea (qty × piezas(UdM) × Q/pieza de la lista).
    2. Reconstruye las filas de cargos FacEx en `taxes`: quita las anteriores y,
       si hay recargo o flete, agrega filas "Actual" contra las cuentas de
       FacEx Settings (partidas en neto + IVA si `recargo_flete_con_iva`).
    Idempotente: se puede guardar N veces.
    """
    if not _meta_ready(doc):
        return

    rpp = get_recargo_por_pieza(doc.get("selling_price_list"))
    from facex_multi.api.permissions import get_facex_flete_item
    flete_item = get_facex_flete_item(doc.company)

    cache = {}
    total_recargo = 0.0
    for it in doc.get("items") or []:
        it.facex_recargo = 0.0
        if rpp <= 0 or (flete_item and it.item_code == flete_item):
            continue
        uom = it.get("uom") or it.get("stock_uom") or frappe.db.get_value("Item", it.item_code, "stock_uom")
        it.facex_recargo = flt(flt(it.qty) * _piezas(uom, cache) * rpp, 2)
        total_recargo += it.facex_recargo
    doc.facex_recargo_total = flt(total_recargo, 2)

    flete = flt(doc.get("facex_flete_amount")) if cint(doc.get("facex_incluir_flete")) else 0.0
    if not cint(doc.get("facex_incluir_flete")):
        doc.facex_flete_amount = 0.0
        doc.facex_flete_amount_original = 0.0
    if cint(doc.get("is_return")) and flete > 0:
        flete = -flete

    # Quitar filas FacEx previas conservando el resto (plantilla IVA).
    keep = [t for t in (doc.get("taxes") or []) if not t.get("facex_tipo_cargo")]
    doc.set("taxes", keep)
    for i, t in enumerate(doc.taxes, start=1):
        t.idx = i

    if abs(total_recargo) < 0.005 and abs(flete) < 0.005:
        return

    # Sin filas de plantilla todavía (form estándar: set_taxes corre en validate
    # y solo si `taxes` está vacío) → cargarlas nosotros para que el IVA no se
    # pierda por culpa de nuestras filas.
    if doc.get("taxes_and_charges") and not doc.taxes:
        doc.append_taxes_from_master()

    accts = _cargo_accounts(doc.company)
    faltan = []
    if abs(total_recargo) >= 0.005 and not accts["recargo"]:
        faltan.append("Cuenta de Recargo por entrega")
    if abs(flete) >= 0.005 and not accts["flete"]:
        faltan.append("Cuenta de Flete")
    if faltan:
        frappe.throw(
            "FacEx Settings (registro de la compañía {0}): falta configurar {1}. "
            "Sin esa cuenta no se puede registrar el recargo/flete como cargo del documento.".format(
                doc.company, " y ".join(faltan)),
            title="Recargo / Flete sin cuenta contable",
        )

    iva = _iva_row(doc) if accts["con_iva"] else None
    cost_center = frappe.get_cached_value("Company", doc.company, "cost_center")

    def _add(tipo, desc, account, amount):
        if abs(amount) < 0.005:
            return
        doc.append("taxes", {
            "charge_type": "Actual",
            "account_head": account,
            "description": desc,
            "rate": 0,
            "tax_amount": flt(amount, 2),
            "included_in_print_rate": 0,
            "cost_center": cost_center,
            "facex_tipo_cargo": tipo,
        })

    def _split(gross):
        """(neto, iva) — el monto que ve el cliente es `gross`."""
        if not iva:
            return gross, 0.0
        neto = flt(gross / (1 + flt(iva.rate) / 100.0), 2)
        return neto, flt(gross - neto, 2)

    neto, imp = _split(flt(total_recargo, 2))
    _add(TIPO_RECARGO, DESC_RECARGO, accts["recargo"], neto)
    if iva:
        _add(TIPO_IVA_RECARGO, "IVA " + DESC_RECARGO, iva.account_head, imp)

    neto, imp = _split(flt(flete, 2))
    _add(TIPO_FLETE, DESC_FLETE, accts["flete"], neto)
    if iva:
        _add(TIPO_IVA_FLETE, "IVA " + DESC_FLETE, iva.account_head, imp)


def set_totales_con_recargo(doc, method=None):
    """Hook Sales Invoice.validate (después de calculate_taxes_and_totals):
    `facex_total_con_recargo` por línea = importe ya calculado + recargo."""
    if not doc.meta.has_field("facex_recargo_total"):
        return
    for it in doc.get("items") or []:
        rec = flt(it.get("facex_recargo"))
        it.facex_total_con_recargo = flt(flt(it.amount) + rec, 2) if rec else 0.0


def resolve_flete_for_payload(data: dict, company: str, price_list: str, can_edit_price: bool) -> str:
    """Usado por save_draft: fija facex_flete_amount / _original en el payload.

    - Casilla apagada → 0.
    - Casilla encendida → precio del Ítem de Flete en la lista de la factura.
      Solo con `puede_editar_precio` se respeta un monto manual distinto; en
      ese caso se guarda el precio de lista en `_original` y se devuelve el
      texto del comentario de auditoría para el timeline (o "").
    """
    if not cint(data.get("facex_incluir_flete")):
        data["facex_incluir_flete"] = 0
        data["facex_flete_amount"] = 0.0
        data["facex_flete_amount_original"] = 0.0
        return ""

    from facex_multi.api.permissions import get_facex_flete_item
    if not get_facex_flete_item(company):
        frappe.throw("No hay Ítem de Flete configurado en FacEx Settings para esta compañía.")

    lookup = get_flete_rate(company, price_list)
    sent = flt(data.get("facex_flete_amount"))
    data["facex_incluir_flete"] = 1
    if can_edit_price and sent > 0 and abs(sent - lookup) > 0.005:
        data["facex_flete_amount"] = flt(sent, 2)
        data["facex_flete_amount_original"] = flt(lookup, 2)
        return (
            "Flete editado manualmente por {0}: Q {1:,.2f} (precio de lista '{2}': Q {3:,.2f})".format(
                frappe.session.user, flt(sent, 2), price_list or "-", flt(lookup, 2))
        )
    if lookup <= 0:
        frappe.throw(
            "El Ítem de Flete no tiene precio en la lista '{0}'. Agregue el precio a la lista "
            "o desmarque \"Incluir Flete\".".format(price_list or "-"),
            title="Flete sin precio",
        )
    data["facex_flete_amount"] = flt(lookup, 2)
    data["facex_flete_amount_original"] = 0.0
    return ""


# ---------------------------------------------------------------------------
# API para los pages (FacEx Clásico / FacEx Screen)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_recargo_context(company: str = None, price_list: str = None) -> dict:
    """Todo lo que el page necesita para estimar recargo/flete localmente y
    decidir si muestra las columnas Recargo / Total c/recargo."""
    from facex_multi.api.invoice import get_effective_company
    from facex_multi.api.permissions import (
        get_facex_can_edit_price, get_facex_company_config, get_facex_flete_item,
    )
    company = get_effective_company(company)
    cfg = get_facex_company_config(company)
    rpp = get_recargo_por_pieza(price_list)
    return {
        "price_list": price_list or "",
        "recargo_por_pieza": rpp,
        "piezas": get_piezas_map(),
        "flete_item": get_facex_flete_item(company),
        "flete_rate": get_flete_rate(company, price_list),
        "puede_editar_flete": bool(get_facex_can_edit_price(company)),
        "con_iva": cint(cfg.get("recargo_flete_con_iva")),
        "cuenta_recargo": cfg.get("cuenta_recargo_entrega") or "",
        "cuenta_flete": cfg.get("cuenta_flete") or "",
    }


def cargos_facex_por_factura(invoice_names: list) -> dict:
    """{invoice: {"recargo": x, "flete": y}} desde las filas de cargos FacEx
    (bruto: neto + IVA cuando aplica). Para Cierre Diario y reportes."""
    out = {}
    if not invoice_names or not frappe.get_meta("Sales Taxes and Charges").has_field("facex_tipo_cargo"):
        return out
    rows = frappe.get_all(
        "Sales Taxes and Charges",
        filters={"parenttype": "Sales Invoice", "parent": ["in", invoice_names],
                 "facex_tipo_cargo": ["in", list(TIPOS_CARGO)]},
        fields=["parent", "facex_tipo_cargo", "tax_amount"],
    )
    for r in rows:
        d = out.setdefault(r.parent, {"recargo": 0.0, "flete": 0.0})
        key = "flete" if r.facex_tipo_cargo in (TIPO_FLETE, TIPO_IVA_FLETE) else "recargo"
        d[key] += flt(r.tax_amount)
    return out
