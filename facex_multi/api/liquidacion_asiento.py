# -*- coding: utf-8 -*-
"""Asiento contable que cierra la pasarela del recargo en la liquidación.

Flujo real del dinero (verificado en neko con las liquidaciones de Cargo
Expreso, 2026-09-30):

  * El cliente le paga al repartidor el TOTAL de la factura (`monto_cod` =
    grand_total: producto + recargo + flete).
  * El transportista retiene SOLO su comisión (`valor_comision`, ~4 %) y
    deposita el resto: `valor_comision + monto_liquidado = monto_cod` en todas
    las filas revisadas.
  * O sea el FLETE regresa a la empresa; el transportista no se lo queda. Por
    eso este asiento NO toca la cuenta de fletes por pagar: ese pasivo se
    cancela cuando la empresa le pague al transportista su factura de envíos.
    DECISIÓN DEL USUARIO (2026-10-01): que esa cuenta siga creciendo está bien,
    el contador la regulariza en su momento. No agregarle aquí un asiento que
    la drene — no es este el momento del flujo en que se paga.

El RECARGO, en cambio, existe precisamente para cubrir la comisión que el
transportista ya retiene en automático. Por eso la comparación del asiento (y
la del informe) es recargo ↔ comisión, y nunca recargo + flete ↔ comisión:
mezclarlos escondería las pérdidas, que es justo lo que hay que detectar.

Qué arregla
-----------
Hoy la liquidación crea un Payment Entry por `cubierto` = comisión + liquidado,
o sea por el COD COMPLETO, contra la cuenta bancaria. Pero al banco solo entró
`monto_liquidado`: **la cuenta de banco queda sobrestimada por la comisión en
cada guía liquidada**. Es un hueco preexistente, ajeno al rediseño de los
cargos, y es justo lo que este asiento cierra.

El asiento (por liquidación, agregando sus guías conciliadas):

    Dr  Recargos por Pagar a Transportista   Σ recargo cobrado al cliente
    Dr  Comisión de transporte no cubierta   (si la comisión superó al recargo)
        Cr  Cuenta bancaria de la liquidación   Σ comisión real retenida
        Cr  Diferencia favorable de comisión    (si el recargo superó la comisión)

Con eso: se cancela el pasivo del recargo, el banco queda en lo que de verdad
entró, y la diferencia aparece como ganancia o como gasto. Una guía sin recargo
manda la comisión completa al gasto, que es lo correcto: es un costo que no se
le trasladó al cliente.

Se genera en BORRADOR y a pedido (`generar_asiento`), nunca al guardar: son
asientos reales en producción y los revisa y somete Contabilidad.
"""
from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import flt

# Cuentas recomendadas. El número solo se usa si el grupo padre numera sus
# cuentas; si no, queda solo el nombre (hay planes contables sin numeración).
CUENTA_GANANCIA = "Diferencia favorable en comisión de transporte"
CUENTA_PERDIDA = "Comisión de transporte no cubierta"
NUM_GANANCIA = "4210"
NUM_PERDIDA = "5210"

# Dónde colgarlas, por orden de preferencia. Los planes de estos sitios usan
# "Ingresos indirectos" / "Egresos indirectos"; otros solo tienen la raíz.
_PADRES_INGRESO = ("ingresos indirectos", "otros ingresos", "ingreso indirecto")
_PADRES_GASTO = ("egresos indirectos", "gastos indirectos", "otros gastos",
                 "egreso indirecto", "gastos")


def _buscar_padre(company: str, root_type: str, preferencias: tuple) -> str | None:
    grupos = frappe.get_all(
        "Account",
        filters={"company": company, "is_group": 1, "root_type": root_type},
        fields=["name", "account_name", "parent_account"],
    )
    if not grupos:
        return None
    for pref in preferencias:
        for g in grupos:
            if pref in (g.account_name or "").lower():
                return g.name
    # Sin un grupo "indirecto": la raíz del tipo (la que no tiene padre).
    raices = [g for g in grupos if not g.parent_account]
    return (raices or grupos)[0].name


