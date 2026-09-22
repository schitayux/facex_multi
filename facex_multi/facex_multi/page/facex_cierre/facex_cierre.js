// FacEx Multi — Cierre Diario de Ventas y Cuadre de Pagos
// Page interactiva sobre el DocType «FacEx Cierre Diario» (ver api/cierre.py).
//
// Un cierre = Compañía + Fecha + Usuario (caja). El usuario con permiso
// puede_crear_cierres cuadra y cierra SUS ventas del día; Gerencia
// (rol_clasificacion) ve los cierres de todos y es la única que puede
// reabrir uno ya Cerrado para permitir correcciones.

frappe.pages["facex-cierre"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "Cierre Diario — FacEx",
		single_column: true,
	});
	// Mismo Modo Enfoque que FacEx / FacEx Screen / Inventario (ver comentario
	// en facex_inventario.js): quitar la clase al navegar a otra ruta.
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex-cierre") {
			$("body").removeClass("facex-fullscreen-mode");
		}
	});
	wrapper.facexCierre = new FacexCierreDiario(page, wrapper);
	facex_multi.setup_back_guard({ to: "/app/facex", is_dirty: () => wrapper.facexCierre.is_dirty() });
};

frappe.pages["facex-cierre"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	if (!wrapper.facexCierre) return;
	facex_multi.setup_back_guard({ to: "/app/facex", is_dirty: () => wrapper.facexCierre.is_dirty() });
	// Ruta profunda: /app/facex-cierre?fecha=YYYY-MM-DD&usuario=... abre
	// directamente ese cierre (usado por la alerta de pendientes en FacEx).
	wrapper.facexCierre.handle_route();
};

const CD_ESTADO_COLOR = {
	Borrador: { bg: "#fff7e6", fg: "#b45309", bd: "#fbd38d" },
	Cerrado: { bg: "#e6f7ee", fg: "#15803d", bd: "#86efac" },
	Reabierto: { bg: "#fde8e8", fg: "#b91c1c", bd: "#fca5a5" },
	Nuevo: { bg: "#eef2ff", fg: "#3730a3", bd: "#c7d2fe" },
};

function _cd_esc(s) {
	return frappe.utils.escape_html(s == null ? "" : String(s));
}

function _cd_flt(v) {
	const n = parseFloat(v);
	return isNaN(n) ? 0 : n;
}

