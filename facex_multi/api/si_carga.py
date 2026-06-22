"""
facex_multi.api.si_carga
--------------------------
API whitelisted para carga masiva de Sales Invoices como saldos iniciales
desde archivos TSV exportados del portal de la SAT / FEL.

NUNCA certifica, NUNCA firma, NUNCA envía a FEL.
"""
from __future__ import annotations

import frappe
import json
import re
from frappe.utils import today, getdate
from facex_multi.api.invoice import get_effective_company


# ---------------------------------------------------------------------------
# Constantes
# ---------------------------------------------------------------------------

ALLOWED_DTE_TYPES = {"FACT", "FCAM"}
ALLOWED_FEL_STATUS = {"00 No enviar", "02 Procesada"}

# Índices de columnas del archivo TSV (0-based)
_C_FECHA_EMISION = 0
_C_UUID = 1
_C_TIPO_DTE = 2
_C_SERIE = 3
_C_NUMERO = 4
_C_ESTABLECIMIENTO = 10
_C_NOMBRE_EST = 11
_C_ID_RECEPTOR = 12
_C_NOMBRE_RECEPTOR = 13
_C_ESTADO = 16
_C_MONEDA = 17
_C_GRAN_TOTAL = 18
_C_IVA = 19
_C_MARCA_ANULADO = 20


# ---------------------------------------------------------------------------
# 1. Parsear archivo
# ---------------------------------------------------------------------------

@frappe.whitelist()
def parse_file(file_content: str):
    """
    Parsea el contenido TSV del archivo de la SAT.
    Filtra automáticamente registros inválidos (no Vigente, tipo DTE no permitido,
    marcados como anulados).
    Retorna las filas parseadas con datos mapeados, más el listado de filas omitidas.
    """
    if not file_content:
        frappe.throw("El contenido del archivo está vacío.")

    lines = file_content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if len(lines) < 2:
        frappe.throw("El archivo no contiene datos después del encabezado.")

    rows = []
    skipped = []

    for line_num, line in enumerate(lines[1:], start=2):
        line = line.strip()
        if not line:
            continue

        cols = line.split("\t")
        while len(cols) < 33:
            cols.append("")

        def col(i):
            return cols[i].strip() if i < len(cols) else ""

        estado = col(_C_ESTADO)
        tipo_dte_raw = col(_C_TIPO_DTE)
        marca_anulado = col(_C_MARCA_ANULADO).lower()
        uuid_val = col(_C_UUID)

        # Filtrar Estado != Vigente
        if estado != "Vigente":
            skipped.append({
                "linea": line_num,
                "razon": f"Estado '{estado}' (se requiere 'Vigente')",
                "uuid": uuid_val,
                "serie": col(_C_SERIE),
                "numero": col(_C_NUMERO),
            })
            continue

        # Filtrar Marca de anulado
        if marca_anulado in ("si", "sí"):
            skipped.append({
                "linea": line_num,
                "razon": "Documento marcado como anulado",
                "uuid": uuid_val,
                "serie": col(_C_SERIE),
                "numero": col(_C_NUMERO),
            })
            continue

        # Filtrar Tipo DTE
        tipo_dte_upper = tipo_dte_raw.upper().strip()
        tipo_code = tipo_dte_upper[:4]
        if tipo_code not in ALLOWED_DTE_TYPES:
            skipped.append({
                "linea": line_num,
                "razon": f"Tipo DTE '{tipo_dte_raw}' no permitido (solo FACT/FCAM)",
                "uuid": uuid_val,
                "serie": col(_C_SERIE),
                "numero": col(_C_NUMERO),
            })
            continue

        # Parsear fecha: "2026-05-29T09:47:09" → "2026-05-29"
        fecha_raw = col(_C_FECHA_EMISION)
        fecha = fecha_raw[:10] if fecha_raw and len(fecha_raw) >= 10 else today()

        # Parsear montos
        try:
            gran_total = float(col(_C_GRAN_TOTAL) or 0)
        except (ValueError, TypeError):
            gran_total = 0.0

        try:
            iva_monto = float(col(_C_IVA) or 0)
        except (ValueError, TypeError):
            iva_monto = 0.0

        tiene_iva = iva_monto > 0.001
        base_neta = round(gran_total - iva_monto, 10) if tiene_iva else gran_total

        row = {
            "_linea": line_num,
            "posting_date": fecha,
            "due_date": fecha,
            "bfel_uuid": uuid_val,
            "tipo_dte": tipo_code,
            "bfel_docto_serie": col(_C_SERIE),
            "bfel_docto_no": col(_C_NUMERO),
            "bfel_establecimiento": col(_C_ESTABLECIMIENTO),
            "_nombre_establecimiento": col(_C_NOMBRE_EST),
            "id_receptor": col(_C_ID_RECEPTOR),
            "_nombre_receptor": col(_C_NOMBRE_RECEPTOR),
            "currency": col(_C_MONEDA) or "GTQ",
            "gran_total": gran_total,
            "iva_monto": iva_monto,
            "tiene_iva": tiene_iva,
            "base_neta": base_neta,
            # Campos que se resolverán en validación
            "customer": "",
            "customer_name": col(_C_NOMBRE_RECEPTOR),
            "item_code": "",
            "payment_terms": "",
            "bfel_status": "",
            "upload_as_paid": None,
            "taxes_and_charges": "",
            "_customer_status": "pendiente",
            "_errors": [],
            "_warnings": [],
        }
        rows.append(row)

    return {
        "rows": rows,
        "skipped": skipped,
        "total_read": len(lines) - 1,
        "total_ok": len(rows),
        "total_skipped": len(skipped),
    }


