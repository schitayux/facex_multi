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
  * puede_reclasificar_condicion → cambiar la condición de pago (plantilla)
    de una factura validada, NO certificada y con el día abierto
    (reclasificar_condicion). Sin tocar asientos: solo condición, vencimiento,
    cronograma y la marca de contra entrega.
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
    get_facex_can_reclassify_terms,
    get_facex_can_reopen_cierres,
    get_facex_can_supervise_cierres,
    get_user_can_supervise_cierres,
)

DOCTYPE = "FacEx Cierre Diario"

# Formas de pago de eFast Invoice Payment → campo del cierre
_METHOD_FIELD = {
    "Efectivo": "cobro_efectivo",
    "Transferencia": "cobro_transferencia",
    "Depósito": "cobro_transferencia",  # un depósito bancario se cuadra igual que una transferencia
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


def _company_on(company: str) -> bool:
    """Interruptor «Compañía maneja Cierre Diario» (config de la compañía).
    Apagado = la compañía ignora el módulo por completo (sin menú, sin
    congelamiento, sin pendientes), incluso para System Manager."""
    from facex_multi.api.permissions import get_facex_company_config
    return _installed() and bool(cint(get_facex_company_config(company).get("maneja_cierre_diario")))


def _is_gerencia(company: str) -> bool:
    """Supervisa el Cierre Diario: ve los cierres de todos y crea/cierra por
    otro usuario (FacEx Settings / Perfil > cierre_supervisar; antes, el Rol
    (Clasificación) «Gerencia»)."""
    return _company_on(company) and (_is_sysman() or get_facex_can_supervise_cierres(company))


def _can_reopen(company: str) -> bool:
    """Reabrir un cierre Cerrado (cierre_reabrir)."""
    return _company_on(company) and (_is_sysman() or get_facex_can_reopen_cierres(company))


def _can_reclassify(company: str) -> bool:
    """Cambiar la condición de pago de facturas validadas (puede_reclasificar_condicion)."""
    return _company_on(company) and (_is_sysman() or get_facex_can_reclassify_terms(company))


def _can_create(company: str) -> bool:
    return _company_on(company) and (_is_sysman() or get_facex_can_create_cierres(company))


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


def _corte_si(company: str, alias: str = "si") -> tuple:
    """Corte por inicio de operación para una consulta de Sales Invoice de este
    módulo. Devuelve ("1=1", {}) si no hay corte."""
    from facex_multi.api.corte import invoice_corte_sql

    cond, params = invoice_corte_sql(company, alias=alias)
    return (cond or "1=1"), params


def _corte_cierre_literal(user: str = None) -> str:
    """El corte por inicio de operación como SQL literal, para los hooks de
    permisos (que devuelven cadena, sin hueco para parámetros). En este doctype
    `owner` y `usuario` son el mismo usuario, así que el historial visible se
    reconoce por `usuario`."""
    from facex_multi.api.corte import get_corte

    conf = get_corte()
    if not conf["fecha"] or (user or frappe.session.user) in conf["sin_restriccion"]:
        return ""
    partes = [f"`tab{DOCTYPE}`.fecha >= {frappe.db.escape(str(conf['fecha']))}"]
    if conf["visibles"]:
        lista = ", ".join(frappe.db.escape(u) for u in conf["visibles"])
        partes.append(f"`tab{DOCTYPE}`.usuario IN ({lista})")
    return "(" + " OR ".join(partes) + ")"


def _cierre_visible_en_corte(doc, user: str = None) -> bool:
    from facex_multi.api.corte import get_corte

    conf = get_corte(getattr(doc, "company", None))
    if not conf["fecha"] or (user or frappe.session.user) in conf["sin_restriccion"]:
        return True
    if getattr(doc, "usuario", None) in conf["visibles"]:
        return True
    fecha = getattr(doc, "fecha", None)
    return bool(fecha) and getdate(fecha) >= conf["fecha"]


def cierre_query_conditions(user: str = None) -> str:
    """permission_query_conditions (vista Desk): Gerencia / System Manager ven
    todo; el resto solo los cierres de su propia caja. En ambos casos se aplica
    el corte por inicio de operación (los cierres de las pruebas previas al
    arranque no se listan)."""
    user = user or frappe.session.user
    corte = _corte_cierre_literal(user)
    partes = []
    if "System Manager" not in frappe.get_roles(user):
        company = get_effective_company()
        if not (company and get_user_can_supervise_cierres(user, company)):
            partes.append(f"`tab{DOCTYPE}`.usuario = {frappe.db.escape(user)}")
    if corte:
        partes.append(corte)
    return " AND ".join(partes)


def cierre_has_permission(doc, ptype: str = "read", user: str = None) -> bool:
    user = user or frappe.session.user
    if not _cierre_visible_en_corte(doc, user):
        return False
    if "System Manager" in frappe.get_roles(user):
        return True
    if doc.usuario == user:
        return True
    return get_user_can_supervise_cierres(user, doc.company)


# ---------------------------------------------------------------------------
# Congelamiento
# ---------------------------------------------------------------------------

def _closed_dates(company: str, owner: str) -> set:
    if not company or not owner or not _company_on(company):
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

def _clasificar_por_pagos(gt: float, payments: list, fecha, bfel_pago_contra_entrega, due_date) -> tuple:
    """Misma clasificación (Contra Entrega / Al Crédito / Contado) que usa el
    detalle de «Facturas incluidas», aplicada a una lista de pagos ya filtrada
    para UNA factura. La usan tanto las Devoluciones (facturas ANULADAS) como
    podría reutilizarla el loop principal. Devuelve (clasificacion, ce, credito)."""
    paid_non_ce = 0.0
    ce_rows = 0.0
    for p in payments:
        if p.payment_date and getdate(p.payment_date) > fecha:
            continue
        amt = flt(p.amount)
        if p.payment_method == CONTRA_ENTREGA:
            ce_rows += amt
        else:
            paid_non_ce += amt

    if cint(bfel_pago_contra_entrega):
        ce = max(gt - paid_non_ce, 0.0) if gt >= 0 else min(gt - paid_non_ce, 0.0)
    else:
        ce = ce_rows
    credito = gt - paid_non_ce - ce

    es_contra_entrega = bool(cint(bfel_pago_contra_entrega)) or ce_rows > 0.004
    dias_credito = max((getdate(due_date) - fecha).days, 0) if due_date else 0
    es_credito = (not es_contra_entrega) and credito > 0.004 and dias_credito > 0
    clasificacion = "contra_entrega" if es_contra_entrega else ("credito" if es_credito else "contado")
    return clasificacion, ce, credito


def _inv_total(inv) -> float:
    """Total a cobrar de la factura: el redondeado si ERPNext aplicó redondeo
    (es lo que muestra la factura y lo que se paga), si no el grand_total."""
    if not cint(inv.get("disable_rounded_total")) and flt(inv.get("rounded_total")):
        return flt(inv.rounded_total)
    return flt(inv.grand_total)


def _si_fields() -> list:
    meta = frappe.get_meta("Sales Invoice")
    fields = ["name", "customer", "customer_name", "posting_date", "due_date", "grand_total", "rounded_total",
              "disable_rounded_total", "total", "net_total", "discount_amount", "is_return", "outstanding_amount", "owner"]
    for f in ("bfel_status", "bfel_uuid", "bfel_pago_contra_entrega", "custom_pagado", "set_warehouse",
              "payment_terms_template"):
        if meta.has_field(f):
            fields.append(f)
    return fields


def compute_snapshot(company: str, fecha, usuario: str) -> dict:
    """Calcula el resumen del día para (company, fecha, usuario). Puro: no
    escribe nada. Devuelve un dict serializable listo para el page y para
    volcarse en el documento."""
    fecha = getdate(fecha)
    # Corte por inicio de operación: un día anterior al arranque ya no se
    # calcula ni se cierra — sus facturas dejaron de ser consultables.
    from facex_multi.api.corte import get_corte_fecha
    corte = get_corte_fecha(company)
    if corte and fecha < corte:
        frappe.throw(
            _("El {0} es anterior al inicio de operación ({1}): ese día ya no se puede cerrar.").format(
                formatdate(fecha), formatdate(corte)
            ),
            frappe.PermissionError,
        )
    flete_item = (get_facex_company_config(company).get("item_flete") or "").strip()
    # Unidad de fracción (Media Docena) aunque hoy esté apagada: las facturas
    # del día pudieron grabarse con ella.
    frac_uom = (
        frappe.db.get_value("FacEx Configuracion Compania", company, "fraccion_uom")
        if frappe.db.table_exists("FacEx Configuracion Compania")
        and frappe.get_meta("FacEx Configuracion Compania").has_field("fraccion_uom") else None
    ) or ""

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
    venta_sin_desc = venta_con_desc = flete_fact = recargo_fact = 0.0
    recargo_pasarela = flete_pasarela = cargos_venta = 0.0
    inv_flete = Counter()
    inv_recargo = Counter()
    inv_pasarela = Counter()
    # Flete y Recargo Contra Entrega como filas de cargos del documento (ver
    # facex_multi.api.recargo). Las facturas viejas siguen trayendo el flete
    # como línea del Ítem de Flete: ambas fuentes se suman.
    #
    # Cada cargo tiene un MODO congelado en la factura: «pasarela» (el cliente lo
    # paga por el servicio de entrega y el transportista lo descuenta en su
    # liquidación — no es ingreso de la empresa) o «parte de la venta». El cierre
    # los presenta en bloques separados para no confundir el ingreso del día con
    # dinero que solo pasa por la caja.
    from facex_multi.api.recargo import cargos_facex_por_factura
    for inv_name, c in cargos_facex_por_factura(names).items():
        if c.get("flete"):
            flete_fact += flt(c["flete"])
            inv_flete[inv_name] += flt(c["flete"])
        if c.get("recargo"):
            recargo_fact += flt(c["recargo"])
            inv_recargo[inv_name] += flt(c["recargo"])
        if c.get("pasarela"):
            inv_pasarela[inv_name] += flt(c["pasarela"])
        recargo_pasarela += flt(c.get("recargo_pasarela") or 0.0)
        flete_pasarela += flt(c.get("flete_pasarela") or 0.0)
        cargos_venta += flt(c.get("venta") or 0.0)
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
        has_disc = (
            flt(it.discount_percentage) > 0 or flt(it.discount_amount) > 0
            or "OFERTA" in (it.item_code or "").upper()
        )
        if is_flete:
            # Flete de las facturas VIEJAS, cuando era una línea de producto: fue
            # contabilizado como ingreso, así que cuenta como venta (nunca fue
            # pasarela) y se suma a `cargos_venta` para que no caiga en el ajuste.
            flete_fact += amount
            cargos_venta += amount
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
        stock_qty = flt(it.stock_qty) if it.stock_qty is not None else flt(it.qty) * (flt(it.conversion_factor) or 1)
        if frac_uom and it.uom == frac_uom:
            # Entero/Fracción: la Media Docena se presenta en la unidad base
            # (igual que cuando se registraba 0.5 Docena) para no mezclar
            # unidades en la «cantidad original» ni volver la familia «Varias».
            g["cantidad_original"] += stock_qty
            g["uoms"].add(it.stock_uom or "")
            g["conversions"].add(1.0)
            g["fracciones"] = g.get("fracciones", 0.0) + flt(it.qty)
        else:
            g["cantidad_original"] += flt(it.qty)
            g["uoms"].add(it.uom or it.stock_uom or "")
            g["conversions"].add(round(flt(it.conversion_factor) or 1, 6))
        g["cantidad"] += stock_qty
        g["total"] += amount
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
    contado_pendiente = 0.0
    facturas = []
    total_venta = 0.0
    cargos_pasarela = 0.0
    # Parte de los cargos de terceros que entró en EFECTIVO a la caja (y que por
    # tanto va dentro del depósito del día, aunque no sea venta). Se atribuye en
    # proporción a lo que se pagó en efectivo sobre el total del documento.
    pasarela_en_efectivo = 0.0
    sum_lineas = venta_sin_desc + venta_con_desc + cargos_venta

    for inv in invoices:
        gt = _inv_total(inv)
        total_venta += gt
        pas_inv = flt(inv_pasarela.get(inv.name, 0.0))
        cargos_pasarela += pas_inv
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

        # Clasificación para los cuadros de "Facturas incluidas": Contra Entrega
        # (bandera de la factura o pago con esa forma), Al Crédito (saldo
        # pendiente Y la factura tiene días de crédito según su plazo de pago),
        # o Contado (todo lo demás). Una "Contado" con saldo pendiente es una
        # anomalía: se marca con alerta para que se ingrese el pago real.
        es_contra_entrega = bool(cint(inv.get("bfel_pago_contra_entrega"))) or ce_rows > 0.004
        dias_credito = max((getdate(inv.due_date) - fecha).days, 0) if inv.get("due_date") else 0
        es_credito = (not es_contra_entrega) and credito > 0.004 and dias_credito > 0
        alerta_contado = (not es_contra_entrega) and (not es_credito) and credito > 0.004
        clasificacion = "contra_entrega" if es_contra_entrega else ("credito" if es_credito else "contado")

        # El saldo pendiente de una venta de Contado NO es Crédito (nunca tuvo
        # días de crédito): se cuadra aparte para no inflar "Al Crédito".
        if clasificacion == "credito":
            cobros["al_credito"] += credito
        elif clasificacion == "contado":
            contado_pendiente += credito

        # Cargos de terceros cobrados en efectivo: están físicamente en la caja y
        # se depositan igual (el arqueo debe cuadrar con el efectivo real), pero
        # el cierre los identifica como «por rendir al transportista».
        if pas_inv and gt:
            pasarela_en_efectivo += pas_inv * min(flt(by_method.get("Efectivo")), gt) / gt

        formas = ", ".join(f"{m} {flt(a):,.2f}" for m, a in by_method.items())
        if ce:
            formas = (formas + ", " if formas else "") + f"{CONTRA_ENTREGA} {ce:,.2f}"
        if abs(credito) > 0.004:
            # El texto debe reflejar la misma clasificación que los cuadros:
            # solo se llama "Crédito" cuando la factura de verdad tiene días de
            # crédito; si no, es un saldo pendiente de una venta de contado.
            saldo_label = "Crédito" if es_credito else "Pendiente"
            formas = (formas + ", " if formas else "") + f"{saldo_label} {credito:,.2f}"

        facturas.append({
            "sales_invoice": inv.name,
            "customer_name": inv.customer_name or inv.customer,
            "grand_total": gt,
            "pagado": paid_non_ce,
            "contra_entrega": ce,
            "credito": credito,
            "flete": inv_flete.get(inv.name, 0.0),
            "recargo": inv_recargo.get(inv.name, 0.0),
            "cargos_pasarela": pas_inv,
            "venta_neta": round(gt - pas_inv, 2),
            "formas_pago": formas,
            "tiene_descuento": 1 if inv.name in inv_has_desc else 0,
            "es_devolucion": cint(inv.get("is_return")),
            "bfel_status": inv.get("bfel_status") or "",
            "clasificacion": clasificacion,
            "dias_credito": dias_credito,
            "alerta_contado": 1 if alerta_contado else 0,
            "condicion": inv.get("payment_terms_template") or "",
            "certificada": 1 if _is_certified(inv) else 0,
        })

    # Tres cifras distintas, que antes venían mezcladas en una sola:
    #   venta_neta_dia  — INGRESO de la empresa (lo que debe cuadrar con todos
    #                     los informes de venta y con la cuenta de ingresos).
    #   cargos_pasarela — dinero de terceros que el cliente paga por el servicio
    #                     de entrega; el transportista lo descuenta al liquidar.
    #   total_venta     — TOTAL FACTURADO: la suma de las dos, o sea lo que el
    #                     cliente pagó. Es la base de la cobranza.
    venta_neta_dia = total_venta - cargos_pasarela
    ajuste = venta_neta_dia - sum_lineas
    total_cobros = sum(cobros.values()) + cobro_otros + contado_pendiente

    recup = _recuperacion_cartera(company, fecha, usuario)

    # ---- Devoluciones (facturas ANULADAS de este usuario) ---------------------
    # Dos casos según la fecha ORIGINAL de la factura (posting_date), ambos
    # detectados por "se anuló hoy" (proxy: `modified` cae en `fecha`, ya que
    # Sales Invoice no tiene un campo nativo de fecha de anulación):
    #   * posting_date != fecha → una venta de OTRO día que se anuló hoy: sí
    #     tuvo impacto real en la caja de hoy (reembolso), así que se resta del
    #     Total Venta del Día y se clasifica en el KPI "Devoluciones".
    #   * posting_date == fecha → se facturó y se anuló el mismo día: nunca
    #     llegó a contar en el total (solo se leen docstatus=1), se lista aparte
    #     únicamente para trazabilidad ("Devoluciones - Detalle").
    devoluciones = []
    devoluciones_hoy = []
    total_devoluciones = 0.0
    dev_clasif = {"contado": 0.0, "contra_entrega": 0.0, "credito": 0.0}

    cancel_fields = ["name", "customer", "customer_name", "posting_date", "due_date", "grand_total",
                     "rounded_total", "disable_rounded_total"]
    if frappe.get_meta("Sales Invoice").has_field("bfel_pago_contra_entrega"):
        cancel_fields.append("bfel_pago_contra_entrega")

    cancelados = frappe.get_all(
        "Sales Invoice",
        filters=[
            ["company", "=", company], ["owner", "=", usuario], ["docstatus", "=", 2],
            ["modified", ">=", fecha], ["modified", "<", add_days(fecha, 1)],
        ],
        fields=cancel_fields,
        order_by="name asc",
    )
    if cancelados:
        cnames = [c.name for c in cancelados]
        cpay_by_inv = {}
        if frappe.db.table_exists("eFast Invoice Payment"):
            for p in frappe.get_all(
                "eFast Invoice Payment",
                filters={"parent": ["in", cnames], "parenttype": "Sales Invoice"},
                fields=["parent", "payment_method", "payment_date", "reference", "amount"],
                order_by="parent asc, idx asc",
            ):
                cpay_by_inv.setdefault(p.parent, []).append(p)

        for c in cancelados:
            gt = _inv_total(c)
            clasificacion, ce, credito = _clasificar_por_pagos(
                gt, cpay_by_inv.get(c.name, []), fecha, c.get("bfel_pago_contra_entrega"), c.get("due_date"),
            )
            row = {
                "sales_invoice": c.name,
                "customer_name": c.customer_name or c.customer,
                "grand_total": gt,
                "posting_date": str(c.posting_date),
                "clasificacion": clasificacion,
            }
            if getdate(c.posting_date) == fecha:
                devoluciones_hoy.append(row)
            else:
                devoluciones.append(row)
                total_devoluciones += gt
                dev_clasif[clasificacion] = dev_clasif.get(clasificacion, 0.0) + gt

    return {
        "company": company,
        "fecha": str(fecha),
        "usuario": usuario,
        "flete_item": flete_item,
        "num_facturas": len(invoices),
        "venta_sin_descuento": round(venta_sin_desc, 2),
        "venta_con_descuento": round(venta_con_desc, 2),
        "flete_facturado": round(flete_fact, 2),
        "recargo_facturado": round(recargo_fact, 2),
        "ajuste_impuestos": round(ajuste, 2),
        # Bloque 1 — VENTA (ingreso propio) y bloque 2 — CARGOS DE TERCEROS.
        "venta_neta": round(venta_neta_dia, 2),
        "cargos_venta": round(cargos_venta, 2),
        "cargos_pasarela": round(cargos_pasarela, 2),
        "recargo_pasarela": round(recargo_pasarela, 2),
        "flete_pasarela": round(flete_pasarela, 2),
        # Total facturado = venta neta + cargos de terceros (lo que pagó el
        # cliente). Se conserva el nombre `total_venta` por compatibilidad con
        # los cierres ya guardados.
        "total_venta": round(total_venta, 2),
        "cobro_efectivo": round(cobros["cobro_efectivo"], 2),
        "cobro_transferencia": round(cobros["cobro_transferencia"], 2),
        "cobro_cheque": round(cobros["cobro_cheque"], 2),
        "cobro_tarjeta": round(cobros["cobro_tarjeta"], 2),
        "cobro_contra_entrega": round(cobros["cobro_contra_entrega"], 2),
        "contado_pendiente": round(contado_pendiente, 2),
        "al_credito": round(cobros["al_credito"], 2),
        "cobro_otros": round(cobro_otros, 2),
        "total_cobros": round(total_cobros, 2),
        **recup,
        # Parte del depósito del día que son cargos de terceros: el efectivo está
        # en la caja y se deposita completo (si no, el arqueo nunca cuadraría),
        # pero hay que rendirlo al transportista. Es informativo: NO se resta del
        # Total a Depositar.
        "deposito_cargos_terceros": round(
            pasarela_en_efectivo + flt(recup.get("recuperado_pasarela_efectivo")), 2),
        "total_devoluciones": round(total_devoluciones, 2),
        "devoluciones_contado": round(dev_clasif["contado"], 2),
        "devoluciones_contra_entrega": round(dev_clasif["contra_entrega"], 2),
        "devoluciones_credito": round(dev_clasif["credito"], 2),
        "devoluciones": devoluciones,
        "devoluciones_hoy": devoluciones_hoy,
        "detalle_familias": familias,
        "facturas": facturas,
    }


_RECUP_TIPOS = OrderedDict([
    ("credito", "Recuperación de Crédito"),
    ("cod", "Cobros de Contra Entrega (COD)"),
    ("contado", "Saldos de Contado"),
])


def _recuperacion_cartera(company: str, fecha, usuario: str) -> dict:
    """Pagos con fecha `fecha` aplicados a facturas de días ANTERIORES del
    usuario: dinero que entra hoy pero no es venta de hoy. Se presenta aparte
    del cuadre de la venta del día para no mezclarlo con ella.

    Tipo de la factura:
      * cod     → factura Contra Entrega (bandera o filas «Contra Entrega»);
                  la forma se reetiqueta «<forma> COD» (p.ej. «Transferencia
                  COD», «Depósito COD») para no confundirla con cobros de hoy.
      * credito → la factura tenía días de crédito (vencimiento > emisión).
      * contado → pago tardío de una venta de contado.
    Estado: «Liquidada» si con este pago la factura quedó sin saldo, si no
    «Abono» con el saldo que resta."""
    empty = {
        "abonos_anteriores": 0.0, "recuperado_efectivo": 0.0, "abonos_detalle": [],
        "recuperado_por_tipo": {k: 0.0 for k in _RECUP_TIPOS}, "recuperado_por_forma": {},
        "recuperado_facturas": 0, "recuperado_liquidadas": 0,
        "recuperado_pasarela": 0.0, "recuperado_venta": 0.0,
        "recuperado_pasarela_efectivo": 0.0,
        "recuperado_neto": 0.0, "cod_comision": 0.0, "cod_flete": 0.0,
        "cod_neto": 0.0, "cod_proyectado_recargo": 0.0, "cod_ejecutado_recargo": 0.0,
        "cod_diferencia": 0.0, "cod_facturas": 0,
    }
    if not frappe.db.table_exists("eFast Invoice Payment"):
        return empty
    meta = frappe.get_meta("Sales Invoice")
    ce_col = "si.bfel_pago_contra_entrega" if meta.has_field("bfel_pago_contra_entrega") else "0"
    corte_cond, corte_vals = _corte_si(company)
    rows = frappe.db.sql(
        f"""
        SELECT p.parent AS sales_invoice, si.customer_name, si.posting_date, si.due_date,
               si.grand_total, si.rounded_total, si.disable_rounded_total,
               {ce_col} AS bfel_pago_contra_entrega,
               p.payment_method, p.reference, p.amount
        FROM `tabeFast Invoice Payment` p
        JOIN `tabSales Invoice` si ON si.name = p.parent
        WHERE si.company = %(company)s AND si.owner = %(usuario)s AND si.docstatus = 1
          AND si.posting_date < %(fecha)s AND p.payment_date = %(fecha)s
          AND p.parenttype = 'Sales Invoice' AND p.payment_method != %(ce)s
          AND {corte_cond}
        ORDER BY si.posting_date, p.parent, p.idx
        """,
        {"company": company, "usuario": usuario, "fecha": fecha, "ce": CONTRA_ENTREGA,
         **corte_vals},
        as_dict=True,
    )
    if not rows:
        return empty

    names = sorted({r.sales_invoice for r in rows})
    pagado = Counter()
    tiene_ce = set()
    for p in frappe.get_all(
        "eFast Invoice Payment",
        filters={"parent": ["in", names], "parenttype": "Sales Invoice"},
        fields=["parent", "payment_method", "payment_date", "amount"],
    ):
        if p.payment_method == CONTRA_ENTREGA:
            tiene_ce.add(p.parent)
        elif not p.payment_date or getdate(p.payment_date) <= fecha:
            pagado[p.parent] += flt(p.amount)

    # Datos de la liquidación de transporte para los cobros COD. El pago que se
    # registra en la factura es el COD COMPLETO, pero a la empresa solo le entró
    # `monto_liquidado`: el transportista retuvo su comisión antes de depositar.
    # Se enlaza por (factura, guía) — la fila de pago guarda el número de guía en
    # `reference`, ver api.invoice._sync_pago_facex.
    liq_rows = {}
    if frappe.db.table_exists("FacEx Liquidacion Transportista Detalle"):
        from facex_multi.api.invoice import _norm_numero_guia
        for d in frappe.db.sql(
            """
            SELECT d.sales_invoice, d.guia, d.monto_cod, d.valor_comision, d.monto_liquidado
            FROM `tabFacEx Liquidacion Transportista Detalle` d
            WHERE d.parenttype = 'FacEx Liquidacion Transportista'
              AND d.match_encontrado = 1 AND d.sales_invoice IN %(names)s
            """,
            {"names": tuple(names)},
            as_dict=True,
        ):
            liq_rows[(d.sales_invoice, _norm_numero_guia(d.guia))] = d
            # Respaldo por factura, por si la referencia del pago no trae la guía.
            liq_rows.setdefault((d.sales_invoice, None), d)

    def _liquidacion_de(sales_invoice, reference):
        from facex_multi.api.invoice import _norm_numero_guia
        return (liq_rows.get((sales_invoice, _norm_numero_guia(reference or "")))
                or liq_rows.get((sales_invoice, None)))

    # Un cobro de una factura Contra Entrega anterior recupera a la vez venta y
    # cargos de terceros (el cliente pagó todo junto al repartidor). Se parte en
    # proporción al total del documento para que la tarjeta de recuperación no
    # presente como ingreso dinero que hay que rendirle al transportista.
    from facex_multi.api.recargo import pasarela_por_factura, recargo_estimado_por_factura
    pasarela_inv = pasarela_por_factura(names)
    # Para el Análisis COD interesa lo que se le COBRÓ AL CLIENTE, que en las
    # facturas anteriores al 2026-09-21 iba embebido en el precio y no como fila
    # de cargo; `recargo_estimado_por_factura` lo reconstruye.
    cargos_inv = recargo_estimado_por_factura(names)

    por_tipo = {k: 0.0 for k in _RECUP_TIPOS}
    por_forma = OrderedDict()
    efectivo = 0.0
    pasarela_total = 0.0
    pasarela_efectivo = 0.0
    neto_total = 0.0
    cod_comision = cod_flete = cod_neto = 0.0
    cod_proyectado = cod_ejecutado = 0.0
    cod_facturas = set()
    liquidadas = set()
    for r in rows:
        amt = flt(r.amount)
        metodo = r.payment_method or "Efectivo"
        cobrable_inv = _inv_total(r)
        pas_pago = (
            flt(pasarela_inv.get(r.sales_invoice, 0.0)) * amt / cobrable_inv
            if cobrable_inv else 0.0
        )
        pasarela_total += pas_pago
        if metodo == "Efectivo":
            pasarela_efectivo += pas_pago
        if cint(r.bfel_pago_contra_entrega) or r.sales_invoice in tiene_ce:
            tipo, forma = "cod", f"{metodo} COD"
        elif r.due_date and getdate(r.due_date) > getdate(r.posting_date):
            tipo, forma = "credito", metodo
        else:
            tipo, forma = "contado", metodo
        saldo = _inv_total(r) - pagado[r.sales_invoice]

        # Lo que de verdad entró. En un cobro COD el pago registrado es el COD
        # completo, pero el transportista ya retuvo su comisión: lo que llegó es
        # `monto_liquidado`. Si el pago no cubre toda la guía se prorratea.
        liq = _liquidacion_de(r.sales_invoice, r.get("reference")) if tipo == "cod" else None
        comision = flete_liq = 0.0
        neto = amt
        if liq:
            cod_total = flt(liq.monto_cod) or cobrable_inv
            factor = min(amt / cod_total, 1.0) if cod_total else 1.0
            comision = flt(liq.valor_comision) * factor
            # El monto liquidado de la fila ya es COD − comisión; se recalcula
            # con el factor para que un abono parcial sea coherente.
            neto = flt(liq.monto_liquidado) * factor if flt(liq.monto_liquidado) else amt - comision
            c = cargos_inv.get(r.sales_invoice) or {}
            flete_liq = flt(c.get("flete")) * factor
            cod_comision += comision
            cod_flete += flete_liq
            cod_neto += neto - flete_liq
            cod_proyectado += flt(c.get("recargo")) * factor
            cod_ejecutado += comision
            cod_facturas.add(r.sales_invoice)
        neto_total += neto

        r.update({
            "posting_date": str(r.posting_date),
            "tipo": tipo,
            "tipo_label": _RECUP_TIPOS[tipo],
            "forma": forma,
            "saldo_restante": round(max(saldo, 0.0), 2),
            "estado": "Liquidada" if saldo <= 0.004 else "Abono",
            "dias": (fecha - getdate(r.posting_date)).days,
            "cargos_pasarela": round(pas_pago, 2),
            "venta_neta": round(amt - pas_pago, 2),
            # Cifras de la liquidación (0 cuando el cobro no viene de una).
            "valor_comision": round(comision, 2),
            "flete_liquidado": round(flete_liq, 2),
            "monto_neto": round(neto, 2),
        })
        for k in ("due_date", "grand_total", "rounded_total", "disable_rounded_total", "bfel_pago_contra_entrega"):
            r.pop(k, None)
        por_tipo[tipo] += amt
        # Por forma de pago se muestra lo que ENTRÓ (neto de comisión): es el
        # dinero que la empresa puede cuadrar contra el banco.
        por_forma[forma] = por_forma.get(forma, 0.0) + neto
        if metodo == "Efectivo":
            efectivo += amt
        if saldo <= 0.004:
            liquidadas.add(r.sales_invoice)

    recuperado = sum(por_tipo.values())
    return {
        "abonos_anteriores": round(recuperado, 2),
        "recuperado_efectivo": round(efectivo, 2),
        "abonos_detalle": rows,
        "recuperado_por_tipo": {k: round(v, 2) for k, v in por_tipo.items()},
        "recuperado_por_forma": {k: round(v, 2) for k, v in por_forma.items()},
        "recuperado_facturas": len(names),
        "recuperado_liquidadas": len(liquidadas),
        # De lo recuperado, cuánto es venta de la empresa y cuánto cargo de
        # terceros (ver el comentario del prorrateo más arriba).
        "recuperado_pasarela": round(pasarela_total, 2),
        "recuperado_venta": round(recuperado - pasarela_total, 2),
        "recuperado_pasarela_efectivo": round(pasarela_efectivo, 2),
        # Recuperado NETO: lo que de verdad entró. En los cobros COD el pago
        # registrado es el COD completo, pero el transportista ya había retenido
        # su comisión. = factura − comisión.
        "recuperado_neto": round(neto_total, 2),
        # Análisis COD de las guías liquidadas que se cobraron hoy.
        "cod_comision": round(cod_comision, 2),
        "cod_flete": round(cod_flete, 2),
        "cod_neto": round(cod_neto, 2),
        "cod_proyectado_recargo": round(cod_proyectado, 2),
        "cod_ejecutado_recargo": round(cod_ejecutado, 2),
        "cod_diferencia": round(cod_proyectado - cod_ejecutado, 2),
        "cod_facturas": len(cod_facturas),
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
    if not company or not _company_on(company):
        return []
    desde = add_days(today(), -PENDING_LOOKBACK_DAYS)
    cond = ""
    corte_cond, corte_vals = _corte_si(company)
    vals = {"company": company, "desde": desde, "hoy": today(), **corte_vals}
    if usuario:
        cond = "AND si.owner = %(usuario)s"
        vals["usuario"] = usuario
    rows = frappe.db.sql(
        f"""
        SELECT si.posting_date AS fecha, si.owner AS usuario, u.full_name AS usuario_nombre,
               COUNT(*) AS num_facturas, SUM(IF(IFNULL(si.disable_rounded_total, 0) = 0 AND IFNULL(si.rounded_total, 0) != 0,
                       si.rounded_total, si.grand_total)) AS total_venta,
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
          AND {corte_cond}
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
# Control al crear facturas (fecha en día cerrado / cierres pendientes)
# ---------------------------------------------------------------------------

def _gate_cfg(company: str) -> tuple:
    from facex_multi.api.permissions import get_facex_company_config
    cfg = get_facex_company_config(company)
    modo = cfg.get("cierre_pendiente_modo") or "Avisar"
    return modo, max(0, cint(cfg.get("cierre_pendiente_dias_gracia")))


def _overdue_pending(company: str, usuario: str, gracia: int) -> list:
    """Días pendientes del usuario que ya pasaron la tolerancia: se puede
    facturar hoy con hasta `gracia` días atrás sin cerrar."""
    limite = add_days(today(), -gracia)
    return [r for r in _pending_days(company, usuario) if getdate(r["fecha"]) < getdate(limite)]


def guard_sales_invoice_closed_date(doc, method=None):
    """Hook Sales Invoice.validate — (1) no se puede fechar una factura en un
    día que el dueño ya cerró; (2) si la compañía lo exige, un usuario con
    cierres vencidos no puede crear facturas nuevas hasta cerrarlos."""
    if doc.flags.facex_cierre_bypass or frappe.flags.in_import or frappe.flags.in_patch:
        return
    if doc.docstatus == 2 or not doc.company or not doc.posting_date or not _company_on(doc.company):
        return
    if getdate(doc.posting_date) in _closed_dates(doc.company, doc.owner or frappe.session.user):
        frappe.throw(_frozen_msg(doc.company, doc.owner or frappe.session.user, doc.posting_date),
                     title=_("Cierre Diario"))

    if not doc.is_new():
        return
    user = frappe.session.user
    if user == "Administrator" or _is_gerencia(doc.company) or not _can_create(doc.company):
        return
    modo, gracia = _gate_cfg(doc.company)
    if modo != "Bloquear":
        return
    vencidos = _overdue_pending(doc.company, user, gracia)
    if vencidos:
        fechas = ", ".join(formatdate(r["fecha"]) for r in vencidos[:5])
        frappe.throw(
            _("Tiene {0} día(s) con ventas sin cerrar ({1}). Realice su Cierre Diario antes de crear "
              "facturas nuevas.").format(len(vencidos), fechas) + " " +
            _("Si no puede cerrarlos, pida a Gerencia que lo haga."),
            title=_("Cierre Diario pendiente"),
        )


@frappe.whitelist()
def get_work_gate(company: str = None) -> dict:
    """Estado para Clásico: ¿hay que cerrar antes de trabajar? y días ya
    cerrados (para avisar al elegir fecha). No lanza error."""
    company = get_effective_company(company)
    out = {"modo": "No exigir", "bloquea": 0, "pendientes": [], "cerrados": []}
    if not _company_on(company) or not _can_create(company) or _is_gerencia(company):
        return out
    user = frappe.session.user
    modo, gracia = _gate_cfg(company)
    out["modo"] = modo
    out["cerrados"] = sorted(str(d) for d in _closed_dates(company, user))
    if modo == "No exigir":
        return out
    vencidos = _overdue_pending(company, user, gracia)
    out["pendientes"] = [{"fecha": r["fecha"], "num_facturas": r["num_facturas"]} for r in vencidos]
    out["bloquea"] = int(modo == "Bloquear" and bool(vencidos))
    return out


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
        # Subconsulta sin alias de tabla: el corte va con columnas sin calificar.
        corte_cond, corte_vals = _corte_si(company, alias=None)
        # Usuarios con ventas en la compañía + usuarios con FacEx Settings en ella
        users = frappe.db.sql(
            f"""
            SELECT DISTINCT x.name, u.full_name FROM (
                SELECT owner AS name FROM `tabSales Invoice`
                 WHERE company = %(c)s AND docstatus = 1 AND {corte_cond}
                UNION
                SELECT user AS name FROM `tabFacEx Settings` WHERE bfel_company = %(c)s AND IFNULL(user, '') != ''
            ) x JOIN `tabUser` u ON u.name = x.name
            WHERE u.enabled = 1
            ORDER BY u.full_name
            """,
            {"c": company, **corte_vals},
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
        "puede_reclasificar": int(_can_reclassify(company)),
        "condiciones": _terms_options() if _can_reclassify(company) else [],
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
    # `get_all` ignora los hooks de permisos (cierre_query_conditions), así que
    # el corte por inicio de operación va explícito en los filtros.
    from facex_multi.api.corte import get_corte
    conf = get_corte(company)
    or_filters = None
    if conf["fecha"] and frappe.session.user not in conf["sin_restriccion"]:
        or_filters = [["fecha", ">=", conf["fecha"]]]
        if conf["visibles"]:
            or_filters.append(["usuario", "in", list(conf["visibles"])])
    return frappe.get_all(
        DOCTYPE,
        filters=filters,
        or_filters=or_filters,
        fields=["name", "fecha", "usuario", "usuario_nombre", "almacen", "estado", "num_facturas",
                "total_venta", "venta_neta", "cargos_pasarela",
                "total_cobros", "total_egresos", "total_a_depositar", "al_credito",
                "cobro_efectivo", "cerrado_por", "cerrado_en", "reabierto_por", "reabierto_en", "modified"],
        order_by="fecha desc, usuario asc",
        limit_page_length=500,
    )


def upgrade_snapshot(snap: dict) -> dict:
    """Completa un snapshot guardado ANTES del rediseño de cargos (2026-09-30).

    Esos snapshots no traen `venta_neta` ni el desglose de cargos de terceros, así
    que el bloque «CARGOS POR CUENTA DE TERCEROS» salía en cero y parecía roto.

    La reconstrucción es fiel: antes del rediseño TODO cargo de recargo/flete era
    pasarela (se contabilizaba contra cuentas de pasivo; el campo que marca el
    modo no existía y su ausencia significa pasarela). Así que el recargo y el
    flete facturados del snapshot SON los cargos de terceros.

    No toca `total_a_depositar` ni ninguna cifra ya congelada: solo deriva las
    que faltaban. Si el snapshot ya es nuevo, lo devuelve intacto.
    """
    if not snap or "cargos_pasarela" in snap:
        return snap
    recargo = flt(snap.get("recargo_facturado"))
    flete = flt(snap.get("flete_facturado"))
    pasarela = recargo + flete
    snap["recargo_pasarela"] = round(recargo, 2)
    snap["flete_pasarela"] = round(flete, 2)
    snap["cargos_pasarela"] = round(pasarela, 2)
    snap["cargos_venta"] = 0.0
    snap["venta_neta"] = round(flt(snap.get("total_venta")) - pasarela, 2)
    # No se puede saber cuánto de esos cargos entró en efectivo (el snapshot
    # viejo no guarda el desglose por forma de pago por factura), así que el
    # renglón del depósito se omite en vez de inventarlo.
    snap.setdefault("deposito_cargos_terceros", 0.0)
    snap["snapshot_reconstruido"] = 1
    return snap


def _doc_to_dict(doc) -> dict:
    d = doc.as_dict()
    d["snapshot"] = upgrade_snapshot(
        json.loads(doc.snapshot_json)) if doc.snapshot_json else None
    d["puede_reabrir"] = int(_can_reopen(doc.company))
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
    for k in ("venta_sin_descuento", "venta_con_descuento", "flete_facturado", "recargo_facturado", "ajuste_impuestos",
              "venta_neta", "cargos_pasarela", "recargo_pasarela", "flete_pasarela",
              "deposito_cargos_terceros",
              "total_venta", "cobro_efectivo", "cobro_transferencia", "cobro_cheque", "cobro_tarjeta",
              "cobro_contra_entrega", "contado_pendiente", "al_credito", "total_cobros", "abonos_anteriores", "num_facturas"):
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


def _assert_contado_pagado(snap: dict) -> None:
    """No se puede cerrar el día mientras haya facturas clasificadas como
    Contado con saldo pendiente (alerta_contado): se vendieron de contado
    pero les falta registrar el pago real. Es el mismo criterio que pinta la
    alerta en el cuadro "Facturas incluidas" del page — aquí se hace valer
    también server-side, no solo deshabilitando el botón en el front."""
    pendientes = [f for f in snap["facturas"] if f.get("alerta_contado")]
    if not pendientes:
        return
    nombres = ", ".join(f["sales_invoice"] for f in pendientes)
    frappe.throw(
        _(
            "No se puede cerrar el día: {0} factura(s) de Contado sin el pago real registrado (100% pendiente): {1}. "
            "Ingrese el pago en el facturador clásico antes de cerrar."
        ).format(len(pendientes), nombres)
    )


@frappe.whitelist()
def cerrar_cierre(payload) -> dict:
    """Guarda y CIERRA el día: a partir de aquí las facturas y pagos de esa
    fecha para ese usuario quedan congelados."""
    payload = _parse(payload)
    doc = _load_or_new(payload)
    _apply_payload(doc, payload)
    snap = compute_snapshot(doc.company, doc.fecha, doc.usuario)
    _assert_contado_pagado(snap)
    _apply_snapshot(doc, snap)
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
    if not _can_reopen(doc.company):
        frappe.throw(_("No tiene el permiso «Reabrir cierres» (FacEx Settings)."), frappe.PermissionError)
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


# ---------------------------------------------------------------------------
# Reclasificar la condición de pago de una factura validada
# ---------------------------------------------------------------------------
# El usuario se equivocó de condición (Contado / Crédito N días / Contra
# Entrega). ERPNext no permite editar payment_terms_template, due_date ni
# payment_schedule después de validar, y cancelar/rehacer cambia el número.
# Como contado y crédito usan la misma cuenta por cobrar y el mismo monto, NO
# hay asientos que corregir: se reescriben la condición, el vencimiento (en la
# factura, GL Entry y Payment Ledger Entry para antigüedad de saldos), el
# cronograma y bfel_pago_contra_entrega. Queda Version + comentario en la
# factura. Facturas certificadas: bloqueo total (FACT vs FCAM ante SAT).

def _is_certified(inv) -> bool:
    return bool(inv.get("bfel_uuid")) or inv.get("bfel_status") == "02 Procesada"


def _terms_options() -> list:
    meta = frappe.get_meta("Payment Terms Template")
    fields = ["name"]
    if meta.has_field("custom_es_contra_entrega"):
        fields.append("custom_es_contra_entrega")
    filters = {"disabled": 0} if meta.has_field("disabled") else {}
    out = []
    for t in frappe.get_all("Payment Terms Template", filters=filters, fields=fields, order_by="name"):
        dias = max(
            [cint(d.credit_days) + 30 * cint(d.credit_months) for d in frappe.get_all(
                "Payment Terms Template Detail", filters={"parent": t.name},
                fields=["credit_days", "credit_months"],
            )] or [0]
        )
        cod = cint(t.get("custom_es_contra_entrega"))
        out.append({
            "name": t.name,
            "dias": dias,
            "es_contra_entrega": cod,
            "clasificacion": "contra_entrega" if cod else ("credito" if dias > 0 else "contado"),
        })
    return out


def _new_schedule(si, template: str) -> list:
    """Cronograma de la plantilla nueva, conservando lo ya pagado del
    cronograma anterior (repartido en orden)."""
    from erpnext.controllers.accounts_controller import get_payment_terms

    total = _inv_total(si)
    rounded = abs(total - flt(si.grand_total)) > 0.0001
    base_total = flt(si.base_rounded_total) if rounded else flt(si.base_grand_total)
    terms = get_payment_terms(template, si.posting_date, total, base_total) or []
    if not terms:
        frappe.throw(_("La condición {0} no tiene términos de pago.").format(template))
    rate = flt(si.conversion_rate) or 1
    pagado = sum(flt(r.paid_amount) for r in si.payment_schedule or [])
    for t in terms:
        aplica = min(pagado, flt(t.payment_amount))
        pagado -= aplica
        t.paid_amount = aplica
        t.base_paid_amount = flt(aplica * rate, 2)
        t.outstanding = flt(t.payment_amount) - aplica
        t.base_outstanding = flt(t.base_payment_amount) - t.base_paid_amount
    return terms


@frappe.whitelist()
def reclasificar_condicion(invoice: str, template: str, motivo: str = None) -> dict:
    si = frappe.get_doc("Sales Invoice", invoice)
    if get_effective_company(si.company) != si.company:
        frappe.throw(_("La factura no pertenece a la compañía activa."), frappe.PermissionError)
    if not _can_reclassify(si.company):
        frappe.throw(_("No tiene el permiso «Reclasificar condición de pago desde el cierre»."), frappe.PermissionError)
    _assert_can_manage(si.company, si.owner)
    if si.docstatus != 1:
        frappe.throw(_("Solo se reclasifican facturas validadas."))
    if cint(si.get("is_return")):
        frappe.throw(_("Las notas de crédito / devoluciones no se reclasifican."))
    if _is_certified(si):
        frappe.throw(_("La factura {0} está certificada ante SAT: su condición de pago no se puede cambiar.").format(si.name))
    if getdate(si.posting_date) in _closed_dates(si.company, si.owner):
        frappe.throw(_frozen_msg(si.company, si.owner, si.posting_date), title=_("Cierre Diario"))
    motivo = (motivo or "").strip()
    if not motivo:
        frappe.throw(_("Indique el motivo del cambio."))
    opciones = {o["name"]: o for o in _terms_options()}
    if template not in opciones:
        frappe.throw(_("Condición de pago no válida: {0}").format(template))
    anterior = si.payment_terms_template or ""
    if template == anterior:
        frappe.throw(_("La factura ya tiene la condición {0}.").format(template))

    cod = cint(opciones[template]["es_contra_entrega"])
    if not cod and si.get("bfel_guias_transportista"):
        frappe.throw(_("La factura tiene guía de transporte asociada: es Contra Entrega. Quite la guía antes de cambiar la condición."))

    schedule = _new_schedule(si, template)
    due_date = max(getdate(t.due_date) for t in schedule)
    old_due = si.due_date
    old_cod = cint(si.get("bfel_pago_contra_entrega"))

    frappe.db.delete("Payment Schedule", {"parent": si.name, "parenttype": "Sales Invoice"})
    for idx, t in enumerate(schedule, 1):
        row = frappe.new_doc("Payment Schedule")
        row.update(t)
        row.update({"parent": si.name, "parenttype": "Sales Invoice", "parentfield": "payment_schedule",
                    "idx": idx, "docstatus": 1})
        row.db_insert()

    values = {"payment_terms_template": template, "due_date": due_date}
    if si.meta.has_field("bfel_pago_contra_entrega"):
        values["bfel_pago_contra_entrega"] = cod
    frappe.db.set_value("Sales Invoice", si.name, values)  # actualiza modified
    frappe.db.sql(
        "UPDATE `tabGL Entry` SET due_date = %s WHERE voucher_type = 'Sales Invoice' AND voucher_no = %s AND IFNULL(party, '') != ''",
        (due_date, si.name),
    )
    frappe.db.sql(
        "UPDATE `tabPayment Ledger Entry` SET due_date = %s WHERE voucher_type = 'Sales Invoice' AND voucher_no = %s",
        (due_date, si.name),
    )

    changed = [["payment_terms_template", anterior, template], ["due_date", str(old_due), str(due_date)]]
    if "bfel_pago_contra_entrega" in values and old_cod != cod:
        changed.append(["bfel_pago_contra_entrega", old_cod, cod])
    frappe.get_doc({
        "doctype": "Version", "ref_doctype": "Sales Invoice", "docname": si.name,
        "data": frappe.as_json({"changed": changed, "added": [], "removed": [], "row_changed": []}),
    }).insert(ignore_permissions=True)
    si.add_comment("Comment", _("Condición de pago reclasificada desde el Cierre Diario: «{0}» → «{1}» (vence {2}). Motivo: {3}").format(
        anterior or "—", template, formatdate(due_date), frappe.utils.escape_html(motivo)))
    frappe.db.commit()
    return {"success": True, "invoice": si.name, "template": template, "due_date": str(due_date)}


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
