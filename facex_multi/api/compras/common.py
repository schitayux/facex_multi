"""
facex_multi.api.compras.common
------------------------------
Helpers compartidos por los documentos de compra y el arranque del page
FacEx Compras. Movidos desde api/purchase.py (que conserva el mantenimiento
de proveedores del Clásico y alias de compatibilidad).
"""
from __future__ import annotations

import frappe
from frappe.utils import flt, today


# ---------------------------------------------------------------------------
# Resolución de datos de la compañía / ítem
# ---------------------------------------------------------------------------

def get_abbr(company: str) -> str:
    return frappe.db.get_value("Company", company, "abbr") or ""


def resolve_item_warehouse(item_code: str, company: str, allowed_warehouses=None) -> str:
    """Bodega para recepción: Item Default → patrón por grupo de ítem.

    Si `allowed_warehouses` viene definido (usuario con bodegas_habilitadas
    restringidas), la bodega resuelta se acota a esa lista — así el picker
    nunca sugiere de entrada una bodega fuera del alcance del usuario, y el
    guardado solo necesita rechazar una bodega que el usuario haya elegido a mano."""
    wh = frappe.db.get_value(
        "Item Default",
        {"parent": item_code, "company": company},
        "default_warehouse",
    )
    if not wh:
        abbr       = get_abbr(company)
        item_group = frappe.db.get_value("Item", item_code, "item_group") or ""
        base       = "EL MOSQUETE" if abbr == "EMS" else "EL PANZER"
        idx        = {"ARMAS": "I", "MUNICIÓN": "II", "ACCESORIOS": "III"}.get(item_group)
        wh = f"{base} {idx} - {abbr}" if idx else ""

    if wh and allowed_warehouses is not None and wh not in allowed_warehouses:
        wh = allowed_warehouses[0] if allowed_warehouses else ""
    return wh


def default_uom() -> str:
    """UdM de respaldo cuando el ítem no tiene stock_uom (caso excepcional)."""
    return frappe.db.get_single_value("Stock Settings", "stock_uom") or "Unit"


def get_buying_price_list() -> str:
    """Lista de precios de compra configurada en Buying Settings (fallback: 'Standard Buying')."""
    return frappe.db.get_single_value("Buying Settings", "buying_price_list") or "Standard Buying"


def get_company_currency(company: str) -> str:
    return frappe.db.get_value("Company", company, "default_currency") or "GTQ"


def get_conversion_rate(currency: str, company: str, date: str = None) -> float:
    """Tipo de cambio nativo de ERPNext (Currency Exchange) hacia la moneda de
    la compañía. Misma moneda → 1. Sin tipo de cambio configurado → error
    explícito en vez de registrar dólares como si fueran quetzales."""
    company_currency = get_company_currency(company)
    if not currency or currency == company_currency:
        return 1.0
    from erpnext.setup.utils import get_exchange_rate
    rate = flt(get_exchange_rate(currency, company_currency, date or today()))
    if not rate:
        frappe.throw(
            f"No hay tipo de cambio configurado de {currency} a {company_currency}. "
            "Regístrelo en ERPNext (Currency Exchange) antes de grabar."
        )
    return rate


def get_payable_account(supplier: str, company: str, currency: str = None) -> str:
    """Cuenta por pagar nativa: la del proveedor / su grupo / la de la compañía
    (erpnext get_party_account). Si la moneda del documento no coincide con la
    de esa cuenta, se busca una cuenta Payable de la compañía en esa moneda.

    Antes se tomaba "la primera cuenta Payable por fecha de creación", que en
    casi todas las compañías resultaba ser 1610 - Avances de Empleado."""
    from erpnext.accounts.party import get_party_account

    account = get_party_account("Supplier", supplier, company) if supplier else None
    account = account or frappe.db.get_value("Company", company, "default_payable_account")
    if account and currency:
        acc_currency = frappe.db.get_value("Account", account, "account_currency")
        if acc_currency and acc_currency != currency:
            account = frappe.db.get_value(
                "Account",
                {"company": company, "account_type": "Payable",
                 "account_currency": currency, "is_group": 0, "disabled": 0},
                "name",
                order_by="creation asc",
            )
    if not account:
        frappe.throw(f"La compañía {company} no tiene cuenta por pagar configurada"
                     + (f" en {currency}." if currency else "."))
    return account


