"""
facex_multi.api.transformar
----------------------------
«Transformar» del módulo de Inventario: convertir existencia de uno o varios
productos hijos en un producto padre, con flujo Borrador → Autorizar.

- El creador (transformar_grabar_borrador) arma el documento FacEx
  Transformacion: padre + UdM + cantidad + almacén destino, e hijos con
  producto + cantidad + UdM + almacén de salida. Queda en «Borrador» y se
  avisa a los autorizadores de la compañía (Notification Log + realtime).
- El autorizador (transformar_autorizar) lo Autoriza → se genera y somete un
  Stock Entry «Manufacture» (salida de los hijos + entrada del padre, el costo
  del padre = valor consumido de los hijos) — o lo Rechaza con un motivo. En
  ambos casos el creador recibe un aviso sin leer hasta que abre el documento.
- Cada usuario solo ve los documentos que él creó; el autorizador además ve
  los pendientes que tocan sus bodegas y los que él resolvió. El informe
  sigue el Alcance de Inventario del perfil.

Sin BOM ni Work Order: el Stock Entry es el mismo tipo que usa la
Transformación de Listas de Materiales (bfel_transformacion=1).
"""
from __future__ import annotations

import frappe
from frappe.utils import cint, flt, get_first_day, get_last_day, now_datetime, today

from facex_multi.api.invoice import get_effective_company, get_user_companies
from facex_multi.api.permissions import (
    SCOPE_OWN,
    _is_sm,
    get_facex_allowed_warehouses,
    get_facex_can_view_costs,
    get_facex_default_warehouse,
    get_facex_inventory_permissions,
    get_facex_inventory_scope,
)
from facex_multi.api.stock import (
    _check_item_company,
    _idempotent_replay,
    _remember_token,
    _resolve_batch,
    get_item_stock_summary,
)

DOCTYPE = "FacEx Transformacion"
SE_SERIES = "TRF-.ABBR.-.####"
PAGE_LINK = "/app/facex-inventario?transformar={}"

BORRADOR, AUTORIZADO, RECHAZADO, ANULADO = "Borrador", "Autorizado", "Rechazado", "Anulado"


# ---------------------------------------------------------------------------
# Permisos
# ---------------------------------------------------------------------------

def _company(company: str = None) -> str:
    company = get_effective_company(company)
    if company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)
    return company


def _gate(company: str) -> dict:
    perms = get_facex_inventory_permissions(company)
    return {
        "can_draft": bool(perms.get("transformar_grabar_borrador")),
        "can_authorize": bool(perms.get("transformar_autorizar")),
        "can_cancel": bool(perms.get("transformar_autorizar")) and bool(perms.get("puede_cancelar_movimientos")),
        "can_report": bool(perms.get("reporte_inv_transformaciones")),
        "can_view_costs": bool(get_facex_can_view_costs(company)),
    }


def _require(company: str, key: str, msg: str) -> dict:
    gate = _gate(company)
    if not gate[key]:
        frappe.throw(msg, frappe.PermissionError)
    return gate


def _doc_warehouses(doc) -> set:
    whs = {doc.get("almacen_destino")}
    for r in doc.get("items") or []:
        whs.add(r.get("almacen"))
    return {w for w in whs if w}


def _in_warehouse_scope(doc, company: str) -> bool:
    """¿Toca el documento alguna bodega habilitada (visibilidad) del usuario?"""
    allowed = get_facex_allowed_warehouses(company)
    if allowed is None:
        return True
    return bool(_doc_warehouses(doc) & set(allowed))


def _can_read(doc) -> bool:
    user = frappe.session.user
    if _is_sm() or doc.creado_por == user or doc.autorizado_por == user:
        return True
    gate = _gate(doc.company)
    if gate["can_authorize"] and doc.estado == BORRADOR and _in_warehouse_scope(doc, doc.company):
        return True
    # Informe con alcance «Toda la compañía»: consulta de solo lectura.
    if gate["can_report"] and get_facex_inventory_scope(doc.company) != SCOPE_OWN:
        return _in_warehouse_scope(doc, doc.company)
    return False


def _load(name: str, for_update: bool = False):
    if not frappe.db.exists(DOCTYPE, name):
        frappe.throw(f"La transformación '{name}' no existe.")
    doc = frappe.get_doc(DOCTYPE, name, for_update=for_update)
    if doc.company not in (get_user_companies() or []):
        frappe.throw("No tiene permiso para operar sobre esta compañía.", frappe.PermissionError)
    return doc


# ---------------------------------------------------------------------------
# Notificaciones (campana de Frappe + evento realtime para el page)
# ---------------------------------------------------------------------------

