"""
facex_multi.api.traslados
-------------------------
Flujo de Recepción y Devolución de Traslados en Tránsito para el módulo de
Inventario de FacEx.

Concepto: el emisor hace un traslado normal (Material Transfer) cuyo destino es el
«Almacén de Tránsito» del receptor (FacEx Settings > transito_por_defecto). El
receptor abre «Recepción de Traslados», ve lo que le llegó a su tránsito, escanea
lo que acepta y el sistema:
  - crea y somete un traslado automático  tránsito -> su bodega  con lo recibido;
  - por lo no recibido, cada ítem queda «pendiente de recepción» (otro pase) o
    «pendiente de devolución» (con motivo opcional).
Las devoluciones se procesan aparte: elegir bodega destino (de bodegas_habilitadas)
y confirmar -> traslado automático  tránsito -> bodega elegida.

El estado y las cantidades por ítem viven en el DocType `FacEx Recepcion Traslado`.
Todo el movimiento de stock/valuación/GL sigue en ERPNext core.
"""
from __future__ import annotations

import frappe
from frappe.utils import flt, today

from facex_multi.api.invoice import get_effective_company, get_user_companies, get_warehouses
from facex_multi.api.item import _variantes_layout_teclado
from facex_multi.api.permissions import (
    get_facex_allowed_warehouses,
    get_facex_can_receive_traslados,
    get_facex_default_warehouse,
    get_facex_transito_warehouse,
)
from facex_multi.api.stock import _build_and_submit_stock_entry, _build_stock_entry_items


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _guard(company: str = None) -> str:
    company = get_effective_company(company)
    if company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)
    if not get_facex_can_receive_traslados(company):
        frappe.throw("No tiene permiso para recibir traslados.", frappe.PermissionError)
    return company


def _require_transito(company: str) -> str:
    transito = get_facex_transito_warehouse(company)
    if not transito:
        frappe.throw("No tiene configurado un Almacén de Tránsito en FacEx Settings.")
    allowed = get_facex_allowed_warehouses(company)
    if allowed is not None and transito not in allowed:
        frappe.throw(
            "Su Almacén de Tránsito no está entre sus Bodegas Habilitadas. "
            "Pida a un administrador que lo agregue."
        )
    return transito


def _allowed_destinos(company: str) -> list:
    """Bodegas a las que el usuario puede dar de alta / devolver stock."""
    allowed = get_facex_allowed_warehouses(company)
    todas = get_warehouses(company) or []
    if allowed is None:
        return todas
    return [w for w in todas if w in allowed]


def _origin_transfer_condition(alias: str = "se") -> str:
    """Un Stock Entry Material Transfer 'apunta al tránsito' si su header
    to_warehouse es el tránsito, o si alguna línea tiene t_warehouse = tránsito."""
    return (
        f"({alias}.to_warehouse = %(transito)s "
        f"OR EXISTS (SELECT 1 FROM `tabStock Entry Detail` sd "
        f"WHERE sd.parent = {alias}.name AND sd.t_warehouse = %(transito)s))"
    )


def _transit_bin_qty(company: str, transito: str, item_codes: list) -> dict:
    if not item_codes:
        return {}
    rows = frappe.db.sql(
        """
        SELECT b.item_code, b.actual_qty
        FROM `tabBin` b
        WHERE b.warehouse = %(transito)s AND b.item_code IN %(codes)s
        """,
        {"transito": transito, "codes": tuple(item_codes)},
        as_dict=True,
    )
    return {r.item_code: flt(r.actual_qty) for r in rows}


