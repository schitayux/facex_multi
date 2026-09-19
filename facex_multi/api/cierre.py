"""
facex_multi.api.cierre
----------------------
Cierre Diario de Ventas y Cuadre de Pagos (Page «facex-cierre»).

Un cierre es único por Compañía + Fecha + Usuario (caja): cada usuario
cierra SUS ventas del día (Sales Invoice validadas con owner = usuario y
posting_date = fecha). El documento «FacEx Cierre Diario» guarda un
snapshot del resumen (ventas, fletes, cobros por forma de pago, créditos),
el detalle de venta por Familia de Precio y los egresos anotados a mano
para reportar cuánto efectivo se entrega para depósito.

Congelamiento — un cierre en estado «Cerrado» bloquea, para ese usuario:
  * cancelar cualquier factura de esa fecha (before_cancel);
  * agregar / quitar / modificar pagos (custom_efast_payments) con fecha
    dentro de un día cerrado, o anteriores o iguales a la fecha de una
    factura ya cerrada (before_update_after_submit);
  * cancelar Payment Entries validados vinculados a facturas congeladas.
Todo lo que tenga fecha POSTERIOR al cierre sigue permitido (p.ej. un abono
de hoy a una factura de ayer ya cerrada).

Permisos (FacEx Settings):
  * puede_crear_cierres → crear / cuadrar / cerrar los cierres PROPIOS y
    verlos únicamente ellos.
  * Rol (Clasificación) «Gerencia» → ver los cierres de todos, crear/cerrar
    los de cualquier usuario y REABRIR un cierre Cerrado (única vía para
    corregir facturas o pagos ya congelados).
  * System Manager → acceso total.
"""
from __future__ import annotations

import json
from collections import Counter, OrderedDict

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, formatdate, getdate, now_datetime, today

from facex_multi.api.invoice import get_effective_company
from facex_multi.api.permissions import (
    get_facex_can_create_cierres,
    get_facex_company_config,
    get_facex_is_gerencia,
)

DOCTYPE = "FacEx Cierre Diario"

# Formas de pago de eFast Invoice Payment → campo del cierre
_METHOD_FIELD = {
    "Efectivo": "cobro_efectivo",
    "Transferencia": "cobro_transferencia",
    "Cheque": "cobro_cheque",
    "Tarjeta de Crédito": "cobro_tarjeta",
}
_METHOD_LABEL = {
    "cobro_efectivo": "Pago Efectivo",
    "cobro_transferencia": "Transferencia",
    "cobro_cheque": "Cheques",
    "cobro_tarjeta": "Tarjeta de Crédito",
    "cobro_contra_entrega": "Contra Entrega",
    "al_credito": "Al Crédito",
}
CONTRA_ENTREGA = "Contra Entrega"

# Días hacia atrás que se revisan para la alerta de "cierres pendientes".
PENDING_LOOKBACK_DAYS = 60

# Egresos con los que arranca un cierre nuevo (según hoja CIERRE VENTA.xlsx).
DEFAULT_EGRESOS = ["Administración entregado a Gerencia", "Gastos"]


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------

def _is_sysman() -> bool:
    return "System Manager" in frappe.get_roles()


def _installed() -> bool:
    """El bench comparte código entre sitios: un sitio sin migrar no tiene la
    tabla todavía. Sin ella el módulo simplemente no existe para ese sitio
    (sin tarjeta, sin alertas, sin congelamiento)."""
    return frappe.db.table_exists(DOCTYPE) and frappe.get_meta("FacEx Settings").has_field("puede_crear_cierres")


def _is_gerencia(company: str) -> bool:
    return _installed() and (_is_sysman() or get_facex_is_gerencia(company))


def _can_create(company: str) -> bool:
    return _installed() and (_is_sysman() or get_facex_can_create_cierres(company))


def _assert_module_access(company: str) -> None:
    if not (_can_create(company) or _is_gerencia(company)):
        frappe.throw(_("No tiene permiso para el módulo Cierre Diario de FacEx."), frappe.PermissionError)


def _assert_can_manage(company: str, usuario: str) -> None:
    """Crear / guardar / cerrar el cierre de `usuario`."""
    if _is_gerencia(company):
        return
    if _can_create(company) and usuario == frappe.session.user:
        return
    frappe.throw(_("Solo puede crear o cerrar sus propios cierres diarios."), frappe.PermissionError)


