# -*- coding: utf-8 -*-
"""Comisionador — liquidación de comisiones de vendedores (Page «facex-comisiones»).

Criterio (base de caja): la comisión se calcula sobre DINERO RECIBIDO en el
período (eFast Invoice Payment, sin las filas «Contra Entrega», que son una
promesa de cobro y no dinero), sobre la mercadería (sin flete ni recargo).

Concepto de cada cobro:
  Contado       factura emitida en el período sin crédito ni contra entrega
                (o pagada el mismo día de la emisión).
  Recuperación  todo lo demás: crédito, contra entrega y contado cobrado tarde.
                Se agrupa por el MES DE LA FACTURA ORIGINAL.
Descuentos:
  · Factura emitida y anulada dentro del mismo período: no cuenta (sus cobros
    salen como «Excluida», informativo).
  · Factura de un período anterior anulada en este: se RESTA lo ya comisionado
    (lo que consta en liquidaciones Cerradas; si no hay, se estima con los cobros
    previos y se marca «Estimado»). Sus cobros de este período tampoco cuentan.
  · Nota de Crédito: se resta solo la parte que ya estaba cobrada (el saldo
    pendiente absorbe el resto de la NC).
Documento: FEL si la factura está certificada, «Recibo de Compra» si no.
Vendedor: Sales Invoice.sales_partner (el de la factura original).

La liquidación se graba (FacEx Comision Liquidacion): porcentajes por vendedor,
facturas que la componen, firmas. Cerrada queda congelada; los períodos
Cerrados no se pueden traslapar (un cobro no se comisiona dos veces).
Permiso: comisionador (deny-by-default).
"""
from __future__ import annotations

import json
from collections import OrderedDict, defaultdict

import frappe
from frappe.utils import cint, flt, getdate, now_datetime, today

from facex_multi.api import cierre as _c
from facex_multi.api.cliente_generico import display_name_sql

DOCTYPE = "FacEx Comision Liquidacion"
SIN_VENDEDOR = "(Sin vendedor)"
MAX_DIAS = 366
EPS = 0.004
FEL = "FEL"
RECIBO = "Recibo de Compra"
C_CONTADO, C_RECUP, C_ANUL, C_NC, C_EXCL = "Contado", "Recuperación", "Anulación", "Nota de Crédito", "Excluida"
_ORDEN = {C_CONTADO: 0, C_RECUP: 1, C_ANUL: 2, C_NC: 3, C_EXCL: 4}
MESES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto",
         "Septiembre", "Octubre", "Noviembre", "Diciembre"]


# ---------------------------------------------------------------------------
# Permisos y parámetros
# ---------------------------------------------------------------------------

def _company(company: str = None) -> str:
    from facex_multi.api.permissions import get_facex_permissions_for_company

    company = _c.get_effective_company(company)
    if not get_facex_permissions_for_company(company).get("comisionador"):
        frappe.throw("No tiene permiso para el Comisionador.", frappe.PermissionError)
    return company


def _doc(name: str):
    doc = frappe.get_doc(DOCTYPE, name)
    _company(doc.company)
    return doc


def _periodo(company: str, desde, hasta) -> tuple:
    from facex_multi.api.corte import get_corte_fecha

    if not desde or not hasta:
        frappe.throw("Indique el período: fecha Desde y fecha Hasta.")
    d, h = getdate(desde), getdate(hasta)
    if h < d:
        frappe.throw("La fecha Hasta no puede ser menor a la fecha Desde.")
    if h > getdate(today()):
        frappe.throw("La fecha Hasta no puede ser futura.")
    if (h - d).days + 1 > MAX_DIAS:
        frappe.throw(f"El período máximo es de {MAX_DIAS} días.")
    corte = get_corte_fecha(company)
    if corte and d < corte:
        frappe.throw(f"El período inicia antes del inicio de operación ({corte}); los datos anteriores ya no son consultables.")
    return d, h


def _cancel_expr(alias: str = "si") -> str:
    """Fecha de anulación de la factura (facex_cancelado_el; antes del campo, `modified`)."""
    if _c._has_anulacion():
        return f"DATE(COALESCE({alias}.facex_cancelado_el, {alias}.modified))"
    return f"DATE({alias}.modified)"


def _vend(sp) -> str:
    return sp or SIN_VENDEDOR


def _mes(fecha) -> str:
    return getdate(fecha).strftime("%Y-%m")


def _mes_label(mes: str) -> str:
    if not mes or "-" not in mes:
        return mes or ""
    y, m = mes.split("-")
    return f"{MESES[int(m) - 1]} {y}"


# ---------------------------------------------------------------------------
# Datos base
# ---------------------------------------------------------------------------

def _facturas(names) -> dict:
    """{factura: dict} con lo necesario para clasificar y prorratear."""
    names = sorted({n for n in names if n})
    if not names:
        return {}
    meta = frappe.get_meta("Sales Invoice")
    ce = "si.bfel_pago_contra_entrega" if meta.has_field("bfel_pago_contra_entrega") else "0"
    uuid = "si.bfel_uuid" if meta.has_field("bfel_uuid") else "NULL"
    st = "si.bfel_status" if meta.has_field("bfel_status") else "NULL"
    out = {}
    for i in range(0, len(names), 2000):
        for r in frappe.db.sql(
            f"""
            SELECT si.name, si.posting_date, si.due_date, {display_name_sql('si')} AS customer_name, si.sales_partner,
                   si.grand_total, si.net_total, si.docstatus, si.is_return, si.return_against,
                   {ce} AS pago_ce, {uuid} AS bfel_uuid, {st} AS bfel_status,
                   {_cancel_expr('si')} AS cancelado
            FROM `tabSales Invoice` si WHERE si.name IN %(n)s
            """, {"n": tuple(names[i:i + 2000])}, as_dict=True,
        ):
            out[r.name] = r
    ces = set()
    for i in range(0, len(names), 2000):
        ces.update(frappe.db.sql_list(
            """SELECT DISTINCT parent FROM `tabeFast Invoice Payment`
               WHERE parenttype = 'Sales Invoice' AND payment_method = %(ce)s AND parent IN %(n)s""",
            {"ce": _c.CONTRA_ENTREGA, "n": tuple(names[i:i + 2000])}))
    for r in out.values():
        r["tiene_ce"] = r.name in ces
    return out