# ---------------------------------------------------------------------------
# 2. Defaults para la pantalla
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_load_defaults(company: str = None):
    """
    Retorna los datos necesarios para inicializar la pantalla de carga:
    establecimientos, series, plantilla de impuestos, condiciones de pago.
    """
    company = get_effective_company(company)

    establishments = _get_establishments(company)
    tax_template = _get_tax_template(company)
    naming_series = _get_naming_series_for_company(company)

    payment_terms = frappe.get_all(
        "Payment Terms Template",
        fields=["name"],
        order_by="name asc"
    )
    companies = frappe.get_all("Company", fields=["name"], order_by="name asc")

    return {
        "company": company,
        "establishments": establishments,
        "default_tax_template": tax_template,
        "naming_series": naming_series,
        "payment_terms": [p.name for p in payment_terms],
        "companies": [c.name for c in companies],
        "allowed_fel_status": sorted(ALLOWED_FEL_STATUS),
    }


# ---------------------------------------------------------------------------
# 3. Validar filas
# ---------------------------------------------------------------------------

@frappe.whitelist()
def validate_rows(rows_json: str, company: str, default_item: str):
    """
    Para cada fila:
      - Resuelve o crea cliente por bfel_id_receptor
      - Verifica establecimiento
      - Detecta duplicados por UUID y Serie/Número
      - Asigna plantilla de impuestos si corresponde
    Retorna filas enriquecidas con _customer_status, _errors, _warnings.
    """
    rows = json.loads(rows_json) if isinstance(rows_json, str) else rows_json
    company = get_effective_company(company)

    if not frappe.db.exists("Item", default_item):
        frappe.throw(f"El ítem '{default_item}' no existe.")

    # Establecimientos válidos para la compañía
    valid_est = {}
    try:
        bfel_settings = frappe.get_all(
            "BFEL Settings",
            filters={"company": company, "enabled": 1},
            fields=["name"],
            limit=1
        )
        if bfel_settings:
            raw_est = frappe.get_all(
                "BFEL Establecimientos",
                filters={"parent": bfel_settings[0].name},
                fields=["establecimiento_id", "nombre_establecimiento", "activo"]
            )
            for e in raw_est:
                valid_est[str(e.establecimiento_id)] = e
    except Exception:
        pass

    tax_template = _get_tax_template(company)
    default_price_list = _get_price_list(company)

    # Cache de búsqueda de clientes por ID receptor
    customer_cache = {}

    for row in rows:
        row["_errors"] = []
        row["_warnings"] = []
        row["taxes_and_charges"] = ""
        if not row.get("item_code"):
            row["item_code"] = default_item

        # 1. Establecimiento
        est_id = str(row.get("bfel_establecimiento") or "").strip()
        if est_id and valid_est and est_id not in valid_est:
            row["_warnings"].append(
                f"Establecimiento '{est_id}' no está configurado en BFEL Settings de la compañía. Se cargará tal cual."
            )

        # 2. Resolver cliente
        id_receptor = str(row.get("id_receptor") or "").strip()
        if not id_receptor:
            row["_errors"].append("Fila sin ID de receptor.")
            row["_customer_status"] = "error"
            continue

        if id_receptor not in customer_cache:
            existing = (
                frappe.db.get_value(
                    "Customer",
                    {"bfel_id_receptor": id_receptor, "bfel_company": company},
                    ["name", "customer_name"],
                    as_dict=True
                )
                or frappe.db.get_value(
                    "Customer",
                    {"bfel_id_receptor": id_receptor},
                    ["name", "customer_name"],
                    as_dict=True
                )
            )
            customer_cache[id_receptor] = existing

        cust = customer_cache[id_receptor]
        if cust:
            row["customer"] = cust["name"]
            row["customer_name"] = cust["customer_name"]
            row["_customer_status"] = "ok"
        else:
            row["customer"] = ""
            row["_customer_status"] = "crear"
            row["_warnings"].append(
                f"Cliente con ID '{id_receptor}' no existe. Se creará al cargar."
            )

        # 3. Impuestos
        if row.get("tiene_iva") and tax_template:
            row["taxes_and_charges"] = tax_template

        # 4. Duplicado por UUID
        bfel_uuid = str(row.get("bfel_uuid") or "").strip()
        if bfel_uuid:
            dup = frappe.db.get_value(
                "Sales Invoice",
                {"bfel_uuid": bfel_uuid, "company": company, "docstatus": ["!=", 2]},
                "name"
            )
            if dup:
                row["_errors"].append(f"UUID ya existe en factura {dup}.")
                row["_customer_status"] = "duplicado"
                continue

        # 5. Duplicado por Serie + Número
        serie = str(row.get("bfel_docto_serie") or "").strip()
        numero = str(row.get("bfel_docto_no") or "").strip()
        if serie and numero:
            dup = frappe.db.get_value(
                "Sales Invoice",
                {
                    "bfel_docto_serie": serie,
                    "bfel_docto_no": numero,
                    "company": company,
                    "docstatus": ["!=", 2],
                },
                "name"
            )
            if dup:
                row["_errors"].append(f"Serie/Número '{serie}/{numero}' ya existe en factura {dup}.")
                row["_customer_status"] = "duplicado"
                continue

    return {
        "rows": rows,
        "tax_template": tax_template,
        "default_price_list": default_price_list,
    }


