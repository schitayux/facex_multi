// FacEx Multi — Comisionador (liquidación de comisiones de vendedores)
// Page sobre el DocType «FacEx Comision Liquidacion» (ver api/comisiones.py).
//
// Flujo: 1) Configuración (período, base, vendedores y porcentajes) → Guardar
// configuración; 2) Ejecutar (solo habilitado si lo que se ve es exactamente lo
// guardado); 3) Reporte (filas con clic = facturas que suman ese monto; Excel,
// PDF para firmas y Cerrar liquidación); 4) Liquidaciones guardadas.

frappe.pages["facex-comisiones"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: "Comisionador — FacEx", single_column: true });
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex-comisiones") $("body").removeClass("facex-fullscreen-mode");
	});
	wrapper.facexComisiones = new FacexComisionador(page, wrapper);
};

frappe.pages["facex-comisiones"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	// Atrás / Adelante del navegador: cada vista es una ruta real de Frappe
	// (facex-comisiones/config/<desde>/<hasta>, /reporte/<liquidación>, /historial),
	// así que no hace falta el guardia de historial de las otras pantallas.
	if (wrapper.facexComisiones) wrapper.facexComisiones.handle_route();
};

const CM_CSS = `
/* Modo Enfoque: sin navbar ni panel izquierdo del Desk (igual que Cierre Diario). */
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
.cm-back{border:0;background:none;color:#153375;font-weight:700;cursor:pointer;padding:4px 8px;border-radius:6px}.cm-back:hover{background:#eef2ff}
.cm{width:100%;max-width:none;margin:0;padding:12px 16px;min-height:calc(100vh - 110px);font-size:13px;color:#1f2937}
.cm *{box-sizing:border-box}
.cm-top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.cm-top h2{margin:0;font-size:20px;color:#153375}
.cm-sub{color:#6b7280;font-size:12px}
.cm-tabs{display:flex;gap:4px;border-bottom:2px solid #e5e7eb;margin-bottom:14px;flex-wrap:wrap}
.cm-tab{padding:8px 16px;border:0;background:none;cursor:pointer;font-weight:600;color:#6b7280;border-bottom:3px solid transparent;margin-bottom:-2px}
.cm-tab.on{color:#153375;border-color:#153375}
.cm-tab:disabled{opacity:.4;cursor:not-allowed}
.cm-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px}
.cm-filters{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.cm-filters label{display:block;font-size:11px;font-weight:700;color:#4b5563;margin-bottom:3px;text-transform:uppercase}
.cm-filters input,.cm-filters select{height:34px;padding:0 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#111}
.cm-btn{height:34px;padding:0 14px;border-radius:6px;border:1px solid #153375;background:#fff;color:#153375;font-weight:600;cursor:pointer}
.cm-btn.pri{background:#153375;color:#fff}
.cm-btn.ok{background:#1f6f54;border-color:#1f6f54;color:#fff}
.cm-btn.dng{border-color:#b91c1c;color:#b91c1c}
.cm-btn:disabled{opacity:.45;cursor:not-allowed}
.cm table{width:100%;border-collapse:collapse}
.cm th{background:#eef2ff;color:#153375;text-align:left;padding:6px 8px;font-size:12px;border:1px solid #dbe3f0}
.cm td{padding:5px 8px;border:1px solid #e5e7eb}
.cm td.n,.cm th.n{text-align:right;font-variant-numeric:tabular-nums}
.cm tr.vh td{background:#153375;color:#fff;font-weight:700}
.cm tr.sub td{background:#eef2fb;font-weight:700}
.cm tr.tot td{background:#dbeafe;font-weight:800}
.cm tr.click{cursor:pointer}.cm tr.click:hover td{background:#fef9c3}
.cm input.pct{width:90px;height:30px;text-align:right;border:1px solid #cbd5e1;border-radius:6px;padding:0 6px}
.cm input.pct.bad{border-color:#b91c1c;background:#fef2f2}
.cm-warn{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:12px}
.cm-err{background:#fef2f2;border-color:#fca5a5;color:#991b1b}
.cm-badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700}
.cm-badge.Borrador{background:#fff7e6;color:#b45309}.cm-badge.Cerrada{background:#e6f7ee;color:#15803d}
.cm-kpis{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.cm-kpi{flex:1 1 150px;border:1px solid #e5e7eb;border-radius:10px;padding:10px;background:#fff}
.cm-kpi b{display:block;font-size:17px;color:#153375}.cm-kpi span{font-size:11px;color:#6b7280}
.cm-stale{background:#fef2f2;border:1px solid #fca5a5;color:#991b1b;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-weight:600}
.cm-scroll{overflow-x:auto}
@media(max-width:700px){.cm{padding:8px 4px}.cm-top h2{font-size:17px}}
`;

