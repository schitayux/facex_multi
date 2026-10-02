"""
facex_multi.api.purchase
------------------------
Mantenimiento de Proveedores del FacEx Clásico (pestaña Mantenimiento →
Proveedores).

Los documentos de compra se movieron a facex_multi.api.compras (page FacEx
Compras). Los nombres viejos se re-exportan al final para que un navegador
con el facex.js anterior en caché siga funcionando durante el despliegue.
"""
from __future__ import annotations
import frappe
import json

from facex_multi.api.compras.common import require_purchase as _require_purchase


@frappe.whitelist()
def search_suppliers_maint(txt: str = "", company: str = None) -> list:
    """Para el módulo de mantenimiento: retorna listado con tax_id."""
    from facex_multi.api.invoice import get_effective_company
    company = get_effective_company(company)
    results = frappe.db.sql(
        """
        SELECT name, supplier_name, tax_id
        FROM `tabSupplier`
        WHERE disabled = 0
          AND (name LIKE %(q)s OR supplier_name LIKE %(q)s OR tax_id LIKE %(q)s)
          AND (
              bfel_company = %(company)s
              OR (bfel_company IS NULL OR bfel_company = '')
          )
        ORDER BY supplier_name ASC
        LIMIT 30
        """,
        {"q": f"%{txt}%", "company": company},
        as_dict=True,
    )
    return [{"name": r.name, "supplier_name": r.supplier_name, "tax_id": r.tax_id or ""} for r in results]


@frappe.whitelist()
def search_suppliers_maintenance(company: str = None, start: int = 0, page_length: int = 15,
                                   nombre: str = None, codigo: str = None, nit: str = None,
                                   telefono: str = None, texto: str = None, filtro: str = None):
    """Búsqueda/paginación de proveedores para el Mantenimiento de Proveedores (modo
    búsqueda-primero, igual que search_customers_maintenance en customer.py). Cada
    parámetro filtra una columna distinta y se combinan con AND. Sin filtros, lista
    TODOS los proveedores de la compañía activa ("Ver todos"). Incluye deshabilitados
    para poder ubicarlos y reactivarlos/editarlos desde el mantenimiento.

    Retorna {"rows": [...], "total": N} para el paginador del popup."""
    company = _require_purchase(company, "puede_compras",
                                msg="No tiene permiso para consultar proveedores en FacEx.")

    conditions = []
    params = {"company": company}

    nombre = (nombre or "").strip()
    if nombre:
        conditions.append("supplier_name LIKE %(nombre)s")
        params["nombre"] = f"%{nombre}%"

    codigo = (codigo or "").strip()
    if codigo:
        conditions.append("name LIKE %(codigo)s")
        params["codigo"] = f"%{codigo}%"

    nit = (nit or "").strip()
    if nit:
        conditions.append("tax_id LIKE %(nit)s")
        params["nit"] = f"%{nit}%"

    telefono = (telefono or "").strip()
    if telefono:
        conditions.append("custom_telefono LIKE %(telefono)s")
        params["telefono"] = f"%{telefono}%"

    # Búsqueda libre del panel de Mantenimiento (cada palabra en alguno de estos campos)
    for i, t in enumerate([t for t in (texto or "").strip().split() if t][:6]):
        params[f"tx{i}"] = f"%{t}%"
        conditions.append(
            f"(supplier_name LIKE %(tx{i})s OR name LIKE %(tx{i})s OR tax_id LIKE %(tx{i})s "
            f"OR custom_telefono LIKE %(tx{i})s)"
        )

    if filtro == "activos":
        conditions.append("disabled = 0")
    elif filtro == "inactivos":
        conditions.append("disabled = 1")
    elif filtro == "sin_nit":
        conditions.append("IFNULL(tax_id, '') = ''")

    company_filter = "(bfel_company = %(company)s OR (bfel_company IS NULL OR bfel_company = ''))"
    where = " AND ".join([company_filter] + conditions)

    total = frappe.db.sql(f"SELECT COUNT(*) FROM `tabSupplier` WHERE {where}", params)[0][0]

    rows = frappe.db.sql(
        f"""
        SELECT name, supplier_name, tax_id, custom_telefono, custom_direccion, disabled
        FROM `tabSupplier`
        WHERE {where}
        ORDER BY supplier_name ASC
        LIMIT %(page_length)s OFFSET %(start)s
        """,
        {**params, "page_length": int(page_length), "start": int(start)},
        as_dict=True,
    )
    return {"rows": rows, "total": total}


