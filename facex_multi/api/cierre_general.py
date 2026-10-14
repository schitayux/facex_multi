# -*- coding: utf-8 -*-
"""Cierre Diario General (informe gerencial).

Consolida, por Tienda/Vendedor (= usuario que factura), lo que el Cierre Diario
calcula usuario por usuario. Se arma SIEMPRE con compute_snapshot en vivo, así
que funciona aunque el usuario todavía no haya presentado su cierre; el informe
avisa qué tiendas/días están en tiempo real. Los egresos (Gastos) sí salen del
documento de Cierre Diario, que es donde se anotan.

Tabla 1 — VENTAS DEL DÍA (venta, créditos y mercadería COD SIN flete ni recargo)
          + anexo «Pagos» (transferencia/depósito, efectivo, cheques/TC, gastos,
          líquido por recibir, transferencia + fletes previo depósito).
Tabla 2 — LIQUIDACIÓN DE CXC (cobros del día de facturas de días anteriores:
          clientes al crédito y clientes COD conciliados con la liquidación).
Tabla 3 — COBROS DE FLETES (previo depósito y COD por liquidación).

Fletes «previo depósito»: flete de las facturas pagadas completas el mismo día
de la venta, en la parte que se pagó por transferencia/depósito. Se resta de la
columna Transferencia/Depósito y se suma en la última columna, de modo que
«Transferencia/Depósito + fletes previo depósito» = lo realmente depositado.

Se muestra dentro de la page del Cierre Diario (botón «Ir a Cierre Diario General»).
Permiso: reporte_cierre_general (deny-by-default). Como Ventas por Vendedor, NO
aplica el Alcance en Ventas: el permiso mismo implica ver a todas las tiendas.
"""
from __future__ import annotations

from collections import OrderedDict

import frappe
from frappe.utils import add_days, cint, flt, getdate, today

from facex_multi.api import cierre as _c

MAX_DIAS = 62
MAX_PARES = 600
EPS = 0.004


def _parse_multi(value) -> list:
    if isinstance(value, str):
        value = frappe.parse_json(value) if value.startswith("[") else ([value] if value else [])
    return [v for v in (value or []) if v]


def _estado_dia(cs: dict, series: set) -> str:
    """«cerrado» / «abierto» (hay cierre sin cerrar) / «sin_cierre»."""
    if not cs:
        return "sin_cierre"
    if _c._modo_dia(cs) == "todas":
        return "cerrado" if cs[_c.SERIE_TODAS]["estado"] == "Cerrado" else "abierto"
    need = series or set(cs.keys())
    return "cerrado" if all((cs.get(s) or {}).get("estado") == "Cerrado" for s in need) else "abierto"


def _pares(company, start, end, usuarios) -> tuple:
    """{(fecha, usuario)} con actividad en el rango + series con venta por par."""
    corte_cond, corte_vals = _c._corte_si(company)
    user_cond = "AND si.owner IN %(usuarios)s" if usuarios else ""
    base = {"company": company, "start": start, "end": end, "ce": _c.CONTRA_ENTREGA,
            "usuarios": tuple(usuarios or ()), **corte_vals}
    series = {}
    pares = set()
    for r in frappe.db.sql(
        f"""
        SELECT DISTINCT si.owner, si.posting_date, si.naming_series
        FROM `tabSales Invoice` si
        WHERE si.company = %(company)s AND si.docstatus = 1
          AND si.posting_date BETWEEN %(start)s AND %(end)s
          AND {corte_cond} {user_cond}
        """, base, as_dict=True,
    ):
        key = (getdate(r.posting_date), r.owner)
        pares.add(key)
        series.setdefault(key, set()).add(_c._norm_serie(r.naming_series))
    if frappe.db.table_exists("eFast Invoice Payment"):
        for r in frappe.db.sql(
            f"""
            SELECT DISTINCT si.owner, p.payment_date
            FROM `tabeFast Invoice Payment` p
            JOIN `tabSales Invoice` si ON si.name = p.parent
            WHERE si.company = %(company)s AND si.docstatus = 1
              AND p.parenttype = 'Sales Invoice' AND p.payment_method != %(ce)s
              AND p.payment_date BETWEEN %(start)s AND %(end)s
              AND si.posting_date < p.payment_date
              AND {corte_cond} {user_cond}
            """, base, as_dict=True,
        ):
            pares.add((getdate(r.payment_date), r.owner))
    # Cierres con egresos aunque ese día no haya movimiento.
    for r in frappe.db.sql(
        """
        SELECT DISTINCT usuario, fecha FROM `tabFacEx Cierre Diario`
        WHERE company = %(company)s AND fecha BETWEEN %(start)s AND %(end)s
        """ + ("AND usuario IN %(usuarios)s" if usuarios else ""), base, as_dict=True,
    ):
        pares.add((getdate(r.fecha), r.usuario))
    return pares, series


