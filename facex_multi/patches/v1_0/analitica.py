"""Analítica (2026-11-01): permiso «analitica» en FacEx Settings y en el Perfil
de Permisos. Nace apagado en todos los sitios (deny-by-default): solo System
Manager entra hasta que Gerencia lo marque."""
import frappe


def execute():
    for dt in ("facex_perfil_de_permisos", "facex_settings"):
        frappe.reload_doc("facex_multi", "doctype", dt)
    from facex_multi.api.permissions import clear_permissions_cache
    clear_permissions_cache()
