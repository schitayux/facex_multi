"""
facex_multi.api.compras.pagos
-----------------------------
FacEx Pagos (/app/facex-pagos): pagos a proveedores sobre el Payment Entry
nativo de ERPNext (payment_type "Pay", party_type "Supplier").

Un pago de FacEx = un Payment Entry:
- una forma de pago (Efectivo / Cheque / Transferencia / Depósito) → una
  cuenta de caja o banco (FacEx Configuracion Compania, sección Pagos a
  Proveedores);
- varias facturas de compra (references con monto positivo) y notas de
  crédito del proveedor (references con monto negativo) en el mismo pago;
- retenciones ISR / IVA como deducciones (haber a «Retención … por pagar»)
  y cargos bancarios como deducción al gasto;
- lo que sobra queda como anticipo nativo (unallocated_amount).

Los anticipos ya pagados y las notas de crédito sueltas se aplican a
facturas con la Conciliación de Pagos nativa (Payment Reconciliation).
Saldos: siempre el outstanding / unallocated nativo, sin libro paralelo.

Permisos (denegados por defecto): pago_proveedor_grabar_borrador /
pago_proveedor_validar / pago_proveedor_cancelar + puede_compras.
"""
from __future__ import annotations

import json

import frappe
from frappe.utils import flt, getdate, today

from facex_multi.api.compras.common import get_payable_account, require_purchase

PAGO_SERIES = "PPR-.ABBR.-.####"

# Formas de pago: clave → (etiqueta, campo de cuenta en la config, pide referencia,
# Modes of Payment candidatos para el campo informativo mode_of_payment).
FORMAS = {
    "efectivo": ("Efectivo", "pago_cuenta_efectivo", 0, ("Efectivo", "Cash", "Efectivo (FP-EFE)")),
    "cheque": ("Cheque", "pago_cuenta_banco", 1, ("Cheque",)),
    "transferencia": ("Transferencia", "pago_cuenta_banco", 1,
                      ("Transferencia bancaria", "Transferencia (FP-TRA)", "Wire Transfer")),
    "deposito": ("Depósito bancario", "pago_cuenta_banco", 1,
                 ("Depósito bancario (FP-DEP)", "Giro bancario", "Bank Draft")),
}
RETENCIONES = {
    "isr": ("Retención ISR", "pago_cuenta_retencion_isr"),
    "iva": ("Retención IVA", "pago_cuenta_retencion_iva"),
}
CONFIG_DOCTYPE = "FacEx Configuracion Compania"
TOL = 0.005


# ---------------------------------------------------------------------------
# Configuración / permisos
# ---------------------------------------------------------------------------

def _config(company: str) -> dict:
    fields = [f[1] for f in FORMAS.values()] + [r[1] for r in RETENCIONES.values()] + ["pago_cuenta_cargos_bancarios"]
    meta = frappe.get_meta(CONFIG_DOCTYPE)
    fields = sorted({f for f in fields if meta.has_field(f)})
    row = frappe.db.get_value(CONFIG_DOCTYPE, company, fields, as_dict=True) if fields else None
    return row or {}


def _require(company: str, action: str = None, msg: str = None) -> str:
    flags = ["puede_compras"]
    if action:
        flags.append(f"pago_proveedor_{action}")
    verbo = {"grabar_borrador": "grabar", "validar": "validar", "cancelar": "cancelar"}.get(action, "consultar")
    return require_purchase(company, *flags, msg=msg or f"No tiene permiso para {verbo} pagos a proveedores en FacEx.")


def _mode_of_payment(forma: str) -> str:
    for name in FORMAS[forma][3]:
        if frappe.db.exists("Mode of Payment", {"name": name, "enabled": 1}):
            return name
    return None


@frappe.whitelist()
def get_pagos_defaults(company: str = None) -> dict:
    from facex_multi.api.compras.common import get_compras_defaults
    d = get_compras_defaults(company)
    company = d.get("company")
    cfg = _config(company) if company else {}
    d["formas"] = [
        {"key": k, "label": v[0], "account": cfg.get(v[1]) or "", "needs_ref": v[2]}
        for k, v in FORMAS.items() if cfg.get(v[1])
    ]
    d["retenciones"] = [
        {"key": k, "label": v[0], "account": cfg.get(v[1]) or ""}
        for k, v in RETENCIONES.items() if cfg.get(v[1])
    ]
    d["cuenta_cargos_bancarios"] = cfg.get("pago_cuenta_cargos_bancarios") or ""
    d["config_incompleta"] = not d["formas"]
    return d


