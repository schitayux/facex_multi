"""Multimoneda en FacEx (2026-11-25).

Reglas (decididas con el usuario, ver memoria facex-multimoneda):

- Configuración por compañía en «FacEx Configuracion Compania»:
  `moneda_por_defecto` (en blanco = moneda de la compañía) y
  `monedas_permitidas` (en blanco = solo la por defecto). Una compañía con
  una sola moneda permitida NO es multimoneda y todo sigue como siempre.
- Cliente: `facex_moneda` (en blanco = la por defecto de la compañía) y
  `facex_multimoneda`. Sin multimoneda, el cliente solo se factura en su
  moneda; con multimoneda, en cualquiera de las permitidas. La cuenta por
  cobrar es SIEMPRE la de la compañía (GTQ): ERPNext no deja que un cliente
  tenga movimientos en cuentas de dos monedas, por eso la compañía
  multimoneda activa `allow_multi_currency_invoices_against_single_party_account`.
- Listas de precios: una lista por moneda, sin conversión. La moneda de la
  factura es la de su lista (se valida aquí, no se convierte).
- Tipo de cambio: referencia de Banguat del día de la factura, guardado en
  «Currency Exchange» (así ERPNext y cualquier reporte lo encuentran). Solo
  un usuario con `edita_tipo_cambio` puede escribir otro; la factura lo marca
  con `facex_tipo_cambio_manual`.
- NC/ND: heredan moneda y tipo de cambio de la factura de origen.
- La certificación FEL no se toca: las vistas v_bfel_* ya envían
  `si.currency` y los montos en la moneda de la factura.
"""
import re
from xml.etree import ElementTree as ET

import frappe
from frappe.utils import add_days, cint, flt, formatdate, getdate, today

CONFIG_DOCTYPE = "FacEx Configuracion Compania"

BANGUAT_URL = "https://www.banguat.gob.gt/variables/ws/TipoCambio.asmx"
BANGUAT_NS = "http://www.banguat.gob.gt/variables/ws/"
# Banguat publica directamente la referencia del dólar contra el quetzal.
BANGUAT_PAR = ("USD", "GTQ")


# ---------------------------------------------------------------------------
# Campos (after_migrate)
# ---------------------------------------------------------------------------

def ensure_moneda_fields():
    """Campos de multimoneda en Cliente y Factura de Venta. Idempotente."""
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    create_custom_fields(
        {
            "Customer": [
                {
                    "fieldname": "facex_moneda",
                    "fieldtype": "Link",
                    "options": "Currency",
                    "label": "Moneda de facturación",
                    "insert_after": "default_price_list",
                    "description": (
                        "En blanco = moneda por defecto de la compañía. Debe ser una de "
                        "las monedas permitidas en FacEx Configuración de Compañía."
                    ),
                    "module": "FacEx Multi",
                },
                {
                    "fieldname": "facex_multimoneda",
                    "fieldtype": "Check",
                    "label": "Multimoneda",
                    "insert_after": "facex_moneda",
                    "default": "0",
                    "description": (
                        "Marcado: se le puede cotizar y facturar en cualquier moneda "
                        "permitida de la compañía (arranca en su Moneda de facturación). "
                        "Sin marcar: solo en su Moneda de facturación."
                    ),
                    "module": "FacEx Multi",
                },
            ],
            "Sales Invoice": [
                {
                    "fieldname": "facex_tipo_cambio_manual",
                    "fieldtype": "Check",
                    "label": "Tipo de cambio manual (FacEx)",
                    "insert_after": "conversion_rate",
                    "default": "0",
                    "read_only": 1,
                    "no_copy": 1,
                    "print_hide": 1,
                    "description": (
                        "Marcado cuando un usuario con permiso «Editar Tipo de Cambio» "
                        "escribió el tipo de cambio. Sin marcar = referencia Banguat del día."
                    ),
                    "module": "FacEx Multi",
                },
            ],
        }
    )


# ---------------------------------------------------------------------------
# Configuración por compañía
# ---------------------------------------------------------------------------

def company_currency(company: str) -> str:
    return (company and frappe.get_cached_value("Company", company, "default_currency")) or "GTQ"