class FacexCierreDiario {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.$root = $(page.body);
		this.ctx = null;
		this.doc = null; // documento cargado (o null si es nuevo)
		this.snap = null; // snapshot mostrado (vivo o congelado)
		this.form = { fecha: "", usuario: "", almacen: "", egresos: [], observaciones: "" };
		this._dirty = false;
		this._view = "list";
		this._facturasFilter = null; // "contado" | "contra_entrega" | "credito" | null (sin filtro)
		this.page.add_menu_item(__("FacEx - Clásico"), () => { window.location.href = "/app/facex"; });
		this._render_topbar();
		this.$body = this.$root.find("#cd-content-root");
		this._load_context(() => this.handle_route(true));
	}

	is_dirty() {
		return this._view === "detail" && this._dirty;
	}

	// ─────────────────────────── contexto ───────────────────────────

	_load_context(cb) {
		frappe.call({
			method: "facex_multi.api.cierre.get_context",
			callback: (r) => {
				this.ctx = r.message;
				this.$root.find("#cd-topbar-company").text(this.ctx.company);
				this.$root.find("#cd-active-user-fullname").text(this.ctx.user_fullname);
				this.$root.find("#cd-active-user-email").text(this.ctx.user);
				if (cb) cb();
			},
			error: () => {
				this.$body.html(`<div class="cd-empty">${__("No tiene permiso para el módulo Cierre Diario. Solicite el permiso «Crear Cierres Diarios de Venta» en FacEx Settings.")}</div>`);
			},
		});
	}

	_reload_pending(cb) {
		frappe.call({
			method: "facex_multi.api.cierre.get_pending_closures",
			callback: (r) => {
				if (this.ctx) this.ctx.pending = r.message || [];
				if (cb) cb();
			},
		});
	}

	// Enlace profundo (desde la alerta de pendientes de FacEx / FacEx Screen):
	// /app/facex-cierre?name=CD-... o ?fecha=YYYY-MM-DD&usuario=...
	// Se consume una sola vez y se limpia de la URL para que las re-entradas
	// a la página (on_page_show) no vuelvan a abrirlo.
	handle_route(first) {
		if (!this.ctx) return;
		const q = frappe.utils.get_query_params();
		if (q.name || q.fecha) {
			history.replaceState(null, "", "/app/facex-cierre");
			if (q.name) this._open_existing(q.name);
			else this._open_new(q.fecha, q.usuario || this.ctx.user);
			return;
		}
		if (first) this._render_list();
	}

	// ─────────────────────────── topbar ───────────────────────────

	_render_topbar() {
		this.$root.html(`
<style>${CD_STYLES}</style>
<div class="cd-topbar">
	<div class="cd-topbar-left">
		<span class="cd-topbar-logo" id="cd-topbar-logo" title="Ir a la lista de cierres" style="cursor:pointer;">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="#153375"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
			FacEx <span class="cd-topbar-sub">Cierre Diario</span>
		</span>
		<span class="cd-topbar-company" id="cd-topbar-company"></span>
	</div>
	<div class="cd-topbar-right">
		<button type="button" class="cd-topbar-link" id="cd-topbar-billing">Facturador</button>
		<button type="button" class="cd-topbar-link" id="cd-topbar-pos">POS</button>
		<div class="cd-user-dropdown">
			<button class="cd-user-btn" id="cd-btn-user-profile" title="Perfil de Usuario">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
			</button>
			<div class="cd-user-menu" id="cd-user-menu" style="display:none;">
				<div class="cd-user-menu-label">Usuario Conectado</div>
				<div class="cd-user-fullname" id="cd-active-user-fullname"></div>
				<div class="cd-user-email" id="cd-active-user-email"></div>
				<button type="button" class="cd-btn cd-btn-danger cd-user-menu-btn" id="cd-btn-logout">Cerrar Sesión</button>
			</div>
		</div>
	</div>
</div>
<div id="cd-content-root"></div>
		`);
		this.$root.find("#cd-topbar-billing").on("click", () => { window.location.href = "/app/facex"; });
		this.$root.find("#cd-topbar-pos").on("click", () => { window.location.href = "/app/facex-screen"; });
		this.$root.find("#cd-topbar-logo").on("click", () => this._go_list());
		this.$root.find("#cd-btn-user-profile").on("click", (e) => {
			e.stopPropagation();
			this.$root.find("#cd-user-menu").fadeToggle(150);
		});
		$(document).off(".cdUserMenu").on("click.cdUserMenu", (e) => {
			if (!$(e.target).closest(".cd-user-dropdown").length) this.$root.find("#cd-user-menu").fadeOut(150);
		});
		this.$root.find("#cd-btn-logout").on("click", () => frappe.app.logout());
	}

	_go_list() {
		const go = () => {
			this._dirty = false;
			this._reload_pending(() => this._render_list());
		};
		if (this.is_dirty()) frappe.confirm(__("Hay cambios sin guardar. ¿Desea salir de todos modos?"), go);
		else go();
	}

	// ─────────────────────────── helpers ───────────────────────────

	fmt(n) {
		const v = _cd_flt(n);
		const s = Math.abs(v).toLocaleString("es-GT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		return (v < 0 ? "-" : "") + (this.ctx && this.ctx.currency === "GTQ" ? "Q " : "") + s;
	}

	fmt_qty(n) {
		const v = _cd_flt(n);
		return v.toLocaleString("es-GT", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
	}

	long_date(ymd) {
		if (!ymd) return "";
		const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
		const dt = new Date(y, m - 1, d);
		return dt.toLocaleDateString("es-GT", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).toUpperCase();
	}

	short_date(ymd) {
		return ymd ? frappe.datetime.str_to_user(ymd) : "";
	}

	user_label(u) {
		const row = (this.ctx.users || []).find((x) => x.name === u);
		return row ? (row.full_name || u) : u;
	}

	badge(estado) {
		const c = CD_ESTADO_COLOR[estado] || CD_ESTADO_COLOR.Nuevo;
		return `<span class="cd-badge" style="background:${c.bg};color:${c.fg};border-color:${c.bd};">${_cd_esc(estado)}</span>`;
	}

	// ─────────────────────────── LISTA ───────────────────────────

	_render_list() {
		this._view = "list";
		this.doc = null;
		this.snap = null;
		const ctx = this.ctx;
		const pend = ctx.pending || [];
		const canCreate = ctx.puede_crear_cierres || ctx.es_gerencia;

		this.$body.html(`
<div class="cd-wrap">
	<div class="cd-head">
		<div>
			<div class="cd-title">Cierre Diario de Ventas</div>
			<div class="cd-subtitle">${_cd_esc(ctx.company)} · ${ctx.es_gerencia ? "Gerencia: ve los cierres de todos los usuarios" : "Solo sus propios cierres"}</div>
		</div>
		<div class="cd-head-actions">
			${canCreate ? `<button type="button" class="cd-btn cd-btn-primary" id="cd-btn-new">+ Nuevo cierre</button>` : ""}
		</div>
	</div>

	<div id="cd-pending" class="cd-alert ${pend.length ? "cd-alert-warn" : "cd-alert-ok"}">
		${pend.length
			? `<div class="cd-alert-title">⚠ ${pend.length} día(s) con ventas pendientes de cierre</div>
			   <div class="cd-alert-chips">${pend.map((p) => `
					<button type="button" class="cd-chip" data-fecha="${_cd_esc(p.fecha)}" data-usuario="${_cd_esc(p.usuario)}" data-name="${_cd_esc(p.cierre || "")}">
						<b>${this.short_date(p.fecha)}</b>${ctx.es_gerencia ? ` · ${_cd_esc(p.usuario_nombre || p.usuario)}` : ""}
						<span class="cd-chip-meta">${p.num_facturas} fact. · ${this.fmt(p.total_venta)}${p.estado ? ` · ${_cd_esc(p.estado)}` : ""}</span>
					</button>`).join("")}</div>`
			: `<div class="cd-alert-title">✓ Sin días pendientes de cierre (últimos 60 días)</div>`}
	</div>

	<div class="cd-card">
		<div class="cd-filters">
			<div class="cd-field"><label>Desde</label><input type="date" id="cd-f-desde" class="cd-input" value="${frappe.datetime.add_days(ctx.today, -30)}"></div>
			<div class="cd-field"><label>Hasta</label><input type="date" id="cd-f-hasta" class="cd-input" value="${ctx.today}"></div>
			${ctx.es_gerencia ? `<div class="cd-field"><label>Usuario</label><select id="cd-f-usuario" class="cd-input"><option value="">(todos)</option>${ctx.users.map((u) => `<option value="${_cd_esc(u.name)}">${_cd_esc(u.full_name || u.name)}</option>`).join("")}</select></div>` : ""}
			<div class="cd-field"><label>Estado</label><select id="cd-f-estado" class="cd-input"><option value="">(todos)</option><option>Borrador</option><option>Cerrado</option><option>Reabierto</option></select></div>
			<div class="cd-field" style="align-self:end;"><button type="button" class="cd-btn cd-btn-secondary" id="cd-btn-filter">Buscar</button></div>
		</div>
		<div id="cd-list-table" class="cd-table-wrap"><div class="cd-empty">Cargando…</div></div>
	</div>
</div>`);

		this.$body.find("#cd-btn-new").on("click", () => this._open_new(ctx.today, ctx.user));
		this.$body.find(".cd-chip").on("click", (e) => {
			const $c = $(e.currentTarget);
			if ($c.data("name")) this._open_existing($c.data("name"));
			else this._open_new($c.data("fecha"), $c.data("usuario"));
		});
		this.$body.find("#cd-btn-filter").on("click", () => this._load_list());
		this._load_list();
	}

	_load_list() {
		const args = {
			from_date: this.$body.find("#cd-f-desde").val(),
			to_date: this.$body.find("#cd-f-hasta").val(),
			usuario: this.$body.find("#cd-f-usuario").val() || "",
			estado: this.$body.find("#cd-f-estado").val() || "",
		};
		frappe.call({
			method: "facex_multi.api.cierre.list_cierres",
			args,
			callback: (r) => {
				const rows = r.message || [];
				const $t = this.$body.find("#cd-list-table");
				if (!rows.length) {
					$t.html(`<div class="cd-empty">No hay cierres en el rango seleccionado.</div>`);
					return;
				}
				$t.html(`
<table class="cd-table">
	<thead><tr>
		<th>Fecha</th><th>Usuario</th><th>Estado</th><th class="r">Facturas</th><th class="r">Venta</th>
		<th class="r">Efectivo</th><th class="r">Crédito</th><th class="r">Egresos</th><th class="r">A depositar</th><th>Cerrado</th>
	</tr></thead>
	<tbody>${rows.map((c) => `
		<tr class="cd-row" data-name="${_cd_esc(c.name)}">
			<td><b>${this.short_date(c.fecha)}</b><div class="cd-muted">${_cd_esc(c.name)}</div></td>
			<td>${_cd_esc(c.usuario_nombre || c.usuario)}</td>
			<td>${this.badge(c.estado)}</td>
			<td class="r">${c.num_facturas || 0}</td>
			<td class="r">${this.fmt(c.total_venta)}</td>
			<td class="r">${this.fmt(c.cobro_efectivo)}</td>
			<td class="r">${this.fmt(c.al_credito)}</td>
			<td class="r">${this.fmt(c.total_egresos)}</td>
			<td class="r"><b>${this.fmt(c.total_a_depositar)}</b></td>
			<td class="cd-muted">${c.cerrado_por ? `${_cd_esc(c.cerrado_por)}<br>${frappe.datetime.str_to_user(c.cerrado_en)}` : "—"}</td>
		</tr>`).join("")}</tbody>
</table>`);
				$t.find(".cd-row").on("click", (e) => this._open_existing($(e.currentTarget).data("name")));
			},
		});
	}

	// ─────────────────────────── DETALLE ───────────────────────────

	_open_new(fecha, usuario, keep_egresos) {
		// Si ya existe un cierre para esa fecha/usuario, abrirlo en vez de duplicar.
		frappe.call({
			method: "facex_multi.api.cierre.compute_preview",
			args: { fecha, usuario },
			freeze: true,
			freeze_message: __("Calculando el día…"),
			callback: (r) => {
				const snap = r.message;
				if (snap.existing) {
					this._open_existing(snap.existing);
					return;
				}
				this.doc = null;
				this.snap = snap;
				this.form = {
					fecha, usuario,
					almacen: "",
					egresos: keep_egresos || (this.ctx.default_egresos || []).map((c) => ({ concepto: c, monto: 0, referencia: "", observaciones: "" })),
					observaciones: "",
				};
				this._dirty = false;
				this._facturasFilter = null;
				this._render_detail();
			},
		});
	}

	_open_existing(name) {
		frappe.call({
			method: "facex_multi.api.cierre.get_cierre",
			args: { name },
			freeze: true,
			callback: (r) => {
				this.doc = r.message;
				this.form = {
					fecha: this.doc.fecha,
					usuario: this.doc.usuario,
					almacen: this.doc.almacen || "",
					egresos: (this.doc.egresos || []).map((e) => ({ concepto: e.concepto, monto: _cd_flt(e.monto), referencia: e.referencia || "", observaciones: e.observaciones || "" })),
					observaciones: this.doc.observaciones || "",
				};
				this._dirty = false;
				this._facturasFilter = null;
				if (this.doc.estado === "Cerrado") {
					// Congelado: se muestra el snapshot guardado al momento del cierre.
					this.snap = this.doc.snapshot || null;
					this._render_detail();
				} else {
					// Borrador / Reabierto: siempre en vivo.
					this._recompute(() => this._render_detail());
				}
			},
		});
	}

	_recompute(cb) {
		frappe.call({
			method: "facex_multi.api.cierre.compute_preview",
			args: { fecha: this.form.fecha, usuario: this.form.usuario },
			freeze: true,
			freeze_message: __("Recalculando…"),
			callback: (r) => {
				this.snap = r.message;
				if (cb) cb();
			},
		});
	}

	_totals() {
		const s = this.snap || {};
		const egresos = this.form.egresos.reduce((a, e) => a + _cd_flt(e.monto), 0);
		const total_venta = _cd_flt(s.total_venta);
		const cobro_efectivo = _cd_flt(s.cobro_efectivo);
		// Solo el efectivo cobrado se entrega para depósito: transferencias,
		// depósitos bancarios, tarjeta, cheque, contra entrega y crédito no
		// pasan por la caja.
		return { egresos, total_venta, cobro_efectivo, a_depositar: cobro_efectivo - egresos };
	}

	_clasificacion_facturas(facts) {
		const grupos = {
			contado: { count: 0, total: 0, alertas: 0 },
			contra_entrega: { count: 0, total: 0, alertas: 0 },
			credito: { count: 0, total: 0, alertas: 0 },
		};
		const alertas = [];
		facts.forEach((f) => {
			const g = grupos[f.clasificacion] || grupos.contado;
			g.count += 1;
			g.total += _cd_flt(f.grand_total);
			if (f.alerta_contado) {
				g.alertas += 1;
				alertas.push(f);
			}
		});
		return { grupos, alertas };
	}

	_render_detail() {
		this._view = "detail";
		const ctx = this.ctx;
		const doc = this.doc;
		const s = this.snap || {};
		const estado = doc ? doc.estado : "Nuevo";
		const cerrado = estado === "Cerrado";
		const canManage = doc ? !!doc.puede_gestionar : (ctx.es_gerencia || (ctx.puede_crear_cierres && this.form.usuario === ctx.user));
		const editable = canManage && !cerrado;
		const t = this._totals();
		const fams = s.detalle_familias || [];
		const facts = s.facturas || [];
		const cuadra = Math.abs(_cd_flt(s.total_cobros) - _cd_flt(s.total_venta)) < 0.01;
		const { grupos: clas, alertas: alertasContado } = this._clasificacion_facturas(facts);
		const filtro = this._facturasFilter;
		const factsView = filtro ? facts.filter((f) => f.clasificacion === filtro) : facts;
		const CD_CLASE_LABEL = { contado: "Contado", contra_entrega: "C. Entrega", credito: "Crédito" };
		// No se puede cerrar el día mientras haya facturas de Contado sin el
		// pago real registrado (backend lo vuelve a validar en cerrar_cierre).
		const bloqueaCierre = alertasContado.length > 0;

		this.$body.html(`
<div class="cd-wrap">
	<div class="cd-head">
		<div>
			<button type="button" class="cd-link" id="cd-btn-back">← Cierres</button>
			<div class="cd-title">Cierre Diario ${doc ? `<span class="cd-muted" style="font-weight:400;font-size:14px;">${_cd_esc(doc.name)}</span>` : ""} ${this.badge(estado)}</div>
			<div class="cd-subtitle" id="cd-long-date">${this.long_date(this.form.fecha)}</div>
		</div>
		<div class="cd-head-actions">
			${!cerrado ? `<button type="button" class="cd-btn cd-btn-secondary" id="cd-btn-recalc" title="Vuelve a leer facturas y pagos del día">↻ Recalcular</button>` : ""}
			<button type="button" class="cd-btn cd-btn-secondary" id="cd-btn-print">🖨 Imprimir</button>
			${editable ? `<button type="button" class="cd-btn cd-btn-secondary" id="cd-btn-save">Guardar borrador</button>` : ""}
			${editable ? `<button type="button" class="cd-btn cd-btn-success" id="cd-btn-close" ${bloqueaCierre ? "disabled" : ""} title="${bloqueaCierre ? "Hay facturas de Contado sin pago completo registrado — ingrese el pago real antes de cerrar" : ""}">🔒 Cerrar día</button>` : ""}
			${cerrado && doc && doc.puede_reabrir ? `<button type="button" class="cd-btn cd-btn-danger" id="cd-btn-reopen">Reabrir cierre</button>` : ""}
			${doc && !cerrado && canManage ? `<button type="button" class="cd-btn cd-btn-ghost" id="cd-btn-delete" title="Eliminar borrador">Eliminar</button>` : ""}
		</div>
	</div>

	${cerrado ? `<div class="cd-alert cd-alert-ok"><b>Día cerrado</b> por ${_cd_esc(doc.cerrado_por)} el ${frappe.datetime.str_to_user(doc.cerrado_en)}. Las facturas y pagos de esta fecha están congelados; solo Gerencia puede reabrir.</div>` : ""}
	${estado === "Reabierto" ? `<div class="cd-alert cd-alert-danger"><b>Cierre reabierto</b> por ${_cd_esc(doc.reabierto_por)} el ${frappe.datetime.str_to_user(doc.reabierto_en)} — motivo: ${_cd_esc(doc.motivo_reapertura)}. Realice las correcciones necesarias, recalcule y vuelva a cerrar el día.</div>` : ""}
	${!canManage ? `<div class="cd-alert cd-alert-warn">Solo lectura: este cierre pertenece a otro usuario.</div>` : ""}

	<div class="cd-card">
		<div class="cd-grid-4">
			<div class="cd-field"><label>Fecha</label><input type="date" id="cd-fecha" class="cd-input" value="${_cd_esc(this.form.fecha)}" max="${ctx.today}" ${doc ? "disabled" : ""}></div>
			<div class="cd-field"><label>Usuario (caja)</label>
				${ctx.es_gerencia && !doc
					? `<select id="cd-usuario" class="cd-input">${ctx.users.map((u) => `<option value="${_cd_esc(u.name)}" ${u.name === this.form.usuario ? "selected" : ""}>${_cd_esc(u.full_name || u.name)}</option>`).join("")}</select>`
					: `<input type="text" class="cd-input" value="${_cd_esc(this.user_label(this.form.usuario))}" disabled>`}
			</div>
			<div class="cd-field"><label>Almacén (referencia)</label>
				<select id="cd-almacen" class="cd-input" ${editable ? "" : "disabled"}><option value="">—</option>${ctx.warehouses.map((w) => `<option value="${_cd_esc(w.name)}" ${w.name === this.form.almacen ? "selected" : ""}>${_cd_esc(w.warehouse_name || w.name)}</option>`).join("")}</select>
			</div>
			<div class="cd-field"><label>Facturas del día</label><div class="cd-static">${s.num_facturas || 0}</div></div>
		</div>
	</div>

	<!-- DETALLE DE VENTA DIARIA -->
	<div class="cd-card">
		<div class="cd-card-title">DETALLE DE VENTA DIARIA <span class="cd-muted">por Familia de Precio</span></div>
		<div class="cd-table-wrap">
		<table class="cd-table cd-table-fam">
			<thead><tr><th style="width:44px;">No.</th><th>Descripción / Familia</th><th class="r">Cantidad</th><th class="r">Precio por Unidad</th><th class="r">Total</th></tr></thead>
			<tbody>${fams.length ? fams.map((f, i) => `
				<tr class="${f.es_oferta ? "cd-row-oferta" : ""}" title="${_cd_esc(f.items ? Object.entries(f.items).map(([k, v]) => `${k}: ${v}`).join("\n") : "")}">
					<td>${f.es_oferta ? 0 : i}</td>
					<td><b>${_cd_esc(f.familia)}</b>${f.descripcion && f.descripcion !== f.familia ? `<div class="cd-muted">${_cd_esc(f.descripcion)}</div>` : ""}</td>
					<td class="r">${this.fmt_qty(f.cantidad)}</td>
					<td class="r">${this.fmt(f.precio_unidad)}</td>
					<td class="r"><b>${this.fmt(f.total)}</b></td>
				</tr>`).join("") : `<tr><td colspan="5" class="cd-empty">Sin ventas validadas en esta fecha.</td></tr>`}
			</tbody>
			<tfoot><tr><td colspan="2">TOTAL (sin fletes)</td><td class="r">${this.fmt_qty(fams.reduce((a, f) => a + _cd_flt(f.cantidad), 0))}</td><td></td><td class="r">${this.fmt(_cd_flt(s.venta_sin_descuento) + _cd_flt(s.venta_con_descuento))}</td></tr></tfoot>
		</table>
		</div>
	</div>

	<!-- RESUMEN -->
	<div class="cd-card">
		<div class="cd-card-title">RESUMEN TOTAL VENTA DEL DÍA <span class="cd-muted">${this.short_date(this.form.fecha)}</span></div>
		<div class="cd-grid-3">
			<div class="cd-block">
				<div class="cd-block-title">VENTAS</div>
				<div class="cd-line"><span>Ventas sin descuento</span><b>${this.fmt(s.venta_sin_descuento)}</b></div>
				<div class="cd-line"><span>Piezas en oferta (con descuento)</span><b>${this.fmt(s.venta_con_descuento)}</b></div>
				<div class="cd-line"><span>Fletes facturados</span><b>${this.fmt(s.flete_facturado)}</b></div>
				${_cd_flt(s.recargo_facturado) ? `<div class="cd-line"><span>Recargo por entrega facturado</span><b>${this.fmt(s.recargo_facturado)}</b></div>` : ""}
				${Math.abs(_cd_flt(s.ajuste_impuestos)) >= 0.01 ? `<div class="cd-line"><span>Ajustes (descuento global / redondeo)</span><b>${this.fmt(s.ajuste_impuestos)}</b></div>` : ""}
				<div class="cd-line"><span class="cd-devol-label">Devoluciones <span class="cd-muted">(facturas de otra fecha anuladas hoy)</span></span><b class="cd-devol-label">− ${this.fmt(s.total_devoluciones)}</b></div>
				<div class="cd-line cd-line-total"><span>TOTAL VENTA</span><b>${this.fmt(_cd_flt(s.total_venta) - _cd_flt(s.total_devoluciones))}</b></div>
			</div>
			<div class="cd-block">
				<div class="cd-block-title">CARGOS</div>
				<div class="cd-line"><span>Fletes facturados${s.flete_item ? ` <span class="cd-muted">(${_cd_esc(s.flete_item)})</span>` : ""}</span><b>${this.fmt(s.flete_facturado)}</b></div>
				<div class="cd-line"><span>Recargo por entrega facturado <span class="cd-muted">(listas Contra Entrega)</span></span><b>${this.fmt(s.recargo_facturado)}</b></div>
				<div class="cd-line cd-line-total"><span>TOTAL CARGOS</span><b>${this.fmt(_cd_flt(s.flete_facturado) + _cd_flt(s.recargo_facturado))}</b></div>
				${!s.flete_item ? `<div class="cd-hint">Sin Ítem de Flete configurado en FacEx Settings — los fletes se contarán como venta.</div>` : ""}
			</div>
			<div class="cd-block">
				<div class="cd-block-title">COBROS Y CRÉDITOS</div>
				<div class="cd-line"><span>Transferencia</span><b>${this.fmt(s.cobro_transferencia)}</b></div>
				<div class="cd-line"><span>Cheques</span><b>${this.fmt(s.cobro_cheque)}</b></div>
				<div class="cd-line"><span>Pago Efectivo</span><b>${this.fmt(s.cobro_efectivo)}</b></div>
				<div class="cd-line"><span>Tarjeta de Crédito</span><b>${this.fmt(s.cobro_tarjeta)}</b></div>
				<div class="cd-line"><span>Contra Entrega</span><b>${this.fmt(s.cobro_contra_entrega)}</b></div>
				<div class="cd-line"><span>Contado <span class="cd-muted">(pendiente de registrar)</span></span><b>${this.fmt(s.contado_pendiente)}</b></div>
				<div class="cd-line"><span>Al Crédito</span><b>${this.fmt(s.al_credito)}</b></div>
				${_cd_flt(s.cobro_otros) ? `<div class="cd-line"><span>Otros</span><b>${this.fmt(s.cobro_otros)}</b></div>` : ""}
				<div class="cd-line cd-line-total"><span>TOTAL ${cuadra ? `<span class="cd-ok">✓ cuadra</span>` : `<span class="cd-bad">≠ venta</span>`}</span><b>${this.fmt(s.total_cobros)}</b></div>
			</div>
			<div class="cd-block cd-block-devol">
				<div class="cd-block-title cd-block-title-devol">DEVOLUCIONES</div>
				<div class="cd-line"><span>Contra Entrega</span><b>${this.fmt(s.devoluciones_contra_entrega)}</b></div>
				<div class="cd-line"><span>Al Crédito</span><b>${this.fmt(s.devoluciones_credito)}</b></div>
				<div class="cd-line"><span>Contado</span><b>${this.fmt(s.devoluciones_contado)}</b></div>
				<div class="cd-line cd-line-total"><span>TOTAL DEVOLUCIONES</span><b>${this.fmt(s.total_devoluciones)}</b></div>
				${(s.devoluciones || []).length ? `<div class="cd-hint">${s.devoluciones.map((d) => `<a href="/app/facex?invoice=${encodeURIComponent(d.sales_invoice)}" target="_blank">${_cd_esc(d.sales_invoice)}</a> (${this.short_date(d.posting_date)})`).join(", ")}</div>` : `<div class="cd-hint">Sin devoluciones.</div>`}
			</div>
		</div>
		${(s.abonos_detalle || []).length ? `
		<details class="cd-details">
			<summary>Abonos recibidos hoy de facturas anteriores: <b>${this.fmt(s.abonos_anteriores)}</b> <span class="cd-muted">(informativo, no entra en el total a depositar)</span></summary>
			<table class="cd-table cd-table-sm"><thead><tr><th>Factura</th><th>Cliente</th><th>Fecha factura</th><th>Forma</th><th>Ref.</th><th class="r">Monto</th></tr></thead>
			<tbody>${s.abonos_detalle.map((a) => `<tr><td>${_cd_esc(a.sales_invoice)}</td><td>${_cd_esc(a.customer_name)}</td><td>${this.short_date(a.posting_date)}</td><td>${_cd_esc(a.payment_method)}</td><td>${_cd_esc(a.reference)}</td><td class="r">${this.fmt(a.amount)}</td></tr>`).join("")}</tbody></table>
		</details>` : ""}
	</div>

	<!-- EGRESOS + TOTAL A DEPOSITAR -->
	<div class="cd-grid-2">
		<div class="cd-card">
			<div class="cd-card-title">EGRESOS</div>
			<div class="cd-table-wrap">
			<table class="cd-table cd-table-egresos">
				<thead><tr><th>Concepto</th><th class="r" style="width:140px;">Monto</th><th style="width:130px;">Referencia</th><th>Observaciones</th>${editable ? `<th style="width:36px;"></th>` : ""}</tr></thead>
				<tbody id="cd-egresos-body"></tbody>
				<tfoot><tr><td>TOTAL EGRESOS</td><td class="r" id="cd-total-egresos"><b>${this.fmt(t.egresos)}</b></td><td colspan="${editable ? 3 : 2}"></td></tr></tfoot>
			</table>
			</div>
			${editable ? `<button type="button" class="cd-btn cd-btn-ghost" id="cd-btn-add-egreso">+ Agregar egreso</button>` : ""}
		</div>
		<div class="cd-card cd-card-deposit">
			<div class="cd-deposit-label">TOTAL A DEPOSITAR</div>
			<div class="cd-deposit-value" id="cd-total-depositar">${this.fmt(t.a_depositar)}</div>
			<div class="cd-deposit-formula">Efectivo cobrado ${this.fmt(t.cobro_efectivo)} − Egresos <span id="cd-dep-egresos">${this.fmt(t.egresos)}</span></div>
			<div class="cd-field" style="margin-top:14px;"><label>Observaciones</label>
				<textarea id="cd-observaciones" class="cd-input" rows="3" ${editable ? "" : "disabled"}>${_cd_esc(this.form.observaciones)}</textarea></div>
		</div>
	</div>

	<!-- FACTURAS -->
	<div class="cd-card">
		<div class="cd-card-title">CLASIFICACIÓN DE FACTURAS</div>
		<div class="cd-class-grid">
			<button type="button" class="cd-class-box cd-class-contado ${filtro === "contado" ? "cd-class-active" : ""}" data-filter="contado">
				<div class="cd-class-label">Facturas de Contado</div>
				<div class="cd-class-count">${clas.contado.count}</div>
				<div class="cd-class-total">${this.fmt(clas.contado.total)}</div>
				${clas.contado.alertas ? `<div class="cd-class-warn">⚠ ${Math.round((clas.contado.alertas / clas.contado.count) * 100)}% falta de pago por registrar (${clas.contado.alertas}/${clas.contado.count})</div>` : ""}
			</button>
			<button type="button" class="cd-class-box cd-class-ce ${filtro === "contra_entrega" ? "cd-class-active" : ""}" data-filter="contra_entrega">
				<div class="cd-class-label">Contra Entrega</div>
				<div class="cd-class-count">${clas.contra_entrega.count}</div>
				<div class="cd-class-total">${this.fmt(clas.contra_entrega.total)}</div>
			</button>
			<button type="button" class="cd-class-box cd-class-credito ${filtro === "credito" ? "cd-class-active" : ""}" data-filter="credito">
				<div class="cd-class-label">Al Crédito</div>
				<div class="cd-class-count">${clas.credito.count}</div>
				<div class="cd-class-total">${this.fmt(clas.credito.total)}</div>
			</button>
		</div>
		${alertasContado.length ? `
		<div class="cd-alert cd-alert-warn" style="margin-top:12px;">
			<div class="cd-alert-title">⚠ ${alertasContado.length} factura(s) de contado sin pago completo</div>
			<div>Se vendieron de contado pero quedaron con saldo pendiente. Abra la factura en el facturador clásico para ingresar el pago real. <b>No se puede cerrar el día hasta que todas queden pagadas al 100%.</b></div>
			<ul class="cd-alert-list">${alertasContado.map((f) => `<li><a href="/app/facex?invoice=${encodeURIComponent(f.sales_invoice)}" target="_blank">${_cd_esc(f.sales_invoice)}</a> — ${_cd_esc(f.customer_name)} — pendiente <b>${this.fmt(f.credito)}</b></li>`).join("")}</ul>
		</div>` : ""}

		<details class="cd-details" style="margin-top:10px;" ${facts.length && facts.length <= 15 ? "open" : ""}>
			<summary><b>Facturas incluidas (${factsView.length}${filtro ? ` de ${facts.length}` : ""})</b>${filtro ? ` <span class="cd-muted">— filtro: ${CD_CLASE_LABEL[filtro]} (<a href="#" id="cd-clear-filter">quitar</a>)</span>` : ""}</summary>
			<div class="cd-table-wrap">
			<table class="cd-table cd-table-sm">
				<thead><tr><th>Factura</th><th>Cliente</th><th>Clasificación</th><th class="r">Total</th><th class="r">C. Entrega</th><th class="r">Recargo</th><th class="r">Contado</th><th class="r">Crédito</th><th class="r">Flete</th><th>FEL</th></tr></thead>
				<tbody>${factsView.map((f) => {
					const recargo = _cd_flt(f.recargo);
					const ceNeto = _cd_flt(f.contra_entrega) - recargo;
					const contadoPend = f.clasificacion === "contado" ? f.credito : 0;
					const creditoReal = f.clasificacion === "credito" ? f.credito : 0;
					return `
					<tr class="${f.alerta_contado ? "cd-row-alert" : ""}">
						<td><a href="/app/facex?invoice=${encodeURIComponent(f.sales_invoice)}" target="_blank">${_cd_esc(f.sales_invoice)}</a>${f.es_devolucion ? ` <span class="cd-tag">DEV</span>` : ""}${f.tiene_descuento ? ` <span class="cd-tag cd-tag-oferta">OFERTA</span>` : ""}</td>
						<td>${_cd_esc(f.customer_name)}</td>
						<td><span class="cd-tag cd-tag-clase-${f.clasificacion}">${CD_CLASE_LABEL[f.clasificacion] || ""}</span>${f.alerta_contado ? ` <span class="cd-tag cd-tag-alerta" title="Contado sin pagar">⚠</span>` : ""}</td>
						<td class="r">${this.fmt(f.grand_total)}</td>
						<td class="r">${this.fmt(ceNeto)}</td>
						<td class="r">${this.fmt(recargo)}</td>
						<td class="r">${this.fmt(contadoPend)}</td>
						<td class="r">${this.fmt(creditoReal)}</td>
						<td class="r">${this.fmt(f.flete)}</td>
						<td class="cd-muted">${_cd_esc(f.bfel_status)}</td>
					</tr>`;
				}).join("") || `<tr><td colspan="10" class="cd-empty">Sin facturas.</td></tr>`}
				</tbody>
			</table>
			</div>
		</details>
	</div>

	<!-- DEVOLUCIONES - DETALLE (facturadas y anuladas el mismo día: no afectan totales) -->
	<div class="cd-card">
		<details class="cd-details">
			<summary><b>Devoluciones - Detalle (${(s.devoluciones_hoy || []).length})</b> <span class="cd-muted">— facturadas y anuladas hoy mismo, no afectan el Total Venta</span></summary>
			<div class="cd-table-wrap">
			<table class="cd-table cd-table-sm">
				<thead><tr><th>Factura</th><th>Cliente</th><th>Clasificación</th><th class="r">Total</th></tr></thead>
				<tbody>${(s.devoluciones_hoy || []).map((d) => `
					<tr>
						<td><a href="/app/facex?invoice=${encodeURIComponent(d.sales_invoice)}" target="_blank">${_cd_esc(d.sales_invoice)}</a></td>
						<td>${_cd_esc(d.customer_name)}</td>
						<td><span class="cd-tag cd-tag-clase-${d.clasificacion}">${CD_CLASE_LABEL[d.clasificacion] || ""}</span></td>
						<td class="r">${this.fmt(d.grand_total)}</td>
					</tr>`).join("") || `<tr><td colspan="4" class="cd-empty">Sin devoluciones el mismo día.</td></tr>`}
				</tbody>
			</table>
			</div>
		</details>
	</div>
</div>`);

		this._render_egresos(editable);
		this._bind_detail(editable);
	}

	_render_egresos(editable) {
		const $b = this.$body.find("#cd-egresos-body");
		if (!this.form.egresos.length && !editable) {
			$b.html(`<tr><td colspan="4" class="cd-empty">Sin egresos anotados.</td></tr>`);
			return;
		}
		$b.html(this.form.egresos.map((e, i) => editable ? `
			<tr data-idx="${i}">
				<td><input type="text" class="cd-input cd-eg" data-f="concepto" value="${_cd_esc(e.concepto)}" placeholder="Concepto"></td>
				<td><input type="number" step="0.01" class="cd-input cd-input-money cd-eg" data-f="monto" value="${_cd_flt(e.monto).toFixed(2)}"></td>
				<td><input type="text" class="cd-input cd-eg" data-f="referencia" value="${_cd_esc(e.referencia)}" placeholder="Recibo / ref."></td>
				<td><input type="text" class="cd-input cd-eg" data-f="observaciones" value="${_cd_esc(e.observaciones)}"></td>
				<td><button type="button" class="cd-icon-btn cd-eg-del" title="Quitar">✕</button></td>
			</tr>` : `
			<tr>
				<td>${_cd_esc(e.concepto)}</td><td class="r">${this.fmt(e.monto)}</td><td>${_cd_esc(e.referencia)}</td><td>${_cd_esc(e.observaciones)}</td>
			</tr>`).join(""));
	}

	_refresh_totals() {
		const t = this._totals();
		this.$body.find("#cd-total-egresos").html(`<b>${this.fmt(t.egresos)}</b>`);
		this.$body.find("#cd-dep-egresos").text(this.fmt(t.egresos));
		this.$body.find("#cd-total-depositar").text(this.fmt(t.a_depositar));
	}

	_bind_detail(editable) {
		// Delegados sobre $body (persistente entre renders): namespaced + off
		// previo para no acumular handlers en cada _render_detail.
		this.$body.off(".cdEgresos");
		this.$body.find("#cd-btn-back").on("click", () => this._go_list());
		this.$body.find("#cd-btn-recalc").on("click", () => this._recompute(() => { this._render_detail(); frappe.show_alert({ message: __("Recalculado."), indicator: "blue" }); }));
		this.$body.find("#cd-btn-print").on("click", () => this._print());

		this.$body.find(".cd-class-box").on("click", (e) => {
			const f = $(e.currentTarget).data("filter");
			this._facturasFilter = this._facturasFilter === f ? null : f;
			this._render_detail();
		});
		this.$body.find("#cd-clear-filter").on("click", (e) => {
			e.preventDefault();
			this._facturasFilter = null;
			this._render_detail();
		});

		if (!this.doc) {
			// Nuevo: cambiar fecha/usuario recalcula (y si ya existe, lo abre).
			const reload = () => {
				const fecha = this.$body.find("#cd-fecha").val();
				const usuario = this.$body.find("#cd-usuario").val() || this.form.usuario;
				if (!fecha) return;
				this._open_new(fecha, usuario, this.form.egresos);
			};
			this.$body.find("#cd-fecha").on("change", reload);
			this.$body.find("#cd-usuario").on("change", reload);
		}

		if (!editable) return;

		const mark = () => { this._dirty = true; };
		this.$body.find("#cd-almacen").on("change", (e) => { this.form.almacen = e.target.value; mark(); });
		this.$body.find("#cd-observaciones").on("input", (e) => { this.form.observaciones = e.target.value; mark(); });

		this.$body.on("input.cdEgresos", ".cd-eg", (e) => {
			const $tr = $(e.target).closest("tr");
			const i = parseInt($tr.data("idx"), 10);
			const f = $(e.target).data("f");
			this.form.egresos[i][f] = f === "monto" ? _cd_flt(e.target.value) : e.target.value;
			mark();
			this._refresh_totals();
		});
		this.$body.on("click.cdEgresos", ".cd-eg-del", (e) => {
			const i = parseInt($(e.target).closest("tr").data("idx"), 10);
			this.form.egresos.splice(i, 1);
			mark();
			this._render_egresos(true);
			this._refresh_totals();
		});
		this.$body.find("#cd-btn-add-egreso").on("click", () => {
			this.form.egresos.push({ concepto: "", monto: 0, referencia: "", observaciones: "" });
			mark();
			this._render_egresos(true);
			this.$body.find("#cd-egresos-body tr:last input:first").focus();
		});

		this.$body.find("#cd-btn-save").on("click", () => this._save(false));
		this.$body.find("#cd-btn-close").on("click", () => this._save(true));
		this.$body.find("#cd-btn-reopen").on("click", () => this._reopen());
		this.$body.find("#cd-btn-delete").on("click", () => this._delete());
	}

	_payload() {
		return {
			name: this.doc ? this.doc.name : "",
			fecha: this.form.fecha,
			usuario: this.form.usuario,
			almacen: this.form.almacen,
			egresos: this.form.egresos,
			observaciones: this.form.observaciones,
		};
	}

	_save(close) {
		if (close) {
			const { alertas } = this._clasificacion_facturas((this.snap || {}).facturas || []);
			if (alertas.length) {
				frappe.msgprint({
					title: __("No se puede cerrar el día"),
					indicator: "red",
					message: __("Hay {0} factura(s) de Contado sin el pago real registrado (100% pendiente). Ingréselo en el facturador clásico antes de cerrar.", [alertas.length]),
				});
				return;
			}
		}
		const t = this._totals();
		const doit = () => {
			frappe.call({
				method: close ? "facex_multi.api.cierre.cerrar_cierre" : "facex_multi.api.cierre.save_cierre",
				args: { payload: JSON.stringify(this._payload()) },
				freeze: true,
				freeze_message: close ? __("Cerrando el día…") : __("Guardando…"),
				callback: (r) => {
					if (r.exc) return;
					this._dirty = false;
					frappe.show_alert({ message: close ? __("Día cerrado. Facturas y pagos quedaron congelados.") : __("Borrador guardado."), indicator: "green" });
					this._reload_pending();
					this._open_existing(r.message.name);
				},
			});
		};
		if (!close) { doit(); return; }
		frappe.confirm(
			`<div style="font-size:14px;">
				<p><b>¿Cerrar el día ${this.short_date(this.form.fecha)} de ${_cd_esc(this.user_label(this.form.usuario))}?</b></p>
				<p>Efectivo cobrado: <b>${this.fmt(t.cobro_efectivo)}</b> · Egresos: <b>${this.fmt(t.egresos)}</b> · A depositar: <b>${this.fmt(t.a_depositar)}</b></p>
				<p class="text-muted">A partir de este momento no se podrán anular facturas ni modificar pagos de esta fecha. Solo un usuario de Gerencia podrá reabrir el cierre.</p>
			</div>`,
			doit
		);
	}

	_reopen() {
		const d = new frappe.ui.Dialog({
			title: __("Reabrir cierre {0}", [this.doc.name]),
			fields: [
				{ fieldtype: "HTML", options: `<p>${__("Al reabrir, las facturas y pagos del {0} vuelven a poder modificarse. Deberá volver a cerrar el día después de corregir.", [this.short_date(this.form.fecha)])}</p>` },
				{ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo de la reapertura"), reqd: 1 },
			],
			primary_action_label: __("Reabrir"),
			primary_action: (v) => {
				d.hide();
				frappe.call({
					method: "facex_multi.api.cierre.reabrir_cierre",
					args: { name: this.doc.name, motivo: v.motivo },
					freeze: true,
					callback: (r) => {
						if (r.exc) return;
						frappe.show_alert({ message: __("Cierre reabierto."), indicator: "orange" });
						this._reload_pending();
						this._open_existing(r.message.name);
					},
				});
			},
		});
		d.show();
	}

	_delete() {
		frappe.confirm(__("¿Eliminar el borrador {0}?", [this.doc.name]), () => {
			frappe.call({
				method: "facex_multi.api.cierre.delete_cierre",
				args: { name: this.doc.name },
				freeze: true,
				callback: (r) => {
					if (r.exc) return;
					this._dirty = false;
					frappe.show_alert({ message: __("Borrador eliminado."), indicator: "orange" });
					this._go_list();
				},
			});
		});
	}

	// ─────────────────────────── IMPRESIÓN ───────────────────────────

	_print() {
		const s = this.snap || {};
		const t = this._totals();
		const fams = s.detalle_familias || [];
		const doc = this.doc;
		const money = (n) => this.fmt(n);
		const almacen = this.form.almacen ? ((this.ctx.warehouses.find((w) => w.name === this.form.almacen) || {}).warehouse_name || this.form.almacen) : "";
		const html = `<!doctype html><html><head><meta charset="utf-8"><title>Cierre Diario ${_cd_esc(this.form.fecha)}</title>
<style>
	body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:24px;}
	h1{font-size:16px;letter-spacing:3px;text-align:center;margin:0 0 14px;}
	table{border-collapse:collapse;width:100%;margin-bottom:14px;}
	th,td{border:1px solid #999;padding:4px 6px;}
	th{background:#e8f4fb;text-align:left;}
	td.r,th.r{text-align:right;}
	.hdr td{border:none;padding:2px 4px;}
	.sec{background:#1f5fa8;color:#fff;font-weight:bold;}
	.tot td{font-weight:bold;background:#f3f4f6;}
	.oferta td{background:#fff7e6;}
	.big{font-size:15px;font-weight:bold;}
	.muted{color:#666;font-size:11px;}
	.grid{display:flex;gap:16px;}
	.grid>div{flex:1;}
	@media print{ body{margin:8mm;} }
</style></head><body>
<h1>D E T A L L E &nbsp; D E &nbsp; V E N T A &nbsp; D I A R I A</h1>
<table class="hdr"><tr><td><b>FECHA</b></td><td>${this.long_date(this.form.fecha)}</td><td><b>USUARIO</b></td><td>${_cd_esc(this.user_label(this.form.usuario))}</td></tr>
<tr><td><b>COMPAÑÍA</b></td><td>${_cd_esc(this.ctx.company)}</td><td><b>ALMACÉN</b></td><td>${_cd_esc(almacen)}</td></tr>
<tr><td><b>CIERRE</b></td><td>${doc ? _cd_esc(doc.name) + " · " + _cd_esc(doc.estado) : "(sin guardar)"}</td><td><b>CERRADO</b></td><td>${doc && doc.cerrado_por ? _cd_esc(doc.cerrado_por) + " " + frappe.datetime.str_to_user(doc.cerrado_en) : "—"}</td></tr></table>

<table><thead><tr><th style="width:36px;">No.</th><th>DESCRIPCIÓN / FAMILIA</th><th class="r">Cantidad</th><th class="r">Precio por Unidad</th><th class="r">TOTAL</th></tr></thead>
<tbody>${fams.map((f, i) => `<tr class="${f.es_oferta ? "oferta" : ""}"><td>${f.es_oferta ? 0 : i}</td><td>${_cd_esc(f.familia)}${f.descripcion && f.descripcion !== f.familia ? ` <span class="muted">${_cd_esc(f.descripcion)}</span>` : ""}</td><td class="r">${this.fmt_qty(f.cantidad)}</td><td class="r">${money(f.precio_unidad)}</td><td class="r">${money(f.total)}</td></tr>`).join("")}
<tr class="tot"><td colspan="2">TOTAL (sin fletes)</td><td class="r">${this.fmt_qty(fams.reduce((a, f) => a + _cd_flt(f.cantidad), 0))}</td><td></td><td class="r">${money(_cd_flt(s.venta_sin_descuento) + _cd_flt(s.venta_con_descuento))}</td></tr></tbody></table>

<table><tr><td colspan="2" class="sec">RESUMEN TOTAL VENTA DEL DÍA ${this.short_date(this.form.fecha)}</td></tr>
<tr><td colspan="2" class="sec" style="background:#3b82c4;">VENTAS</td></tr>
<tr><td>Ventas sin descuento (sin flete)</td><td class="r">${money(s.venta_sin_descuento)}</td></tr>
<tr><td>Piezas en oferta (líneas con descuento)</td><td class="r">${money(s.venta_con_descuento)}</td></tr>
<tr><td>Fletes facturados</td><td class="r">${money(s.flete_facturado)}</td></tr>
${_cd_flt(s.recargo_facturado) ? `<tr><td>Recargo por entrega facturado</td><td class="r">${money(s.recargo_facturado)}</td></tr>` : ""}
${Math.abs(_cd_flt(s.ajuste_impuestos)) >= 0.01 ? `<tr><td>Ajustes (descuento global / redondeo)</td><td class="r">${money(s.ajuste_impuestos)}</td></tr>` : ""}
<tr><td>Devoluciones (facturas de otra fecha anuladas hoy)</td><td class="r">− ${money(s.total_devoluciones)}</td></tr>
<tr class="tot"><td>TOTAL VENTA</td><td class="r">${money(_cd_flt(s.total_venta) - _cd_flt(s.total_devoluciones))}</td></tr>
<tr><td colspan="2" class="sec" style="background:#3b82c4;">CARGOS</td></tr>
<tr><td>Fletes facturados</td><td class="r">${money(s.flete_facturado)}</td></tr>
<tr><td>Recargo por entrega facturado</td><td class="r">${money(s.recargo_facturado)}</td></tr>
<tr class="tot"><td>TOTAL CARGOS</td><td class="r">${money(_cd_flt(s.flete_facturado) + _cd_flt(s.recargo_facturado))}</td></tr>
<tr><td colspan="2" class="sec" style="background:#3b82c4;">COBROS Y CRÉDITOS</td></tr>
<tr><td>Transferencia</td><td class="r">${money(s.cobro_transferencia)}</td></tr>
<tr><td>Cheques</td><td class="r">${money(s.cobro_cheque)}</td></tr>
<tr><td>Pago Efectivo</td><td class="r">${money(s.cobro_efectivo)}</td></tr>
<tr><td>Tarjeta de Crédito</td><td class="r">${money(s.cobro_tarjeta)}</td></tr>
<tr><td>Contra Entrega</td><td class="r">${money(s.cobro_contra_entrega)}</td></tr>
<tr><td>Contado (pendiente de registrar)</td><td class="r">${money(s.contado_pendiente)}</td></tr>
<tr><td>Al Crédito</td><td class="r">${money(s.al_credito)}</td></tr>
<tr class="tot"><td>TOTAL</td><td class="r">${money(s.total_cobros)}</td></tr>
${_cd_flt(s.abonos_anteriores) ? `<tr><td class="muted">Abonos recibidos hoy de facturas anteriores (informativo)</td><td class="r muted">${money(s.abonos_anteriores)}</td></tr>` : ""}
<tr><td colspan="2" class="sec" style="background:#dc2626;">DEVOLUCIONES</td></tr>
<tr><td>Contra Entrega</td><td class="r">${money(s.devoluciones_contra_entrega)}</td></tr>
<tr><td>Al Crédito</td><td class="r">${money(s.devoluciones_credito)}</td></tr>
<tr><td>Contado</td><td class="r">${money(s.devoluciones_contado)}</td></tr>
<tr class="tot"><td>TOTAL DEVOLUCIONES</td><td class="r">${money(s.total_devoluciones)}</td></tr>
<tr><td colspan="2" class="sec" style="background:#3b82c4;">EGRESOS</td></tr>
${this.form.egresos.map((e) => `<tr><td>${_cd_esc(e.concepto)}${e.referencia ? ` <span class="muted">(${_cd_esc(e.referencia)})</span>` : ""}${e.observaciones ? ` <span class="muted">${_cd_esc(e.observaciones)}</span>` : ""}</td><td class="r">${money(e.monto)}</td></tr>`).join("")}
<tr class="tot"><td>TOTAL EGRESOS</td><td class="r">${money(t.egresos)}</td></tr>
<tr class="tot big"><td>TOTAL A DEPOSITAR</td><td class="r">${money(t.a_depositar)}</td></tr>
</table>
${this.form.observaciones ? `<p><b>Observaciones:</b> ${_cd_esc(this.form.observaciones)}</p>` : ""}
<div class="grid" style="margin-top:40px;"><div style="border-top:1px solid #333;text-align:center;padding-top:4px;">Entregado por</div><div style="border-top:1px solid #333;text-align:center;padding-top:4px;">Recibido por</div><div style="border-top:1px solid #333;text-align:center;padding-top:4px;">Gerencia</div></div>
<p class="muted" style="margin-top:20px;">Generado ${frappe.datetime.now_datetime()} por ${_cd_esc(this.ctx.user_fullname)} · FacEx</p>
<script>window.onload=function(){window.print();}</script>
</body></html>`;
		const w = window.open("", "_blank");
		if (!w) { frappe.msgprint(__("El navegador bloqueó la ventana de impresión.")); return; }
		w.document.open();
		w.document.write(html);
		w.document.close();
	}
}

const CD_STYLES = `
body.facex-fullscreen-mode .navbar, body.facex-fullscreen-mode .page-head,
body.facex-fullscreen-mode .layout-side-section, body.facex-fullscreen-mode .standard-sidebar-wrapper,
body.facex-fullscreen-mode .standard-sidebar, body.facex-fullscreen-mode .desk-sidebar,
body.facex-fullscreen-mode .sidebar-left, body.facex-fullscreen-mode .left-sidebar, body.facex-fullscreen-mode .sidebar,
body.facex-fullscreen-mode .page-sidebar, body.facex-fullscreen-mode .body-sidebar-container,
body.facex-fullscreen-mode .body-sidebar, body.facex-fullscreen-mode .footer {
  display:none !important; width:0 !important; min-width:0 !important; max-width:0 !important; margin:0 !important; padding:0 !important;
}
body.facex-fullscreen-mode .layout-main-section, body.facex-fullscreen-mode .page-content, body.facex-fullscreen-mode .page-container,
body.facex-fullscreen-mode .layout-main, body.facex-fullscreen-mode .page-body, body.facex-fullscreen-mode .workspace-layout,
body.facex-fullscreen-mode .layout-container, body.facex-fullscreen-mode #space-layout, body.facex-fullscreen-mode .main-section {
  width:100% !important; max-width:100% !important; margin:0 !important; padding:0 !important; display:block !important;
}

.cd-topbar { display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid #d1d8dd;padding:10px 20px; }
.cd-topbar-left, .cd-topbar-right { display:flex;align-items:center;gap:14px; }
.cd-topbar-logo { display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;color:#153375; }
.cd-topbar-sub { font-weight:600;font-size:13px;color:#6c757d; }
.cd-topbar-company { font-size:12px;font-weight:600;color:#475569;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:20px;padding:3px 10px; }
.cd-topbar-link { background:none;border:none;padding:6px 10px;border-radius:4px;font-size:13px;font-weight:500;color:#495057;cursor:pointer; }
.cd-topbar-link:hover { background:#f1f5f9;color:#153375; }
.cd-user-dropdown { position:relative;display:flex;align-items:center; }
.cd-user-btn { padding:6px 10px;border-radius:20px;background:#f1f5f9;border:1px solid #cbd5e1;display:flex;align-items:center;gap:6px;cursor:pointer; }
.cd-user-menu { display:none;position:absolute;top:120%;right:0;background:#fff;border:1px solid #d1d8dd;box-shadow:0 10px 15px -3px rgba(0,0,0,.1);border-radius:10px;padding:14px;min-width:220px;z-index:1001; }
.cd-user-menu-label { font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6c757d;margin-bottom:4px; }
.cd-user-fullname { font-size:14px;font-weight:700;color:#0f172a; }
.cd-user-email { font-size:12px;color:#6c757d;margin-bottom:14px;word-break:break-all; }
.cd-user-menu-btn { width:100%; }

.cd-wrap { max-width:1280px;margin:0 auto;padding:18px 16px 40px; }
.cd-head { display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px; }
.cd-head-actions { display:flex;gap:8px;flex-wrap:wrap; }
.cd-title { font-size:22px;font-weight:800;color:#0f172a;display:flex;align-items:center;gap:10px;flex-wrap:wrap; }
.cd-subtitle { font-size:13px;color:#6c757d;margin-top:2px;font-weight:600;letter-spacing:.3px; }
.cd-link { background:none;border:none;color:#5e64ff;font-size:13px;padding:0;cursor:pointer;font-weight:600; }
.cd-card { background:#fff;border:1px solid #d1d8dd;border-radius:8px;padding:16px 18px;margin-bottom:14px; }
.cd-card-title { font-size:13px;font-weight:800;color:#153375;letter-spacing:.6px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center; }
.cd-card-title .cd-muted { font-weight:500;letter-spacing:0; }
.cd-muted { color:#6c757d;font-size:12px; }
.cd-hint { color:#6c757d;font-size:11.5px;margin-top:6px; }
.cd-empty { color:#6c757d;text-align:center;padding:24px 10px;font-size:13px; }
.cd-static { font-size:15px;font-weight:700;padding:7px 0; }
.cd-badge { display:inline-block;font-size:11px;font-weight:700;padding:2px 10px;border-radius:12px;border:1px solid;letter-spacing:.3px; }
.cd-tag { display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:8px;background:#e2e8f0;color:#334155;margin-left:4px; }
.cd-tag-oferta { background:#fff7e6;color:#b45309; }
.cd-tag-alerta { background:#fde8e8;color:#b91c1c; }
.cd-tag-clase-contado { background:#eef2ff;color:#3730a3; }
.cd-tag-clase-contra_entrega { background:#fff7e6;color:#b45309; }
.cd-tag-clase-credito { background:#fde8e8;color:#b91c1c; }
.cd-ok { color:#15803d;font-size:11px;margin-left:6px; }
.cd-bad { color:#b91c1c;font-size:11px;margin-left:6px; }

.cd-alert { border-radius:8px;padding:12px 16px;margin-bottom:14px;font-size:13px;border:1px solid; }
.cd-alert-warn { background:#fff7e6;border-color:#fbd38d;color:#7c4a03; }
.cd-alert-ok { background:#e6f7ee;border-color:#86efac;color:#14532d; }
.cd-alert-danger { background:#fde8e8;border-color:#fca5a5;color:#7f1d1d; }
.cd-alert-title { font-weight:700;margin-bottom:6px; }
.cd-alert-chips { display:flex;gap:8px;flex-wrap:wrap; }
.cd-alert-list { margin:8px 0 0;padding-left:18px; }
.cd-alert-list a { font-weight:700; }
.cd-chip { background:#fff;border:1px solid #fbd38d;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;text-align:left;color:#0f172a; }
.cd-chip:hover { border-color:#b45309;box-shadow:0 2px 6px rgba(0,0,0,.08); }
.cd-chip-meta { display:block;color:#6c757d;font-size:11px; }

.cd-class-grid { display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px; }
.cd-class-box { display:block;text-align:left;background:#fafbfc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 14px;cursor:pointer;font-family:inherit; }
.cd-class-box:hover { border-color:#94a3b8;box-shadow:0 2px 6px rgba(0,0,0,.06); }
.cd-class-active { border-color:#5e64ff;box-shadow:0 0 0 2px rgba(94,100,255,.18);background:#f5f6ff; }
.cd-class-label { font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;letter-spacing:.4px; }
.cd-class-count { font-size:22px;font-weight:800;color:#0f172a;line-height:1.3; }
.cd-class-total { font-size:13px;font-weight:700;color:#334155; }
.cd-class-warn { font-size:11px;font-weight:700;color:#b91c1c;margin-top:4px; }
.cd-row-alert td { background:#fff7e6; }

.cd-filters { display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-bottom:12px; }
.cd-field { display:flex;flex-direction:column;gap:4px;min-width:150px; }
.cd-field label { font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;letter-spacing:.4px; }
.cd-input { padding:7px 10px;border:1px solid #d1d8dd;border-radius:4px;font-size:13px;background:#fff;width:100%; }
.cd-input:focus { outline:none;border-color:#5e64ff;box-shadow:0 0 0 2px rgba(94,100,255,.15); }
.cd-input:disabled { background:#f8fafc;color:#475569; }
.cd-input-money { text-align:right;max-width:150px; }
.cd-grid-4 { display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px; }
.cd-grid-3 { display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px; }
.cd-grid-2 { display:grid;grid-template-columns:2fr 1fr;gap:14px; }
@media (max-width:900px){ .cd-grid-2 { grid-template-columns:1fr; } }

.cd-block { border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;background:#fafbfc; }
.cd-block-title { background:#1f5fa8;color:#fff;font-weight:800;font-size:12px;letter-spacing:.6px;padding:5px 10px;border-radius:4px;margin:-4px -6px 10px; }
.cd-line { display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 0;border-bottom:1px dashed #e2e8f0;font-size:13px; }
.cd-line:last-child { border-bottom:none; }
.cd-line-total { border-top:2px solid #1f5fa8;margin-top:4px;padding-top:8px;font-size:14px; }
.cd-line-total b { font-size:15px; }

.cd-block-devol { border-color:#fca5a5;background:#fef2f2; }
.cd-block-title-devol { background:#dc2626; }
.cd-devol-label, .cd-devol-label b { color:#b91c1c; }

.cd-table-wrap { overflow-x:auto; }
.cd-table { width:100%;border-collapse:collapse;font-size:13px; }
.cd-table th { text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#475569;background:#f1f5f9;padding:8px 10px;border-bottom:1px solid #d1d8dd;white-space:nowrap; }
.cd-table td { padding:8px 10px;border-bottom:1px solid #eef2f7;vertical-align:middle; }
.cd-table th.r, .cd-table td.r { text-align:right;white-space:nowrap; }
.cd-table tfoot td { font-weight:800;background:#f8fafc;border-top:2px solid #1f5fa8; }
.cd-table-sm { font-size:12px; }
.cd-table-sm td, .cd-table-sm th { padding:5px 8px; }
.cd-row { cursor:pointer; }
.cd-row:hover td { background:#f0f4ff; }
.cd-row-oferta td { background:#fff7e6; }
.cd-table-egresos td { padding:4px 6px; }
.cd-table-egresos .cd-input { padding:5px 8px; }
.cd-icon-btn { background:none;border:none;color:#b91c1c;cursor:pointer;font-size:14px;padding:4px 6px; }
.cd-details summary { cursor:pointer;font-size:13px;padding:6px 0; }
.cd-details table { margin-top:8px; }

.cd-card-deposit { background:linear-gradient(135deg,#153375,#1f5fa8);color:#fff;border:none; }
.cd-deposit-label { font-size:12px;font-weight:800;letter-spacing:1px;opacity:.9; }
.cd-deposit-value { font-size:34px;font-weight:900;margin:6px 0 2px;letter-spacing:-.5px; }
.cd-deposit-formula { font-size:12px;opacity:.85; }
.cd-card-deposit .cd-field label { color:#dbeafe; }
.cd-card-deposit textarea.cd-input { color:#0f172a; }

.cd-btn { padding:8px 16px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:600; }
.cd-btn:disabled { opacity:.5;cursor:not-allowed; }
.cd-btn-primary { background:#5e64ff;color:#fff; }
.cd-btn-primary:hover { background:#4b51e0; }
.cd-btn-success { background:#15803d;color:#fff; }
.cd-btn-success:hover { background:#166534; }
.cd-btn-secondary { background:#e9ecef;color:#495057; }
.cd-btn-secondary:hover { background:#dee2e6; }
.cd-btn-danger { background:#fff;color:#e03e2d;border:1px solid #e03e2d; }
.cd-btn-danger:hover { background:#fde8e8; }
.cd-btn-ghost { background:none;color:#5e64ff;border:1px dashed #c7d2fe;margin-top:8px; }
.cd-btn-ghost:hover { background:#eef2ff; }
`;
