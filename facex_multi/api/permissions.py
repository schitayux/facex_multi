"""
facex_multi.api.permissions
----------------------------
Permisos por usuario+compañía para el page FacEx.
Sin registro en FacEx Settings → acceso total (retrocompatible).
System Manager → siempre acceso total.
"""
from __future__ import annotations
import frappe

_ALL_PERM_FIELDS = [
    "puede_ver_tablero", "puede_facturar",
    "puede_guardar", "puede_validar", "puede_certificar",
    "puede_compras", "puede_validar_compras", "puede_cancelar_compras",
    "crea_clientes", "modifica_clientes",
    "crea_proveedores", "modifica_proveedores",
    "crea_items", "modifica_items", "actualiza_precios", "puede_editar_precio",
    "reporte_ventas_fecha", "reporte_ventas_producto",
    "reporte_facturas_canceladas", "reporte_estados_cuenta",
    "reporte_antiguedad_saldos", "reporte_cotizaciones",
    "reporte_recibos_pagos", "reporte_crecimiento_ventas",
    "reporte_imprimir_recibo",
]

def _full_access() -> dict:
    return {f: 1 for f in _ALL_PERM_FIELDS}


def get_facex_permissions_for_company(company: str) -> dict:
    """
    Retorna el dict de permisos para frappe.session.user + company.
    Llamado internamente desde get_defaults — no whitelist propio.
    """
    if not company:
        return _full_access()

    # System Manager siempre tiene acceso total
    if "System Manager" in frappe.get_roles():
        return _full_access()

    row = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        _ALL_PERM_FIELDS,
        as_dict=True,
    )

    if not row:
        # Sin registro configurado → acceso total
        return _full_access()

    # Convertir a int explícito (los Check vienen como 0/1 desde DB)
    return {k: int(row.get(k) or 0) for k in _ALL_PERM_FIELDS}


_COMPANY_CONFIG_FIELDS = [
    "maneja_series", "maneja_adendas", "concatena_descripcion2",
    "maneja_inventario", "tipo_x_defecto",
    "mostrar_almacen", "mostrar_desc_pct", "mostrar_adenda", "mostrar_tipo",
    "exige_pago_completo", "permite_pago_credito", "permite_pago_contra_entrega",
]
# Campos texto (Select/Data) — no convertir a int
_CONFIG_TEXT_FIELDS = {"tipo_x_defecto"}
# Check fields que están ON por defecto cuando no hay config
_CONFIG_DEFAULT_ON = {"mostrar_almacen", "mostrar_desc_pct", "mostrar_adenda", "mostrar_tipo"}


def _config_default() -> dict:
    result = {}
    for k in _COMPANY_CONFIG_FIELDS:
        if k in _CONFIG_TEXT_FIELDS:
            result[k] = ""
        elif k in _CONFIG_DEFAULT_ON:
            result[k] = 1
        else:
            result[k] = 0
    return result


def get_facex_default_warehouse(company: str) -> str:
    """
    Bodega por defecto del usuario en FacEx Screen (campo bodega_por_defecto,
    registro user+company). System Manager y usuarios sin registro/valor
    configurado devuelven "" — sin restricción, se ven todos los productos.
    """
    if "System Manager" in frappe.get_roles():
        return ""
    if not company:
        return ""
    return frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "bodega_por_defecto",
    ) or ""


def get_facex_company_config(company: str) -> dict:
    """
    Retorna la configuración DIGECAM/Inventario a nivel de compañía (registro con user='').
    Si no existe, devuelve defaults (columnas visibles ON, resto OFF).
    """
    if not company:
        return _config_default()
    row = frappe.db.get_value(
        "FacEx Settings",
        {"bfel_company": company, "user": ["is", "not set"]},
        _COMPANY_CONFIG_FIELDS,
        as_dict=True,
    )
    if not row:
        return _config_default()
    result = {}
    for k in _COMPANY_CONFIG_FIELDS:
        v = row.get(k)
        if k in _CONFIG_TEXT_FIELDS:
            result[k] = str(v or "")
        elif k in _CONFIG_DEFAULT_ON:
            result[k] = int(v) if v is not None else 1
        else:
            result[k] = int(v or 0)
    return result


# ---------------------------------------------------------------------------
# Módulo de Inventario (Entradas / Salidas / Transferencias / Reportes)
# ---------------------------------------------------------------------------
# A diferencia de _ALL_PERM_FIELDS (Ventas/Compras), aquí NO hay acceso total
# por defecto. Sin fila de FacEx Settings para el usuario+compañía → sin
# acceso. Es una decisión deliberada: el módulo de inventario mueve stock,
# no debe quedar expuesto a usuarios que nunca fueron configurados para él.