def _assert_can_view(doc) -> None:
    if _is_gerencia(doc.company):
        return
    if _can_create(doc.company) and doc.usuario == frappe.session.user:
        return
    frappe.throw(_("No tiene permiso para ver este cierre."), frappe.PermissionError)


def cierre_query_conditions(user: str = None) -> str:
    """permission_query_conditions (vista Desk): Gerencia / System Manager ven
    todo; el resto solo los cierres de su propia caja."""
    user = user or frappe.session.user
    if "System Manager" in frappe.get_roles(user):
        return ""
    company = get_effective_company()
    if company and frappe.db.get_value(
        "FacEx Settings", {"user": user, "bfel_company": company}, "rol_clasificacion"
    ) == "Gerencia":
        return ""
    return f"`tab{DOCTYPE}`.usuario = {frappe.db.escape(user)}"


def cierre_has_permission(doc, ptype: str = "read", user: str = None) -> bool:
    user = user or frappe.session.user
    if "System Manager" in frappe.get_roles(user):
        return True
    if doc.usuario == user:
        return True
    return frappe.db.get_value(
        "FacEx Settings", {"user": user, "bfel_company": doc.company}, "rol_clasificacion"
    ) == "Gerencia"


# ---------------------------------------------------------------------------
# Congelamiento
# ---------------------------------------------------------------------------

def _closed_dates(company: str, owner: str) -> set:
    if not company or not owner or not frappe.db.table_exists(DOCTYPE):
        return set()
    return {
        getdate(d)
        for d in frappe.get_all(
            DOCTYPE,
            filters={"company": company, "usuario": owner, "estado": "Cerrado"},
            pluck="fecha",
        )
    }


def _row_frozen(row_date, posting_date, closed: set) -> bool:
    """Un pago está congelado si su fecha cae en un día cerrado, o si es
    anterior/igual a la fecha de una factura cuyo día ya se cerró (el cierre
    de la factura lo contó dentro de «Cobros y Créditos»)."""
    if not closed:
        return False
    rd = getdate(row_date or posting_date)
    pd = getdate(posting_date)
    return rd in closed or (pd in closed and rd <= pd)


def _payment_key(row) -> tuple:
    return (
        row.get("payment_method") or "",
        str(getdate(row.get("payment_date"))) if row.get("payment_date") else "",
        round(flt(row.get("amount")), 2),
        (row.get("reference") or "").strip(),
    )


def _frozen_msg(company: str, owner: str, fecha) -> str:
    name = frappe.db.get_value(
        DOCTYPE, {"company": company, "usuario": owner, "fecha": getdate(fecha), "estado": "Cerrado"}, "name"
    )
    return _(
        "El día {0} ya tiene Cierre Diario de Ventas ({1}) para {2}. "
        "Un usuario de Gerencia debe reabrir ese cierre desde FacEx antes de modificar facturas o pagos de esa fecha."
    ).format(formatdate(fecha), name or "", owner)


def guard_sales_invoice_cancel(doc, method=None):
    """Hook Sales Invoice.before_cancel."""
    if doc.flags.facex_cierre_bypass:
        return
    closed = _closed_dates(doc.company, doc.owner)
    if not closed:
        return
    if getdate(doc.posting_date) in closed:
        frappe.throw(_frozen_msg(doc.company, doc.owner, doc.posting_date), title=_("Cierre Diario"))
    for row in doc.get("custom_efast_payments") or []:
        if _row_frozen(row.payment_date, doc.posting_date, closed):
            frappe.throw(
                _("La factura {0} tiene un pago del {1} incluido en un Cierre Diario ya cerrado. ")
                .format(doc.name, formatdate(row.payment_date or doc.posting_date))
                + _frozen_msg(doc.company, doc.owner, row.payment_date or doc.posting_date),
                title=_("Cierre Diario"),
            )


def guard_sales_invoice_update_after_submit(doc, method=None):
    """Hook Sales Invoice.before_update_after_submit — compara los pagos
    (custom_efast_payments) antes/después y rechaza cualquier alta, baja o
    cambio de una fila congelada. Filas con fecha posterior al cierre pasan."""
    if doc.flags.facex_cierre_bypass or not doc.meta.has_field("custom_efast_payments"):
        return
    closed = _closed_dates(doc.company, doc.owner)
    if not closed:
        return
    prev = doc.get_doc_before_save()
    old_rows = (prev.get("custom_efast_payments") if prev else None) or []
    new_rows = doc.get("custom_efast_payments") or []

    old_frozen = Counter(_payment_key(r) for r in old_rows if _row_frozen(r.payment_date, doc.posting_date, closed))
    new_frozen = Counter(_payment_key(r) for r in new_rows if _row_frozen(r.payment_date, doc.posting_date, closed))
    if old_frozen == new_frozen:
        return

    changed = list((old_frozen - new_frozen).elements()) + list((new_frozen - old_frozen).elements())
    fecha = changed[0][1] if changed and changed[0][1] else doc.posting_date
    frappe.throw(
        _("No se pueden modificar los pagos de la factura {0} con fecha {1}: ").format(doc.name, formatdate(fecha))
        + _frozen_msg(doc.company, doc.owner, fecha),
        title=_("Cierre Diario"),
    )


