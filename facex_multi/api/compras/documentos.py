"""
facex_multi.api.compras.documentos
----------------------------------
Documentos del ciclo de compra de FacEx Compras sobre los doctypes nativos:

    oc  Orden de Compra        Purchase Order
    en  Entrada de Mercadería  Purchase Receipt
    fc  Factura de Compra      Purchase Invoice

Un solo juego de endpoints (lista / lectura / grabar / validar / cancelar /
eliminar) parametrizado por `kind`. Los documentos se encadenan con los
mapeadores de ERPNext (OC → Entrada, OC → Factura, Entrada → Factura), así
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
    check_doc_access,
    default_uom,
    get_buying_price_list,
    get_conversion_rate,
    get_naming_series,
    get_payable_account,
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
}

# Qué documento puede generarse desde cuál (origen, destino).
MAKE_FROM = {("oc", "en"), ("oc", "fc"), ("en", "fc")}

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
}


def _cfg(kind: str) -> frappe._dict:
    if kind not in KINDS:
        frappe.throw(f"Documento de compra no válido: {kind}")
    return KINDS[kind]


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
        filters.append(["is_return", "=", 0])
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


def _related(kind: str, doc) -> list:
    """Documentos vinculados (origen y siguientes) para la cadena del formulario."""
    out, seen = [], set()

    def add(k, names):
        for n in names:
            if n and (k, n) not in seen:
                seen.add((k, n))
                row = frappe.db.get_value(KINDS[k].doctype, n, ["docstatus", "status", "grand_total"], as_dict=True)
                if row:
                    out.append({"kind": k, "name": n, **row})

    def children(child_dt, field, value):
        return frappe.get_all(child_dt, filters={field: value, "docstatus": ["<", 2]},
                              pluck="parent", distinct=True)

    items = doc.get("items") or []
    if kind == "oc":
        add("en", children("Purchase Receipt Item", "purchase_order", doc.name))
        add("fc", children("Purchase Invoice Item", "purchase_order", doc.name))
    elif kind == "en":
        add("oc", [i.purchase_order for i in items])
        add("fc", children("Purchase Invoice Item", "purchase_receipt", doc.name))
    else:
        add("oc", [i.purchase_order for i in items])
        add("en", [i.purchase_receipt for i in items])
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
    d["related"] = _related(kind, doc)
    return d


# ---------------------------------------------------------------------------
# Grabar
# ---------------------------------------------------------------------------

@frappe.whitelist()
def save_document(kind: str, data_json: str) -> dict:
    """
    Crea o actualiza el borrador. data_json:
      {name?, company, supplier, currency, tax_type, remarks,
       oc: transaction_date, schedule_date
       en: posting_date, supplier_delivery_note
       fc: posting_date, bill_no, bill_date, bfel_multi_tipo
       items: [{item_code, qty, rate, uom?, conversion_factor?, warehouse,
                serial_no, batch_no, bfel_multi_tipo, <campos de enlace>}]}
    """
    cfg = _cfg(kind)
    data = json.loads(data_json) if isinstance(data_json, str) else data_json
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
    frappe.db.commit()
    return {"success": True, "name": doc.name}


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


def _is_downstream(kind: str, other: str) -> bool:
    order = ["oc", "en", "fc"]
    return order.index(other) > order.index(kind)


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
    if source.docstatus != 1:
        frappe.throw(f"Valide primero {KINDS[source_kind].label} {source.name}.")
    if source.get("status") == "Closed":
        frappe.throw(f"{KINDS[source_kind].label} {source.name} está cerrada.")

    # Los mapeadores nativos exigen permisos de ERPNext sobre el doctype de
    # origen/destino (p. ej. los usuarios de facturación no tienen Purchase
    # Order); aquí el control es el permiso FacEx, ya verificado, y el
    # resultado no se graba. Solo se cambia session.user durante el mapeo:
    # frappe.set_user() además reemplazaría el sid de la sesión en curso.
    user = frappe.session.user
    try:
        frappe.local.session.user = "Administrator"
        target = _mapper(source_kind, target_kind)(source.name)
    finally:
        frappe.local.session.user = user

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
    }
