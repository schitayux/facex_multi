# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class FacExTransportista(Document):
	def validate(self):
		if self.url_tracking and "{guia}" not in self.url_tracking:
			frappe.throw("La URL de Rastreo debe incluir el placeholder {guia}, ej: https://transportista.com/tracking/?guia={guia}")
