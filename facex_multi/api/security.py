"""
facex_multi.api.security
-------------------------
Módulo «Seguridad» de FacEx: permite a un usuario habilitado (flag
`puede_ver_facex_settings`, deny-by-default) editar la configuración de FacEx
Settings de otros usuarios sin necesitar el rol System Manager ni acceso al
escritorio de Frappe, y reiniciar contraseñas de usuarios que NO sean System
Manager (flag independiente `puede_resetear_password`).

Riesgo: quien tiene `puede_ver_facex_settings` puede otorgarse a sí mismo o a
otros cualquier permiso de FacEx (incluida asignación de precios, anulación de
facturas, etc.). Es responsabilidad del System Manager elegir con cuidado a
quién se le concede este flag — de ahí la advertencia mostrada en el frontend.
"""
from __future__ import annotations

import frappe
from frappe.utils import cint, today

from facex_multi.api.invoice import get_effective_company
from facex_multi.api.permissions import (
    get_facex_can_view_seguridad,
    get_facex_can_reset_password,
    _COMPANY_CONFIG_FIELDS,
)

_MIN_PASSWORD_LENGTH = 8


def _require_seguridad(company: str) -> str:
    company = get_effective_company(company)
    if not get_facex_can_view_seguridad(company):
        frappe.throw("No tiene permiso para acceder al módulo de Seguridad.", frappe.PermissionError)
    return company


def _is_system_manager(user: str) -> bool:
    return "System Manager" in frappe.get_roles(user)


def _system_manager_users() -> tuple:
    """Todos los usuarios con rol System Manager — se excluyen de todo el
    módulo Seguridad (lista de permisos, edición de FacEx Settings y reinicio
    de contraseña): un System Manager ya tiene acceso total en cada getter de
    permissions.py (bypass explícito), así que aparecer aquí solo genera
    ruido/confusión, no un control real."""
    return tuple(frappe.get_all(
        "Has Role", filters={"role": "System Manager", "parenttype": "User"}, pluck="parent",
    )) or ("",)


@frappe.whitelist()
def list_users_for_security(company: str = None, txt: str = ""):
    """Usuarios habilitados de tipo System User (excluye System Manager — ver
    _system_manager_users), con si ya tienen fila de FacEx Settings en esta
    compañía (para el picker de «Permisos de Usuarios»)."""
    company = _require_seguridad(company)

    filters = {
        "enabled": 1,
        "user_type": "System User",
        "name": ["not in", _system_manager_users()],
    }
    or_filters = None
    if txt:
        or_filters = [["name", "like", f"%{txt}%"], ["full_name", "like", f"%{txt}%"]]

    users = frappe.get_all(
        "User", filters=filters, or_filters=or_filters,
        fields=["name", "full_name"], order_by="full_name asc", limit_page_length=200,
    )
    configured = set(frappe.get_all(
        "FacEx Settings", filters={"bfel_company": company, "user": ["not in", ["", None]]},
        pluck="user",
    ))
    for u in users:
        u["has_facex_settings"] = u["name"] in configured

    return {"company": company, "users": users}


@frappe.whitelist()
def get_company_config_fieldnames() -> list:
    """Nombres de los campos de FacEx Settings que son configuración DE
    COMPAÑÍA (se leen solo del registro con Usuario en blanco — ver
    permissions.get_facex_company_config). Editarlos en la fila de un usuario
    específico no tiene ningún efecto: el frontend de Seguridad los excluye
    del diálogo por-usuario para no sugerir que sí aplican ahí."""
    return list(_COMPANY_CONFIG_FIELDS)


def _validate_target_user(user: str) -> None:
    """Valida que `user` sea un objetivo válido para el módulo Seguridad:
    debe existir, estar habilitado, y no ser Administrator/System Manager.
    Refuerza en el backend lo que las listas (list_users_for_security,
    user_query_resettable) ya excluyen de la UI."""
    if not frappe.db.exists("User", user):
        frappe.throw(f"El usuario '{user}' no existe.")
    if user == "Administrator" or _is_system_manager(user):
        frappe.throw(
            "No aplica: un usuario System Manager ya tiene acceso total en FacEx, "
            "sin importar lo que diga FacEx Settings.",
            frappe.PermissionError,
        )
    if not frappe.db.get_value("User", user, "enabled"):
        frappe.throw(f"El usuario '{user}' está deshabilitado.", frappe.PermissionError)