# ---------------------------------------------------------------------------
# Impuestos de compra
# ---------------------------------------------------------------------------

def list_company_tax_templates(company: str) -> list:
    """Plantillas de impuestos de compra realmente activas y ligadas a la compañía."""
    return frappe.get_all(
        "Purchase Taxes and Charges Template",
        filters={"company": company, "disabled": 0},
        fields=["name", "is_default"],
        order_by="is_default desc, name asc",
    )


def resolve_purchase_tax_template(company: str, template_name: str = None) -> str:
    """Respeta la plantilla elegida si es activa y de la compañía; si no, la
    marcada is_default=1 o la primera activa."""
    if template_name and frappe.db.exists(
        "Purchase Taxes and Charges Template",
        {"name": template_name, "company": company, "disabled": 0},
    ):
        return template_name
    templates = list_company_tax_templates(company)
    return templates[0].name if templates else ""


def get_tax_rows(template_name: str) -> list:
    """Filas reales de la plantilla de impuestos, listas para doc.append('taxes', ...)."""
    if not template_name:
        return []
    from erpnext.controllers.accounts_controller import get_taxes_and_charges
    return get_taxes_and_charges("Purchase Taxes and Charges Template", template_name) or []


def get_purchase_tax_rate(template_name: str) -> float:
    """Suma de porcentajes de impuesto de la plantilla indicada."""
    if not template_name:
        return 0.0
    rows = frappe.get_all("Purchase Taxes and Charges", filters={"parent": template_name}, fields=["rate"])
    return sum(flt(r.rate) for r in rows)


def get_tax_templates_with_rate(company: str) -> list:
    """Plantillas con su % total y si el impuesto va incluido en el precio
    (included_in_print_rate), para el total estimado del formulario."""
    out = []
    for t in list_company_tax_templates(company):
        included = frappe.db.exists(
            "Purchase Taxes and Charges", {"parent": t.name, "included_in_print_rate": 1}
        )
        out.append({
            "name": t.name,
            "is_default": int(t.is_default or 0),
            "rate": get_purchase_tax_rate(t.name),
            "included": int(bool(included)),
        })
    return out


def get_naming_series(doctype: str, company: str) -> list:
    """Series del doctype (Property Setter del sitio) que contienen la
    abreviatura de la compañía; sin coincidencias → todas."""
    abbr = get_abbr(company)
    raw = (
        frappe.db.get_value(
            "Property Setter",
            {"doc_type": doctype, "field_name": "naming_series", "property": "options"},
            "value",
        )
        or ""
    )
    all_s = [s.strip() for s in raw.split("\n") if s.strip()]
    filtered = [s for s in all_s if abbr and abbr in s]
    return filtered or all_s


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------
# Los flags puede_compras / puede_validar_compras / puede_cancelar_compras se
# aplican en el servidor (no solo ocultan botones). Retrocompatibles: sin fila
# de FacEx Settings o System Manager → pasan.

# Checks por documento (patch add_compras_documentos_permisos) → check
# heredado equivalente, mientras el sitio no haya corrido migrate (gunicorn
# recarga el .py antes de que existan las columnas).
_LEGACY_PERM = {
    "oc_grabar_borrador": "puede_compras",
    "entrada_compra_grabar_borrador": "puede_compras",
    "factura_compra_grabar_borrador": "puede_compras",
    "oc_validar": "puede_validar_compras",
    "entrada_compra_validar": "puede_validar_compras",
    "oc_cancelar": "puede_cancelar_compras",
    "entrada_compra_cancelar": "puede_cancelar_compras",
}


def perm_field(field: str) -> str:
    if field in _LEGACY_PERM and not frappe.get_meta("FacEx Settings").has_field(field):
        return _LEGACY_PERM[field]
    return field


def require_purchase(company: str = None, *flags: str, msg: str = None) -> str:
    from facex_multi.api.invoice import get_effective_company, get_user_companies
    from facex_multi.api.permissions import require_facex_permission

    company = get_effective_company(company)
    if company not in (get_user_companies() or []) and frappe.session.user != "Administrator":
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)
    require_facex_permission(company, *(flags or ("puede_compras",)), msg=msg)
    return company


