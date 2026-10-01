"""
facex_multi.api.compras.documentos
----------------------------------
Documentos del ciclo de compra de FacEx Compras sobre los doctypes nativos:

    oc  Orden de Compra              Purchase Order
    en  Entrada de Mercadería        Purchase Receipt
    dv  Devolución de Mercadería     Purchase Receipt (is_return)
    fc  Factura de Compra            Purchase Invoice
    nc  Nota de Crédito de Proveedor Purchase Invoice (is_return)

Un solo juego de endpoints (lista / lectura / grabar / validar / cancelar /
eliminar) parametrizado por `kind`. Los documentos se encadenan con los
mapeadores de ERPNext (OC → Entrada, OC → Factura, Entrada → Factura,
Entrada → Devolución, Factura → Nota de Crédito, Devolución → Nota de Crédito), así
las cantidades pendientes, % recibido / % facturado y los estados de cada
documento los lleva ERPNext.

Permisos: `puede_compras` para entrar al módulo + los checks por documento
de FacEx Settings (Grabar Borrador / Validar / Cancelar).
"""
from __future__ import annotations

import json

import frappe
from frappe.utils import flt, getdate, today

from facex_multi.api.compras.common import (
    TERMS_FIELD,
    check_doc_access,
    compute_due_date,
    default_uom,
    get_buying_price_list,
    get_conversion_rate,
    get_naming_series,
    get_payable_account,
    get_supplier_payment_terms,
    get_tax_rows,
    is_own_scope,
    perm_field,
    require_purchase,
    resolve_item_warehouse,
    resolve_purchase_tax_template,
)

KINDS = {
    "oc": frappe._dict(
        doctype="Purchase Order", label="Orden de Compra", date="transaction_date",
        draft="oc_grabar_borrador", submit="oc_validar", cancel="oc_cancelar",
    ),
    "en": frappe._dict(
        doctype="Purchase Receipt", label="Entrada de Mercadería", date="posting_date",
        draft="entrada_compra_grabar_borrador", submit="entrada_compra_validar",
        cancel="entrada_compra_cancelar",
    ),
    "fc": frappe._dict(
        doctype="Purchase Invoice", label="Factura de Compra", date="posting_date",
        draft="factura_compra_grabar_borrador", submit="puede_validar_compras",
        cancel="puede_cancelar_compras",
    ),
    "dv": frappe._dict(
        doctype="Purchase Receipt", label="Devolución de Mercadería", date="posting_date", is_return=1,
        draft="devolucion_compra_grabar_borrador", submit="devolucion_compra_validar",
        cancel="devolucion_compra_cancelar",
    ),
    "nc": frappe._dict(
        doctype="Purchase Invoice", label="Nota de Crédito de Proveedor", date="posting_date", is_return=1,
        draft="nc_compra_grabar_borrador", submit="nc_compra_validar", cancel="nc_compra_cancelar",
    ),
}
RETURN_KINDS = ("dv", "nc")

# Qué documento puede generarse desde cuál (origen, destino).
MAKE_FROM = {("oc", "en"), ("oc", "fc"), ("en", "fc"), ("en", "dv"), ("fc", "nc"), ("dv", "nc")}

# Devoluciones: campo de la línea destino que apunta a la línea de origen
# (clave con la que se aplican las cantidades que el usuario edita).
RETURN_DETAIL = {"en": "purchase_receipt_item", "fc": "purchase_invoice_item", "dv": "pr_detail"}

# Campos de enlace de cada línea con el documento de origen.
LINK_FIELDS = {
    "oc": (),
    "en": ("purchase_order", "purchase_order_item"),
    "fc": ("purchase_order", "po_detail", "purchase_receipt", "pr_detail"),
}

LIST_FIELDS = {
    "oc": ["transaction_date as fecha", "schedule_date", "per_received", "per_billed"],
    "en": ["posting_date as fecha", "supplier_delivery_note", "per_billed"],
    "fc": ["posting_date as fecha", "bill_no", "bill_date", "due_date", "outstanding_amount"],
    "dv": ["posting_date as fecha", "return_against", "per_billed"],
    "nc": ["posting_date as fecha", "bill_no", "return_against", "outstanding_amount"],
}


def _cfg(kind: str) -> frappe._dict:
    if kind not in KINDS:
        frappe.throw(f"Documento de compra no válido: {kind}")
    return KINDS[kind]


# ---------------------------------------------------------------------------
# Condición de pago / fecha de vencimiento
# ---------------------------------------------------------------------------
# Fecha desde la que se cuentan los días de crédito. Es la misma que usa
# ERPNext en set_payment_schedule: bill_date o posting_date en la factura, la
# fecha del documento en los demás.

def _terms_base_date(kind: str, data: dict, doc_date: str) -> str:
    if kind in ("fc", "nc"):
        return data.get("bill_date") or doc_date
    return doc_date


