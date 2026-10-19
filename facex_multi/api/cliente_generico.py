"""
facex_multi.api.cliente_generico
--------------------------------
Clientes genéricos (Consumidor Final): un solo código de cliente por compañía,
marcado con `Customer.bfel_cliente_generico = 1` (solo visible en el ERP).

En las lecturas de FacEx (reportes, cierres, vistas de facturas...) la factura
de un cliente genérico se muestra con lo que el usuario escribió en la factura
(`Sales Invoice.bfel_nombre` / `bfel_nit`) en vez de los datos de la ficha. Si
el usuario no cambió el nombre (vacío o sigue el default "Consumidor Final"),
se muestra el original y se agrupa como siempre.

Dos formas de aplicarlo:
- SQL crudo: `display_name_sql(alias)` / `display_nit_sql(alias)` en el SELECT
  (y en WHERE para búsquedas).
- Filas ya leídas (frappe.get_all, etc.): `apply_display(rows)`.
"""
from __future__ import annotations

import frappe

# Valores que el usuario deja cuando no cambia el default de la factura.
_DEFAULT_NOMBRES = ("consumidor final", "cf", "c/f")
_DEFAULT_NITS = ("cf", "c/f")


def generic_customers() -> set:
    """Clientes marcados como genéricos (cacheado por request)."""
    cache = getattr(frappe.local, "_facex_generic_customers", None)
    if cache is None:
        cache = set()
        if frappe.db.has_column("Customer", "bfel_cliente_generico"):
            cache = set(frappe.get_all("Customer", filters={"bfel_cliente_generico": 1}, pluck="name"))
        frappe.local._facex_generic_customers = cache
    return cache


def _generic_cond(alias: str) -> str:
    return f"{alias}.customer IN (SELECT gc.name FROM `tabCustomer` gc WHERE gc.bfel_cliente_generico = 1)"


def nombre_cambiado_sql(alias: str = "`tabSales Invoice`") -> str:
    """Condición SQL: factura de cliente genérico con nombre propio en `bfel_nombre`.
    La collation de la BD es case-insensitive, así que las comparaciones también."""
    defaults = ", ".join(f"'{d}'" for d in _DEFAULT_NOMBRES)
    return (
        f"({_generic_cond(alias)}"
        f" AND TRIM(IFNULL({alias}.bfel_nombre, '')) NOT IN ('', {defaults})"
        f" AND TRIM({alias}.bfel_nombre) <> TRIM(IFNULL({alias}.customer_name, '')))"
    )


def display_name_sql(alias: str = "`tabSales Invoice`") -> str:
    """Expresión SQL del nombre a mostrar para una factura (usar `AS customer_name`)."""
    return f"(CASE WHEN {nombre_cambiado_sql(alias)} THEN TRIM({alias}.bfel_nombre) ELSE {alias}.customer_name END)"


def display_nit_sql(alias: str = "`tabSales Invoice`", fallback: str = None) -> str:
    """Expresión SQL del NIT a mostrar: `bfel_nit` de la factura si el cliente es
    genérico y el usuario puso uno distinto de CF; si no, `fallback`."""
    fallback = fallback or f"{alias}.bfel_nit"
    defaults = ", ".join(f"'{d}'" for d in _DEFAULT_NITS)
    return (
        f"(CASE WHEN {_generic_cond(alias)} AND TRIM(IFNULL({alias}.bfel_nit, '')) NOT IN ('', {defaults})"
        f" THEN TRIM({alias}.bfel_nit) ELSE {fallback} END)"
    )


def display_name(customer: str, customer_name: str, bfel_nombre: str) -> str:
    """Versión Python de `display_name_sql`."""
    original = customer_name or customer or ""
    if customer not in generic_customers():
        return original
    nombre = (bfel_nombre or "").strip()
    if not nombre or nombre.lower() in _DEFAULT_NOMBRES or nombre.lower() == original.strip().lower():
        return original
    return nombre


def nombre_cambiado(row) -> bool:
    return display_name(row.get("customer"), row.get("customer_name"), row.get("bfel_nombre")) != (
        row.get("customer_name") or row.get("customer") or ""
    )


def apply_display(rows, name_key: str = "customer_name", invoice_key: str = "name"):
    """Sobrescribe `name_key` con el nombre a mostrar en filas de Sales Invoice.

    Si a la fila le faltan `customer` o `bfel_nombre`, se leen de la factura
    (`invoice_key`). Devuelve las mismas filas para poder encadenar."""
    if not rows or not generic_customers():
        return rows
    faltan = [r.get(invoice_key) for r in rows
              if r.get(invoice_key) and ("customer" not in r or "bfel_nombre" not in r)]
    extra = {}
    if faltan:
        extra = {
            d.name: d for d in frappe.get_all(
                "Sales Invoice", filters={"name": ["in", list(set(faltan))]},
                fields=["name", "customer", "customer_name", "bfel_nombre"],
            )
        }
    for r in rows:
        src = extra.get(r.get(invoice_key)) or r
        customer = r.get("customer") or src.get("customer")
        if customer not in generic_customers():
            continue
        original = r.get(name_key) or src.get("customer_name")
        r[name_key] = display_name(customer, original, r.get("bfel_nombre", src.get("bfel_nombre")))
    return rows


@frappe.whitelist()
def get_invoice_display_name(invoice: str) -> str:
    """Nombre a mostrar de una factura, para vistas que la leen por nombre."""
    doc = frappe.get_doc("Sales Invoice", invoice)
    doc.check_permission("read")
    return display_name(doc.customer, doc.customer_name, doc.get("bfel_nombre"))


DEFAULT_NOMBRE = "Consumidor Final"


def default_bfel_nombre(doc, method=None):
    """before_validate de Sales Invoice: "Nombre para Factura" nunca se graba en
    blanco. Si viene vacío se usa "Consumidor Final" (cliente genérico o NIT CF);
    para un cliente con NIT propio, el nombre de su ficha."""
    if not doc.meta.has_field("bfel_nombre"):
        return
    nombre = (doc.get("bfel_nombre") or "").strip()
    if not nombre:
        nit = (doc.get("bfel_nit") or "").strip().lower()
        if doc.customer in generic_customers() or nit in ("", *_DEFAULT_NITS):
            nombre = DEFAULT_NOMBRE
        else:
            nombre = doc.customer_name or DEFAULT_NOMBRE
    doc.bfel_nombre = nombre