def _blank(usuario, nombre) -> dict:
    return {
        "usuario": usuario, "nombre": nombre, "dias": 0, "dias_sin_cierre": [],
        "venta": 0.0, "creditos": 0.0, "cod": 0.0, "total": 0.0,
        "transfer": 0.0, "efectivo": 0.0, "cheque_tc": 0.0, "gastos": 0.0,
        "liquido": 0.0, "transfer_fletes": 0.0,
        "cxc_credito": 0.0, "cxc_cod": 0.0, "cxc_total": 0.0,
        "fletes_pd_cant": 0, "fletes_pd_q": 0.0, "fletes_liq_cant": 0, "fletes_liq_q": 0.0,
        "fletes_total_cant": 0, "fletes_total_q": 0.0,
        "detalle": {"facturas": [], "recuperaciones": [], "fletes": []},
    }


_SUMAS = (
    "venta", "creditos", "cod", "total", "transfer", "efectivo", "cheque_tc", "gastos",
    "liquido", "transfer_fletes", "cxc_credito", "cxc_cod", "cxc_total",
    "fletes_pd_cant", "fletes_pd_q", "fletes_liq_cant", "fletes_liq_q",
    "fletes_total_cant", "fletes_total_q",
)


@frappe.whitelist()
def get_cierre_general(start_date: str = None, end_date: str = None,
                       usuarios=None, company: str = None) -> dict:
    from facex_multi.api.corte import get_corte_fecha
    from facex_multi.api.permissions import get_facex_permissions_for_company

    company = _c.get_effective_company(company)
    _c._assert_module_access(company)
    # Permiso propio, deny-by-default (System Manager siempre lo tiene). El informe
    # vive dentro del Cierre Diario, no en Reportes, así que no depende de los
    # checks reporte_* de la puerta de Reportes.
    if not get_facex_permissions_for_company(company).get("reporte_cierre_general"):
        frappe.throw("No tiene permiso para ver el Cierre Diario General.", frappe.PermissionError)

    start = getdate(start_date or today())
    end = min(getdate(end_date or start), getdate(today()))
    if end < start:
        start, end = end, start
    if (end - start).days + 1 > MAX_DIAS:
        frappe.throw(f"El rango máximo es de {MAX_DIAS} días. Reduzca las fechas.")
    corte = get_corte_fecha(company)
    if corte and start < corte:
        start = corte
    if end < start:
        return _vacio(company, start, end)

    usuarios = _parse_multi(usuarios)
    pares, series = _pares(company, start, end, usuarios)
    if len(pares) > MAX_PARES:
        frappe.throw("Demasiados días/tiendas para calcular de una vez. Reduzca el rango o filtre por usuario.")

    cierres = _c._cierres_por_dia(company, {"fecha": ["between", [start, end]]})
    egresos = {}
    for r in frappe.db.sql(
        """
        SELECT usuario, fecha, SUM(total_egresos) AS e FROM `tabFacEx Cierre Diario`
        WHERE company = %(c)s AND fecha BETWEEN %(s)s AND %(e)s GROUP BY usuario, fecha
        """, {"c": company, "s": start, "e": end}, as_dict=True,
    ):
        egresos[(getdate(r.fecha), r.usuario)] = flt(r.e)

    nombres = {
        u.name: u.full_name or u.name for u in frappe.get_all(
            "User", filters={"name": ["in", list({u for _f, u in pares}) or [""]]},
            fields=["name", "full_name"])
    }

    filas = OrderedDict()
    for fecha, usuario in sorted(pares, key=lambda x: (nombres.get(x[1], x[1]).lower(), x[0])):
        fila = filas.setdefault(usuario, _blank(usuario, nombres.get(usuario, usuario)))
        snap = _c.compute_snapshot(company, fecha, usuario, _c.SERIE_TODAS)
        _acumular(fila, snap, fecha, egresos.get((fecha, usuario), 0.0))
        # «Aún sin cierre» y «EN VIVO» aplican solo a días con venta (al menos una
        # factura emitida); un día sin venta no necesita cierre.
        if series.get((fecha, usuario)) and _estado_dia(
                cierres.get((str(fecha), usuario)) or {}, series[(fecha, usuario)]) != "cerrado":
            fila["dias_sin_cierre"].append(str(fecha))

    # Días sin venta por usuario (los que aparecen en el informe y los que se
    # eligieron en el filtro aunque no tengan movimiento).
    fechas = [add_days(start, i) for i in range((end - start).days + 1)]
    con_venta = {k for k, v in series.items() if v}
    for u in usuarios:
        filas.setdefault(u, _blank(u, nombres.get(u) or frappe.db.get_value("User", u, "full_name") or u))
    sin_venta = []
    for usuario, f in filas.items():
        # Sábado y domingo no se reportan como «sin venta» (si hubo venta, el día
        # igual aparece en las tablas).
        dias = [str(d) for d in fechas if d.weekday() < 5 and (d, usuario) not in con_venta]
        f["dias_sin_venta"] = dias
        if dias:
            sin_venta.append({"usuario": usuario, "nombre": f["nombre"], "fechas": dias})

    rows = [f for f in filas.values() if f["dias"]]
    tot = _blank("", "TOTAL")
    for f in rows:
        for k in _SUMAS:
            tot[k] += f[k]
        f["en_vivo"] = 1 if f["dias_sin_cierre"] else 0
        f["dias_sin_cierre"].sort()
        _redondear(f)
    _redondear(tot)
    tot.pop("detalle", None)

    return {
        "company": company,
        "start_date": str(start), "end_date": str(end),
        "es_rango": int(start != end),
        "rows": rows,
        "totales": tot,
        "mostrar_cheque_tc": int(any(abs(f["cheque_tc"]) > EPS for f in rows)),
        "sin_cierre": [
            {"usuario": f["usuario"], "nombre": f["nombre"], "fechas": f["dias_sin_cierre"]}
            for f in rows if f["dias_sin_cierre"]
        ],
        "sin_venta": sin_venta,
        "hoy": today(),
    }