def _authorizers(company: str) -> list:
    rows = frappe.get_all(
        "FacEx Settings",
        filters={"bfel_company": company, "transformar_autorizar": 1, "user": ["is", "set"]},
        pluck="user",
    )
    if not rows:
        return []
    enabled = frappe.get_all("User", filters={"name": ["in", rows], "enabled": 1}, pluck="name")
    return sorted(set(enabled))


def _notify(users, subject: str, doc) -> None:
    """Aviso no leído por usuario. Un fallo de notificación no debe tumbar la
    operación de inventario, así que se registra y se sigue."""
    sender = frappe.session.user
    for user in sorted(set(u for u in users if u and u != sender)):
        try:
            frappe.get_doc({
                "doctype": "Notification Log",
                "for_user": user,
                "from_user": sender,
                "type": "Alert",
                "subject": subject,
                "document_type": DOCTYPE,
                "document_name": doc.name,
                "link": PAGE_LINK.format(doc.name),
            }).insert(ignore_permissions=True)
        except Exception:
            frappe.log_error(title="FacEx Transformar: notificación")
        frappe.publish_realtime(
            "facex_transformar", {"company": doc.company, "name": doc.name, "estado": doc.estado},
            user=user, after_commit=True,
        )


def _mark_notifications_read(name: str, user: str = None, exclude_user: str = None) -> None:
    filters = {"document_type": DOCTYPE, "document_name": name, "read": 0}
    if user:
        filters["for_user"] = user
    if exclude_user:
        filters["for_user"] = ["!=", exclude_user]
    for n in frappe.get_all("Notification Log", filters=filters, pluck="name"):
        frappe.db.set_value("Notification Log", n, "read", 1, update_modified=False)


def _user_name(user: str) -> str:
    return frappe.db.get_value("User", user, "full_name") or user


# ---------------------------------------------------------------------------
# Datos para la pantalla
# ---------------------------------------------------------------------------

def _pending_conditions(company: str, values: dict) -> str:
    """WHERE de los pendientes que el autorizador actual puede resolver."""
    values.update({"company": company, "estado": BORRADOR})
    cond = "t.company = %(company)s AND t.estado = %(estado)s"
    allowed = get_facex_allowed_warehouses(company)
    if allowed is not None:
        values["allowed_wh"] = tuple(allowed) or ("",)
        cond += """ AND (t.almacen_destino IN %(allowed_wh)s OR EXISTS (
            SELECT 1 FROM `tabFacEx Transformacion Item` ti
            WHERE ti.parent = t.name AND ti.almacen IN %(allowed_wh)s))"""
    return cond


def _badges(company: str, gate: dict) -> dict:
    user = frappe.session.user
    pendientes = 0
    if gate["can_authorize"]:
        values = {}
        pendientes = frappe.db.sql(
            f"SELECT COUNT(*) FROM `tab{DOCTYPE}` t WHERE {_pending_conditions(company, values)}",
            values,
        )[0][0]
    no_vistos = frappe.db.count(DOCTYPE, {"company": company, "creado_por": user, "visto_por_creador": 0})
    mis_borradores = frappe.db.count(DOCTYPE, {"company": company, "creado_por": user, "estado": BORRADOR})
    return {"pendientes": cint(pendientes), "no_vistos": cint(no_vistos), "mis_borradores": cint(mis_borradores)}


@frappe.whitelist()
def get_badges(company: str = None):
    """Contadores para la tarjeta de Inventario y el aviso al entrar."""
    company = _company(company)
    gate = _gate(company)
    if not (gate["can_draft"] or gate["can_authorize"]):
        return {"pendientes": 0, "no_vistos": 0, "mis_borradores": 0}
    return _badges(company, gate)


@frappe.whitelist()
def get_context(company: str = None):
    company = _company(company)
    gate = _gate(company)
    if not (gate["can_draft"] or gate["can_authorize"]):
        frappe.throw("No tiene acceso a Transformar en esta compañía.", frappe.PermissionError)
    from facex_multi.api.invoice import get_warehouses
    return {
        "company": company,
        **gate,
        "badges": _badges(company, gate),
        "bodega_por_defecto": get_facex_default_warehouse(company),
        "almacenes_entrada": get_warehouses(company, "entrada"),
        "almacenes_salida": get_warehouses(company, "salida"),
        "hay_autorizadores": bool(_authorizers(company)),
    }


