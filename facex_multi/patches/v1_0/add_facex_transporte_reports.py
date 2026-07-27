import frappe


def execute():
    for report in [
        "facex_guias_por_estado_de_entrega",
        "facex_facturas_por_numero_de_guia",
        "facex_control_de_liquidaciones",
    ]:
        frappe.reload_doc("facex_multi", "report", report, force=True)
    frappe.db.commit()