# ---------------------------------------------------------------------------
# 4. Crear facturas
# ---------------------------------------------------------------------------

@frappe.whitelist()
def create_invoices(
    rows_json: str,
    company: str,
    default_item: str,
    payment_terms: str = "",
    bfel_status: str = "00 No enviar",
    upload_as_paid: int = 0,
    naming_series: str = "",
):
    """
    Crea Sales Invoices como saldos iniciales (is_opening="Yes").
    NO certifica, NO firma, NO envía a FEL.
    Por cada fila:
      - Crea el cliente si no existe
      - Crea la Sales Invoice
      - Si upload_as_paid (global o por fila) es True, agrega fila en custom_efast_payments
    """
    rows = json.loads(rows_json) if isinstance(rows_json, str) else rows_json
    company = get_effective_company(company)
    upload_as_paid_global = int(upload_as_paid or 0)

    # Validar estado FEL
    if bfel_status not in ALLOWED_FEL_STATUS:
        frappe.throw(
            f"Estado FEL '{bfel_status}' no permitido. Opciones: {', '.join(sorted(ALLOWED_FEL_STATUS))}"
        )

    tax_template = _get_tax_template(company)
    default_price_list = _get_price_list(company)

    if not naming_series:
        naming_series = _get_naming_series_for_company(company)[0] if _get_naming_series_for_company(company) else "SINV-.YYYY.-"

    default_warehouse = (
        frappe.defaults.get_user_default("Warehouse")
        or frappe.db.get_value("Warehouse", {"company": company, "is_group": 0, "disabled": 0}, "name")
        or ""
    )
    default_cost_center = (
        frappe.defaults.get_user_default("Cost Center")
        or frappe.db.get_value("Cost Center", {"company": company, "is_group": 0, "disabled": 0}, "name")
        or ""
    )

    results = []
    customers_created = set()

    for row in rows:
        row_result = {
            "linea": row.get("_linea"),
            "uuid": row.get("bfel_uuid"),
            "serie_numero": f"{row.get('bfel_docto_serie','')}/{row.get('bfel_docto_no','')}",
            "status": "error",
            "invoice_name": None,
            "customer": None,
            "customer_created": False,
            "marked_as_paid": False,
            "error": None,
        }

        # Saltar filas con errores
        errors = row.get("_errors") or []
        if errors:
            row_result["error"] = "; ".join(errors)
            results.append(row_result)
            continue

        try:
            # Resolver/crear cliente
            customer_doc = row.get("customer") or ""
            if not customer_doc:
                customer_doc = _create_customer(
                    id_receptor=str(row.get("id_receptor") or "").strip(),
                    nombre_receptor=str(row.get("_nombre_receptor") or row.get("customer_name") or "Sin nombre").strip(),
                    company=company,
                )
                row_result["customer_created"] = True
                customers_created.add(customer_doc)

            row_result["customer"] = customer_doc

            # Determinar estado FEL de la fila
            row_fel_status = str(row.get("bfel_status") or bfel_status).strip()
            if row_fel_status not in ALLOWED_FEL_STATUS:
                row_fel_status = bfel_status

            # Ítem
            item_code = str(row.get("item_code") or default_item).strip()

            # Almacén y costo por ítem
            item_warehouse = default_warehouse
            item_cost_center = default_cost_center
            item_def = frappe.db.get_value(
                "Item Default",
                {"parent": item_code, "company": company},
                ["default_warehouse", "selling_cost_center"],
                as_dict=True
            )
            if item_def:
                if item_def.default_warehouse:
                    item_warehouse = item_def.default_warehouse
                if item_def.selling_cost_center:
                    item_cost_center = item_def.selling_cost_center

            # Tasa del ítem = base neta (gran total - IVA)
            base_neta = float(row.get("base_neta") or row.get("gran_total") or 0)
            item_uom = frappe.db.get_value("Item", item_code, "stock_uom") or "Nos"

            # Condiciones de pago por fila o globales
            row_payment_terms = str(row.get("payment_terms") or payment_terms or "").strip()

            # Estrategia de due_date para is_opening="Yes":
            # ERPNext limpia payment_terms_template en validate_invoice_documents_schedule DESPUÉS de
            # que set_missing_values() ya calculó due_date con la plantilla. Por eso:
            #   - Si hay plantilla: NO ponemos due_date en si_data → set_missing_values lo calcula
            #     como get_due_date(posting_date, customer, company, template_name=payment_terms_template)
            #     usando la fecha histórica del archivo como base.
            #   - Si no hay plantilla: ponemos due_date = posting_date explícito.
            _posting_date = getdate(row.get("posting_date") or today())

            # Construir doc
            si_data = {
                "doctype": "Sales Invoice",
                "naming_series": naming_series,
                "company": company,
                "customer": customer_doc,
                "posting_date": str(_posting_date),
                "set_posting_time": 1,
                "currency": row.get("currency") or "GTQ",
                "selling_price_list": default_price_list,
                "is_opening": "No",
                "terms": "Carga masiva FacEx",
                "bfel_nit": str(row.get("id_receptor") or "").strip(),
                "bfel_nombre": str(row.get("_nombre_receptor") or row.get("customer_name") or "").strip(),
                "bfel_status": row_fel_status,
                "bfel_establecimiento": str(row.get("bfel_establecimiento") or "").strip(),
                "bfel_docto_serie": str(row.get("bfel_docto_serie") or "").strip(),
                "bfel_docto_no": str(row.get("bfel_docto_no") or "").strip(),
                "bfel_uuid": str(row.get("bfel_uuid") or "").strip(),
                "bfel_moneda": str(row.get("currency") or "GTQ").strip(),
                "bfel_facex_multi": 1,
                "bfel_carga_masiva": 1,
                "items": [{
                    "item_code": item_code,
                    "qty": 1,
                    "rate": base_neta,
                    "price_list_rate": base_neta,
                    "uom": item_uom,
                    "warehouse": item_warehouse or "",
                    "cost_center": item_cost_center or "",
                }],
            }

            if row_payment_terms:
                # Con plantilla: set_missing_values calculará due_date = posting_date + días_plantilla
                si_data["payment_terms_template"] = row_payment_terms
                # NO incluir due_date → set_missing_values lo calculará automáticamente
            else:
                # Sin plantilla: fijar due_date = posting_date
                si_data["due_date"] = str(_posting_date)

            # Impuestos
            taxes_tpl = row.get("taxes_and_charges") or (tax_template if row.get("tiene_iva") else "")
            if taxes_tpl:
                si_data["taxes_and_charges"] = taxes_tpl

            doc = frappe.get_doc(si_data)

            if taxes_tpl:
                doc.append_taxes_from_master()

            # Red de seguridad: si validate_due_date detectara due_date vacío o < posting_date
            # (e.g. plantilla exótica o cliente sin términos definidos), corregir en lugar de lanzar.
            _doc_ref = doc
            def _fix_due_date_for_opening():
                _p = getdate(_doc_ref.posting_date)
                if not _doc_ref.due_date or getdate(_doc_ref.due_date) < _p:
                    _doc_ref.due_date = str(_p)
                for _ps in (_doc_ref.payment_schedule or []):
                    if _ps.due_date and getdate(_ps.due_date) < _p:
                        _ps.due_date = str(_p)
            doc.validate_due_date = _fix_due_date_for_opening

            doc.flags.ignore_permissions = False
            doc.insert()
            frappe.db.commit()

            row_result["invoice_name"] = doc.name
            row_result["status"] = "ok"

            # Marcar como pagada si corresponde
            row_upload_paid = row.get("upload_as_paid")
            if row_upload_paid is None:
                row_upload_paid = upload_as_paid_global
            else:
                try:
                    row_upload_paid = int(row_upload_paid)
                except (ValueError, TypeError):
                    row_upload_paid = upload_as_paid_global

            if row_upload_paid:
                try:
                    _add_payment_to_invoice(
                        invoice_name=doc.name,
                        grand_total=float(doc.grand_total or 0),
                        posting_date=doc.posting_date,
                    )
                    row_result["marked_as_paid"] = True
                except Exception as e_pay:
                    frappe.log_error(frappe.get_traceback(), f"FacEx SI Carga: pago fila {row.get('_linea')}")
                    row_result["pay_warning"] = str(e_pay)

        except Exception as e:
            frappe.log_error(frappe.get_traceback(), f"FacEx SI Carga: crear factura fila {row.get('_linea')}")
            row_result["error"] = str(e)
            try:
                frappe.db.rollback()
            except Exception:
                pass

        results.append(row_result)

    created = [r for r in results if r["status"] == "ok"]
    errors_list = [r for r in results if r["status"] == "error"]
    paid_list = [r for r in results if r.get("marked_as_paid")]

    return {
        "results": results,
        "summary": {
            "created": len(created),
            "errors": len(errors_list),
            "customers_created": len(customers_created),
            "paid": len(paid_list),
            "invoices": [r["invoice_name"] for r in created if r["invoice_name"]],
        },
    }


