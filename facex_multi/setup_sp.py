import frappe

def execute():
    if not frappe.db.exists("Custom Field", "Sales Partner-bfel_company"):
        frappe.get_doc({
            "doctype": "Custom Field",
            "dt": "Sales Partner",
            "fieldname": "bfel_company",
            "label": "Compañía (FEL)",
            "fieldtype": "Link",
            "options": "Company",
            "insert_after": "partner_type",
            "in_list_view": 1,
            "in_standard_filter": 1
        }).insert(ignore_permissions=True)
        frappe.db.commit()
        print("Campo bfel_company creado en Sales Partner.")
    else:
        print("Campo bfel_company ya existe en Sales Partner.")
