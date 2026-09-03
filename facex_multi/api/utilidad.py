"""
facex_multi.api.utilidad
------------------------
Análisis de Utilidad y Asignación de Precios basada en utilidad para FacEx.

Compara el precio de venta (Item Price, siempre NETO/sin IVA en FacEx) contra tres
bases de costo:

- ``estandar``  → ``Item.custom_costo_estandar`` (ficha del producto).
- ``ponderado`` → promedio ponderado del sistema: ``SUM(qty*valuation_rate)/SUM(qty)``
                  de ``tabBin`` para las bodegas de la compañía (acotado a
                  ``get_facex_allowed_warehouses`` si el usuario está restringido).
- ``ultima_compra`` → tarifa neta de la última ``Purchase Invoice`` validada del ítem
                  (opcionalmente filtrada por proveedor).

El % de utilidad es *markup sobre costo*: ``precio_neto = costo * (1 + util%/100)``.
El IVA se aplica sólo para mostrar el precio con impuesto (``neto * (1 + iva%/100)``);
la utilidad se calcula siempre sobre el neto. La tasa de IVA se toma de la plantilla
de impuestos de venta por defecto de la compañía (override manual desde el front).

Todas las consultas están aisladas por compañía con el mismo criterio ``bfel_company``
que usa ``facex_multi.api.item``.
"""
from __future__ import annotations

import json

import frappe
from frappe.utils import flt

from facex_multi.api.invoice import get_effective_company, has_efast_permission
from facex_multi.api.item import _get_selling_price_list, update_item_price
from facex_multi.api.permissions import (
    get_facex_allowed_warehouses,
    get_facex_permissions_for_company,
)

COST_BASES = ("estandar", "ponderado", "ultima_compra")
DEFAULT_IVA_RATE = 12.0


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------

def _check_report_permission(company: str) -> None:
    if "System Manager" in frappe.get_roles():
        return
    perms = get_facex_permissions_for_company(company)
    if not perms.get("reporte_analisis_utilidad"):
        frappe.throw(
            "No tiene permiso para ver el Análisis de Utilidad.", frappe.PermissionError
        )


def _check_pricing_permission(company: str) -> None:
    if "System Manager" in frappe.get_roles():
        return
    perms = get_facex_permissions_for_company(company)
    if not perms.get("asignacion_precios"):
        frappe.throw(
            "No tiene permiso para la Asignación de Precios.", frappe.PermissionError
        )


@frappe.whitelist()
def has_utilidad_report_permission(company: str = None) -> bool:
    """Espejo liviano para que el front decida si dibuja la vista."""
    if "System Manager" in frappe.get_roles():
        return True
    company = get_effective_company(company)
    return bool(get_facex_permissions_for_company(company).get("reporte_analisis_utilidad"))


# ---------------------------------------------------------------------------
# Helpers de costo
# ---------------------------------------------------------------------------

def _company_item_filter(alias: str = "") -> str:
    """Condición SQL de aislamiento por compañía (mismo criterio que api.item)."""
    p = f"{alias}." if alias else ""
    return f"""(
        {p}bfel_company = %(company)s
        OR (({p}bfel_company IS NULL OR {p}bfel_company = '') AND IFNULL({p}bfel_company_null, 0) = 0)
    )"""


def _get_iva_rate(company: str) -> float:
    """Suma de tasas de la plantilla de impuestos de venta por defecto de la compañía."""
    template = (
        frappe.db.get_value(
            "Sales Taxes and Charges Template", {"company": company, "is_default": 1}, "name"
        )
        or frappe.db.get_value(
            "Sales Taxes and Charges Template",
            {"company": company, "disabled": 0},
            "name",
            order_by="creation asc",
        )
    )
    if not template:
        return DEFAULT_IVA_RATE
    rows = frappe.get_all(
        "Sales Taxes and Charges", filters={"parent": template}, fields=["rate"]
    )
    total = sum(flt(r.rate) for r in rows)
    return total or DEFAULT_IVA_RATE


