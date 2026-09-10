"""
facex_multi.api.familia
-----------------------
Familias de Precio: agrupador comercial más fino que el Grupo de Artículo
(tipo de prenda + audiencia + rango de talla), que comparte precio de venta
y costo entre todos sus SKU ("hijos").

- DocType «FacEx Familia de Precio» (registro/matriz de precios por lista).
- Custom field Item.custom_facex_familia (Link a la familia).
- Mantenimiento de Familias (FacEx Clásico / Inventario), con permisos
  consulta_familias / mantiene_familias en FacEx Settings.
- "Aplicar a la familia" en «Costos a Ítems» y «Precios»: asigna un valor a
  TODOS los ítems de la familia (server-side, ignora paginación) y sincroniza
  el registro de la familia.
- Al crear un ítem con familia se generan solos sus Item Price desde la matriz.
"""
from __future__ import annotations

import json

import frappe
from frappe.utils import flt, getdate, today

from facex_multi.api.invoice import get_effective_company, has_efast_permission
from facex_multi.api.permissions import (
    get_facex_can_maintain_familias,
    get_facex_can_maintain_item_costs,
    get_facex_can_view_familias,
    get_facex_requires_item_familia,
    require_facex_permission,
)


# ---------------------------------------------------------------------------
# Custom field + hook de validación en Item
# ---------------------------------------------------------------------------

def ensure_item_familia_field():
    """Crea/actualiza el custom field Item.custom_facex_familia. Idempotente."""
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    create_custom_fields(
        {
            "Item": [
                {
                    "fieldname": "custom_facex_familia",
                    "fieldtype": "Link",
                    "options": "FacEx Familia de Precio",
                    "label": "Familia",
                    "insert_after": "item_group",
                    "description": (
                        "Familia de Precio: agrupa a los SKU que comparten precio y "
                        "costo. Se administra en «Mantenimiento de Familias» de FacEx."
                    ),
                    "module": "FacEx Multi",
                }
            ],
        }
    )


def validate_item_familia(doc, method=None):
    """Hook Item.validate: exige Familia si la compañía del ítem tiene la política
    activada (`exige_familia_item`). Solo aplica a ítems FacEx (con bfel_company)."""
    company = getattr(doc, "bfel_company", None)
    if not company:
        return
    if not frappe.get_meta("Item").has_field("custom_facex_familia"):
        return
    if not get_facex_requires_item_familia(company):
        return
    if (doc.get("custom_facex_familia") or "").strip():
        _validate_familia_belongs(doc.custom_facex_familia, company)
        return
    frappe.throw(
        "Debe asignar una <b>Familia</b> al producto. "
        "La compañía exige Familia de Precio en todos los ítems."
    )


def _validate_familia_belongs(familia: str, company: str):
    row = frappe.db.get_value(
        "FacEx Familia de Precio", familia, ["bfel_company", "activa"], as_dict=True
    )
    if not row:
        frappe.throw(f"La familia «{familia}» no existe.")
    if row.bfel_company and row.bfel_company != company:
        frappe.throw(f"La familia «{familia}» pertenece a otra compañía.")


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------

def _require_feature():
    """El feature de Familias requiere el DocType sincronizado (bench migrate)."""
    if not frappe.db.table_exists("FacEx Familia de Precio"):
        frappe.throw("El módulo de Familias de Precio todavía no está disponible en este sitio.")


def _require_view(company: str):
    _require_feature()
    if not get_facex_can_view_familias(company):
        frappe.throw("No tiene permiso para ver las Familias de Precio.", frappe.PermissionError)


def _require_edit(company: str):
    _require_feature()
    if not get_facex_can_maintain_familias(company):
        frappe.throw("No tiene permiso para mantener las Familias de Precio.", frappe.PermissionError)


def _company_item_where(alias: str = "") -> str:
    p = f"{alias}." if alias else ""
    return (
        f"({p}bfel_company = %(company)s OR (({p}bfel_company IS NULL OR {p}bfel_company = '') "
        f"AND IFNULL({p}bfel_company_null, 0) = 0))"
    )


