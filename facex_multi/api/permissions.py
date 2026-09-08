"""
facex_multi.api.permissions
----------------------------
Permisos por usuario+compañía para el page FacEx.
Sin registro en FacEx Settings → acceso total (retrocompatible).
System Manager → siempre acceso total.
"""
from __future__ import annotations
import frappe

_ALL_PERM_FIELDS = [
    "puede_ver_tablero", "puede_facturar",
    "puede_guardar", "puede_validar", "puede_certificar",
    "puede_compras", "puede_validar_compras", "puede_cancelar_compras",
    "crea_clientes", "modifica_clientes",
    "crea_proveedores", "modifica_proveedores",
    "crea_items", "modifica_items", "actualiza_precios",
    "gestiona_listas_materiales", "asignacion_precios",
    "reporte_ventas_fecha", "reporte_ventas_producto",
    "reporte_facturas_canceladas", "reporte_estados_cuenta",
    "reporte_antiguedad_saldos", "reporte_cotizaciones",
    "reporte_recibos_pagos", "reporte_crecimiento_ventas",
    "reporte_imprimir_recibo", "reporte_analisis_utilidad",
]

def _full_access() -> dict:
    return {f: 1 for f in _ALL_PERM_FIELDS}


def get_facex_permissions_for_company(company: str) -> dict:
    """
    Retorna el dict de permisos para frappe.session.user + company.
    Llamado internamente desde get_defaults — no whitelist propio.
    """
    if not company:
        return _full_access()

    # System Manager siempre tiene acceso total
    if "System Manager" in frappe.get_roles():
        return _full_access()

    row = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        _ALL_PERM_FIELDS,
        as_dict=True,
    )

    if not row:
        # Sin registro configurado → acceso total
        return _full_access()

    # Convertir a int explícito (los Check vienen como 0/1 desde DB)
    return {k: int(row.get(k) or 0) for k in _ALL_PERM_FIELDS}


def require_facex_permission(company: str, *flags: str, msg: str = None) -> None:
    """Exige uno o más flags de _ALL_PERM_FIELDS para frappe.session.user + company.

    Retrocompatible con el resto de este archivo: sin fila de FacEx Settings o
    System Manager → get_facex_permissions_for_company devuelve acceso total y
    la comprobación pasa. Sólo un usuario configurado con el flag en 0 recibe
    PermissionError. Pensado para blindar los @frappe.whitelist() que hasta
    ahora sólo ocultaban el botón en el front (puede_facturar, puede_guardar,
    puede_validar, puede_compras, crea_clientes, actualiza_precios, …).
    """
    from facex_multi.api.invoice import get_effective_company

    perms = get_facex_permissions_for_company(get_effective_company(company))
    if any(not perms.get(f) for f in flags):
        frappe.throw(
            msg or "No tiene permiso para realizar esta acción en FacEx.",
            frappe.PermissionError,
        )


_COMPANY_CONFIG_FIELDS = [
    "maneja_series", "maneja_adendas", "concatena_descripcion2",
    "maneja_inventario", "tipo_x_defecto",
    "mostrar_almacen", "mostrar_desc_pct", "mostrar_adenda", "mostrar_tipo",
    "exige_pago_completo", "permite_pago_credito", "permite_pago_contra_entrega",
]
# Campos texto (Select/Data) — no convertir a int
_CONFIG_TEXT_FIELDS = {"tipo_x_defecto"}
# Check fields que están ON por defecto cuando no hay config
_CONFIG_DEFAULT_ON = {"mostrar_almacen", "mostrar_desc_pct", "mostrar_adenda", "mostrar_tipo"}


def _config_default() -> dict:
    result = {}
    for k in _COMPANY_CONFIG_FIELDS:
        if k in _CONFIG_TEXT_FIELDS:
            result[k] = ""
        elif k in _CONFIG_DEFAULT_ON:
            result[k] = 1
        else:
            result[k] = 0
    return result


def get_facex_default_warehouse(company: str) -> str:
    """
    Bodega por defecto del usuario en FacEx Screen (campo bodega_por_defecto,
    registro user+company). System Manager y usuarios sin registro/valor
    configurado devuelven "" — sin restricción, se ven todos los productos.
    """
    if "System Manager" in frappe.get_roles():
        return ""
    if not company:
        return ""
    return frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "bodega_por_defecto",
    ) or ""


