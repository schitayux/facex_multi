"""
facex_multi.api.nav_guard
-------------------------
Navegación restringida. Cada usuario de escritorio (System User) cae en uno
de tres modos (nav_mode):

- None ("libre"): System Manager / Administrator, o con «Permitir navegar x
  ERP» marcado en alguna de sus filas de FacEx Settings. Navega como siempre.
- "facex": tiene fila(s) de FacEx Settings y todas con el check desmarcado
  (default del campo). Solo las pantallas de FacEx: cualquier otra URL del
  ERP lo regresa a la «Página de inicio (navegación restringida)» de FacEx
  Configuracion Compania.
- "blocked": NO tiene fila de FacEx Settings. Contar con una es obligatorio:
  no entra ni a FacEx ni al ERP; todo lo manda a /facex-sin-acceso (aviso +
  cerrar sesión) hasta que Seguridad le cree su fila.

Dos capas, con la MISMA regla (resolve_path):
- before_request: cargas completas de página (URL escrita a mano, pestaña
  nueva, /app → /desk, login).
- nav_guard.js: navegación interna del Desk (SPA, no pasa por el servidor);
  pregunta a resolve_route qué hacer con la ruta bloqueada.

Los enlaces a documentos que FacEx mismo abre (/app/sales-invoice/X,
/app/payment-entry/X, compras, stock entry…) no se rompen en modo "facex":
se traducen a la pantalla FacEx equivalente o a /printview (solo lectura).

Con varias compañías basta que UNA fila lo permita (no se encierra a nadie
por cambiar de compañía). Un error al evaluar la regla deja pasar la
petición (log `facex_nav_guard`) en vez de dejar a todos sin poder entrar.

Esto es una restricción de NAVEGACIÓN, no de datos: lo que protege la
información siguen siendo roles/DocPerm y los permission_query_conditions /
has_permission de permissions.py.
"""
from __future__ import annotations

from urllib.parse import urlencode

import frappe
from frappe.utils import cint

FIELD = "permite_navegar_erp"
CONFIG_DOCTYPE = "FacEx Configuracion Compania"
CONFIG_FIELD = "pagina_inicio_restringida"

MODE_FACEX = "facex"
MODE_BLOCKED = "blocked"
BLOCKED_PATH = "/facex-sin-acceso"

# Pages a las que FacEx da acceso desde su propia navegación (facex-si-carga
# no: solo se enlaza desde el workspace del ERP).
ALLOWED_PAGES = (
    "facex",
    "facex-screen",
    "facex-inventario",
    "facex-cierre",
    "facex-pagos",
    "facex-compras",
)
DEFAULT_PAGE = "facex"

# Nunca se restringen (ni siquiera a un usuario bloqueado): API —incluido el
# login—, assets, sesión y la propia página de aviso.
_ALWAYS_PASS = (
    "/api/",
    "/assets/",
    "/socket.io",
    "/.well-known/",
    "/login",
    "/logout",
    "/update-password",
    "/message",
    BLOCKED_PATH,
)

# Además, en modo "facex": descargas, impresión y 2FA que usan las pantallas.
_FACEX_PASS = _ALWAYS_PASS + (
    "/files/",
    "/private/files/",
    "/printview",
    "/printpreview",
    "/qrcode",
)

# Documentos sin pantalla FacEx propia que se muestran en /printview (solo
# lectura) cuando un enlace de FacEx los abre. Cualquier otro → página de inicio.
_PRINTVIEW_DOCTYPES = {"Payment Entry", "Stock Entry", "Quotation", "Delivery Note"}

_LOG = "facex_nav_guard"


# ---------------------------------------------------------------------------
# Regla
# ---------------------------------------------------------------------------

def nav_mode(user: str = None):
    """None (libre), MODE_FACEX o MODE_BLOCKED — cacheado por petición."""
    user = user or frappe.session.user
    if not user or user in ("Guest", "Administrator"):
        return None
    cache = getattr(frappe.local, "facex_nav_mode", None)
    if cache is None:
        cache = frappe.local.facex_nav_mode = {}
    if user not in cache:
        cache[user] = _compute_mode(user)
    return cache[user]


def is_restricted(user: str = None) -> bool:
    return nav_mode(user) is not None


def _compute_mode(user: str):
    if frappe.db.get_value("User", user, "user_type") != "System User":
        return None  # usuarios del portal: no usan el Desk
    if "System Manager" in frappe.get_roles(user):
        return None
    if not frappe.get_meta("FacEx Settings").has_field(FIELD):
        return None  # código desplegado antes del migrate
    values = frappe.get_all("FacEx Settings", filters={"user": user}, pluck=FIELD)
    if not values:
        return MODE_BLOCKED  # contar con fila de FacEx Settings es obligatorio
    return None if any(cint(v) for v in values) else MODE_FACEX


def home_path(mode: str = MODE_FACEX) -> str:
    """A dónde mandar al usuario en sesión: aviso si está bloqueado; si no, la
    página de inicio de su compañía efectiva."""
    if mode == MODE_BLOCKED:
        return BLOCKED_PATH
    page = None
    try:
        from facex_multi.api.invoice import get_effective_company

        company = get_effective_company()
        if company and frappe.db.table_exists(CONFIG_DOCTYPE) and frappe.get_meta(CONFIG_DOCTYPE).has_field(CONFIG_FIELD):
            page = frappe.db.get_value(CONFIG_DOCTYPE, company, CONFIG_FIELD)
    except Exception:
        frappe.logger(_LOG).exception("home_path")
    if page not in ALLOWED_PAGES:
        page = DEFAULT_PAGE
    return f"/desk/{page}"


