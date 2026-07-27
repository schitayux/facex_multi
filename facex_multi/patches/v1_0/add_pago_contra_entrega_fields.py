import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)

    # bfel_guias_transportista necesita poder editarse aun con la factura ya
    # sometida/certificada, para poder completar la guía después (flujo
    # "Envíos Pendientes" de FacEx Screen) sin reabrir el resto del documento.
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
                },
                {
                    "fieldname": "bfel_guias_transportista",
                    "fieldtype": "Table",
                    "label": "Guías de Transporte",
                    "options": "FacEx Guia Transportista",
                    "insert_after": "bfel_pago_contra_entrega",
                    "module": "FacEx Multi",
                    "allow_on_submit": 1,
                },
            ],
        }
    )

    frappe.db.commit()
