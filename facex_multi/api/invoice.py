"""
facex_multi.api.invoice
----------------------
Thin wrapper sobre ERPNext Sales Invoice estándar.
NUNCA duplica lógica fiscal, de stock ni contable.
Toda la lógica real permanece en ERPNext core.
"""
from __future__ import annotations

import frappe
import json
from frappe.utils import today, add_days, getdate


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------

def has_efast_permission():
    roles = frappe.get_roles()
    allowed = {"Sales User", "Accounts User", "Sales Manager",
                "Accounts Manager", "System Manager"}
    return bool(allowed & set(roles))


def fix_abbr_in_naming_series(doc, method=None):
    """
    Resuelve .ABBR. en naming_series a la abreviatura real de la compañía.
    Solo aplica en Frappe v15; en v16+ esto es nativo y se omite.
    Se activa via doc_events Sales Invoice > before_insert.
    """
    if int(frappe.__version__.split(".")[0]) >= 16:
        return
    series = doc.naming_series or ""
    if ".ABBR." not in series or not doc.company:
        return
    abbr = frappe.db.get_value("Company", doc.company, "abbr") or ""
    if not abbr:
        return
    doc.naming_series = series.replace(".ABBR.", f".{abbr}.")


def get_effective_company(company: str = None) -> str:
    """
    Resuelve la compañía efectiva. Prioridad:
    1. Parámetro company (si es válido).
    2. is_default en User Permission para el usuario actual (fuerza sin cache).
    3. Default de compañía del usuario en cache.
    4. Default global de compañía.
    """
    if company:
        return company.strip()
        
    user_company = frappe.db.get_value(
        "User Permission", 
        {"user": frappe.session.user, "allow": "Company", "is_default": 1}, 
        "for_value"
    )
    if user_company:
        return user_company

    return (
        frappe.defaults.get_user_default("Company")
        or frappe.db.get_single_value("Global Defaults", "default_company")
        or ""
    )


def get_company_abbr(company: str) -> str:
    """Retorna la abreviación de la compañía."""
    if not company:
        return ""
    return frappe.db.get_value("Company", company, "abbr") or ""


def filter_naming_series_for_company(series_list: list, company: str, establecimiento: str = None) -> list:
    """
    Filtra las series de numeración para que solo se muestren las compatibles
    con la compañía activa según la asociación en BFEL Document Map.
    Si se especifica establecimiento, también filtra por establecimiento.
    Despliega según el orden original en que se crearon en naming_series.
    """
    if not company:
        return series_list

    # 1. Obtener configuraciones BFEL activas de la compañía
    bfel_settings_list = frappe.get_all(
        "BFEL Settings",
        filters={"company": company, "enabled": 1},
        fields=["name"]
    )
    if not bfel_settings_list:
        return []

    settings_names = [s.name for s in bfel_settings_list]

    # 2. Obtener tipo de documentos (type_docdte) permitidos según BFEL Document Map
    map_filters = {
        "bfel_settings": ["in", settings_names],
        "enabled": 1,
        "erpnext_doctype": "Sales Invoice"
    }
    if establecimiento:
        map_filters["establecimiento"] = str(establecimiento)

    allowed_doc_maps = frappe.get_all(
        "BFEL Document Map",
        filters=map_filters,
        fields=["type_docdte"]
    )

    allowed_prefixes = {d.type_docdte.upper() for d in allowed_doc_maps if d.type_docdte}
    if not allowed_prefixes:
        return []

    # 3. Filtrar series_list manteniendo el orden original
    import re
    filtered = []
    for s in series_list:
        if not s:
            continue
        # Extraer el prefijo de la serie antes de cualquier delimitador (ej. de "FACT-.YYYY.-" extrae "FACT")
        parts = re.split(r'[-._/]', s)
        prefix = parts[0].strip().upper() if parts else ""
        if prefix in allowed_prefixes:
            filtered.append(s)

    return filtered



def create_custom_field_if_missing():
    """
    Crea el campo personalizado bfel_facex_multi en Sales Invoice si no existe.
    """
    if not frappe.db.exists("Custom Field", "Sales Invoice-bfel_facex_multi"):
        try:
            frappe.get_doc({
                "doctype": "Custom Field",
                "dt": "Sales Invoice",
                "fieldname": "bfel_facex_multi",
                "label": "Origen FacEx",
                "fieldtype": "Check",
                "insert_after": "naming_series",
                "default": "0",
                "read_only": 1,
                "no_copy": 1
            }).insert(ignore_permissions=True)
            frappe.db.commit()
        except Exception:
            frappe.log_error(frappe.get_traceback(), "FacEx Multi: create_custom_field_if_missing")


# ---------------------------------------------------------------------------
# 1. Defaults para nueva factura
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_user_companies():
    """Retorna las compañías permitidas para el usuario actual según User Permission."""
    perms = frappe.get_all(
        "User Permission",
        filters={"user": frappe.session.user, "allow": "Company"},
        pluck="for_value"
    )
    if perms:
        return perms
    if "System Manager" in frappe.get_roles():
        return frappe.get_all("Company", filters={"is_group": 0}, pluck="name", order_by="name asc")
    return []


@frappe.whitelist()
def set_active_company(company: str):
    """Establece la compañía activa para el usuario actual como is_default en User Permission."""
    company = (company or "").strip()
    if not company:
        frappe.throw("Compañía inválida.")

    # Validar que el usuario tiene permiso para esta compañía (o es System Manager)
    allowed = get_user_companies()
    if company not in allowed and "System Manager" not in frappe.get_roles():
        frappe.throw(f"No tiene permiso para la compañía '{company}'.")

    # Quitar is_default de las compañías actuales
    existing = frappe.get_all(
        "User Permission",
        filters={"user": frappe.session.user, "allow": "Company"},
        fields=["name", "for_value", "is_default"]
    )
    for perm in existing:
        if perm.is_default or perm.for_value == company:
            doc = frappe.get_doc("User Permission", perm.name)
            doc.is_default = 1 if perm.for_value == company else 0
            doc.save(ignore_permissions=True)

    frappe.db.commit()
    return {"success": True, "company": company}


@frappe.whitelist()
def get_warehouses(company: str = None):
    """Retorna los almacenes activos de la compañía actual."""
    company = get_effective_company(company)
    return frappe.get_all(
        "Warehouse",
        filters={"company": company, "is_group": 0, "disabled": 0},
        fields=["name"],
        order_by="name asc",
        pluck="name"
    )


