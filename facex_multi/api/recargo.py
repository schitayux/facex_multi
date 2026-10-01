# -*- coding: utf-8 -*-
"""Recargo "Contra entrega" por pieza física y Flete como cargos del documento.

Contexto (Neko, 2026-09): las listas de precios COD llevaban embebido en el
`rate` un recargo de Q1.00 por pieza física (Docena = 12 piezas, Unidad = 1)
que se le paga al repartidor. Ese dinero no es ingreso de la empresa, pero al
ir dentro del precio del ítem se contabilizaba como venta. Lo mismo pasaba con
"Incluir Flete", que agregaba una línea con el ítem FLETE-xxx.

Diseño:
  * `UOM.custom_piezas_fisicas`  → piezas físicas por unidad de venta (12 / 1).
    Las UdM se quedan con factor de conversión 1 (así lo usa inventario).
  * `Price List.custom_recargo_por_pieza` → Q por pieza. > 0 = la lista lleva
    recargo. Es el ÚNICO disparador (no la condición de pago).
  * Por línea: `Sales Invoice Item.facex_recargo` = qty × piezas × Q/pieza y
    `facex_total_con_recargo` = importe + recargo (informativos, read-only).
  * Por documento: filas tipo "Actual" en `taxes` (Sales Taxes and Charges)
    marcadas con `facex_tipo_cargo` — "Recargo" (Σ líneas) y "Flete"
    (`facex_flete_amount`) — contra las cuentas de pasivo configuradas en
    FacEx Settings (registro de la compañía). El Grand Total que paga el
    cliente no cambia; lo que cambia es que el ítem se factura a precio neto
    y el recargo/flete no toca la cuenta de Ingresos.
  * `recargo_flete_con_iva` (FacEx Settings): si está ON cada cargo pasarela se
    parte en neto (cuenta pasivo) + IVA (cuenta del IVA de la plantilla). Por
    defecto OFF (fila sin IVA).

Pasarela vs. parte de la venta (2026-09-30)
-------------------------------------------
Cada cargo tiene un MODO por compañía (`recargo_es_venta` / `flete_es_venta`
en Configuración Compañía):

  * PASARELA (por defecto, el caso de Neko) — el cliente paga un extra por usar
    el servicio de entrega; el transportista lo cobra, lo deposita a la empresa
    y lo descuenta en su liquidación. NO es ingreso: no suma en ningún informe
    de venta ni en el tablero, y la certificación FEL documenta solo el neto.
  * PARTE DE LA VENTA — el cargo es ingreso propio: suma como venta, lleva IVA
    (siempre, porque es ingreso gravado) y al certificar se prorratea entre las
    líneas del documento en proporción al total de cada línea.

El modo se CONGELA por fila en `Sales Taxes and Charges.facex_cargo_es_venta`
al grabar la factura. Es deliberado: si se leyera en vivo de la configuración,
mover el interruptor reescribiría la historia de los informes y descuadraría
cierres ya congelados. Las filas emitidas antes de que existiera el campo
quedan en 0 = pasarela, que es exactamente lo que son (fueron contabilizadas
contra cuentas de pasivo), así que no hace falta parchear nada.

Una devolución / nota de crédito HEREDA el modo de la factura original
(`_modo_heredado`), para revertir el cargo tal como se emitió aunque la
compañía haya cambiado de modo después.

Quien consume esto: `cargos_facex_por_factura` (Cierre Diario, por documento) y
los helpers SQL `pasarela_sql` / `venta_neta_sql` (informes, KPIs y tablero).

Las filas se reconstruyen en `before_validate` porque ERPNext calcula los
totales dentro de su propio `validate` (accounts_controller.validate →
calculate_taxes_and_totals) y los hooks `validate` corren después.
"""
from __future__ import annotations

import frappe
from frappe.utils import cint, flt