def _factores(company: str, facs: dict) -> dict:
    """{factura: (con_iva, sin_iva)} = fracción de cada quetzal cobrado que es
    mercadería con IVA / mercadería sin IVA (se excluyen flete y recargo)."""
    from facex_multi.api.permissions import get_facex_flete_item
    from facex_multi.api.recargo import cargos_facex_por_factura

    names = list(facs)
    cargos = cargos_facex_por_factura(names) if names else {}
    flete_item = (get_facex_flete_item(company) or "").strip()
    flete_net = defaultdict(float)
    if names and flete_item:
        for r in frappe.db.sql(
            """SELECT parent, SUM(net_amount) AS n FROM `tabSales Invoice Item`
               WHERE parenttype = 'Sales Invoice' AND item_code = %(i)s AND parent IN %(n)s GROUP BY parent""",
            {"i": flete_item, "n": tuple(names)}, as_dict=True,
        ):
            flete_net[r.parent] = flt(r.n)
    out = {}
    for n, f in facs.items():
        gt = abs(flt(f.grand_total))
        if gt < EPS:
            out[n] = (0.0, 0.0)
            continue
        c = cargos.get(n) or {}
        cargos_row = abs(flt(c.get("flete")) + flt(c.get("recargo")))
        net = abs(flt(f.net_total))
        base_all = max(gt - cargos_row, 0.0)
        tax = (base_all / net) if net > EPS and base_all >= net else 1.0
        merch_net = max(net - abs(flete_net[n]), 0.0)
        merch_gross = min(merch_net * tax, base_all)
        out[n] = (merch_gross / gt, merch_net / gt)
    return out


def _tipo_doc(f) -> str:
    return FEL if (f.bfel_uuid or f.bfel_status == "02 Procesada") else RECIBO


def _condicion(f) -> str:
    if cint(f.pago_ce) or f.tiene_ce:
        return "Contra Entrega"
    if f.due_date and getdate(f.due_date) > getdate(f.posting_date):
        return "Crédito"
    return "Contado"


def _pagos_sql(extra: str, params: dict, company: str):
    corte_cond, corte_vals = _c._corte_si(company)
    return frappe.db.sql(
        f"""
        SELECT p.name AS pago, p.parent AS factura, p.payment_method AS forma, p.reference,
               p.amount, COALESCE(p.payment_date, si.posting_date) AS fecha_pago
        FROM `tabeFast Invoice Payment` p
        JOIN `tabSales Invoice` si ON si.name = p.parent
        WHERE p.parenttype = 'Sales Invoice' AND si.company = %(company)s AND si.is_return = 0
          AND p.payment_method != %(ce)s AND {corte_cond} {extra}
        ORDER BY fecha_pago, p.parent, p.idx
        """, {"company": company, "ce": _c.CONTRA_ENTREGA, **corte_vals, **params}, as_dict=True)


def _linea(vendedor, concepto, f, doc_name, con, sin, **kw) -> dict:
    d = {
        "vendedor": vendedor, "concepto": concepto,
        "mes_origen": _mes(f.posting_date), "tipo_documento": _tipo_doc(f),
        "condicion": _condicion(f), "factura": doc_name, "factura_origen": "",
        "fecha_factura": str(f.posting_date), "cliente": f.customer_name or "",
        "fecha_pago": None, "forma_pago": "", "referencia": "",
        "monto_con_iva": round(con, 2), "monto_sin_iva": round(sin, 2),
        "base": 0.0, "pct": 0.0, "comision": 0.0, "nota": "",
    }
    d.update(kw)
    return d


def _previo(company: str, facturas, desde) -> dict:
    """Lo ya comisionado en liquidaciones Cerradas anteriores, neto de
    anulaciones/NC previas: {factura_original: {con, sin, base, com, docs}}."""
    facturas = sorted(set(facturas))
    out = {}
    if not facturas:
        return out
    for r in frappe.db.sql(
        """
        SELECT IF(IFNULL(d.factura_origen, '') != '', d.factura_origen, d.factura) AS k,
               SUM(d.monto_con_iva) AS con, SUM(d.monto_sin_iva) AS sin,
               SUM(d.base) AS base, SUM(d.comision) AS com, GROUP_CONCAT(DISTINCT l.name) AS docs
        FROM `tabFacEx Comision Liquidacion Detalle` d
        JOIN `tabFacEx Comision Liquidacion` l ON l.name = d.parent
        WHERE l.company = %(c)s AND l.estado = 'Cerrada' AND l.fecha_hasta < %(desde)s
          AND d.concepto != %(ex)s
          AND (d.factura IN %(n)s OR d.factura_origen IN %(n)s)
        GROUP BY k
        """, {"c": company, "desde": desde, "ex": C_EXCL, "n": tuple(facturas)}, as_dict=True,
    ):
        out[r.k] = r
    return out


# ---------------------------------------------------------------------------
# Motor
# ---------------------------------------------------------------------------

