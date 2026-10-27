"""Reportes de Compras (2026-10-19): permisos reporte_compras_antiguedad /
reporte_compras_periodo / reporte_compras_pagos. Nacen apagados en todos los
sitios (deny-by-default); no se conceden a ningún usuario."""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_perfil_de_permisos")
    frappe.reload_doc("facex_multi", "doctype", "facex_settings")
    from facex_multi.api.permissions import clear_permissions_cache
    clear_permissions_cache()
