"""Cierre Diario General (2026-10-14): el check reporte_cierre_general nace
apagado en todos los sitios (deny-by-default; System Manager siempre lo tiene).
En neko.chappsa.com se concede a Jorge y Karla (Gerencia) como excepción de
su fila, sin tocar el perfil."""
import frappe

NEKO_SITE = "neko.chappsa.com"
USUARIOS = ("jorge.gerencia@neko.local", "karla.gerencia@neko.local")


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_perfil_de_permisos")
    frappe.reload_doc("facex_multi", "doctype", "facex_settings")
    if frappe.local.site != NEKO_SITE:
        return
    for name in frappe.get_all("FacEx Settings", filters={"user": ["in", USUARIOS]}, pluck="name"):
        doc = frappe.get_doc("FacEx Settings", name)
        if int(doc.reporte_cierre_general or 0):
            continue
        doc.reporte_cierre_general = 1
        doc.save(ignore_permissions=True)
    from facex_multi.api.permissions import clear_permissions_cache
    clear_permissions_cache()