def _calcular(company: str, desde, hasta, rates: dict, base_calculo: str) -> tuple:
    """(líneas, advertencias). rates = {vendedor: (pct_contado, pct_recuperacion)}.
    Puro: no escribe nada."""
    corte_cond, corte_vals = _c._corte_si(company)
    lineas, adv = [], []

    def pct_por(vend, concepto, cond):
        pc, pr = rates.get(vend, (0.0, 0.0))
        return pc if (concepto == C_CONTADO or (concepto in (C_ANUL, C_NC) and cond == "Contado")) else pr

    def comisionar(l, pct):
        base = l["monto_con_iva"] if base_calculo == "Con IVA" else l["monto_sin_iva"]
        l["base"], l["pct"] = round(base, 2), pct
        l["comision"] = round(base * pct / 100.0, 2)

    # ---- 1. Cobros del período ---------------------------------------------------
    pagos = _pagos_sql(
        "AND si.docstatus IN (1, 2) AND COALESCE(p.payment_date, si.posting_date) BETWEEN %(desde)s AND %(hasta)s",
        {"desde": desde, "hasta": hasta}, company)
    facs = _facturas({p.factura for p in pagos})
    fact = _factores(company, facs)
    for p in pagos:
        f = facs[p.factura]
        con_r, sin_r = fact[p.factura]
        amt = flt(p.amount)
        con, sin = amt * con_r, amt * sin_r
        vend = _vend(f.sales_partner)
        kw = {"fecha_pago": str(p.fecha_pago), "forma_pago": p.forma or "", "referencia": p.reference or ""}
        if f.docstatus == 2 and getdate(f.cancelado) <= hasta:
            lineas.append(_linea(vend, C_EXCL, f, p.factura, con, sin, **kw,
                                 nota=f"Anulada el {f.cancelado}: no se comisiona"))
            continue
        en_periodo = desde <= getdate(f.posting_date) <= hasta
        cond = _condicion(f)
        mismo_dia = getdate(p.fecha_pago) == getdate(f.posting_date)
        contado = en_periodo and (cond == "Contado" or (mismo_dia and cond != "Contra Entrega"))
        concepto = C_CONTADO if contado else C_RECUP
        l = _linea(vend, concepto, f, p.factura, con, sin, **kw)
        comisionar(l, pct_por(vend, concepto, cond))
        lineas.append(l)

    # ---- 2. Facturas de períodos anteriores anuladas en este ----------------------
    anuladas = frappe.db.sql_list(
        f"""SELECT si.name FROM `tabSales Invoice` si
            WHERE si.company = %(company)s AND si.docstatus = 2 AND si.is_return = 0
              AND si.posting_date < %(desde)s AND {_cancel_expr('si')} BETWEEN %(desde)s AND %(hasta)s
              AND {corte_cond}""",
        {"company": company, "desde": desde, "hasta": hasta, **corte_vals})
    if anuladas:
        afacs = _facturas(anuladas)
        afact = _factores(company, afacs)
        previo = _previo(company, anuladas, desde)
        previos_pagos = defaultdict(float)
        for p in _pagos_sql("AND si.name IN %(n)s AND COALESCE(p.payment_date, si.posting_date) < %(desde)s",
                            {"n": tuple(anuladas), "desde": desde}, company):
            previos_pagos[p.factura] += flt(p.amount)
        for n in sorted(anuladas):
            f, (con_r, sin_r) = afacs[n], afact[n]
            vend, cond = _vend(f.sales_partner), _condicion(f)
            pv = previo.get(n)
            if pv:
                if abs(flt(pv.con)) < EPS and abs(flt(pv.com)) < EPS:
                    continue
                l = _linea(vend, C_ANUL, f, n, -flt(pv.con), -flt(pv.sin),
                           nota=f"Revierte lo liquidado en {pv.docs}")
                l["base"] = round(-flt(pv.base), 2)
                l["pct"] = round(flt(pv.com) / flt(pv.base) * 100, 4) if abs(flt(pv.base)) > EPS else 0.0
                l["comision"] = round(-flt(pv.com), 2)
            else:
                amt = previos_pagos.get(n, 0.0)
                if amt < EPS:
                    continue
                l = _linea(vend, C_ANUL, f, n, -amt * con_r, -amt * sin_r,
                           nota="Estimado: sin liquidación previa, con los cobros anteriores al período")
                comisionar(l, pct_por(vend, C_ANUL, cond))
                adv.append(f"Anulación {n}: estimada con los cobros previos (no consta en una liquidación Cerrada); revísela.")
            lineas.append(l)

    # ---- 3. Notas de crédito del período ------------------------------------------
    ncs = frappe.db.sql(
        f"""SELECT si.name, si.return_against, si.posting_date, si.grand_total, {display_name_sql('si')} AS customer_name, si.sales_partner
            FROM `tabSales Invoice` si
            WHERE si.company = %(company)s AND si.is_return = 1 AND si.docstatus = 1
              AND si.posting_date BETWEEN %(desde)s AND %(hasta)s AND {corte_cond}
            ORDER BY si.posting_date, si.name""",
        {"company": company, "desde": desde, "hasta": hasta, **corte_vals}, as_dict=True)
    if ncs:
        origs = sorted({n.return_against for n in ncs if n.return_against})
        ofacs = _facturas(origs)
        ofact = _factores(company, ofacs)
        previo = _previo(company, origs, desde)
        pagos_o = defaultdict(list)
        if origs:
            for p in _pagos_sql("AND si.name IN %(n)s AND si.docstatus = 1 AND COALESCE(p.payment_date, si.posting_date) <= %(hasta)s",
                                {"n": tuple(origs), "hasta": hasta}, company):
                pagos_o[p.factura].append((getdate(p.fecha_pago), flt(p.amount)))
        nc_all = defaultdict(list)
        if origs:
            for r in frappe.db.sql(
                """SELECT return_against, posting_date, ABS(grand_total) AS gt FROM `tabSales Invoice`
                   WHERE is_return = 1 AND docstatus = 1 AND return_against IN %(n)s AND posting_date <= %(hasta)s""",
                {"n": tuple(origs), "hasta": hasta}, as_dict=True,
            ):
                nc_all[r.return_against].append((getdate(r.posting_date), flt(r.gt)))
        en_periodo = defaultdict(float)
        for n in ncs:
            en_periodo[n.return_against] += abs(flt(n.grand_total))
        for nc in ncs:
            o = nc.return_against
            f = ofacs.get(o)
            if not f or f.docstatus != 1:
                if o and f and f.docstatus == 2:
                    continue  # la original anulada ya se revierte completa arriba
                fn = _facturas([nc.name])[nc.name]
                con_r, sin_r = _factores(company, {nc.name: fn})[nc.name]
                gt = abs(flt(nc.grand_total))
                vend = _vend(nc.sales_partner)
                l = _linea(vend, C_NC, fn, nc.name, -gt * con_r, -gt * sin_r, factura_origen=o or "",
                           nota="NC sin factura original: se resta completa")
                comisionar(l, pct_por(vend, C_NC, _condicion(fn)))
                lineas.append(l)
                adv.append(f"NC {nc.name} sin factura original en la compañía: se restó completa.")
                continue
            gt0 = flt(f.grand_total)
            paid_s = sum(a for d, a in pagos_o[o] if d < desde)
            paid_e = sum(a for d, a in pagos_o[o])
            nc_s = sum(a for d, a in nc_all[o] if d < desde)
            nc_e = sum(a for d, a in nc_all[o])
            ded = max(0.0, max(0.0, paid_e - (gt0 - nc_e)) - max(0.0, paid_s - (gt0 - nc_s)))
            ded *= (abs(flt(nc.grand_total)) / en_periodo[o]) if en_periodo[o] else 0.0
            con_r, sin_r = ofact[o]
            vend, cond = _vend(f.sales_partner), _condicion(f)
            l = _linea(vend, C_NC, f, nc.name, -ded * con_r, -ded * sin_r, factura_origen=o,
                       nota="" if ded > EPS else "Sin impacto: la NC se aplicó al saldo pendiente")
            pv = previo.get(o)
            pct = pct_por(vend, C_NC, cond)
            if pv and abs(flt(pv.base)) > EPS and flt(pv.com) > 0:
                pct = flt(pv.com) / flt(pv.base) * 100
            comisionar(l, pct)
            lineas.append(l)

    lineas.sort(key=lambda l: (l["vendedor"] == SIN_VENDEDOR, l["vendedor"], _ORDEN[l["concepto"]],
                               l["mes_origen"], l["fecha_pago"] or "", l["factura"]))
    return lineas, adv


