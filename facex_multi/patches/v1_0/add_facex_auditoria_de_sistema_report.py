"""
Patch: registra el reporte "FacEx Auditoria de Sistema" (resumen por usuario
de operaciones — cantidad y monto — filtrable por rango de fechas y usuario).
"""
import frappe


def execute():
    frappe.reload_doc("facex_multi", "report", "facex_auditoria_de_sistema", force=True)
    frappe.db.commit()
