"""
Patch: crea el custom field 'custom_facex_palabras_busqueda' en Item.
Texto libre con alias/números de referencia/nombres alternos del producto,
usado por la búsqueda dedicada (F8) en FacEx / FacEx Screen.
Idempotente — create_custom_fields crea o actualiza sin duplicar.
"""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    create_custom_fields(
        {
            "Item": [
                {
                    "fieldname": "custom_facex_palabras_busqueda",
                    "fieldtype": "Small Text",
                    "label": "Palabras de Búsqueda / Referencias",
                    "insert_after": "description",
                    "description": "Alias, números de referencia (cross-reference) u otros nombres con los que se busca este producto. Se usa en la búsqueda dedicada (F8) de FacEx / FacEx Screen.",
                    "module": "FacEx Multi",
                }
            ],
        }
    )
    frappe.db.commit()
