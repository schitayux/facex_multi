"""Navegación restringida (2026-10-06), ver facex_multi.api.nav_guard.

El cambio entra SIN efecto en producción: «Permitir navegar x ERP» queda en 1
para todas las filas de FacEx Settings y todos los perfiles (nadie queda
restringido hasta que se le desmarque a mano), y la página de inicio de cada
compañía en «facex».
"""
import frappe


def execute():
    for doctype in ("FacEx Settings", "FacEx Perfil de Permisos"):
        if frappe.db.table_exists(doctype) and frappe.db.has_column(doctype, "permite_navegar_erp"):
            frappe.db.sql(f"UPDATE `tab{doctype}` SET permite_navegar_erp = 1")

    config = "FacEx Configuracion Compania"
    if frappe.db.table_exists(config) and frappe.db.has_column(config, "pagina_inicio_restringida"):
        frappe.db.sql(
            f"""UPDATE `tab{config}` SET pagina_inicio_restringida = 'facex'
                WHERE IFNULL(pagina_inicio_restringida, '') = ''"""
        )

    frappe.cache.delete_key("bootinfo")
