"""
facex_multi.api.item
-------------------
Búsqueda, creación y actualización rápida de productos y precios para la sección de Mantenimiento.
"""
from __future__ import annotations

import frappe
import json
from frappe.utils import flt, cint
from facex_multi.api.invoice import has_efast_permission, get_effective_company
from facex_multi.api.permissions import get_facex_permissions_for_company


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
def search_items_maintenance(company: str = None, start: int = 0, page_length: int = 15,
                               nombre: str = None, codigo: str = None, grupo: str = None):
    """Búsqueda/paginación de productos para el Mantenimiento de Productos (modo
    búsqueda-primero, igual que search_customers_maintenance en customer.py). Cada
    parámetro filtra una columna distinta y se combinan con AND. Sin filtros, lista
    TODOS los productos de la compañía activa ("Ver todos"). Incluye deshabilitados
    para poder ubicarlos y reactivarlos/editarlos desde el mantenimiento.

    Retorna {"rows": [...], "total": N} para el paginador del popup."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)

    conditions = []
    params = {"company": company}

    nombre = (nombre or "").strip()
    if nombre:
        conditions.append("item_name LIKE %(nombre)s")
        params["nombre"] = f"%{nombre}%"

    codigo = (codigo or "").strip()
    if codigo:
        conditions.append("name LIKE %(codigo)s")
        params["codigo"] = f"%{codigo}%"

    grupo = (grupo or "").strip()
    if grupo:
        conditions.append("item_group LIKE %(grupo)s")
        params["grupo"] = f"%{grupo}%"

    company_filter = """(
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )"""
    where = " AND ".join([company_filter] + conditions)

    total = frappe.db.sql(f"SELECT COUNT(*) FROM `tabItem` WHERE {where}", params)[0][0]

    rows = frappe.db.sql(
        f"""
        SELECT name, item_name, item_group, stock_uom, has_serial_no, has_batch_no,
               is_stock_item, disabled
        FROM `tabItem`
        WHERE {where}
        ORDER BY item_name ASC
        LIMIT %(page_length)s OFFSET %(start)s
        """,
        {**params, "page_length": int(page_length), "start": int(start)},
        as_dict=True,
    )
    for row in rows:
        row["gestionado_por"] = "Serie" if row.get("has_serial_no") else ("Lote" if row.get("has_batch_no") else "General")
    return {"rows": rows, "total": total}


@frappe.whitelist()
def export_items_excel(names_json: str, company: str = None):
    """Exporta a Excel los productos marcados en el popup de resultados del
    Mantenimiento de Productos. Vuelve a filtrar por compañía activa por si el
    listado de nombres fue manipulado desde el cliente."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    names = json.loads(names_json) if isinstance(names_json, str) else names_json
    if not names:
        frappe.throw("Debe seleccionar al menos un producto.")
    company = get_effective_company(company)

    placeholders = ", ".join(["%s"] * len(names))
    rows = frappe.db.sql(
        f"""
        SELECT name, item_name, item_group, stock_uom, has_serial_no, has_batch_no,
               is_stock_item, disabled
        FROM `tabItem`
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

    headers = ["Código", "Nombre", "Grupo de Artículos", "UOM", "Gestionado por", "Inventariable", "Deshabilitado"]
    data = [headers]
    for r in rows:
        gestionado = "Serie" if r.has_serial_no else ("Lote" if r.has_batch_no else "General")
        data.append([
            r.name, r.item_name or "", r.item_group or "", r.stock_uom or "",
            gestionado, "Sí" if r.is_stock_item else "No", "Sí" if r.disabled else "No",
        ])

    xlsx_file = make_xlsx(data, "Productos")
    frappe.response["filename"] = "productos.xlsx"
    frappe.response["filecontent"] = xlsx_file.getvalue()
    frappe.response["type"] = "binary"


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
        "standard_price": float(price),
        "costo_estandar": float(doc.get("custom_costo_estandar") or 0),
        "palabras_busqueda": doc.get("custom_facex_palabras_busqueda") or "",
    }


def _variantes_layout_teclado(txt: str):
    """Variantes de 'txt' para compensar el layout de teclado del lector de
    código de barras (modo teclado/HID) cuando no coincide con el del SO.

    El caso más común: lector configurado en layout US contra un SO en
    Español/Latinoamérica hace que el guion '-' llegue como comilla simple "'".
    """
    variantes = [txt]
    if "'" in txt:
        variantes.append(txt.replace("'", "-"))
    if "-" in txt:
        variantes.append(txt.replace("-", "'"))
    return variantes


@frappe.whitelist()
def find_item_by_code(txt: str, company: str = None):
    """Busca un único ítem por código de barras exacto o por código de producto exacto.

    Pensado para el escaneo con lector de código de barras / QR: a diferencia de
    search_items (que hace LIKE y puede devolver varias coincidencias), esta
    devuelve como máximo un resultado exacto, listo para agregar a la línea.
    """
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    txt = (txt or "").strip()
    if not txt:
        return None

    item_code = None
    for candidato in _variantes_layout_teclado(txt):
        item_code = frappe.db.get_value("Item Barcode", {"barcode": candidato}, "parent")
        if not item_code and frappe.db.exists("Item", candidato):
            item_code = candidato
        if item_code:
            break
    if not item_code:
        return None

    item = frappe.db.get_value(
        "Item", item_code,
        ["name", "disabled", "bfel_company"],
        as_dict=True,
    )
    if not item or item.disabled:
        return None
    if item.bfel_company and item.bfel_company != company:
        return None

    return get_item(item_code, company=company)


def _get_item_for_company(item_code: str, company: str):
    item = frappe.db.get_value("Item", item_code, ["name", "bfel_company"], as_dict=True)
    if not item:
        frappe.throw(f"El producto '{item_code}' no existe.")
    if item.bfel_company and item.bfel_company != company:
        frappe.throw(f"El producto '{item_code}' pertenece a otra compañía y no puede ser accedido.")
    return item


@frappe.whitelist()
def get_label_print_config(item_code: str, company: str = None):
    """Configuración de impresión de etiquetas (app eTIBA) para un producto."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    _get_item_for_company(item_code, company)

    try:
        from etiba.api.imprimir_etiquetas import obtener_formato_sugerido
    except ImportError:
        frappe.throw("La aplicación eTIBA no está instalada en este sitio.")

    sugerido = obtener_formato_sugerido(item_code)

    return {
        "formato_sugerido": sugerido.get("formato_sugerido"),
        "requiere_serie": sugerido.get("requiere_serie"),
        "print_service_url": frappe.db.get_single_value("Etiba Settings", "print_service_url")
            or "http://localhost:5001/ImpresionEtiquetas",
        "cantidad_por_defecto": cint(frappe.db.get_single_value("Etiba Settings", "cantidad_por_defecto")) or 1,
        "formatos": frappe.get_all(
            "Etiba Formato", filters={"activo": 1}, fields=["name", "lenguaje"], order_by="name asc"
        ),
    }


@frappe.whitelist()
def imprimir_etiqueta_item(item_code: str, formato: str, cantidad=1, company: str = None, serie: str = None):
    """Genera el ZPL/TSPL (vía eTIBA) para imprimir etiquetas de un producto.

    Usa 'serie' como identificador si el formato lo requiere (Número de Serie);
    de lo contrario usa el código de producto.
    """
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    _get_item_for_company(item_code, company)

    try:
        from etiba.api.imprimir_etiquetas import obtener_valores
    except ImportError:
        frappe.throw("La aplicación eTIBA no está instalada en este sitio.")

    identificador = serie or item_code
    return obtener_valores(identificador=identificador, formato=formato, codigo_producto=item_code, cantidad=cantidad)


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
    if doc.meta.has_field("custom_facex_palabras_busqueda") and "palabras_busqueda" in data:
        doc.custom_facex_palabras_busqueda = data.get("palabras_busqueda") or ""
    if doc.meta.has_field("custom_costo_estandar") and "costo_estandar" in data:
        doc.custom_costo_estandar = flt(data.get("costo_estandar") or 0)

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
def get_all_prices(price_list: str, txt: str = None, codigo: str = None, grupo: str = None, company: str = None):
    """Obtiene una lista de productos filtrados por compañía con sus precios, para el
    Mantenimiento de Precios. txt/codigo/grupo filtran nombre/código/grupo de artículos
    respectivamente y se combinan con AND — alimentan los campos de filtro en los
    encabezados de columna de esa pantalla."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)

    conditions = []
    params = {"company": company}

    txt = (txt or "").strip()
    if txt:
        conditions.append("item_name LIKE %(txt)s")
        params["txt"] = f"%{txt}%"

    codigo = (codigo or "").strip()
    if codigo:
        conditions.append("name LIKE %(codigo)s")
        params["codigo"] = f"%{codigo}%"

    grupo = (grupo or "").strip()
    if grupo:
        conditions.append("item_group LIKE %(grupo)s")
        params["grupo"] = f"%{grupo}%"

    company_filter = """(
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )"""
    where = " AND ".join(["disabled = 0", company_filter] + conditions)

    items = frappe.db.sql(
        f"""
        SELECT name, item_name, item_group, stock_uom
        FROM `tabItem`
        WHERE {where}
        ORDER BY item_name ASC
        LIMIT 200
        """,
        params,
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
            "item_group": it["item_group"] or "",
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
            IFNULL(i.bfel_es_lista_materiales, 0) AS is_lista_materiales,
            IFNULL(i.bfel_modo_stock_lista, '') AS modo_stock_lista,
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
        r["is_lista_materiales"] = int(r.get("is_lista_materiales") or 0)

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
def export_item_prices_excel(names_json: str, price_list: str, company: str = None):
    """Exporta a Excel los productos marcados en la grilla del Mantenimiento de
    Precios, con su precio vigente en la lista de precios activa. Vuelve a filtrar
    por compañía activa por si el listado de nombres fue manipulado desde el cliente."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    names = json.loads(names_json) if isinstance(names_json, str) else names_json
    if not names:
        frappe.throw("Debe seleccionar al menos un producto.")
    company = get_effective_company(company)

    placeholders = ", ".join(["%s"] * len(names))
    rows = frappe.db.sql(
        f"""
        SELECT name, item_name, item_group, stock_uom
        FROM `tabItem`
        WHERE name IN ({placeholders})
          AND (
              bfel_company = %s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
        ORDER BY item_name ASC
        """,
        tuple(names) + (company,),
        as_dict=True,
    )

    currency = frappe.db.get_value("Price List", price_list, "currency") or "GTQ"

    from frappe.utils.xlsxutils import make_xlsx

    headers = ["Código", "Nombre", "Grupo de Productos", "UOM", "Lista de Precios", "Precio", "Moneda"]
    data = [headers]
    for r in rows:
        price = frappe.db.get_value(
            "Item Price",
            {"item_code": r.name, "price_list": price_list},
            "price_list_rate"
        ) or 0.0
        data.append([r.name, r.item_name or "", r.item_group or "", r.stock_uom or "", price_list, float(price), currency])

    xlsx_file = make_xlsx(data, "Precios")
    frappe.response["filename"] = "precios.xlsx"
    frappe.response["filecontent"] = xlsx_file.getvalue()
    frappe.response["type"] = "binary"


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


# ---------------------------------------------------------------------------
# Listas de Materiales para venta (paquetes/kits) — módulo de Inventario
# ---------------------------------------------------------------------------
# Un ítem "padre" puede agrupar varios productos componentes en dos modos:
#   - Padre: el padre lleva stock propio (se carga vía Transformación, ver api/stock.py).
#   - Hijos: el padre es solo agrupador (is_stock_item=0); el stock vive en los
#     componentes. Para este modo NO se reinventa lógica de descuento de stock:
#     se sincroniza un Product Bundle nativo de ERPNext, cuyo mecanismo estándar
#     (packed_items en Sales Invoice) ya hace exactamente esto al vender.

def validate_lista_materiales(doc, method=None):
    """Hook Item.validate: valida la configuración de Lista de Materiales.
    El sync del Product Bundle (modo Hijos) se hace aparte en on_update, después
    de que este Item ya quedó escrito en BD — Product Bundle.validate() valida
    is_stock_item leyendo directo de la BD, no del doc en memoria."""
    if not doc.get("bfel_es_lista_materiales"):
        return

    modo = doc.get("bfel_modo_stock_lista")
    if modo not in ("Padre", "Hijos"):
        frappe.throw("Debe indicar el modo de manejo de stock (Padre o Hijos) de la Lista de Materiales.")

    rows = doc.get("bfel_lista_materiales_items") or []
    if not rows:
        frappe.throw("Debe agregar al menos un componente a la Lista de Materiales.")

    seen = set()
    for i, row in enumerate(rows, start=1):
        if not row.item_code:
            frappe.throw(f"Fila {i}: falta el producto componente.")
        if row.item_code == doc.name:
            frappe.throw(f"Fila {i}: un producto no puede ser componente de sí mismo.")
        if row.item_code in seen:
            frappe.throw(f"Fila {i}: el producto '{row.item_code}' está repetido.")
        seen.add(row.item_code)
        if flt(row.qty) <= 0:
            frappe.throw(f"Fila {i} ({row.item_code}): la cantidad debe ser mayor a cero.")
        if frappe.db.get_value("Item", row.item_code, "bfel_es_lista_materiales"):
            frappe.throw(
                f"Fila {i}: '{row.item_code}' es a su vez una Lista de Materiales; "
                "no se permiten kits anidados."
            )

    if modo == "Padre":
        _apply_stock_mode_flags(doc, {"is_stock_item": 1})
    else:  # Hijos
        _apply_stock_mode_flags(doc, {"is_stock_item": 0, "has_serial_no": 0, "has_batch_no": 0})


_STOCK_MODE_FIELD_LABELS = {
    "is_stock_item": "Es un Ítem de Inventario",
    "has_serial_no": "Maneja Número de Serie",
    "has_batch_no": "Maneja Número de Lote",
}


def _apply_stock_mode_flags(doc, desired: dict):
    """
    Aplica los flags de manejo de stock (is_stock_item / has_serial_no /
    has_batch_no) que exige el modo elegido de la Lista de Materiales —
    pero antes verifica que el ítem no tenga historial de transacciones
    incompatible con ese cambio.

    Por qué no basta con dejar que ERPNext lo bloquee solo: Item.validate()
    (que incluye su propio chequeo Item.cant_change()) corre ANTES que los
    hooks de doc_events como este — para cuando este hook se ejecuta, el
    valor viejo ya pasó ese chequeo sin ver el cambio que estamos por hacer,
    así que ERPNext nunca se entera y el guardado pasaría igual dejando el
    ítem en un estado inconsistente con su historial real. Por eso replicamos
    aquí, ANTES de tocar los campos, el mismo chequeo que usa
    Item.cant_change() (Item._get_linked_submitted_documents), reutilizando
    ese método nativo en vez de reinventar qué documentos cuentan como
    "historial".
    """
    if doc.is_new():
        doc.update(desired)
        return

    current = frappe.db.get_value("Item", doc.name, list(desired.keys()), as_dict=True) or {}
    changed_fields = [f for f in desired if cint(current.get(f)) != cint(desired[f])]

    if changed_fields:
        linked = doc._get_linked_submitted_documents(changed_fields)
        # El propio Product Bundle que este módulo sincroniza para el modo Hijos
        # (ver sync_lista_materiales_product_bundle) no cuenta como "historial":
        # es un espejo que este mismo código crea/deshabilita automáticamente,
        # no una transacción real — si lo dejamos, nunca se podría alternar de
        # modo un ítem que alguna vez estuvo en Hijos, aunque no tenga ventas
        # ni movimientos de inventario reales.
        if linked and linked.get("doctype") == "Product Bundle" and linked.get("docname") == doc.name:
            linked = None
        if linked:
            labels = ", ".join(_STOCK_MODE_FIELD_LABELS.get(f, f) for f in changed_fields)
            doc_ref = (
                f"{linked.get('doctype')} {linked.get('docname')}"
                if linked.get("docname")
                else linked.get("doctype")
            )
            frappe.throw(
                f"No se puede cambiar el modo de esta Lista de Materiales: el producto "
                f"'{doc.name}' ya tiene un documento registrado ({doc_ref}) que depende de "
                f"su configuración actual ({labels}). Cree un producto nuevo para usar este "
                f"modo en su lugar."
            )

    doc.update(desired)


def sync_lista_materiales_product_bundle(doc, method=None):
    """Hook Item.on_update: mantiene sincronizado un Product Bundle nativo cuando la
    Lista de Materiales está en modo 'Hijos', para que ERPNext descargue el stock de
    los componentes automáticamente al vender (packed_items en Sales Invoice)."""
    es_lista = bool(doc.get("bfel_es_lista_materiales"))
    modo = doc.get("bfel_modo_stock_lista")

    if not (es_lista and modo == "Hijos"):
        if frappe.db.exists("Product Bundle", doc.name):
            frappe.db.set_value("Product Bundle", doc.name, "disabled", 1)
        return

    rows = doc.get("bfel_lista_materiales_items") or []
    if frappe.db.exists("Product Bundle", doc.name):
        pb = frappe.get_doc("Product Bundle", doc.name)
        pb.set("items", [])
    else:
        pb = frappe.new_doc("Product Bundle")
        pb.new_item_code = doc.name

    pb.description = doc.item_name or doc.name
    pb.disabled = 0
    for row in rows:
        pb.append("items", {
            "item_code": row.item_code,
            "qty": row.qty,
            "uom": row.uom or frappe.db.get_value("Item", row.item_code, "stock_uom"),
        })
    pb.flags.ignore_permissions = True
    pb.save(ignore_permissions=True)


@frappe.whitelist()
def save_lista_materiales(item_code: str, modo_stock: str, items_json: str, company: str = None):
    """Crea/actualiza la configuración de Lista de Materiales (kit de venta) de un ítem
    existente. La validación de negocio y el sync del Product Bundle corren en los
    hooks de Item (validate_lista_materiales / sync_lista_materiales_product_bundle)."""
    company = get_effective_company(company)
    perms = get_facex_permissions_for_company(company)
    if not perms.get("gestiona_listas_materiales"):
        frappe.throw("No tiene permiso para gestionar Listas de Materiales.", frappe.PermissionError)

    if not item_code or not frappe.db.exists("Item", item_code):
        frappe.throw("Debe indicar un producto padre existente.")

    item_company = frappe.db.get_value("Item", item_code, "bfel_company")
    if item_company and item_company != company:
        frappe.throw(f"El producto '{item_code}' pertenece a otra compañía y no puede utilizarse aquí.")

    if modo_stock not in ("Padre", "Hijos"):
        frappe.throw("El modo de stock debe ser 'Padre' o 'Hijos'.")

    rows = frappe.parse_json(items_json) or []

    doc = frappe.get_doc("Item", item_code)
    doc.bfel_es_lista_materiales = 1
    doc.bfel_modo_stock_lista = modo_stock
    doc.set("bfel_lista_materiales_items", [])
    for row in rows:
        doc.append("bfel_lista_materiales_items", {
            "item_code": row.get("item_code"),
            "qty": flt(row.get("qty")),
        })
    doc.save(ignore_permissions=False)
    frappe.db.commit()

    return {"item_code": doc.name}


@frappe.whitelist()
def disable_lista_materiales(item_code: str, company: str = None):
    """Desmarca un ítem como Lista de Materiales (deja de ser kit; vuelve a ser un
    producto normal). No borra el historial: el Product Bundle asociado, si existía,
    queda deshabilitado (ver sync_lista_materiales_product_bundle)."""
    company = get_effective_company(company)
    perms = get_facex_permissions_for_company(company)
    if not perms.get("gestiona_listas_materiales"):
        frappe.throw("No tiene permiso para gestionar Listas de Materiales.", frappe.PermissionError)

    if not item_code or not frappe.db.exists("Item", item_code):
        frappe.throw("Producto no encontrado.")

    doc = frappe.get_doc("Item", item_code)
    doc.bfel_es_lista_materiales = 0
    doc.bfel_modo_stock_lista = ""
    doc.set("bfel_lista_materiales_items", [])
    doc.save(ignore_permissions=False)
    frappe.db.commit()

    return {"item_code": doc.name}


@frappe.whitelist()
def list_listas_materiales(company: str = None):
    """Lista los productos configurados como Lista de Materiales (kit de venta) de la
    compañía activa, para la pantalla de Inventario."""
    company = get_effective_company(company)
    perms = get_facex_permissions_for_company(company)
    if not perms.get("gestiona_listas_materiales"):
        frappe.throw("No tiene permiso para ver Listas de Materiales.", frappe.PermissionError)

    return frappe.db.sql(
        """
        SELECT name AS item_code, item_name, bfel_modo_stock_lista AS modo_stock, disabled
        FROM `tabItem`
        WHERE bfel_es_lista_materiales = 1
          AND (
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
        ORDER BY item_name ASC
        """,
        {"company": company},
        as_dict=True,
    )


@frappe.whitelist()
def search_listas_materiales_maintenance(company: str = None, start: int = 0, page_length: int = 15,
                                           nombre: str = None, codigo: str = None, modo: str = None):
    """Búsqueda/paginación de Listas de Materiales para su Mantenimiento (modo
    búsqueda-primero, igual que search_customers_maintenance en customer.py). Cada
    parámetro filtra una columna distinta y se combinan con AND. Sin filtros, lista
    TODAS las Listas de Materiales de la compañía activa ("Ver todas"). Incluye
    deshabilitadas para poder ubicarlas y reactivarlas/editarlas desde el mantenimiento.

    Retorna {"rows": [...], "total": N} para el paginador del popup."""
    company = get_effective_company(company)
    perms = get_facex_permissions_for_company(company)
    if not perms.get("gestiona_listas_materiales"):
        frappe.throw("No tiene permiso para ver Listas de Materiales.", frappe.PermissionError)

    conditions = ["bfel_es_lista_materiales = 1"]
    params = {"company": company}

    nombre = (nombre or "").strip()
    if nombre:
        conditions.append("item_name LIKE %(nombre)s")
        params["nombre"] = f"%{nombre}%"

    codigo = (codigo or "").strip()
    if codigo:
        conditions.append("name LIKE %(codigo)s")
        params["codigo"] = f"%{codigo}%"

    modo = (modo or "").strip()
    if modo:
        conditions.append("bfel_modo_stock_lista = %(modo)s")
        params["modo"] = modo

    company_filter = """(
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )"""
    where = " AND ".join([company_filter] + conditions)

    total = frappe.db.sql(f"SELECT COUNT(*) FROM `tabItem` WHERE {where}", params)[0][0]

    rows = frappe.db.sql(
        f"""
        SELECT name, item_name, bfel_modo_stock_lista AS modo_stock, disabled,
               (SELECT COUNT(*) FROM `tabFacEx Lista Materiales Item` c WHERE c.parent = `tabItem`.name) AS num_componentes
        FROM `tabItem`
        WHERE {where}
        ORDER BY item_name ASC
        LIMIT %(page_length)s OFFSET %(start)s
        """,
        {**params, "page_length": int(page_length), "start": int(start)},
        as_dict=True,
    )
    return {"rows": rows, "total": total}


@frappe.whitelist()
def export_listas_materiales_excel(names_json: str, company: str = None):
    """Exporta a Excel las Listas de Materiales marcadas en el popup de resultados de
    su Mantenimiento. Vuelve a filtrar por compañía activa por si el listado de
    nombres fue manipulado desde el cliente. Cada componente aparece en su propia fila
    bajo el mismo producto padre, para que el detalle quede legible en la hoja."""
    company = get_effective_company(company)
    perms = get_facex_permissions_for_company(company)
    if not perms.get("gestiona_listas_materiales"):
        frappe.throw("No tiene permiso para ver Listas de Materiales.", frappe.PermissionError)

    names = json.loads(names_json) if isinstance(names_json, str) else names_json
    if not names:
        frappe.throw("Debe seleccionar al menos una Lista de Materiales.")

    placeholders = ", ".join(["%s"] * len(names))
    rows = frappe.db.sql(
        f"""
        SELECT name, item_name, bfel_modo_stock_lista AS modo_stock, disabled
        FROM `tabItem`
        WHERE name IN ({placeholders})
          AND bfel_es_lista_materiales = 1
          AND (
              bfel_company = %s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
        ORDER BY item_name ASC
        """,
        tuple(names) + (company,),
        as_dict=True,
    )

    from frappe.utils.xlsxutils import make_xlsx

    headers = ["Código Padre", "Nombre Padre", "Modo de Stock", "Deshabilitado", "Componente", "Cantidad"]
    data = [headers]
    for r in rows:
        componentes = frappe.get_all(
            "FacEx Lista Materiales Item",
            filters={"parent": r.name},
            fields=["item_code", "qty"],
            order_by="idx asc",
        )
        base = [r.name, r.item_name or "", r.modo_stock or "", "Sí" if r.disabled else "No"]
        if not componentes:
            data.append(base + ["", ""])
        else:
            for c in componentes:
                data.append(base + [c.item_code, c.qty])

    xlsx_file = make_xlsx(data, "Listas de Materiales")
    frappe.response["filename"] = "listas_materiales.xlsx"
    frappe.response["filecontent"] = xlsx_file.getvalue()
    frappe.response["type"] = "binary"


@frappe.whitelist()
def get_lista_materiales_detail(item_code: str):
    """Detalle de componentes de una Lista de Materiales — usado tanto por la pantalla
    de edición en Inventario como por el popup de solo lectura en FacEx Clásico (POS).
    Sin gate de permiso de inventario a propósito: cualquiera que pueda ver el ítem en
    el POS debe poder ver de qué se compone."""
    if not item_code or not frappe.db.exists("Item", item_code):
        frappe.throw("Producto no encontrado.")

    doc = frappe.get_doc("Item", item_code)
    if not doc.get("bfel_es_lista_materiales"):
        return {"es_lista_materiales": 0, "modo_stock": "", "items": []}

    return {
        "es_lista_materiales": 1,
        "modo_stock": doc.get("bfel_modo_stock_lista") or "",
        "items": [
            {
                "item_code": row.item_code,
                "item_name": row.item_name,
                "qty": flt(row.qty),
                "uom": row.uom,
            }
            for row in (doc.get("bfel_lista_materiales_items") or [])
        ],
    }
