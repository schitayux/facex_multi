"""
Patch: crea el custom field 'descripcion_2' en Sales Invoice Item.
Idempotente — se puede correr múltiples veces sin efecto secundario.
"""
import frappe


def execute():
    if frappe.db.exists("Custom Field", {"dt": "Sales Invoice Item", "fieldname": "descripcion_2"}):
        return

    doc = frappe.new_doc("Custom Field")
    doc.dt = "Sales Invoice Item"
    doc.fieldname = "descripcion_2"
    doc.label = "Descripción 2"
    doc.fieldtype = "Small Text"
    doc.insert_after = "item_tax_template"
    doc.print_hide = 1
    doc.module = "FacEx Multi"
    doc.insert(ignore_permissions=True)
    frappe.db.commit()