def _origin_items(stock_entry: str) -> list:
    """Líneas del traslado origen que entraron al tránsito, agregadas por
    (item, lote). Las series se concatenan."""
    rows = frappe.db.sql(
        """
        SELECT sed.item_code, i.item_name, sed.uom, sed.stock_uom,
               sed.batch_no, sed.serial_no, SUM(sed.qty) AS qty,
               i.has_serial_no, i.has_batch_no
        FROM `tabStock Entry Detail` sed
        INNER JOIN `tabItem` i ON i.name = sed.item_code
        WHERE sed.parent = %(se)s
        GROUP BY sed.item_code, sed.batch_no, sed.serial_no, sed.uom, sed.stock_uom
        ORDER BY sed.item_code
        """,
        {"se": stock_entry},
        as_dict=True,
    )
    return rows


def _get_recepcion(stock_entry: str):
    name = frappe.db.get_value("FacEx Recepcion Traslado", {"stock_entry_origen": stock_entry}, "name")
    return frappe.get_doc("FacEx Recepcion Traslado", name) if name else None


def _origin_header(stock_entry: str) -> dict:
    se = frappe.db.get_value(
        "Stock Entry", stock_entry,
        ["name", "company", "purpose", "docstatus", "from_warehouse", "to_warehouse", "posting_date"],
        as_dict=True,
    )
    if not se:
        frappe.throw("El traslado indicado no existe.")
    if se.purpose != "Material Transfer" or se.docstatus != 1:
        frappe.throw("El documento indicado no es un traslado sometido.")
    return se


# ---------------------------------------------------------------------------
# Listados
# ---------------------------------------------------------------------------

@frappe.whitelist()
def list_traslados_pendientes(company: str = None):
    """Traslados sometidos dirigidos al tránsito del usuario que todavía tienen
    stock por ingresar (o por decidir), y que efectivamente tienen stock cargado
    en el tránsito."""
    company = _guard(company)
    transito = _require_transito(company)

    rows = frappe.db.sql(
        f"""
        SELECT se.name, se.posting_date, se.from_warehouse,
               (SELECT COUNT(*) FROM `tabStock Entry Detail` sd WHERE sd.parent = se.name) AS item_count,
               rt.name AS recepcion, rt.estado AS recepcion_estado,
               rt.total_pendiente_recepcion, rt.total_pendiente_devolucion
        FROM `tabStock Entry` se
        LEFT JOIN `tabFacEx Recepcion Traslado` rt ON rt.stock_entry_origen = se.name
        WHERE se.company = %(company)s
          AND se.purpose = 'Material Transfer'
          AND se.docstatus = 1
          AND {_origin_transfer_condition("se")}
          AND (rt.name IS NULL OR rt.total_pendiente_recepcion > 0)
        ORDER BY se.posting_date DESC, se.creation DESC
        LIMIT 200
        """,
        {"company": company, "transito": transito},
        as_dict=True,
    )
    if not rows:
        return {"transito": transito, "rows": []}

    out = []
    for r in rows:
        items = _origin_items(r.name)
        codes = list({it.item_code for it in items})
        bin_qty = _transit_bin_qty(company, transito, codes)
        if not any(flt(bin_qty.get(c)) > 0 for c in codes):
            continue  # sin stock cargado en el tránsito -> no se puede recibir aún

        if r.recepcion:
            pendiente = flt(r.total_pendiente_recepcion)
        else:
            pendiente = sum(flt(it.qty) for it in items)
        out.append({
            "name": r.name,
            "posting_date": str(r.posting_date or ""),
            "from_warehouse": r.from_warehouse,
            "item_count": r.item_count,
            "unidades_pendientes": pendiente,
            "recepcion": r.recepcion,
            "estado": r.recepcion_estado or "Sin iniciar",
        })
    return {"transito": transito, "rows": out}


@frappe.whitelist()
def list_devoluciones_pendientes(company: str = None):
    company = _guard(company)
    _require_transito(company)
    rows = frappe.get_all(
        "FacEx Recepcion Traslado",
        filters={"company": company, "total_pendiente_devolucion": [">", 0]},
        fields=["name", "stock_entry_origen", "almacen_origen", "fecha_origen",
                "total_pendiente_devolucion", "estado"],
        order_by="modified desc",
        limit=200,
    )
    return {"rows": rows}