# ---------------------------------------------------------------------------
# Contexto / listado / detalle
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_familia_context(company: str = None):
    """Datos de arranque del Mantenimiento de Familias y de los pickers."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    _require_feature()
    company = get_effective_company(company)
    _require_view(company)

    from facex_multi.api.item import get_price_lists

    price_lists = [r for r in get_price_lists(company) if r.get("selling")]
    return {
        "company": company,
        "can_edit": int(get_facex_can_maintain_familias(company)),
        "price_lists": price_lists,
        "uoms": frappe.get_all("UOM", filters={"enabled": 1}, pluck="name", order_by="name"),
    }


@frappe.whitelist()
def search_familias(company: str = None, txt: str = None, solo_activas: int = 0,
                    start: int = 0, page_length: int = 20):
    """Listado paginado de familias de la compañía. `txt` filtra código o descripción."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    _require_feature()
    company = get_effective_company(company)
    _require_view(company)

    conditions = ["bfel_company = %(company)s"]
    params = {"company": company}
    txt = (txt or "").strip()
    if txt:
        conditions.append("(name LIKE %(txt)s OR descripcion LIKE %(txt)s)")
        params["txt"] = f"%{txt}%"
    if int(solo_activas or 0):
        conditions.append("activa = 1")
    where = " AND ".join(conditions)

    total = frappe.db.sql(
        f"SELECT COUNT(*) FROM `tabFacEx Familia de Precio` WHERE {where}", params
    )[0][0]
    rows = frappe.db.sql(
        f"""
        SELECT name AS familia, descripcion, uom, item_group, activa, costo_estandar
        FROM `tabFacEx Familia de Precio`
        WHERE {where}
        ORDER BY name ASC
        LIMIT %(page_length)s OFFSET %(start)s
        """,
        {**params, "page_length": int(page_length), "start": int(start)},
        as_dict=True,
    )
    # nº de ítems por familia (para la columna "hijos")
    if rows:
        names = [r["familia"] for r in rows]
        ph = ", ".join(["%s"] * len(names))
        counts = dict(
            frappe.db.sql(
                f"""SELECT custom_facex_familia, COUNT(*)
                    FROM `tabItem` WHERE custom_facex_familia IN ({ph})
                    GROUP BY custom_facex_familia""",
                tuple(names),
            )
        )
        for r in rows:
            r["items"] = int(counts.get(r["familia"], 0))
    return {"rows": rows, "total": total}


