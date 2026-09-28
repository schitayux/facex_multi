"""
facex_multi.api.series
----------------------
Series de numeración por tipo de documento (Factura, Nota de Crédito,
Nota de Débito, Recibo de Pago).

Dónde se configuran (grid «FacEx Serie Documento»):
  1. FacEx Settings del usuario+compañía  → series permitidas + una por defecto.
  2. FacEx Configuracion Compania         → lo mismo para quien no tiene propias.
  3. Ninguna de las dos para ese tipo      → comportamiento heredado: todas las
     series compatibles, la primera es la por defecto.
La resolución es por tipo: un usuario puede tener propia la Factura y heredar
de la compañía el Recibo.

En FEL el prefijo de la serie ES el tipo DTE que se certifica (la vista SQL
hace `ifnull(dm.type_docdte, left(si.name, 4))`), así que la regla
tipo ↔ prefijo se valida en el servidor para todo Sales Invoice que se
inserte, venga de FacEx, del Desk, de la carga masiva o de la API.
"""
from __future__ import annotations

import re

import frappe

TIPO_FACTURA = "Factura"
TIPO_NC = "Nota de Crédito"
TIPO_ND = "Nota de Débito"
TIPO_RECIBO = "Recibo de Pago"

TIPO_DOCTYPE = {
    TIPO_FACTURA: "Sales Invoice",
    TIPO_NC: "Sales Invoice",
    TIPO_ND: "Sales Invoice",
    TIPO_RECIBO: "Payment Entry",
}

# Prefijo DTE obligatorio para los documentos de ajuste.
PREFIJO_AJUSTE = {TIPO_NC: "NCRE", TIPO_ND: "NDEB"}
# Tipos DTE de la SAT que NO son una factura de venta: una «Factura» nunca
# puede usar estas series.
DTE_NO_FACTURA = {"NCRE", "NDEB", "NABN", "RDON", "RECI"}
# Tipos DTE de factura: una NC/ND nunca puede usar estas series.
DTE_FACTURA = {"FACT", "FCAM", "FPEQ", "FCAP", "FESP", "FAPE", "FCPE", "FAAE", "FACA", "FCCA"}

CHILD_DOCTYPE = "FacEx Serie Documento"
CONFIG_DOCTYPE = "FacEx Configuracion Compania"


def prefijo(series: str) -> str:
    """"FACT-.ABBR.-.####" → "FACT"."""
    parts = re.split(r"[-._/ ]", (series or "").strip())
    return parts[0].upper() if parts else ""


def tipo_de_factura(doc) -> str:
    if int(doc.get("is_return") or 0):
        return TIPO_NC
    if int(doc.get("is_debit_note") or 0):
        return TIPO_ND
    return TIPO_FACTURA


def _abbr(company: str) -> str:
    return (frappe.db.get_value("Company", company, "abbr") or "") if company else ""


def _norm(series: str, company: str) -> str:
    """Compara plantilla y serie resuelta por igual (".ABBR." → abreviatura)."""
    series = (series or "").strip()
    abbr = _abbr(company)
    return series.replace(".ABBR.", f".{abbr}.") if abbr else series


def _options(doctype: str) -> list:
    from facex_multi.api.invoice import _get_naming_series
    return _get_naming_series(doctype)


def _is_fel(company: str) -> bool:
    return bool(company) and bool(
        frappe.db.exists("BFEL Settings", {"company": company, "enabled": 1})
    )


# ---------------------------------------------------------------------------
# Reglas tipo ↔ serie
# ---------------------------------------------------------------------------

def error_serie(series: str, tipo: str, company: str) -> str | None:
    """Motivo por el que `series` no sirve para `tipo` en `company`, o None."""
    if tipo not in TIPO_DOCTYPE:
        return f"Tipo de documento '{tipo}' no válido."
    doctype = TIPO_DOCTYPE[tipo]
    opts = {_norm(o, company) for o in _options(doctype)}
    if _norm(series, company) not in opts:
        return (f"La serie '{series}' no existe en las series de {doctype} "
                "(Document Naming Settings).")
    if doctype != "Sales Invoice":
        return None

    p = prefijo(series)
    if tipo == TIPO_FACTURA:
        if p in DTE_NO_FACTURA:
            return f"La serie '{series}' ({p}) no es de factura; no puede usarse como {tipo}."
        return None

    requerido = PREFIJO_AJUSTE[tipo]
    if p == requerido:
        return None
    # Una compañía con FEL certifica por prefijo: la NC/ND DEBE ser NCRE/NDEB.
    # Sin FEL se tolera una serie interna mientras no sea de otro tipo DTE.
    if _is_fel(company) or p in DTE_FACTURA or p in DTE_NO_FACTURA:
        return f"Una {tipo} debe usar una serie que empiece con {requerido} (serie '{series}')."
    return None


