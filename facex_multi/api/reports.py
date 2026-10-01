"""
facex_multi.api.reports
----------------------
Módulo de reportes y análisis para FacEx.
Consultas seguras parametrizadas aisladas a Sales Invoice y eFast Invoice Payment con soporte multi-compañía.
"""
from __future__ import annotations

import frappe
from frappe.utils import today, getdate, add_days, flt
import datetime
from facex_multi.api.invoice import get_effective_company


def _build_company_condition(company: str) -> tuple:
    """
    Retorna (condicion_sql, valores_dict) para filtrar por compañía.
    - Si company está especificada: filtra por esa compañía exacta.
    - Si company está vacía ("Todas"): filtra por TODAS las compañías
      que el usuario tiene asignadas en User Permission.
    """
    company = (company or "").strip()

    if company:
        return "company = %(company)s", {"company": company}

    # "Todas": obtener compañías permitidas del usuario
    user_cos = frappe.get_all(
        "User Permission",
        filters={"user": frappe.session.user, "allow": "Company"},
        pluck="for_value"
    )

    if not user_cos:
        # Sin restricciones de User Permission → usar compañía efectiva por defecto
        eff = get_effective_company()
        if eff:
            return "company = %(company)s", {"company": eff}
        # System Manager sin default: sin restricción de compañía (todos los datos)
        return "1=1", {}

    if len(user_cos) == 1:
        return "company = %(company)s", {"company": user_cos[0]}

    return "company IN %(companies)s", {"companies": tuple(user_cos)}


def _build_company_condition_alias(company: str, alias: str = "p") -> tuple:
    """Igual que _build_company_condition pero para consultas con alias de tabla."""
    cond, vals = _build_company_condition(company)
    if "company = " in cond:
        cond = cond.replace("company = ", f"{alias}.company = ")
    elif "company IN " in cond:
        cond = cond.replace("company IN ", f"{alias}.company IN ")
    return cond, vals


def _corte_condition(company: str = None, alias: str = None,
                     param_prefix: str = "facex_corte") -> tuple:
    """Corte por «Fecha de inicio de operación» para una consulta de Sales
    Invoice: ("1=1", {}) si la compañía no tiene corte configurado o el usuario
    está exento. Va en TODAS las consultas de este módulo porque son SQL crudo
    y no pasan por los hooks de permisos (ver facex_multi.api.corte)."""
    from facex_multi.api.corte import invoice_corte_sql

    cond, params = invoice_corte_sql(get_effective_company(company), alias=alias,
                                     param_prefix=param_prefix)
    return (cond or "1=1"), params


def _sales_partner_condition(alias: str = None, company: str = None) -> tuple:
    """Condición por cliente según el Alcance en Ventas del usuario.

    Con «Clientes donde soy vendedor»: facturas de los clientes cuyo Vendedor
    (Customer.default_sales_partner) es el Socio de Venta del usuario, más lo
    que él mismo facturó (p. ej. a Consumidor Final). Sin Socio configurado,
    solo lo propio. Los otros alcances no filtran por cliente ("1=1") — el
    Socio de Venta por Defecto ya no recorta los reportes; eso lo decide el
    alcance.
    """
    from facex_multi.api.permissions import (
        SCOPE_CUSTOMERS, get_facex_sales_scope, get_facex_user_sales_partner,
    )
    eff_company = get_effective_company(company)
    if get_facex_sales_scope(eff_company) != SCOPE_CUSTOMERS:
        return "1=1", {}
    prefix = f"{alias}." if alias else ""
    me_cond = f"{prefix}owner = %(facex_me)s"
    sp = get_facex_user_sales_partner(eff_company)
    if not sp:
        return me_cond, {"facex_me": frappe.session.user}
    return (
        f"({me_cond} OR {prefix}customer IN "
        f"(SELECT c.name FROM `tabCustomer` c WHERE c.default_sales_partner = %(facex_sp)s))",
        {"facex_me": frappe.session.user, "facex_sp": sp},
    )


def _owner_condition(owners, alias: str = None) -> tuple:
    """Retorna (condicion_sql, valores_dict) para acotar un informe a una
    selección múltiple de usuarios creadores. ("1=1", {}) sin filtro (todos)."""
    if isinstance(owners, str):
        owners = frappe.parse_json(owners) if owners else []
    owners = [o for o in (owners or []) if o]
    if not owners:
        return "1=1", {}
    col = f"{alias}.owner" if alias else "owner"
    return f"{col} IN %(owners)s", {"owners": tuple(owners)}


def _resolve_owner_filter(company: str, owners, alias: str = None,
                          customer_level: bool = False, audit: bool = False) -> tuple:
    """Filtro "Usuario Creador" según el Alcance en Ventas del usuario
    (FacEx Settings / Perfil > alcance_ventas):
    - Toda la compañía: el filtro del frontend manda (vacío = todos).
    - Clientes donde soy vendedor: aquí no filtra (lo hace
      _sales_partner_condition por cliente); en Auditoría (`audit`) = propio.
    - Solo lo creado por mí: forzado a sus propias operaciones, también en
      Estados de Cuenta y Antigüedad de Saldos (`customer_level`): el saldo
      es el de SUS facturas. Antes se mostraba el saldo completo de los
      clientes a los que facturó, lo que exponía facturas de otros usuarios
      (p. ej. todo Consumidor Final).
    """
    from facex_multi.api.permissions import (
        SCOPE_ALL, SCOPE_CUSTOMERS, get_facex_sales_scope,
    )
    scope = get_facex_sales_scope(get_effective_company(company))
    if scope == SCOPE_ALL:
        return _owner_condition(owners, alias)
    if scope == SCOPE_CUSTOMERS and not audit:
        return "1=1", {}
    return _owner_condition([frappe.session.user], alias)


