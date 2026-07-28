# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document
from frappe.utils import flt

from facex_multi.api.invoice import _create_payment_entry, get_effective_company
from facex_multi.api.permissions import get_facex_can_upload_liquidaciones_transporte


def _release_or_keep_payment_entry(payment_entry):
	# Un PE ya sometido en Contabilidad no se toca (requiere reversión manual
	# allá); uno en borrador sí se descarta aquí porque este mismo validate()
	# lo recrea con los montos/match actuales — evita duplicarlo y evita que
	# quede desactualizado si la fila cambió.
	if not payment_entry:
		return None
	docstatus = frappe.db.get_value("Payment Entry", payment_entry, "docstatus")
	if docstatus is None:
		return None
	if docstatus == 1:
		return payment_entry
	frappe.delete_doc("Payment Entry", payment_entry, ignore_permissions=True, force=True)
	return None


class FacExLiquidacionTransportista(Document):
	def validate(self):
		if not get_facex_can_upload_liquidaciones_transporte(get_effective_company()):
			frappe.throw(
				"No tiene permiso para cargar Liquidaciones de Transportistas.",
				frappe.PermissionError,
			)

		self.unmatch_removed_guias()
		self.match_guias()
		self.total_depositado = sum(flt(row.monto_liquidado) for row in self.detalle)

	def on_trash(self):
		# Al eliminar la liquidación completa, toda guía que había quedado
		# liquidado=1 por su culpa debe volver a quedar pendiente — si no, el
		# KPI de COD pendiente de liquidar (y la columna "Liquidado" en
		# Guías) la siguen excluyendo para siempre aunque ya nadie la esté
		# liquidando.
		for row in self.detalle:
			if row.match_encontrado and row.guia:
				self._reset_guia_liquidado(row.guia, self.transportista)
			_release_or_keep_payment_entry(row.payment_entry)

	def unmatch_removed_guias(self):
		# Mismo problema que on_trash pero al EDITAR una liquidación ya
		# guardada: si una fila que antes tenía match (guía + transportista)
		# ya no está en el detalle actual — porque se borró la fila o se
		# cambió de transportista —, esa guía se queda "liquidado=1" para
		# siempre aunque esta liquidación ya no la referencie. Como cada
		# guardado reemplaza el detalle completo (ver match_guias, que
		# reevalúa todas las filas desde cero), no hay forma de detectar la
		# fila que desapareció más que comparando contra la versión previa
		# del documento.
		if self.is_new():
			return
		before = self.get_doc_before_save()
		if not before:
			return
		current_keys = {(row.guia, self.transportista) for row in self.detalle if row.guia}
		for old_row in before.detalle:
			key = (old_row.guia, before.transportista)
			if old_row.match_encontrado and old_row.guia and key not in current_keys:
				self._reset_guia_liquidado(old_row.guia, before.transportista)
				_release_or_keep_payment_entry(old_row.payment_entry)

	def match_guias(self):
		for row in self.detalle:
			row.match_encontrado = 0
			row.sales_invoice = None
			# Cualquier PE en borrador de un match anterior de ESTA fila se
			# descarta aquí y, si sigue habiendo match, se recrea abajo con
			# los montos actuales; uno ya sometido se conserva tal cual.
			row.payment_entry = _release_or_keep_payment_entry(row.payment_entry)

			if not row.guia or not self.transportista:
				continue

			matches = frappe.get_all(
				"FacEx Guia Transportista",
				filters={"numero_guia": row.guia, "transportista": self.transportista},
				fields=["name", "parent", "monto_cod"],
			)

			if len(matches) != 1:
				continue

			match = matches[0]
			row.match_encontrado = 1
			row.sales_invoice = match.parent

			if row.payment_entry:
				# El PE que sobrevivió arriba (sometido) quedó ligado a OTRA
				# factura antes de este cambio de guía/transportista — no se
				# puede recrear silenciosamente sin descuadrar Contabilidad.
				linked_invoice = frappe.db.get_value(
					"Payment Entry Reference",
					{"parent": row.payment_entry, "reference_doctype": "Sales Invoice"},
					"reference_name",
				)
				if linked_invoice and linked_invoice != match.parent:
					frappe.throw(
						f"La guía {row.guia} ya tiene un pago sometido ({row.payment_entry}) "
						f"contra la factura {linked_invoice}, pero ahora hace match con "
						f"{match.parent}. Revierta ese pago en Contabilidad antes de reasignar la guía."
					)

			# Lo que realmente cubrió esta liquidación no es el Monto COD que
			# trae la fila (viene tal cual del Excel del transportista, puede
			# no cuadrar), sino Valor Comisión + Monto Liquidado — la
			# comisión retenida más lo depositado sí deben sumar el efectivo
			# real cobrado. Lo que falte contra el Monto COD ORIGINAL de la
			# guía (capturado al facturar) queda como pendiente real.
			cubierto = flt(row.valor_comision) + flt(row.monto_liquidado)
			pendiente = max(flt(match.monto_cod) - cubierto, 0)

			frappe.db.set_value(
				"FacEx Guia Transportista",
				match.name,
				{"liquidado": 1, "fecha_liquidacion": self.fecha, "monto_pendiente": pendiente},
			)

			# Abono automático (Payment Entry en borrador, tipo Transferencia)
			# contra la factura que hizo match — mismo mecanismo de
			# api.invoice._create_payment_entry que usa la pestaña de Pagos.
			# Si ya quedó un PE sometido (rama de arriba), no se crea otro.
			if not row.payment_entry and cubierto > 0.005:
				invoice_doc = frappe.get_doc("Sales Invoice", match.parent)
				row.payment_entry = _create_payment_entry(
					invoice_doc, "Transferencia", self.fecha, row.guia, cubierto
				)

	def _reset_guia_liquidado(self, numero_guia, transportista):
		# monto_pendiente es Currency, Frappe lo crea NOT NULL DEFAULT 0 sin
		# importar el DocType (ver NOT_NULL_TYPES en frappe/database/schema.py),
		# así que no puede guardarse None. No importa: con liquidado=0 el KPI
		# usa monto_cod completo e ignora monto_pendiente, ver get_transporte_kpis.
		frappe.db.set_value(
			"FacEx Guia Transportista",
			{"numero_guia": numero_guia, "transportista": transportista},
			{"liquidado": 0, "fecha_liquidacion": None, "monto_pendiente": 0},
		)
