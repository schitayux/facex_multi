import frappe
import json


def execute():
    new_content = json.dumps([
        {"id": "facex_shortcut", "type": "shortcut", "data": {"shortcut_name": "FacEx", "col": 4}},
        {"id": "facex_si_carga_shortcut", "type": "shortcut", "data": {"shortcut_name": "Carga SI FacEx", "col": 4}}
    ])
    if frappe.db.exists("Workspace", "FacEx Multi"):
        frappe.db.set_value("Workspace", "FacEx Multi", "content", new_content)
        frappe.db.commit()
