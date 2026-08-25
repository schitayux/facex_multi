"""
facex_multi.api.item_relations
--------------------------------
Relaciones entre artículos independientes en inventario:
- "Par": productos que normalmente se venden juntos (ej. amortiguador
  derecho/izquierdo). Se sugiere automáticamente al agregar uno a la venta.
- "Alternativo": producto sustituto equivalente (ej. sin existencia del
  original, ofrecer la marca genérica). Acceso rápido con F7 en FacEx /
  FacEx Screen sobre la fila activa.

Además, búsqueda dedicada (F8) por "palabras de búsqueda" (custom field
Item.custom_facex_palabras_busqueda): alias/números de referencia/nombres
alternos con los que un cajero puede reconocer el producto.

No hay enforcement server-side al guardar documentos — esto es una ayuda de
UX al armar la venta, no una restricción de permisos.
"""
from __future__ import annotations

import frappe
from facex_multi.api.invoice import has_efast_permission, get_effective_company
from facex_multi.api.permissions import get_facex_permissions_for_company
from facex_multi.api.item import _get_selling_price_list


def _check_modify_items_permission(company: str) -> None:
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    perms = get_facex_permissions_for_company(company)
    if not perms.get("modifica_items"):
        frappe.throw("No tiene permiso para modificar relaciones de productos.", frappe.PermissionError)


@frappe.whitelist()
def get_item_relations(item_code: str, tipo: str = None):
    """
    Relaciones (Par/Alternativo) del artículo, vistas desde su perspectiva:
    incluye filas donde item_code = X, y filas donde item_relacionado = X
    con two_way=1 (la relación aplica en ambos sentidos).
    """
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    if not item_code:
        return []

    conditions = ["(r.item_code = %(item_code)s OR (r.item_relacionado = %(item_code)s AND r.two_way = 1))"]
    values = {"item_code": item_code}
    if tipo:
        conditions.append("r.tipo = %(tipo)s")
        values["tipo"] = tipo

    rows = frappe.db.sql(
        f"""
        SELECT
            r.name,
            r.tipo,
            r.two_way,
            r.item_code,
            r.item_relacionado,
            CASE WHEN r.item_code = %(item_code)s THEN r.item_relacionado ELSE r.item_code END AS other_item_code
        FROM `tabFacEx Item Relacion` r
        WHERE {" AND ".join(conditions)}
        ORDER BY r.tipo ASC, r.creation ASC
        """,
        values,
        as_dict=True,
    )
    if not rows:
        return []

    other_codes = list({r.other_item_code for r in rows})
    items = frappe.get_all(
        "Item",
        filters={"name": ["in", other_codes]},
        fields=["name", "item_name", "image", "disabled"],
    )
    items_by_code = {i.name: i for i in items}

    result = []
    for r in rows:
        item = items_by_code.get(r.other_item_code)
        if not item:
            continue
        result.append({
            "name": r.name,
            "tipo": r.tipo,
            "two_way": int(r.two_way or 0),
            "item_code": r.other_item_code,
            "item_name": item.item_name,
            "image": item.image or "",
            "disabled": int(item.disabled or 0),
        })
    return result


@frappe.whitelist()
def get_item_pair_suggestion(item_code: str):
    """Primer 'Par' configurado para item_code, para el aviso automático al
    agregar el artículo a la venta. None/{} si no hay ninguno."""
    if not item_code:
        return {}
    relations = get_item_relations(item_code, tipo="Par")
    active = [r for r in relations if not r.get("disabled")]
    return active[0] if active else {}


@frappe.whitelist()
def add_item_relation(item_code: str, item_relacionado: str, tipo: str, two_way: int = 1, company: str = None):
    company = get_effective_company(company)
    _check_modify_items_permission(company)

    doc = frappe.get_doc({
        "doctype": "FacEx Item Relacion",
        "item_code": item_code,
        "item_relacionado": item_relacionado,
        "tipo": tipo,
        "two_way": int(two_way or 0),
    })
    doc.insert(ignore_permissions=True)
    frappe.db.commit()
    return {"name": doc.name}


@frappe.whitelist()
def remove_item_relation(name: str, company: str = None):
    company = get_effective_company(company)
    _check_modify_items_permission(company)

    if not frappe.db.exists("FacEx Item Relacion", name):
        return {"deleted": False}
    frappe.delete_doc("FacEx Item Relacion", name, ignore_permissions=True)
    frappe.db.commit()
    return {"deleted": True}


@frappe.whitelist()
def search_items_by_keywords(txt: str = "", company: str = None):
    """
    Búsqueda dedicada (F8): LIKE sobre custom_facex_palabras_busqueda, con
    fallback a item_code/item_name si el texto no matchea ninguna palabra
    clave, para que la ventana siga siendo útil como buscador general.
    Mismo shape que get_pos_items (item.py) para compartir el mismo render
    de resultados en el picker.
    """
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)

    company = get_effective_company(company)
    txt = (txt or "").strip()
    if len(txt) < 2:
        return []
    q = f"%{txt}%"
    price_list = _get_selling_price_list()

    company_cond = (
        "(i.bfel_company = %(company)s OR ((i.bfel_company IS NULL OR i.bfel_company = '') "
        "AND IFNULL(i.bfel_company_null, 0) = 0))"
    )

    rows = frappe.db.sql(
        f"""
        SELECT
            i.name AS item_code,
            i.item_name,
            i.item_group,
            i.stock_uom,
            i.image AS image_url,
            i.is_stock_item,
            i.has_serial_no,
            IFNULL(i.custom_tiene_adenda, 0) AS custom_tiene_adenda,
            i.custom_facex_palabras_busqueda AS matched_keywords,
            (i.custom_facex_palabras_busqueda LIKE %(q)s) AS matched_by_keyword,
            ip.price_list_rate AS rate,
            IFNULL(bn.stock_qty, 0) AS stock_qty
        FROM `tabItem` i
        LEFT JOIN `tabItem Price` ip
            ON ip.item_code = i.name
           AND ip.price_list = %(price_list)s
           AND ip.selling = 1
        LEFT JOIN (
            SELECT b.item_code, SUM(b.actual_qty) AS stock_qty
            FROM `tabBin` b
            JOIN `tabWarehouse` w ON w.name = b.warehouse
            WHERE w.company = %(company)s AND w.is_group = 0 AND w.disabled = 0
            GROUP BY b.item_code
        ) bn ON bn.item_code = i.name
        WHERE i.disabled = 0
          AND {company_cond}
          AND (
              i.custom_facex_palabras_busqueda LIKE %(q)s
              OR i.name LIKE %(q)s
              OR i.item_name LIKE %(q)s
          )
        ORDER BY matched_by_keyword DESC, i.item_name ASC
        LIMIT 50
        """,
        {"q": q, "company": company, "price_list": price_list},
        as_dict=True,
    )
    for r in rows:
        r["is_stock_item"] = int(r.get("is_stock_item") or 0)
        r["has_serial_no"] = int(r.get("has_serial_no") or 0)
        r["custom_tiene_adenda"] = int(r.get("custom_tiene_adenda") or 0)
        r["matched_by_keyword"] = int(r.get("matched_by_keyword") or 0)
        r["rate"] = float(r.get("rate") or 0)
        r["stock_qty"] = float(r.get("stock_qty") or 0)
    return rows
