"""
facex_multi.api.compras.trazabilidad
------------------------------------
Dos vistas de historia para los documentos de compra:

  get_document_map  mapa de relaciones — todo el flujo al que pertenece el
                    documento (Orden → Entrada → Factura, devoluciones y
                    notas de crédito), INCLUYENDO los anulados y las
                    rectificaciones (amended_from), que es justo lo que hay
                    que poder evidenciar.
  get_document_log  bitácora de cambios por usuario — creación, ediciones del
                    borrador (Version de Frappe, campo por campo),
                    validación, anulación y comentarios.

Nada de esto escribe: son dos lecturas sobre lo que ya registran ERPNext y
Frappe.
"""
from __future__ import annotations

import json

import frappe
from frappe.utils import flt, get_fullname

# Campos que no aportan nada a una bitácora para el usuario final.
RUIDO = {
    "modified", "modified_by", "creation", "owner", "idx", "docstatus", "doctype",
    "naming_series", "_comments", "_assign", "_liked_by", "_user_tags", "_seen",
    "amended_from", "title", "letter_head", "language",
    "base_grand_total", "base_net_total", "base_total", "base_rounded_total",
    "base_total_taxes_and_charges", "base_in_words", "in_words", "rounding_adjustment",
    "base_rounding_adjustment", "conversion_rate", "plc_conversion_rate",
    "facex_validado_por", "facex_validado_el", "facex_cancelado_por", "facex_cancelado_el",
    # Porcentajes y cantidades que ERPNext recalcula desde los documentos
    # siguientes: inundarían la bitácora sin decir quién decidió nada.
    "per_received", "per_billed", "per_ordered", "per_delivered", "advance_paid",
    "billing_address", "shipping_address", "address_display", "shipping_address_display",
    "other_charges_calculation",
}

# Tipos de campo que no se pueden resumir en una línea de bitácora.
TIPOS_RUIDO = {"Text Editor", "HTML Editor", "Code", "Markdown Editor", "Section Break",
               "Column Break", "Tab Break", "HTML", "Table", "Table MultiSelect", "Image"}

# Tablas hijas que sí vale la pena resumir (el resto se omite). El
# payment_schedule queda fuera a propósito: se rearma solo cada vez que cambia
# la condición de pago o la fecha, y eso ya se ve campo por campo.
TABLAS = {
    "items": "Productos",
    "taxes": "Impuestos",
    "facex_anexos": "Anexos",
}


# ---------------------------------------------------------------------------
# Mapa de relaciones
# ---------------------------------------------------------------------------

def _node_info(doctype: str, name: str) -> dict:
    from facex_multi.api.compras.documentos import KINDS, _kind_of

    meta = frappe.get_meta(doctype)
    fields = ["name", "docstatus", "status", "supplier", "supplier_name", "grand_total",
              "currency", "owner", "amended_from"]
    fields.append("transaction_date" if doctype == "Purchase Order" else "posting_date")
    # El campo de anulación lo agrega after_migrate: un sitio que todavía no
    # migró no debe reventar al pedirlo.
    fields += [f for f in ("facex_validado_por", "facex_cancelado_por") if meta.has_field(f)]
    row = frappe.db.get_value(doctype, name, fields, as_dict=True)
    if not row:
        return None
    kind = "oc" if doctype == "Purchase Order" else _kind_of(doctype, name)
    return {
        "kind": kind,
        "label": KINDS[kind].label,
        "name": row.name,
        "docstatus": row.docstatus,
        "status": row.status,
        "fecha": str(row.get("transaction_date") or row.get("posting_date") or ""),
        "total": abs(flt(row.grand_total)),
        "currency": row.currency,
        "supplier_name": row.supplier_name or row.supplier or "",
        "owner_fullname": get_fullname(row.owner) if row.owner else "",
        "anulado_por_fullname": get_fullname(row.facex_cancelado_por) if row.get("facex_cancelado_por") else "",
        "rectifica": row.get("amended_from") or "",
    }


def _child_values(child_doctype: str, parent: str, field: str) -> list:
    return [v for v in frappe.get_all(child_doctype, filters={"parent": parent},
                                      pluck=field, distinct=True) if v]