def _numero_libre(company: str, preferido: str) -> str | None:
    """El número recomendado si está libre; si no, el siguiente libre hacia
    arriba. Los planes de estos sitios ya tienen numeraciones propias (en neko
    el 5210 es «Gastos postales»), así que no se puede fijar uno a ciegas."""
    usados = set(frappe.get_all(
        "Account", filters={"company": company}, pluck="account_number") or [])
    usados.discard(None)
    if preferido not in usados:
        return preferido
    try:
        base = int(preferido)
    except ValueError:
        return None
    for n in range(base + 1, base + 90):
        if str(n) not in usados:
            return str(n)
    return None


def _crear_cuenta(company: str, nombre: str, numero: str, root_type: str,
                  preferencias: tuple) -> str:
    padre = _buscar_padre(company, root_type, preferencias)
    if not padre:
        frappe.throw(
            f"La compañía {company} no tiene ningún grupo de cuentas de tipo "
            f"{root_type}; no se puede crear «{nombre}»."
        )
    existente = frappe.db.get_value(
        "Account", {"company": company, "account_name": nombre}, "name")
    if existente:
        return existente
    # El número solo si el padre numera: mezclar numeradas y sin numerar deja
    # el plan inconsistente.
    usa_numeros = bool(frappe.db.get_value("Account", padre, "account_number"))
    doc = frappe.new_doc("Account")
    doc.account_name = nombre
    doc.parent_account = padre
    doc.company = company
    doc.root_type = root_type
    doc.report_type = "Profit and Loss"
    doc.is_group = 0
    if usa_numeros:
        libre = _numero_libre(company, numero)
        if libre:
            doc.account_number = libre
    doc.flags.ignore_permissions = True
    doc.insert(ignore_permissions=True)
    return doc.name


@frappe.whitelist()
def setup_cuentas_diferencia_comision(company: str = None) -> dict:
    """Crea las cuentas recomendadas y las deja configuradas.

    Sin `company` lo hace en las compañías que YA usan la pasarela (las que
    tienen cuenta de recargo configurada). No se tocan las demás: crearles
    cuentas que nunca van a usar solo ensucia su plan contable.
    """
    frappe.only_for("System Manager")
    from facex_multi.api.permissions import CONFIG_DOCTYPE, get_facex_company_config

    if company:
        companies = [company]
    else:
        companies = [
            c for c in frappe.get_all("Company", pluck="name")
            if (get_facex_company_config(c).get("cuenta_recargo_entrega") or "").strip()
        ]

    out = []
    for co in companies:
        cfg = get_facex_company_config(co)
        ganancia = cfg.get("cuenta_dif_comision_ganancia") or _crear_cuenta(
            co, CUENTA_GANANCIA, NUM_GANANCIA, "Income", _PADRES_INGRESO)
        perdida = cfg.get("cuenta_dif_comision_perdida") or _crear_cuenta(
            co, CUENTA_PERDIDA, NUM_PERDIDA, "Expense", _PADRES_GASTO)
        if frappe.db.exists(CONFIG_DOCTYPE, co):
            frappe.db.set_value(CONFIG_DOCTYPE, co, {
                "cuenta_dif_comision_ganancia": ganancia,
                "cuenta_dif_comision_perdida": perdida,
            })
        out.append({"company": co, "ganancia": ganancia, "perdida": perdida})

    from facex_multi.api.permissions import clear_permissions_cache
    clear_permissions_cache()
    frappe.db.commit()
    return {"configuradas": out, "omitidas_sin_pasarela": len(
        frappe.get_all("Company", pluck="name")) - len(companies)}