def get_facex_allowed_warehouses(company: str):
    """
    Lista de bodegas habilitadas para frappe.session.user + company (grid
    bodegas_habilitadas de FacEx Settings). Retorna None cuando NO hay
    restricción — System Manager, sin fila de FacEx Settings, o fila con el
    grid vacío — en cuyo caso el caller debe tratarlo como "todas las
    bodegas de la compañía" (retrocompatible, igual criterio que el resto
    de permisos de este archivo). Retorna una lista (posiblemente vacía solo
    si la compañía no aplica) cuando sí hay restricción configurada.
    """
    if "System Manager" in frappe.get_roles():
        return None
    if not company:
        return None

    settings_name = frappe.db.get_value(
        "FacEx Settings", {"user": frappe.session.user, "bfel_company": company}, "name"
    )
    if not settings_name:
        return None

    warehouses = frappe.get_all(
        "FacEx Settings Bodega",
        filters={"parent": settings_name, "parenttype": "FacEx Settings"},
        pluck="warehouse",
    )
    return warehouses or None


def get_facex_default_sales_partner(company: str) -> str:
    """
    Socio de Venta por defecto del usuario en FacEx/FacEx Screen (campo
    socio_venta_por_defecto). Vacío si no hay registro/valor configurado.
    """
    if not company:
        return ""
    return frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "socio_venta_por_defecto",
    ) or ""


# ---------------------------------------------------------------------------
# Editar precio manualmente en venta (FacEx Screen y Clásico)
# ---------------------------------------------------------------------------
# Deny-by-default: sin fila de FacEx Settings o con puede_editar_precio=0 el
# usuario NO puede sobrescribir el precio unitario — se factura siempre con el
# precio de la lista. A diferencia del resto de _ALL_PERM_FIELDS (acceso total
# cuando no hay config), aquí "sin config → sin permiso".

def get_facex_can_edit_price(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_editar_precio",
    )
    return bool(int(value or 0))


# ---------------------------------------------------------------------------
# Listas de Precios habilitadas / por defecto (FacEx Screen y Clásico)
# ---------------------------------------------------------------------------
# Mismo criterio retrocompatible que las bodegas: None = sin restricción
# (System Manager, sin fila de FacEx Settings, o grid vacío) → el caller debe
# tratarlo como "todas las listas de venta de la compañía".

def get_facex_allowed_price_lists(company: str):
    if "System Manager" in frappe.get_roles():
        return None
    if not company:
        return None

    settings_name = frappe.db.get_value(
        "FacEx Settings", {"user": frappe.session.user, "bfel_company": company}, "name"
    )
    if not settings_name:
        return None

    price_lists = frappe.get_all(
        "FacEx Settings Lista Precios",
        filters={"parent": settings_name, "parenttype": "FacEx Settings"},
        pluck="price_list",
    )
    return price_lists or None


def get_facex_default_price_list(company: str) -> str:
    """
    Lista de precios por defecto del usuario (campo lista_precios_por_defecto).
    Se usa SOLO cuando el cliente no tiene una lista asignada en su ficha —
    la del cliente siempre tiene prioridad. Vacío si no hay valor configurado.
    """
    if not company:
        return ""
    return frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "lista_precios_por_defecto",
    ) or ""


# ---------------------------------------------------------------------------
# Segregación de clientes por Socio de Ventas
# ---------------------------------------------------------------------------
# Si el usuario tiene socio_venta_por_defecto asignado en FacEx Settings, solo
# puede ver/usar los clientes de ese socio (Customer.default_sales_partner).
# Vacío/null en TODAS sus filas → sin restricción (ve todos y elige cualquiera).
# System Manager → sin restricción siempre.