def guard_payment_entry_cancel(doc, method=None):
    """Hook Payment Entry.before_cancel — un PE validado contra una factura
    congelada (o fechado en un día cerrado del dueño de la factura) no se
    puede anular."""
    if doc.flags.facex_cierre_bypass:
        return
    for ref in doc.get("references") or []:
        if ref.reference_doctype != "Sales Invoice":
            continue
        si = frappe.db.get_value(
            "Sales Invoice", ref.reference_name, ["company", "owner", "posting_date"], as_dict=True
        )
        if not si:
            continue
        closed = _closed_dates(si.company, si.owner)
        if not closed:
            continue
        if getdate(si.posting_date) in closed or _row_frozen(doc.posting_date, si.posting_date, closed):
            frappe.throw(
                _("El pago {0} pertenece a la factura {1}, incluida en un Cierre Diario cerrado. ").format(doc.name, ref.reference_name)
                + _frozen_msg(si.company, si.owner, si.posting_date if getdate(si.posting_date) in closed else doc.posting_date),
                title=_("Cierre Diario"),
            )


@frappe.whitelist()
def get_invoice_freeze_status(invoice_name: str) -> dict:
    """Para el front (Historial / Anular): informa si una factura está
    congelada por un cierre y hasta qué fecha."""
    si = frappe.db.get_value(
        "Sales Invoice", invoice_name, ["company", "owner", "posting_date"], as_dict=True
    )
    if not si:
        return {"frozen": False}
    closed = _closed_dates(si.company, si.owner)
    frozen = getdate(si.posting_date) in closed
    return {
        "frozen": frozen,
        "closed_dates": sorted(str(d) for d in closed),
        "message": _frozen_msg(si.company, si.owner, si.posting_date) if frozen else "",
    }


# ---------------------------------------------------------------------------
# Cálculo del snapshot
# ---------------------------------------------------------------------------

def _si_fields() -> list:
    meta = frappe.get_meta("Sales Invoice")
    fields = ["name", "customer", "customer_name", "posting_date", "grand_total", "total",
              "net_total", "discount_amount", "is_return", "outstanding_amount", "owner"]
    for f in ("bfel_status", "bfel_pago_contra_entrega", "custom_pagado", "set_warehouse"):
        if meta.has_field(f):
            fields.append(f)
    return fields


