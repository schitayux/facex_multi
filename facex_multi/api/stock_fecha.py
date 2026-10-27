"""
facex_multi.api.stock_fecha
---------------------------
Inventario validado **por fecha** y no por hora.

ERPNext ordena y valida el inventario por `posting_datetime`
(posting_date + posting_time) y, a igualdad de hora, por `creation`. Como esta
app no marca «Editar fecha y hora de emisión», cada documento queda con la hora
exacta en que se capturó, así que el orden de captura decide si hay existencia:
una entrada registrada a las 16:00 no existe para una venta de las 10:00 del
mismo día, aunque la mercadería estuviera físicamente desde la mañana. De ahí
los «cruces de horarios»: ERPNext responde «N unidades de X necesarias en el
almacén Y» cuando la mercadería sí estaba, solo que el papeleo se capturó
después.

Aquí el inventario pasa a validarse al día, en dos capas:

  Capa 1 — las ENTRADAS puras se asientan al inicio del día (00:00:01):
      Entrada de Mercadería (Purchase Receipt), Factura de Compra con
      inventario y Entrada de Inventario (Stock Entry / Material Receipt).
      Con eso la mercadería del día está disponible desde la primera hora para
      cualquier salida de esa misma fecha, y la venta se valúa con el costo de
      la entrada (no con el costo anterior ni con cero).
      No se toca la hora de: traslados, transformaciones, salidas, facturas de
      venta y notas de crédito (su hora va al DTE de FEL), devoluciones a
      proveedor ni el Reajuste de Inventario (un conteo físico sí depende de la
      hora en que se contó).

  Capa 2 — el saldo se valida al CIERRE DE CADA DÍA, no instante por instante:
      se apaga el bloqueo nativo punto-en-el-tiempo (Stock Settings →
      «Permitir Stock Negativo») y en su lugar, al confirmar o anular cualquier
      movimiento, se exige que ningún ítem/almacén quede negativo al final de
      la fecha del documento ni de ninguna fecha posterior. El orden de las
      horas dentro del día deja de importar: cargar un vehículo por la mañana,
      venderle todo el día y devolver el sobrante por la noche cuadra igual, se
      capture en el orden que se capture; lo que sigue prohibido es que el día
      cierre con existencia negativa.

Interruptor: Stock Settings → «Validar inventario por fecha (FacEx)»
(`bfel_validar_por_fecha`, encendido en la primera migración). Si se desmarca,
las dos capas se apagan; para volver al comportamiento 100% nativo hay que
desmarcar también «Permitir Stock Negativo».

Limitación conocida: la existencia de un número de serie o de un lote la
resuelve ERPNext en el Serial and Batch Bundle, que sigue siendo
punto-en-el-tiempo. La capa 1 la cubre cuando la serie/lote entró por compra o
por entrada de inventario; si entró por un traslado el mismo día, ese traslado
debe capturarse antes de la salida.
"""
from __future__ import annotations

import frappe
from frappe.utils import cint, flt, formatdate, getdate

# Hora canónica de las entradas: el segundo 1 del día, de modo que toda entrada
# precede a cualquier salida de esa fecha (que conserva su hora real).
HORA_ENTRADA = "00:00:01"

# Doctypes que mueven inventario y por los que pasa la validación por fecha.
# Es la lista completa de los que escriben asientos en ERPNext v16: los tres
# controladores (buying / selling / subcontracting), Stock Entry, Stock
# Reconciliation y Asset Capitalization. Ninguna salida de mercadería puede
# quedar fuera de esta lista: es lo que garantiza que el saldo nunca cierre
# negativo ahora que el bloqueo nativo por hora está apagado.
DOCTYPES_INVENTARIO = (
    "Stock Entry",
    "Stock Reconciliation",
    "Purchase Receipt",
    "Purchase Invoice",
    "Sales Invoice",
    "POS Invoice",
    "Delivery Note",
    "Subcontracting Receipt",
    "Asset Capitalization",
)

# Cuántos faltantes se detallan en el mensaje de error.
MAX_FALTANTES = 5


# ---------------------------------------------------------------------------
# Interruptor
# ---------------------------------------------------------------------------

def validacion_por_fecha_activa() -> bool:
    """Lee el check de Stock Settings (documento en caché, como el propio
    `is_negative_stock_allowed` de ERPNext). Devuelve False mientras el campo
    no exista — es decir, antes del primer `bench migrate`."""
    try:
        return bool(cint(frappe.get_cached_doc("Stock Settings").get("bfel_validar_por_fecha")))
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Capa 1: hora canónica de las entradas
# ---------------------------------------------------------------------------

