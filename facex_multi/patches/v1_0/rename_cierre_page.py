"""
Patch: la Page del Cierre Diario se llamaba «facex-cierre-diario», igual que el
slug de la vista de lista del DocType «FacEx Cierre Diario» — el router de Desk
prefiere el DocType, así que la Page nunca abría. Ahora se llama «facex-cierre».
"""
import frappe


def execute():
    frappe.delete_doc_if_exists("Page", "facex-cierre-diario")
    frappe.reload_doc("facex_multi", "page", "facex_cierre", force=True)
    frappe.db.commit()
