import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_liquidacion_transportista_detalle", force=True)
    frappe.reload_doc("facex_multi", "doctype", "facex_liquidacion_transportista", force=True)
    frappe.db.commit()
