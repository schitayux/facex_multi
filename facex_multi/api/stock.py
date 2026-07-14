"""
facex_multi.api.stock
----------------------
Interfaz para el módulo de Inventario del page FacEx.
Thin wrapper sobre Stock Entry / Warehouse / Batch / Serial No estándar de ERPNext.
NUNCA duplica lógica de valuación, GL ni de Stock Ledger — eso vive en ERPNext core.
"""
from __future__ import annotations

import frappe
from frappe.utils import today, cint, flt, get_first_day, get_last_day

from facex_multi.api.invoice import get_effective_company, get_user_companies, get_warehouses
from facex_multi.api.permissions import get_facex_inventory_permissions
from facex_multi.api.si_carga import _get_establishments


def get_warehouses_meta(company: str):
    """Almacenes de la compañía con su sucursal (bfel_establecimiento) asignada, si la hay."""
    return frappe.get_all(
        "Warehouse",
        filters={"company": company, "is_group": 0, "disabled": 0},
        fields=["name", "bfel_establecimiento"],
        order_by="name asc",
    )


def get_warehouses_for_establecimiento(company: str, establecimiento_id: str):
    """Nombres de almacén que pertenecen a esa sucursal. '' o None -> sin asignar."""
    meta = get_warehouses_meta(company)
    if not establecimiento_id:
        return [m.name for m in meta if not m.bfel_establecimiento]
    return [m.name for m in meta if m.bfel_establecimiento == establecimiento_id]


@frappe.whitelist()
def get_establishments_for_company(company: str = None):
    """Sucursales (BFEL Establecimientos) activas de la compañía."""
    company = get_effective_company(company)
    return _get_establishments(company)


# Entradas, Salidas y Transferencias comparten toda la lógica de construcción/
# validación de Stock Entry — solo cambian estos parámetros.
_MOVEMENT_CONFIG = {
    "in": {
        "purpose": "Material Receipt",
        "naming_series": "ING-.ABBR.-.####",
        "perm_field": "puede_hacer_entradas",
    },
    "out": {
        "purpose": "Material Issue",
        "naming_series": "SAL-.ABBR.-.####",
        "perm_field": "puede_hacer_salidas",
    },
    "transfer": {
        "purpose": "Material Transfer",
        "naming_series": "TRA-.ABBR.-.####",
        "perm_field": "puede_hacer_transferencias",
    },
}


def _check_item_company(item_code: str, company: str):
    """Misma regla que save_draft() en invoice.py: un ítem con bfel_company
    fijo no puede usarse fuera de esa compañía."""
    item_company = frappe.db.get_value("Item", item_code, "bfel_company")
    if item_company and item_company != company:
        frappe.throw(f"El producto '{item_code}' pertenece a otra compañía y no puede utilizarse aquí.")


def _resolve_batch(item_code: str, batch_id: str, mode: str) -> str:
    """
    mode='in' (Entradas): auto-crea el Batch si no existe — el usuario
    solo escribe un código de lote, no administra el maestro de Batch.
    mode='out'/'transfer': el lote YA debe existir; no se inventa stock
    de un lote que nunca entró.
    """
    batch_id = (batch_id or "").strip()
    if not batch_id:
        frappe.throw("Debe indicar un número de lote para este producto.")
    if frappe.db.exists("Batch", batch_id):
        return batch_id
    if mode != "in":
        frappe.throw(f"El lote '{batch_id}' no existe para este producto.")
    doc = frappe.get_doc({
        "doctype": "Batch",
        "batch_id": batch_id,
        "item": item_code,
    })
    doc.insert(ignore_permissions=True)
    return doc.name


