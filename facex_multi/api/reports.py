"""
facex_multi.api.reports
----------------------
Módulo de reportes y análisis para FacEx.
Consultas seguras parametrizadas aisladas a Sales Invoice y eFast Invoice Payment con soporte multi-compañía.
"""
from __future__ import annotations

import frappe
from frappe.utils import today, getdate, add_days
import datetime
from facex_multi.api.invoice import get_effective_company


def _build_company_condition(company: str) -> tuple:
    """
    Retorna (condicion_sql, valores_dict) para filtrar por compañía.
    - Si company está especificada: filtra por esa compañía exacta.
    - Si company está vacía ("Todas"): filtra por TODAS las compañías
      que el usuario tiene asignadas en User Permission.
    """
    company = (company or "").strip()

    if company:
        return "company = %(company)s", {"company": company}

    # "Todas": obtener compañías permitidas del usuario
    user_cos = frappe.get_all(
        "User Permission",
        filters={"user": frappe.session.user, "allow": "Company"},
        pluck="for_value"
    )

    if not user_cos:
        # Sin restricciones de User Permission → usar compañía efectiva por defecto
        eff = get_effective_company()
        if eff:
            return "company = %(company)s", {"company": eff}
        # System Manager sin default: sin restricción de compañía (todos los datos)
        return "1=1", {}

    if len(user_cos) == 1:
        return "company = %(company)s", {"company": user_cos[0]}

    return "company IN %(companies)s", {"companies": tuple(user_cos)}


def _build_company_condition_alias(company: str, alias: str = "p") -> tuple:
    """Igual que _build_company_condition pero para consultas con alias de tabla."""
    cond, vals = _build_company_condition(company)
    if "company = " in cond:
        cond = cond.replace("company = ", f"{alias}.company = ")
    elif "company IN " in cond:
        cond = cond.replace("company IN ", f"{alias}.company IN ")
    return cond, vals


def _sales_partner_condition(alias: str = None) -> tuple:
    """Retorna (condicion_sql, valores_dict) para acotar un informe de Sales
    Invoice al Socio de Ventas del usuario. ("1=1", {}) si el usuario no está
    limitado (ve todo lo que su compañía/rol le permita)."""
    from facex_multi.api.permissions import get_facex_user_sales_partner
    sp = get_facex_user_sales_partner()
    if not sp:
        return "1=1", {}
    col = f"{alias}.sales_partner" if alias else "sales_partner"
    return f"{col} = %(facex_sp)s", {"facex_sp": sp}


def _owner_condition(owners, alias: str = None) -> tuple:
    """Retorna (condicion_sql, valores_dict) para acotar un informe a una
    selección múltiple de usuarios creadores. ("1=1", {}) sin filtro (todos)."""
    if isinstance(owners, str):
        owners = frappe.parse_json(owners) if owners else []
    owners = [o for o in (owners or []) if o]
    if not owners:
        return "1=1", {}
    col = f"{alias}.owner" if alias else "owner"
    return f"{col} IN %(owners)s", {"owners": tuple(owners)}


def _resolve_owner_filter(company: str, owners, alias: str = None) -> tuple:
    """Igual patrón que _resolve_warehouse_filter, aplicado al filtro
    "Usuario Creador" de los reportes de FacEx Clásico:
    - Rol de Clasificación "Gerencia" (FacEx Settings > rol_clasificacion) o
      System Manager: puede elegir cualquier usuario creador (o ninguno =
      todos).
    - Cualquier otro caso (rol distinto, vacío, o sin fila de FacEx
      Settings): SIEMPRE forzado a ver solo sus propias operaciones, sin
      importar qué haya seleccionado en el filtro del frontend.
    """
    from facex_multi.api.permissions import get_facex_is_gerencia
    eff_company = get_effective_company(company)
    if "System Manager" in frappe.get_roles() or get_facex_is_gerencia(eff_company):
        return _owner_condition(owners, alias)
    return _owner_condition([frappe.session.user], alias)