@frappe.whitelist()
def get_user_facex_settings(user: str, company: str = None):
    """Fila de FacEx Settings del usuario+compañía, o valores por defecto del
    DocType si aún no existe (para precargar el diálogo de edición)."""
    company = _require_seguridad(company)
    _validate_target_user(user)

    name = frappe.db.get_value("FacEx Settings", {"user": user, "bfel_company": company}, "name")
    if name:
        doc = frappe.get_doc("FacEx Settings", name)
        return doc.as_dict()

    # Sin fila aún: valores por defecto del DocType (mismo criterio de
    # get_facex_permissions_for_company — sin fila = acceso total legacy).
    doc = frappe.new_doc("FacEx Settings")
    doc.user = user
    doc.bfel_company = company
    return doc.as_dict()


@frappe.whitelist()
def save_user_facex_settings(user: str, company: str, data_json: str):
    """Crea o actualiza la fila de FacEx Settings de `user` en `company`."""
    company = _require_seguridad(company)
    _validate_target_user(user)
    data = frappe.parse_json(data_json)

    name = frappe.db.get_value("FacEx Settings", {"user": user, "bfel_company": company}, "name")
    if name:
        doc = frappe.get_doc("FacEx Settings", name)
    else:
        doc = frappe.new_doc("FacEx Settings")
        doc.user = user
        doc.bfel_company = company

    # _COMPANY_CONFIG_FIELDS se excluyen aquí también aunque el frontend ya no
    # los mande: son configuración de compañía (registro con Usuario en
    # blanco), grabarlos en la fila de un usuario no tendría ningún efecto.
    skip = {"name", "user", "bfel_company", "doctype", "owner", "creation", "modified", "modified_by"}
    skip |= set(_COMPANY_CONFIG_FIELDS)
    for fieldname, value in data.items():
        if fieldname in skip:
            continue
        if not doc.meta.has_field(fieldname):
            continue
        doc.set(fieldname, value)

    doc.save()
    frappe.db.commit()
    return {"name": doc.name}


@frappe.whitelist()
def user_query_resettable(doctype, txt, searchfield, start, page_length, filters):
    """Query override para el Link «Usuario» del picker de Reiniciar Contraseña:
    solo habilitados, tipo System User, y SIN rol System Manager."""
    company = (filters or {}).get("company") if isinstance(filters, dict) else None
    _require_seguridad_or_reset(company)

    system_managers = _system_manager_users()

    return frappe.db.sql(
        """
        SELECT name, full_name
        FROM `tabUser`
        WHERE enabled = 1 AND user_type = 'System User' AND name != 'Administrator'
            AND name NOT IN %(system_managers)s
            AND (name LIKE %(txt)s OR full_name LIKE %(txt)s)
        ORDER BY full_name ASC
        LIMIT %(page_length)s OFFSET %(start)s
        """,
        {
            "system_managers": system_managers,
            "txt": f"%{txt}%",
            "start": start,
            "page_length": page_length,
        },
    )


def _require_seguridad_or_reset(company: str) -> str:
    company = get_effective_company(company)
    if not (get_facex_can_view_seguridad(company) or get_facex_can_reset_password(company)):
        frappe.throw("No tiene permiso para reiniciar contraseñas.", frappe.PermissionError)
    return company


@frappe.whitelist()
def reset_user_password(user: str, new_password: str, company: str = None, logout_all_sessions: int = 1):
    """Reinicia la contraseña de `user` directamente (sin correo ni link de
    reseteo). Prohibido para System Manager y Administrator."""
    _require_seguridad_or_reset(company)

    if not new_password or len(new_password) < _MIN_PASSWORD_LENGTH:
        frappe.throw(f"La nueva contraseña debe tener al menos {_MIN_PASSWORD_LENGTH} caracteres.")
    _validate_target_user(user)

    from frappe.utils.password import update_password
    update_password(user=user, pwd=new_password, logout_all_sessions=cint(logout_all_sessions))
    frappe.db.set_value("User", user, "last_password_reset_date", today())
    frappe.db.commit()
    return {"success": True}