_INVENTORY_PERM_FIELDS = [
    "puede_ver_inventario",
    "puede_hacer_entradas",
    "puede_hacer_salidas",
    "puede_hacer_transferencias",
    "puede_cancelar_movimientos",
    "reporte_inv_kardex",
    "reporte_inv_existencias",
    "reporte_inv_trazabilidad",
]


def _inventory_no_access() -> dict:
    return {f: 0 for f in _INVENTORY_PERM_FIELDS}


def _inventory_full_access() -> dict:
    return {f: 1 for f in _INVENTORY_PERM_FIELDS}


def get_facex_inventory_permissions(company: str) -> dict:
    """
    Retorna el dict de permisos de inventario para frappe.session.user + company.
    Deny-by-default: sin fila configurada → sin acceso (salvo System Manager).
    """
    if "System Manager" in frappe.get_roles():
        return _inventory_full_access()

    if not company:
        return _inventory_no_access()

    row = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        _INVENTORY_PERM_FIELDS,
        as_dict=True,
    )

    if not row:
        return _inventory_no_access()

    return {k: int(row.get(k) or 0) for k in _INVENTORY_PERM_FIELDS}


# ---------------------------------------------------------------------------
# Eliminar Ventas en Espera (FacEx Screen)
# ---------------------------------------------------------------------------
# Deny-by-default igual que el módulo de Inventario: es una acción destructiva
# e irreversible (borra el documento), así que un usuario sin fila configurada
# en FacEx Settings NO la tiene, a diferencia de _ALL_PERM_FIELDS.

def get_facex_can_delete_held_sales(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_eliminar_ventas_espera",
    )
    return bool(int(value or 0))


# ---------------------------------------------------------------------------
# Anular/Cancelar facturas desde FacEx Screen (FEL o interna)
# ---------------------------------------------------------------------------
# Deny-by-default: es una acción destructiva/irreversible (anula ante la SAT
# o revierte contabilidad e inventario), así que un usuario sin fila
# configurada en FacEx Settings NO la tiene.

def get_facex_can_cancel_invoices(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_anular_facturas",
    )
    return bool(int(value or 0))


# ---------------------------------------------------------------------------
# Botón "POS" en el menú del page FacEx (redirige a FacEx Screen)
# ---------------------------------------------------------------------------
# Deny-by-default: el botón nuevo no debe aparecer para nadie hasta que se
# habilite explícitamente por usuario+compañía en FacEx Settings.

def get_facex_can_access_pos(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_pos",
    )
    return bool(int(value or 0))


# ---------------------------------------------------------------------------
# Botón "Inventario" en el menú del page FacEx (redirige a FacEx Inventario)
# ---------------------------------------------------------------------------
# Deny-by-default, igual que el botón POS. Deliberadamente separado de
# get_facex_inventory_permissions/puede_ver_inventario: aquél gobierna el
# acceso a las operaciones dentro del módulo de Inventario, este solo la
# visibilidad del atajo en el menú de FacEx — un admin puede querer otorgar
# uno sin el otro.

def get_facex_can_access_inventory_menu(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_menu_inventario",
    )
    return bool(int(value or 0))


# Roles que ya tienen acceso al page FacEx (ver facex_inventario.json > roles).
# Stock Entry, por defecto en ERPNext, solo lo tienen "Stock User"/"Stock Manager" —
# aquí se les otorga el permiso nativo para que el motor de ERPNext los valide de
# forma normal (create/write/submit/cancel). El filtro fino de QUÉ compañía y QUÉ
# acción (entrada/salida/transferencia) sigue resuelto por FacEx Settings arriba;
# esto solo abre la puerta a nivel de DocType, como ya ocurre con Sales Invoice.
STOCK_ENTRY_ROLES = [
    "Sales User", "Accounts User", "Sales Manager",
    "Accounts Manager", "System Manager", "facex_multi",
]


def ensure_stock_entry_permissions():
    """
    Idempotente: otorga permiso nativo de Stock Entry (read/write/create/
    submit/cancel/report/print) a los roles que ya usa FacEx, si no lo tienen.
    Se llama desde after_migrate (hooks.py) para que sobreviva a futuros
    `bench migrate` sin depender de que alguien lo corra a mano.
    """
    for role in STOCK_ENTRY_ROLES:
        if frappe.db.exists("Custom DocPerm", {"parent": "Stock Entry", "role": role}):
            continue
        frappe.get_doc({
            "doctype": "Custom DocPerm",
            "parent": "Stock Entry",
            "parenttype": "DocType",
            "parentfield": "permissions",
            "role": role,
            "permlevel": 0,
            "read": 1,
            "write": 1,
            "create": 1,
            "submit": 1,
            "cancel": 1,
            "delete": 0,
            "report": 1,
            "export": 0,
            "print": 1,
            "email": 0,
            "share": 0,
        }).insert(ignore_permissions=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="Stock Entry")


