"""
Patch: crea el custom field 'custom_tiene_adenda' en Item.
Marca los ítems (ej. municiones) que requieren adenda DIGECAM al vender,
usado por FacEx Screen / FacEx POS para disparar el flujo de series y adendas.
Idempotente — create_custom_fields crea o actualiza sin duplicar.
"""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    create_custom_fields(
        {
            "Item": [
                {
                    "fieldname": "custom_tiene_adenda",
                    "fieldtype": "Check",
                    "label": "Tiene Adenda",
                    "insert_after": "has_serial_no",
                    "description": "Ítems que requieren adenda DIGECAM (ej. municiones) al vender.",
                    "module": "FacEx Multi",
                }
            ],
        }
    )
    frappe.db.commit()
