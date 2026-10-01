# -*- coding: utf-8 -*-
"""Rellena el cruce recargo cobrado ↔ comisión real en las liquidaciones viejas.

`recargo_cobrado`, `flete_cobrado`, `diferencia_comision` y `resultado_comision`
se calculan en `validate`, así que una liquidación cargada antes de que
existieran los campos los tiene en cero y el informe Control de Liquidaciones
la muestra sin diferencia. Esto NO cambia ningún dato de negocio: solo deriva
columnas informativas desde la factura ya conciliada y la comisión que ya
traía la fila.
"""
import frappe
from frappe.utils import flt


def execute():
    tabla = "FacEx Liquidacion Transportista Detalle"
    if not frappe.db.table_exists(tabla):
        return
    meta = frappe.get_meta(tabla)
    if not meta.has_field("recargo_cobrado"):
        return

    from facex_multi.api.recargo import recargo_estimado_por_factura

    filas = frappe.get_all(
        tabla,
        filters={"parenttype": "FacEx Liquidacion Transportista"},
        fields=["name", "parent", "sales_invoice", "match_encontrado", "valor_comision"],
    )
    if not filas:
        return

    facturas = [f.sales_invoice for f in filas if f.sales_invoice]
    cargos = recargo_estimado_por_factura(facturas) if facturas else {}

    por_padre = {}
    for f in filas:
        c = cargos.get(f.sales_invoice) or {}
        recargo = flt(c.get("recargo"))
        flete = flt(c.get("flete"))
        if f.match_encontrado:
            dif = flt(recargo - flt(f.valor_comision), 2)
            estado = ("Ganancia" if dif > 0.005 else "Pérdida" if dif < -0.005 else "Exacto")
        else:
            dif, estado = 0.0, "Sin match"
        frappe.db.set_value(tabla, f.name, {
            "recargo_cobrado": recargo,
            "flete_cobrado": flete,
            "diferencia_comision": dif,
            "resultado_comision": estado,
        }, update_modified=False)

        acc = por_padre.setdefault(f.parent, {"r": 0.0, "f": 0.0, "c": 0.0, "g": 0.0, "p": 0.0})
        if f.match_encontrado:
            acc["r"] += recargo
            acc["f"] += flete
            acc["c"] += flt(f.valor_comision)
            if dif > 0:
                acc["g"] += dif
            else:
                acc["p"] += -dif

    for padre, a in por_padre.items():
        frappe.db.set_value("FacEx Liquidacion Transportista", padre, {
            "total_recargo_cobrado": flt(a["r"], 2),
            "total_flete_cobrado": flt(a["f"], 2),
            "total_comision_real": flt(a["c"], 2),
            "total_diferencia": flt(a["r"] - a["c"], 2),
            "total_ganancia": flt(a["g"], 2),
            "total_perdida": flt(a["p"], 2),
        }, update_modified=False)

    frappe.db.commit()
