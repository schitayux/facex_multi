"""
Patch: recarga FacEx Settings con los campos de Familias de Precio
(consulta_familias, mantiene_familias, exige_familia_item).
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings")
    frappe.reload_doc("facex_multi", "doctype", "facex_familia_de_precio_lista")
    frappe.reload_doc("facex_multi", "doctype", "facex_familia_de_precio")
    frappe.db.commit()
