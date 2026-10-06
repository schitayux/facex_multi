# -*- coding: utf-8 -*-
"""Enviar por WhatsApp (2026-10-06).

Tres capas, todas deben cumplirse para que un usuario vea el botón:
  1. Compañía: FacEx Configuracion Compania → `wa_habilitado`.
  2. Compañía: el documento está «Activo» en su grid `wa_documentos`
     (mensaje y «Adjuntar impresión» también viven ahí).
  3. Usuario: FacEx Settings / Perfil → `wa_factura`, `wa_cotizacion`, `wa_pago`.

El botón abre WhatsApp (wa.me) con el texto listo. WhatsApp no deja adjuntar un
archivo por enlace, así que el PDF del formato de impresión viaja como un
enlace temporal con clave (7 días) — ver `create_link` / `pdf`. En celular el
diálogo ofrece además el menú de compartir del teléfono con el PDF real.

Tipos de documento:
  * factura    — Sales Invoice validada. Si está certificada en FEL («01 Enviar» +
                 UUID) es «factura» y lleva el enlace de verificación de la SAT; si no,
                 es solo un «recibo de compra».
  * cotizacion — Sales Invoice en borrador.
  * pago       — Recibo de pago de una Sales Invoice con pagos registrados.
"""
import re
import secrets

import frappe
from frappe import _
from frappe.rate_limiter import rate_limit
from frappe.utils import add_to_date, cint, flt, fmt_money, formatdate, get_url, now_datetime

CONFIG_DOCTYPE = "FacEx Configuracion Compania"
LINK_DOCTYPE = "FacEx WA Enlace"
LINK_DAYS = 7

# tipo → (etiqueta del grid, campo de permiso del usuario)
TIPOS = {
    "factura": ("Factura validada", "wa_factura"),
    "cotizacion": ("Cotización", "wa_cotizacion"),
    "pago": ("Pago recibido", "wa_pago"),
}

DEFAULT_MESSAGES = {
    "Factura validada": (
        "Gracias estimado {cliente} por hacer tu compra hoy. Te compartimos tu {tipo_doc} {documento} "
        "por {total}. Agradecemos tu confianza. — {empresa}"
    ),
    "Cotización": (
        "Estimado {cliente}, te compartimos la cotización {documento} por {total} con fecha {fecha}. "
        "Quedamos atentos a tu confirmación. — {empresa}"
    ),
    "Pago recibido": (
        "Estimado {cliente}, confirmamos el recibo de tu pago por {monto} de la compra {documento}. "
        "Saldo pendiente: {saldo}. Gracias por tu confianza. — {empresa}"
    ),
}


# ---------------------------------------------------------------------------
# Configuración y permisos
# ---------------------------------------------------------------------------

def ensure_default_rows(doc):
    """Config de Compañía: con WhatsApp habilitado el grid tiene siempre sus tres
    documentos (con el mensaje sugerido) para que el administrador solo marque."""
    if not doc.get("wa_habilitado"):
        return
    have = {r.tipo for r in doc.get("wa_documentos") or []}
    for label, _perm in TIPOS.values():
        if label not in have:
            doc.append("wa_documentos", {
                "tipo": label, "activo": 1, "adjuntar_pdf": 1, "mensaje": DEFAULT_MESSAGES[label],
            })


def _company_wa(company: str) -> dict:
    """{tipo: {mensaje, adjuntar}} de lo activo en la compañía ({} si está apagado)."""
    if not company or not frappe.db.table_exists(CONFIG_DOCTYPE):
        return {}
    if not frappe.get_meta(CONFIG_DOCTYPE).has_field("wa_habilitado"):
        return {}
    if not cint(frappe.db.get_value(CONFIG_DOCTYPE, company, "wa_habilitado")):
        return {}
    rows = frappe.get_all(
        "FacEx WA Documento", filters={"parent": company, "parenttype": CONFIG_DOCTYPE},
        fields=["tipo", "activo", "adjuntar_pdf", "mensaje"],
    )
    by_label = {r.tipo: r for r in rows}
    out = {}
    for key, (label, _perm) in TIPOS.items():
        r = by_label.get(label)
        if r and cint(r.activo):
            out[key] = {"mensaje": r.mensaje or DEFAULT_MESSAGES[label], "adjuntar": cint(r.adjuntar_pdf)}
    return out


def is_company_wa_on(company: str) -> bool:
    return bool(_company_wa(company))


def get_wa_for_user(company: str) -> dict:
    """Lo que ESTE usuario puede enviar por WhatsApp en `company`:
    {tipo: {mensaje, adjuntar}}. Vacío = ningún botón. Va dentro de get_defaults."""
    from facex_multi.api.permissions import _flag  # permiso deny-by-default (System Manager siempre)
    company_wa = _company_wa(company)
    return {k: v for k, v in company_wa.items() if _flag(company, TIPOS[k][1])}