@frappe.whitelist()
def get_defaults(company: str = None):
    """
    Retorna valores por defecto para inicializar una nueva factura:
    naming_series, company, warehouse, cost_center, currency, taxes_and_charges.
    """
    create_custom_field_if_missing()
    
    # Resolver la compañía efectiva
    company = get_effective_company(company)

    # Naming series disponibles para Sales Invoice
    naming_series = _get_naming_series("Sales Invoice")

    # Obtener establecimientos de la compañía
    establishments = []
    try:
        bfel_settings_list = frappe.get_all(
            "BFEL Settings",
            filters={"company": company, "enabled": 1},
            fields=["name"]
        )
        if bfel_settings_list:
            settings_name = bfel_settings_list[0].name
            raw_est = frappe.get_all(
                "BFEL Establecimientos",
                filters={"parent": settings_name, "activo": 1},
                fields=["establecimiento_id", "nombre_establecimiento", "subnombre_establecimiento", "logo", "activo"],
                order_by="establecimiento_id asc"
            )
            for r in raw_est:
                establishments.append({
                    "establecimiento_id": r.establecimiento_id,
                    "nombre_establecimiento": r.nombre_establecimiento,
                    "subnombre_establecimiento": r.subnombre_establecimiento,
                    "logo": r.logo,
                    "activo": r.activo
                })
    except Exception:
        pass

    if not establishments:
        company_logo = frappe.db.get_value("Company", company, "company_logo") or ""
        establishments.append({
            "establecimiento_id": 1,
            "nombre_establecimiento": company,
            "subnombre_establecimiento": company,
            "logo": company_logo,
            "activo": 1
        })

    # Filtrar por el primer establecimiento activo por defecto
    default_est = establishments[0]["establecimiento_id"] if establishments else None
    naming_series = filter_naming_series_for_company(naming_series, company, default_est)

    # Almacén por defecto
    default_warehouse = (
        frappe.defaults.get_user_default("Warehouse")
        or frappe.db.get_value("Warehouse",
            {"company": company, "is_group": 0, "disabled": 0},
            "name")
        or ""
    )

    # Centro de costo por defecto
    default_cost_center = (
        frappe.defaults.get_user_default("Cost Center")
        or frappe.db.get_value("Cost Center",
            {"company": company, "is_group": 0, "disabled": 0},
            "name")
        or ""
    )

    # Plantilla de impuestos por defecto
    default_taxes = (
        frappe.db.get_value("Sales Taxes and Charges Template",
            {"company": company, "is_default": 1},
            "name")
        or frappe.db.get_value("Sales Taxes and Charges Template",
            {"company": company, "disabled": 0},
            "name",
            order_by="creation asc")
        or ""
    )

    # Moneda de la empresa
    currency = frappe.db.get_value("Company", company, "default_currency") or "GTQ"

    # Selling Settings no tiene campo payment_terms en ERPNext v15
    default_payment_terms = ""

    from facex_multi.api.permissions import (
        get_facex_permissions_for_company, get_facex_company_config,
        get_facex_default_warehouse, get_facex_can_delete_held_sales,
        get_facex_can_cancel_invoices, get_facex_can_access_pos,
        get_facex_can_access_inventory_menu,
    )
    permissions = get_facex_permissions_for_company(company)
    permissions["puede_eliminar_ventas_espera"] = int(get_facex_can_delete_held_sales(company))
    permissions["puede_anular_facturas"] = int(get_facex_can_cancel_invoices(company))
    permissions["puede_ver_pos"] = int(get_facex_can_access_pos(company))
    permissions["puede_ver_menu_inventario"] = int(get_facex_can_access_inventory_menu(company))
    company_config = get_facex_company_config(company)
    default_pos_warehouse = get_facex_default_warehouse(company)

    return {
        "company": company,
        "naming_series": naming_series,
        "establishments": establishments,
        "default_warehouse": default_warehouse,
        "default_cost_center": default_cost_center,
        "default_taxes_and_charges": default_taxes,
        "default_payment_terms_template": default_payment_terms,
        "currency": currency,
        "posting_date": today(),
        "due_date": today(),
        "bfel_status_options": ["01 Enviar", "00 No enviar"],
        "bfel_status_default": "01 Enviar",
        "permissions": permissions,
        "company_config": company_config,
        "default_pos_warehouse": default_pos_warehouse,
    }


@frappe.whitelist()
def get_invoice_history(company: str = None, from_date: str = None, to_date: str = None):
    """Lista de facturas emitidas (cualquier estado) en un rango de fechas.
    Por defecto: del primer día del mes actual a hoy."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    today_date = getdate(today())
    from_date = getdate(from_date) if from_date else today_date.replace(day=1)
    to_date = getdate(to_date) if to_date else today_date

    return frappe.get_all(
        "Sales Invoice",
        filters={
            "company": company,
            "posting_date": ["between", [from_date, to_date]],
        },
        fields=["name", "customer_name", "posting_date", "grand_total", "docstatus", "bfel_status", "bfel_uuid"],
        order_by="posting_date desc, creation desc",
        limit_page_length=500,
    )


@frappe.whitelist()
def get_held_sales(company: str = None):
    """Ventas suspendidas (borradores) desde FacEx Screen, pendientes de retomar.
    Trae sales_partner/owner además de los campos básicos para que la pantalla
    pueda filtrar por fecha/vendedor/usuario creador sin llamadas adicionales."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    rows = frappe.get_all(
        "Sales Invoice",
        filters={
            "company": company,
            "docstatus": 0,
            "bfel_venta_suspendida": 1,
        },
        fields=["name", "customer_name", "posting_date", "grand_total", "sales_partner", "owner"],
        order_by="modified desc",
        limit_page_length=200,
    )
    owners = list({r["owner"] for r in rows if r.get("owner")})
    fullnames = {}
    if owners:
        for u in frappe.get_all("User", filters={"name": ["in", owners]}, fields=["name", "full_name"]):
            fullnames[u["name"]] = u["full_name"] or u["name"]
    for r in rows:
        r["owner_fullname"] = fullnames.get(r.get("owner"), r.get("owner") or "")
    return rows


@frappe.whitelist()
def delete_held_sale(name: str):
    """Elimina definitivamente una venta en espera (borrador suspendido desde
    FacEx Screen). Requiere el permiso dedicado (deny-by-default, ver
    permissions.get_facex_can_delete_held_sales) — es irreversible."""
    from facex_multi.api.permissions import get_facex_can_delete_held_sales

    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if not get_facex_can_delete_held_sales(doc.company):
        frappe.throw("No tiene permisos para eliminar ventas en espera.", frappe.PermissionError)

    # Salvaguarda: solo se permite borrar por esta vía documentos que
    # realmente son borradores suspendidos de FacEx Screen — nunca facturas
    # validadas ni borradores de otro origen que coincidan por casualidad.
    if doc.docstatus != 0 or not doc.get("bfel_venta_suspendida"):
        frappe.throw("Este documento no es una venta en espera; no se puede eliminar por esta vía.")

    frappe.delete_doc("Sales Invoice", name, ignore_permissions=True)
    frappe.db.commit()
    return {"success": True}


@frappe.whitelist()
def get_compatible_series(company: str, establecimiento: str = None) -> list:
    """
    Retorna las series de numeración compatibles con la compañía y establecimiento especificados.
    """
    all_series = _get_naming_series("Sales Invoice")
    return filter_naming_series_for_company(all_series, company, establecimiento)



def _get_naming_series(doctype: str) -> list:
    """
    Extrae naming series disponibles para un DocType.
    Prioridad: Property Setter > DocField > fallback.
    """
    try:
        # 1) Property Setter tiene máxima prioridad (personalización del usuario)
        prop = frappe.db.get_value(
            "Property Setter",
            {"doc_type": doctype, "field_name": "naming_series", "property": "options"},
            "value",
        )
        if prop:
            return [s.strip() for s in prop.split("\n") if s.strip()]

        # 2) DocField original
        options_str = frappe.db.get_value(
            "DocField",
            {"parent": doctype, "fieldname": "naming_series"},
            "options",
        ) or ""
        if options_str:
            return [s.strip() for s in options_str.split("\n") if s.strip()]

    except Exception:
        frappe.log_error(frappe.get_traceback(), "FacEx Multi: get_naming_series")

    return ["SINV-.YYYY.-"]


# ---------------------------------------------------------------------------
# 2. Stock por bodega (popover)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_item_stock(item_code: str, company: str = None):
    """Stock actual por bodega para un ítem, usando tabBin (snapshot rápido)."""
    company = get_effective_company(company)
    if not item_code:
        return []
    return frappe.db.sql(
        """
        SELECT b.warehouse, b.actual_qty, b.projected_qty, i.stock_uom, i.is_stock_item
        FROM `tabBin` b
        JOIN `tabWarehouse` w ON w.name = b.warehouse
        JOIN `tabItem` i      ON i.name  = b.item_code
        WHERE b.item_code = %(item_code)s
          AND w.company   = %(company)s
          AND w.is_group  = 0
          AND w.disabled  = 0
        ORDER BY b.actual_qty DESC
        """,
        {"item_code": item_code, "company": company},
        as_dict=True,
    )


