"""Columna UdM en el detalle de los formatos de impresión (2026-10-06).

Con «Ver unidad de medida» activo (Configuración de Compañía) los formatos de
venta dibujan una columna UdM junto a la cantidad (en lugar de la etiqueta bajo
la cantidad); apagado, no hay columna. Parchea las copias en base de datos de
FAC CERTIFI / FAC FEL / Recibo Ticket / Cotización / Movimiento de Inventario
y sus clones por compañía (solo si su estructura coincide); respaldo previo en
private/backups. Idempotente. `apply()` también se usa sobre las plantillas del repo."""
import json
import os
import re

import frappe

VU = '{%- set _fx_vu = frappe.db.get_value("FacEx Configuracion Compania", doc.company, "mostrar_uom") -%}\n'
AMBER = 'style="background:#fff3cd;border:1px solid #f0a500;padding:0 3px;border-radius:3px;"'

# Etiqueta bajo la cantidad de versiones anteriores (se retira).
_OLD_SNIPPET = re.compile(r'\{% if (\w+)\.uom and \1\.stock_uom and \1\.uom != \1\.stock_uom %\}<br><b class="fx-uom-frac">\{\{ \1\.uom \}\}</b>\{% endif %\}')
_NEW_SNIPPET = re.compile(r'\{% if _fx_vu and (\w+)\.uom %\}<br><b.*?\{\{ \1\.uom \}\}</b>\{% endif %\}', re.S)
_QTY_TD = re.compile(r'(<td[^>]*>\s*\{\{ (item|sii)\.qty \}\}\s*</td>)')
_QTY_TH = re.compile(r'(<th[^>]*>\s*Cant(?:idad|\.)\s*</th>)')


def _td(v, cls=""):
    return ('{%% if _fx_vu %%}<td class="fx-uom-col %(c)s">{%% if %(v)s.stock_uom and %(v)s.uom != %(v)s.stock_uom %%}<b ' + AMBER +
            '>{{ %(v)s.uom }}</b>{%% else %%}{{ %(v)s.uom or %(v)s.stock_uom or "" }}{%% endif %%}</td>{%% endif %%}') % {"v": v, "c": cls}


def apply(html: str) -> str:
    if not html or "fx-uom-col" in html:
        return html
    new = _NEW_SNIPPET.sub("", _OLD_SNIPPET.sub("", html))
    # Cotización traía su propia columna UM (siempre visible; luego condicionada):
    # se retira y la reemplaza la columna común junto a la cantidad.
    for lit in ('{% if _fx_vu %}<th class="th-uom">UdM</th>{% endif %}', '{% if _fx_vu %}<td>{{ item.uom }}</td>{% endif %}',
                '<th class="th-uom">UM</th>', '<td>{{ item.uom }}</td>'):
        new = new.replace(lit, "")
    # Ventas: columna junto a la cantidad (solo si hay exactamente un encabezado y una celda).
    if len(_QTY_TD.findall(new)) == 1 and len(_QTY_TH.findall(new)) == 1:
        v = _QTY_TD.search(new).group(2)
        new = _QTY_TD.sub(lambda m: m.group(1) + _td(v), new)
        new = _QTY_TH.sub(lambda m: m.group(1) + '{% if _fx_vu %}<th class="fx-uom-col">UdM</th>{% endif %}', new)
    if "{% if _fx_vu %}" in new and "set _fx_vu" not in new:
        new = VU + new
    return new


def apply_movimiento(html: str) -> str:
    th = '<th style="border:1px solid #999;padding:4px 6px;width:60px;">UOM</th>'
    td = '<td style="border:1px solid #999;padding:4px 6px;">{{ row.uom or row.stock_uom or "" }}</td>'
    if "_fx_vu" in html or th not in html or td not in html:
        return html
    html = html.replace(th, '{%- if _fx_vu -%}' + th.replace("UOM", "UdM") + '{%- endif -%}').replace(td, '{%- if _fx_vu -%}' + td + '{%- endif -%}')
    return VU + html


def execute():
    backup_dir = frappe.get_site_path("private", "backups")
    os.makedirs(backup_dir, exist_ok=True)
    rows = frappe.get_all("Print Format", filters={"custom_format": 1, "doc_type": ["in", ["Sales Invoice", "Stock Entry"]]},
                          fields=["name", "doc_type"])
    for r in rows:
        html = frappe.db.get_value("Print Format", r.name, "html") or ""
        new = apply_movimiento(html) if r.doc_type == "Stock Entry" else apply(html)
        if new == html:
            continue
        with open(os.path.join(backup_dir, f"print_format_{frappe.scrub(r.name)}_pre_uom_columna_2026-10-06.json"), "w") as f:
            json.dump({"name": r.name, "html": html}, f, ensure_ascii=False)
        frappe.db.set_value("Print Format", r.name, "html", new, update_modified=False)
    frappe.clear_cache()
