"""
Patch: Flujo de Recepción y Devolución de Traslados en Tránsito.

- Recarga FacEx Settings (campos nuevos `transito_por_defecto`, `puede_recibir_traslados`).
- Recarga los DocTypes nuevos `FacEx Recepcion Traslado` y `FacEx Recepcion Traslado Item`.

Idempotente.
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_recepcion_traslado_item", force=True)
    frappe.reload_doc("facex_multi", "doctype", "facex_recepcion_traslado", force=True)
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
