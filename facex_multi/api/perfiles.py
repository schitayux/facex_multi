"""
facex_multi.api.perfiles
------------------------
Perfiles de Permisos FacEx (compartidos por todas las compañías del sitio).

Modelo: la fila de FacEx Settings apunta a un perfil y sus 71 checks de
permiso (PROFILE_PERM_FIELDS) guardan el valor EFECTIVO. La tabla
`excepciones` se deriva sola: los checks que difieren del perfil.

- Asignar o cambiar el perfil de una fila → sus checks toman los valores del
  perfil (sin excepciones).
- Marcar distinto un check en una fila con perfil → queda como excepción.
- Guardar un perfil → se propaga a todas sus filas respetando sus excepciones.

Como la fila materializa el valor efectivo, el resolvedor de
permissions.py y todo el código que ya lee FacEx Settings no cambian.
"""
from __future__ import annotations

import frappe

from facex_multi.api.permissions import PROFILE_PERM_FIELDS, clear_permissions_cache

PROFILE_DOCTYPE = "FacEx Perfil de Permisos"


def perfil_values(perfil: str) -> dict:
    row = frappe.db.get_value(PROFILE_DOCTYPE, perfil, PROFILE_PERM_FIELDS, as_dict=True)
    if not row:
        frappe.throw(f"El Perfil de Permisos '{perfil}' no existe.")
    return {f: int(row.get(f) or 0) for f in PROFILE_PERM_FIELDS}


def _labels() -> dict:
    meta = frappe.get_meta("FacEx Settings")
    return {f: (meta.get_label(f) or f) for f in PROFILE_PERM_FIELDS}


def sync_settings_with_profile(doc) -> None:
    """FacEx Settings.validate: aplica el perfil (si se asignó o cambió) y
    recalcula las excepciones."""
    if not doc.perfil:
        doc.set("excepciones", [])
        return
    prof = perfil_values(doc.perfil)
    if doc.has_value_changed("perfil") and not doc.flags.keep_checks:
        for f in PROFILE_PERM_FIELDS:
            doc.set(f, prof[f])
    labels = _labels()
    doc.set("excepciones", [])
    for f in PROFILE_PERM_FIELDS:
        value = int(doc.get(f) or 0)
        if value != prof[f]:
            doc.append("excepciones", {
                "permiso": f, "etiqueta": labels[f], "valor": value, "valor_perfil": prof[f],
            })


def propagate_profile(profile_doc) -> int:
    """FacEx Perfil de Permisos.on_update: lleva el perfil a sus filas
    conservando las excepciones de cada una. Devuelve cuántas filas tocó."""
    prof = {f: int(profile_doc.get(f) or 0) for f in PROFILE_PERM_FIELDS}
    names = frappe.get_all("FacEx Settings", filters={"perfil": profile_doc.name}, pluck="name")
    for name in names:
        row = frappe.get_doc("FacEx Settings", name)
        overrides = {e.permiso: int(e.valor or 0) for e in row.get("excepciones") or []}
        for f in PROFILE_PERM_FIELDS:
            row.set(f, overrides.get(f, prof[f]))
        row.flags.keep_checks = True
        row.save(ignore_permissions=True)
    clear_permissions_cache()
    return len(names)


@frappe.whitelist()
def get_profile_values(perfil: str) -> dict:
    """Valores del perfil, para precargar los checks al elegirlo en el
    diálogo de Seguridad."""
    from facex_multi.api.invoice import get_effective_company
    from facex_multi.api.permissions import get_facex_can_view_seguridad
    if not get_facex_can_view_seguridad(get_effective_company()):
        frappe.throw("No tiene permiso para el módulo Seguridad.", frappe.PermissionError)
    return perfil_values(perfil)


# ---------------------------------------------------------------------------
# Migración asistida (se corre una vez por sitio con bench execute)
# ---------------------------------------------------------------------------

def migrar_a_perfiles(grupos: dict, descripciones: dict = None, dry_run: int = 1) -> str:
    """Crea perfiles a partir de grupos de usuarios y los asigna SIN cambiar
    ningún permiso efectivo: el perfil toma, check por check, el valor de la
    mayoría del grupo (empate → desmarcado) y lo que cada usuario tenga
    distinto queda como excepción.

    grupos = {"Ventas": ["carmen@x", "erick@x"], ...}; aplica a todas las
    filas de esos usuarios (todas sus compañías).
    """
    descripciones = descripciones or {}
    out = []
    for nombre, users in grupos.items():
        rows = frappe.get_all(
            "FacEx Settings",
            filters={"user": ["in", users]},
            fields=["name", "user"] + PROFILE_PERM_FIELDS,
        )
        missing = set(users) - {r.user for r in rows}
        if missing:
            frappe.throw(f"Sin fila de FacEx Settings: {', '.join(sorted(missing))}")
        values = {
            f: int(sum(int(r.get(f) or 0) for r in rows) * 2 > len(rows))
            for f in PROFILE_PERM_FIELDS
        }
        excepciones = sum(
            1 for r in rows for f in PROFILE_PERM_FIELDS if int(r.get(f) or 0) != values[f]
        )
        out.append(f"{nombre}: {len(rows)} fila(s), {sum(values.values())} permisos, {excepciones} excepción(es)")
        if int(dry_run):
            # Las filas se guardarán: sus validaciones (bodegas, socio, listas)
            # deben pasar hoy, o la migración se detendría a la mitad.
            for r in rows:
                row = frappe.get_doc("FacEx Settings", r.name)
                try:
                    row.run_method("validate")
                except Exception as e:
                    out.append(f"  ⚠ {r.user} ({r.name}) no pasa la validación: {str(e)[:150]}")
                frappe.clear_messages()
            continue
        if frappe.db.exists(PROFILE_DOCTYPE, nombre):
            prof = frappe.get_doc(PROFILE_DOCTYPE, nombre)
        else:
            prof = frappe.new_doc(PROFILE_DOCTYPE)
            prof.nombre_perfil = nombre
        prof.descripcion = descripciones.get(nombre) or prof.get("descripcion")
        for f, v in values.items():
            prof.set(f, v)
        prof.flags.skip_propagation = True
        prof.save(ignore_permissions=True)
        for r in rows:
            row = frappe.get_doc("FacEx Settings", r.name)
            row.perfil = nombre
            row.flags.keep_checks = True
            row.save(ignore_permissions=True)
        prof.reload()
        prof.flags.skip_propagation = True
        prof.save(ignore_permissions=True)  # refresca usuarios_asignados
    if not int(dry_run):
        frappe.db.commit()
        clear_permissions_cache()
    return ("SIMULACIÓN — nada guardado\n" if int(dry_run) else "APLICADO\n") + "\n".join(out)