# ---------------------------------------------------------------------------
# 3. Detalles de item
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_item_details(item_code: str, company: str = "", customer: str = "",
                     warehouse: str = "", posting_date: str = "", price_list: str = ""):
    """
    Retorna datos básicos de un item para poblar una fila del grid.
    No duplica la lógica de pricing — el precio final lo calcula ERPNext en save().
    """
    if not item_code:
        return {}

    company = get_effective_company(company)
    item = frappe.get_cached_doc("Item", item_code)

    if item.meta.has_field("bfel_company") and item.bfel_company and item.bfel_company != company:
        frappe.throw(f"El producto '{item_code}' no pertenece a la compañía activa '{company}'.")

    # Buscar la lista de precios a usar
    plist = price_list
    if not plist and customer:
        plist = frappe.db.get_value("Customer", customer, "default_price_list")
    
    if not plist:
        plist = (
            frappe.defaults.get_user_default("selling_price_list")
            or frappe.db.get_single_value("Selling Settings", "selling_price_list")
        )
        if not plist:
            if frappe.db.exists("Price List", "Standard Selling"):
                plist = "Standard Selling"
            else:
                active_list = frappe.db.get_value("Price List", {"selling": 1, "enabled": 1, "bfel_company": company}, "name")
                if not active_list:
                    active_list = frappe.db.get_value("Price List", {"selling": 1, "enabled": 1}, "name")
                plist = active_list or ""

    # Precio estándar (si existe)
    rate = 0.0
    item_price = frappe.db.get_value(
        "Item Price",
        {
            "item_code": item_code,
            "price_list": plist,
            "selling": 1,
        },
        "price_list_rate",
        order_by="valid_from desc",
    )
    if item_price:
        rate = float(item_price)

    # Almacén: parámetro > item_defaults filtrado por empresa > fallback empresa
    item_warehouse = warehouse or ""
    if not item_warehouse and item.item_defaults:
        _row = next((d for d in item.item_defaults if d.company == company),
                    item.item_defaults[0])
        item_warehouse = _row.get("default_warehouse") or ""
    if not item_warehouse and company:
        item_warehouse = (
            frappe.db.get_value("Warehouse",
                {"company": company, "is_group": 0, "disabled": 0}, "name")
            or ""
        )

    # Centro de costo: selling_cost_center > buying_cost_center > fallback empresa
    item_cost_center = ""
    if item.item_defaults:
        _row = next((d for d in item.item_defaults if d.company == company),
                    item.item_defaults[0])
        item_cost_center = (
            _row.get("selling_cost_center") or _row.get("buying_cost_center") or ""
        )
    if not item_cost_center and company:
        item_cost_center = (
            frappe.db.get_value("Cost Center",
                {"company": company, "is_group": 0, "disabled": 0},
                "name", order_by="lft asc")
            or ""
        )

    return {
        "item_code": item.name,
        "item_name": item.item_name,
        "description": item.description or item.item_name,
        "uom": item.stock_uom,
        "stock_uom": item.stock_uom,
        "rate": rate,
        "warehouse": item_warehouse,
        "cost_center": item_cost_center,
        "is_stock_item": item.is_stock_item,
        "has_serial_no": int(item.has_serial_no or 0),
        "custom_tiene_adenda": int(getattr(item, "custom_tiene_adenda", 0) or 0),
        "item_group": item.item_group or "",
    }


@frappe.whitelist()
def get_serial_nos_for_item(item_code: str, warehouse: str = "", company: str = None) -> list:
    """Retorna series disponibles (status=Active) para el item, restringidas SIEMPRE a
    almacenes ligados a la compañía activa — nunca globales entre compañías, ni
    siquiera cuando no se especifica una bodega puntual (caso: sin bodega por
    defecto configurada, se acota igual a todas las bodegas de la compañía)."""
    company = get_effective_company(company)

    conditions = ["s.item_code = %(item_code)s", "s.status = 'Active'", "w.company = %(company)s", "w.is_group = 0"]
    values = {"item_code": item_code, "company": company}
    if warehouse:
        conditions.append("s.warehouse = %(warehouse)s")
        values["warehouse"] = warehouse
    where_clause = " AND ".join(conditions)

    return frappe.db.sql(
        f"""
        SELECT s.name, s.warehouse
        FROM `tabSerial No` s
        JOIN `tabWarehouse` w ON w.name = s.warehouse
        WHERE {where_clause}
        ORDER BY s.name ASC
        LIMIT 500
        """,
        values,
        as_dict=True,
    )


def _build_descripcion2(item_dict: dict, correlativo: str) -> str:
    """
    Construye el campo descripcion_2 según el tipo de item:
    - Arma (serial_no presente): usa oficio + campos DIGECAM de arma
    - Munición/Accesorio (sin serial_no, tiene_adenda=1): usa autorizacion + campos munición
    - Sin adenda: solo descripción + correlativo
    """
    desc = (item_dict.get("description") or item_dict.get("item_name") or "").strip()
    tiene_adenda = int(item_dict.get("tiene_adenda") or 0)
    serial_no = (item_dict.get("serial_no") or "").strip()
    corr_str = f"Correlativo Interno: {correlativo}" if correlativo else ""

    parts = [desc]

    if tiene_adenda and serial_no:
        # Arma serializada
        if item_dict.get("color"):
            parts.append(f"Color: {item_dict['color']}")
        if item_dict.get("largo"):
            parts.append(f"Largo Del Cañon: {item_dict['largo']}")
        if item_dict.get("modelo"):
            parts.append(f"Modelo: {item_dict['modelo']}")
        if item_dict.get("tenencia_1"):
            parts.append(f"Tenencia 1: {item_dict['tenencia_1']}")
        if item_dict.get("tenencia_2"):
            parts.append(f"Tenencia 2: {item_dict['tenencia_2']}")
        if item_dict.get("codigo"):
            parts.append(f"Codigo Cliente: {item_dict['codigo']}")
        if item_dict.get("oficio"):
            parts.append(f"Oficio: {item_dict['oficio']}")
        if item_dict.get("expediente"):
            parts.append(f"Expediente: {item_dict['expediente']}")
        parts.append(f"Serie: {serial_no}")

    elif tiene_adenda:
        # Munición / accesorio con adenda (sin serie)
        if item_dict.get("licencia"):
            parts.append(f"Licencia: {item_dict['licencia']}")
        if item_dict.get("autorizacion"):
            parts.append(f"Autorización: {item_dict['autorizacion']}")
        if item_dict.get("lote"):
            parts.append(f"Lote: {item_dict['lote']}")
        tenencia = item_dict.get("custom_tenencia_municion") or ""
        if tenencia:
            parts.append(f"Tenencia: {tenencia}")
        codigo = item_dict.get("custom_codigo_cliente_municion") or ""
        if codigo:
            parts.append(f"Codigo Cliente: {codigo}")

    if corr_str:
        parts.append(corr_str)

    return " | ".join(parts)


# ---------------------------------------------------------------------------
# 3. Guardar borrador
# ---------------------------------------------------------------------------