def compute_snapshot(company: str, fecha, usuario: str) -> dict:
    """Calcula el resumen del día para (company, fecha, usuario). Puro: no
    escribe nada. Devuelve un dict serializable listo para el page y para
    volcarse en el documento."""
    fecha = getdate(fecha)
    flete_item = (get_facex_company_config(company).get("item_flete") or "").strip()

    invoices = frappe.get_all(
        "Sales Invoice",
        filters={"company": company, "posting_date": fecha, "owner": usuario, "docstatus": 1},
        fields=_si_fields(),
        order_by="name asc",
    )
    names = [i.name for i in invoices]

    items, payments = [], []
    if names:
        has_familia = frappe.get_meta("Item").has_field("custom_facex_familia")
        fam_select = (
            "it.custom_facex_familia AS familia, fam.descripcion AS familia_desc, fam.uom AS familia_uom"
            if has_familia else "NULL AS familia, NULL AS familia_desc, NULL AS familia_uom"
        )
        fam_join = (
            "LEFT JOIN `tabFacEx Familia de Precio` fam ON fam.name = it.custom_facex_familia"
            if has_familia else ""
        )
        items = frappe.db.sql(
            f"""
            SELECT sii.parent, sii.item_code, sii.item_name, sii.qty, sii.uom, sii.stock_uom,
                   sii.conversion_factor, sii.stock_qty, sii.discount_percentage, sii.discount_amount,
                   sii.rate, sii.price_list_rate, sii.amount, sii.idx,
                   {fam_select}
            FROM `tabSales Invoice Item` sii
            LEFT JOIN `tabItem` it ON it.name = sii.item_code
            {fam_join}
            WHERE sii.parent IN %(names)s AND sii.parenttype = 'Sales Invoice'
            ORDER BY sii.parent, sii.idx
            """,
            {"names": tuple(names)},
            as_dict=True,
        )
        if frappe.db.table_exists("eFast Invoice Payment"):
            payments = frappe.get_all(
                "eFast Invoice Payment",
                filters={"parent": ["in", names], "parenttype": "Sales Invoice"},
                fields=["parent", "payment_method", "payment_date", "reference", "amount"],
                order_by="parent asc, idx asc",
            )

    # ---- Ventas + detalle por familia -------------------------------------
    venta_sin_desc = venta_con_desc = flete_fact = 0.0
    inv_flete = Counter()
    inv_has_desc = set()
    groups = OrderedDict()

    def _group(key):
        if key not in groups:
            groups[key] = {
                "cantidad_original": 0.0, "cantidad": 0.0, "total": 0.0,
                "uoms": set(), "conversions": set(), "num_lineas": 0, "items": Counter(),
            }
        return groups[key]

    for it in items:
        amount = flt(it.amount)
        is_flete = bool(flete_item) and it.item_code == flete_item
        has_disc = flt(it.discount_percentage) > 0 or flt(it.discount_amount) > 0
        if is_flete:
            flete_fact += amount
            inv_flete[it.parent] += amount
            continue
        if has_disc:
            venta_con_desc += amount
            inv_has_desc.add(it.parent)
            key = ("OFERTA", "")
        else:
            venta_sin_desc += amount
            key = ("FAM", it.familia) if it.familia else ("ITEM", it.item_code)
        g = _group(key)
        g["cantidad_original"] += flt(it.qty)
        g["cantidad"] += flt(it.stock_qty) if it.stock_qty is not None else flt(it.qty) * (flt(it.conversion_factor) or 1)
        g["total"] += amount
        g["uoms"].add(it.uom or it.stock_uom or "")
        g["conversions"].add(round(flt(it.conversion_factor) or 1, 6))
        g["num_lineas"] += 1
        g["items"][it.item_code] += flt(it.stock_qty) if it.stock_qty is not None else flt(it.qty)
        if key[0] == "FAM":
            g.setdefault("descripcion", it.familia_desc or it.familia)
            g.setdefault("familia_uom", it.familia_uom or "")
        elif key[0] == "ITEM":
            g.setdefault("descripcion", it.item_name or it.item_code)

    familias = []
    # Fila 0: Piezas en Ofertas (siempre primero, aunque venga en cero)
    oferta = groups.pop(("OFERTA", ""), None)
    familias.append(_familia_row(
        es_oferta=1, familia="PIEZAS EN OFERTAS",
        descripcion="Todas las líneas con descuento aplicado", g=oferta,
    ))
    ordered = sorted(groups.items(), key=lambda kv: (kv[0][0] != "FAM", (kv[0][1] or "").upper()))
    for (kind, code), g in ordered:
        familias.append(_familia_row(
            es_oferta=0, familia=code,
            descripcion=g.get("descripcion") or code, g=g, kind=kind,
        ))

    # ---- Cobros y créditos ---------------------------------------------------
    pay_by_inv = {}
    for p in payments:
        pay_by_inv.setdefault(p.parent, []).append(p)

    cobros = {k: 0.0 for k in _METHOD_LABEL}
    cobro_otros = 0.0
    facturas = []
    total_venta = 0.0
    sum_lineas = venta_sin_desc + venta_con_desc + flete_fact

    for inv in invoices:
        gt = flt(inv.grand_total)
        total_venta += gt
        paid_non_ce = 0.0
        ce_rows = 0.0
        by_method = Counter()
        for p in pay_by_inv.get(inv.name, []):
            if p.payment_date and getdate(p.payment_date) > fecha:
                # Abono posterior al día — no pertenece a este cierre
                continue
            amt = flt(p.amount)
            if p.payment_method == CONTRA_ENTREGA:
                ce_rows += amt
                continue
            paid_non_ce += amt
            by_method[p.payment_method or "Efectivo"] += amt
            field = _METHOD_FIELD.get(p.payment_method)
            if field:
                cobros[field] += amt
            else:
                cobro_otros += amt

        if cint(inv.get("bfel_pago_contra_entrega")):
            ce = max(gt - paid_non_ce, 0.0) if gt >= 0 else min(gt - paid_non_ce, 0.0)
        else:
            ce = ce_rows
        credito = gt - paid_non_ce - ce
        cobros["cobro_contra_entrega"] += ce
        cobros["al_credito"] += credito

        formas = ", ".join(f"{m} {flt(a):,.2f}" for m, a in by_method.items())
        if ce:
            formas = (formas + ", " if formas else "") + f"{CONTRA_ENTREGA} {ce:,.2f}"
        if abs(credito) > 0.004:
            formas = (formas + ", " if formas else "") + f"Crédito {credito:,.2f}"

        facturas.append({
            "sales_invoice": inv.name,
            "customer_name": inv.customer_name or inv.customer,
            "grand_total": gt,
            "pagado": paid_non_ce,
            "contra_entrega": ce,
            "credito": credito,
            "flete": inv_flete.get(inv.name, 0.0),
            "formas_pago": formas,
            "tiene_descuento": 1 if inv.name in inv_has_desc else 0,
            "es_devolucion": cint(inv.get("is_return")),
            "bfel_status": inv.get("bfel_status") or "",
        })

    ajuste = total_venta - sum_lineas
    total_cobros = sum(cobros.values()) + cobro_otros

    # ---- Abonos de hoy a facturas de días anteriores (informativo) ------------
    abonos = []
    if frappe.db.table_exists("eFast Invoice Payment"):
        abonos = frappe.db.sql(
            """
            SELECT p.parent AS sales_invoice, si.customer_name, si.posting_date,
                   p.payment_method, p.reference, p.amount
            FROM `tabeFast Invoice Payment` p
            JOIN `tabSales Invoice` si ON si.name = p.parent
            WHERE si.company = %(company)s AND si.owner = %(usuario)s AND si.docstatus = 1
              AND si.posting_date < %(fecha)s AND p.payment_date = %(fecha)s
              AND p.parenttype = 'Sales Invoice' AND p.payment_method != %(ce)s
            ORDER BY p.parent
            """,
            {"company": company, "usuario": usuario, "fecha": fecha, "ce": CONTRA_ENTREGA},
            as_dict=True,
        )
    abonos_por_metodo = Counter()
    for a in abonos:
        abonos_por_metodo[a.payment_method or "Efectivo"] += flt(a.amount)
        a["posting_date"] = str(a.posting_date)

    return {
        "company": company,
        "fecha": str(fecha),
        "usuario": usuario,
        "flete_item": flete_item,
        "num_facturas": len(invoices),
        "venta_sin_descuento": round(venta_sin_desc, 2),
        "venta_con_descuento": round(venta_con_desc, 2),
        "flete_facturado": round(flete_fact, 2),
        "ajuste_impuestos": round(ajuste, 2),
        "total_venta": round(total_venta, 2),
        "cobro_efectivo": round(cobros["cobro_efectivo"], 2),
        "cobro_transferencia": round(cobros["cobro_transferencia"], 2),
        "cobro_cheque": round(cobros["cobro_cheque"], 2),
        "cobro_tarjeta": round(cobros["cobro_tarjeta"], 2),
        "cobro_contra_entrega": round(cobros["cobro_contra_entrega"], 2),
        "al_credito": round(cobros["al_credito"], 2),
        "cobro_otros": round(cobro_otros, 2),
        "total_cobros": round(total_cobros, 2),
        "abonos_anteriores": round(sum(abonos_por_metodo.values()), 2),
        "abonos_detalle": abonos,
        "abonos_por_metodo": dict(abonos_por_metodo),
        "detalle_familias": familias,
        "facturas": facturas,
    }