def get_facex_user_sales_partner(company: str = None, user: str = None) -> str:
    """
    Socio de Ventas al que está limitado `user` (por defecto la sesión activa).
    Si `company` viene dado, mira solo esa fila; si no, mira todas las filas de
    FacEx Settings del usuario y devuelve el valor solo si es único y no vacío
    (evita ambigüedad cuando el usuario opera en varias compañías con socios
    distintos).
    """
    user = user or frappe.session.user
    if user in ("Administrator", "Guest"):
        return ""
    if "System Manager" in frappe.get_roles(user):
        return ""

    filters = {"user": user}
    if company:
        filters["bfel_company"] = company
        return frappe.db.get_value("FacEx Settings", filters, "socio_venta_por_defecto") or ""

    valores = {
        v for v in frappe.get_all(
            "FacEx Settings", filters=filters, pluck="socio_venta_por_defecto"
        ) if v
    }
    return valores.pop() if len(valores) == 1 else ""


def get_facex_customer_partner_sql(company: str = None, alias: str = "tabCustomer"):
    """
    Devuelve (condicion_sql, params) para acotar una consulta de Customer al
    socio de ventas del usuario, o ("", {}) si no hay restricción. `alias` es
    el nombre de tabla/alias tal como aparece en el FROM del caller.
    El cliente mostrador (Consumidor Final) queda siempre visible.
    """
    sp = get_facex_user_sales_partner(company)
    if not sp:
        return "", {}
    cond = (
        f"(`{alias}`.default_sales_partner = %(facex_sp)s "
        f"OR `{alias}`.customer_name = 'Consumidor Final')"
    )
    return cond, {"facex_sp": sp}


def get_facex_invoice_partner_sql(company: str = None, alias: str = "tabSales Invoice"):
    """
    Devuelve (condicion_sql, params) para acotar una consulta de Sales Invoice
    (o Quotation, Delivery Note, etc. — cualquier doctype con campo
    sales_partner) al socio de ventas del usuario, o ("", {}) si no hay
    restricción. `alias` = tabla/alias tal como aparece en el FROM del caller.
    Cubre reportes, historial, KPIs y transporte de FacEx (consultas SQL crudas
    que no pasan por permission_query_conditions).
    """
    sp = get_facex_user_sales_partner(company)
    if not sp:
        return "", {}
    return f"`{alias}`.sales_partner = %(facex_inv_sp)s", {"facex_inv_sp": sp}


def sales_invoice_query_conditions(user: str = None) -> str:
    """Hook permission_query_conditions para Sales Invoice (escritorio, report
    view, links). Un usuario limitado a un socio de ventas solo ve las facturas
    de ese socio."""
    sp = get_facex_user_sales_partner(user=user)
    if not sp:
        return ""
    return f"`tabSales Invoice`.sales_partner = {frappe.db.escape(sp)}"


def sales_invoice_has_permission(doc, user: str = None, ptype: str = None) -> bool:
    if ptype in ("create", "select"):
        return True
    sp = get_facex_user_sales_partner(user=user)
    if not sp:
        return True
    return (getattr(doc, "sales_partner", "") or "") == sp


def customer_query_conditions(user: str = None) -> str:
    """Hook permission_query_conditions para Customer (escritorio, reportes,
    link de Cliente en Factura)."""
    sp = get_facex_user_sales_partner(user=user)
    if not sp:
        return ""
    sp_esc = frappe.db.escape(sp)
    return (
        f"(`tabCustomer`.default_sales_partner = {sp_esc} "
        f"OR `tabCustomer`.customer_name = 'Consumidor Final')"
    )


def customer_has_permission(doc, user: str = None, ptype: str = None) -> bool:
    """Hook has_permission para Customer — mismo criterio que
    customer_query_conditions para el acceso a un cliente puntual."""
    if ptype in ("create", "select"):
        return True
    sp = get_facex_user_sales_partner(user=user)
    if not sp:
        return True
    if getattr(doc, "customer_name", "") == "Consumidor Final":
        return True
    return (getattr(doc, "default_sales_partner", "") or "") == sp


