"""«Exigir Vendedor» (Configuración de Compañía, 2026-11-01): nace en 0. Se
activa solo en las compañías que ya trabajan con vendedor en todas sus ventas
(Neko en neko.chappsa.com, IMPORTADORA O.R. en disfavil.chappsa.com). Las
compañías de facex.chappsa.com quedan fuera de la regla por decisión del
usuario."""
import frappe

COMPANIAS = ("Neko", "IMPORTADORA O.R.")


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_configuracion_compania")
    for company in COMPANIAS:
        if frappe.db.exists("FacEx Configuracion Compania", company):
            frappe.db.set_value("FacEx Configuracion Compania", company, "exige_vendedor", 1,
                                update_modified=False)
    frappe.clear_cache()
