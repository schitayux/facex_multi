"""
Patch: FacEx Pagos (pagos a proveedores).

Completa en FacEx Configuracion Compania las cuentas de pago de cada compañía
(solo las vacías): efectivo = caja por defecto, banco = cuenta bancaria por
defecto («Bancos - Cuenta General» creada 2026-09-29 para reemplazar por la
real), retenciones ISR/IVA por pagar y cargos bancarios. Los permisos de pago
quedan en 0 (denegados por defecto): el administrador los asigna.
"""
import frappe


def _account(company, name):
    return frappe.db.get_value("Account", {"company": company, "account_name": name, "is_group": 0, "disabled": 0}, "name")


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_configuracion_compania")
    for company in frappe.get_all("Company", pluck="name"):
        if not frappe.db.exists("FacEx Configuracion Compania", company):
            continue
        co = frappe.db.get_value("Company", company, ["default_cash_account", "default_bank_account"], as_dict=True)
        values = {
            "pago_cuenta_efectivo": co.default_cash_account,
            "pago_cuenta_banco": co.default_bank_account,
            "pago_cuenta_retencion_isr": _account(company, "Retención ISR por pagar"),
            "pago_cuenta_retencion_iva": _account(company, "Retención IVA por pagar"),
            "pago_cuenta_cargos_bancarios": _account(company, "Cargos bancarios"),
        }
        current = frappe.db.get_value("FacEx Configuracion Compania", company, list(values), as_dict=True)
        todo = {k: v for k, v in values.items() if v and not current.get(k)}
        if todo:
            frappe.db.set_value("FacEx Configuracion Compania", company, todo, update_modified=False)
    frappe.db.commit()