def series_base(company: str, tipo: str, establecimiento: str = None) -> list:
    """Series candidatas sin configuración (comportamiento heredado)."""
    doctype = TIPO_DOCTYPE[tipo]
    opts = _options(doctype)
    if tipo == TIPO_FACTURA:
        from facex_multi.api.invoice import filter_naming_series_for_company
        return filter_naming_series_for_company(opts, company, establecimiento)
    if tipo == TIPO_RECIBO:
        return opts
    return [s for s in opts if not error_serie(s, tipo, company)]


# ---------------------------------------------------------------------------
# Configuración (usuario → compañía)
# ---------------------------------------------------------------------------

def _rows_for(parenttype: str, parent: str) -> list:
    if not parent or not frappe.db.table_exists(CHILD_DOCTYPE):
        return []
    cache = getattr(frappe.local, "facex_series_rows", None)
    if cache is None:
        cache = frappe.local.facex_series_rows = {}
    key = (parenttype, parent)
    if key not in cache:
        cache[key] = frappe.get_all(
            CHILD_DOCTYPE,
            filters={"parenttype": parenttype, "parent": parent, "parentfield": "series_documentos"},
            fields=["tipo_documento", "naming_series", "establecimiento", "por_defecto"],
            order_by="idx asc",
        )
    return cache[key]


def _match(rows: list, tipo: str, establecimiento) -> list:
    est = str(establecimiento or "").strip()
    return [
        r for r in rows
        if r.tipo_documento == tipo
        and (not (r.establecimiento or "").strip() or not est or r.establecimiento.strip() == est)
    ]


def series_configuradas(company: str, tipo: str, establecimiento: str = None, user: str = None):
    """(series, origen) configuradas para el tipo, default primero; o (None, None)
    si no hay configuración (→ comportamiento heredado).

    origen: "usuario" | "compania".
    """
    from facex_multi.api.permissions import _row

    user = user or frappe.session.user
    candidates = []
    row = _row(company, user)
    if row:
        candidates.append(("usuario", "FacEx Settings", row.name))
    candidates.append(("compania", CONFIG_DOCTYPE, company))

    for origen, parenttype, parent in candidates:
        rows = _match(_rows_for(parenttype, parent), tipo, establecimiento)
        if not rows:
            continue
        valid = []
        for r in sorted(rows, key=lambda r: -int(r.por_defecto or 0)):
            err = error_serie(r.naming_series, tipo, company)
            if err:
                # Serie borrada/renombrada después de configurarla: no tumbar
                # la caja; se ignora y queda registrado.
                frappe.log_error(f"{parenttype} {parent}: {err}", "FacEx Series: serie inválida")
                continue
            if r.naming_series not in valid:
                valid.append(r.naming_series)
        if valid:
            return valid, origen
    return None, None


def get_series(company: str, tipo: str, establecimiento: str = None) -> list:
    """Series que el usuario puede usar para `tipo`, la por defecto primero."""
    configured, _origen = series_configuradas(company, tipo, establecimiento)
    base = series_base(company, tipo, establecimiento)
    if configured is None:
        return base
    base_norm = {_norm(s, company) for s in base}
    # Compañía sin BFEL: la base de Factura viene vacía (legacy) — se respeta
    # lo configurado, que ya pasó error_serie.
    if tipo == TIPO_FACTURA and not base:
        return configured
    return [s for s in configured if _norm(s, company) in base_norm]


def get_default_series(company: str, tipo: str, establecimiento: str = None) -> str:
    series = get_series(company, tipo, establecimiento)
    return series[0] if series else ""


def serie_permitida(series: str, company: str, tipo: str, establecimiento: str = None) -> bool:
    configured, _origen = series_configuradas(company, tipo, establecimiento)
    if configured is None:
        return True
    return _norm(series, company) in {_norm(s, company) for s in configured}


# ---------------------------------------------------------------------------
# Validación de la configuración (validate de FacEx Settings / Config Compañía)
# ---------------------------------------------------------------------------

