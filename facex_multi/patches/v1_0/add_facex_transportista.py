import frappe


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_transportista", force=True)

    # url_tracking se deja vacío intencionalmente: no se asume el patrón real de URL
    # de cada transportista. Editar manualmente en FacEx Transportista cuando se confirme.
    seed = [
        {
            "transportista_nombre": "Cargo Expreso",
            "abreviatura": "CAEX",
            "activo": 1,
        },
        {
            "transportista_nombre": "Corre Caminos",
            "abreviatura": "CC",
            "activo": 1,
        },
    ]

    for row in seed:
        if not frappe.db.exists("FacEx Transportista", row["transportista_nombre"]):
            doc = frappe.new_doc("FacEx Transportista")
            doc.update(row)
            doc.insert(ignore_permissions=True)
            print(f"FacEx Transportista creado: {row['transportista_nombre']}")

    frappe.db.commit()
