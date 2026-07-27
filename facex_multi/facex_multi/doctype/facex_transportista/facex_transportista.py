# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

from facex_multi.api.invoice import get_effective_company
from facex_multi.api.permissions import get_facex_can_administer_transportistas


class FacExTransportista(Document):
	def validate(self):
		if self.url_tracking and "{guia}" not in self.url_tracking:
			frappe.throw("La URL de Rastreo debe incluir el placeholder {guia}, ej: https://transportista.com/tracking/?guia={guia}")

		if not get_facex_can_administer_transportistas(get_effective_company()):
			frappe.throw(
				"No tiene permiso para administrar el catálogo de Transportistas.",
				frappe.PermissionError,
			)
