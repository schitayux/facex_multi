"""
Patch: agrega el child doctype "FacEx Settings Lista Precios" y recarga
"FacEx Settings" para que aparezcan los campos nuevos:
  - listas_precios_habilitadas (Table)
  - lista_precios_por_defecto (Link -> Price List)
y el cambio de label/description de puede_editar_precio.
Idempotente.
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings_lista_precios", force=True)
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
