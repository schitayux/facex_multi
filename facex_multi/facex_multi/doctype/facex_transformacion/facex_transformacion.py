# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

# Toda la lógica (permisos, notificaciones, Stock Entry) vive en
# facex_multi.api.transformar: el escritorio solo lo ve System Manager.

from frappe.model.document import Document
from frappe.utils import flt


class FacExTransformacion(Document):
	def validate(self):
		self.stock_qty = flt(self.cantidad) * flt(self.conversion_factor or 1)
		for r in self.items:
			r.stock_qty = flt(r.cantidad) * flt(r.conversion_factor or 1)
