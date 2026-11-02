"""
facex_multi.api.analitica
-------------------------
Página «Analítica» (facex-analitica): indicadores de clientes, horarios,
condición de pago, productos, venta cruzada, crédito y tickets.

Permiso: `analitica` (FacEx Settings / Perfil de Permisos, deny-by-default).
Cada pestaña tiene su endpoint y se pide al abrirla.

Criterios comunes:
- Venta = Sales Invoice validada (docstatus 1), sin devoluciones, de la
  compañía, desde el corte de inicio de operación (sin datos de prueba).
- Monto = grand_total (el total certificado ante la SAT manda).
- Condición: Contra Entrega (marcada o con pago CE), Crédito (vence después
  de la fecha de la factura) o Contado.
- Los clientes genéricos (Consumidor Final) cuentan en ventas y tickets, pero
  no en los análisis por cliente (no se puede saber quién recompra).
- «Dejó de comprar» se mide contra el ritmo de CADA cliente (su intervalo
  promedio entre compras), no con un número fijo de días.
"""
from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from datetime import date, timedelta
from itertools import combinations

import frappe
from frappe import _
from frappe.utils import add_days, cint, date_diff, flt, getdate, today

from facex_multi.api import cierre as _c

MAX_DIAS = 1100
DIAS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"]
MESES = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
C_CONTADO, C_CREDITO, C_CE = "Contado", "Crédito", "Contra Entrega"
INICIO = date(2000, 1, 1)
# «Para ofertar»: stock que al ritmo de venta del período alcanza para más días que esto.
DIAS_INVENTARIO_ALTO = 120


# ---------------------------------------------------------------------------
# Contexto, permisos y consultas base
# ---------------------------------------------------------------------------

def _ctx(company=None, desde=None, hasta=None) -> frappe._dict:
    from facex_multi.api.invoice import get_effective_company
    from facex_multi.api.permissions import get_facex_permissions_for_company

    company = get_effective_company(company)
    if not get_facex_permissions_for_company(company).get("analitica"):
        frappe.throw(_("No tiene permiso para la Analítica."), frappe.PermissionError)
    hasta = getdate(hasta or today())
    desde = getdate(desde or add_days(hasta, -89))
    if desde > hasta:
        frappe.throw(_("La fecha Desde no puede ser posterior a Hasta."))
    if date_diff(hasta, desde) > MAX_DIAS:
        frappe.throw(_("El período no puede pasar de {0} días.").format(MAX_DIAS))
    corte, cv = _c._corte_si(company, "si")
    return frappe._dict(company=company, desde=desde, hasta=hasta, corte=corte, cv=cv,
                        dias=date_diff(hasta, desde) + 1)


def _ventas(ctx, desde=None, hasta=None) -> list:
    return frappe.db.sql(
        f"""
        SELECT si.name, si.customer, si.customer_name, si.posting_date, si.posting_time,
               si.grand_total AS total, si.total_qty, si.due_date, si.owner,
               IFNULL(si.sales_partner, '') AS vendedor,
               IFNULL(si.bfel_pago_contra_entrega, 0) AS pago_ce,
               EXISTS(SELECT 1 FROM `tabeFast Invoice Payment` p
                      WHERE p.parent = si.name AND p.parenttype = 'Sales Invoice'
                        AND p.payment_method = %(ce)s) AS tiene_ce
        FROM `tabSales Invoice` si
        WHERE si.company = %(company)s AND si.docstatus = 1 AND si.is_return = 0
          AND si.posting_date BETWEEN %(desde)s AND %(hasta)s AND {ctx.corte}
        ORDER BY si.posting_date, si.posting_time
        """,
        {"company": ctx.company, "desde": desde or ctx.desde, "hasta": hasta or ctx.hasta,
         "ce": _c.CONTRA_ENTREGA, **ctx.cv},
        as_dict=True,
    )


def _lineas(ctx, desde=None, hasta=None) -> list:
    flete = _item_flete(ctx.company)
    return frappe.db.sql(
        f"""
        SELECT sii.parent, si.customer, si.posting_date, sii.item_code, sii.item_name,
               sii.item_group, sii.stock_qty AS qty, sii.amount
        FROM `tabSales Invoice Item` sii
        JOIN `tabSales Invoice` si ON si.name = sii.parent
        WHERE si.company = %(company)s AND si.docstatus = 1 AND si.is_return = 0
          AND si.posting_date BETWEEN %(desde)s AND %(hasta)s AND {ctx.corte}
          AND IFNULL(sii.item_code, '') NOT IN ('', %(flete)s)
        """,
        {"company": ctx.company, "desde": desde or ctx.desde, "hasta": hasta or ctx.hasta,
         "flete": flete or "-", **ctx.cv},
        as_dict=True,
    )