def get_facex_company_config(company: str) -> dict:
    """
    Retorna la configuración DIGECAM/Inventario a nivel de compañía (registro con user='').
    Si no existe, devuelve defaults (columnas visibles ON, resto OFF).
    """
    if not company:
        return _config_default()
    row = frappe.db.get_value(
        "FacEx Settings",
        {"bfel_company": company, "user": ["is", "not set"]},
        _COMPANY_CONFIG_FIELDS,
        as_dict=True,
    )
    if not row:
        return _config_default()
    result = {}
    for k in _COMPANY_CONFIG_FIELDS:
        v = row.get(k)
        if k in _CONFIG_TEXT_FIELDS:
            result[k] = str(v or "")
        elif k in _CONFIG_DEFAULT_ON:
            result[k] = int(v) if v is not None else 1
        else:
            result[k] = int(v or 0)
    return result


# ---------------------------------------------------------------------------
# Módulo de Inventario (Entradas / Salidas / Transferencias / Reportes)
# ---------------------------------------------------------------------------
# A diferencia de _ALL_PERM_FIELDS (Ventas/Compras), aquí NO hay acceso total
# por defecto. Sin fila de FacEx Settings para el usuario+compañía → sin
# acceso. Es una decisión deliberada: el módulo de inventario mueve stock,
# no debe quedar expuesto a usuarios que nunca fueron configurados para él.

_INVENTORY_PERM_FIELDS = [
    "puede_ver_inventario",
    "puede_hacer_entradas",
    "puede_hacer_salidas",
    "puede_hacer_transferencias",
    "puede_cancelar_movimientos",
    "puede_hacer_transformaciones",
    "reporte_inv_kardex",
    "reporte_inv_existencias",
    "reporte_inv_trazabilidad",
    "reporte_inv_kardex_producto",
    "reporte_inv_valuacion",
    "reporte_inv_vencimientos",
    "reporte_inv_rotacion",
    "reporte_inv_entradas_proveedor",
    "mantiene_costos_items",
    "mantiene_almacenes",
    "puede_recibir_traslados",
    "entrada_grabar_borrador", "entrada_validar_confirmar",
    "salida_grabar_borrador", "salida_validar_confirmar",
    "transferencia_grabar_borrador", "transferencia_validar_confirmar",
]


# ---------------------------------------------------------------------------
# Grabar Borrador / Validar y Confirmar por operación (Entrada/Salida/Transferencia)
# ---------------------------------------------------------------------------
# `puede_hacer_<op>` queda como legacy: por sí solo = "acceso + validación
# directa". Si el admin marca alguna de las casillas nuevas, esas mandan.

MOV_FLAGS = {
    "in":       ("puede_hacer_entradas",       "entrada_grabar_borrador",       "entrada_validar_confirmar"),
    "out":      ("puede_hacer_salidas",        "salida_grabar_borrador",        "salida_validar_confirmar"),
    "transfer": ("puede_hacer_transferencias", "transferencia_grabar_borrador", "transferencia_validar_confirmar"),
}


def movement_gate(perms: dict, mode: str) -> dict:
    """A partir del dict de get_facex_inventory_permissions, resuelve para `mode`:
    can_access (¿ve la operación?), can_draft (¿graba borrador?), can_submit
    (¿valida/somete?)."""
    legacy_f, draft_f, submit_f = MOV_FLAGS[mode]
    legacy_v = bool(perms.get(legacy_f))
    draft_v = bool(perms.get(draft_f))
    submit_v = bool(perms.get(submit_f))
    has_new = draft_v or submit_v
    return {
        "can_access": legacy_v or has_new,
        "can_draft": draft_v,
        "can_submit": submit_v or (legacy_v and not has_new),
    }


def _inventory_no_access() -> dict:
    return {f: 0 for f in _INVENTORY_PERM_FIELDS}


def _inventory_full_access() -> dict:
    return {f: 1 for f in _INVENTORY_PERM_FIELDS}


def get_facex_inventory_permissions(company: str) -> dict:
    """
    Retorna el dict de permisos de inventario para frappe.session.user + company.
    Deny-by-default: sin fila configurada → sin acceso (salvo System Manager).
    """
    if "System Manager" in frappe.get_roles():
        return _inventory_full_access()

    if not company:
        return _inventory_no_access()

    row = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        _INVENTORY_PERM_FIELDS,
        as_dict=True,
    )

    if not row:
        return _inventory_no_access()

    return {k: int(row.get(k) or 0) for k in _INVENTORY_PERM_FIELDS}


