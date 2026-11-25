"""Multimoneda fase 2 (2026-11-25): cuentas de cobro por moneda en FacEx
Configuracion Compania y moneda / monto recibido / tipo de cambio / comprobante
en las filas de pago (eFast Invoice Payment). No configura cuentas."""
import frappe


def execute():
    for dt in ("facex_cuenta_pago_moneda", "facex_configuracion_compania", "efast_invoice_payment"):
        frappe.reload_doc("facex_multi", "doctype", dt)
