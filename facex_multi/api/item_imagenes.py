# -*- coding: utf-8 -*-
"""Imágenes de productos para la página web (2026-11-09).

Solo actúa sobre productos de compañías con «Tiene página web» activa en
FacEx Configuracion Compania (hoy solo Distotall). Para cualquier otra
compañía cada función regresa sin hacer nada.

1. Al subir una imagen a un producto:
   - Si el formato no se ve en el navegador (TIFF, PSD, HEIC con el plugin…)
     se agrega una copia JPEG al mismo producto; el original queda intacto.
   - Si el producto no tiene imagen principal, esa imagen pasa a serlo
     (es la que lee el catálogo de la página web).
2. Al borrar la imagen principal, la siguiente imagen del producto toma su
   lugar (si la hay).
3. `usar_como_principal`: botón «Usar como principal» del carrusel.

Los cambios de imagen principal vuelven a publicar el catálogo en segundo plano.
"""
import os

import frappe

try:  # fotos HEIC/HEIF de iPhone, solo si el paquete está instalado
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:
    pass

# Formatos que el navegador muestra tal cual (nombre de formato de Pillow).
FORMATOS_NAVEGADOR = {"JPEG", "PNG", "WEBP", "GIF", "AVIF", "BMP"}
# Extensiones que se listan como imagen del producto en las compañías con página.
EXTENSIONES_WEB = (".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif", ".avif", ".bmp")
EXTENSIONES_HEIC = (".heic", ".heif")
LADO_MAXIMO_COPIA = 4000  # px de la copia JPEG de formatos no compatibles


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def compania_web(item_code: str):
    """Compañía del producto si tiene página web activa; si no, None."""
    if not item_code:
        return None
    from facex_multi.api.pagina_web import companias_con_pagina

    companias = companias_con_pagina()
    if not companias:
        return None
    company = frappe.db.get_value("Item", item_code, "bfel_company")
    return company if company and company in companias else None


def es_extension_web(nombre: str) -> bool:
    return (nombre or "").lower().endswith(EXTENSIONES_WEB)


def _formato(ruta: str):
    from PIL import Image

    try:
        with Image.open(ruta) as im:
            return im.format
    except Exception:
        return None


def _a_jpeg(ruta: str):
    from io import BytesIO

    from PIL import Image, ImageOps

    try:
        with Image.open(ruta) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA", "P", "PA"):
                im = im.convert("RGBA")
                fondo = Image.new("RGB", im.size, (255, 255, 255))
                fondo.paste(im, mask=im.split()[-1])
                im = fondo
            elif im.mode != "RGB":
                im = im.convert("RGB")
            im.thumbnail((LADO_MAXIMO_COPIA, LADO_MAXIMO_COPIA), Image.LANCZOS)
            salida = BytesIO()
            im.save(salida, "JPEG", quality=90, optimize=True)
            return salida.getvalue()
    except Exception:
        return None


def _poner_principal(item_code: str, url, company: str):
    frappe.db.set_value("Item", item_code, "image", url or None)
    from facex_multi.api.pagina_web import programar_compania

    programar_compania(company)


# ---------------------------------------------------------------------------
# Hooks de File
# ---------------------------------------------------------------------------

def al_subir_archivo(doc, method=None):
    """File.after_insert."""
    if doc.get("is_folder") or doc.get("attached_to_doctype") != "Item" or not doc.get("attached_to_name"):
        return
    if doc.flags.get("facex_copia_jpeg"):
        return  # copia creada aquí mismo; la imagen principal la decide el original
    item_code = doc.attached_to_name
    company = compania_web(item_code)
    if not company:
        return

    from facex_multi.api.pagina_web import _ruta_archivo

    ruta = _ruta_archivo(doc.file_url)
    if not ruta:
        return
    nombre = (doc.file_name or os.path.basename(ruta)).strip()
    formato = _formato(ruta)
    if not formato:
        if nombre.lower().endswith(EXTENSIONES_HEIC):
            frappe.throw(
                "Las fotos HEIC del iPhone todavía no se pueden leer. Súbela como JPG o PNG "
                "(en el iPhone: Ajustes › Cámara › Formatos › «Más compatible»)."
            )
        return  # no es imagen (PDF, etc.): no se toca

    url = doc.file_url
    if formato not in FORMATOS_NAVEGADOR:
        datos = _a_jpeg(ruta)
        if not datos:
            return
        copia = frappe.get_doc(
            {
                "doctype": "File",
                "file_name": os.path.splitext(nombre)[0] + ".jpg",
                "attached_to_doctype": "Item",
                "attached_to_name": item_code,
                "is_private": doc.is_private,
                "content": datos,
            }
        )
        copia.flags.facex_copia_jpeg = True
        copia.insert(ignore_permissions=True)
        url = copia.file_url

    if not frappe.db.get_value("Item", item_code, "image"):
        _poner_principal(item_code, url, company)


def al_borrar_archivo(doc, method=None):
    """File.on_trash: si era la imagen principal, la siguiente toma su lugar."""
    if doc.get("is_folder") or doc.get("attached_to_doctype") != "Item" or not doc.get("attached_to_name"):
        return
    item_code = doc.attached_to_name
    if not frappe.db.exists("Item", item_code):
        return
    company = compania_web(item_code)
    if not company:
        return
    if frappe.db.get_value("Item", item_code, "image") != doc.file_url:
        return
    siguiente = None
    for f in frappe.get_all(
        "File",
        filters={"attached_to_doctype": "Item", "attached_to_name": item_code, "name": ["!=", doc.name]},
        fields=["file_name", "file_url"],
        order_by="creation desc",
    ):
        if f.file_url != doc.file_url and es_extension_web(f.file_name or f.file_url):
            siguiente = f.file_url
            break
    _poner_principal(item_code, siguiente, company)


# ---------------------------------------------------------------------------
# Botón «Usar como principal»
# ---------------------------------------------------------------------------

@frappe.whitelist()
def usar_como_principal(item_code: str, file_name: str) -> dict:
    if not item_code or not frappe.db.exists("Item", item_code):
        frappe.throw("Producto no encontrado.")
    company = compania_web(item_code)
    if not company:
        frappe.throw("Solo disponible para compañías con página web.")
    frappe.has_permission("Item", ptype="write", doc=item_code, throw=True)

    from facex_multi.api.permissions import get_facex_permissions_for_company

    if not get_facex_permissions_for_company(company).get("modifica_items", 1):
        frappe.throw("No tiene permiso para modificar productos.", frappe.PermissionError)

    f = frappe.db.get_value(
        "File", file_name, ["attached_to_doctype", "attached_to_name", "file_name", "file_url"], as_dict=True
    ) if file_name else None
    if not f or f.attached_to_doctype != "Item" or f.attached_to_name != item_code:
        frappe.throw("La imagen no pertenece a este producto.")
    if not es_extension_web(f.file_name or f.file_url):
        frappe.throw("Ese archivo no es una imagen.")

    _poner_principal(item_code, f.file_url, company)
    return {"ok": True, "image": f.file_url}
