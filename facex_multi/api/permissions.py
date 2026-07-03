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
    "crea_items", "modifica_items", "actualiza_precios",
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
