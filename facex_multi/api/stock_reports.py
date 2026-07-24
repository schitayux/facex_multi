"""
facex_multi.api.stock_reports
-------------------------------
Reportes de Inventario del page FacEx: Kardex de Movimientos, Existencias
(status/antigüedad/sin rotación) y Trazabilidad Serie/Lote.
Solo lectura — consultas directas sobre Stock Entry / Stock Ledger Entry /
Bin / Serial No / Batch nativos de ERPNext. No se recalcula valuación ni stock.
"""
from __future__ import annotations

import frappe
from frappe.utils import today, get_first_day, get_last_day, add_days, getdate, flt

from facex_multi.api.invoice import get_effective_company, get_user_companies
from facex_multi.api.permissions import get_facex_inventory_permissions
from facex_multi.api.si_carga import _get_establishments
from facex_multi.api.stock import get_warehouses_for_establecimiento



def _check_report_access(company: str, perm_field: str) -> str:
    company = get_effective_company(company)
    if company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)
    perms = get_facex_inventory_permissions(company)
    if not perms.get(perm_field):
        frappe.throw("No tiene permiso para ver este reporte de inventario.", frappe.PermissionError)
    return company


class _NoWarehousesForEstablecimiento(Exception):
    """Señal interna: la sucursal filtrada no tiene almacenes asignados."""


def _establecimiento_condition(company: str, establecimiento, alias: str = "sle"):
    """
    Retorna (condicion_sql_o_None, valor_para_params). Si se pidió filtrar por
    una sucursal sin almacenes asignados, lanza _NoWarehousesForEstablecimiento
    para que el caller retorne una lista vacía sin ejecutar la consulta.
    """
    if establecimiento is None:
        return None, None
    wh_list = get_warehouses_for_establecimiento(company, establecimiento)
    if not wh_list:
        raise _NoWarehousesForEstablecimiento()
    return f"{alias}.warehouse IN %(wh_list)s", tuple(wh_list)


