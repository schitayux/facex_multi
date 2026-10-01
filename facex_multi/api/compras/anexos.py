"""
facex_multi.api.compras.anexos
------------------------------
Anexos de los documentos de compra: archivo + comentario opcional + el check
«Copiar hacia documentos destino» (marcado por omisión).

Las filas viven en la tabla hija `facex_anexos` (doctype FacEx Anexo) que
ensure_compras_custom_fields agrega a Purchase Order / Purchase Receipt /
Purchase Invoice con allow_on_submit, y cada archivo tiene su propio File
ligado al documento.

Por qué no se usa el adjuntador estándar del Desk: /api/method/upload_file
exige permiso de escritura de ERPNext sobre el doctype (los usuarios de FacEx
no lo tienen sobre Purchase Order) y además no deja adjuntar a un documento
validado. Por lo mismo la descarga va por download_anexo y no por el enlace
directo a /private/files/…. Aquí el control es el permiso FacEx del documento
y las filas se escriben directo en la tabla hija, así adjuntar nunca re-valida
el documento de compra.
"""
from __future__ import annotations

import base64
import json

import frappe
from frappe.utils import cint, now_datetime

from facex_multi.api.compras.common import is_own_scope

# Tamaño máximo por archivo (el contenido viaja en base64 dentro del request).
MAX_ANEXO_MB = 10

ANEXO_FIELD = "facex_anexos"


# ---------------------------------------------------------------------------
# Permisos / acceso
# ---------------------------------------------------------------------------

def _doc_for_anexos(kind: str, name: str):
    """El documento + la compañía efectiva, con el permiso de FacEx que
    corresponde a modificarlo (el mismo de grabar su borrador: adjuntar no
    cambia cantidades ni importes, pero sí es intervenir el documento)."""
    from facex_multi.api.compras.common import check_doc_access
    from facex_multi.api.compras.documentos import _cfg, _require

    cfg = _cfg(kind)
    doc = frappe.get_doc(cfg.doctype, (name or "").strip())
    company = _require(kind, doc.company, "draft",
                       msg=f"No tiene permiso para modificar documentos «{cfg.label}» en FacEx.")
    check_doc_access(doc, company)
    if doc.docstatus == 2:
        frappe.throw("El documento está anulado: ya no admite cambios en sus anexos.")
    return doc


def _can_read(kind: str, name: str):
    """Lectura: basta el permiso de consulta del documento."""
    from facex_multi.api.compras.common import check_doc_access
    from facex_multi.api.compras.documentos import _cfg, _require

    cfg = _cfg(kind)
    doc = frappe.get_doc(cfg.doctype, (name or "").strip())
    company = _require(kind, doc.company)
    check_doc_access(doc, company)
    return doc


# ---------------------------------------------------------------------------
# Lectura
# ---------------------------------------------------------------------------

def anexos_listos() -> bool:
    """El doctype hijo lo crea `bench migrate`. Mientras un sitio no haya
    migrado, los anexos simplemente no existen: leerlos no debe romper la
    apertura de los documentos (gunicorn recarga el .py antes del migrate)."""
    return bool(frappe.db.table_exists("FacEx Anexo"))


def read_anexos(doctype: str, name: str) -> list:
    """Filas de anexos de un documento, con los datos del archivo."""
    if not anexos_listos():
        return []
    rows = frappe.get_all(
        "FacEx Anexo",
        filters={"parenttype": doctype, "parent": name, "parentfield": ANEXO_FIELD},
        fields=["name", "archivo", "nombre_archivo", "comentario", "copiar_a_destino",
                "origen", "subido_por", "subido_el", "idx"],
        order_by="idx asc, subido_el asc",
    )
    for r in rows:
        r["copiar_a_destino"] = cint(r.get("copiar_a_destino"))
        r["subido_por_fullname"] = frappe.utils.get_fullname(r.subido_por) if r.get("subido_por") else ""
        r["file_size"] = frappe.db.get_value("File", {"file_url": r.archivo}, "file_size") or 0
    return rows


@frappe.whitelist()
def get_anexos(kind: str, name: str) -> list:
    _can_read(kind, name)
    from facex_multi.api.compras.documentos import _cfg
    return read_anexos(_cfg(kind).doctype, name)


# ---------------------------------------------------------------------------
# Archivos
# ---------------------------------------------------------------------------

