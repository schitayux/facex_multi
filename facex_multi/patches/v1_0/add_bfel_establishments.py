import frappe
import os

def execute():
    # 1. Force sync/reload the new doctype to make sure its database table is created
    try:
        frappe.reload_doc("facex_multi", "doctype", "bfel_establecimientos", force=True)
        print("BFEL Establecimientos DocType synced successfully.")
    except Exception as e:
        frappe.log_error(message=frappe.get_traceback(), title="Error reloading BFEL Establecimientos")
        raise e

    # 2. Create the custom field 'bfel_establecimientos' (Table) in 'BFEL Settings'
    if not frappe.db.exists("Custom Field", "BFEL Settings-bfel_establecimientos"):
        try:
            doc = frappe.new_doc("Custom Field")
            doc.dt = "BFEL Settings"
            doc.fieldname = "bfel_establecimientos"
            doc.label = "Establecimientos"
            doc.fieldtype = "Table"
            doc.options = "BFEL Establecimientos"
            doc.insert_after = "receptor_email_default"
            doc.module = "FacEx Multi"
            doc.insert(ignore_permissions=True)
            print("Custom field bfel_establecimientos created in BFEL Settings.")
        except Exception as e:
            frappe.log_error(message=frappe.get_traceback(), title="Error creating custom field bfel_establecimientos")
            raise e

    # 3. Add default establishment line for all existing BFEL Settings
    try:
        settings_list = frappe.get_all("BFEL Settings", fields=["name", "company"])
        for s in settings_list:
            doc = frappe.get_doc("BFEL Settings", s.name)
            
            # Check if already has establishment 1
            has_est_1 = False
            if doc.get("bfel_establecimientos"):
                for est in doc.bfel_establecimientos:
                    if str(est.establecimiento_id) == "1":
                        has_est_1 = True
                        break
            
            if not has_est_1:
                # Get company logo
                company_logo = frappe.db.get_value("Company", doc.company, "company_logo") or ""
                
                # Append default row
                doc.append("bfel_establecimientos", {
                    "establecimiento_id": 1,
                    "nombre_establecimiento": doc.company,
                    "subnombre_establecimiento": doc.company,
                    "logo": company_logo,
                    "activo": 1
                })
                doc.save(ignore_permissions=True)
                print(f"Added default establishment to BFEL Settings: {doc.name}")
    except Exception as e:
        frappe.log_error(message=frappe.get_traceback(), title="Error migrating default establishments")
        raise e
            
    # 4. Delete existing print formats from the database to force reload from files
    templates = ["Cotización FacEx", "Recibo de Pago FacEx", "FAC FEL", "FAC CERTIFI"]
    for t in templates:
        try:
            if frappe.db.exists("Print Format", t):
                frappe.delete_doc("Print Format", t, ignore_permissions=True)
                print(f"Deleted print format {t} to force refresh from template files.")
        except Exception as e:
            frappe.log_error(message=frappe.get_traceback(), title=f"Error deleting print format {t}")

    frappe.db.commit()
    print("Migration patch executed successfully.")