def get_currency_config(company: str) -> dict:
    """{"compania": GTQ, "por_defecto": GTQ, "permitidas": [GTQ, USD], "multimoneda": bool}.

    Sin configuración (o sin migrar) → solo la moneda de la compañía."""
    base = company_currency(company)
    default, extra = base, []
    meta = frappe.get_meta(CONFIG_DOCTYPE) if frappe.db.table_exists(CONFIG_DOCTYPE) else None
    if company and meta and meta.has_field("moneda_por_defecto") and frappe.db.exists(CONFIG_DOCTYPE, company):
        default = frappe.db.get_value(CONFIG_DOCTYPE, company, "moneda_por_defecto") or base
        if frappe.db.table_exists("FacEx Moneda Permitida"):
            extra = frappe.get_all(
                "FacEx Moneda Permitida",
                filters={"parent": company, "parenttype": CONFIG_DOCTYPE},
                pluck="moneda",
                order_by="idx asc",
            )
    permitidas = []
    # Solo hay multimoneda si se listan monedas: en blanco = solo la por defecto.
    for c in [default] + ([base] if extra else []) + list(extra):
        if c and c not in permitidas:
            permitidas.append(c)
    return {
        "compania": base,
        "por_defecto": default,
        "permitidas": permitidas,
        "multimoneda": len(permitidas) > 1,
    }


def validate_company_config(doc, method=None):
    """Hook validate de FacEx Configuracion Compania: la moneda por defecto
    tiene que estar entre las permitidas (si se listan)."""
    if not doc.meta.has_field("monedas_permitidas"):
        return
    listadas = [r.moneda for r in (doc.get("monedas_permitidas") or []) if r.moneda]
    base = company_currency(doc.company or doc.name)
    default = doc.get("moneda_por_defecto") or base
    if listadas and default not in listadas:
        frappe.throw(
            f"La moneda por defecto <b>{default}</b> debe estar entre las monedas permitidas.",
            title="Monedas",
        )
    if default != base and not listadas:
        frappe.throw(
            f"La moneda por defecto <b>{default}</b> no es la de la compañía ({base}): "
            f"liste también las monedas permitidas, incluida {base}.",
            title="Monedas",
        )


def on_update_company_config(doc, method=None):
    """Compañía multimoneda → ERPNext debe aceptar facturas en otra moneda contra
    la cuenta por cobrar en la moneda de la compañía (decisión: CxC siempre GTQ).
    Es un ajuste de todo el sitio; no cambia nada para las compañías de una sola
    moneda. Nunca se apaga solo (podría haber facturas ya emitidas así)."""
    if not get_currency_config(doc.company or doc.name)["multimoneda"]:
        return
    field = "allow_multi_currency_invoices_against_single_party_account"
    if not frappe.get_meta("Accounts Settings").has_field(field):
        return
    if not cint(frappe.db.get_single_value("Accounts Settings", field)):
        frappe.db.set_single_value("Accounts Settings", field, 1)
        frappe.msgprint(
            "Se activó en Configuración de Contabilidad «Permitir facturas multimoneda contra "
            "una sola cuenta de tercero»: la cuenta por cobrar sigue en la moneda de la compañía.",
            alert=True,
        )


# ---------------------------------------------------------------------------
# Tipo de cambio (Banguat → Currency Exchange)
# ---------------------------------------------------------------------------

def _banguat_rango(desde, hasta) -> dict:
    """{fecha: tasa} de Banguat (TipoCambioRango) entre dos fechas, ambas incluidas."""
    import requests

    body = (
        '<?xml version="1.0" encoding="utf-8"?>'
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>'
        f'<TipoCambioRango xmlns="{BANGUAT_NS}">'
        f"<fechainit>{getdate(desde).strftime('%d/%m/%Y')}</fechainit>"
        f"<fechafin>{getdate(hasta).strftime('%d/%m/%Y')}</fechafin>"
        "</TipoCambioRango></soap:Body></soap:Envelope>"
    )
    resp = requests.post(
        BANGUAT_URL,
        data=body.encode("utf-8"),
        headers={
            "Content-Type": "text/xml; charset=utf-8",
            "SOAPAction": f'"{BANGUAT_NS}TipoCambioRango"',
        },
        timeout=20,
    )
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    out = {}
    for var in root.iter(f"{{{BANGUAT_NS}}}Var"):
        moneda = (var.findtext(f"{{{BANGUAT_NS}}}moneda") or "").strip()
        fecha = (var.findtext(f"{{{BANGUAT_NS}}}fecha") or "").strip()
        tasa = flt(var.findtext(f"{{{BANGUAT_NS}}}venta"))
        if moneda != "2" or not re.match(r"^\d{2}/\d{2}/\d{4}$", fecha) or tasa <= 0:
            continue
        d, m, y = fecha.split("/")
        out[getdate(f"{y}-{m}-{d}")] = tasa
    return out


