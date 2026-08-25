from frappe.model.document import Document

class FacExSettings(Document):
    def validate(self):
        import frappe
        self._validate_bodegas_habilitadas()
        self._validate_socio_venta_por_defecto()

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

    def _validate_bodegas_habilitadas(self):
        import frappe

        for row in self.get("bodegas_habilitadas") or []:
            wh_company = frappe.db.get_value("Warehouse", row.warehouse, "company")
            if wh_company and self.bfel_company and wh_company != self.bfel_company:
                frappe.throw(
                    f"La bodega '{row.warehouse}' pertenece a la compañía '{wh_company}' "
                    f"y no puede habilitarse en la configuración de '{self.bfel_company}'."
                )

        habilitadas = [row.warehouse for row in (self.get("bodegas_habilitadas") or [])]
        if self.bodega_por_defecto and habilitadas and self.bodega_por_defecto not in habilitadas:
            frappe.throw(
                f"La Bodega por Defecto '{self.bodega_por_defecto}' debe ser una de las "
                "Bodegas Habilitadas, o deja el grid vacío para no restringir bodegas."
            )

    def _validate_socio_venta_por_defecto(self):
        if not self.socio_venta_por_defecto:
            return
        from facex_multi.api.sales_partner import validate_sales_partner_company
        validate_sales_partner_company(self.socio_venta_por_defecto, self.bfel_company)
