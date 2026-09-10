"""
Patch: crea el custom field 'custom_facex_familia' en Item.
Link a «FacEx Familia de Precio». Agrupa los SKU que comparten precio y costo
(ver Mantenimiento de Familias en FacEx). Idempotente.
"""
import frappe
from facex_multi.api.familia import ensure_item_familia_field


def execute():
    ensure_item_familia_field()
    frappe.db.commit()
