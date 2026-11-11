# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import difflib

import frappe
from frappe.model.document import Document
from frappe.utils import flt

from facex_multi.api.invoice import (
	FORMA_PAGO_LIQUIDACION,
	_create_payment_entry,
	_clave_guia,
	_norm_numero_guia,
	_sync_pago_facex,
	clean_numero_guia,
	get_effective_company,
)
from facex_multi.api.permissions import (
	get_facex_can_upload_liquidaciones_transporte,
	get_facex_liquidacion_especial,
)


def _release_or_keep_payment_entry(payment_entry):
	# Un PE ya sometido en Contabilidad no se toca (requiere reversión manual
	# allá); uno en borrador sí se descarta aquí porque este mismo validate()
	# lo recrea con los montos/match actuales — evita duplicarlo y evita que
	# quede desactualizado si la fila cambió.
	if not payment_entry:
		return None
	docstatus = frappe.db.get_value("Payment Entry", payment_entry, "docstatus")
	if docstatus is None:
		return None
	if docstatus == 1:
		return payment_entry
	if docstatus == 2:
		# Ya fue revertido en Contabilidad (queda como rastro de la reversión):
		# la fila se suelta y, si sigue habiendo match, genera un abono nuevo.
		return None
	frappe.delete_doc("Payment Entry", payment_entry, ignore_permissions=True, force=True)
	return None


def _assert_payment_entry_reversible(payment_entry, guia, accion):
	"""El abono del match se somete automáticamente (la factura queda pagada de
	verdad), así que desligar esa fila —quitarla del detalle o cambiarle el
	transportista— dejaría el pago huérfano en Contabilidad: un abono sin
	liquidación que lo respalde. Se bloquea y se ofrecen las dos salidas
	explícitas: revertir el pago allá, o eliminar la liquidación completa desde
	Mantenimiento (esa vía sí revierte sus abonos, ver
	api.invoice.delete_liquidacion_transporte)."""
	if not payment_entry:
		return
	if frappe.db.get_value("Payment Entry", payment_entry, "docstatus") == 1:
		frappe.throw(
			f"No se puede {accion}: la guía <b>{frappe.utils.escape_html(guia or '')}</b> tiene el "
			f"pago <b>{frappe.utils.escape_html(payment_entry)}</b> ya sometido en Contabilidad. "
			"Reviértalo allá primero, o elimine la liquidación completa (Mantenimiento), "
			"que sí revierte sus abonos.",
			title="Pago sometido",
		)


# ── Búsqueda tolerante de guías ────────────────────────────────────────────
# La guía de la liquidación se busca por su CLAVE (solo letras y dígitos, ver
# api.invoice._clave_guia): «419566215-1» y «4195662151» son la misma guía.
# Sobre los candidatos con la misma clave se calcula un % de coincidencia:
#
#   * Guía (60%): 100 si es idéntica, 95 si solo difiere en guiones/espacios.
#   * Monto (40%): Monto COD de la fila (o Efectivo si viene vacío) contra el
#     Monto COD capturado en la guía y contra el total de la factura; vale el
#     que más se parezca. 100 si cuadra al centavo, baja 5 puntos por cada 1%
#     de diferencia (20% o más de diferencia = 0).
#
# Sin monto que comparar, el % es solo el de la guía.
# El monto también desempata: si la misma clave está en varias facturas y solo
# una cuadra al centavo con el monto, esa es la del match.
#
# Una guía que NO comparte clave con ninguna registrada nunca se concilia sola
# (el match somete el abono en el acto); solo se sugiere la más parecida en el
# mensaje de error para que el usuario la corrija.

PESO_GUIA = 0.6
PESO_MONTO = 0.4
PUNTOS_GUIA_EXACTA = 100
PUNTOS_GUIA_SIN_SEPARADORES = 95
SIMILITUD_MINIMA_SUGERENCIA = 0.8


def _indice_guias_registradas(transportista):
	"""Guías capturadas en facturas para el transportista, indexadas por clave
	tolerante → lista de {name, parent, monto_cod, numero_guia, liquidado,
	grand_total}. Mismo criterio que usa match_guias, así que «está registrada»
	aquí equivale a «match_guias la va a encontrar»."""
	indice = {}
	for g in frappe.db.sql(
		"""
		select g.name, g.parent, g.monto_cod, g.numero_guia, g.liquidado,
		       si.grand_total
		from `tabFacEx Guia Transportista` g
		left join `tabSales Invoice` si on si.name = g.parent
		where g.transportista = %s
		""",
		transportista,
		as_dict=True,
	):
		clave = _clave_guia(g.numero_guia)
		if clave:
			indice.setdefault(clave, []).append(g)
	return indice


