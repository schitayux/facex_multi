# -*- coding: utf-8 -*-
"""Reportes de FacEx Compras (/app/facex-compras/reportes).

Tres reportes, cada uno con su permiso (denegado por defecto) además de
puede_compras:

  antiguedad  Antigüedad de saldos de proveedores (cuentas por pagar HOY, por
              rangos de vencimiento) — reporte_compras_antiguedad.
  compras     Compras por período: facturas de compra y notas de crédito, por
              proveedor, mes o producto, con totales con y sin IVA —
              reporte_compras_periodo.
  pagos       Pagos a proveedores por forma de pago, con las facturas que
              cubren — reporte_compras_pagos.

Respetan el alcance de compras del usuario («Solo lo creado por mí»). Todos
devuelven la misma estructura —resumen + detalle con una `clave` para filtrar—
que usan la pantalla y la exportación a Excel / PDF.

Saldos: siempre el outstanding / unallocated nativo (sin libro paralelo). El
saldo es el de hoy: ERPNext no guarda el saldo histórico por fecha en el
documento.
"""
from __future__ import annotations

from collections import OrderedDict, defaultdict

import frappe
from frappe.utils import flt, getdate, today

from facex_multi.api.compras.common import is_own_scope, require_purchase

MAX_DIAS = 366
MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto",
         "Septiembre", "Octubre", "Noviembre", "Diciembre"]
PERMISO = {
    "antiguedad": "reporte_compras_antiguedad",
    "compras": "reporte_compras_periodo",
    "pagos": "reporte_compras_pagos",
}
TITULO = {
    "antiguedad": "Antigüedad de saldos de proveedores",
    "compras": "Compras por período",
    "pagos": "Pagos a proveedores",
}


def _require(report: str, company: str = None) -> str:
    if report not in PERMISO:
        frappe.throw("Reporte no válido.")
    return require_purchase(company, "puede_compras", PERMISO[report],
                            msg=f"No tiene permiso para el reporte «{TITULO[report]}».")


def _periodo(desde, hasta) -> tuple:
    if not desde or not hasta:
        frappe.throw("Indique el período: fecha Desde y fecha Hasta.")
    d, h = getdate(desde), getdate(hasta)
    if h < d:
        frappe.throw("La fecha Hasta no puede ser menor a la fecha Desde.")
    if (h - d).days + 1 > MAX_DIAS:
        frappe.throw(f"El período máximo es de {MAX_DIAS} días.")
    return d, h


def _mes_label(mes: str) -> str:
    y, m = mes.split("-")
    return f"{MESES[int(m) - 1]} {y}"


def _owner_sql(company: str, alias: str, params: dict) -> str:
    if is_own_scope(company):
        params["owner"] = frappe.session.user
        return f" AND {alias}.owner = %(owner)s"
    return ""


def _supplier_name(names) -> dict:
    names = [n for n in set(names) if n]
    if not names:
        return {}
    return dict(frappe.db.sql("SELECT name, supplier_name FROM `tabSupplier` WHERE name IN %s", (tuple(names),)))


# ---------------------------------------------------------------------------
# 1. Antigüedad de saldos
# ---------------------------------------------------------------------------

RANGOS = [("por_vencer", "Por vencer"), ("d30", "1 a 30 días"), ("d60", "31 a 60 días"),
          ("d90", "61 a 90 días"), ("d90m", "Más de 90 días")]


def _rango(dias: int) -> str:
    if dias <= 0:
        return "por_vencer"
    return "d30" if dias <= 30 else "d60" if dias <= 60 else "d90" if dias <= 90 else "d90m"


