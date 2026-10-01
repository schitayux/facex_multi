"""
facex_multi.api.corte
---------------------
Corte por «Fecha de inicio de operación»: oculta en FacEx todo lo que se
registró ANTES de que la compañía saliera a producción, sin borrar un solo
registro.

Por qué existe
    Un sitio se usa semanas antes del arranque para capacitar y para cargar
    catálogos. Al salir a producción el cliente no quiere ver nada de esas
    pruebas en ninguna pantalla ni en ningún informe, pero tampoco se pueden
    borrar: cancelar una factura con `update_stock` DEVUELVE la mercadería al
    almacén, y el inventario es justamente el saldo con el que arranca.
    De ahí la regla: los documentos de venta y cobro se ocultan por fecha; los
    movimientos de inventario y las existencias NO se tocan nunca.

Qué se ve, con el corte activo
    1. Todo lo fechado en el día del corte o después.
    2. El historial de los usuarios declarados «historial visible» — p. ej. un
       vendedor que ya venía operando de verdad antes del arranque y cuya
       cartera sigue viva.
    3. Las facturas marcadas «Es Saldo Inicial» (`custom_es_saldo_inicial`):
       la carga de saldos de apertura, que es anterior al corte a propósito.
    Y los usuarios declarados «sin corte» (soporte) ven todo, siempre.

Dónde se aplica
    - Escritorio y acceso a un documento puntual: los hooks
      `permission_query_conditions` / `has_permission` de Sales Invoice y
      FacEx Cierre Diario (ver api.permissions y api.cierre). Abrir una factura
      anterior al corte da PermissionError, que es lo que debe pasar si alguien
      llega a ella por un enlace viejo.
    - Pantallas e informes de FacEx: cada consulta SQL agrega `get_corte_sql()`
      a su lista de condiciones. Son consultas crudas que no pasan por los
      hooks de permisos (y `frappe.get_all` tampoco), así que el corte va
      explícito en cada una.

Configuración (FacEx Configuracion Compania, una por compañía)
    fecha_inicio_operacion             Date       vacío = corte apagado
    corte_usuarios_historial_visible   Small Text un usuario por línea
    corte_usuarios_sin_restriccion     Small Text un usuario por línea
"""
from __future__ import annotations

import frappe
from frappe.utils import getdate

CONFIG_DOCTYPE = "FacEx Configuracion Compania"
CAMPO_FECHA = "fecha_inicio_operacion"
CAMPO_HISTORIAL_VISIBLE = "corte_usuarios_historial_visible"
CAMPO_SIN_RESTRICCION = "corte_usuarios_sin_restriccion"
CAMPO_SALDO_INICIAL = "custom_es_saldo_inicial"

_CAMPOS = (CAMPO_FECHA, CAMPO_HISTORIAL_VISIBLE, CAMPO_SIN_RESTRICCION)


def _parse_usuarios(valor) -> tuple:
    """Small Text con un usuario por línea → tupla normalizada. Tolera comas,
    espacios y líneas vacías para que un copiar/pegar no rompa el corte."""
    if not valor:
        return ()
    crudos = str(valor).replace(",", "\n").replace(";", "\n").splitlines()
    return tuple(sorted({u.strip() for u in crudos if u and u.strip()}))


def _usuario(user: str = None) -> str:
    """El usuario sobre el que se evalúa el corte. Los hooks de permisos de
    Frappe pueden preguntar por un usuario distinto al de la sesión."""
    return user or frappe.session.user


def _cache() -> dict:
    if not hasattr(frappe.local, "facex_corte_cache"):
        frappe.local.facex_corte_cache = {}
    return frappe.local.facex_corte_cache


def get_corte(company: str = None) -> dict:
    """Configuración del corte para `company`, resuelta y cacheada por request.

    Devuelve {"fecha": date|None, "visibles": (...), "sin_restriccion": (...)}.
    `fecha` en None = corte apagado (el caso de facex y disfavil, y de neko
    hasta que se configure la fecha): todas las funciones de abajo se vuelven
    no-ops y ninguna consulta cambia.
    """
    if not company:
        from facex_multi.api.invoice import get_effective_company
        company = get_effective_company()
    company = (company or "").strip()
    vacio = {"fecha": None, "visibles": (), "sin_restriccion": ()}
    if not company:
        return vacio

    cache = _cache()
    if company in cache:
        return cache[company]

    row = None
    # `has_field`: el código puede estar desplegado antes del migrate que crea
    # los campos — mismo criterio defensivo que get_facex_company_config.
    if frappe.db.table_exists(CONFIG_DOCTYPE):
        meta = frappe.get_meta(CONFIG_DOCTYPE)
        existentes = [f for f in _CAMPOS if meta.has_field(f)]
        if existentes:
            row = frappe.db.get_value(CONFIG_DOCTYPE, company, existentes, as_dict=True)

    resultado = vacio if not row else {
        "fecha": getdate(row.get(CAMPO_FECHA)) if row.get(CAMPO_FECHA) else None,
        "visibles": _parse_usuarios(row.get(CAMPO_HISTORIAL_VISIBLE)),
        "sin_restriccion": _parse_usuarios(row.get(CAMPO_SIN_RESTRICCION)),
    }
    cache[company] = resultado
    return resultado


