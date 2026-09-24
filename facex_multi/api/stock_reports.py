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

from facex_multi.api.costs import (
    COST_BASIS_LABELS,
    get_item_costs,
    normalize_basis,
    resolve_cost,
)
from facex_multi.api.invoice import get_effective_company, get_user_companies
from facex_multi.api.permissions import (
    get_facex_allowed_warehouses,
    get_facex_can_view_costs,
    get_facex_inventory_permissions,
)
from facex_multi.api.si_carga import _get_establishments
from facex_multi.api.stock import get_warehouses_for_establecimiento


def _strip_cost_fields(rows: list, fields: tuple) -> None:
    """Anula en sitio los campos monetarios de costo cuando el usuario no tiene
    permiso `puede_ver_costos`. Así ni el front ni las exportaciones reciben el dato."""
    for r in rows:
        for f in fields:
            if f in r:
                r[f] = None


def _parse_list(val):
    """Acepta lista, JSON de lista o cadena separada por comas. Devuelve list[str]."""
    if not val:
        return []
    if isinstance(val, (list, tuple)):
        return [str(v).strip() for v in val if str(v).strip()]
    if isinstance(val, str):
        val = val.strip()
        if val.startswith("["):
            try:
                return [str(v).strip() for v in frappe.parse_json(val) if str(v).strip()]
            except Exception:
                pass
        return [v.strip() for v in val.split(",") if v.strip()]
    return []


def _item_group_condition(item_groups, params, alias="i"):
    """(condicion_sql_o_None) filtrando por uno o varios grupos de artículo."""
    groups = _parse_list(item_groups)
    if not groups:
        return None
    params["item_groups"] = tuple(groups)
    return f"{alias}.item_group IN %(item_groups)s"


def _sort_rows(rows, sort_by, sort_dir, numeric_keys=()):
    """Ordena `rows` (list[dict]) por `sort_by`. Numérico para numeric_keys, texto
    para el resto; None siempre al final. Sin `sort_by` no toca el orden."""
    if not sort_by or not rows or sort_by not in rows[0]:
        return rows
    reverse = str(sort_dir or "asc").lower() == "desc"
    is_num = sort_by in numeric_keys

    def key(r):
        v = r.get(sort_by)
        if v is None or v == "":
            return (1, 0 if is_num else "")
        if is_num:
            return (0, flt(v))
        return (0, str(v).lower())

    return sorted(rows, key=key, reverse=reverse)



def _check_report_access(company: str, perm_field: str) -> str:
    company = get_effective_company(company)
    if company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)
    perms = get_facex_inventory_permissions(company)
    if not perms.get(perm_field):
        frappe.throw("No tiene permiso para ver este reporte de inventario.", frappe.PermissionError)
    return company


def _warehouse_condition(company: str, warehouse, alias: str = "sle"):
    """
    Retorna (condicion_sql_o_None, params_dict) acotando el reporte a las
    bodegas habilitadas del usuario (FacEx Settings > bodegas_habilitadas).
    `warehouse` acepta selección múltiple (lista, JSON de lista o CSV, vía
    _parse_list) o un solo código (retrocompatible).
    - Bodega(s) explícita(s) fuera de lo permitido -> PermissionError.
    - Sin bodega explícita y hay restricción -> condición IN sobre la lista
      permitida (no se puede dejar "todas" cuando el usuario está acotado).
    - Sin restricción configurada -> sin condición (comportamiento actual).
    """
    from facex_multi.api.permissions import get_facex_allowed_warehouses
    allowed = get_facex_allowed_warehouses(company)
    warehouses = _parse_list(warehouse)

    if warehouses:
        if allowed is not None:
            invalid = [w for w in warehouses if w not in allowed]
            if invalid:
                frappe.throw(
                    f"No tiene permiso para ver la bodega '{invalid[0]}' en este informe.",
                    frappe.PermissionError,
                )
        return f"{alias}.warehouse IN %(warehouse_list)s", {"warehouse_list": tuple(warehouses)}

    if allowed is not None:
        return f"{alias}.warehouse IN %(allowed_warehouses)s", {"allowed_warehouses": tuple(allowed) or ("",)}

    return None, {}


def _owner_condition(owners, alias: str = None):
    """Retorna (condicion_sql_o_None, params_dict) acotando el reporte a una
    selección múltiple de usuarios creadores. None sin filtro (todos)."""
    owner_list = _parse_list(owners)
    if not owner_list:
        return None, {}
    col = f"{alias}.owner" if alias else "owner"
    return f"{col} IN %(owner_list)s", {"owner_list": tuple(owner_list)}


def _scoped_owner_condition(company: str, owners, alias: str, dominio: str = "inventario"):
    """_owner_condition según el alcance del usuario (FacEx Settings / Perfil):
    «Solo lo creado por mí» fuerza sus propios documentos sin importar el
    filtro del frontend; «Toda la compañía» deja mandar al filtro (vacío =
    todos). `dominio`: inventario (movimientos) o compras (Entradas por
    Proveedor, que sale de Facturas de Compra)."""
    from facex_multi.api.permissions import SCOPE_OWN, get_facex_scope
    if get_facex_scope(company, dominio) == SCOPE_OWN:
        return _owner_condition([frappe.session.user], alias)
    return _owner_condition(owners, alias)


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
    owners=None,
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

    wh_cond, wh_params = _warehouse_condition(company, warehouse, "sle")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)

    owner_cond, owner_params = _scoped_owner_condition(company, owners, "sle")
    if owner_cond:
        conditions.append(owner_cond)
        params.update(owner_params)

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

    can_costs = get_facex_can_view_costs(company)
    if not can_costs:
        _strip_cost_fields(rows, ("valuation_rate", "stock_value_difference", "accumulated_value"))

    return {
        "from_date": str(from_date), "to_date": str(to_date),
        "rows": rows, "can_view_costs": can_costs,
    }


