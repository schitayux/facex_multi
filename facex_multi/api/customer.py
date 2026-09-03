"""
facex_multi.api.customer
-----------------------
Búsqueda y creación rápida de clientes desde el POS.
"""
from __future__ import annotations

import frappe
import json
from frappe.utils import flt
from facex_multi.api.invoice import get_effective_company, has_efast_permission


def _get_credit_limit_for_company(doc, company: str) -> float:
    for row in doc.get("credit_limits") or []:
        if row.company == company:
            return flt(row.credit_limit)
    return 0.0


def _set_credit_limit_for_company(doc, company: str, credit_limit: float):
    for row in doc.get("credit_limits") or []:
        if row.company == company:
            row.credit_limit = credit_limit
            return
    doc.append("credit_limits", {"company": company, "credit_limit": credit_limit})


def _get_linked_address(customer_name: str):
    """Retorna el nombre del Address vinculado al cliente (primary o el primero enlazado)."""
    addr = frappe.db.get_value("Customer", customer_name, "customer_primary_address")
    return addr or frappe.db.get_value(
        "Dynamic Link",
        {"link_doctype": "Customer", "link_name": customer_name, "parenttype": "Address"},
        "parent",
    )


def _get_linked_contact(customer_name: str):
    """Retorna el nombre del Contact vinculado al cliente (primary o el primero enlazado)."""
    contact = frappe.db.get_value("Customer", customer_name, "customer_primary_contact")
    return contact or frappe.db.get_value(
        "Dynamic Link",
        {"link_doctype": "Customer", "link_name": customer_name, "parenttype": "Contact"},
        "parent",
    )


def _sync_customer_address(customer_doc, data: dict):
    """Crea o actualiza el Address del cliente (address_line1/city) y lo marca como primary."""
    direccion = (data.get("direccion") or "").strip()
    departamento = (data.get("departamento") or "").strip()
    if not direccion and not departamento:
        return
    if not direccion or not departamento:
        frappe.throw("Debe completar tanto 'Dirección' como 'Departamento' para guardar la sección Dirección.")

    address_name = _get_linked_address(customer_doc.name)
    addr = frappe.get_doc("Address", address_name) if address_name else frappe.new_doc("Address")
    if not address_name:
        addr.address_type = "Billing"
        addr.country = "Guatemala"
        addr.append("links", {"link_doctype": "Customer", "link_name": customer_doc.name})

    addr.address_title = f"{customer_doc.name}-FacEx"
    addr.address_line1 = direccion
    addr.city = departamento
    addr.save(ignore_permissions=True)

    if customer_doc.customer_primary_address != addr.name:
        frappe.db.set_value("Customer", customer_doc.name, "customer_primary_address", addr.name)