def _familia_row(es_oferta: int, familia: str, descripcion: str, g: dict | None, kind: str = "FAM") -> dict:
    if not g:
        return {
            "es_oferta": es_oferta, "familia": familia, "descripcion": descripcion,
            "cantidad_original": 0.0, "uom": "", "conversion": 0.0,
            "cantidad": 0.0, "precio_unidad": 0.0, "total": 0.0, "num_lineas": 0, "items": {},
        }
    uoms = {u for u in g["uoms"] if u}
    convs = g["conversions"]
    cantidad = flt(g["cantidad"])
    total = flt(g["total"])
    return {
        "es_oferta": es_oferta,
        "familia": familia,
        "descripcion": descripcion,
        "tipo": kind,
        "cantidad_original": round(flt(g["cantidad_original"]), 4),
        "uom": next(iter(uoms)) if len(uoms) == 1 else ("Varias" if uoms else ""),
        "conversion": next(iter(convs)) if len(convs) == 1 else 0.0,
        "cantidad": round(cantidad, 4),
        "precio_unidad": round(total / cantidad, 4) if cantidad else 0.0,
        "total": round(total, 2),
        "num_lineas": g["num_lineas"],
        "items": {k: round(v, 4) for k, v in g["items"].items()},
    }


# ---------------------------------------------------------------------------
# Pendientes
# ---------------------------------------------------------------------------