# ---------------------------------------------------------------------------
# Ver Costos y Valores de Inventario (reportes, grids de Entradas/Salidas,
# flotante de existencia y pantallas nuevas del módulo de Inventario)
# ---------------------------------------------------------------------------
# Deny-by-default: información sensible. Sin fila de FacEx Settings o con
# puede_ver_costos=0 el usuario NO ve ningún costo/valor dentro del módulo de
# Inventario — ni en pantalla, ni al imprimir, ni al exportar. NO afecta el
# Análisis de Utilidad / Asignación de Precios de FacEx Clásico (permisos aparte).

def get_facex_can_view_costs(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_costos",
    )
    return bool(int(value or 0))


_COST_BASES = ("estandar", "ponderado", "ultima_compra")


def get_facex_default_cost_basis(company: str) -> str:
    """Base de costo por defecto del usuario para las Entradas de Inventario
    (campo costo_entrada_por_defecto). Cae a 'estandar' si no hay valor o es
    desconocido."""
    if not company:
        return "estandar"
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "costo_entrada_por_defecto",
    )
    return value if value in _COST_BASES else "estandar"


def get_facex_can_maintain_item_costs(company: str) -> bool:
    """Pantalla «Costos a Ítems». Deny-by-default."""
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "mantiene_costos_items",
    )
    return bool(int(value or 0))


def get_facex_can_receive_traslados(company: str) -> bool:
    """Pantalla «Recepción de Traslados». Deny-by-default."""
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_recibir_traslados",
    )
    return bool(int(value or 0))


def get_facex_transito_warehouse(company: str) -> str:
    """Almacén de tránsito del usuario (campo transito_por_defecto). Vacío si no
    hay valor configurado."""
    if not company:
        return ""
    return frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "transito_por_defecto",
    ) or ""


def get_facex_can_maintain_warehouses(company: str) -> bool:
    """Pantalla «Almacenes». Deny-by-default y además exige acceso a TODAS las
    bodegas de la compañía — un usuario con bodegas_habilitadas restringidas no
    puede administrar el árbol de almacenes."""
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "mantiene_almacenes",
    )
    if not bool(int(value or 0)):
        return False
    return get_facex_allowed_warehouses(company) is None


# ---------------------------------------------------------------------------
# Eliminar Ventas en Espera (FacEx Screen)
# ---------------------------------------------------------------------------
# Deny-by-default igual que el módulo de Inventario: es una acción destructiva
# e irreversible (borra el documento), así que un usuario sin fila configurada
# en FacEx Settings NO la tiene, a diferencia de _ALL_PERM_FIELDS.

def get_facex_can_delete_held_sales(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_eliminar_ventas_espera",
    )
    return bool(int(value or 0))


# ---------------------------------------------------------------------------
# Anular/Cancelar facturas desde FacEx Screen (FEL o interna)
# ---------------------------------------------------------------------------
# Deny-by-default: es una acción destructiva/irreversible (anula ante la SAT
# o revierte contabilidad e inventario), así que un usuario sin fila
# configurada en FacEx Settings NO la tiene.

def get_facex_can_cancel_invoices(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_anular_facturas",
    )
    return bool(int(value or 0))


# ---------------------------------------------------------------------------
# Botón "POS" en el menú del page FacEx (redirige a FacEx Screen)
# ---------------------------------------------------------------------------
# Deny-by-default: el botón nuevo no debe aparecer para nadie hasta que se
# habilite explícitamente por usuario+compañía en FacEx Settings.

def get_facex_can_access_pos(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_pos",
    )
    return bool(int(value or 0))


# ---------------------------------------------------------------------------
# Botón "Inventario" en el menú del page FacEx (redirige a FacEx Inventario)
# ---------------------------------------------------------------------------
# Deny-by-default, igual que el botón POS. Deliberadamente separado de
# get_facex_inventory_permissions/puede_ver_inventario: aquél gobierna el
# acceso a las operaciones dentro del módulo de Inventario, este solo la
# visibilidad del atajo en el menú de FacEx — un admin puede querer otorgar
# uno sin el otro.

def get_facex_can_access_inventory_menu(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_menu_inventario",
    )
    return bool(int(value or 0))