def _guardar_tasa(fecha, tasa) -> None:
    """Currency Exchange USD→GTQ de la fecha (para venta y compra). Idempotente:
    si ya existe la fecha, solo se corrige la tasa si cambió."""
    from_c, to_c = BANGUAT_PAR
    existente = frappe.db.get_value(
        "Currency Exchange",
        {"date": fecha, "from_currency": from_c, "to_currency": to_c},
        ["name", "exchange_rate"],
        as_dict=True,
    )
    if existente:
        if abs(flt(existente.exchange_rate) - flt(tasa)) > 1e-9:
            frappe.db.set_value("Currency Exchange", existente.name, "exchange_rate", tasa)
        return
    ce = frappe.new_doc("Currency Exchange")
    ce.date = fecha
    ce.from_currency = from_c
    ce.to_currency = to_c
    ce.exchange_rate = tasa
    ce.for_buying = 1
    ce.for_selling = 1
    ce.insert(ignore_permissions=True)


def sincronizar_banguat(dias: int = 7, hasta=None) -> int:
    """Trae de Banguat los últimos `dias` hasta `hasta` (hoy) y los guarda en
    Currency Exchange. Devuelve cuántas fechas se recibieron."""
    hasta = getdate(hasta or today())
    tasas = _banguat_rango(add_days(hasta, -(cint(dias) or 1) + 1), hasta)
    for fecha, tasa in tasas.items():
        _guardar_tasa(fecha, tasa)
    return len(tasas)


def sincronizar_banguat_diario():
    """scheduler (hourly): se corre cada hora para tener la tasa del día apenas
    Banguat la publica. Solo trabaja si alguna compañía del sitio usa USD."""
    if not _sitio_usa_usd():
        return
    try:
        sincronizar_banguat(dias=7)
        frappe.db.commit()
    except Exception:
        frappe.db.rollback()
        frappe.log_error(title="FacEx: tipo de cambio Banguat")


def _sitio_usa_usd() -> bool:
    if not frappe.db.table_exists("FacEx Moneda Permitida"):
        return False
    return bool(frappe.db.exists("FacEx Moneda Permitida", {"moneda": BANGUAT_PAR[0]}))


def get_tipo_cambio(moneda: str, a_moneda: str, fecha=None) -> float:
    """Tipo de cambio `moneda`→`a_moneda` vigente en `fecha`.

    USD→GTQ: la tasa Banguat de esa fecha exacta (Banguat publica todos los
    días, incluidos fines de semana). Si falta en Currency Exchange se pide a
    Banguat en el momento. Otras monedas: lo que ERPNext tenga configurado.
    Devuelve 0 si no hay tasa."""
    if not moneda or not a_moneda or moneda == a_moneda:
        return 1.0
    fecha = getdate(fecha or today())
    if (moneda, a_moneda) == BANGUAT_PAR:
        filtro = {"date": fecha, "from_currency": moneda, "to_currency": a_moneda}
        tasa = flt(frappe.db.get_value("Currency Exchange", filtro, "exchange_rate"))
        if tasa > 0:
            return tasa
        if fecha <= getdate(today()):
            try:
                tasas = _banguat_rango(add_days(fecha, -6), fecha)
                for f, t in tasas.items():
                    _guardar_tasa(f, t)
                if tasas.get(fecha):
                    return flt(tasas[fecha])
            except Exception:
                frappe.log_error(title="FacEx: tipo de cambio Banguat")
        # Sin respuesta de Banguat: la última tasa guardada de los 7 días previos.
        previa = frappe.get_all(
            "Currency Exchange",
            filters={
                "from_currency": moneda,
                "to_currency": a_moneda,
                "date": ["between", [add_days(fecha, -7), fecha]],
            },
            fields=["exchange_rate"],
            order_by="date desc",
            limit=1,
        )
        return flt(previa[0].exchange_rate) if previa else 0.0
    from erpnext.setup.utils import get_exchange_rate

    return flt(get_exchange_rate(moneda, a_moneda, fecha, "for_selling"))