def _item_flete(company) -> str:
    from facex_multi.api.permissions import get_facex_company_config
    return get_facex_company_config(company).get("item_flete") or ""


def _condicion(r) -> str:
    if cint(r.pago_ce) or cint(r.tiene_ce):
        return C_CE
    if r.due_date and getdate(r.due_date) > getdate(r.posting_date):
        return C_CREDITO
    return C_CONTADO


def _hora(t) -> int:
    if t is None:
        return 0
    if isinstance(t, timedelta):
        return int(t.total_seconds() // 3600) % 24
    try:
        return int(str(t).split(":")[0]) % 24
    except ValueError:
        return 0


def _genericos() -> set:
    from facex_multi.api.cliente_generico import generic_customers
    return generic_customers()


def _r(v, n=2):
    return round(flt(v), n)


def _pct(a, b):
    return _r(100.0 * a / b, 1) if b else 0.0


def _var(actual, anterior):
    """Variación % contra el período anterior (None si no hay base)."""
    return _r(100.0 * (actual - anterior) / anterior, 1) if anterior else None


def _clientes_info(nombres) -> dict:
    if not nombres:
        return {}
    rows = frappe.get_all(
        "Customer", filters={"name": ["in", list(nombres)]},
        fields=["name", "customer_name", "mobile_no", "default_sales_partner"],
    )
    return {r.name: r for r in rows}


def _usuarios(nombres) -> dict:
    if not nombres:
        return {}
    rows = frappe.get_all("User", filters={"name": ["in", list(nombres)]}, fields=["name", "full_name"])
    return {r.name: (r.full_name or r.name) for r in rows}


# ---------------------------------------------------------------------------
# 1. Resumen
# ---------------------------------------------------------------------------

def _kpis_basicos(rows, gen) -> dict:
    total = sum(flt(r.total) for r in rows)
    n = len(rows)
    clientes = {r.customer for r in rows if r.customer not in gen}
    return {"ventas": _r(total), "tickets": n, "ticket_prom": _r(total / n) if n else 0,
            "articulos_ticket": _r(sum(flt(r.total_qty) for r in rows) / n, 1) if n else 0,
            "clientes": len(clientes)}


@frappe.whitelist()
def get_resumen(company=None, desde=None, hasta=None) -> dict:
    ctx = _ctx(company, desde, hasta)
    gen = _genericos()
    rows = _ventas(ctx)
    prev = _ventas(ctx, add_days(ctx.desde, -ctx.dias), add_days(ctx.desde, -1))
    k, kp = _kpis_basicos(rows, gen), _kpis_basicos(prev, gen)
    for key in ("ventas", "tickets", "ticket_prom", "clientes"):
        k[f"{key}_var"] = _var(k[key], kp[key])

    # Recompra dentro del período y clientes nuevos (primera compra en el período).
    por_cliente = Counter(r.customer for r in rows if r.customer not in gen)
    k["recompran"] = sum(1 for c in por_cliente.values() if c >= 2)
    k["pct_recompra"] = _pct(k["recompran"], len(por_cliente))
    primeras = dict(frappe.db.sql(
        f"""SELECT si.customer, MIN(si.posting_date) FROM `tabSales Invoice` si
            WHERE si.company = %(company)s AND si.docstatus = 1 AND si.is_return = 0 AND {ctx.corte}
              AND si.customer IN %(clientes)s
            GROUP BY si.customer""", {"company": ctx.company, "clientes": tuple(por_cliente) or ("-",), **ctx.cv}))
    k["nuevos"] = sum(1 for c in por_cliente if primeras.get(c) and getdate(primeras[c]) >= ctx.desde)

    devol = frappe.db.sql(
        f"""SELECT COUNT(*), IFNULL(SUM(si.grand_total), 0) FROM `tabSales Invoice` si
            WHERE si.company = %(company)s AND si.docstatus = 1 AND si.is_return = 1
              AND si.posting_date BETWEEN %(desde)s AND %(hasta)s AND {ctx.corte}""",
        {"company": ctx.company, "desde": ctx.desde, "hasta": ctx.hasta, **ctx.cv})[0]
    k["devoluciones"], k["devoluciones_monto"] = cint(devol[0]), _r(abs(flt(devol[1])))

    cond = defaultdict(lambda: [0, 0.0])
    for r in rows:
        c = cond[_condicion(r)]
        c[0] += 1
        c[1] += flt(r.total)
    condiciones = [{"condicion": n, "tickets": cond[n][0], "monto": _r(cond[n][1]),
                    "pct": _pct(cond[n][1], k["ventas"])} for n in (C_CONTADO, C_CREDITO, C_CE)]

    # Serie: por día hasta 92 días; si no, por semana (lunes).
    semanal = ctx.dias > 92
    serie = defaultdict(lambda: [0.0, 0])
    for r in rows:
        d = getdate(r.posting_date)
        if semanal:
            d = d - timedelta(days=d.weekday())
        serie[d][0] += flt(r.total)
        serie[d][1] += 1
    puntos, d = [], ctx.desde - timedelta(days=ctx.desde.weekday()) if semanal else ctx.desde
    while d <= ctx.hasta:
        puntos.append({"fecha": str(d), "ventas": _r(serie[d][0]), "tickets": serie[d][1]})
        d += timedelta(days=7 if semanal else 1)

    horas, dias = Counter(), Counter()
    for r in rows:
        horas[_hora(r.posting_time)] += flt(r.total)
        dias[getdate(r.posting_date).weekday()] += flt(r.total)
    k["hora_pico"] = f"{max(horas, key=horas.get):02d}:00" if horas else "—"
    k["dia_pico"] = DIAS[max(dias, key=dias.get)] if dias else "—"

    top_cli = Counter()
    for r in rows:
        if r.customer not in gen:
            top_cli[(r.customer, r.customer_name)] += flt(r.total)
    prods = defaultdict(lambda: [0.0, 0.0, ""])
    for ln in _lineas(ctx):
        p = prods[ln.item_code]
        p[0] += flt(ln.amount)
        p[1] += flt(ln.qty)
        p[2] = ln.item_name
    return {
        "kpis": k, "condiciones": condiciones, "serie": puntos, "serie_semanal": semanal,
        "top_clientes": [{"cliente": n, "nombre": nm, "monto": _r(v)} for (n, nm), v in top_cli.most_common(5)],
        "top_productos": [{"item": c, "nombre": v[2], "monto": _r(v[0]), "cantidad": _r(v[1])}
                          for c, v in sorted(prods.items(), key=lambda x: -x[1][0])[:5]],
    }


# ---------------------------------------------------------------------------
# 2. Clientes: recompra, en riesgo, dejaron de comprar, nuevos
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_clientes(company=None, desde=None, hasta=None) -> dict:
    ctx = _ctx(company, desde, hasta)
    gen = _genericos()
    hist = defaultdict(list)
    for r in _ventas(ctx, INICIO, ctx.hasta):
        if r.customer not in gen:
            hist[r.customer].append(r)
    info = _clientes_info(hist.keys())
    out = []
    for cust, rs in hist.items():
        fechas = sorted(getdate(r.posting_date) for r in rs)
        n, total = len(rs), sum(flt(r.total) for r in rs)
        dias_sin = date_diff(ctx.hasta, fechas[-1])
        en_periodo = [r for r in rs if getdate(r.posting_date) >= ctx.desde]
        intervalo = None
        if n >= 2:
            intervalo = max(date_diff(fechas[-1], fechas[0]) / (n - 1), 1)
            ratio = dias_sin / max(intervalo, 7)
            estado = "Activo" if ratio <= 1.5 else ("En riesgo" if ratio <= 3 else "Dejó de comprar")
        else:
            estado = "Una compra"
        ci = info.get(cust) or {}
        out.append({
            "cliente": cust, "nombre": (ci.get("customer_name") or rs[-1].customer_name or cust),
            "celular": ci.get("mobile_no") or "", "vendedor": ci.get("default_sales_partner") or rs[-1].vendedor,
            "compras": n, "compras_periodo": len(en_periodo), "monto": _r(total),
            "monto_periodo": _r(sum(flt(r.total) for r in en_periodo)), "ticket_prom": _r(total / n),
            "primera": str(fechas[0]), "ultima": str(fechas[-1]), "dias_sin_comprar": dias_sin,
            "intervalo": _r(intervalo, 0) if intervalo else None, "estado": estado,
            "nuevo": fechas[0] >= ctx.desde,
        })
    cnt = Counter(c["estado"] for c in out)
    activos_periodo = [c for c in out if c["compras_periodo"]]
    recurrentes = [c for c in out if c["compras"] >= 2]
    riesgo = [c for c in out if c["estado"] == "En riesgo"]
    dejaron = [c for c in out if c["estado"] == "Dejó de comprar"]
    return {
        "kpis": {
            "clientes": len(out), "con_compra_periodo": len(activos_periodo),
            "recurrentes": len(recurrentes), "pct_recurrentes": _pct(len(recurrentes), len(out)),
            "activos": cnt["Activo"], "en_riesgo": cnt["En riesgo"], "dejaron": cnt["Dejó de comprar"],
            "una_compra": cnt["Una compra"], "nuevos": sum(1 for c in out if c["nuevo"]),
            # Lo que esos clientes compraban en un mes a su ritmo habitual.
            "venta_mensual_en_riesgo": _r(sum(c["ticket_prom"] * min(30.0 / max(c["intervalo"] or 30, 7), 4)
                                               for c in riesgo + dejaron)),
        },
        "recompran": sorted(recurrentes, key=lambda c: (-c["compras"], -c["monto"]))[:300],
        "en_riesgo": sorted(riesgo, key=lambda c: -c["monto"])[:300],
        "dejaron": sorted(dejaron, key=lambda c: -c["monto"])[:300],
        "nuevos": sorted((c for c in out if c["nuevo"]), key=lambda c: -c["monto"])[:300],
        "una_compra": sorted((c for c in out if c["estado"] == "Una compra"), key=lambda c: -c["monto"])[:300],
    }


# ---------------------------------------------------------------------------
# 3. Horarios
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_horarios(company=None, desde=None, hasta=None) -> dict:
    ctx = _ctx(company, desde, hasta)
    tickets = [[0] * 24 for _ in range(7)]
    monto = [[0.0] * 24 for _ in range(7)]
    for r in _ventas(ctx):
        d, h = getdate(r.posting_date).weekday(), _hora(r.posting_time)
        tickets[d][h] += 1
        monto[d][h] += flt(r.total)
    por_hora = [{"hora": h, "tickets": sum(tickets[d][h] for d in range(7)),
                 "monto": _r(sum(monto[d][h] for d in range(7)))} for h in range(24)]
    por_dia = [{"dia": DIAS[d], "tickets": sum(tickets[d]), "monto": _r(sum(monto[d]))} for d in range(7)]
    usadas = [h for h in range(24) if por_hora[h]["tickets"]]
    pico_h = max(por_hora, key=lambda x: x["monto"]) if usadas else None
    pico_d = max(por_dia, key=lambda x: x["monto"]) if usadas else None
    celda = max(((d, h) for d in range(7) for h in range(24)), key=lambda x: monto[x[0]][x[1]]) if usadas else None
    return {
        "dias": DIAS, "horas": list(range(min(usadas), max(usadas) + 1)) if usadas else [],
        "tickets": tickets, "monto": [[_r(v) for v in fila] for fila in monto],
        "por_hora": por_hora, "por_dia": por_dia,
        "kpis": {
            "hora_pico": f"{pico_h['hora']:02d}:00–{pico_h['hora'] + 1:02d}:00" if pico_h else "—",
            "hora_pico_monto": pico_h["monto"] if pico_h else 0,
            "dia_pico": pico_d["dia"] if pico_d else "—", "dia_pico_monto": pico_d["monto"] if pico_d else 0,
            "mejor_franja": f"{DIAS[celda[0]]} {celda[1]:02d}:00" if celda else "—",
            "hora_baja": (f"{min((x for x in por_hora if x['tickets']), key=lambda x: x['monto'])['hora']:02d}:00"
                          if usadas else "—"),
        },
    }


# ---------------------------------------------------------------------------
# 4. Condición de pago (contado / crédito / contra entrega)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_condicion(company=None, desde=None, hasta=None) -> dict:
    ctx = _ctx(company, desde, hasta)
    gen = _genericos()
    rows = _ventas(ctx)
    total = sum(flt(r.total) for r in rows)
    agg = defaultdict(lambda: {"tickets": 0, "monto": 0.0, "clientes": set()})
    mes = defaultdict(lambda: defaultdict(float))
    cli = defaultdict(lambda: {"nombre": "", "ce": 0, "ce_monto": 0.0, "tickets": 0})
    for r in rows:
        c = _condicion(r)
        a = agg[c]
        a["tickets"] += 1
        a["monto"] += flt(r.total)
        if r.customer not in gen:
            a["clientes"].add(r.customer)
            x = cli[r.customer]
            x["nombre"] = r.customer_name
            x["tickets"] += 1
            if c == C_CE:
                x["ce"] += 1
                x["ce_monto"] += flt(r.total)
        d = getdate(r.posting_date)
        mes[f"{MESES[d.month - 1]} {d.year}"][c] += flt(r.total)
    resumen = []
    for c in (C_CONTADO, C_CREDITO, C_CE):
        a = agg[c]
        resumen.append({"condicion": c, "tickets": a["tickets"], "monto": _r(a["monto"]),
                        "pct": _pct(a["monto"], total), "pct_tickets": _pct(a["tickets"], len(rows)),
                        "ticket_prom": _r(a["monto"] / a["tickets"]) if a["tickets"] else 0,
                        "clientes": len(a["clientes"])})
    meses = []
    for m in dict.fromkeys(f"{MESES[getdate(r.posting_date).month - 1]} {getdate(r.posting_date).year}" for r in rows):
        meses.append({"mes": m, **{c: _r(mes[m][c]) for c in (C_CONTADO, C_CREDITO, C_CE)}})
    top_ce = sorted(({"cliente": k, "nombre": v["nombre"], "pedidos_ce": v["ce"], "monto_ce": _r(v["ce_monto"]),
                      "tickets": v["tickets"], "pct_ce": _pct(v["ce"], v["tickets"])}
                     for k, v in cli.items() if v["ce"]), key=lambda x: -x["pedidos_ce"])
    return {"resumen": resumen, "meses": meses, "clientes_ce": top_ce[:300],
            "kpis": {"pct_ce": resumen[2]["pct_tickets"], "ce_tickets": resumen[2]["tickets"],
                     "ce_monto": resumen[2]["monto"], "clientes_ce": len(top_ce),
                     "pct_credito": resumen[1]["pct"], "pct_contado": resumen[0]["pct"]}}


# ---------------------------------------------------------------------------
# 5. Productos: más vendidos, sin venta, para ofertar
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_productos(company=None, desde=None, hasta=None) -> dict:
    ctx = _ctx(company, desde, hasta)
    act = defaultdict(lambda: {"qty": 0.0, "monto": 0.0, "tickets": set(), "clientes": set(), "ultima": None})
    nombres = {}
    for ln in _lineas(ctx):
        a = act[ln.item_code]
        a["qty"] += flt(ln.qty)
        a["monto"] += flt(ln.amount)
        a["tickets"].add(ln.parent)
        a["clientes"].add(ln.customer)
        a["ultima"] = max(a["ultima"] or ln.posting_date, ln.posting_date)
        nombres[ln.item_code] = (ln.item_name, ln.item_group)
    prev = Counter()
    for ln in _lineas(ctx, add_days(ctx.desde, -ctx.dias), add_days(ctx.desde, -1)):
        prev[ln.item_code] += flt(ln.qty)

    stock = {r.item_code: r for r in frappe.db.sql(
        """SELECT b.item_code, SUM(b.actual_qty) AS qty, SUM(b.stock_value) AS valor
           FROM `tabBin` b JOIN `tabWarehouse` w ON w.name = b.warehouse
           WHERE w.company = %(company)s AND b.actual_qty > 0 GROUP BY b.item_code""",
        {"company": ctx.company}, as_dict=True)}
    items = {r.name: r for r in frappe.db.sql(
        """SELECT name, item_name, item_group, stock_uom FROM `tabItem`
           WHERE disabled = 0 AND is_sales_item = 1
             AND (IFNULL(bfel_company, '') = '' OR bfel_company = %(company)s)""",
        {"company": ctx.company}, as_dict=True)}
    ultima_venta = dict(frappe.db.sql(
        f"""SELECT sii.item_code, MAX(si.posting_date) FROM `tabSales Invoice Item` sii
            JOIN `tabSales Invoice` si ON si.name = sii.parent
            WHERE si.company = %(company)s AND si.docstatus = 1 AND si.is_return = 0 AND {ctx.corte}
            GROUP BY sii.item_code""", {"company": ctx.company, **ctx.cv}))

    def nombre(code):
        it = items.get(code)
        return (it.item_name if it else nombres.get(code, (code, ""))[0]), (it.item_group if it else nombres.get(code, ("", ""))[1])

    vendidos = []
    for code, a in act.items():
        nm, grp = nombre(code)
        st = stock.get(code)
        vendidos.append({"item": code, "nombre": nm, "grupo": grp, "cantidad": _r(a["qty"]), "monto": _r(a["monto"]),
                         "tickets": len(a["tickets"]), "clientes": len(a["clientes"]),
                         "stock": _r(st.qty if st else 0), "var_cantidad": _var(a["qty"], prev.get(code, 0))})
    vendidos.sort(key=lambda x: -x["monto"])

    sin_venta, ofertar = [], []
    for code, st in stock.items():
        if code not in items or flt(st.qty) <= 0:
            continue
        nm, grp = nombre(code)
        ult = ultima_venta.get(code)
        base = {"item": code, "nombre": nm, "grupo": grp, "stock": _r(st.qty), "valor_stock": _r(st.valor),
                "uom": items[code].stock_uom, "ultima_venta": str(ult) if ult else None,
                "dias_sin_venta": date_diff(ctx.hasta, ult) if ult else None}
        a = act.get(code)
        if not a:
            sin_venta.append(base)
            continue
        diaria = a["qty"] / ctx.dias
        dias_inv = flt(st.qty) / diaria if diaria else None
        motivos = []
        if dias_inv and dias_inv > DIAS_INVENTARIO_ALTO:
            motivos.append(f"Stock para {int(dias_inv)} días al ritmo actual")
        p = prev.get(code, 0)
        if p >= 3 and a["qty"] <= p * 0.5:
            motivos.append(f"Ventas bajaron {int(round(100 * (p - a['qty']) / p))}% vs período anterior")
        if motivos:
            ofertar.append({**base, "vendido": _r(a["qty"]), "dias_inventario": int(dias_inv) if dias_inv else None,
                            "motivo": "; ".join(motivos)})
    sin_venta.sort(key=lambda x: -x["valor_stock"])
    ofertar.sort(key=lambda x: -x["valor_stock"])
    return {
        "kpis": {"vendidos": len(vendidos), "sin_venta": len(sin_venta),
                 "valor_sin_venta": _r(sum(x["valor_stock"] for x in sin_venta)),
                 "para_ofertar": len(ofertar), "valor_ofertar": _r(sum(x["valor_stock"] for x in ofertar)),
                 "top": vendidos[0]["nombre"] if vendidos else "—"},
        "vendidos": vendidos[:300], "sin_venta": sin_venta[:300], "ofertar": ofertar[:300],
    }


# ---------------------------------------------------------------------------
# 6. Venta cruzada: productos que se compran juntos y clientes parecidos
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_cruzada(company=None, desde=None, hasta=None, customer=None) -> dict:
    ctx = _ctx(company, desde, hasta)
    gen = _genericos()
    tickets = defaultdict(set)
    por_cliente = defaultdict(set)
    nombres = {}
    for ln in _lineas(ctx):
        tickets[ln.parent].add(ln.item_code)
        nombres[ln.item_code] = ln.item_name
        if ln.customer not in gen:
            por_cliente[ln.customer].add(ln.item_code)
    cuenta, pares = Counter(), Counter()
    for items in tickets.values():
        cuenta.update(items)
        if 2 <= len(items) <= 40:
            pares.update(combinations(sorted(items), 2))
    lista_pares = []
    for (a, b), n in pares.most_common(60):
        if n < 2:
            break
        lista_pares.append({"a": a, "a_nombre": nombres.get(a, a), "b": b, "b_nombre": nombres.get(b, b),
                            "juntos": n, "pct_a": _pct(n, cuenta[a]), "pct_b": _pct(n, cuenta[b])})
    multi = sum(1 for s in tickets.values() if len(s) >= 2)

    info = _clientes_info(por_cliente.keys())
    clientes = sorted(({"cliente": c, "nombre": (info.get(c) or {}).get("customer_name") or c, "productos": len(s)}
                       for c, s in por_cliente.items()), key=lambda x: -x["productos"])
    res = {"kpis": {"tickets": len(tickets), "tickets_multi": multi, "pct_multi": _pct(multi, len(tickets)),
                    "pares": len(lista_pares)},
           "pares": lista_pares, "clientes": clientes[:500], "parecidos": [], "sugerencias": []}

    if customer and customer in por_cliente:
        mio = por_cliente[customer]
        sims = []
        for c, s in por_cliente.items():
            if c == customer:
                continue
            inter = len(mio & s)
            if inter:
                sims.append((inter / len(mio | s), c, inter))
        sims.sort(reverse=True)
        top = sims[:15]
        score, quien = Counter(), defaultdict(int)
        for sim, c, _i in top:
            for it in por_cliente[c] - mio:
                score[it] += sim
                quien[it] += 1
        res["parecidos"] = [{"cliente": c, "nombre": (info.get(c) or {}).get("customer_name") or c,
                             "en_comun": i, "similitud": _r(100 * s, 0)} for s, c, i in top[:8]]
        res["sugerencias"] = [{"item": it, "nombre": nombres.get(it, it), "clientes_parecidos": quien[it],
                               "puntaje": _r(sc, 2)} for it, sc in score.most_common(15)]
        res["cliente"] = {"cliente": customer, "nombre": (info.get(customer) or {}).get("customer_name") or customer,
                          "productos": [{"item": i, "nombre": nombres.get(i, i)} for i in sorted(mio)]}
    return res


# ---------------------------------------------------------------------------
# 7. Crédito: cartera real, cobros esperados y pronóstico de compras
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_credito(company=None, desde=None, hasta=None) -> dict:
    ctx = _ctx(company, desde, hasta)
    gen = _genericos()
    hoy = getdate(today())
    creditos = [r for r in _ventas(ctx, INICIO, hoy) if _condicion(r) == C_CREDITO]
    pagos = {}
    if creditos:
        for p in frappe.db.sql(
            """SELECT parent, SUM(amount) AS pagado, MAX(payment_date) AS ultimo
               FROM `tabeFast Invoice Payment` WHERE parenttype = 'Sales Invoice' AND parent IN %(n)s
               GROUP BY parent""", {"n": tuple(r.name for r in creditos)}, as_dict=True):
            pagos[p.parent] = p

    buckets = {k: 0.0 for k in ("v60", "v31", "v1", "p7", "p15", "p30", "p31")}
    semanas = defaultdict(float)
    cli = defaultdict(lambda: {"fechas": [], "montos": [], "saldo": 0.0, "vencido": 0.0, "atrasos": [], "nombre": ""})
    cartera, vencido = 0.0, 0.0
    for r in creditos:
        p = pagos.get(r.name)
        saldo = max(flt(r.total) - flt(p.pagado if p else 0), 0)
        due = getdate(r.due_date)
        x = cli[r.customer]
        x["nombre"] = r.customer_name
        x["fechas"].append(getdate(r.posting_date))
        x["montos"].append(flt(r.total))
        if saldo <= 0.01:
            if p and p.ultimo:
                x["atrasos"].append(date_diff(p.ultimo, due))
            continue
        cartera += saldo
        x["saldo"] += saldo
        dias = date_diff(hoy, due)
        if dias > 0:
            vencido += saldo
            x["vencido"] += saldo
            buckets["v60" if dias > 60 else ("v31" if dias > 30 else "v1")] += saldo
        else:
            d = -dias
            buckets["p7" if d <= 7 else ("p15" if d <= 15 else ("p30" if d <= 30 else "p31"))] += saldo
            if d <= 56:
                semanas[due - timedelta(days=due.weekday())] += saldo
    lunes = hoy - timedelta(days=hoy.weekday())
    cobros = [{"semana": "Vencido", "monto": _r(vencido)}] + [
        {"semana": str(lunes + timedelta(weeks=i)), "monto": _r(semanas[lunes + timedelta(weeks=i)])} for i in range(8)]

    info = _clientes_info(cli.keys())
    pron, esperado_total = [], 0.0
    for c, x in cli.items():
        if c in gen:
            continue
        fechas = sorted(x["fechas"])
        n = len(fechas)
        ticket = sum(x["montos"]) / n
        intervalo = max(date_diff(fechas[-1], fechas[0]) / (n - 1), 7) if n >= 2 else None
        dias_sin = date_diff(hoy, fechas[-1])
        activo = bool(intervalo) and dias_sin <= 3 * intervalo
        esperado = ticket * min(30.0 / intervalo, 4) if activo else 0.0
        esperado_total += esperado
        proxima = fechas[-1] + timedelta(days=int(intervalo)) if intervalo else None
        pron.append({
            "cliente": c, "nombre": (info.get(c) or {}).get("customer_name") or x["nombre"],
            "celular": (info.get(c) or {}).get("mobile_no") or "",
            "compras": n, "ticket_prom": _r(ticket), "intervalo": int(intervalo) if intervalo else None,
            "ultima": str(fechas[-1]), "proxima": str(proxima) if proxima else None,
            "esperado_30": _r(esperado), "saldo": _r(x["saldo"]), "vencido": _r(x["vencido"]),
            "atraso_prom": _r(statistics.mean(x["atrasos"]), 0) if x["atrasos"] else None,
            "estado": "Activo" if activo else ("Una compra" if n == 1 else "Sin compras recientes"),
        })
    pron.sort(key=lambda x: (-x["esperado_30"], -x["saldo"]))
    return {
        "kpis": {"cartera": _r(cartera), "vencido": _r(vencido), "pct_vencido": _pct(vencido, cartera),
                 "por_vencer_30": _r(buckets["p7"] + buckets["p15"] + buckets["p30"]),
                 "esperado_30": _r(esperado_total),
                 "clientes_activos": sum(1 for p in pron if p["estado"] == "Activo"),
                 "clientes_con_saldo": sum(1 for p in pron if p["saldo"] > 0.01)},
        "antiguedad": [
            {"rango": "Vencido más de 60 días", "monto": _r(buckets["v60"]), "tono": "rojo"},
            {"rango": "Vencido 31–60 días", "monto": _r(buckets["v31"]), "tono": "rojo"},
            {"rango": "Vencido 1–30 días", "monto": _r(buckets["v1"]), "tono": "ambar"},
            {"rango": "Vence en 0–7 días", "monto": _r(buckets["p7"]), "tono": "azul"},
            {"rango": "Vence en 8–15 días", "monto": _r(buckets["p15"]), "tono": "azul"},
            {"rango": "Vence en 16–30 días", "monto": _r(buckets["p30"]), "tono": "verde"},
            {"rango": "Vence en más de 30 días", "monto": _r(buckets["p31"]), "tono": "verde"},
        ],
        "cobros": cobros, "pronostico": pron[:300],
    }


# ---------------------------------------------------------------------------
# 8. Tickets
# ---------------------------------------------------------------------------

_RANGOS = [(0, 100), (100, 250), (250, 500), (500, 1000), (1000, 2500), (2500, 5000), (5000, None)]


@frappe.whitelist()
def get_tickets(company=None, desde=None, hasta=None) -> dict:
    ctx = _ctx(company, desde, hasta)
    rows = _ventas(ctx)
    lineas = Counter(ln.parent for ln in _lineas(ctx))
    montos = [flt(r.total) for r in rows]
    n = len(rows)
    rangos = []
    for lo, hi in _RANGOS:
        sel = [m for m in montos if m >= lo and (hi is None or m < hi)]
        rangos.append({"rango": f"Q{lo:,}–Q{hi:,}" if hi else f"Q{lo:,} o más", "tickets": len(sel),
                       "pct": _pct(len(sel), n), "monto": _r(sum(sel))})
    art = Counter()
    for r in rows:
        k = lineas.get(r.name, 0)
        art["1" if k <= 1 else ("2" if k == 2 else ("3" if k == 3 else ("4–5" if k <= 5 else "6 o más")))] += 1
    articulos = [{"productos": k, "tickets": art[k], "pct": _pct(art[k], n)} for k in ("1", "2", "3", "4–5", "6 o más")]

    def agrupa(key, etiqueta):
        g = defaultdict(lambda: [0, 0.0, 0])
        for r in rows:
            x = g[key(r)]
            x[0] += 1
            x[1] += flt(r.total)
            x[2] += lineas.get(r.name, 0)
        return sorted(({"nombre": etiqueta(k), "tickets": v[0], "monto": _r(v[1]), "ticket_prom": _r(v[1] / v[0]),
                        "productos_prom": _r(v[2] / v[0], 1)} for k, v in g.items()), key=lambda x: -x["monto"])

    usuarios = _usuarios({r.owner for r in rows})
    por_dia = defaultdict(list)
    for r in rows:
        por_dia[getdate(r.posting_date).weekday()].append(flt(r.total))
    return {
        "kpis": {"tickets": n, "ticket_prom": _r(sum(montos) / n) if n else 0,
                 "ticket_mediana": _r(statistics.median(montos)) if montos else 0,
                 "ticket_max": _r(max(montos)) if montos else 0,
                 "productos_ticket": _r(sum(lineas.values()) / n, 1) if n else 0,
                 "pct_un_producto": articulos[0]["pct"]},
        "rangos": rangos, "articulos": articulos,
        "vendedores": agrupa(lambda r: r.vendedor, lambda k: k or "(Sin vendedor)"),
        "usuarios": agrupa(lambda r: r.owner, lambda k: usuarios.get(k, k)),
        "por_dia": [{"dia": DIAS[d], "tickets": len(por_dia[d]),
                     "ticket_prom": _r(sum(por_dia[d]) / len(por_dia[d])) if por_dia[d] else 0} for d in range(7)],
    }


# ---------------------------------------------------------------------------
# Contexto de la página
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_contexto(company=None) -> dict:
    """Compañía efectiva y usuario; falla con PermissionError sin `analitica`."""
    ctx = _ctx(company)
    primera = frappe.db.sql(
        f"""SELECT MIN(si.posting_date) FROM `tabSales Invoice` si
            WHERE si.company = %(company)s AND si.docstatus = 1 AND {ctx.corte}""",
        {"company": ctx.company, **ctx.cv})[0][0]
    return {"company": ctx.company, "hoy": today(),
            "user_fullname": frappe.utils.get_fullname(frappe.session.user),
            "primera_venta": str(primera) if primera else None}