def _get_terms(doc) -> str:
    field = TERMS_FIELD.get(doc.doctype)
    if field and doc.meta.has_field(field):
        return doc.get(field) or ""
    return ""


def _get_vencimiento(doc) -> str:
    """Vencimiento tal como quedó grabado: nativo en la factura, el mayor del
    cronograma en la orden, propio en la entrada."""
    if doc.doctype == "Purchase Invoice":
        return str(doc.get("due_date") or "")
    if doc.doctype == "Purchase Order":
        fechas = [r.due_date for r in (doc.get("payment_schedule") or []) if r.get("due_date")]
        return str(max(fechas)) if fechas else ""
    if doc.meta.has_field("facex_due_date"):
        return str(doc.get("facex_due_date") or "")
    return ""


def _apply_terms(doc, terms: str, base_date: str, due_date: str = None) -> None:
    """Graba la condición de pago y el vencimiento que le corresponde.

    Con condición elegida el vencimiento lo manda la condición (los mismos
    días que cuenta ERPNext desde la fecha del documento); sin condición se
    respeta la fecha que el usuario haya puesto a mano. El cronograma se
    limpia siempre: ERPNext solo lo reconstruye cuando está vacío, así que si
    no se borra, cambiar la condición o la fecha en un borrador no movería el
    vencimiento."""
    vencimiento = compute_due_date(terms, base_date) if terms else (due_date or "")

    if doc.meta.has_field("payment_schedule"):
        doc.set("payment_schedule", [])
    # Sin condición elegida hay que decírselo a ERPNext: si no, en
    # set_missing_values repone la condición por omisión del proveedor sobre el
    # campo vacío y el documento saldría a crédito contra la voluntad del
    # usuario (ver ensure_compras_custom_fields).
    if doc.meta.has_field("ignore_default_payment_terms_template"):
        doc.ignore_default_payment_terms_template = 0 if terms else 1
    field = TERMS_FIELD.get(doc.doctype)
    if field and doc.meta.has_field(field):
        doc.set(field, terms or None)
    if doc.meta.has_field("facex_due_date"):
        doc.facex_due_date = vencimiento or None
    if doc.meta.has_field("due_date"):
        doc.due_date = vencimiento or base_date


def _require(kind: str, company: str, action: str = None, msg: str = None) -> str:
    """puede_compras + (opcional) el check del documento para `action`
    (draft / submit / cancel)."""
    cfg = _cfg(kind)
    flags = ["puede_compras"]
    if action:
        flags.append(perm_field(cfg[action]))
    verbo = {"draft": "grabar", "submit": "validar", "cancel": "cancelar"}.get(action, "consultar")
    return require_purchase(
        company, *flags,
        msg=msg or f"No tiene permiso para {verbo} documentos «{cfg.label}» en FacEx.",
    )


def _get(kind: str, name: str):
    return frappe.get_doc(_cfg(kind).doctype, (name or "").strip())


# ---------------------------------------------------------------------------
# Lista / lectura
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_document_list(kind: str, company: str = None, start_date: str = None, end_date: str = None,
                      supplier: str = None, estado: str = None, limit: int = 100) -> list:
    """`estado`: "" (todos), "0"/"1"/"2" (docstatus) o un status nativo
    ("To Receive and Bill", "To Bill", "Completed", "Closed", …)."""
    cfg = _cfg(kind)
    company = _require(kind, company)

    date = cfg.date
    filters = [["company", "=", company]]
    if kind != "oc":
        filters.append(["is_return", "=", int(kind in RETURN_KINDS)])
    if start_date and end_date:
        filters.append([date, "between", [start_date, end_date]])
    elif start_date:
        filters.append([date, ">=", start_date])
    elif end_date:
        filters.append([date, "<=", end_date])
    if supplier:
        filters.append(["supplier", "=", supplier])
    if estado not in (None, ""):
        if str(estado).isdigit():
            filters.append(["docstatus", "=", int(estado)])
        else:
            filters.append(["status", "=", estado])
    if is_own_scope(company):
        filters.append(["owner", "=", frappe.session.user])

    return frappe.get_all(
        cfg.doctype,
        filters=filters,
        fields=["name", "supplier", "supplier_name", "grand_total", "docstatus", "status",
                "currency", "owner"] + LIST_FIELDS[kind],
        order_by=f"{date} desc, creation desc",
        limit=min(int(limit or 100), 500),
    )


def _item_flags(item_code: str) -> dict:
    meta = frappe.db.get_value(
        "Item", item_code, ["has_serial_no", "has_batch_no", "is_stock_item"], as_dict=True
    ) or {}
    return {
        "has_serial_no": int(meta.get("has_serial_no") or 0),
        "has_batch_no": int(meta.get("has_batch_no") or 0),
        "is_stock_item": int(meta.get("is_stock_item") or 0),
    }


