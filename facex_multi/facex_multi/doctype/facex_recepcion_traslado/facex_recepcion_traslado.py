# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import flt


class FacExRecepcionTraslado(Document):
	def validate(self):
		self.recompute_totals()

	def recompute_totals(self):
		self.total_enviado = sum(flt(r.qty_enviada) for r in self.items)
		self.total_recibido = sum(flt(r.qty_recibida) for r in self.items)
		self.total_pendiente_recepcion = sum(flt(r.qty_pendiente_recepcion) for r in self.items)
		self.total_pendiente_devolucion = sum(flt(r.qty_pendiente_devolucion) for r in self.items)
		self.total_devuelto = sum(flt(r.qty_devuelta) for r in self.items)

		if flt(self.total_pendiente_recepcion) > 0:
			self.estado = "Pendiente"
		elif flt(self.total_pendiente_devolucion) > 0:
			self.estado = "Pendiente Devolución"
		else:
			self.estado = "Cerrado"