def _item_uoms(item_code: str, stock_uom: str) -> list:
    rows = frappe.get_all(
        "UOM Conversion Detail",
        filters={"parent": item_code, "parenttype": "Item"},
        fields=["uom", "conversion_factor"],
        order_by="idx asc",
    )
    out = [{"uom": stock_uom, "conversion_factor": 1}]
    out += [{"uom": r.uom, "conversion_factor": flt(r.conversion_factor)}
            for r in rows if r.uom != stock_uom and flt(r.conversion_factor) > 0]
    return out


@frappe.whitelist()
def get_item_info(item_code: str, company: str = None):
    """UdM disponibles, lote/serie y existencia de un producto; si es Lista de
    Materiales, sus componentes como sugerencia de hijos."""
    company = _company(company)
    item = frappe.db.get_value(
        "Item", item_code,
        ["item_name", "stock_uom", "has_batch_no", "has_serial_no", "is_stock_item", "disabled",
         "bfel_es_lista_materiales"],
        as_dict=True,
    )
    if not item or item.disabled or not item.is_stock_item:
        frappe.throw(f"El producto '{item_code}' no existe, está deshabilitado o no maneja inventario.")
    _check_item_company(item_code, company)

    componentes = []
    if cint(item.bfel_es_lista_materiales):
        componentes = frappe.get_all(
            "FacEx Lista Materiales Item",
            filters={"parent": item_code, "parenttype": "Item"},
            fields=["item_code", "qty"],
            order_by="idx asc",
        )
    return {
        "item_code": item_code,
        "item_name": item.item_name,
        "stock_uom": item.stock_uom,
        "has_batch_no": cint(item.has_batch_no),
        "has_serial_no": cint(item.has_serial_no),
        "uoms": _item_uoms(item_code, item.stock_uom),
        "stock": get_item_stock_summary(item_code, company),
        "componentes": componentes,
    }


# ---------------------------------------------------------------------------
# Validación del documento
# ---------------------------------------------------------------------------

def _conversion(item_code: str, uom: str, stock_uom: str) -> float:
    if not uom or uom == stock_uom:
        return 1.0
    cf = frappe.db.get_value(
        "UOM Conversion Detail", {"parent": item_code, "parenttype": "Item", "uom": uom}, "conversion_factor"
    )
    if not flt(cf):
        frappe.throw(f"El producto '{item_code}' no tiene conversión configurada para la unidad '{uom}'.")
    return flt(cf)


def _stock_item(item_code: str, label: str):
    item = frappe.db.get_value(
        "Item", item_code,
        ["item_name", "stock_uom", "has_batch_no", "has_serial_no", "is_stock_item", "disabled"],
        as_dict=True,
    )
    if not item:
        frappe.throw(f"{label}: el producto '{item_code}' no existe.")
    if item.disabled or not item.is_stock_item:
        frappe.throw(f"{label}: el producto '{item_code}' está deshabilitado o no maneja inventario.")
    return item


def _serials(raw: str) -> list:
    return [s.strip() for s in (raw or "").replace(",", "\n").splitlines() if s.strip()]


