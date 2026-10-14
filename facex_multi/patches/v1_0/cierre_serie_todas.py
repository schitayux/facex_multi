# -*- coding: utf-8 -*-
"""Cierre Diario por serie: los cierres existentes son consolidados.

Antes de 2026-10-08 un cierre abarcaba todas las series del usuario; se marcan
con serie «Todas» para que el congelamiento y los pendientes los traten igual
que siempre.
"""
import frappe


def execute():
    if not frappe.db.table_exists("FacEx Cierre Diario"):
        return
    if not frappe.db.has_column("FacEx Cierre Diario", "serie"):
        return
    frappe.db.sql(
        "UPDATE `tabFacEx Cierre Diario` SET serie = 'Todas' WHERE IFNULL(serie, '') = ''"
    )
