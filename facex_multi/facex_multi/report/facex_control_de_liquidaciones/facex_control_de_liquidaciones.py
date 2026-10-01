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
		# Cierre de la pasarela: lo que el cliente pagó de más por el servicio de
		# entrega (cargo cobrado) contra lo que el transportista retuvo de verdad
		# (valor comisión). La diferencia es ganancia o pérdida de la pasarela.
		{"label": _("Recargo Cobrado"), "fieldtype": "Currency", "fieldname": "recargo_cobrado", "width": 110},
		{"label": _("Valor Comisión"), "fieldtype": "Currency", "fieldname": "valor_comision", "width": 110},
		{"label": _("Diferencia"), "fieldtype": "Currency", "fieldname": "diferencia_comision", "width": 110},
		{"label": _("Flete Cobrado"), "fieldtype": "Currency", "fieldname": "flete_cobrado", "width": 110},
		{"label": _("Resultado"), "fieldtype": "Data", "fieldname": "resultado_comision", "width": 90},
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

	from facex_multi.api.permissions import get_facex_invoice_partner_sql
	sp_cond, sp_params = get_facex_invoice_partner_sql(alias="si")
	if sp_cond:
		conditions.append(sp_cond)
		values.update(sp_params)

	# Alcance en Ventas del perfil (Solo lo creado por mí / Clientes donde soy vendedor).
	from facex_multi.api.permissions import get_facex_companies_sales_scope_sql
	sc_cond, sc_params = get_facex_companies_sales_scope_sql(companies, "si")
	if sc_cond:
		conditions.append(sc_cond)
		values.update(sc_params)

	# Corte por inicio de operación, por compañía (ver api.corte).
	from facex_multi.api.corte import invoice_corte_companies_sql
	co_cond, co_params = invoice_corte_companies_sql(companies, "si")
	if co_cond:
		conditions.append(co_cond)
		values.update(co_params)

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

	owners = filters.get("owners")
	if isinstance(owners, str):
		owners = frappe.parse_json(owners) if owners else []
	if owners:
		conditions.append("g.owner in %(owners)s")
		values["owners"] = tuple(owners)

	if filters.resultado_comision:
		conditions.append("d.resultado_comision = %(resultado_comision)s")
		values["resultado_comision"] = filters.resultado_comision

	where_clause = " and ".join(conditions)

	# El recargo cobrado (estimación de la comisión) y el flete se leen de la
	# fila de la liquidación, que es donde `calcular_diferencia_comision` los
	# dejó cruzados contra la factura conciliada. Ver facex_multi.api.recargo.
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
			d.recargo_cobrado as recargo_cobrado,
			d.flete_cobrado as flete_cobrado,
			d.diferencia_comision as diferencia_comision,
			d.resultado_comision as resultado_comision,
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