def _kind_of(doctype: str, name: str) -> str:
    is_return = frappe.db.get_value(doctype, name, "is_return")
    if doctype == "Purchase Receipt":
        return "dv" if is_return else "en"
    return "nc" if is_return else "fc"


def _related(kind: str, doc) -> list:
    """Documentos vinculados (origen y siguientes) para la cadena del formulario."""
    out, seen = [], set()

    def add(doctype, names):
        for n in names:
            if not n or (doctype, n) in seen or n == doc.name:
                continue
            seen.add((doctype, n))
            row = frappe.db.get_value(doctype, n, ["docstatus", "status", "grand_total", "is_return"]
                                      if doctype != "Purchase Order" else ["docstatus", "status", "grand_total"],
                                      as_dict=True)
            if row:
                k = "oc" if doctype == "Purchase Order" else _kind_of(doctype, n)
                row.pop("is_return", None)
                out.append({"kind": k, "name": n, **row})

    def children(child_dt, field, value):
        return frappe.get_all(child_dt, filters={field: value, "docstatus": ["<", 2]},
                              pluck="parent", distinct=True)

    def returns_of(doctype, name):
        return frappe.get_all(doctype, filters={"return_against": name, "is_return": 1, "docstatus": ["<", 2]},
                              pluck="name")

    items = doc.get("items") or []
    if kind == "oc":
        add("Purchase Receipt", children("Purchase Receipt Item", "purchase_order", doc.name))
        add("Purchase Invoice", children("Purchase Invoice Item", "purchase_order", doc.name))
    elif kind in ("en", "dv"):
        add("Purchase Order", [i.purchase_order for i in items])
        if kind == "dv":
            add("Purchase Receipt", [doc.return_against])
        add("Purchase Receipt", returns_of("Purchase Receipt", doc.name))
        add("Purchase Invoice", children("Purchase Invoice Item", "purchase_receipt", doc.name))
    else:
        add("Purchase Order", [i.purchase_order for i in items])
        add("Purchase Receipt", [i.purchase_receipt for i in items])
        if kind == "nc":
            add("Purchase Invoice", [doc.return_against])
        add("Purchase Invoice", returns_of("Purchase Invoice", doc.name))
    return out


@frappe.whitelist()
def get_document(kind: str, name: str, company: str = None) -> dict:
    company = _require(kind, company)
    doc = _get(kind, name)
    check_doc_access(doc, company)

    d = doc.as_dict()
    for item in d.get("items", []):
        item.update(_item_flags(item.get("item_code")))
    d["owner_fullname"] = frappe.utils.get_fullname(doc.owner)
    validado = doc.get("facex_validado_por")
    d["validado_por_fullname"] = frappe.utils.get_fullname(validado) if validado else ""
    cancelado = doc.get("facex_cancelado_por")
    d["cancelado_por_fullname"] = frappe.utils.get_fullname(cancelado) if cancelado else ""
    d["related"] = _related(kind, doc)

    from facex_multi.api.compras.anexos import read_anexos
    d["anexos"] = read_anexos(doc.doctype, doc.name)
    d["payment_terms_template"] = _get_terms(doc)
    d["vencimiento"] = _get_vencimiento(doc)

    if kind in RETURN_KINDS:
        _add_return_info(kind, doc, d)
        # La nota de crédito no guarda condición de pago (ERPNext la limpia en
        # las devoluciones): se muestra la del documento al que acredita.
        if not d["payment_terms_template"] and d.get("return_source"):
            src = d["return_source"]
            if src.get("kind") and src.get("name"):
                try:
                    d["payment_terms_template"] = _get_terms(_get(src["kind"], src["name"]))
                except frappe.DoesNotExistError:
                    pass
    return d


def _return_source(kind: str, doc) -> tuple:
    """(kind, name) del documento contra el que se devuelve."""
    if kind == "dv":
        return "en", doc.return_against
    if doc.return_against:
        return "fc", doc.return_against
    prs = [i.purchase_receipt for i in doc.items if i.get("purchase_receipt")]
    return ("dv", prs[0]) if prs else (None, None)


def _add_return_info(kind: str, doc, d: dict) -> None:
    """Cantidades en positivo + máximo devolvible por línea (para el borrador)."""
    src_kind, src_name = _return_source(kind, doc)
    d["return_source"] = {"kind": src_kind, "name": src_name} if src_kind else None
    detail_f = RETURN_DETAIL.get(src_kind)
    pending = {}
    if doc.docstatus == 0 and src_kind:
        try:
            target = _mapped(src_kind, src_name, kind)
            pending = {it.get(detail_f): abs(flt(it.qty)) for it in target.items}
        except frappe.ValidationError:
            frappe.clear_messages()
    for it in d.get("items", []):
        it["detail"] = it.get(detail_f) if detail_f else None
        it["qty"] = abs(flt(it.get("qty")))
        it["max_qty"] = pending.get(it["detail"], it["qty"])