# Roles que ya tienen acceso al page FacEx (ver facex_inventario.json > roles).
# Stock Entry, por defecto en ERPNext, solo lo tienen "Stock User"/"Stock Manager" —
# aquí se les otorga el permiso nativo para que el motor de ERPNext los valide de
# forma normal (create/write/submit/cancel). El filtro fino de QUÉ compañía y QUÉ
# acción (entrada/salida/transferencia) sigue resuelto por FacEx Settings arriba;
# esto solo abre la puerta a nivel de DocType, como ya ocurre con Sales Invoice.
STOCK_ENTRY_ROLES = [
    "Sales User", "Accounts User", "Sales Manager",
    "Accounts Manager", "System Manager", "facex_multi",
]


def ensure_stock_entry_permissions():
    """
    Idempotente: otorga permiso nativo de Stock Entry (read/write/create/
    submit/cancel/report/print) a los roles que ya usa FacEx, si no lo tienen.
    Se llama desde after_migrate (hooks.py) para que sobreviva a futuros
    `bench migrate` sin depender de que alguien lo corra a mano.
    """
    for role in STOCK_ENTRY_ROLES:
        if frappe.db.exists("Custom DocPerm", {"parent": "Stock Entry", "role": role}):
            continue
        frappe.get_doc({
            "doctype": "Custom DocPerm",
            "parent": "Stock Entry",
            "parenttype": "DocType",
            "parentfield": "permissions",
            "role": role,
            "permlevel": 0,
            "read": 1,
            "write": 1,
            "create": 1,
            "submit": 1,
            "cancel": 1,
            "delete": 0,
            "report": 1,
            "export": 0,
            "print": 1,
            "email": 0,
            "share": 0,
        }).insert(ignore_permissions=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="Stock Entry")


# ---------------------------------------------------------------------------
# Series de numeración por tipo de movimiento (Entradas/Salidas/Transferencias)
# ---------------------------------------------------------------------------
# ".ABBR." ya lo resuelve ERPNext de forma nativa (erpnext.hooks.naming_series_variables
# -> parse_naming_series_variable), para cualquier doctype con campo "company".
# No hay que reimplementar esa lógica: solo declarar las series como opciones
# válidas del campo naming_series de Stock Entry.

STOCK_ENTRY_NAMING_SERIES = [
    "MAT-STE-.YYYY.-",   # serie nativa de ERPNext — no se retira, la siguen usando Repack/Manufacture/etc.
    "ING-.ABBR.-.####",  # Entradas
    "SAL-.ABBR.-.####",  # Salidas (fase futura)
    "TRA-.ABBR.-.####",  # Transferencias (fase futura)
    "TRF-.ABBR.-.####",  # Transformaciones (Listas de Materiales, modo Padre)
]


def ensure_stock_entry_naming_series():
    """Idempotente: agrega ING-/SAL-/TRA- a las opciones de Stock Entry.naming_series
    vía Property Setter, sin quitar la serie nativa. Se llama desde after_migrate."""
    from frappe.custom.doctype.property_setter.property_setter import make_property_setter

    meta_options = frappe.get_meta("Stock Entry").get_field("naming_series").options or ""
    current_options = [o.strip() for o in meta_options.split("\n") if o.strip()]
    missing = [o for o in STOCK_ENTRY_NAMING_SERIES if o not in current_options]
    if not missing:
        return

    new_value = "\n".join(current_options + missing)
    existing_name = frappe.db.get_value(
        "Property Setter",
        {"doc_type": "Stock Entry", "field_name": "naming_series", "property": "options"},
    )
    if existing_name:
        frappe.db.set_value("Property Setter", existing_name, "value", new_value)
    else:
        make_property_setter("Stock Entry", "naming_series", "options", new_value, "Text")

    frappe.db.commit()
    frappe.clear_cache(doctype="Stock Entry")


# ---------------------------------------------------------------------------
# Sucursal (BFEL Establecimiento) por Almacén
# ---------------------------------------------------------------------------
# No existía ninguna relación entre Almacén y BFEL Establecimientos (esa tabla
# solo se usaba para series fiscales de facturación). La agregamos aquí como
# campo simple (igual convención que bfel_establecimiento en Sales/Purchase
# Invoice: Data guardando el establecimiento_id, no un Link).

