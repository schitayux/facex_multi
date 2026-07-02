"""
facex_multi.api.sales_partner
------------------------------
Búsqueda de socios de ventas con filtros de compañía (lógica bfel_company_null).
"""
from __future__ import annotations

import frappe
from facex_multi.api.invoice import get_effective_company


@frappe.whitelist()
def search_sales_partners(txt: str = "", company: str = None):
    """Busca socios de ventas filtrados por compañía activa con lógica bfel_company_null."""
    company = get_effective_company(company)
    q = f"%{txt.strip()}%" if txt and txt.strip() else "%"
    return frappe.db.sql(
        """
        SELECT name, partner_name, partner_type, commission_rate
        FROM `tabSales Partner`
        WHERE (
            bfel_company = %(company)s
            OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
        )
          AND (name LIKE %(q)s OR partner_name LIKE %(q)s)
        ORDER BY partner_name ASC
        LIMIT 20
        """,
        {"q": q, "company": company},
        as_dict=True,
    )


def validate_sales_partner_company(sales_partner: str, company: str) -> None:
    """
    Valida que un Sales Partner sea accesible desde la compañía indicada.
    Replica la lógica bfel_company_null: lanza frappe.throw si no es accesible.
    """
    if not sales_partner or not company:
        return
    sp = frappe.db.get_value(
        "Sales Partner",
        sales_partner,
        ["bfel_company", "bfel_company_null"],
        as_dict=True,
    )
    if not sp:
        return
    sp_company = sp.bfel_company or ""
    sp_null = int(sp.bfel_company_null or 0)
    if sp_company and sp_company != company:
        frappe.throw(
            f"El Socio de Ventas '{sales_partner}' pertenece a '{sp_company}' "
            f"y no puede utilizarse en '{company}'."
        )
    if not sp_company and sp_null:
        frappe.throw(
            f"El Socio de Ventas '{sales_partner}' está marcado como exclusivo "
            f"sin compañía asignada y no es accesible."
        )
