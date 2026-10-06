"""FAC CERTIFI - NEKO con el diseño compacto (2026-10-06): «Recibo de compra»
(00 No enviar) y factura certificada en una página, sin chips ni encabezados
pesados. Plantilla: templates/print_formats/fac_certifi_compacto.html.
Respaldo previo en private/backups."""
import json
import os

import frappe

PF = "FAC CERTIFI - NEKO"


def execute():
    if frappe.local.site != "neko.chappsa.com" or not frappe.db.exists("Print Format", PF):
        return
    path = frappe.get_app_path("facex_multi", "templates", "print_formats", "fac_certifi_compacto.html")
    html = open(path, encoding="utf-8").read()
    old = frappe.db.get_value("Print Format", PF, ["html", "css", "margin_top", "margin_bottom", "margin_left", "margin_right"], as_dict=True)
    if old.html == html:
        return
    bdir = frappe.get_site_path("private", "backups")
    os.makedirs(bdir, exist_ok=True)
    with open(os.path.join(bdir, "print_format_fac_certifi_neko_pre_compacto_2026-10-06.json"), "w") as f:
        json.dump(old, f, ensure_ascii=False, default=str)
    frappe.db.set_value("Print Format", PF, {
        "html": html, "css": "", "margin_top": 12, "margin_bottom": 12, "margin_left": 14, "margin_right": 14,
    }, update_modified=False)
    frappe.clear_cache()
