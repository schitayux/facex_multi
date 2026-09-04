"""
Patch: los clientes subidos por plantilla traían el vendedor en la pestaña
"Equipo de Ventas" (Sales Team -> sales_person), pero FacEx segrega por
"Socio de Ventas" (Sales Partner) vía Customer.default_sales_partner.

Este patch, de forma idempotente:
  1. Crea un Sales Partner "espejo" por cada Sales Person (no-grupo) usado en
     el Equipo de Ventas de algún Customer que aún no lo tenga.
  2. Rellena Customer.default_sales_partner con el Sales Partner del vendedor
     dominante de su Equipo de Ventas, SOLO en clientes que hoy no tienen
     default_sales_partner.

No toca clientes que ya tienen socio, ni "Consumidor Final".
"""
import frappe


def _dominant_sales_person(customer_name):
    rows = frappe.get_all(
        "Sales Team",
        filters={"parenttype": "Customer", "parent": customer_name},
        fields=["sales_person", "allocated_percentage", "idx"],
    )
    rows = [r for r in rows if r.sales_person]
    if not rows:
        return None
    rows.sort(key=lambda r: (-(r.allocated_percentage or 0), r.idx or 0))
    return rows[0].sales_person


def _ensure_sales_partner(sales_person, company):
    """Devuelve el name del Sales Partner espejo del Sales Person, creándolo si
    hace falta. Reutiliza por partner_name."""
    existing = frappe.db.get_value("Sales Partner", {"partner_name": sales_person}, "name")
    if existing:
        return existing
    if frappe.db.exists("Sales Partner", sales_person):
        return sales_person

    doc = frappe.new_doc("Sales Partner")
    doc.partner_name = sales_person
    doc.commission_rate = 0
    doc.territory = (
        frappe.db.get_value("Territory", {"is_group": 0}, "name", order_by="lft asc")
        or frappe.db.get_value("Territory", {}, "name")
        or "All Territories"
    )
    if doc.meta.has_field("bfel_company") and company:
        doc.bfel_company = company
    if doc.meta.has_field("bfel_enlace_vendedor"):
        doc.bfel_enlace_vendedor = 1
    doc.flags.ignore_permissions = True
    doc.insert()
    return doc.name


def execute():
    default_company = frappe.defaults.get_global_default("company")

    # Sales Persons que son grupo (ej. "Equipo de ventas" raíz) — se excluyen.
    group_sps = set(frappe.get_all("Sales Person", filters={"is_group": 1}, pluck="name"))

    customers = frappe.get_all(
        "Customer",
        filters=[
            ["default_sales_partner", "in", ["", None]],
        ],
        fields=["name", "customer_name", "bfel_company"],
    )

    partners_created = 0
    customers_updated = 0
    partner_cache = {}

    for cust in customers:
        if cust.customer_name == "Consumidor Final":
            continue
        sp = _dominant_sales_person(cust.name)
        if not sp or sp in group_sps:
            continue

        company = cust.bfel_company or default_company
        cache_key = (sp, company)
        if cache_key not in partner_cache:
            before = frappe.db.exists("Sales Partner", {"partner_name": sp})
            partner_cache[cache_key] = _ensure_sales_partner(sp, company)
            if not before:
                partners_created += 1

        frappe.db.set_value(
            "Customer", cust.name, "default_sales_partner", partner_cache[cache_key],
            update_modified=False,
        )
        customers_updated += 1

    frappe.db.commit()
    frappe.logger().info(
        f"[facex_multi] backfill_sales_partners_from_sales_team: "
        f"{partners_created} Sales Partner creados, {customers_updated} clientes actualizados."
    )
    print(
        f"backfill_sales_partners_from_sales_team: {partners_created} Sales Partner creados, "
        f"{customers_updated} clientes actualizados."
    )