def ensure_warehouse_establecimiento_field():
    """Idempotente: agrega el campo bfel_establecimiento a Warehouse si no existe."""
    if frappe.db.exists("Custom Field", "Warehouse-bfel_establecimiento"):
        return
    frappe.get_doc({
        "doctype": "Custom Field",
        "dt": "Warehouse",
        "fieldname": "bfel_establecimiento",
        "label": "Establecimiento (Sucursal)",
        "fieldtype": "Data",
        "insert_after": "company",
        "description": "ID de BFEL Establecimientos al que pertenece este almacén. Vacío = sin asignar.",
    }).insert(ignore_permissions=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="Warehouse")


# Tipo de Almacén (FacEx) — clasificación funcional del almacén, editable desde
# la pantalla «Almacenes» del módulo de Inventario. Prefijo bfel_ para que lo
# capture el fixture de Custom Field existente (hooks.py).
WAREHOUSE_TIPO_ALMACEN_OPTIONS = "\nVenta\nTransito\nConsignación\nDevoluciones\nCuarentena\nGeneral\nOtros"


def ensure_warehouse_tipo_almacen_field():
    """Idempotente: agrega el campo Select bfel_tipo_almacen a Warehouse si no existe."""
    if frappe.db.exists("Custom Field", "Warehouse-bfel_tipo_almacen"):
        return
    frappe.get_doc({
        "doctype": "Custom Field",
        "dt": "Warehouse",
        "fieldname": "bfel_tipo_almacen",
        "label": "Tipo de Almacén",
        "fieldtype": "Select",
        "options": WAREHOUSE_TIPO_ALMACEN_OPTIONS,
        "insert_after": "bfel_establecimiento",
        "module": "FacEx Multi",
        "description": "Clasificación funcional del almacén usada por FacEx (Venta, Tránsito, Consignación, etc.).",
    }).insert(ignore_permissions=True)
    frappe.db.commit()
    frappe.clear_cache(doctype="Warehouse")


# ---------------------------------------------------------------------------
# Módulo de Transporte (Catálogo de Transportistas / Guías / Liquidaciones)
# ---------------------------------------------------------------------------
# Deny-by-default, igual que Inventario y las acciones destructivas de arriba:
# un usuario sin fila configurada en FacEx Settings NO tiene acceso a estas
# 4 acciones hasta que se le habilite explícitamente por usuario+compañía.

def get_facex_can_administer_transportistas(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_administrar_transportistas",
    )
    return bool(int(value or 0))


def get_facex_can_upload_liquidaciones_transporte(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_cargar_liquidaciones_transporte",
    )
    return bool(int(value or 0))


def get_facex_can_edit_guias_transporte(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_editar_guias_transporte",
    )
    return bool(int(value or 0))


def get_facex_can_view_transporte_reportes(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_reportes_transporte",
    )
    return bool(int(value or 0))


def get_facex_companies_with_transporte_report_access(companies: list) -> list:
    """
    Filtra `companies` (típicamente el resultado de get_user_companies())
    dejando solo aquellas donde el usuario tiene puede_ver_reportes_transporte=1.
    System Manager conserva la lista completa.
    """
    if not companies:
        return []
    if "System Manager" in frappe.get_roles():
        return companies
    return frappe.get_all(
        "FacEx Settings",
        filters={
            "user": frappe.session.user,
            "bfel_company": ["in", companies],
            "puede_ver_reportes_transporte": 1,
        },
        pluck="bfel_company",
    )


def get_facex_can_view_transporte_menu(company: str) -> bool:
    """Llave maestra del menú 'Transporte' en FacEx Screen — si es False, el
    menú completo se oculta sin importar los demás permisos de transporte."""
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_menu_transporte",
    )
    return bool(int(value or 0))


def get_facex_can_view_transporte_kpis(company: str) -> bool:
    if "System Manager" in frappe.get_roles():
        return True
    if not company:
        return False
    value = frappe.db.get_value(
        "FacEx Settings",
        {"user": frappe.session.user, "bfel_company": company},
        "puede_ver_kpis_transporte",
    )
    return bool(int(value or 0))
