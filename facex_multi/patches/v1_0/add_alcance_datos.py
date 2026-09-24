"""
Patch: Alcance de datos (Ventas / Inventario / Compras) + checks que
reemplazan al Rol (Clasificación) «Gerencia».

Traduce, fila por fila de FacEx Settings, lo que hoy decide «Gerencia» para
que nadie note el cambio:
- Gerencia → alcance_ventas «Toda la compañía», reportes_todas_bodegas,
  cierre_supervisar y cierre_reabrir marcados.
- Resto   → alcance_ventas «Solo lo creado por mí», esos checks en 0.
- alcance_inventario / alcance_compras → «Toda la compañía» para todos (esos
  reportes no filtraban por usuario creador).
Luego cada Perfil de Permisos toma, campo por campo, el valor de la mayoría
de sus filas y se recalculan las excepciones. rol_clasificacion no se toca:
queda informativo. Idempotente: solo completa filas sin alcance_ventas.
"""
import frappe

from facex_multi.api.permissions import SCOPE_ALL, SCOPE_OWN

NEW_CHECKS = ("reportes_todas_bodegas", "cierre_supervisar", "cierre_reabrir")
NEW_SCOPES = ("alcance_ventas", "alcance_inventario", "alcance_compras")


def execute():
    for dt in ("facex_settings_excepcion", "facex_perfil_de_permisos", "facex_settings"):
        frappe.reload_doc("facex_multi", "doctype", dt)

    rows = frappe.get_all(
        "FacEx Settings",
        filters={"user": ["is", "set"]},
        fields=["name", "perfil", "rol_clasificacion", "alcance_ventas"],
    )
    for r in rows:
        if r.alcance_ventas:
            continue
        g = r.rol_clasificacion == "Gerencia"
        frappe.db.set_value("FacEx Settings", r.name, {
            "alcance_ventas": SCOPE_ALL if g else SCOPE_OWN,
            "alcance_inventario": SCOPE_ALL,
            "alcance_compras": SCOPE_ALL,
            "reportes_todas_bodegas": int(g),
            "cierre_supervisar": int(g),
            "cierre_reabrir": int(g),
        }, update_modified=False)

    from facex_multi.api.perfiles import PROFILE_DOCTYPE, sync_settings_with_profile

    for perfil in frappe.get_all(PROFILE_DOCTYPE, pluck="name"):
        members = frappe.get_all(
            "FacEx Settings",
            filters={"perfil": perfil},
            fields=["name"] + list(NEW_CHECKS) + list(NEW_SCOPES),
        )
        if not members:
            continue
        values = {}
        for f in NEW_CHECKS:
            values[f] = int(sum(int(m.get(f) or 0) for m in members) * 2 > len(members))
        for f in NEW_SCOPES:
            opts = [m.get(f) or SCOPE_OWN for m in members]
            # más frecuente; empate → el más restrictivo (Solo lo creado por mí)
            values[f] = max(set(opts), key=lambda o: (opts.count(o), o == SCOPE_OWN))
        frappe.db.set_value(PROFILE_DOCTYPE, perfil, values, update_modified=False)

        for m in members:
            row = frappe.get_doc("FacEx Settings", m.name)
            row.flags.keep_checks = True
            sync_settings_with_profile(row)
            frappe.db.delete("FacEx Settings Excepcion", {"parent": row.name, "parenttype": "FacEx Settings"})
            for i, e in enumerate(row.get("excepciones") or [], 1):
                e.idx = i
                e.db_insert()

    frappe.db.commit()