# ---------------------------------------------------------------------------
# Proveedores y documentos abiertos
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_suppliers_with_balance(company: str = None, txt: str = "") -> list:
    """Proveedores con saldo por pagar (facturas − notas de crédito − anticipos)."""
    company = _require(company)
    rows = frappe.db.sql(
        """
        SELECT pi.supplier, pi.supplier_name, SUM(pi.outstanding_amount) AS saldo,
               SUM(CASE WHEN pi.outstanding_amount > 0 AND pi.due_date < CURDATE() THEN pi.outstanding_amount ELSE 0 END) AS vencido,
               COUNT(CASE WHEN pi.outstanding_amount > 0 THEN 1 END) AS facturas
        FROM `tabPurchase Invoice` pi
        WHERE pi.company = %(company)s AND pi.docstatus = 1 AND pi.outstanding_amount != 0
          AND (%(txt)s = '' OR pi.supplier LIKE %(like)s OR pi.supplier_name LIKE %(like)s)
        GROUP BY pi.supplier, pi.supplier_name
        ORDER BY saldo DESC
        LIMIT 200
        """,
        {"company": company, "txt": txt or "", "like": f"%{txt}%"},
        as_dict=True,
    )
    adv = _advances_by_supplier(company)
    for r in rows:
        r["anticipos"] = adv.pop(r.supplier, 0)
        r["saldo"] = flt(r.saldo) - r["anticipos"]
    return rows


def _advances_by_supplier(company: str, supplier: str = None) -> dict:
    cond = "AND party = %(supplier)s" if supplier else ""
    return dict(frappe.db.sql(
        f"""SELECT party, SUM(unallocated_amount) FROM `tabPayment Entry`
            WHERE company = %(company)s AND docstatus = 1 AND payment_type = 'Pay'
              AND party_type = 'Supplier' AND unallocated_amount > 0 {cond}
            GROUP BY party""",
        {"company": company, "supplier": supplier},
    ))


@frappe.whitelist()
def get_open_documents(supplier: str, company: str = None) -> dict:
    """Facturas con saldo, notas de crédito con crédito disponible y anticipos
    sin aplicar del proveedor (saldos nativos)."""
    company = _require(company)
    base = {"company": company, "supplier": supplier, "docstatus": 1}
    fields = ["name", "posting_date", "due_date", "bill_no", "grand_total", "outstanding_amount", "currency", "return_against"]
    facturas = frappe.get_all("Purchase Invoice", filters={**base, "is_return": 0, "outstanding_amount": [">", 0]},
                              fields=fields, order_by="due_date asc, posting_date asc")
    notas = frappe.get_all("Purchase Invoice", filters={**base, "is_return": 1, "outstanding_amount": ["<", 0]},
                           fields=fields, order_by="posting_date asc")
    anticipos = frappe.get_all(
        "Payment Entry",
        filters={"company": company, "party_type": "Supplier", "party": supplier, "docstatus": 1,
                 "payment_type": "Pay", "unallocated_amount": [">", 0]},
        fields=["name", "posting_date", "paid_amount", "unallocated_amount", "reference_no", "mode_of_payment"],
        order_by="posting_date asc",
    )
    hoy = getdate(today())
    for f in facturas:
        f["vencida"] = int(bool(f.due_date and getdate(f.due_date) < hoy))
    for n in notas:
        n["credito"] = abs(flt(n.outstanding_amount))
    return {
        "supplier_name": frappe.db.get_value("Supplier", supplier, "supplier_name"),
        "facturas": facturas,
        "notas": notas,
        "anticipos": anticipos,
    }


# ---------------------------------------------------------------------------
# Grabar / validar / cancelar / eliminar
# ---------------------------------------------------------------------------

