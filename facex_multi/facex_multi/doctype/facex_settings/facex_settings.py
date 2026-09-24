from frappe.model.document import Document

class FacExSettings(Document):
    def validate(self):
        import frappe
        self._validate_bodegas_habilitadas()
        self._validate_socio_venta_por_defecto()
        self._validate_listas_precios()

        # user="" → registro de compañía heredado. La configuración de compañía
        # ahora vive en «FacEx Configuracion Compania»: ya no se crean filas
        # nuevas sin usuario; las existentes se pueden seguir guardando.
        if not self.user and self.is_new():
            frappe.throw(
                "La configuración de compañía ahora se edita en «FacEx Configuracion Compania». "
                "FacEx Settings requiere un Usuario."
            )
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

        filas = {row.warehouse: row for row in (self.get("bodegas_habilitadas") or [])}
        if not filas:
            return

        if self.bodega_por_defecto:
            fila = filas.get(self.bodega_por_defecto)
            if not fila:
                frappe.throw(
                    f"La Bodega por Defecto '{self.bodega_por_defecto}' debe ser una de las "
                    "Bodegas Habilitadas, o deja el grid vacío para no restringir bodegas."
                )
            if not fila.permite_venta:
                frappe.throw(
                    f"La Bodega por Defecto '{self.bodega_por_defecto}' se usa para facturar, "
                    "así que debe tener marcada la operación «Venta» en Bodegas Habilitadas."
                )

        if self.transito_por_defecto:
            fila = filas.get(self.transito_por_defecto)
            if fila and not fila.permite_transferencia:
                frappe.throw(
                    f"El Almacén de Tránsito '{self.transito_por_defecto}' recibe traslados, "
                    "así que debe tener marcada la operación «Transferencia» en Bodegas Habilitadas."
                )

    def _validate_socio_venta_por_defecto(self):
        if not self.socio_venta_por_defecto:
            return
        from facex_multi.api.sales_partner import validate_sales_partner_company
        validate_sales_partner_company(self.socio_venta_por_defecto, self.bfel_company)

    def _validate_listas_precios(self):
        import frappe
        from facex_multi.api.item import validate_price_list_company

        habilitadas = []
        for row in self.get("listas_precios_habilitadas") or []:
            if not row.price_list:
                continue
            validate_price_list_company(row.price_list, self.bfel_company)
            if not frappe.db.get_value("Price List", row.price_list, "selling"):
                frappe.throw(
                    f"La lista '{row.price_list}' no es una lista de venta y no puede habilitarse aquí."
                )
            habilitadas.append(row.price_list)

        if self.lista_precios_por_defecto:
            validate_price_list_company(self.lista_precios_por_defecto, self.bfel_company)
            if habilitadas and self.lista_precios_por_defecto not in habilitadas:
                frappe.throw(
                    f"La Lista de Precios por Defecto '{self.lista_precios_por_defecto}' debe ser una de "
                    "las Listas de Precios Habilitadas, o deja el grid vacío para no restringir listas."
                )