def _es_entrada_pura(doc) -> bool:
    """True solo para documentos cuyo único efecto es ingresar mercadería y
    cuya hora no significa nada fuera del inventario."""
    if doc.doctype == "Purchase Receipt":
        return not cint(doc.get("is_return"))
    if doc.doctype == "Purchase Invoice":
        return cint(doc.get("update_stock")) and not cint(doc.get("is_return"))
    if doc.doctype == "Stock Entry":
        return doc.get("purpose") == "Material Receipt"
    return False


def normalizar_hora_entrada(doc, method=None):
    """Hook before_validate — asienta las entradas a las 00:00:01 de su fecha.

    Marca `set_posting_time` porque ERPNext (TransactionBase.validate_posting_time)
    sobrescribe fecha y hora con el momento del guardado cuando ese check está
    apagado. La fecha que trae el documento no se toca: solo la hora.
    """
    if not validacion_por_fecha_activa() or not _es_entrada_pura(doc):
        return
    if doc.get("posting_time") == HORA_ENTRADA and cint(doc.get("set_posting_time")):
        return
    doc.set_posting_time = 1
    doc.posting_time = HORA_ENTRADA


# ---------------------------------------------------------------------------
# Capa 2: el saldo se valida al cierre de cada día
# ---------------------------------------------------------------------------

def _pares_afectados(doc) -> list:
    """(ítem, almacén) tocados por el documento. Se leen de los asientos ya
    escritos, así que sirve igual al confirmar que al anular (al anular los
    asientos quedan con is_cancelled = 1). Se excluyen los ítems marcados como
    «permitir stock negativo»."""
    rows = frappe.db.sql(
        """
        SELECT DISTINCT sle.item_code, sle.warehouse
        FROM `tabStock Ledger Entry` sle
        INNER JOIN `tabItem` i ON i.name = sle.item_code
        WHERE sle.voucher_type = %(dt)s AND sle.voucher_no = %(dn)s
          AND IFNULL(i.allow_negative_stock, 0) = 0
        """,
        {"dt": doc.doctype, "dn": doc.name},
        as_dict=True,
    )
    return [(r.item_code, r.warehouse) for r in rows]


def _dias_negativos(pares: list, desde) -> list:
    """Saldo al cierre de cada fecha (último asiento del día por
    posting_datetime/creation, igual que el orden canónico de ERPNext) desde
    `desde` en adelante. Devuelve los días que cierran en negativo."""
    condicion = " OR ".join(["(sle.item_code = %s AND sle.warehouse = %s)"] * len(pares))
    valores = [v for par in pares for v in par] + [getdate(desde)]
    rows = frappe.db.sql(
        f"""
        SELECT item_code, warehouse, posting_date, qty_after_transaction
        FROM (
            SELECT sle.item_code, sle.warehouse, sle.posting_date, sle.qty_after_transaction,
                   ROW_NUMBER() OVER (
                       PARTITION BY sle.item_code, sle.warehouse, sle.posting_date
                       ORDER BY sle.posting_datetime DESC, sle.creation DESC
                   ) AS rn
            FROM `tabStock Ledger Entry` sle
            WHERE sle.is_cancelled = 0 AND ({condicion}) AND sle.posting_date >= %s
        ) cierre
        WHERE rn = 1 AND qty_after_transaction < 0
        ORDER BY posting_date, item_code
        """,
        valores,
        as_dict=True,
    )
    # Igual que ERPNext (is_negative_with_precision): -0.0003 con precisión 3
    # no es un faltante real.
    precision = cint(frappe.db.get_default("float_precision")) or 2
    faltantes = []
    for r in rows:
        qty = flt(r.qty_after_transaction, precision)
        if qty < 0 and abs(qty) > 0.0001:
            r.faltante = abs(qty)
            faltantes.append(r)
    return faltantes


def _mensaje(faltantes: list) -> str:
    lineas = []
    for r in faltantes[:MAX_FALTANTES]:
        nombre = frappe.get_cached_value("Item", r.item_code, "item_name") or ""
        etiqueta = f"{r.item_code} — {nombre}" if nombre and nombre != r.item_code else r.item_code
        lineas.append(
            "<li>Faltan <b>{}</b> de <b>{}</b> en <b>{}</b> al cierre del <b>{}</b>.</li>".format(
                flt(r.faltante), frappe.utils.escape_html(etiqueta),
                frappe.utils.escape_html(r.warehouse), formatdate(r.posting_date),
            )
        )
    restantes = len(faltantes) - len(lineas)
    if restantes > 0:
        lineas.append(f"<li>… y {restantes} caso(s) más.</li>")
    return (
        "El inventario quedaría negativo al cierre del día:<ul>"
        + "".join(lineas)
        + "</ul>La hora de los documentos ya no influye, pero la fecha sí: "
        "registre la entrada o el traslado con una fecha igual o anterior a la del movimiento."
    )