def _totales(lineas: list, vendedores: list) -> dict:
    """Totales por vendedor configurado (solo ellos cobran)."""
    out = OrderedDict()
    for v in vendedores:
        out[v] = {k: 0.0 for k in (
            "contado_con_iva", "contado_sin_iva", "recuperacion_con_iva", "recuperacion_sin_iva",
            "anulaciones_con_iva", "anulaciones_sin_iva", "neto_con_iva", "neto_sin_iva",
            "comision_contado", "comision_recuperacion", "comision_anulaciones", "comision_total")}
    for l in lineas:
        t = out.get(l["vendedor"])
        if t is None or l["concepto"] == C_EXCL:
            continue
        k = {C_CONTADO: "contado", C_RECUP: "recuperacion"}.get(l["concepto"], "anulaciones")
        t[f"{k}_con_iva"] += l["monto_con_iva"]
        t[f"{k}_sin_iva"] += l["monto_sin_iva"]
        t[f"comision_{'anulaciones' if k == 'anulaciones' else k}"] += l["comision"]
        t["neto_con_iva"] += l["monto_con_iva"]
        t["neto_sin_iva"] += l["monto_sin_iva"]
        t["comision_total"] += l["comision"]
    return {v: {k: round(x, 2) for k, x in t.items()} for v, t in out.items()}


# ---------------------------------------------------------------------------
# Configuración del período
# ---------------------------------------------------------------------------

def _actividad(company: str, desde, hasta) -> dict:
    """{vendedor: {ventas, cobros, anulaciones}} con movimiento en el período."""
    corte_cond, corte_vals = _c._corte_si(company)
    base = {"company": company, "desde": desde, "hasta": hasta, "ce": _c.CONTRA_ENTREGA, **corte_vals}
    act = defaultdict(lambda: {"ventas": 0, "cobros": 0, "anulaciones": 0})
    vend = "IFNULL(NULLIF(si.sales_partner, ''), %(sin)s)"
    base["sin"] = SIN_VENDEDOR
    for r in frappe.db.sql(
        f"""SELECT {vend} AS v, COUNT(*) AS n FROM `tabSales Invoice` si
            WHERE si.company = %(company)s AND si.docstatus = 1 AND si.is_return = 0
              AND si.posting_date BETWEEN %(desde)s AND %(hasta)s AND {corte_cond} GROUP BY v""", base, as_dict=True):
        act[r.v]["ventas"] += r.n
    for r in frappe.db.sql(
        f"""SELECT {vend} AS v, COUNT(DISTINCT p.parent) AS n
            FROM `tabeFast Invoice Payment` p JOIN `tabSales Invoice` si ON si.name = p.parent
            WHERE p.parenttype = 'Sales Invoice' AND si.company = %(company)s AND si.is_return = 0
              AND si.docstatus IN (1, 2) AND p.payment_method != %(ce)s
              AND COALESCE(p.payment_date, si.posting_date) BETWEEN %(desde)s AND %(hasta)s AND {corte_cond}
            GROUP BY v""", base, as_dict=True):
        act[r.v]["cobros"] += r.n
    for r in frappe.db.sql(
        f"""SELECT {vend} AS v, COUNT(*) AS n FROM `tabSales Invoice` si
            WHERE si.company = %(company)s AND si.docstatus = 2 AND si.is_return = 0
              AND si.posting_date < %(desde)s AND {_cancel_expr('si')} BETWEEN %(desde)s AND %(hasta)s
              AND {corte_cond} GROUP BY v""", base, as_dict=True):
        act[r.v]["anulaciones"] += r.n
    for r in frappe.db.sql(
        f"""SELECT IFNULL(NULLIF(o.sales_partner, ''), %(sin)s) AS v, COUNT(*) AS n
            FROM `tabSales Invoice` si LEFT JOIN `tabSales Invoice` o ON o.name = si.return_against
            WHERE si.company = %(company)s AND si.docstatus = 1 AND si.is_return = 1
              AND si.posting_date BETWEEN %(desde)s AND %(hasta)s AND {corte_cond} GROUP BY v""", base, as_dict=True):
        act[r.v]["anulaciones"] += r.n
    return act