# ---------------------------------------------------------------------------
# 1. Kardex de Movimientos (Entradas + Salidas + Transferencias)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_kardex(
    company: str = None,
    from_date: str = None,
    to_date: str = None,
    movement_type: str = None,
    warehouse: str = None,
    item_code: str = None,
    establecimiento: str = None,
):
    """
    Kardex completo: TODO documento que haya afectado el stock de la compañía
    (Stock Entry, Factura de Venta con update_stock, Compras, Notas de Entrega,
    Conciliación de Inventario, etc.) — se lee de Stock Ledger Entry, la fuente
    única y voucher-agnóstica de ERPNext, no solo lo creado por este módulo.

    'Cuenta Contable' y 'Comentario' solo se resuelven para Stock Entry (de
    donde este módulo captura esos datos); para otros orígenes quedan vacíos —
    no hay un campo equivalente genérico entre todos los tipos de documento.

    'Valor Acumulado' es una corrida (running total) en orden cronológico
    ascendente: Entradas suman, Salidas restan, Transferencias NO afectan
    (es el mismo valor moviéndose dentro de la compañía).
    """
    company = _check_report_access(company, "reporte_inv_kardex")

    from_date = from_date or get_first_day(today())
    to_date = to_date or get_last_day(today())

    conditions = [
        "sle.company = %(company)s",
        "sle.posting_date BETWEEN %(from_date)s AND %(to_date)s",
    ]
    params = {"company": company, "from_date": from_date, "to_date": to_date}

    is_transfer_sql = "(sle.voucher_type = 'Stock Entry' AND se.purpose = 'Material Transfer')"
    if movement_type == "transfer":
        conditions.append(is_transfer_sql)
    elif movement_type == "in":
        conditions.append(f"sle.actual_qty > 0 AND NOT {is_transfer_sql}")
    elif movement_type == "out":
        conditions.append(f"sle.actual_qty < 0 AND NOT {is_transfer_sql}")

    if warehouse:
        conditions.append("sle.warehouse = %(warehouse)s")
        params["warehouse"] = warehouse

    if item_code:
        conditions.append("sle.item_code = %(item_code)s")
        params["item_code"] = item_code

    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "sle")
    except _NoWarehousesForEstablecimiento:
        return {"from_date": str(from_date), "to_date": str(to_date), "rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    where_clause = " AND ".join(conditions)

    rows = frappe.db.sql(
        f"""
        SELECT
            sle.name AS sle_name, sle.voucher_type, sle.voucher_no,
            sle.posting_date, sle.item_code, i.item_name,
            sle.actual_qty, sle.stock_uom, sle.warehouse, sle.company, sle.valuation_rate,
            sle.stock_value_difference, sle.is_cancelled,
            sle.batch_no, sle.serial_no,
            w.bfel_establecimiento,
            sed.expense_account,
            se.purpose AS se_purpose, se.remarks AS se_remarks
        FROM `tabStock Ledger Entry` sle
        LEFT JOIN `tabItem` i ON i.name = sle.item_code
        LEFT JOIN `tabWarehouse` w ON w.name = sle.warehouse
        LEFT JOIN `tabStock Entry` se ON se.name = sle.voucher_no AND sle.voucher_type = 'Stock Entry'
        LEFT JOIN `tabStock Entry Detail` sed ON sed.name = sle.voucher_detail_no AND sle.voucher_type = 'Stock Entry'
        WHERE {where_clause}
        ORDER BY sle.posting_date ASC, sle.posting_datetime ASC, sle.creation ASC
        LIMIT 1000
        """,
        params,
        as_dict=True,
    )

    est_map = {e["id"]: e["nombre"] for e in _get_establishments(company)}

    running = 0.0
    for r in rows:
        is_transfer = r.voucher_type == "Stock Entry" and r.se_purpose == "Material Transfer"
        r["movement_type_label"] = "Transferencia" if is_transfer else ("Entrada" if r.actual_qty > 0 else "Salida")
        r["status_label"] = "Anulado" if r.is_cancelled else "Activo"
        r["establecimiento_nombre"] = est_map.get(r.bfel_establecimiento, "Sin asignar" if not r.bfel_establecimiento else r.bfel_establecimiento)
        if not is_transfer and not r.is_cancelled:
            running += flt(r.stock_value_difference)
        r["accumulated_value"] = running

    return {"from_date": str(from_date), "to_date": str(to_date), "rows": rows}


# ---------------------------------------------------------------------------
# 2. Existencias: status por almacén / antigüedad / sin rotación
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_stock_status(company: str = None, warehouse: str = None, item_code: str = None, establecimiento: str = None):
    """Balance actual por almacén (Bin) — foto de hoy."""
    company = _check_report_access(company, "reporte_inv_existencias")

    conditions = ["w.company = %(company)s", "b.actual_qty != 0"]
    params = {"company": company}
    if warehouse:
        conditions.append("b.warehouse = %(warehouse)s")
        params["warehouse"] = warehouse
    if item_code:
        conditions.append("b.item_code = %(item_code)s")
        params["item_code"] = item_code
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "b")
    except _NoWarehousesForEstablecimiento:
        return {"rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT b.item_code, i.item_name, b.warehouse, b.actual_qty, b.valuation_rate,
               (b.actual_qty * b.valuation_rate) AS stock_value
        FROM `tabBin` b
        INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
        LEFT JOIN `tabItem` i ON i.name = b.item_code
        WHERE {" AND ".join(conditions)}
        ORDER BY b.item_code ASC, b.warehouse ASC
        LIMIT 1000
        """,
        params,
        as_dict=True,
    )
    return {"rows": rows}


@frappe.whitelist()
def get_stock_aging(company: str = None, warehouse: str = None, item_code: str = None, establecimiento: str = None):
    """
    Antigüedad práctica: días desde el ÚLTIMO ingreso (Stock Ledger Entry con
    actual_qty > 0) por ítem+almacén con stock actual. No es FIFO layer-by-layer
    (eso es Stock Ageing nativo de ERPNext) — es una referencia simple y rápida
    de leer para el usuario final.
    """
    company = _check_report_access(company, "reporte_inv_existencias")

    conditions = ["w.company = %(company)s", "b.actual_qty > 0"]
    params = {"company": company}
    if warehouse:
        conditions.append("b.warehouse = %(warehouse)s")
        params["warehouse"] = warehouse
    if item_code:
        conditions.append("b.item_code = %(item_code)s")
        params["item_code"] = item_code
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "b")
    except _NoWarehousesForEstablecimiento:
        return {"rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT b.item_code, i.item_name, b.warehouse, b.actual_qty,
               (
                   SELECT MAX(sle.posting_date)
                   FROM `tabStock Ledger Entry` sle
                   WHERE sle.item_code = b.item_code
                     AND sle.warehouse = b.warehouse
                     AND sle.actual_qty > 0
                     AND sle.is_cancelled = 0
               ) AS last_receipt_date
        FROM `tabBin` b
        INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
        LEFT JOIN `tabItem` i ON i.name = b.item_code
        WHERE {" AND ".join(conditions)}
        ORDER BY b.item_code ASC, b.warehouse ASC
        LIMIT 1000
        """,
        params,
        as_dict=True,
    )

    today_date = getdate(today())
    for r in rows:
        if r.last_receipt_date:
            r["days_in_stock"] = (today_date - getdate(r.last_receipt_date)).days
        else:
            r["days_in_stock"] = None
        d = r["days_in_stock"]
        if d is None:
            r["bucket"] = "Sin dato"
        elif d <= 30:
            r["bucket"] = "0-30 días"
        elif d <= 60:
            r["bucket"] = "31-60 días"
        elif d <= 90:
            r["bucket"] = "61-90 días"
        else:
            r["bucket"] = "+90 días"

    return {"rows": rows}


