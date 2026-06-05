"""
facex_multi.api.analytics
------------------------
Análisis de ventas por cliente para la pestaña de Análisis del POS con aislamiento multi-compañía.
"""
from __future__ import annotations

import frappe
from frappe.utils import today, add_months
from facex_multi.api.invoice import get_effective_company


@frappe.whitelist()
def get_customer_analytics(customer: str, company: str = None):
    """
    Retorna estadísticas de ventas del cliente para los últimos 6 meses:
    - Stats agregadas (count, total, máximo, promedio)
    - Gráfica mensual de ventas
    - Últimas 5 facturas
    - Facturas con saldo pendiente
    Todos los datos filtrados y validados estrictamente por compañía activa.
    """
    if not customer:
        return {}

    company = get_effective_company(company)

    # Validar que el cliente pertenece a la compañía activa (si bfel_company está seteada)
    cust_comp = frappe.db.get_value("Customer", customer, "bfel_company")
    if cust_comp and cust_comp != company:
        frappe.throw("El cliente seleccionado pertenece a otra compañía y no se pueden cargar sus estadísticas.")

    since = add_months(today(), -6)

    stats = frappe.db.sql(
        """
        SELECT
            COUNT(*)               AS count,
            COALESCE(SUM(grand_total), 0)  AS total,
            COALESCE(MAX(grand_total), 0)  AS max_invoice,
            COALESCE(AVG(grand_total), 0)  AS avg_invoice
        FROM `tabSales Invoice`
        WHERE customer = %(c)s AND docstatus = 1 AND company = %(company)s
          AND posting_date >= %(since)s
        """,
        {"c": customer, "since": since, "company": company},
        as_dict=True,
    )

    monthly = frappe.db.sql(
        """
        SELECT
            DATE_FORMAT(posting_date, '%%Y-%%m') AS month,
            COALESCE(SUM(grand_total), 0)        AS total,
            COUNT(*)                              AS count
        FROM `tabSales Invoice`
        WHERE customer = %(c)s AND docstatus = 1 AND company = %(company)s
          AND posting_date >= %(since)s
        GROUP BY DATE_FORMAT(posting_date, '%%Y-%%m')
        ORDER BY month ASC
        """,
        {"c": customer, "since": since, "company": company},
        as_dict=True,
    )

    last_invoices = frappe.db.sql(
        """
        SELECT 
            name, 
            posting_date, 
            grand_total, 
            docstatus, 
            bfel_status, 
            COALESCE((
                SELECT SUM(amount) 
                FROM `tabeFast Invoice Payment` 
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0) AS total_payments
        FROM `tabSales Invoice`
        WHERE customer = %(c)s AND docstatus IN (0, 1) AND company = %(company)s
        ORDER BY posting_date DESC, creation DESC
        LIMIT 5
        """,
        {"c": customer, "company": company},
        as_dict=True,
    )

    outstanding_raw = frappe.db.sql(
        """
        SELECT 
            name, 
            posting_date, 
            grand_total, 
            COALESCE((
                SELECT SUM(amount) 
                FROM `tabeFast Invoice Payment` 
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0) AS total_payments
        FROM `tabSales Invoice`
        WHERE customer = %(c)s AND docstatus = 1 AND company = %(company)s
        ORDER BY posting_date ASC
        """,
        {"c": customer, "company": company},
        as_dict=True,
    )

    outstanding = []
    for r in outstanding_raw:
        tot_paid = float(r.get("total_payments") or 0.0)
        gt = float(r.get("grand_total") or 0.0)
        bal = max(0.0, gt - tot_paid)
        if bal > 0.009:
            outstanding.append({
                "name": r["name"],
                "posting_date": str(r["posting_date"] or ""),
                "grand_total": gt,
                "outstanding_amount": bal,
            })
            if len(outstanding) >= 10:
                break

    customer_info = (
        frappe.db.get_value("Customer", customer, ["customer_name", "customer_group"], as_dict=True)
        or {}
    )

    s = stats[0] if stats else {}
    return {
        "customer": customer,
        "customer_name": customer_info.get("customer_name", customer),
        "stats_6m": {
            "count": int(s.get("count") or 0),
            "total": float(s.get("total") or 0),
            "max_invoice": float(s.get("max_invoice") or 0),
            "avg_invoice": float(s.get("avg_invoice") or 0),
        },
        "monthly_chart": [
            {"month": r["month"], "total": float(r["total"] or 0), "count": int(r["count"] or 0)}
            for r in monthly
        ],
        "last_invoices": [
            {
                "name": r["name"],
                "posting_date": str(r["posting_date"] or ""),
                "grand_total": float(r["grand_total"] or 0),
                "outstanding_amount": max(0.0, float(r["grand_total"] or 0) - float(r.get("total_payments") or 0)),
                "docstatus": r["docstatus"],
                "bfel_status": r.get("bfel_status") or "",
                "custom_pagado": 1 if max(0.0, float(r["grand_total"] or 0) - float(r.get("total_payments") or 0)) <= 0.009 else 0,
            }
            for r in last_invoices
        ],
        "outstanding": outstanding,
    }
