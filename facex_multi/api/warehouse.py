"""
facex_multi.api.warehouse
-------------------------
Mantenimiento de Almacenes desde el módulo de Inventario de FacEx (pantalla
«Almacenes»). Alta / edición / baja de almacenes HOJA (no grupos) de la compañía
efectiva, más el campo FacEx «Tipo de Almacén» (bfel_tipo_almacen) y la sucursal
(bfel_establecimiento).

Gate: `get_facex_can_maintain_warehouses` — deny-by-default y además exige que el
usuario tenga acceso a TODAS las bodegas de la compañía (sin restricción en
FacEx Settings > Bodegas Habilitadas).

Thin wrapper sobre el DocType Warehouse nativo de ERPNext: la validación de árbol
(NestedSet) y el `on_trash` (que ya bloquea si hay Stock Ledger Entry) siguen
viviendo en ERPNext core.
"""
from __future__ import annotations

import frappe

from facex_multi.api.invoice import get_effective_company, get_user_companies
from facex_multi.api.permissions import get_facex_can_maintain_warehouses
from facex_multi.api.si_carga import _get_establishments

_TIPO_ALMACEN_OPTIONS = ["Venta", "Transito", "Consignación", "Devoluciones",
                         "Cuarentena", "General", "Otros"]


def _guard(company: str) -> str:
    company = get_effective_company(company)
    if company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)
    if not get_facex_can_maintain_warehouses(company):
        frappe.throw("No tiene permiso para mantener los almacenes.", frappe.PermissionError)
    return company


def _assert_company_warehouse(name: str, company: str) -> dict:
    wh = frappe.db.get_value(
        "Warehouse", name,
        ["name", "warehouse_name", "company", "is_group", "parent_warehouse", "disabled"],
        as_dict=True,
    )
    if not wh:
        frappe.throw(f"El almacén '{name}' no existe.")
    if wh.company and wh.company != company:
        frappe.throw("Ese almacén pertenece a otra compañía.")
    return wh


def _has_movements(name: str) -> bool:
    if frappe.db.exists("Stock Ledger Entry", {"warehouse": name}):
        return True
    if frappe.db.sql(
        "SELECT 1 FROM `tabBin` WHERE warehouse = %s AND actual_qty != 0 LIMIT 1", name
    ):
        return True
    return False


@frappe.whitelist()
def list_warehouses_maintenance(company: str = None):
    """Árbol de almacenes de la compañía: grupos (solo lectura) + hojas editables,
    con sucursal, tipo, estado y si ya tienen movimientos (bloquea la baja)."""
    company = _guard(company)

    fields = ["name", "warehouse_name", "parent_warehouse", "is_group", "disabled"]
    meta = frappe.get_meta("Warehouse")
    if meta.has_field("bfel_establecimiento"):
        fields.append("bfel_establecimiento")
    if meta.has_field("bfel_tipo_almacen"):
        fields.append("bfel_tipo_almacen")

    warehouses = frappe.get_all(
        "Warehouse", filters={"company": company}, fields=fields, order_by="name asc",
    )
    for w in warehouses:
        w["has_movements"] = _has_movements(w["name"]) if not w.get("is_group") else False

    groups = [w for w in warehouses if w.get("is_group")]
    establishments = _get_establishments(company)

    return {
        "company": company,
        "warehouses": warehouses,
        "groups": [{"name": g["name"], "warehouse_name": g["warehouse_name"]} for g in groups],
        "establishments": establishments,
        "tipo_almacen_options": _TIPO_ALMACEN_OPTIONS,
    }


@frappe.whitelist()
def create_warehouse(payload: str):
    """Crea un almacén HOJA en la compañía efectiva."""
    data = frappe.parse_json(payload)
    company = _guard(data.get("company"))

    warehouse_name = (data.get("warehouse_name") or "").strip()
    if not warehouse_name:
        frappe.throw("Indique el nombre del almacén.")

    parent = (data.get("parent_warehouse") or "").strip()
    if parent:
        pg = _assert_company_warehouse(parent, company)
        if not pg.is_group:
            frappe.throw("El almacén padre debe ser un grupo.")
    else:
        # Sin grupo elegido → colgar del grupo raíz de la compañía.
        parent = frappe.db.get_value(
            "Warehouse",
            {"company": company, "is_group": 1, "parent_warehouse": ["in", ["", None]]},
            "name",
        ) or frappe.db.get_value("Warehouse", {"company": company, "is_group": 1}, "name")

    doc = frappe.get_doc({
        "doctype": "Warehouse",
        "warehouse_name": warehouse_name,
        "company": company,
        "is_group": 0,
        "parent_warehouse": parent or None,
    })
    if doc.meta.has_field("bfel_establecimiento"):
        doc.bfel_establecimiento = data.get("bfel_establecimiento") or None
    if doc.meta.has_field("bfel_tipo_almacen"):
        doc.bfel_tipo_almacen = data.get("bfel_tipo_almacen") or None
    doc.insert()
    frappe.db.commit()
    return {"name": doc.name, "warehouse_name": doc.warehouse_name}


@frappe.whitelist()
def update_warehouse(name: str, payload: str):
    data = frappe.parse_json(payload)
    company = _guard(data.get("company"))
    wh = _assert_company_warehouse(name, company)
    if wh.is_group:
        frappe.throw("Esta pantalla solo administra almacenes hoja, no grupos.")

    doc = frappe.get_doc("Warehouse", name)

    new_name = (data.get("warehouse_name") or "").strip()
    if new_name and new_name != doc.warehouse_name:
        doc.warehouse_name = new_name
    if "disabled" in data:
        doc.disabled = int(data.get("disabled") or 0)
    if doc.meta.has_field("bfel_establecimiento") and "bfel_establecimiento" in data:
        doc.bfel_establecimiento = data.get("bfel_establecimiento") or None
    if doc.meta.has_field("bfel_tipo_almacen") and "bfel_tipo_almacen" in data:
        doc.bfel_tipo_almacen = data.get("bfel_tipo_almacen") or None

    doc.save()
    frappe.db.commit()
    return {"name": doc.name, "warehouse_name": doc.warehouse_name}


@frappe.whitelist()
def delete_warehouse(name: str, company: str = None):
    company = _guard(company)
    wh = _assert_company_warehouse(name, company)
    if wh.is_group:
        frappe.throw("No se pueden eliminar grupos desde esta pantalla.")
    if frappe.db.exists("Warehouse", {"parent_warehouse": name}):
        frappe.throw("El almacén tiene almacenes hijos. Elimínelos primero.")
    if _has_movements(name):
        frappe.throw("El almacén ya tiene movimientos de inventario y no puede eliminarse. "
                     "Puede deshabilitarlo en su lugar.")
    frappe.delete_doc("Warehouse", name)
    frappe.db.commit()
    return {"success": True}