TIPO_RECARGO = "Recargo"
TIPO_FLETE = "Flete"
TIPO_IVA_RECARGO = "IVA Recargo"
TIPO_IVA_FLETE = "IVA Flete"
TIPOS_CARGO = (TIPO_RECARGO, TIPO_FLETE, TIPO_IVA_RECARGO, TIPO_IVA_FLETE)

DESC_RECARGO = "Recargo por entrega"
DESC_FLETE = "Flete"

# Piezas físicas sugeridas para las UdM conocidas cuando el campo está en 0.
_PIEZAS_SEED = {"Docena": 12, "Unidad": 1, "Nos.": 1, "Unit": 1}


# ---------------------------------------------------------------------------
# Custom fields (after_migrate, idempotente)
# ---------------------------------------------------------------------------

def ensure_recargo_flete_fields():
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    create_custom_fields(
        {
            "UOM": [
                {
                    "fieldname": "custom_piezas_fisicas",
                    "label": "Piezas físicas por unidad (FacEx)",
                    "fieldtype": "Int",
                    "insert_after": "must_be_whole_number",
                    "description": "Cuántas piezas físicas representa 1 de esta UdM al vender "
                                   "(Docena = 12, Unidad = 1). Se usa para el recargo por pieza "
                                   "de las listas Contra Entrega; NO altera el factor de conversión.",
                },
            ],
            "Price List": [
                {
                    "fieldname": "custom_recargo_por_pieza",
                    "label": "Recargo por pieza (Contra Entrega)",
                    "fieldtype": "Currency",
                    "insert_after": "custom_es_contra_entrega",
                    "description": "Q por pieza física que se cobra al cliente y se paga al "
                                   "repartidor. > 0 = las facturas con esta lista llevan la fila "
                                   "\"Recargo por entrega\" en cargos (no es ingreso). Los precios "
                                   "de la lista deben ser NETOS (sin el recargo).",
                },
            ],
            "Sales Taxes and Charges": [
                {
                    "fieldname": "facex_tipo_cargo",
                    "label": "Tipo de cargo FacEx",
                    "fieldtype": "Data",
                    "insert_after": "description",
                    "read_only": 1,
                    "hidden": 1,
                    "description": "Recargo / Flete / IVA Recargo / IVA Flete — fila generada por FacEx.",
                },
                {
                    "fieldname": "facex_cargo_es_venta",
                    "label": "El cargo es parte de la venta",
                    "fieldtype": "Check",
                    "insert_after": "facex_tipo_cargo",
                    "default": "0",
                    "read_only": 1,
                    "hidden": 1,
                    "description": "Congela el modo de la compañía al grabar la factura. 0 = pasarela "
                                   "(no es venta); 1 = ingreso propio. Las filas anteriores a este campo "
                                   "quedan en 0, que es exactamente lo que son: fueron contabilizadas "
                                   "contra cuentas de pasivo.",
                },
            ],
            "Sales Invoice Item": [
                {
                    "fieldname": "facex_recargo",
                    "label": "Recargo entrega",
                    "fieldtype": "Currency",
                    "insert_after": "amount",
                    "read_only": 1,
                    "no_copy": 1,
                    "print_hide": 1,
                    "description": "qty × piezas físicas × recargo por pieza de la lista. Informativo: "
                                   "el monto real va en la fila de cargos del documento.",
                },
                {
                    "fieldname": "facex_total_con_recargo",
                    "label": "Total c/recargo",
                    "fieldtype": "Currency",
                    "insert_after": "facex_recargo",
                    "read_only": 1,
                    "no_copy": 1,
                    "print_hide": 1,
                    "description": "Importe + recargo. Informativo, no participa en los totales.",
                },
            ],
            "Sales Invoice": [
                {
                    "fieldname": "facex_recargo_section",
                    "label": "Recargo / Flete (FacEx)",
                    "fieldtype": "Section Break",
                    "insert_after": "bfel_pago_contra_entrega",
                    "collapsible": 1,
                },
                {
                    "fieldname": "facex_incluir_flete",
                    "label": "Incluir Flete",
                    "fieldtype": "Check",
                    "insert_after": "facex_recargo_section",
                },
                {
                    "fieldname": "facex_flete_amount",
                    "label": "Monto de Flete",
                    "fieldtype": "Currency",
                    "insert_after": "facex_incluir_flete",
                    "read_only": 1,
                    "description": "Se toma del precio del Ítem de Flete en la lista de precios de la "
                                   "factura. Solo editable con el permiso 'Editar Precio Manualmente en Venta'.",
                },
                {
                    "fieldname": "facex_flete_amount_original",
                    "label": "Flete según lista (auditoría)",
                    "fieldtype": "Currency",
                    "insert_after": "facex_flete_amount",
                    "read_only": 1,
                    "hidden": 1,
                    "no_copy": 1,
                },
                {
                    "fieldname": "facex_recargo_total",
                    "label": "Recargo por entrega (total)",
                    "fieldtype": "Currency",
                    "insert_after": "facex_flete_amount_original",
                    "read_only": 1,
                    "no_copy": 1,
                },
            ],
        },
        ignore_validate=True,
        update=True,
    )

    # Semilla de piezas físicas para las UdM conocidas (solo si están en 0).
    for uom, piezas in _PIEZAS_SEED.items():
        if frappe.db.exists("UOM", uom) and not cint(frappe.db.get_value("UOM", uom, "custom_piezas_fisicas")):
            frappe.db.set_value("UOM", uom, "custom_piezas_fisicas", piezas, update_modified=False)
    frappe.db.commit()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _meta_ready(doc) -> bool:
    """Entre desplegar el código y correr `bench migrate` los campos pueden no
    existir todavía; en ese caso no hacemos nada (código defensivo)."""
    return (
        doc.meta.has_field("facex_recargo_total")
        and frappe.get_meta("Sales Taxes and Charges").has_field("facex_tipo_cargo")
        and frappe.get_meta("Price List").has_field("custom_recargo_por_pieza")
    )