def _require_wa(company: str, tipo: str) -> dict:
    if tipo not in TIPOS:
        frappe.throw(_("Tipo de documento desconocido."))
    cfg = get_wa_for_user(company).get(tipo)
    if not cfg:
        frappe.throw(_("No tiene habilitado enviar «{0}» por WhatsApp.").format(TIPOS[tipo][0]), frappe.PermissionError)
    return cfg


# ---------------------------------------------------------------------------
# Documento
# ---------------------------------------------------------------------------

def _load_invoice(name: str, tipo: str):
    doc = frappe.get_doc("Sales Invoice", (name or "").strip())
    if not frappe.db.exists("Sales Invoice", doc.name):
        frappe.throw(_("La factura no existe."))
    doc.check_permission("read")
    cfg = _require_wa(doc.company, tipo)

    # Mismo alcance que los reportes de ventas (Solo lo creado por mí / clientes del vendedor).
    from facex_multi.api.permissions import get_facex_sales_scope_sql
    cond, params = get_facex_sales_scope_sql(doc.company, alias="si")
    if cond and not frappe.db.sql(
        f"SELECT 1 FROM `tabSales Invoice` si WHERE si.name = %(n)s AND {cond}", {"n": doc.name, **params}
    ):
        frappe.throw(_("La factura no está a su alcance."), frappe.PermissionError)

    if doc.docstatus == 2 or cint(doc.get("bfel_documento_anulado")):
        frappe.throw(_("El documento está cancelado/anulado."))
    if tipo == "factura" and doc.docstatus != 1:
        frappe.throw(_("Solo se envían facturas validadas."))
    if tipo == "cotizacion" and doc.docstatus != 0:
        frappe.throw(_("Solo se envían como cotización las facturas en borrador."))
    if tipo == "pago" and not _paid_amount(doc):
        frappe.throw(_("La factura no tiene pagos registrados."))
    return doc, cfg


def _paid_amount(doc) -> float:
    return sum(flt(p.amount) for p in (doc.get("custom_efast_payments") or []))


def _is_certified(doc) -> bool:
    return bool(doc.get("bfel_uuid")) and doc.get("bfel_status") == "02 Procesada"


def _tipo_doc_label(doc, tipo: str) -> str:
    if tipo == "cotizacion":
        return "cotización"
    if tipo == "pago":
        return "recibo de pago"
    return "factura" if _is_certified(doc) else "recibo de compra"


def _phone(doc) -> str:
    """Teléfono de contacto de la factura → ficha del cliente → contacto principal."""
    for val in (doc.get("contact_mobile"), doc.get("contact_phone")):
        if val:
            return str(val)
    cust = frappe.db.get_value("Customer", doc.customer, ["mobile_no"], as_dict=True) or {}
    if cust.get("mobile_no"):
        return str(cust["mobile_no"])
    rows = frappe.db.sql(
        """
        SELECT c.mobile_no, c.phone FROM `tabContact` c
        JOIN `tabDynamic Link` dl ON dl.parent = c.name AND dl.parenttype = 'Contact'
        WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s
        ORDER BY c.is_primary_contact DESC, c.modified DESC LIMIT 1
        """, doc.customer, as_dict=True,
    )
    if rows and (rows[0].mobile_no or rows[0].phone):
        return str(rows[0].mobile_no or rows[0].phone)
    # Teléfonos de la tabla del contacto (aunque ninguno esté marcado como principal).
    extra = frappe.db.sql(
        """
        SELECT cp.phone FROM `tabContact Phone` cp
        JOIN `tabDynamic Link` dl ON dl.parent = cp.parent AND dl.parenttype = 'Contact'
        WHERE dl.link_doctype = 'Customer' AND dl.link_name = %s AND IFNULL(cp.phone, '') != ''
        ORDER BY cp.is_primary_mobile_no DESC, cp.is_primary_phone DESC, cp.idx ASC LIMIT 1
        """, doc.customer,
    )
    return str(extra[0][0]) if extra else ""


def _render(template: str, values: dict) -> str:
    out = template or ""
    for k, v in values.items():
        out = out.replace("{" + k + "}", str(v))
    return out


def _print_format(company: str, tipo: str) -> str:
    from facex_multi.api.invoice import get_print_formats
    formats = get_print_formats(company) or []
    up = lambda f: f.upper()  # noqa: E731
    if tipo == "cotizacion":
        pick = next((f for f in formats if "COTI" in up(f)), "")
    elif tipo == "pago":
        pick = next((f for f in formats if "RECI" in up(f)), "") or "Recibo de Pago FacEx"
    else:
        pick = next((f for f in formats if "CERTIFI" in up(f)), "") or next((f for f in formats if "FEL" in up(f)), "")
    return pick


