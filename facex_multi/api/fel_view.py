# -*- coding: utf-8 -*-
"""Vista de certificación FEL que respeta el modo de los cargos FacEx.

Problema
--------
La vista que usa brainfel para certificar (`v_bfel_sales_invoice_fact`) arma:

    Items_Total      = sii.amount                  (líneas, sin cargos)
    Totales_GranTotal = si.grand_total             (CON los cargos)
    TotalIVA          = Σ TODAS las filas de `taxes`  (CON los cargos)

Con el recargo por entrega y el flete como filas de cargos eso rompe por dos
lados: el GranTotal no cuadra con la suma de las líneas (sobra el cargo) y el
cargo se declara como si fuera IVA, así que el impuesto por línea no suma el
TotalIVA y SAT rechaza el documento.

Solución
--------
Una vista NUEVA que ENVUELVE la que ya funciona, sin tocarla (requisito
explícito: la vista en producción no se modifica). Envolver en vez de duplicar
tiene tres ventajas: hereda toda la lógica de DIGECAM, adendas y frases; sirve
igual en facex y en disfavil aunque sus vistas base sean distintas; y se genera
desde código leyendo las columnas reales de cada sitio.

Reglas, iguales para los dos modos de cargo:

  * Un cargo PASARELA no se documenta: se resta del GranTotal y del TotalIVA.
    Resultado: GranTotal = Σ líneas (= `si.total`) y TotalIVA = el IVA de la
    plantilla, que es exactamente lo nativo de ERPNext. Verificado en neko:
    `venta_neta == total de líneas` al centavo en todas las facturas.
  * Un cargo PARTE DE LA VENTA sí se documenta, prorrateado entre las líneas en
    proporción al total de cada línea (`sii.amount`), como pidió el usuario. El
    renglón de mayor `idx` absorbe el residuo del redondeo para que la suma de
    las líneas cuadre con el GranTotal al centavo.

Una sola expresión gobierna ambos: se excluyen del total las filas de cargo con
`facex_cargo_es_venta = 0` y se prorratean las que están en 1.

Cómo se activa
--------------
NO se activa sola. Hay que apuntar a la vista nueva en los dos lugares donde
brainfel resuelve el dataset:
  * `BFEL Settings.sql_func_certificar` (por compañía habilitada), y
  * `BFEL Document Map.sql_function`, si el mapa de ese tipo de documento trae
    su propia vista.
`switch_bfel_to_cargos_view()` lo hace y `bfel_view_status()` muestra cómo está
cada uno. Se dejan explícitos porque cambiar la vista cambia lo que se le manda
a SAT.

Advertencia conocida (documentos mixtos): el prorrateo reparte el cargo entre
TODAS las líneas, también las exentas. En un documento que mezcle gravado y
exento, parte del cargo queda declarada como exenta. Es lo que pidió el usuario
(proporcional por total de línea) y es consistente, pero si una compañía va a
usar el modo "parte de la venta" con documentos mixtos hay que validarlo con el
contador antes.
"""
from __future__ import annotations

import frappe

# La que brainfel lee de verdad es `sql_func_certificar` (el valor del campo del
# mismo nombre en BFEL Settings es literalmente ese: hay una VISTA llamada así).
# Hoy es un passthrough columna por columna sobre `v_bfel_sales_invoice_fact`,
# pero la envolvente se apoya en ella y no en la de abajo, para heredar cualquier
# lógica que se le agregue en esa capa.
BASE_VIEW = "sql_func_certificar"
BASE_VIEW_FALLBACK = "v_bfel_sales_invoice_fact"
CARGOS_VIEW = "v_bfel_sales_invoice_fact_cargos"

# Columnas que la vista envolvente recalcula; el resto pasa tal cual.
_OVERRIDE = (
    "Items_Total",
    "Items_Precio",
    "Items_PrecioUnitario",
    "Items_IVA_MontoGravable",
    "Items_IVA_MontoImpuesto",
    "Totales_GranTotal",
    "Totales_TotalIVA_TotalMontoImpuesto",
)

# Clave de factura y de línea dentro de la vista base.
_KEY_DOC = "Next_Identificador"
_KEY_LINE = "Items_NumeroLinea"


