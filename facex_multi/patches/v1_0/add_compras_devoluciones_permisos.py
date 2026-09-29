"""
Patch: permisos de Devolución de Mercadería y Nota de Crédito de Proveedor
(FacEx Compras, fase 3). Cada fila de FacEx Settings y cada Perfil recibe
lo que hoy tiene en Entrada / Factura de Compra, y se recalculan las
excepciones de las filas con perfil.
"""
import frappe

MAPPING = {
    "devolucion_compra_grabar_borrador": "entrada_compra_grabar_borrador",
    "devolucion_compra_validar": "entrada_compra_validar",
    "devolucion_compra_cancelar": "entrada_compra_cancelar",
    "nc_compra_grabar_borrador": "factura_compra_grabar_borrador",
    "nc_compra_validar": "puede_validar_compras",
    "nc_compra_cancelar": "puede_cancelar_compras",
}


def execute():
    for dt in ("facex_settings_excepcion", "facex_perfil_de_permisos", "facex_settings"):
        frappe.reload_doc("facex_multi", "doctype", dt)

    sets = ", ".join(f"`{new}` = IFNULL(`{old}`, 0)" for new, old in MAPPING.items())
    for table in ("tabFacEx Settings", "tabFacEx Perfil de Permisos"):
        frappe.db.sql(f"UPDATE `{table}` SET {sets}")

    from facex_multi.api.perfiles import sync_settings_with_profile

    for name in frappe.get_all("FacEx Settings", filters={"perfil": ["is", "set"]}, pluck="name"):
        row = frappe.get_doc("FacEx Settings", name)
        row.flags.keep_checks = True
        sync_settings_with_profile(row)
        frappe.db.delete("FacEx Settings Excepcion", {"parent": row.name, "parenttype": "FacEx Settings"})
        for i, e in enumerate(row.get("excepciones") or [], 1):
            e.idx = i
            e.db_insert()

    from facex_multi.api.permissions import clear_permissions_cache
    clear_permissions_cache()
    frappe.db.commit()
