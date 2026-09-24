# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe import _

from facex_multi.api.reports import _build_company_condition, _build_company_condition_alias, _resolve_owner_filter


def execute(filters=None):
	filters = frappe._dict(filters or {})
	if not filters.from_date or not filters.to_date:
		frappe.throw(_("Indique el rango de fechas (Desde / Hasta)."))
	columns = get_columns()
	data = get_data(filters)
	return columns, data


def _owners_condition(filters, alias: str = ""):
	"""Igual criterio que reports._resolve_owner_filter con audit=True (Alcance
	en Ventas «Toda la compañía»: libre; cualquier otro: propias operaciones) —
	compartido entre esta pantalla (Script Report) y el panel de Reportes de
	FacEx Clásico (reports.get_system_audit), que reutiliza get_data()."""
	cond, vals = _resolve_owner_filter(filters.get("company"), filters.get("owners"), alias or None, audit=True)
	if cond == "1=1":
		return "", {}
	return cond, vals


def get_columns():
	return [
		{"label": _("Usuario"), "fieldtype": "Link", "fieldname": "usuario", "options": "User", "width": 180},
		{"label": _("Nombre"), "fieldtype": "Data", "fieldname": "usuario_nombre", "width": 160},
		{"label": _("Cotizaciones (cant.)"), "fieldtype": "Int", "fieldname": "cotizaciones_count", "width": 110},
		{"label": _("Cotizaciones (monto)"), "fieldtype": "Currency", "fieldname": "cotizaciones_monto", "width": 130},
		{"label": _("Facturas No Enviar (cant.)"), "fieldtype": "Int", "fieldname": "facturas_no_enviar_count", "width": 130},
		{"label": _("Facturas No Enviar (monto)"), "fieldtype": "Currency", "fieldname": "facturas_no_enviar_monto", "width": 150},
		{"label": _("Facturas Enviar (cant.)"), "fieldtype": "Int", "fieldname": "facturas_enviar_count", "width": 120},
		{"label": _("Facturas Enviar (monto)"), "fieldtype": "Currency", "fieldname": "facturas_enviar_monto", "width": 140},
		{"label": _("Pagos Aplicados (cant.)"), "fieldtype": "Int", "fieldname": "pagos_count", "width": 120},
		{"label": _("Pagos Aplicados (monto)"), "fieldtype": "Currency", "fieldname": "pagos_monto", "width": 140},
		{"label": _("Guías Pend. de Liquidar (cant.)"), "fieldtype": "Int", "fieldname": "guias_pendientes_count", "width": 150},
		{"label": _("Guías Pend. de Liquidar (monto)"), "fieldtype": "Currency", "fieldname": "guias_pendientes_monto", "width": 160},
		{"label": _("Total Operaciones"), "fieldtype": "Int", "fieldname": "total_operaciones", "width": 120},
	]