def _neighbours(doctype: str, name: str) -> list:
    """Vecinos del documento en el flujo: (desde, hacia, relación).

    Se recorren las dos direcciones y SIN filtrar docstatus — un documento
    anulado sigue colgado de su origen y así queda evidenciado."""
    edges = []

    def edge(src_dt, src, dst_dt, dst, rel):
        if src and dst:
            edges.append((src_dt, src, dst_dt, dst, rel))

    # ── Hacia arriba (de dónde salió este documento)
    if doctype == "Purchase Receipt":
        for po in _child_values("Purchase Receipt Item", name, "purchase_order"):
            edge("Purchase Order", po, doctype, name, "recepción")
        edge(doctype, frappe.db.get_value(doctype, name, "return_against"), doctype, name, "devolución")
    elif doctype == "Purchase Invoice":
        for po in _child_values("Purchase Invoice Item", name, "purchase_order"):
            edge("Purchase Order", po, doctype, name, "facturación")
        for pr in _child_values("Purchase Invoice Item", name, "purchase_receipt"):
            edge("Purchase Receipt", pr, doctype, name, "facturación")
        edge(doctype, frappe.db.get_value(doctype, name, "return_against"), doctype, name, "nota de crédito")

    # ── Hacia abajo (qué se generó desde este documento)
    if doctype == "Purchase Order":
        for pr in frappe.get_all("Purchase Receipt Item", filters={"purchase_order": name},
                                 pluck="parent", distinct=True):
            edge(doctype, name, "Purchase Receipt", pr, "recepción")
        for pi in frappe.get_all("Purchase Invoice Item", filters={"purchase_order": name},
                                 pluck="parent", distinct=True):
            edge(doctype, name, "Purchase Invoice", pi, "facturación")
    elif doctype == "Purchase Receipt":
        for pi in frappe.get_all("Purchase Invoice Item", filters={"purchase_receipt": name},
                                 pluck="parent", distinct=True):
            edge(doctype, name, "Purchase Invoice", pi, "facturación")
        for pr in frappe.get_all("Purchase Receipt", filters={"return_against": name}, pluck="name"):
            edge(doctype, name, doctype, pr, "devolución")
    elif doctype == "Purchase Invoice":
        for pi in frappe.get_all("Purchase Invoice", filters={"return_against": name}, pluck="name"):
            edge(doctype, name, doctype, pi, "nota de crédito")

    # ── Rectificaciones: el anulado y el que lo reemplazó.
    edge(doctype, frappe.db.get_value(doctype, name, "amended_from"), doctype, name, "rectificación")
    for amd in frappe.get_all(doctype, filters={"amended_from": name}, pluck="name"):
        edge(doctype, name, doctype, amd, "rectificación")

    return edges


@frappe.whitelist()
def get_document_map(kind: str, name: str, company: str = None) -> dict:
    """Todo el flujo del documento: nodos (cada documento con su estado) y
    aristas (qué salió de qué). Incluye anulados y rectificaciones."""
    from facex_multi.api.compras.common import check_doc_access
    from facex_multi.api.compras.documentos import _cfg, _require

    cfg = _cfg(kind)
    company = _require(kind, company)
    doc = frappe.get_doc(cfg.doctype, (name or "").strip())
    check_doc_access(doc, company)

    nodes, edges, seen = {}, [], set()
    pending = [(cfg.doctype, doc.name)]
    # Tope defensivo: una cadena de compra real no pasa de unas decenas de
    # documentos; así una relación circular o un flujo enorme no cuelga el page.
    while pending and len(nodes) < 80:
        dt, nm = pending.pop(0)
        if (dt, nm) in seen:
            continue
        seen.add((dt, nm))
        info = _node_info(dt, nm)
        if not info:
            continue
        # La cadena de compra es siempre de una sola compañía; un enlace que
        # salga de ella no se dibuja (el usuario no podría abrirlo).
        if frappe.db.get_value(dt, nm, "company") != doc.company:
            continue
        nodes[nm] = info
        for src_dt, src, dst_dt, dst, rel in _neighbours(dt, nm):
            key = (src, dst, rel)
            if key not in {(e["from"], e["to"], e["rel"]) for e in edges}:
                edges.append({"from": src, "to": dst, "rel": rel})
            for d in ((src_dt, src), (dst_dt, dst)):
                if d not in seen:
                    pending.append(d)

    # Si el recorrido se cortó por el tope, quedan aristas apuntando a
    # documentos que no se cargaron: se descartan para no dibujar huecos.
    edges = [e for e in edges if e["from"] in nodes and e["to"] in nodes]

    return {
        "current": doc.name,
        "nodes": sorted(nodes.values(), key=lambda n: (n["fecha"] or "", n["name"])),
        "edges": edges,
    }


# ---------------------------------------------------------------------------
# Bitácora de cambios
# ---------------------------------------------------------------------------

