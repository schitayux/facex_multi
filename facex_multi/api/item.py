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
        "item_code":    doc.name,
        "item_name":    doc.item_name or "",
        "description":  doc.description or "",
        "stock_uom":    doc.stock_uom or "Nos",
        "item_group":   doc.item_group or "",
        "has_serial_no":  int(doc.has_serial_no or 0),
        "has_batch_no":   int(doc.has_batch_no or 0),
        "is_stock_item":  int(doc.is_stock_item or 0),
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

    gestionado_por = (data.get("gestionado_por") or "General").strip()
    if gestionado_por == "Serie":
        doc.has_serial_no = 1
        doc.has_batch_no  = 0
        doc.is_stock_item = 1
    elif gestionado_por == "Lote":
        doc.has_serial_no = 0
        doc.has_batch_no  = 1
        doc.is_stock_item = 1
    else:
        doc.has_serial_no = 0
        doc.has_batch_no  = 0
        if "is_stock_item" in data:
            doc.is_stock_item = int(data.get("is_stock_item") or 0)

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
def get_pos_item_groups(company: str = None):
    """Devuelve los Item Group con al menos un producto activo visible para la compañía, con conteo.
    Alimenta la barra de categorías de la pantalla POS (facex-screen)."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)

    return frappe.db.sql(
        """
        SELECT item_group, COUNT(*) AS item_count
        FROM `tabItem`
        WHERE disabled = 0
          AND item_group IS NOT NULL AND item_group != ''
          AND (
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
        GROUP BY item_group
        ORDER BY item_group ASC
        """,
        {"company": company},
        as_dict=True,
    )


@frappe.whitelist()
def get_pos_items(company: str = None, item_group: str = None, txt: str = None, warehouse: str = None):
    """Bulk: productos para la grilla de tarjetas de la pantalla POS (facex-screen).
    A diferencia de search_items/get_all_prices, trae item_group, imagen y precio
    en una sola consulta (sin N+1) para poder poblar el grid completo de un jalón.

    Si se pasa `warehouse`, `stock_qty` refleja las existencias de esa bodega
    específica; si no, se suman todas las bodegas de la compañía (señal
    informativa cuando el usuario no tiene bodega por defecto configurada)."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    price_list = _get_selling_price_list()

    conditions = [
        "i.disabled = 0",
        "(i.bfel_company = %(company)s OR ((i.bfel_company IS NULL OR i.bfel_company = '') "
        "AND IFNULL(i.bfel_company_null, 0) = 0))",
    ]
    values = {"company": company, "price_list": price_list}

    if item_group:
        conditions.append("i.item_group = %(item_group)s")
        values["item_group"] = item_group

    if txt and txt.strip():
        conditions.append("(i.name LIKE %(txt)s OR i.item_name LIKE %(txt)s)")
        values["txt"] = f"%{txt.strip()}%"

    where_clause = " AND ".join(conditions)

    if warehouse:
        # JOIN a Warehouse (no solo WHERE por nombre) para que, aun si la bodega
        # por defecto quedara mal configurada apuntando a otra compañía, nunca
        # se filtre/muestre stock que no pertenece a la compañía activa.
        bin_join = """
        LEFT JOIN (
            SELECT b.item_code, SUM(b.actual_qty) AS stock_qty
            FROM `tabBin` b
            JOIN `tabWarehouse` w ON w.name = b.warehouse
            WHERE b.warehouse = %(warehouse)s AND w.company = %(company)s
            GROUP BY b.item_code
        ) bn ON bn.item_code = i.name
        """
        values["warehouse"] = warehouse
    else:
        bin_join = """
        LEFT JOIN (
            SELECT b.item_code, SUM(b.actual_qty) AS stock_qty
            FROM `tabBin` b
            JOIN `tabWarehouse` w ON w.name = b.warehouse
            WHERE w.company = %(company)s AND w.is_group = 0 AND w.disabled = 0
            GROUP BY b.item_code
        ) bn ON bn.item_code = i.name
        """

    rows = frappe.db.sql(
        f"""
        SELECT
            i.name AS item_code,
            i.item_name,
            i.item_group,
            i.stock_uom,
            COALESCE(i.image, f.file_url) AS image_url,
            i.has_serial_no,
            i.is_stock_item,
            IFNULL(i.custom_tiene_adenda, 0) AS custom_tiene_adenda,
            ip.price_list_rate AS rate,
            IFNULL(bn.stock_qty, 0) AS stock_qty,
            IFNULL(bc.barcodes, '') AS barcodes
        FROM `tabItem` i
        LEFT JOIN `tabItem Price` ip
            ON ip.item_code = i.name
           AND ip.price_list = %(price_list)s
           AND ip.selling = 1
        LEFT JOIN (
            SELECT attached_to_name, file_url,
                   ROW_NUMBER() OVER (PARTITION BY attached_to_name ORDER BY creation ASC) AS rn
            FROM `tabFile`
            WHERE attached_to_doctype = 'Item'
              AND (file_name LIKE '%%.png' OR file_name LIKE '%%.jpg' OR file_name LIKE '%%.jpeg')
        ) f ON f.attached_to_name = i.name AND f.rn = 1
        LEFT JOIN (
            SELECT parent, GROUP_CONCAT(barcode SEPARATOR ' ') AS barcodes
            FROM `tabItem Barcode`
            GROUP BY parent
        ) bc ON bc.parent = i.name
        {bin_join}
        WHERE {where_clause}
        ORDER BY i.item_name ASC
        LIMIT 1500
        """,
        values,
        as_dict=True,
    )

    for r in rows:
        r["rate"] = float(r.get("rate") or 0)
        r["has_serial_no"] = int(r.get("has_serial_no") or 0)
        r["is_stock_item"] = int(r.get("is_stock_item") or 0)
        r["custom_tiene_adenda"] = int(r.get("custom_tiene_adenda") or 0)
        r["stock_qty"] = float(r.get("stock_qty") or 0)

    return rows


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
        SELECT name, customer_name, tax_id, bfel_id_receptor, default_sales_partner
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


@frappe.whitelist()
def get_item_images(item_code: str):
    """Retorna las imágenes (png/jpg/jpeg) adjuntas a un producto, incluyendo su imagen principal."""
    if not item_code or not frappe.db.exists("Item", item_code):
        return []

    if not frappe.has_permission("Item", ptype="read", doc=item_code):
        frappe.throw("No tiene permisos para ver este producto.", frappe.PermissionError)

    exts = (".png", ".jpg", ".jpeg")
    files = frappe.get_all(
        "File",
        filters={"attached_to_doctype": "Item", "attached_to_name": item_code},
        fields=["name", "file_name", "file_url", "is_private"],
        order_by="creation asc",
    )
    images = [f for f in files if (f.file_name or "").lower().endswith(exts)]

    main_image = frappe.db.get_value("Item", item_code, "image")
    if main_image and not any(img.file_url == main_image for img in images):
        images.insert(0, {
            "name": None,
            "file_name": (main_image.rsplit("/", 1)[-1]),
            "file_url": main_image,
            "is_private": 0,
        })

    return images


@frappe.whitelist()
def delete_item_image(item_code: str, file_name: str = None):
    """Elimina una imagen adjunta del producto (o limpia la imagen principal si no tiene File propio)."""
    if not item_code or not frappe.db.exists("Item", item_code):
        frappe.throw("Producto no encontrado.")

    if not frappe.has_permission("Item", ptype="write", doc=item_code):
        frappe.throw("No tiene permisos para modificar este producto.", frappe.PermissionError)

    if file_name and frappe.db.exists("File", file_name):
        f = frappe.get_doc("File", file_name)
        if f.attached_to_doctype != "Item" or f.attached_to_name != item_code:
            frappe.throw("El archivo no pertenece a este producto.")
        file_url = f.file_url
        frappe.delete_doc("File", file_name, ignore_permissions=False)
        if frappe.db.get_value("Item", item_code, "image") == file_url:
            frappe.db.set_value("Item", item_code, "image", None)
    else:
        frappe.db.set_value("Item", item_code, "image", None)

    frappe.db.commit()
    return {"success": True}


def sync_description_from_item_name(doc, method=None):
    """Hook Item.before_save: mantiene description = item_name para ítems FEL."""
    if getattr(doc, "bfel_company", None):
        doc.description = doc.item_name or doc.description
