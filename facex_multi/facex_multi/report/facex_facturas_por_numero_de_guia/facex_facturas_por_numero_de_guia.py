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
		{"label": _("Número de Guía"), "fieldtype": "Data", "fieldname": "numero_guia", "width": 140},
		{"label": _("Sales Invoice"), "fieldtype": "Link", "fieldname": "sales_invoice", "options": "Sales Invoice", "width": 130},
		{"label": _("Cliente"), "fieldtype": "Link", "fieldname": "customer", "options": "Customer", "width": 160},
		{"label": _("Monto"), "fieldtype": "Currency", "fieldname": "grand_total", "width": 110},
		{"label": _("Fecha de Envío"), "fieldtype": "Date", "fieldname": "fecha_envio", "width": 100},
		{"label": _("Estado de Entrega"), "fieldtype": "Data", "fieldname": "estado_entrega", "width": 120},
		{"label": _("Transportista"), "fieldtype": "Link", "fieldname": "transportista", "options": "FacEx Transportista", "width": 130},
		{"label": _("Liquidado"), "fieldtype": "Check", "fieldname": "liquidado", "width": 80},
		{"label": _("Fecha de Liquidación"), "fieldtype": "Date", "fieldname": "fecha_liquidacion", "width": 120},
		{"label": _("Liquidación Asociada"), "fieldtype": "Link", "fieldname": "liquidacion", "options": "FacEx Liquidacion Transportista", "width": 160},
	]


def get_data(filters):
	companies = get_facex_companies_with_transporte_report_access(get_user_companies())
	if not companies or not filters.numero_guia:
		return []

	conditions = ["si.company in %(companies)s", "g.numero_guia like %(numero_guia)s"]
	values = {"companies": companies, "numero_guia": f"%{filters.numero_guia}%"}

	if filters.transportista:
		conditions.append("g.transportista = %(transportista)s")
		values["transportista"] = filters.transportista

	where_clause = " and ".join(conditions)

	rows = frappe.db.sql(
		f"""
		select
			g.numero_guia as numero_guia,
			g.parent as sales_invoice,
			si.customer as customer,
			si.grand_total as grand_total,
			g.fecha_envio as fecha_envio,
			g.estado_entrega as estado_entrega,
			g.transportista as transportista,
			g.liquidado as liquidado,
			g.fecha_liquidacion as fecha_liquidacion
		from `tabFacEx Guia Transportista` g
		inner join `tabSales Invoice` si on si.name = g.parent
		where g.parenttype = 'Sales Invoice' and {where_clause}
		order by g.fecha_envio desc, g.numero_guia
		""",
		values,
		as_dict=True,
	)

	if not rows:
		return []

	liquidacion_by_sales_invoice = {
		d.sales_invoice: d.parent
		for d in frappe.get_all(
			"FacEx Liquidacion Transportista Detalle",
			filters={"sales_invoice": ["in", [r.sales_invoice for r in rows]]},
			fields=["parent", "sales_invoice"],
		)
	}

	for row in rows:
		row["liquidacion"] = liquidacion_by_sales_invoice.get(row["sales_invoice"])

	return rows