def _get_default_expense_account(item_code: str, company: str) -> str:
    """
    Resuelve la cuenta contable por defecto para la línea de un movimiento,
    en el mismo orden que usa ERPNext nativamente:
    1. Default del ítem para esta compañía (Item Default).
    2. Default del grupo de ítems para esta compañía (Item Group Default).
    3. Cuenta de Ajuste de Existencias de la compañía (Company.stock_adjustment_account).
    """
    if not item_code or not company:
        return ""

    account = frappe.db.get_value(
        "Item Default",
        {"parent": item_code, "parenttype": "Item", "company": company},
        "expense_account",
    )
    if account:
        return account

    item_group = frappe.db.get_value("Item", item_code, "item_group")
    if item_group:
        account = frappe.db.get_value(
            "Item Default",
            {"parent": item_group, "parenttype": "Item Group", "company": company},
            "expense_account",
        )
        if account:
            return account

    return frappe.db.get_value("Company", company, "stock_adjustment_account") or ""


@frappe.whitelist()
def get_default_expense_account(item_code: str, company: str = None):
    """Cuenta contable sugerida para un ítem, usada para prellenar la columna
    'Cuenta Contable' del grid al agregar la fila."""
    company = get_effective_company(company)
    return _get_default_expense_account(item_code, company)


@frappe.whitelist()
def search_items_for_stock(txt: str = None, company: str = None):
    """Busca ítems para el módulo de Inventario, incluyendo flags de lote/serie."""
    company = get_effective_company(company)
    q = f"%{(txt or '').strip()}%"
    return frappe.db.sql(
        """
        SELECT name, item_code, item_name, stock_uom, has_batch_no, has_serial_no
        FROM `tabItem`
        WHERE disabled = 0
          AND is_stock_item = 1
          AND (
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
          AND (%(txt)s = '' OR name LIKE %(q)s OR item_name LIKE %(q)s)
        ORDER BY item_name ASC
        LIMIT 50
        """,
        {"q": q, "company": company, "txt": (txt or "").strip()},
        as_dict=True,
    )


@frappe.whitelist()
def validate_items_bulk(item_codes: str, company: str = None):
    """
    Valida en bloque una lista de códigos de producto — usado por 'Pegar datos'
    (Ctrl+V / botón) para resolver de una sola vez qué filas pegadas corresponden
    a productos reales de esta compañía, sin una consulta por fila.
    Retorna dict {item_code: {item_name, stock_uom, has_batch_no, has_serial_no}}.
    """
    company = get_effective_company(company)
    codes = frappe.parse_json(item_codes) or []
    if not codes:
        return {}
    rows = frappe.db.sql(
        """
        SELECT name, item_name, stock_uom, has_batch_no, has_serial_no
        FROM `tabItem`
        WHERE disabled = 0
          AND is_stock_item = 1
          AND name IN %(codes)s
          AND (
              bfel_company = %(company)s
              OR ((bfel_company IS NULL OR bfel_company = '') AND IFNULL(bfel_company_null, 0) = 0)
          )
        """,
        {"codes": tuple(codes), "company": company},
        as_dict=True,
    )
    return {r.name: r for r in rows}


