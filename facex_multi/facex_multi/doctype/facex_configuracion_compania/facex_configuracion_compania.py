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
		self._validate_cuentas_cargos()

		from facex_multi.api.series import validate_series_table
		validate_series_table(self, self.company)

	# Un cargo en modo PASARELA (el cliente paga un extra que el transportista
	# descuenta luego en su liquidación) es un PASIVO, no un ingreso; un cargo
	# marcado "es parte de la venta" sí es ingreso. Poner la cuenta del tipo
	# contrario descuadra los informes de venta contra la contabilidad y no hay
	# forma de detectarlo después, así que se avisa al guardar.
	_CARGOS = (
		("recargo_es_venta", "cuenta_recargo_entrega", "Recargo por entrega"),
		("flete_es_venta", "cuenta_flete", "Flete"),
	)

	def _validate_cuentas_cargos(self):
		for modo_field, cuenta_field, label in self._CARGOS:
			account = self.get(cuenta_field)
			if not account:
				continue
			row = frappe.db.get_value("Account", account, ["company", "root_type"], as_dict=True) or {}
			if row.get("company") != self.company:
				frappe.throw(f"La cuenta '{account}' no pertenece a la compañía '{self.company}'.")
			es_venta = bool(self.get(modo_field))
			esperado = "Income" if es_venta else "Liability"
			if row.get("root_type") and row["root_type"] != esperado:
				frappe.msgprint(
					"{0}: está marcado como {1} pero la cuenta '{2}' es de tipo «{3}». "
					"Lo esperado es una cuenta de {4}. Verifique con el contador — "
					"si la cuenta no corresponde, los informes de venta no cuadrarán "
					"contra la contabilidad.".format(
						label,
						"parte de la venta (ingreso)" if es_venta else "pasarela (no es ingreso)",
						account, row["root_type"],
						"INGRESO" if es_venta else "PASIVO",
					),
					title="Revise la cuenta del cargo",
					indicator="orange",
				)

	def on_update(self):
		from facex_multi.api.permissions import clear_permissions_cache
		clear_permissions_cache()