@frappe.whitelist()
def get_tipo_cambio_venta(company: str = None, moneda: str = None, fecha: str = None) -> dict:
    """Para el facturador: tipo de cambio de `moneda` a la moneda de la compañía."""
    from facex_multi.api.invoice import get_effective_company, has_efast_permission

    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    company = get_effective_company(company)
    base = company_currency(company)
    moneda = moneda or base
    tasa = get_tipo_cambio(moneda, base, fecha)
    frappe.db.commit()  # tasa traída de Banguat queda guardada
    return {
        "moneda": moneda,
        "moneda_compania": base,
        "fecha": str(getdate(fecha or today())),
        "tipo_cambio": tasa,
        "fuente": "Banguat" if (moneda, base) == BANGUAT_PAR else "ERPNext",
    }


# ---------------------------------------------------------------------------
# Cliente
# ---------------------------------------------------------------------------

def customer_currency_rule(customer: str, company: str, cfg: dict = None) -> dict:
    """{"moneda": X, "multimoneda": bool, "permitidas": [...]} del cliente."""
    cfg = cfg or get_currency_config(company)
    row = {}
    if customer and frappe.get_meta("Customer").has_field("facex_moneda"):
        row = frappe.db.get_value(
            "Customer", customer, ["facex_moneda", "facex_multimoneda"], as_dict=True
        ) or {}
    moneda = row.get("facex_moneda") or cfg["por_defecto"]
    multi = bool(cint(row.get("facex_multimoneda"))) and cfg["multimoneda"]
    return {
        "moneda": moneda,
        "multimoneda": multi,
        "permitidas": list(cfg["permitidas"]) if multi else [moneda],
    }


@frappe.whitelist()
def get_customer_currency(customer: str, company: str = None) -> dict:
    from facex_multi.api.invoice import get_effective_company, has_efast_permission

    if not has_efast_permission():
        frappe.throw("No tiene permisos para realizar esta acción.", frappe.PermissionError)
    regla = customer_currency_rule(customer, get_effective_company(company))
    lista = frappe.db.get_value("Customer", customer, "default_price_list") if customer else ""
    regla["lista"] = lista or ""
    regla["lista_moneda"] = (lista and frappe.db.get_value("Price List", lista, "currency")) or ""
    return regla


def validate_customer_moneda(doc, method=None):
    """Hook validate de Customer (llamado desde customer.validate_customer_on_save)."""
    if not doc.meta.has_field("facex_moneda"):
        return
    company = doc.get("bfel_company")
    if not company:
        return
    cfg = get_currency_config(company)
    if doc.get("facex_moneda") == cfg["por_defecto"] and not cfg["multimoneda"]:
        doc.facex_moneda = ""
    if not cfg["multimoneda"]:
        if doc.get("facex_moneda"):
            frappe.throw(
                f"La compañía {company} solo factura en {cfg['por_defecto']}: "
                f"deje en blanco la Moneda de facturación del cliente."
            )
        doc.facex_multimoneda = 0
        return
    moneda = doc.get("facex_moneda") or cfg["por_defecto"]
    if moneda not in cfg["permitidas"]:
        frappe.throw(
            f"La moneda {moneda} no está permitida en {company} "
            f"(permitidas: {', '.join(cfg['permitidas'])})."
        )
    if doc.get("default_price_list"):
        plc = frappe.db.get_value("Price List", doc.default_price_list, "currency")
        if plc and plc != moneda:
            frappe.throw(
                f"La Lista de Precios «{doc.default_price_list}» está en {plc} y la Moneda de "
                f"facturación del cliente es {moneda}: elija una lista en {moneda}."
            )


# ---------------------------------------------------------------------------
# Lista de precios
# ---------------------------------------------------------------------------

def validate_price_list(doc, method=None):
    """Hook validate de Price List: una lista de venta de una compañía solo puede
    estar en una moneda permitida para esa compañía."""
    company = doc.get("bfel_company")
    if not company or not cint(doc.get("selling")):
        return
    cfg = get_currency_config(company)
    if doc.currency and doc.currency not in cfg["permitidas"]:
        frappe.throw(
            f"La moneda {doc.currency} no está permitida en {company} "
            f"(permitidas: {', '.join(cfg['permitidas'])}). Configúrela en FacEx "
            f"Configuración de Compañía → Monedas."
        )


# ---------------------------------------------------------------------------
# Factura de venta (cotización = borrador)
# ---------------------------------------------------------------------------

def _fecha_tipo_cambio(doc):
    """Fecha que manda para el tipo de cambio: la de emisión si es postfechada
    (set_posting_time) y hoy si no — ERPNext estampa hoy al validar."""
    if cint(doc.get("set_posting_time")) and doc.get("posting_date"):
        return getdate(doc.posting_date)
    return getdate(today())