function _cm_esc(s) { return frappe.utils.escape_html(s == null ? "" : String(s)); }
function _cm_q(v) { return "Q " + (parseFloat(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _cm_n(v) { return (parseFloat(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _cm_fecha(d) { if (!d) return ""; const p = String(d).slice(0, 10).split("-"); return `${p[2]}/${p[1]}/${p[0]}`; }

class FacexComisionador {
	constructor(page, wrapper) {
		this.page = page;
		this.$root = $(page.body);
		this.ctx = null;
		this.cfg = null; // lo cargado del servidor para (desde, hasta)
		this.saved_sig = null; // firma de lo guardado
		this.name = null; // liquidación guardada del período
		this.estado = "Nuevo";
		this.rep = null;
		this.tab = "config";
		this.page.add_menu_item(__("FacEx - Clásico"), () => { window.location.href = "/app/facex"; });
		this.$root.html(`<style>${CM_CSS}</style><div class="cm" id="cm-root"></div>`);
		this.$el = this.$root.find("#cm-root");
		frappe.call({
			method: "facex_multi.api.comisiones.get_context",
			callback: (r) => { this.ctx = r.message; this.draw(); this.handle_route(); },
			error: () => this.$el.html(`<div class="cm-card">${__("No tiene permiso para el Comisionador. Solicite el permiso «Comisionador (Gerencia)» en FacEx Settings.")}</div>`),
		});
	}

	// ───────────────────────── estructura ─────────────────────────
	draw() {
		const c = this.ctx;
		this.$el.html(`
			<div class="cm-top"><div style="display:flex;align-items:center;gap:10px">
				<button class="cm-back" id="cm-volver" title="Volver a FacEx">← FacEx</button>
				<div><h2>Comisionador</h2><div class="cm-sub">${_cm_esc(c.company)} · ${_cm_esc(c.user_fullname)}</div></div></div>
				<div id="cm-estado"></div></div>
			<div class="cm-tabs">
				<button class="cm-tab" data-t="config">1 · Configuración</button>
				<button class="cm-tab" data-t="reporte">2 · Reporte</button>
				<button class="cm-tab" data-t="hist">Liquidaciones guardadas</button>
			</div><div id="cm-body"></div>`);
		this.$el.find("#cm-volver").on("click", () => { window.location.href = "/app/facex"; });
		this.$el.find(".cm-tab").on("click", (e) => {
			const t = $(e.currentTarget).data("t");
			if (t === "reporte") this.go("reporte", this.rep && this.rep.name);
			else if (t === "hist") this.go("historial");
			else this.go("config", this.filters && this.filters.desde, this.filters && this.filters.hasta);
		});
	}

	// ───────────────────────── rutas (Atrás / Adelante) ─────────────────────────
	go(...parts) {
		frappe.set_route("facex-comisiones", ...parts.filter(Boolean));
	}

	handle_route() {
		if (!this.ctx || !this.$el.find("#cm-body").length) return;
		const [, tab, a, b] = frappe.get_route();
		if (tab === "historial") return this.show("hist");
		if (tab === "reporte" && a) {
			if (this.rep && this.rep.name === a) return this.show("reporte");
			return frappe.call({
				method: "facex_multi.api.comisiones.get_reporte", args: { name: a }, freeze: true,
				callback: (r) => {
					const m = r.message;
					this.name = m.name; this.estado = m.estado; this.filters = { desde: m.desde, hasta: m.hasta, base: m.base_calculo };
					if (m.ejecutada_el) { this.rep = m; this.show("reporte"); }
					else { this.rep = null; this.cfg = null; this.go("config", m.desde, m.hasta); }
				},
			});
		}
		// Configuración, con el período en la ruta cuando ya se cargó uno.
		if (a && b && (!this.filters || this.filters.desde !== a || this.filters.hasta !== b)) {
			this.filters = { desde: a, hasta: b, base: (this.filters && this.filters.base) || "Sin IVA" };
			this.cfg = null; this.name = null; this.saved_sig = null;
		}
		this.show("config");
		if (a && b && !this.cfg) this.cargar(true);
	}

	// Conserva lo capturado en la tabla al salir de Configuración (p. ej. con Atrás).
	stash() {
		if (this.tab !== "config" || !this.cfg || !this.$body || !this.$body.find("#cm-cfg tbody tr[data-i]").length) return;
		this.collect().forEach((r, i) => {
			Object.assign(this.cfg.vendedores[i], { incluido: r.incluido ? 1 : 0, pct_contado: r.pct_contado, pct_recuperacion: r.pct_recuperacion });
		});
		this.filters.base = this.$body.find("#cm-base").val() || this.filters.base;
	}

	show(t) {
		this.stash();
		this.tab = t;
		this.$el.find(".cm-tab").each((_, b) => $(b).toggleClass("on", $(b).data("t") === t));
		this.$el.find('.cm-tab[data-t="reporte"]').prop("disabled", !this.rep);
		const badge = this.rep && t === "reporte" ? `<span class="cm-badge ${this.rep.estado}">${this.rep.estado} · ${_cm_esc(this.rep.name)}</span>` : "";
		this.$el.find("#cm-estado").html(badge);
		this.$body = this.$el.find("#cm-body");
		if (t === "config") this.render_config();
		else if (t === "reporte") this.render_reporte();
		else this.render_hist();
	}

	// ───────────────────────── 1 · configuración ─────────────────────────
	render_config() {
		const hoy = this.ctx.today;
		const f = this.filters || { desde: hoy.slice(0, 8) + "01", hasta: hoy, base: "Sin IVA" };
		this.filters = f;
		this.$body.html(`
			<div class="cm-card">
				<div class="cm-filters">
					<div><label>Desde *</label><input type="date" id="cm-desde" value="${f.desde}" max="${hoy}"></div>
					<div><label>Hasta *</label><input type="date" id="cm-hasta" value="${f.hasta}" max="${hoy}"></div>
					<div><label>Base de cálculo *</label><select id="cm-base">
						<option ${f.base === "Sin IVA" ? "selected" : ""}>Sin IVA</option>
						<option ${f.base === "Con IVA" ? "selected" : ""}>Con IVA</option></select></div>
					<button class="cm-btn" id="cm-cargar">Cargar vendedores</button>
				</div>
				<div class="cm-sub" style="margin-top:8px">La comisión se calcula sobre el dinero recibido en el período (sin flete ni recargo).
				Los porcentajes se guardan para el período; «Ejecutar» solo se habilita cuando lo que ve es exactamente lo guardado.</div>
			</div>
			<div id="cm-cfg"></div>
			<div class="cm-card" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
				<button class="cm-btn pri" id="cm-guardar">Guardar configuración</button>
				<button class="cm-btn ok" id="cm-ejecutar">Ejecutar</button>
				<span class="cm-sub" id="cm-hint"></span>
			</div>`);
		this.$body.find("#cm-desde,#cm-hasta,#cm-base").on("input change", () => this.on_filters());
		this.$body.find("#cm-cargar").on("click", () => this.cargar());
		this.$body.find("#cm-guardar").on("click", () => this.guardar());
		this.$body.find("#cm-ejecutar").on("click", () => this.ejecutar());
		this.draw_cfg();
	}

	on_filters() {
		const f = this.filters;
		const prev = `${f.desde}|${f.hasta}`;
		f.desde = this.$body.find("#cm-desde").val();
		f.hasta = this.$body.find("#cm-hasta").val();
		f.base = this.$body.find("#cm-base").val();
		// Cambió el período: la tabla cargada ya no corresponde → hay que volver a cargarla.
		if (`${f.desde}|${f.hasta}` !== prev) { this.cfg = null; this.name = null; this.saved_sig = null; this.draw_cfg(); }
		else this.refresh_buttons();
	}

	cargar(desde_ruta) {
		const f = this.filters;
		if (!f.desde || !f.hasta) return frappe.msgprint(__("Indique Desde y Hasta."));
		frappe.call({
			method: "facex_multi.api.comisiones.get_config", freeze: true,
			args: { company: this.ctx.company, desde: f.desde, hasta: f.hasta },
			callback: (r) => {
				this.cfg = r.message; this.name = r.message.name; this.estado = r.message.estado;
				f.base = r.message.base_calculo; this.$body.find("#cm-base").val(f.base);
				this.draw_cfg();
				this.saved_sig = this.name ? this.sig() : null;
				this.refresh_buttons();
				if (this.name && this.estado !== "Nuevo") this.open_saved(false);
				// El período queda en la URL: Atrás/Adelante lo restauran.
				if (!desde_ruta) this.go("config", f.desde, f.hasta);
			},
		});
	}

	draw_cfg() {
		const $c = this.$body.find("#cm-cfg");
		if (!this.cfg) {
			$c.html(`<div class="cm-card cm-sub">Elija el período y presione «Cargar vendedores» para ver quiénes tuvieron ventas y cobros.</div>`);
			return this.refresh_buttons();
		}
		const cerrada = this.estado === "Cerrada";
		const warn = (this.cfg.avisos || []).map((a) => `<div class="cm-warn">⚠ ${_cm_esc(a)}</div>`).join("")
			+ (this.cfg.traslape.length ? `<div class="cm-warn cm-err">El período se traslapa con liquidación(es) Cerrada(s): ${_cm_esc(this.cfg.traslape.join(", "))}. No se puede guardar.</div>` : "")
			+ (cerrada ? `<div class="cm-warn">La liquidación de este período está Cerrada: solo lectura.</div>` : "");
		const rows = this.cfg.vendedores.map((v, i) => `
			<tr data-i="${i}"><td><input type="checkbox" class="inc" ${v.incluido ? "checked" : ""} ${cerrada ? "disabled" : ""}></td>
			<td><b>${_cm_esc(v.vendedor)}</b></td>
			<td class="n">${v.ventas}</td><td class="n">${v.cobros}</td><td class="n">${v.anulaciones}</td>
			<td class="n"><input class="pct pc" inputmode="decimal" value="${v.pct_contado ?? ""}" ${cerrada ? "disabled" : ""}> %</td>
			<td class="n"><input class="pct pr" inputmode="decimal" value="${v.pct_recuperacion ?? ""}" ${cerrada ? "disabled" : ""}> %</td>
			<td class="cm-sub">${_cm_esc(v.origen)}</td></tr>`).join("");
		$c.html(`${warn}<div class="cm-card cm-scroll"><table>
			<thead><tr><th></th><th>Vendedor</th><th class="n">Ventas</th><th class="n">Facturas con cobro</th><th class="n">Anulaciones / NC</th>
			<th class="n">% Contado</th><th class="n">% Recuperación de crédito</th><th>Origen del %</th></tr></thead>
			<tbody>${rows || `<tr><td colspan="8">Sin movimiento en el período.</td></tr>`}</tbody></table></div>`);
		$c.find("input").on("input change", () => this.refresh_buttons());
		this.refresh_buttons();
	}

	collect() {
		if (!this.cfg) return [];
		const out = [];
		this.$body.find("#cm-cfg tbody tr[data-i]").each((_, tr) => {
			const $t = $(tr), v = this.cfg.vendedores[$t.data("i")];
			out.push({ vendedor: v.vendedor, incluido: $t.find(".inc").is(":checked"),
				pct_contado: $t.find(".pc").val().trim(), pct_recuperacion: $t.find(".pr").val().trim(), $t });
		});
		return out;
	}

	sig() {
		const rows = this.collect().filter((r) => r.incluido).map((r) => [r.vendedor, r.pct_contado, r.pct_recuperacion]);
		return JSON.stringify([this.filters.desde, this.filters.hasta, this.filters.base, rows]);
	}

	valid() {
		const rows = this.collect();
		const inc = rows.filter((r) => r.incluido);
		let ok = inc.length > 0;
		rows.forEach((r) => {
			["pc", "pr"].forEach((k) => {
				const val = (k === "pc" ? r.pct_contado : r.pct_recuperacion);
				const bad = r.incluido && (val === "" || isNaN(val) || +val < 0 || +val > 100);
				r.$t.find("." + k).toggleClass("bad", !!bad);
				if (bad) ok = false;
			});
		});
		return ok;
	}

	refresh_buttons() {
		const f = this.filters;
		const loaded = !!this.cfg, cerrada = this.estado === "Cerrada";
		const traslape = loaded && this.cfg.traslape.length > 0;
		const ok = loaded && this.valid() && !!f.desde && !!f.hasta && f.desde <= f.hasta;
		const dirty = this.saved_sig !== this.sig();
		this.$body.find("#cm-guardar").prop("disabled", !(ok && dirty && !cerrada && !traslape));
		// Ejecutar: solo con lo guardado, sin cambios pendientes.
		this.$body.find("#cm-ejecutar").prop("disabled", !(this.name && ok && !dirty && !cerrada));
		this.$body.find("#cm-hint").text(
			!loaded ? "Cargue los vendedores del período." :
			cerrada ? "Liquidación Cerrada: abra «2 · Reporte»." :
			!ok ? "Complete los porcentajes de todos los vendedores incluidos (0 a 100)." :
			dirty ? "Hay cambios sin guardar: guarde la configuración para poder ejecutar." :
			"Configuración guardada. Puede ejecutar.");
	}

	guardar() {
		if (!this.valid()) return;
		const f = this.filters;
		const vendedores = this.collect().filter((r) => r.incluido).map((r) => ({
			vendedor: r.vendedor, pct_contado: r.pct_contado, pct_recuperacion: r.pct_recuperacion }));
		frappe.call({
			method: "facex_multi.api.comisiones.save_config", freeze: true,
			args: { payload: { company: this.ctx.company, desde: f.desde, hasta: f.hasta, base_calculo: f.base, vendedores } },
			callback: (r) => {
				this.name = r.message.name; this.estado = r.message.estado;
				this.rep = null; // el resultado anterior ya no vale
				this.$el.find('.cm-tab[data-t="reporte"]').prop("disabled", true);
				this.cargar_silencioso();
				frappe.show_alert({ message: __("Configuración guardada"), indicator: "green" });
			},
		});
	}

	cargar_silencioso() {
		const f = this.filters;
		frappe.call({
			method: "facex_multi.api.comisiones.get_config",
			args: { company: this.ctx.company, desde: f.desde, hasta: f.hasta },
			callback: (r) => { this.cfg = r.message; this.draw_cfg(); this.saved_sig = this.sig(); this.refresh_buttons(); },
		});
	}

	ejecutar() {
		if (!this.name) return;
		frappe.call({
			method: "facex_multi.api.comisiones.ejecutar", freeze: true, freeze_message: __("Calculando comisiones…"),
			args: { name: this.name },
			callback: (r) => { this.rep = r.message; this.go("reporte", r.message.name); },
		});
	}

	open_saved(go) {
		frappe.call({
			method: "facex_multi.api.comisiones.get_reporte", args: { name: this.name },
			callback: (r) => { this.rep = r.message.ejecutada_el ? r.message : null; this.show(go === false ? "config" : "reporte"); },
		});
	}

	// ───────────────────────── 2 · reporte ─────────────────────────
	render_reporte() {
		const r = this.rep;
		if (!r) return this.$body.html(`<div class="cm-card cm-sub">Aún no hay un reporte ejecutado.</div>`);
		const con = r.base_calculo === "Con IVA";
		const t = r.totales;
		const cerrada = r.estado === "Cerrada";
		const adv = (r.advertencias || []).map((a) => `<div class="cm-warn">⚠ ${_cm_esc(a)}</div>`).join("");
		const kpi = (l, v, s) => `<div class="cm-kpi"><span>${l}</span><b>${_cm_q(v)}</b><span>${s || ""}</span></div>`;
		const k = (a) => (con ? t[a + "_con_iva"] : t[a + "_sin_iva"]);
		const resumen = r.vendedores.map((v) => `
			<tr class="click" data-v="${_cm_esc(v.vendedor)}" data-c="" data-m="">
			<td><b>${_cm_esc(v.vendedor)}</b></td><td class="n">${v.pct_contado}%</td><td class="n">${v.pct_recuperacion}%</td>
			<td class="n">${_cm_n(con ? v.contado_con_iva : v.contado_sin_iva)}</td>
			<td class="n">${_cm_n(con ? v.recuperacion_con_iva : v.recuperacion_sin_iva)}</td>
			<td class="n">${_cm_n(con ? v.anulaciones_con_iva : v.anulaciones_sin_iva)}</td>
			<td class="n">${_cm_n(v.neto_con_iva)}</td><td class="n">${_cm_n(v.neto_sin_iva)}</td>
			<td class="n"><b>${_cm_n(v.comision_total)}</b></td></tr>`).join("");
		const filas = r.vendedores.map((v) => {
			const body = v.filas.map((f) => `
				<tr class="click" data-v="${_cm_esc(v.vendedor)}" data-c="${_cm_esc(f.concepto)}" data-m="${f.mes}">
				<td>${_cm_esc(f.concepto)}</td><td>${_cm_esc(f.mes_label)}</td>
				<td class="n">${_cm_n(f.fel_con)}</td><td class="n">${_cm_n(f.fel_sin)}</td>
				<td class="n">${_cm_n(f.rec_con)}</td><td class="n">${_cm_n(f.rec_sin)}</td>
				<td class="n">${_cm_n(f.con)}</td><td class="n">${_cm_n(f.sin)}</td>
				<td class="n">${_cm_n(f.pct)}%</td><td class="n"><b>${_cm_n(f.comision)}</b></td></tr>`).join("");
			return `<tr class="vh"><td colspan="10">${_cm_esc(v.vendedor)} — contado ${v.pct_contado}% · recuperación ${v.pct_recuperacion}%</td></tr>
				${body || `<tr><td colspan="10" class="cm-sub">Sin movimiento comisionable.</td></tr>`}
				<tr class="sub click" data-v="${_cm_esc(v.vendedor)}" data-c="" data-m=""><td colspan="6">Total ${_cm_esc(v.vendedor)}</td>
				<td class="n">${_cm_n(v.neto_con_iva)}</td><td class="n">${_cm_n(v.neto_sin_iva)}</td><td></td><td class="n">${_cm_n(v.comision_total)}</td></tr>`;
		}).join("");
		const excl = r.lineas.filter((l) => l.concepto === "Excluida");
		this.$body.html(`
			<div class="cm-card" style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
				<div><b>Del ${_cm_fecha(r.desde)} al ${_cm_fecha(r.hasta)}</b> · base ${r.base_calculo}
				<div class="cm-sub">Ejecutada ${_cm_esc((r.ejecutada_el || "").slice(0, 16))} por ${_cm_esc(r.ejecutada_por)}${cerrada ? ` · Cerrada ${_cm_esc((r.cerrada_el || "").slice(0, 16))} por ${_cm_esc(r.cerrada_por)}` : ""}</div></div>
				<div style="display:flex;gap:6px;flex-wrap:wrap">
					<button class="cm-btn" id="cm-xlsx">Excel</button><button class="cm-btn" id="cm-pdf">PDF para firmas</button>
					${cerrada ? (this.ctx.es_sysman ? `<button class="cm-btn dng" id="cm-reabrir">Reabrir</button>` : "")
						: `<button class="cm-btn ok" id="cm-cerrar">Cerrar liquidación</button>`}</div></div>
			${adv}
			<div class="cm-kpis">
				${kpi("Contado", k("contado"), con ? "con IVA" : "sin IVA")}${kpi("Recuperación de créditos", k("recuperacion"), con ? "con IVA" : "sin IVA")}
				${kpi("Anulaciones / NC", k("anulaciones"), con ? "con IVA" : "sin IVA")}${kpi("Neto sin IVA", t.neto_sin_iva)}
				${kpi("Neto con IVA", t.neto_con_iva)}${kpi("Comisión total a pagar", t.comision_total)}</div>
			<div class="cm-card cm-scroll"><b>Resumen para pago</b><div class="cm-sub">Clic en una fila para ver las facturas.</div>
				<table><thead><tr><th>Vendedor</th><th class="n">% Contado</th><th class="n">% Recup.</th><th class="n">Contado</th><th class="n">Recuperación</th>
				<th class="n">Anulaciones / NC</th><th class="n">Neto con IVA</th><th class="n">Neto sin IVA</th><th class="n">Comisión</th></tr></thead>
				<tbody>${resumen}<tr class="tot"><td colspan="3">TOTAL</td><td class="n">${_cm_n(k("contado"))}</td><td class="n">${_cm_n(k("recuperacion"))}</td>
				<td class="n">${_cm_n(k("anulaciones"))}</td><td class="n">${_cm_n(t.neto_con_iva)}</td><td class="n">${_cm_n(t.neto_sin_iva)}</td><td class="n">${_cm_n(t.comision_total)}</td></tr></tbody></table></div>
			<div class="cm-card cm-scroll"><b>Detalle por concepto y mes de la factura original</b>
				<div class="cm-sub">FEL = factura certificada · Recibo de Compra = no certificada. Anulaciones/NC restan.</div>
				<table><thead><tr><th>Concepto</th><th>Mes de la factura</th><th class="n">FEL con IVA</th><th class="n">FEL sin IVA</th>
				<th class="n">Recibo con IVA</th><th class="n">Recibo sin IVA</th><th class="n">Total con IVA</th><th class="n">Total sin IVA</th>
				<th class="n">%</th><th class="n">Comisión</th></tr></thead><tbody>${filas}</tbody></table></div>
			${excl.length ? `<div class="cm-card cm-sub"><b>${excl.length} cobro(s) excluidos</b> (facturas emitidas y anuladas en el mismo período). Se ven en el Excel, hoja «Facturas».</div>` : ""}
			${r.observaciones ? `<div class="cm-card cm-sub">${_cm_esc(r.observaciones)}</div>` : ""}`);
		this.$body.find("tr.click").on("click", (e) => { const d = $(e.currentTarget).data(); this.detalle(d.v, d.c, String(d.m || "")); });
		this.$body.find("#cm-xlsx").on("click", () => this.exportar("xlsx"));
		this.$body.find("#cm-pdf").on("click", () => this.pdf_firmas());
		this.$body.find("#cm-cerrar").on("click", () => this.cerrar());
		this.$body.find("#cm-reabrir").on("click", () => this.reabrir());
	}

	detalle(vend, concepto, mes) {
		const r = this.rep;
		const ls = r.lineas.filter((l) => l.vendedor === vend && l.concepto !== "Excluida"
			&& (!concepto || l.concepto === concepto) && (!mes || l.mes_origen === mes));
		const sum = (k) => ls.reduce((a, l) => a + (+l[k] || 0), 0);
		const rows = ls.map((l) => `<tr><td>${_cm_esc(l.concepto)}</td><td><a href="/app/facex?invoice=${encodeURIComponent(l.factura)}" target="_blank">${_cm_esc(l.factura)}</a>
			${l.factura_origen ? `<div class="cm-sub">de <a href="/app/facex?invoice=${encodeURIComponent(l.factura_origen)}" target="_blank">${_cm_esc(l.factura_origen)}</a></div>` : ""}</td>
			<td>${_cm_esc(l.tipo_documento)}</td><td>${_cm_fecha(l.fecha_factura)}</td><td>${_cm_esc(l.cliente)}</td><td>${_cm_esc(l.condicion)}</td>
			<td>${_cm_fecha(l.fecha_pago)} ${_cm_esc(l.forma_pago)}</td>
			<td class="n">${_cm_n(l.monto_con_iva)}</td><td class="n">${_cm_n(l.monto_sin_iva)}</td><td class="n">${_cm_n(l.pct)}%</td><td class="n">${_cm_n(l.comision)}</td>
			<td class="cm-sub">${_cm_esc(l.nota)}</td></tr>`).join("");
		const d = new frappe.ui.Dialog({ title: `${vend}${concepto ? " · " + concepto : ""}${mes ? " · " + mes : ""}`, size: "extra-large" });
		d.$body.html(`<style>${CM_CSS}</style><div class="cm cm-scroll"><table><thead><tr><th>Concepto</th><th>Documento</th><th>Tipo</th><th>Fecha</th><th>Cliente</th>
			<th>Condición</th><th>Pago</th><th class="n">Con IVA</th><th class="n">Sin IVA</th><th class="n">%</th><th class="n">Comisión</th><th>Nota</th></tr></thead>
			<tbody>${rows}<tr class="tot"><td colspan="7">TOTAL (${ls.length})</td><td class="n">${_cm_n(sum("monto_con_iva"))}</td>
			<td class="n">${_cm_n(sum("monto_sin_iva"))}</td><td></td><td class="n">${_cm_n(sum("comision"))}</td><td></td></tr></tbody></table></div>`);
		d.show();
	}

	exportar(formato, vendedores) {
		let url = `/api/method/facex_multi.api.comisiones.export_liquidacion?name=${encodeURIComponent(this.rep.name)}&formato=${formato}`;
		if (vendedores && vendedores.length) url += `&vendedores=${encodeURIComponent(JSON.stringify(vendedores))}`;
		window.open(url, "_blank");
	}

	// PDF para firmas: de todos los vendedores o solo de los que se elijan.
	pdf_firmas() {
		const vs = this.rep.vendedores.map((v) => v.vendedor);
		const d = new frappe.ui.Dialog({
			title: __("PDF para firmas"),
			fields: [
				{ fieldname: "todos", fieldtype: "Check", label: __("Todos los vendedores"), default: 1,
					onchange: () => d.fields_dict.lista.$wrapper.toggle(!d.get_value("todos")) },
				{ fieldname: "lista", fieldtype: "HTML" },
			],
			primary_action_label: __("Generar PDF"),
			primary_action: (v) => {
				const sel = v.todos ? [] : d.fields_dict.lista.$wrapper.find("input:checked").map((_, i) => $(i).val()).get();
				if (!v.todos && !sel.length) return frappe.msgprint(__("Elija al menos un vendedor."));
				d.hide();
				this.exportar("pdf", sel);
			},
		});
		d.fields_dict.lista.$wrapper.html(vs.map((x) => `<div class="checkbox" style="margin:4px 0"><label>
			<input type="checkbox" value="${_cm_esc(x)}"> ${_cm_esc(x)}</label></div>`).join("")).hide();
		d.show();
	}

	cerrar() {
		const d = new frappe.ui.Dialog({
			title: __("Cerrar liquidación"),
			fields: [
				{ fieldname: "elaboro", fieldtype: "Data", label: __("Elaboró"), default: this.ctx.user_fullname, reqd: 1 },
				{ fieldname: "reviso", fieldtype: "Data", label: __("Revisó") },
				{ fieldname: "autorizo", fieldtype: "Data", label: __("Autorizó") },
				{ fieldname: "observaciones", fieldtype: "Small Text", label: __("Observaciones") },
				{ fieldtype: "HTML", options: `<div class="cm-warn">Al cerrar, la liquidación queda congelada (porcentajes, facturas y montos) y el período no se puede volver a comisionar.</div>` },
			],
			primary_action_label: __("Cerrar liquidación"),
			primary_action: (v) => {
				frappe.call({
					method: "facex_multi.api.comisiones.cerrar", freeze: true, args: { name: this.rep.name, ...v },
					callback: (r) => { d.hide(); this.rep = r.message; this.estado = "Cerrada"; this.show("reporte"); },
				});
			},
		});
		d.show();
	}

	reabrir() {
		frappe.prompt({ fieldname: "motivo", fieldtype: "Small Text", label: __("Motivo de la reapertura"), reqd: 1 }, (v) => {
			frappe.call({
				method: "facex_multi.api.comisiones.reabrir", args: { name: this.rep.name, motivo: v.motivo },
				callback: () => { this.estado = "Borrador"; this.open_saved(); },
			});
		}, __("Reabrir liquidación"));
	}

	// ───────────────────────── liquidaciones guardadas ─────────────────────────
	render_hist() {
		frappe.call({
			method: "facex_multi.api.comisiones.listar", args: { company: this.ctx.company },
			callback: (r) => {
				const rows = (r.message || []).map((x) => `<tr class="click" data-n="${_cm_esc(x.name)}"><td><b>${_cm_esc(x.name)}</b></td>
					<td>${_cm_fecha(x.fecha_desde)} al ${_cm_fecha(x.fecha_hasta)}</td><td><span class="cm-badge ${x.estado}">${x.estado}</span></td>
					<td>${_cm_esc(x.base_calculo)}</td><td class="n">${x.vendedores}</td><td class="n">${_cm_n(x.total_comision)}</td>
					<td>${_cm_esc(x.cerrada_por)} ${_cm_esc((x.cerrada_el || "").slice(0, 10))}</td>
					<td>${x.estado === "Borrador" ? `<button class="cm-btn dng del" data-n="${_cm_esc(x.name)}">Eliminar</button>` : ""}</td></tr>`).join("");
				this.$body.html(`<div class="cm-card cm-scroll"><table><thead><tr><th>Liquidación</th><th>Período</th><th>Estado</th><th>Base</th>
					<th class="n">Vendedores</th><th class="n">Comisión total</th><th>Cerrada por</th><th></th></tr></thead>
					<tbody>${rows || `<tr><td colspan="8" class="cm-sub">Aún no hay liquidaciones guardadas.</td></tr>`}</tbody></table></div>`);
				this.$body.find("tr.click").on("click", (e) => this.go("reporte", $(e.currentTarget).data("n")));
				this.$body.find(".del").on("click", (e) => {
					e.stopPropagation();
					const n = $(e.currentTarget).data("n");
					frappe.confirm(__("¿Eliminar la liquidación {0}?", [n]), () => frappe.call({
						method: "facex_multi.api.comisiones.eliminar", args: { name: n }, callback: () => { this.rep = null; this.render_hist(); } }));
				});
			},
		});
	}
}