def _cuenta_banco_liquidacion(doc, company: str) -> str:
    """La cuenta que los Payment Entry de ESTA liquidación debitaron: es la que
    quedó sobrestimada por la comisión, así que es la que hay que acreditar.

    Se lee de los propios abonos y no del resolvedor de formas de pago: la
    liquidación usa `FORMA_PAGO_LIQUIDACION` ("Transferencia"), pero si esa
    forma no tiene cuenta configurada en la compañía el resolvedor cae a
    efectivo — y el asiento corregiría una cuenta distinta de la que se movió.
    """
    cuentas = {
        c for c in frappe.get_all(
            "Payment Entry",
            filters={"name": ["in", [r.payment_entry for r in doc.detalle if r.payment_entry]]},
            pluck="paid_to",
        ) if c
    } if any(r.payment_entry for r in doc.detalle) else set()

    if len(cuentas) == 1:
        return cuentas.pop()
    if len(cuentas) > 1:
        frappe.throw(
            "Los abonos de esta liquidación fueron a más de una cuenta ({0}). "
            "Genere el asiento a mano: no se puede decidir cuál corregir.".format(
                ", ".join(sorted(cuentas))))

    from facex_multi.api.invoice import FORMA_PAGO_LIQUIDACION, _resolve_mode_of_payment_account
    _mode, cuenta = _resolve_mode_of_payment_account(FORMA_PAGO_LIQUIDACION, company)
    if not cuenta:
        frappe.throw(
            f"No se encontró la cuenta de «{FORMA_PAGO_LIQUIDACION}» en {company}. "
            "Es la cuenta que la liquidación usa para los abonos y la que el "
            "asiento tiene que corregir."
        )
    return cuenta


def _resumen(doc) -> dict:
    """Totales del asiento a partir de las filas conciliadas.

    El recargo se recalcula desde las facturas en vez de leer el campo guardado
    `recargo_cobrado`: ese campo se llena en `validate`, así que una liquidación
    cargada antes de esta versión (o que no se haya vuelto a guardar) lo tiene
    en 0 y el asiento saldría sin cancelar el pasivo.
    """
    from facex_multi.api.recargo import cargos_facex_por_factura

    facturas = [r.sales_invoice for r in doc.detalle if r.match_encontrado and r.sales_invoice]
    cargos = cargos_facex_por_factura(facturas) if facturas else {}

    recargo = comision = 0.0
    guias = 0
    for row in doc.detalle:
        if not row.match_encontrado:
            continue
        recargo += flt((cargos.get(row.sales_invoice) or {}).get("recargo_pasarela"))
        comision += flt(row.valor_comision)
        guias += 1
    return {
        "recargo": flt(recargo, 2),
        "comision": flt(comision, 2),
        "diferencia": flt(recargo - comision, 2),
        "guias": guias,
    }


@frappe.whitelist()
def preview_asiento(name: str) -> dict:
    """Qué quedaría en el asiento, sin crear nada."""
    doc = frappe.get_doc("FacEx Liquidacion Transportista", name)
    r = _resumen(doc)
    company = _company_de(doc)
    from facex_multi.api.permissions import get_facex_company_config
    cfg = get_facex_company_config(company)
    r.update({
        "company": company,
        "cuenta_recargo": cfg.get("cuenta_recargo_entrega") or "",
        "cuenta_banco": _cuenta_banco_liquidacion(doc, company) if company else "",
        "cuenta_ganancia": cfg.get("cuenta_dif_comision_ganancia") or "",
        "cuenta_perdida": cfg.get("cuenta_dif_comision_perdida") or "",
        "asiento_existente": getattr(doc, "journal_entry", None),
    })
    return r


def _company_de(doc) -> str:
    """Compañía de la liquidación: la de sus facturas conciliadas (el doctype no
    tiene campo propio de compañía)."""
    for row in doc.detalle:
        if row.sales_invoice:
            co = frappe.db.get_value("Sales Invoice", row.sales_invoice, "company")
            if co:
                return co
    from facex_multi.api.invoice import get_effective_company
    return get_effective_company()