def _pending_days(company: str, usuario: str | None) -> list:
    """Días con ventas validadas (últimos PENDING_LOOKBACK_DAYS, anteriores a
    hoy) que aún no tienen un cierre Cerrado para ese usuario."""
    if not company or not _installed():
        return []
    desde = add_days(today(), -PENDING_LOOKBACK_DAYS)
    cond = ""
    vals = {"company": company, "desde": desde, "hoy": today()}
    if usuario:
        cond = "AND si.owner = %(usuario)s"
        vals["usuario"] = usuario
    rows = frappe.db.sql(
        f"""
        SELECT si.posting_date AS fecha, si.owner AS usuario, u.full_name AS usuario_nombre,
               COUNT(*) AS num_facturas, SUM(si.grand_total) AS total_venta,
               (SELECT c.name FROM `tabFacEx Cierre Diario` c
                 WHERE c.company = si.company AND c.usuario = si.owner AND c.fecha = si.posting_date
                 ORDER BY c.modified DESC LIMIT 1) AS cierre,
               (SELECT c.estado FROM `tabFacEx Cierre Diario` c
                 WHERE c.company = si.company AND c.usuario = si.owner AND c.fecha = si.posting_date
                 ORDER BY c.modified DESC LIMIT 1) AS estado
        FROM `tabSales Invoice` si
        LEFT JOIN `tabUser` u ON u.name = si.owner
        WHERE si.company = %(company)s AND si.docstatus = 1
          AND si.posting_date >= %(desde)s AND si.posting_date < %(hoy)s
          {cond}
        GROUP BY si.posting_date, si.owner
        HAVING IFNULL(estado, '') != 'Cerrado'
        ORDER BY si.posting_date DESC, si.owner
        """,
        vals,
        as_dict=True,
    )
    for r in rows:
        r["fecha"] = str(r["fecha"])
        r["total_venta"] = flt(r["total_venta"])
    return rows


@frappe.whitelist()
def get_pending_closures(company: str = None) -> list:
    """Alerta de días sin cerrar. Se invoca desde el Inicio de FacEx / FacEx
    Screen, por eso NO lanza error: sin módulo o sin permiso devuelve []."""
    company = get_effective_company(company)
    if not (_can_create(company) or _is_gerencia(company)):
        return []
    return _pending_days(company, None if _is_gerencia(company) else frappe.session.user)


# ---------------------------------------------------------------------------
# API del page
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_context(company: str = None) -> dict:
    company = get_effective_company(company)
    _assert_module_access(company)
    gerencia = _is_gerencia(company)

    users = []
    if gerencia:
        # Usuarios con ventas en la compañía + usuarios con FacEx Settings en ella
        users = frappe.db.sql(
            """
            SELECT DISTINCT x.name, u.full_name FROM (
                SELECT owner AS name FROM `tabSales Invoice` WHERE company = %(c)s AND docstatus = 1
                UNION
                SELECT user AS name FROM `tabFacEx Settings` WHERE bfel_company = %(c)s AND IFNULL(user, '') != ''
            ) x JOIN `tabUser` u ON u.name = x.name
            WHERE u.enabled = 1
            ORDER BY u.full_name
            """,
            {"c": company},
            as_dict=True,
        )
    me = frappe.session.user
    me_fullname = frappe.db.get_value("User", me, "full_name") or me
    if not any(u.name == me for u in users):
        users.insert(0, frappe._dict(name=me, full_name=me_fullname))

    return {
        "company": company,
        "company_abbr": frappe.db.get_value("Company", company, "abbr") or "",
        "currency": frappe.db.get_value("Company", company, "default_currency") or "GTQ",
        "user": me,
        "user_fullname": me_fullname,
        "es_gerencia": int(gerencia),
        "puede_crear_cierres": int(_can_create(company)),
        "today": today(),
        "users": users,
        "warehouses": frappe.get_all(
            "Warehouse", filters={"company": company, "is_group": 0, "disabled": 0},
            fields=["name", "warehouse_name"], order_by="warehouse_name",
        ),
        "default_egresos": DEFAULT_EGRESOS,
        "pending": _pending_days(company, None if gerencia else me),
    }