def get_data(filters):
	company_cond, company_vals = _build_company_condition(filters.get("company"))
	owners_cond, owners_vals = _owners_condition(filters)

	users = {}

	def _bump(owner, count_key, amount_key, count, amount):
		if not owner:
			return
		row = users.setdefault(owner, {})
		row[count_key] = row.get(count_key, 0) + int(count or 0)
		row[amount_key] = row.get(amount_key, 0.0) + float(amount or 0)

	# 1. Cotizaciones: Sales Invoice en borrador (docstatus = 0).
	conditions = [
		"docstatus = 0", "is_return = 0", "is_debit_note = 0",
		"COALESCE(bfel_documento_anulado, 0) != 1",
		"posting_date BETWEEN %(from_date)s AND %(to_date)s",
		company_cond,
	]
	values = {"from_date": filters.from_date, "to_date": filters.to_date, **company_vals}
	if owners_cond:
		conditions.append(owners_cond)
		values.update(owners_vals)
	rows = frappe.db.sql(
		f"""
		SELECT owner, COUNT(*) AS cnt, COALESCE(SUM(grand_total), 0) AS total
		FROM `tabSales Invoice`
		WHERE {" AND ".join(conditions)}
		GROUP BY owner
		""",
		values, as_dict=True,
	)
	for r in rows:
		_bump(r.owner, "cotizaciones_count", "cotizaciones_monto", r.cnt, r.total)

	# 2 y 3. Facturas validadas (docstatus = 1), por bfel_status.
	for status, count_key, amount_key in (
		("00 No enviar", "facturas_no_enviar_count", "facturas_no_enviar_monto"),
		("01 Enviar", "facturas_enviar_count", "facturas_enviar_monto"),
	):
		conditions = [
			"docstatus = 1", "bfel_status = %(status)s",
			"COALESCE(bfel_documento_anulado, 0) != 1",
			"posting_date BETWEEN %(from_date)s AND %(to_date)s",
			company_cond,
		]
		values = {
			"status": status, "from_date": filters.from_date, "to_date": filters.to_date,
			**company_vals,
		}
		if owners_cond:
			conditions.append(owners_cond)
			values.update(owners_vals)
		rows = frappe.db.sql(
			f"""
			SELECT owner, COUNT(*) AS cnt, COALESCE(SUM(grand_total), 0) AS total
			FROM `tabSales Invoice`
			WHERE {" AND ".join(conditions)}
			GROUP BY owner
			""",
			values, as_dict=True,
		)
		for r in rows:
			_bump(r.owner, count_key, amount_key, r.cnt, r.total)

	# 4. Pagos Aplicados: eFast Invoice Payment (owner de la fila del pago).
	company_cond_p, company_vals_p = _build_company_condition_alias(filters.get("company"), "p")
	owners_cond_p, owners_vals_p = _owners_condition(filters, "ip")
	conditions = [
		"p.docstatus = 1", "COALESCE(p.bfel_documento_anulado, 0) != 1",
		"ip.payment_date BETWEEN %(from_date)s AND %(to_date)s",
		company_cond_p,
	]
	values = {"from_date": filters.from_date, "to_date": filters.to_date, **company_vals_p}
	if owners_cond_p:
		conditions.append(owners_cond_p)
		values.update(owners_vals_p)
	rows = frappe.db.sql(
		f"""
		SELECT ip.owner AS owner, COUNT(*) AS cnt, COALESCE(SUM(ip.amount), 0) AS total
		FROM `tabeFast Invoice Payment` ip
		JOIN `tabSales Invoice` p
			ON ip.parent = p.name AND ip.parenttype = 'Sales Invoice' AND ip.parentfield = 'custom_efast_payments'
		WHERE {" AND ".join(conditions)}
		GROUP BY ip.owner
		""",
		values, as_dict=True,
	)
	for r in rows:
		_bump(r.owner, "pagos_count", "pagos_monto", r.cnt, r.total)

	# 5. Guías Pendientes de Liquidar: FacEx Guia Transportista (owner de la
	# fila de la guía). Misma fórmula de remanente que get_transporte_kpis.
	company_cond_si, company_vals_si = _build_company_condition_alias(filters.get("company"), "si")
	owners_cond_g, owners_vals_g = _owners_condition(filters, "pend")
	conditions = [
		"si.docstatus = 1",
		"pend.fecha_envio BETWEEN %(from_date)s AND %(to_date)s",
		company_cond_si,
	]
	values = {"from_date": filters.from_date, "to_date": filters.to_date, **company_vals_si}
	if owners_cond_g:
		conditions.append(owners_cond_g)
		values.update(owners_vals_g)
	rows = frappe.db.sql(
		f"""
		SELECT pend.owner AS owner,
			SUM(CASE WHEN pend.pendiente > 0.005 THEN 1 ELSE 0 END) AS cnt,
			COALESCE(SUM(pend.pendiente), 0) AS total
		FROM (
			SELECT g.owner AS owner, g.parent AS parent, g.fecha_envio AS fecha_envio,
				CASE WHEN g.liquidado = 0 THEN g.monto_cod ELSE COALESCE(g.monto_pendiente, 0) END AS pendiente
			FROM `tabFacEx Guia Transportista` g
			WHERE g.parenttype = 'Sales Invoice' AND g.estado_entrega != 'Anulado'
		) pend
		INNER JOIN `tabSales Invoice` si ON si.name = pend.parent
		WHERE {" AND ".join(conditions)}
		GROUP BY pend.owner
		""",
		values, as_dict=True,
	)
	for r in rows:
		_bump(r.owner, "guias_pendientes_count", "guias_pendientes_monto", r.cnt, r.total)

	if not users:
		return []

	names = frappe.get_all("User", filters={"name": ["in", list(users.keys())]}, fields=["name", "full_name"])
	full_names = {n.name: n.full_name for n in names}

	count_keys = [
		"cotizaciones_count", "facturas_no_enviar_count", "facturas_enviar_count",
		"pagos_count", "guias_pendientes_count",
	]
	result = []
	for owner, row in users.items():
		row["usuario"] = owner
		row["usuario_nombre"] = full_names.get(owner) or owner
		row["total_operaciones"] = sum(row.get(k, 0) for k in count_keys)
		result.append(row)

	result.sort(key=lambda r: r["total_operaciones"], reverse=True)
	return result
