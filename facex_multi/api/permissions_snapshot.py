"""
facex_multi.api.permissions_snapshot
------------------------------------
Foto de los permisos EFECTIVOS de FacEx para cada usuario real del sitio.

Red de seguridad del rediseño de permisos: se toma una foto antes de un
cambio, otra después, y se comparan. Si un refactor dice "mismo
comportamiento", las dos fotos deben ser idénticas.

Solo lectura: no escribe nada (hace rollback al final por si algún getter
tocara la base). Uso:

    bench --site <sitio> execute facex_multi.api.permissions_snapshot.run \
        --kwargs "{'path': '/tmp/foto_antes.json'}"
    bench --site <sitio> execute facex_multi.api.permissions_snapshot.compare \
        --kwargs "{'before': '/tmp/foto_antes.json', 'after': '/tmp/foto_despues.json'}"
"""
from __future__ import annotations

import inspect
import json

import frappe

MOV_MODES = ("in", "out", "transfer")


def _targets() -> list:
    """(usuario, compañía) a fotografiar: cada fila de FacEx Settings con
    usuario, más usuarios de escritorio SIN fila en su compañía por defecto
    (cubre el criterio "sin fila" de cada permiso) y Administrator."""
    rows = frappe.get_all(
        "FacEx Settings",
        filters={"user": ["is", "set"]},
        fields=["user", "bfel_company"],
        order_by="user, bfel_company",
    )
    targets = [(r.user, r.bfel_company) for r in rows]
    with_row = {r.user for r in rows}
    companies = frappe.get_all("Company", pluck="name", order_by="name")
    no_row = frappe.get_all(
        "User",
        filters={"enabled": 1, "user_type": "System User", "name": ["not in", list(with_row) + ["Administrator", "Guest"]]},
        pluck="name",
        order_by="name",
        limit=5,
    )
    for user in no_row:
        for company in companies[:2]:
            targets.append((user, company))
    if companies:
        targets.append(("Administrator", companies[0]))
    return targets


def _call(fn, *args):
    try:
        value = fn(*args)
    except Exception as e:  # el error también es parte del comportamiento
        return f"<{type(e).__name__}: {str(e)[:120]}>"
    if isinstance(value, (set, tuple)):
        value = sorted(value) if isinstance(value, set) else list(value)
    return value


def _snapshot_one(user: str, company: str) -> dict:
    from facex_multi.api import permissions as P

    frappe.set_user(user)
    frappe.local.facex_allowed_companies = None
    out = {}
    for name, fn in sorted(inspect.getmembers(P, inspect.isfunction)):
        if not name.startswith("get_facex_") or fn.__module__ != P.__name__:
            continue
        params = list(inspect.signature(fn).parameters)
        if name == "get_facex_allowed_warehouses":
            for op in (None, *P.BODEGA_OPERACIONES):
                out[f"{name}[{op}]"] = _call(fn, company, op)
        elif name == "get_facex_companies_with_transporte_report_access":
            out[name] = _call(fn, [company])
        elif name == "get_facex_user_sales_partner":
            out[f"{name}[company]"] = _call(fn, company)
            out[f"{name}[all]"] = _call(fn)
        elif params and params[0] == "company":
            out[name] = _call(fn, company)
        elif not params:
            out[name] = _call(fn)
    inv = P.get_facex_inventory_permissions(company)
    for mode in MOV_MODES:
        out[f"movement_gate[{mode}]"] = _call(P.movement_gate, inv, mode)
    out["sales_invoice_query_conditions"] = _call(P.sales_invoice_query_conditions, user)
    out["customer_query_conditions"] = _call(P.customer_query_conditions, user)

    from facex_multi.api import reports
    out["reports.has_reports_permission"] = _call(reports.has_reports_permission, company)

    from facex_multi.api.invoice import get_defaults
    defaults = _call(get_defaults, company)
    if isinstance(defaults, dict):
        out["get_defaults.permissions"] = defaults.get("permissions")
        out["get_defaults.company_config"] = defaults.get("company_config")
    else:
        out["get_defaults"] = defaults
    frappe.clear_messages()
    return out


def run(path: str = None) -> str:
    original = frappe.session.user
    result = {}
    try:
        for user, company in _targets():
            result[f"{user} @ {company}"] = _snapshot_one(user, company)
    finally:
        frappe.set_user(original)
        frappe.db.rollback()
    text = json.dumps(result, sort_keys=True, ensure_ascii=False, indent=1, default=str)
    if path:
        with open(path, "w") as f:
            f.write(text)
        return f"{len(result)} usuarios/compañías → {path}"
    return text


def compare(before: str, after: str) -> str:
    a = json.load(open(before))
    b = json.load(open(after))
    diffs = []
    for key in sorted(set(a) | set(b)):
        if key not in a or key not in b:
            diffs.append(f"{key}: solo en {'antes' if key in a else 'después'}")
            continue
        for perm in sorted(set(a[key]) | set(b[key])):
            if a[key].get(perm) != b[key].get(perm):
                diffs.append(f"{key} :: {perm}: {a[key].get(perm)!r} → {b[key].get(perm)!r}")
    if not diffs:
        return f"IDÉNTICO ({len(a)} usuarios/compañías)"
    return f"{len(diffs)} DIFERENCIAS:\n" + "\n".join(diffs[:200])