@frappe.whitelist()
def generar_asiento(name: str) -> dict:
    """Crea el Journal Entry en BORRADOR que cierra la pasarela del recargo.

    En borrador a propósito: lo revisa y lo somete Contabilidad. Idempotente —
    si ya hay un asiento vivo para esta liquidación, no crea otro.
    """
    from facex_multi.api.permissions import (
        get_facex_can_upload_liquidaciones_transporte, get_facex_company_config,
    )

    doc = frappe.get_doc("FacEx Liquidacion Transportista", name)
    company = _company_de(doc)
    if not get_facex_can_upload_liquidaciones_transporte(company):
        frappe.throw(_("No tiene permiso para generar el asiento de la liquidación."),
                     frappe.PermissionError)

    anterior = getattr(doc, "journal_entry", None)
    if anterior and frappe.db.exists("Journal Entry", anterior):
        if frappe.db.get_value("Journal Entry", anterior, "docstatus") != 2:
            frappe.throw(
                _("La liquidación {0} ya tiene el asiento {1}. Cancélelo en Contabilidad "
                  "si necesita regenerarlo.").format(doc.name, anterior))

    r = _resumen(doc)
    if not r["guias"]:
        frappe.throw(_("La liquidación no tiene guías conciliadas: no hay nada que asentar."))
    if abs(r["recargo"]) < 0.005 and abs(r["comision"]) < 0.005:
        frappe.throw(_("Ni recargo cobrado ni comisión: no hay nada que asentar."))

    cfg = get_facex_company_config(company)
    cuenta_recargo = (cfg.get("cuenta_recargo_entrega") or "").strip()
    cuenta_ganancia = (cfg.get("cuenta_dif_comision_ganancia") or "").strip()
    cuenta_perdida = (cfg.get("cuenta_dif_comision_perdida") or "").strip()
    faltan = []
    if not cuenta_recargo:
        faltan.append("Cuenta Recargo por Entrega")
    if r["diferencia"] > 0.005 and not cuenta_ganancia:
        faltan.append("Cuenta Diferencia favorable de comisión")
    if r["diferencia"] < -0.005 and not cuenta_perdida:
        faltan.append("Cuenta Comisión de transporte no cubierta")
    if faltan:
        frappe.throw(
            _("Falta configurar en {0}: {1}. Use «Configurar cuentas de diferencia "
              "de comisión» para crearlas con los valores recomendados.").format(
                company, " y ".join(faltan)))

    cuenta_banco = _cuenta_banco_liquidacion(doc, company)
    cost_center = frappe.get_cached_value("Company", company, "cost_center")

    je = frappe.new_doc("Journal Entry")
    je.voucher_type = "Journal Entry"
    je.company = company
    je.posting_date = doc.fecha
    je.user_remark = (
        f"Cierre de pasarela — liquidación {doc.name} ({doc.transportista}).\n"
        f"Recargo cobrado al cliente {r['recargo']:,.2f} − comisión real "
        f"{r['comision']:,.2f} = {r['diferencia']:,.2f} en {r['guias']} guía(s).\n"
        "Cancela el recargo por pagar y corrige el banco por la comisión que el "
        "transportista retuvo y nunca se depositó."
    )

    def _fila(cuenta, debito=0.0, credito=0.0):
        if abs(debito) < 0.005 and abs(credito) < 0.005:
            return
        je.append("accounts", {
            "account": cuenta,
            "debit_in_account_currency": flt(debito, 2),
            "credit_in_account_currency": flt(credito, 2),
            "cost_center": cost_center,
        })

    _fila(cuenta_recargo, debito=r["recargo"])
    if r["diferencia"] < -0.005:
        _fila(cuenta_perdida, debito=-r["diferencia"])
    _fila(cuenta_banco, credito=r["comision"])
    if r["diferencia"] > 0.005:
        _fila(cuenta_ganancia, credito=r["diferencia"])

    je.flags.ignore_permissions = True
    je.insert(ignore_permissions=True)

    doc.db_set("journal_entry", je.name)
    frappe.db.commit()
    return {"journal_entry": je.name, **r}