@frappe.whitelist()
def save_payment(data_json: str) -> dict:
    """
    data_json: {name?, company, supplier, posting_date, forma, reference_no,
                amount (lo que recibe el proveedor), cargos_bancarios,
                retenciones: [{tipo: isr|iva, amount}],
                facturas: [{name, amount}], notas: [{name, amount}], remarks}
    """
    data = json.loads(data_json) if isinstance(data_json, str) else data_json
    company = _require(data.get("company"), "grabar_borrador")
    supplier = (data.get("supplier") or "").strip()
    if not supplier:
        frappe.throw("Seleccione el proveedor.")
    forma = data.get("forma")
    if forma not in FORMAS:
        frappe.throw("Seleccione la forma de pago.")
    cfg = _config(company)
    paid_from = cfg.get(FORMAS[forma][1])
    if not paid_from:
        frappe.throw(f"Configure la cuenta de «{FORMAS[forma][0]}» en FacEx Configuración Compañía → Pagos a Proveedores.")
    reference_no = (data.get("reference_no") or "").strip()
    if FORMAS[forma][2] and not reference_no:
        frappe.throw(f"Ingrese el número de {FORMAS[forma][0].lower()} / referencia bancaria.")

    amount = flt(data.get("amount"), 2)
    fee = flt(data.get("cargos_bancarios"), 2) if forma != "efectivo" else 0
    if amount < 0 or fee < 0:
        frappe.throw("Los montos no pueden ser negativos.")

    name = (data.get("name") or "").strip()
    if name and frappe.db.exists("Payment Entry", name):
        pe = frappe.get_doc("Payment Entry", name)
        _check_access(pe, company)
        if pe.docstatus != 0:
            frappe.throw("Solo se pueden editar pagos en borrador.")
        pe.set("references", [])
        pe.set("deductions", [])
    else:
        pe = frappe.new_doc("Payment Entry")
        _ensure_series()
        pe.naming_series = PAGO_SERIES

    posting_date = data.get("posting_date") or today()
    currency = frappe.db.get_value("Company", company, "default_currency")
    payable = get_payable_account(supplier, company, currency)
    pe.update({
        "payment_type": "Pay",
        "party_type": "Supplier",
        "party": supplier,
        "company": company,
        "posting_date": posting_date,
        "mode_of_payment": _mode_of_payment(forma),
        "paid_from": paid_from,
        "paid_to": payable,
        "paid_from_account_currency": frappe.db.get_value("Account", paid_from, "account_currency") or currency,
        "paid_to_account_currency": frappe.db.get_value("Account", payable, "account_currency") or currency,
        "source_exchange_rate": 1,
        "target_exchange_rate": 1,
        # "Cheque/Reference No" es obligatorio y único en estos sitios
        # (Property Setter): efectivo sin referencia → una generada.
        "reference_no": reference_no or f"EFE-{frappe.generate_hash(length=8).upper()}",
        "reference_date": data.get("reference_date") or posting_date,
        "remarks": data.get("remarks") or "",
    })
    if pe.meta.has_field("facex_forma_pago"):
        pe.facex_forma_pago = forma

    allocated = 0.0
    for row in data.get("facturas") or []:
        amt = flt(row.get("amount"), 2)
        if amt <= 0:
            continue
        inv = _open_invoice(row.get("name"), company, supplier, is_return=0)
        if amt > flt(inv.outstanding_amount) + TOL:
            frappe.throw(f"{inv.name}: el saldo es {flt(inv.outstanding_amount):,.2f}; no se puede pagar {amt:,.2f}.")
        pe.append("references", {"reference_doctype": "Purchase Invoice", "reference_name": inv.name, "allocated_amount": amt})
        allocated += amt
    for row in data.get("notas") or []:
        amt = flt(row.get("amount"), 2)
        if amt <= 0:
            continue
        nc = _open_invoice(row.get("name"), company, supplier, is_return=1)
        if amt > abs(flt(nc.outstanding_amount)) + TOL:
            frappe.throw(f"{nc.name}: el crédito disponible es {abs(flt(nc.outstanding_amount)):,.2f}.")
        pe.append("references", {"reference_doctype": "Purchase Invoice", "reference_name": nc.name, "allocated_amount": -amt})
        allocated -= amt

    cost_center = frappe.db.get_value("Company", company, "cost_center")
    retenido = 0.0
    for r in data.get("retenciones") or []:
        amt = flt(r.get("amount"), 2)
        if amt <= 0:
            continue
        tipo = r.get("tipo")
        if tipo not in RETENCIONES or not cfg.get(RETENCIONES[tipo][1]):
            frappe.throw("Configure la cuenta de retención en FacEx Configuración Compañía → Pagos a Proveedores.")
        # Deducción negativa = HABER a la cuenta de retención por pagar.
        pe.append("deductions", {"account": cfg.get(RETENCIONES[tipo][1]), "cost_center": cost_center,
                                 "amount": -amt, "description": RETENCIONES[tipo][0]})
        retenido += amt
    if fee:
        if not cfg.get("pago_cuenta_cargos_bancarios"):
            frappe.throw("Configure la cuenta de Cargos Bancarios en FacEx Configuración Compañía → Pagos a Proveedores.")
        pe.append("deductions", {"account": cfg.get("pago_cuenta_cargos_bancarios"), "cost_center": cost_center,
                                 "amount": fee, "description": "Cargos bancarios"})

    if allocated < -TOL:
        frappe.throw("Las notas de crédito aplicadas no pueden superar las facturas pagadas.")
    # Lo que se cubre = entregado + retenido; lo que sobra queda como anticipo.
    if amount + retenido < allocated - TOL:
        frappe.throw(
            f"El monto entregado ({amount:,.2f}) más las retenciones ({retenido:,.2f}) no cubre lo aplicado "
            f"a facturas ({allocated:,.2f})."
        )
    if amount <= 0 and allocated <= TOL:
        frappe.throw("Indique el monto del pago o las facturas a pagar.")
    if amount <= 0:
        frappe.throw("El monto entregado debe ser mayor a cero. Para cruzar notas de crédito o anticipos "
                     "con facturas use «Aplicar crédito».")

    pe.paid_amount = amount + fee
    pe.received_amount = amount + fee
    pe.save(ignore_permissions=True)
    frappe.db.commit()
    return {"success": True, "name": pe.name, "unallocated_amount": flt(pe.unallocated_amount)}


