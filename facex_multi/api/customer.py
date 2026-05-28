"""
facex_multi.api.customer
-----------------------
Búsqueda y creación rápida de clientes desde el POS.
"""
from __future__ import annotations

import frappe
import json


@frappe.whitelist()
def search_customer(txt: str):
    """Busca clientes por nombre, NIT o código."""
    if not txt or len(txt.strip()) < 2:
        return []
    txt = txt.strip()
    rows = frappe.db.sql(
        """
        SELECT name, customer_name, tax_id, bfel_id_receptor
        FROM `tabCustomer`
        WHERE disabled = 0
          AND (name LIKE %(q)s OR customer_name LIKE %(q)s OR tax_id LIKE %(q)s OR bfel_id_receptor LIKE %(q)s)
        ORDER BY customer_name ASC
        LIMIT 20
        """,
        {"q": f"%{txt}%"},
        as_dict=True,
    )
    for row in rows:
        nit = row.get("bfel_id_receptor") or row.get("tax_id") or ""
        row["tax_id"] = nit
        row["bfel_id_receptor"] = nit
    return rows


@frappe.whitelist()
def get_customer(name: str):
    """Retorna los campos relevantes del cliente para el diálogo."""
    doc = frappe.get_doc("Customer", name)
    nit = doc.get("bfel_id_receptor") or doc.get("tax_id") or ""
    return {
        "name": doc.name,
        "customer_name": doc.customer_name or "",
        "bfel_identificacion": doc.get("bfel_identificacion") or "",
        "bfel_id_receptor": nit,
        "custom_direccion": doc.get("custom_direccion") or "",
        "custom_departamento": doc.get("custom_departamento") or "",
        "custom_telefono": doc.get("custom_telefono") or "",
        "naming_series": doc.get("naming_series") or "",
        "payment_terms": doc.get("payment_terms") or "",
        "default_price_list": doc.get("default_price_list") or "",
        "default_sales_partner": doc.get("default_sales_partner") or "",
    }


@frappe.whitelist()
def create_or_update_customer(data_json: str):
    """Crea o actualiza un cliente con los campos del diálogo rápido."""
    data = json.loads(data_json) if isinstance(data_json, str) else data_json
    name = (data.get("name") or "").strip()

    if name:
        doc = frappe.get_doc("Customer", name)
    else:
        doc = frappe.new_doc("Customer")
        doc.customer_type = "Individual"
        doc.customer_group = (
            frappe.db.get_value("Customer Group", {"is_group": 0}, "name", order_by="lft asc")
            or "All Customer Groups"
        )
        doc.territory = (
            frappe.db.get_value("Territory", {"is_group": 0}, "name", order_by="lft asc")
            or "All Territories"
        )

    editable = [
        "customer_name", "bfel_identificacion", "bfel_id_receptor",
        "custom_direccion", "custom_departamento", "custom_telefono",
        "payment_terms", "default_price_list", "default_sales_partner",
    ]
    for field in editable:
        if field in data:
            setattr(doc, field, data[field])

    # Sincronizar tax_id y bfel_id_receptor
    if doc.meta.has_field("bfel_id_receptor"):
        nit = doc.get("bfel_id_receptor") or doc.get("tax_id") or ""
        if nit:
            doc.bfel_id_receptor = nit
            doc.tax_id = nit

    doc.save(ignore_permissions=False)
    frappe.db.commit()
    return {"name": doc.name, "customer_name": doc.customer_name}


def sync_customer_nit(doc, method=None):
    """Sincroniza tax_id y bfel_id_receptor antes de guardar el cliente."""
    if doc.meta.has_field("bfel_id_receptor"):
        nit = doc.get("bfel_id_receptor") or doc.get("tax_id") or ""
        if nit:
            doc.bfel_id_receptor = nit
            doc.tax_id = nit