def _weighted_avg_costs(item_codes: list, company: str, allowed_warehouses) -> dict:
    """{item_code: promedio_ponderado} calculado desde tabBin por compañía."""
    if not item_codes:
        return {}
    params = {"company": company}
    placeholders = ", ".join([f"%(ic{i})s" for i in range(len(item_codes))])
    for i, code in enumerate(item_codes):
        params[f"ic{i}"] = code

    wh_cond = ""
    if allowed_warehouses is not None:
        wh_cond = "AND b.warehouse IN %(allowed_warehouses)s"
        params["allowed_warehouses"] = tuple(allowed_warehouses) or ("",)

    rows = frappe.db.sql(
        f"""
        SELECT b.item_code,
               SUM(b.actual_qty * b.valuation_rate) AS val,
               SUM(b.actual_qty) AS qty
        FROM `tabBin` b
        INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
        WHERE b.item_code IN ({placeholders})
          AND w.company = %(company)s
          {wh_cond}
        GROUP BY b.item_code
        """,
        params,
        as_dict=True,
    )
    out = {}
    for r in rows:
        qty = flt(r.qty)
        out[r.item_code] = flt(r.val) / qty if qty else 0.0
    return out


def _last_purchase_costs(item_codes: list, company: str, supplier: str = None) -> dict:
    """{item_code: tarifa neta de la última Purchase Invoice validada}."""
    if not item_codes:
        return {}
    params = {"company": company}
    placeholders = ", ".join([f"%(ic{i})s" for i in range(len(item_codes))])
    for i, code in enumerate(item_codes):
        params[f"ic{i}"] = code
    supp_cond = ""
    if supplier:
        supp_cond = "AND pi.supplier = %(supplier)s"
        params["supplier"] = supplier

    rows = frappe.db.sql(
        f"""
        SELECT pii.item_code, pii.base_net_rate, pii.base_rate, pi.posting_date, pi.creation
        FROM `tabPurchase Invoice Item` pii
        INNER JOIN `tabPurchase Invoice` pi ON pi.name = pii.parent
        INNER JOIN (
            SELECT pii2.item_code, MAX(pi2.posting_date) AS max_date
            FROM `tabPurchase Invoice Item` pii2
            INNER JOIN `tabPurchase Invoice` pi2 ON pi2.name = pii2.parent
            WHERE pii2.item_code IN ({placeholders})
              AND pi2.docstatus = 1
              AND pi2.company = %(company)s
              {supp_cond}
            GROUP BY pii2.item_code
        ) latest ON latest.item_code = pii.item_code AND pi.posting_date = latest.max_date
        WHERE pi.docstatus = 1
          AND pi.company = %(company)s
          {supp_cond}
        ORDER BY pi.creation DESC
        """,
        params,
        as_dict=True,
    )
    out = {}
    for r in rows:
        if r.item_code in out:
            continue
        out[r.item_code] = flt(r.base_net_rate) or flt(r.base_rate) or 0.0
    return out


def _price_list_rates(item_codes: list, price_list: str) -> dict:
    if not item_codes or not price_list:
        return {}
    rows = frappe.get_all(
        "Item Price",
        filters={"item_code": ["in", item_codes], "price_list": price_list},
        fields=["item_code", "price_list_rate"],
    )
    return {r.item_code: flt(r.price_list_rate) for r in rows}


def _items_for_supplier(company: str, supplier: str) -> set:
    """Códigos de ítem con historial de compra al proveedor dado (esta compañía)."""
    rows = frappe.db.sql(
        """
        SELECT DISTINCT pii.item_code
        FROM `tabPurchase Invoice Item` pii
        INNER JOIN `tabPurchase Invoice` pi ON pi.name = pii.parent
        WHERE pi.docstatus = 1 AND pi.company = %(company)s AND pi.supplier = %(supplier)s
        """,
        {"company": company, "supplier": supplier},
        as_dict=True,
    )
    return {r.item_code for r in rows}


def _fetch_items(company: str, item_group: str = None, item_code: str = None,
                 supplier: str = None, limit: int = 500) -> list:
    """Ítems de la compañía filtrados por grupo / código / proveedor."""
    conditions = ["disabled = 0", _company_item_filter()]
    params = {"company": company}

    if item_code:
        conditions.append("name = %(item_code)s")
        params["item_code"] = item_code
    if item_group:
        conditions.append("item_group = %(item_group)s")
        params["item_group"] = item_group

    supplier_codes = None
    if supplier:
        supplier_codes = _items_for_supplier(company, supplier)
        if not supplier_codes:
            return []
        placeholders = ", ".join([f"%(sc{i})s" for i in range(len(supplier_codes))])
        for i, code in enumerate(supplier_codes):
            params[f"sc{i}"] = code
        conditions.append(f"name IN ({placeholders})")

    where = " AND ".join(conditions)
    return frappe.db.sql(
        f"""
        SELECT name AS item_code, item_name, item_group, stock_uom
        FROM `tabItem`
        WHERE {where}
        ORDER BY item_name ASC
        LIMIT {int(limit)}
        """,
        params,
        as_dict=True,
    )