def _open_invoice(name, company, supplier, is_return):
    inv = frappe.db.get_value(
        "Purchase Invoice", name,
        ["name", "company", "supplier", "docstatus", "is_return", "outstanding_amount"], as_dict=True,
    )
    if not inv or inv.company != company or inv.supplier != supplier or inv.docstatus != 1 \
            or int(inv.is_return) != is_return:
        frappe.throw(f"El documento {name} no es válido para este pago.")
    return inv


def _check_access(pe, company):
    if pe.company != company and frappe.session.user != "Administrator":
        frappe.throw("El pago pertenece a otra compañía.", frappe.PermissionError)
    if pe.payment_type != "Pay" or pe.party_type != "Supplier":
        frappe.throw(f"{pe.name} no es un pago a proveedor.")


def _get_pe(name):
    return frappe.get_doc("Payment Entry", (name or "").strip())


@frappe.whitelist()
def submit_payment(name: str) -> dict:
    pe = _get_pe(name)
    company = _require(pe.company, "validar")
    _check_access(pe, company)
    if pe.docstatus != 0:
        frappe.throw("El pago ya fue validado o cancelado.")
    pe.flags.ignore_permissions = True
    pe.submit()
    frappe.db.commit()
    return {"success": True, "name": pe.name}


@frappe.whitelist()
def cancel_payment(name: str) -> dict:
    pe = _get_pe(name)
    company = _require(pe.company, "cancelar")
    _check_access(pe, company)
    if pe.docstatus != 1:
        frappe.throw("Solo se pueden cancelar pagos validados.")
    pe.flags.ignore_permissions = True
    pe.cancel()
    frappe.db.commit()
    return {"success": True, "name": pe.name}


@frappe.whitelist()
def delete_payment(name: str) -> dict:
    pe = _get_pe(name)
    company = _require(pe.company, "grabar_borrador")
    _check_access(pe, company)
    if pe.docstatus != 0:
        frappe.throw("Solo se pueden eliminar pagos en borrador.")
    frappe.delete_doc("Payment Entry", pe.name, ignore_permissions=True)
    frappe.db.commit()
    return {"success": True}


# ---------------------------------------------------------------------------
# Lectura / lista
# ---------------------------------------------------------------------------

def _forma_of(pe) -> str:
    f = pe.get("facex_forma_pago")
    if f in FORMAS:
        return f
    mop_type = frappe.db.get_value("Mode of Payment", pe.mode_of_payment, "type") if pe.mode_of_payment else None
    return "efectivo" if mop_type == "Cash" else "transferencia"


