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
		{"label": _("Transportista"), "fieldtype": "Link", "fieldname": "transportista", "options": "FacEx Transportista", "width": 130},
		{"label": _("Estado de Entrega"), "fieldtype": "Data", "fieldname": "estado_entrega", "width": 120},
		{"label": _("Piezas"), "fieldtype": "Int", "fieldname": "piezas", "width": 70},
		{"label": _("Fecha de Envío"), "fieldtype": "Date", "fieldname": "fecha_envio", "width": 100},
		{"label": _("Destino"), "fieldtype": "Data", "fieldname": "destino", "width": 130},
		{"label": _("Monto COD"), "fieldtype": "Currency", "fieldname": "monto_cod", "width": 110},
		{"label": _("Sales Invoice"), "fieldtype": "Link", "fieldname": "sales_invoice", "options": "Sales Invoice", "width": 130},
		{"label": _("Cliente"), "fieldtype": "Link", "fieldname": "customer", "options": "Customer", "width": 160},
		{"label": _("Compañía"), "fieldtype": "Link", "fieldname": "company", "options": "Company", "width": 140},
		{"label": _("Liquidado"), "fieldtype": "Check", "fieldname": "liquidado", "width": 80},
		{"label": _("Fecha de Liquidación"), "fieldtype": "Date", "fieldname": "fecha_liquidacion", "width": 120},
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

	if filters.estado_entrega:
		conditions.append("g.estado_entrega = %(estado_entrega)s")
		values["estado_entrega"] = filters.estado_entrega

	if filters.company:
		conditions.append("si.company = %(company)s")
		values["company"] = filters.company

	where_clause = " and ".join(conditions)

	return frappe.db.sql(
		f"""
		select
			g.numero_guia as numero_guia,
			g.transportista as transportista,
			g.estado_entrega as estado_entrega,
			g.piezas as piezas,
			g.fecha_envio as fecha_envio,
			g.destino as destino,
			g.monto_cod as monto_cod,
			g.parent as sales_invoice,
			si.customer as customer,
			si.company as company,
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
