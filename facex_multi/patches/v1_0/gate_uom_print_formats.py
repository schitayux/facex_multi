"""Formatos de impresión de venta: la UdM depende de «Ver unidad de medida»
(Configuración de Compañía, 2026-10-06). Parchea las copias en base de datos
(FAC CERTIFI / FAC FEL / Cotización FacEx / Recibo Ticket, con sus clones por
compañía); respaldo previo en private/backups. Idempotente."""
import json
import os
import re

import frappe

OLD = re.compile(r'\{% if (\w+)\.uom and \1\.stock_uom and \1\.uom != \1\.stock_uom %\}<br><b class="fx-uom-frac">\{\{ \1\.uom \}\}</b>\{% endif %\}')
VU = '{%- set _fx_vu = frappe.db.get_value("FacEx Configuracion Compania", doc.company, "mostrar_uom") -%}\n'
STYLE = 'style="background:#fff3cd;border:1px solid #f0a500;padding:0 3px;border-radius:3px;"'


def _qty_snippet(v):
    return ('{%% if _fx_vu and %(v)s.uom %%}<br><b {%% if %(v)s.stock_uom and %(v)s.uom != %(v)s.stock_uom %%}' + STYLE +
            '{%% endif %%}>{{ %(v)s.uom }}</b>{%% endif %%}') % {"v": v}


def _patch(html):
    new = OLD.sub(lambda m: _qty_snippet(m.group(1)), html)
    th, td = '<th class="th-uom">UM</th>', '<td>{{ item.uom }}</td>'
    if th in new and td in new and "{% if _fx_vu %}" not in new:
        new = new.replace(th, '{% if _fx_vu %}<th class="th-uom">UdM</th>{% endif %}').replace(td, '{% if _fx_vu %}<td>{{ item.uom }}</td>{% endif %}')
    if new != html and "_fx_vu" in new and not new.lstrip().startswith("{%- set _fx_vu"):
        new = VU + new
    return new


def execute():
    backup_dir = frappe.get_site_path("private", "backups")
    os.makedirs(backup_dir, exist_ok=True)
    names = frappe.get_all("Print Format", filters={"doc_type": "Sales Invoice", "custom_format": 1}, pluck="name")
    for pf in names:
        html = frappe.db.get_value("Print Format", pf, "html") or ""
        new = _patch(html)
        if new == html:
            continue
        with open(os.path.join(backup_dir, f"print_format_{frappe.scrub(pf)}_pre_mostrar_uom_2026-10-06.json"), "w") as f:
            json.dump({"name": pf, "html": html}, f, ensure_ascii=False)
        frappe.db.set_value("Print Format", pf, "html", new, update_modified=False)
    frappe.clear_cache()
