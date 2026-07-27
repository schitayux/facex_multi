# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import flt


class FacExLiquidacionTransportista(Document):
	def validate(self):
		self.match_guias()
		self.total_depositado = sum(flt(row.monto_liquidado) for row in self.detalle)

	def match_guias(self):
		for row in self.detalle:
			row.match_encontrado = 0
			row.sales_invoice = None

			if not row.guia or not self.transportista:
				continue

			matches = frappe.get_all(
				"FacEx Guia Transportista",
				filters={"numero_guia": row.guia, "transportista": self.transportista},
				fields=["name", "parent"],
			)

			if len(matches) != 1:
				continue

			match = matches[0]
			row.match_encontrado = 1
			row.sales_invoice = match.parent

			frappe.db.set_value(
				"FacEx Guia Transportista",
				match.name,
				{"liquidado": 1, "fecha_liquidacion": self.fecha},
			)
