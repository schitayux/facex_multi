import frappe


def execute():
    """
    Frappe v16 slugifies workspace names for routing (FacEx → facex),
    which conflicts with the Page named "facex". Delete the auto-created
    workspaces so the page is reachable at /app/facex.
    """
    conflicting = ["FacEx", "Facturación FacEx", "efast-sale", "eFast Sale"]
    for name in conflicting:
        if frappe.db.exists("Workspace", name):
            frappe.delete_doc("Workspace", name, force=True, ignore_permissions=True)

    # Remove stale old page if it still exists
    if frappe.db.exists("Page", "efast-sale"):
        frappe.delete_doc("Page", "efast-sale", force=True, ignore_permissions=True)

    frappe.db.commit()
