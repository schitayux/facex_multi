"""Entero / Fracción (2026-10-05) — ver facex_multi.api.fraccion.

Todos los sitios: la sección nace apagada (maneja_fraccion = 0).
neko.chappsa.com: se activa para la compañía Neko con «Media Docena»
(factor 0.5) solo sobre la unidad base Docena — los surtidos (Unidad) siguen
enteros. La UdM nace entera y con 6 piezas físicas (recargo Contra Entrega).
Los formatos de factura de neko pasan a mostrar la UdM bajo la cantidad cuando
no es la unidad base (respaldo previo en private/backups).
"""
import json
import os

import frappe

NEKO_SITE = "neko.chappsa.com"
UOM = "Media Docena"
PRINT_FORMATS = ("FAC CERTIFI - NEKO", "FAC FEL - NEKO", "FAC CERTIFI", "FAC FEL")
SNIPPET = (
    '{%% if %(v)s.uom and %(v)s.stock_uom and %(v)s.uom != %(v)s.stock_uom %%}'
    '<br><b class="fx-uom-frac">{{ %(v)s.uom }}</b>{%% endif %%}'
)


def execute():
    if frappe.local.site != NEKO_SITE:
        return
    frappe.reload_doc("facex_multi", "doctype", "facex_unidad_fraccion")
    frappe.reload_doc("facex_multi", "doctype", "facex_configuracion_compania")

    if not frappe.db.exists("UOM", UOM):
        frappe.get_doc({"doctype": "UOM", "uom_name": UOM, "must_be_whole_number": 1}).insert(ignore_permissions=True)

    for company in frappe.get_all("FacEx Configuracion Compania", pluck="name"):
        if company != "Neko":
            continue
        cfg = frappe.get_doc("FacEx Configuracion Compania", company)
        cfg.maneja_fraccion = 1
        cfg.fraccion_uom = UOM
        cfg.fraccion_factor = 0.5
        cfg.fraccion_etiqueta = "Media"
        cfg.set("fraccion_unidades_base", [{"uom": "Docena"}])
        cfg.flags.ignore_permissions = True
        cfg.save()  # on_update → UdM (entera, 6 piezas) + ficha de los ítems Docena

    _patch_print_formats()
    frappe.clear_cache()


def _patch_print_formats():
    backup_dir = frappe.get_site_path("private", "backups")
    os.makedirs(backup_dir, exist_ok=True)
    for pf in PRINT_FORMATS:
        html = frappe.db.get_value("Print Format", pf, "html")
        if not html or "fx-uom-frac" in html:
            continue
        with open(os.path.join(backup_dir, f"print_format_{frappe.scrub(pf)}_pre_fraccion_2026-10-05.json"), "w") as f:
            json.dump({"name": pf, "html": html}, f, ensure_ascii=False)
        changed = False
        for v in ("item", "sii"):
            token = "{{ %s.qty }}" % v
            if html.count(token) == 1:
                html = html.replace(token, token + SNIPPET % {"v": v})
                changed = True
        if changed:
            frappe.db.set_value("Print Format", pf, "html", html, update_modified=False)