def is_own_scope(company: str) -> bool:
    from facex_multi.api.permissions import SCOPE_OWN, get_facex_purchase_scope
    return get_facex_purchase_scope(company) == SCOPE_OWN


def check_doc_access(doc, company: str) -> None:
    """El documento debe ser de la compañía conectada y, con alcance
    'Solo lo creado por mí', del propio usuario."""
    if doc.company != company and frappe.session.user != "Administrator":
        frappe.throw(f"El documento {doc.name} pertenece a otra compañía.", frappe.PermissionError)
    if is_own_scope(company) and doc.owner != frappe.session.user:
        frappe.throw("Solo puede operar sobre los documentos de compra que usted registró.",
                     frappe.PermissionError)


# ---------------------------------------------------------------------------
# Arranque del page
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_compras_defaults(company: str = None) -> dict:
    """Datos para inicializar FacEx Compras: compañía efectiva, compañías del
    usuario, permisos, bodegas de compra, plantillas de impuesto y monedas."""
    from facex_multi.api.invoice import get_effective_company, get_user_companies, get_warehouses
    from facex_multi.api.permissions import (
        get_facex_can_access_inventory_menu,
        get_facex_can_access_pos,
        get_facex_permissions_for_company,
        get_facex_purchase_scope,
    )

    companies = get_user_companies() or []
    company = get_effective_company(company)
    if company and companies and company not in companies:
        company = companies[0]

    general = get_facex_permissions_for_company(company)
    perms = {k: int(general.get(perm_field(k)) or 0) for k in (
        "puede_compras", "puede_validar_compras", "puede_cancelar_compras",
        "oc_grabar_borrador", "oc_validar", "oc_cancelar",
        "entrada_compra_grabar_borrador", "entrada_compra_validar", "entrada_compra_cancelar",
        "factura_compra_grabar_borrador",
        "crea_proveedores", "modifica_proveedores", "puede_facturar",
    )}
    # Accesos de la barra superior (otras Pages de FacEx).
    perms["puede_ver_pos"] = int(get_facex_can_access_pos(company))
    perms["puede_ver_menu_inventario"] = int(get_facex_can_access_inventory_menu(company))
    perms["alcance_compras"] = get_facex_purchase_scope(company) if company else ""

    currency = get_company_currency(company) if company else "GTQ"
    currencies = [currency] + [c for c in ("GTQ", "USD") if c != currency]
    tax_templates = get_tax_templates_with_rate(company) if company else []

    return {
        "company":              company,
        "companies":            companies,
        "permissions":          perms,
        "currency":             currency,
        "currencies":           currencies,
        "tax_templates":        tax_templates,
        "default_tax_template": tax_templates[0]["name"] if tax_templates else "",
        "warehouses":           get_warehouses(company, "compra") if (company and perms["puede_compras"]) else [],
        "today":                today(),
    }


# ---------------------------------------------------------------------------
# «Validado por» en los documentos de compra (formatos de impresión)
# ---------------------------------------------------------------------------

PURCHASE_DOCTYPES = ("Purchase Order", "Purchase Receipt", "Purchase Invoice")


def ensure_compras_custom_fields():
    """after_migrate: quién y cuándo validó el documento. El creador ya es
    `owner`; el formato de impresión muestra ambos."""
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    fields = [
        {
            "fieldname": "facex_validado_por",
            "label": "Validado por",
            "fieldtype": "Link",
            "options": "User",
            "insert_after": "amended_from",
            "read_only": 1,
            "no_copy": 1,
            "allow_on_submit": 1,
            "print_hide": 1,
        },
        {
            "fieldname": "facex_validado_el",
            "label": "Validado el",
            "fieldtype": "Datetime",
            "insert_after": "facex_validado_por",
            "read_only": 1,
            "no_copy": 1,
            "allow_on_submit": 1,
            "print_hide": 1,
        },
    ]
    create_custom_fields({dt: fields for dt in PURCHASE_DOCTYPES}, update=True)


def set_validado_por(doc, method=None):
    """on_submit de Purchase Order / Receipt / Invoice (desde FacEx o el Desk)."""
    if doc.meta.has_field("facex_validado_por"):
        doc.db_set({"facex_validado_por": frappe.session.user,
                    "facex_validado_el": frappe.utils.now_datetime()}, update_modified=False)
