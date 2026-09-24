"""
Patch: separa la configuración de compañía de FacEx Settings.

Hasta ahora la configuración a nivel de compañía (DIGECAM, columnas visibles,
condiciones de pago, flete, políticas de catálogo) vivía en la fila de
FacEx Settings con Usuario en blanco, y esos ~20 campos aparecían también en
cada fila de usuario, donde no tenían efecto. Ahora vive en
«FacEx Configuracion Compania» (uno por compañía).

Copia cada fila heredada al doctype nuevo (idempotente: no pisa un registro
ya existente). La fila heredada NO se borra — queda como respaldo y como
fallback de lectura en permissions.get_facex_company_config.
"""
import frappe

from facex_multi.api.permissions import CONFIG_DOCTYPE, _COMPANY_CONFIG_FIELDS


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_configuracion_compania")
    frappe.reload_doc("facex_multi", "doctype", "facex_settings")

    meta = frappe.get_meta("FacEx Settings")
    fields = [f for f in _COMPANY_CONFIG_FIELDS if meta.has_field(f)]
    legacy = frappe.get_all(
        "FacEx Settings",
        filters={"user": ["is", "not set"]},
        fields=["name", "bfel_company"] + fields,
        order_by="modified desc",
    )
    for row in legacy:
        company = row.get("bfel_company")
        if not company or not frappe.db.exists("Company", company):
            continue
        if frappe.db.exists(CONFIG_DOCTYPE, company):
            continue
        doc = frappe.new_doc(CONFIG_DOCTYPE)
        doc.company = company
        for f in fields:
            doc.set(f, row.get(f))
        # Las validaciones de cuenta/ítem por compañía son para capturas
        # nuevas; los valores heredados se copian tal cual.
        doc.flags.ignore_validate = True
        doc.flags.ignore_links = True
        doc.insert(ignore_permissions=True)
    frappe.db.commit()