# ---------------------------------------------------------------------------
# Grabar
# ---------------------------------------------------------------------------

@frappe.whitelist()
def save_document(kind: str, data_json: str) -> dict:
    """
    Crea o actualiza el borrador. data_json:
      {name?, company, supplier, currency, tax_type, remarks,
       payment_terms_template, due_date, anexos: [{file_url, comentario,
                copiar_a_destino, origen}],
       oc: transaction_date, schedule_date
       en: posting_date, supplier_delivery_note
       fc: posting_date, bill_no, bill_date, bfel_multi_tipo
       items: [{item_code, qty, rate, uom?, conversion_factor?, warehouse,
                serial_no, batch_no, bfel_multi_tipo, <campos de enlace>}]}
    """
    cfg = _cfg(kind)
    data = json.loads(data_json) if isinstance(data_json, str) else data_json
    if kind in RETURN_KINDS:
        return _save_return(kind, data)
    company = _require(kind, data.get("company"), "draft")
    name = (data.get("name") or "").strip()
    supplier = (data.get("supplier") or "").strip()
    if not supplier:
        frappe.throw("Seleccione el proveedor.")
    currency = data.get("currency") or frappe.db.get_value("Company", company, "default_currency") or "GTQ"
    doc_date = data.get(cfg.date) or data.get("posting_date") or today()

    if name and frappe.db.exists(cfg.doctype, name):
        doc = frappe.get_doc(cfg.doctype, name)
        check_doc_access(doc, company)
        if doc.docstatus != 0:
            frappe.throw("Solo se pueden editar documentos en borrador.")
        doc.items = []
        doc.taxes = []
    else:
        doc = frappe.new_doc(cfg.doctype)
        series = get_naming_series(cfg.doctype, company)
        if series:
            doc.naming_series = series[0]

    doc.company = company
    doc.supplier = supplier
    doc.set(cfg.date, doc_date)
    doc.currency = currency
    doc.conversion_rate = get_conversion_rate(currency, company, doc_date)
    doc.buying_price_list = get_buying_price_list()
    doc.price_list_currency = currency
    doc.plc_conversion_rate = doc.conversion_rate
    doc.ignore_pricing_rule = 1
    doc.taxes_and_charges = resolve_purchase_tax_template(company, data.get("tax_type") or "")
    doc.set_warehouse = None
    if doc.meta.has_field("remarks"):
        doc.remarks = data.get("remarks") or ""

    schedule_date = None
    if kind == "oc":
        schedule_date = data.get("schedule_date") or doc_date
        if getdate(schedule_date) < getdate(doc_date):
            frappe.throw("La fecha de entrega no puede ser anterior a la fecha de la orden.")
        doc.schedule_date = schedule_date
    else:
        doc.set_posting_time = 1
    if kind == "en":
        doc.supplier_delivery_note = data.get("supplier_delivery_note") or ""
    if kind == "fc":
        doc.bill_no = data.get("bill_no") or ""
        doc.bill_date = data.get("bill_date") or doc_date
        doc.credit_to = get_payable_account(supplier, company, currency)
        if doc.meta.has_field("bfel_multi_tipo"):
            doc.bfel_multi_tipo = data.get("bfel_multi_tipo") or ""

    _apply_terms(doc, (data.get("payment_terms_template") or "").strip(),
                 _terms_base_date(kind, data, doc_date), data.get("due_date") or "")

    rows = [r for r in (data.get("items") or []) if (r.get("item_code") or "").strip()]
    if not rows:
        frappe.throw("Agregue al menos un producto antes de guardar.")

    # Factura que viene de una Entrada: el inventario ya ingresó con la
    # Entrada, la factura solo registra la cuenta por pagar (update_stock=0).
    from_receipt = kind == "fc" and any(r.get("pr_detail") for r in rows)

    from facex_multi.api.permissions import get_facex_allowed_warehouses
    from facex_multi.api.stock import _resolve_batch
    allowed_warehouses = get_facex_allowed_warehouses(company, "compra")

    has_stock_item = False
    for row in rows:
        item_code = row["item_code"].strip()
        info = frappe.db.get_value(
            "Item", item_code, ["has_serial_no", "has_batch_no", "is_stock_item", "stock_uom"], as_dict=True
        )
        if not info:
            frappe.throw(f"Producto '{item_code}' no encontrado.")
        is_stock = int(info.is_stock_item or 0)
        has_serial = int(info.has_serial_no or 0)
        has_batch = int(info.has_batch_no or 0)
        stock_uom = info.stock_uom or default_uom()

        # ¿Esta línea mueve inventario en ESTE documento?
        moves_stock = is_stock and (kind == "en" or (kind == "fc" and not from_receipt))
        if from_receipt and is_stock and not row.get("pr_detail"):
            frappe.throw(
                f"{item_code}: esta factura viene de una Entrada de Mercadería; los productos de "
                "inventario que no estén en la entrada deben ingresarse con otra entrada."
            )

        qty = flt(row.get("qty"))
        rate = flt(row.get("rate"))
        serial_no = (row.get("serial_no") or "").strip()
        batch_no = (row.get("batch_no") or "").strip()
        if moves_stock and has_serial and serial_no:
            serials = [s.strip() for s in serial_no.replace(",", "\n").split("\n") if s.strip()]
            qty = len(serials)
            serial_no = "\n".join(serials)
        if qty <= 0:
            frappe.throw(f"{item_code}: la cantidad debe ser mayor a 0.")

        wh = ""
        if is_stock:
            has_stock_item = True
            wh = row.get("warehouse") or resolve_item_warehouse(item_code, company, allowed_warehouses)
            if wh and allowed_warehouses is not None and wh not in allowed_warehouses:
                if row.get("warehouse") and moves_stock:
                    frappe.throw(f"La bodega '{wh}' no está habilitada para compra en su configuración.")
                if not row.get("warehouse"):
                    wh = allowed_warehouses[0] if allowed_warehouses else ""
            if not wh and (moves_stock or kind == "oc"):
                frappe.throw(f"Indique la bodega de recepción de {item_code}.")

        item_row = {
            "item_code": item_code,
            "qty": qty,
            "rate": rate,
            "uom": row.get("uom") or stock_uom,
            "stock_uom": stock_uom,
            "conversion_factor": flt(row.get("conversion_factor")) or 1.0,
            "warehouse": wh,
        }
        if kind == "oc":
            item_row["schedule_date"] = schedule_date
        for f in LINK_FIELDS[kind]:
            if row.get(f):
                item_row[f] = row.get(f)
        if kind == "fc" and row.get("bfel_multi_tipo"):
            item_row["bfel_multi_tipo"] = row.get("bfel_multi_tipo")
        if moves_stock and has_serial and serial_no:
            item_row["use_serial_batch_fields"] = 1
            item_row["serial_no"] = serial_no
        if moves_stock and has_batch:
            # Recepción de mercadería: se auto-crea el maestro Batch si el lote
            # del proveedor aún no existe (mismo criterio que Entradas).
            item_row["use_serial_batch_fields"] = 1
            item_row["batch_no"] = _resolve_batch(item_code, batch_no, "in")
        doc.append("items", item_row)

    if kind == "en" and not has_stock_item:
        frappe.throw("Una Entrada de Mercadería necesita al menos un producto de inventario.")
    if kind == "fc":
        # Solo servicios/gastos → sin movimiento de inventario. Con update_stock=1
        # y ningún ítem de inventario ERPNext arma partidas en cero y rechaza la
        # validación ("Either debit or credit amount is required").
        doc.update_stock = 1 if (has_stock_item and not from_receipt) else 0

    for tax_row in get_tax_rows(doc.taxes_and_charges):
        doc.append("taxes", tax_row)

    if kind == "fc":
        # Cuenta de gasto nativa de cada línea (inventario de la bodega o
        # «Inventario Recibido pero no Facturado») asignada ANTES de validar:
        # si no, ERPNext la cambia en validate y muestra al usuario el aviso
        # técnico «Cabeza de gastos cambiada …».
        doc.set_expense_account(for_validate=False)

    # ignore_permissions: el control es el permiso FacEx; las validaciones
    # nativas de ERPNext (cantidades contra la OC, proveedor/moneda del
    # documento de origen, series, lotes…) sí corren.
    doc.save(ignore_permissions=True)
    _save_anexos(cfg.doctype, doc, data)
    frappe.db.commit()
    return {"success": True, "name": doc.name}


