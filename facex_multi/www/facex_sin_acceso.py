"""Aviso para usuarios sin fila de FacEx Settings (ver api/nav_guard.py):
contar con una es obligatorio para entrar a FacEx o al ERP."""
import frappe

no_cache = 1


def get_context(context):
    if frappe.session.user == "Guest":
        frappe.local.flags.redirect_location = "/login"
        raise frappe.Redirect
    context.no_breadcrumbs = True
    context.title = "Sin acceso a FacEx"
    context.user = frappe.session.user
    context.full_name = frappe.utils.get_fullname(frappe.session.user)