@frappe.whitelist()
def user_query_for_reports(doctype=None, txt="", searchfield=None, start=0, page_length=20, filters=None):
    """Query override para el filtro "Usuario Creador" (selección múltiple) de
    todos los reportes de FacEx: usuarios habilitados, excluye System Manager
    (mismo criterio que el módulo Seguridad — ver
    facex_multi.api.security._system_manager_users — un System Manager no
    aporta nada útil como filtro porque ya tiene acceso total en todo)."""
    from facex_multi.api.security import _system_manager_users

    return frappe.db.sql(
        """
        SELECT name, full_name
        FROM `tabUser`
        WHERE enabled = 1 AND user_type = 'System User'
            AND name NOT IN %(system_managers)s
            AND (name LIKE %(txt)s OR full_name LIKE %(txt)s)
        ORDER BY full_name ASC
        LIMIT %(page_length)s OFFSET %(start)s
        """,
        {
            "system_managers": _system_manager_users(),
            "txt": f"%{txt}%",
            "start": start,
            "page_length": page_length,
        },
    )


_REPORT_FLAGS = (
    "reporte_ventas_fecha", "reporte_ventas_producto", "reporte_facturas_canceladas",
    "reporte_estados_cuenta", "reporte_antiguedad_saldos", "reporte_cotizaciones",
    "reporte_recibos_pagos", "reporte_crecimiento_ventas", "reporte_imprimir_recibo",
    "reporte_analisis_utilidad", "reporte_auditoria_sistema", "reporte_ventas_vendedor",
)


def _has_facex_settings_row(company: str) -> bool:
    return bool(frappe.db.exists(
        "FacEx Settings", {"user": frappe.session.user, "bfel_company": company}
    ))


@frappe.whitelist()
def has_reports_permission(company: str = None) -> bool:
    """Puerta general de Reportes FacEx.

    Si el usuario tiene fila en FacEx Settings para la compañía, mandan sus
    checks reporte_*: basta con uno marcado (antes además se exigía un rol de
    ERPNext y un usuario con «Estados de Cuenta» marcado seguía bloqueado).
    Sin fila (usuarios anteriores a FacEx Settings) se conserva el criterio por
    rol. System Manager siempre entra.
    """
    roles = set(frappe.get_roles())
    if "System Manager" in roles:
        return True
    company = get_effective_company(company)
    if company and _has_facex_settings_row(company):
        from facex_multi.api.permissions import get_facex_permissions_for_company
        perms = get_facex_permissions_for_company(company)
        return any(perms.get(f) for f in _REPORT_FLAGS)
    allowed = {"Accounts Manager", "Sales Manager", "facex_multi"}
    return bool(allowed & roles)


def check_permission(company: str = None):
    """Valida que el usuario tenga permisos, de lo contrario lanza excepción de permisos."""
    if not has_reports_permission(company):
        frappe.throw("No tiene permisos suficientes para acceder a este reporte.", frappe.PermissionError)


def _require_report(company: str, flag: str) -> None:
    """Puerta general (has_reports_permission) + el check del informe concreto
    en FacEx Settings. Sin fila de FacEx Settings o System Manager,
    get_facex_permissions_for_company devuelve acceso total y sólo manda el rol.
    """
    check_permission(company)
    from facex_multi.api.permissions import get_facex_permissions_for_company
    perms = get_facex_permissions_for_company(get_effective_company(company))
    if not perms.get(flag):
        frappe.throw("No tiene permiso para ver este informe.", frappe.PermissionError)


def _resolve_warehouse_filter(company: str, warehouse):
    """
    Acota el filtro de bodega a las bodegas habilitadas del usuario (FacEx
    Settings > bodegas_habilitadas). `warehouse` acepta selección múltiple
    (lista, o JSON de lista como llega del filtro MultiSelectList del
    frontend) o un solo código (retrocompatible). Retorna (mode, value):
    - ("in", tuple_de_bodegas): una o más bodegas explícitas (intersectadas
      con lo permitido) o, sin selección explícita, la lista completa de
      bodegas permitidas del usuario.
    - (None, None): sin filtro que aplicar (sin restricción, o compañía
      vacía/"Todas" — las listas permitidas son por compañía y no combinan
      entre varias, así que en ese caso se deja sin acotar).
    """
    company = (company or "").strip()
    if isinstance(warehouse, str):
        warehouse = frappe.parse_json(warehouse) if warehouse.startswith("[") else ([warehouse] if warehouse else [])
    warehouse = [w for w in (warehouse or []) if w]

    if not company:
        return None, None

    from facex_multi.api.permissions import (
        get_facex_allowed_warehouses, get_facex_can_see_all_report_warehouses,
    )
    if get_facex_can_see_all_report_warehouses(company):
        # «Ver todas las bodegas en reportes» (o System Manager): cualquier
        # almacén de la compañía en los reportes de FacEx Clásico.
        allowed = None
    else:
        allowed = get_facex_allowed_warehouses(company)

    if warehouse:
        if allowed is not None:
            invalid = [w for w in warehouse if w not in allowed]
            if invalid:
                frappe.throw(
                    f"No tiene permiso para ver la bodega '{invalid[0]}' en este informe.",
                    frappe.PermissionError,
                )
        return "in", tuple(warehouse)

    if allowed is not None:
        return "in", (tuple(allowed) or ("",))

    return None, None