def _save_file(filename: str, content: bytes, doctype: str = None, name: str = None):
    """Crea el File. Sin documento (`name` vacío) queda sin ligar: el
    documento todavía no existe y se liga cuando se grabe el borrador."""
    f = frappe.get_doc({
        "doctype": "File",
        "file_name": filename,
        "content": content,
        "is_private": 1,
        "attached_to_doctype": doctype or None,
        "attached_to_name": name or None,
        "attached_to_field": ANEXO_FIELD if doctype else None,
    })
    try:
        f.insert(ignore_permissions=True)
    except frappe.ValidationError:
        raise
    except Exception:
        # Frappe revisa el contenido del archivo (tipo, PDFs con JavaScript…);
        # un archivo dañado reventaría con un error técnico.
        frappe.log_error(title=f"FacEx anexos: no se pudo guardar {filename}")
        frappe.throw(f"No se pudo guardar «{filename}»: el archivo parece dañado o no es un "
                     "formato admitido. Verifíquelo y vuelva a intentarlo.")
    return f


def _link_file(file_url: str, doctype: str, name: str) -> None:
    """Asegura un File de `file_url` ligado a este documento.

    Un anexo copiado o subido antes de grabar apunta a un archivo cuyo File
    pertenece a otro documento (o a ninguno). Cada documento necesita su
    propio File: es por él que download_anexo entrega el archivo, y es lo que
    hace que borrar el documento se lleve sus anexos sin tocar los del
    documento de origen."""
    if not file_url:
        return
    if frappe.db.exists("File", {"file_url": file_url, "attached_to_doctype": doctype,
                                 "attached_to_name": name}):
        return
    origen = frappe.db.get_value(
        "File", {"file_url": file_url}, ["name", "attached_to_doctype", "attached_to_name"], as_dict=True
    )
    if not origen:
        return
    doc = frappe.get_doc("File", origen.name)
    if not origen.attached_to_doctype:
        # Archivo recién subido para un documento que aún no existía.
        doc.attached_to_doctype = doctype
        doc.attached_to_name = name
        doc.attached_to_field = ANEXO_FIELD
        doc.save(ignore_permissions=True)
        # El rastro «Adjunto» en el documento lo deja Frappe al insertar el
        # File; aquí el File ya existía, así que hay que dejarlo a mano para
        # que el anexo aparezca en la bitácora de cambios.
        doc.create_attachment_record()
        return
    doc.create_attachment_copy(doctype, name, ANEXO_FIELD, ignore_permissions=True)


def _assert_file_allowed(file_url: str, company: str) -> None:
    """El `file_url` llega del formulario: hay que comprobar que el usuario
    tenga derecho a ese archivo antes de copiarlo a su documento.

    Vale si lo subió él y aún no está ligado a nada (anexo pendiente de un
    documento nuevo) o si está ligado a un documento de compra de su misma
    compañía y dentro de su alcance. Sin esto, un cliente manipulado podría
    anexar —y así leer— un archivo privado de otra compañía."""
    from facex_multi.api.compras.common import CICLO_DOCTYPES

    rows = frappe.get_all(
        "File", filters={"file_url": file_url},
        fields=["owner", "attached_to_doctype", "attached_to_name"],
    )
    if not rows:
        frappe.throw("El archivo del anexo ya no existe.")
    for r in rows:
        if not r.attached_to_doctype:
            if r.owner == frappe.session.user:
                return
            continue
        if r.attached_to_doctype not in CICLO_DOCTYPES:
            continue
        origen = frappe.db.get_value(r.attached_to_doctype, r.attached_to_name,
                                     ["company", "owner"], as_dict=True)
        if not origen or origen.company != company:
            continue
        if is_own_scope(company) and origen.owner != frappe.session.user:
            continue
        return
    frappe.throw("No tiene acceso al archivo que intenta anexar.", frappe.PermissionError)


def _drop_file(file_url: str, doctype: str, name: str, row: str = None) -> None:
    """Quita el File de ESTE documento (el mismo archivo anexado en otro
    documento queda intacto, y el archivo en disco solo desaparece cuando ya no
    lo referencia ningún File).

    `row` se acepta para limpiar también el File que Frappe anexaba a la propia
    fila cuando `archivo` era de tipo Attach: en sitios que ya tienen filas de
    esa época hay que borrarlo igual, o queda huérfano."""
    objetivos = [{"attached_to_doctype": doctype, "attached_to_name": name}]
    if row:
        objetivos.append({"attached_to_doctype": "FacEx Anexo", "attached_to_name": row})
    for filtros in objetivos:
        for f in frappe.get_all("File", filters={"file_url": file_url, **filtros}, pluck="name"):
            frappe.delete_doc("File", f, ignore_permissions=True, delete_permanently=False)