@frappe.whitelist()
def save_draft(doc_json: str):
    """
    Crea o actualiza un Sales Invoice en estado borrador.
    Toda la lógica de impuestos y totales la ejecuta ERPNext en doc.save().
    Retorna el documento completo con totales calculados.
    """
    data = frappe.parse_json(doc_json)

    # bfel_establecimiento es Small Text pero el frontend puede enviarlo como int
    if data.get("bfel_establecimiento") is not None:
        data["bfel_establecimiento"] = str(data["bfel_establecimiento"])

    # Resolver y validar la compañía activa
    company = get_effective_company(data.get("company"))
    data["company"] = company

    # Validar naming series
    if data.get("naming_series"):
        all_series = _get_naming_series("Sales Invoice")
        compat_series = filter_naming_series_for_company(all_series, company, data.get("bfel_establecimiento"))
        if data["naming_series"] not in compat_series:
            frappe.throw(f"La serie de facturación '{data['naming_series']}' no es compatible con la compañía '{company}' y el establecimiento '{data.get('bfel_establecimiento') or ''}'.")

    # Validar cliente
    customer = data.get("customer")
    if customer:
        cust_company = frappe.db.get_value("Customer", customer, "bfel_company")
        if cust_company and cust_company != company:
            frappe.throw(f"El cliente '{customer}' pertenece a otra compañía y no puede utilizarse en esta factura.")

    # Validar Socio de Ventas y mapear a campo vendedor si bfel_enlace_vendedor=1
    sales_partner = data.get("sales_partner")
    if sales_partner:
        from facex_multi.api.sales_partner import validate_sales_partner_company
        validate_sales_partner_company(sales_partner, company)
        enlace = frappe.db.get_value("Sales Partner", sales_partner, "bfel_enlace_vendedor")
        if enlace:
            data["vendedor"] = sales_partner

    # Validar productos
    if "items" in data:
        for item_row in data["items"]:
            ic = item_row.get("item_code")
            if ic:
                item_comp = frappe.db.get_value("Item", ic, "bfel_company")
                if item_comp and item_comp != company:
                    frappe.throw(f"El producto '{ic}' pertenece a otra compañía y no puede utilizarse en esta factura.")

    
    # Pre-procesar items para asegurar que el descuento se aplique correctamente en ERPNext
    if "items" in data:
        for item_row in data["items"]:
            disc_pct = float(item_row.get("discount_percentage") or 0)
            original_rate = float(item_row.get("rate") or 0)
            if disc_pct > 0:
                item_row["price_list_rate"] = original_rate
                item_row["discount_percentage"] = disc_pct
                # rate tiene que ser el precio descontado para ERPNext
                item_row["rate"] = original_rate - (original_rate * disc_pct / 100.0)
            else:
                item_row["price_list_rate"] = original_rate
                item_row["discount_percentage"] = 0.0
                item_row["rate"] = original_rate

    name = (data.get("name") or "").strip()
    is_new = not name or name == "new"

    if is_new:
        data.pop("name", None)
        data["doctype"] = "Sales Invoice"
        # Si selling_price_list viene vacío, eliminarlo para que ERPNext lo resuelva
        # vía update_if_missing (party_details). update_if_missing solo aplica cuando
        # el campo es None, no cuando es "" — de ahí los errores de lista de precios.
        if not data.get("selling_price_list"):
            data.pop("selling_price_list", None)
        # Bug fix: si no se envían filas de taxes pero hay plantilla, dejar que ERPNext
        # las compute desde taxes_and_charges (evita primera factura sin impuestos)
        if not data.get("taxes") and data.get("taxes_and_charges"):
            data.pop("taxes", None)
        doc = frappe.get_doc(data)
        # Fallback: si aun así sigue vacío, tomar la lista de Selling Settings
        if not doc.selling_price_list:
            doc.selling_price_list = (
                frappe.db.get_single_value("Selling Settings", "selling_price_list") or ""
            )
    else:
        # Verificar que el doc existe y está en borrador
        docstatus = frappe.db.get_value("Sales Invoice", name, "docstatus")
        if docstatus is None:
            frappe.throw(f"Factura {name} no existe.")
        if docstatus == 1:
            frappe.throw(
                "La factura ya fue validada (submitted). "
                "No se puede editar en este estado."
            )
        if docstatus == 2:
            frappe.throw("La factura está cancelada.")

        doc = frappe.get_doc("Sales Invoice", name)
        # Actualizar campos del encabezado
        for field in (
            "naming_series", "customer", "posting_date", "due_date",
            "payment_terms_template", "terms", "taxes_and_charges",
            "bfel_nit", "bfel_identificacion", "bfel_nombre", "bfel_status", "bfel_escenario_exento",
            "es_fiscal", "update_stock", "company", "bfel_facex_multi", "bfel_venta_suspendida",
            "selling_price_list", "sales_partner", "bfel_establecimiento", "vendedor",
        ):
            # No pisar selling_price_list con vacío si el doc ya tiene uno
            if field == "selling_price_list" and not data.get(field) and doc.selling_price_list:
                continue
            if field in data:
                setattr(doc, field, data[field])

        # Reconstruir tabla de items desde el payload
        if "items" in data:
            doc.items = []
            for item_row in data["items"]:
                item_row.pop("name", None)  # forzar nueva row
                doc.append("items", item_row)

        # Bug fix: solo reemplazar taxes si se envían filas reales.
        # Si viene lista vacía pero hay plantilla, no borrar (deja a ERPNext gestionar).
        if "taxes" in data and isinstance(data.get("taxes"), list):
            if data["taxes"]:
                doc.taxes = []
                for tax_row in data["taxes"]:
                    tax_row.pop("name", None)
                    doc.append("taxes", tax_row)
            elif not data.get("taxes_and_charges"):
                # Plantilla fue eliminada explícitamente → limpiar taxes
                doc.taxes = []

    # Bug fix: force ERPNext to compute taxes from template if no taxes are provided
    if doc.get("taxes_and_charges") and not doc.get("taxes"):
        doc.append_taxes_from_master()

    # Sincronizar cronograma de pagos: siempre limpiar payment_schedule para que
    # ERPNext lo reconstruya en doc.save() con las fechas nuevas (posting_date/due_date
    # editados por el usuario), en vez de arrastrar filas viejas con due_date obsoletos
    # que pisan el due_date editado (ver accounts_controller.set_due_date()).
    doc.payment_schedule = []

    doc.flags.ignore_permissions = False
    doc.save()
    frappe.db.commit()

    return _safe_doc_dict(doc)


# ---------------------------------------------------------------------------
# 4. Validar (submit)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def submit_invoice(name: str):
    """
    Valida (submit) un Sales Invoice borrador.
    ERPNext ejecuta toda la lógica contable y de stock.
    Si concatena_descripcion2 está activo para la compañía, genera descripcion_2 en cada item.
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if doc.docstatus != 0:
        frappe.throw("Solo se puede validar una factura en estado Borrador.")

    from facex_multi.api.permissions import get_facex_company_config
    cfg = get_facex_company_config(doc.company)
    if cfg.get("concatena_descripcion2"):
        correlativo = str(doc.get("custom_correlativo_interno") or "")
        if not correlativo and frappe.db.exists("DocType", "Correlativos de factura"):
            # Intentar leer desde Correlativos de factura si aún no se asignó
            corr_row = frappe.db.get_value(
                "Correlativos de factura", {"empresa": doc.company}, "correlativo"
            )
            correlativo = str(corr_row or "")
        changed = False
        for item in doc.items:
            nueva = _build_descripcion2(item.as_dict(), correlativo)
            if item.get("descripcion_2") != nueva:
                item.descripcion_2 = nueva
                changed = True
        if changed:
            doc.save(ignore_permissions=True)
            frappe.db.commit()

    doc.submit()
    frappe.db.commit()

    return {
        "success": True,
        "name": doc.name,
        "status": doc.status,
        "docstatus": doc.docstatus,
        "grand_total": doc.grand_total,
    }


# ---------------------------------------------------------------------------
# 4b. Anular (cancel)
# ---------------------------------------------------------------------------

def _cancel_linked_payment_entries(invoice_name: str):
    """Cancela (sin eliminar) los Payment Entry presentados que referencian
    esta factura — ERPNext no permite cancelar una Sales Invoice mientras
    tenga Payment Entries activos apuntándola."""
    for pe_name in frappe.get_all(
        "Payment Entry Reference",
        filters={"reference_doctype": "Sales Invoice", "reference_name": invoice_name},
        pluck="parent",
    ):
        pe = frappe.get_doc("Payment Entry", pe_name)
        if pe.docstatus == 1:
            pe.cancel()


@frappe.whitelist()
def cancel_invoice(name: str):
    """
    Cancela internamente un Sales Invoice a nivel de ERPNext (revierte
    contabilidad e inventario). Solo para facturas validadas (docstatus 1)
    que NO han sido certificadas en FEL — una factura certificada debe
    anularse primero ante la SAT vía cancel_certified_invoice_fel().
    Requiere permiso puede_anular_facturas (deny-by-default).
    """
    from facex_multi.api.permissions import get_facex_can_cancel_invoices

    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if not get_facex_can_cancel_invoices(doc.company):
        frappe.throw("No tiene permiso para anular/cancelar documentos en FacEx Screen.")

    if doc.docstatus != 1:
        frappe.throw("Solo se puede anular una factura Validada.")
    if doc.bfel_uuid:
        frappe.throw("Esta factura ya fue certificada en FEL — debe anularse ante la SAT, no cancelarse localmente.")

    _cancel_linked_payment_entries(doc.name)
    doc.cancel()
    frappe.db.commit()

    return {
        "success": True,
        "name": doc.name,
        "docstatus": doc.docstatus,
    }


@frappe.whitelist()
def mark_printed_without_cert(name: str):
    """
    Marca la factura como impresa sin certificar — una decisión definitiva
    tomada por el cajero en FacEx Screen ("Solo Imprimir sin certificar").
    A partir de aquí "Certificar FEL e Imprimir" ya no se ofrece para esta
    factura (mutuamente excluyente, y persistido para que Historial lo
    respete al recargarla).
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)
    if doc.bfel_uuid:
        frappe.throw("Esta factura ya fue certificada en FEL.")
    frappe.db.set_value("Sales Invoice", name, "bfel_impreso_sin_certificar", 1)
    frappe.db.commit()
    return {"success": True}


