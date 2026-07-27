# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from facex_multi.api.invoice import get_user_companies
from facex_multi.api.permissions import get_facex_companies_with_transporte_report_access


def execute(filters=None):
	filters = frappe._dict(filters or {})
	columns = get_columns()
	data = get_data(filters)
	return columns, data


def get_columns():
	return [
		{"label": _("Cliente"), "fieldtype": "Link", "fieldname": "customer", "options": "Customer", "width": 160},
		{"label": _("Transportista"), "fieldtype": "Link", "fieldname": "transportista", "options": "FacEx Transportista", "width": 130},
		{"label": _("Número de Guía"), "fieldtype": "Data", "fieldname": "numero_guia", "width": 140},
		{"label": _("Sales Invoice"), "fieldtype": "Link", "fieldname": "sales_invoice", "options": "Sales Invoice", "width": 130},
		{"label": _("Monto COD"), "fieldtype": "Currency", "fieldname": "monto_cod", "width": 110},
		{"label": _("Monto Liquidado"), "fieldtype": "Currency", "fieldname": "monto_liquidado", "width": 110},
		{"label": _("Valor Comisión"), "fieldtype": "Currency", "fieldname": "valor_comision", "width": 110},
		{"label": _("Estado"), "fieldtype": "Data", "fieldname": "estado_liquidacion", "width": 100},
		{"label": _("Fecha de Pago"), "fieldtype": "Date", "fieldname": "fecha_pago", "width": 100},
		{"label": _("Liquidación"), "fieldtype": "Link", "fieldname": "liquidacion", "options": "FacEx Liquidacion Transportista", "width": 160},
	]


def get_data(filters):
	companies = get_facex_companies_with_transporte_report_access(get_user_companies())
	if not companies:
		return []

	conditions = ["si.company in %(companies)s"]
	values = {"companies": companies}

	if filters.transportista:
		conditions.append("g.transportista = %(transportista)s")
		values["transportista"] = filters.transportista

	if filters.customer:
		conditions.append("si.customer = %(customer)s")
		values["customer"] = filters.customer

	if filters.estado_liquidacion == "Pendiente":
		conditions.append("g.liquidado = 0")
	elif filters.estado_liquidacion == "Liquidado":
		conditions.append("g.liquidado = 1")

	where_clause = " and ".join(conditions)

	rows = frappe.db.sql(
		f"""
		select
			si.customer as customer,
			g.transportista as transportista,
			g.numero_guia as numero_guia,
			g.parent as sales_invoice,
			g.monto_cod as monto_cod,
			d.monto_liquidado as monto_liquidado,
			d.valor_comision as valor_comision,
			g.liquidado as liquidado,
			liq.fecha as fecha_pago,
			liq.name as liquidacion
		from `tabFacEx Guia Transportista` g
		inner join `tabSales Invoice` si on si.name = g.parent
		left join `tabFacEx Liquidacion Transportista Detalle` d
			on d.sales_invoice = g.parent and d.guia = g.numero_guia
		left join `tabFacEx Liquidacion Transportista` liq on liq.name = d.parent
		where g.parenttype = 'Sales Invoice' and {where_clause}
		order by g.liquidado asc, si.customer, g.numero_guia
		""",
		values,
		as_dict=True,
	)

	for row in rows:
		row["estado_liquidacion"] = _("Liquidado") if row.pop("liquidado") else _("Pendiente")

	return rows
