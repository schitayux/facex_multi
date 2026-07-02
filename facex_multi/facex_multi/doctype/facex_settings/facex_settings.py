from frappe.model.document import Document

class FacExSettings(Document):
    def validate(self):
        import frappe
        # user="" → registro de compañía (config DIGECAM); solo puede haber uno por compañía
        if not self.user:
            existing = frappe.db.get_value(
                "FacEx Settings",
                {"bfel_company": self.bfel_company, "user": ["in", ["", None]], "name": ["!=", self.name]},
                "name"
            )
            if existing:
                frappe.throw(
                    f"Ya existe una configuración de compañía para '{self.bfel_company}' ({existing}). "
                    "Deja el campo Usuario vacío solo en el registro de configuración base de la compañía."
                )
            return

        # registro normal usuario+compañía — garantizar unicidad
        existing = frappe.db.get_value(
            "FacEx Settings",
            {"user": self.user, "bfel_company": self.bfel_company, "name": ["!=", self.name]},
            "name"
        )
        if existing:
            frappe.throw(
                f"Ya existe una configuración FacEx para el usuario '{self.user}' "
                f"en la compañía '{self.bfel_company}' ({existing})."
            )