@frappe.whitelist()
def cancel_certified_invoice_fel(name: str, motivo_anulacion: str):
    """
    Anula una factura ya certificada en FEL: primero ante la SAT (delega
    100% a brainfel.api.certify_sales_invoice.cancel_sales_invoice_fel, el
    mismo mecanismo que usa el formulario clásico de Sales Invoice vía su
    hook before_cancel), y solo si eso tiene éxito cancela el documento en
    ERPNext (revierte contabilidad e inventario). Requiere permiso
    puede_anular_facturas (deny-by-default).
    """
    from facex_multi.api.permissions import get_facex_can_cancel_invoices
    from brainfel.api.certify_sales_invoice import cancel_sales_invoice_fel

    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if not get_facex_can_cancel_invoices(doc.company):
        frappe.throw("No tiene permiso para anular/cancelar documentos en FacEx Screen.")
    if doc.docstatus != 1:
        frappe.throw("Solo se puede anular una factura Validada.")
    if not doc.bfel_uuid:
        frappe.throw("Esta factura no ha sido certificada en FEL — use la cancelación interna.")

    cancel_sales_invoice_fel(name, motivo_anulacion)

    doc.reload()
    doc.flags.ignore_validate_update_after_submit = True
    _cancel_linked_payment_entries(doc.name)
    doc.cancel()
    frappe.db.commit()

    return {"success": True, "name": doc.name, "docstatus": doc.docstatus}


# ---------------------------------------------------------------------------
# 5. Certificar FEL (delega 100% a brainfel)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def certify_invoice(name: str):
    """
    Certifica la factura vía Digifact/Brainfel.
    Delega completamente a brainfel.api.certify_sales_invoice.
    Sin duplicar absolutamente ninguna lógica FEL aquí.
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    # Validar que existe exactamente una configuración activa
    configs = frappe.get_all("BFEL Settings", filters={"company": doc.company, "enabled": 1}, fields=["name"])
    if not configs:
        frappe.throw(f"No se encontró ninguna configuración activa de BFEL Settings para la compañía '{doc.company}'.")
    if len(configs) > 1:
        frappe.throw(f"Riesgo de Configuración FEL: Se encontraron múltiples configuraciones de BFEL Settings activas para la compañía '{doc.company}' ({', '.join(c.name for c in configs)}). Por favor desactive las configuraciones duplicadas para evitar fugas de datos.")

    from brainfel.api.certify_sales_invoice import certify_sales_invoice
    return certify_sales_invoice(name)


# ---------------------------------------------------------------------------
# 6. Cargar factura existente
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_invoice(name: str):
    """
    Carga una Sales Invoice existente para visualizar/editar en FacEx Multi.
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)
    d = _safe_doc_dict(doc)
    all_pes   = _get_linked_payment_entries(name) if doc.docstatus == 1 else []
    submitted = [pe for pe in all_pes if pe.get("docstatus") == 1]
    draft     = [pe for pe in all_pes if pe.get("docstatus") == 0]
    d["_payment_entries"] = {
        "submitted":     submitted,
        "draft":         draft,
        "has_submitted": bool(submitted),
    }
    return d


# ---------------------------------------------------------------------------
# 6b. Duplicar factura (Validada/Vigente o Cancelada) → nuevo borrador limpio
# ---------------------------------------------------------------------------

# Campos de encabezado que representan datos de negocio/insumo y sí se copian.
# Deliberadamente NO incluye ningún campo de respuesta del certificador FEL.
_DUPLICATE_HEADER_FIELDS = (
    "company", "customer", "naming_series", "currency", "conversion_rate",
    "selling_price_list", "price_list_currency", "plc_conversion_rate",
    "taxes_and_charges", "terms", "tc_name", "payment_terms_template",
    "sales_partner", "vendedor", "update_stock", "es_fiscal", "cost_center",
    "letter_head",
    # Datos FEL de *insumo* (identificación del cliente / configuración del
    # documento), distintos de los datos de *retorno* de la certificación.
    "bfel_establecimiento", "bfel_escenario_exento", "bfel_concepto", "bfel_moneda",
    "bfel_nit", "bfel_identificacion", "bfel_nombre", "bfel_tipo_id", "bfel_cui",
    "bfel_direccion",
    "bfel_es_exportacion", "bfel_incoterm", "bfel_nombre_consignatario",
    "bfel_direccion_consignatario", "bfel_codigo_consignatario",
    "bfel_codigo_exportador", "bfel_nombre_exportador", "bfel_otra_referencia",
)

# Campos de retorno/estado de certificación FEL: nunca se copian de la factura origen.
_FEL_RETURN_FIELDS_CLEAR_EMPTY = (
    "bfel_uuid", "bfel_docto_serie", "bfel_docto_no", "bfel_fechacertificacion",
    "bfel_mensaje", "bfel_request_id", "bfel_numero_acceso",
    "bfel_numero_anterior", "bfel_serie_anterior", "bfel_doc_vinculado",
)
_FEL_RETURN_FIELDS_CLEAR_ZERO = ("bfel_documento_anulado", "bfel_contingencia")

_DUPLICATE_ITEM_FIELDS = (
    "item_code", "item_name", "description", "qty", "uom", "conversion_factor",
    "rate", "price_list_rate", "discount_percentage", "discount_amount",
    "warehouse", "income_account", "expense_account", "cost_center",
    "item_tax_template", "descripcion_2", "bfel_multi_tipo", "bfel_comentario",
)

_DUPLICATE_TAX_FIELDS = (
    "charge_type", "account_head", "description", "rate",
    "included_in_print_rate", "cost_center",
)


@frappe.whitelist()
def duplicate_invoice(name: str):
    """
    Duplica una Sales Invoice ya Validada (vigente) o Cancelada, generando un
    nuevo borrador en memoria (no se inserta hasta que el usuario presione
    Guardar). Conserva cliente, items, impuestos y datos fiscales de insumo,
    pero NUNCA copia datos de retorno de la certificación FEL (uuid, serie,
    número, fecha, mensaje, request id, etc.) ni pagos ya aplicados
    (los Payment Entry no se enlazan a la factura nueva). El estado FEL de
    la copia siempre queda en "01 Enviar".
    """
    name = (name or "").strip()
    src = frappe.get_doc("Sales Invoice", name)

    if src.docstatus == 0:
        frappe.throw(
            "Solo se pueden duplicar facturas Validadas (vigentes) o Canceladas. "
            "Un borrador ya se puede editar directamente."
        )

    data = {"doctype": "Sales Invoice", "name": "new", "docstatus": 0}
    for f in _DUPLICATE_HEADER_FIELDS:
        if src.meta.has_field(f):
            data[f] = src.get(f)

    data["posting_date"] = today()
    data["due_date"] = None
    data["bfel_facex_multi"] = 1

    # Limpiar explícitamente todo dato de retorno / estado de certificación FEL
    for f in _FEL_RETURN_FIELDS_CLEAR_EMPTY:
        data[f] = None
    for f in _FEL_RETURN_FIELDS_CLEAR_ZERO:
        data[f] = 0
    data["bfel_status"] = "01 Enviar"

    # Items: solo datos comerciales, sin ligas a stock/documentos de origen
    # (no se copian serial_no, batch_no, sales_order, delivery_note, etc.)
    data["items"] = [
        {f: item.get(f) for f in _DUPLICATE_ITEM_FIELDS}
        for item in src.items
    ]

    # Taxes: si hay plantilla, se recalculan solas en save_draft(); si no,
    # se copian las filas manuales para no perder impuestos ad-hoc.
    if not data.get("taxes_and_charges") and src.taxes:
        data["taxes"] = [
            {f: tax.get(f) for f in _DUPLICATE_TAX_FIELDS}
            for tax in src.taxes
        ]

    new_doc = frappe.get_doc(data)
    return _safe_doc_dict(new_doc)


# ---------------------------------------------------------------------------
# 6c. Corregir cliente al final de la venta (FacEx Screen)
# ---------------------------------------------------------------------------
# El cliente muchas veces se decide hasta el final de la venta, pero para
# entonces la factura ya está validada (docstatus=1) y ERPNext no permite
# editar el cliente de una factura validada. Se resuelve duplicándola con el
# cliente correcto (reutilizando duplicate_invoice tal cual, sin duplicar
# lógica), volviendo a validar y reaplicando el mismo desglose de pago.