def get_recargo_por_pieza(price_list: str) -> float:
    if not price_list or not frappe.get_meta("Price List").has_field("custom_recargo_por_pieza"):
        return 0.0
    return flt(frappe.db.get_value("Price List", price_list, "custom_recargo_por_pieza"))


def get_piezas_map() -> dict:
    """{uom: piezas físicas} para todas las UdM con valor > 0."""
    if not frappe.get_meta("UOM").has_field("custom_piezas_fisicas"):
        return {}
    rows = frappe.get_all("UOM", filters={"custom_piezas_fisicas": [">", 0]},
                          fields=["name", "custom_piezas_fisicas"])
    return {r.name: cint(r.custom_piezas_fisicas) for r in rows}


def _piezas(uom: str, cache: dict) -> int:
    if not uom:
        return 0
    if uom not in cache:
        cache[uom] = cint(frappe.db.get_value("UOM", uom, "custom_piezas_fisicas")) if frappe.get_meta("UOM").has_field("custom_piezas_fisicas") else 0
    return cache[uom]


def get_flete_rate(company: str, price_list: str) -> float:
    """Precio del Ítem de Flete (FacEx Settings.item_flete) en la lista dada."""
    from facex_multi.api.permissions import get_facex_flete_item
    item = get_facex_flete_item(company)
    if not item or not price_list:
        return 0.0
    return flt(frappe.db.get_value(
        "Item Price", {"item_code": item, "price_list": price_list, "selling": 1},
        "price_list_rate", order_by="valid_from desc",
    ))


def _cargo_accounts(company: str) -> dict:
    from facex_multi.api.permissions import get_facex_company_config
    cfg = get_facex_company_config(company)
    return {
        "recargo": cfg.get("cuenta_recargo_entrega") or "",
        "flete": cfg.get("cuenta_flete") or "",
        "con_iva": cint(cfg.get("recargo_flete_con_iva")),
        "recargo_es_venta": cint(cfg.get("recargo_es_venta")),
        "flete_es_venta": cint(cfg.get("flete_es_venta")),
    }


