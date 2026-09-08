"""
Patch: segregación Grabar Borrador / Validar y Confirmar por operación de
inventario (Entrada/Salida/Transferencia).

- Recarga FacEx Settings (6 campos nuevos).
- Backfill retrocompatible: donde hoy hay `puede_hacer_<op> = 1`, activa
  `<op>_validar_confirmar = 1` para conservar el comportamiento actual
  (guardar = validar directo).

Idempotente.
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)
    for legacy, submit_f in (
        ("puede_hacer_entradas", "entrada_validar_confirmar"),
        ("puede_hacer_salidas", "salida_validar_confirmar"),
        ("puede_hacer_transferencias", "transferencia_validar_confirmar"),
    ):
        frappe.db.sql(
            f"UPDATE `tabFacEx Settings` SET `{submit_f}` = 1 WHERE `{legacy}` = 1"
        )
    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