def _cancel_and_delete_invoice(name: str) -> None:
    """Cancela y elimina una Sales Invoice + sus Payment Entries vinculados.
    Solo debe usarse sobre facturas que nunca se certificaron en FEL (nunca
    salieron del sistema hacia la SAT) — cancelar antes de eliminar deja un
    trail contable de reversión limpio, sin huérfanos."""
    for pe_name in frappe.get_all(
        "Payment Entry Reference",
        filters={"reference_doctype": "Sales Invoice", "reference_name": name},
        pluck="parent",
    ):
        pe = frappe.get_doc("Payment Entry", pe_name)
        if pe.docstatus == 1:
            pe.cancel()
        frappe.delete_doc("Payment Entry", pe_name, force=True, ignore_permissions=True)

    doc = frappe.get_doc("Sales Invoice", name)
    if doc.docstatus == 1:
        doc.cancel()
    frappe.delete_doc("Sales Invoice", name, force=True, ignore_permissions=True)
    frappe.db.commit()


@frappe.whitelist()
def rebill_with_new_customer(invoice_name: str, new_customer: str, payments_json: str = None):
    """
    Corrige el cliente de una venta ya validada duplicándola con el cliente
    correcto, validando la copia y reaplicando el mismo desglose de pago
    (si lo hubo — una venta al Crédito no manda payments_json).

    Los campos fiscales del cliente (bfel_nit, bfel_identificacion, etc.) no
    se copian a mano: certify_invoice los lee directo del Customer al
    certificar, así que basta con fijar el campo `customer`.

    Maneja la factura original según su estado de certificación FEL:
    - Si NO fue certificada: se cancela y se elimina (nunca llegó a la SAT).
    - Si YA fue certificada: se conserva intacta (documento fiscal real);
      la corrección queda como una factura adicional — anular la original
      requiere el proceso formal de Nota de Crédito, fuera de este alcance.
    """
    invoice_name = (invoice_name or "").strip()
    new_customer = (new_customer or "").strip()
    if not new_customer:
        frappe.throw("Debe indicar el cliente nuevo.")

    src = frappe.get_doc("Sales Invoice", invoice_name)
    if src.docstatus != 1:
        frappe.throw("Solo se puede corregir el cliente de una venta ya validada.")

    was_certified = bool(src.bfel_uuid) or src.bfel_status == "02 Procesada"

    new_data = duplicate_invoice(invoice_name)
    new_data["customer"] = new_customer
    new_data["name"] = "new"
    # duplicate_invoice deja due_date en None (due_date es obligatorio en save_draft)
    new_data["due_date"] = new_data.get("posting_date")
    # duplicate_invoice copia naming_series ya resuelto (p. ej. "FACT-.EMS.-.#####"
    # en vez de la plantilla "FACT-.ABBR.-.#####"), lo cual la validación de
    # save_draft rechaza como "no compatible" — se recalcula una serie
    # compatible real para la compañía/establecimiento en vez de arrastrarlo.
    compat_series = get_compatible_series(new_data.get("company"), new_data.get("bfel_establecimiento"))
    if compat_series:
        new_data["naming_series"] = compat_series[0]

    new_doc = save_draft(frappe.as_json(new_data))
    submit_invoice(new_doc["name"])
    if payments_json:
        save_payments(new_doc["name"], payments_json, "1")

    original_deleted = False
    if not was_certified:
        _cancel_and_delete_invoice(invoice_name)
        original_deleted = True

    return {
        "new_invoice": get_invoice(new_doc["name"]),
        "original_deleted": original_deleted,
        "original_was_certified": was_certified,
    }


# ---------------------------------------------------------------------------
# 7. Enviar email
# ---------------------------------------------------------------------------

