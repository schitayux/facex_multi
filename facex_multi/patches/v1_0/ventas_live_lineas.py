"""Ventas por Live — un bot por número (2026-10-27): «WhatsApp del live» en la
sesión y «WhatsApp de mis lives» en FacEx Settings."""
import frappe


def execute():
    for dt in ("facex_live_sesion", "facex_settings"):
        frappe.reload_doc("facex_multi", "doctype", dt)