@frappe.whitelist()
def user_query_for_reports(doctype=None, txt="", searchfield=None, start=0, page_length=20, filters=None):
    """Query override para el filtro "Usuario Creador" (selección múltiple) de
    todos los reportes de FacEx: usuarios habilitados, excluye System Manager
    (mismo criterio que el módulo Seguridad — ver
    facex_multi.api.security._system_manager_users — un System Manager no
    aporta nada útil como filtro porque ya tiene acceso total en todo)."""
    from facex_multi.api.security import _system_manager_users

    return frappe.db.sql(
        """
        SELECT name, full_name
        FROM `tabUser`
        WHERE enabled = 1 AND user_type = 'System User'
            AND name NOT IN %(system_managers)s
            AND (name LIKE %(txt)s OR full_name LIKE %(txt)s)
        ORDER BY full_name ASC
        LIMIT %(page_length)s OFFSET %(start)s
        """,
        {
            "system_managers": _system_manager_users(),
            "txt": f"%{txt}%",
            "start": start,
            "page_length": page_length,
        },
    )


@frappe.whitelist()
def has_reports_permission() -> bool:
    """
    Verifica si el usuario tiene permisos para ver los reportes avanzados de FacEx.
    A futuro se pueden mapear permisos granulares para los usuarios finales.
    """
    roles = frappe.get_roles()
    allowed = {"Accounts Manager", "Sales Manager", "System Manager", "facex_multi"}
    return bool(allowed & set(roles))


def check_permission():
    """Valida que el usuario tenga permisos, de lo contrario lanza excepción de permisos."""
    if not has_reports_permission():
        frappe.throw("No tiene permisos suficientes para acceder a este reporte.", frappe.PermissionError)


def _require_report(company: str, flag: str) -> None:
    """Gate por rol (check_permission) + flag granular de FacEx Settings.

    Antes sólo se validaba el rol (Accounts/Sales Manager…): los ~12 checkboxes
    reporte_* de FacEx Settings no se aplicaban. Retrocompatible: sin fila de
    FacEx Settings o System Manager → get_facex_permissions_for_company devuelve
    acceso total y sólo manda el rol.
    """
    check_permission()
    from facex_multi.api.permissions import get_facex_permissions_for_company
    perms = get_facex_permissions_for_company(get_effective_company(company))
    if not perms.get(flag):
        frappe.throw("No tiene permiso para ver este informe.", frappe.PermissionError)


def _resolve_warehouse_filter(company: str, warehouse):
    """
    Acota el filtro de bodega a las bodegas habilitadas del usuario (FacEx
    Settings > bodegas_habilitadas). `warehouse` acepta selección múltiple
    (lista, o JSON de lista como llega del filtro MultiSelectList del
    frontend) o un solo código (retrocompatible). Retorna (mode, value):
    - ("in", tuple_de_bodegas): una o más bodegas explícitas (intersectadas
      con lo permitido) o, sin selección explícita, la lista completa de
      bodegas permitidas del usuario.
    - (None, None): sin filtro que aplicar (sin restricción, o compañía
      vacía/"Todas" — las listas permitidas son por compañía y no combinan
      entre varias, así que en ese caso se deja sin acotar).
    """
    company = (company or "").strip()
    if isinstance(warehouse, str):
        warehouse = frappe.parse_json(warehouse) if warehouse.startswith("[") else ([warehouse] if warehouse else [])
    warehouse = [w for w in (warehouse or []) if w]

    if not company:
        return None, None

    from facex_multi.api.permissions import get_facex_allowed_warehouses, get_facex_is_gerencia
    if "System Manager" in frappe.get_roles() or get_facex_is_gerencia(company):
        # Gerencia (o System Manager): sin restricción, puede ver cualquier
        # almacén de la compañía en los reportes de FacEx Clásico.
        allowed = None
    else:
        allowed = get_facex_allowed_warehouses(company)

    if warehouse:
        if allowed is not None:
            invalid = [w for w in warehouse if w not in allowed]
            if invalid:
                frappe.throw(
                    f"No tiene permiso para ver la bodega '{invalid[0]}' en este informe.",
                    frappe.PermissionError,
                )
        return "in", tuple(warehouse)

    if allowed is not None:
        return "in", (tuple(allowed) or ("",))

    return None, None