def _monto_fila(monto_cod, efectivo=None):
	return flt(monto_cod) or flt(efectivo)


def _puntaje_monto(monto, cand):
	"""(puntos 0–100 o None si no hay qué comparar, texto)."""
	refs = [
		("Monto COD de la guía", flt(cand.monto_cod)),
		("total de la factura", flt(cand.grand_total)),
	]
	refs = [(etq, ref) for etq, ref in refs if ref > 0]
	if monto <= 0 or not refs:
		return None, "monto no comparado"
	mejor = None
	for etq, ref in refs:
		diff = abs(monto - ref)
		pts = 100.0 if diff <= 0.01 else max(0.0, 100.0 - diff / ref * 500.0)
		if mejor is None or pts > mejor[0]:
			mejor = (pts, etq, diff)
	pts, etq, diff = mejor
	if pts >= 100:
		return pts, f"monto igual al {etq}"
	return pts, f"monto difiere Q{diff:,.2f} del {etq}"


def _puntuar(guia_escrita, monto, cand):
	if _norm_numero_guia(cand.numero_guia) == _norm_numero_guia(guia_escrita):
		pts_guia, txt_guia = PUNTOS_GUIA_EXACTA, "Guía idéntica"
	else:
		pts_guia = PUNTOS_GUIA_SIN_SEPARADORES
		txt_guia = f"Guía sin guión/espacios (en factura: {clean_numero_guia(cand.numero_guia)})"
	pts_monto, txt_monto = _puntaje_monto(monto, cand)
	if pts_monto is None:
		pct = float(pts_guia)
	else:
		pct = PESO_GUIA * pts_guia + PESO_MONTO * pts_monto
	return {
		"cand": cand,
		"porcentaje": round(pct, 1),
		"monto_exacto": pts_monto is not None and pts_monto >= 100,
		"detalle": f"{txt_guia} · {txt_monto}",
	}


def _sugerencia(guia, monto, indice):
	"""La guía registrada (aún sin liquidar) más parecida, para el mensaje de
	«no registrada». Nunca se concilia sola."""
	clave = _clave_guia(guia)
	if not clave:
		return ""
	mejor = None
	for clave_cand, cands in indice.items():
		sm = difflib.SequenceMatcher(None, clave, clave_cand)
		if sm.real_quick_ratio() < SIMILITUD_MINIMA_SUGERENCIA or sm.quick_ratio() < SIMILITUD_MINIMA_SUGERENCIA:
			continue
		ratio = sm.ratio()
		if ratio < SIMILITUD_MINIMA_SUGERENCIA:
			continue
		for c in cands:
			if c.liquidado:
				continue
			pts_monto, _ = _puntaje_monto(monto, c)
			pct = PESO_GUIA * ratio * 100 + PESO_MONTO * (pts_monto or 0)
			if mejor is None or pct > mejor[0]:
				mejor = (pct, c)
	if not mejor:
		return ""
	pct, c = mejor
	monto_txt = f", COD Q{flt(c.monto_cod or c.grand_total):,.2f}" if flt(c.monto_cod or c.grand_total) else ""
	return f" ¿Quiso decir {clean_numero_guia(c.numero_guia)} ({c.parent}{monto_txt}, {pct:.0f}% de coincidencia)?"


def _evaluar_guia(guia, monto, indice):
	"""→ {"match": dict|None, "motivo": str|None}. match trae cand, porcentaje,
	detalle (ver _puntuar)."""
	cands = indice.get(_clave_guia(guia)) or []
	if not cands:
		return {
			"match": None,
			"motivo": "No está registrada en ninguna factura para este transportista."
			+ _sugerencia(guia, monto, indice),
		}
	puntuados = [_puntuar(guia, monto, c) for c in cands]
	if len(puntuados) == 1:
		return {"match": puntuados[0], "motivo": None}

	# Varias facturas con la misma guía: el monto desempata solo si UNA cuadra
	# al centavo.
	exactos = [p for p in puntuados if p["monto_exacto"]]
	if len(exactos) == 1:
		m = exactos[0]
		n_fact = len({c.parent for c in cands})
		m["detalle"] += f" · elegida por monto entre {n_fact} facturas" if n_fact > 1 else " · elegida por monto"
		return {"match": m, "motivo": None}
	facturas = ", ".join(sorted({c.parent for c in cands}))
	return {
		"match": None,
		"motivo": f"Está registrada en más de una factura ({facturas}) y el Monto COD no permite distinguir cuál.",
	}