@frappe.whitelist()
def get_payment(name: str, company: str = None) -> dict:
    company = _require(company)
    pe = _get_pe(name)
    _check_access(pe, company)
    d = pe.as_dict()
    d["forma"] = _forma_of(pe)
    d["owner_fullname"] = frappe.utils.get_fullname(pe.owner)
    v = pe.get("facex_validado_por")
    d["validado_por_fullname"] = frappe.utils.get_fullname(v) if v else ""
    d["supplier_name"] = frappe.db.get_value("Supplier", pe.party, "supplier_name")
    for r in d.get("references", []):
        if r.get("reference_doctype") == "Purchase Invoice":
            info = frappe.db.get_value("Purchase Invoice", r["reference_name"],
                                       ["bill_no", "is_return", "posting_date"], as_dict=True) or {}
            r.update(info)
    ret_accounts = {v2: k for k, v2 in ((k, _config(pe.company).get(v[1])) for k, v in RETENCIONES.items())}
    for x in d.get("deductions", []):
        x["tipo"] = ret_accounts.get(x.get("account"), "cargos" if flt(x.get("amount")) > 0 else "otra")
    return d


@frappe.whitelist()
def get_payment_list(company: str = None, start_date: str = None, end_date: str = None,
                     supplier: str = None, estado: str = None, limit: int = 200) -> list:
    company = _require(company)
    filters = [["company", "=", company], ["payment_type", "=", "Pay"], ["party_type", "=", "Supplier"]]
    if start_date and end_date:
        filters.append(["posting_date", "between", [start_date, end_date]])
    if supplier:
        filters.append(["party", "=", supplier])
    if estado not in (None, ""):
        filters.append(["docstatus", "=", int(estado)])
    from facex_multi.api.compras.common import is_own_scope
    if is_own_scope(company):
        filters.append(["owner", "=", frappe.session.user])
    rows = frappe.get_all(
        "Payment Entry", filters=filters,
        fields=["name", "party", "party_name", "posting_date", "paid_amount", "unallocated_amount",
                "total_allocated_amount", "mode_of_payment", "reference_no", "docstatus", "status", "owner"],
        order_by="posting_date desc, creation desc", limit=min(int(limit or 200), 500),
    )
    return rows


# ---------------------------------------------------------------------------
# Aplicar anticipos / notas de crédito a facturas (Conciliación nativa)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def apply_credit(company: str, supplier: str, credit_doctype: str, credit_name: str,
                 invoice: str, amount: float) -> dict:
    """Aplica un anticipo (Payment Entry) o una nota de crédito (Purchase
    Invoice de devolución) a una factura, sin mover dinero, con la
    Conciliación de Pagos de ERPNext."""
    company = _require(company, "validar",
                       msg="No tiene permiso para aplicar anticipos o notas de crédito.")
    amount = flt(amount, 2)
    if amount <= 0:
        frappe.throw("Indique el monto a aplicar.")
    _open_invoice(invoice, company, supplier, is_return=0)
    currency = frappe.db.get_value("Company", company, "default_currency")
    payable = get_payable_account(supplier, company, currency)

    pr = frappe.new_doc("Payment Reconciliation")
    pr.update({"company": company, "party_type": "Supplier", "party": supplier,
               "receivable_payable_account": payable})
    pr.get_unreconciled_entries()
    pay = [p.as_dict() for p in pr.payments if p.reference_type == credit_doctype and p.reference_name == credit_name]
    inv = [i.as_dict() for i in pr.invoices if i.invoice_number == invoice]
    if not pay:
        frappe.throw(f"{credit_name} no tiene crédito disponible para aplicar.")
    if not inv:
        frappe.throw(f"La factura {invoice} no tiene saldo pendiente.")
    if amount > flt(pay[0]["amount"]) + TOL:
        frappe.throw(f"El crédito disponible de {credit_name} es {flt(pay[0]['amount']):,.2f}.")
    if amount > flt(inv[0]["outstanding_amount"]) + TOL:
        frappe.throw(f"El saldo de {invoice} es {flt(inv[0]['outstanding_amount']):,.2f}.")
    # El tope se pone del lado de la factura: el monto del crédito debe
    # quedar igual a su saldo real (ERPNext lo usa para detectar cambios).
    inv[0]["outstanding_amount"] = amount
    pr.allocate_entries({"payments": pay, "invoices": inv})
    pr.reconcile()
    frappe.clear_messages()
    frappe.db.commit()
    return {"success": True, "outstanding": flt(frappe.db.get_value("Purchase Invoice", invoice, "outstanding_amount"))}