@frappe.whitelist()
def compute_preview(company: str = None, fecha: str = None, usuario: str = None) -> dict:
    """Snapshot en vivo (sin guardar) para la pantalla de cierre."""
    company = get_effective_company(company)
    usuario = usuario or frappe.session.user
    _assert_module_access(company)
    if not _is_gerencia(company) and usuario != frappe.session.user:
        frappe.throw(_("Solo puede consultar sus propios cierres."), frappe.PermissionError)
    if not fecha:
        frappe.throw(_("Indique la fecha del cierre."))
    snap = compute_snapshot(company, fecha, usuario)
    existing = frappe.db.get_value(
        DOCTYPE, {"company": company, "fecha": getdate(fecha), "usuario": usuario}, "name"
    )
    snap["existing"] = existing
    return snap


@frappe.whitelist()
def list_cierres(company: str = None, from_date: str = None, to_date: str = None,
                 usuario: str = None, estado: str = None) -> list:
    company = get_effective_company(company)
    _assert_module_access(company)
    filters = {"company": company}
    if not _is_gerencia(company):
        filters["usuario"] = frappe.session.user
    elif usuario:
        filters["usuario"] = usuario
    if from_date and to_date:
        filters["fecha"] = ["between", [from_date, to_date]]
    elif from_date:
        filters["fecha"] = [">=", from_date]
    elif to_date:
        filters["fecha"] = ["<=", to_date]
    if estado:
        filters["estado"] = estado
    return frappe.get_all(
        DOCTYPE,
        filters=filters,
        fields=["name", "fecha", "usuario", "usuario_nombre", "almacen", "estado", "num_facturas",
                "total_venta", "total_cobros", "total_egresos", "total_a_depositar", "al_credito",
                "cobro_efectivo", "cerrado_por", "cerrado_en", "reabierto_por", "reabierto_en", "modified"],
        order_by="fecha desc, usuario asc",
        limit_page_length=500,
    )


def _doc_to_dict(doc) -> dict:
    d = doc.as_dict()
    d["snapshot"] = json.loads(doc.snapshot_json) if doc.snapshot_json else None
    d["puede_reabrir"] = int(_is_gerencia(doc.company))
    d["puede_gestionar"] = int(
        _is_gerencia(doc.company) or (_can_create(doc.company) and doc.usuario == frappe.session.user)
    )
    for k in ("cerrado_en", "reabierto_en", "creation", "modified", "fecha"):
        if d.get(k) is not None:
            d[k] = str(d[k])
    for row in d.get("egresos") or []:
        for k in ("creation", "modified"):
            row.pop(k, None)
    return d


@frappe.whitelist()
def get_cierre(name: str) -> dict:
    doc = frappe.get_doc(DOCTYPE, name)
    _assert_can_view(doc)
    return _doc_to_dict(doc)


def _apply_snapshot(doc, snap: dict) -> None:
    for k in ("venta_sin_descuento", "venta_con_descuento", "flete_facturado", "ajuste_impuestos",
              "total_venta", "cobro_efectivo", "cobro_transferencia", "cobro_cheque", "cobro_tarjeta",
              "cobro_contra_entrega", "al_credito", "total_cobros", "abonos_anteriores", "num_facturas"):
        doc.set(k, snap.get(k) or 0)
    doc.set("detalle_familias", [])
    for r in snap["detalle_familias"]:
        doc.append("detalle_familias", {k: r.get(k) for k in (
            "es_oferta", "familia", "descripcion", "cantidad", "precio_unidad", "total",
            "cantidad_original", "uom", "conversion", "num_lineas")})
    doc.set("facturas", [])
    for r in snap["facturas"]:
        doc.append("facturas", r)
    doc.snapshot_json = json.dumps(snap, default=str, ensure_ascii=False)