def _fmt(value) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f"{flt(value):g}"
    return str(value)


def _label(meta, fieldname: str) -> str:
    df = meta.get_field(fieldname)
    return (df.label if df and df.label else fieldname)


def _describe(doctype: str, data: dict) -> list:
    """Los cambios de un Version, en palabras."""
    meta = frappe.get_meta(doctype)
    out = []
    for item in data.get("changed") or []:
        field = item[0]
        if field in RUIDO:
            continue
        df = meta.get_field(field)
        if not df or df.fieldtype in TIPOS_RUIDO:
            continue
        out.append({"campo": _label(meta, field), "antes": _fmt(item[1]), "despues": _fmt(item[2])})

    # Las líneas de las tablas hijas se resumen: «Productos: agregó 2 línea(s)».
    resumen = {}
    for clave, verbo in (("added", "agregó"), ("removed", "quitó"), ("row_changed", "editó")):
        for item in data.get(clave) or []:
            tabla = TABLAS.get(item[0])
            if not tabla:
                continue
            resumen[(tabla, verbo)] = resumen.get((tabla, verbo), 0) + 1
    for (tabla, verbo), n in sorted(resumen.items()):
        out.append({"campo": tabla, "antes": "", "despues": f"{verbo} {n} línea(s)"})
    return out


@frappe.whitelist()
def get_document_log(kind: str, name: str, company: str = None) -> dict:
    """Quién hizo qué y cuándo: creación, ediciones, validación, anulación y
    comentarios del documento."""
    from facex_multi.api.compras.common import check_doc_access
    from facex_multi.api.compras.documentos import _cfg, _require

    cfg = _cfg(kind)
    company = _require(kind, company)
    doc = frappe.get_doc(cfg.doctype, (name or "").strip())
    check_doc_access(doc, company)

    eventos = []

    def add(tipo, user, when, detalle="", cambios=None):
        if not when:
            return
        eventos.append({
            "tipo": tipo,
            "user": user or "",
            "fullname": get_fullname(user) if user else "",
            "cuando": str(when),
            "detalle": detalle,
            "cambios": cambios or [],
        })

    add("Creado", doc.owner, doc.creation, f"Se registró el borrador de {cfg.label}.")

    for v in frappe.get_all(
        "Version",
        filters={"ref_doctype": cfg.doctype, "docname": doc.name},
        fields=["owner", "creation", "data"],
        order_by="creation asc",
        limit=200,
    ):
        try:
            data = json.loads(v.data or "{}")
        except ValueError:
            continue
        cambios = _describe(cfg.doctype, data)
        if cambios:
            add("Modificado", v.owner, v.creation, "", cambios)

    if doc.get("facex_validado_por"):
        add("Validado", doc.facex_validado_por, doc.get("facex_validado_el"),
            f"{cfg.label} validada.")
    elif doc.docstatus == 1:
        add("Validado", "", doc.modified, f"{cfg.label} validada (antes del registro de auditoría).")

    if doc.get("facex_cancelado_por"):
        add("Anulado", doc.facex_cancelado_por, doc.get("facex_cancelado_el"),
            f"{cfg.label} anulada.")
    elif doc.docstatus == 2:
        add("Anulado", "", doc.modified, f"{cfg.label} anulada (antes del registro de auditoría).")

    # Comentarios del usuario y el rastro de anexos: Frappe deja un Comment
    # «Attachment» / «Attachment Removed» por cada archivo que se liga o se
    # quita del documento, que es justo el alta y baja de cada anexo.
    tipos = {"Comment": "Comentario", "Attachment": "Anexo agregado",
             "Attachment Removed": "Anexo eliminado"}
    for c in frappe.get_all(
        "Comment",
        filters={"reference_doctype": cfg.doctype, "reference_name": doc.name,
                 "comment_type": ["in", list(tipos)]},
        fields=["owner", "creation", "content", "comment_type"],
        order_by="creation asc",
        limit=200,
    ):
        add(tipos[c.comment_type], c.owner, c.creation,
            frappe.utils.strip_html(c.content or "").strip()[:500])

    eventos.sort(key=lambda e: e["cuando"])

    por_usuario = {}
    for e in eventos:
        clave = e["fullname"] or e["user"] or "—"
        por_usuario[clave] = por_usuario.get(clave, 0) + 1

    return {
        "eventos": eventos,
        "por_usuario": [{"usuario": k, "eventos": v} for k, v in
                        sorted(por_usuario.items(), key=lambda x: (-x[1], x[0]))],
    }
