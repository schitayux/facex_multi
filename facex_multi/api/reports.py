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


# ---------------------------------------------------------------------------
# 1. Informe de Ventas por Fecha
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_sales_by_date(start_date: str, end_date: str, customer: str = None, warehouse: str = None, company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    
    company = get_effective_company(company)
    conditions = ["docstatus = 1", "COALESCE(bfel_documento_anulado, 0) != 1", "company = %(company)s"]
    values = {"start": start_date, "end": end_date, "company": company}
    
    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer
        
    if warehouse:
        conditions.append("name IN (SELECT parent FROM `tabSales Invoice Item` WHERE warehouse = %(warehouse)s)")
        values["warehouse"] = warehouse
        
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT name, posting_date, customer, customer_name, total, total_taxes_and_charges, grand_total, outstanding_amount
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
                         item_group: str = None, customer: str = None, warehouse: str = None, company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    
    company = get_effective_company(company)
    conditions = ["p.docstatus = 1", "COALESCE(p.bfel_documento_anulado, 0) != 1", "p.posting_date BETWEEN %(start)s AND %(end)s", "p.company = %(company)s"]
    values = {"start": start_date, "end": end_date, "company": company}
    
    if item_code:
        conditions.append("i.item_code = %(item_code)s")
        values["item_code"] = item_code
        
    if item_group:
        conditions.append("i.item_group = %(item_group)s")
        values["item_group"] = item_group
        
    if customer:
        conditions.append("p.customer = %(customer)s")
        values["customer"] = customer
        
    if warehouse:
        conditions.append("i.warehouse = %(warehouse)s")
        values["warehouse"] = warehouse
        
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
def get_cancelled_invoices(start_date: str, end_date: str, customer: str = None, company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    
    company = get_effective_company(company)
    conditions = ["(docstatus = 2 OR COALESCE(bfel_documento_anulado, 0) = 1)", "posting_date BETWEEN %(start)s AND %(end)s", "company = %(company)s"]
    values = {"start": start_date, "end": end_date, "company": company}
    
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
def get_customer_statement(customer: str, start_date: str = None, end_date: str = None, doc_type_filter: str = None, company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    if not customer:
        return {"ledger": [], "summary": {}}
        
    company = get_effective_company(company)
    values = {"customer": customer, "company": company}
    conditions = ["customer = %(customer)s", "docstatus = 1", "COALESCE(bfel_documento_anulado, 0) != 1", "company = %(company)s"]
    
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
def get_aging_receivables(customer: str = None, company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    
    company = get_effective_company(company)
    conditions = ["docstatus = 1", "is_return = 0", "COALESCE(bfel_documento_anulado, 0) != 1", "company = %(company)s"]
    values = {"company": company}
    
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
def get_quotations_report(start_date: str = None, end_date: str = None, customer: str = None, company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    
    company = get_effective_company(company)
    conditions = ["docstatus = 0", "is_return = 0", "is_debit_note = 0", "COALESCE(bfel_documento_anulado, 0) != 1", "company = %(company)s"]
    values = {"company": company}
    
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
        SELECT name, posting_date, customer, customer_name, grand_total, bfel_status, creation
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
def get_payments_report(start_date: str, end_date: str, payment_method: str = None, company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    
    company = get_effective_company(company)
    conditions = ["p.docstatus = 1", "COALESCE(p.bfel_documento_anulado, 0) != 1", "ip.payment_date BETWEEN %(start)s AND %(end)s", "p.company = %(company)s"]
    values = {"start": start_date, "end": end_date, "company": company}
    
    if payment_method:
        conditions.append("ip.payment_method = %(method)s")
        values["method"] = payment_method
        
    if establecimiento:
        conditions.append("p.bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT ip.payment_date, ip.parent AS invoice, p.customer, p.customer_name, ip.payment_method, ip.reference, ip.amount
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
def get_uncertified_invoices(company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    
    company = get_effective_company(company)
    conditions = [
        "docstatus = 1",
        "company = %(company)s",
        "bfel_status = '01 Enviar'",
        "(bfel_uuid IS NULL OR bfel_uuid = '')"
    ]
    values = {"company": company}
    
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
def get_sales_growth_analysis(year: str = None, month: str = None, company: str = None, establecimiento: str = None) -> dict:
    check_permission()
    
    company = get_effective_company(company)
    current_year = int(year) if year else datetime.datetime.now().year
    current_month = int(month) if month else datetime.datetime.now().month
    
    if current_month == 1:
        prev_month = 12
        prev_year = current_year - 1
    else:
        prev_month = current_month - 1
        prev_year = current_year
        
    # Ventas diarias año actual/mes seleccionado
    curr_conditions = ["docstatus = 1", "YEAR(posting_date) = %(year)s", "MONTH(posting_date) = %(month)s", "company = %(company)s", "COALESCE(bfel_documento_anulado, 0) != 1"]
    curr_values = {"year": current_year, "month": current_month, "company": company}
    
    prev_conditions = ["docstatus = 1", "YEAR(posting_date) = %(year)s", "MONTH(posting_date) = %(month)s", "company = %(company)s", "COALESCE(bfel_documento_anulado, 0) != 1"]
    prev_values = {"year": prev_year, "month": prev_month, "company": company}
    
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