# ---------------------------------------------------------------------------
# 1. Informe de Ventas por Fecha
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_sales_by_date(start_date: str, end_date: str, customer: str = None, warehouse=None,
                       owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_ventas_fecha")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    corte_cond, corte_vals = _corte_condition(company)
    conditions = ["docstatus = 1", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, sp_cond, owner_cond, corte_cond]
    values = {"start": start_date, "end": end_date, **company_vals, **sp_vals, **owner_vals, **corte_vals}

    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer

    wh_mode, wh_val = _resolve_warehouse_filter(company, warehouse)
    if wh_mode == "in":
        conditions.append("name IN (SELECT parent FROM `tabSales Invoice Item` WHERE warehouse IN %(allowed_warehouses)s)")
        values["allowed_warehouses"] = wh_val

    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento

    # outstanding_amount NO sirve aquí: FacEx registra los pagos como Payment
    # Entry en BORRADOR (ver invoice.save_payments) y ese campo de ERPNext solo
    # se actualiza cuando el PE se valida/concilia, así que una factura pagada
    # por FacEx pero con PE en borrador seguía apareciendo "Pendiente" por su
    # total completo. Se recalcula el saldo real desde custom_efast_payments,
    # igual que ya hacen Estados de Cuenta y Antigüedad de Saldos.
    #
    # `cargos_pasarela` / `venta_neta`: el recargo y el flete en modo pasarela no
    # son venta de la empresa (ver facex_multi.api.recargo). El SALDO se sigue
    # calculando sobre el total completo, que es lo que el cliente debe.
    from facex_multi.api.recargo import pasarela_sql, total_cobrable_sql, venta_neta_sql
    pas = pasarela_sql("tabSales Invoice")
    neta = venta_neta_sql("tabSales Invoice")
    cobrable = total_cobrable_sql("tabSales Invoice")
    query = f"""
        SELECT name, posting_date, customer, customer_name, total, total_taxes_and_charges, grand_total,
            {pas} AS cargos_pasarela,
            {neta} AS venta_neta,
            {cobrable} AS total_cobrable,
            GREATEST(grand_total - COALESCE((
                SELECT SUM(amount)
                FROM `tabeFast Invoice Payment`
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0), 0) AS outstanding_amount
        FROM `tabSales Invoice`
        WHERE posting_date BETWEEN %(start)s AND %(end)s AND { " AND ".join(conditions) }
        ORDER BY posting_date DESC, name DESC
    """

    invoices = frappe.db.sql(query, values, as_dict=True)

    # Calcular agregados
    total_sales = sum(float(inv.venta_neta or 0) for inv in invoices)
    total_pasarela = sum(float(inv.cargos_pasarela or 0) for inv in invoices)
    # Lo que el cliente paga es el total redondeado, no `grand_total` (mismo
    # criterio que el Cierre Diario): si se mezclan, los totales no cuadran por
    # los centavos del redondeo.
    total_cobrado_cliente = sum(float(inv.total_cobrable or 0) for inv in invoices)
    # `total_taxes_and_charges` de ERPNext incluye las filas de cargos FacEx, así
    # que el impuesto real es ese total menos los cargos pasarela.
    total_tax = sum(float(inv.total_taxes_and_charges or 0) for inv in invoices) - total_pasarela
    avg_sale = total_sales / len(invoices) if invoices else 0.0

    return {
        "invoices": invoices,
        "summary": {
            "total_sales": total_sales,
            "total_pasarela": total_pasarela,
            "total_cobrado_cliente": total_cobrado_cliente,
            "total_tax": total_tax,
            "avg_sale": avg_sale,
            "count": len(invoices)
        }
    }


# ---------------------------------------------------------------------------
# 2. Informe de Ventas por Producto con Filtros
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_sales_by_product(start_date: str, end_date: str, item_code: str = None,
                         item_group: str = None, customer: str = None, warehouse=None,
                         owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_ventas_producto")

    company_cond, company_vals = _build_company_condition_alias(company, "p")
    sp_cond, sp_vals = _sales_partner_condition("p", company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners, "p")
    corte_cond, corte_vals = _corte_condition(company, "p")
    conditions = ["p.docstatus = 1", "COALESCE(p.bfel_documento_anulado, 0) != 1", "p.posting_date BETWEEN %(start)s AND %(end)s", company_cond, sp_cond, owner_cond, corte_cond]
    values = {"start": start_date, "end": end_date, **company_vals, **sp_vals, **owner_vals, **corte_vals}

    if item_code:
        conditions.append("i.item_code = %(item_code)s")
        values["item_code"] = item_code
        
    if item_group:
        conditions.append("i.item_group = %(item_group)s")
        values["item_group"] = item_group
        
    if customer:
        conditions.append("p.customer = %(customer)s")
        values["customer"] = customer
        
    wh_mode, wh_val = _resolve_warehouse_filter(company, warehouse)
    if wh_mode == "in":
        conditions.append("i.warehouse IN %(allowed_warehouses)s")
        values["allowed_warehouses"] = wh_val

    if establecimiento:
        conditions.append("p.bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT i.item_code, i.item_name, SUM(i.qty) AS total_qty, AVG(i.rate) AS avg_rate, SUM(i.amount) AS total_amount
        FROM `tabSales Invoice Item` i
        JOIN `tabSales Invoice` p ON i.parent = p.name AND i.parenttype = 'Sales Invoice' AND i.parentfield = 'items'
        WHERE { " AND ".join(conditions) }
        GROUP BY i.item_code, i.item_name
        ORDER BY total_amount DESC
    """
    
    products = frappe.db.sql(query, values, as_dict=True)
    
    total_qty = sum(float(p.total_qty or 0) for p in products)
    total_amount = sum(float(p.total_amount or 0) for p in products)
    
    return {
        "products": products,
        "summary": {
            "total_qty": total_qty,
            "total_amount": total_amount,
            "count": len(products)
        }
    }


# ---------------------------------------------------------------------------
# 3. Facturas Canceladas
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_cancelled_invoices(start_date: str, end_date: str, customer: str = None, owners=None,
                           company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_facturas_canceladas")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    corte_cond, corte_vals = _corte_condition(company)
    conditions = ["(docstatus = 2 OR COALESCE(bfel_documento_anulado, 0) = 1)", "posting_date BETWEEN %(start)s AND %(end)s", company_cond, sp_cond, owner_cond, corte_cond]
    values = {"start": start_date, "end": end_date, **company_vals, **sp_vals, **owner_vals, **corte_vals}
    
    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer
        
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT name, posting_date, customer, customer_name, grand_total, modified_by, modified, bfel_documento_anulado
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY posting_date DESC, name DESC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    total_amount = sum(float(inv.grand_total or 0) for inv in invoices)
    
    return {
        "invoices": invoices,
        "summary": {
            "total_amount": total_amount,
            "count": len(invoices)
        }
    }


# ---------------------------------------------------------------------------
# 4. Estado de Cuenta de Clientes (Aislado a pagos FacEx de Sales Invoice)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_customer_statement(customer: str, start_date: str = None, end_date: str = None, doc_type_filter: str = None,
                            owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_estados_cuenta")
    if not customer:
        return {"ledger": [], "summary": {}}

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners, customer_level=True)
    corte_cond, corte_vals = _corte_condition(company)
    values = {"customer": customer, **company_vals, **sp_vals, **owner_vals, **corte_vals}
    conditions = ["customer = %(customer)s", "docstatus = 1", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, sp_cond, owner_cond, corte_cond]
    
    if start_date and end_date:
        conditions.append("posting_date BETWEEN %(start)s AND %(end)s")
        values["start"] = start_date
        values["end"] = end_date
        
    if doc_type_filter:
        if doc_type_filter == "Facturas":
            conditions.append("is_return = 0")
        elif doc_type_filter == "Notas de Crédito":
            conditions.append("is_return = 1")
        elif doc_type_filter == "Notas de Débito":
            conditions.append("is_debit_note = 1")
            
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT 
            name, 
            posting_date, 
            due_date,
            bfel_docto_serie,
            bfel_docto_no,
            grand_total,
            is_return,
            is_debit_note,
            COALESCE((
                SELECT SUM(amount) 
                FROM `tabeFast Invoice Payment` 
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0) AS total_paid
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY posting_date ASC, creation ASC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    
    # Construir historial/libro mayor detallado
    ledger = []
    running_balance = 0.0
    total_invoiced = 0.0
    total_paid = 0.0
    
    for inv in invoices:
        inv_total = float(inv.grand_total or 0.0)
        inv_paid = float(inv.total_paid or 0.0)
        inv_balance = max(0.0, inv_total - inv_paid)
        
        total_invoiced += inv_total
        total_paid += inv_paid
        running_balance += inv_balance
        
        status = "Liquidado" if inv_balance <= 0.009 else "Pendiente"
        
        doc_type_desc = "Factura"
        if inv.is_return == 1:
            doc_type_desc = "Nota de Crédito"
        elif inv.is_debit_note == 1:
            doc_type_desc = "Nota de Débito"
            
        ledger.append({
            "name": inv.name,
            "posting_date": str(inv.posting_date),
            "due_date": str(inv.due_date) if inv.due_date else "",
            "serie_no": f"{inv.bfel_docto_serie or ''} - {inv.bfel_docto_no or ''}" if (inv.bfel_docto_serie or inv.bfel_docto_no) else "",
            "grand_total": inv_total,
            "paid_amount": inv_paid,
            "balance": inv_balance,
            "status": status,
            "doc_type_desc": doc_type_desc
        })
        
    # Obtener límite de crédito del cliente
    credit_limit = 0.0
    cust_limits = frappe.db.get_value("Customer Credit Limit", {"parent": customer}, "credit_limit")
    if cust_limits:
        credit_limit = float(cust_limits)
        
    return {
        "ledger": ledger,
        "summary": {
            "customer_name": frappe.db.get_value("Customer", customer, "customer_name") or customer,
            "total_invoiced": total_invoiced,
            "total_paid": total_paid,
            "outstanding_balance": running_balance,
            "credit_limit": credit_limit
        }
    }


# ---------------------------------------------------------------------------
# 5. Antigüedad de Saldos (Aging)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_aging_receivables(customer: str = None, owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_antiguedad_saldos")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners, customer_level=True)
    corte_cond, corte_vals = _corte_condition(company)
    conditions = ["docstatus = 1", "is_return = 0", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, sp_cond, owner_cond, corte_cond]
    values = {**company_vals, **sp_vals, **owner_vals, **corte_vals}
    
    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer
        
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT 
            name,
            customer,
            customer_name,
            posting_date,
            due_date,
            bfel_docto_serie,
            bfel_docto_no,
            grand_total,
            COALESCE((
                SELECT SUM(amount) 
                FROM `tabeFast Invoice Payment` 
                WHERE parent = `tabSales Invoice`.name AND parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
            ), 0) AS total_paid
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY customer ASC, posting_date ASC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    today_dt = getdate(today())
    
    # Procesar agrupamiento por cliente
    aging_data = {}
    
    for inv in invoices:
        paid = float(inv.total_paid or 0.0)
        outstanding = float(inv.grand_total or 0.0) - paid
        
        if outstanding <= 0.009:
            continue
            
        cust_id = inv.customer
        if cust_id not in aging_data:
            aging_data[cust_id] = {
                "customer": cust_id,
                "customer_name": inv.customer_name or cust_id,
                "total_outstanding": 0.0,
                "range_0_30": 0.0,
                "range_31_60": 0.0,
                "range_61_90": 0.0,
                "range_91_plus": 0.0,
                "invoices": []
            }
            
        # Calcular antigüedad de días con base a la fecha de vencimiento
        due_dt = getdate(inv.due_date or inv.posting_date)
        days = (today_dt - due_dt).days
        
        aging_data[cust_id]["total_outstanding"] += outstanding
        
        if days <= 30:
            aging_data[cust_id]["range_0_30"] += outstanding
            bucket = "0-30 días"
        elif days <= 60:
            aging_data[cust_id]["range_31_60"] += outstanding
            bucket = "31-60 días"
        elif days <= 90:
            aging_data[cust_id]["range_61_90"] += outstanding
            bucket = "61-90 días"
        else:
            aging_data[cust_id]["range_91_plus"] += outstanding
            bucket = "91+ días"
            
        serie_no = f"{inv.bfel_docto_serie or ''} - {inv.bfel_docto_no or ''}" if (inv.bfel_docto_serie or inv.bfel_docto_no) else ""
        
        aging_data[cust_id]["invoices"].append({
            "name": inv.name,
            "serie_no": serie_no,
            "posting_date": str(inv.posting_date),
            "due_date": str(inv.due_date) if inv.due_date else "",
            "grand_total": float(inv.grand_total or 0.0),
            "paid_amount": paid,
            "outstanding_amount": outstanding,
            "days_due": days,
            "bucket": bucket
        })
            
    aging_list = sorted(aging_data.values(), key=lambda x: x["total_outstanding"], reverse=True)
    
    # Resumen general
    total_outstanding = sum(x["total_outstanding"] for x in aging_list)
    total_0_30 = sum(x["range_0_30"] for x in aging_list)
    total_31_60 = sum(x["range_31_60"] for x in aging_list)
    total_61_90 = sum(x["range_61_90"] for x in aging_list)
    total_91_plus = sum(x["range_91_plus"] for x in aging_list)
    
    return {
        "aging": aging_list,
        "summary": {
            "total_outstanding": total_outstanding,
            "total_0_30": total_0_30,
            "total_31_60": total_31_60,
            "total_61_90": total_61_90,
            "total_91_plus": total_91_plus
        }
    }


# ---------------------------------------------------------------------------
# 6. Informe de Cotizaciones (Pre-Facturas Borradores)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_quotations_report(start_date: str = None, end_date: str = None, customer: str = None, owners=None,
                           company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_cotizaciones")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    corte_cond, corte_vals = _corte_condition(company)
    conditions = ["docstatus = 0", "is_return = 0", "is_debit_note = 0", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, sp_cond, owner_cond, corte_cond]
    values = {**company_vals, **sp_vals, **owner_vals, **corte_vals}
    
    if start_date and end_date:
        conditions.append("posting_date BETWEEN %(start)s AND %(end)s")
        values["start"] = start_date
        values["end"] = end_date
    if customer:
        conditions.append("customer = %(customer)s")
        values["customer"] = customer
        
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT name, company, posting_date, customer, customer_name, grand_total, bfel_status, creation
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY posting_date DESC, creation DESC
    """

    invoices = frappe.db.sql(query, values, as_dict=True)
    total_amount = sum(float(inv.grand_total or 0) for inv in invoices)
    
    return {
        "invoices": invoices,
        "summary": {
            "total_amount": total_amount,
            "count": len(invoices)
        }
    }


# ---------------------------------------------------------------------------
# 7. Informe de Pagos por Fecha
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_payments_report(start_date: str, end_date: str, payment_method: str = None, owners=None,
                         company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_recibos_pagos")

    company_cond, company_vals = _build_company_condition_alias(company, "p")
    sp_cond, sp_vals = _sales_partner_condition("p", company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners, "ip")
    corte_cond, corte_vals = _corte_condition(company, "p")
    conditions = ["p.docstatus = 1", "COALESCE(p.bfel_documento_anulado, 0) != 1", "ip.payment_date BETWEEN %(start)s AND %(end)s", company_cond, sp_cond, owner_cond, corte_cond]
    values = {"start": start_date, "end": end_date, **company_vals, **sp_vals, **owner_vals, **corte_vals}
    
    if payment_method:
        conditions.append("ip.payment_method = %(method)s")
        values["method"] = payment_method
        
    if establecimiento:
        conditions.append("p.bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT ip.payment_date, ip.parent AS invoice, p.company, p.customer, p.customer_name, ip.payment_method, ip.reference, ip.amount
        FROM `tabeFast Invoice Payment` ip
        JOIN `tabSales Invoice` p ON ip.parent = p.name AND ip.parenttype = 'Sales Invoice' AND ip.parentfield = 'custom_efast_payments'
        WHERE { " AND ".join(conditions) }
        ORDER BY ip.payment_date DESC, ip.creation DESC
    """
    
    payments = frappe.db.sql(query, values, as_dict=True)
    
    # Calcular totales por método de pago
    method_totals = {}
    total_received = 0.0
    
    for pay in payments:
        amount = float(pay.amount or 0.0)
        total_received += amount
        method = pay.payment_method or "Otros"
        if method not in method_totals:
            method_totals[method] = 0.0
        method_totals[method] += amount
        
    return {
        "payments": payments,
        "summary": {
            "total_received": total_received,
            "method_totals": [{"method": k, "amount": v} for k, v in method_totals.items()],
            "count": len(payments)
        }
    }


# ---------------------------------------------------------------------------
# 8. Documentos con Error sin Certificar aún
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_uncertified_invoices(owners=None, company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_facturas_canceladas")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    corte_cond, corte_vals = _corte_condition(company)
    conditions = [
        "docstatus = 1",
        company_cond,
        sp_cond,
        owner_cond,
        corte_cond,
        "bfel_status = '01 Enviar'",
        "(bfel_uuid IS NULL OR bfel_uuid = '')"
    ]
    values = {**company_vals, **sp_vals, **owner_vals, **corte_vals}
    
    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento
        
    query = f"""
        SELECT name, posting_date, customer, customer_name, grand_total, bfel_status, bfel_error_log
        FROM `tabSales Invoice`
        WHERE { " AND ".join(conditions) }
        ORDER BY posting_date DESC, name DESC
    """
    
    invoices = frappe.db.sql(query, values, as_dict=True)
    total_amount = sum(float(inv.grand_total or 0) for inv in invoices)
    
    return {
        "invoices": invoices,
        "summary": {
            "total_amount": total_amount,
            "count": len(invoices)
        }
    }


# ---------------------------------------------------------------------------
# 9. Análisis Crecimiento de Ventas (Interactivo anual)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_sales_growth_analysis(year: str = None, month: str = None, owners=None,
                               company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_crecimiento_ventas")

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, owners)
    current_year = int(year) if year else datetime.datetime.now().year
    current_month = int(month) if month else datetime.datetime.now().month

    if current_month == 1:
        prev_month = 12
        prev_year = current_year - 1
    else:
        prev_month = current_month - 1
        prev_year = current_year

    # Ventas diarias año actual/mes seleccionado
    corte_cond, corte_vals = _corte_condition(company)
    curr_conditions = ["docstatus = 1", "YEAR(posting_date) = %(year)s", "MONTH(posting_date) = %(month)s", company_cond, sp_cond, owner_cond, corte_cond, "COALESCE(bfel_documento_anulado, 0) != 1"]
    curr_values = {"year": current_year, "month": current_month, **company_vals, **sp_vals, **owner_vals, **corte_vals}

    prev_conditions = ["docstatus = 1", "YEAR(posting_date) = %(year)s", "MONTH(posting_date) = %(month)s", company_cond, sp_cond, owner_cond, corte_cond, "COALESCE(bfel_documento_anulado, 0) != 1"]
    prev_values = {"year": prev_year, "month": prev_month, **company_vals, **sp_vals, **owner_vals, **corte_vals}
    
    if establecimiento:
        curr_conditions.append("bfel_establecimiento = %(establecimiento)s")
        curr_values["establecimiento"] = establecimiento
        prev_conditions.append("bfel_establecimiento = %(establecimiento)s")
        prev_values["establecimiento"] = establecimiento
        
    # Venta neta: sin el recargo/flete en modo pasarela, que no es ingreso de la
    # empresa (ver facex_multi.api.recargo).
    from facex_multi.api.recargo import venta_neta_sql
    neta = venta_neta_sql("tabSales Invoice")

    curr_data = frappe.db.sql(f"""
        SELECT DAY(posting_date) AS day, SUM({neta}) AS total
        FROM `tabSales Invoice`
        WHERE {" AND ".join(curr_conditions)}
        GROUP BY DAY(posting_date)
    """, curr_values, as_dict=True)

    # Ventas diarias año anterior/mes anterior
    prev_data = frappe.db.sql(f"""
        SELECT DAY(posting_date) AS day, SUM({neta}) AS total
        FROM `tabSales Invoice`
        WHERE {" AND ".join(prev_conditions)}
        GROUP BY DAY(posting_date)
    """, prev_values, as_dict=True)
    
    # Mapear a vectores de días
    curr_dict = {r["day"]: float(r["total"] or 0) for r in curr_data}
    prev_dict = {r["day"]: float(r["total"] or 0) for r in prev_data}
    
    import calendar
    num_days = calendar.monthrange(current_year, current_month)[1]
    
    chart_data = []
    total_curr = 0.0
    total_prev = 0.0
    
    for d in range(1, num_days + 1):
        val_curr = curr_dict.get(d, 0.0)
        val_prev = prev_dict.get(d, 0.0)
        
        total_curr += val_curr
        total_prev += val_prev
        
        # Calcular crecimiento relativo diario
        growth = 0.0
        if val_prev > 0:
            growth = ((val_curr - val_prev) / val_prev) * 100.0
            
        chart_data.append({
            "idx": d,
            "month_name": f"Día {d}",
            "current_year": val_curr,
            "previous_year": val_prev,
            "growth": round(growth, 2)
        })
        
    overall_growth = 0.0
    if total_prev > 0:
        overall_growth = ((total_curr - total_prev) / total_prev) * 100.0
        
    months_names = [
        "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
        "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
    ]
        
    return {
        "year": current_year,
        "prev_year": prev_year,
        "month": current_month,
        "prev_month": prev_month,
        "month_name": months_names[current_month - 1],
        "prev_month_name": months_names[prev_month - 1],
        "chart_data": chart_data,
        "summary": {
            "total_current": total_curr,
            "total_previous": total_prev,
            "overall_growth": round(overall_growth, 2)
        }
    }


# ---------------------------------------------------------------------------
# 10. Auditoría de Sistema (resumen por usuario)
# ---------------------------------------------------------------------------
# Reutiliza get_data() del Script Report "FacEx Auditoria de Sistema" (misma
# consulta, ya probada) — este endpoint solo la expone dentro del panel de
# Reportes de FacEx Clásico, gateada por el flag granular de FacEx Settings
# (el Script Report en Desk solo valida roles, no este flag).

@frappe.whitelist()
def get_system_audit(start_date: str, end_date: str, owners=None, company: str = None) -> dict:
    _require_report(company, "reporte_auditoria_sistema")

    from facex_multi.facex_multi.report.facex_auditoria_de_sistema.facex_auditoria_de_sistema import get_data

    rows = get_data(frappe._dict({
        "from_date": start_date, "to_date": end_date, "owners": owners, "company": company,
    }))

    count_keys = [
        "cotizaciones_count", "facturas_no_enviar_count", "facturas_enviar_count",
        "pagos_count", "guias_pendientes_count",
    ]
    amount_keys = [
        "cotizaciones_monto", "facturas_no_enviar_monto", "facturas_enviar_monto",
        "pagos_monto", "guias_pendientes_monto",
    ]
    return {
        "rows": rows,
        "summary": {
            "user_count": len(rows),
            "total_operaciones": sum(r.get("total_operaciones", 0) for r in rows),
            "total_monto": sum(sum(r.get(k, 0) for k in amount_keys) for r in rows),
            "count": len(rows),
        },
    }


# ---------------------------------------------------------------------------
# 11. Ventas por Vendedor (Gerencia)
# ---------------------------------------------------------------------------
# Vendedor = Socio de Ventas de la FACTURA (Sales Invoice.sales_partner), no
# el del cliente. La condición (Contado / Crédito / Contra Entrega) se decide
# con la misma regla del Cierre Diario (cierre._clasificar_por_pagos) para
# que ambos cuadren. Permiso propio deny-by-default: reporte_ventas_vendedor.
# Informe de Gerencia: NO aplica el Alcance en Ventas (varios gerentes lo
# tienen en «Solo lo creado por mí» y verían solo lo suyo); el permiso mismo
# implica ver a todos los vendedores. Sigue acotado a las compañías del
# usuario y a sus bodegas (salvo «todas las bodegas en reportes»).

SIN_VENDEDOR = "(Sin vendedor)"
_CLASES = ("contado", "credito", "contra_entrega")


def _sales_by_seller_conditions(company, establecimiento, sales_partners) -> tuple:
    company_cond, company_vals = _build_company_condition(company)
    corte_cond, corte_vals = _corte_condition(company)
    conditions = ["docstatus = 1", "COALESCE(bfel_documento_anulado, 0) != 1", company_cond, corte_cond]
    values = {**company_vals, **corte_vals}

    wh_mode, wh_val = _resolve_warehouse_filter(company, None)
    if wh_mode == "in":
        conditions.append("name IN (SELECT parent FROM `tabSales Invoice Item` WHERE warehouse IN %(allowed_warehouses)s)")
        values["allowed_warehouses"] = wh_val

    if establecimiento:
        conditions.append("bfel_establecimiento = %(establecimiento)s")
        values["establecimiento"] = establecimiento

    partners = _parse_multi(sales_partners)
    if partners:
        parts = []
        named = [p for p in partners if p != SIN_VENDEDOR]
        if named:
            parts.append("sales_partner IN %(sales_partners)s")
            values["sales_partners"] = tuple(named)
        if SIN_VENDEDOR in partners:
            parts.append("IFNULL(sales_partner, '') = ''")
        conditions.append("(" + " OR ".join(parts) + ")")
    return conditions, values


def _parse_multi(value) -> list:
    if isinstance(value, str):
        value = frappe.parse_json(value) if value.startswith("[") else ([value] if value else [])
    return [v for v in (value or []) if v]


@frappe.whitelist()
def get_sales_by_seller(start_date: str, end_date: str, sales_partners=None,
                        company: str = None, establecimiento: str = None) -> dict:
    _require_report(company, "reporte_ventas_vendedor")

    from facex_multi.api.cierre import _clasificar_por_pagos, _inv_total
    from facex_multi.api.recargo import pasarela_por_factura, venta_neta_sql

    conditions, values = _sales_by_seller_conditions(company, establecimiento, sales_partners)
    where = " AND ".join(conditions)

    meta = frappe.get_meta("Sales Invoice")
    optional = [f for f in ("payment_terms_template", "bfel_pago_contra_entrega", "bfel_status")
                if meta.has_field(f)]
    invoices = frappe.db.sql(
        f"""
        SELECT name, posting_date, due_date, customer, customer_name, sales_partner,
            bfel_establecimiento, company, owner, is_return, grand_total, rounded_total,
            disable_rounded_total, total_taxes_and_charges
            {"".join(", " + f for f in optional)}
        FROM `tabSales Invoice`
        WHERE posting_date BETWEEN %(start)s AND %(end)s AND {where}
        ORDER BY posting_date DESC, name DESC
        """,
        {"start": start_date, "end": end_date, **values},
        as_dict=True,
    )

    payments_by_inv = {}
    pasarela = {}
    if invoices:
        for p in frappe.db.sql(
            """
            SELECT parent, payment_date, payment_method, amount
            FROM `tabeFast Invoice Payment`
            WHERE parenttype = 'Sales Invoice' AND parentfield = 'custom_efast_payments'
                AND parent IN %(names)s
            """,
            {"names": tuple(i.name for i in invoices)},
            as_dict=True,
        ):
            payments_by_inv.setdefault(p.parent, []).append(p)
        # Recargo/flete pasarela por factura: no es venta del vendedor, pero sí
        # es parte de lo que el cliente paga (y por tanto de su saldo).
        pasarela = pasarela_por_factura([i.name for i in invoices])

    def _bucket():
        return {"monto": 0.0, "facturas": 0, "clientes": set()}

    clases = {c: _bucket() for c in _CLASES}
    devoluciones = _bucket()
    sellers = {}
    customers = set()
    cobrado = 0.0
    saldo = 0.0
    cobrable = 0.0
    impuestos = 0.0
    total_pasarela = 0.0
    rows = []

    for inv in invoices:
        # `gt` = lo que el cliente paga (base de cobranza: pagado y saldo).
        # `venta` = lo que vendió el vendedor, sin los cargos pasarela.
        gt = _inv_total(inv)
        pas = flt(pasarela.get(inv.name, 0.0))
        venta = gt - pas
        pays = payments_by_inv.get(inv.name, [])
        pagado = sum(flt(p.amount) for p in pays)
        pendiente = max(gt - pagado, 0.0) if not inv.is_return else 0.0
        seller = inv.sales_partner or SIN_VENDEDOR
        s = sellers.setdefault(seller, {
            "vendedor": seller, "facturas": 0, "clientes": set(), "venta_bruta": 0.0,
            "devoluciones": 0.0, "saldo": 0.0, "cargos_pasarela": 0.0, **{c: 0.0 for c in _CLASES},
        })
        impuestos += flt(inv.total_taxes_and_charges) - pas
        total_pasarela += pas
        s["cargos_pasarela"] += pas

        if inv.is_return:
            clase = "devolucion"
            devoluciones["monto"] += abs(venta)
            devoluciones["facturas"] += 1
            devoluciones["clientes"].add(inv.customer)
            s["devoluciones"] += abs(venta)
        else:
            clase, _ce, _cred = _clasificar_por_pagos(
                gt, pays, getdate(inv.posting_date), inv.get("bfel_pago_contra_entrega"), inv.due_date,
            )
            b = clases[clase]
            b["monto"] += venta
            b["facturas"] += 1
            b["clientes"].add(inv.customer)
            s[clase] += venta
            s["venta_bruta"] += venta
            s["facturas"] += 1
            s["clientes"].add(inv.customer)
            s["saldo"] += pendiente
            customers.add(inv.customer)
            cobrado += min(pagado, gt)
            saldo += pendiente
            cobrable += gt

        rows.append({
            "name": inv.name,
            "posting_date": inv.posting_date,
            "due_date": inv.due_date,
            "customer": inv.customer,
            "customer_name": inv.customer_name,
            "vendedor": seller,
            "establecimiento": inv.bfel_establecimiento,
            "condicion": clase,
            "plantilla": inv.get("payment_terms_template") or "",
            "bfel_status": inv.get("bfel_status") or "",
            "grand_total": venta,
            "total_cobrable": gt,
            "cargos_pasarela": pas,
            "pagado": pagado,
            "saldo": pendiente,
            "owner": inv.owner,
        })

    venta_bruta = sum(b["monto"] for b in clases.values())
    venta_neta = venta_bruta - devoluciones["monto"]
    num_facturas = sum(b["facturas"] for b in clases.values())

    seller_rows = []
    for s in sellers.values():
        neto = s["venta_bruta"] - s["devoluciones"]
        seller_rows.append({
            **{k: v for k, v in s.items() if k != "clientes"},
            "clientes": len(s["clientes"]),
            "venta_neta": neto,
            "ticket_promedio": s["venta_bruta"] / s["facturas"] if s["facturas"] else 0.0,
            "participacion": (neto / venta_neta * 100.0) if venta_neta else 0.0,
        })
    seller_rows.sort(key=lambda r: (r["vendedor"] == SIN_VENDEDOR, -r["venta_neta"]))

    # Periodo anterior de la misma duración, con los mismos filtros.
    d0, d1 = getdate(start_date), getdate(end_date)
    days = (d1 - d0).days + 1
    prev_start, prev_end = add_days(d0, -days), add_days(d0, -1)
    prev = frappe.db.sql(
        f"""
        SELECT COALESCE(SUM({venta_neta_sql("tabSales Invoice")}), 0) AS neto
        FROM `tabSales Invoice`
        WHERE posting_date BETWEEN %(start)s AND %(end)s AND {where}
        """,
        {"start": prev_start, "end": prev_end, **values},
        as_dict=True,
    )[0]
    venta_anterior = flt(prev.neto)
    crecimiento = ((venta_neta - venta_anterior) / venta_anterior * 100.0) if venta_anterior else None

    # Clientes nuevos: su primera factura validada en la compañía cae en el rango.
    clientes_nuevos = 0
    if customers:
        company_cond, company_vals = _build_company_condition(company)
        corte_cond, corte_vals = _corte_condition(company)
        clientes_nuevos = frappe.db.sql(
            f"""
            SELECT COUNT(*) FROM (
                SELECT customer, MIN(posting_date) AS primera
                FROM `tabSales Invoice`
                WHERE docstatus = 1 AND is_return = 0 AND customer IN %(customers)s
                  AND {company_cond} AND {corte_cond}
                GROUP BY customer
            ) t WHERE t.primera BETWEEN %(start)s AND %(end)s
            """,
            {"customers": tuple(customers), "start": start_date, "end": end_date,
             **company_vals, **corte_vals},
        )[0][0]

    def _clase_summary(b):
        return {
            "monto": b["monto"],
            "facturas": b["facturas"],
            "clientes": len(b["clientes"]),
            "pct": (b["monto"] / venta_bruta * 100.0) if venta_bruta else 0.0,
        }

    top = next((r for r in seller_rows if r["vendedor"] != SIN_VENDEDOR), None)
    return {
        "invoices": rows,
        "sellers": seller_rows,
        "summary": {
            "venta_bruta": venta_bruta,
            "venta_neta": venta_neta,
            "impuestos": impuestos,
            "facturas": num_facturas,
            "clientes": len(customers),
            "clientes_nuevos": clientes_nuevos,
            "ticket_promedio": venta_bruta / num_facturas if num_facturas else 0.0,
            "cobrado": cobrado,
            "saldo": saldo,
            # El % cobrado se mide contra lo COBRABLE (venta + cargos pasarela),
            # no contra la venta: si no, un documento con flete pasa del 100 %.
            "cobrable": cobrable,
            "cargos_pasarela": total_pasarela,
            "pct_cobrado": (cobrado / cobrable * 100.0) if cobrable else 0.0,
            "vendedores": len([r for r in seller_rows if r["vendedor"] != SIN_VENDEDOR]),
            "sin_vendedor": next((r["venta_neta"] for r in seller_rows if r["vendedor"] == SIN_VENDEDOR), 0.0),
            "top_vendedor": top["vendedor"] if top else "",
            "top_vendedor_monto": top["venta_neta"] if top else 0.0,
            "venta_anterior": venta_anterior,
            "crecimiento": round(crecimiento, 2) if crecimiento is not None else None,
            "periodo_anterior": [str(prev_start), str(prev_end)],
            "contado": _clase_summary(clases["contado"]),
            "credito": _clase_summary(clases["credito"]),
            "contra_entrega": _clase_summary(clases["contra_entrega"]),
            "devoluciones": {k: v for k, v in _clase_summary(devoluciones).items() if k != "pct"},
            "count": len(rows),
        },
    }


# ---------------------------------------------------------------------------
# 12. Vista rápida de una factura (panel lateral de los reportes)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_invoice_peek(name: str, company: str = None) -> dict:
    """Resumen de una factura para mirarla sin salir del reporte.

    La factura tiene que caer dentro del MISMO ámbito que los informes
    (compañía + socio de ventas + usuario creador). Si no, para este usuario
    no existe: el nombre llega del cliente y sin esta comprobación cualquiera
    podría espiar facturas de otro vendedor escribiendo su número.

    Las líneas de pago sólo se incluyen con `reporte_recibos_pagos`, el mismo
    permiso que exige el informe de Recibos y Pagos.
    """
    check_permission(company)

    company_cond, company_vals = _build_company_condition(company)
    sp_cond, sp_vals = _sales_partner_condition(company=company)
    owner_cond, owner_vals = _resolve_owner_filter(company, None)
    corte_cond, corte_vals = _corte_condition(company)
    values = {"name": name, **company_vals, **sp_vals, **owner_vals, **corte_vals}

    rows = frappe.db.sql(
        f"""
        SELECT name, posting_date, due_date, customer, customer_name, bfel_nit,
            company, currency, docstatus, status, total, total_taxes_and_charges,
            discount_amount, grand_total, bfel_status, bfel_uuid, bfel_docto_serie,
            bfel_docto_no, bfel_establecimiento, owner,
            COALESCE(bfel_documento_anulado, 0) AS anulado
        FROM `tabSales Invoice`
        WHERE name = %(name)s AND {company_cond} AND {sp_cond} AND {owner_cond} AND {corte_cond}
        """,
        values,
        as_dict=True,
    )
    if not rows:
        frappe.throw("La factura no existe o no está a su alcance.", frappe.PermissionError)
    inv = rows[0]

    items = frappe.db.sql(
        """
        SELECT item_code, item_name, qty, rate, amount
        FROM `tabSales Invoice Item`
        WHERE parent = %(name)s
        ORDER BY idx
        """,
        {"name": name},
        as_dict=True,
    )

    payments = frappe.db.sql(
        """
        SELECT payment_date, payment_method, reference, amount
        FROM `tabeFast Invoice Payment`
        WHERE parent = %(name)s AND parenttype = 'Sales Invoice'
            AND parentfield = 'custom_efast_payments'
        ORDER BY idx
        """,
        {"name": name},
        as_dict=True,
    )
    total_paid = sum(float(p.amount or 0) for p in payments)

    from facex_multi.api.permissions import get_facex_permissions_for_company

    perms = get_facex_permissions_for_company(get_effective_company(company))

    return {
        "invoice": inv,
        "items": items,
        "item_count": len(items),
        "total_paid": total_paid,
        "outstanding": max(float(inv.grand_total or 0) - total_paid, 0.0),
        "payments": payments if perms.get("reporte_recibos_pagos") else [],
        "can_see_payments": bool(perms.get("reporte_recibos_pagos")),
        "owner_name": frappe.db.get_value("User", inv.owner, "full_name") or inv.owner,
    }