def _antiguedad(company: str, supplier: str = None, **_) -> dict:
    params = {"company": company, "supplier": supplier}
    own = _owner_sql(company, "pi", params)
    rows = frappe.db.sql(
        f"""
        SELECT pi.name, pi.supplier, pi.supplier_name, pi.bill_no, pi.posting_date,
               COALESCE(pi.due_date, pi.posting_date) AS due_date, pi.is_return,
               pi.outstanding_amount * IF(IFNULL(pi.conversion_rate, 0) = 0, 1, pi.conversion_rate) AS saldo
        FROM `tabPurchase Invoice` pi
        WHERE pi.company = %(company)s AND pi.docstatus = 1 AND pi.outstanding_amount != 0
          AND (%(supplier)s IS NULL OR %(supplier)s = '' OR pi.supplier = %(supplier)s) {own}
        ORDER BY pi.supplier_name, due_date, pi.name
        """, params, as_dict=True)
    hoy = getdate(today())
    por = OrderedDict()
    detalle = []
    for r in rows:
        dias = (hoy - getdate(r.due_date)).days
        rg = _rango(dias)
        s = por.setdefault(r.supplier, {"nombre": r.supplier_name or r.supplier, "facturas": 0, "notas": 0.0,
                                         **{k: 0.0 for k, _l in RANGOS}})
        if r.is_return:
            s["notas"] += flt(r.saldo)  # saldo a favor (negativo)
        else:
            s["facturas"] += 1
            s[rg] += flt(r.saldo)
        detalle.append({"clave": r.supplier, "doc": r.name, "kind": "nc" if r.is_return else "fc", "v": [
            r.supplier_name or r.supplier, r.name, r.bill_no or "", str(r.posting_date), str(r.due_date),
            max(dias, 0) if not r.is_return else 0, "Nota de crédito" if r.is_return else dict(RANGOS)[rg],
            round(flt(r.saldo), 2)]})
    adv = {}
    for r in frappe.db.sql(
        f"""SELECT party, SUM(unallocated_amount) AS a FROM `tabPayment Entry` pe
            WHERE pe.company = %(company)s AND pe.docstatus = 1 AND pe.payment_type = 'Pay'
              AND pe.party_type = 'Supplier' AND pe.unallocated_amount > 0
              AND (%(supplier)s IS NULL OR %(supplier)s = '' OR pe.party = %(supplier)s) {_owner_sql(company, 'pe', params)}
            GROUP BY party""", params, as_dict=True):
        adv[r.party] = flt(r.a)
    nombres = _supplier_name(adv)
    for sup, a in adv.items():
        por.setdefault(sup, {"nombre": nombres.get(sup) or sup, "facturas": 0, "notas": 0.0,
                             **{k: 0.0 for k, _l in RANGOS}})
    out_rows, tot = [], defaultdict(float)
    for sup, s in por.items():
        vencido = s["d30"] + s["d60"] + s["d90"] + s["d90m"]
        bruto = s["por_vencer"] + vencido
        neto = bruto + s["notas"] - adv.get(sup, 0.0)
        v = [s["nombre"], s["facturas"], *[round(s[k], 2) for k, _l in RANGOS], round(bruto, 2),
             round(s["notas"], 2), round(adv.get(sup, 0.0), 2), round(neto, 2)]
        out_rows.append({"clave": sup, "v": v})
        for i, x in enumerate(v[1:], start=1):
            tot[i] += flt(x)
    out_rows.sort(key=lambda r: -r["v"][-1])
    return {
        "head": ["Proveedor", "Facturas", *[l for _k, l in RANGOS], "Saldo facturas", "Notas de crédito",
                 "Anticipos", "Saldo neto"],
        "tipos": ["t", "i", "n", "n", "n", "n", "n", "n", "n", "n", "n"],
        "rows": out_rows,
        "total": ["TOTAL", int(tot[1]), *[round(tot[i], 2) for i in range(2, 11)]],
        "dhead": ["Proveedor", "Factura", "No. Proveedor", "Fecha", "Vence", "Días vencida", "Rango", "Saldo"],
        "dtipos": ["t", "t", "t", "d", "d", "i", "t", "n"],
        "detalle": detalle,
        "nota": "Saldos de hoy (el vencimiento se mide contra la fecha de hoy). Las notas de crédito y los anticipos restan.",
    }


