import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_guia_transportista", force=True)

    create_custom_fields(
        {
            "Sales Invoice": [
                {
                    "fieldname": "bfel_transporte_tab",
                    "fieldtype": "Tab Break",
                    "label": "Transporte",
                    "insert_after": "shipping_rule",
                    "module": "FacEx Multi",
                },
                {
                    "fieldname": "bfel_guias_transportista",
                    "fieldtype": "Table",
                    "label": "Guías de Transporte",
                    "options": "FacEx Guia Transportista",
                    "insert_after": "bfel_transporte_tab",
                    "module": "FacEx Multi",
                },
            ],
        }
    )
    frappe.db.commit()
