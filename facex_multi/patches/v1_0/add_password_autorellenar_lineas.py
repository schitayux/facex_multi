"""Tres ajustes de FacEx Settings / Configuración de Compañía (2026-10-05).

1. puede_cambiar_password: «Cambiar Contraseña» del menú de usuario. Nace en 1
   (default del campo) en todos los sitios; en neko.chappsa.com solo Gerencia.
2. puede_autorellenar_recepcion: nace en 0 (default del campo), sin backfill.
3. lineas_nuevas_al_inicio (Configuración de Compañía): nace en 0; en neko se
   activa en todas las compañías (orden descendente).
"""
import frappe

NEKO_SITE = "neko.chappsa.com"


def execute():
    if frappe.local.site != NEKO_SITE:
        return
    frappe.db.sql(
        """UPDATE `tabFacEx Perfil de Permisos`
           SET puede_cambiar_password = IF(name = 'Gerencia', 1, 0)"""
    )
    frappe.db.sql(
        """UPDATE `tabFacEx Settings`
           SET puede_cambiar_password =
               IF(IFNULL(perfil, '') = 'Gerencia' OR IFNULL(rol_clasificacion, '') = 'Gerencia', 1, 0)
           WHERE IFNULL(user, '') != ''"""
    )
    if frappe.db.table_exists("FacEx Configuracion Compania"):
        frappe.db.sql("UPDATE `tabFacEx Configuracion Compania` SET lineas_nuevas_al_inicio = 1")
    frappe.clear_cache()
