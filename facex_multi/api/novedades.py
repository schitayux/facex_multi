import frappe
from frappe.utils import today

SITE = "neko.chappsa.com"
FECHA = "2026-10-06"


def boot_session(bootinfo):
	"""Marca el boot para mostrar el aviso de novedades una vez por inicio de sesión (solo neko, solo el día indicado)."""
	if frappe.local.site != SITE or today() != FECHA or frappe.session.user == "Guest":
		return
	key = f"facex_novedades_{frappe.session.sid}"
	if frappe.cache.get_value(key):
		return
	frappe.cache.set_value(key, 1, expires_in_sec=86400)
	bootinfo.facex_novedades = 1
