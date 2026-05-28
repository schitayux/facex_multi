"""
Patch: crea custom fields en Sales Invoice para el módulo de pagos eFast.
Idempotente — se puede correr múltiples veces sin efecto secundario.
"""
import frappe


def execute():
    # 1. Asegurar que el rol 'facex_multi' exista en la base de datos
    if not frappe.db.exists("Role", "facex_multi"):
        try:
            frappe.get_doc({
                "doctype": "Role",
                "role_name": "facex_multi",
                "desk_access": 1
            }).insert(ignore_permissions=True)
        except Exception:
            pass

    # 2. Crear campos personalizados
    _create_if_missing(
        dt="Sales Invoice",
        fieldname="custom_pagado",
        label="Pagado",
        fieldtype="Check",
        default="0",
        insert_after="outstanding_amount",
    )
    _create_if_missing(
        dt="Sales Invoice",
        fieldname="custom_efast_payments",
        label="Pagos eFast",
        fieldtype="Table",
        options="eFast Invoice Payment",
        insert_after="custom_pagado",
    )
    frappe.db.commit()


def _create_if_missing(**kwargs):
    dt = kwargs["dt"]
    fieldname = kwargs["fieldname"]
    if frappe.db.exists("Custom Field", {"dt": dt, "fieldname": fieldname}):
        return
    doc = frappe.new_doc("Custom Field")
    for k, v in kwargs.items():
        setattr(doc, k, v)
    doc.module = "FacEx Multi"
    doc.insert(ignore_permissions=True)
