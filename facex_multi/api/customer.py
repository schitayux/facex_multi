"""
facex_multi.api.customer
-----------------------
Búsqueda y creación rápida de clientes desde el POS.
"""
from __future__ import annotations

import frappe
import json
from facex_multi.api.invoice import get_effective_company


@frappe.whitelist()
def lookup_identificacion_name(identificacion: str, tipo: str = "NIT", company: str = None):
    """
    Consulta el nombre registrado para un NIT o CUI en el certificador configurado
    (Grupo CDS/Total Doc) vía BFEL Settings -> url_retorna_cliente (NIT) o
    url_retorna_cui (CUI). PASAPORTE y CF no tienen consulta automática.

    Retorna {"found": False} sin lanzar error si BFEL Settings no está
    habilitado, no es Grupo CDS, el tipo no aplica, o no tiene la URL
    correspondiente configurada, para no interrumpir el flujo del Facturador
    ni el de Mantenimiento cuando la función no aplica.
    """
    identificacion = (identificacion or "").strip()
    tipo = (tipo or "").strip().upper()
    if not identificacion or tipo not in ("NIT", "CUI"):
        return {"found": False}

    company = get_effective_company(company)

    from brainfel.utils.company_utils import get_bfel_settings_for_company_safe

    settings = get_bfel_settings_for_company_safe(company)
    if not settings or settings.certifier != "Grupo CDS":
        return {"found": False}

    url_field = "url_retorna_cliente" if tipo == "NIT" else "url_retorna_cui"
    if not (settings.get(url_field) or "").strip():
        return {"found": False}

    from brainfel.services.totaldoc_client import consultar_cliente, consultar_cliente_cui

    try:
        if tipo == "NIT":
            result = consultar_cliente(settings, identificacion)
        else:
            result = consultar_cliente_cui(settings, identificacion)
    except Exception as e:
        frappe.log_error(title="FEL lookup_identificacion_name", message=str(e))
        return {"found": False, "message": str(e)}

    if not result.get("success"):
        return {"found": False, "message": result.get("message")}

    return {"found": True, "customer_name": result.get("customer_name")}


@frappe.whitelist()
def search_customer(txt: str, company: str = None):
    """Busca clientes por nombre, NIT o código filtrados por compañía activa."""
    if not txt or len(txt.strip()) < 2:
        return []
    txt = txt.strip()
    company = get_effective_company(company)
    rows = frappe.db.sql(
        """
        SELECT name, customer_name, tax_id, bfel_id_receptor
        FROM `tabCustomer`
        WHERE disabled = 0
          AND (
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
          AND (name LIKE %(q)s OR customer_name LIKE %(q)s OR tax_id LIKE %(q)s OR bfel_id_receptor LIKE %(q)s)
        ORDER BY customer_name ASC
        LIMIT 20
        """,
        {"q": f"%{txt}%", "company": company},
        as_dict=True,
    )
    for row in rows:
        nit = row.get("bfel_id_receptor") or row.get("tax_id") or ""
        row["tax_id"] = nit
        row["bfel_id_receptor"] = nit
    return rows


@frappe.whitelist()
def get_customer(name: str, company: str = None):
    """Retorna los campos relevantes del cliente para el diálogo con validación de compañía."""
    doc = frappe.get_doc("Customer", name)
    company = get_effective_company(company)
    
    if doc.meta.has_field("bfel_company") and doc.bfel_company and doc.bfel_company != company:
        frappe.throw(f"El cliente '{name}' pertenece a otra compañía y no puede ser accedido.")

    nit = doc.get("bfel_id_receptor") or doc.get("tax_id") or ""
    return {
        "name": doc.name,
        "customer_name": doc.customer_name or "",
        "bfel_identificacion": doc.get("bfel_identificacion") or "",
        "bfel_id_receptor": nit,
        "custom_direccion": doc.get("custom_direccion") or "",
        "custom_departamento": doc.get("custom_departamento") or "",
        "custom_telefono": doc.get("custom_telefono") or "",
        "naming_series": doc.get("naming_series") or "",
        "payment_terms": doc.get("payment_terms") or "",
        "default_price_list": doc.get("default_price_list") or "",
        "default_sales_partner": doc.get("default_sales_partner") or "",
    }