def _base_columns(base: str) -> list:
    rows = frappe.db.sql(
        """
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s
        ORDER BY ORDINAL_POSITION
        """,
        base,
        as_dict=True,
    )
    return [r["COLUMN_NAME"] for r in rows]


def resolve_base(base: str = None) -> str:
    """Vista sobre la que se envuelve: la que brainfel lee, si existe en este
    sitio, y si no la de abajo. Explícito gana sobre la detección."""
    if base:
        return base
    for candidata in (BASE_VIEW, BASE_VIEW_FALLBACK):
        if _base_columns(candidata):
            return candidata
    return BASE_VIEW


def build_sql(base: str = None, target: str = CARGOS_VIEW) -> str:
    """SQL del CREATE OR REPLACE VIEW, generado desde las columnas reales de
    `base` en ESTE sitio (facex y disfavil no tienen la misma vista)."""
    base = resolve_base(base)
    cols = _base_columns(base)
    if not cols:
        frappe.throw(
            f"La vista base «{base}» no existe en este sitio. "
            "La vista de cargos se construye envolviéndola, así que primero debe existir."
        )
    faltan = [c for c in (_OVERRIDE + (_KEY_DOC, _KEY_LINE)) if c not in cols]
    if faltan:
        frappe.throw(
            f"La vista base «{base}» no trae las columnas {faltan}. "
            "Se abortó para no generar una vista que mande datos incompletos a SAT."
        )

    # Las columnas que no recalculamos viajan intactas desde la capa interna.
    passthrough = ",\n       ".join(
        f"`s`.`{c}`" for c in cols if c not in _OVERRIDE
    )

    # Agregados por factura:
    #   fx_pasarela     cargos que NO se documentan (modo pasarela)
    #   fx_cargo_venta  cargos que SÍ son venta y se prorratean entre las líneas
    #   fx_lineas       Σ sii.amount — la base del prorrateo
    agregados = """
        SELECT si.name AS fx_doc,
               COALESCE(SUM(CASE WHEN IFNULL(t.facex_tipo_cargo, '') != ''
                                  AND IFNULL(t.facex_cargo_es_venta, 0) = 0
                                 THEN t.tax_amount END), 0) AS fx_pasarela,
               COALESCE(SUM(CASE WHEN IFNULL(t.facex_tipo_cargo, '') != ''
                                  AND IFNULL(t.facex_cargo_es_venta, 0) = 1
                                 THEN t.tax_amount END), 0) AS fx_cargo_venta,
               -- Parte NETA de los cargos que son venta: es INGRESO, no impuesto.
               -- `total_taxes_and_charges` de ERPNext la mete en el total de
               -- impuestos (son filas de `taxes`), así que hay que sacarla del
               -- TotalIVA o se declararía como IVA lo que es venta.
               COALESCE(SUM(CASE WHEN IFNULL(t.facex_cargo_es_venta, 0) = 1
                                  AND t.facex_tipo_cargo IN ('Recargo', 'Flete')
                                 THEN t.tax_amount END), 0) AS fx_venta_neto
        FROM `tabSales Invoice` si
        LEFT JOIN `tabSales Taxes and Charges` t
               ON t.parent = si.name AND t.parenttype = 'Sales Invoice'
        GROUP BY si.name
    """

    # Todo lo que viene del LEFT JOIN va con COALESCE: si una factura de la vista
    # base no tuviera fila de agregados, el resultado sería NULL y la vista
    # mandaría un documento sin totales a SAT. Degradar a «sin cargos, factor 1»
    # deja el documento igual que la vista base, que es el fallo seguro.
    pasarela = "COALESCE(`f`.`fx_pasarela`, 0)"
    venta_neto = "COALESCE(`f`.`fx_venta_neto`, 0)"
    factor = "COALESCE(`f`.`fx_factor`, 1)"
    cargo_venta = "COALESCE(`f`.`fx_cargo_venta`, 0)"
    lineas = "COALESCE(`f`.`fx_lineas`, 0)"
    iva_incluido = "COALESCE(`f`.`fx_iva_incluido`, 0)"

    # GranTotal del documento.
    #
    # Camino normal: el de la vista base menos el cargo pasarela, que no se
    # documenta.
    #
    # Corrección del REDONDEO: con IVA incluido en el precio, `grand_total` se
    # recalcula como net_total + impuestos y se desvía unos centavos de la suma
    # de las líneas (`si.total`) — p. ej. Q11,651.94 contra Q11,652.00. Esa
    # diferencia la absorbe `rounding_adjustment`, y lo que el cliente paga es
    # `rounded_total`, que SÍ coincide con la suma de las líneas. Cuando la
    # desviación es de ese orden (≤ Q0.15) se declara la suma de las líneas: así
    # el documento cuadra exacto y no hay que retocar ningún renglón.
    #
    # No se usa `rounded_total` directamente: hay facturas donde el redondeo mueve
    # el total de verdad (facex FCAM-FE-0006: líneas 7.23, rounded 7.00) y
    # declararlo obligaría a cambiar el precio de la línea. Por eso la tolerancia
    # y el guardia de `discount_amount`: con un descuento global `si.total` ya no
    # es el total del documento y se cae al camino normal.
    lineas_mas_venta = f"ROUND({lineas} + {cargo_venta}, 6)"
    gran_base = f"ROUND(`b`.`Totales_GranTotal` - {pasarela}, 6)"
    gran = (
        f"(CASE WHEN {iva_incluido} = 1 AND COALESCE(`f`.`fx_descuento`, 0) = 0"
        f"       AND ABS({gran_base} - {lineas_mas_venta}) <= 0.15"
        f"      THEN {lineas_mas_venta} ELSE {gran_base} END)"
    )
    # TotalIVA = total de impuestos de la vista base, menos los cargos pasarela
    # (no se documentan) y menos la parte NETA de los cargos que son venta (es
    # ingreso, y ya quedó prorrateada dentro de las líneas). Lo que queda es el
    # IVA de la plantilla más el IVA de esos cargos, que es lo correcto.
    iva = (f"ROUND(`b`.`Totales_TotalIVA_TotalMontoImpuesto` - {pasarela} - {venta_neto}, 6)")

    # `si.total` es Σ sii.amount: la base del prorrateo. Se lee de la factura y no
    # de la vista para no depender de que la vista base exponga todas las líneas.
    return f"""
CREATE OR REPLACE VIEW `{target}` AS
SELECT {passthrough},
       CAST(ROUND(`s`.`fx_it` + `s`.`fx_res_it`, 6) AS DECIMAL(19,6)) AS `Items_Total`,
       CAST(ROUND(`s`.`fx_it` + `s`.`fx_res_it`, 6) AS DECIMAL(19,6)) AS `Items_Precio`,
       CAST(ROUND((`s`.`fx_it` + `s`.`fx_res_it`)
                  / NULLIF(`s`.`Items_Cantidad`, 0), 6) AS DECIMAL(19,6)) AS `Items_PrecioUnitario`,
       CAST(ROUND(`s`.`fx_grav` + `s`.`fx_res_grav`, 6) AS DECIMAL(19,6)) AS `Items_IVA_MontoGravable`,
       CAST(ROUND(`s`.`fx_imp` + `s`.`fx_res_imp`, 6) AS DECIMAL(19,6)) AS `Items_IVA_MontoImpuesto`,
       `s`.`fx_gran` AS `Totales_GranTotal`,
       `s`.`fx_iva` AS `Totales_TotalIVA_TotalMontoImpuesto`
FROM (
    SELECT `w`.*,
           -- El renglón de mayor idx absorbe el residuo del redondeo para que
           -- Σ líneas cuadre con el GranTotal al centavo.
           CASE WHEN `w`.`fx_ultima` = 1
                THEN `w`.`fx_meta_it` - SUM(`w`.`fx_it`) OVER (PARTITION BY `w`.`fx_doc_key`)
                ELSE 0 END AS `fx_res_it`,
           CASE WHEN `w`.`fx_ultima` = 1
                THEN `w`.`fx_meta_grav` - SUM(`w`.`fx_grav`) OVER (PARTITION BY `w`.`fx_doc_key`)
                ELSE 0 END AS `fx_res_grav`,
           CASE WHEN `w`.`fx_ultima` = 1
                THEN `w`.`fx_meta_imp` - SUM(`w`.`fx_imp`) OVER (PARTITION BY `w`.`fx_doc_key`)
                ELSE 0 END AS `fx_res_imp`
    FROM (
        SELECT `b`.*,
               `b`.`{_KEY_DOC}` AS `fx_doc_key`,
               ROW_NUMBER() OVER (PARTITION BY `b`.`{_KEY_DOC}`
                                  ORDER BY `b`.`{_KEY_LINE}` DESC) AS `fx_ultima`,
               -- Factor de prorrateo: 1 cuando no hay cargo que sea venta.
               ROUND(`b`.`Items_Total` * {factor}, 6) AS `fx_it`,
               ROUND(`b`.`Items_IVA_MontoGravable` * {factor}, 6) AS `fx_grav`,
               ROUND(`b`.`Items_IVA_MontoImpuesto` * {factor}, 6) AS `fx_imp`,
               -- Metas por documento: lo que deben sumar las líneas ya escaladas.
               -- Con IVA INCLUIDO en el precio (lo normal en Guatemala, y lo que
               -- SAT valida) la meta es el total del documento, así que Σ líneas
               -- == GranTotal y Σ impuesto == TotalIVA quedan exactos por
               -- construcción: el residuo del último renglón absorbe tanto el
               -- prorrateo como el centavo de redondeo por línea.
               -- Con IVA NO incluido (`net_total == total`) las líneas van sin
               -- impuesto, así que la meta es solo líneas + cargo prorrateado y
               -- el IVA se escala; ahí GranTotal != Σ líneas por diseño.
               CASE WHEN {iva_incluido} = 1 THEN {gran}
                    ELSE ROUND({lineas} + {cargo_venta}, 6) END AS `fx_meta_it`,
               -- El impuesto por línea SIEMPRE debe sumar el TotalIVA declarado:
               -- es lo que SAT valida, y no se cumple solo con escalar el IVA de
               -- la vista base (el cargo que es venta trae su propio IVA, que no
               -- es proporcional a las líneas).
               {iva} AS `fx_meta_imp`,
               -- Con IVA incluido, gravable = total de la línea − su impuesto;
               -- sin IVA incluido la línea ya va neta y ella misma es el gravable.
               CASE WHEN {iva_incluido} = 1
                    THEN ROUND({gran} - {iva}, 6)
                    ELSE ROUND({lineas} + {cargo_venta}, 6) END AS `fx_meta_grav`,
               -- Un cargo pasarela no se documenta: fuera del total y del IVA.
               CAST({gran} AS DECIMAL(19,6)) AS `fx_gran`,
               CAST({iva} AS DECIMAL(19,6)) AS `fx_iva`
        FROM `{base}` `b`
        LEFT JOIN (
            SELECT `a`.`fx_doc`, `a`.`fx_pasarela`, `a`.`fx_cargo_venta`, `a`.`fx_venta_neto`,
                   COALESCE(`si2`.`total`, 0) AS `fx_lineas`,
                   -- ¿El precio de la línea ya trae el IVA? Se lee de la bandera
                   -- `included_in_print_rate` de la fila de impuesto, no de
                   -- comparar total con net_total: en un documento EXENTO esos dos
                   -- son iguales (el IVA es 0) y la comparación lo tomaría por
                   -- IVA-no-incluido, declarando mal el gravable. Verificado:
                   -- en neko las 191 facturas están en 1, y en facex las únicas
                   -- dos en 0 son justo las que la vista base ya descuadra.
                   COALESCE(`inc`.`incluido`, 1) AS `fx_iva_incluido`,
                   -- Con descuento global `si.total` deja de ser el total del
                   -- documento, así que la corrección de redondeo no aplica.
                   IFNULL(`si2`.`discount_amount`, 0) AS `fx_descuento`,
                   CASE WHEN COALESCE(`si2`.`total`, 0) > 0
                        THEN (`si2`.`total` + `a`.`fx_cargo_venta`) / `si2`.`total`
                        ELSE 1 END AS `fx_factor`
            FROM ({agregados}) `a`
            JOIN `tabSales Invoice` `si2` ON `si2`.`name` = `a`.`fx_doc`
            LEFT JOIN (
                SELECT t2.parent, MAX(t2.included_in_print_rate) AS incluido
                FROM `tabSales Taxes and Charges` t2
                WHERE t2.parenttype = 'Sales Invoice' AND IFNULL(t2.facex_tipo_cargo, '') = ''
                GROUP BY t2.parent
            ) `inc` ON `inc`.`parent` = `a`.`fx_doc`
        ) `f` ON `f`.`fx_doc` = `b`.`{_KEY_DOC}`
    ) `w`
) `s`
"""