def _modo_heredado(doc) -> dict | None:
    """Para una devolución / nota de crédito: el modo (pasarela o venta) que
    tenían los cargos de la factura ORIGINAL, por tipo de cargo.

    Una NC debe revertir el cargo tal como se emitió: si la venta original fue
    pasarela, su reverso también es pasarela aunque la compañía haya cambiado
    de modo después. Si no hay factura original o no traía cargos, devuelve
    None y se usa el modo actual de la compañía."""
    if not cint(doc.get("is_return")) or not doc.get("return_against"):
        return None
    if not frappe.get_meta("Sales Taxes and Charges").has_field("facex_cargo_es_venta"):
        return None
    rows = frappe.get_all(
        "Sales Taxes and Charges",
        filters={"parenttype": "Sales Invoice", "parent": doc.return_against,
                 "facex_tipo_cargo": ["in", list(TIPOS_CARGO)]},
        fields=["facex_tipo_cargo", "facex_cargo_es_venta"],
    )
    if not rows:
        return None
    out = {}
    for r in rows:
        key = "flete" if r.facex_tipo_cargo in (TIPO_FLETE, TIPO_IVA_FLETE) else "recargo"
        # Cualquier fila del grupo basta: recargo y su IVA comparten el modo.
        out[key] = cint(r.facex_cargo_es_venta)
    return out or None


def _iva_row(doc):
    """Fila de IVA de la plantilla (no generada por FacEx) con tasa > 0, o None."""
    for t in doc.get("taxes") or []:
        if t.get("facex_tipo_cargo"):
            continue
        if t.charge_type == "On Net Total" and flt(t.rate) > 0:
            return t
    return None


# ---------------------------------------------------------------------------
# Hooks Sales Invoice
# ---------------------------------------------------------------------------

