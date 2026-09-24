# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document


class FacExPerfildePermisos(Document):
	"""Perfil de permisos FacEx compartido por todas las compañías del sitio.
	Al guardarlo se propaga a las filas de FacEx Settings que lo usan,
	conservando las excepciones de cada una (ver api/perfiles.py)."""

	def validate(self):
		self.usuarios_asignados = frappe.db.count("FacEx Settings", {"perfil": self.name}) if not self.is_new() else 0

	def on_update(self):
		if self.flags.skip_propagation:
			return
		from facex_multi.api.perfiles import propagate_profile
		n = propagate_profile(self)
		if n:
			frappe.msgprint(f"Perfil aplicado a {n} usuario(s), conservando sus excepciones.", alert=True)

	def on_trash(self):
		n = frappe.db.count("FacEx Settings", {"perfil": self.name})
		if n:
			frappe.throw(f"No se puede eliminar: {n} usuario(s) tienen asignado este perfil.")