@frappe.whitelist()
def create_cargos_view(base: str = None, target: str = CARGOS_VIEW) -> dict:
    """Crea/actualiza la vista envolvente. No cambia la configuración de brainfel:
    hay que apuntarla con `switch_bfel_to_cargos_view` cuando se vaya a usar."""
    frappe.only_for("System Manager")
    base = resolve_base(base)
    frappe.db.sql_ddl(build_sql(base, target))
    frappe.db.commit()
    return {"view": target, "base": base, "columnas": len(_base_columns(target))}


@frappe.whitelist()
def check_cargos_view(target: str = CARGOS_VIEW, base: str = None, limit: int = 2000) -> dict:
    """Cuadra la vista nueva contra lo nativo de ERPNext, documento por documento.

    Lo que la vista PROMETE y aquí se exige:
      1. GranTotal      == si.grand_total − cargos pasarela
      2. TotalIVA       == si.total_taxes_and_charges − cargos pasarela
                           − la parte NETA de los cargos que son venta
      3. Σ Items_Total  == GranTotal con IVA incluido en el precio, o
                           si.total + cargos que son venta cuando no lo está.

    Aparte se informan (sin fallar) las facturas con `rounded_total` distinto de
    `grand_total`: ahí Σ líneas nunca va a igualar el GranTotal y SAT las
    rechazaría. Es preexistente y ajeno a los cargos; ver el comentario de
    `build_sql` sobre por qué no se corrige aquí.

    Y el cuadre que le importa a SAT —GranTotal == Σ Items_Total— se mide
    CONTRA LA VISTA BASE, no en absoluto: solo cuenta como falla si la base
    cuadraba y la nueva no (una regresión nuestra). Hay documentos con IVA NO
    incluido en el precio (`included_in_print_rate = 0`) donde grand_total =
    total + IVA, así que Σ líneas nunca iguala el GranTotal; esa diferencia ya
    existe en la vista base y no la introduce esta.
    """
    base = resolve_base(base)
    rows = frappe.db.sql(
        f"""
        SELECT v.`Next_Identificador` AS inv,
               MAX(v.`Totales_GranTotal`) AS gran,
               MAX(v.`Totales_TotalIVA_TotalMontoImpuesto`) AS iva,
               ROUND(SUM(v.`Items_Total`), 2) AS suma_lineas,
               MAX(b.`Totales_GranTotal`) AS gran_base,
               ROUND(SUM(b.`Items_Total`), 2) AS suma_base,
               MAX(si.total) AS si_total,
               MAX(si.grand_total) AS si_grand,
               MAX(CASE WHEN IFNULL(si.disable_rounded_total, 0) = 0 AND si.rounded_total != 0
                        THEN si.rounded_total ELSE si.grand_total END) AS si_cobrable,
               MAX(si.total_taxes_and_charges) AS si_tax,
               MAX(CASE WHEN ABS(IFNULL(si.net_total,0) - IFNULL(si.total,0)) > 0.005
                        THEN 1 ELSE 0 END) AS iva_incluido,
               COALESCE(MAX(c.pasarela), 0) AS pasarela,
               COALESCE(MAX(c.venta), 0) AS cargo_venta,
               COALESCE(MAX(c.venta_neto), 0) AS cargo_venta_neto
        FROM `{target}` v
        JOIN `{base}` b ON b.`Next_Identificador` = v.`Next_Identificador`
                       AND b.`{_KEY_LINE}` = v.`{_KEY_LINE}`
        JOIN `tabSales Invoice` si ON si.name = v.`Next_Identificador`
        LEFT JOIN (
            SELECT t.parent,
                   COALESCE(SUM(CASE WHEN IFNULL(t.facex_cargo_es_venta, 0) = 0 THEN t.tax_amount END), 0) AS pasarela,
                   COALESCE(SUM(CASE WHEN IFNULL(t.facex_cargo_es_venta, 0) = 1 THEN t.tax_amount END), 0) AS venta,
                   COALESCE(SUM(CASE WHEN IFNULL(t.facex_cargo_es_venta, 0) = 1
                                      AND t.facex_tipo_cargo IN ('Recargo', 'Flete')
                                     THEN t.tax_amount END), 0) AS venta_neto
            FROM `tabSales Taxes and Charges` t
            WHERE t.parenttype = 'Sales Invoice' AND IFNULL(t.facex_tipo_cargo, '') != ''
            GROUP BY t.parent
        ) c ON c.parent = v.`Next_Identificador`
        GROUP BY v.`Next_Identificador`
        LIMIT %(limit)s
        """,
        {"limit": int(limit)},
        as_dict=True,
    )

    def _f(v):
        return float(v or 0)

    fallos, avisos, redondeo = [], [], []
    con_cargo = 0
    for r in rows:
        pas = _f(r["pasarela"])
        if pas or _f(r["cargo_venta"]):
            con_cargo += 1
        problemas = []
        # Dos formas válidas del GranTotal: el de la vista base menos la
        # pasarela, o —cuando el redondeo lo desvió unos centavos de las
        # líneas— la suma de las líneas. Ver el comentario de `build_sql`.
        esperado_gran = round(_f(r["si_grand"]) - pas, 2)
        esperado_lineas_gran = round(_f(r["si_total"]) + _f(r["cargo_venta"]), 2)
        admisibles = [esperado_gran]
        if abs(esperado_gran - esperado_lineas_gran) <= 0.15:
            admisibles.append(esperado_lineas_gran)
        if not any(abs(_f(r["gran"]) - e) <= 0.015 for e in admisibles):
            problemas.append(
                f"GranTotal {_f(r['gran'])} no es ni grand_total−pasarela {esperado_gran} "
                f"ni la suma de líneas {esperado_lineas_gran}")
        esperado_iva = round(_f(r["si_tax"]) - pas - _f(r["cargo_venta_neto"]), 2)
        if abs(_f(r["iva"]) - esperado_iva) > 0.015:
            problemas.append(
                f"TotalIVA {_f(r['iva'])} != impuestos−pasarela−neto_venta {esperado_iva}")
        # Preexistente y ajeno a los cargos: si el redondeo mueve el total, Σ
        # líneas no puede igualar el GranTotal y SAT rechazaría el documento.
        if abs(_f(r["si_cobrable"]) - _f(r["si_grand"])) > 0.005:
            redondeo.append({
                "factura": r["inv"],
                "grand_total": _f(r["si_grand"]),
                "rounded_total": _f(r["si_cobrable"]),
                "nota": "el redondeo mueve el total; SAT rechazaría porque Σ líneas no cuadra",
            })
        # Con IVA incluido en el precio las líneas deben sumar el GranTotal; sin
        # IVA incluido van netas, así que suman total + el cargo prorrateado.
        if int(r["iva_incluido"] or 0):
            # Con IVA incluido, las líneas deben sumar exactamente el GranTotal
            # declarado: es lo que SAT valida.
            esperado_lineas, etiqueta = _f(r["gran"]), "GranTotal"
        else:
            esperado_lineas, etiqueta = esperado_lineas_gran, "total+cargo_venta"
        if abs(_f(r["suma_lineas"]) - esperado_lineas) > 0.015:
            problemas.append(f"Σ líneas {_f(r['suma_lineas'])} != {etiqueta} {esperado_lineas}")
        # Regresión del cuadre SAT: la base cuadraba y la nueva no.
        base_cuadra = abs(_f(r["gran_base"]) - _f(r["suma_base"])) <= 0.015
        nueva_cuadra = abs(_f(r["gran"]) - _f(r["suma_lineas"])) <= 0.015
        if base_cuadra and not nueva_cuadra:
            problemas.append(
                f"REGRESIÓN SAT: GranTotal {_f(r['gran'])} != Σ líneas {_f(r['suma_lineas'])} "
                f"(la vista base sí cuadraba)")
        elif not base_cuadra:
            avisos.append({
                "factura": r["inv"],
                "nota": (f"la vista BASE ya estaba descuadrada (GranTotal {_f(r['gran_base'])} vs "
                         f"Σ líneas {_f(r['suma_base'])}); suele ser IVA no incluido en el precio"),
            })
        if problemas:
            fallos.append({"factura": r["inv"], "problemas": problemas})
    return {
        "revisadas": len(rows),
        "con_cargos": con_cargo,
        "fallos": fallos,
        "avisos_preexistentes": avisos,
        "avisos_redondeo": redondeo,
        "ok": not fallos,
    }