# ---------------------------------------------------------------------------
# 2. Compras por período
# ---------------------------------------------------------------------------

AGRUPAR = ("proveedor", "mes", "producto")


def _compras(company: str, desde=None, hasta=None, agrupar: str = "proveedor", supplier: str = None, **_) -> dict:
    d, h = _periodo(desde, hasta)
    if agrupar not in AGRUPAR:
        frappe.throw("Agrupación no válida.")
    params = {"company": company, "desde": d, "hasta": h, "supplier": supplier}
    own = _owner_sql(company, "pi", params)
    cr = "IF(IFNULL(pi.conversion_rate, 0) = 0, 1, pi.conversion_rate)"
    sup_cond = "AND (%(supplier)s IS NULL OR %(supplier)s = '' OR pi.supplier = %(supplier)s)"
    if agrupar == "producto":
        lines = frappe.db.sql(
            f"""
            SELECT pi.name, pi.posting_date, pi.supplier, pi.supplier_name, pi.is_return,
                   pii.item_code, pii.item_name, pii.qty, pii.uom,
                   pii.net_amount * {cr} AS neto,
                   pii.net_amount * {cr} * IF(IFNULL(pi.net_total, 0) = 0, 1, pi.grand_total / pi.net_total) AS total
            FROM `tabPurchase Invoice Item` pii JOIN `tabPurchase Invoice` pi ON pi.name = pii.parent
            WHERE pi.company = %(company)s AND pi.docstatus = 1 AND pi.posting_date BETWEEN %(desde)s AND %(hasta)s
              {sup_cond} {own}
            ORDER BY pii.item_code, pi.posting_date, pi.name
            """, params, as_dict=True)
        por = OrderedDict()
        detalle = []
        for r in lines:
            g = por.setdefault(r.item_code, {"nombre": r.item_name or r.item_code, "lineas": 0, "qty": 0.0, "neto": 0.0, "total": 0.0})
            g["lineas"] += 1
            g["qty"] += flt(r.qty)
            g["neto"] += flt(r.neto)
            g["total"] += flt(r.total)
            detalle.append({"clave": r.item_code, "doc": r.name, "kind": "nc" if r.is_return else "fc", "v": [
                f"{r.item_code} · {r.item_name or ''}", r.name, str(r.posting_date), r.supplier_name or r.supplier,
                "Nota de crédito" if r.is_return else "Factura", round(flt(r.qty), 3), round(flt(r.neto), 2),
                round(flt(r.total), 2)]})
        rows = [{"clave": k, "v": [f"{k} · {g['nombre']}", g["lineas"], round(g["qty"], 3), round(g["neto"], 2),
                                   round(g["total"] - g["neto"], 2), round(g["total"], 2)]} for k, g in por.items()]
        rows.sort(key=lambda r: -r["v"][-1])
        head = ["Producto", "Líneas", "Cantidad", "Neto (sin IVA)", "IVA", "Total (con IVA)"]
        tipos = ["t", "i", "n", "n", "n", "n"]
        dhead = ["Producto", "Documento", "Fecha", "Proveedor", "Tipo", "Cantidad", "Neto (sin IVA)", "Total (con IVA)"]
        dtipos = ["t", "t", "d", "t", "t", "n", "n", "n"]
    else:
        docs = frappe.db.sql(
            f"""
            SELECT pi.name, pi.posting_date, pi.supplier, pi.supplier_name, pi.bill_no, pi.is_return,
                   pi.net_total * {cr} AS neto, pi.grand_total * {cr} AS total
            FROM `tabPurchase Invoice` pi
            WHERE pi.company = %(company)s AND pi.docstatus = 1 AND pi.posting_date BETWEEN %(desde)s AND %(hasta)s
              {sup_cond} {own}
            ORDER BY pi.posting_date, pi.name
            """, params, as_dict=True)
        por = OrderedDict()
        detalle = []
        for r in docs:
            clave = r.supplier if agrupar == "proveedor" else r.posting_date.strftime("%Y-%m")
            nombre = (r.supplier_name or r.supplier) if agrupar == "proveedor" else _mes_label(clave)
            g = por.setdefault(clave, {"nombre": nombre, "docs": 0, "notas": 0, "neto": 0.0, "total": 0.0})
            g["docs"] += 0 if r.is_return else 1
            g["notas"] += 1 if r.is_return else 0
            g["neto"] += flt(r.neto)
            g["total"] += flt(r.total)
            detalle.append({"clave": clave, "doc": r.name, "kind": "nc" if r.is_return else "fc", "v": [
                r.name, str(r.posting_date), r.supplier_name or r.supplier, r.bill_no or "",
                "Nota de crédito" if r.is_return else "Factura", round(flt(r.neto), 2),
                round(flt(r.total) - flt(r.neto), 2), round(flt(r.total), 2)]})
        rows = [{"clave": k, "v": [g["nombre"], g["docs"], g["notas"], round(g["neto"], 2),
                                   round(g["total"] - g["neto"], 2), round(g["total"], 2)]} for k, g in por.items()]
        rows.sort(key=(lambda r: r["clave"]) if agrupar == "mes" else (lambda r: -r["v"][-1]))
        head = ["Proveedor" if agrupar == "proveedor" else "Mes", "Facturas", "Notas de crédito",
                "Neto (sin IVA)", "IVA", "Total (con IVA)"]
        tipos = ["t", "i", "i", "n", "n", "n"]
        dhead = ["Documento", "Fecha", "Proveedor", "No. Proveedor", "Tipo", "Neto (sin IVA)", "IVA", "Total (con IVA)"]
        dtipos = ["t", "d", "t", "t", "t", "n", "n", "n"]
    total = ["TOTAL"] + [round(sum(flt(r["v"][i]) for r in rows), 3 if head[i] == "Cantidad" else 2) if tipos[i] != "t" else ""
                         for i in range(1, len(head))]
    for i, t in enumerate(tipos):
        if t == "i":
            total[i] = int(total[i])
    return {"head": head, "tipos": tipos, "rows": rows, "total": total, "dhead": dhead, "dtipos": dtipos,
            "detalle": detalle,
            "nota": "Facturas de compra validadas menos sus notas de crédito. Importes en la moneda de la compañía."}