def _desk_sub_path(path: str):
    """['facex'] para /desk/facex o /app/facex; None si no es ruta del Desk."""
    segs = [s for s in (path or "").split("/") if s]
    if segs and segs[0] in ("desk", "app"):
        return segs[1:]
    return None


def _page_url(page: str, **params) -> str:
    return f"/desk/{page}?{urlencode(params)}"


def _doctype_from_slug(slug: str):
    rows = frappe.db.sql(
        "SELECT name FROM `tabDocType` WHERE istable = 0 AND REPLACE(LOWER(name), ' ', '-') = %s LIMIT 1",
        slug,
    )
    return rows[0][0] if rows else None


def _doc_target(slug: str, name: str):
    """Equivalente FacEx de /desk/<doctype>/<name>, o None."""
    doctype = _doctype_from_slug(slug)
    if not doctype or not frappe.db.exists(doctype, name):
        return None
    if doctype == "Sales Invoice":
        return _page_url("facex", invoice=name)
    if doctype == "Purchase Order":
        return _page_url("facex-compras", orden=name)
    if doctype in ("Purchase Receipt", "Purchase Invoice"):
        is_return = cint(frappe.db.get_value(doctype, name, "is_return"))
        param = {
            ("Purchase Receipt", 0): "entrada",
            ("Purchase Receipt", 1): "devolucion",
            ("Purchase Invoice", 0): "factura",
            ("Purchase Invoice", 1): "nota",
        }[(doctype, is_return)]
        return _page_url("facex-compras", **{param: name})
    if doctype == "Payment Entry":
        pe = frappe.db.get_value(doctype, name, ["payment_type", "party_type"], as_dict=True)
        if pe.payment_type == "Pay" and pe.party_type == "Supplier":
            return _page_url("facex-pagos", pago=name)
    if doctype in _PRINTVIEW_DOCTYPES:
        return "/printview?" + urlencode({"doctype": doctype, "name": name})
    return None


def _is_root_static(path: str) -> bool:
    """/facex-sw.js, /favicon.ico, /robots.txt… (archivo en la raíz)."""
    segs = [s for s in path.split("/") if s]
    return len(segs) == 1 and "." in segs[0]


def resolve_path(path: str, mode: str = MODE_FACEX):
    """None si un usuario en `mode` puede abrir `path`; si no, la URL a la
    que hay que mandarlo."""
    path = path or "/"
    if mode == MODE_BLOCKED:
        if path.startswith(_ALWAYS_PASS) or _is_root_static(path):
            return None
        return BLOCKED_PATH

    sub = _desk_sub_path(path)
    if sub is not None:
        if sub and sub[0] in ALLOWED_PAGES:
            return None
        if len(sub) >= 2 and sub[1] not in ("view", "new"):
            target = _doc_target(sub[0], sub[1])
            if target:
                return target
        return home_path(mode)
    if path.startswith(_FACEX_PASS) or _is_root_static(path):
        return None
    return home_path(mode)


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------

def before_request():
    target = None
    try:
        request = frappe.request
        if request.method not in ("GET", "HEAD"):
            return
        path = request.path or "/"
        # Atajo sin tocar la BD: API (y con ella el login), assets, sesión.
        if path.startswith(_ALWAYS_PASS):
            return
        session = getattr(frappe.local, "session", None)
        user = session and session.user
        if not user or user == "Guest":
            return
        mode = nav_mode(user)
        if mode:
            target = resolve_path(path, mode)
    except Exception:
        frappe.logger(_LOG).exception("before_request")
        return
    if target:
        from werkzeug.exceptions import HTTPException
        from werkzeug.utils import redirect

        raise HTTPException(response=redirect(target, 302))


def boot_session(bootinfo):
    """frappe.boot.facex_nav para nav_guard.js (solo usuarios restringidos)."""
    try:
        mode = nav_mode()
        if mode:
            bootinfo.facex_nav = {
                "restricted": 1,
                "home": home_path(mode),
                "pages": list(ALLOWED_PAGES) if mode == MODE_FACEX else [],
            }
    except Exception:
        frappe.logger(_LOG).exception("boot_session")


@frappe.whitelist()
def resolve_route(path: str = ""):
    """nav_guard.js: ruta del Desk bloqueada → a dónde ir. `restricted: 0`
    significa que el boot quedó viejo (ya se le permitió navegar)."""
    mode = nav_mode()
    if not mode:
        return {"restricted": 0}
    return {"restricted": 1, "target": resolve_path(path or "/desk", mode) or ""}


def clear_boot_cache(doc=None, method=None):
    """FacEx Settings on_update/on_trash: el boot del usuario se cachea en
    redis; sin esto el cambio del check no llega hasta el próximo clear-cache.
    FacEx Configuracion Compania: afecta a todos → se borra el de todos."""
    frappe.local.facex_nav_mode = None
    if doc is not None and doc.doctype == "FacEx Settings":
        if doc.get("user"):  # sin usuario = fila de compañía heredada: no aplica
            frappe.cache.hdel("bootinfo", doc.user)
    else:
        frappe.cache.delete_key("bootinfo")