def _save_anexos(doctype: str, doc, data: dict) -> None:
    """Crea las filas de los anexos que traía el formulario: los que se
    subieron antes de que el documento existiera y los heredados del
    documento de origen (los marcados «Copiar hacia documentos destino»)."""
    from facex_multi.api.compras.anexos import persist_pending

    persist_pending(doctype, doc.name, doc.docstatus, data.get("anexos") or [])


# ---------------------------------------------------------------------------
# Validar / cancelar / eliminar / cerrar
# ---------------------------------------------------------------------------

@frappe.whitelist()
def submit_document(kind: str, name: str) -> dict:
    doc = _get(kind, name)
    company = _require(kind, doc.company, "submit")
    check_doc_access(doc, company)
    if doc.docstatus != 0:
        frappe.throw("El documento ya fue validado o cancelado.")
    doc.flags.ignore_permissions = True
    doc.submit()
    frappe.db.commit()
    return {"success": True, "name": doc.name}


@frappe.whitelist()
def cancel_document(kind: str, name: str) -> dict:
    doc = _get(kind, name)
    company = _require(kind, doc.company, "cancel")
    check_doc_access(doc, company)
    if doc.docstatus != 1:
        frappe.throw("Solo se pueden cancelar documentos validados.")
    nexts = [r for r in _related(kind, doc) if r["docstatus"] == 1 and _is_downstream(kind, r["kind"])]
    if nexts:
        frappe.throw(
            "Primero cancele los documentos generados desde este: "
            + ", ".join(f"{KINDS[r['kind']].label} {r['name']}" for r in nexts)
        )
    doc.flags.ignore_permissions = True
    doc.cancel()
    frappe.db.commit()
    return {"success": True, "name": doc.name}