def _apply_payload(doc, data: dict, company: str) -> None:
    """Llena y valida `doc` con el payload del cliente, con las bodegas y
    productos que el CREADOR tiene permitidos."""
    item_padre = (data.get("item_padre") or "").strip()
    if not item_padre:
        frappe.throw("Seleccione el producto padre.")
    padre = _stock_item(item_padre, "Producto padre")
    _check_item_company(item_padre, company)
    if cint(padre.has_serial_no):
        frappe.throw(f"'{item_padre}' maneja número de serie; Transformar todavía no lo soporta en el producto padre.")

    cantidad = flt(data.get("cantidad"))
    if cantidad <= 0:
        frappe.throw("La cantidad del producto padre debe ser mayor a cero.")

    destino = data.get("almacen_destino")
    if not destino:
        frappe.throw("Seleccione el almacén destino del producto padre.")
    entrada_ok = get_facex_allowed_warehouses(company, "entrada")
    if entrada_ok is not None and destino not in entrada_ok:
        frappe.throw(f"La bodega '{destino}' no está habilitada para entrada en su configuración.", frappe.PermissionError)
    if frappe.db.get_value("Warehouse", destino, "company") != company:
        frappe.throw(f"La bodega '{destino}' no pertenece a la compañía.")

    uom = data.get("uom") or padre.stock_uom
    batch_padre = (data.get("batch_no") or "").strip()
    if cint(padre.has_batch_no) and not batch_padre:
        frappe.throw(f"'{item_padre}' maneja lote: indique el lote con el que ingresará.")

    doc.update({
        "company": company,
        "item_padre": item_padre,
        "item_name": padre.item_name,
        "cantidad": cantidad,
        "uom": uom,
        "conversion_factor": _conversion(item_padre, uom, padre.stock_uom),
        "almacen_destino": destino,
        "batch_no": batch_padre if cint(padre.has_batch_no) else None,
        "comentario": (data.get("comentario") or "").strip() or None,
    })

    salida_ok = get_facex_allowed_warehouses(company, "salida")
    hijos = data.get("items") or []
    if not hijos:
        frappe.throw("Agregue al menos un producto hijo a descargar.")
    doc.set("items", [])
    for i, h in enumerate(hijos, start=1):
        code = (h.get("item_code") or "").strip()
        if not code:
            frappe.throw(f"Hijo {i}: falta el producto.")
        if code == item_padre:
            frappe.throw(f"Hijo {i}: el producto padre no puede descargarse a sí mismo.")
        item = _stock_item(code, f"Hijo {i}")
        _check_item_company(code, company)
        qty = flt(h.get("cantidad"))
        if qty <= 0:
            frappe.throw(f"Hijo {i} ({code}): la cantidad debe ser mayor a cero.")
        almacen = h.get("almacen")
        if not almacen:
            frappe.throw(f"Hijo {i} ({code}): seleccione el almacén de salida.")
        if salida_ok is not None and almacen not in salida_ok:
            frappe.throw(f"Hijo {i} ({code}): la bodega '{almacen}' no está habilitada para salida en su configuración.",
                         frappe.PermissionError)
        h_uom = h.get("uom") or item.stock_uom
        cf = _conversion(code, h_uom, item.stock_uom)
        row = {
            "item_code": code, "item_name": item.item_name, "cantidad": qty,
            "uom": h_uom, "conversion_factor": cf, "almacen": almacen,
        }
        if cint(item.has_batch_no):
            batch = (h.get("batch_no") or "").strip()
            if not batch:
                frappe.throw(f"Hijo {i} ({code}): indique el lote a descargar.")
            if not frappe.db.exists("Batch", {"name": batch, "item": code}):
                frappe.throw(f"Hijo {i} ({code}): el lote '{batch}' no existe para este producto.")
            row["batch_no"] = batch
        if cint(item.has_serial_no):
            serials = _serials(h.get("serial_no"))
            if len(serials) != cint(qty * cf) or flt(qty * cf) != cint(qty * cf):
                frappe.throw(f"Hijo {i} ({code}): ingrese {flt(qty * cf)} número(s) de serie (ingresó {len(serials)}).")
            row["serial_no"] = "\n".join(serials)
        doc.append("items", row)


# ---------------------------------------------------------------------------
# Grabar / eliminar borrador
# ---------------------------------------------------------------------------

@frappe.whitelist()
def save_transformacion(payload: str, client_token: str = None):
    """Crea o edita (solo el creador, en Borrador o Rechazado) una
    transformación. Con `autorizar=1` y permiso de autorizador, la autoriza en
    la misma operación."""
    replay = _idempotent_replay(client_token)
    if replay:
        return {"name": replay, "replay": True}

    data = frappe.parse_json(payload)
    company = _company(data.get("company"))
    gate = _gate(company)
    autorizar = cint(data.get("autorizar"))
    if autorizar and not gate["can_authorize"]:
        frappe.throw("No tiene permiso para autorizar transformaciones.", frappe.PermissionError)
    if not autorizar and not gate["can_draft"]:
        frappe.throw("No tiene permiso para grabar transformaciones.", frappe.PermissionError)

    user = frappe.session.user
    name = data.get("name")
    if name:
        doc = _load(name, for_update=True)
        if doc.creado_por != user:
            frappe.throw("Solo el usuario que creó la transformación puede editarla.", frappe.PermissionError)
        if doc.estado not in (BORRADOR, RECHAZADO):
            frappe.throw(f"La transformación {doc.name} está {doc.estado} y ya no se puede editar.")
        if doc.company != company:
            frappe.throw("No puede cambiar la compañía de una transformación existente.")
        reenviada = doc.estado == RECHAZADO
    else:
        doc = frappe.new_doc(DOCTYPE)
        doc.naming_series = "TRN-.ABBR.-.#####"
        doc.creado_por = user
        doc.fecha_creacion = now_datetime()
        reenviada = False

    _apply_payload(doc, data, company)
    doc.estado = BORRADOR
    doc.visto_por_creador = 1
    doc.autorizado_por = None
    doc.fecha_autorizacion = None
    doc.motivo_rechazo = None
    doc.flags.ignore_permissions = True
    doc.save() if name else doc.insert()

    _remember_token(client_token, doc.name)

    if autorizar and gate["can_authorize"]:
        _autorizar(doc)
    elif not name or reenviada:
        verbo = "reenvió" if reenviada else "envió"
        _notify(
            _authorizers(company),
            f"{_user_name(user)} {verbo} la transformación {doc.name} "
            f"({flt(doc.cantidad)} {doc.uom} de {doc.item_padre}) para autorizar.",
            doc,
        )
    frappe.db.commit()
    return {"name": doc.name, "estado": doc.estado, "stock_entry": doc.stock_entry}