def corte_activo(company: str = None, user: str = None) -> bool:
    """True si hay corte y el usuario SÍ está sujeto a él."""
    conf = get_corte(company)
    if not conf["fecha"]:
        return False
    return _usuario(user) not in conf["sin_restriccion"]


def get_corte_fecha(company: str = None, user: str = None):
    """La fecha de corte que aplica a ese usuario, o None."""
    return get_corte(company)["fecha"] if corte_activo(company, user) else None


def get_corte_sql(company: str = None, alias: str = None, date_col: str = "posting_date",
                  owner_col: str = "owner", saldo_inicial: bool = False,
                  param_prefix: str = "facex_corte", user: str = None) -> tuple:
    """(condicion_sql, params) para acotar una consulta al corte, o ("", {}) si
    no hay corte que aplicar.

    alias          tabla/alias tal como aparece en el FROM del caller
                   (None = columnas sin calificar).
    date_col       columna de fecha del documento (posting_date, fecha, ...).
    owner_col      columna que identifica al usuario dueño del dato; en
                   FacEx Cierre Diario `owner` y `usuario` coinciden.
    saldo_inicial  True SOLO en Sales Invoice, el único doctype con el campo
                   «Es Saldo Inicial».
    param_prefix   distingue los parámetros si una consulta combina varias
                   condiciones de corte.
    """
    conf = get_corte(company)
    if not conf["fecha"] or _usuario(user) in conf["sin_restriccion"]:
        return "", {}

    pre = f"{alias}." if alias else ""
    k_fecha = f"{param_prefix}_fecha"
    partes = [f"{pre}{date_col} >= %({k_fecha})s"]
    params = {k_fecha: conf["fecha"]}

    if conf["visibles"] and owner_col:
        k_vis = f"{param_prefix}_visibles"
        partes.append(f"{pre}{owner_col} IN %({k_vis})s")
        params[k_vis] = conf["visibles"]

    if saldo_inicial:
        partes.append(f"COALESCE({pre}{CAMPO_SALDO_INICIAL}, 0) = 1")

    return "(" + " OR ".join(partes) + ")", params


def invoice_corte_sql(company: str = None, alias: str = None,
                      param_prefix: str = "facex_corte", user: str = None) -> tuple:
    """get_corte_sql con los valores propios de Sales Invoice."""
    return get_corte_sql(company, alias=alias, date_col="posting_date",
                         owner_col="owner", saldo_inicial=True,
                         param_prefix=param_prefix, user=user)


def invoice_corte_companies_sql(companies, alias: str = "si") -> tuple:
    """Igual que invoice_corte_sql para una consulta sobre VARIAS compañías
    (los informes de transporte, que son multi-compañía): (compañía AND su
    corte) OR ... Devuelve ("", {}) si ninguna tiene corte configurado — misma
    forma que get_facex_companies_sales_scope_sql."""
    partes, params, hay_corte = [], {}, False
    for i, company in enumerate(companies or []):
        cond, p = invoice_corte_sql(company, alias=alias, param_prefix=f"facex_corte{i}")
        hay_corte = hay_corte or bool(cond)
        clave = f"facex_corte{i}_co"
        params[clave] = company
        params.update(p)
        partes.append(f"({alias}.company = %({clave})s AND {cond})" if cond
                      else f"{alias}.company = %({clave})s")
    if not hay_corte:
        return "", {}
    return "(" + " OR ".join(partes) + ")", params


def invoice_corte_filters(company: str = None, user: str = None) -> list:
    """Filtros estilo `frappe.get_all` para Sales Invoice. Se usa donde la
    consulta no es SQL crudo. OJO: `get_all` no pasa por los hooks de
    permisos, así que ahí el corte tiene que ir en los filtros.

    No puede expresar el OR completo (owner visible / saldo inicial) con el
    dict de filtros, así que devuelve la forma `or_filters`: el caller la
    aplica como tal.
    """
    conf = get_corte(company)
    if not conf["fecha"] or _usuario(user) in conf["sin_restriccion"]:
        return []
    ors = [["posting_date", ">=", conf["fecha"]], [CAMPO_SALDO_INICIAL, "=", 1]]
    if conf["visibles"]:
        ors.append(["owner", "in", list(conf["visibles"])])
    return ors


