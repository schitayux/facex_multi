"""
facex_multi.api.home
--------------------
KPIs de la pantalla Inicio de FacEx Clásico.

El servidor decide QUÉ tarjetas existen: cada KPI sale sólo si el usuario tiene
el mismo flag de FacEx Settings que exige su reporte equivalente, y se calcula
con el mismo ámbito (compañía + socio de ventas + usuario creador, donde
"Gerencia" ve todo y el resto sólo lo suyo). Así Inicio no puede mostrar un
agregado que el usuario no podría abrir en Reportes.
"""
from __future__ import annotations

import frappe
from frappe.utils import today

from facex_multi.api.invoice import get_effective_company
from facex_multi.api.reports import (
    _build_company_condition,
    _build_company_condition_alias,
    _resolve_owner_filter,
    _sales_partner_condition,
    has_reports_permission,
)


def _scope(company: str, alias: str = None) -> tuple:
    """Condiciones de ámbito idénticas a las de cualquier reporte de FacEx."""
    if alias:
        company_cond, company_vals = _build_company_condition_alias(company, alias)
    else:
        company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(alias)
    owner_cond, owner_vals = _resolve_owner_filter(company, None, alias)
    return (
        [company_cond, sp_cond, owner_cond],
        {**company_vals, **sp_vals, **owner_vals},
    )


def _kpi_ventas_hoy(company: str) -> dict:
    conds, values = _scope(company)
    values["today"] = today()
    row = frappe.db.sql(
        f"""
        SELECT COUNT(*) AS cnt, COALESCE(SUM(grand_total), 0) AS total
        FROM `tabSales Invoice`
        WHERE docstatus = 1 AND COALESCE(bfel_documento_anulado, 0) != 1
            AND posting_date = %(today)s AND { " AND ".join(conds) }
        """,
        values,
        as_dict=True,
    )[0]
    return {
        "key": "ventas_hoy",
        "label": "Ventas de hoy",
        "value": float(row.total or 0),
        "format": "currency",
        "sub": f"{row.cnt} factura(s)",
        "report": "sales_by_date",
        "tone": "primary",
    }


def _kpi_por_cobrar(company: str) -> dict:
    conds, values = _scope(company, "si")
    row = frappe.db.sql(
        f"""
        SELECT COUNT(*) AS cnt, COALESCE(SUM(saldo), 0) AS total FROM (
            SELECT GREATEST(si.grand_total - COALESCE((
                SELECT SUM(amount) FROM `tabeFast Invoice Payment`
                WHERE parent = si.name AND parenttype = 'Sales Invoice'
                    AND parentfield = 'custom_efast_payments'
            ), 0), 0) AS saldo
            FROM `tabSales Invoice` si
            WHERE si.docstatus = 1 AND si.is_return = 0
                AND COALESCE(si.bfel_documento_anulado, 0) != 1
                AND { " AND ".join(conds) }
        ) pendientes
        WHERE saldo > 0.009
        """,
        values,
        as_dict=True,
    )[0]
    return {
        "key": "por_cobrar",
        "label": "Por cobrar",
        "value": float(row.total or 0),
        "format": "currency",
        "sub": f"{row.cnt} factura(s) con saldo",
        "report": "aging_receivables",
        "tone": "warning",
    }


def _kpi_cotizaciones(company: str) -> dict:
    conds, values = _scope(company)
    row = frappe.db.sql(
        f"""
        SELECT COUNT(*) AS cnt, COALESCE(SUM(grand_total), 0) AS total
        FROM `tabSales Invoice`
        WHERE docstatus = 0 AND is_return = 0 AND is_debit_note = 0
            AND COALESCE(bfel_documento_anulado, 0) != 1
            AND { " AND ".join(conds) }
        """,
        values,
        as_dict=True,
    )[0]
    return {
        "key": "cotizaciones",
        "label": "Cotizaciones abiertas",
        "value": int(row.cnt or 0),
        "format": "int",
        "sub": f"Q {float(row.total or 0):,.2f} en borradores",
        "report": "quotations_report",
        "tone": "primary",
    }


def _kpi_sin_certificar(company: str) -> dict:
    conds, values = _scope(company)
    row = frappe.db.sql(
        f"""
        SELECT COUNT(*) AS cnt, COALESCE(SUM(grand_total), 0) AS total
        FROM `tabSales Invoice`
        WHERE docstatus = 1 AND bfel_status = '01 Enviar'
            AND (bfel_uuid IS NULL OR bfel_uuid = '')
            AND { " AND ".join(conds) }
        """,
        values,
        as_dict=True,
    )[0]
    return {
        "key": "sin_certificar",
        "label": "Sin certificar (FEL)",
        "value": int(row.cnt or 0),
        "format": "int",
        "sub": f"Q {float(row.total or 0):,.2f} pendiente de SAT",
        # Informativo: el informe "Errores FEL / Sin Certificar" existe en el
        # catálogo pero no tiene botón propio en Reportes, y "Facturas
        # Canceladas" (de donde sale este permiso) muestra otra cosa.
        "report": None,
        "tone": "danger" if int(row.cnt or 0) else "success",
    }


def _kpi_pagos_hoy(company: str) -> dict:
    # El filtro de usuario creador va sobre la línea de pago (ip), no sobre la
    # factura: mismo criterio que el reporte de Recibos y Pagos.
    company_cond, company_vals = _build_company_condition_alias(company, "p")
    sp_cond, sp_vals = _sales_partner_condition("p")
    owner_cond, owner_vals = _resolve_owner_filter(company, None, "ip")
    values = {"today": today(), **company_vals, **sp_vals, **owner_vals}
    row = frappe.db.sql(
        f"""
        SELECT COUNT(*) AS cnt, COALESCE(SUM(ip.amount), 0) AS total
        FROM `tabeFast Invoice Payment` ip
        JOIN `tabSales Invoice` p ON ip.parent = p.name
            AND ip.parenttype = 'Sales Invoice'
            AND ip.parentfield = 'custom_efast_payments'
        WHERE p.docstatus = 1 AND COALESCE(p.bfel_documento_anulado, 0) != 1
            AND ip.payment_date = %(today)s
            AND {company_cond} AND {sp_cond} AND {owner_cond}
        """,
        values,
        as_dict=True,
    )[0]
    return {
        "key": "pagos_hoy",
        "label": "Cobrado hoy",
        "value": float(row.total or 0),
        "format": "currency",
        "sub": f"{row.cnt} pago(s) aplicado(s)",
        "report": "payments_report",
        "tone": "success",
    }


# Cada KPI declara el flag de FacEx Settings que lo habilita — el mismo que
# _require_report exige en su reporte equivalente.
_KPI_BUILDERS = (
    ("reporte_ventas_fecha", _kpi_ventas_hoy),
    ("reporte_recibos_pagos", _kpi_pagos_hoy),
    ("reporte_antiguedad_saldos", _kpi_por_cobrar),
    ("reporte_cotizaciones", _kpi_cotizaciones),
    ("reporte_facturas_canceladas", _kpi_sin_certificar),
)


@frappe.whitelist()
def get_home_kpis(company: str = None) -> dict:
    """Devuelve sólo los KPIs que este usuario puede ver. Lista vacía si no
    tiene acceso a reportes: Inicio simplemente no muestra tarjetas."""
    if not has_reports_permission():
        return {"kpis": []}

    from facex_multi.api.permissions import get_facex_permissions_for_company

    perms = get_facex_permissions_for_company(get_effective_company(company))
    return {"kpis": [build(company) for flag, build in _KPI_BUILDERS if perms.get(flag)]}