def _vacio(company, start, end) -> dict:
    tot = _blank("", "TOTAL")
    tot.pop("detalle")
    return {"company": company, "start_date": str(start), "end_date": str(end),
            "es_rango": int(start != end), "rows": [], "totales": tot,
            "mostrar_cheque_tc": 0, "sin_cierre": [], "sin_venta": [], "hoy": today()}


def _redondear(f: dict) -> None:
    for k in _SUMAS:
        f[k] = round(f[k], 2) if not k.endswith("_cant") else int(f[k])


def _acumular(fila: dict, snap: dict, fecha, gastos: float) -> None:
    fila["dias"] += 1
    f_str = str(fecha)
    flete_pd_total = 0.0
    for f in snap.get("facturas") or []:
        gt = flt(f.get("grand_total"))
        cargos = abs(flt(f.get("flete")) + flt(f.get("recargo")))
        cargos = min(cargos, abs(gt))
        if gt < 0:
            cargos = -cargos
        ratio = (cargos / gt) if gt else 0.0
        venta = gt - cargos
        cred = flt(f.get("credito")) * (1 - ratio) if f.get("clasificacion") == "credito" else 0.0
        cod = flt(f.get("contra_entrega")) * (1 - ratio) if f.get("clasificacion") == "contra_entrega" else 0.0

        flete_pd = 0.0
        pagado_dia = flt(f.get("pagado_dia"))
        if (flt(f.get("flete")) > EPS and gt > 0 and f.get("clasificacion") != "contra_entrega"
                and pagado_dia >= gt - 0.01 and pagado_dia > EPS):
            flete_pd = flt(f.get("flete")) * flt(f.get("transfer_dia")) / pagado_dia
        if flete_pd > EPS:
            flete_pd_total += flete_pd
            fila["fletes_pd_cant"] += 1
            fila["detalle"]["fletes"].append({
                "tipo": "PD", "fecha": f_str, "factura": f["sales_invoice"],
                "cliente": f.get("customer_name"), "monto": round(flete_pd, 2), "guia": "",
            })
        fila["venta"] += venta
        fila["creditos"] += cred
        fila["cod"] += cod
        fila["detalle"]["facturas"].append({
            "fecha": f_str, "factura": f["sales_invoice"], "cliente": f.get("customer_name"),
            "total": round(gt, 2), "cargos": round(cargos, 2), "venta": round(venta, 2),
            "clasificacion": f.get("clasificacion"), "credito": round(cred, 2), "cod": round(cod, 2),
            "formas_pago": f.get("formas_pago"), "devolucion": cint(f.get("es_devolucion")),
        })

    fila["fletes_pd_q"] += flete_pd_total
    transfer_real = flt(snap.get("cobro_transferencia"))
    fila["transfer"] += max(transfer_real - flete_pd_total, 0.0)
    fila["transfer_fletes"] += transfer_real
    fila["efectivo"] += flt(snap.get("cobro_efectivo"))
    fila["cheque_tc"] += flt(snap.get("cobro_cheque")) + flt(snap.get("cobro_tarjeta"))
    fila["gastos"] += gastos
    # Líquido por recibir = efectivo del día − gastos (el efectivo incluye también
    # lo cobrado de cartera anterior, igual que el depósito del Cierre Diario).
    fila["liquido"] += flt(snap.get("cobro_efectivo")) - gastos

    guias_liq = set()
    for r in snap.get("abonos_detalle") or []:
        tipo = r.get("tipo")
        if tipo not in ("credito", "cod"):
            continue
        amt = flt(r.get("amount"))
        flete = flt(r.get("flete_cobrado"))
        recargo = flt(r.get("recargo_cobrado"))
        neto = amt - flete - recargo
        if tipo == "credito":
            fila["cxc_credito"] += neto
        else:
            fila["cxc_cod"] += neto
            if flete > EPS:
                fila["fletes_liq_q"] += flete
                guias_liq.add(r["sales_invoice"])
                fila["detalle"]["fletes"].append({
                    "tipo": "LIQ", "fecha": f_str, "factura": r["sales_invoice"],
                    "cliente": r.get("customer_name"), "monto": round(flete, 2),
                    "guia": r.get("reference") or "",
                })
        fila["detalle"]["recuperaciones"].append({
            "fecha": f_str, "factura": r["sales_invoice"], "cliente": r.get("customer_name"),
            "tipo": tipo, "forma": r.get("forma"), "cobrado": round(amt, 2),
            "cargos": round(flete + recargo, 2), "neto": round(neto, 2),
            "emision": r.get("posting_date"), "guia": r.get("reference") or "",
        })
    fila["fletes_liq_cant"] += len(guias_liq)

    fila["total"] = fila["venta"] - fila["creditos"] - fila["cod"]
    fila["cxc_total"] = fila["cxc_credito"] + fila["cxc_cod"]
    fila["fletes_total_cant"] = fila["fletes_pd_cant"] + fila["fletes_liq_cant"]
    fila["fletes_total_q"] = fila["fletes_pd_q"] + fila["fletes_liq_q"]


