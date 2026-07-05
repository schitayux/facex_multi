"""
Patch: agrega el campo bfel_multi_tipo ("Tipo FEL") a Purchase Invoice
(encabezado) y Purchase Invoice Item (detalle), con el catálogo completo de
clasificación fiscal usado por FacEx para compras:
B-Bien, S-Servicio, C-Combustible, I-Importación, E-Exportación,
P-Pequeño Contribuyente, L-Exención Local, N-No Aplica, X-Sin Asignación.

Ya existía un campo homónimo en Sales Invoice Item (solo B/S); este es
independiente, específico de compras, y con el catálogo completo.

Idempotente — create_custom_fields crea o actualiza sin duplicar.
"""
import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

TIPO_OPTIONS = "\nB\nS\nC\nI\nE\nP\nL\nN\nX"
TIPO_DESCRIPTION = (
    "B=Bien, S=Servicio, C=Combustible, I=Importación, E=Exportación, "
    "P=Pequeño Contribuyente, L=Exención Local, N=No Aplica, X=Sin Asignación"
)


def execute():
    create_custom_fields(
        {
            "Purchase Invoice": [
                {
                    "fieldname": "bfel_multi_tipo",
                    "fieldtype": "Select",
                    "label": "Tipo FEL",
                    "options": TIPO_OPTIONS,
                    "description": TIPO_DESCRIPTION,
                    "insert_after": "supplier",
                    "module": "FacEx Multi",
                }
            ],
            "Purchase Invoice Item": [
                {
                    "fieldname": "bfel_multi_tipo",
                    "fieldtype": "Select",
                    "label": "Tipo FEL",
                    "options": TIPO_OPTIONS,
                    "description": TIPO_DESCRIPTION,
                    "insert_after": "warehouse",
                    "module": "FacEx Multi",
                }
            ],
        }
    )
    frappe.db.commit()