# ---------------------------------------------------------------------------
# 2. Existencias: status por almacén / antigüedad / sin rotación
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_stock_status(company: str = None, warehouse: str = None, item_code: str = None,
                     establecimiento: str = None, item_groups=None):
    """Balance actual por almacén (Bin) — foto de hoy."""
    company = _check_report_access(company, "reporte_inv_existencias")

    conditions = ["w.company = %(company)s", "b.actual_qty != 0"]
    params = {"company": company}
    wh_cond, wh_params = _warehouse_condition(company, warehouse, "b")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)
    if item_code:
        conditions.append("b.item_code = %(item_code)s")
        params["item_code"] = item_code
    ig_cond = _item_group_condition(item_groups, params)
    if ig_cond:
        conditions.append(ig_cond)
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "b")
    except _NoWarehousesForEstablecimiento:
        return {"rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT b.item_code, i.item_name, i.item_group, b.warehouse, b.actual_qty, b.valuation_rate,
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
    can_costs = get_facex_can_view_costs(company)
    if not can_costs:
        _strip_cost_fields(rows, ("valuation_rate", "stock_value"))
    return {"rows": rows, "can_view_costs": can_costs}


@frappe.whitelist()
def get_stock_aging(company: str = None, warehouse: str = None, item_code: str = None,
                    establecimiento: str = None, item_groups=None):
    """
    Antigüedad práctica: días desde el ÚLTIMO ingreso (Stock Ledger Entry con
    actual_qty > 0) por ítem+almacén con stock actual. No es FIFO layer-by-layer
    (eso es Stock Ageing nativo de ERPNext) — es una referencia simple y rápida
    de leer para el usuario final.
    """
    company = _check_report_access(company, "reporte_inv_existencias")

    conditions = ["w.company = %(company)s", "b.actual_qty > 0"]
    params = {"company": company}
    wh_cond, wh_params = _warehouse_condition(company, warehouse, "b")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)
    if item_code:
        conditions.append("b.item_code = %(item_code)s")
        params["item_code"] = item_code
    ig_cond = _item_group_condition(item_groups, params)
    if ig_cond:
        conditions.append(ig_cond)
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "b")
    except _NoWarehousesForEstablecimiento:
        return {"rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT b.item_code, i.item_name, i.item_group, b.warehouse, b.actual_qty,
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
def get_non_moving_items(company: str = None, warehouse: str = None, days: int = 60,
                         item_code: str = None, establecimiento: str = None, item_groups=None):
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
    wh_cond, wh_params = _warehouse_condition(company, warehouse, "b")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)
    if item_code:
        conditions.append("b.item_code = %(item_code)s")
        params["item_code"] = item_code
    ig_cond = _item_group_condition(item_groups, params)
    if ig_cond:
        conditions.append(ig_cond)
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "b")
    except _NoWarehousesForEstablecimiento:
        return {"days": days, "cutoff": str(cutoff), "rows": []}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT b.item_code, i.item_name, i.item_group, b.warehouse, b.actual_qty, b.valuation_rate,
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
    can_costs = get_facex_can_view_costs(company)
    if not can_costs:
        _strip_cost_fields(rows, ("valuation_rate",))
    return {"days": days, "cutoff": str(cutoff), "rows": rows, "can_view_costs": can_costs}


