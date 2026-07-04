"""
Patch: corrige una fuga de datos entre compañías en los Print Formats
'FAC CERTIFI'/'FAC FEL' (y sus variantes '- ABBR' por compañía).

Bug: el bloque Jinja resolvía "BFEL Document Map" filtrando únicamente por
"type_docdte" (prefijo de la serie, ej. 'FCAM'), sin acotar por compañía.
Como el mismo prefijo de serie puede repetirse en varias compañías (cada
una con su propio BFEL Settings), `limit=1` sin `ORDER BY` podía devolver
el mapeo de OTRA compañía, filtrando su NIT/logo/certificador/establecimiento
en la factura impresa. Ejemplo real: FCAM-FE-0078 (compañía FACEX) imprimía
con los datos de "COMERCIALIZADORA Y DISTRIBUIDORA TOTALL, S.A.".

Fix: resolver primero "BFEL Settings" filtrando por si.company, y usar ESE
bfel_settings para acotar la búsqueda de "BFEL Document Map".

Idempotente — si el bloque ya no está presente (ya parchado a mano, como
'FAC CERTIFI - DT'), se omite sin error.
"""
import frappe

CERTIFI_OLD = '''{% set bdm_list =
frappe.get_all(
"BFEL Document Map",
filters={
"type_docdte":
serie_prefix
},
limit=1
)
%}

{% if bdm_list and bdm_list|length > 0 %}

{% set bdm=
frappe.get_doc(
"BFEL Document Map",
bdm_list[0].name
)
%}

{% set bs=
frappe.get_doc(
"BFEL Settings",
bdm.bfel_settings
)
%}

{% set company=
frappe.get_doc(
"Company",
bs.company
)
%}

{% else %}'''

CERTIFI_NEW = '''{% set bs_list=
frappe.get_all(
"BFEL Settings",
filters={
"company": si.company,
"enabled": 1
},
limit=1
)
%}

{% set bdm_list=[] %}

{% if bs_list and bs_list|length > 0 %}
{% set bdm_list=
frappe.get_all(
"BFEL Document Map",
filters={
"type_docdte": serie_prefix,
"bfel_settings": bs_list[0].name
},
limit=1
)
%}
{% endif %}

{% if bdm_list and bdm_list|length > 0 %}

{% set bdm=
frappe.get_doc(
"BFEL Document Map",
bdm_list[0].name
)
%}

{% set bs=
frappe.get_doc(
"BFEL Settings",
bs_list[0].name
)
%}

{% set company=
frappe.get_doc(
"Company",
bs.company
)
%}

{% else %}'''

FEL_OLD_1 = '''{% set bdm_list = frappe.get_all(
    "BFEL Document Map",
    filters={"type_docdte": serie_prefix},
    fields=["name","fel_document_type","bfel_settings","notes"],
    limit=1
) %}'''

FEL_NEW_1 = '''{% set bs_list = frappe.get_all("BFEL Settings", filters={"company": doc.company, "enabled": 1}, limit=1) %}

{% set bdm_list = [] %}
{% if bs_list %}
  {% set bdm_list = frappe.get_all(
      "BFEL Document Map",
      filters={"type_docdte": serie_prefix, "bfel_settings": bs_list[0].name},
      fields=["name","fel_document_type","bfel_settings","notes"],
      limit=1
  ) %}
{% endif %}'''

FEL_OLD_2 = '''{% set bdm = frappe.get_doc("BFEL Document Map", bdm_list[0].name) %}
{% set bs_list = frappe.get_all("BFEL Settings", filters={"company": doc.company, "enabled": 1}, limit=1) %}
{% if not bs_list %}
  {% set bs_list = frappe.get_all("BFEL Settings", filters={"enabled": 1}, limit=1) %}
{% endif %}
{% if bs_list %}
  {% set bs = frappe.get_doc("BFEL Settings", bs_list[0].name) %}
{% else %}
  {% set bs = frappe.get_doc("BFEL Settings", bdm.bfel_settings) %}
{% endif %}'''

FEL_NEW_2 = '''{% set bdm = frappe.get_doc("BFEL Document Map", bdm_list[0].name) %}
{% set bs = frappe.get_doc("BFEL Settings", bs_list[0].name) %}'''


def execute():
    for name in frappe.get_all("Print Format", filters={"doc_type": "Sales Invoice"}, pluck="name"):
        html = frappe.db.get_value("Print Format", name, "html") or ""
        original = html

        if CERTIFI_OLD in html:
            html = html.replace(CERTIFI_OLD, CERTIFI_NEW)

        if FEL_OLD_1 in html:
            html = html.replace(FEL_OLD_1, FEL_NEW_1)
        if FEL_OLD_2 in html:
            html = html.replace(FEL_OLD_2, FEL_NEW_2)

        if html != original:
            frappe.db.set_value("Print Format", name, "html", html)
            print(f"Print Format '{name}': corregida fuga de compañía en BFEL Document Map.")

    frappe.db.commit()
