"""Multimoneda (2026-11-25, fase 1): tabla «FacEx Moneda Permitida», monedas en
FacEx Configuracion Compania, permiso «edita_tipo_cambio» (deny-by-default) y
campos de moneda en Cliente / Factura. No configura ninguna compañía: sin
monedas permitidas todas siguen en su moneda de siempre (ver api/moneda.py)."""
import frappe


def execute():
    for dt in ("facex_moneda_permitida", "facex_configuracion_compania",
               "facex_perfil_de_permisos", "facex_settings"):
        frappe.reload_doc("facex_multi", "doctype", dt)
    from facex_multi.api.moneda import ensure_moneda_fields
    ensure_moneda_fields()
    from facex_multi.api.permissions import clear_permissions_cache
    clear_permissions_cache()
