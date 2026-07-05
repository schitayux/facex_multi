"""
facex_multi.overrides.supplier
-------------------------------
Corrige la nomenclatura de Supplier (Proveedor) para que se comporte igual
que Customer (Cliente) cuando supp_master_name = "Supplier Name":

ERPNext estándar (erpnext/buying/doctype/supplier/supplier.py::autoname)
asigna `self.name = self.supplier_name` sin verificar si ya existe un
Supplier con ese mismo nombre, a diferencia de Customer.get_customer_name()
que sí lo verifica y agrega un sufijo " - N" para evitar colisiones. Como
un mismo proveedor comercial (ej. "CEMACO") puede registrarse para varias
compañías (bfel_company), sin esta corrección el segundo registro con el
mismo nombre falla con "ya existe".
"""
from __future__ import annotations

import frappe
from frappe import _, msgprint
from frappe.utils import cint, cstr
from erpnext.buying.doctype.supplier.supplier import Supplier


class FacexSupplier(Supplier):
    def autoname(self):
        supp_master_name = frappe.defaults.get_global_default("supp_master_name")
        if supp_master_name == "Supplier Name":
            self.name = self.get_supplier_name()
        else:
            super().autoname()

    def get_supplier_name(self):
        """Mismo esquema de desambiguación que Customer.get_customer_name()."""
        self.supplier_name = self.supplier_name.strip()
        if frappe.db.get_value("Supplier", self.supplier_name) and not frappe.flags.in_import:
            name_prefix = f"{self.supplier_name} - %"

            if frappe.db.db_type == "postgres":
                count = frappe.db.sql(
                    """
                    SELECT COALESCE(
                        MAX(CAST(SUBSTRING(name FROM '\\d+$') AS INTEGER)),
                        0
                    )
                    FROM `tabSupplier`
                    WHERE name LIKE %(name_prefix)s
                    """,
                    {"name_prefix": name_prefix},
                    as_list=1,
                )[0][0]
            else:
                count = frappe.db.sql(
                    """
                    SELECT COALESCE(
                        MAX(CAST(SUBSTRING_INDEX(name, ' ', -1) AS UNSIGNED)),
                        0
                    )
                    FROM `tabSupplier`
                    WHERE name LIKE %(name_prefix)s
                    """,
                    {"name_prefix": name_prefix},
                    as_list=1,
                )[0][0]
            count = cint(count) + 1

            new_supplier_name = f"{self.supplier_name} - {cstr(count)}"

            msgprint(
                _("Changed supplier name to '{}' as '{}' already exists.").format(
                    new_supplier_name, self.supplier_name
                ),
                title=_("Note"),
                indicator="yellow",
                alert=True,
            )

            return new_supplier_name

        return self.supplier_name
