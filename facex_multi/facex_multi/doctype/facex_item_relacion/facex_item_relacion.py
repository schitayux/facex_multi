import frappe
from frappe.model.document import Document


class FacExItemRelacion(Document):
    def validate(self):
        if self.item_code == self.item_relacionado:
            frappe.throw("Un artículo no puede relacionarse consigo mismo.")

        item_company = frappe.db.get_value("Item", self.item_code, "bfel_company")
        related_company = frappe.db.get_value("Item", self.item_relacionado, "bfel_company")
        if item_company and related_company and item_company != related_company:
            frappe.throw(
                f"'{self.item_code}' y '{self.item_relacionado}' pertenecen a compañías distintas "
                "y no pueden relacionarse."
            )

        existing = frappe.db.get_value(
            "FacEx Item Relacion",
            {
                "tipo": self.tipo,
                "name": ["!=", self.name],
                "item_code": ["in", [self.item_code, self.item_relacionado]],
                "item_relacionado": ["in", [self.item_code, self.item_relacionado]],
            },
            "name",
        )
        if existing:
            frappe.throw(
                f"Ya existe una relación de tipo '{self.tipo}' entre '{self.item_code}' "
                f"y '{self.item_relacionado}' ({existing})."
            )