def _tasas_previas(company: str, excluir: str = None) -> dict:
    """Último porcentaje conocido por vendedor (liquidación más reciente que lo tenga)."""
    out = {}
    for r in frappe.db.sql(
        """SELECT v.vendedor, v.pct_contado, v.pct_recuperacion, l.name
           FROM `tabFacEx Comision Liquidacion Vendedor` v
           JOIN `tabFacEx Comision Liquidacion` l ON l.name = v.parent
           WHERE l.company = %(c)s AND l.name != %(x)s
           ORDER BY l.fecha_hasta DESC, l.creation DESC""", {"c": company, "x": excluir or ""}, as_dict=True):
        out.setdefault(r.vendedor, r)
    return out


def _liquidaciones_cerradas(company: str, desde, hasta, excluir: str = None) -> list:
    return frappe.get_all(
        DOCTYPE, filters={"company": company, "estado": "Cerrada", "name": ["!=", excluir or ""],
                          "fecha_desde": ["<=", hasta], "fecha_hasta": [">=", desde]},
        fields=["name", "fecha_desde", "fecha_hasta"])


@frappe.whitelist()
def get_context(company: str = None) -> dict:
    company = _company(company)
    me = frappe.session.user
    return {
        "company": company, "today": today(), "user": me,
        "user_fullname": frappe.db.get_value("User", me, "full_name") or me,
        "es_sysman": int("System Manager" in frappe.get_roles()),
    }


@frappe.whitelist()
def get_config(company: str = None, desde: str = None, hasta: str = None) -> dict:
    company = _company(company)
    d, h = _periodo(company, desde, hasta)
    name = frappe.db.get_value(DOCTYPE, {"company": company, "fecha_desde": d, "fecha_hasta": h})
    doc = frappe.get_doc(DOCTYPE, name) if name else None
    saved = {r.vendedor: r for r in (doc.vendedores if doc else [])}
    prev = _tasas_previas(company, name)
    act = _actividad(company, d, h)
    vendedores = sorted(set(act) | set(saved), key=lambda v: (v == SIN_VENDEDOR, v.lower()))
    rows = []
    for v in vendedores:
        s, p = saved.get(v), prev.get(v)
        src = s or p
        rows.append({
            "vendedor": v, **act.get(v, {"ventas": 0, "cobros": 0, "anulaciones": 0}),
            "pct_contado": src.pct_contado if src else None,
            "pct_recuperacion": src.pct_recuperacion if src else None,
            "origen": "Guardado en este período" if s else (f"Último período ({p.name})" if p else "Nuevo: capturar"),
            "incluido": int(bool(s) if doc else v != SIN_VENDEDOR),
        })
    avisos = []
    cerradas = _liquidaciones_cerradas(company, d, h, name)
    ultima = frappe.get_all(DOCTYPE, filters={"company": company, "estado": "Cerrada", "fecha_hasta": ["<", d]},
                            fields=["name", "fecha_hasta"], order_by="fecha_hasta desc", limit=1)
    if ultima and (d - getdate(ultima[0].fecha_hasta)).days != 1:
        avisos.append(f"Hueco: la última liquidación Cerrada ({ultima[0].name}) termina el {ultima[0].fecha_hasta}; "
                      "los cobros entre esa fecha y el inicio de este período no se comisionarán.")
    return {
        "company": company, "desde": str(d), "hasta": str(h), "name": name,
        "estado": doc.estado if doc else "Nuevo", "base_calculo": (doc.base_calculo if doc else "Sin IVA"),
        "ejecutada_el": str(doc.ejecutada_el) if doc and doc.ejecutada_el else None,
        "vendedores": rows, "avisos": avisos,
        "traslape": [f"{x.name} ({x.fecha_desde} al {x.fecha_hasta})" for x in cerradas],
    }


def _pct(v, etiqueta, vend):
    if v is None or str(v).strip() == "":
        frappe.throw(f"Falta el porcentaje «{etiqueta}» de {vend}.")
    n = flt(v)
    if n < 0 or n > 100:
        frappe.throw(f"El porcentaje «{etiqueta}» de {vend} debe estar entre 0 y 100.")
    return n


@frappe.whitelist()
def save_config(payload) -> dict:
    p = frappe.parse_json(payload) if isinstance(payload, str) else payload
    company = _company(p.get("company"))
    d, h = _periodo(company, p.get("desde"), p.get("hasta"))
    base = p.get("base_calculo") or "Sin IVA"
    if base not in ("Sin IVA", "Con IVA"):
        frappe.throw("Base de cálculo inválida.")
    vend = [v for v in (p.get("vendedores") or []) if v.get("vendedor")]
    if not vend:
        frappe.throw("Incluya al menos un vendedor.")
    if len({v["vendedor"] for v in vend}) != len(vend):
        frappe.throw("Hay vendedores repetidos.")
    cerr = _liquidaciones_cerradas(company, d, h)
    if cerr:
        frappe.throw(f"El período se traslapa con la liquidación Cerrada {cerr[0].name} "
                     f"({cerr[0].fecha_desde} al {cerr[0].fecha_hasta}): un cobro no se puede comisionar dos veces.")
    name = frappe.db.get_value(DOCTYPE, {"company": company, "fecha_desde": d, "fecha_hasta": h})
    doc = frappe.get_doc(DOCTYPE, name) if name else frappe.new_doc(DOCTYPE)
    if name and doc.estado == "Cerrada":
        frappe.throw("La liquidación de este período está Cerrada.")
    doc.update({"naming_series": "COM-.YYYY.-", "company": company, "fecha_desde": d, "fecha_hasta": h,
                "base_calculo": base})
    doc.set("vendedores", [])
    for v in vend:
        doc.append("vendedores", {
            "vendedor": v["vendedor"],
            "pct_contado": _pct(v.get("pct_contado"), "% Contado", v["vendedor"]),
            "pct_recuperacion": _pct(v.get("pct_recuperacion"), "% Recuperación", v["vendedor"]),
        })
    # Cambió la configuración: el resultado anterior ya no vale.
    doc.set("detalle", [])
    doc.update({"ejecutada_el": None, "ejecutada_por": None, "total_base_con_iva": 0, "total_base_sin_iva": 0,
                "total_comision": 0, "advertencias": None})
    doc.flags.facex_comision_api = True
    doc.save(ignore_permissions=True)
    return {"name": doc.name, "estado": doc.estado}