def _costs_for_items(items: list, company: str, supplier: str = None) -> dict:
    """{item_code: {'estandar':.., 'ponderado':.., 'ultima_compra':..}}"""
    codes = [it["item_code"] for it in items]
    if not codes:
        return {}

    allowed = get_facex_allowed_warehouses(company)
    ponderado = _weighted_avg_costs(codes, company, allowed)
    ultima = _last_purchase_costs(codes, company, supplier)

    estandar_rows = frappe.get_all(
        "Item", filters={"name": ["in", codes]},
        fields=["name", "custom_costo_estandar"],
    )
    estandar = {r.name: flt(r.custom_costo_estandar) for r in estandar_rows}

    out = {}
    for code in codes:
        out[code] = {
            "estandar": estandar.get(code, 0.0),
            "ponderado": ponderado.get(code, 0.0),
            "ultima_compra": ultima.get(code, 0.0),
        }
    return out


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_utility_analysis(cost_basis: str = "estandar", company: str = None,
                         item_group: str = None, item_code: str = None,
                         supplier: str = None, price_list: str = None) -> dict:
    """Informe Análisis de Utilidad."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    _check_report_permission(company)

    cost_basis = cost_basis if cost_basis in COST_BASES else "estandar"
    price_list = price_list or _get_selling_price_list()
    iva_rate = _get_iva_rate(company)

    items = _fetch_items(company, item_group, item_code, supplier)
    costs = _costs_for_items(items, company, supplier)
    rates = _price_list_rates([it["item_code"] for it in items], price_list)
    currency = frappe.db.get_value("Price List", price_list, "currency") or "GTQ"

    rows = []
    negativos = 0
    suma_pct = 0.0
    n_pct = 0
    for it in items:
        code = it["item_code"]
        c = costs.get(code, {})
        costo = flt(c.get(cost_basis))
        neto = flt(rates.get(code, 0.0))
        util_q = neto - costo
        util_pct = (util_q / costo * 100.0) if costo else 0.0
        margen_precio_pct = (util_q / neto * 100.0) if neto else 0.0
        if neto and util_q < 0:
            negativos += 1
        if costo:
            suma_pct += util_pct
            n_pct += 1
        rows.append({
            "item_code": code,
            "item_name": it["item_name"] or "",
            "item_group": it["item_group"] or "",
            "uom": it["stock_uom"] or "",
            "precio_neto": neto,
            "precio_con_iva": neto * (1 + iva_rate / 100.0),
            "costo_estandar": flt(c.get("estandar")),
            "costo_ponderado": flt(c.get("ponderado")),
            "costo_ultima_compra": flt(c.get("ultima_compra")),
            "costo": costo,
            "utilidad_q": util_q,
            "utilidad_pct": util_pct,
            "margen_sobre_precio_pct": margen_precio_pct,
        })

    return {
        "rows": rows,
        "summary": {
            "count": len(rows),
            "con_utilidad_negativa": negativos,
            "util_pct_promedio": (suma_pct / n_pct) if n_pct else 0.0,
            "iva_rate": iva_rate,
            "price_list": price_list,
            "currency": currency,
            "cost_basis": cost_basis,
        },
    }


@frappe.whitelist()
def get_pricing_context(company: str = None) -> dict:
    """Datos de arranque del formulario de Asignación de Precios."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    company = get_effective_company(company)
    _check_pricing_permission(company)
    return {
        "iva_rate": _get_iva_rate(company),
        "default_price_list": _get_selling_price_list(),
    }


