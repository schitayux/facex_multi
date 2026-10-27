"""Ventas por Live (2026-10-27): DocTypes de sesión/pedido y la sección de
permisos «Ventas por Live» (nace apagada en todos los sitios: deny-by-default;
solo System Manager la tiene hasta que Gerencia la marque en FacEx Settings /
Perfil). No concede el permiso a ningún usuario."""
import frappe


def execute():
    for dt in ("facex_live_personaje", "facex_live_prenda", "facex_live_sesion", "facex_live_pedido",
               "facex_perfil_de_permisos", "facex_settings"):
        frappe.reload_doc("facex_multi", "doctype", dt)
    from facex_multi.api.permissions import clear_permissions_cache
    clear_permissions_cache()
