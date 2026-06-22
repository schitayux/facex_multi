import frappe


def execute():
    """Rellena description con item_name en todos los ítems FEL que tienen description vacío."""
    items = frappe.db.sql(
        """
        SELECT name, item_name
        FROM `tabItem`
        WHERE (description IS NULL OR description = '')
          AND bfel_company IS NOT NULL
          AND bfel_company != ''
        """,
        as_dict=True,
    )

    if not items:
        return

    for item in items:
        frappe.db.set_value(
            "Item",
            item["name"],
            "description",
            item["item_name"],
            update_modified=False,
        )

    frappe.db.commit()
    print(f"Backfill completado: {len(items)} ítems actualizados (description = item_name).")