def apply_recargo_y_flete(doc, method=None):
    """Hook Sales Invoice.before_validate.

    1. Calcula `facex_recargo` por línea (qty × piezas(UdM) × Q/pieza de la lista).
    2. Reconstruye las filas de cargos FacEx en `taxes`: quita las anteriores y,
       si hay recargo o flete, agrega filas "Actual" contra las cuentas de
       FacEx Settings (partidas en neto + IVA si `recargo_flete_con_iva`).
    Idempotente: se puede guardar N veces.
    """
    if not _meta_ready(doc):
        return

    rpp = get_recargo_por_pieza(doc.get("selling_price_list"))
    from facex_multi.api.permissions import get_facex_flete_item
    flete_item = get_facex_flete_item(doc.company)

    cache = {}
    total_recargo = 0.0
    for it in doc.get("items") or []:
        it.facex_recargo = 0.0
        if rpp <= 0 or (flete_item and it.item_code == flete_item):
            continue
        uom = it.get("uom") or it.get("stock_uom") or frappe.db.get_value("Item", it.item_code, "stock_uom")
        it.facex_recargo = flt(flt(it.qty) * _piezas(uom, cache) * rpp, 2)
        total_recargo += it.facex_recargo
    doc.facex_recargo_total = flt(total_recargo, 2)

    flete = flt(doc.get("facex_flete_amount")) if cint(doc.get("facex_incluir_flete")) else 0.0
    if not cint(doc.get("facex_incluir_flete")):
        doc.facex_flete_amount = 0.0
        doc.facex_flete_amount_original = 0.0
    if cint(doc.get("is_return")) and flete > 0:
        flete = -flete

    # Quitar filas FacEx previas conservando el resto (plantilla IVA).
    keep = [t for t in (doc.get("taxes") or []) if not t.get("facex_tipo_cargo")]
    doc.set("taxes", keep)
    for i, t in enumerate(doc.taxes, start=1):
        t.idx = i

    if abs(total_recargo) < 0.005 and abs(flete) < 0.005:
        return

    # Sin filas de plantilla todavía (form estándar: set_taxes corre en validate
    # y solo si `taxes` está vacío) → cargarlas nosotros para que el IVA no se
    # pierda por culpa de nuestras filas.
    if doc.get("taxes_and_charges") and not doc.taxes:
        doc.append_taxes_from_master()

    accts = _cargo_accounts(doc.company)
    faltan = []
    if abs(total_recargo) >= 0.005 and not accts["recargo"]:
        faltan.append("Cuenta de Recargo por entrega")
    if abs(flete) >= 0.005 and not accts["flete"]:
        faltan.append("Cuenta de Flete")
    if faltan:
        frappe.throw(
            "FacEx Settings (registro de la compañía {0}): falta configurar {1}. "
            "Sin esa cuenta no se puede registrar el recargo/flete como cargo del documento.".format(
                doc.company, " y ".join(faltan)),
            title="Recargo / Flete sin cuenta contable",
        )

    # Modo de cada cargo: el de la compañía hoy, salvo en una devolución, que
    # hereda el de la factura original para revertirla tal como se emitió.
    heredado = _modo_heredado(doc) or {}
    es_venta = {
        "recargo": heredado.get("recargo", accts["recargo_es_venta"]),
        "flete": heredado.get("flete", accts["flete_es_venta"]),
    }

    iva_tpl = _iva_row(doc)
    cost_center = frappe.get_cached_value("Company", doc.company, "cost_center")

    def _add(tipo, desc, account, amount, venta):
        if abs(amount) < 0.005:
            return
        doc.append("taxes", {
            "charge_type": "Actual",
            "account_head": account,
            "description": desc,
            "rate": 0,
            "tax_amount": flt(amount, 2),
            "included_in_print_rate": 0,
            "cost_center": cost_center,
            "facex_tipo_cargo": tipo,
            "facex_cargo_es_venta": cint(venta),
        })

    def _split(gross, venta):
        """(neto, iva) — el monto que ve el cliente es siempre `gross`.

        Un cargo "parte de la venta" es ingreso gravado, así que SIEMPRE se
        parte en neto + IVA: es lo único que cuadra con el prorrateo por línea
        de la certificación FEL. Un cargo pasarela respeta
        `recargo_flete_con_iva` (apagado por defecto: no grava)."""
        iva = iva_tpl if (venta or accts["con_iva"]) else None
        if not iva or flt(iva.rate) <= 0:
            return gross, 0.0, None
        neto = flt(gross / (1 + flt(iva.rate) / 100.0), 2)
        return neto, flt(gross - neto, 2), iva

    neto, imp, iva = _split(flt(total_recargo, 2), es_venta["recargo"])
    _add(TIPO_RECARGO, DESC_RECARGO, accts["recargo"], neto, es_venta["recargo"])
    if iva:
        _add(TIPO_IVA_RECARGO, "IVA " + DESC_RECARGO, iva.account_head, imp, es_venta["recargo"])

    neto, imp, iva = _split(flt(flete, 2), es_venta["flete"])
    _add(TIPO_FLETE, DESC_FLETE, accts["flete"], neto, es_venta["flete"])
    if iva:
        _add(TIPO_IVA_FLETE, "IVA " + DESC_FLETE, iva.account_head, imp, es_venta["flete"])


def set_totales_con_recargo(doc, method=None):
    """Hook Sales Invoice.validate (después de calculate_taxes_and_totals):
    `facex_total_con_recargo` por línea = importe ya calculado + recargo."""
    if not doc.meta.has_field("facex_recargo_total"):
        return
    for it in doc.get("items") or []:
        rec = flt(it.get("facex_recargo"))
        it.facex_total_con_recargo = flt(flt(it.amount) + rec, 2) if rec else 0.0