def _liquidadas_en_otra(transportista, claves, name=None):
	"""{clave: liquidación} de las guías que ya están en OTRA liquidación del
	transportista, comparando por clave tolerante."""
	if not claves or not transportista:
		return {}
	res = {}
	for c in frappe.db.sql(
		"""
		select d.guia, d.parent
		from `tabFacEx Liquidacion Transportista Detalle` d
		inner join `tabFacEx Liquidacion Transportista` l on l.name = d.parent
		where d.parenttype = 'FacEx Liquidacion Transportista'
		  and l.name != %(name)s
		  and l.transportista = %(transportista)s
		  and regexp_replace(upper(d.guia), '[^A-Z0-9]', '') in %(claves)s
		""",
		{"name": name or "", "transportista": transportista, "claves": tuple(claves)},
		as_dict=True,
	):
		res.setdefault(_clave_guia(c.guia), c)
	return res


def _revisar(transportista, guias, name=None):
	"""guias: lista de str o de {guia, monto_cod, efectivo}. Devuelve
	{"problemas": {guia_normalizada: motivo}, "coincidencias": {guia_normalizada:
	{porcentaje, detalle, factura, guia_factura}}}."""
	entradas = []
	for g in guias or []:
		if isinstance(g, dict):
			entradas.append((g.get("guia"), _monto_fila(g.get("monto_cod"), g.get("efectivo"))))
		else:
			entradas.append((g, 0.0))
	entradas = [(g, m) for g, m in entradas if _clave_guia(g)]
	if not entradas or not transportista:
		return {"problemas": {}, "coincidencias": {}}

	indice = _indice_guias_registradas(transportista)
	otras = _liquidadas_en_otra(transportista, {_clave_guia(g) for g, _ in entradas}, name)
	problemas, coincidencias = {}, {}
	for guia, monto in entradas:
		n = _norm_numero_guia(guia)
		previa = otras.get(_clave_guia(guia))
		if previa:
			problemas[n] = f"Ya fue liquidada en {previa.parent}."
			continue
		ev = _evaluar_guia(guia, monto, indice)
		if ev["motivo"]:
			problemas[n] = ev["motivo"]
			continue
		m = ev["match"]
		coincidencias[n] = {
			"porcentaje": m["porcentaje"],
			"detalle": m["detalle"],
			"factura": m["cand"].parent,
			"guia_factura": clean_numero_guia(m["cand"].numero_guia),
		}
	return {"problemas": problemas, "coincidencias": coincidencias}


@frappe.whitelist()
def revisar_guias(transportista, guias, name=None):
	"""Usado por el editor de Liquidaciones al pegar desde Excel y al salir de
	cada fila: avisa en el momento qué guías no se van a poder guardar (en vez
	de esperar al error de validate()) y con qué % coincide cada una."""
	if not get_facex_can_upload_liquidaciones_transporte(get_effective_company()):
		frappe.throw(
			"No tiene permiso para cargar Liquidaciones de Transportistas.",
			frappe.PermissionError,
		)
	if isinstance(guias, str):
		guias = frappe.parse_json(guias)
	return _revisar(transportista, guias or [], name)