@frappe.whitelist()
def bfel_view_status() -> dict:
    """Qué vista tiene configurada hoy cada BFEL Settings y cada Document Map."""
    out = {"settings": [], "document_map": [], "vista_cargos_existe": bool(_base_columns(CARGOS_VIEW))}
    for row in frappe.get_all("BFEL Settings", fields=["name", "company", "enabled", "sql_func_certificar"]):
        out["settings"].append(dict(row))
    if frappe.db.table_exists("BFEL Document Map"):
        meta = frappe.get_meta("BFEL Document Map")
        fields = ["name", "erpnext_doctype", "type_docdte"]
        if meta.has_field("sql_function"):
            fields.append("sql_function")
        out["document_map"] = [dict(r) for r in frappe.get_all("BFEL Document Map", fields=fields)]
    return out


@frappe.whitelist()
def switch_bfel_to_cargos_view(company: str = None, target: str = CARGOS_VIEW,
                               revert_to: str = None) -> dict:
    """Apunta brainfel a la vista nueva (o la devuelve a `revert_to`).

    Toca los DOS lugares donde brainfel resuelve el dataset: `BFEL Settings`
    (`sql_func_certificar`) y `BFEL Document Map` (`sql_function`), porque si el
    mapa del tipo de documento trae su propia vista, esa gana.

    Se llama a mano: cambiar la vista cambia lo que se le manda a SAT, así que no
    debe pasar por un `after_migrate`.
    """
    frappe.only_for("System Manager")
    nuevo = revert_to or target
    if not revert_to and not _base_columns(target):
        frappe.throw(f"La vista «{target}» no existe todavía. Corra create_cargos_view primero.")

    # Valores que se consideran "la vista de siempre" y por tanto se pueden
    # reapuntar. Cualquier otro valor es una personalización y se respeta.
    conocidos = (BASE_VIEW, BASE_VIEW_FALLBACK, CARGOS_VIEW)

    cambios, respetados = [], []
    filtros = {"company": company} if company else {}
    for row in frappe.get_all("BFEL Settings", filters=filtros,
                              fields=["name", "company", "sql_func_certificar"]):
        actual = row.sql_func_certificar
        if actual == nuevo:
            continue
        if actual and actual not in conocidos:
            respetados.append(f"BFEL Settings {row.name} ({row.company}) apunta a «{actual}», "
                              "que no es la vista estándar: se dejó igual.")
            continue
        frappe.db.set_value("BFEL Settings", row.name, "sql_func_certificar", nuevo)
        cambios.append(f"BFEL Settings {row.name} ({row.company}): {actual} → {nuevo}")

    if frappe.db.table_exists("BFEL Document Map") and frappe.get_meta("BFEL Document Map").has_field("sql_function"):
        for row in frappe.get_all("BFEL Document Map", fields=["name", "sql_function", "type_docdte"]):
            actual = row.sql_function
            if actual == nuevo:
                continue
            if actual and actual not in conocidos:
                respetados.append(f"BFEL Document Map {row.name} ({row.type_docdte}) apunta a "
                                  f"«{actual}»: se dejó igual.")
                continue
            frappe.db.set_value("BFEL Document Map", row.name, "sql_function", nuevo)
            cambios.append(f"BFEL Document Map {row.name} ({row.type_docdte}): {actual} → {nuevo}")

    frappe.db.commit()
    return {
        "vista": nuevo,
        "cambios": cambios or ["(nada que cambiar)"],
        "respetados": respetados,
    }
