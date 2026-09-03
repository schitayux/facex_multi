"""
Patch: Análisis de Utilidad + Asignación de Precios (FacEx).

- Recarga FacEx Settings para tomar los permisos nuevos:
  `reporte_analisis_utilidad` y `asignacion_precios`.
- Crea el custom field `custom_costo_estandar` (Currency) en Item — costo estándar
  de referencia que consumen el informe de Utilidad y la Asignación de Precios.

Idempotente — create_custom_fields crea o actualiza sin duplicar.
"""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)

    create_custom_fields(
        {
            "Item": [
                {
                    "fieldname": "custom_costo_estandar",
                    "fieldtype": "Currency",
                    "label": "Costo Estándar (FacEx)",
                    "insert_after": "valuation_rate",
                    "module": "FacEx Multi",
                    "description": (
                        "Costo estándar de referencia usado por el Análisis de Utilidad "
                        "y la Asignación de Precios de FacEx."
                    ),
                },
            ]
        }
    )
    frappe.db.commit()