DOWNSTREAM = {
    "oc": {"en", "dv", "fc", "nc"},
    "en": {"dv", "fc", "nc"},
    "dv": {"nc"},
    "fc": {"nc"},
    "nc": set(),
}


def _is_downstream(kind: str, other: str) -> bool:
    return other in DOWNSTREAM[kind]


@frappe.whitelist()
def delete_document(kind: str, name: str) -> dict:
    """Elimina un borrador (mismo permiso que grabarlo)."""
    cfg = _cfg(kind)
    doc = _get(kind, name)
    company = _require(kind, doc.company, "draft")
    check_doc_access(doc, company)
    if doc.docstatus != 0:
        frappe.throw("Solo se pueden eliminar documentos en borrador.")
    frappe.delete_doc(cfg.doctype, doc.name, ignore_permissions=True)
    frappe.db.commit()
    return {"success": True}


@frappe.whitelist()
def set_order_closed(name: str, closed: int = 1) -> dict:
    """Cerrar una OC validada con saldo pendiente (ya no se espera más
    mercadería ni factura) o reabrirla. Mismo permiso que validarla."""
    doc = _get("oc", name)
    company = _require("oc", doc.company, "submit",
                       msg="No tiene permiso para cerrar o reabrir Órdenes de Compra.")
    check_doc_access(doc, company)
    if doc.docstatus != 1:
        frappe.throw("Solo se pueden cerrar órdenes validadas.")
    if int(closed):
        if doc.status in ("Closed", "Completed"):
            frappe.throw("La orden ya está cerrada o completa.")
        doc.update_status("Closed")
    else:
        if doc.status != "Closed":
            frappe.throw("La orden no está cerrada.")
        doc.update_status("Submitted")
    frappe.db.commit()
    return {"success": True, "status": frappe.db.get_value("Purchase Order", doc.name, "status")}


# ---------------------------------------------------------------------------
# Crear desde (OC → Entrada / Factura, Entrada → Factura)
# ---------------------------------------------------------------------------

def _mapper(source_kind: str, target_kind: str):
    if target_kind == "dv":
        from erpnext.stock.doctype.purchase_receipt.purchase_receipt import make_purchase_return
        return make_purchase_return
    if source_kind == "fc" and target_kind == "nc":
        from erpnext.accounts.doctype.purchase_invoice.purchase_invoice import make_debit_note
        return make_debit_note
    if source_kind == "oc" and target_kind == "en":
        from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_receipt
        return make_purchase_receipt
    if source_kind == "oc" and target_kind == "fc":
        from erpnext.buying.doctype.purchase_order.purchase_order import make_purchase_invoice
        return make_purchase_invoice
    from erpnext.stock.doctype.purchase_receipt.purchase_receipt import make_purchase_invoice
    return make_purchase_invoice


@frappe.whitelist()
def make_from(source_kind: str, name: str, target_kind: str) -> dict:
    """Arma (SIN grabar) el documento siguiente con lo pendiente del origen,
    listo para que el formulario lo muestre. Se graba con save_document."""
    if (source_kind, target_kind) not in MAKE_FROM:
        frappe.throw("Ese documento no puede generarse desde este origen.")
    source = _get(source_kind, name)
    company = _require(target_kind, source.company, "draft")
    check_doc_access(source, company)
    _check_source_type(source_kind, source)
    if source.docstatus != 1:
        frappe.throw(f"Valide primero {KINDS[source_kind].label} {source.name}.")
    if source.get("status") == "Closed":
        frappe.throw(f"{KINDS[source_kind].label} {source.name} está cerrada.")

    target = _mapped(source_kind, source.name, target_kind)
    if target_kind in RETURN_KINDS:
        return _return_payload(source_kind, source, target_kind, target)

    items = []
    for it in target.get("items") or []:
        if flt(it.qty) <= 0:
            continue
        row = {
            "item_code": it.item_code,
            "item_name": it.item_name,
            "qty": flt(it.qty),
            "rate": flt(it.rate),
            "uom": it.uom,
            "conversion_factor": flt(it.conversion_factor) or 1,
            "warehouse": it.get("warehouse") or "",
            "serial_no": "",
            "batch_no": "",
            "bfel_multi_tipo": it.get("bfel_multi_tipo") or "",
        }
        for f in LINK_FIELDS[target_kind]:
            row[f] = it.get(f) or ""
        row.update(_item_flags(it.item_code))
        items.append(row)
    if not items:
        frappe.throw(f"{KINDS[source_kind].label} {source.name} no tiene cantidades pendientes para "
                     f"«{KINDS[target_kind].label}».")

    return {
        "supplier": source.supplier,
        "supplier_name": source.supplier_name,
        "currency": source.currency,
        "tax_type": source.taxes_and_charges or "",
        "source": {"kind": source_kind, "name": source.name},
        "items": items,
        **_inherited(source_kind, source),
    }


