"""«Ver unidad de medida» (Configuración de Compañía, 2026-10-06): nace en 0 en
todos los sitios; neko.chappsa.com lo activa (necesario para Entero/Fracción)."""
import frappe


def execute():
    if frappe.local.site != "neko.chappsa.com":
        return
    frappe.reload_doc("facex_multi", "doctype", "facex_configuracion_compania")
    frappe.db.sql("UPDATE `tabFacEx Configuracion Compania` SET mostrar_uom = 1")
    frappe.clear_cache()
