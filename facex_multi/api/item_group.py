"""
facex_multi.api.item_group
---------------------------
Mantenimiento de Grupo de Ítems (DocType nativo `Item Group`) desde FacEx
Clásico. A diferencia de Almacenes, Item Group no tiene compañía propia — la
compañía efectiva solo se usa para resolver el permiso del usuario (FacEx
Settings es por usuario+compañía), no para filtrar registros.

Gate: `get_facex_can_view_item_groups` / `get_facex_can_maintain_item_groups`
— deny-by-default, mismo criterio que Familias de Precio (mantener implica
poder ver).

Thin wrapper sobre el DocType Item Group nativo de ERPNext: la validación de
árbol (NestedSet) sigue viviendo en ERPNext core.
"""
from __future__ import annotations

import frappe

from facex_multi.api.invoice import get_effective_company
from facex_multi.api.permissions import (
    get_facex_can_view_item_groups,
    get_facex_can_maintain_item_groups,
)


def _require_view(company: str) -> str:
    company = get_effective_company(company)
    if not get_facex_can_view_item_groups(company):
        frappe.throw("No tiene permiso para ver los Grupos de Ítems.", frappe.PermissionError)
    return company


def _require_edit(company: str) -> str:
    company = get_effective_company(company)
    if not get_facex_can_maintain_item_groups(company):
        frappe.throw("No tiene permiso para mantener los Grupos de Ítems.", frappe.PermissionError)
    return company


@frappe.whitelist()
def list_item_groups_maintenance(company: str = None):
    """Lista plana de Item Group con su jerarquía (parent_item_group)."""
    _require_view(company)

    groups = frappe.get_all(
        "Item Group",
        fields=["name", "item_group_name", "parent_item_group", "is_group", "disabled"],
        order_by="lft asc",
    )
    for g in groups:
        g["item_count"] = frappe.db.count("Item", {"item_group": g["name"]})

    return {"item_groups": groups}


@frappe.whitelist()
def create_item_group(payload: str):
    data = frappe.parse_json(payload)
    _require_edit(data.get("company"))

    item_group_name = (data.get("item_group_name") or "").strip()
    if not item_group_name:
        frappe.throw("Indique el nombre del grupo de ítems.")

    doc = frappe.get_doc({
        "doctype": "Item Group",
        "item_group_name": item_group_name,
        "parent_item_group": data.get("parent_item_group") or None,
        "is_group": frappe.utils.cint(data.get("is_group")),
    })
    doc.insert()
    frappe.db.commit()
    return {"name": doc.name, "item_group_name": doc.item_group_name}


@frappe.whitelist()
def update_item_group(name: str, payload: str):
    data = frappe.parse_json(payload)
    _require_edit(data.get("company"))

    if not frappe.db.exists("Item Group", name):
        frappe.throw(f"El grupo de ítems '{name}' no existe.")

    doc = frappe.get_doc("Item Group", name)

    new_name = (data.get("item_group_name") or "").strip()
    if new_name and new_name != doc.item_group_name:
        doc.item_group_name = new_name
    if "parent_item_group" in data:
        doc.parent_item_group = data.get("parent_item_group") or None
    if "disabled" in data:
        doc.disabled = frappe.utils.cint(data.get("disabled"))

    doc.save()
    frappe.db.commit()
    return {"name": doc.name, "item_group_name": doc.item_group_name}


@frappe.whitelist()
def delete_item_group(name: str, company: str = None):
    _require_edit(company)

    if not frappe.db.exists("Item Group", name):
        frappe.throw(f"El grupo de ítems '{name}' no existe.")
    if frappe.db.exists("Item Group", {"parent_item_group": name}):
        frappe.throw("El grupo tiene grupos hijos. Elimínelos primero.")
    if frappe.db.exists("Item", {"item_group": name}):
        frappe.throw("El grupo tiene ítems asignados y no puede eliminarse. "
                     "Puede deshabilitarlo en su lugar.")
    frappe.delete_doc("Item Group", name)
    frappe.db.commit()
    return {"success": True}
