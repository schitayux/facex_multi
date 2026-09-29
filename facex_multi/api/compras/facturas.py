"""
facex_multi.api.compras.facturas
--------------------------------
Factura de Compra (Purchase Invoice) desde FacEx Compras.

Búsquedas de proveedores/productos, carga desde Excel y los endpoints
históricos de la factura (delegan en documentos.py, que maneja OC / Entrada /
Factura con el mismo código).
"""
from __future__ import annotations

import frappe
from frappe.utils import flt, today

from facex_multi.api.compras.common import (
    default_uom,
    get_tax_templates_with_rate,
    require_purchase,
    resolve_item_warehouse,
)


# ---------------------------------------------------------------------------
# Búsquedas
# ---------------------------------------------------------------------------

@frappe.whitelist()
def search_items(txt: str = "", company: str = None) -> list:
    """Ítems comprables por código o nombre, con la bodega de recepción sugerida."""
    company = require_purchase(company, "puede_compras")

    results = frappe.db.get_all(
        "Item",
        filters=[["disabled", "=", 0], ["is_purchase_item", "=", 1]],
        or_filters=[["name", "like", f"%{txt}%"], ["item_name", "like", f"%{txt}%"]],
        fields=["name as item_code", "item_name", "item_group",
                "has_serial_no", "has_batch_no", "is_stock_item", "stock_uom"],
        order_by="item_code asc",
        limit=25,
    )

    from facex_multi.api.permissions import get_facex_allowed_warehouses
    allowed_warehouses = get_facex_allowed_warehouses(company, "compra")

    return [
        {
            "item_code":     r.item_code,
            "item_name":     r.item_name,
            "item_group":    r.item_group,
            "has_serial_no": int(r.has_serial_no or 0),
            "has_batch_no":  int(r.has_batch_no or 0),
            "is_stock_item": int(r.is_stock_item or 0),
            "uom":           r.stock_uom or default_uom(),
            "warehouse":     resolve_item_warehouse(r.item_code, company, allowed_warehouses) if r.is_stock_item else "",
        }
        for r in results
    ]


@frappe.whitelist()
def search_suppliers(txt: str = "", company: str = None) -> list:
    """Proveedores activos de la compañía (o sin compañía asignada)."""
    company = require_purchase(company, "puede_compras")
    results = frappe.db.sql(
        """
        SELECT name, supplier_name, tax_id
        FROM `tabSupplier`
        WHERE disabled = 0
          AND (supplier_name LIKE %(q)s OR name LIKE %(q)s OR tax_id LIKE %(q)s)
          AND (bfel_company = %(company)s OR bfel_company IS NULL OR bfel_company = '')
        ORDER BY supplier_name ASC
        LIMIT 20
        """,
        {"q": f"%{txt}%", "company": company},
        as_dict=True,
    )
    return [{"value": r.name, "label": r.supplier_name, "tax_id": r.tax_id or ""} for r in results]


# ---------------------------------------------------------------------------
# Lista / lectura / grabar / validar / cancelar
# ---------------------------------------------------------------------------
# La lógica vive en documentos.py (común a OC / Entrada / Factura); estos
# nombres se conservan porque api/purchase.py los re-exporta.

@frappe.whitelist()
def get_purchase_list(company: str = None, start_date: str = None, end_date: str = None,
                      supplier: str = None, docstatus: str = None, limit: int = 100) -> list:
    from facex_multi.api.compras.documentos import get_document_list
    rows = get_document_list("fc", company, start_date, end_date, supplier, docstatus, limit)
    for r in rows:
        r["posting_date"] = r.get("fecha")
    return rows


@frappe.whitelist()
def get_purchase_invoice(name: str, company: str = None) -> dict:
    from facex_multi.api.compras.documentos import get_document
    return get_document("fc", name, company)


@frappe.whitelist()
def save_purchase_invoice(data_json: str) -> dict:
    from facex_multi.api.compras.documentos import save_document
    return save_document("fc", data_json)


@frappe.whitelist()
def submit_purchase_invoice(name: str) -> dict:
    from facex_multi.api.compras.documentos import submit_document
    return submit_document("fc", name)


@frappe.whitelist()
def cancel_purchase_invoice(name: str) -> dict:
    from facex_multi.api.compras.documentos import cancel_document
    return cancel_document("fc", name)


@frappe.whitelist()
def delete_purchase_invoice(name: str) -> dict:
    from facex_multi.api.compras.documentos import delete_document
    return delete_document("fc", name)


