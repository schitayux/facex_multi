import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_field

def execute():
    # 1. Create custom field
    create_custom_field('User', dict(
        fieldname='bfel_company',
        label='Bfel Company',
        fieldtype='Link',
        options='Company',
        insert_after='email',
    ))
    print("Custom field 'bfel_company' created.")

    # 2. Create Server Script for Permission Query
    script_name = 'Restrict User By Bfel Company'
    script_content = '''
# Sólo aplicar si el usuario no es System Manager o Administrator
if "System Manager" not in frappe.get_roles() and frappe.session.user != "Administrator":
    current_user = frappe.get_doc("User", frappe.session.user)
    if current_user.bfel_company:
        conditions = f"bfel_company = '{current_user.bfel_company}'"
'''
    
    if not frappe.db.exists('Server Script', script_name):
        doc = frappe.get_doc({
            'doctype': 'Server Script',
            'name': script_name,
            'script_type': 'Permission Query',
            'reference_doctype': 'User',
            'script': script_content,
            'disabled': 0
        })
        doc.insert()
        print("Server Script created.")
    else:
        doc = frappe.get_doc('Server Script', script_name)
        doc.script = script_content
        doc.disabled = 0
        doc.save()
        print("Server Script updated.")
        
    frappe.db.commit()
    print("Success")