def _sync_customer_contact(customer_doc, data: dict):
    """Crea o actualiza el Contact del cliente (first_name/last_name/email_ids/phone_nos) y lo marca como primary."""
    nombre = (data.get("contacto_nombre") or "").strip()
    apellido = (data.get("contacto_apellido") or "").strip()
    email = (data.get("contacto_email") or "").strip()
    telefono = (data.get("contacto_telefono") or "").strip()
    if not any([nombre, apellido, email, telefono]):
        return
    if not nombre:
        frappe.throw("El 'Nombre' del contacto es obligatorio para guardar la sección Contacto.")

    contact_name = _get_linked_contact(customer_doc.name)
    contact = frappe.get_doc("Contact", contact_name) if contact_name else frappe.new_doc("Contact")
    if not contact_name:
        contact.append("links", {"link_doctype": "Customer", "link_name": customer_doc.name})

    contact.first_name = nombre
    contact.last_name = apellido
    contact.email_ids = []
    if email:
        contact.append("email_ids", {"email_id": email, "is_primary": 1})
    contact.phone_nos = []
    if telefono:
        contact.append("phone_nos", {"phone": telefono, "is_primary_phone": 1})
    contact.save(ignore_permissions=True)

    if customer_doc.customer_primary_contact != contact.name:
        frappe.db.set_value("Customer", customer_doc.name, "customer_primary_contact", contact.name)


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
def search_customers_maintenance(company: str = None, start: int = 0, page_length: int = 15,
                                   nombre: str = None, codigo: str = None, nit: str = None,
                                   grupo: str = None, celular: str = None, vendedor: str = None):
    """Búsqueda/paginación de clientes para el Mantenimiento de Clientes (modo
    búsqueda-primero). Cada parámetro filtra una columna distinta y se combinan
    con AND, para soportar tanto el buscador rápido del panel izquierdo (un solo
    filtro) como la fila de filtros por columna del popup de resultados (varios
    a la vez). Sin ningún filtro, lista TODOS los clientes de la compañía activa
    ("Ver todos"). Incluye deshabilitados para poder ubicarlos y
    reactivarlos/editarlos desde el mantenimiento.

    Retorna {"rows": [...], "total": N} para el paginador del popup."""
    company = get_effective_company(company)

    conditions = []
    params = {"company": company}

    nombre = (nombre or "").strip()
    if nombre:
        conditions.append("customer_name LIKE %(nombre)s")
        params["nombre"] = f"%{nombre}%"

    codigo = (codigo or "").strip()
    if codigo:
        conditions.append("name LIKE %(codigo)s")
        params["codigo"] = f"%{codigo}%"

    nit = (nit or "").strip()
    if nit:
        conditions.append("(tax_id LIKE %(nit)s OR bfel_id_receptor LIKE %(nit)s)")
        params["nit"] = f"%{nit}%"

    grupo = (grupo or "").strip()
    if grupo:
        conditions.append("customer_group LIKE %(grupo)s")
        params["grupo"] = f"%{grupo}%"

    celular = (celular or "").strip()
    if celular:
        conditions.append("mobile_no LIKE %(celular)s")
        params["celular"] = f"%{celular}%"

    vendedor = (vendedor or "").strip()
    if vendedor:
        conditions.append("default_sales_partner LIKE %(vendedor)s")
        params["vendedor"] = f"%{vendedor}%"

    company_filter = """(
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )"""
    where = " AND ".join([company_filter] + conditions)

    total = frappe.db.sql(f"SELECT COUNT(*) FROM `tabCustomer` WHERE {where}", params)[0][0]

    rows = frappe.db.sql(
        f"""
        SELECT name, customer_name, tax_id, bfel_id_receptor, customer_group, mobile_no,
               default_price_list, payment_terms, default_sales_partner, disabled
        FROM `tabCustomer`
        WHERE {where}
        ORDER BY customer_name ASC
        LIMIT %(page_length)s OFFSET %(start)s
        """,
        {**params, "page_length": int(page_length), "start": int(start)},
        as_dict=True,
    )
    for row in rows:
        nit_val = row.get("bfel_id_receptor") or row.get("tax_id") or ""
        row["tax_id"] = nit_val
        row["bfel_id_receptor"] = nit_val
    return {"rows": rows, "total": total}


@frappe.whitelist()
def export_customers_excel(names_json: str, company: str = None):
    """Exporta a Excel los clientes marcados en el popup de resultados del
    Mantenimiento de Clientes. Vuelve a filtrar por compañía activa por si el
    listado de nombres fue manipulado desde el cliente."""
    names = json.loads(names_json) if isinstance(names_json, str) else names_json
    if not names:
        frappe.throw("Debe seleccionar al menos un cliente.")
    company = get_effective_company(company)

    placeholders = ", ".join(["%s"] * len(names))
    rows = frappe.db.sql(
        f"""
        SELECT name, customer_name, tax_id, bfel_id_receptor, customer_group, mobile_no,
               default_price_list, payment_terms, default_sales_partner, disabled
        FROM `tabCustomer`
        WHERE name IN ({placeholders})
          AND (
              bfel_company = %s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
        """,
        tuple(names) + (company,),
        as_dict=True,
    )

    from frappe.utils.xlsxutils import make_xlsx

    headers = [
        "Código", "Nombre", "NIT / Identificación", "Grupo de Cliente", "Celular",
        "Lista de Precios", "Condiciones de Pago", "Vendedor", "Deshabilitado",
    ]
    data = [headers]
    for r in rows:
        nit = r.get("bfel_id_receptor") or r.get("tax_id") or ""
        data.append([
            r.name, r.customer_name, nit, r.customer_group or "", r.mobile_no or "",
            r.default_price_list or "", r.payment_terms or "",
            r.default_sales_partner or "", "Sí" if r.disabled else "No",
        ])

    xlsx_file = make_xlsx(data, "Clientes")
    frappe.response["filename"] = "clientes.xlsx"
    frappe.response["filecontent"] = xlsx_file.getvalue()
    frappe.response["type"] = "binary"