# ---------------------------------------------------------------------------
# Detalle para las pantallas
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_traslado_para_recepcion(stock_entry: str, company: str = None):
    company = _guard(company)
    transito = _require_transito(company)
    se = _origin_header(stock_entry)
    if se.company != company:
        frappe.throw("Ese traslado pertenece a otra compañía.")

    rec = _get_recepcion(stock_entry)
    origin = _origin_items(stock_entry)
    codes = list({it.item_code for it in origin})
    bin_qty = _transit_bin_qty(company, transito, codes)

    items = []
    if rec:
        for row in rec.items:
            if flt(row.qty_pendiente_recepcion) <= 0:
                continue
            items.append({
                "item_code": row.item_code, "item_name": row.item_name, "uom": row.uom,
                "batch_no": row.batch_no, "serial_no": row.serial_no,
                "has_serial_no": frappe.db.get_value("Item", row.item_code, "has_serial_no"),
                "qty_enviada": flt(row.qty_enviada),
                "qty_pendiente": flt(row.qty_pendiente_recepcion),
                "bin_transito": flt(bin_qty.get(row.item_code)),
            })
    else:
        for it in origin:
            items.append({
                "item_code": it.item_code, "item_name": it.item_name,
                "uom": it.uom or it.stock_uom,
                "batch_no": it.batch_no, "serial_no": it.serial_no,
                "has_serial_no": it.has_serial_no,
                "qty_enviada": flt(it.qty),
                "qty_pendiente": flt(it.qty),
                "bin_transito": flt(bin_qty.get(it.item_code)),
            })

    motivos = frappe.get_all(
        "FacEx Motivo Devolucion", filters={"activo": 1},
        fields=["name", "motivo", "bodega_destino_sugerida"], order_by="motivo asc",
    )
    return {
        "stock_entry": stock_entry,
        "from_warehouse": se.from_warehouse,
        "transito": transito,
        "recepcion": rec.name if rec else None,
        "items": items,
        "motivos": motivos,
        "destinos": _allowed_destinos(company),
        "destino_defecto": get_facex_default_warehouse(company),
    }


@frappe.whitelist()
def get_devolucion_detalle(recepcion: str, company: str = None):
    company = _guard(company)
    _require_transito(company)
    rec = frappe.get_doc("FacEx Recepcion Traslado", recepcion)
    if rec.company != company:
        frappe.throw("Esa recepción pertenece a otra compañía.")

    items = []
    for row in rec.items:
        if flt(row.qty_pendiente_devolucion) <= 0:
            continue
        items.append({
            "item_code": row.item_code, "item_name": row.item_name, "uom": row.uom,
            "batch_no": row.batch_no, "serial_no": row.serial_no,
            "has_serial_no": frappe.db.get_value("Item", row.item_code, "has_serial_no"),
            "qty_pendiente_devolucion": flt(row.qty_pendiente_devolucion),
            "motivo_devolucion": row.motivo_devolucion,
        })
    return {
        "recepcion": recepcion,
        "transito": rec.almacen_transito,
        "items": items,
        "destinos": _allowed_destinos(company),
    }


# ---------------------------------------------------------------------------
# Escaneo
# ---------------------------------------------------------------------------