@frappe.whitelist()
def export_existencias(company: str = None, tab: str = "status", formato: str = "xlsx",
                       warehouse: str = None, item_code: str = None, establecimiento: str = None,
                       item_groups=None, days=60, sort_by: str = None, sort_dir: str = "asc"):
    """Exporta el reporte de Existencias (pestaña `tab`: status / aging / nonmoving)
    a `formato` xlsx o pdf, respetando los filtros, el orden y el permiso de costos."""
    company_eff = get_effective_company(company)
    tab = tab if tab in ("status", "aging", "nonmoving") else "status"
    numeric_keys = ("actual_qty", "valuation_rate", "stock_value", "days_in_stock")

    if tab == "status":
        data = get_stock_status(company, warehouse, item_code, establecimiento, item_groups)
        cc = data.get("can_view_costs")
        rows = _sort_rows(data["rows"], sort_by, sort_dir, numeric_keys)
        headers = ["Código", "Nombre", "Grupo", "Almacén", "Cantidad"]
        num = {4}
        if cc:
            headers += ["Costo", "Valor"]
            num |= {5, 6}
        matrix = []
        for r in rows:
            line = [r["item_code"], r["item_name"], r.get("item_group"), r["warehouse"], r["actual_qty"]]
            if cc:
                line += [r.get("valuation_rate"), r.get("stock_value")]
            matrix.append(line)
        titulo = "Existencias — Status por Almacén"

    elif tab == "aging":
        data = get_stock_aging(company, warehouse, item_code, establecimiento, item_groups)
        rows = _sort_rows(data["rows"], sort_by, sort_dir, numeric_keys)
        headers = ["Código", "Nombre", "Grupo", "Almacén", "Cantidad", "Último Ingreso", "Días", "Rango"]
        num = {4, 6}
        matrix = []
        for r in rows:
            d = r.get("days_in_stock")
            matrix.append([
                r["item_code"], r["item_name"], r.get("item_group"), r["warehouse"], r["actual_qty"],
                r.get("last_receipt_date") or "", "" if d is None else d, r.get("bucket"),
            ])
        titulo = "Existencias — Antigüedad"

    else:  # nonmoving
        data = get_non_moving_items(company, warehouse, days, item_code, establecimiento, item_groups)
        cc = data.get("can_view_costs")
        for r in data["rows"]:
            vr = r.get("valuation_rate")
            r["stock_value"] = (flt(r.get("actual_qty")) * flt(vr)) if vr is not None else None
        rows = _sort_rows(data["rows"], sort_by, sort_dir, numeric_keys)
        headers = ["Código", "Nombre", "Grupo", "Almacén", "Cantidad"]
        num = {4}
        if cc:
            headers += ["Valor"]
            num |= {5}
        headers += ["Última Salida"]
        matrix = []
        for r in rows:
            line = [r["item_code"], r["item_name"], r.get("item_group"), r["warehouse"], r["actual_qty"]]
            if cc:
                line += [r.get("stock_value")]
            line += [r.get("last_outgoing_date") or "Nunca"]
            matrix.append(line)
        titulo = f"Existencias — Sin Rotación (>{data.get('days', days)} días sin salida)"

    fbase = f"existencias_{tab}"
    if formato == "pdf":
        filtros = []
        if warehouse:
            filtros.append(f"Almacén: {warehouse}")
        groups = _parse_list(item_groups)
        if groups:
            filtros.append(f"Grupos: {', '.join(groups)}")
        if item_code:
            filtros.append(f"Ítem: {item_code}")
        _pdf_response(fbase, titulo, company_eff, " · ".join(filtros) or "Sin filtros",
                      headers, matrix, tuple(num))
    else:
        _xlsx_response(fbase, [headers] + matrix)


# ---------------------------------------------------------------------------
# 3. Trazabilidad por Serie / Lote
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_serial_traceability(company: str = None, item_code: str = None, serial_no: str = None, warehouse: str = None, establecimiento: str = None, owners=None):
    company = _check_report_access(company, "reporte_inv_trazabilidad")

    conditions = ["s.company = %(company)s"]
    params = {"company": company}
    if item_code:
        conditions.append("s.item_code = %(item_code)s")
        params["item_code"] = item_code
    if serial_no:
        conditions.append("s.name LIKE %(serial_no)s")
        params["serial_no"] = f"%{serial_no}%"
    wh_cond, wh_params = _warehouse_condition(company, warehouse, "s")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)
    owner_cond, owner_params = _scoped_owner_condition(company, owners, "s")
    if owner_cond:
        conditions.append(owner_cond)
        params.update(owner_params)
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
def get_batch_traceability(company: str = None, item_code: str = None, batch_no: str = None, warehouse: str = None, establecimiento: str = None, owners=None):
    company = _check_report_access(company, "reporte_inv_trazabilidad")

    conditions = ["sle.company = %(company)s", "sle.batch_no IS NOT NULL", "sle.batch_no != ''", "sle.is_cancelled = 0"]
    params = {"company": company}
    if item_code:
        conditions.append("sle.item_code = %(item_code)s")
        params["item_code"] = item_code
    if batch_no:
        conditions.append("sle.batch_no LIKE %(batch_no)s")
        params["batch_no"] = f"%{batch_no}%"
    wh_cond, wh_params = _warehouse_condition(company, warehouse, "sle")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)
    owner_cond, owner_params = _scoped_owner_condition(company, owners, "sle")
    if owner_cond:
        conditions.append(owner_cond)
        params.update(owner_params)
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


# ---------------------------------------------------------------------------
# Helpers de exportación
# ---------------------------------------------------------------------------

def _xlsx_response(filename: str, matrix: list) -> None:
    from frappe.utils.xlsxutils import make_xlsx
    xlsx = make_xlsx(matrix, filename)
    frappe.response["filename"] = f"{filename}.xlsx"
    frappe.response["filecontent"] = xlsx.getvalue()
    frappe.response["type"] = "binary"


def _pdf_response(filename: str, titulo: str, company: str, subtitulo: str,
                  headers: list, matrix_rows: list, num_cols: tuple = ()) -> None:
    """Genera un PDF apaisado sencillo (encabezado + tabla) y lo devuelve como descarga."""
    from frappe.utils.pdf import get_pdf

    def esc(v):
        return frappe.utils.escape_html("" if v is None else str(v))

    thead = "".join(f"<th>{esc(h)}</th>" for h in headers)
    body = ""
    for row in matrix_rows:
        tds = "".join(
            f'<td class="{"num" if idx in num_cols else ""}">{esc(c)}</td>'
            for idx, c in enumerate(row)
        )
        body += f"<tr>{tds}</tr>"

    html = f"""
<div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;color:#222;">
  <div style="border-bottom:2px solid #153375;padding-bottom:6px;margin-bottom:10px;">
    <div style="font-size:15px;font-weight:700;color:#153375;">{esc(titulo)}</div>
    <div style="font-size:11px;color:#555;">{esc(company)}</div>
    <div style="font-size:9px;color:#888;">{esc(subtitulo)} · Generado {esc(frappe.utils.now_datetime().strftime("%d/%m/%Y %H:%M"))}</div>
  </div>
  <table style="width:100%;border-collapse:collapse;">
    <thead><tr style="background:#eef2ff;">{thead}</tr></thead>
    <tbody>{body}</tbody>
  </table>
</div>
<style>
  th, td {{ border:1px solid #cdd5e0; padding:3px 5px; text-align:left; }}
  td.num {{ text-align:right; font-family:'Courier New',monospace; }}
  tbody tr:nth-child(even) {{ background:#f7f9fc; }}
</style>
"""
    frappe.response["filename"] = f"{filename}.pdf"
    frappe.response["filecontent"] = get_pdf(html, options={"orientation": "Landscape"})
    frappe.response["type"] = "pdf"


