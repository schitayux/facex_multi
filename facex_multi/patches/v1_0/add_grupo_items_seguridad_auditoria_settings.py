"""
Patch: recarga FacEx Settings con los campos nuevos de Grupo de Ítems
(consulta_grupo_items, mantiene_grupo_items), Seguridad
(puede_ver_facex_settings, puede_resetear_password) y el permiso del reporte
Auditoría de Sistema (reporte_auditoria_sistema).
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