@frappe.whitelist()
def resolver_codigo_escaneado(stock_entry: str, code: str, company: str = None):
    """Resuelve un escaneo (QR / código de barras / tecleo) contra los ítems del
    traslado: por código de ítem (con variantes de layout de teclado), por código
    de barras (Item Barcode) o por N° de serie presente en el traslado."""
    company = _guard(company)
    code = (code or "").strip()
    if not code:
        return None

    origin = _origin_items(stock_entry)
    item_codes = {it.item_code for it in origin}
    if not item_codes:
        return None

    # 1. Código de ítem exacto (con variantes guion <-> comilla del lector)
    for variante in _variantes_layout_teclado(code):
        if variante in item_codes:
            return {"item_code": variante, "tipo": "item"}

    # 2. Código de barras (Item Barcode) que pertenezca a un ítem del traslado
    bc = frappe.db.sql(
        """
        SELECT parent AS item_code FROM `tabItem Barcode`
        WHERE barcode = %(code)s AND parent IN %(codes)s LIMIT 1
        """,
        {"code": code, "codes": tuple(item_codes)},
        as_dict=True,
    )
    if bc:
        return {"item_code": bc[0].item_code, "tipo": "item"}

    # 3. N° de serie presente en alguna línea del traslado
    for it in origin:
        serials = {s.strip() for s in (it.serial_no or "").replace(",", "\n").splitlines() if s.strip()}
        if code in serials:
            return {"item_code": it.item_code, "tipo": "serie", "serial_no": code}

    return None


# ---------------------------------------------------------------------------
# Procesar recepción
# ---------------------------------------------------------------------------

def _upsert_recepcion(company, se_header, transito):
    rec = _get_recepcion(se_header.name)
    if rec:
        return rec
    origin = _origin_items(se_header.name)
    rec = frappe.get_doc({
        "doctype": "FacEx Recepcion Traslado",
        "company": company,
        "stock_entry_origen": se_header.name,
        "almacen_transito": transito,
        "almacen_origen": se_header.from_warehouse,
        "usuario": frappe.session.user,
        "fecha_origen": se_header.posting_date,
        "items": [
            {
                "item_code": it.item_code,
                "uom": it.uom or it.stock_uom,
                "batch_no": it.batch_no,
                "serial_no": it.serial_no,
                "qty_enviada": flt(it.qty),
                "qty_recibida": 0,
                "qty_pendiente_recepcion": flt(it.qty),
                "qty_pendiente_devolucion": 0,
                "qty_devuelta": 0,
            }
            for it in origin
        ],
    })
    rec.insert(ignore_permissions=True)
    return rec


def _match_rec_row(rec, item_code, batch_no):
    for row in rec.items:
        if row.item_code == item_code and (row.batch_no or "") == (batch_no or ""):
            return row
    # fallback: solo por item_code
    for row in rec.items:
        if row.item_code == item_code:
            return row
    return None


@frappe.whitelist()
def procesar_recepcion(payload: str):
    """payload = {stock_entry, destino_warehouse,
        items: [{item_code, batch_no, serial_no, qty_recibida,
                 resto: 'devolucion'|'recepcion', motivo_devolucion?}]}"""
    data = frappe.parse_json(payload)
    company = _guard(data.get("company"))
    transito = _require_transito(company)

    se = _origin_header(data.get("stock_entry"))
    if se.company != company:
        frappe.throw("Ese traslado pertenece a otra compañía.")

    destino = data.get("destino_warehouse")
    if not destino:
        frappe.throw("Seleccione la bodega destino.")

    payload_items = data.get("items") or []
    rec = _upsert_recepcion(company, se, transito)

    transfer_rows = []
    resumen = {"recibido": 0.0, "pendiente_recepcion": 0.0, "pendiente_devolucion": 0.0}

    for pi in payload_items:
        item_code = (pi.get("item_code") or "").strip()
        batch_no = pi.get("batch_no") or None
        row = _match_rec_row(rec, item_code, batch_no)
        if not row:
            continue

        pendiente = flt(row.qty_pendiente_recepcion)
        if pendiente <= 0:
            continue

        recibida = min(flt(pi.get("qty_recibida")), pendiente)
        if recibida < 0:
            recibida = 0

        has_serial = bool(frappe.db.get_value("Item", item_code, "has_serial_no"))
        if has_serial and recibida > 0:
            # v1: los ítems por serie se reciben completos (todas las series de la línea)
            recibida = pendiente

        resto = pendiente - recibida
        resto_tipo = (pi.get("resto") or "devolucion").strip()

        if recibida > 0:
            trow = {
                "item_code": item_code,
                "qty": recibida,
                "uom": row.uom,
                "source_warehouse": transito,
                "target_warehouse": destino,
            }
            if row.batch_no:
                trow["batch_no"] = row.batch_no
            if has_serial:
                trow["serial_no"] = row.serial_no
            transfer_rows.append(trow)

        row.qty_recibida = flt(row.qty_recibida) + recibida
        if resto_tipo == "recepcion":
            row.qty_pendiente_recepcion = resto
            row.qty_pendiente_devolucion = flt(row.qty_pendiente_devolucion)
        else:
            row.qty_pendiente_recepcion = 0
            row.qty_pendiente_devolucion = flt(row.qty_pendiente_devolucion) + resto
            if pi.get("motivo_devolucion"):
                row.motivo_devolucion = pi.get("motivo_devolucion")

        resumen["recibido"] += recibida
        if resto_tipo == "recepcion":
            resumen["pendiente_recepcion"] += resto
        else:
            resumen["pendiente_devolucion"] += resto

    generado = None
    if transfer_rows:
        items = _build_stock_entry_items(
            transfer_rows, company, "transfer",
            default_source=transito, default_target=destino,
        )
        doc = _build_and_submit_stock_entry(
            "transfer", company, transito, destino, items,
            remarks=f"Recepción de traslado {se.name}",
        )
        generado = doc.name
        rec.recepcion_stock_entry = generado

    rec.save(ignore_permissions=True)
    frappe.db.commit()

    return {
        "stock_entry_generado": generado,
        "recepcion": rec.name,
        "estado": rec.estado,
        "resumen": resumen,
    }


