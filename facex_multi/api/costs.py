"""
facex_multi.api.costs
---------------------
Módulo compartido de bases de costo de FacEx. Centraliza el cálculo de las tres
bases de costo que maneja el sistema, para que las consuman por igual el Análisis
de Utilidad / Asignación de Precios (``api.utilidad``), los reportes e ingresos de
Inventario (``api.stock_reports`` / ``api.stock``) y el mantenimiento de Costos a
Ítems (``api.item``).

Bases:
- ``estandar``      → ``Item.custom_costo_estandar`` (costo estándar propio de FacEx,
                      fijado a mano en la ficha o desde «Costos a Ítems»).
- ``ponderado``     → promedio ponderado del sistema:
                      ``SUM(qty * valuation_rate) / SUM(qty)`` de ``tabBin`` para las
                      bodegas de la compañía (acotado a ``get_facex_allowed_warehouses``
                      si el usuario está restringido).
- ``ultima_compra`` → tarifa NETA de la última ``Purchase Invoice`` validada del ítem
                      (opcionalmente filtrada por proveedor).

Solo lectura. No recalcula valuación ni stock (eso vive en ERPNext core).
"""
from __future__ import annotations

import frappe
from frappe.utils import flt

COST_BASES = ("estandar", "ponderado", "ultima_compra")

COST_BASIS_LABELS = {
    "estandar": "Costo Estándar (FacEx)",
    "ponderado": "Promedio Ponderado",
    "ultima_compra": "Último Precio de Compra",
}


def normalize_basis(basis: str | None) -> str:
    """Devuelve una base válida — cae a ``estandar`` para cualquier valor desconocido."""
    return basis if basis in COST_BASES else "estandar"


def weighted_avg_costs(item_codes: list, company: str, allowed_warehouses=None) -> dict:
    """{item_code: promedio_ponderado} calculado desde ``tabBin`` por compañía."""
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


def last_purchase_costs(item_codes: list, company: str, supplier: str = None) -> dict:
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


def standard_costs(item_codes: list) -> dict:
    """{item_code: Item.custom_costo_estandar}. Vacío si el campo no existe todavía."""
    if not item_codes:
        return {}
    if not frappe.get_meta("Item").has_field("custom_costo_estandar"):
        return {code: 0.0 for code in item_codes}
    rows = frappe.get_all(
        "Item", filters={"name": ["in", list(item_codes)]},
        fields=["name", "custom_costo_estandar"],
    )
    return {r.name: flt(r.custom_costo_estandar) for r in rows}


def get_item_costs(item_codes, company: str, supplier: str = None, allowed_warehouses=None) -> dict:
    """
    {item_code: {'estandar':.., 'ponderado':.., 'ultima_compra':..}} para todos los
    códigos pedidos (siempre presentes, con 0.0 donde no haya dato).

    ``allowed_warehouses`` acota el promedio ponderado; pásalo si el usuario está
    restringido (``get_facex_allowed_warehouses``). ``None`` = todas las bodegas.
    """
    codes = list(dict.fromkeys(c for c in (item_codes or []) if c))
    if not codes:
        return {}

    ponderado = weighted_avg_costs(codes, company, allowed_warehouses)
    ultima = last_purchase_costs(codes, company, supplier)
    estandar = standard_costs(codes)

    return {
        code: {
            "estandar": flt(estandar.get(code, 0.0)),
            "ponderado": flt(ponderado.get(code, 0.0)),
            "ultima_compra": flt(ultima.get(code, 0.0)),
        }
        for code in codes
    }


def resolve_cost(item_code: str, company: str, basis: str, costs: dict = None,
                 allowed_warehouses=None) -> float:
    """Costo del ítem en la base indicada. ``costs`` puede venir precalculado
    (dict de get_item_costs) para evitar consultas repetidas."""
    basis = normalize_basis(basis)
    if costs is None or item_code not in costs:
        costs = get_item_costs([item_code], company, allowed_warehouses=allowed_warehouses)
    return flt((costs.get(item_code) or {}).get(basis, 0.0))
