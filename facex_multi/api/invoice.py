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
def get_defaults():
    """
    Retorna valores por defecto para inicializar una nueva factura:
    naming_series, company, warehouse, cost_center, currency, taxes_and_charges.
    """
    create_custom_field_if_missing()
    defaults = frappe.defaults.get_defaults()
    company = defaults.get("company") or frappe.db.get_single_value(
        "Global Defaults", "default_currency"
    )

    # Empresa por defecto del usuario
    company = (
        frappe.defaults.get_user_default("Company")
        or frappe.db.get_single_value("Global Defaults", "default_company")
        or ""
    )

    # Naming series disponibles para Sales Invoice
    naming_series = _get_naming_series("Sales Invoice")

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

    return {
        "company": company,
        "naming_series": naming_series,
        "default_warehouse": default_warehouse,
        "default_cost_center": default_cost_center,
        "default_taxes_and_charges": default_taxes,
        "default_payment_terms_template": default_payment_terms,
        "currency": currency,
        "posting_date": today(),
        "due_date": today(),
        "bfel_status_options": ["01 Enviar", "00 No enviar"],
        "bfel_status_default": "01 Enviar",
    }


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
# 2. Detalles de item
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

    item = frappe.get_cached_doc("Item", item_code)

    # Buscar la lista de precios a usar
    plist = price_list
    if not plist and customer:
        plist = frappe.db.get_value("Customer", customer, "default_price_list")
    
    if not plist:
        plist = (
            frappe.defaults.get_user_default("selling_price_list")
            or frappe.db.get_single_value("Selling Settings", "selling_price_list")
            or "Standard Selling"
        )

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
    }


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
        # Bug fix: si no se envían filas de taxes pero hay plantilla, dejar que ERPNext
        # las compute desde taxes_and_charges (evita primera factura sin impuestos)
        if not data.get("taxes") and data.get("taxes_and_charges"):
            data.pop("taxes", None)
        doc = frappe.get_doc(data)
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
            "bfel_nit", "bfel_nombre", "bfel_status", "bfel_escenario_exento",
            "es_fiscal", "update_stock", "company", "bfel_facex_multi",
        ):
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
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if doc.docstatus != 0:
        frappe.throw("Solo se puede validar una factura en estado Borrador.")

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

@frappe.whitelist()
def cancel_invoice(name: str):
    """
    Cancela un Sales Invoice a nivel de ERPNext.
    Solo para facturas validadas (docstatus 1) que NO han sido certificadas en FEL.
    """
    name = (name or "").strip()
    doc = frappe.get_doc("Sales Invoice", name)

    if doc.docstatus != 1:
        frappe.throw("Solo se puede anular una factura Validada.")
        
    doc.cancel()
    frappe.db.commit()

    return {
        "success": True,
        "name": doc.name,
        "docstatus": doc.docstatus,
    }


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
    # Validar permiso de lectura (frappe lo maneja via get_doc)
    return _safe_doc_dict(doc)


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
            "html": os.path.join(base_dir, "templates", "print_formats", "fac_fel.html"),
            "css": os.path.join(base_dir, "templates", "print_formats", "fac_fel.css"),
        }
    }
    
    for name, paths in templates.items():
        try:
            if not os.path.exists(paths["html"]) or not os.path.exists(paths["css"]):
                continue
                
            with open(paths["html"], "r", encoding="utf-8") as f:
                html_content = f.read()
            with open(paths["css"], "r", encoding="utf-8") as f:
                css_content = f.read()
                
            if frappe.db.exists("Print Format", name):
                # Si ya existe en la base de datos de ERPNext, NO sobreescribirlo con los archivos del repo.
                # De esta forma, el usuario puede editar y diseñar los formatos directamente desde la UI de ERPNext.
                pass
            else:
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
def get_print_formats():
    """Retorna print formats disponibles para Sales Invoice."""
    # Sincronizar formatos personalizados antes de retornar la lista
    _sync_custom_print_formats()
    
    formats = frappe.db.get_all(
        "Print Format",
        filters={"doc_type": "Sales Invoice", "disabled": 0},
        fields=["name"],
        order_by="name asc",
    )
    return [f["name"] for f in formats]



# ---------------------------------------------------------------------------
# Helper interno
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 9. Guardar pagos eFast (custom child table)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def save_payments(invoice_name: str, payments_json: str, pagado: str = "0"):
    """
    Guarda los registros de pago en la tabla hija custom_efast_payments
    y actualiza el campo custom_pagado.
    Permite edición en cualquier estado (borrador o validada).
    """
    import json as _json

    name = (invoice_name or "").strip()
    payments = _json.loads(payments_json) if isinstance(payments_json, str) else (payments_json or [])
    pagado_val = 1 if str(pagado) in ("1", "true", "True") else 0

    doc = frappe.get_doc("Sales Invoice", name)
    doc.custom_pagado = pagado_val
    doc.custom_efast_payments = []

    for row in payments:
        doc.append("custom_efast_payments", {
            "payment_method": row.get("payment_method") or "Efectivo",
            "payment_date": row.get("payment_date") or today(),
            "reference": row.get("reference") or "",
            "amount": float(row.get("amount") or 0),
        })

    doc.flags.ignore_validate_update_after_submit = True
    doc.save(ignore_permissions=False)
    frappe.db.commit()

    total_paid = sum(float(r.get("amount") or 0) for r in payments)
    return {
        "success": True,
        "total_paid": total_paid,
        "pagado": pagado_val,
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
def get_dashboard_stats(start_date=None, end_date=None, customer=None, item_code=None):
    """
    Calcula métricas y reportes dinámicos para el Tablero FaEx.
    """
    if not has_efast_permission():
        frappe.throw("No tiene permisos para ver este tablero.", frappe.PermissionError)

    # 1. Construir filtros base para Sales Invoice (incluyendo canceladas 2)
    filters = {"docstatus": ["in", [0, 1, 2]]}
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

    # 4. Detalle de items vendidos
    invoice_names = [inv.name for inv in invoices]
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
            
        outstanding_balance = frappe.db.get_value(
            "Sales Invoice",
            {"customer": customer, "docstatus": 1},
            {"SUM": "outstanding_amount"}
        ) or 0.0

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
        "items_summary": items_summary_list[:20],  # Top 20 productos
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




