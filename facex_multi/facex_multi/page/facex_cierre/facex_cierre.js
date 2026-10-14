// FacEx Multi — Cierre Diario de Ventas y Cuadre de Pagos
// Page interactiva sobre el DocType «FacEx Cierre Diario» (ver api/cierre.py).
//
// Un cierre = Compañía + Fecha + Usuario (caja) + Serie. La serie es
// obligatoria: «Todas» consolida todas las series del usuario; una serie
// concreta obliga a cerrar ese día serie por serie (ver api/cierre.py).
// El usuario con permiso puede_crear_cierres cuadra y cierra SUS ventas del día; Gerencia
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
	facex_multi.setup_back_guard({ to: "/app/facex", is_dirty: () => wrapper.facexCierre.is_dirty(), on_back: () => wrapper.facexCierre.on_back() });
};

frappe.pages["facex-cierre"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	if (!wrapper.facexCierre) return;
	facex_multi.setup_back_guard({ to: "/app/facex", is_dirty: () => wrapper.facexCierre.is_dirty(), on_back: () => wrapper.facexCierre.on_back() });
	// Ruta profunda: /app/facex-cierre?fecha=YYYY-MM-DD&usuario=...[&serie=...] abre
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
		this.form = { fecha: "", usuario: "", serie: "", almacen: "", egresos: [], observaciones: "" };
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

	// «Atrás» del navegador: desde el Cierre General vuelve a la lista de cierres
	// (sin salir de la page).
	on_back() {
		if (this._view === "general") {
			this._go_list();
			return true;
		}
		return false;
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
		// /app/facex-cierre?view=general&desde=…&hasta=…&usuarios=a,b — el Cierre
		// General mantiene su filtro en la URL para que «Atrás» (p. ej. al volver
		// de abrir una factura) regrese justo aquí. Sin permiso cae en la lista.
		if (q.view === "general") {
			if (this._view === "general") return;
			if (this.ctx.puede_cierre_general) {
				this._open_general({
					desde: q.desde || this.ctx.today, hasta: q.hasta || q.desde || this.ctx.today,
					usuarios: q.usuarios ? String(q.usuarios).split(",").filter(Boolean) : [],
				});
				return;
			}
			history.replaceState(null, "", "/app/facex-cierre");
			this._render_list();
			return;
		}
		if (q.name || q.fecha) {
			history.replaceState(null, "", "/app/facex-cierre");
			if (q.name) this._open_existing(q.name);
			else this._open_new(q.fecha, q.usuario || this.ctx.user, null, q.serie || "");
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
				<button type="button" class="cd-btn cd-user-menu-btn" id="cd-btn-reload" title="Limpia la caché y recarga con la última versión"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>Recargar</button>
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
		this.$root.find("#cd-btn-reload").on("click", () => facex_multi.reload_app(this.is_dirty()));
		this.$root.find("#cd-btn-logout").on("click", () => frappe.app.logout());
	}

	_go_list() {
		const go = () => {
			this._dirty = false;
			if (this._view === "general") history.replaceState(null, "", "/app/facex-cierre");
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
			<div class="cd-subtitle">${_cd_esc(ctx.company)} · ${ctx.es_gerencia ? "Supervisión: ve los cierres de todos los usuarios" : "Solo sus propios cierres"}</div>
		</div>
		<div class="cd-head-actions">
			${canCreate ? `<button type="button" class="cd-btn cd-btn-primary" id="cd-btn-new">+ Nuevo cierre</button>` : ""}
		</div>
	</div>

	${ctx.puede_cierre_general ? `<button type="button" class="cd-general-btn" id="cd-btn-general">
		<span class="cd-general-ico">📊</span><span>Ir a Cierre Diario General</span><span class="cd-general-arrow">→</span>
	</button>` : ""}

	<div id="cd-pending" class="cd-alert ${pend.length ? "cd-alert-warn" : "cd-alert-ok"}">
		${pend.length
			? `<div class="cd-alert-title">⚠ ${pend.length} día(s) con ventas pendientes de cierre</div>
			   <div class="cd-alert-chips">${pend.map((p, i) => `
					<button type="button" class="cd-chip" data-idx="${i}">
						<b>${this.short_date(p.fecha)}</b>${ctx.es_gerencia ? ` · ${_cd_esc(p.usuario_nombre || p.usuario)}` : ""}
						<span class="cd-chip-meta">${p.num_facturas} fact. · ${this.fmt(p.total_venta)}${p.estado ? ` · ${_cd_esc(p.estado)}` : ""}</span>
						${(p.series_pendientes || []).length ? `<span class="cd-chip-meta">Falta: ${p.series_pendientes.map((x) => _cd_esc(x.label)).join(", ")}</span>` : ""}
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
		// Informe gerencial: se abre aquí mismo (vista interna), por defecto el día de hoy.
		this.$body.find("#cd-btn-general").on("click", () => this._open_general({ desde: ctx.today, hasta: ctx.today, usuarios: [] }));
		this.$body.find(".cd-chip").on("click", (e) => {
			const p = pend[parseInt($(e.currentTarget).data("idx"), 10)];
			// Día por serie con una sola serie pendiente: directo a esa serie;
			// si no, el selector de serie del día.
			const sp = p.series_pendientes || [];
			if (p.cierre) this._open_existing(p.cierre);
			else if (sp.length === 1 && sp[0].cierre) this._open_existing(sp[0].cierre);
			else if (sp.length === 1) this._open_new(p.fecha, p.usuario, null, sp[0].serie);
			else this._open_new(p.fecha, p.usuario);
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
		<th>Fecha</th><th>Usuario</th><th>Serie</th><th>Estado</th><th class="r">Facturas</th><th class="r">Venta</th><th class="r">Terceros</th>
		<th class="r">Efectivo</th><th class="r">Crédito</th><th class="r">Egresos</th><th class="r">A depositar</th><th>Cerrado</th>
	</tr></thead>
	<tbody>${rows.map((c) => `
		<tr class="cd-row" data-name="${_cd_esc(c.name)}">
			<td><b>${this.short_date(c.fecha)}</b><div class="cd-muted">${_cd_esc(c.name)}</div></td>
			<td>${_cd_esc(c.usuario_nombre || c.usuario)}</td>
			<td>${_cd_esc(c.serie_label || c.serie)}</td>
			<td>${this.badge(c.estado)}</td>
			<td class="r">${c.num_facturas || 0}</td>
			<td class="r">${this.fmt(c.venta_neta)}</td>
			<td class="r">${this.fmt(c.cargos_pasarela)}</td>
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

	// ─────────────────────── CIERRE DIARIO GENERAL ───────────────────────
	// Informe gerencial (api/cierre_general.py): 3 tablas por tienda/vendedor.
	// Solo con el permiso reporte_cierre_general; el servidor lo vuelve a exigir.

	_open_general(f) {
		if (!this.ctx || !this.ctx.puede_cierre_general) return this._render_list();
		this._view = "general";
		this.doc = null;
		this.snap = null;
		this._gen = { desde: f.desde, hasta: f.hasta, usuarios: f.usuarios || [], data: null };
		const ctx = this.ctx;
		const sel = this._gen.usuarios;
		this.$body.html(`
<div class="cd-wrap">
	<div class="cd-head">
		<div>
			<button type="button" class="cd-link" id="cd-btn-back">← Cierres</button>
			<div class="cd-title">Cierre Diario General</div>
			<div class="cd-subtitle">${_cd_esc(ctx.company)} · consolidado por tienda / vendedor</div>
		</div>
		<div class="cd-head-actions"><button type="button" class="cd-btn cd-btn-secondary" id="cd-g-pdf">Ver PDF</button><button type="button" class="cd-btn cd-btn-primary" id="cd-g-export">Exportar a Excel</button></div>
	</div>
	<div class="cd-card">
		<div class="cd-filters">
			<div class="cd-field"><label>Desde</label><input type="date" id="cd-g-desde" class="cd-input" value="${_cd_esc(f.desde)}" max="${ctx.today}"></div>
			<div class="cd-field"><label>Hasta</label><input type="date" id="cd-g-hasta" class="cd-input" value="${_cd_esc(f.hasta)}" max="${ctx.today}"></div>
			<div class="cd-field cd-g-users">
				<label>Tienda / Vendedor</label>
				<button type="button" class="cd-input cd-g-users-btn" id="cd-g-users-btn"><span id="cd-g-users-txt"></span><span class="cd-g-caret">▾</span></button>
				<div class="cd-g-users-panel" id="cd-g-users-panel" style="display:none;">
					<label class="cd-g-all"><input type="checkbox" id="cd-g-users-all"> <b>Todas</b></label>
					${(ctx.users || []).map((u) => `<label><input type="checkbox" class="cd-g-user" value="${_cd_esc(u.name)}" ${sel.includes(u.name) ? "checked" : ""}> ${_cd_esc(u.full_name || u.name)}</label>`).join("")}
				</div>
			</div>
			<div class="cd-field" style="align-self:end;"><button type="button" class="cd-btn cd-btn-primary" id="cd-g-run">Generar</button></div>
		</div>
		<div id="cd-g-out" class="cd-g-out"><div class="cd-empty">Cargando…</div></div>
	</div>
</div>`);
		const $b = this.$body;
		$b.find("#cd-btn-back").on("click", () => this._go_list());
		$b.find("#cd-g-run").on("click", () => this._run_general());
		$b.find("#cd-g-export").on("click", () => this._export_general("xlsx"));
		$b.find("#cd-g-pdf").on("click", () => this._export_general("pdf"));
		const paintUsers = () => {
			const n = this._gen.usuarios.length;
			const names = this._gen.usuarios.map((u) => this.user_label(u));
			$b.find("#cd-g-users-txt").text(!n ? "Todas las tiendas" : (n <= 2 ? names.join(", ") : `${n} seleccionadas`));
			$b.find("#cd-g-users-all").prop("checked", !n);
		};
		paintUsers();
		$b.find("#cd-g-users-btn").on("click", (e) => { e.stopPropagation(); $b.find("#cd-g-users-panel").toggle(); });
		$b.find("#cd-g-users-panel").on("click", (e) => e.stopPropagation());
		$b.find(".cd-g-user").on("change", () => {
			this._gen.usuarios = $b.find(".cd-g-user:checked").map((_, el) => el.value).get();
			paintUsers();
		});
		$b.find("#cd-g-users-all").on("change", (e) => {
			if (e.target.checked) { this._gen.usuarios = []; $b.find(".cd-g-user").prop("checked", false); }
			paintUsers();
		});
		$(document).off("click.cdGenUsers").on("click.cdGenUsers", () => $b.find("#cd-g-users-panel").hide());
		this._run_general();
	}

	_run_general() {
		const g = this._gen;
		g.desde = this.$body.find("#cd-g-desde").val() || this.ctx.today;
		g.hasta = this.$body.find("#cd-g-hasta").val() || g.desde;
		this.$body.find("#cd-g-users-panel").hide();
		const qs = `view=general&desde=${g.desde}&hasta=${g.hasta}${g.usuarios.length ? "&usuarios=" + encodeURIComponent(g.usuarios.join(",")) : ""}`;
		history.replaceState(null, "", `/app/facex-cierre?${qs}`);
		const $out = this.$body.find("#cd-g-out");
		$out.html(`<div class="cd-empty">Calculando…</div>`);
		frappe.call({
			method: "facex_multi.api.cierre_general.get_cierre_general",
			args: { start_date: g.desde, end_date: g.hasta, usuarios: g.usuarios, company: this.ctx.company },
			callback: (r) => {
				if (this._view !== "general") return;
				g.data = r.message;
				this._render_general_tables(r.message);
			},
			error: () => $out.html(`<div class="cd-empty">No se pudo generar el informe (¿sin permiso?).</div>`),
		});
	}

	_render_general_tables(data) {
		const Q = (v) => this.fmt(v);
		const fd = (d) => this.short_date(d);
		const rows = data.rows || [];
		const T = data.totales || {};
		const multi = !!data.es_rango;
		const rango = multi ? `${fd(data.start_date)} al ${fd(data.end_date)}` : fd(data.start_date);
		const cheque = !!data.mostrar_cheque_tc;
		const eye = (i, sec) => `<button type="button" class="cd-g-eye" data-i="${i}" data-sec="${sec}" title="Ver el detalle"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></button>`;
		const num = (v, bold) => `<td class="r ${(v || 0) < 0 ? "cd-g-neg" : ""}">${bold ? `<b>${Q(v)}</b>` : Q(v)}</td>`;
		const cnt = (v) => `<td class="r"><b>${v || 0}</b></td>`;
		const name = (r, i, sec) => `<td class="cd-g-name">${_cd_esc(r.nombre)}${r.en_vivo ? ' <span class="cd-g-live" title="Sin cierre presentado: datos en tiempo real">EN VIVO</span>' : ""}${eye(i, sec)}</td>`;
		const tot = (cells) => `<tr class="cd-g-total">${cells}</tr>`;
		const box = (t, b, note) => `<div class="cd-g-box"><div class="cd-g-box-title">${t}</div><div class="cd-table-wrap">${b}</div>${note ? `<div class="cd-g-note">${note}</div>` : ""}</div>`;

		let html = `<div class="cd-g-banner">
			<div><div class="cd-g-h1">CIERRE DIARIO GENERAL</div>
			<div class="cd-g-range ${multi ? "multi" : ""}">${multi ? "Del " + rango : "Fecha: " + rango}</div></div>
			<div class="cd-muted">${multi ? "Agrupado por tienda / vendedor" : ""}</div></div>`;
		// Dos cuadros compactos lado a lado (no crecen hacia abajo): días con venta
		// que aún no tienen cierre, y días sin venta por usuario.
		const lista = (arr) => arr.map((x) => `<li><b>${_cd_esc(x.nombre)}</b>: ${x.fechas.map(fd).join(", ")}</li>`).join("");
		const sc = data.sin_cierre || [];
		const sv = data.sin_venta || [];
		html += `<div class="cd-g-notes">
			<div class="cd-g-note-box cd-g-note-warn"><div class="cd-g-note-t">⚠ Fechas aún sin cierre diario <small>(con facturas emitidas · datos en tiempo real)</small></div>
				${sc.length ? `<ul>${lista(sc)}</ul>` : '<div class="cd-g-note-ok">✓ Todos los días con venta tienen cierre.</div>'}</div>
			<div class="cd-g-note-box"><div class="cd-g-note-t">Días sin venta para usuarios</div>
				${sv.length ? `<ul>${lista(sv)}</ul>` : '<div class="cd-g-note-ok">Todos los usuarios vendieron en todas las fechas.</div>'}</div>
		</div>`;
		if (!rows.length) {
			this.$body.find("#cd-g-out").html(html + `<div class="cd-empty">Sin movimiento en ${multi ? "el rango" : "la fecha"} seleccionada.</div>`);
			return;
		}
		const right = (r) => `${num(r.transfer)}${num(r.efectivo)}${cheque ? num(r.cheque_tc) : ""}${num(r.gastos)}${num(r.liquido, true)}${num(r.transfer_fletes, true)}`;
		html += box("TABLA 1 · VENTAS DEL DÍA", `
<table class="cd-table cd-g-table">
	<thead>
		<tr><th colspan="5" class="cd-g-grp cd-g-grp-v">VENTAS DEL DÍA <small>(sin flete ni recargo)</small></th>
			<th colspan="${cheque ? 6 : 5}" class="cd-g-grp cd-g-grp-p">ANEXO · PAGOS</th></tr>
		<tr><th>Tienda / Vendedor</th><th class="r">Venta del día</th><th class="r">Créditos</th><th class="r">Mercadería COD</th><th class="r">Total</th>
			<th class="r cd-g-sep">Transfer / Depo</th><th class="r">Efectivo</th>${cheque ? '<th class="r">Cheques / TC</th>' : ""}<th class="r">Gastos</th><th class="r">Líquido x Recibir</th><th class="r">Transfer/Depo + Fletes previo depo</th></tr>
	</thead>
	<tbody>
		${rows.map((r, i) => `<tr>${name(r, i, "ventas")}${num(r.venta)}${num(r.creditos)}${num(r.cod)}${num(r.total, true)}${right(r)}</tr>`).join("")}
		${tot(`<td>TOTAL</td>${num(T.venta, true)}${num(T.creditos, true)}${num(T.cod, true)}${num(T.total, true)}${right(T)}`)}
	</tbody>
</table>`, "Venta, créditos y COD sin flete ni recargo (los toma del pie de la factura). Líquido x Recibir = Efectivo − Gastos.");
		html += box("TABLA 2 · LIQUIDACIÓN DE CXC", `
<table class="cd-table cd-g-table">
	<thead><tr><th>Tienda / Vendedor</th><th class="r">Clientes al Crédito</th><th class="r">Clientes COD x Liquidaciones</th><th class="r">Total</th></tr></thead>
	<tbody>
		${rows.map((r, i) => `<tr>${name(r, i, "cxc")}${num(r.cxc_credito)}${num(r.cxc_cod)}${num(r.cxc_total, true)}</tr>`).join("")}
		${tot(`<td>TOTAL</td>${num(T.cxc_credito, true)}${num(T.cxc_cod, true)}${num(T.cxc_total, true)}`)}
	</tbody>
</table>`, "Cobros del período de facturas de días anteriores, sin flete ni recargo.");
		html += box("TABLA 3 · COBROS DE FLETES DEL DÍA", `
<table class="cd-table cd-g-table">
	<thead><tr><th>Tienda / Vendedor</th><th class="r">Cant. PD</th><th class="r">Fletes Previo Depo Q</th><th class="r">Cant. Liq</th><th class="r">Fletes COD x Liquidación Q</th><th class="r">Total Cant.</th><th class="r">Total Q</th></tr></thead>
	<tbody>
		${rows.map((r, i) => `<tr>${name(r, i, "fletes")}${cnt(r.fletes_pd_cant)}${num(r.fletes_pd_q)}${cnt(r.fletes_liq_cant)}${num(r.fletes_liq_q)}${cnt(r.fletes_total_cant)}${num(r.fletes_total_q, true)}</tr>`).join("")}
		${tot(`<td>TOTAL</td>${cnt(T.fletes_pd_cant)}${num(T.fletes_pd_q, true)}${cnt(T.fletes_liq_cant)}${num(T.fletes_liq_q, true)}${cnt(T.fletes_total_cant)}${num(T.fletes_total_q, true)}`)}
	</tbody>
</table>`, "PD = flete de facturas pagadas el mismo día de la venta por transferencia/depósito. Liq = flete de clientes COD conciliados con la carga de guías.");

		const $out = this.$body.find("#cd-g-out");
		$out.html(html);
		$out.find(".cd-g-eye").on("click", (e) => this._general_detalle($(e.currentTarget).data("i"), $(e.currentTarget).data("sec"), rango));
	}

	// Ojo: detalle de una tienda para resolver dudas sin salir del informe.
	_general_detalle(i, sec, rango) {
		const r = ((this._gen.data || {}).rows || [])[i];
		if (!r) return;
		const Q = (v) => this.fmt(v);
		const d = r.detalle || {};
		const COND = { contado: "Contado", credito: "Crédito", contra_entrega: "Contra Entrega" };
		const link = (n) => `<a href="#" class="cd-g-inv" data-inv="${_cd_esc(n)}">${_cd_esc(n)}</a>`;
		const td = (v, b) => `<td class="r">${b ? `<b>${Q(v)}</b>` : Q(v)}</td>`;
		const table = (head, body, empty) => body
			? `<div class="cd-table-wrap"><table class="cd-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`
			: `<div class="cd-empty">${empty}</div>`;
		let title, html;
		if (sec === "cxc") {
			title = "Liquidación de CXC";
			html = table(["Fecha cobro", "Factura", "Cliente", "Tipo", "Forma", "Cobrado", "Flete/Recargo", "Neto"],
				(d.recuperaciones || []).map((x) => `<tr><td>${this.short_date(x.fecha)}</td><td>${link(x.factura)}</td><td>${_cd_esc(x.cliente || "")}</td><td>${x.tipo === "cod" ? "COD x liquidación" : "Crédito"}</td><td>${_cd_esc(x.forma || "")}</td>${td(x.cobrado)}${td(-x.cargos)}${td(x.neto, true)}</tr>`).join(""),
				"Sin cobros de cartera en el período.");
		} else if (sec === "fletes") {
			title = "Cobros de fletes";
			html = table(["Fecha", "Factura", "Cliente", "Tipo", "Guía", "Flete"],
				(d.fletes || []).map((x) => `<tr><td>${this.short_date(x.fecha)}</td><td>${link(x.factura)}</td><td>${_cd_esc(x.cliente || "")}</td><td>${x.tipo === "PD" ? "Previo depósito" : "COD x liquidación"}</td><td>${_cd_esc(x.guia || "")}</td>${td(x.monto, true)}</tr>`).join(""),
				"Sin fletes cobrados en el período.");
		} else {
			title = "Ventas del día";
			html = table(["Fecha", "Factura", "Cliente", "Condición", "Total fact.", "Flete/Recargo", "Venta", "Crédito", "COD", "Formas de pago"],
				(d.facturas || []).map((x) => `<tr><td>${this.short_date(x.fecha)}</td><td>${link(x.factura)}${x.devolucion ? ' <small class="cd-g-neg">DEV</small>' : ""}</td><td>${_cd_esc(x.cliente || "")}</td><td>${COND[x.clasificacion] || ""}</td>${td(x.total)}${td(-x.cargos)}${td(x.venta, true)}${td(x.credito)}${td(x.cod)}<td class="cd-muted">${_cd_esc(x.formas_pago || "")}</td></tr>`).join(""),
				"Sin facturas en el período.");
		}
		const dlg = new frappe.ui.Dialog({ title: `${title} · ${r.nombre} · ${rango}`, size: "extra-large", fields: [{ fieldtype: "HTML", fieldname: "h" }] });
		dlg.fields_dict.h.$wrapper.html(`<style>${CD_STYLES}</style>${html}`);
		dlg.show();
		// Abrir la factura sale de esta page; la URL del informe ya quedó guardada
		// (replaceState), así que «Atrás» regresa a este mismo informe y filtro.
		dlg.$wrapper.on("click", ".cd-g-inv", (e) => {
			e.preventDefault();
			window.location.href = `/app/facex?invoice=${encodeURIComponent($(e.currentTarget).data("inv"))}`;
		});
	}

	// Excel (descarga) o PDF (se abre en otra pestaña para verlo), con los filtros
	// actuales; el servidor vuelve a exigir el permiso.
	_export_general(formato) {
		const g = this._gen || {};
		const qs = [
			`start_date=${encodeURIComponent(g.desde)}`, `end_date=${encodeURIComponent(g.hasta)}`,
			`company=${encodeURIComponent(this.ctx.company)}`, `formato=${formato}`,
			g.usuarios && g.usuarios.length ? `usuarios=${encodeURIComponent(JSON.stringify(g.usuarios))}` : "",
		].filter(Boolean).join("&");
		window.open(`/api/method/facex_multi.api.cierre_general.export_cierre_general?${qs}`, "_blank");
	}

	// ─────────────────────────── DETALLE ───────────────────────────

	_open_new(fecha, usuario, keep_egresos, serie) {
		// Sin serie el servidor solo devuelve las series del día y se muestra el
		// selector (elegir serie o «Todas» es obligatorio). Si ya existe un
		// cierre para esa fecha/usuario/serie, se abre en vez de duplicar.
		frappe.call({
			method: "facex_multi.api.cierre.compute_preview",
			args: { fecha, usuario, serie: serie || "" },
			freeze: true,
			freeze_message: __("Calculando el día…"),
			callback: (r) => {
				const snap = r.message;
				if (snap.requiere_serie) {
					// Día sin cierres y una sola serie con movimiento: «Todas» y esa serie
					// dan lo mismo, así que se abre directo el cierre de esa serie.
					const sd = snap.series_dia || {};
					const activas = (sd.series || []).filter((o) => o.num_facturas > 0 || o.con_cobros);
					if (!sd.modo && activas.length === 1) {
						this._open_new(fecha, usuario, keep_egresos, activas[0].serie);
						return;
					}
					this._render_picker(fecha, usuario, snap.series_dia, keep_egresos);
					return;
				}
				if (snap.existing) {
					this._open_existing(snap.existing);
					return;
				}
				this.doc = null;
				this.snap = snap;
				this.form = {
					fecha, usuario, serie: snap.serie,
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
					serie: this.doc.serie,
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

	// Selector obligatorio de serie: «Todas» (consolidado) o una serie concreta
	// (el día pasa a cerrarse serie por serie). El modo que ya tenga el día
	// deshabilita la otra forma.
	_render_picker(fecha, usuario, info, keep_egresos) {
		this._view = "picker";
		this.doc = null;
		this.snap = null;
		const ctx = this.ctx;
		const modo = info.modo || "";
		const opt = (o, disabled, why) => `
			<button type="button" class="cd-serie-opt ${o.serie === "Todas" ? "cd-serie-todas" : ""}" data-serie="${_cd_esc(o.serie)}" data-name="${_cd_esc(o.cierre || "")}" ${disabled ? "disabled" : ""} title="${_cd_esc(why || o.serie)}">
				<div class="cd-serie-head"><b>${_cd_esc(o.label)}</b>${o.estado ? this.badge(o.estado) : ""}</div>
				<div class="cd-serie-meta">${o.num_facturas || 0} fact. · ${this.fmt(o.total_venta)}${o.con_cobros ? " · con cobros de cartera" : ""}</div>
				${o.serie !== "Todas" ? `<div class="cd-serie-code">${_cd_esc(o.serie)}</div>` : `<div class="cd-serie-code">Consolidado, como hasta ahora</div>`}
				${why ? `<div class="cd-serie-why">${_cd_esc(why)}</div>` : ""}
			</button>`;
		// Solo las series del día (con movimiento o con cierre); las configuradas
		// sin uso se ocultan, salvo que no haya ninguna con movimiento.
		const todas_series = info.series || [];
		const en_uso = todas_series.filter((o) => o.num_facturas > 0 || o.con_cobros || o.cierre);
		const series = en_uso.length ? en_uso : todas_series;
		this.$body.html(`
<div class="cd-wrap">
	<div class="cd-head">
		<div>
			<button type="button" class="cd-link" id="cd-btn-back">← Cierres</button>
			<div class="cd-title">Nuevo Cierre Diario ${this.badge("Nuevo")}</div>
			<div class="cd-subtitle">${this.long_date(fecha)}</div>
		</div>
	</div>
	<div class="cd-card">
		<div class="cd-grid-4">
			<div class="cd-field"><label>Fecha</label><input type="date" id="cd-fecha" class="cd-input" value="${_cd_esc(fecha)}" max="${ctx.today}"></div>
			<div class="cd-field"><label>Usuario (caja)</label>
				${ctx.es_gerencia
					? `<select id="cd-usuario" class="cd-input">${ctx.users.map((u) => `<option value="${_cd_esc(u.name)}" ${u.name === usuario ? "selected" : ""}>${_cd_esc(u.full_name || u.name)}</option>`).join("")}</select>`
					: `<input type="text" class="cd-input" value="${_cd_esc(this.user_label(usuario))}" disabled>`}
			</div>
		</div>
	</div>
	<div class="cd-card">
		<div class="cd-card-title">ELIJA LA SERIE A CERRAR <span class="cd-muted">obligatorio</span></div>
		<div class="cd-hint" style="margin-bottom:12px;">
			<b>Todas las series</b> genera un solo cierre consolidado. Si elige <b>una serie</b>, este día se cierra serie por serie:
			cada serie con movimiento necesita su propio cierre y el día no queda completo hasta cerrarlas todas.
		</div>
		${modo === "serie" ? `<div class="cd-alert cd-alert-warn">Este día ya se está cerrando <b>por serie</b>: elija la serie que le toca.</div>` : ""}
		${modo === "todas" ? `<div class="cd-alert cd-alert-warn">Este día ya tiene un cierre <b>consolidado</b>.</div>` : ""}
		<div class="cd-serie-grid">
			${opt(info.todas, modo === "serie", modo === "serie" ? "No disponible: el día ya se cierra por serie." : "")}
			${series.map((o) => opt(o, modo === "todas", modo === "todas" ? "No disponible: el día ya tiene cierre consolidado." : "")).join("")}
		</div>
		${!series.length ? `<div class="cd-hint">El usuario no tiene facturas, cobros ni series configuradas para esta fecha.</div>` : ""}
	</div>
</div>`);
		this.$body.find("#cd-btn-back").on("click", () => this._go_list());
		this.$body.find(".cd-serie-opt").on("click", (e) => {
			const $o = $(e.currentTarget);
			if ($o.data("name")) this._open_existing($o.data("name"));
			else this._open_new(fecha, usuario, keep_egresos, String($o.data("serie")));
		});
		const reload = () => {
			const f = this.$body.find("#cd-fecha").val();
			if (f) this._open_new(f, this.$body.find("#cd-usuario").val() || usuario, keep_egresos);
		};
		this.$body.find("#cd-fecha, #cd-usuario").on("change", reload);
	}

	_recompute(cb) {
		frappe.call({
			method: "facex_multi.api.cierre.compute_preview",
			args: { fecha: this.form.fecha, usuario: this.form.usuario, serie: this.form.serie },
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
		const recuperado_efectivo = _cd_flt(s.recuperado_efectivo);
		// Solo el efectivo se entrega para depósito (el de la venta del día más
		// el recuperado hoy de facturas anteriores): transferencias, depósitos
		// bancarios, tarjeta, cheque, contra entrega y crédito no pasan por la caja.
		return { egresos, total_venta, cobro_efectivo, recuperado_efectivo,
			a_depositar: cobro_efectivo + recuperado_efectivo - egresos };
	}

	// Recuperación de cartera: pagos de hoy a facturas de días anteriores. Va
	// en su propia tarjeta para no mezclarse con el cuadre de la venta del día.
	_recuperacion_html(s) {
		const rows = s.abonos_detalle || [];
		if (!rows.length) return "";
		const tipos = s.recuperado_por_tipo;
		const formas = s.recuperado_por_forma;
		// Snapshots anteriores a esta versión solo traen forma y monto.
		if (!tipos || !formas) {
			return `<div class="cd-card"><div class="cd-card-title">RECUPERACIÓN DE CARTERA <span class="cd-muted">cobros de hoy a facturas de días anteriores</span></div>
			<table class="cd-table cd-table-sm"><thead><tr><th>Factura</th><th>Cliente</th><th>Fecha factura</th><th>Forma</th><th>Ref.</th><th class="r">Monto</th></tr></thead>
			<tbody>${rows.map((a) => `<tr><td>${_cd_esc(a.sales_invoice)}</td><td>${_cd_esc(a.customer_name)}</td><td>${this.short_date(a.posting_date)}</td><td>${_cd_esc(a.payment_method)}</td><td>${_cd_esc(a.reference)}</td><td class="r">${this.fmt(a.amount)}</td></tr>`).join("")}</tbody>
			<tfoot><tr><td colspan="5">TOTAL</td><td class="r">${this.fmt(s.abonos_anteriores)}</td></tr></tfoot></table></div>`;
		}
		const recibido_venta = ["cobro_efectivo", "cobro_transferencia", "cobro_cheque", "cobro_tarjeta", "cobro_otros"]
			.reduce((a, k) => a + _cd_flt(s[k]), 0);
		// Lo recuperado NETO de la comisión que el transportista ya retuvo. Un
		// snapshot anterior a esta versión no lo trae: ahí vale el bruto.
		const neto_recuperado = s.recuperado_neto === undefined
			? _cd_flt(s.abonos_anteriores) : _cd_flt(s.recuperado_neto);
		const tipo_labels = { credito: "Recuperación de Crédito", cod: "Cobros de Contra Entrega (COD)", contado: "Saldos de Contado" };
		return `
	<div class="cd-card cd-card-recup">
		<div class="cd-card-title">RECUPERACIÓN DE CARTERA <span class="cd-muted">cobros de hoy a facturas de días anteriores — no es venta del día y no entra en su cuadre</span></div>
		<div class="cd-grid-3">
			<div class="cd-block">
				<div class="cd-block-title">POR TIPO DE FACTURA</div>
				${Object.keys(tipo_labels).map((k) => `<div class="cd-line"><span>${tipo_labels[k]}</span><b>${this.fmt(tipos[k])}</b></div>`).join("")}
				<div class="cd-line cd-line-total"><span>TOTAL RECUPERADO</span><b>${this.fmt(s.abonos_anteriores)}</b></div>
				${_cd_flt(s.recuperado_pasarela) ? `
				<div class="cd-line"><span>— del cual venta recuperada</span><b>${this.fmt(s.recuperado_venta)}</b></div>
				<div class="cd-line"><span>— del cual cargos de terceros</span><b>${this.fmt(s.recuperado_pasarela)}</b></div>
				<div class="cd-hint">Un cobro de una factura Contra Entrega anterior recupera venta y cargos de terceros a la vez (el cliente pagó todo junto al repartidor); se separan en proporción al total de la factura.</div>` : ""}
				<div class="cd-hint">${s.recuperado_facturas || 0} factura(s) · ${s.recuperado_liquidadas || 0} quedaron liquidadas</div>
			</div>
			<div class="cd-block">
				<div class="cd-block-title">POR FORMA DE PAGO</div>
				${Object.entries(formas).map(([f, v]) => `<div class="cd-line"><span>${_cd_esc(f)}</span><b>${this.fmt(v)}</b></div>`).join("")}
				<div class="cd-line cd-line-total"><span>TOTAL</span><b>${this.fmt(neto_recuperado)}</b></div>
				${_cd_flt(s.cod_comision) ? `<div class="cd-hint">Los cobros COD se muestran por el <b>monto liquidado</b>: el transportista retuvo ${this.fmt(s.cod_comision)} de comisión antes de depositar, así que eso nunca entró. El cargo a la factura sí fue el total (${this.fmt(s.abonos_anteriores)}).</div>` : ""}
				${_cd_flt(s.recuperado_efectivo) ? `<div class="cd-hint">El efectivo recuperado (${this.fmt(s.recuperado_efectivo)}) se suma al Total a Depositar.</div>` : ""}
			</div>
			<div class="cd-block">
				<div class="cd-block-title">TOTAL RECIBIDO HOY</div>
				<div class="cd-line"><span>Cobrado de la venta del día <span class="cd-muted">(sin CE ni crédito)</span></span><b>${this.fmt(recibido_venta)}</b></div>
				<div class="cd-line"><span>Recuperación de cartera <span class="cd-muted">(neto de comisión)</span></span><b>${this.fmt(neto_recuperado)}</b></div>
				<div class="cd-line cd-line-total"><span>TOTAL RECIBIDO</span><b>${this.fmt(recibido_venta + neto_recuperado)}</b></div>
			</div>
			${_cd_flt(s.cod_ejecutado_recargo) || _cd_flt(s.cod_proyectado_recargo) ? `
			<div class="cd-block">
				<div class="cd-block-title">ANÁLISIS COD</div>
				<div class="cd-line"><span>Recuperado sin comisión ni flete</span><b>${this.fmt(s.cod_neto)}</b></div>
				<div class="cd-line"><span>Proyectado recargo <span class="cd-muted">(cobrado al cliente)</span></span><b>${this.fmt(s.cod_proyectado_recargo)}</b></div>
				<div class="cd-line"><span>Ejecutado recargo <span class="cd-muted">(comisión real)</span></span><b>${this.fmt(s.cod_ejecutado_recargo)}</b></div>
				<div class="cd-line cd-line-total"><span>Diferencia</span><b class="${_cd_flt(s.cod_diferencia) < 0 ? "cd-devol-label" : ""}">${this.fmt(s.cod_diferencia)}</b></div>
				<div class="cd-hint">El recargo por pieza es la ESTIMACIÓN de la comisión que el transportista retiene. Diferencia positiva = el cliente cubrió de más; negativa = el recargo no alcanzó. Sobre ${s.cod_facturas || 0} factura(s) liquidada(s) cobrada(s) hoy.</div>
			</div>` : ""}
		</div>
		<div class="cd-table-wrap">
		<table class="cd-table cd-table-sm">
			<thead><tr><th>Factura</th><th>Cliente</th><th>Fecha factura</th><th class="r">Días</th><th>Tipo</th><th>Forma</th><th>Ref.</th><th class="r">Cargado a factura</th><th class="r">Comisión</th><th class="r">Entró</th><th>Estado</th></tr></thead>
			<tbody>${rows.map((a) => `<tr>
				<td><a href="/app/facex?invoice=${encodeURIComponent(a.sales_invoice)}" target="_blank">${_cd_esc(a.sales_invoice)}</a></td>
				<td>${_cd_esc(a.customer_name)}</td>
				<td>${this.short_date(a.posting_date)}</td>
				<td class="r">${a.dias || 0}</td>
				<td>${_cd_esc(a.tipo_label)}</td>
				<td>${_cd_esc(a.forma)}</td>
				<td>${_cd_esc(a.reference)}</td>
				<td class="r">${this.fmt(a.amount)}</td>
				<td class="r">${_cd_flt(a.valor_comision) ? this.fmt(a.valor_comision) : "—"}</td>
				<td class="r"><b>${this.fmt(a.monto_neto === undefined ? a.amount : a.monto_neto)}</b></td>
				<td>${a.estado === "Liquidada" ? `<span class="cd-ok">✓ Liquidada</span>` : `Abono <span class="cd-muted">· saldo ${this.fmt(a.saldo_restante)}</span>`}</td>
			</tr>`).join("")}</tbody>
		</table>
		</div>
	</div>`;
	}

	// Cierre de una serie concreta: estado de las demás series del día, para
	// que el usuario vea qué le falta cerrar.
	_series_dia_html(s) {
		const info = s.series_dia;
		if (!info || !this.form.serie || this.form.serie === "Todas") return "";
		const otras = (info.series || []).filter((o) => o.serie !== this.form.serie && (o.num_facturas || o.con_cobros || o.cierre));
		const chips = otras.map((o) => `<span class="cd-tag" title="${_cd_esc(o.serie)}">${_cd_esc(o.label)} · ${o.estado ? _cd_esc(o.estado) : "sin cierre"}</span>`).join(" ");
		return `<div class="cd-alert cd-alert-warn"><b>Cierre por serie:</b> solo cuentan las facturas de ${_cd_esc(s.serie_label || this.form.serie)} (ventas, cobros, devoluciones y recuperación de cartera).
			${otras.length ? `<div style="margin-top:4px;">Otras series del día: ${chips}</div>` : ""}</div>`;
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
		// Reclasificar condición de pago: permiso propio, día abierto, factura
		// no certificada (el servidor valida lo mismo).
		const canReclass = !!ctx.puede_reclasificar && canManage && !cerrado;
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
	${this._series_dia_html(s)}

	<div class="cd-card">
		<div class="cd-grid-4">
			<div class="cd-field"><label>Fecha</label><input type="date" id="cd-fecha" class="cd-input" value="${_cd_esc(this.form.fecha)}" max="${ctx.today}" ${doc ? "disabled" : ""}></div>
			<div class="cd-field"><label>Usuario (caja)</label>
				${ctx.es_gerencia && !doc
					? `<select id="cd-usuario" class="cd-input">${ctx.users.map((u) => `<option value="${_cd_esc(u.name)}" ${u.name === this.form.usuario ? "selected" : ""}>${_cd_esc(u.full_name || u.name)}</option>`).join("")}</select>`
					: `<input type="text" class="cd-input" value="${_cd_esc(this.user_label(this.form.usuario))}" disabled>`}
			</div>
			<div class="cd-field"><label>Serie</label>
				${!doc && s.series_dia
					? `<select id="cd-serie" class="cd-input">${[s.series_dia.todas].concat(s.series_dia.series || [])
						.map((o) => `<option value="${_cd_esc(o.serie)}" ${o.serie === this.form.serie ? "selected" : ""}>${_cd_esc(o.label)}</option>`).join("")}</select>`
					: `<input type="text" class="cd-input" value="${_cd_esc(s.serie_label || (doc && doc.serie_label) || this.form.serie)}" title="${_cd_esc(this.form.serie)}" disabled>`}
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
				<div class="cd-block-title">VENTA (ingreso propio)</div>
				<div class="cd-line"><span>Ventas sin descuento</span><b>${this.fmt(s.venta_sin_descuento)}</b></div>
				<div class="cd-line"><span>Piezas en oferta (con descuento)</span><b>${this.fmt(s.venta_con_descuento)}</b></div>
				${_cd_flt(s.cargos_venta) ? `<div class="cd-line"><span>Cargos que sí son venta <span class="cd-muted">(flete/recargo propio)</span></span><b>${this.fmt(s.cargos_venta)}</b></div>` : ""}
				${Math.abs(_cd_flt(s.ajuste_impuestos)) >= 0.01 ? `<div class="cd-line"><span>Ajustes (descuento global / redondeo)</span><b>${this.fmt(s.ajuste_impuestos)}</b></div>` : ""}
				<div class="cd-line"><span class="cd-devol-label">Devoluciones <span class="cd-muted">(facturas de otra fecha anuladas hoy)</span></span><b class="cd-devol-label">− ${this.fmt(s.total_devoluciones)}</b></div>
				<div class="cd-line cd-line-total"><span>VENTA DEL DÍA</span><b>${this.fmt(_cd_flt(s.venta_neta) - _cd_flt(s.total_devoluciones))}</b></div>
				<div class="cd-hint">Esta es la cifra de ingresos del día: la misma que suman los informes de venta y el tablero.</div>
			</div>
			<div class="cd-block">
				<div class="cd-block-title">CARGOS POR CUENTA DE TERCEROS</div>
				<div class="cd-line"><span>Flete <span class="cd-muted">(servicio de entrega)</span></span><b>${this.fmt(s.flete_pasarela)}</b></div>
				<div class="cd-line"><span>Recargo por entrega <span class="cd-muted">(listas Contra Entrega)</span></span><b>${this.fmt(s.recargo_pasarela)}</b></div>
				<div class="cd-line cd-line-total"><span>TOTAL DE TERCEROS</span><b>${this.fmt(s.cargos_pasarela)}</b></div>
				<div class="cd-hint">NO es ingreso: el cliente lo paga por usar el servicio de entrega y el transportista lo descuenta en su liquidación. Por eso no suma en la venta del día ni en los informes.</div>
				${s.snapshot_reconstruido ? `<div class="cd-hint">Este cierre se cerró antes de separar los cargos de terceros, así que el desglose se reconstruyó del recargo y el flete que guardó (entonces todos eran pasarela). El total a depositar es el que se congeló y no cambió.</div>` : ""}
				<div class="cd-line cd-line-total"><span>TOTAL FACTURADO <span class="cd-muted">(cobrado al cliente)</span></span><b>${this.fmt(_cd_flt(s.total_venta) - _cd_flt(s.total_devoluciones))}</b></div>
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
	</div>

	${this._recuperacion_html(s)}

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
			<div class="cd-deposit-formula">Efectivo venta del día ${this.fmt(t.cobro_efectivo)}${t.recuperado_efectivo ? ` + Efectivo recuperado ${this.fmt(t.recuperado_efectivo)}` : ""} − Egresos <span id="cd-dep-egresos">${this.fmt(t.egresos)}</span></div>
			${_cd_flt(s.deposito_cargos_terceros) ? `
			<div class="cd-deposit-split">
				<div class="cd-line"><span>— venta propia</span><b>${this.fmt(t.a_depositar - _cd_flt(s.deposito_cargos_terceros))}</b></div>
				<div class="cd-line"><span>— cargos de terceros <span class="cd-muted">(por rendir al transportista)</span></span><b>${this.fmt(s.deposito_cargos_terceros)}</b></div>
			</div>
			<div class="cd-hint">Se deposita el efectivo completo, porque es el que está físicamente en la caja. El renglón de terceros solo identifica cuánto de ese depósito hay que rendirle al transportista.</div>` : ""}
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
						<td><span class="cd-tag cd-tag-clase-${f.clasificacion}" title="${_cd_esc(f.condicion || "")}">${CD_CLASE_LABEL[f.clasificacion] || ""}</span>${f.alerta_contado ? ` <span class="cd-tag cd-tag-alerta" title="Contado sin pagar">⚠</span>` : ""}${canReclass && !f.es_devolucion ? (f.certificada ? ` <span class="cd-muted" title="Certificada ante SAT: la condición de pago no se puede cambiar">🔒</span>` : ` <a href="#" class="cd-reclass" data-inv="${_cd_esc(f.sales_invoice)}" title="Cambiar condición de pago">✎</a>`) : ""}</td>
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
			// Nuevo: cambiar fecha/serie recalcula (y si ya existe, lo abre);
			// otro usuario tiene otras series, así que vuelve al selector.
			const reload = (serie) => {
				const fecha = this.$body.find("#cd-fecha").val();
				const usuario = this.$body.find("#cd-usuario").val() || this.form.usuario;
				if (!fecha) return;
				this._open_new(fecha, usuario, this.form.egresos, serie);
			};
			this.$body.find("#cd-fecha").on("change", () => reload(this.form.serie));
			this.$body.find("#cd-serie").on("change", (e) => reload(e.target.value));
			this.$body.find("#cd-usuario").on("change", () => reload(""));
		}

		this.$body.find(".cd-reclass").on("click", (e) => {
			e.preventDefault();
			this._reclasificar($(e.currentTarget).data("inv"));
		});

		// Reabrir aplica justo cuando el cierre NO es editable (Cerrado): se
		// enlaza antes del corte por !editable.
		this.$body.find("#cd-btn-reopen").on("click", () => this._reopen());

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
		this.$body.find("#cd-btn-delete").on("click", () => this._delete());
	}

	_payload() {
		return {
			name: this.doc ? this.doc.name : "",
			fecha: this.form.fecha,
			usuario: this.form.usuario,
			serie: this.form.serie,
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
				<p><b>¿Cerrar el día ${this.short_date(this.form.fecha)} de ${_cd_esc(this.user_label(this.form.usuario))} — ${_cd_esc((this.snap || {}).serie_label || this.form.serie)}?</b></p>
				<p>Efectivo cobrado: <b>${this.fmt(t.cobro_efectivo)}</b> · Egresos: <b>${this.fmt(t.egresos)}</b> · A depositar: <b>${this.fmt(t.a_depositar)}</b></p>
				<p class="text-muted">A partir de este momento no se podrán anular facturas ni modificar pagos de esta fecha. Solo un usuario de Gerencia podrá reabrir el cierre.</p>
			</div>`,
			doit
		);
	}

	_reclasificar(invoice) {
		const f = ((this.snap || {}).facturas || []).find((x) => x.sales_invoice === invoice);
		if (!f) return;
		const LABEL = { contado: "Contado", contra_entrega: "Contra Entrega", credito: "Crédito" };
		const opts = (this.ctx.condiciones || []).map((c) => c.name);
		const d = new frappe.ui.Dialog({
			title: __("Condición de pago — {0}", [invoice]),
			fields: [
				{ fieldtype: "HTML", options: `<p>${_cd_esc(f.customer_name)} — <b>${this.fmt(f.grand_total)}</b><br>${__("Condición actual")}: <b>${_cd_esc(f.condicion || "—")}</b> (${LABEL[f.clasificacion] || ""})</p>` },
				{ fieldname: "template", fieldtype: "Select", label: __("Nueva condición de pago"), options: [""].concat(opts), reqd: 1 },
				{ fieldname: "info", fieldtype: "HTML" },
				{ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo del cambio"), reqd: 1 },
			],
			primary_action_label: __("Cambiar condición"),
			primary_action: (v) => {
				if (v.template === f.condicion) {
					frappe.msgprint(__("La factura ya tiene esa condición."));
					return;
				}
				d.hide();
				frappe.call({
					method: "facex_multi.api.cierre.reclasificar_condicion",
					args: { invoice, template: v.template, motivo: v.motivo },
					freeze: true,
					freeze_message: __("Actualizando la factura…"),
					callback: (r) => {
						if (r.exc) return;
						frappe.show_alert({ message: __("Condición de {0} actualizada.", [invoice]), indicator: "green" });
						this._recompute(() => this._render_detail());
					},
				});
			},
		});
		d.fields_dict.template.$input.on("change", () => {
			const c = (this.ctx.condiciones || []).find((x) => x.name === d.get_value("template"));
			d.fields_dict.info.$wrapper.html(c ? `<p class="text-muted">${__("Se clasificará como")} <b>${LABEL[c.clasificacion]}</b>${c.dias ? ` — ${__("vence a {0} días de la fecha de la factura", [c.dias])}` : ""}.</p>` : "");
		});
		d.show();
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
<tr><td><b>SERIE</b></td><td colspan="3">${_cd_esc(s.serie_label || (doc && doc.serie_label) || this.form.serie || "Todas las series")}</td></tr>
<tr><td><b>CIERRE</b></td><td>${doc ? _cd_esc(doc.name) + " · " + _cd_esc(doc.estado) : "(sin guardar)"}</td><td><b>CERRADO</b></td><td>${doc && doc.cerrado_por ? _cd_esc(doc.cerrado_por) + " " + frappe.datetime.str_to_user(doc.cerrado_en) : "—"}</td></tr></table>

<table><thead><tr><th style="width:36px;">No.</th><th>DESCRIPCIÓN / FAMILIA</th><th class="r">Cantidad</th><th class="r">Precio por Unidad</th><th class="r">TOTAL</th></tr></thead>
<tbody>${fams.map((f, i) => `<tr class="${f.es_oferta ? "oferta" : ""}"><td>${f.es_oferta ? 0 : i}</td><td>${_cd_esc(f.familia)}${f.descripcion && f.descripcion !== f.familia ? ` <span class="muted">${_cd_esc(f.descripcion)}</span>` : ""}</td><td class="r">${this.fmt_qty(f.cantidad)}</td><td class="r">${money(f.precio_unidad)}</td><td class="r">${money(f.total)}</td></tr>`).join("")}
<tr class="tot"><td colspan="2">TOTAL (sin fletes)</td><td class="r">${this.fmt_qty(fams.reduce((a, f) => a + _cd_flt(f.cantidad), 0))}</td><td></td><td class="r">${money(_cd_flt(s.venta_sin_descuento) + _cd_flt(s.venta_con_descuento))}</td></tr></tbody></table>

<table><tr><td colspan="2" class="sec">RESUMEN DEL DÍA ${this.short_date(this.form.fecha)}</td></tr>
<tr><td colspan="2" class="sec" style="background:#3b82c4;">VENTA (ingreso propio)</td></tr>
<tr><td>Ventas sin descuento (sin flete)</td><td class="r">${money(s.venta_sin_descuento)}</td></tr>
<tr><td>Piezas en oferta (líneas con descuento)</td><td class="r">${money(s.venta_con_descuento)}</td></tr>
${_cd_flt(s.cargos_venta) ? `<tr><td>Cargos que sí son venta (flete/recargo propio)</td><td class="r">${money(s.cargos_venta)}</td></tr>` : ""}
${Math.abs(_cd_flt(s.ajuste_impuestos)) >= 0.01 ? `<tr><td>Ajustes (descuento global / redondeo)</td><td class="r">${money(s.ajuste_impuestos)}</td></tr>` : ""}
<tr><td>Devoluciones (facturas de otra fecha anuladas hoy)</td><td class="r">− ${money(s.total_devoluciones)}</td></tr>
<tr class="tot"><td>VENTA DEL DÍA</td><td class="r">${money(_cd_flt(s.venta_neta) - _cd_flt(s.total_devoluciones))}</td></tr>
<tr><td colspan="2" class="sec" style="background:#3b82c4;">CARGOS POR CUENTA DE TERCEROS (no es ingreso)</td></tr>
<tr><td>Flete (servicio de entrega)</td><td class="r">${money(s.flete_pasarela)}</td></tr>
<tr><td>Recargo por entrega (listas Contra Entrega)</td><td class="r">${money(s.recargo_pasarela)}</td></tr>
<tr class="tot"><td>TOTAL DE TERCEROS</td><td class="r">${money(s.cargos_pasarela)}</td></tr>
<tr class="tot"><td>TOTAL FACTURADO (cobrado al cliente)</td><td class="r">${money(_cd_flt(s.total_venta) - _cd_flt(s.total_devoluciones))}</td></tr>
<tr><td colspan="2" class="sec" style="background:#3b82c4;">COBROS Y CRÉDITOS</td></tr>
<tr><td>Transferencia</td><td class="r">${money(s.cobro_transferencia)}</td></tr>
<tr><td>Cheques</td><td class="r">${money(s.cobro_cheque)}</td></tr>
<tr><td>Pago Efectivo</td><td class="r">${money(s.cobro_efectivo)}</td></tr>
<tr><td>Tarjeta de Crédito</td><td class="r">${money(s.cobro_tarjeta)}</td></tr>
<tr><td>Contra Entrega</td><td class="r">${money(s.cobro_contra_entrega)}</td></tr>
<tr><td>Contado (pendiente de registrar)</td><td class="r">${money(s.contado_pendiente)}</td></tr>
<tr><td>Al Crédito</td><td class="r">${money(s.al_credito)}</td></tr>
<tr class="tot"><td>TOTAL</td><td class="r">${money(s.total_cobros)}</td></tr>
${_cd_flt(s.abonos_anteriores) ? `<tr><td colspan="2" class="sec" style="background:#0f766e;">RECUPERACIÓN DE CARTERA (cobros de hoy a facturas de días anteriores)</td></tr>
${s.recuperado_por_tipo ? `<tr><td>Recuperación de Crédito</td><td class="r">${money(s.recuperado_por_tipo.credito)}</td></tr>
<tr><td>Cobros de Contra Entrega (COD)</td><td class="r">${money(s.recuperado_por_tipo.cod)}</td></tr>
<tr><td>Saldos de Contado</td><td class="r">${money(s.recuperado_por_tipo.contado)}</td></tr>
${Object.entries(s.recuperado_por_forma || {}).map(([f, v]) => `<tr><td class="muted">&nbsp;&nbsp;${_cd_esc(f)}</td><td class="r muted">${money(v)}</td></tr>`).join("")}` : ""}
<tr class="tot"><td>TOTAL RECUPERADO (cargado a facturas) ${s.recuperado_facturas ? `<span class="muted">(${s.recuperado_facturas} factura(s), ${s.recuperado_liquidadas || 0} liquidadas)</span>` : ""}</td><td class="r">${money(s.abonos_anteriores)}</td></tr>
${_cd_flt(s.cod_comision) ? `<tr><td class="muted">&nbsp;&nbsp;− comisión retenida por el transportista</td><td class="r muted">${money(s.cod_comision)}</td></tr>
<tr class="tot"><td>RECUPERADO NETO (lo que entró)</td><td class="r">${money(s.recuperado_neto)}</td></tr>` : ""}
${_cd_flt(s.cod_ejecutado_recargo) || _cd_flt(s.cod_proyectado_recargo) ? `<tr><td colspan="2" class="sec" style="background:#0f766e;">ANÁLISIS COD (${s.cod_facturas || 0} factura(s) liquidada(s) cobrada(s) hoy)</td></tr>
<tr><td>Recuperado sin comisión ni flete</td><td class="r">${money(s.cod_neto)}</td></tr>
<tr><td>Proyectado recargo (cobrado al cliente)</td><td class="r">${money(s.cod_proyectado_recargo)}</td></tr>
<tr><td>Ejecutado recargo (comisión real)</td><td class="r">${money(s.cod_ejecutado_recargo)}</td></tr>
<tr class="tot"><td>Diferencia</td><td class="r">${money(s.cod_diferencia)}</td></tr>` : ""}` : ""}
<tr><td colspan="2" class="sec" style="background:#dc2626;">DEVOLUCIONES</td></tr>
<tr><td>Contra Entrega</td><td class="r">${money(s.devoluciones_contra_entrega)}</td></tr>
<tr><td>Al Crédito</td><td class="r">${money(s.devoluciones_credito)}</td></tr>
<tr><td>Contado</td><td class="r">${money(s.devoluciones_contado)}</td></tr>
<tr class="tot"><td>TOTAL DEVOLUCIONES</td><td class="r">${money(s.total_devoluciones)}</td></tr>
<tr><td colspan="2" class="sec" style="background:#3b82c4;">EGRESOS</td></tr>
${this.form.egresos.map((e) => `<tr><td>${_cd_esc(e.concepto)}${e.referencia ? ` <span class="muted">(${_cd_esc(e.referencia)})</span>` : ""}${e.observaciones ? ` <span class="muted">${_cd_esc(e.observaciones)}</span>` : ""}</td><td class="r">${money(e.monto)}</td></tr>`).join("")}
<tr class="tot"><td>TOTAL EGRESOS</td><td class="r">${money(t.egresos)}</td></tr>
<tr class="tot big"><td>TOTAL A DEPOSITAR <span class="muted">(efectivo venta ${money(t.cobro_efectivo)}${t.recuperado_efectivo ? ` + efectivo recuperado ${money(t.recuperado_efectivo)}` : ""} − egresos)</span></td><td class="r">${money(t.a_depositar)}</td></tr>
${_cd_flt(s.deposito_cargos_terceros) ? `<tr><td class="muted">&nbsp;&nbsp;— venta propia</td><td class="r muted">${money(t.a_depositar - _cd_flt(s.deposito_cargos_terceros))}</td></tr>
<tr><td class="muted">&nbsp;&nbsp;— cargos de terceros (por rendir al transportista)</td><td class="r muted">${money(s.deposito_cargos_terceros)}</td></tr>` : ""}
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
.cd-user-menu-btn { width:100%; margin-bottom:8px; }
.cd-user-menu-btn:last-child { margin-bottom:0; }

.cd-wrap { max-width:1280px;margin:0 auto;padding:18px 16px 40px; }
.cd-head { display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px; }
.cd-head-actions { display:flex;gap:8px;flex-wrap:wrap; }
.cd-title { font-size:22px;font-weight:800;color:#0f172a;display:flex;align-items:center;gap:10px;flex-wrap:wrap; }
.cd-general-btn { display:flex;align-items:center;justify-content:center;gap:14px;width:100%;margin:0 0 14px;padding:18px 24px;border:0;border-radius:12px;cursor:pointer;
  font-size:20px;font-weight:800;letter-spacing:.4px;color:#fff;background:linear-gradient(135deg,#153375,#1f6f54);box-shadow:0 0 0 0 rgba(31,111,84,.55);animation:cd-general-pulse 3.6s ease-in-out infinite; }
.cd-general-btn:hover { filter:brightness(1.12);animation-play-state:paused; }
.cd-general-ico,.cd-general-arrow { font-size:24px; }
@keyframes cd-general-pulse { 0%{box-shadow:0 0 0 0 rgba(31,111,84,.5);opacity:1;} 50%{opacity:.9;} 75%{box-shadow:0 0 0 12px rgba(31,111,84,0);} 100%{box-shadow:0 0 0 0 rgba(31,111,84,0);opacity:1;} }
@media (prefers-reduced-motion: reduce) { .cd-general-btn { animation:none; } }
.cd-g-users { position:relative;min-width:240px; }
.cd-g-users-btn { display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:240px;height:auto;min-height:36px;text-align:left;cursor:pointer;background:#fff; }
.cd-g-users-panel { position:absolute;z-index:30;top:100%;left:0;min-width:280px;max-height:300px;overflow:auto;margin-top:4px;padding:6px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,.18); }
.cd-g-users-panel label { display:flex;align-items:center;gap:8px;padding:6px 8px;margin:0;font-size:13px;font-weight:500;cursor:pointer;border-radius:6px; }
.cd-g-users-panel label:hover { background:#f1f5f9; }
.cd-g-users-panel .cd-g-all { border-bottom:1px solid #e2e8f0;border-radius:0;margin-bottom:4px; }
.cd-g-banner { display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:8px;margin:14px 0;padding-bottom:10px;border-bottom:2px solid #153375; }
.cd-g-h1 { font-size:18px;font-weight:800;color:#153375; }
.cd-g-range { font-size:13px;font-weight:600;color:#6c757d; }
.cd-g-range.multi { font-size:16px;font-weight:800;color:#1f6f54; }
.cd-g-box { margin-bottom:22px; }
.cd-g-box-title { font-size:13px;font-weight:800;color:#153375;margin-bottom:8px;letter-spacing:.3px; }
.cd-g-note { font-size:11px;color:#6c757d;margin-top:4px; }
.cd-g-table { min-width:640px; }
.cd-g-grp { text-align:center;color:#fff !important; }
.cd-g-grp-v { background:#153375 !important; } .cd-g-grp-p { background:#1f6f54 !important;border-left:3px solid #fff; }
.cd-g-sep { border-left:3px solid #fff; }
.cd-g-name { font-weight:700;white-space:nowrap; }
.cd-g-total td { background:#eef2fb;font-weight:800;border-top:2px solid #153375; }
.cd-g-neg { color:#b91c1c; }
.cd-g-live { display:inline-block;font-size:10px;font-weight:700;color:#8a5a00;background:#fff3d6;border:1px solid #f0c36a;border-radius:10px;padding:1px 7px;margin-left:4px; }
.cd-g-eye { border:0;background:transparent;color:#153375;cursor:pointer;padding:2px 4px;margin-left:4px;border-radius:6px; }
.cd-g-eye:hover { background:#e2e8f0; }
.cd-g-notes { display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px; }
@media (max-width:760px) { .cd-g-notes { grid-template-columns:1fr; } }
.cd-g-note-box { background:#f8fafc;border:1px solid #d1d8dd;border-radius:8px;padding:8px 12px;max-height:140px;overflow:auto;font-size:12px; }
.cd-g-note-warn { background:#fff8e6;border-color:#f0c36a;border-left:4px solid #e0a100;color:#6b4a00; }
.cd-g-note-t { font-weight:800;margin-bottom:4px; } .cd-g-note-t small { font-weight:500; }
.cd-g-note-box ul { margin:0;padding-left:18px;line-height:1.55; }
.cd-g-note-ok { color:#15803d;font-weight:600; }
.cd-g-inv { color:#153375;font-weight:700;text-decoration:underline; }
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
.cd-serie-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px; }
.cd-serie-opt { background:#fff;border:1px solid #d1d8dd;border-radius:8px;padding:10px 12px;text-align:left;cursor:pointer;color:#0f172a; }
.cd-serie-opt:hover:not([disabled]) { border-color:#5e64ff;box-shadow:0 2px 6px rgba(0,0,0,.08); }
.cd-serie-opt[disabled] { opacity:.5;cursor:not-allowed; }
.cd-serie-todas { border-color:#c7d2fe;background:#f5f7ff; }
.cd-serie-head { display:flex;justify-content:space-between;align-items:center;gap:6px;font-size:14px; }
.cd-serie-meta { color:#475569;font-size:12px;margin-top:4px; }
.cd-serie-code { color:#6c757d;font-size:11px;margin-top:2px;word-break:break-all; }
.cd-serie-why { color:#b45309;font-size:11px;margin-top:4px; }

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
/* Celular (PWA): la barra superior no debe sacar el menú de usuario de la pantalla */
@media (max-width:600px){
  .cd-topbar { padding:8px 10px; flex-wrap:wrap; gap:6px; }
  .cd-topbar-right { gap:4px; flex-wrap:wrap; justify-content:flex-end; margin-left:auto; }
  .cd-topbar-sub, .cd-topbar-company { display:none; }
  .cd-topbar-link { padding:6px 7px; font-size:12px; }
}

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
.cd-card-recup { border-left:4px solid #0f766e; }
.cd-deposit-label { font-size:12px;font-weight:800;letter-spacing:1px;opacity:.9; }
.cd-deposit-value { font-size:34px;font-weight:900;margin:6px 0 2px;letter-spacing:-.5px; }
.cd-deposit-formula { font-size:12px;opacity:.85; }
/* Desglose del depósito: cuánto del efectivo es venta y cuánto hay que rendirle
   al transportista. El depósito NO se reduce; esto solo lo identifica. */
.cd-deposit-split { margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.3); }
.cd-deposit-split .cd-line { border:none;padding:2px 0;font-size:12px; }
.cd-card-deposit .cd-hint { color:#dbeafe;opacity:.85; }
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