def resolve_flete_for_payload(data: dict, company: str, price_list: str, can_edit_price: bool) -> str:
    """Usado por save_draft: fija facex_flete_amount / _original en el payload.

    - Casilla apagada → 0.
    - Casilla encendida → precio del Ítem de Flete en la lista de la factura.
      Solo con `puede_editar_precio` se respeta un monto manual distinto; en
      ese caso se guarda el precio de lista en `_original` y se devuelve el
      texto del comentario de auditoría para el timeline (o "").
    """
    if not cint(data.get("facex_incluir_flete")):
        data["facex_incluir_flete"] = 0
        data["facex_flete_amount"] = 0.0
        data["facex_flete_amount_original"] = 0.0
        return ""

    from facex_multi.api.permissions import get_facex_flete_item
    if not get_facex_flete_item(company):
        frappe.throw("No hay Ítem de Flete configurado en FacEx Settings para esta compañía.")

    lookup = get_flete_rate(company, price_list)
    sent = flt(data.get("facex_flete_amount"))
    data["facex_incluir_flete"] = 1
    if can_edit_price and sent > 0 and abs(sent - lookup) > 0.005:
        data["facex_flete_amount"] = flt(sent, 2)
        data["facex_flete_amount_original"] = flt(lookup, 2)
        return (
            "Flete editado manualmente por {0}: Q {1:,.2f} (precio de lista '{2}': Q {3:,.2f})".format(
                frappe.session.user, flt(sent, 2), price_list or "-", flt(lookup, 2))
        )
    if lookup <= 0:
        frappe.throw(
            "El Ítem de Flete no tiene precio en la lista '{0}'. Agregue el precio a la lista "
            "o desmarque \"Incluir Flete\".".format(price_list or "-"),
            title="Flete sin precio",
        )
    data["facex_flete_amount"] = flt(lookup, 2)
    data["facex_flete_amount_original"] = 0.0
    return ""


# ---------------------------------------------------------------------------
# API para los pages (FacEx Clásico / FacEx Screen)
# ---------------------------------------------------------------------------

@frappe.whitelist()
def get_recargo_context(company: str = None, price_list: str = None) -> dict:
    """Todo lo que el page necesita para estimar recargo/flete localmente y
    decidir si muestra las columnas Recargo / Total c/recargo."""
    from facex_multi.api.invoice import get_effective_company
    from facex_multi.api.permissions import (
        get_facex_can_edit_price, get_facex_company_config, get_facex_flete_item,
    )
    company = get_effective_company(company)
    cfg = get_facex_company_config(company)
    rpp = get_recargo_por_pieza(price_list)
    return {
        "price_list": price_list or "",
        "recargo_por_pieza": rpp,
        "piezas": get_piezas_map(),
        "flete_item": get_facex_flete_item(company),
        "flete_rate": get_flete_rate(company, price_list),
        "puede_editar_flete": bool(get_facex_can_edit_price(company)),
        "con_iva": cint(cfg.get("recargo_flete_con_iva")),
        "cuenta_recargo": cfg.get("cuenta_recargo_entrega") or "",
        "cuenta_flete": cfg.get("cuenta_flete") or "",
        # Modo de cada cargo: 0 = pasarela (no es venta), 1 = ingreso propio.
        # El page lo usa para rotular los totales de la factura en pantalla.
        "recargo_es_venta": cint(cfg.get("recargo_es_venta")),
        "flete_es_venta": cint(cfg.get("flete_es_venta")),
    }


_CARGO_KEYS = ("recargo", "flete", "pasarela", "venta",
               "recargo_pasarela", "recargo_venta", "flete_pasarela", "flete_venta")