# ---------------------------------------------------------------------------
# Ejecutar / reporte / cierre
# ---------------------------------------------------------------------------

def _aplicar_calculo(doc) -> dict:
    d, h = getdate(doc.fecha_desde), getdate(doc.fecha_hasta)
    rates = {r.vendedor: (flt(r.pct_contado), flt(r.pct_recuperacion)) for r in doc.vendedores}
    lineas, adv = _calcular(doc.company, d, h, rates, doc.base_calculo)
    tot = _totales(lineas, list(rates))
    for r in doc.vendedores:
        r.update(tot[r.vendedor])
    fuera = defaultdict(float)
    for l in lineas:
        if l["vendedor"] not in rates and l["concepto"] != C_EXCL:
            fuera[l["vendedor"]] += l["monto_sin_iva"]
    for v, m in sorted(fuera.items()):
        adv.append(f"{v} tuvo movimiento (Q {m:,.2f} sin IVA) y NO está incluido en la liquidación.")
    n_ex = sum(1 for l in lineas if l["concepto"] == C_EXCL)
    if n_ex:
        adv.append(f"{n_ex} cobro(s) de facturas anuladas dentro del período quedaron excluidos (ver «Excluida»).")
    doc.set("detalle", [])
    for l in lineas:
        if l["vendedor"] in rates:
            doc.append("detalle", l)
    doc.total_base_con_iva = round(sum(t["neto_con_iva"] for t in tot.values()), 2)
    doc.total_base_sin_iva = round(sum(t["neto_sin_iva"] for t in tot.values()), 2)
    doc.total_comision = round(sum(t["comision_total"] for t in tot.values()), 2)
    doc.advertencias = json.dumps(adv, ensure_ascii=False)
    return {"lineas": len(doc.detalle), "total": doc.total_comision}


@frappe.whitelist()
def ejecutar(name: str) -> dict:
    doc = _doc(name)
    if doc.estado == "Cerrada":
        frappe.throw("La liquidación está Cerrada.")
    cerr = _liquidaciones_cerradas(doc.company, getdate(doc.fecha_desde), getdate(doc.fecha_hasta), doc.name)
    if cerr:
        frappe.throw(f"El período se traslapa con la liquidación Cerrada {cerr[0].name}.")
    _aplicar_calculo(doc)
    doc.ejecutada_el, doc.ejecutada_por = now_datetime(), frappe.session.user
    doc.flags.facex_comision_api = True
    doc.save(ignore_permissions=True)
    return get_reporte(doc.name)


def _nombre(user) -> str:
    return (frappe.db.get_value("User", user, "full_name") or user) if user else ""


@frappe.whitelist()
def get_reporte(name: str) -> dict:
    doc = _doc(name)
    lineas = [{k: (str(v) if k.startswith("fecha") and v else v) for k, v in l.as_dict().items()
               if k in ("vendedor", "concepto", "mes_origen", "tipo_documento", "condicion", "factura",
                        "factura_origen", "fecha_factura", "cliente", "fecha_pago", "forma_pago",
                        "referencia", "monto_con_iva", "monto_sin_iva", "base", "pct", "comision", "nota")}
              for l in doc.detalle]
    por_v = defaultdict(OrderedDict)
    for l in lineas:
        if l["concepto"] == C_EXCL:
            continue
        r = por_v[l["vendedor"]].setdefault((l["concepto"], l["mes_origen"]), {
            "concepto": l["concepto"], "mes": l["mes_origen"], "mes_label": _mes_label(l["mes_origen"]),
            "fel_con": 0.0, "fel_sin": 0.0, "rec_con": 0.0, "rec_sin": 0.0, "base": 0.0, "comision": 0.0, "n": 0})
        pref = "fel" if l["tipo_documento"] == FEL else "rec"
        r[f"{pref}_con"] += l["monto_con_iva"]
        r[f"{pref}_sin"] += l["monto_sin_iva"]
        r["base"] += l["base"]
        r["comision"] += l["comision"]
        r["n"] += 1
    vendedores = []
    for v in doc.vendedores:
        filas = sorted(por_v[v.vendedor].values(), key=lambda r: (_ORDEN[r["concepto"]], r["mes"]))
        for r in filas:
            for k in ("fel_con", "fel_sin", "rec_con", "rec_sin", "base", "comision"):
                r[k] = round(r[k], 2)
            r["con"], r["sin"] = round(r["fel_con"] + r["rec_con"], 2), round(r["fel_sin"] + r["rec_sin"], 2)
            r["pct"] = round(r["comision"] / r["base"] * 100, 4) if abs(r["base"]) > EPS else 0.0
        vendedores.append({**{k: v.get(k) for k in (
            "vendedor", "pct_contado", "pct_recuperacion", "contado_con_iva", "contado_sin_iva",
            "recuperacion_con_iva", "recuperacion_sin_iva", "anulaciones_con_iva", "anulaciones_sin_iva",
            "neto_con_iva", "neto_sin_iva", "comision_contado", "comision_recuperacion",
            "comision_anulaciones", "comision_total")}, "filas": filas})
    return {
        "name": doc.name, "company": doc.company, "desde": str(doc.fecha_desde), "hasta": str(doc.fecha_hasta),
        "estado": doc.estado, "base_calculo": doc.base_calculo,
        "ejecutada_el": str(doc.ejecutada_el) if doc.ejecutada_el else None,
        "ejecutada_por": _nombre(doc.ejecutada_por), "cerrada_el": str(doc.cerrada_el) if doc.cerrada_el else None,
        "cerrada_por": _nombre(doc.cerrada_por), "elaboro": doc.elaboro or "", "reviso": doc.reviso or "",
        "autorizo": doc.autorizo or "", "observaciones": doc.observaciones or "",
        "vendedores": vendedores, "lineas": lineas,
        "totales": {"neto_con_iva": doc.total_base_con_iva, "neto_sin_iva": doc.total_base_sin_iva,
                    "comision_total": doc.total_comision,
                    **{k: round(sum(flt(v.get(k)) for v in vendedores), 2) for k in (
                        "contado_con_iva", "contado_sin_iva", "recuperacion_con_iva", "recuperacion_sin_iva",
                        "anulaciones_con_iva", "anulaciones_sin_iva", "comision_contado",
                        "comision_recuperacion", "comision_anulaciones")}},
        "advertencias": json.loads(doc.advertencias) if doc.advertencias else [],
    }


