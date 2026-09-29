"""
Patch: permisos por documento de FacEx Compras (Orden de Compra, Entrada de
Mercadería, Factura de Compra — Grabar Borrador / Validar / Cancelar).

Para que nadie note el cambio, cada fila de FacEx Settings y cada Perfil de
Permisos recibe lo que hoy le dan los checks de Compras:
- *_grabar_borrador ← puede_compras
- oc_validar / entrada_compra_validar ← puede_validar_compras
- oc_cancelar / entrada_compra_cancelar ← puede_cancelar_compras
Luego se recalculan las excepciones de las filas con perfil (son las mismas
de antes, extendidas a los checks nuevos).
"""
import frappe

MAPPING = {
    "oc_grabar_borrador": "puede_compras",
    "entrada_compra_grabar_borrador": "puede_compras",
    "factura_compra_grabar_borrador": "puede_compras",
    "oc_validar": "puede_validar_compras",
    "entrada_compra_validar": "puede_validar_compras",
    "oc_cancelar": "puede_cancelar_compras",
    "entrada_compra_cancelar": "puede_cancelar_compras",
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