# ---------------------------------------------------------------------------
# Exportación (Excel / PDF) — mismas cifras y mismo permiso que el informe.
# ---------------------------------------------------------------------------

def _tablas(data: dict) -> list:
    """[(título, encabezados, filas, columnas_numéricas)] de las 3 tablas."""
    rows = (data.get("rows") or []) + [dict(data.get("totales") or {}, nombre="TOTAL")]
    cheque = bool(data.get("mostrar_cheque_tc"))
    h1 = ["Tienda / Vendedor", "Venta del día", "Créditos", "Mercadería COD", "Total",
          "Transfer / Depo", "Efectivo"] + (["Cheques / TC"] if cheque else []) + \
         ["Gastos", "Líquido x Recibir", "Transfer/Depo + Fletes previo depo"]
    r1 = [[r["nombre"], r["venta"], r["creditos"], r["cod"], r["total"], r["transfer"], r["efectivo"]]
          + ([r["cheque_tc"]] if cheque else [])
          + [r["gastos"], r["liquido"], r["transfer_fletes"]] for r in rows]
    h2 = ["Tienda / Vendedor", "Clientes al Crédito", "Clientes COD x Liquidaciones", "Total"]
    r2 = [[r["nombre"], r["cxc_credito"], r["cxc_cod"], r["cxc_total"]] for r in rows]
    h3 = ["Tienda / Vendedor", "Cant. PD", "Fletes Previo Depo Q", "Cant. Liq",
          "Fletes COD x Liquidación Q", "Total Cant.", "Total Q"]
    r3 = [[r["nombre"], r["fletes_pd_cant"], r["fletes_pd_q"], r["fletes_liq_cant"],
           r["fletes_liq_q"], r["fletes_total_cant"], r["fletes_total_q"]] for r in rows]
    return [
        ("VENTAS DEL DÍA (sin flete ni recargo) · ANEXO PAGOS", h1, r1),
        ("LIQUIDACIÓN DE CXC", h2, r2),
        ("COBROS DE FLETES DEL DÍA", h3, r3),
    ]