def _load_or_new(payload: dict):
    company = get_effective_company(payload.get("company"))
    usuario = (payload.get("usuario") or frappe.session.user).strip()
    fecha = payload.get("fecha")
    if not fecha:
        frappe.throw(_("Indique la fecha del cierre."))
    fecha = getdate(fecha)
    if fecha > getdate(today()):
        frappe.throw(_("No se puede cerrar una fecha futura."))
    _assert_can_manage(company, usuario)

    name = (payload.get("name") or "").strip() or frappe.db.get_value(
        DOCTYPE, {"company": company, "fecha": fecha, "usuario": usuario}, "name"
    )
    if name:
        doc = frappe.get_doc(DOCTYPE, name)
        _assert_can_manage(doc.company, doc.usuario)
        if doc.estado == "Cerrado":
            frappe.throw(_("El cierre {0} ya está Cerrado. Gerencia debe reabrirlo para modificarlo.").format(doc.name))
        if (doc.company, getdate(doc.fecha), doc.usuario) != (company, fecha, usuario):
            frappe.throw(_("No se puede cambiar la compañía, fecha o usuario de un cierre existente."))
    else:
        doc = frappe.new_doc(DOCTYPE)
        doc.company = company
        doc.fecha = fecha
        doc.usuario = usuario
        doc.estado = "Borrador"
    return doc


def _apply_payload(doc, payload: dict) -> None:
    if "almacen" in payload:
        doc.almacen = (payload.get("almacen") or "").strip() or None
    if "flete_pagado_transportista" in payload:
        doc.flete_pagado_transportista = flt(payload.get("flete_pagado_transportista"))
    if "observaciones" in payload:
        doc.observaciones = payload.get("observaciones") or ""
    if "egresos" in payload:
        doc.set("egresos", [])
        for r in payload.get("egresos") or []:
            concepto = (r.get("concepto") or "").strip()
            if not concepto and not flt(r.get("monto")):
                continue
            doc.append("egresos", {
                "concepto": concepto or "Egreso",
                "monto": flt(r.get("monto")),
                "referencia": (r.get("referencia") or "").strip(),
                "observaciones": (r.get("observaciones") or "").strip(),
            })
    doc.usuario_nombre = frappe.db.get_value("User", doc.usuario, "full_name") or doc.usuario


def _parse(payload):
    if isinstance(payload, str):
        payload = json.loads(payload or "{}")
    return payload or {}


@frappe.whitelist()
def save_cierre(payload) -> dict:
    """Guarda (o crea) el cierre como Borrador/Reabierto con el snapshot
    recalculado al momento."""
    payload = _parse(payload)
    doc = _load_or_new(payload)
    _apply_payload(doc, payload)
    _apply_snapshot(doc, compute_snapshot(doc.company, doc.fecha, doc.usuario))
    doc.flags.facex_cierre_api = True
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return _doc_to_dict(doc)


@frappe.whitelist()
def cerrar_cierre(payload) -> dict:
    """Guarda y CIERRA el día: a partir de aquí las facturas y pagos de esa
    fecha para ese usuario quedan congelados."""
    payload = _parse(payload)
    doc = _load_or_new(payload)
    _apply_payload(doc, payload)
    _apply_snapshot(doc, compute_snapshot(doc.company, doc.fecha, doc.usuario))
    doc.estado = "Cerrado"
    doc.cerrado_por = frappe.session.user
    doc.cerrado_en = now_datetime()
    doc.flags.facex_cierre_api = True
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return _doc_to_dict(doc)


@frappe.whitelist()
def reabrir_cierre(name: str, motivo: str = None) -> dict:
    doc = frappe.get_doc(DOCTYPE, name)
    if not _is_gerencia(doc.company):
        frappe.throw(_("Solo un usuario con Rol (Clasificación) «Gerencia» puede reabrir un cierre."), frappe.PermissionError)
    if doc.estado != "Cerrado":
        frappe.throw(_("El cierre {0} no está Cerrado.").format(doc.name))
    motivo = (motivo or "").strip()
    if not motivo:
        frappe.throw(_("Indique el motivo de la reapertura."))
    doc.estado = "Reabierto"
    doc.reabierto_por = frappe.session.user
    doc.reabierto_en = now_datetime()
    doc.motivo_reapertura = motivo
    doc.flags.facex_cierre_api = True
    doc.save(ignore_permissions=True)
    frappe.db.commit()
    return _doc_to_dict(doc)


@frappe.whitelist()
def delete_cierre(name: str) -> dict:
    doc = frappe.get_doc(DOCTYPE, name)
    _assert_can_manage(doc.company, doc.usuario)
    if doc.estado == "Cerrado":
        frappe.throw(_("No se puede eliminar un cierre Cerrado. Reábralo primero."))
    doc.flags.facex_cierre_api = True
    doc.delete(ignore_permissions=True)
    frappe.db.commit()
    return {"success": True}