def _build_stock_entry_items(
    rows: list, company: str, mode: str, default_source: str = None, default_target: str = None
) -> list:
    """
    mode: 'in' (solo t_warehouse) / 'out' (solo s_warehouse) / 'transfer' (ambos).
    Valida cada fila y arma el dict listo para doc.append('items', ...).
    El bloqueo de stock negativo (out/transfer) lo hace ERPNext de forma nativa
    (Stock Settings > Allow Negative Stock) — no se reimplementa aquí.
    """
    built = []
    for i, row in enumerate(rows, start=1):
        item_code = (row.get("item_code") or "").strip()
        if not item_code:
            frappe.throw(f"Fila {i}: falta el producto.")
        if not frappe.db.exists("Item", item_code):
            frappe.throw(f"Fila {i}: el producto '{item_code}' no existe.")

        _check_item_company(item_code, company)

        qty = flt(row.get("qty"))
        if qty <= 0:
            frappe.throw(f"Fila {i} ({item_code}): la cantidad debe ser mayor a cero.")

        item_meta = frappe.db.get_value(
            "Item", item_code, ["stock_uom", "has_batch_no", "has_serial_no"], as_dict=True
        )

        entry_row = {
            "item_code": item_code,
            "qty": qty,
            "uom": row.get("uom") or item_meta.stock_uom,
            "conversion_factor": 1,
        }

        # Costo: solo aplica en Entradas — en Salidas/Transferencias el valor
        # de lo que sale ya lo determina ERPNext (FIFO/Promedio), no se pide.
        if mode == "in":
            entry_row["basic_rate"] = flt(row.get("rate")) or 0
            entry_row["allow_zero_valuation_rate"] = 1 if not row.get("rate") else 0

        # Cuenta contable: aplica en Entradas y Salidas (no en Transferencias,
        # que es un movimiento interno entre almacenes de la misma compañía).
        if mode in ("in", "out"):
            entry_row["expense_account"] = row.get("expense_account") or _get_default_expense_account(item_code, company)

        if mode in ("out", "transfer"):
            s_warehouse = row.get("source_warehouse") or default_source
            if not s_warehouse:
                frappe.throw(f"Fila {i} ({item_code}): falta el almacén origen.")
            entry_row["s_warehouse"] = s_warehouse

        if mode in ("in", "transfer"):
            t_warehouse = row.get("target_warehouse") or default_target
            if not t_warehouse:
                frappe.throw(f"Fila {i} ({item_code}): falta el almacén destino.")
            entry_row["t_warehouse"] = t_warehouse

        if mode == "transfer" and entry_row.get("s_warehouse") == entry_row.get("t_warehouse"):
            frappe.throw(f"Fila {i} ({item_code}): el almacén origen y destino no pueden ser el mismo.")

        if item_meta.has_batch_no:
            entry_row["use_serial_batch_fields"] = 1
            entry_row["batch_no"] = _resolve_batch(item_code, row.get("batch_no"), mode)

        if item_meta.has_serial_no:
            raw = (row.get("serial_no") or "").strip()
            if not raw:
                frappe.throw(f"Fila {i} ({item_code}): este producto requiere número(s) de serie.")
            serials = [s.strip() for s in raw.replace(",", "\n").splitlines() if s.strip()]
            if len(serials) != cint(qty):
                frappe.throw(
                    f"Fila {i} ({item_code}): la cantidad ({cint(qty)}) no coincide "
                    f"con la cantidad de números de serie ingresados ({len(serials)})."
                )
            entry_row["use_serial_batch_fields"] = 1
            entry_row["serial_no"] = "\n".join(serials)

        built.append(entry_row)

    if not built:
        frappe.throw("Debe agregar al menos un producto.")

    return built


def _idempotent_replay(client_token: str):
    """Si este client_token ya generó un documento (doble clic, doble submit,
    reintento de red), retorna ese documento en vez de crear uno nuevo."""
    if not client_token:
        return None
    return frappe.cache().get_value(f"facex_inv_token:{client_token}")


def _remember_token(client_token: str, docname: str):
    if not client_token:
        return
    frappe.cache().set_value(f"facex_inv_token:{client_token}", docname, expires_in_sec=300)


def _create_stock_movement(mode: str, payload: str, client_token: str = None):
    cfg = _MOVEMENT_CONFIG[mode]

    replay = _idempotent_replay(client_token)
    if replay:
        return {"name": replay, "replay": True}

    data = frappe.parse_json(payload)

    company = get_effective_company(data.get("company"))
    if company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)

    perms = get_facex_inventory_permissions(company)
    if not perms.get(cfg["perm_field"]):
        frappe.throw("No tiene permiso para registrar este movimiento de inventario.", frappe.PermissionError)

    source_warehouse = data.get("source_warehouse")
    target_warehouse = data.get("target_warehouse")

    if mode == "transfer" and source_warehouse and target_warehouse and source_warehouse == target_warehouse:
        frappe.throw("El almacén origen y destino no pueden ser el mismo.")

    items = _build_stock_entry_items(
        data.get("items") or [], company, mode,
        default_source=source_warehouse, default_target=target_warehouse,
    )

    doc_fields = {
        "doctype": "Stock Entry",
        "naming_series": cfg["naming_series"],
        "stock_entry_type": cfg["purpose"],
        "purpose": cfg["purpose"],
        "company": company,
        "posting_date": data.get("posting_date") or today(),
        "remarks": data.get("remarks"),
        "items": items,
    }
    if mode in ("out", "transfer"):
        doc_fields["from_warehouse"] = source_warehouse
    if mode in ("in", "transfer"):
        doc_fields["to_warehouse"] = target_warehouse

    doc = frappe.get_doc(doc_fields)
    doc.flags.ignore_permissions = False
    doc.insert()
    doc.submit()
    frappe.db.commit()

    _remember_token(client_token, doc.name)

    return {"name": doc.name}


