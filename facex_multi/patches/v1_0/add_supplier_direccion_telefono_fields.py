"""
Patch: crea los custom fields 'custom_direccion' y 'custom_telefono' en Supplier.

El Mantenimiento de Proveedores (FacEx clásico) ya leía/escribía estos dos
campos desde purchase.py (get_supplier / create_or_update_supplier), pero
nunca se habían creado como Custom Field — por lo tanto nunca se persistían
(el setattr fallaba silenciosamente dentro de un try/except). Este patch los
crea para que Teléfono y Dirección realmente se guarden.
Idempotente — create_custom_fields crea o actualiza sin duplicar.
"""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    create_custom_fields(
        {
            "Supplier": [
                {
                    "fieldname": "custom_direccion",
                    "fieldtype": "Data",
                    "label": "Dirección",
                    "insert_after": "tax_id",
                    "module": "FacEx Multi",
                },
                {
                    "fieldname": "custom_telefono",
                    "fieldtype": "Data",
                    "label": "Teléfono",
                    "insert_after": "custom_direccion",
                    "module": "FacEx Multi",
                },
            ],
        }
    )
    frappe.db.commit()
