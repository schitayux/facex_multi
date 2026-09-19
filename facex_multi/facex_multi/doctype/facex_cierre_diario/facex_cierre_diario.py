"""
FacEx Cierre Diario — cierre diario de ventas y cuadre de pagos por
compañía + fecha + usuario (caja).

Toda la lógica de cálculo, congelamiento y permisos vive en
facex_multi.api.cierre; este controlador solo garantiza invariantes básicos
del documento (unicidad, totales, y que un cierre Cerrado no se edite por
fuera del flujo Reabrir de la API).
"""
import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import flt


class FacExCierreDiario(Document):
	def validate(self):
		self._validate_unique()
		self._validate_frozen()
		self.calcular_totales()

	def _validate_unique(self):
		dup = frappe.db.get_value(
			"FacEx Cierre Diario",
			{
				"company": self.company,
				"fecha": self.fecha,
				"usuario": self.usuario,
				"name": ["!=", self.name],
			},
			"name",
		)
		if dup:
			frappe.throw(
				_("Ya existe el cierre {0} para {1} el {2}.").format(
					dup, self.usuario_nombre or self.usuario, frappe.format(self.fecha, {"fieldtype": "Date"})
				)
			)

	def _validate_frozen(self):
		# Un cierre Cerrado es inmutable salvo por la API (flags.facex_cierre_api),
		# que es la única que puede llevarlo a Reabierto / Cerrado.
		if self.is_new() or self.flags.facex_cierre_api:
			return
		prev = self.get_doc_before_save()
		if prev and prev.estado == "Cerrado":
			frappe.throw(_("El cierre {0} está Cerrado. Un usuario de Gerencia debe reabrirlo desde FacEx para modificarlo.").format(self.name))

	def calcular_totales(self):
		self.total_egresos = sum(flt(r.monto) for r in (self.egresos or []))
		self.total_venta = (
			flt(self.venta_sin_descuento) + flt(self.venta_con_descuento)
			+ flt(self.flete_facturado) + flt(self.ajuste_impuestos)
		)
		self.total_cobros = (
			flt(self.cobro_efectivo) + flt(self.cobro_transferencia) + flt(self.cobro_cheque)
			+ flt(self.cobro_tarjeta) + flt(self.cobro_contra_entrega) + flt(self.al_credito)
		)
		# Fórmula del cuadre (según hoja CIERRE VENTA.xlsx): Venta total − Egresos.
		self.total_a_depositar = flt(self.total_venta) - flt(self.total_egresos)
		self.num_facturas = len(self.facturas or [])

	def on_trash(self):
		if self.estado == "Cerrado" and "System Manager" not in frappe.get_roles():
			frappe.throw(_("No se puede eliminar un cierre Cerrado."))