@frappe.whitelist()
def delete_transformacion(name: str):
    doc = _load(name, for_update=True)
    if doc.creado_por != frappe.session.user and not _is_sm():
        frappe.throw("Solo el usuario que creó la transformación puede eliminarla.", frappe.PermissionError)
    if doc.estado not in (BORRADOR, RECHAZADO):
        frappe.throw(f"La transformación {doc.name} está {doc.estado}; no se puede eliminar.")
    _mark_notifications_read(doc.name)
    frappe.delete_doc(DOCTYPE, doc.name, ignore_permissions=True)
    frappe.db.commit()
    return {"name": name, "deleted": 1}


# ---------------------------------------------------------------------------
# Autorizar / Rechazar / Anular
# ---------------------------------------------------------------------------

def _build_stock_entry(doc):
    rows = []
    for r in doc.items:
        row = {
            "item_code": r.item_code,
            "qty": flt(r.cantidad),
            "uom": r.uom,
            "conversion_factor": flt(r.conversion_factor) or 1,
            "s_warehouse": r.almacen,
            "is_finished_item": 0,
        }
        if r.batch_no:
            row["use_serial_batch_fields"] = 1
            row["batch_no"] = _resolve_batch(r.item_code, r.batch_no, "out")
        if r.serial_no:
            row["use_serial_batch_fields"] = 1
            row["serial_no"] = r.serial_no
        rows.append(row)

    padre = {
        "item_code": doc.item_padre,
        "qty": flt(doc.cantidad),
        "uom": doc.uom,
        "conversion_factor": flt(doc.conversion_factor) or 1,
        "t_warehouse": doc.almacen_destino,
        "is_finished_item": 1,
    }
    if doc.batch_no:
        padre["use_serial_batch_fields"] = 1
        padre["batch_no"] = _resolve_batch(doc.item_padre, doc.batch_no, "in")
    rows.append(padre)

    comentario = f" — {doc.comentario}" if doc.comentario else ""
    return frappe.get_doc({
        "doctype": "Stock Entry",
        "naming_series": SE_SERIES,
        "stock_entry_type": "Manufacture",
        "purpose": "Manufacture",
        "company": doc.company,
        "posting_date": today(),
        "fg_completed_qty": flt(doc.cantidad) * (flt(doc.conversion_factor) or 1),
        "bfel_transformacion": 1,
        "remarks": f"Transformar {doc.name} (creado por {doc.creado_por}){comentario}",
        "items": rows,
    })


def _autorizar(doc) -> None:
    se = _build_stock_entry(doc)
    # El control de acceso es el de FacEx (transformar_autorizar + bodegas);
    # el autorizador no necesita rol de escritorio sobre Stock Entry.
    se.flags.ignore_permissions = True
    se.insert()
    se.submit()

    user = frappe.session.user
    doc.db_set({
        "estado": AUTORIZADO,
        "stock_entry": se.name,
        "autorizado_por": user,
        "fecha_autorizacion": now_datetime(),
        "valor_total": flt(se.total_incoming_value),
        "visto_por_creador": 1 if doc.creado_por == user else 0,
    })
    _mark_notifications_read(doc.name, exclude_user=doc.creado_por)
    _notify(
        [doc.creado_por],
        f"{_user_name(user)} autorizó su transformación {doc.name}: "
        f"+{flt(doc.cantidad)} {doc.uom} de {doc.item_padre} (movimiento {se.name}).",
        doc,
    )


def _load_for_resolution(name: str):
    doc = _load(name, for_update=True)
    _require(doc.company, "can_authorize", "No tiene permiso para autorizar transformaciones.")
    if doc.estado != BORRADOR:
        frappe.throw(f"La transformación {doc.name} ya está {doc.estado}.")
    if not _in_warehouse_scope(doc, doc.company):
        frappe.throw("Esta transformación no involucra ninguna de sus bodegas habilitadas.", frappe.PermissionError)
    return doc