def _inherited(source_kind: str, source) -> dict:
    """Lo que el documento destino hereda del origen:

      date      la fecha de HOY — el documento se está creando ahora, no en la
                fecha del origen (de ahí se recalcula su vencimiento).
      payment_terms_template / vencimiento  la condición de pago del origen,
                recontada desde hoy.
      anexos    los anexos del origen marcados «Copiar hacia documentos
                destino»; se graban con el destino.
    """
    from facex_multi.api.compras.anexos import copiables

    hoy = today()
    terms = _get_terms(source)
    return {
        "date": hoy,
        "payment_terms_template": terms,
        "vencimiento": compute_due_date(terms, hoy) if terms else "",
        "anexos": copiables(KINDS[source_kind].doctype, source.name, KINDS[source_kind].label),
    }


def _mapped(source_kind: str, source_name: str, target_kind: str):
    """Documento destino armado por el mapeador nativo (sin grabar).

    Los mapeadores exigen permisos de ERPNext sobre el doctype de origen /
    destino (p. ej. los usuarios de facturación no tienen Purchase Order);
    aquí el control es el permiso FacEx, ya verificado, y el resultado no se
    graba. Solo se cambia session.user durante el mapeo: frappe.set_user()
    además reemplazaría el sid de la sesión en curso."""
    user = frappe.session.user
    try:
        frappe.local.session.user = "Administrator"
        return _mapper(source_kind, target_kind)(source_name)
    finally:
        frappe.local.session.user = user


# ---------------------------------------------------------------------------
# Devoluciones (Devolución de Mercadería / Nota de Crédito de Proveedor)
# ---------------------------------------------------------------------------
# El documento SIEMPRE se reconstruye con el mapeador nativo contra su
# origen; del usuario solo se toman la cantidad a devolver de cada línea
# (≤ pendiente de devolver), qué series devuelve, fecha, observaciones y el
# número de nota de crédito del proveedor. Precios, impuestos, bodegas,
# lotes y enlaces son los del documento original.

def _check_source_type(source_kind: str, source) -> None:
    """Entrada / Factura vs Devolución / Nota de crédito comparten doctype."""
    if source_kind != "oc" and int(source.get("is_return") or 0) != int(source_kind in RETURN_KINDS):
        frappe.throw(f"{source.name} no es una {KINDS[source_kind].label}.")


def _serials(txt) -> list:
    return [x.strip() for x in (txt or "").replace(",", "\n").split("\n") if x.strip()]


def _moves_stock(kind: str, doc, item) -> bool:
    is_stock = frappe.get_cached_value("Item", item.item_code, "is_stock_item")
    return bool(is_stock) and (kind == "dv" or bool(doc.get("update_stock")))


def _return_payload(source_kind: str, source, target_kind: str, target) -> dict:
    detail_f = RETURN_DETAIL[source_kind]
    items = []
    for it in target.get("items") or []:
        qty = abs(flt(it.qty))
        if qty <= 0:
            continue
        row = {
            "detail": it.get(detail_f),
            "item_code": it.item_code,
            "item_name": it.item_name,
            "qty": qty,
            "max_qty": qty,
            "rate": flt(it.rate),
            "uom": it.uom,
            "warehouse": it.get("warehouse") or "",
            "serial_no": it.get("serial_no") or "",
            "batch_no": it.get("batch_no") or "",
            "purchase_order": it.get("purchase_order") or "",
            "purchase_receipt": it.get("purchase_receipt") or "",
        }
        row.update(_item_flags(it.item_code))
        items.append(row)
    if not items:
        frappe.throw(f"{KINDS[source_kind].label} {source.name} ya no tiene cantidades pendientes de devolver.")
    return {
        "supplier": source.supplier,
        "supplier_name": source.supplier_name,
        "currency": source.currency,
        "tax_type": target.get("taxes_and_charges") or source.get("taxes_and_charges") or "",
        "update_stock": int(target.get("update_stock") or 0) if target_kind == "nc" else 1,
        "source": {"kind": source_kind, "name": source.name},
        "items": items,
        **_inherited(source_kind, source),
    }


