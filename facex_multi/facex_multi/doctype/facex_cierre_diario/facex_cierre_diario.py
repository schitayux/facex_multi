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
		# Tres cifras distintas (ver facex_multi.api.cierre.compute_snapshot):
		#   venta_neta      — ingreso propio (líneas + cargos que SÍ son venta).
		#   cargos_pasarela — recargo/flete que el cliente paga por el servicio de
		#                     entrega y el transportista descuenta al liquidar.
		#   total_venta     — TOTAL FACTURADO: la suma de las dos.
		# Antes esto era un solo "TOTAL VENTA DEL DÍA" que además omitía el
		# recargo, así que no cuadraba con el snapshot.
		self.venta_neta = (
			flt(self.venta_sin_descuento) + flt(self.venta_con_descuento)
			+ self._snap("cargos_venta") + flt(self.ajuste_impuestos)
		)
		self.cargos_pasarela = flt(self.recargo_pasarela) + flt(self.flete_pasarela)
		self.total_venta = flt(self.venta_neta) + flt(self.cargos_pasarela)
		self.total_cobros = (
			flt(self.cobro_efectivo) + flt(self.cobro_transferencia) + flt(self.cobro_cheque)
			+ flt(self.cobro_tarjeta) + flt(self.cobro_contra_entrega) + flt(self.al_credito)
		)
		# Fórmula del cuadre: solo el efectivo cobrado en el día es lo que se
		# entrega físicamente para depósito (transferencias, depósitos bancarios,
		# tarjeta, cheque, contra entrega y crédito no pasan por la caja). Incluye
		# el efectivo recuperado hoy de facturas anteriores (sección Recuperación
		# de cartera del snapshot).
		self.total_a_depositar = (
			flt(self.cobro_efectivo) + self._snap("recuperado_efectivo") - flt(self.total_egresos)
		)
		# Parte del depósito que son cargos de terceros cobrados en efectivo. Es
		# informativo y NO se resta: el cajero entrega el efectivo que tiene, y
		# restarlo haría que el arqueo marcara un sobrante todos los días.
		self.deposito_cargos_terceros = self._snap("deposito_cargos_terceros")
		self.num_facturas = len(self.facturas or [])

	def _snap(self, key: str) -> float:
		"""Cifra del snapshot que no tiene campo propio en el documento (se lee de
		`snapshot_json` para no migrar el DocType por cada dato informativo)."""
		try:
			return flt((frappe.parse_json(self.snapshot_json or "{}") or {}).get(key))
		except Exception:
			return 0.0

	def on_trash(self):
		if self.estado == "Cerrado" and "System Manager" not in frappe.get_roles():
			frappe.throw(_("No se puede eliminar un cierre Cerrado."))