@frappe.whitelist()
def create_stock_entry_in(payload: str, client_token: str = None):
    """Crea y somete una Entrada de Inventario (Stock Entry, Material Receipt)."""
    return _create_stock_movement("in", payload, client_token)


@frappe.whitelist()
def create_stock_entry_out(payload: str, client_token: str = None):
    """Crea y somete una Salida de Inventario (Stock Entry, Material Issue).
    Si no hay existencia suficiente, ERPNext la rechaza de forma nativa
    (Stock Settings > Allow Negative Stock)."""
    return _create_stock_movement("out", payload, client_token)


@frappe.whitelist()
def create_stock_entry_transfer(payload: str, client_token: str = None):
    """Crea y somete una Transferencia de Inventario (Stock Entry, Material Transfer)
    entre dos almacenes de la MISMA compañía."""
    return _create_stock_movement("transfer", payload, client_token)


@frappe.whitelist()
def get_item_stock_summary(item_code: str, company: str = None):
    """Existencia y costo actual del ítem por almacén, para el flotante rápido del grid."""
    company = get_effective_company(company)
    return frappe.db.sql(
        """
        SELECT b.warehouse, b.actual_qty, b.valuation_rate
        FROM `tabBin` b
        INNER JOIN `tabWarehouse` w ON w.name = b.warehouse
        WHERE b.item_code = %(item_code)s AND w.company = %(company)s
        ORDER BY b.actual_qty DESC
        """,
        {"item_code": item_code, "company": company},
        as_dict=True,
    )


@frappe.whitelist()
def get_valuation_rates(item_codes: str, warehouse: str = None):
    """
    Costo de valuación actual (Bin.valuation_rate) para varios ítems en un
    almacén — usado para el pie de totales de Salidas, donde el costo NO lo
    captura el usuario: lo trae el sistema.
    """
    codes = frappe.parse_json(item_codes) or []
    if not codes or not warehouse:
        return {}
    rows = frappe.get_all(
        "Bin",
        filters={"item_code": ["in", codes], "warehouse": warehouse},
        fields=["item_code", "valuation_rate"],
    )
    return {r.item_code: r.valuation_rate for r in rows}


@frappe.whitelist()
def get_available_serials(item_code: str, warehouse: str):
    """Números de serie actualmente disponibles (Activos) de un ítem en un
    almacén — para el selector de series de Salidas/Transferencias."""
    if not warehouse:
        return []
    return frappe.get_all(
        "Serial No",
        filters={"item_code": item_code, "warehouse": warehouse, "status": "Active"},
        pluck="name",
        order_by="creation asc",
    )


@frappe.whitelist()
def cancel_stock_entry(name: str):
    """Anula (cancel nativo de ERPNext) un movimiento de inventario ya sometido."""
    doc = frappe.get_doc("Stock Entry", name)

    if doc.company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)

    perms = get_facex_inventory_permissions(doc.company)
    if not perms.get("puede_cancelar_movimientos"):
        frappe.throw("No tiene permiso para anular movimientos de inventario.", frappe.PermissionError)

    doc.flags.ignore_permissions = False
    doc.cancel()
    frappe.db.commit()

    return {"name": doc.name, "docstatus": doc.docstatus}