# ---------------------------------------------------------------------------
# Series de numeración por tipo de movimiento (Entradas/Salidas/Transferencias)
# ---------------------------------------------------------------------------
# ".ABBR." ya lo resuelve ERPNext de forma nativa (erpnext.hooks.naming_series_variables
# -> parse_naming_series_variable), para cualquier doctype con campo "company".
# No hay que reimplementar esa lógica: solo declarar las series como opciones
# válidas del campo naming_series de Stock Entry.

STOCK_ENTRY_NAMING_SERIES = [
    "MAT-STE-.YYYY.-",   # serie nativa de ERPNext — no se retira, la siguen usando Repack/Manufacture/etc.
    "ING-.ABBR.-.####",  # Entradas
    "SAL-.ABBR.-.####",  # Salidas (fase futura)
    "TRA-.ABBR.-.####",  # Transferencias (fase futura)
]


def ensure_stock_entry_naming_series():
    """Idempotente: agrega ING-/SAL-/TRA- a las opciones de Stock Entry.naming_series
    vía Property Setter, sin quitar la serie nativa. Se llama desde after_migrate."""
    from frappe.custom.doctype.property_setter.property_setter import make_property_setter

    meta_options = frappe.get_meta("Stock Entry").get_field("naming_series").options or ""
    current_options = [o.strip() for o in meta_options.split("\n") if o.strip()]
    missing = [o for o in STOCK_ENTRY_NAMING_SERIES if o not in current_options]
    if not missing:
        return

    new_value = "\n".join(current_options + missing)
    existing_name = frappe.db.get_value(
        "Property Setter",
        {"doc_type": "Stock Entry", "field_name": "naming_series", "property": "options"},
    )
    if existing_name:
        frappe.db.set_value("Property Setter", existing_name, "value", new_value)
    else:
        make_property_setter("Stock Entry", "naming_series", "options", new_value, "Text")

    frappe.db.commit()
    frappe.clear_cache(doctype="Stock Entry")


# ---------------------------------------------------------------------------
# Sucursal (BFEL Establecimiento) por Almacén
# ---------------------------------------------------------------------------
# No existía ninguna relación entre Almacén y BFEL Establecimientos (esa tabla
# solo se usaba para series fiscales de facturación). La agregamos aquí como
# campo simple (igual convención que bfel_establecimiento en Sales/Purchase
# Invoice: Data guardando el establecimiento_id, no un Link).

def ensure_warehouse_establecimiento_field():
    """Idempotente: agrega el campo bfel_establecimiento a Warehouse si no existe."""
    if frappe.db.exists("Custom Field", "Warehouse-bfel_establecimiento"):
        return
    frappe.get_doc({
        "doctype": "Custom Field",
        "dt": "Warehouse",
        "fieldname": "bfel_establecimiento",
        "label": "Establecimiento (Sucursal)",
        "fieldtype": "Data",
        "insert_after": "company",
        "description": "ID de BFEL Establecimientos al que pertenece este almacén. Vacío = sin asignar.",
    }).insert(ignore_permissions=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="Warehouse")


# ---------------------------------------------------------------------------
# Módulo de Transporte (Catálogo de Transportistas / Guías / Liquidaciones)
# ---------------------------------------------------------------------------
# Deny-by-default, igual que Inventario y las acciones destructivas de arriba:
# un usuario sin fila configurada en FacEx Settings NO tiene acceso a estas
# 4 acciones hasta que se le habilite explícitamente por usuario+compañía.

def get_facex_can_administer_transportistas(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_administrar_transportistas",
    )
    return bool(int(value or 0))


def get_facex_can_upload_liquidaciones_transporte(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_cargar_liquidaciones_transporte",
    )
    return bool(int(value or 0))


def get_facex_can_edit_guias_transporte(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_editar_guias_transporte",
    )
    return bool(int(value or 0))


def get_facex_can_view_transporte_reportes(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_reportes_transporte",
    )
    return bool(int(value or 0))


def get_facex_companies_with_transporte_report_access(companies: list) -> list:
    """
    Filtra `companies` (típicamente el resultado de get_user_companies())
    dejando solo aquellas donde el usuario tiene puede_ver_reportes_transporte=1.
    System Manager conserva la lista completa.
    """
    if not companies:
        return []
    if "System Manager" in frappe.get_roles():
        return companies
    return frappe.get_all(
        "FacEx Settings",
        filters={
            "user": frappe.session.user,
            "bfel_company": ["in", companies],
            "puede_ver_reportes_transporte": 1,
        },
        pluck="bfel_company",
    )