@frappe.whitelist()
def list_familia_codes(company: str = None, solo_activas: int = 1):
    """Códigos de familia de la compañía para los pickers de filtro en «Costos a
    Ítems» y «Precios». No requiere permiso de mantenimiento de familias."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    _require_feature()
    company = get_effective_company(company)
    if not frappe.db.table_exists("FacEx Familia de Precio"):
        return []
    filters = {"bfel_company": company}
    if int(solo_activas or 0):
        filters["activa"] = 1
    return frappe.get_all(
        "FacEx Familia de Precio", filters=filters,
        fields=["name as familia", "descripcion", "uom"], order_by="name asc",
    )


@frappe.whitelist()
def get_familia(name: str, company: str = None):
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    company = get_effective_company(company)
    _require_view(company)

    doc = frappe.get_doc("FacEx Familia de Precio", name)
    if doc.bfel_company and doc.bfel_company != company:
        frappe.throw("La familia pertenece a otra compañía.")
    return {
        "familia": doc.name,
        "descripcion": doc.descripcion or "",
        "bfel_company": doc.bfel_company,
        "uom": doc.uom or "",
        "item_group": doc.item_group or "",
        "activa": int(doc.activa or 0),
        "costo_estandar": flt(doc.costo_estandar),
        "precios": [
            {"price_list": p.price_list, "price_list_rate": flt(p.price_list_rate)}
            for p in doc.precios
        ],
        "items": frappe.db.count("Item", {"custom_facex_familia": doc.name}),
    }


@frappe.whitelist()
def create_or_update_familia(data_json: str, company: str = None):
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    company = get_effective_company(company)
    _require_edit(company)

    data = json.loads(data_json) if isinstance(data_json, str) else data_json
    familia = (data.get("familia") or "").strip()
    if not familia:
        frappe.throw("El código de la familia es obligatorio.")

    is_new = not frappe.db.exists("FacEx Familia de Precio", familia)
    if is_new:
        doc = frappe.new_doc("FacEx Familia de Precio")
        doc.familia = familia
    else:
        doc = frappe.get_doc("FacEx Familia de Precio", familia)
        if doc.bfel_company and doc.bfel_company != company:
            frappe.throw("La familia pertenece a otra compañía.")

    doc.bfel_company = company
    doc.descripcion = data.get("descripcion") or ""
    doc.uom = data.get("uom") or doc.uom
    doc.item_group = data.get("item_group") or None
    doc.activa = int(data.get("activa", 1) or 0)
    doc.costo_estandar = flt(data.get("costo_estandar") or 0)

    doc.set("precios", [])
    for row in data.get("precios") or []:
        if not row.get("price_list"):
            continue
        doc.append("precios", {
            "price_list": row["price_list"],
            "price_list_rate": flt(row.get("price_list_rate") or 0),
        })

    doc.save(ignore_permissions=False)
    frappe.db.commit()
    return {"familia": doc.name}


@frappe.whitelist()
def delete_familia(name: str, company: str = None):
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    company = get_effective_company(company)
    _require_edit(company)

    doc = frappe.get_doc("FacEx Familia de Precio", name)
    if doc.bfel_company and doc.bfel_company != company:
        frappe.throw("La familia pertenece a otra compañía.")
    doc.delete()  # on_trash bloquea si hay ítems asignados
    frappe.db.commit()
    return {"deleted": name}


# ---------------------------------------------------------------------------
# Miembros de la familia + aplicación en lote
# ---------------------------------------------------------------------------

def _familia_members(familia: str, company: str) -> list:
    """Todos los ítems (código) de la compañía con esa familia asignada."""
    return frappe.db.sql(
        f"""
        SELECT name AS item_code, item_name, stock_uom, disabled
        FROM `tabItem`
        WHERE custom_facex_familia = %(familia)s AND {_company_item_where()}
        ORDER BY name ASC
        """,
        {"familia": familia, "company": company},
        as_dict=True,
    )


@frappe.whitelist()
def get_familia_members(familia: str, company: str = None, price_list: str = None):
    """Resumen para el diálogo de confirmación de "Aplicar a la familia":
    cuántos ítems, cuántos deshabilitados, y (si se pasa price_list) cuántos ya
    tienen un precio distinto que se sobrescribirá."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    company = get_effective_company(company)

    fam = frappe.db.get_value(
        "FacEx Familia de Precio", familia, ["bfel_company", "uom", "activa"], as_dict=True
    )
    if not fam:
        frappe.throw(f"La familia «{familia}» no existe.")
    if fam.bfel_company and fam.bfel_company != company:
        frappe.throw("La familia pertenece a otra compañía.")

    members = _familia_members(familia, company)
    codes = [m["item_code"] for m in members]
    disabled = sum(1 for m in members if m["disabled"])
    uom_mismatch = [m["item_code"] for m in members if fam.uom and m["stock_uom"] != fam.uom]

    con_precio_distinto = []
    if price_list and codes:
        ph = ", ".join(["%s"] * len(codes))
        existing = frappe.db.sql(
            f"""SELECT item_code, price_list_rate FROM `tabItem Price`
                WHERE price_list = %s AND item_code IN ({ph})""",
            (price_list, *codes),
            as_dict=True,
        )
        con_precio_distinto = [e["item_code"] for e in existing]

    return {
        "familia": familia,
        "uom": fam.uom,
        "count": len(members),
        "disabled": disabled,
        "uom_mismatch": uom_mismatch,
        "con_precio_existente": con_precio_distinto,
    }