# ---------------------------------------------------------------------------
# Filas (escritura directa en la tabla hija)
# ---------------------------------------------------------------------------

def _next_idx(doctype: str, name: str) -> int:
    return cint(frappe.db.sql(
        """SELECT MAX(idx) FROM `tabFacEx Anexo`
           WHERE parenttype = %s AND parent = %s AND parentfield = %s""",
        (doctype, name, ANEXO_FIELD),
    )[0][0]) + 1


def add_row(doctype: str, name: str, docstatus: int, file_url: str, nombre_archivo: str = "",
            comentario: str = "", copiar_a_destino: int = 1, origen: str = "") -> str:
    """Agrega la fila de anexo y liga el archivo al documento."""
    _link_file(file_url, doctype, name)
    row = frappe.new_doc("FacEx Anexo")
    row.update({
        "archivo": file_url,
        "nombre_archivo": nombre_archivo or (file_url or "").split("/")[-1],
        "comentario": comentario or "",
        "copiar_a_destino": 1 if cint(copiar_a_destino) else 0,
        "origen": origen or "",
        "subido_por": frappe.session.user,
        "subido_el": now_datetime(),
    })
    row.parenttype = doctype
    row.parent = name
    row.parentfield = ANEXO_FIELD
    row.idx = _next_idx(doctype, name)
    row.insert(ignore_permissions=True)
    # Las filas hijas comparten el docstatus del padre (si no, el grid del
    # Desk las dibujaría como editables en un documento ya validado).
    if cint(docstatus):
        frappe.db.set_value("FacEx Anexo", row.name, "docstatus", cint(docstatus), update_modified=False)
    return row.name


@frappe.whitelist()
def upload_anexo(kind: str, filename: str, content_b64: str, name: str = None,
                 comentario: str = None, copiar_a_destino: int = 1, company: str = None) -> dict:
    """Sube un archivo como anexo.

    Con `name` (documento ya grabado, borrador o validado) crea la fila de
    inmediato. Sin `name` solo guarda el archivo y devuelve su URL: el
    formulario la lleva en el borrador y la fila se crea al grabar."""
    from facex_multi.api.compras.documentos import _cfg

    filename = (filename or "").strip()
    if not filename:
        frappe.throw("El archivo no tiene nombre.")
    try:
        content = base64.b64decode(content_b64 or "", validate=True)
    except Exception:
        frappe.throw("No se pudo leer el archivo.")
    if not content:
        frappe.throw(f"El archivo «{filename}» está vacío.")
    if len(content) > MAX_ANEXO_MB * 1024 * 1024:
        frappe.throw(f"«{filename}» supera el máximo de {MAX_ANEXO_MB} MB por anexo.")

    if not anexos_listos():
        frappe.throw("Los anexos no están habilitados en este sitio todavía. "
                     "Pida al administrador que ejecute la actualización (bench migrate).")

    cfg = _cfg(kind)
    name = (name or "").strip()
    if name:
        doc = _doc_for_anexos(kind, name)
        f = _save_file(filename, content, cfg.doctype, doc.name)
        row = add_row(cfg.doctype, doc.name, doc.docstatus, f.file_url, f.file_name,
                      comentario, copiar_a_destino)
        frappe.db.commit()
        return {"success": True, "file_url": f.file_url, "nombre_archivo": f.file_name, "row": row}

    # Documento nuevo todavía sin grabar: solo se valida el permiso del módulo.
    from facex_multi.api.compras.documentos import _require
    _require(kind, company, "draft")
    f = _save_file(filename, content)
    frappe.db.commit()
    return {"success": True, "file_url": f.file_url, "nombre_archivo": f.file_name, "row": None}