# ---------------------------------------------------------------------------
# 3. Pagos a proveedores
# ---------------------------------------------------------------------------

FORMAS = [("Efectivo", "Efectivo"), ("Cheque", "Cheque"), ("Transferencia", "Transferencia"),
          ("Depósito bancario", "Depósito"), ("Otros", "Otros")]


def _forma(pe) -> str:
    f = (pe.get("forma") or pe.get("mode_of_payment") or "").strip()
    for clave, _l in FORMAS[:-1]:
        if f.lower().startswith(clave.lower()[:6]):
            return clave
    return "Otros"


def _pagos(company: str, desde=None, hasta=None, supplier: str = None, **_) -> dict:
    d, h = _periodo(desde, hasta)
    params = {"company": company, "desde": d, "hasta": h, "supplier": supplier}
    own = _owner_sql(company, "pe", params)
    has_forma = frappe.get_meta("Payment Entry").has_field("facex_forma_pago")
    pes = frappe.db.sql(
        f"""
        SELECT pe.name, pe.posting_date, pe.party, pe.party_name, pe.paid_amount, pe.total_allocated_amount,
               pe.unallocated_amount, pe.mode_of_payment, pe.reference_no,
               {"pe.facex_forma_pago" if has_forma else "NULL"} AS forma
        FROM `tabPayment Entry` pe
        WHERE pe.company = %(company)s AND pe.docstatus = 1 AND pe.payment_type = 'Pay' AND pe.party_type = 'Supplier'
          AND pe.posting_date BETWEEN %(desde)s AND %(hasta)s
          AND (%(supplier)s IS NULL OR %(supplier)s = '' OR pe.party = %(supplier)s) {own}
        ORDER BY pe.posting_date, pe.name
        """, params, as_dict=True)
    refs = defaultdict(list)
    if pes:
        for r in frappe.db.sql(
            """SELECT parent, reference_name FROM `tabPayment Entry Reference`
               WHERE parenttype = 'Payment Entry' AND parent IN %s AND reference_doctype = 'Purchase Invoice'
               ORDER BY idx""", (tuple(p.name for p in pes),), as_dict=True):
            refs[r.parent].append(r.reference_name)
    por = OrderedDict()
    detalle = []
    for p in pes:
        f = _forma(p)
        g = por.setdefault(p.party, {"nombre": p.party_name or p.party, "pagos": 0, "aplicado": 0.0, "anticipo": 0.0,
                                      **{k: 0.0 for k, _l in FORMAS}})
        g["pagos"] += 1
        g["aplicado"] += flt(p.total_allocated_amount)
        g["anticipo"] += flt(p.unallocated_amount)
        g[f] += flt(p.paid_amount)
        detalle.append({"clave": p.party, "doc": p.name, "kind": "pago", "v": [
            p.party_name or p.party, p.name, str(p.posting_date), f, p.reference_no or "",
            ", ".join(refs.get(p.name) or []) or "(anticipo)", round(flt(p.paid_amount), 2),
            round(flt(p.unallocated_amount), 2)]})
    rows = [{"clave": k, "v": [g["nombre"], g["pagos"], *[round(g[c], 2) for c, _l in FORMAS],
                               round(sum(g[c] for c, _l in FORMAS), 2), round(g["anticipo"], 2)]}
            for k, g in por.items()]
    rows.sort(key=lambda r: -r["v"][-2])
    n = len(FORMAS)
    total = ["TOTAL", sum(r["v"][1] for r in rows)] + [round(sum(flt(r["v"][i]) for r in rows), 2) for i in range(2, n + 4)]
    return {
        "head": ["Proveedor", "Pagos", *[l for _c, l in FORMAS], "Total pagado", "De ello, anticipo"],
        "tipos": ["t", "i", *["n"] * (n + 2)],
        "rows": rows, "total": total,
        "dhead": ["Proveedor", "Pago", "Fecha", "Forma", "Referencia", "Facturas que cubre", "Monto pagado", "Anticipo"],
        "dtipos": ["t", "t", "d", "t", "t", "t", "n", "n"],
        "detalle": detalle,
        "nota": "Pagos validados (los cancelados no aparecen). Un pago sin facturas queda como anticipo.",
    }


