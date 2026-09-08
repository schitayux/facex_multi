"""
Patch: Inventario — permiso «Ver Costos», base de costo por defecto en Entradas,
reportes nuevos y pantallas de maestros (Costos a Ítems / Almacenes).

- Recarga FacEx Settings para tomar los campos nuevos:
  puede_ver_costos, costo_entrada_por_defecto, reporte_inv_kardex_producto,
  reporte_inv_valuacion, reporte_inv_vencimientos, reporte_inv_rotacion,
  reporte_inv_entradas_proveedor, mantiene_costos_items, mantiene_almacenes.
- Crea el custom field Select `bfel_tipo_almacen` en Warehouse.

Idempotente.
"""
import frappe

from facex_multi.api.permissions import ensure_warehouse_tipo_almacen_field


def execute():
    frappe.reload_doc("facex_multi", "doctype", "facex_settings", force=True)
    ensure_warehouse_tipo_almacen_field()
    frappe.db.commit()
    frappe.clear_cache(doctype="FacEx Settings")
