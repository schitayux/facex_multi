"""Validar pagos automáticamente (2026-10-12): el campo nace apagado en todos
los sitios; neko.chappsa.com lo activa para la compañía Neko."""
import frappe

NEKO_SITE = "neko.chappsa.com"
COMPANY = "Neko"


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_configuracion_compania")
    if frappe.local.site != NEKO_SITE or not frappe.db.exists("FacEx Configuracion Compania", COMPANY):
        return
    frappe.db.set_value("FacEx Configuracion Compania", COMPANY, "validar_pagos_automaticamente", 1)
