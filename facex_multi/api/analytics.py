"""
facex_multi.api.analytics
------------------------
Análisis de ventas por cliente para la pestaña de Análisis del POS.
"""
from __future__ import annotations

import frappe
from frappe.utils import today, add_months


@frappe.whitelist()
def get_customer_analytics(customer: str):
    """
    Retorna estadísticas de ventas del cliente para los últimos 6 meses:
    - Stats agregadas (count, total, máximo, promedio)
    - Gráfica mensual de ventas
    - Últimas 5 facturas
    - Facturas con saldo pendiente
    """
    if not customer:
        return {}

    since = add_months(today(), -6)

    stats = frappe.db.sql(
        """
        SELECT
            COUNT(*)               AS count,
            COALESCE(SUM(grand_total), 0)  AS total,
            COALESCE(MAX(grand_total), 0)  AS max_invoice,
            COALESCE(AVG(grand_total), 0)  AS avg_invoice
        FROM `tabSales Invoice`
        WHERE customer = %(c)s AND docstatus = 1
          AND posting_date >= %(since)s
        """,
        {"c": customer, "since": since},
        as_dict=True,
    )

    monthly = frappe.db.sql(
        """
        SELECT
            DATE_FORMAT(posting_date, '%%Y-%%m') AS month,
            COALESCE(SUM(grand_total), 0)        AS total,
            COUNT(*)                              AS count
        FROM `tabSales Invoice`
        WHERE customer = %(c)s AND docstatus = 1
          AND posting_date >= %(since)s
        GROUP BY DATE_FORMAT(posting_date, '%%Y-%%m')
        ORDER BY month ASC
        """,
        {"c": customer, "since": since},
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
            custom_pagado,
            COALESCE((
                SELECT SUM(amount) 
                FROM `tabeFast Invoice Payment` 
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0) AS total_payments
        FROM `tabSales Invoice`
        WHERE customer = %(c)s AND docstatus IN (0, 1)
        ORDER BY posting_date DESC, creation DESC
        LIMIT 5
        """,
        {"c": customer},
        as_dict=True,
    )

    outstanding_raw = frappe.db.sql(
        """
        SELECT 
            name, 
            posting_date, 
            grand_total, 
            custom_pagado,
            COALESCE((
                SELECT SUM(amount) 
                FROM `tabeFast Invoice Payment` 
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0) AS total_payments
        FROM `tabSales Invoice`
        WHERE customer = %(c)s AND docstatus = 1
        ORDER BY posting_date ASC
        """,
        {"c": customer},
        as_dict=True,
    )

    outstanding = []
    for r in outstanding_raw:
        if int(r.get("custom_pagado") or 0) == 1:
            continue
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
                "outstanding_amount": 0.0 if int(r.get("custom_pagado") or 0) == 1 else max(0.0, float(r["grand_total"] or 0) - float(r.get("total_payments") or 0)),
                "docstatus": r["docstatus"],
                "bfel_status": r.get("bfel_status") or "",
                "custom_pagado": int(r.get("custom_pagado") or 0),
            }
            for r in last_invoices
        ],
        "outstanding": outstanding,
    }
