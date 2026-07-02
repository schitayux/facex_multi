"""
facex_multi.api.item
-------------------
Búsqueda, creación y actualización rápida de productos y precios para la sección de Mantenimiento.
"""
from __future__ import annotations

import frappe
import json
from facex_multi.api.invoice import has_efast_permission, get_effective_company


def _get_selling_price_list():
    plist = (
        frappe.defaults.get_user_default("selling_price_list")
        or frappe.db.get_single_value("Selling Settings", "selling_price_list")
    )
    if not plist:
        if frappe.db.exists("Price List", "Standard Selling"):
            plist = "Standard Selling"
        else:
            plist = frappe.db.get_value("Price List", {"selling": 1, "enabled": 1}, "name") or ""
    return plist


@frappe.whitelist()
def get_price_lists(company: str = None):
    """Retorna todas las listas de precios activas (compras/ventas) de ERPNext filtradas por compañía."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)

    return frappe.db.sql(
        """
        SELECT name, currency, selling, buying
        FROM `tabPrice List`
        WHERE enabled = 1
          AND (
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
        ORDER BY name ASC
        """,
        {"company": company},
        as_dict=True,
    )


@frappe.whitelist()
def search_items(txt: str = None, company: str = None):
    """Busca ítems por código o nombre filtrados por compañía activa."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)

    if txt and len(txt.strip()) >= 2:
        q = f"%{txt.strip()}%"
        rows = frappe.db.sql(
            """
            SELECT name, item_code, item_name, stock_uom, description
            FROM `tabItem`
            WHERE disabled = 0
              AND (
                  bfel_company = %(company)s
                  OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
              )
              AND (name LIKE %(q)s OR item_name LIKE %(q)s)
            ORDER BY item_name ASC
            LIMIT 50
            """,
            {"q": q, "company": company},
            as_dict=True,
        )
        return rows
    else:
        return frappe.db.sql(
            """
            SELECT name, item_code, item_name, stock_uom, description
            FROM `tabItem`
            WHERE disabled = 0
              AND (
                  bfel_company = %(company)s
                  OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
              )
            ORDER BY item_name ASC
            LIMIT 50
            """,
            {"company": company},
            as_dict=True,
        )


@frappe.whitelist()
def get_item(name: str, price_list: str = None, company: str = None):
    """Obtiene los detalles de un ítem y su precio con validación de compañía."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    doc = frappe.get_doc("Item", name)
    
    if doc.meta.has_field("bfel_company") and doc.bfel_company and doc.bfel_company != company:
        frappe.throw(f"El producto '{name}' pertenece a otra compañía y no puede ser accedido.")

    plist = price_list or _get_selling_price_list()
    
    # Obtener el precio estándar de la lista activa
    price = frappe.db.get_value(
        "Item Price",
        {"item_code": name, "price_list": plist},
        "price_list_rate"
    ) or 0.0

    return {
        "item_code": doc.name,
        "item_name": doc.item_name or "",
        "description": doc.description or "",
        "stock_uom": doc.stock_uom or "Nos",
        "item_group": doc.item_group or "",
        "standard_price": float(price)
    }


@frappe.whitelist()
def create_or_update_item(data_json: str, company: str = None):
    """Crea o actualiza un producto asignando y protegiendo bfel_company."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    data = json.loads(data_json) if isinstance(data_json, str) else data_json
    item_code = (data.get("item_code") or "").strip()
    company = get_effective_company(company)
    abbr = frappe.db.get_value("Company", company, "abbr") or ""

    is_new = True
    if item_code and frappe.db.exists("Item", item_code):
        doc = frappe.get_doc("Item", item_code)
        if doc.meta.has_field("bfel_company") and doc.bfel_company and doc.bfel_company != company:
            frappe.throw("No tiene permisos para modificar un producto de otra compañía.")
        is_new = False
    else:
        auto_code = int(data.get("auto_code") or 0)
        if auto_code:
            # Generar código automático: AXXX-ABBR
            # Encontrar el correlativo XXX más alto para esta compañía y abreviatura
            like_pattern = f"A%-{abbr}"
            latest_items = frappe.db.sql(
                """
                SELECT name 
                FROM `tabItem` 
                WHERE name LIKE %(pattern)s AND bfel_company = %(company)s
                ORDER BY name DESC
                """,
                {"pattern": like_pattern, "company": company},
                as_dict=True
            )
            
            next_num = 1
            if latest_items:
                max_num = 0
                for it in latest_items:
                    code_str = it["name"]
                    if code_str.endswith(f"-{abbr}"):
                        num_part = code_str[:-len(f"-{abbr}")]
                        if num_part.startswith("A") and num_part[1:].isdigit():
                            num = int(num_part[1:])
                            if num > max_num:
                                max_num = num
                next_num = max_num + 1
            
            item_code = f"A{next_num:03d}-{abbr}"
        else:
            # Código personalizado. Forzar sufijo: -.ABBR
            if abbr and not item_code.endswith(f"-{abbr}"):
                item_code = f"{item_code}-{abbr}"
        
        if not item_code:
            frappe.throw("El código de producto es obligatorio.")

        if frappe.db.exists("Item", item_code):
            frappe.throw(f"El producto con código '{item_code}' ya existe.")

        doc = frappe.new_doc("Item")
        doc.item_code = item_code
        doc.item_group = (
            frappe.db.get_value("Item Group", {"is_group": 0}, "name", order_by="lft asc")
            or "All Item Groups"
        )
        doc.is_stock_item = 0
        if doc.meta.has_field("bfel_company"):
            doc.bfel_company = company

    doc.item_name = data.get("item_name", doc.item_name)
    doc.description = doc.item_name
    doc.stock_uom = data.get("stock_uom") or doc.stock_uom or "Nos"
    doc.item_group = data.get("item_group") or doc.item_group

    # Forzar bfel_company
    if doc.meta.has_field("bfel_company"):
        doc.bfel_company = company

    doc.save(ignore_permissions=False)
    frappe.db.commit()

    # Si se especificó un precio y lista de precios, actualizarlo/crearlo
    price_val = data.get("standard_price")
    price_list = data.get("price_list") or _get_selling_price_list()
    if price_val is not None:
        update_item_price(doc.name, price_val, price_list, company)

    return {"item_code": doc.name, "item_name": doc.item_name}


@frappe.whitelist()
def get_all_prices(price_list: str, txt: str = None, company: str = None):
    """Obtiene una lista de productos filtrados por compañía con sus precios."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    
    txt_filter = f"AND item_name LIKE %(txt)s" if txt else ""
    items = frappe.db.sql(
        f"""
        SELECT name, item_name, stock_uom
        FROM `tabItem`
        WHERE disabled = 0
          AND (
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
          {txt_filter}
        LIMIT 50
        """,
        {"company": company, "txt": f"%{txt}%" if txt else ""},
        as_dict=True,
    )
    
    # Obtener moneda de la lista de precios
    currency = frappe.db.get_value("Price List", price_list, "currency") or "GTQ"

    res = []
    for it in items:
        price = frappe.db.get_value(
            "Item Price",
            {"item_code": it["name"], "price_list": price_list},
            "price_list_rate"
        ) or 0.0
        res.append({
            "item_code": it["name"],
            "item_name": it["item_name"],
            "stock_uom": it["stock_uom"],
            "price": float(price),
            "currency": currency
        })
    return res


@frappe.whitelist()
def update_item_price(item_code: str, rate: float | str, price_list: str, company: str = None):
    """Crea o actualiza el registro de Item Price validando que el ítem pertenece a la compañía."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    item_comp = frappe.db.get_value("Item", item_code, "bfel_company")
    if item_comp and item_comp != company:
        frappe.throw("No se puede asignar precio a un producto de otra compañía.")

    rate_val = float(rate)
    price_name = frappe.db.get_value(
        "Item Price",
        {"item_code": item_code, "price_list": price_list},
        "name"
    )

    if price_name:
        price_doc = frappe.get_doc("Item Price", price_name)
        price_doc.price_list_rate = rate_val
        price_doc.save(ignore_permissions=False)
    else:
        price_doc = frappe.new_doc("Item Price")
        price_doc.item_code = item_code
        price_doc.price_list = price_list
        price_doc.price_list_rate = rate_val
        price_doc.insert(ignore_permissions=False)

    frappe.db.commit()
    return {"item_code": item_code, "rate": rate_val}


@frappe.whitelist()
def get_customers_list(txt: str = None, company: str = None):
    """Obtiene una lista de clientes filtrada por compañía para el catálogo."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    
    txt_filter = "AND customer_name LIKE %(txt)s" if txt else ""
    res = frappe.db.sql(
        f"""
        SELECT name, customer_name, tax_id, bfel_id_receptor
        FROM `tabCustomer`
        WHERE disabled = 0
          AND (
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
          {txt_filter}
        ORDER BY customer_name ASC
        LIMIT 50
        """,
        {"company": company, "txt": f"%{txt}%" if txt else ""},
        as_dict=True,
    )
    for r in res:
        nit = r.get("bfel_id_receptor") or r.get("tax_id") or ""
        r["tax_id"] = nit
        r["bfel_id_receptor"] = nit
    return res


@frappe.whitelist()
def delete_item(item_code: str, company: str = None):
    """Elimina de forma segura un ítem validando compañía activa."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    item_comp = frappe.db.get_value("Item", item_code, "bfel_company")
    if item_comp and item_comp != company:
        frappe.throw("No puede eliminar un producto de otra compañía.")

    frappe.delete_doc("Item", item_code)
    frappe.db.commit()
    return {"success": True}


@frappe.whitelist()
def delete_customer(customer_name: str, company: str = None):
    """Elimina de forma segura un cliente validando compañía activa."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    cust_comp = frappe.db.get_value("Customer", customer_name, "bfel_company")
    if cust_comp and cust_comp != company:
        frappe.throw("No puede eliminar un cliente de otra compañía.")

    frappe.delete_doc("Customer", customer_name)
    frappe.db.commit()
    return {"success": True}


def sync_description_from_item_name(doc, method=None):
    """Hook Item.before_save: mantiene description = item_name para ítems FEL."""
    if getattr(doc, "bfel_company", None):
        doc.description = doc.item_name or doc.description