@frappe.whitelist()
def get_non_moving_items(company: str = None, warehouse: str = None, days: int = 60, item_code: str = None, establecimiento: str = None):
    """
    Productos con stock actual que NO han tenido ninguna salida (actual_qty < 0
    en Stock Ledger Entry — cualquier documento: Stock Entry, Factura de Venta,
    Nota de Entrega, etc.) en los últimos `days` días.
    """
    company = _check_report_access(company, "reporte_inv_existencias")
    days = 60 if days is None or days == "" else int(days)
    cutoff = add_days(today(), -days)

    conditions = ["w.company = %(company)s", "b.actual_qty > 0"]
    params = {"company": company, "cutoff": cutoff}
    if warehouse:
        conditions.append("b.warehouse = %(warehouse)s")
        params["warehouse"] = warehouse
    if item_code:
        conditions.append("b.item_code = %(item_code)s")
        params["item_code"] = item_code
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "b")
    except _NoWarehousesForEstablecimiento:
        return {"days": days, "cutoff": str(cutoff), "rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT b.item_code, i.item_name, b.warehouse, b.actual_qty, b.valuation_rate,
               (
                   SELECT MAX(sle.posting_date)
                   FROM `tabStock Ledger Entry` sle
                   WHERE sle.item_code = b.item_code
                     AND sle.warehouse = b.warehouse
                     AND sle.actual_qty < 0
                     AND sle.is_cancelled = 0
               ) AS last_outgoing_date
        FROM `tabBin` b
        INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
        LEFT JOIN `tabItem` i ON i.name = b.item_code
        WHERE {" AND ".join(conditions)}
        HAVING last_outgoing_date IS NULL OR last_outgoing_date < %(cutoff)s
        ORDER BY b.item_code ASC
        LIMIT 1000
        """,
        params,
        as_dict=True,
    )
    return {"days": days, "cutoff": str(cutoff), "rows": rows}


# ---------------------------------------------------------------------------
# 3. Trazabilidad por Serie / Lote
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_serial_traceability(company: str = None, item_code: str = None, serial_no: str = None, warehouse: str = None, establecimiento: str = None):
    company = _check_report_access(company, "reporte_inv_trazabilidad")

    conditions = ["s.company = %(company)s"]
    params = {"company": company}
    if item_code:
        conditions.append("s.item_code = %(item_code)s")
        params["item_code"] = item_code
    if serial_no:
        conditions.append("s.name LIKE %(serial_no)s")
        params["serial_no"] = f"%{serial_no}%"
    if warehouse:
        conditions.append("s.warehouse = %(warehouse)s")
        params["warehouse"] = warehouse
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "s")
    except _NoWarehousesForEstablecimiento:
        return {"rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT s.name AS serial_no, s.item_code, i.item_name, s.warehouse, s.status,
               lt.voucher_type AS reference_doctype, lt.voucher_no AS reference_name,
               lt.posting_date,
               CASE lt.voucher_type
                   WHEN 'Sales Invoice' THEN si.customer
                   WHEN 'Delivery Note' THEN dn.customer
                   WHEN 'POS Invoice' THEN pi.customer
                   ELSE NULL
               END AS customer
        FROM `tabSerial No` s
        LEFT JOIN `tabItem` i ON i.name = s.item_code
        LEFT JOIN (
            SELECT serial_no, voucher_type, voucher_no, posting_date
            FROM (
                SELECT sbe.serial_no, sbb.voucher_type, sbb.voucher_no, sbb.posting_date,
                       ROW_NUMBER() OVER (
                           PARTITION BY sbe.serial_no
                           ORDER BY sbb.posting_date DESC, sbb.posting_time DESC, sbb.creation DESC
                       ) AS rn
                FROM `tabSerial and Batch Entry` sbe
                INNER JOIN `tabSerial and Batch Bundle` sbb ON sbb.name = sbe.parent
                WHERE sbb.is_cancelled = 0
            ) ranked
            WHERE rn = 1
        ) lt ON lt.serial_no = s.name
        LEFT JOIN `tabSales Invoice` si ON si.name = lt.voucher_no AND lt.voucher_type = 'Sales Invoice'
        LEFT JOIN `tabDelivery Note` dn ON dn.name = lt.voucher_no AND lt.voucher_type = 'Delivery Note'
        LEFT JOIN `tabPOS Invoice` pi ON pi.name = lt.voucher_no AND lt.voucher_type = 'POS Invoice'
        WHERE {" AND ".join(conditions)}
        ORDER BY s.creation DESC
        LIMIT 500
        """,
        params,
        as_dict=True,
    )
    return {"rows": rows}