# ---------------------------------------------------------------------------
# Procesar devolución
# ---------------------------------------------------------------------------

@frappe.whitelist()
def procesar_devolucion(payload: str):
    """payload = {recepcion, almacen_devolucion,
        items: [{item_code, batch_no, serial_no, qty}]}"""
    data = frappe.parse_json(payload)
    company = _guard(data.get("company"))
    transito = _require_transito(company)

    rec = frappe.get_doc("FacEx Recepcion Traslado", data.get("recepcion"))
    if rec.company != company:
        frappe.throw("Esa recepción pertenece a otra compañía.")

    destino = data.get("almacen_devolucion")
    if not destino:
        frappe.throw("Seleccione la bodega a la que devolverá los productos.")

    payload_items = data.get("items") or []
    transfer_rows = []
    total = 0.0

    for pi in payload_items:
        item_code = (pi.get("item_code") or "").strip()
        batch_no = pi.get("batch_no") or None
        row = _match_rec_row(rec, item_code, batch_no)
        if not row:
            continue
        pend = flt(row.qty_pendiente_devolucion)
        if pend <= 0:
            continue

        qty = min(flt(pi.get("qty")), pend)
        has_serial = bool(frappe.db.get_value("Item", item_code, "has_serial_no"))
        if has_serial and qty > 0:
            qty = pend
        if qty <= 0:
            continue

        trow = {
            "item_code": item_code, "qty": qty, "uom": row.uom,
            "source_warehouse": transito, "target_warehouse": destino,
        }
        if row.batch_no:
            trow["batch_no"] = row.batch_no
        if has_serial:
            trow["serial_no"] = row.serial_no
        transfer_rows.append(trow)

        row.qty_devuelta = flt(row.qty_devuelta) + qty
        row.qty_pendiente_devolucion = pend - qty
        total += qty

    if not transfer_rows:
        frappe.throw("No indicó ninguna cantidad a devolver.")

    items = _build_stock_entry_items(
        transfer_rows, company, "transfer",
        default_source=transito, default_target=destino,
    )
    doc = _build_and_submit_stock_entry(
        "transfer", company, transito, destino, items,
        remarks=f"Devolución de traslado {rec.name}",
    )

    rec.save(ignore_permissions=True)
    frappe.db.commit()

    return {"stock_entry_generado": doc.name, "recepcion": rec.name, "estado": rec.estado, "devuelto": total}