# ---------------------------------------------------------------------------
# Carga desde Excel
# ---------------------------------------------------------------------------

@frappe.whitelist()
def process_purchase_excel(file_url: str, company: str = None) -> dict:
    """
    Parsea Excel con 2 hojas:
      Hoja 1 – ENCABEZADO (fila 2): proveedor | fecha_registro | no_factura | fecha_factura | moneda
      Hoja 2 – DETALLE (desde fila 2): codigo_item | precio_unitario | serie | lote
    Una fila por unidad para ítems con serie; varias filas sin serie se acumulan
    (agrupadas por código + lote).
    """
    import openpyxl
    from frappe.utils.file_manager import get_file_path

    company = require_purchase(company, "puede_compras")
    wb = openpyxl.load_workbook(get_file_path(file_url), data_only=True)

    from facex_multi.api.permissions import get_facex_allowed_warehouses
    allowed_warehouses = get_facex_allowed_warehouses(company, "compra")

    ws_h = wb.worksheets[0]
    rows_h = list(ws_h.iter_rows(min_row=2, values_only=True))
    if not rows_h or not rows_h[0][0]:
        frappe.throw("La hoja ENCABEZADO está vacía o mal formada.")
    h = rows_h[0]

    def _val(v, default=""):
        return str(v).strip() if v is not None else default

    header = {
        "supplier":     _val(h[0] if len(h) > 0 else ""),
        "posting_date": _val(h[1], today()),
        "bill_no":      _val(h[2] if len(h) > 2 else ""),
        "bill_date":    _val(h[3] if len(h) > 3 else None, _val(h[1], today())),
        "currency":     _val(h[4] if len(h) > 4 else "GTQ", "GTQ").upper() or "GTQ",
    }
    if len(wb.worksheets) < 2:
        frappe.throw("Falta la hoja DETALLE (segunda hoja del archivo).")
    rows_d = list(wb.worksheets[1].iter_rows(min_row=2, values_only=True))

    order, groups = [], {}
    for row in rows_d:
        if not row or not row[0]:
            continue
        item_code = str(row[0]).strip()
        rate = flt(row[1] if len(row) > 1 else 0)
        serial = str(row[2]).strip() if len(row) > 2 and row[2] else ""
        batch = str(row[3]).strip() if len(row) > 3 and row[3] else ""
        key = (item_code, batch)
        if key not in groups:
            order.append(key)
            groups[key] = {"rate": rate, "serials": [], "qty": 0, "batch": batch}
        if serial:
            groups[key]["serials"].append(serial)
        else:
            groups[key]["qty"] += 1
        if rate:
            groups[key]["rate"] = rate

    items, errors = [], []
    for item_code, _batch in order:
        g = groups[(item_code, _batch)]
        info = frappe.db.get_value(
            "Item", item_code,
            ["item_name", "item_group", "has_serial_no", "has_batch_no", "is_stock_item", "stock_uom"],
            as_dict=True,
        )
        if not info:
            errors.append(f"Producto '{item_code}' no encontrado en el sistema.")
            continue
        has_serial = int(info.has_serial_no or 0)
        has_batch = int(info.has_batch_no or 0)
        if has_serial and g["serials"]:
            qty, serial_no = len(g["serials"]), "\n".join(g["serials"])
        else:
            qty, serial_no = g["qty"] or 1, ""
        if has_serial and not serial_no:
            errors.append(f"'{item_code}' maneja series pero no se encontraron números de serie.")
        if has_batch and not g["batch"]:
            errors.append(f"'{item_code}' se gestiona por lote pero la columna 'lote' viene vacía.")
        items.append({
            "item_code":     item_code,
            "item_name":     info.item_name,
            "item_group":    info.item_group,
            "has_serial_no": has_serial,
            "has_batch_no":  has_batch,
            "is_stock_item": int(info.is_stock_item or 0),
            "uom":           info.stock_uom or default_uom(),
            "qty":           qty,
            "rate":          g["rate"],
            "warehouse":     resolve_item_warehouse(item_code, company, allowed_warehouses) if info.is_stock_item else "",
            "serial_no":     serial_no,
            "batch_no":      g["batch"],
        })

    return {"header": header, "items": items, "errors": errors}


@frappe.whitelist()
def get_purchase_tax_templates(company: str = None) -> list:
    company = require_purchase(company, "puede_compras")
    return get_tax_templates_with_rate(company)