class FacExLiquidacionTransportista(Document):
	def validate(self):
		if not get_facex_can_upload_liquidaciones_transporte(get_effective_company()):
			frappe.throw(
				"No tiene permiso para cargar Liquidaciones de Transportistas.",
				frappe.PermissionError,
			)

		self.validate_guias_no_duplicadas()
		self.validate_guias_registradas()
		self.marcar_liquidacion_especial()
		self.unmatch_removed_guias()
		self.match_guias()
		self.total_depositado = sum(flt(row.monto_liquidado) for row in self.detalle)
		self.total_excedente = sum(flt(row.excedente) for row in self.detalle)
		self.calcular_diferencia_comision()

	def marcar_liquidacion_especial(self):
		"""Excepción por usuario (FacEx Settings → Liquidación Especial): el
		abono a cada factura se topa en su saldo y lo que sobre queda como
		excedente de la fila, en vez de que el Payment Entry falle por pagar de
		más. Es pegajosa: una vez especial, sigue siéndolo aunque la re-guarde
		otro usuario — sus abonos ya sometidos se hicieron topados y un
		re-guardado normal los vería «desfasados» de comisión + depositado."""
		config = get_facex_liquidacion_especial(get_effective_company())
		if config:
			self.liquidacion_especial = 1
			self.etiqueta_especial = config["etiqueta"]
		elif self.liquidacion_especial and not self.etiqueta_especial:
			self.etiqueta_especial = "Liquidación Especial"

	def _saldo_factura(self, sales_invoice, payment_entry):
		"""Lo que esta fila puede abonarle a la factura: su saldo actual más lo
		que ya le abonó el PE sometido de la misma fila (si lo hay), para que un
		re-guardado vuelva a dar el mismo monto aplicado. Con el redondeo de
		ERPNext desactivado, el saldo parte del grand_total certificado."""
		saldo = flt(frappe.db.get_value("Sales Invoice", sales_invoice, "outstanding_amount"))
		if payment_entry:
			saldo += flt(frappe.db.get_value(
				"Payment Entry Reference",
				{"parent": payment_entry, "reference_doctype": "Sales Invoice", "reference_name": sales_invoice},
				"allocated_amount",
			))
		return max(flt(saldo, 2), 0)

	def _resolver_asiento_al_borrar(self):
		asiento = getattr(self, "journal_entry", None)
		if not asiento or not frappe.db.exists("Journal Entry", asiento):
			return
		docstatus = frappe.db.get_value("Journal Entry", asiento, "docstatus")
		if docstatus == 1:
			frappe.throw(
				f"No se puede eliminar: la liquidación tiene el asiento "
				f"<b>{frappe.utils.escape_html(asiento)}</b> ya sometido en Contabilidad. "
				"Cancélelo allá primero.",
				title="Asiento sometido",
			)
		if docstatus == 0:
			frappe.delete_doc("Journal Entry", asiento, ignore_permissions=True, force=True)

	def calcular_diferencia_comision(self):
		"""Cierre real de la pasarela: recargo cobrado al cliente vs. comisión real.

		El RECARGO por pieza (Q1/pieza de las listas Contra Entrega) es la
		ESTIMACIÓN de la comisión que el transportista cobra por recaudar el COD.
		Lo que retiene de verdad es un porcentaje que solo se conoce AQUÍ, en la
		liquidación, donde cada guía trae su Valor Comisión. Por eso la
		comparación es recargo ↔ comisión:

		  * diferencia positiva → ganancia: el cliente cubrió más de lo que costó
		    la recaudación.
		  * diferencia negativa → pérdida: el recargo por pieza quedó por debajo
		    de la comisión real. Es lo excepcional; si aparece seguido hay que
		    subir el Q por pieza de la lista.

		El FLETE queda FUERA de esta diferencia a propósito: paga el servicio de
		envío, no la comisión de cobro. Mezclarlos haría que toda guía pareciera
		una ganancia enorme (el flete es un orden de magnitud mayor que la
		comisión) y escondería justo las pérdidas que hay que detectar.

		El recargo sale de `recargo_estimado_por_factura`, que también lo
		reconstruye en las facturas anteriores al 2026-09-21 (lo llevaban dentro
		del precio de la lista, sin fila de cargo). Es lo correcto AQUÍ, que es
		análisis. El ASIENTO, en cambio, usa solo las filas de cargo reales
		(`liquidacion_asiento._resumen`): en una factura vieja el recargo se
		contabilizó como ingreso, así que no hay pasivo que cancelar.
		"""
		from facex_multi.api.recargo import recargo_estimado_por_factura

		facturas = [r.sales_invoice for r in self.detalle if r.sales_invoice]
		cargos = recargo_estimado_por_factura(facturas) if facturas else {}

		recargo = flete = comision = ganancia = perdida = 0.0
		for row in self.detalle:
			c = cargos.get(row.sales_invoice) or {}
			row.recargo_cobrado = flt(c.get("recargo"))
			row.flete_cobrado = flt(c.get("flete"))
			# Sin match no hay factura contra la que comparar: la fila se deja en
			# cero en vez de inventar una diferencia que sería toda la comisión.
			if not row.match_encontrado:
				row.diferencia_comision = 0.0
				row.resultado_comision = "Sin match"
				continue
			row.diferencia_comision = flt(row.recargo_cobrado) - flt(row.valor_comision)
			if row.diferencia_comision > 0.005:
				row.resultado_comision = "Ganancia"
				ganancia += row.diferencia_comision
			elif row.diferencia_comision < -0.005:
				row.resultado_comision = "Pérdida"
				perdida += -row.diferencia_comision
			else:
				row.resultado_comision = "Exacto"
			recargo += flt(row.recargo_cobrado)
			flete += flt(row.flete_cobrado)
			comision += flt(row.valor_comision)

		self.total_recargo_cobrado = recargo
		self.total_flete_cobrado = flete
		self.total_comision_real = comision
		self.total_diferencia = recargo - comision
		self.total_ganancia = ganancia
		self.total_perdida = perdida

	def on_trash(self):
		# El asiento de cierre de pasarela, si ya se sometió, quedaría huérfano:
		# un movimiento contable sin la liquidación que lo respalda. En borrador
		# sí se descarta aquí (lo regenera quien vuelva a cargar la liquidación).
		self._resolver_asiento_al_borrar()

		# Al eliminar la liquidación completa, toda guía que había quedado
		# liquidado=1 por su culpa debe volver a quedar pendiente — si no, el
		# KPI de COD pendiente de liquidar (y la columna "Liquidado" en
		# Guías) la siguen excluyendo para siempre aunque ya nadie la esté
		# liquidando.
		for row in self.detalle:
			_assert_payment_entry_reversible(row.payment_entry, row.guia, "eliminar la liquidación")
		for row in self.detalle:
			if row.match_encontrado and row.guia:
				self._reset_guia_liquidado(row.guia, self.transportista)
			_release_or_keep_payment_entry(row.payment_entry)

	def validate_guias_no_duplicadas(self):
		# Un mismo No. de guía no puede aparecer dos veces para el mismo
		# transportista: cada fila con match genera su propio abono
		# (_create_payment_entry) y marca la guía como liquidada, así que
		# repetirla paga dos veces la misma factura. Se compara por la clave
		# tolerante (sin guiones, espacios ni marcas invisibles, sin distinguir
		# mayúsculas): «419566215-1» y «4195662151» son la misma guía.
		vistas = {}
		for row in self.detalle:
			limpio = clean_numero_guia(row.guia)
			if limpio != (row.guia or ""):
				row.guia = limpio
			key = _clave_guia(limpio)
			if not key:
				continue
			previa = vistas.get(key)
			if previa:
				frappe.throw(
					f"El No. de guía <b>{frappe.utils.escape_html(limpio)}</b> está repetido en "
					f"esta liquidación (líneas {previa} y {row.idx}).",
					title="Guía duplicada",
				)
			vistas[key] = row.idx

		if not vistas or not self.transportista:
			return

		conflictos = _liquidadas_en_otra(self.transportista, set(vistas), self.name)
		if conflictos:
			c = next(iter(conflictos.values()))
			frappe.throw(
				f"El No. de guía <b>{frappe.utils.escape_html(c.guia or '')}</b> ya fue liquidado "
				f"en <b>{frappe.utils.escape_html(c.parent or '')}</b> para este transportista.",
				title="Guía duplicada",
			)

	def validate_guias_registradas(self):
		# Solo se liquidan guías que existen capturadas contra una factura: una
		# fila sin match no genera abono ni marca nada, y además queda tomando el
		# número para este transportista (validate_guias_no_duplicadas), así que
		# cuando la guía sí se capture ya no se podría liquidar. Se listan todas
		# de una vez para que el usuario las corrija juntas.
		#
		# Aquí también se resuelve el match (ver _evaluar_guia) y la fila pasa a
		# llevar la guía TAL COMO está en la factura: todo lo de después (abono,
		# Pagos eFast, Cierre, marcar liquidado) compara contra ese número. Lo
		# que escribió el usuario queda en guia_original si era distinto.
		if not self.transportista:
			return
		indice = _indice_guias_registradas(self.transportista)
		faltantes = []
		for row in self.detalle:
			row.flags.coincidencia = None
			if not row.guia:
				continue
			# Al re-guardar, row.guia ya es la de la factura: el % se sigue
			# calculando con lo que se escribió originalmente.
			escrita = row.guia
			if row.guia_original and _clave_guia(row.guia_original) == _clave_guia(row.guia):
				escrita = row.guia_original
			ev = _evaluar_guia(escrita, _monto_fila(row.monto_cod, row.efectivo), indice)
			if ev["motivo"]:
				faltantes.append(
					f"Línea {row.idx}: <b>{frappe.utils.escape_html(row.guia)}</b> — "
					f"{frappe.utils.escape_html(ev['motivo'])}"
				)
				continue
			m = ev["match"]
			canonica = clean_numero_guia(m["cand"].numero_guia)
			row.guia_original = escrita if escrita != canonica else None
			row.guia = canonica
			row.flags.coincidencia = m
		if faltantes:
			frappe.throw(
				"Estas guías no se pueden liquidar para "
				f"<b>{frappe.utils.escape_html(self.transportista)}</b>. Quítelas o "
				"captúrelas primero en su factura:<br><br>" + "<br>".join(faltantes),
				title="Guías no registradas",
			)

	def unmatch_removed_guias(self):
		# Mismo problema que on_trash pero al EDITAR una liquidación ya
		# guardada: si una fila que antes tenía match (guía + transportista)
		# ya no está en el detalle actual — porque se borró la fila o se
		# cambió de transportista —, esa guía se queda "liquidado=1" para
		# siempre aunque esta liquidación ya no la referencie. Como cada
		# guardado reemplaza el detalle completo (ver match_guias, que
		# reevalúa todas las filas desde cero), no hay forma de detectar la
		# fila que desapareció más que comparando contra la versión previa
		# del documento.
		if self.is_new():
			return
		before = self.get_doc_before_save()
		if not before:
			return
		# Por clave tolerante: una fila vieja guardada como la escribió el
		# usuario («gua-111») sigue siendo la misma que ahora quedó con la guía
		# de la factura («GUA-111»).
		current_keys = {(_clave_guia(row.guia), self.transportista) for row in self.detalle if row.guia}
		for old_row in before.detalle:
			key = (_clave_guia(old_row.guia), before.transportista)
			if old_row.match_encontrado and old_row.guia and key not in current_keys:
				_assert_payment_entry_reversible(
					old_row.payment_entry, old_row.guia, "desligar esta guía de la liquidación"
				)
				self._reset_guia_liquidado(old_row.guia, before.transportista)
				_release_or_keep_payment_entry(old_row.payment_entry)

	def match_guias(self):
		for row in self.detalle:
			row.match_encontrado = 0
			row.porcentaje_coincidencia = 0
			row.detalle_coincidencia = None
			row.sales_invoice = None
			row.fecha_factura = None
			row.monto_aplicado = 0
			row.excedente = 0
			# Cualquier PE en borrador de un match anterior de ESTA fila se
			# descarta aquí y, si sigue habiendo match, se recrea abajo con
			# los montos actuales; uno ya sometido se conserva tal cual.
			row.payment_entry = _release_or_keep_payment_entry(row.payment_entry)

			if not row.guia or not self.transportista:
				continue

			# Resuelto en validate_guias_registradas (guía por clave tolerante +
			# desempate por monto); sin match ya habría lanzado error.
			coincidencia = row.flags.get("coincidencia")
			if not coincidencia:
				continue

			match = coincidencia["cand"]
			row.porcentaje_coincidencia = coincidencia["porcentaje"]
			row.detalle_coincidencia = coincidencia["detalle"]
			row.match_encontrado = 1
			row.sales_invoice = match.parent
			# Fecha de emisión de la factura conciliada: se guarda en la fila
			# para que la pantalla de Liquidaciones la muestre junto al match
			# sin una consulta extra por guía.
			row.fecha_factura = frappe.db.get_value("Sales Invoice", match.parent, "posting_date")

			# Lo que realmente cubrió esta liquidación no es el Monto COD que
			# trae la fila (viene tal cual del Excel del transportista, puede
			# no cuadrar), sino Valor Comisión + Monto Liquidado — la
			# comisión retenida más lo depositado sí deben sumar el efectivo
			# real cobrado. Lo que falte contra el Monto COD ORIGINAL de la
			# guía (capturado al facturar) queda como pendiente real.
			cubierto = flt(row.valor_comision) + flt(row.monto_liquidado)
			pendiente = max(flt(match.monto_cod) - cubierto, 0)

			# Lo que se le abona a la factura. Normalmente todo lo cubierto (si
			# excede el saldo, el Payment Entry falla y así se detecta el
			# descuadre). En una liquidación especial se paga solo hasta el 100%
			# de la factura y el sobrante queda como excedente de la fila.
			aplicado = cubierto
			if self.liquidacion_especial:
				aplicado = min(cubierto, self._saldo_factura(match.parent, row.payment_entry))
			row.monto_aplicado = aplicado
			row.excedente = flt(cubierto - aplicado, 2)

			if row.payment_entry:
				# El PE que sobrevivió arriba (sometido) quedó ligado a OTRA
				# factura antes de este cambio de guía/transportista — no se
				# puede recrear silenciosamente sin descuadrar Contabilidad.
				linked_invoice = frappe.db.get_value(
					"Payment Entry Reference",
					{"parent": row.payment_entry, "reference_doctype": "Sales Invoice"},
					"reference_name",
				)
				if linked_invoice and linked_invoice != match.parent:
					frappe.throw(
						f"La guía {row.guia} ya tiene un pago sometido ({row.payment_entry}) "
						f"contra la factura {linked_invoice}, pero ahora hace match con "
						f"{match.parent}. Revierta ese pago en Contabilidad antes de reasignar la guía."
					)
				# Mismo caso con los montos: el abono ya sometido no se puede
				# reemplazar, así que editar Valor Comisión / Monto Liquidado
				# dejaría el pago desfasado de lo que dice la liquidación.
				pagado = flt(frappe.db.get_value("Payment Entry", row.payment_entry, "paid_amount"))
				if abs(pagado - aplicado) > 0.005:
					frappe.throw(
						f"La guía {row.guia} ya tiene un pago sometido ({row.payment_entry}) por "
						f"Q{pagado:,.2f}, pero con los montos actuales cubriría Q{aplicado:,.2f}. "
						"Revierta ese pago en Contabilidad antes de cambiar los montos de la fila."
					)

			frappe.db.set_value(
				"FacEx Guia Transportista",
				match.name,
				{"liquidado": 1, "fecha_liquidacion": self.fecha, "monto_pendiente": pendiente},
			)

			# Abono automático contra la factura que hizo match: mismo mecanismo
			# de api.invoice._create_payment_entry que usa la pestaña de Pagos,
			# pero aquí se SOMETE en el acto — al guardar la liquidación la
			# factura queda realmente pagada (su saldo baja), no solo conciliada.
			# Si ya quedó un PE sometido (rama de arriba), no se crea otro.
			if not row.payment_entry and aplicado > 0.005:
				invoice_doc = frappe.get_doc("Sales Invoice", match.parent)
				row.payment_entry = _create_payment_entry(
					invoice_doc, FORMA_PAGO_LIQUIDACION, self.fecha, row.guia, aplicado
				)
				frappe.get_doc("Payment Entry", row.payment_entry).submit()

			# Y la fila de «Pagos eFast» dentro de la factura: es la ÚNICA fuente
			# que lee el Cierre Diario (los Payment Entry no los mira), así que
			# sin esto el dinero de la liquidación no aparece en el cierre del
			# día ni en Recuperación de Cartera. Idempotente: se sincroniza en
			# cada guardado, también en liquidaciones viejas que se re-guarden.
			if aplicado > 0.005:
				_sync_pago_facex(match.parent, self.fecha, row.guia, aplicado)

	def _reset_guia_liquidado(self, numero_guia, transportista):
		# monto_pendiente es Currency, Frappe lo crea NOT NULL DEFAULT 0 sin
		# importar el DocType (ver NOT_NULL_TYPES en frappe/database/schema.py),
		# así que no puede guardarse None. No importa: con liquidado=0 el KPI
		# usa monto_cod completo e ignora monto_pendiente, ver get_transporte_kpis.
		# Se busca por clave tolerante, igual que el match.
		for g in _indice_guias_registradas(transportista).get(_clave_guia(numero_guia)) or []:
			frappe.db.set_value(
				"FacEx Guia Transportista",
				g.name,
				{"liquidado": 0, "fecha_liquidacion": None, "monto_pendiente": 0},
			)
