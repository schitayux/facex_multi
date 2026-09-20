"""
Patch: recarga FacEx Settings con el campo `rol_clasificacion` (Bodega /
Ventas / Producción / Gerencia) y marca como "Gerencia" a los usuarios
jorge.gerencia@neko.local y karla.gerencia@neko.local, si existen en este
site. Solo "Gerencia" habilita selección libre de almacén/usuario creador en
los reportes de FacEx Clásico — el resto queda forzado a sus propias
operaciones (ver facex_multi.api.reports._resolve_owner_filter).
"""
import frappe


_GERENCIA_USERS = ("jorge.gerencia@neko.local", "karla.gerencia@neko.local")


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)

    for user in _GERENCIA_USERS:
        if not frappe.db.exists("User", user):
            continue
        for name in frappe.get_all("FacEx Settings", filters={"user": user}, pluck="name"):
            frappe.db.set_value("FacEx Settings", name, "rol_clasificacion", "Gerencia")

    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