@frappe.whitelist()
def apply_familia_costo(familia: str, costo, company: str = None):
    """Asigna el Costo Estándar FacEx a TODOS los ítems de la familia y sincroniza
    el costo sugerido del registro de la familia."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    company = get_effective_company(company)
    if not get_facex_can_maintain_item_costs(company):
        frappe.throw("No tiene permiso para mantener los costos de ítems.", frappe.PermissionError)

    if not frappe.get_meta("Item").has_field("custom_costo_estandar"):
        frappe.throw("El campo Costo Estándar (custom_costo_estandar) no existe en Item.")

    costo = flt(costo)
    if costo < 0:
        frappe.throw("El costo no puede ser negativo.")

    fam = frappe.db.get_value("FacEx Familia de Precio", familia, ["bfel_company"], as_dict=True)
    if not fam:
        frappe.throw(f"La familia «{familia}» no existe.")
    if fam.bfel_company and fam.bfel_company != company:
        frappe.throw("La familia pertenece a otra compañía.")

    members = _familia_members(familia, company)
    for m in members:
        frappe.db.set_value("Item", m["item_code"], "custom_costo_estandar", costo, update_modified=False)
    frappe.db.set_value("FacEx Familia de Precio", familia, "costo_estandar", costo)
    frappe.db.commit()
    return {"familia": familia, "updated": [m["item_code"] for m in members], "costo": costo}


@frappe.whitelist()
def apply_familia_price(familia: str, price_list: str, rate, company: str = None,
                        valid_from: str = None):
    """Asigna un precio de venta a TODOS los ítems de la familia en UNA lista, con
    la UOM de la familia, y sincroniza la fila de esa lista en el registro."""
    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    company = get_effective_company(company)
    require_facex_permission(company, "actualiza_precios",
                             msg="No tiene permiso para actualizar precios en FacEx.")

    if not price_list:
        frappe.throw("Debe indicar una lista de precios.")
    rate = flt(rate)
    if rate < 0:
        frappe.throw("El precio no puede ser negativo.")

    from facex_multi.api.item import validate_price_list_company

    validate_price_list_company(price_list, company)

    fam = frappe.db.get_value(
        "FacEx Familia de Precio", familia, ["bfel_company", "uom"], as_dict=True
    )
    if not fam:
        frappe.throw(f"La familia «{familia}» no existe.")
    if fam.bfel_company and fam.bfel_company != company:
        frappe.throw("La familia pertenece a otra compañía.")

    vf = getdate(valid_from) if valid_from else getdate(today())
    members = _familia_members(familia, company)

    updated, errors = [], []
    for m in members:
        try:
            _upsert_item_price(m["item_code"], price_list, rate, fam.uom, vf)
            updated.append(m["item_code"])
        except Exception as e:  # noqa: BLE001
            errors.append({"item_code": m["item_code"], "error": str(e)})

    # sincroniza el registro de la familia
    doc = frappe.get_doc("FacEx Familia de Precio", familia)
    for p in doc.precios:
        if p.price_list == price_list:
            p.price_list_rate = rate
            break
    else:
        doc.append("precios", {"price_list": price_list, "price_list_rate": rate})
    doc.save(ignore_permissions=True)

    frappe.db.commit()
    return {"familia": familia, "price_list": price_list, "rate": rate,
            "updated": updated, "errors": errors}


def _upsert_item_price(item_code: str, price_list: str, rate: float, uom: str, valid_from):
    name = frappe.db.get_value(
        "Item Price", {"item_code": item_code, "price_list": price_list}, "name"
    )
    if name:
        doc = frappe.get_doc("Item Price", name)
        doc.price_list_rate = rate
        if uom:
            doc.uom = uom
        doc.valid_from = valid_from
        doc.save(ignore_permissions=True)
    else:
        doc = frappe.new_doc("Item Price")
        doc.item_code = item_code
        doc.price_list = price_list
        doc.price_list_rate = rate
        if uom:
            doc.uom = uom
        doc.valid_from = valid_from
        doc.insert(ignore_permissions=True)


# ---------------------------------------------------------------------------
# Repartición al crear un ítem nuevo con familia (opción 3)
# ---------------------------------------------------------------------------

def fanout_new_item_from_familia(item_code: str, familia: str, company: str,
                                 valid_from: str = None, set_cost: bool = True):
    """Genera los Item Price del ítem recién creado desde la matriz de su familia
    y (opcional) copia el costo estándar sugerido. Silencioso ante errores por
    lista para no bloquear el alta."""
    if not familia:
        return {"prices": [], "cost": None}
    fam = frappe.db.get_value(
        "FacEx Familia de Precio", familia,
        ["bfel_company", "uom", "costo_estandar"], as_dict=True,
    )
    if not fam or (fam.bfel_company and fam.bfel_company != company):
        return {"prices": [], "cost": None}

    vf = getdate(valid_from) if valid_from else getdate(today())
    created = []
    for p in frappe.get_all(
        "FacEx Familia de Precio Lista",
        filters={"parent": familia}, fields=["price_list", "price_list_rate"],
    ):
        try:
            _upsert_item_price(item_code, p.price_list, flt(p.price_list_rate), fam.uom, vf)
            created.append(p.price_list)
        except Exception:  # noqa: BLE001
            frappe.log_error(frappe.get_traceback(), f"fanout familia {familia} -> {item_code}")

    cost = None
    if set_cost and flt(fam.costo_estandar) and frappe.get_meta("Item").has_field("custom_costo_estandar"):
        if not flt(frappe.db.get_value("Item", item_code, "custom_costo_estandar")):
            frappe.db.set_value("Item", item_code, "custom_costo_estandar",
                                flt(fam.costo_estandar), update_modified=False)
            cost = flt(fam.costo_estandar)
    return {"prices": created, "cost": cost}