def cargos_facex_por_factura(invoice_names: list) -> dict:
    """{invoice: {...}} con los cargos FacEx del documento (bruto: neto + IVA
    cuando aplica), desglosados por tipo y por modo:

      recargo / flete                  total por tipo (lo que paga el cliente)
      pasarela / venta                 el mismo dinero partido por MODO
      <tipo>_pasarela / <tipo>_venta   el cruce de ambos

    `pasarela` es la parte que NO es venta de la empresa. Para Cierre Diario,
    liquidaciones y reportes.
    """
    out = {}
    meta = frappe.get_meta("Sales Taxes and Charges")
    if not invoice_names or not meta.has_field("facex_tipo_cargo"):
        return out
    fields = ["parent", "facex_tipo_cargo", "tax_amount"]
    has_modo = meta.has_field("facex_cargo_es_venta")
    if has_modo:
        fields.append("facex_cargo_es_venta")
    rows = frappe.get_all(
        "Sales Taxes and Charges",
        filters={"parenttype": "Sales Invoice", "parent": ["in", invoice_names],
                 "facex_tipo_cargo": ["in", list(TIPOS_CARGO)]},
        fields=fields,
    )
    for r in rows:
        d = out.setdefault(r.parent, {k: 0.0 for k in _CARGO_KEYS})
        tipo = "flete" if r.facex_tipo_cargo in (TIPO_FLETE, TIPO_IVA_FLETE) else "recargo"
        modo = "venta" if (has_modo and cint(r.facex_cargo_es_venta)) else "pasarela"
        amount = flt(r.tax_amount)
        d[tipo] += amount
        d[modo] += amount
        d[f"{tipo}_{modo}"] += amount
    return out


# ---------------------------------------------------------------------------
# Helpers SQL — "venta neta" para informes, KPIs y tablero
# ---------------------------------------------------------------------------
# Los informes de venta se construían sobre `grand_total`, que incluye las filas
# de cargos. Con el recargo/flete en modo pasarela eso infla la venta con dinero
# que no es de la empresa. En vez de parchear cada consulta con su propia resta,
# la regla vive aquí y cada informe la usa como expresión SQL: así no hay dos
# definiciones de "venta" que puedan divergir.
#
# Un cargo pasarela se reconoce por `facex_cargo_es_venta = 0` en una fila con
# `facex_tipo_cargo`. Las filas anteriores al campo quedan en 0 = pasarela, que
# es lo que son.

def _cargos_meta_ok() -> bool:
    """Entre desplegar el código y correr `bench migrate` los campos pueden no
    existir; en ese caso los helpers devuelven '0' y los informes siguen
    funcionando con el total completo (comportamiento anterior)."""
    try:
        meta = frappe.get_meta("Sales Taxes and Charges")
        return meta.has_field("facex_tipo_cargo") and meta.has_field("facex_cargo_es_venta")
    except Exception:
        return False


def pasarela_sql(alias: str = "si") -> str:
    """Expresión SQL con el total de cargos PASARELA de la factura `alias`
    (0 si todavía no se migraron los campos). Sin parámetros: no interpola nada
    del usuario, solo el alias que pone el caller."""
    if not _cargos_meta_ok():
        return "0"
    return (
        "COALESCE((SELECT SUM(_fxc.tax_amount) FROM `tabSales Taxes and Charges` _fxc "
        f"WHERE _fxc.parent = `{alias}`.name AND _fxc.parenttype = 'Sales Invoice' "
        "AND IFNULL(_fxc.facex_tipo_cargo, '') != '' "
        "AND IFNULL(_fxc.facex_cargo_es_venta, 0) = 0), 0)"
    )


def total_cobrable_sql(alias: str = "si") -> str:
    """Total que paga el cliente: `rounded_total` salvo que esté deshabilitado
    (mismo criterio que `cierre._inv_total`). Es la base de cobranza —
    estados de cuenta, antigüedad de saldos, pagos — y NO se le resta nada."""
    return (
        f"(CASE WHEN IFNULL(`{alias}`.disable_rounded_total, 0) = 0 AND `{alias}`.rounded_total != 0 "
        f"THEN `{alias}`.rounded_total ELSE `{alias}`.grand_total END)"
    )


def venta_neta_sql(alias: str = "si") -> str:
    """Venta de la empresa: total cobrable menos los cargos pasarela. Es lo que
    deben sumar los informes de venta, los KPIs y el tablero."""
    return f"({total_cobrable_sql(alias)} - {pasarela_sql(alias)})"


