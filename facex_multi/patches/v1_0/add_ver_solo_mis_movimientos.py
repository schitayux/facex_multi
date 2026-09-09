"""
Patch: campo `ver_solo_mis_movimientos` en FacEx Settings.

Si está marcado, en la pestaña «Movimientos del Mes» del módulo de Inventario
el usuario solo ve los Stock Entry que él mismo creó.

Default 0 (ve todos) → no cambia el comportamiento de ningún usuario existente;
el administrador marca la casilla para los usuarios que deban quedar acotados.

Idempotente.
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)
    frappe.clear_cache(doctype="FacEx Settings")