# ---------------------------------------------------------------------------
# 5. Series compatibles con la compañía
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_series_for_company(company: str) -> list:
    """Retorna las naming series compatibles con la compañía."""
    company = get_effective_company(company)
    return _get_naming_series_for_company(company)


# ---------------------------------------------------------------------------
# Helpers internos
# ---------------------------------------------------------------------------

def _get_establishments(company: str) -> list:
    establishments = []
    try:
        bfel_settings = frappe.get_all(
            "BFEL Settings",
            filters={"company": company, "enabled": 1},
            fields=["name"],
            limit=1
        )
        if bfel_settings:
            raw = frappe.get_all(
                "BFEL Establecimientos",
                filters={"parent": bfel_settings[0].name, "activo": 1},
                fields=["establecimiento_id", "nombre_establecimiento"],
                order_by="establecimiento_id asc"
            )
            for e in raw:
                establishments.append({
                    "id": str(e.establecimiento_id),
                    "nombre": e.nombre_establecimiento,
                })
    except Exception:
        pass
    return establishments


def _get_tax_template(company: str) -> str:
    return (
        frappe.db.get_value(
            "Sales Taxes and Charges Template",
            {"company": company, "is_default": 1},
            "name"
        )
        or frappe.db.get_value(
            "Sales Taxes and Charges Template",
            {"company": company, "disabled": 0},
            "name",
            order_by="creation asc"
        )
        or ""
    )


