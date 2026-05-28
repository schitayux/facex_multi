"""
facex_multi.api.item
-------------------
Búsqueda, creación y actualización rápida de productos y precios para la sección de Mantenimiento.
"""
from __future__ import annotations

import frappe
import json
from facex_multi.api.invoice import has_efast_permission


def _get_selling_price_list():
    return (
        frappe.defaults.get_user_default("selling_price_list")
        or frappe.db.get_single_value("Selling Settings", "selling_price_list")
        or "Standard Selling"
    )


@frappe.whitelist()
def get_price_lists():
    """Retorna todas las listas de precios activas (compras/ventas) de ERPNext."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    return frappe.get_all(
        "Price List",
        filters={"enabled": 1},
        fields=["name", "currency", "selling", "buying"],
        order_by="name asc"
    )


@frappe.whitelist()
def search_items(txt: str = None):
    """Busca ítems por código o nombre de forma segura y parametrizada."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    filters = {"disabled": 0}
    if txt and len(txt.strip()) >= 2:
        q = f"%{txt.strip()}%"
        rows = frappe.db.sql(
            """
            SELECT name, item_code, item_name, stock_uom, description
            FROM `tabItem`
            WHERE disabled = 0
              AND (name LIKE %(q)s OR item_name LIKE %(q)s)
            ORDER BY item_name ASC
            LIMIT 50
            """,
            {"q": q},
            as_dict=True,
        )
        return rows
    else:
        return frappe.db.get_all(
            "Item",
            filters=filters,
            fields=["name", "item_code", "item_name", "stock_uom", "description"],
            limit=50,
            order_by="item_name asc"
        )


@frappe.whitelist()
def get_item(name: str, price_list: str = None):
    """Obtiene los detalles de un ítem y su precio en la lista especificada o activa."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    doc = frappe.get_doc("Item", name)
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
def create_or_update_item(data_json: str):
    """Crea o actualiza un producto con campos básicos."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    data = json.loads(data_json) if isinstance(data_json, str) else data_json
    item_code = (data.get("item_code") or "").strip()

    is_new = True
    if item_code and frappe.db.exists("Item", item_code):
        doc = frappe.get_doc("Item", item_code)
        is_new = False
    else:
        doc = frappe.new_doc("Item")
        doc.item_code = item_code
        # Valores por defecto para que sea válido en ERPNext estándar
        doc.item_group = (
            frappe.db.get_value("Item Group", {"is_group": 0}, "name", order_by="lft asc")
            or "All Item Groups"
        )
        doc.is_stock_item = 0

    doc.item_name = data.get("item_name", doc.item_name)
    doc.description = data.get("description", doc.description or doc.item_name)
    doc.stock_uom = data.get("stock_uom") or doc.stock_uom or "Nos"
    doc.item_group = data.get("item_group") or doc.item_group

    doc.save(ignore_permissions=False)
    frappe.db.commit()

    # Si se especificó un precio y lista de precios, actualizarlo/crearlo
    price_val = data.get("standard_price")
    price_list = data.get("price_list") or _get_selling_price_list()
    if price_val is not None:
        update_item_price(doc.name, price_val, price_list)

    return {"item_code": doc.name, "item_name": doc.item_name}


@frappe.whitelist()
def get_all_prices(price_list: str, txt: str = None):
    """Obtiene una lista de productos con su precio en la lista seleccionada."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    filters = {"disabled": 0}
    if txt:
        filters["item_name"] = ["like", f"%{txt}%"]

    items = frappe.db.get_all("Item", filters=filters, fields=["name", "item_name", "stock_uom"], limit=50)
    
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
def update_item_price(item_code: str, rate: float | str, price_list: str):
    """Crea o actualiza el registro de Item Price para una lista de precios específica."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

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
def get_customers_list(txt: str = None):
    """Obtiene una lista de clientes para poblar el catálogo de mantenimiento."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    filters = {"disabled": 0}
    if txt:
        filters["customer_name"] = ["like", f"%{txt}%"]

    res = frappe.get_all(
        "Customer",
        filters=filters,
        fields=["name", "customer_name", "tax_id", "bfel_id_receptor"],
        limit=50,
        order_by="customer_name asc"
    )
    for r in res:
        nit = r.get("bfel_id_receptor") or r.get("tax_id") or ""
        r["tax_id"] = nit
        r["bfel_id_receptor"] = nit
    return res


@frappe.whitelist()
def delete_item(item_code: str):
    """Elimina de forma segura un ítem de ERPNext."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    frappe.delete_doc("Item", item_code)
    frappe.db.commit()
    return {"success": True}


@frappe.whitelist()
def delete_customer(customer_name: str):
    """Elimina de forma segura un cliente de ERPNext."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    frappe.delete_doc("Customer", customer_name)
    frappe.db.commit()
    return {"success": True}