# ---------------------------------------------------------------------------
# Estado de cuenta del proveedor (libro mayor nativo)
# ---------------------------------------------------------------------------

VOUCHER_LABELS = {
    "Purchase Invoice": "Factura",
    "Payment Entry": "Pago",
    "Journal Entry": "Partida / Aplicación",
}


@frappe.whitelist()
def get_statement(supplier: str, company: str = None, start_date: str = None, end_date: str = None) -> dict:
    """Movimientos de la cuenta por pagar del proveedor (GL nativo): saldo
    inicial, cargos (facturas) / abonos (pagos, notas de crédito) y saldo."""
    company = _require(company)
    start_date = start_date or frappe.utils.get_first_day(today()).isoformat()
    end_date = end_date or today()
    params = {"company": company, "supplier": supplier, "start": start_date, "end": end_date}
    base = """company = %(company)s AND party_type = 'Supplier' AND party = %(supplier)s AND is_cancelled = 0"""
    opening = frappe.db.sql(f"SELECT SUM(credit - debit) FROM `tabGL Entry` WHERE {base} AND posting_date < %(start)s", params)[0][0]
    rows = frappe.db.sql(
        f"""SELECT posting_date, voucher_type, voucher_no, SUM(credit) AS cargo, SUM(debit) AS abono,
                   MIN(creation) AS creation
            FROM `tabGL Entry` WHERE {base} AND posting_date BETWEEN %(start)s AND %(end)s
            GROUP BY posting_date, voucher_type, voucher_no
            ORDER BY posting_date, creation""",
        params, as_dict=True,
    )
    saldo = flt(opening)
    for r in rows:
        extra = {}
        if r.voucher_type == "Purchase Invoice":
            extra = frappe.db.get_value("Purchase Invoice", r.voucher_no, ["bill_no", "is_return", "due_date"], as_dict=True) or {}
            r["tipo"] = "Nota de crédito" if extra.get("is_return") else "Factura"
        elif r.voucher_type == "Payment Entry":
            extra = frappe.db.get_value("Payment Entry", r.voucher_no, ["reference_no", "mode_of_payment"], as_dict=True) or {}
            r["tipo"] = "Pago"
        else:
            r["tipo"] = VOUCHER_LABELS.get(r.voucher_type, r.voucher_type)
        r.update(extra)
        # Un pago que además consume una nota de crédito trae cargo y abono:
        # se muestra neto (lo que realmente bajó la deuda).
        net = flt(r.cargo) - flt(r.abono)
        r["cargo"], r["abono"] = (net, 0.0) if net > 0 else (0.0, -net)
        saldo += net
        r["saldo"] = saldo
    return {
        "supplier": supplier,
        "supplier_name": frappe.db.get_value("Supplier", supplier, "supplier_name"),
        "supplier_tax_id": frappe.db.get_value("Supplier", supplier, "tax_id"),
        "company": company,
        "start_date": start_date,
        "end_date": end_date,
        "opening": flt(opening),
        "closing": saldo,
        "rows": rows,
        "open": get_open_documents(supplier, company),
    }


# ---------------------------------------------------------------------------
# Instalación (after_migrate)
# ---------------------------------------------------------------------------

def _ensure_series():
    from facex_multi.api.series import _options
    current = _options("Payment Entry")
    if PAGO_SERIES in current:
        return
    from frappe.custom.doctype.property_setter.property_setter import make_property_setter
    make_property_setter("Payment Entry", "naming_series", "options",
                         "\n".join(current + [PAGO_SERIES]), "Text")
    frappe.clear_cache(doctype="Payment Entry")


def ensure_pagos_setup():
    """after_migrate: serie PPR-.ABBR.- de los pagos a proveedores + campo
    de la forma de pago de FacEx en Payment Entry."""
    _ensure_series()
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields
    create_custom_fields({
        "Payment Entry": [{
            "fieldname": "facex_forma_pago", "label": "Forma de pago (FacEx Pagos)", "fieldtype": "Data",
            "insert_after": "mode_of_payment", "read_only": 1, "no_copy": 1, "print_hide": 1,
        }],
    }, update=True)