def _allowed_wh(company: str):
    return get_facex_allowed_warehouses(company)


# ---------------------------------------------------------------------------
# 4. Kardex Valorizado por Producto
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_kardex_producto(company: str = None, item_code: str = None, from_date: str = None,
                        to_date: str = None, warehouse: str = None, establecimiento: str = None,
                        cost_basis: str = "estandar", owners=None):
    """Kardex de un solo producto: saldo corrido en unidades y valorizado a la
    base de costo elegida (estándar FacEx / promedio ponderado / última compra).
    El 'valor real SLE' se muestra aparte como referencia."""
    company = _check_report_access(company, "reporte_inv_kardex_producto")
    if not item_code:
        frappe.throw("Indique un producto para el Kardex valorizado.")

    from_date = from_date or get_first_day(today())
    to_date = to_date or get_last_day(today())
    basis = normalize_basis(cost_basis)
    can_costs = get_facex_can_view_costs(company)
    unit_cost = resolve_cost(item_code, company, basis, allowed_warehouses=_allowed_wh(company))
    item_name = frappe.db.get_value("Item", item_code, "item_name")

    conditions = [
        "sle.company = %(company)s",
        "sle.item_code = %(item_code)s",
        "sle.posting_date BETWEEN %(from_date)s AND %(to_date)s",
    ]
    params = {"company": company, "item_code": item_code, "from_date": from_date, "to_date": to_date}

    wh_cond, wh_params = _warehouse_condition(company, warehouse, "sle")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)

    owner_cond, owner_params = _scoped_owner_condition(company, owners, "sle")
    if owner_cond:
        conditions.append(owner_cond)
        params.update(owner_params)

    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "sle")
    except _NoWarehousesForEstablecimiento:
        return {"from_date": str(from_date), "to_date": str(to_date), "item_code": item_code,
                "item_name": item_name, "rows": [], "can_view_costs": can_costs, "summary": {}}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    # Saldo de apertura (unidades) antes del rango
    open_conditions = ["sle.company = %(company)s", "sle.item_code = %(item_code)s",
                       "sle.is_cancelled = 0", "sle.posting_date < %(from_date)s"]
    open_params = {"company": company, "item_code": item_code, "from_date": from_date}
    owh_cond, owh_params = _warehouse_condition(company, warehouse, "sle")
    if owh_cond:
        open_conditions.append(owh_cond)
        open_params.update(owh_params)
    if owner_cond:
        open_conditions.append(owner_cond)
        open_params.update(owner_params)
    if est_cond:
        open_conditions.append(est_cond)
        open_params["wh_list"] = est_val
    opening_qty = flt(frappe.db.sql(
        f"SELECT COALESCE(SUM(sle.actual_qty), 0) FROM `tabStock Ledger Entry` sle "
        f"WHERE {' AND '.join(open_conditions)}", open_params)[0][0])

    rows = frappe.db.sql(
        f"""
        SELECT sle.name AS sle_name, sle.voucher_type, sle.voucher_no, sle.posting_date,
               sle.actual_qty, sle.stock_uom, sle.warehouse, sle.valuation_rate,
               sle.stock_value_difference, sle.is_cancelled,
               se.purpose AS se_purpose, se.remarks AS se_remarks
        FROM `tabStock Ledger Entry` sle
        LEFT JOIN `tabStock Entry` se ON se.name = sle.voucher_no AND sle.voucher_type = 'Stock Entry'
        WHERE {" AND ".join(conditions)}
        ORDER BY sle.posting_date ASC, sle.posting_datetime ASC, sle.creation ASC
        LIMIT 2000
        """,
        params,
        as_dict=True,
    )

    running_qty = opening_qty
    running_val = opening_qty * unit_cost
    opening_value = running_val
    for r in rows:
        is_transfer = r.voucher_type == "Stock Entry" and r.se_purpose == "Material Transfer"
        r["movement_type_label"] = "Transferencia" if is_transfer else ("Entrada" if r.actual_qty > 0 else "Salida")
        r["status_label"] = "Anulado" if r.is_cancelled else "Activo"
        r["qty_in"] = r.actual_qty if r.actual_qty > 0 else 0
        r["qty_out"] = -r.actual_qty if r.actual_qty < 0 else 0
        if not r.is_cancelled:
            running_qty += flt(r.actual_qty)
        r["balance_qty"] = running_qty
        mov_val = flt(r.actual_qty) * unit_cost
        r["unit_cost"] = unit_cost
        r["movement_value"] = mov_val
        if not r.is_cancelled and not is_transfer:
            running_val += mov_val
        r["balance_value"] = running_val

    if not can_costs:
        _strip_cost_fields(rows, ("valuation_rate", "stock_value_difference",
                                  "unit_cost", "movement_value", "balance_value"))

    return {
        "from_date": str(from_date), "to_date": str(to_date),
        "item_code": item_code, "item_name": item_name,
        "opening_qty": opening_qty,
        "opening_value": opening_value if can_costs else None,
        "rows": rows, "can_view_costs": can_costs,
        "summary": {
            "final_qty": running_qty,
            "final_value": running_val if can_costs else None,
            "unit_cost": unit_cost if can_costs else None,
            "cost_basis": basis,
            "cost_basis_label": COST_BASIS_LABELS[basis],
        },
    }


