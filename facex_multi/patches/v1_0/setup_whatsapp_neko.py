"""Enviar por WhatsApp (2026-10-06): neko habilitado con los tres documentos
(mensajes sugeridos) y concedido a los perfiles de ventas y gerencia; el resto
de los sitios queda desactivado (el campo nace en 0)."""
import frappe

NEKO_SITE = "neko.chappsa.com"
PERFILES = ("Gerencia", "Ventas", "Ventas Redes Sociales")


def execute():
    for dt in ("facex_wa_documento", "facex_wa_enlace", "facex_configuracion_compania", "facex_settings", "facex_perfil_de_permisos"):
        frappe.reload_doc("facex_multi", "doctype", dt)
    if frappe.local.site != NEKO_SITE:
        return
    for company in frappe.get_all("FacEx Configuracion Compania", pluck="name"):
        cfg = frappe.get_doc("FacEx Configuracion Compania", company)
        cfg.wa_habilitado = 1  # validate() agrega los tres documentos con su mensaje sugerido
        cfg.flags.ignore_permissions = True
        cfg.save()
    for perfil in PERFILES:
        if frappe.db.exists("FacEx Perfil de Permisos", perfil):
            frappe.db.set_value("FacEx Perfil de Permisos", perfil, {"wa_factura": 1, "wa_cotizacion": 1, "wa_pago": 1}, update_modified=False)
            frappe.db.sql(
                "UPDATE `tabFacEx Settings` SET wa_factura = 1, wa_cotizacion = 1, wa_pago = 1 WHERE perfil = %s", perfil
            )
    frappe.clear_cache()