@frappe.whitelist()
def create_or_update_customer(data_json: str, company: str = None):
    """Crea o actualiza un cliente con los campos del diálogo rápido asignando bfel_company."""
    data = json.loads(data_json) if isinstance(data_json, str) else data_json
    name = (data.get("name") or "").strip()
    company = get_effective_company(company)

    if name:
        doc = frappe.get_doc("Customer", name)
        # Validar pertenencia antes de editar
        if doc.meta.has_field("bfel_company") and doc.bfel_company and doc.bfel_company != company:
            frappe.throw("No tiene permisos para modificar un cliente de otra compañía.")
    else:
        doc = frappe.new_doc("Customer")
        doc.customer_type = "Individual"
        doc.customer_group = (
            frappe.db.get_value("Customer Group", {"is_group": 0}, "name", order_by="lft asc")
            or "All Customer Groups"
        )
        doc.territory = (
            frappe.db.get_value("Territory", {"is_group": 0}, "name", order_by="lft asc")
            or "All Territories"
        )
        if doc.meta.has_field("bfel_company"):
            doc.bfel_company = company

    editable = [
        "customer_name", "bfel_identificacion", "bfel_id_receptor",
        "custom_direccion", "custom_departamento", "custom_telefono",
        "payment_terms", "default_price_list", "default_sales_partner",
    ]
    for field in editable:
        if field in data:
            setattr(doc, field, data[field])

    # Forzar que bfel_company no sea alterada
    if doc.meta.has_field("bfel_company"):
        doc.bfel_company = company

    # Sincronizar tax_id y bfel_id_receptor
    if doc.meta.has_field("bfel_id_receptor"):
        nit = doc.get("bfel_id_receptor") or doc.get("tax_id") or ""
        if nit:
            doc.bfel_id_receptor = nit
            doc.tax_id = nit

    doc.save(ignore_permissions=False)
    frappe.db.commit()
    return {"name": doc.name, "customer_name": doc.customer_name}


def validate_customer_on_save(doc, method=None):
    """Sincroniza tax_id y valida la lista de precios antes de guardar el cliente."""
    if doc.meta.has_field("bfel_id_receptor"):
        nit = doc.get("bfel_id_receptor") or doc.get("tax_id") or ""
        if nit:
            doc.bfel_id_receptor = nit
            doc.tax_id = nit

    if doc.meta.has_field("bfel_company") and doc.bfel_company:
        company = doc.bfel_company

        # Si no tiene lista de precios, intentar auto-asignar o requerirla
        if not doc.default_price_list:
            plists = frappe.db.sql(
                """
                SELECT name FROM `tabPrice List`
                WHERE selling=1 AND enabled=1
                  AND (
                      bfel_company = %(company)s
                      OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null,0) = 0)
                  )
                """,
                {"company": company},
                as_dict=True,
            )
            if len(plists) == 1:
                doc.default_price_list = plists[0].name
            else:
                frappe.throw(f"Es obligatorio asignar una 'Lista de Precios' al cliente {doc.name}.")

        # Validar que la lista asignada pertenece a su compañía (o es global)
        if doc.default_price_list:
            plist_company = frappe.db.get_value("Price List", doc.default_price_list, "bfel_company")
            if plist_company and plist_company != company:
                frappe.throw(f"La Lista de Precios '{doc.default_price_list}' pertenece a {plist_company} y no puede asignarse a un cliente de {company}.")

        # Validar que el socio de ventas asignado pertenece a su compañía
        if doc.default_sales_partner:
            from facex_multi.api.sales_partner import validate_sales_partner_company
            validate_sales_partner_company(doc.default_sales_partner, company)