def _rango_txt(data: dict) -> str:
    a, b = getdate(data["start_date"]), getdate(data["end_date"])
    f = lambda d: d.strftime("%d/%m/%Y")  # noqa: E731
    return f"Del {f(a)} al {f(b)}" if a != b else f"Fecha: {f(a)}"


def _notas(data: dict) -> list:
    f = lambda d: getdate(d).strftime("%d/%m/%Y")  # noqa: E731
    out = []
    for titulo, key in (("Fechas aún sin cierre diario (datos en tiempo real)", "sin_cierre"),
                        ("Días sin venta para usuarios", "sin_venta")):
        items = [f"{x['nombre']}: {', '.join(f(d) for d in x['fechas'])}" for x in data.get(key) or []]
        out.append((titulo, items))
    return out


@frappe.whitelist()
def export_cierre_general(start_date: str = None, end_date: str = None, usuarios=None,
                          company: str = None, formato: str = "xlsx") -> None:
    data = get_cierre_general(start_date, end_date, usuarios, company)
    titulo = "Cierre Diario General"
    rango = _rango_txt(data)
    fname = f"cierre_general_{data['start_date']}_{data['end_date']}"
    tablas = _tablas(data)
    notas = _notas(data)

    if formato == "pdf":
        from frappe.utils.pdf import get_pdf
        esc = lambda v: frappe.utils.escape_html("" if v is None else str(v))  # noqa: E731
        Q = lambda v: f"Q {flt(v):,.2f}"  # noqa: E731
        blocks = ""
        for t, head, filas in tablas:
            cnt_cols = {i for i, h in enumerate(head) if h.startswith("Cant.") or h == "Total Cant."}
            body = ""
            for k, row in enumerate(filas):
                last = k == len(filas) - 1
                tds = "".join(
                    f'<td class="{"num" if i else ""}">{esc(c) if i == 0 else (int(c) if i in cnt_cols else Q(c))}</td>'
                    for i, c in enumerate(row))
                body += f'<tr class="{"tot" if last else ""}">{tds}</tr>'
            blocks += (f'<div class="t">{esc(t)}</div><table><thead><tr>'
                       + "".join(f"<th>{esc(h)}</th>" for h in head) + f"</tr></thead><tbody>{body}</tbody></table>")
        notes_html = "".join(
            f'<div class="n"><b>{esc(t)}</b>: ' + (esc(" · ".join(items)) if items else "—") + "</div>"
            for t, items in notas)
        html = f"""
<div style="font-family:Helvetica,Arial,sans-serif;font-size:9px;color:#222;">
  <div style="border-bottom:2px solid #153375;padding-bottom:6px;margin-bottom:8px;">
    <div style="font-size:16px;font-weight:700;color:#153375;">{esc(titulo.upper())}</div>
    <div style="font-size:12px;font-weight:700;color:#1f6f54;">{esc(rango)}</div>
    <div style="font-size:9px;color:#666;">{esc(data["company"])} · Generado {esc(frappe.utils.now_datetime().strftime("%d/%m/%Y %H:%M"))}</div>
  </div>
  {notes_html}
  {blocks}
</div>
<style>
  .t {{ font-size:11px;font-weight:700;color:#153375;margin:12px 0 4px; }}
  .n {{ font-size:9px;margin:2px 0;color:#444; }}
  table {{ width:100%;border-collapse:collapse; }}
  th, td {{ border:1px solid #cdd5e0;padding:3px 5px;text-align:left; }}
  th {{ background:#eef2ff; }} td.num {{ text-align:right; }}
  tr.tot td {{ background:#eef2fb;font-weight:700; }}
</style>"""
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
    nombres = ["Ventas del día", "Liquidación CXC", "Cobros de fletes"]
    for (t, head, filas), nombre in zip(tablas, nombres):
        ws = wb.create_sheet(nombre)
        ws.append([titulo.upper()])
        ws.append([rango + " · " + data["company"]])
        ws.append([t])
        ws.append([])
        ws.append(head)
        for c in ws[5]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor="153375")
            c.alignment = Alignment(wrap_text=True, horizontal="center", vertical="center")
        for row in filas:
            ws.append(row)
        for r_i in range(6, 6 + len(filas)):
            for c_i, h in enumerate(head, start=1):
                cell = ws.cell(row=r_i, column=c_i)
                if c_i > 1:
                    cell.number_format = "0" if (h.startswith("Cant.") or h == "Total Cant.") else '#,##0.00'
        for cell in ws[5 + len(filas)]:
            cell.font = Font(bold=True)
            cell.fill = PatternFill("solid", fgColor="EEF2FB")
        ws["A1"].font = Font(bold=True, size=14, color="153375")
        ws["A2"].font = Font(bold=True, color="1F6F54")
        ws["A3"].font = Font(bold=True)
        ws.column_dimensions["A"].width = 30
        for i in range(2, len(head) + 1):
            ws.column_dimensions[get_column_letter(i)].width = 20
        ws.freeze_panes = "B6"
        if nombre == nombres[0]:
            r = ws.max_row + 2
            for tit, items in notas:
                ws.cell(row=r, column=1, value=tit).font = Font(bold=True)
                r += 1
                for it in items or ["—"]:
                    ws.cell(row=r, column=1, value=it)
                    r += 1
                r += 1
    out = BytesIO()
    wb.save(out)
    frappe.response["filename"] = f"{fname}.xlsx"
    frappe.response["filecontent"] = out.getvalue()
    frappe.response["type"] = "binary"