@frappe.whitelist()
def export_suppliers_excel(names_json: str, company: str = None):
    """Exporta a Excel los proveedores marcados en el popup de resultados del
    Mantenimiento de Proveedores. Vuelve a filtrar por compañía activa por si el
    listado de nombres fue manipulado desde el cliente."""
    names = json.loads(names_json) if isinstance(names_json, str) else names_json
    if not names:
        frappe.throw("Debe seleccionar al menos un proveedor.")
    company = _require_purchase(company, "puede_compras",
                                msg="No tiene permiso para exportar proveedores en FacEx.")

    placeholders = ", ".join(["%s"] * len(names))
    rows = frappe.db.sql(
        f"""
        SELECT name, supplier_name, tax_id, custom_telefono, custom_direccion, disabled
        FROM `tabSupplier`
        WHERE name IN ({placeholders})
          AND (bfel_company = %s OR (bfel_company IS NULL OR bfel_company = ''))
        """,
        tuple(names) + (company,),
        as_dict=True,
    )

    from frappe.utils.xlsxutils import make_xlsx

    headers = ["Código", "Nombre", "NIT / ID Fiscal", "Teléfono", "Dirección", "Deshabilitado"]
    data = [headers]
    for r in rows:
        data.append([
            r.name, r.supplier_name or "", r.tax_id or "",
            r.custom_telefono or "", r.custom_direccion or "", "Sí" if r.disabled else "No",
        ])

    xlsx_file = make_xlsx(data, "Proveedores")
    frappe.response["filename"] = "proveedores.xlsx"
    frappe.response["filecontent"] = xlsx_file.getvalue()
    frappe.response["type"] = "binary"


@frappe.whitelist()
def get_supplier(name: str, company: str = None) -> dict:
    """Retorna los campos relevantes del proveedor para el formulario de mantenimiento."""
    company = _require_purchase(company, "puede_compras",
                                msg="No tiene permiso para consultar proveedores en FacEx.")
    doc = frappe.get_doc("Supplier", name)
    if doc.get("bfel_company") and doc.bfel_company != company:
        frappe.throw(f"El proveedor '{name}' pertenece a otra compañía.")
    return {
        "name":          doc.name,
        "supplier_name": doc.supplier_name or "",
        "tax_id":        doc.tax_id or "",
        "custom_direccion": doc.get("custom_direccion") or "",
        "custom_telefono":  doc.get("custom_telefono") or "",
        # Condición de pago por omisión del proveedor (campo nativo
        # Supplier.payment_terms): los documentos de compra nuevos la traen ya
        # puesta y de ahí calculan la fecha de vencimiento.
        "payment_terms":    doc.get("payment_terms") or "",
    }


@frappe.whitelist()
def create_or_update_supplier(data_json: str, company: str = None) -> dict:
    """Crea o actualiza un proveedor desde el mantenimiento FacEx."""
    data    = json.loads(data_json) if isinstance(data_json, str) else data_json
    name    = (data.get("name") or "").strip()
    company = _require_purchase(
        company,
        "modifica_proveedores" if name else "crea_proveedores",
        msg="No tiene permiso para %s proveedores en FacEx." % ("modificar" if name else "crear"),
    )

    if name:
        doc = frappe.get_doc("Supplier", name)
        if doc.get("bfel_company") and doc.bfel_company != company:
            frappe.throw("No tiene permisos para modificar un proveedor de otra compañía.")
    else:
        doc = frappe.new_doc("Supplier")
        doc.supplier_type  = "Company"
        doc.supplier_group = (
            frappe.db.get_value("Supplier Group", {"is_group": 0}, "name", order_by="lft asc")
            or "All Supplier Groups"
        )
        if doc.meta.has_field("bfel_company"):
            doc.bfel_company = company

    for field in ("supplier_name", "tax_id", "custom_direccion", "custom_telefono", "payment_terms"):
        if field in data:
            try:
                setattr(doc, field, data[field])
            except Exception:
                pass

    if doc.meta.has_field("bfel_company"):
        doc.bfel_company = company

    doc.save(ignore_permissions=False)
    frappe.db.commit()
    return {"name": doc.name, "supplier_name": doc.supplier_name}


@frappe.whitelist()
def list_payment_terms(company: str = None) -> list:
    """Condiciones de pago disponibles para la ficha del proveedor."""
    _require_purchase(company, "puede_compras",
                      msg="No tiene permiso para consultar proveedores en FacEx.")
    return frappe.get_all("Payment Terms Template", pluck="name", order_by="name asc")


# ---------------------------------------------------------------------------
# Alias de compatibilidad (endpoints movidos a facex_multi.api.compras)
# ---------------------------------------------------------------------------
from facex_multi.api.compras.common import get_compras_defaults as get_purchase_defaults  # noqa: E402,F401
from facex_multi.api.compras.facturas import (  # noqa: E402,F401
    cancel_purchase_invoice,
    get_purchase_invoice,
    get_purchase_list,
    get_purchase_tax_templates,
    process_purchase_excel,
    save_purchase_invoice,
    search_items,
    search_suppliers,
    submit_purchase_invoice,
)