@frappe.whitelist()
def get_batch_traceability(company: str = None, item_code: str = None, batch_no: str = None, warehouse: str = None, establecimiento: str = None):
    company = _check_report_access(company, "reporte_inv_trazabilidad")

    conditions = ["sle.company = %(company)s", "sle.batch_no IS NOT NULL", "sle.batch_no != ''", "sle.is_cancelled = 0"]
    params = {"company": company}
    if item_code:
        conditions.append("sle.item_code = %(item_code)s")
        params["item_code"] = item_code
    if batch_no:
        conditions.append("sle.batch_no LIKE %(batch_no)s")
        params["batch_no"] = f"%{batch_no}%"
    if warehouse:
        conditions.append("sle.warehouse = %(warehouse)s")
        params["warehouse"] = warehouse
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "sle")
    except _NoWarehousesForEstablecimiento:
        return {"rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT sle.batch_no, sle.item_code, i.item_name, sle.warehouse,
               SUM(sle.actual_qty) AS qty_in_batch,
               b.expiry_date
        FROM `tabStock Ledger Entry` sle
        LEFT JOIN `tabItem` i ON i.name = sle.item_code
        LEFT JOIN `tabBatch` b ON b.name = sle.batch_no
        WHERE {" AND ".join(conditions)}
        GROUP BY sle.batch_no, sle.item_code, sle.warehouse
        HAVING qty_in_batch != 0
        ORDER BY sle.item_code ASC, sle.batch_no ASC
        LIMIT 500
        """,
        params,
        as_dict=True,
    )
    return {"rows": rows}