@frappe.whitelist()
def export_kardex_producto_excel(company: str = None, item_code: str = None, from_date: str = None,
                                 to_date: str = None, warehouse: str = None, establecimiento: str = None,
                                 cost_basis: str = "estandar", owners=None):
    data = get_kardex_producto(company, item_code, from_date, to_date, warehouse, establecimiento, cost_basis, owners)
    rows = data["rows"]
    if not rows:
        frappe.throw("No hay movimientos para exportar con los filtros seleccionados.")
    cc = data["can_view_costs"]
    headers = ["Fecha", "Documento", "Tipo", "Almacén", "Entra", "Sale", "Saldo Unid."]
    if cc:
        headers += ["Costo Unit.", "Valor Movimiento", "Saldo Valorizado", "Valor Real SLE"]
    headers += ["Estado"]
    matrix = [headers]
    for r in rows:
        line = [str(r.get("posting_date") or ""), r.get("voucher_no"), r.get("movement_type_label"),
                r.get("warehouse"), r.get("qty_in"), r.get("qty_out"), r.get("balance_qty")]
        if cc:
            line += [r.get("unit_cost"), r.get("movement_value"), r.get("balance_value"),
                     r.get("stock_value_difference")]
        line += [r.get("status_label")]
        matrix.append(line)
    _xlsx_response("kardex_valorizado_producto", matrix)


# ---------------------------------------------------------------------------
# 5. Valuación de Inventario
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_stock_valuation(company: str = None, warehouse: str = None, item_group: str = None,
                        establecimiento: str = None, cost_basis: str = "estandar"):
    """Foto del valor de existencias por almacén y grupo de artículo, valorizada a
    la base de costo elegida, con reconciliación contra el saldo GL de las cuentas
    tipo 'Stock' de la compañía."""
    company = _check_report_access(company, "reporte_inv_valuacion")
    basis = normalize_basis(cost_basis)
    can_costs = get_facex_can_view_costs(company)

    conditions = ["w.company = %(company)s", "b.actual_qty != 0"]
    params = {"company": company}
    wh_cond, wh_params = _warehouse_condition(company, warehouse, "b")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)
    if item_group:
        conditions.append("i.item_group = %(item_group)s")
        params["item_group"] = item_group
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "b")
    except _NoWarehousesForEstablecimiento:
        return {"rows": [], "can_view_costs": can_costs, "summary": {}}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    raw = frappe.db.sql(
        f"""
        SELECT b.item_code, i.item_name, i.item_group, b.warehouse, b.actual_qty, b.valuation_rate
        FROM `tabBin` b
        INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
        LEFT JOIN `tabItem` i ON i.name = b.item_code
        WHERE {" AND ".join(conditions)}
        ORDER BY i.item_group ASC, b.item_code ASC, b.warehouse ASC
        LIMIT 5000
        """,
        params,
        as_dict=True,
    )

    codes = list({r.item_code for r in raw})
    costs = get_item_costs(codes, company, allowed_warehouses=_allowed_wh(company))

    rows = []
    total_val = 0.0
    by_wh, by_group = {}, {}
    for r in raw:
        unit = resolve_cost(r.item_code, company, basis, costs)
        val = flt(r.actual_qty) * unit
        total_val += val
        by_wh[r.warehouse] = by_wh.get(r.warehouse, 0.0) + val
        g = r.item_group or "Sin grupo"
        by_group[g] = by_group.get(g, 0.0) + val
        rows.append({
            "item_code": r.item_code, "item_name": r.item_name, "item_group": r.item_group,
            "warehouse": r.warehouse, "actual_qty": r.actual_qty,
            "unit_cost": unit, "stock_value": val, "valuation_rate_sistema": r.valuation_rate,
        })

    gl_balance = flt(frappe.db.sql(
        """
        SELECT COALESCE(SUM(gle.debit - gle.credit), 0)
        FROM `tabGL Entry` gle
        INNER JOIN `tabAccount` a ON a.name = gle.account
        WHERE gle.company = %(company)s AND a.account_type = 'Stock'
          AND a.is_group = 0 AND gle.is_cancelled = 0
        """,
        {"company": company},
    )[0][0])

    if not can_costs:
        _strip_cost_fields(rows, ("unit_cost", "stock_value", "valuation_rate_sistema"))

    return {
        "rows": rows, "can_view_costs": can_costs,
        "summary": {
            "cost_basis": basis, "cost_basis_label": COST_BASIS_LABELS[basis],
            "total_value": total_val if can_costs else None,
            "gl_balance": gl_balance if can_costs else None,
            "difference": (total_val - gl_balance) if can_costs else None,
            "by_warehouse": ([{"warehouse": k, "value": v} for k, v in sorted(by_wh.items())]
                             if can_costs else []),
            "by_group": ([{"item_group": k, "value": v} for k, v in sorted(by_group.items())]
                         if can_costs else []),
        },
    }


