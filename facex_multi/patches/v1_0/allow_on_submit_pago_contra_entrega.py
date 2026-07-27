import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    # Necesario para el caso de reintento en save_guias_transporte: poder
    # marcar bfel_pago_contra_entrega en una factura ya sometida.
    create_custom_fields(
        {
            "Sales Invoice": [
                {
                    "fieldname": "bfel_pago_contra_entrega",
                    "fieldtype": "Check",
                    "label": "Pago Contra Entrega",
                    "insert_after": "bfel_transporte_tab",
                    "module": "FacEx Multi",
                    "no_copy": 1,
                    "default": "0",
                    "description": "Marcado desde FacEx Screen cuando el cliente paga contra entrega (cobra el transportista, no el cajero).",
                    "allow_on_submit": 1,
                },
            ],
        }
    )

    frappe.db.commit()