def _get_price_list(company: str) -> str:
    return (
        frappe.db.get_value("Price List", {"selling": 1, "enabled": 1, "bfel_company": company}, "name")
        or frappe.db.get_value("Price List", {"selling": 1, "enabled": 1}, "name")
        or "Standard Selling"
    )


def _get_naming_series_for_company(company: str) -> list:
    from facex_multi.api.invoice import _get_naming_series, filter_naming_series_for_company
    all_series = _get_naming_series("Sales Invoice")
    compat = filter_naming_series_for_company(all_series, company)
    return compat if compat else ["SINV-.YYYY.-"]


def _create_customer(id_receptor: str, nombre_receptor: str, company: str) -> str:
    """Crea un cliente nuevo asociado a la compañía con bfel_id_receptor."""
    customer_group = (
        frappe.db.get_value("Customer Group", {"is_group": 0}, "name", order_by="lft asc")
        or "All Customer Groups"
    )
    territory = (
        frappe.db.get_value("Territory", {"is_group": 0}, "name", order_by="lft asc")
        or "All Territories"
    )

    # Determinar tipo de identificación
    bfel_identificacion = "CF"
    if id_receptor and id_receptor.upper() not in ("CF", ""):
        if re.match(r"^\d+$", id_receptor):
            bfel_identificacion = "NIT"
        else:
            bfel_identificacion = "CUI"

    doc = frappe.new_doc("Customer")
    doc.customer_name = nombre_receptor or id_receptor
    doc.customer_type = "Individual"
    doc.customer_group = customer_group
    doc.territory = territory

    if doc.meta.has_field("bfel_company"):
        doc.bfel_company = company
    if doc.meta.has_field("bfel_id_receptor"):
        doc.bfel_id_receptor = id_receptor
    if doc.meta.has_field("bfel_identificacion"):
        doc.bfel_identificacion = bfel_identificacion
    if id_receptor and id_receptor.upper() not in ("CF", ""):
        doc.tax_id = id_receptor

    # Auto-asignar lista de precios
    plists = frappe.get_all(
        "Price List",
        filters={"selling": 1, "enabled": 1, "bfel_company": company},
        fields=["name"]
    )
    if plists:
        doc.default_price_list = plists[0].name
    else:
        plist_global = frappe.db.get_value("Price List", {"selling": 1, "enabled": 1}, "name")
        if plist_global:
            doc.default_price_list = plist_global

    doc.flags.ignore_permissions = False
    doc.insert()
    frappe.db.commit()
    return doc.name


def _add_payment_to_invoice(invoice_name: str, grand_total: float, posting_date: str):
    """Agrega una fila de pago a custom_efast_payments reutilizando save_payments."""
    from facex_multi.api.invoice import save_payments

    payments = [{
        "payment_method": "Efectivo",
        "payment_date": posting_date or today(),
        "reference": "Saldo inicial FacEx",
        "amount": grand_total,
    }]
    save_payments(
        invoice_name=invoice_name,
        payments_json=json.dumps(payments),
        pagado="1",
    )