@frappe.whitelist()
def export_stock_valuation_excel(company: str = None, warehouse: str = None, item_group: str = None,
                                 establecimiento: str = None, cost_basis: str = "estandar"):
    data = get_stock_valuation(company, warehouse, item_group, establecimiento, cost_basis)
    rows = data["rows"]
    if not rows:
        frappe.throw("No hay existencias para exportar con los filtros seleccionados.")
    cc = data["can_view_costs"]
    headers = ["Código", "Nombre", "Grupo", "Almacén", "Cantidad"]
    if cc:
        headers += ["Costo Unit.", "Valor"]
    matrix = [headers]
    for r in rows:
        line = [r.get("item_code"), r.get("item_name"), r.get("item_group"),
                r.get("warehouse"), r.get("actual_qty")]
        if cc:
            line += [r.get("unit_cost"), r.get("stock_value")]
        matrix.append(line)
    _xlsx_response("valuacion_inventario", matrix)


# ---------------------------------------------------------------------------
# 6. Productos por Vencer / Lotes Caducados
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_expiring_batches(company: str = None, warehouse: str = None, item_code: str = None,
                         establecimiento: str = None, days_ahead=30, include_expired=1):
    """Lotes con existencia vigente cuya fecha de vencimiento cae dentro de
    `days_ahead` días (o ya vencidos si `include_expired`)."""
    company = _check_report_access(company, "reporte_inv_vencimientos")
    days_ahead = 30 if days_ahead in (None, "") else int(days_ahead)
    include_expired = int(include_expired or 0)
    can_costs = get_facex_can_view_costs(company)
    cutoff = add_days(today(), days_ahead)

    conditions = [
        "sle.company = %(company)s", "sle.batch_no IS NOT NULL", "sle.batch_no != ''",
        "sle.is_cancelled = 0", "b.expiry_date IS NOT NULL", "b.expiry_date <= %(cutoff)s",
    ]
    params = {"company": company, "cutoff": cutoff, "today": today()}
    if not include_expired:
        conditions.append("b.expiry_date >= %(today)s")
    if item_code:
        conditions.append("sle.item_code = %(item_code)s")
        params["item_code"] = item_code
    wh_cond, wh_params = _warehouse_condition(company, warehouse, "sle")
    if wh_cond:
        conditions.append(wh_cond)
        params.update(wh_params)
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "sle")
    except _NoWarehousesForEstablecimiento:
        return {"rows": [], "can_view_costs": can_costs}
    if est_cond:
        conditions.append(est_cond)
        params["wh_list"] = est_val

    rows = frappe.db.sql(
        f"""
        SELECT sle.batch_no, sle.item_code, i.item_name, sle.warehouse,
               SUM(sle.actual_qty) AS qty, b.expiry_date,
               AVG(NULLIF(sle.valuation_rate, 0)) AS valuation_rate
        FROM `tabStock Ledger Entry` sle
        LEFT JOIN `tabItem` i ON i.name = sle.item_code
        INNER JOIN `tabBatch` b ON b.name = sle.batch_no
        WHERE {" AND ".join(conditions)}
        GROUP BY sle.batch_no, sle.item_code, sle.warehouse, b.expiry_date
        HAVING qty > 0
        ORDER BY b.expiry_date ASC, sle.item_code ASC
        LIMIT 2000
        """,
        params,
        as_dict=True,
    )

    today_d = getdate(today())
    for r in rows:
        d = (getdate(r.expiry_date) - today_d).days
        r["days_to_expiry"] = d
        if d < 0:
            r["bucket"] = "Vencido"
        elif d <= 30:
            r["bucket"] = "0-30 días"
        elif d <= 60:
            r["bucket"] = "31-60 días"
        elif d <= 90:
            r["bucket"] = "61-90 días"
        else:
            r["bucket"] = "+90 días"
        r["stock_value"] = flt(r.qty) * flt(r.valuation_rate)

    if not can_costs:
        _strip_cost_fields(rows, ("valuation_rate", "stock_value"))

    return {"rows": rows, "can_view_costs": can_costs,
            "days_ahead": days_ahead, "include_expired": include_expired}


@frappe.whitelist()
def export_expiring_batches_excel(company: str = None, warehouse: str = None, item_code: str = None,
                                  establecimiento: str = None, days_ahead=30, include_expired=1):
    data = get_expiring_batches(company, warehouse, item_code, establecimiento, days_ahead, include_expired)
    rows = data["rows"]
    if not rows:
        frappe.throw("No hay lotes para exportar con los filtros seleccionados.")
    cc = data["can_view_costs"]
    headers = ["Lote", "Código", "Nombre", "Almacén", "Cantidad", "Vence", "Días", "Estado"]
    if cc:
        headers += ["Valor"]
    matrix = [headers]
    for r in rows:
        line = [r.get("batch_no"), r.get("item_code"), r.get("item_name"), r.get("warehouse"),
                r.get("qty"), str(r.get("expiry_date") or ""), r.get("days_to_expiry"), r.get("bucket")]
        if cc:
            line += [r.get("stock_value")]
        matrix.append(line)
    _xlsx_response("productos_por_vencer", matrix)