@frappe.whitelist()
def get_customer(name: str, company: str = None):
    """Retorna los campos relevantes del cliente para el diálogo con validación de compañía."""
    doc = frappe.get_doc("Customer", name)
    company = get_effective_company(company)
    
    if doc.meta.has_field("bfel_company") and doc.bfel_company and doc.bfel_company != company:
        frappe.throw(f"El cliente '{name}' pertenece a otra compañía y no puede ser accedido.")

    nit = doc.get("bfel_id_receptor") or doc.get("tax_id") or ""

    address_name = _get_linked_address(doc.name)
    addr = frappe.get_doc("Address", address_name) if address_name else None

    contact_name = _get_linked_contact(doc.name)
    contact = frappe.get_doc("Contact", contact_name) if contact_name else None

    return {
        "name": doc.name,
        "customer_name": doc.customer_name or "",
        "bfel_identificacion": doc.get("bfel_identificacion") or "",
        "bfel_id_receptor": nit,
        "direccion": addr.address_line1 if addr else "",
        "departamento": addr.city if addr else "",
        "contacto_nombre": contact.first_name if contact else "",
        "contacto_apellido": contact.last_name if contact else "",
        "contacto_email": contact.email_ids[0].email_id if contact and contact.email_ids else "",
        "contacto_telefono": contact.phone_nos[0].phone if contact and contact.phone_nos else "",
        "naming_series": doc.get("naming_series") or "",
        "payment_terms": doc.get("payment_terms") or "",
        "default_price_list": doc.get("default_price_list") or "",
        "default_sales_partner": doc.get("default_sales_partner") or "",
        "customer_group": doc.get("customer_group") or "",
        "credit_limit": _get_credit_limit_for_company(doc, company),
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
        "payment_terms", "default_price_list", "default_sales_partner",
        "customer_group",
    ]
    for field in editable:
        if field in data:
            # customer_group ya recibe un valor por defecto al crear el cliente
            # (ver arriba); no lo pisamos con "" si el usuario no eligió uno.
            if field == "customer_group" and not data[field]:
                continue
            setattr(doc, field, data[field])

    # Forzar que bfel_company no sea alterada
    if doc.meta.has_field("bfel_company"):
        doc.bfel_company = company

    if "credit_limit" in data:
        _set_credit_limit_for_company(doc, company, flt(data.get("credit_limit")))

    # Sincronizar tax_id y bfel_id_receptor
    if doc.meta.has_field("bfel_id_receptor"):
        nit = doc.get("bfel_id_receptor") or doc.get("tax_id") or ""
        if nit:
            doc.bfel_id_receptor = nit
            doc.tax_id = nit

    doc.save(ignore_permissions=False)

    _sync_customer_address(doc, data)
    _sync_customer_contact(doc, data)

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


@frappe.whitelist()
def get_or_create_walkin_customer(company: str = None):
    """Devuelve el cliente 'Consumidor Final' (mostrador) de la compañía activa, creándolo
    la primera vez si no existe. Cliente por defecto de la pantalla POS (facex-screen)."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)

    existing = frappe.db.get_value(
        "Customer",
        {"customer_name": "Consumidor Final", "bfel_company": company},
        ["name", "customer_name", "default_sales_partner"],
        as_dict=True,
    )
    if existing:
        return existing

    price_list = (
        frappe.db.get_value("Price List", {"selling": 1, "enabled": 1, "bfel_company": company}, "name")
        or frappe.db.get_value("Price List", {"selling": 1, "enabled": 1}, "name")
        or ""
    )

    doc = frappe.new_doc("Customer")
    doc.customer_name = "Consumidor Final"
    doc.customer_type = "Individual"
    doc.customer_group = (
        frappe.db.get_value("Customer Group", {"is_group": 0}, "name", order_by="lft asc")
        or "All Customer Groups"
    )
    doc.territory = (
        frappe.db.get_value("Territory", {"is_group": 0}, "name", order_by="lft asc")
        or "All Territories"
    )
    doc.default_price_list = price_list
    if doc.meta.has_field("bfel_company"):
        doc.bfel_company = company

    doc.insert(ignore_permissions=True)
    frappe.db.commit()

    return {"name": doc.name, "customer_name": doc.customer_name, "default_sales_partner": doc.default_sales_partner or ""}
