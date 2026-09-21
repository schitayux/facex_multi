# -*- coding: utf-8 -*-
"""Tipo de familia (GENERICO / ETICO) e indicador de IVA por ítem.

En Guatemala los medicamentos genéricos están exentos de IVA (art. 7 núm. 15 de
la Ley del IVA). La ficha del Item lleva `custom_facex_tipo_familia`,
`custom_facex_indicador_iva` (IVA / EXE) y, para los exentos, la frase legal
`custom_facex_frase_exencion` que se imprime al pie del detalle de la factura.

El cálculo de impuestos lo hace ERPNext con el Item Tax Template del ítem
(plantilla al 0% para los exentos); este módulo solo expone el indicador para
que los facturadores (clásico y screen) no estimen IVA sobre esas filas y para
que el impreso muestre la leyenda.
"""
from __future__ import annotations

import frappe

FRASE_EXENCION_GENERICOS = (
    "* Medicamentos genéricos o antirretrovirales . Exenta del IVA "
    "( art. 7 núm 15 Ley del IVA )"
)

FIELDS = ("custom_facex_tipo_familia", "custom_facex_indicador_iva", "custom_facex_frase_exencion")


def ensure_item_familia_tipo_fields():
    """Crea/actualiza los custom fields de tipo de familia e IVA en Item. Idempotente
    (after_migrate). En disfavil los dos primeros ya existían creados a mano el
    2026-09-08; create_custom_fields los actualiza sin duplicar."""
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    create_custom_fields(
        {
            "Item": [
                {
                    "fieldname": "custom_facex_tipo_familia",
                    "label": "Tipo Familia",
                    "fieldtype": "Select",
                    "options": "\nGENERICO\nETICO",
                    "insert_after": "custom_costo_estandar",
                    "translatable": 0,
                    "module": "FacEx Multi",
                },
                {
                    "fieldname": "custom_facex_indicador_iva",
                    "label": "Indicador IVA",
                    "fieldtype": "Select",
                    "options": "\nIVA\nEXE",
                    "insert_after": "custom_facex_tipo_familia",
                    "translatable": 0,
                    "module": "FacEx Multi",
                },
                {
                    "fieldname": "custom_facex_frase_exencion",
                    "label": "Frase",
                    "fieldtype": "Select",
                    "options": "\n" + FRASE_EXENCION_GENERICOS,
                    "insert_after": "custom_facex_indicador_iva",
                    "depends_on": 'eval:doc.custom_facex_tipo_familia=="GENERICO"',
                    "description": "Leyenda de exención que se imprime al pie del detalle de la factura.",
                    "translatable": 0,
                    "module": "FacEx Multi",
                },
            ]
        },
        update=True,
    )


def _item_fields_available() -> bool:
    meta = frappe.get_meta("Item")
    return all(meta.has_field(f) for f in FIELDS[:2])


def is_item_tax_exempt(item_code: str, company: str = None) -> bool:
    """True si la ficha del ítem lo marca exento: indicador EXE, familia GENERICO
    o su Item Tax Template para la compañía sin ninguna tasa > 0."""
    if not item_code:
        return False
    if _item_fields_available():
        row = frappe.db.get_value(
            "Item", item_code,
            ["custom_facex_indicador_iva", "custom_facex_tipo_familia"], as_dict=True,
        )
        if row and ((row.custom_facex_indicador_iva or "").upper() == "EXE"
                    or (row.custom_facex_tipo_familia or "").upper() == "GENERICO"):
            return True

    templates = frappe.get_all(
        "Item Tax", filters={"parent": item_code, "parenttype": "Item"},
        pluck="item_tax_template",
    )
    if not templates:
        return False
    if company:
        templates = [t for t in templates
                     if frappe.db.get_value("Item Tax Template", t, "company") == company] or templates
    for tpl in templates:
        rates = frappe.get_all("Item Tax Template Detail", filters={"parent": tpl}, pluck="tax_rate")
        if rates and all((r or 0) == 0 for r in rates):
            return True
    return False


def tax_exempt_sql_expr(alias: str = "i") -> str:
    """Expresión SQL (0/1) para marcar filas exentas en listados; tolera sitios
    donde los campos aún no existen (before migrate)."""
    if not _item_fields_available():
        return "0"
    return (
        f"CASE WHEN UPPER(IFNULL({alias}.custom_facex_indicador_iva,'')) = 'EXE' "
        f"OR UPPER(IFNULL({alias}.custom_facex_tipo_familia,'')) = 'GENERICO' THEN 1 ELSE 0 END"
    )


def get_exemption_legends(items) -> list:
    """Frases de exención distintas de los ítems de una factura (para el impreso)."""
    if not frappe.get_meta("Item").has_field("custom_facex_frase_exencion"):
        return []
    seen, out = set(), []
    for it in items or []:
        code = it.get("item_code") if isinstance(it, dict) else getattr(it, "item_code", None)
        if not code:
            continue
        frase = frappe.db.get_value("Item", code, "custom_facex_frase_exencion")
        if frase and frase not in seen:
            seen.add(frase)
            out.append(frase)
    return out