@frappe.whitelist()
def cerrar(name: str, elaboro: str = "", reviso: str = "", autorizo: str = "", observaciones: str = "") -> dict:
    doc = _doc(name)
    if doc.estado == "Cerrada":
        frappe.throw("La liquidación ya está Cerrada.")
    if not doc.ejecutada_el:
        frappe.throw("Ejecute el reporte antes de cerrar la liquidación.")
    cerr = _liquidaciones_cerradas(doc.company, getdate(doc.fecha_desde), getdate(doc.fecha_hasta), doc.name)
    if cerr:
        frappe.throw(f"El período se traslapa con la liquidación Cerrada {cerr[0].name}.")
    # Los datos pudieron cambiar desde la ejecución (un pago nuevo, una anulación).
    antes = (doc.total_comision, len(doc.detalle))
    _aplicar_calculo(doc)
    if (doc.total_comision, len(doc.detalle)) != antes:
        frappe.throw("Los datos cambiaron desde la última ejecución. Ejecute de nuevo y revise antes de cerrar.")
    doc.update({"estado": "Cerrada", "cerrada_el": now_datetime(), "cerrada_por": frappe.session.user,
                "elaboro": elaboro, "reviso": reviso, "autorizo": autorizo, "observaciones": observaciones})
    doc.flags.facex_comision_api = True
    doc.save(ignore_permissions=True)
    return get_reporte(doc.name)


@frappe.whitelist()
def reabrir(name: str, motivo: str = "") -> dict:
    doc = _doc(name)
    if "System Manager" not in frappe.get_roles():
        frappe.throw("Solo un System Manager puede reabrir una liquidación.", frappe.PermissionError)
    if doc.estado != "Cerrada":
        frappe.throw("La liquidación no está Cerrada.")
    if not (motivo or "").strip():
        frappe.throw("Indique el motivo de la reapertura.")
    doc.update({"estado": "Borrador", "cerrada_el": None, "cerrada_por": None})
    doc.flags.facex_comision_api = True
    doc.save(ignore_permissions=True)
    doc.add_comment("Info", f"Reabierta por {frappe.session.user}: {motivo}")
    return {"name": doc.name, "estado": doc.estado}


@frappe.whitelist()
def eliminar(name: str) -> dict:
    doc = _doc(name)
    if doc.estado == "Cerrada":
        frappe.throw("Una liquidación Cerrada no se puede eliminar.")
    frappe.delete_doc(DOCTYPE, name, ignore_permissions=True)
    return {"ok": 1}


@frappe.whitelist()
def listar(company: str = None) -> list:
    company = _company(company)
    rows = frappe.get_all(
        DOCTYPE, filters={"company": company},
        fields=["name", "fecha_desde", "fecha_hasta", "estado", "base_calculo", "total_comision",
                "ejecutada_el", "cerrada_por", "cerrada_el"], order_by="fecha_hasta desc, creation desc", limit=200)
    for r in rows:
        r["cerrada_por"] = _nombre(r.cerrada_por)
        r["vendedores"] = frappe.db.count("FacEx Comision Liquidacion Vendedor", {"parent": r.name})
    return rows


# ---------------------------------------------------------------------------
# Exportación (Excel / PDF) — siempre desde lo grabado, igual que la pantalla
# ---------------------------------------------------------------------------

def _f(d) -> str:
    return getdate(d).strftime("%d/%m/%Y")