# ---------------------------------------------------------------------------
# 1. Informe de Ventas por Fecha
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_sales_by_date(start_date: str, end_date: str, customer: str = None, warehouse=None,
                       owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_ventas_fecha")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition()
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    conditions = ["docstatus = 1", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, sp_cond, owner_cond]
    values = {"start": start_date, "end": end_date, **company_vals, **sp_vals, **owner_vals}

    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer

    wh_mode, wh_val = _resolve_warehouse_filter(company, warehouse)
    if wh_mode == "in":
        conditions.append("name IN (SELECT parent FROM `tabSales Invoice Item` WHERE warehouse IN %(allowed_warehouses)s)")
        values["allowed_warehouses"] = wh_val

    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento

    # outstanding_amount NO sirve aquí: FacEx registra los pagos como Payment
    # Entry en BORRADOR (ver invoice.save_payments) y ese campo de ERPNext solo
    # se actualiza cuando el PE se valida/concilia, así que una factura pagada
    # por FacEx pero con PE en borrador seguía apareciendo "Pendiente" por su
    # total completo. Se recalcula el saldo real desde custom_efast_payments,
    # igual que ya hacen Estados de Cuenta y Antigüedad de Saldos.
    query = f"""
        SELECT name, posting_date, customer, customer_name, total, total_taxes_and_charges, grand_total,
            GREATEST(grand_total - COALESCE((
                SELECT SUM(amount)
                FROM `tabeFast Invoice Payment`
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0), 0) AS outstanding_amount
        FROM `tabSales Invoice`
        WHERE posting_date BETWEEN %(start)s AND %(end)s AND { " AND ".join(conditions) }
        ORDER BY posting_date DESC, name DESC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    
    # Calcular agregados
    total_sales = sum(float(inv.grand_total or 0) for inv in invoices)
    total_tax = sum(float(inv.total_taxes_and_charges or 0) for inv in invoices)
    avg_sale = total_sales / len(invoices) if invoices else 0.0
    
    return {
        "invoices": invoices,
        "summary": {
            "total_sales": total_sales,
            "total_tax": total_tax,
            "avg_sale": avg_sale,
            "count": len(invoices)
        }
    }


# ---------------------------------------------------------------------------
# 2. Informe de Ventas por Producto con Filtros
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_sales_by_product(start_date: str, end_date: str, item_code: str = None,
                         item_group: str = None, customer: str = None, warehouse=None,
                         owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_ventas_producto")

    company_cond, company_vals = _build_company_condition_alias(company, "p")
    sp_cond, sp_vals = _sales_partner_condition("p")
    owner_cond, owner_vals = _resolve_owner_filter(company, owners, "p")
    conditions = ["p.docstatus = 1", "COALESCE(p.bfel_documento_anulado, 0) != 1", "p.posting_date BETWEEN %(start)s AND %(end)s", company_cond, sp_cond, owner_cond]
    values = {"start": start_date, "end": end_date, **company_vals, **sp_vals, **owner_vals}

    if item_code:
        conditions.append("i.item_code = %(item_code)s")
        values["item_code"] = item_code
        
    if item_group:
        conditions.append("i.item_group = %(item_group)s")
        values["item_group"] = item_group
        
    if customer:
        conditions.append("p.customer = %(customer)s")
        values["customer"] = customer
        
    wh_mode, wh_val = _resolve_warehouse_filter(company, warehouse)
    if wh_mode == "in":
        conditions.append("i.warehouse IN %(allowed_warehouses)s")
        values["allowed_warehouses"] = wh_val

    if establecimiento:
        conditions.append("p.bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT i.item_code, i.item_name, SUM(i.qty) AS total_qty, AVG(i.rate) AS avg_rate, SUM(i.amount) AS total_amount
        FROM `tabSales Invoice Item` i
        JOIN `tabSales Invoice` p ON i.parent = p.name AND i.parenttype = 'Sales Invoice' AND i.parentfield = 'items'
        WHERE { " AND ".join(conditions) }
        GROUP BY i.item_code, i.item_name
        ORDER BY total_amount DESC
    """
    
    products = frappe.db.sql(query, values, as_dict=True)
    
    total_qty = sum(float(p.total_qty or 0) for p in products)
    total_amount = sum(float(p.total_amount or 0) for p in products)
    
    return {
        "products": products,
        "summary": {
            "total_qty": total_qty,
            "total_amount": total_amount,
            "count": len(products)
        }
    }


# ---------------------------------------------------------------------------
# 3. Facturas Canceladas
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_cancelled_invoices(start_date: str, end_date: str, customer: str = None, owners=None,
                           company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_facturas_canceladas")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition()
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    conditions = ["(docstatus = 2 OR COALESCE(bfel_documento_anulado, 0) = 1)", "posting_date BETWEEN %(start)s AND %(end)s", company_cond, sp_cond, owner_cond]
    values = {"start": start_date, "end": end_date, **company_vals, **sp_vals, **owner_vals}
    
    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer
        
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT name, posting_date, customer, customer_name, grand_total, modified_by, modified, bfel_documento_anulado
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY posting_date DESC, name DESC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    total_amount = sum(float(inv.grand_total or 0) for inv in invoices)
    
    return {
        "invoices": invoices,
        "summary": {
            "total_amount": total_amount,
            "count": len(invoices)
        }
    }


# ---------------------------------------------------------------------------
# 4. Estado de Cuenta de Clientes (Aislado a pagos FacEx de Sales Invoice)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_customer_statement(customer: str, start_date: str = None, end_date: str = None, doc_type_filter: str = None,
                            owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_estados_cuenta")
    if not customer:
        return {"ledger": [], "summary": {}}

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition()
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    values = {"customer": customer, **company_vals, **sp_vals, **owner_vals}
    conditions = ["customer = %(customer)s", "docstatus = 1", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, sp_cond, owner_cond]
    
    if start_date and end_date:
        conditions.append("posting_date BETWEEN %(start)s AND %(end)s")
        values["start"] = start_date
        values["end"] = end_date
        
    if doc_type_filter:
        if doc_type_filter == "Facturas":
            conditions.append("is_return = 0")
        elif doc_type_filter == "Notas de Crédito":
            conditions.append("is_return = 1")
        elif doc_type_filter == "Notas de Débito":
            conditions.append("is_debit_note = 1")
            
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT 
            name, 
            posting_date, 
            due_date,
            bfel_docto_serie,
            bfel_docto_no,
            grand_total,
            is_return,
            is_debit_note,
            COALESCE((
                SELECT SUM(amount) 
                FROM `tabeFast Invoice Payment` 
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0) AS total_paid
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY posting_date ASC, creation ASC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    
    # Construir historial/libro mayor detallado
    ledger = []
    running_balance = 0.0
    total_invoiced = 0.0
    total_paid = 0.0
    
    for inv in invoices:
        inv_total = float(inv.grand_total or 0.0)
        inv_paid = float(inv.total_paid or 0.0)
        inv_balance = max(0.0, inv_total - inv_paid)
        
        total_invoiced += inv_total
        total_paid += inv_paid
        running_balance += inv_balance
        
        status = "Liquidado" if inv_balance <= 0.009 else "Pendiente"
        
        doc_type_desc = "Factura"
        if inv.is_return == 1:
            doc_type_desc = "Nota de Crédito"
        elif inv.is_debit_note == 1:
            doc_type_desc = "Nota de Débito"
            
        ledger.append({
            "name": inv.name,
            "posting_date": str(inv.posting_date),
            "due_date": str(inv.due_date) if inv.due_date else "",
            "serie_no": f"{inv.bfel_docto_serie or ''} - {inv.bfel_docto_no or ''}" if (inv.bfel_docto_serie or inv.bfel_docto_no) else "",
            "grand_total": inv_total,
            "paid_amount": inv_paid,
            "balance": inv_balance,
            "status": status,
            "doc_type_desc": doc_type_desc
        })
        
    # Obtener límite de crédito del cliente
    credit_limit = 0.0
    cust_limits = frappe.db.get_value("Customer Credit Limit", {"parent": customer}, "credit_limit")
    if cust_limits:
        credit_limit = float(cust_limits)
        
    return {
        "ledger": ledger,
        "summary": {
            "customer_name": frappe.db.get_value("Customer", customer, "customer_name") or customer,
            "total_invoiced": total_invoiced,
            "total_paid": total_paid,
            "outstanding_balance": running_balance,
            "credit_limit": credit_limit
        }
    }


# ---------------------------------------------------------------------------
# 5. Antigüedad de Saldos (Aging)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_aging_receivables(customer: str = None, owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_antiguedad_saldos")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition()
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    conditions = ["docstatus = 1", "is_return = 0", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, sp_cond, owner_cond]
    values = {**company_vals, **sp_vals, **owner_vals}
    
    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer
        
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT 
            name,
            customer,
            customer_name,
            posting_date,
            due_date,
            bfel_docto_serie,
            bfel_docto_no,
            grand_total,
            COALESCE((
                SELECT SUM(amount) 
                FROM `tabeFast Invoice Payment` 
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0) AS total_paid
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY customer ASC, posting_date ASC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    today_dt = getdate(today())
    
    # Procesar agrupamiento por cliente
    aging_data = {}
    
    for inv in invoices:
        paid = float(inv.total_paid or 0.0)
        outstanding = float(inv.grand_total or 0.0) - paid
        
        if outstanding <= 0.009:
            continue
            
        cust_id = inv.customer
        if cust_id not in aging_data:
            aging_data[cust_id] = {
                "customer": cust_id,
                "customer_name": inv.customer_name or cust_id,
                "total_outstanding": 0.0,
                "range_0_30": 0.0,
                "range_31_60": 0.0,
                "range_61_90": 0.0,
                "range_91_plus": 0.0,
                "invoices": []
            }
            
        # Calcular antigüedad de días con base a la fecha de vencimiento
        due_dt = getdate(inv.due_date or inv.posting_date)
        days = (today_dt - due_dt).days
        
        aging_data[cust_id]["total_outstanding"] += outstanding
        
        if days <= 30:
            aging_data[cust_id]["range_0_30"] += outstanding
            bucket = "0-30 días"
        elif days <= 60:
            aging_data[cust_id]["range_31_60"] += outstanding
            bucket = "31-60 días"
        elif days <= 90:
            aging_data[cust_id]["range_61_90"] += outstanding
            bucket = "61-90 días"
        else:
            aging_data[cust_id]["range_91_plus"] += outstanding
            bucket = "91+ días"
            
        serie_no = f"{inv.bfel_docto_serie or ''} - {inv.bfel_docto_no or ''}" if (inv.bfel_docto_serie or inv.bfel_docto_no) else ""
        
        aging_data[cust_id]["invoices"].append({
            "name": inv.name,
            "serie_no": serie_no,
            "posting_date": str(inv.posting_date),
            "due_date": str(inv.due_date) if inv.due_date else "",
            "grand_total": float(inv.grand_total or 0.0),
            "paid_amount": paid,
            "outstanding_amount": outstanding,
            "days_due": days,
            "bucket": bucket
        })
            
    aging_list = sorted(aging_data.values(), key=lambda x: x["total_outstanding"], reverse=True)
    
    # Resumen general
    total_outstanding = sum(x["total_outstanding"] for x in aging_list)
    total_0_30 = sum(x["range_0_30"] for x in aging_list)
    total_31_60 = sum(x["range_31_60"] for x in aging_list)
    total_61_90 = sum(x["range_61_90"] for x in aging_list)
    total_91_plus = sum(x["range_91_plus"] for x in aging_list)
    
    return {
        "aging": aging_list,
        "summary": {
            "total_outstanding": total_outstanding,
            "total_0_30": total_0_30,
            "total_31_60": total_31_60,
            "total_61_90": total_61_90,
            "total_91_plus": total_91_plus
        }
    }


# ---------------------------------------------------------------------------
# 6. Informe de Cotizaciones (Pre-Facturas Borradores)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_quotations_report(start_date: str = None, end_date: str = None, customer: str = None, owners=None,
                           company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_cotizaciones")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition()
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    conditions = ["docstatus = 0", "is_return = 0", "is_debit_note = 0", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, sp_cond, owner_cond]
    values = {**company_vals, **sp_vals, **owner_vals}
    
    if start_date and end_date:
        conditions.append("posting_date BETWEEN %(start)s AND %(end)s")
        values["start"] = start_date
        values["end"] = end_date
    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer
        
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT name, company, posting_date, customer, customer_name, grand_total, bfel_status, creation
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY posting_date DESC, creation DESC
    """

    invoices = frappe.db.sql(query, values, as_dict=True)
    total_amount = sum(float(inv.grand_total or 0) for inv in invoices)
    
    return {
        "invoices": invoices,
        "summary": {
            "total_amount": total_amount,
            "count": len(invoices)
        }
    }


# ---------------------------------------------------------------------------
# 7. Informe de Pagos por Fecha
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_payments_report(start_date: str, end_date: str, payment_method: str = None, owners=None,
                         company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_recibos_pagos")

    company_cond, company_vals = _build_company_condition_alias(company, "p")
    sp_cond, sp_vals = _sales_partner_condition("p")
    owner_cond, owner_vals = _resolve_owner_filter(company, owners, "ip")
    conditions = ["p.docstatus = 1", "COALESCE(p.bfel_documento_anulado, 0) != 1", "ip.payment_date BETWEEN %(start)s AND %(end)s", company_cond, sp_cond, owner_cond]
    values = {"start": start_date, "end": end_date, **company_vals, **sp_vals, **owner_vals}
    
    if payment_method:
        conditions.append("ip.payment_method = %(method)s")
        values["method"] = payment_method
        
    if establecimiento:
        conditions.append("p.bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT ip.payment_date, ip.parent AS invoice, p.company, p.customer, p.customer_name, ip.payment_method, ip.reference, ip.amount
        FROM `tabeFast Invoice Payment` ip
        JOIN `tabSales Invoice` p ON ip.parent = p.name AND ip.parenttype = 'Sales Invoice' AND ip.parentfield = 'custom_efast_payments'
        WHERE { " AND ".join(conditions) }
        ORDER BY ip.payment_date DESC, ip.creation DESC
    """
    
    payments = frappe.db.sql(query, values, as_dict=True)
    
    # Calcular totales por método de pago
    method_totals = {}
    total_received = 0.0
    
    for pay in payments:
        amount = float(pay.amount or 0.0)
        total_received += amount
        method = pay.payment_method or "Otros"
        if method not in method_totals:
            method_totals[method] = 0.0
        method_totals[method] += amount
        
    return {
        "payments": payments,
        "summary": {
            "total_received": total_received,
            "method_totals": [{"method": k, "amount": v} for k, v in method_totals.items()],
            "count": len(payments)
        }
    }


# ---------------------------------------------------------------------------
# 8. Documentos con Error sin Certificar aún
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_uncertified_invoices(owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_facturas_canceladas")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition()
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    conditions = [
        "docstatus = 1",
        company_cond,
        sp_cond,
        owner_cond,
        "bfel_status = '01 Enviar'",
        "(bfel_uuid IS NULL OR bfel_uuid = '')"
    ]
    values = {**company_vals, **sp_vals, **owner_vals}
    
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT name, posting_date, customer, customer_name, grand_total, bfel_status, bfel_error_log
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY posting_date DESC, name DESC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    total_amount = sum(float(inv.grand_total or 0) for inv in invoices)
    
    return {
        "invoices": invoices,
        "summary": {
            "total_amount": total_amount,
            "count": len(invoices)
        }
    }


# ---------------------------------------------------------------------------
# 9. Análisis Crecimiento de Ventas (Interactivo anual)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_sales_growth_analysis(year: str = None, month: str = None, owners=None,
                               company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_crecimiento_ventas")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition()
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    current_year = int(year) if year else datetime.datetime.now().year
    current_month = int(month) if month else datetime.datetime.now().month

    if current_month == 1:
        prev_month = 12
        prev_year = current_year - 1
    else:
        prev_month = current_month - 1
        prev_year = current_year

    # Ventas diarias año actual/mes seleccionado
    curr_conditions = ["docstatus = 1", "YEAR(posting_date) = %(year)s", "MONTH(posting_date) = %(month)s", company_cond, sp_cond, owner_cond, "COALESCE(bfel_documento_anulado, 0) != 1"]
    curr_values = {"year": current_year, "month": current_month, **company_vals, **sp_vals, **owner_vals}

    prev_conditions = ["docstatus = 1", "YEAR(posting_date) = %(year)s", "MONTH(posting_date) = %(month)s", company_cond, sp_cond, owner_cond, "COALESCE(bfel_documento_anulado, 0) != 1"]
    prev_values = {"year": prev_year, "month": prev_month, **company_vals, **sp_vals, **owner_vals}
    
    if establecimiento:
        curr_conditions.append("bfel_establecimiento = %(establecimiento)s")
        curr_values["establecimiento"] = establecimiento
        prev_conditions.append("bfel_establecimiento = %(establecimiento)s")
        prev_values["establecimiento"] = establecimiento
        
    curr_data = frappe.db.sql(f"""
        SELECT DAY(posting_date) AS day, SUM(grand_total) AS total
        FROM `tabSales Invoice`
        WHERE {" AND ".join(curr_conditions)}
        GROUP BY DAY(posting_date)
    """, curr_values, as_dict=True)
    
    # Ventas diarias año anterior/mes anterior
    prev_data = frappe.db.sql(f"""
        SELECT DAY(posting_date) AS day, SUM(grand_total) AS total
        FROM `tabSales Invoice`
        WHERE {" AND ".join(prev_conditions)}
        GROUP BY DAY(posting_date)
    """, prev_values, as_dict=True)
    
    # Mapear a vectores de días
    curr_dict = {r["day"]: float(r["total"] or 0) for r in curr_data}
    prev_dict = {r["day"]: float(r["total"] or 0) for r in prev_data}
    
    import calendar
    num_days = calendar.monthrange(current_year, current_month)[1]
    
    chart_data = []
    total_curr = 0.0
    total_prev = 0.0
    
    for d in range(1, num_days + 1):
        val_curr = curr_dict.get(d, 0.0)
        val_prev = prev_dict.get(d, 0.0)
        
        total_curr += val_curr
        total_prev += val_prev
        
        # Calcular crecimiento relativo diario
        growth = 0.0
        if val_prev > 0:
            growth = ((val_curr - val_prev) / val_prev) * 100.0
            
        chart_data.append({
            "idx": d,
            "month_name": f"Día {d}",
            "current_year": val_curr,
            "previous_year": val_prev,
            "growth": round(growth, 2)
        })
        
    overall_growth = 0.0
    if total_prev > 0:
        overall_growth = ((total_curr - total_prev) / total_prev) * 100.0
        
    months_names = [
        "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
        "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
    ]
        
    return {
        "year": current_year,
        "prev_year": prev_year,
        "month": current_month,
        "prev_month": prev_month,
        "month_name": months_names[current_month - 1],
        "prev_month_name": months_names[prev_month - 1],
        "chart_data": chart_data,
        "summary": {
            "total_current": total_curr,
            "total_previous": total_prev,
            "overall_growth": round(overall_growth, 2)
        }
    }


# ---------------------------------------------------------------------------
# 10. Auditoría de Sistema (resumen por usuario)
# ---------------------------------------------------------------------------
# Reutiliza get_data() del Script Report "FacEx Auditoria de Sistema" (misma
# consulta, ya probada) — este endpoint solo la expone dentro del panel de
# Reportes de FacEx Clásico, gateada por el flag granular de FacEx Settings
# (el Script Report en Desk solo valida roles, no este flag).

@frappe.whitelist()
def get_system_audit(start_date: str, end_date: str, owners=None, company: str = None) -> dict:
    _require_report(company, "reporte_auditoria_sistema")

    from facex_multi.facex_multi.report.facex_auditoria_de_sistema.facex_auditoria_de_sistema import get_data

    rows = get_data(frappe._dict({
        "from_date": start_date, "to_date": end_date, "owners": owners, "company": company,
    }))

    count_keys = [
        "cotizaciones_count", "facturas_no_enviar_count", "facturas_enviar_count",
        "pagos_count", "guias_pendientes_count",
    ]
    amount_keys = [
        "cotizaciones_monto", "facturas_no_enviar_monto", "facturas_enviar_monto",
        "pagos_monto", "guias_pendientes_monto",
    ]
    return {
        "rows": rows,
        "summary": {
            "user_count": len(rows),
            "total_operaciones": sum(r.get("total_operaciones", 0) for r in rows),
            "total_monto": sum(sum(r.get(k, 0) for k in amount_keys) for r in rows),
            "count": len(rows),
        },
    }


# ---------------------------------------------------------------------------
# 12. Vista rápida de una factura (panel lateral de los reportes)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_invoice_peek(name: str, company: str = None) -> dict:
    """Resumen de una factura para mirarla sin salir del reporte.

    La factura tiene que caer dentro del MISMO ámbito que los informes
    (compañía + socio de ventas + usuario creador). Si no, para este usuario
    no existe: el nombre llega del cliente y sin esta comprobación cualquiera
    podría espiar facturas de otro vendedor escribiendo su número.

    Las líneas de pago sólo se incluyen con `reporte_recibos_pagos`, el mismo
    permiso que exige el informe de Recibos y Pagos.
    """
    check_permission()

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition()
    owner_cond, owner_vals = _resolve_owner_filter(company, None)
    values = {"name": name, **company_vals, **sp_vals, **owner_vals}

    rows = frappe.db.sql(
        f"""
        SELECT name, posting_date, due_date, customer, customer_name, bfel_nit,
            company, currency, docstatus, status, total, total_taxes_and_charges,
            discount_amount, grand_total, bfel_status, bfel_uuid, bfel_docto_serie,
            bfel_docto_no, bfel_establecimiento, owner,
            COALESCE(bfel_documento_anulado, 0) AS anulado
        FROM `tabSales Invoice`
        WHERE name = %(name)s AND {company_cond} AND {sp_cond} AND {owner_cond}
        """,
        values,
        as_dict=True,
    )
    if not rows:
        frappe.throw("La factura no existe o no está a su alcance.", frappe.PermissionError)
    inv = rows[0]

    items = frappe.db.sql(
        """
        SELECT item_code, item_name, qty, rate, amount
        FROM `tabSales Invoice Item`
        WHERE parent = %(name)s
        ORDER BY idx
        """,
        {"name": name},
        as_dict=True,
    )

    payments = frappe.db.sql(
        """
        SELECT payment_date, payment_method, reference, amount
        FROM `tabeFast Invoice Payment`
        WHERE parent = %(name)s AND parenttype = 'Sales Invoice'
            AND parentfield = 'custom_efast_payments'
        ORDER BY idx
        """,
        {"name": name},
        as_dict=True,
    )
    total_paid = sum(float(p.amount or 0) for p in payments)

    from facex_multi.api.permissions import get_facex_permissions_for_company

    perms = get_facex_permissions_for_company(get_effective_company(company))

    return {
        "invoice": inv,
        "items": items,
        "item_count": len(items),
        "total_paid": total_paid,
        "outstanding": max(float(inv.grand_total or 0) - total_paid, 0.0),
        "payments": payments if perms.get("reporte_recibos_pagos") else [],
        "can_see_payments": bool(perms.get("reporte_recibos_pagos")),
        "owner_name": frappe.db.get_value("User", inv.owner, "full_name") or inv.owner,
    }
