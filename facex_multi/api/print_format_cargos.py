# Bloque "Cargos FacEx" (Recargo Contra Entrega / Flete) en los print formats FAC CERTIFI / FAC FEL.
import frappe, json, os

BLOCK = '''{# ============================================================= #}
{# CARGOS FACEX: Recargo Contra Entrega / Flete (filas de cargos,   #}
{# no líneas de producto). Se suman al TOTAL impreso.               #}
{# ============================================================= #}
{% set cargos_ns = namespace(recargo=0, flete=0) %}
{% for tx in si.taxes %}
{% if tx.get("facex_tipo_cargo") %}
{% if "Flete" in tx.facex_tipo_cargo %}
{% set cargos_ns.flete = cargos_ns.flete + (tx.tax_amount or 0) %}
{% else %}
{% set cargos_ns.recargo = cargos_ns.recargo + (tx.tax_amount or 0) %}
{% endif %}
{% endif %}
{% endfor %}
{% if cargos_ns.recargo or cargos_ns.flete %}
<div class="cargos-facex" style="font-size:10px; margin:4px 0 2px 0; text-align:right;">
{% if cargos_ns.recargo %}<div>Recargo por entrega: {{ frappe.utils.fmt_money(cargos_ns.recargo, currency=si.currency) }}</div>{% endif %}
{% if cargos_ns.flete %}<div>Flete: {{ frappe.utils.fmt_money(cargos_ns.flete, currency=si.currency) }}</div>{% endif %}
</div>
{% set ns.total = ns.total + cargos_ns.recargo + cargos_ns.flete %}
{% endif %}
'''
ANCHOR = '<div class="total-wrapper">'

def patch_html(html):
    if "cargos-facex" in html or html.count(ANCHOR) != 1:
        return html, False
    return html.replace(ANCHOR, BLOCK + ANCHOR), True

def patch_fixture(path):
    d = json.load(open(path))
    n = 0
    for p in d:
        if p["name"] in ("FAC CERTIFI", "FAC FEL"):
            p["html"], ok = patch_html(p.get("html") or "")
            n += ok
    json.dump(d, open(path, "w"), indent=1, ensure_ascii=False)
    open(path, "a").write("\n")
    return n

def patch_site(names=("FAC CERTIFI - NEKO", "FAC FEL - NEKO")):
    """bench --site X execute facex_multi.api.print_format_cargos.patch_site"""
    bdir = frappe.get_site_path("private", "backups")
    os.makedirs(bdir, exist_ok=True)
    for name in names:
        if not frappe.db.exists("Print Format", name):
            print("no existe", name); continue
        html = frappe.db.get_value("Print Format", name, "html") or ""
        new, ok = patch_html(html)
        if not ok:
            print("sin cambios", name); continue
        bk = os.path.join(bdir, f"print_format_{name.replace(' ', '_')}_{frappe.utils.now_datetime():%Y%m%d_%H%M%S}.html")
        open(bk, "w").write(html)
        frappe.db.set_value("Print Format", name, "html", new)
        frappe.db.commit()
        print("parchado", name, "backup:", bk)