def _save_return(kind: str, data: dict) -> dict:
    cfg = _cfg(kind)
    company = _require(kind, data.get("company"), "draft")
    name = (data.get("name") or "").strip()
    existing = None
    if name and frappe.db.exists(cfg.doctype, name):
        existing = frappe.get_doc(cfg.doctype, name)
        check_doc_access(existing, company)
        if existing.docstatus != 0:
            frappe.throw("Solo se pueden editar documentos en borrador.")
        src_kind, src_name = _return_source(kind, existing)
    else:
        src = data.get("source") or {}
        src_kind, src_name = src.get("kind"), src.get("name")
    if (src_kind, kind) not in MAKE_FROM or not src_name:
        frappe.throw("Indique el documento contra el que se devuelve.")
    source = _get(src_kind, src_name)
    check_doc_access(source, company)
    _check_source_type(src_kind, source)
    if source.docstatus != 1:
        frappe.throw(f"{KINDS[src_kind].label} {source.name} no está validada.")

    target = _mapped(src_kind, source.name, kind)
    detail_f = RETURN_DETAIL[src_kind]
    wanted = {r.get("detail"): r for r in (data.get("items") or []) if r.get("detail")}

    keep = []
    for it in target.items:
        w = wanted.get(it.get(detail_f))
        if not w:
            continue
        qty = flt(w.get("qty"))
        max_qty = abs(flt(it.qty))
        if qty <= 0:
            continue
        if qty > max_qty + 1e-9:
            frappe.throw(f"{it.item_code}: solo quedan {max_qty:g} pendientes de devolver.")
        if _moves_stock(kind, target, it) and frappe.get_cached_value("Item", it.item_code, "has_serial_no"):
            available = set(_serials(it.serial_no))
            chosen = _serials(w.get("serial_no"))
            if not chosen:
                frappe.throw(f"{it.item_code}: indique las series que devuelve.")
            invalid = [x for x in chosen if x not in available]
            if invalid:
                frappe.throw(f"{it.item_code}: las series {', '.join(invalid)} no están pendientes de devolver en {source.name}.")
            qty = len(chosen)
            it.serial_no = "\n".join(chosen)
        it.qty = -qty
        it.stock_qty = -qty * (flt(it.conversion_factor) or 1)
        it.received_qty = it.qty + flt(it.get("rejected_qty"))
        keep.append(it)
    if not keep:
        frappe.throw("Indique al menos una línea con cantidad a devolver.")

    if existing:
        doc = existing
        doc.set("items", [])
        doc.set("taxes", [])
        skip = {"name", "parent", "parentfield", "parenttype", "idx", "doctype", "docstatus"}
        for it in keep:
            doc.append("items", {k: v for k, v in it.as_dict().items() if k not in skip})
        for t in target.get("taxes") or []:
            doc.append("taxes", {k: v for k, v in t.as_dict().items() if k not in skip})
    else:
        doc = target
        doc.set("items", keep)
        series = get_naming_series(cfg.doctype, company)
        if series:
            doc.naming_series = series[0]

    doc.posting_date = data.get("posting_date") or today()
    doc.set_posting_time = 1
    if doc.meta.has_field("remarks"):
        doc.remarks = data.get("remarks") or ""
    # La devolución hereda la condición de pago de la entrada (la nota de
    # crédito no la guarda: ERPNext limpia payment_terms_template en las
    # devoluciones, así que se muestra la de la factura que acredita).
    if kind == "dv" and doc.meta.has_field("facex_payment_terms_template"):
        terms = _get_terms(source)
        doc.facex_payment_terms_template = terms or None
        doc.facex_due_date = compute_due_date(terms, doc.posting_date) if terms else None
    if kind == "nc":
        doc.bill_no = data.get("bill_no") or ""
        doc.bill_date = data.get("bill_date") or doc.posting_date
        doc.credit_to = get_payable_account(doc.supplier, company, doc.currency)
        doc.set_expense_account(for_validate=False)
        # Nota de crédito sobre una factura: rebaja el saldo de ESA factura
        # (como en SAP B1). ERPNext por defecto deja el saldo negativo en la
        # propia nota (update_outstanding_for_self=1).
        if doc.return_against and doc.meta.has_field("update_outstanding_for_self"):
            doc.update_outstanding_for_self = 0

    doc.save(ignore_permissions=True)
    _save_anexos(cfg.doctype, doc, data)
    frappe.db.commit()
    return {"success": True, "name": doc.name}
