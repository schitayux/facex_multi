"""
Patch: Cierre Diario de Ventas — recarga FacEx Settings con el permiso
`puede_crear_cierres` y crea los DocTypes «FacEx Cierre Diario» (+ tablas
hijas Egreso / Familia / Factura) y la Page facex-cierre.
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)
    for dt in ("facex_cierre_diario_egreso", "facex_cierre_diario_familia",
               "facex_cierre_diario_factura", "facex_cierre_diario"):
        frappe.reload_doc("facex_multi", "doctype", dt, force=True)
    frappe.reload_doc("facex_multi", "page", "facex_cierre", force=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