def sales_invoice_before_validate(doc, method=None):
    """Hook before_validate de Sales Invoice (antes de que ERPNext calcule los
    montos en moneda de la compañía): fija moneda y tipo de cambio.

    Carga histórica (si_carga, flags.facex_cierre_bypass) no se toca."""
    if doc.docstatus == 2 or doc.flags.get("facex_cierre_bypass"):
        return
    if not doc.company:
        return
    base = company_currency(doc.company)
    has_manual = doc.meta.has_field("facex_tipo_cambio_manual")

    # NC / ND: misma moneda y tipo de cambio que la factura de origen.
    if doc.get("return_against"):
        o = frappe.db.get_value(
            "Sales Invoice", doc.return_against, ["currency", "conversion_rate"], as_dict=True
        )
        if o and o.currency:
            doc.currency = o.currency
            doc.conversion_rate = flt(o.conversion_rate) or 1.0
            if doc.get("selling_price_list"):
                plc = frappe.db.get_value("Price List", doc.selling_price_list, "currency")
                if plc == o.currency:
                    doc.plc_conversion_rate = doc.conversion_rate
            return

    cfg = get_currency_config(doc.company)
    moneda = doc.get("currency") or cfg["por_defecto"]

    if not cfg["multimoneda"]:
        # Compañía de una sola moneda: como siempre (no se cambia nada que ya
        # estuviera bien, solo se impide facturar en otra moneda).
        if moneda != cfg["por_defecto"] and doc.docstatus == 0:
            frappe.throw(
                f"La compañía {doc.company} solo factura en {cfg['por_defecto']}.",
                title="Moneda no permitida",
            )
        return

    doc.currency = moneda
    if moneda not in cfg["permitidas"]:
        frappe.throw(
            f"La moneda {moneda} no está permitida en {doc.company} "
            f"(permitidas: {', '.join(cfg['permitidas'])}).",
            title="Moneda no permitida",
        )

    if doc.get("customer"):
        regla = customer_currency_rule(doc.customer, doc.company, cfg)
        if moneda not in regla["permitidas"]:
            frappe.throw(
                f"Al cliente {doc.get('customer_name') or doc.customer} solo se le factura en "
                f"{', '.join(regla['permitidas'])}.",
                title="Moneda del cliente",
            )

    if doc.get("selling_price_list"):
        plc = frappe.db.get_value("Price List", doc.selling_price_list, "currency")
        if plc and plc != moneda:
            frappe.throw(
                f"La Lista de Precios «{doc.selling_price_list}» está en {plc} y la factura en "
                f"{moneda}. Elija una lista en {moneda}.",
                title="Lista de precios",
            )

    if moneda == base:
        doc.conversion_rate = 1.0
        doc.plc_conversion_rate = 1.0
        if has_manual:
            doc.facex_tipo_cambio_manual = 0
        return

    manual = has_manual and cint(doc.get("facex_tipo_cambio_manual")) and flt(doc.conversion_rate) > 0
    if manual:
        from facex_multi.api.permissions import get_facex_can_edit_exchange_rate

        if not get_facex_can_edit_exchange_rate(doc.company):
            # Sin permiso solo se conserva un tipo manual que ya estaba grabado
            # (lo puso otro usuario autorizado) y que no se cambió.
            prev = None if doc.is_new() else frappe.db.get_value(
                "Sales Invoice", doc.name, ["conversion_rate", "facex_tipo_cambio_manual"], as_dict=True
            )
            if not (prev and cint(prev.facex_tipo_cambio_manual)
                    and abs(flt(prev.conversion_rate) - flt(doc.conversion_rate)) < 1e-9):
                manual = False
    if not manual:
        fecha = _fecha_tipo_cambio(doc)
        tasa = get_tipo_cambio(moneda, base, fecha)
        if tasa <= 0:
            frappe.throw(
                f"No hay tipo de cambio {moneda}→{base} para el {formatdate(fecha)} "
                f"(Banguat no respondió). Intente de nuevo en unos minutos.",
                title="Tipo de cambio",
            )
        doc.conversion_rate = tasa
        if has_manual:
            doc.facex_tipo_cambio_manual = 0
    # Lista en la misma moneda de la factura: precio de lista = precio de venta.
    doc.plc_conversion_rate = doc.conversion_rate
