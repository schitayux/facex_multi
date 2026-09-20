"""
Patch: agrega al grid "Bodegas Habilitadas" (FacEx Settings Bodega) los checks
de operación permitida por bodega — venta, compra, entrada, salida y
transferencia — y los deja en 1 en las filas ya existentes, para que ningún
usuario configurado pierda acceso al migrar. De ahí en adelante la regla es
"check desmarcado = operación denegada en esa bodega".
Idempotente.
"""
import frappe

OPERACIONES = (
    "permite_venta",
    "permite_compra",
    "permite_entrada",
    "permite_salida",
    "permite_transferencia",
)


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings_bodega", force=True)
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)

    sets = ", ".join(f"`{f}` = 1" for f in OPERACIONES)
    where = " OR ".join(f"IFNULL(`{f}`, 0) = 0" for f in OPERACIONES)
    frappe.db.sql(f"UPDATE `tabFacEx Settings Bodega` SET {sets} WHERE {where}")

    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