@frappe.whitelist()
def autorizar_transformacion(name: str):
    doc = _load_for_resolution(name)
    _autorizar(doc)
    frappe.db.commit()
    return {"name": doc.name, "estado": doc.estado, "stock_entry": doc.stock_entry}


@frappe.whitelist()
def rechazar_transformacion(name: str, motivo: str = None):
    motivo = (motivo or "").strip()
    if not motivo:
        frappe.throw("Indique el motivo del rechazo.")
    doc = _load_for_resolution(name)
    user = frappe.session.user
    doc.db_set({
        "estado": RECHAZADO,
        "autorizado_por": user,
        "fecha_autorizacion": now_datetime(),
        "motivo_rechazo": motivo,
        "visto_por_creador": 1 if doc.creado_por == user else 0,
    })
    _mark_notifications_read(doc.name, exclude_user=doc.creado_por)
    _notify([doc.creado_por], f"{_user_name(user)} rechazó su transformación {doc.name}: {motivo}", doc)
    frappe.db.commit()
    return {"name": doc.name, "estado": doc.estado}


@frappe.whitelist()
def anular_transformacion(name: str):
    """Revierte una transformación autorizada (cancela el Stock Entry)."""
    doc = _load(name, for_update=True)
    _require(doc.company, "can_cancel",
             "Anular requiere los permisos «Transformar — Autorizar» y «Anular Movimientos».")
    if doc.estado != AUTORIZADO:
        frappe.throw(f"Solo se anulan transformaciones Autorizadas (esta está {doc.estado}).")
    if not _in_warehouse_scope(doc, doc.company):
        frappe.throw("Esta transformación no involucra ninguna de sus bodegas habilitadas.", frappe.PermissionError)
    if doc.stock_entry:
        se = frappe.get_doc("Stock Entry", doc.stock_entry)
        if se.docstatus == 1:
            se.flags.ignore_permissions = True
            se.cancel()
    user = frappe.session.user
    doc.db_set({
        "estado": ANULADO,
        "anulado_por": user,
        "fecha_anulacion": now_datetime(),
        "visto_por_creador": 1 if doc.creado_por == user else 0,
    })
    _notify([doc.creado_por], f"{_user_name(user)} anuló la transformación {doc.name}.", doc)
    frappe.db.commit()
    return {"name": doc.name, "estado": doc.estado}


# ---------------------------------------------------------------------------
# Consulta
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_transformacion(name: str):
    doc = _load(name)
    if not _can_read(doc):
        frappe.throw("No tiene permiso para ver esta transformación.", frappe.PermissionError)

    user = frappe.session.user
    # Abrirlo = leer el aviso.
    if doc.creado_por == user and not cint(doc.visto_por_creador):
        doc.db_set("visto_por_creador", 1, update_modified=False)
    _mark_notifications_read(doc.name, user=user)
    frappe.db.commit()

    gate = _gate(doc.company)
    es_creador = doc.creado_por == user
    stock = {}
    if doc.estado == BORRADOR:
        for r in doc.items:
            if r.item_code not in stock:
                stock[r.item_code] = {s.get("warehouse"): flt(s.get("actual_qty"))
                                      for s in get_item_stock_summary(r.item_code, doc.company)}

    out = doc.as_dict()
    out.update({
        "creado_por_nombre": _user_name(doc.creado_por),
        "autorizado_por_nombre": _user_name(doc.autorizado_por) if doc.autorizado_por else "",
        "anulado_por_nombre": _user_name(doc.anulado_por) if doc.anulado_por else "",
        "puede_editar": es_creador and doc.estado in (BORRADOR, RECHAZADO),
        "puede_autorizar": doc.estado == BORRADOR and gate["can_authorize"] and _in_warehouse_scope(doc, doc.company),
        "puede_anular": doc.estado == AUTORIZADO and gate["can_cancel"] and _in_warehouse_scope(doc, doc.company),
        "existencia": stock,
    })
    if not gate["can_view_costs"]:
        out["valor_total"] = None
    return out


_LIST_FIELDS = """t.name, t.estado, t.item_padre, t.item_name, t.cantidad, t.uom, t.almacen_destino,
    t.creado_por, t.fecha_creacion, t.autorizado_por, t.fecha_autorizacion, t.motivo_rechazo,
    t.stock_entry, t.visto_por_creador, t.comentario, t.valor_total,
    (SELECT COUNT(*) FROM `tabFacEx Transformacion Item` ti WHERE ti.parent = t.name) AS hijos,
    uc.full_name AS creado_por_nombre, ua.full_name AS autorizado_por_nombre"""