@frappe.whitelist()
def get_pricing_rows(company: str = None, supplier: str = None, item_group: str = None,
                     item_code: str = None, price_list: str = None) -> dict:
    """Filas para el formulario de Asignación de Precios."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    _check_pricing_permission(company)

    if not (supplier or item_group or item_code):
        frappe.throw("Indique un proveedor, un grupo de artículos o un ítem para buscar.")

    price_list = price_list or _get_selling_price_list()
    items = _fetch_items(company, item_group, item_code, supplier)
    costs = _costs_for_items(items, company, supplier)
    rates = _price_list_rates([it["item_code"] for it in items], price_list)
    currency = frappe.db.get_value("Price List", price_list, "currency") or "GTQ"

    rows = []
    for it in items:
        code = it["item_code"]
        c = costs.get(code, {})
        rows.append({
            "item_code": code,
            "item_name": it["item_name"] or "",
            "item_group": it["item_group"] or "",
            "uom": it["stock_uom"] or "",
            "costo_estandar": flt(c.get("estandar")),
            "costo_ponderado": flt(c.get("ponderado")),
            "costo_ultima_compra": flt(c.get("ultima_compra")),
            "precio_actual": flt(rates.get(code, 0.0)),
        })

    return {
        "rows": rows,
        "iva_rate": _get_iva_rate(company),
        "price_list": price_list,
        "currency": currency,
    }


@frappe.whitelist()
def apply_utility_prices(rows_json: str, price_list: str = None, company: str = None,
                         guardar_costo_estandar: int = 0) -> dict:
    """Asigna precios de venta (netos) a partir de costo + % de utilidad.

    Cada fila: {item_code, costo, util_pct}. El precio neto se recalcula aquí
    (markup sobre costo) — el valor calculado en el cliente sólo es indicativo.
    """
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    _check_pricing_permission(company)

    rows = json.loads(rows_json) if isinstance(rows_json, str) else rows_json
    if not rows:
        frappe.throw("No hay filas seleccionadas para aplicar.")

    price_list = price_list or _get_selling_price_list()
    guardar_costo_estandar = int(guardar_costo_estandar or 0)

    updated, errors = [], []
    for row in rows:
        code = (row.get("item_code") or "").strip()
        costo = flt(row.get("costo"))
        util_pct = flt(row.get("util_pct"))
        if not code:
            continue
        if costo <= 0:
            errors.append({"item_code": code, "error": "Costo inválido (debe ser > 0)."})
            continue
        neto = costo * (1 + util_pct / 100.0)
        try:
            update_item_price(code, neto, price_list, company)
            if guardar_costo_estandar and frappe.get_meta("Item").has_field("custom_costo_estandar"):
                frappe.db.set_value("Item", code, "custom_costo_estandar", costo)
            updated.append({"item_code": code, "precio_neto": neto})
        except Exception as e:
            errors.append({"item_code": code, "error": str(e)})

    if guardar_costo_estandar:
        frappe.db.commit()

    return {"updated": updated, "errors": errors, "price_list": price_list}


@frappe.whitelist()
def export_utility_analysis_excel(cost_basis: str = "estandar", company: str = None,
                                  item_group: str = None, item_code: str = None,
                                  supplier: str = None, price_list: str = None):
    """Exporta el Análisis de Utilidad a XLSX."""
    data = get_utility_analysis(cost_basis, company, item_group, item_code, supplier, price_list)
    rows = data["rows"]
    if not rows:
        frappe.throw("No hay datos para exportar con los filtros seleccionados.")

    from frappe.utils.xlsxutils import make_xlsx

    headers = [
        "Código", "Nombre", "Grupo", "UOM", "Precio Neto", "Precio c/IVA",
        "Costo Estándar", "Costo Prom. Ponderado", "Último Precio Compra",
        "Costo Usado", "Utilidad Q", "Utilidad %", "Margen s/Precio %",
    ]
    out = [headers]
    for r in rows:
        out.append([
            r["item_code"], r["item_name"], r["item_group"], r["uom"],
            r["precio_neto"], r["precio_con_iva"], r["costo_estandar"],
            r["costo_ponderado"], r["costo_ultima_compra"], r["costo"],
            r["utilidad_q"], round(r["utilidad_pct"], 2), round(r["margen_sobre_precio_pct"], 2),
        ])

    xlsx_file = make_xlsx(out, "Analisis de Utilidad")
    frappe.response["filename"] = "analisis_utilidad.xlsx"
    frappe.response["filecontent"] = xlsx_file.getvalue()
    frappe.response["type"] = "binary"
