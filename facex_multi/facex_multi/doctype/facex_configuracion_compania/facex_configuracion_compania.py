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
		self._validate_fraccion()
		from facex_multi.api.whatsapp import ensure_default_rows
		ensure_default_rows(self)

	def _validate_fraccion(self):
		if not self.get("maneja_fraccion"):
			return
		if not self.get("mostrar_uom"):
			frappe.throw("Entero/Fracción necesita «Ver unidad de medida» activo: sin la columna UdM no se distingue la Media Docena.")
		factor = self.get("fraccion_factor") or 0
		if not (0 < factor < 1):
			frappe.throw("Entero/Fracción: el Factor de la Fracción debe ser mayor que 0 y menor que 1 (ej. 0.5 = media).")
		bases = [r.uom for r in (self.get("fraccion_unidades_base") or [])]
		if not bases:
			frappe.throw("Entero/Fracción: indique al menos una unidad base que admite fracción (ej. Docena).")
		if self.get("fraccion_uom") in bases:
			frappe.throw("Entero/Fracción: la Unidad de Fracción no puede ser también una unidad base.")

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
		# Página de inicio de la navegación restringida (viaja en el boot).
		if self.has_value_changed("pagina_inicio_restringida"):
			from facex_multi.api.nav_guard import clear_boot_cache
			clear_boot_cache(self)
		# Entero/Fracción: UdM de fracción + ficha de los ítems que la admiten.
		from facex_multi.api.fraccion import on_config_update
		on_config_update(self.company)