# ---------------------------------------------------------------------------
# 7. Rotación y Análisis ABC
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_stock_turnover_abc(company: str = None, warehouse: str = None, item_group: str = None,
                           establecimiento: str = None, from_date: str = None, to_date: str = None,
                           cost_basis: str = "estandar", owners=None):
    """Rotación de inventario y clasificación ABC por valor de consumo del periodo
    (por defecto, últimos 90 días). La clase ABC y la rotación se muestran siempre;
    los montos de valor solo con permiso `puede_ver_costos`."""
    company = _check_report_access(company, "reporte_inv_rotacion")
    basis = normalize_basis(cost_basis)
    can_costs = get_facex_can_view_costs(company)
    to_date = to_date or today()
    from_date = from_date or add_days(to_date, -90)

    mv_conditions = ["sle.company = %(company)s", "sle.is_cancelled = 0",
                     "sle.posting_date BETWEEN %(from_date)s AND %(to_date)s"]
    params = {"company": company, "from_date": from_date, "to_date": to_date}
    wh_cond, wh_params = _warehouse_condition(company, warehouse, "sle")
    if wh_cond:
        mv_conditions.append(wh_cond)
        params.update(wh_params)
    owner_cond, owner_params = _scoped_owner_condition(company, owners, "sle")
    if owner_cond:
        mv_conditions.append(owner_cond)
        params.update(owner_params)
    if item_group:
        mv_conditions.append("i.item_group = %(item_group)s")
        params["item_group"] = item_group
    try:
        est_cond, est_val = _establecimiento_condition(company, establecimiento, "sle")
    except _NoWarehousesForEstablecimiento:
        return {"rows": [], "can_view_costs": can_costs, "summary": {},
                "from_date": str(from_date), "to_date": str(to_date)}
    if est_cond:
        mv_conditions.append(est_cond)
        params["wh_list"] = est_val

    movements = frappe.db.sql(
        f"""
        SELECT sle.item_code, i.item_name, i.item_group,
               SUM(CASE WHEN sle.actual_qty < 0 THEN -sle.actual_qty ELSE 0 END) AS consumo,
               SUM(sle.actual_qty) AS neto_periodo
        FROM `tabStock Ledger Entry` sle
        LEFT JOIN `tabItem` i ON i.name = sle.item_code
        WHERE {" AND ".join(mv_conditions)}
        GROUP BY sle.item_code
        LIMIT 5000
        """,
        params,
        as_dict=True,
    )

    bin_conditions = ["w.company = %(company)s"]
    bparams = {"company": company}
    bwh_cond, bwh_params = _warehouse_condition(company, warehouse, "b")
    if bwh_cond:
        bin_conditions.append(bwh_cond)
        bparams.update(bwh_params)
    try:
        best_cond, best_val = _establecimiento_condition(company, establecimiento, "b")
    except _NoWarehousesForEstablecimiento:
        best_cond = None
    if best_cond:
        bin_conditions.append(best_cond)
        bparams["wh_list"] = best_val
    bin_rows = frappe.db.sql(
        f"""
        SELECT b.item_code, SUM(b.actual_qty) AS stock_final
        FROM `tabBin` b INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
        WHERE {" AND ".join(bin_conditions)}
        GROUP BY b.item_code
        """,
        bparams,
        as_dict=True,
    )
    stock_final = {r.item_code: flt(r.stock_final) for r in bin_rows}

    codes = list({m.item_code for m in movements} | set(stock_final.keys()))
    costs = get_item_costs(codes, company, allowed_warehouses=_allowed_wh(company))

    rows, moved = [], set()
    for m in movements:
        moved.add(m.item_code)
        sf = stock_final.get(m.item_code, 0.0)
        si = sf - flt(m.neto_periodo)
        avg_stock = (si + sf) / 2.0
        consumo = flt(m.consumo)
        unit = resolve_cost(m.item_code, company, basis, costs)
        rows.append({
            "item_code": m.item_code, "item_name": m.item_name, "item_group": m.item_group,
            "consumo": consumo, "stock_final": sf, "stock_promedio": avg_stock,
            "rotacion": (consumo / avg_stock) if avg_stock > 0 else 0.0,
            "unit_cost": unit, "consumo_valor": consumo * unit,
        })
    for code, sf in stock_final.items():
        if code in moved:
            continue
        nm = frappe.db.get_value("Item", code, ["item_name", "item_group"], as_dict=True) or {}
        unit = resolve_cost(code, company, basis, costs)
        rows.append({
            "item_code": code, "item_name": nm.get("item_name"), "item_group": nm.get("item_group"),
            "consumo": 0.0, "stock_final": sf, "stock_promedio": sf, "rotacion": 0.0,
            "unit_cost": unit, "consumo_valor": 0.0,
        })

    rows.sort(key=lambda r: r["consumo_valor"], reverse=True)
    total_cv = sum(r["consumo_valor"] for r in rows) or 0.0
    cum = 0.0
    for r in rows:
        cum += r["consumo_valor"]
        pct = (cum / total_cv * 100.0) if total_cv else 0.0
        r["pareto_pct"] = pct
        r["abc"] = "A" if pct <= 80 else ("B" if pct <= 95 else "C")

    summary = {
        "cost_basis": basis, "cost_basis_label": COST_BASIS_LABELS[basis],
        "count_a": sum(1 for r in rows if r["abc"] == "A"),
        "count_b": sum(1 for r in rows if r["abc"] == "B"),
        "count_c": sum(1 for r in rows if r["abc"] == "C"),
        "total_consumo_valor": total_cv if can_costs else None,
    }
    if not can_costs:
        _strip_cost_fields(rows, ("unit_cost", "consumo_valor", "pareto_pct"))

    return {"rows": rows, "can_view_costs": can_costs, "summary": summary,
            "from_date": str(from_date), "to_date": str(to_date)}