@frappe.whitelist()
def export_liquidacion(name: str, formato: str = "xlsx") -> None:
    rep = get_reporte(name)
    if not rep["ejecutada_el"]:
        frappe.throw("Ejecute el reporte antes de exportarlo.")
    con = rep["base_calculo"] == "Con IVA"
    fname = f"comisiones_{rep['desde']}_{rep['hasta']}"
    titulo = f"Liquidación de Comisiones · {rep['name']}"
    rango = f"Del {_f(rep['desde'])} al {_f(rep['hasta'])} · {rep['company']} · Base: {rep['base_calculo']} · {rep['estado']}"

    h_res = ["Vendedor", "% Contado", "% Recuperación", "Contado", "Recuperación", "Anulaciones / NC",
             "Neto con IVA", "Neto sin IVA", "Comisión a pagar", "Recibí conforme (firma)"]
    r_res = [[v["vendedor"], v["pct_contado"], v["pct_recuperacion"],
              v["contado_con_iva" if con else "contado_sin_iva"], v["recuperacion_con_iva" if con else "recuperacion_sin_iva"],
              v["anulaciones_con_iva" if con else "anulaciones_sin_iva"], v["neto_con_iva"], v["neto_sin_iva"],
              v["comision_total"], ""] for v in rep["vendedores"]]
    t = rep["totales"]
    r_res.append(["TOTAL", "", "", t["contado_con_iva" if con else "contado_sin_iva"],
                  t["recuperacion_con_iva" if con else "recuperacion_sin_iva"],
                  t["anulaciones_con_iva" if con else "anulaciones_sin_iva"], t["neto_con_iva"], t["neto_sin_iva"],
                  t["comision_total"], ""])
    h_con = ["Vendedor", "Concepto", "Mes de la factura", "FEL con IVA", "FEL sin IVA", "Recibo de Compra con IVA",
             "Recibo de Compra sin IVA", "Total con IVA", "Total sin IVA", "Base", "% real", "Comisión", "Docs"]
    r_con = [[v["vendedor"], r["concepto"], r["mes_label"], r["fel_con"], r["fel_sin"], r["rec_con"], r["rec_sin"],
              r["con"], r["sin"], r["base"], r["pct"], r["comision"], r["n"]]
             for v in rep["vendedores"] for r in v["filas"]]
    h_fac = ["Vendedor", "Concepto", "Mes factura", "Documento", "Factura / NC", "Factura original", "Fecha factura",
             "Cliente", "Condición", "Fecha pago", "Forma de pago", "Referencia", "Monto con IVA", "Monto sin IVA",
             "Base", "%", "Comisión", "Nota"]
    r_fac = [[l["vendedor"], l["concepto"], l["mes_origen"], l["tipo_documento"], l["factura"], l["factura_origen"],
              l["fecha_factura"], l["cliente"], l["condicion"], l["fecha_pago"] or "", l["forma_pago"], l["referencia"],
              l["monto_con_iva"], l["monto_sin_iva"], l["base"], l["pct"], l["comision"], l["nota"]]
             for l in rep["lineas"]]
    firmas = [("Elaboró", rep["elaboro"]), ("Revisó", rep["reviso"]), ("Autorizó", rep["autorizo"])]

    if formato == "pdf":
        from frappe.utils.pdf import get_pdf
        esc = lambda v: frappe.utils.escape_html("" if v is None else str(v))  # noqa: E731
        num = lambda v: f"{flt(v):,.2f}"  # noqa: E731

        def tabla(head, rows, texto, total=False):
            body = ""
            for i, row in enumerate(rows):
                tds = "".join(f'<td class="{"" if j in texto else "n"}">{esc(c) if j in texto or c == "" else num(c)}</td>'
                              for j, c in enumerate(row))
                body += f'<tr class="{"tot" if total and i == len(rows) - 1 else ""}">{tds}</tr>'
            return "<table><thead><tr>" + "".join(f"<th>{esc(h)}</th>" for h in head) + f"</tr></thead><tbody>{body}</tbody></table>"

        adv = "".join(f"<div class='a'>⚠ {esc(a)}</div>" for a in rep["advertencias"])
        firmas_html = "".join(
            f"<td class='fm'><div class='ln'></div>{esc(k)}<br><b>{esc(v)}</b></td>" for k, v in firmas)
        html = f"""
<div style="font-family:Helvetica,Arial,sans-serif;font-size:9px;color:#222;">
 <div style="border-bottom:2px solid #153375;padding-bottom:6px;margin-bottom:8px;">
  <div style="font-size:16px;font-weight:700;color:#153375;">{esc(titulo.upper())}</div>
  <div style="font-size:11px;font-weight:700;color:#1f6f54;">{esc(rango)}</div>
  <div style="color:#666;">Ejecutada {esc(rep['ejecutada_el'])} por {esc(rep['ejecutada_por'])}</div></div>
 {adv}
 <div class="t">RESUMEN PARA PAGO</div>{tabla(h_res, r_res, {0, 9}, True)}
 <div class="t">DETALLE POR CONCEPTO Y MES DE LA FACTURA ORIGINAL</div>{tabla(h_con, r_con, {0, 1, 2})}
 <div style="margin-top:8px;color:#444;">{esc(rep['observaciones'])}</div>
 <table style="margin-top:36px;border:0"><tr>{firmas_html}</tr></table>
</div>
<style>.t{{font-size:11px;font-weight:700;color:#153375;margin:12px 0 4px}} .a{{color:#b45309;margin:2px 0}}
table{{width:100%;border-collapse:collapse}} th,td{{border:1px solid #cdd5e0;padding:3px 5px;text-align:left}}
th{{background:#eef2ff}} td.n{{text-align:right}} tr.tot td{{background:#eef2fb;font-weight:700}}
td.fm{{border:0;text-align:center;width:33%;padding-top:30px}} .ln{{border-top:1px solid #000;margin:0 20px 4px}}</style>"""
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

    def hoja(nombre, head, rows, texto, total=False, extra=None):
        ws = wb.create_sheet(nombre)
        ws.append([titulo.upper()])
        ws.append([rango])
        ws.append([])
        ws.append(head)
        for c in ws[4]:
            c.font = Font(bold=True, color="FFFFFF")
            c.fill = PatternFill("solid", fgColor="153375")
            c.alignment = Alignment(wrap_text=True, horizontal="center", vertical="center")
        for row in rows:
            ws.append(row)
        for r_i in range(5, 5 + len(rows)):
            for c_i in range(1, len(head) + 1):
                if (c_i - 1) not in texto:
                    ws.cell(row=r_i, column=c_i).number_format = "#,##0.00"
        if total:
            for c in ws[4 + len(rows)]:
                c.font = Font(bold=True)
                c.fill = PatternFill("solid", fgColor="EEF2FB")
        ws["A1"].font = Font(bold=True, size=14, color="153375")
        ws["A2"].font = Font(bold=True, color="1F6F54")
        for i in range(1, len(head) + 1):
            ws.column_dimensions[get_column_letter(i)].width = 30 if i == 1 else 18
        ws.freeze_panes = "B5"
        if extra:
            r = ws.max_row + 2
            for line in extra:
                ws.cell(row=r, column=1, value=line)
                r += 1
        return ws

    extra = [f"⚠ {a}" for a in rep["advertencias"]] + [""] + \
            [f"{k}: {v or '______________________'}" for k, v in firmas]
    hoja("Resumen", h_res, r_res, {0, 9}, True, extra)
    hoja("Por concepto", h_con, r_con, {0, 1, 2})
    hoja("Facturas", h_fac, r_fac, {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 17})
    out = BytesIO()
    wb.save(out)
    frappe.response["filename"] = f"{fname}.xlsx"
    frappe.response["filecontent"] = out.getvalue()
    frappe.response["type"] = "binary"
