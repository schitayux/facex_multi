# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class FacExConfiguracionCompania(Document):
	"""Configuración de FacEx a nivel de compañía (DIGECAM, columnas visibles,
	condiciones de pago, flete, políticas de catálogo). Antes vivía en la fila
	de FacEx Settings con Usuario en blanco; se lee siempre vía
	permissions.get_facex_company_config."""

	def validate(self):
		if self.item_flete:
			item_company = frappe.db.get_value("Item", self.item_flete, "bfel_company") if frappe.get_meta("Item").has_field("bfel_company") else None
			if item_company and item_company != self.company:
				frappe.throw(f"El ítem de flete '{self.item_flete}' pertenece a la compañía '{item_company}'.")
		for field in ("cuenta_recargo_entrega", "cuenta_flete"):
			account = self.get(field)
			if account and frappe.db.get_value("Account", account, "company") != self.company:
				frappe.throw(f"La cuenta '{account}' no pertenece a la compañía '{self.company}'.")