def validate_series_table(doc, company: str) -> None:
    seen = set()
    defaults = {}
    for r in doc.get("series_documentos") or []:
        r.naming_series = (r.naming_series or "").strip()
        r.establecimiento = (r.establecimiento or "").strip()
        err = error_serie(r.naming_series, r.tipo_documento, company)
        if err:
            frappe.throw(f"Series de Documentos, fila {r.idx}: {err}")
        if r.tipo_documento == TIPO_FACTURA and _is_fel(company):
            from facex_multi.api.invoice import filter_naming_series_for_company
            if not filter_naming_series_for_company([r.naming_series], company, r.establecimiento or None):
                frappe.throw(
                    f"Series de Documentos, fila {r.idx}: la serie '{r.naming_series}' no tiene un "
                    f"BFEL Document Map activo en '{company}'"
                    + (f" para el establecimiento {r.establecimiento}." if r.establecimiento else ".")
                )
        key = (r.tipo_documento, r.naming_series, r.establecimiento)
        if key in seen:
            frappe.throw(f"Series de Documentos, fila {r.idx}: la serie '{r.naming_series}' está repetida.")
        seen.add(key)
        if int(r.por_defecto or 0):
            dkey = (r.tipo_documento, r.establecimiento)
            if dkey in defaults:
                frappe.throw(
                    f"Series de Documentos: solo puede haber una serie por defecto para "
                    f"«{r.tipo_documento}»" + (f" (establecimiento {r.establecimiento})" if r.establecimiento else "")
                    + f" — filas {defaults[dkey]} y {r.idx}."
                )
            defaults[dkey] = r.idx
    frappe.local.facex_series_rows = None


# ---------------------------------------------------------------------------
# Hook central: Sales Invoice.before_insert
# ---------------------------------------------------------------------------

def enforce_sales_invoice_series(doc, method=None):
    """Garantiza que la serie corresponda al tipo de documento antes de que
    ERPNext asigne el número (before_insert corre antes de autoname).

    - NC/ND sin serie o con la de la factura original (el Desk la copia al
      hacer la devolución) → se cambia por la serie por defecto del tipo.
    - Serie de otro tipo (p. ej. FACT en una NC) → error.
    - Documentos de FacEx: NC/ND exigen el permiso correspondiente.
    - Usuario con series configuradas → solo puede usar esas.
    """
    if frappe.flags.in_install or frappe.flags.in_migrate or frappe.flags.in_patch:
        return
    company = doc.company
    tipo = tipo_de_factura(doc)
    est = doc.get("bfel_establecimiento")

    if tipo != TIPO_FACTURA and doc.get("bfel_facex_multi"):
        from facex_multi.api.permissions import (
            get_facex_can_issue_credit_notes, get_facex_can_issue_debit_notes,
        )
        allowed = (get_facex_can_issue_credit_notes if tipo == TIPO_NC
                   else get_facex_can_issue_debit_notes)(company)
        if not allowed:
            frappe.throw(f"No tiene permiso para emitir {tipo} en FacEx.", frappe.PermissionError)

    if not doc.naming_series or (tipo != TIPO_FACTURA and error_serie(doc.naming_series, tipo, company)):
        default = get_default_series(company, tipo, est)
        if default:
            doc.naming_series = default

    if not doc.naming_series:
        return  # ERPNext usa su serie por defecto (compañías sin configuración)

    err = error_serie(doc.naming_series, tipo, company)
    if err:
        frappe.throw(err)

    if frappe.flags.in_import or "System Manager" in frappe.get_roles():
        return
    if not serie_permitida(doc.naming_series, company, tipo, est):
        frappe.throw(
            f"La serie '{doc.naming_series}' no está habilitada para su usuario como {tipo}. "
            "Solicite a su administrador que la agregue en Series de Documentos (FacEx Settings)."
        )


# ---------------------------------------------------------------------------
# Payment Entry (Recibo de Pago)
# ---------------------------------------------------------------------------

RECIBO_SERIES = "REC-.ABBR.-.####"


def ensure_payment_entry_naming_series():
    """after_migrate, idempotente: agrega REC-.ABBR.-.#### AL FINAL de las
    opciones de Payment Entry.naming_series (el Desk sigue usando la primera)."""
    from frappe.custom.doctype.property_setter.property_setter import make_property_setter

    current = _options("Payment Entry")
    if RECIBO_SERIES in current:
        return
    make_property_setter(
        "Payment Entry", "naming_series", "options",
        "\n".join(current + [RECIBO_SERIES]), "Text",
    )
    frappe.clear_cache(doctype="Payment Entry")


# ---------------------------------------------------------------------------
# API para los grids (opciones del Autocomplete)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_series_options(company: str) -> dict:
    """Series válidas por tipo para `company` (opciones del grid)."""
    if not frappe.has_permission("FacEx Settings", "read") and not frappe.has_permission(CONFIG_DOCTYPE, "read"):
        from facex_multi.api.invoice import get_effective_company
        from facex_multi.api.permissions import get_facex_can_view_seguridad
        if not get_facex_can_view_seguridad(get_effective_company(company)):
            frappe.throw("No tiene permiso para consultar las series.", frappe.PermissionError)
    out = {}
    for tipo, doctype in TIPO_DOCTYPE.items():
        out[tipo] = [s for s in _options(doctype) if not error_serie(s, tipo, company)]
    return out