def invoice_visible(name: str = None, doc=None, company: str = None, user: str = None) -> bool:
    """¿Esta factura es consultable con el corte puesto? `doc` si ya se tiene
    cargada (evita el viaje a la base), `name` si no."""
    if doc is None and not name:
        return True
    datos = doc if doc is not None else frappe.db.get_value(
        "Sales Invoice", name, ["posting_date", "owner", "company"], as_dict=True
    )
    if not datos:
        return True
    conf = get_corte(company or datos.get("company"))
    if not conf["fecha"] or _usuario(user) in conf["sin_restriccion"]:
        return True
    if datos.get("owner") in conf["visibles"]:
        return True
    # El campo puede no existir todavía (código antes del migrate).
    if doc is not None:
        if int(getattr(doc, CAMPO_SALDO_INICIAL, 0) or 0):
            return True
    elif frappe.get_meta("Sales Invoice").has_field(CAMPO_SALDO_INICIAL):
        if int(frappe.db.get_value("Sales Invoice", name, CAMPO_SALDO_INICIAL) or 0):
            return True
    fecha = datos.get("posting_date")
    return bool(fecha) and getdate(fecha) >= conf["fecha"]


def assert_invoice_visible(name: str = None, doc=None, company: str = None,
                           user: str = None) -> None:
    """PermissionError con el mensaje que ve el usuario cuando intenta llegar a
    una factura anterior al corte (enlace viejo, guía, liquidación, número
    escrito a mano)."""
    if invoice_visible(name=name, doc=doc, company=company, user=user):
        return
    etiqueta = (doc.name if doc is not None else name) or ""
    conf = get_corte(company or (doc.company if doc is not None else None))
    frappe.throw(
        "La factura <b>{0}</b> es anterior al inicio de operación ({1}) y ya no "
        "puede consultarse.".format(
            frappe.utils.escape_html(etiqueta), frappe.utils.formatdate(conf["fecha"])
        ),
        frappe.PermissionError,
        title="Documento fuera del período",
    )


def liquidacion_query_conditions(user: str = None) -> str:
    """Hook permission_query_conditions para FacEx Liquidacion Transportista.
    La pantalla de Transporte las lista con `frappe.db.get_list`, que sí pasa
    por aquí, así que el corte por inicio de operación cubre a la vez la
    pantalla de FacEx y el escritorio."""
    conf = get_corte()
    if not conf["fecha"] or _usuario(user) in conf["sin_restriccion"]:
        return ""
    dt = "FacEx Liquidacion Transportista"
    partes = [f"`tab{dt}`.fecha >= {frappe.db.escape(str(conf['fecha']))}"]
    if conf["visibles"]:
        lista = ", ".join(frappe.db.escape(u) for u in conf["visibles"])
        partes.append(f"`tab{dt}`.owner IN ({lista})")
    return "(" + " OR ".join(partes) + ")"


def liquidacion_has_permission(doc, user: str = None, ptype: str = None) -> bool:
    """Hook has_permission: una liquidación anterior al corte no se abre."""
    if ptype in ("create", "select"):
        return True
    conf = get_corte(getattr(doc, "cliente", None))
    if not conf["fecha"] or _usuario(user) in conf["sin_restriccion"]:
        return True
    if getattr(doc, "owner", None) in conf["visibles"]:
        return True
    fecha = getattr(doc, "fecha", None)
    return bool(fecha) and getdate(fecha) >= conf["fecha"]


def ensure_corte_fields():
    """after_migrate: campo «Es Saldo Inicial» en Sales Invoice.

    Marca técnica: la pone la carga de saldos de apertura, no el usuario — de
    ahí read_only. Las facturas que la llevan se siguen viendo aunque su fecha
    sea anterior al corte.
    """
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    create_custom_fields(
        {
            "Sales Invoice": [
                {
                    "fieldname": CAMPO_SALDO_INICIAL,
                    "label": "Es Saldo Inicial",
                    "fieldtype": "Check",
                    "insert_after": "is_return",
                    "default": "0",
                    "read_only": 1,
                    "no_copy": 1,
                    "print_hide": 1,
                    "allow_on_submit": 1,
                    "description": "Factura de carga de saldos de apertura. Las marcadas aquí "
                                   "se muestran siempre, aunque su fecha sea anterior a la "
                                   "«Fecha de inicio de operación» de la compañía.",
                },
            ],
        },
        ignore_validate=True,
    )