def _sat_url(doc):
    if not _is_certified(doc):
        return ""
    from facex_multi.api.invoice import get_fel_verification_url
    try:
        return get_fel_verification_url(doc.name)
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# API para las pantallas
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_context(invoice: str, tipo: str) -> dict:
    """Datos del diálogo «Enviar por WhatsApp»: teléfono, mensaje ya con las
    variables resueltas y si se adjunta la impresión."""
    doc, cfg = _load_invoice(invoice, tipo)
    currency = doc.currency or frappe.get_cached_value("Company", doc.company, "default_currency")
    money = lambda v: fmt_money(flt(v), currency=currency)  # noqa: E731
    pagado = _paid_amount(doc)
    saldo = max(flt(doc.grand_total) - pagado, 0) if doc.docstatus == 1 or pagado else flt(doc.grand_total)
    values = {
        "cliente": doc.get("bfel_nombre") or doc.get("customer_name") or doc.customer,
        "documento": doc.name,
        "tipo_doc": _tipo_doc_label(doc, tipo),
        "total": money(doc.grand_total),
        "saldo": money(saldo),
        "monto": money(pagado),
        "fecha": formatdate(doc.posting_date),
        "empresa": frappe.get_cached_value("Company", doc.company, "company_name") or doc.company,
    }
    return {
        "invoice": doc.name,
        "tipo": tipo,
        "phone": _phone(doc),
        "message": _render(cfg["mensaje"], values),
        "attach": cint(cfg["adjuntar"]),
        "sat_url": _sat_url(doc) if tipo == "factura" else "",
        "tipo_doc": values["tipo_doc"],
        "dias": LINK_DAYS,
    }


@frappe.whitelist()
def create_link(invoice: str, tipo: str) -> dict:
    """Enlace temporal (7 días) al PDF del documento con su formato de impresión."""
    doc, cfg = _load_invoice(invoice, tipo)
    if not cint(cfg["adjuntar"]):
        frappe.throw(_("Este documento no tiene activo «Adjuntar impresión»."))
    fmt = _print_format(doc.company, tipo)
    if not fmt:
        frappe.throw(_("La compañía no tiene un formato de impresión para este documento."))
    token = secrets.token_urlsafe(24)
    expires = add_to_date(now_datetime(), days=LINK_DAYS)
    link = frappe.get_doc({
        "doctype": LINK_DOCTYPE, "token": token, "company": doc.company, "tipo": tipo,
        "reference_doctype": "Sales Invoice", "reference_name": doc.name,
        "print_format": fmt, "expires_on": expires, "creado_por": frappe.session.user,
    })
    link.insert(ignore_permissions=True)
    frappe.db.commit()
    return {
        "url": get_url(f"/api/method/facex_multi.api.whatsapp.pdf?t={token}"),
        "expires_on": str(expires),
        "print_format": fmt,
    }


@frappe.whitelist(allow_guest=True)
@rate_limit(limit=60, seconds=60)
def pdf(t: str = ""):
    """Descarga pública del PDF con un token vigente (el cliente final no tiene
    cuenta). El token es largo y aleatorio, vence a los 7 días y se desactiva si
    el documento se cancela."""
    t = (t or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_\-]{20,64}", t):
        frappe.throw(_("Enlace no válido."), frappe.DoesNotExistError)
    row = frappe.db.get_value(
        LINK_DOCTYPE, t, ["reference_doctype", "reference_name", "print_format", "expires_on"], as_dict=True,
    )
    if not row or row.expires_on < now_datetime():
        frappe.throw(_("El enlace venció o no existe."), frappe.DoesNotExistError)
    if frappe.db.get_value(row.reference_doctype, row.reference_name, "docstatus") in (None, 2):
        frappe.throw(_("El documento ya no está vigente."), frappe.DoesNotExistError)

    frappe.db.sql(f"UPDATE `tab{LINK_DOCTYPE}` SET accesos = accesos + 1 WHERE name = %s", t)
    frappe.db.commit()
    # El token ya autorizó el documento: se omite la validación de permisos de
    # impresión. OJO: nunca frappe.set_user() aquí — cambia session.sid y la
    # respuesta reescribe la cookie del navegador que abre el enlace (deja al
    # usuario de FacEx deslogueado si el enlace se abre en su propio navegador).
    frappe.flags.ignore_print_permissions = True
    try:
        content = frappe.get_print(row.reference_doctype, row.reference_name, row.print_format, as_pdf=True)
    finally:
        frappe.flags.ignore_print_permissions = False
    frappe.local.response.filename = f"{row.reference_name}.pdf"
    frappe.local.response.filecontent = content
    frappe.local.response.type = "pdf"


def purge_expired_links():
    """Scheduler diario: borra enlaces vencidos hace más de 30 días."""
    frappe.db.delete(LINK_DOCTYPE, {"expires_on": ["<", add_to_date(now_datetime(), days=-30)]})