@frappe.whitelist()
def export_stock_turnover_abc_excel(company: str = None, warehouse: str = None, item_group: str = None,
                                    establecimiento: str = None, from_date: str = None, to_date: str = None,
                                    cost_basis: str = "estandar", owners=None):
    data = get_stock_turnover_abc(company, warehouse, item_group, establecimiento, from_date, to_date, cost_basis, owners)
    rows = data["rows"]
    if not rows:
        frappe.throw("No hay datos para exportar con los filtros seleccionados.")
    cc = data["can_view_costs"]
    headers = ["Código", "Nombre", "Grupo", "Consumo", "Stock Final", "Stock Prom.", "Rotación", "Clase ABC"]
    if cc:
        headers += ["Costo Unit.", "Valor Consumo", "% Pareto"]
    matrix = [headers]
    for r in rows:
        line = [r.get("item_code"), r.get("item_name"), r.get("item_group"), r.get("consumo"),
                r.get("stock_final"), r.get("stock_promedio"), round(flt(r.get("rotacion")), 2), r.get("abc")]
        if cc:
            line += [r.get("unit_cost"), r.get("consumo_valor"),
                     round(flt(r.get("pareto_pct")), 2) if r.get("pareto_pct") is not None else None]
        matrix.append(line)
    _xlsx_response("rotacion_abc", matrix)


# ---------------------------------------------------------------------------
# 8. Entradas por Proveedor
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_receipts_by_supplier(company: str = None, from_date: str = None, to_date: str = None,
                             supplier: str = None, item_code: str = None, establecimiento: str = None,
                             owners=None):
    """Resumen de ingresos de mercadería vía Facturas de Compra validadas del
    periodo, agrupado por proveedor y producto. (Purchase Receipt / Stock Entry
    manual quedan fuera de este reporte.)"""
    company = _check_report_access(company, "reporte_inv_entradas_proveedor")
    from_date = from_date or get_first_day(today())
    to_date = to_date or get_last_day(today())
    can_costs = get_facex_can_view_costs(company)

    conditions = ["pi.docstatus = 1", "pi.company = %(company)s",
                  "pi.posting_date BETWEEN %(from_date)s AND %(to_date)s"]
    params = {"company": company, "from_date": from_date, "to_date": to_date}
    owner_cond, owner_params = _scoped_owner_condition(company, owners, "pi", "compras")
    if owner_cond:
        conditions.append(owner_cond)
        params.update(owner_params)
    if supplier:
        conditions.append("pi.supplier = %(supplier)s")
        params["supplier"] = supplier
    if item_code:
        conditions.append("pii.item_code = %(item_code)s")
        params["item_code"] = item_code
    if establecimiento is not None and frappe.get_meta("Purchase Invoice").has_field("bfel_establecimiento"):
        conditions.append("pi.bfel_establecimiento = %(est)s")
        params["est"] = establecimiento

    rows = frappe.db.sql(
        f"""
        SELECT pi.supplier, pii.item_code, i.item_name, i.item_group,
               SUM(pii.stock_qty) AS qty,
               SUM(pii.base_net_amount) AS net_amount,
               MAX(pi.posting_date) AS last_date,
               COUNT(DISTINCT pi.name) AS invoice_count
        FROM `tabPurchase Invoice Item` pii
        INNER JOIN `tabPurchase Invoice` pi ON pi.name = pii.parent
        LEFT JOIN `tabItem` i ON i.name = pii.item_code
        WHERE {" AND ".join(conditions)}
        GROUP BY pi.supplier, pii.item_code
        ORDER BY pi.supplier ASC, net_amount DESC
        LIMIT 5000
        """,
        params,
        as_dict=True,
    )

    for r in rows:
        r["avg_net_rate"] = (flt(r.net_amount) / flt(r.qty)) if flt(r.qty) else 0.0

    by_supplier = {}
    for r in rows:
        s = by_supplier.setdefault(r.supplier, {"supplier": r.supplier, "qty": 0.0, "net_amount": 0.0})
        s["qty"] += flt(r.qty)
        s["net_amount"] += flt(r.net_amount)

    total_qty = sum(flt(r.qty) for r in rows)
    total_net = sum(flt(r.net_amount) for r in rows)

    if not can_costs:
        _strip_cost_fields(rows, ("net_amount", "avg_net_rate"))
        for s in by_supplier.values():
            s["net_amount"] = None

    return {
        "rows": rows, "can_view_costs": can_costs,
        "from_date": str(from_date), "to_date": str(to_date),
        "summary": {
            "by_supplier": list(by_supplier.values()),
            "total_qty": total_qty,
            "total_net": total_net if can_costs else None,
        },
    }


@frappe.whitelist()
def export_receipts_by_supplier_excel(company: str = None, from_date: str = None, to_date: str = None,
                                      supplier: str = None, item_code: str = None, establecimiento: str = None,
                                      owners=None):
    data = get_receipts_by_supplier(company, from_date, to_date, supplier, item_code, establecimiento, owners)
    rows = data["rows"]
    if not rows:
        frappe.throw("No hay entradas para exportar con los filtros seleccionados.")
    cc = data["can_view_costs"]
    headers = ["Proveedor", "Código", "Nombre", "Grupo", "Cantidad", "Últ. Fecha", "N° Facturas"]
    if cc:
        headers += ["Monto Neto", "Costo Unit. Prom."]
    matrix = [headers]
    for r in rows:
        line = [r.get("supplier"), r.get("item_code"), r.get("item_name"), r.get("item_group"),
                r.get("qty"), str(r.get("last_date") or ""), r.get("invoice_count")]
        if cc:
            line += [r.get("net_amount"), r.get("avg_net_rate")]
        matrix.append(line)
    _xlsx_response("entradas_por_proveedor", matrix)