def validar_saldo_por_fecha(doc, method=None):
    """Hook on_submit / on_cancel de todos los documentos de inventario.

    Reemplaza el bloqueo nativo (que compara el saldo en el instante exacto del
    documento) por el saldo al cierre de la fecha del documento y de cualquier
    fecha posterior. Al lanzar la excepción aquí, dentro de la misma
    transacción en la que ERPNext acaba de escribir los asientos, el
    movimiento completo se revierte — igual que el `NegativeStockError` nativo.
    """
    if not validacion_por_fecha_activa() or doc.doctype not in DOCTYPES_INVENTARIO:
        return
    if doc.flags.get("facex_omitir_validacion_fecha"):
        return
    pares = _pares_afectados(doc)
    if not pares:
        return
    faltantes = _dias_negativos(pares, doc.get("posting_date"))
    if faltantes:
        from erpnext.stock.stock_ledger import NegativeStockError

        frappe.throw(_mensaje(faltantes), NegativeStockError, title="Existencia insuficiente")


# ---------------------------------------------------------------------------
# after_migrate
# ---------------------------------------------------------------------------

def ensure_validacion_por_fecha():
    """after_migrate: crea el interruptor en Stock Settings y, mientras esté
    encendido, mantiene «Permitir Stock Negativo» marcado — es lo que apaga el
    bloqueo nativo punto-en-el-tiempo que esta validación sustituye.

    El interruptor se enciende solo en la primera migración (cuando el valor
    nunca se ha guardado). Si alguien lo desmarca a propósito, se respeta.
    """
    from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

    create_custom_fields({"Stock Settings": [{
        "fieldname": "bfel_validar_por_fecha",
        "label": "Validar inventario por fecha (FacEx)",
        "fieldtype": "Check",
        "insert_after": "allow_negative_stock",
        "default": "1",
        "description": (
            "Las entradas se asientan al inicio del día y la existencia se valida al "
            "cierre de cada fecha, no a la hora de cada documento. Requiere «Permitir "
            "Stock Negativo» marcado (FacEx lo mantiene marcado mientras esto esté activo)."
        ),
    }]}, update=True)

    # `get_single_value` castea el Check vacío a 0, así que «nunca configurado»
    # se distingue solo por la ausencia de la fila en tabSingles.
    guardado = frappe.db.sql(
        "SELECT value FROM `tabSingles` WHERE doctype = %s AND field = %s",
        ("Stock Settings", "bfel_validar_por_fecha"),
    )
    if not guardado:
        frappe.db.set_single_value("Stock Settings", "bfel_validar_por_fecha", 1)
        activa = True
    else:
        activa = bool(cint(guardado[0][0]))

    if activa and not cint(frappe.db.get_single_value("Stock Settings", "allow_negative_stock")):
        frappe.db.set_single_value("Stock Settings", "allow_negative_stock", 1)

    _blindar_allow_negative_stock(activa)
    frappe.clear_cache(doctype="Stock Settings")


def _blindar_allow_negative_stock(activa: bool):
    """«Permitir Stock Negativo» queda en solo lectura mientras FacEx valide por
    fecha: desmarcarlo no devolvería la protección, dejaría el sistema con el
    bloqueo nativo por hora *y* sin el de FacEx. Si se apaga el interruptor, el
    campo vuelve a ser editable para poder restaurar el comportamiento nativo.
    """
    propiedades = {
        "read_only": ("Check", 1),
        "description": ("Text", (
            "Lo administra FacEx: la existencia se valida al cierre de cada día "
            "(ver «Validar inventario por fecha»), no a la hora de cada documento. "
            "Este check es el interruptor de la validación nativa por hora; "
            "desmarcarlo aquí no impide los saldos negativos, solo devuelve los "
            "cruces de horarios."
        )),
    }
    for propiedad, (tipo, valor) in propiedades.items():
        existente = frappe.db.exists("Property Setter", {
            "doc_type": "Stock Settings",
            "field_name": "allow_negative_stock",
            "property": propiedad,
        })
        if activa:
            frappe.make_property_setter(
                {
                    "doctype": "Stock Settings",
                    "fieldname": "allow_negative_stock",
                    "property": propiedad,
                    "value": valor,
                    "property_type": tipo,
                },
                is_system_generated=False,
                validate_fields_for_doctype=False,
            )
        elif existente:
            frappe.delete_doc("Property Setter", existente, ignore_permissions=True)
