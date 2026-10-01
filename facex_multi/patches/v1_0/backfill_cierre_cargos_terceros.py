# -*- coding: utf-8 -*-
"""Rellena venta neta y cargos de terceros en los cierres ya guardados.

Los cierres cerrados antes del rediseño (2026-09-30) tienen esos campos en cero
porque no existían, así que la columna «Terceros» de la lista y el bloque del
resumen salían vacíos y parecía que el cálculo estaba roto.

Se deriva del propio snapshot congelado, con la misma regla que
`cierre.upgrade_snapshot`: antes del rediseño TODO recargo/flete era pasarela
(iba contra cuentas de pasivo). NO se toca `total_a_depositar` ni ninguna otra
cifra congelada, ni el `snapshot_json`.
"""
import json

import frappe
from frappe.utils import flt


def execute():
    if not frappe.db.table_exists("FacEx Cierre Diario"):
        return
    meta = frappe.get_meta("FacEx Cierre Diario")
    if not meta.has_field("cargos_pasarela"):
        return

    for c in frappe.get_all("FacEx Cierre Diario",
                            fields=["name", "total_venta", "flete_facturado",
                                    "recargo_facturado", "venta_sin_descuento",
                                    "venta_con_descuento", "ajuste_impuestos",
                                    "cargos_pasarela", "snapshot_json"]):
        # Si ya trae el desglose (cierre creado con la versión nueva), no tocar.
        if flt(c.cargos_pasarela):
            continue
        snap = {}
        try:
            snap = json.loads(c.snapshot_json or "{}") or {}
        except Exception:
            pass
        if "cargos_pasarela" in snap:
            # El snapshot ya es nuevo: basta con subir sus cifras al documento.
            recargo = flt(snap.get("recargo_pasarela"))
            flete = flt(snap.get("flete_pasarela"))
            venta_neta = flt(snap.get("venta_neta"))
        else:
            recargo = flt(snap.get("recargo_facturado") or c.recargo_facturado)
            flete = flt(snap.get("flete_facturado") or c.flete_facturado)
            venta_neta = flt(c.total_venta) - (recargo + flete)

        frappe.db.set_value("FacEx Cierre Diario", c.name, {
            "recargo_pasarela": round(recargo, 2),
            "flete_pasarela": round(flete, 2),
            "cargos_pasarela": round(recargo + flete, 2),
            "venta_neta": round(venta_neta, 2),
        }, update_modified=False)

    frappe.db.commit()