_BUILD = {"antiguedad": _antiguedad, "compras": _compras, "pagos": _pagos}


def _run(report: str, company: str, filters: dict) -> dict:
    company = _require(report, company)
    out = _BUILD[report](company, **{k: v for k, v in (filters or {}).items() if k in ("supplier", "desde", "hasta", "agrupar")})
    out.update(report=report, titulo=TITULO[report], company=company, generado=str(frappe.utils.now_datetime())[:16])
    d, h = (filters or {}).get("desde"), (filters or {}).get("hasta")
    out["periodo"] = f"Del {getdate(d).strftime('%d/%m/%Y')} al {getdate(h).strftime('%d/%m/%Y')}" if d and h else \
        f"Al {getdate(today()).strftime('%d/%m/%Y')}"
    return out


@frappe.whitelist()
def get_report(report: str, company: str = None, filters=None) -> dict:
    return _run(report, company, frappe.parse_json(filters) if isinstance(filters, str) else filters)


@frappe.whitelist()
def export_report(report: str, company: str = None, filters=None, formato: str = "xlsx") -> None:
    data = _run(report, company, frappe.parse_json(filters) if isinstance(filters, str) else filters)
    fname = f"{report}_{data['company']}_{today()}"
    resumen = [r["v"] for r in data["rows"]] + [data["total"]]
    detalle = [r["v"] for r in data["detalle"]]

    if formato == "pdf":
        from frappe.utils.pdf import get_pdf
        esc = lambda v: frappe.utils.escape_html("" if v is None else str(v))  # noqa: E731

        def fmt(v, t):
            if t == "n":
                return f"{flt(v):,.2f}"
            if t == "d":
                return getdate(v).strftime("%d/%m/%Y") if v else ""
            return esc(v)

        def tabla(head, tipos, rows, total=False):
            body = ""
            for i, row in enumerate(rows):
                tds = "".join(f'<td class="{"n" if t in ("n", "i") else ""}">{fmt(c, t)}</td>'
                              for c, t in zip(row, tipos))
                body += f'<tr class="{"tot" if total and i == len(rows) - 1 else ""}">{tds}</tr>'
            return "<table><thead><tr>" + "".join(f"<th>{esc(h)}</th>" for h in head) + f"</tr></thead><tbody>{body}</tbody></table>"

        html = f"""
<div style="font-family:Helvetica,Arial,sans-serif;font-size:9px;color:#222;">
 <div style="border-bottom:2px solid #153375;padding-bottom:6px;margin-bottom:8px;">
  <div style="font-size:16px;font-weight:700;color:#153375;">{esc(data['titulo'].upper())}</div>
  <div style="font-size:11px;font-weight:700;color:#1f6f54;">{esc(data['periodo'])} · {esc(data['company'])}</div>
  <div style="color:#666;">Generado {esc(data['generado'])} · {esc(data.get('nota', ''))}</div></div>
 <div class="t">RESUMEN</div>{tabla(data['head'], data['tipos'], resumen, True)}
 <div class="t">DETALLE</div>{tabla(data['dhead'], data['dtipos'], detalle)}
</div>
<style>.t{{font-size:11px;font-weight:700;color:#153375;margin:12px 0 4px}} table{{width:100%;border-collapse:collapse}}
th,td{{border:1px solid #cdd5e0;padding:3px 5px;text-align:left}} th{{background:#eef2ff}} td.n{{text-align:right}}
tr.tot td{{background:#eef2fb;font-weight:700}}</style>"""
        frappe.response["filename"] = f"{fname}.pdf"
        frappe.response["filecontent"] = get_pdf(html, options={"orientation": "Landscape"})
        frappe.response["type"] = "pdf"
        return

    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    wb.remove(wb.active)

    def hoja(nombre, head, tipos, rows, total=False):
        ws = wb.create_sheet(nombre)
        ws.append([data["titulo"].upper()])
        ws.append([f"{data['periodo']} · {data['company']}"])
        ws.append([data.get("nota", "")])
        ws.append(head)
        for c in ws[4]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor="153375")
            c.alignment = Alignment(wrap_text=True, horizontal="center", vertical="center")
        for row in rows:
            ws.append([getdate(c) if t == "d" and c else c for c, t in zip(row, tipos)])
        for r_i in range(5, 5 + len(rows)):
            for c_i, t in enumerate(tipos, start=1):
                cell = ws.cell(row=r_i, column=c_i)
                if t == "n":
                    cell.number_format = "#,##0.00"
                elif t == "d":
                    cell.number_format = "dd/mm/yyyy"
        if total:
            for c in ws[4 + len(rows)]:
                c.font = Font(bold=True)
                c.fill = PatternFill("solid", fgColor="EEF2FB")
        ws["A1"].font = Font(bold=True, size=14, color="153375")
        ws["A2"].font = Font(bold=True, color="1F6F54")
        for i in range(1, len(head) + 1):
            ws.column_dimensions[get_column_letter(i)].width = 34 if i == 1 else 18
        ws.freeze_panes = "B5"

    hoja("Resumen", data["head"], data["tipos"], resumen, True)
    hoja("Detalle", data["dhead"], data["dtipos"], detalle)
    out = BytesIO()
    wb.save(out)
    frappe.response["filename"] = f"{fname}.xlsx"
    frappe.response["filecontent"] = out.getvalue()
    frappe.response["type"] = "binary"