@frappe.whitelist()
def download_anexo(kind: str, name: str = None, row: str = None, file_url: str = None):
    """Entrega el archivo de un anexo con el permiso de FacEx.

    El enlace directo a /private/files/… no sirve: Frappe resuelve el permiso
    de un archivo privado contra el documento al que está ligado, y los
    usuarios de FacEx no tienen permiso de ERPNext sobre Purchase Order /
    Receipt / Invoice — verían el anexo en la pantalla y no podrían abrirlo."""
    from facex_multi.api.compras.documentos import _cfg

    if row:
        doc = _can_read(kind, name)
        file_url = _own_row(_cfg(kind).doctype, doc.name, row)
        encontrado = frappe.get_all("File", filters={"file_url": file_url,
                                                     "attached_to_doctype": _cfg(kind).doctype,
                                                     "attached_to_name": doc.name},
                                    pluck="name", limit=1)
        if not encontrado:
            frappe.throw("El archivo de este anexo ya no está disponible.")
        f = frappe.get_doc("File", encontrado[0])
    else:
        # Anexo todavía pendiente de grabar: solo su propio archivo recién subido.
        rows = frappe.get_all("File", filters={"file_url": (file_url or "").strip(),
                                               "owner": frappe.session.user,
                                               "attached_to_doctype": ["is", "not set"]},
                              pluck="name", limit=1)
        if not rows:
            frappe.throw("No tiene acceso a este archivo.", frappe.PermissionError)
        f = frappe.get_doc("File", rows[0])

    frappe.local.response.filename = f.file_name or (f.file_url or "").split("/")[-1]
    frappe.local.response.filecontent = f.get_content()
    frappe.local.response.type = "download"


@frappe.whitelist()
def update_anexo(kind: str, name: str, row: str, comentario: str = None,
                 copiar_a_destino: int = None) -> dict:
    """Edita el comentario y/o el check de copia de un anexo."""
    from facex_multi.api.compras.documentos import _cfg

    doc = _doc_for_anexos(kind, name)
    _own_row(_cfg(kind).doctype, doc.name, row)
    values = {}
    if comentario is not None:
        values["comentario"] = comentario
    if copiar_a_destino is not None:
        values["copiar_a_destino"] = 1 if cint(copiar_a_destino) else 0
    if values:
        frappe.db.set_value("FacEx Anexo", row, values, update_modified=False)
        frappe.db.commit()
    return {"success": True}


@frappe.whitelist()
def delete_anexo(kind: str, name: str, row: str) -> dict:
    from facex_multi.api.compras.documentos import _cfg

    cfg = _cfg(kind)
    doc = _doc_for_anexos(kind, name)
    file_url = _own_row(cfg.doctype, doc.name, row)
    _drop_file(file_url, cfg.doctype, doc.name, row)
    frappe.delete_doc("FacEx Anexo", row, ignore_permissions=True)
    frappe.db.commit()
    return {"success": True}


def _own_row(doctype: str, name: str, row: str) -> str:
    """La fila tiene que ser de ESTE documento (el nombre viene del cliente)."""
    data = frappe.db.get_value(
        "FacEx Anexo", row, ["parenttype", "parent", "parentfield", "archivo"], as_dict=True
    )
    if not data or data.parenttype != doctype or data.parent != name or data.parentfield != ANEXO_FIELD:
        frappe.throw("El anexo no pertenece a este documento.")
    return data.archivo or ""


# ---------------------------------------------------------------------------
# Grabado del documento / copia hacia el destino
# ---------------------------------------------------------------------------

def persist_pending(doctype: str, name: str, docstatus: int, pendientes) -> None:
    """Crea las filas de los anexos que el formulario traía pendientes (los
    que se subieron antes de que el documento existiera, y los copiados del
    documento de origen). Se llama al grabar (save_document)."""
    if not pendientes or not anexos_listos():
        return
    if isinstance(pendientes, str):
        pendientes = json.loads(pendientes or "[]")
    company = frappe.db.get_value(doctype, name, "company")
    for a in pendientes or []:
        file_url = (a.get("file_url") or a.get("archivo") or "").strip()
        if not file_url:
            continue
        if frappe.db.exists("FacEx Anexo", {"parenttype": doctype, "parent": name,
                                            "parentfield": ANEXO_FIELD, "archivo": file_url}):
            continue
        _assert_file_allowed(file_url, company)
        add_row(doctype, name, docstatus, file_url, a.get("nombre_archivo") or "",
                a.get("comentario") or "", a.get("copiar_a_destino", 1), a.get("origen") or "")


def copiables(doctype: str, name: str, origen_label: str) -> list:
    """Anexos del documento de origen marcados «Copiar hacia documentos
    destino», en el formato que espera el formulario del destino."""
    out = []
    for r in read_anexos(doctype, name):
        if not r["copiar_a_destino"]:
            continue
        out.append({
            "file_url": r["archivo"],
            "nombre_archivo": r["nombre_archivo"],
            "comentario": r["comentario"] or "",
            "copiar_a_destino": 1,
            "origen": r["origen"] or f"{origen_label} {name}",
            "heredado": 1,
        })
    return out
