"""
FacEx Comision Liquidacion — liquidación de comisiones de vendedores por
compañía + período (Page «facex-comisiones»).

Toda la lógica (cálculo, permisos, cierre) vive en facex_multi.api.comisiones;
el controlador solo garantiza invariantes: un solo documento por período, y
que una liquidación Cerrada no se edite ni se borre por fuera de la API.
"""
import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import getdate


class FacExComisionLiquidacion(Document):
	def validate(self):
		if getdate(self.fecha_desde) > getdate(self.fecha_hasta):
			frappe.throw(_("La fecha inicial no puede ser mayor a la final."))
		otro = frappe.db.exists("FacEx Comision Liquidacion", {
			"company": self.company, "fecha_desde": self.fecha_desde,
			"fecha_hasta": self.fecha_hasta, "name": ["!=", self.name],
		})
		if otro:
			frappe.throw(_("Ya existe la liquidación {0} para ese período.").format(otro))
		if not self.is_new() and not self.flags.facex_comision_api and \
				frappe.db.get_value(self.doctype, self.name, "estado") == "Cerrada":
			frappe.throw(_("Una liquidación Cerrada no se puede modificar."))

	def on_trash(self):
		if self.estado == "Cerrada" and not self.flags.facex_comision_api:
			frappe.throw(_("Una liquidación Cerrada no se puede eliminar."))