@frappe.whitelist()
def get_inventory_defaults(company: str = None):
    """
    Datos base para inicializar la pantalla de Inventario:
    compañía efectiva, compañías permitidas, almacenes y permisos del
    usuario actual para esa compañía.
    """
    allowed_companies = get_user_companies()
    company = get_effective_company(company)

    if company and allowed_companies and company not in allowed_companies:
        company = allowed_companies[0]

    permissions = get_facex_inventory_permissions(company)
    warehouses = get_warehouses(company) if permissions.get("puede_ver_inventario") else []
    establishments = _get_establishments(company) if permissions.get("puede_ver_inventario") else []
    warehouses_meta = get_warehouses_meta(company) if permissions.get("puede_ver_inventario") else []

    return {
        "company": company,
        "companies": allowed_companies,
        "warehouses": warehouses,
        "warehouses_meta": warehouses_meta,
        "establishments": establishments,
        "permissions": permissions,
    }


def _list_stock_movements(mode: str, company: str = None, from_date: str = None, to_date: str = None):
    cfg = _MOVEMENT_CONFIG[mode]

    company = get_effective_company(company)
    if company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)

    perms = get_facex_inventory_permissions(company)
    if not perms.get(cfg["perm_field"]):
        frappe.throw("No tiene permiso para ver estos movimientos de inventario.", frappe.PermissionError)

    from_date = from_date or get_first_day(today())
    to_date = to_date or get_last_day(today())

    rows = frappe.db.sql(
        """
        SELECT
            se.name, se.posting_date, se.from_warehouse, se.to_warehouse, se.docstatus,
            se.remarks, se.owner, se.creation,
            se.total_incoming_value, se.total_outgoing_value,
            (SELECT COUNT(*) FROM `tabStock Entry Detail` sed WHERE sed.parent = se.name) AS item_count
        FROM `tabStock Entry` se
        WHERE se.company = %(company)s
          AND se.purpose = %(purpose)s
          AND se.posting_date BETWEEN %(from_date)s AND %(to_date)s
        ORDER BY se.posting_date DESC, se.creation DESC
        LIMIT 500
        """,
        {"company": company, "purpose": cfg["purpose"], "from_date": from_date, "to_date": to_date},
        as_dict=True,
    )

    return {"from_date": str(from_date), "to_date": str(to_date), "rows": rows}


@frappe.whitelist()
def list_stock_entries_in(company: str = None, from_date: str = None, to_date: str = None):
    return _list_stock_movements("in", company, from_date, to_date)


@frappe.whitelist()
def list_stock_entries_out(company: str = None, from_date: str = None, to_date: str = None):
    return _list_stock_movements("out", company, from_date, to_date)


@frappe.whitelist()
def list_stock_entries_transfer(company: str = None, from_date: str = None, to_date: str = None):
    return _list_stock_movements("transfer", company, from_date, to_date)


@frappe.whitelist()
def get_stock_entry_detail(name: str):
    """Detalle de un movimiento ya creado, para reabrirlo desde la pestaña de Movimientos."""
    doc = frappe.get_doc("Stock Entry", name)
    if doc.company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)

    mode_by_purpose = {
        "Material Receipt": "in",
        "Material Issue": "out",
        "Material Transfer": "transfer",
    }
    mode = mode_by_purpose.get(doc.purpose, "other")

    return {
        "name": doc.name,
        "mode": mode,
        "source_warehouse": doc.from_warehouse,
        "target_warehouse": doc.to_warehouse,
        "posting_date": str(doc.posting_date),
        "remarks": doc.remarks,
        "docstatus": doc.docstatus,
        "items": [
            {
                "item_code": d.item_code,
                "item_name": frappe.db.get_value("Item", d.item_code, "item_name"),
                "qty": d.qty,
                "uom": d.uom,
                "batch_no": d.batch_no,
                "serial_no": d.serial_no,
                "rate": d.basic_rate,
                "expense_account": d.expense_account,
            }
            for d in doc.items
        ],
    }
