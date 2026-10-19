"""Comisionador (2026-10-19): DocTypes de la liquidación de comisiones y el
permiso «comisionador» (nace apagado en todos los sitios: deny-by-default; solo
System Manager lo tiene hasta que Gerencia lo marque en FacEx Settings / Perfil).
No concede el permiso a ningún usuario."""
import frappe


def execute():
    for dt in ("facex_comision_liquidacion_vendedor", "facex_comision_liquidacion_detalle",
               "facex_comision_liquidacion", "facex_perfil_de_permisos", "facex_settings"):
        frappe.reload_doc("facex_multi", "doctype", dt)
    from facex_multi.api.permissions import clear_permissions_cache
    clear_permissions_cache()