@frappe.whitelist()
def send_invoice_email(name: str, recipients: str = "", print_format: str = ""):
    """
    Envía la factura por email usando el mecanismo estándar de ERPNext.
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if not recipients:
        # Intentar obtener email del cliente
        recipients = frappe.db.get_value("Customer", doc.customer, "email_id") or ""

    if not recipients:
        frappe.throw("No se encontró dirección de email del cliente.")

    # Usar el mecanismo estándar de Frappe para enviar documento
    frappe.sendmail(
        recipients=recipients.split(","),
        subject=f"Factura {name}",
        message=f"Adjunto encontrará la factura {name}.",
        reference_doctype="Sales Invoice",
        reference_name=name,
    )
    return {"success": True, "sent_to": recipients}


# ---------------------------------------------------------------------------
# 8. Print formats disponibles
# ---------------------------------------------------------------------------

def _sync_custom_print_formats():
    """
    Sincroniza dinámicamente los formatos de impresión 'Cotización FacEx' y
    'Recibo de Pago FacEx' desde los archivos locales de plantilla html y css.
    """
    import os
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    templates = {
        "Cotización FacEx": {
            "html": os.path.join(base_dir, "templates", "print_formats", "cotizacion_facex.html"),
            "css": os.path.join(base_dir, "templates", "print_formats", "cotizacion_facex.css"),
        },
        "Recibo de Pago FacEx": {
            "html": os.path.join(base_dir, "templates", "print_formats", "recibo_pago_facex.html"),
            "css": os.path.join(base_dir, "templates", "print_formats", "recibo_pago_facex.css"),
        },
        "FAC FEL": {
            "html": os.path.join(base_dir, "templates", "print_formats", "fac_fel.html"),
            "css": os.path.join(base_dir, "templates", "print_formats", "fac_fel.css"),
        },
        "FAC CERTIFI": {
            "html": os.path.join(base_dir, "templates", "print_formats", "fac_certifi.html"),
            "css": os.path.join(base_dir, "templates", "print_formats", "fac_certifi.css"),
        },
        "Recibo Ticket FacEx": {
            "html": os.path.join(base_dir, "templates", "print_formats", "recibo_ticket_facex.html"),
            "css": os.path.join(base_dir, "templates", "print_formats", "recibo_ticket_facex.css"),
        },
    }
    
    for name, paths in templates.items():
        try:
            if not os.path.exists(paths["html"]) or not os.path.exists(paths["css"]):
                continue
                
            with open(paths["html"], "r", encoding="utf-8") as f:
                html_content = f.read()
            with open(paths["css"], "r", encoding="utf-8") as f:
                css_content = f.read()
                
            if not frappe.db.exists("Print Format", name):
                frappe.get_doc({
                    "doctype": "Print Format",
                    "name": name,
                    "doc_type": "Sales Invoice",
                    "print_format_type": "Jinja",
                    "html": html_content,
                    "css": css_content,
                    "standard": "No",
                    "custom_format": 1
                }).insert(ignore_permissions=True)
                
            frappe.db.commit()
        except Exception:
            frappe.log_error(frappe.get_traceback(), f"FacEx Multi: sync print format {name}")


@frappe.whitelist()
def get_print_formats(company: str = None):
    """Retorna print formats disponibles para Sales Invoice."""
    # Sincronizar formatos personalizados antes de retornar la lista
    # _sync_custom_print_formats()
    
    company = get_effective_company(company)
    
    formats = frappe.db.get_all(
        "Print Format",
        filters=[
            ["doc_type", "=", "Sales Invoice"],
            ["disabled", "=", 0],
            ["bfel_company", "=", company]
        ],
        fields=["name"],
        order_by="name asc",
    )
    return [f["name"] for f in formats]


@frappe.whitelist()
def get_fel_verification_url(invoice_name: str):
    """
    Construye el URL público de verificación de la SAT Guatemala para una
    factura certificada en FEL — el mismo enlace que codifica el QR impreso
    en el documento oficial (fac_fel.html). Se reutiliza para compartir por
    WhatsApp sin exponer ningún archivo propio: apunta directo al validador
    público de la SAT, no a nuestro servidor.
    """
    invoice_name = (invoice_name or "").strip()
    doc = frappe.get_doc("Sales Invoice", invoice_name)
    if not doc.bfel_uuid:
        frappe.throw("La factura no ha sido certificada en FEL.")

    company_nit = frappe.db.get_value(
        "BFEL Settings", {"company": doc.company, "enabled": 1}, "company_nit"
    ) or ""
    emisor = company_nit.replace("-", "")
    receptor = (doc.bfel_nit or "CF").replace("-", "")
    monto = "%.2f" % doc.grand_total

    return (
        "https://felpub.c.sat.gob.gt/verificador-web/publico/vistas/verificacionDte.jsf"
        f"?tipo=autorizacion&numero={doc.bfel_uuid}&emisor={emisor}&receptor={receptor}&monto={monto}"
    )



# ---------------------------------------------------------------------------
# 9. Payment Entry helpers (FacEx → ERPNext nativo)
# ---------------------------------------------------------------------------

_FACEX_METHOD_MAP = {
    "Efectivo":           ["Efectivo", "Cash"],
    "Tarjeta de Crédito": ["Tarjetas de credito", "Tarjeta de Crédito", "Credit Card"],
    "Tarjeta de Credito": ["Tarjetas de credito", "Tarjeta de Crédito", "Credit Card"],
    "Transferencia":      ["Transferencia bancaria", "Transferencia", "Wire Transfer"],
    "Cheque":             ["Cheque", "Check"],
}
_FACEX_FALLBACK_CANDIDATES = ["Efectivo", "Cash"]


def _resolve_mode_of_payment_account(payment_method, company):
    """Prueba los nombres candidatos (español e inglés) del Mode of Payment
    hasta encontrar uno con cuenta configurada para la empresa dada."""
    candidates = _FACEX_METHOD_MAP.get(payment_method, []) + _FACEX_FALLBACK_CANDIDATES
    seen = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        account = frappe.db.get_value(
            "Mode of Payment Account",
            {"parent": candidate, "company": company},
            "default_account",
        )
        if account:
            return candidate, account
    return candidates[0] if candidates else "Efectivo", None


def _get_linked_payment_entries(invoice_name):
    pe_names = frappe.db.get_all(
        "Payment Entry Reference",
        filters={"reference_doctype": "Sales Invoice", "reference_name": invoice_name},
        pluck="parent",
    )
    result = []
    for pe_name in set(pe_names):
        pe = frappe.db.get_value(
            "Payment Entry",
            pe_name,
            ["name", "docstatus", "paid_amount", "posting_date", "mode_of_payment"],
            as_dict=True,
        )
        if pe:
            result.append(pe)
    return result


def _delete_draft_payment_entries(invoice_name):
    for pe in _get_linked_payment_entries(invoice_name):
        if pe.get("docstatus") == 0:
            frappe.delete_doc("Payment Entry", pe["name"], ignore_permissions=True, force=True)


def _create_payment_entry(invoice_doc, payment_method, payment_date, reference, amount):
    mode, paid_to = _resolve_mode_of_payment_account(payment_method, invoice_doc.company)

    paid_from = frappe.db.get_value("Company", invoice_doc.company, "default_receivable_account")
    if not paid_from:
        frappe.throw(f"La empresa {invoice_doc.company} no tiene cuenta por cobrar configurada.")

    if not paid_to:
        frappe.throw(f"No se encontró cuenta de pago para '{payment_method}' en {invoice_doc.company}.")

    paid_from_currency = frappe.db.get_value("Account", paid_from, "account_currency") or "GTQ"
    paid_to_currency   = frappe.db.get_value("Account", paid_to,   "account_currency") or "GTQ"

    pe = frappe.new_doc("Payment Entry")
    pe.payment_type               = "Receive"
    pe.party_type                 = "Customer"
    pe.party                      = invoice_doc.customer
    pe.company                    = invoice_doc.company
    pe.posting_date               = payment_date or today()
    pe.mode_of_payment            = mode
    pe.paid_amount                = amount
    pe.received_amount            = amount
    pe.paid_from                  = paid_from
    pe.paid_to                    = paid_to
    pe.paid_from_account_currency = paid_from_currency
    pe.paid_to_account_currency   = paid_to_currency
    pe.source_exchange_rate       = 1
    pe.target_exchange_rate       = 1
    pe.remarks                    = f"FacEx | {invoice_doc.name}"
    # "Cheque/Reference No" está forzado a reqd=1 + unique=1 en este sitio
    # (Property Setter sobre Payment Entry), a diferencia del comportamiento
    # estándar de ERPNext (solo obligatorio para cuentas tipo Bank). Efectivo
    # y otros métodos sin referencia manual necesitan igual un valor único
    # por Payment Entry — mismo criterio que el flujo "Automático x FacEx" ya
    # usado en FacEx clásico, pero con sufijo único para no chocar con la
    # restricción unique=1 si hay más de un cobro en efectivo.
    pe.reference_no   = reference or f"{invoice_doc.name}-{frappe.generate_hash(length=8)}"
    pe.reference_date = payment_date or today()

    pe.append("references", {
        "reference_doctype":  "Sales Invoice",
        "reference_name":     invoice_doc.name,
        "allocated_amount":   amount,
        "total_amount":       invoice_doc.grand_total,
        "outstanding_amount": invoice_doc.outstanding_amount,
    })

    pe.insert(ignore_permissions=True)
    return pe.name


# ---------------------------------------------------------------------------
# 10. Guardar pagos eFast → Payment Entry borrador
# ---------------------------------------------------------------------------

@frappe.whitelist()
def save_payments(invoice_name: str, payments_json: str, pagado: str = "0"):
    """
    Sincroniza los pagos de FacEx con Payment Entries en borrador de ERPNext.
    - Toggle ON: crea PE(s) en borrador por cada fila de pago.
    - Toggle OFF: elimina todos los PE en borrador vinculados.
    - Si ya existe un PE validado (docstatus=1): bloquea la operación.
    """
    import json as _json

    name       = (invoice_name or "").strip()
    payments   = _json.loads(payments_json) if isinstance(payments_json, str) else (payments_json or [])
    pagado_val = 1 if str(pagado) in ("1", "true", "True") else 0

    # Bloquear si hay PEs ya validados
    all_pes   = _get_linked_payment_entries(name)
    submitted = [pe for pe in all_pes if pe.get("docstatus") == 1]
    if submitted:
        frappe.throw(
            f"La factura {name} tiene {len(submitted)} pago(s) ya validado(s) en ERPNext. "
            "No se puede modificar el estado de pago desde FacEx."
        )

    # Eliminar PEs borrador existentes y recrear
    _delete_draft_payment_entries(name)

    doc = frappe.get_doc("Sales Invoice", name)
    doc.custom_pagado         = pagado_val
    doc.custom_efast_payments = []

    created_pes = []
    if pagado_val:
        for row in payments:
            amount = float(row.get("amount") or 0)
            if amount <= 0:
                continue
            method = row.get("payment_method") or "Efectivo"
            date   = row.get("payment_date") or today()
            ref    = row.get("reference") or ""
            doc.append("custom_efast_payments", {
                "payment_method": method,
                "payment_date":   date,
                "reference":      ref,
                "amount":         amount,
            })
            created_pes.append(
                _create_payment_entry(doc, method, date, ref, amount)
            )

    doc.flags.ignore_validate_update_after_submit = True
    doc.save(ignore_permissions=False)
    frappe.db.commit()

    total_paid = sum(float(r.get("amount") or 0) for r in payments)
    return {
        "success":         True,
        "total_paid":      total_paid,
        "pagado":          pagado_val,
        "payment_entries": created_pes,
    }


# ---------------------------------------------------------------------------
# Helper interno
# ---------------------------------------------------------------------------

def _safe_doc_dict(doc) -> dict:
    """Convierte doc a dict serializable con campos clave garantizados."""
    d = doc.as_dict()
    # Asegurar que campos numéricos no sean None
    for field in ("total", "total_taxes_and_charges", "discount_amount",
                  "grand_total", "outstanding_amount"):
        if d.get(field) is None:
            d[field] = 0.0
    return d


# ---------------------------------------------------------------------------
# 10. API para Reportes del Tablero / Dashboard
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_dashboard_stats(start_date=None, end_date=None, customer=None, item_code=None, company=None):
    """
    Calcula métricas y reportes dinámicos para el Tablero FaEx.
    """
    if not has_efast_permission():
        frappe.throw("No tiene permisos para ver este tablero.", frappe.PermissionError)

    company = get_effective_company(company)

    # 1. Construir filtros base para Sales Invoice (incluyendo canceladas 2)
    filters = {"docstatus": ["in", [0, 1, 2]], "company": company}
    if start_date and end_date:
        filters["posting_date"] = ["between", [start_date, end_date]]
    if customer:
        filters["customer"] = customer

    # Cargar facturas
    raw_invoices = frappe.db.get_all(
        "Sales Invoice",
        filters=filters,
        fields=["name", "customer", "customer_name", "posting_date", "grand_total", "bfel_status", "bfel_uuid", "docstatus", "bfel_documento_anulado"],
        order_by="posting_date desc, creation desc"
    )

    # Filtrar facturas: si está cancelada (docstatus=2), solo mostrar si tiene UUID o está anulada en FEL
    invoices = [
        inv for inv in raw_invoices
        if inv.docstatus != 2 or (inv.bfel_uuid or inv.bfel_documento_anulado == 1)
    ]

    # 2. Ventas del día (hoy) - Excluyendo las canceladas/anuladas del conteo de ventas activas
    today_date = getdate(today())
    today_invoices = [inv for inv in invoices if getdate(inv.posting_date) == today_date and inv.docstatus != 2 and inv.bfel_documento_anulado != 1]
    today_total = sum(float(inv.grand_total or 0) for inv in today_invoices)

    # 3. Ventas del mes (mes actual) - Excluyendo las canceladas/anuladas
    month_start_date = getdate(today()[:7] + "-01")
    month_invoices = [inv for inv in invoices if getdate(inv.posting_date) >= month_start_date and inv.docstatus != 2 and inv.bfel_documento_anulado != 1]
    month_total = sum(float(inv.grand_total or 0) for inv in month_invoices)

    # 4. Detalle de items vendidos (excluyendo canceladas y anuladas)
    invoice_names = [inv.name for inv in invoices if inv.docstatus != 2 and inv.bfel_documento_anulado != 1]
    if invoice_names:
        item_filters = {
            "parent": ["in", invoice_names]
        }
        if item_code:
            item_filters["item_code"] = item_code

        # Query detallado de productos
        item_details = frappe.db.get_all(
            "Sales Invoice Item",
            filters=item_filters,
            fields=["item_code", "item_name", "qty", "rate", "amount"]
        )
    else:
        item_details = []

    # Agrupar por item
    items_summary = {}
    for d in item_details:
        code = d.item_code
        if not code:
            continue
        if code not in items_summary:
            items_summary[code] = {
                "item_code": code,
                "item_name": d.item_name or code,
                "qty": 0.0,
                "amount": 0.0
            }
        items_summary[code]["qty"] += float(d.qty or 0)
        items_summary[code]["amount"] += float(d.amount or 0)

    items_summary_list = sorted(items_summary.values(), key=lambda x: x["amount"], reverse=True)

    # 5. Conteo FEL
    fel_processed = sum(1 for inv in invoices if inv.bfel_status == "02 Procesada")
    fel_pending = len(invoices) - fel_processed

    # 6. Estadísticas específicas de cliente (si se seleccionó cliente)
    customer_stats = {}
    if customer:
        cust_invoices = [inv for inv in invoices if inv.customer == customer]
        total_sales = sum(float(inv.grand_total or 0) for inv in cust_invoices)
        
        # Obtener datos rápidos del límite de crédito y saldo pendiente
        cust_doc = frappe.get_cached_doc("Customer", customer)
        credit_limit = 0.0
        if cust_doc.credit_limits:
            credit_limit = float(cust_doc.credit_limits[0].credit_limit or 0)
            
        outstanding_balance_res = frappe.db.sql(
            """
            select sum(outstanding_amount)
            from `tabSales Invoice`
            where customer = %s and docstatus = 1 and company = %s
            """,
            (customer, company),
        )
        outstanding_balance = float((outstanding_balance_res and outstanding_balance_res[0][0]) or 0.0)


        customer_stats = {
            "total_sales": total_sales,
            "invoice_count": len(cust_invoices),
            "credit_limit": credit_limit,
            "outstanding_balance": float(outstanding_balance),
        }

    return {
        "today_total": today_total,
        "today_count": len(today_invoices),
        "month_total": month_total,
        "month_count": len(month_invoices),
        "fel_processed": fel_processed,
        "fel_pending": fel_pending,
        "invoices": invoices[:50],  # Limitar a las últimas 50 facturas en lista rápida
        "items_summary": items_summary_list[:30],  # Top 30 productos para mostrar top 15 en frontend
        "customer_stats": customer_stats
    }


@frappe.whitelist()
def run_permissions_setup():
    role = "facex_multi"
    
    # 1. Asegurar que el rol 'facex_multi' exista en la base de datos
    if not frappe.db.exists("Role", role):
        try:
            frappe.get_doc({
                "doctype": "Role",
                "role_name": role,
                "desk_access": 1
            }).insert(ignore_permissions=True)
            frappe.db.commit()
        except Exception:
            pass

    # Doctypes to associate
    doctypes_all = [
        "Sales Invoice",
        "eFast Invoice Payment",
        "Item",
        "Customer",
        "Print Format",
        "Warehouse",
        "Sales Taxes and Charges Template",
        "Payment Terms Template",
        "Payment Term",
        "Terms and Conditions",
        "Customer Credit Limit"
    ]
    
    # Permissions dictionary
    perm_dict = {
        "read": 1, "write": 1, "create": 1, "delete": 1,
        "submit": 1, "cancel": 1, "amend": 1, "print": 1,
        "email": 1, "report": 1, "import": 1, "export": 1, "share": 1
    }
    
    for dt in doctypes_all:
        try:
            meta = frappe.get_meta(dt)
            applicable_perms = {}
            for k, v in perm_dict.items():
                if meta.istable and k in ["submit", "cancel", "amend"]:
                    continue
                applicable_perms[k] = v
            
            filters = {"parent": dt, "role": role, "permlevel": 0}
            name = frappe.db.get_value("Custom DocPerm", filters)
            if name:
                doc = frappe.get_doc("Custom DocPerm", name)
                for k, v in applicable_perms.items():
                    setattr(doc, k, v)
                doc.save(ignore_permissions=True)
            else:
                doc = frappe.get_doc({
                    "doctype": "Custom DocPerm",
                    "parent": dt,
                    "parenttype": "DocType",
                    "parentfield": "permissions",
                    "role": role,
                    "permlevel": 0,
                    **applicable_perms
                })
                doc.insert(ignore_permissions=True)
                
            frappe.clear_cache(doctype=dt)
        except Exception:
            pass
            
    try:
        page = frappe.get_doc("Page", "facex")
        if not any(r.role == role for r in page.roles):
            page.append("roles", {"role": role})
            page.save(ignore_permissions=True)
    except Exception:
        pass
        
    frappe.db.commit()
    return "Permissions successfully set for role facex_multi!"


@frappe.whitelist()
def preview_fel_pdf(invoice_name: str):
    """
    Descarga el PDF de la FEL desde el proveedor en el servidor y lo sirve como inline
    con el nombre del archivo establecido como el correlativo de la factura.
    """
    import requests

    doc = frappe.get_doc("Sales Invoice", invoice_name)
    if not doc.bfel_uuid:
        frappe.throw("La factura no ha sido certificada en FEL.")

    # Validar que existe exactamente una configuración activa
    configs = frappe.get_all("BFEL Settings", filters={"company": doc.company, "enabled": 1}, fields=["name"])
    if not configs:
        frappe.throw(f"No se encontró ninguna configuración activa de BFEL Settings para la compañía '{doc.company}'.")
    if len(configs) > 1:
        frappe.throw(f"Riesgo de Configuración FEL: Se encontraron múltiples configuraciones de BFEL Settings activas para la compañía '{doc.company}' ({', '.join(c.name for c in configs)}). Por favor desactive las configuraciones duplicadas para evitar fugas de datos.")

    # Obtener la URL del PDF desde la configuración de BFEL
    url_pdf = frappe.db.get_value(
        "BFEL Settings",
        {"company": doc.company, "enabled": 1},
        "url_pdf"
    )
    if not url_pdf:
        frappe.throw("No se encontró la configuración de URL de PDF en BFEL Settings.")

    full_url = f"{url_pdf}{doc.bfel_uuid}"
    
    try:
        response = requests.get(full_url, timeout=15)
        response.raise_for_status()
        pdf_data = response.content
    except Exception as e:
        frappe.log_error(frappe.get_traceback(), "FacEx Multi: preview_fel_pdf download error")
        frappe.throw(f"Error al descargar el PDF desde el proveedor FEL: {str(e)}")

    # Responder con el archivo PDF inline
    frappe.local.response.filename = f"{doc.name}.pdf"
    frappe.local.response.filecontent = pdf_data
    frappe.local.response.type = "pdf"
    frappe.local.response.display_content = "inline"