_LIST_JOINS = """LEFT JOIN `tabUser` uc ON uc.name = t.creado_por
    LEFT JOIN `tabUser` ua ON ua.name = t.autorizado_por"""


def _finish_rows(rows: list, can_view_costs: bool) -> list:
    for r in rows:
        r["creado_por_nombre"] = r.get("creado_por_nombre") or r.get("creado_por")
        r["autorizado_por_nombre"] = r.get("autorizado_por_nombre") or r.get("autorizado_por") or ""
        if not can_view_costs:
            r["valor_total"] = None
    return rows


@frappe.whitelist()
def list_mis_transformaciones(company: str = None, estado: str = None, from_date: str = None, to_date: str = None):
    """Bandeja del creador: SOLO lo que él creó. Borrador/Rechazado sin filtro
    de fecha (son trabajo pendiente)."""
    company = _company(company)
    gate = _gate(company)
    if not (gate["can_draft"] or gate["can_authorize"]):
        frappe.throw("No tiene acceso a Transformar en esta compañía.", frappe.PermissionError)
    values = {"company": company, "user": frappe.session.user}
    cond = "t.company = %(company)s AND t.creado_por = %(user)s"
    if estado:
        cond += " AND t.estado = %(estado)s"
        values["estado"] = estado
    if estado not in (BORRADOR, RECHAZADO):
        values["from_date"] = from_date or get_first_day(today())
        values["to_date"] = to_date or get_last_day(today())
        cond += " AND DATE(t.fecha_creacion) BETWEEN %(from_date)s AND %(to_date)s"
    rows = frappe.db.sql(
        f"""SELECT {_LIST_FIELDS} FROM `tab{DOCTYPE}` t {_LIST_JOINS}
        WHERE {cond} ORDER BY t.visto_por_creador ASC, t.fecha_creacion DESC LIMIT 500""",
        values, as_dict=True,
    )
    return {"rows": _finish_rows(rows, gate["can_view_costs"])}


@frappe.whitelist()
def list_pendientes(company: str = None):
    """Bandeja del autorizador: Borradores de la compañía que tocan sus bodegas."""
    company = _company(company)
    gate = _require(company, "can_authorize", "No tiene permiso para autorizar transformaciones.")
    values = {}
    rows = frappe.db.sql(
        f"""SELECT {_LIST_FIELDS} FROM `tab{DOCTYPE}` t {_LIST_JOINS}
        WHERE {_pending_conditions(company, values)} ORDER BY t.fecha_creacion ASC LIMIT 500""",
        values, as_dict=True,
    )
    return {"rows": _finish_rows(rows, gate["can_view_costs"])}


@frappe.whitelist()
def list_resueltas_por_mi(company: str = None, from_date: str = None, to_date: str = None):
    company = _company(company)
    gate = _require(company, "can_authorize", "No tiene permiso para autorizar transformaciones.")
    values = {
        "company": company, "user": frappe.session.user,
        "from_date": from_date or get_first_day(today()), "to_date": to_date or get_last_day(today()),
    }
    rows = frappe.db.sql(
        f"""SELECT {_LIST_FIELDS} FROM `tab{DOCTYPE}` t {_LIST_JOINS}
        WHERE t.company = %(company)s AND t.autorizado_por = %(user)s
          AND DATE(t.fecha_autorizacion) BETWEEN %(from_date)s AND %(to_date)s
        ORDER BY t.fecha_autorizacion DESC LIMIT 500""",
        values, as_dict=True,
    )
    return {"rows": _finish_rows(rows, gate["can_view_costs"])}


# ---------------------------------------------------------------------------
# Informe de Transformaciones
# ---------------------------------------------------------------------------

def _parse_list(val):
    from facex_multi.api.stock_reports import _parse_list as parse
    return parse(val)


