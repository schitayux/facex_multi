"""
Patch: recarga FacEx Settings con el campo `bfel_status_por_defecto`
(preferencia por usuario del estado FEL con el que arrancan las facturas
nuevas en FacEx Clásico y FacEx Screen: "01 Enviar" / "00 No enviar").
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
