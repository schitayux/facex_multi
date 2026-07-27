import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_transportista", force=True)
    frappe.db.commit()