@frappe.whitelist()
def get_transformaciones_report(company: str = None, from_date: str = None, to_date: str = None,
                                estado: str = None, creadores=None, autorizadores=None,
                                warehouse=None, item_code: str = None, detalle: int = 0):
    """Documentos Transformar del periodo (por fecha de creación) con creador y
    autorizador. Alcance «Solo lo creado por mí» → los que creó o resolvió."""
    company = _company(company)
    gate = _require(company, "can_report", "No tiene permiso para ver el informe de Transformaciones.")
    values = {
        "company": company,
        "from_date": from_date or get_first_day(today()),
        "to_date": to_date or get_last_day(today()),
    }
    cond = ["t.company = %(company)s", "DATE(t.fecha_creacion) BETWEEN %(from_date)s AND %(to_date)s"]
    if estado:
        cond.append("t.estado = %(estado)s")
        values["estado"] = estado
    if get_facex_inventory_scope(company) == SCOPE_OWN:
        cond.append("(t.creado_por = %(me)s OR t.autorizado_por = %(me)s)")
        values["me"] = frappe.session.user
    else:
        creadores = _parse_list(creadores)
        if creadores:
            cond.append("t.creado_por IN %(creadores)s")
            values["creadores"] = tuple(creadores)
        autorizadores = _parse_list(autorizadores)
        if autorizadores:
            cond.append("t.autorizado_por IN %(autorizadores)s")
            values["autorizadores"] = tuple(autorizadores)
    if item_code:
        cond.append("""(t.item_padre = %(item_code)s OR EXISTS (SELECT 1 FROM `tabFacEx Transformacion Item` ti
            WHERE ti.parent = t.name AND ti.item_code = %(item_code)s))""")
        values["item_code"] = item_code

    allowed = get_facex_allowed_warehouses(company)
    whs = _parse_list(warehouse)
    if whs and allowed is not None and any(w not in allowed for w in whs):
        frappe.throw("No tiene permiso para ver alguna de las bodegas seleccionadas.", frappe.PermissionError)
    scope_wh = whs or (list(allowed) if allowed is not None else None)
    if scope_wh is not None:
        cond.append("""(t.almacen_destino IN %(whs)s OR EXISTS (SELECT 1 FROM `tabFacEx Transformacion Item` ti
            WHERE ti.parent = t.name AND ti.almacen IN %(whs)s))""")
        values["whs"] = tuple(scope_wh) or ("",)

    rows = frappe.db.sql(
        f"""SELECT {_LIST_FIELDS} FROM `tab{DOCTYPE}` t {_LIST_JOINS}
        WHERE {" AND ".join(cond)} ORDER BY t.fecha_creacion DESC LIMIT 5000""",
        values, as_dict=True,
    )
    rows = _finish_rows(rows, gate["can_view_costs"])

    if cint(detalle) and rows:
        hijos = frappe.get_all(
            "FacEx Transformacion Item",
            filters={"parent": ["in", [r.name for r in rows]], "parenttype": DOCTYPE},
            fields=["parent", "item_code", "item_name", "cantidad", "uom", "almacen", "batch_no"],
            order_by="parent asc, idx asc",
        )
        by_parent = {}
        for h in hijos:
            by_parent.setdefault(h.parent, []).append(h)
        for r in rows:
            r["items"] = by_parent.get(r.name, [])

    resumen = {}
    for r in rows:
        resumen[r.estado] = resumen.get(r.estado, 0) + 1
    return {
        "rows": rows, "resumen": resumen, "can_view_costs": gate["can_view_costs"],
        "from_date": str(values["from_date"]), "to_date": str(values["to_date"]),
    }


@frappe.whitelist()
def export_transformaciones_excel(company: str = None, from_date: str = None, to_date: str = None,
                                  estado: str = None, creadores=None, autorizadores=None,
                                  warehouse=None, item_code: str = None):
    from facex_multi.api.stock_reports import _xlsx_response

    data = get_transformaciones_report(company, from_date, to_date, estado, creadores, autorizadores,
                                       warehouse, item_code, detalle=1)
    if not data["rows"]:
        frappe.throw("No hay transformaciones para exportar con los filtros seleccionados.")
    cc = data["can_view_costs"]
    headers = ["Documento", "Estado", "Creado", "Creado por", "Autorizado/Rechazado", "Autorizado por",
               "Padre", "Nombre Padre", "Cantidad", "UdM", "Almacén Destino",
               "Hijo", "Nombre Hijo", "Cant. Hijo", "UdM Hijo", "Almacén Salida",
               "Movimiento", "Motivo Rechazo"]
    if cc:
        headers.append("Valor")
    matrix = [headers]
    for r in data["rows"]:
        for i, h in enumerate(r.get("items") or [{}]):
            line = [
                r.name, r.estado, str(r.fecha_creacion or ""), r.creado_por_nombre,
                str(r.fecha_autorizacion or ""), r.autorizado_por_nombre,
                r.item_padre, r.item_name, r.cantidad if i == 0 else None, r.uom, r.almacen_destino,
                h.get("item_code"), h.get("item_name"), h.get("cantidad"), h.get("uom"), h.get("almacen"),
                r.stock_entry, r.motivo_rechazo,
            ]
            if cc:
                line.append(r.valor_total if i == 0 else None)
            matrix.append(line)
    _xlsx_response("transformaciones", matrix)