def recargo_estimado_por_factura(invoice_names: list) -> dict:
    """{invoice: {"recargo", "flete", "origen"}} — el recargo y el flete que se le
    COBRARON AL CLIENTE, para analizar contra la comisión real del transportista.

    No es lo mismo que `cargos_facex_por_factura`, y la diferencia importa:

      * Las facturas emitidas desde el 2026-09-21 traen el recargo y el flete como
        filas de cargo; ahí se leen de ahí («origen»: cargos).
      * Las ANTERIORES llevaban el recargo EMBEBIDO en el precio de la lista
        (Q1 por pieza dentro del rate) y el flete como una línea del ítem de
        flete, así que no tienen ninguna fila de cargo. Para esas se reconstruye
        con la misma fórmula que las habría generado: qty × piezas físicas de la
        UdM × Q/pieza de la lista, saltando la línea del ítem de flete
        («origen»: reconstruido). Ver ACC-SINV-2026-00041 (2026-09-17): dos
        líneas de 0.5 Docena en LP-COD = Q12 de recargo, más Q35 de flete en
        línea, que sin esto salían en cero en el Análisis COD del Cierre.

    OJO: esto NO sirve para el asiento contable. En una factura vieja el recargo
    se contabilizó como INGRESO (iba en el precio), no como pasivo, así que no
    hay nada que cancelar en la cuenta de recargos por pagar. Para el pasivo hay
    que seguir usando `cargos_facex_por_factura(...)["recargo_pasarela"]`.
    """
    out = {}
    if not invoice_names:
        return out

    invoices = frappe.get_all(
        "Sales Invoice", filters={"name": ["in", list(invoice_names)]},
        fields=["name", "company", "selling_price_list"])
    if not invoices:
        return out

    cargos = cargos_facex_por_factura([i.name for i in invoices])
    items = frappe.get_all(
        "Sales Invoice Item", filters={"parent": ["in", [i.name for i in invoices]],
                                       "parenttype": "Sales Invoice"},
        fields=["parent", "item_code", "qty", "uom", "stock_uom", "amount"])
    por_factura = {}
    for it in items:
        por_factura.setdefault(it.parent, []).append(it)

    piezas = get_piezas_map()
    rpp_cache, flete_cache = {}, {}
    from facex_multi.api.permissions import get_facex_flete_item

    for inv in invoices:
        pl = inv.selling_price_list
        if pl not in rpp_cache:
            rpp_cache[pl] = get_recargo_por_pieza(pl)
        if inv.company not in flete_cache:
            flete_cache[inv.company] = (get_facex_flete_item(inv.company) or "").strip()
        rpp = rpp_cache[pl]
        flete_item = flete_cache[inv.company]
        lineas = por_factura.get(inv.name, [])

        # El flete en línea de producto existe en ambos casos y siempre suma.
        flete_lineas = sum(flt(it.amount) for it in lineas
                           if flete_item and it.item_code == flete_item)

        c = cargos.get(inv.name)
        if c:
            out[inv.name] = {
                "recargo": flt(c.get("recargo")),
                "flete": flt(c.get("flete")) + flete_lineas,
                "origen": "cargos",
            }
            continue

        # Sin filas de cargo: se reconstruye con la fórmula original, saltando la
        # línea del ítem de flete (que nunca llevó recargo).
        recargo = 0.0
        for it in lineas:
            if flete_item and it.item_code == flete_item:
                continue
            uom = it.uom or it.stock_uom
            recargo += flt(it.qty) * cint(piezas.get(uom, 0)) * rpp
        if recargo or flete_lineas:
            out[inv.name] = {
                "recargo": flt(recargo, 2),
                "flete": flt(flete_lineas, 2),
                "origen": "reconstruido",
            }
    return out


def pasarela_por_factura(invoice_names: list) -> dict:
    """{invoice: monto pasarela} — versión Python de `pasarela_sql` para los
    informes que ya traen las facturas en memoria."""
    return {k: v["pasarela"] for k, v in cargos_facex_por_factura(invoice_names).items() if v["pasarela"]}
