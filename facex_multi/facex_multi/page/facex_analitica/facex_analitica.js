// FacEx Multi — Analítica (Gerencia)
// Servidor: facex_multi/api/analitica.py (un endpoint por sección, se pide al
// abrirla y se guarda en memoria por período). Permiso «analitica» de FacEx
// Settings / Perfil (deny-by-default).
//
// Ruta: /app/facex-analitica/<seccion>. Menú lateral contraíble (se recuerda
// en este navegador); en celular es un panel que se abre con ☰.

frappe.pages["facex-analitica"].on_page_load = function (wrapper) {
	frappe.ui.make_app_page({ parent: wrapper, title: "Analítica — FacEx", single_column: true });
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex-analitica") $("body").removeClass("facex-fullscreen-mode");
	});
	wrapper.fxAnalitica = new FacexAnalitica(wrapper);
};

frappe.pages["facex-analitica"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	if (wrapper.fxAnalitica) wrapper.fxAnalitica.handle_route();
};

const AN_CSS = `
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
.an{--an-pri:#153375;--an-pri-soft:#eef2ff;--an-txt:#1f2937;--an-mut:#6b7280;--an-brd:#e5e7eb;--an-bg:#f6f7fb;
  --an-ok:#1f6f54;--an-ok-soft:#e7f5ef;--an-warn:#a15c07;--an-warn-soft:#fdf3e1;--an-bad:#b42318;--an-bad-soft:#fdecea;
  display:flex;min-height:100vh;background:var(--an-bg);color:var(--an-txt);font-size:13px}
.an *{box-sizing:border-box}
.an-side{width:224px;flex:0 0 224px;background:#0f2557;color:#dbe4ff;display:flex;flex-direction:column;transition:width .18s,flex-basis .18s;position:sticky;top:0;height:100vh;z-index:30}
.an.an-mini .an-side{width:62px;flex-basis:62px}
.an-brand{display:flex;align-items:center;gap:8px;padding:14px 14px 10px;font-weight:800;font-size:15px;color:#fff;white-space:nowrap;overflow:hidden}
.an-brand svg{flex:0 0 auto}
.an-nav{flex:1;overflow-y:auto;padding:6px 8px}
.an-nav button{display:flex;align-items:center;gap:10px;width:100%;border:0;background:none;color:#c7d2fe;padding:9px 10px;border-radius:8px;cursor:pointer;font-weight:600;text-align:left;white-space:nowrap;overflow:hidden;font-size:13px}
.an-nav button:hover{background:rgba(255,255,255,.08);color:#fff}
.an-nav button.on{background:#fff;color:#0f2557}
.an-nav svg{flex:0 0 18px}
.an.an-mini .an-lbl,.an.an-mini .an-brand span{display:none}
.an-side-foot{padding:8px;border-top:1px solid rgba(255,255,255,.12);display:flex;flex-direction:column;gap:4px}
.an-side-foot button{display:flex;align-items:center;gap:10px;border:0;background:none;color:#c7d2fe;padding:8px 10px;border-radius:8px;cursor:pointer;font-weight:600;white-space:nowrap;overflow:hidden}
.an-side-foot button:hover{background:rgba(255,255,255,.08);color:#fff}
.an-main{flex:1;min-width:0;padding:14px 18px 40px}
.an-top{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap;margin-bottom:12px}
.an-title{display:flex;align-items:center;gap:10px}
.an-title h2{margin:0;font-size:20px;color:var(--an-pri)}
.an-sub{color:var(--an-mut);font-size:12px}
.an-burger{display:none;border:1px solid var(--an-brd);background:#fff;border-radius:8px;width:38px;height:38px;cursor:pointer;color:var(--an-pri)}
.an-filters{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.an-filters label{display:block;font-size:10px;font-weight:700;color:var(--an-mut);text-transform:uppercase;margin-bottom:2px}
.an-filters input,.an-filters select{height:34px;padding:0 8px;border:1px solid #cbd5e1;border-radius:7px;background:#fff;color:#111;font-size:13px}
.an-btn{height:34px;padding:0 14px;border-radius:7px;border:1px solid var(--an-pri);background:var(--an-pri);color:#fff;font-weight:700;cursor:pointer}
.an-btn.sec{background:#fff;color:var(--an-pri)}
.an-hint{background:#fff;border:1px solid var(--an-brd);border-left:4px solid var(--an-pri);border-radius:8px;padding:8px 12px;color:#374151;margin-bottom:12px}
.an-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-bottom:12px}
.an-kpi{background:#fff;border:1px solid var(--an-brd);border-radius:10px;padding:10px 12px;min-height:84px}
.an-kpi-l{font-size:11px;font-weight:700;color:var(--an-mut);text-transform:uppercase;letter-spacing:.02em}
.an-kpi-v{font-size:22px;font-weight:800;color:#111827;margin-top:2px;line-height:1.15;word-break:break-word}
.an-kpi-v.sm{font-size:16px}
.an-kpi-s{font-size:11px;color:var(--an-mut);margin-top:3px}
.an-kpi.ok{border-left:4px solid var(--an-ok)}.an-kpi.warn{border-left:4px solid #d97706}.an-kpi.bad{border-left:4px solid var(--an-bad)}.an-kpi.pri{border-left:4px solid var(--an-pri)}
.an-up{color:var(--an-ok);font-weight:700}.an-down{color:var(--an-bad);font-weight:700}
.an-tabs{display:flex;gap:4px;border-bottom:2px solid var(--an-brd);margin-bottom:10px;overflow-x:auto;scrollbar-width:thin}
.an-tab{padding:8px 14px;border:0;background:none;cursor:pointer;font-weight:700;color:var(--an-mut);border-bottom:3px solid transparent;margin-bottom:-2px;white-space:nowrap}
.an-tab.on{color:var(--an-pri);border-color:var(--an-pri)}
.an-tab .an-n{display:inline-block;min-width:20px;padding:0 6px;margin-left:6px;border-radius:10px;background:#eef0f4;color:#374151;font-size:11px}
.an-card{background:#fff;border:1px solid var(--an-brd);border-radius:10px;padding:12px}
.an-card h4{margin:0 0 8px;font-size:13px;color:#111827}
.an-grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.an-tw{overflow:auto;max-height:calc(100vh - 360px);min-height:120px;border:1px solid var(--an-brd);border-radius:8px;background:#fff}
.an-t{width:100%;border-collapse:collapse}
.an-t th{position:sticky;top:0;background:#f3f4f8;color:#374151;font-size:11px;text-transform:uppercase;text-align:left;padding:7px 8px;border-bottom:1px solid var(--an-brd);cursor:pointer;white-space:nowrap;z-index:1}
.an-t th.num,.an-t td.num{text-align:right}
.an-t td{padding:6px 8px;border-bottom:1px solid #f0f1f4;vertical-align:top}
.an-t tr:hover td{background:#fafbff}
.an-t th .an-sort{color:var(--an-pri)}
.an-tbar{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.an-tbar input{height:32px;border:1px solid #cbd5e1;border-radius:7px;padding:0 10px;min-width:220px}
.an-muted{color:var(--an-mut)}
.an-badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:700;white-space:nowrap}
.an-b-ok{background:var(--an-ok-soft);color:var(--an-ok)}.an-b-warn{background:var(--an-warn-soft);color:var(--an-warn)}
.an-b-bad{background:var(--an-bad-soft);color:var(--an-bad)}.an-b-pri{background:var(--an-pri-soft);color:var(--an-pri)}.an-b-mut{background:#eef0f4;color:#4b5563}
.an-bars{display:flex;flex-direction:column;gap:7px}
.an-bar{display:grid;grid-template-columns:minmax(90px,170px) 1fr minmax(80px,auto);gap:8px;align-items:center}
.an-bar-l{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.an-bar-t{background:#eef0f4;border-radius:6px;height:18px;overflow:hidden}
.an-bar-f{height:100%;background:var(--an-pri);border-radius:6px}
.an-bar-f.ok{background:var(--an-ok)}.an-bar-f.warn{background:#d97706}.an-bar-f.bad{background:var(--an-bad)}.an-bar-f.mut{background:#94a3b8}
.an-bar-v{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.an-cols{display:flex;align-items:flex-end;gap:2px;height:180px;padding:6px 4px 0;border-bottom:1px solid var(--an-brd);overflow-x:auto}
.an-col{flex:1 0 8px;min-width:8px;background:var(--an-pri);border-radius:3px 3px 0 0;opacity:.85}
.an-col:hover{opacity:1}
.an-cols-x{display:flex;justify-content:space-between;color:var(--an-mut);font-size:11px;margin-top:4px}
.an-heat{border-collapse:separate;border-spacing:2px;width:100%}
.an-heat th{font-size:10px;color:var(--an-mut);font-weight:700;padding:2px}
.an-heat td{height:28px;min-width:28px;border-radius:4px;text-align:center;font-size:10px;color:#0f172a}
.an-legend{display:flex;gap:6px;align-items:center;color:var(--an-mut);font-size:11px;margin-top:6px}
.an-legend i{display:inline-block;width:18px;height:10px;border-radius:2px}
.an-empty{padding:28px;text-align:center;color:var(--an-mut)}
.an-load{padding:40px;text-align:center;color:var(--an-mut)}
.an-wa{color:#128c7e;font-weight:700;text-decoration:none;white-space:nowrap}
.an-more{margin-top:8px;text-align:center}
.an-backdrop{display:none}
.an-tip{margin-top:8px;min-height:18px;color:#111827;font-weight:600;font-size:12px}
@media (max-width: 820px){
  .an-side{position:fixed;left:0;top:0;bottom:0;transform:translateX(-100%);transition:transform .2s;width:240px !important;flex-basis:auto !important;box-shadow:0 10px 30px rgba(0,0,0,.25)}
  .an.an-open .an-side{transform:none}
  .an.an-mini .an-lbl,.an.an-mini .an-brand span{display:inline}
  .an.an-open .an-backdrop{display:block;position:fixed;inset:0;background:rgba(15,23,42,.35);z-index:25}
  .an-burger{display:inline-flex;align-items:center;justify-content:center}
  .an-collapse{display:none !important}
  .an-main{padding:10px 10px 30px}
  .an-title h2{font-size:17px}
  .an-filters{width:100%}
  .an-filters > div{flex:1 1 130px}
  .an-filters input,.an-filters select{width:100%}
  .an-kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .an-kpi-v{font-size:18px}
  .an-grid2{grid-template-columns:1fr}
  .an-tw{max-height:none}
  .an-tbar input{min-width:0;width:100%}
  .an-bar{grid-template-columns:minmax(80px,120px) 1fr auto}
}
`;

const _an_esc = (s) => frappe.utils.escape_html(s == null ? "" : String(s));
const _an_ico = (p) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

const AN_SECCIONES = [
	{ id: "resumen", label: "Resumen", icon: _an_ico('<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>'),
		hint: "Cómo va la venta del período y cuánto cambió contra el período anterior del mismo largo." },
	{ id: "clientes", label: "Clientes", icon: _an_ico('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
		hint: "Quién vuelve a comprar y quién dejó de hacerlo. «En riesgo» y «Dejó de comprar» se miden contra el ritmo de compra de cada cliente: si compraba cada 10 días y lleva 25 sin comprar, está en riesgo." },
	{ id: "horarios", label: "Horarios", icon: _an_ico('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
		hint: "Horas y días con más venta. Úselo para turnos, promociones y horarios de atención." },
	{ id: "pago", label: "Contado · Crédito · CE", icon: _an_ico('<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>'),
		hint: "Cómo pagan los clientes: de contado, al crédito o contra entrega (CE). Una venta es CE si se marcó así o se cobró por contra entrega." },
	{ id: "productos", label: "Productos", icon: _an_ico('<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>'),
		hint: "Lo que más se vende, lo que tiene stock y no se vendió en el período, y lo que conviene ofertar (mucho stock para su ritmo de venta, o ventas en caída)." },
	{ id: "cruzada", label: "Venta cruzada", icon: _an_ico('<polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/>'),
		hint: "Productos que se compran juntos en el mismo ticket, y para cada cliente qué compran sus clientes parecidos que él todavía no compra." },
	{ id: "credito", label: "Crédito y pronóstico", icon: _an_ico('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
		hint: "Cartera real (total menos pagos registrados en FacEx), cobros esperados por semana y cuánto se espera que compren al crédito los próximos 30 días según el ritmo de cada cliente. Es una estimación, no una promesa." },
	{ id: "tickets", label: "Tickets", icon: _an_ico('<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><line x1="13" y1="5" x2="13" y2="19"/>'),
		hint: "Cuánto deja cada venta: monto, cuántos productos lleva, y por vendedor y usuario." },
];

class FacexAnalitica {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.cache = {};
		this.subtab = {};
		this.sec = "resumen";
		if (!document.getElementById("an-css")) $("<style id='an-css'>").text(AN_CSS).appendTo("head");
		this.$root = $(wrapper).find(".layout-main-section");
		this.$root.html('<div class="an-load">Cargando…</div>');
		frappe.call({
			method: "facex_multi.api.analitica.get_contexto",
			callback: (r) => { this.ctx = r.message; this.draw(); this.handle_route(); },
			error: () => this.$root.html(`<div class="an-empty">No tiene permiso para la Analítica.<br>
				Solicite el permiso «Analítica (Gerencia)» en FacEx Settings.<br><br>
				<a href="/app/facex">← Volver a FacEx</a></div>`),
		});
	}

	// ── estructura ─────────────────────────────────────────────────────────
	draw() {
		const hoy = this.ctx.hoy;
		this.f = { desde: frappe.datetime.add_days(hoy, -89), hasta: hoy, preset: "90" };
		let mini = false;
		try { mini = localStorage.getItem("fx_an_mini") === "1"; } catch (e) { /* sin storage */ }
		this.$root.html(`
			<div class="an ${mini ? "an-mini" : ""}">
				<aside class="an-side">
					<div class="an-brand">${_an_ico('<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>')}<span>Analítica</span></div>
					<nav class="an-nav">${AN_SECCIONES.map((s) => `
						<button data-sec="${s.id}" title="${_an_esc(s.label)}">${s.icon}<span class="an-lbl">${_an_esc(s.label)}</span></button>`).join("")}
					</nav>
					<div class="an-side-foot">
						<button class="an-collapse" title="Contraer / expandir menú">${_an_ico('<polyline points="15 18 9 12 15 6"/>')}<span class="an-lbl">Contraer menú</span></button>
						<button class="an-volver" title="Volver a FacEx">${_an_ico('<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>')}<span class="an-lbl">Volver a FacEx</span></button>
					</div>
				</aside>
				<div class="an-backdrop"></div>
				<main class="an-main">
					<div class="an-top">
						<div class="an-title">
							<button class="an-burger" title="Menú">${_an_ico('<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>')}</button>
							<div><h2 id="an-h"></h2><div class="an-sub">${_an_esc(this.ctx.company)} · ${_an_esc(this.ctx.user_fullname)}</div></div>
						</div>
						<div class="an-filters">
							<div><label>Período</label><select id="an-preset">
								<option value="30">Últimos 30 días</option><option value="90">Últimos 90 días</option>
								<option value="mes">Este mes</option><option value="mesant">Mes anterior</option>
								<option value="anio">Este año</option><option value="todo">Desde la primera venta</option>
								<option value="otro">Otro rango…</option></select></div>
							<div><label>Desde</label><input type="date" id="an-desde"></div>
							<div><label>Hasta</label><input type="date" id="an-hasta"></div>
							<div><label>&nbsp;</label><button class="an-btn" id="an-go">Actualizar</button></div>
						</div>
					</div>
					<div class="an-hint" id="an-hint"></div>
					<div id="an-body"></div>
				</main>
			</div>`);
		this.$an = this.$root.find(".an");
		this.$body = this.$root.find("#an-body");
		this._sync_filters();

		this.$an.find(".an-nav button").on("click", (e) => {
			this.$an.removeClass("an-open");
			frappe.set_route("facex-analitica", $(e.currentTarget).data("sec"));
		});
		this.$an.find(".an-collapse").on("click", () => {
			this.$an.toggleClass("an-mini");
			try { localStorage.setItem("fx_an_mini", this.$an.hasClass("an-mini") ? "1" : "0"); } catch (e) { /* sin storage */ }
		});
		this.$an.find(".an-volver").on("click", () => { window.location.href = "/app/facex"; });
		this.$an.find(".an-burger").on("click", () => this.$an.toggleClass("an-open"));
		this.$an.on("click mouseenter", "[data-tip]", (e) => {
			$(e.currentTarget).closest(".an-card").find(".an-tip").text($(e.currentTarget).attr("data-tip"));
		});
		this.$an.find(".an-backdrop").on("click", () => this.$an.removeClass("an-open"));
		this.$an.find("#an-preset").on("change", (e) => {
			this.f.preset = e.target.value;
			this._apply_preset();
			if (this.f.preset !== "otro") this.load();
		});
		this.$an.find("#an-desde, #an-hasta").on("change", () => { this.f.preset = "otro"; this.$an.find("#an-preset").val("otro"); });
		this.$an.find("#an-go").on("click", () => {
			this.f.desde = this.$an.find("#an-desde").val();
			this.f.hasta = this.$an.find("#an-hasta").val();
			if (!this.f.desde || !this.f.hasta) return frappe.show_alert({ message: "Indique Desde y Hasta.", indicator: "orange" });
			this.load(true);
		});
	}

	_apply_preset() {
		const hoy = this.ctx.hoy, D = frappe.datetime;
		const p = this.f.preset;
		if (p === "30") this.f.desde = D.add_days(hoy, -29);
		else if (p === "90") this.f.desde = D.add_days(hoy, -89);
		else if (p === "mes") this.f.desde = hoy.slice(0, 8) + "01";
		else if (p === "mesant") {
			const ini = D.add_months(hoy.slice(0, 8) + "01", -1);
			this.f.desde = ini;
			this.f.hasta = D.add_days(hoy.slice(0, 8) + "01", -1);
			return this._sync_filters();
		} else if (p === "anio") this.f.desde = hoy.slice(0, 4) + "-01-01";
		else if (p === "todo") this.f.desde = this.ctx.primera_venta || hoy.slice(0, 4) + "-01-01";
		if (p !== "otro") this.f.hasta = hoy;
		this._sync_filters();
	}

	_sync_filters() {
		this.$an.find("#an-preset").val(this.f.preset);
		this.$an.find("#an-desde").val(this.f.desde);
		this.$an.find("#an-hasta").val(this.f.hasta);
	}

	handle_route() {
		if (!this.$an) return;
		const r = frappe.get_route();
		const sec = AN_SECCIONES.find((s) => s.id === r[1]) ? r[1] : "resumen";
		this.sec = sec;
		const s = AN_SECCIONES.find((x) => x.id === sec);
		this.$an.find(".an-nav button").removeClass("on").filter(`[data-sec="${sec}"]`).addClass("on");
		this.$an.find("#an-h").text(s.label);
		this.$an.find("#an-hint").text(s.hint);
		this.load();
	}

	// ── datos ──────────────────────────────────────────────────────────────
	load(force = false, extra = {}) {
		const METODO = { resumen: "get_resumen", clientes: "get_clientes", horarios: "get_horarios", pago: "get_condicion",
			productos: "get_productos", cruzada: "get_cruzada", credito: "get_credito", tickets: "get_tickets" };
		const sec = this.sec;
		const key = [sec, this.f.desde, this.f.hasta, JSON.stringify(extra)].join("|");
		if (!force && this.cache[key]) return this.render(sec, this.cache[key]);
		this.$body.html('<div class="an-load">Calculando…</div>');
		frappe.call({
			method: `facex_multi.api.analitica.${METODO[sec]}`,
			args: { company: this.ctx.company, desde: this.f.desde, hasta: this.f.hasta, ...extra },
			callback: (r) => {
				if (sec !== this.sec || !r.message) return;
				this.cache[key] = r.message;
				this.render(sec, r.message);
			},
			error: () => this.$body.html('<div class="an-empty">No se pudo calcular esta sección.</div>'),
		});
	}

	render(sec, d) {
		this[`r_${sec}`](d);
	}

	// ── piezas ─────────────────────────────────────────────────────────────
	money(v) { return new Intl.NumberFormat("es-GT", { style: "currency", currency: "GTQ", maximumFractionDigits: 2 }).format(v || 0); }
	int(v) { return new Intl.NumberFormat("es-GT", { maximumFractionDigits: 0 }).format(v || 0); }
	num(v, d = 1) { return new Intl.NumberFormat("es-GT", { maximumFractionDigits: d }).format(v || 0); }
	date(v) { return v ? frappe.datetime.str_to_user(v) : "—"; }

	vari(v) {
		if (v === null || v === undefined) return '<span class="an-muted">sin período anterior</span>';
		const cls = v >= 0 ? "an-up" : "an-down";
		return `<span class="${cls}">${v >= 0 ? "▲" : "▼"} ${this.num(Math.abs(v))}%</span> vs período anterior`;
	}

	kpis(list) {
		return `<div class="an-kpis">${list.map((k) => `
			<div class="an-kpi ${k.tone || ""}" ${k.title ? `title="${_an_esc(k.title)}"` : ""}>
				<div class="an-kpi-l">${_an_esc(k.l)}</div>
				<div class="an-kpi-v ${k.sm ? "sm" : ""}">${k.v}</div>
				${k.s ? `<div class="an-kpi-s">${k.s}</div>` : ""}
			</div>`).join("")}</div>`;
	}

	bars(rows, label, value, fmt, tone) {
		const max = Math.max(...rows.map((r) => r[value] || 0), 0) || 1;
		return `<div class="an-bars">${rows.map((r) => `
			<div class="an-bar"><div class="an-bar-l" title="${_an_esc(r[label])}">${_an_esc(r[label])}</div>
				<div class="an-bar-t"><div class="an-bar-f ${typeof tone === "function" ? tone(r) : (tone || "")}" style="width:${Math.max(0, (100 * (r[value] || 0)) / max)}%"></div></div>
				<div class="an-bar-v">${fmt(r[value], r)}</div></div>`).join("")}</div>`;
	}

	badge(estado) {
		const cls = { "Activo": "an-b-ok", "En riesgo": "an-b-warn", "Dejó de comprar": "an-b-bad", "Una compra": "an-b-mut",
			"Sin compras recientes": "an-b-bad", "Contado": "an-b-ok", "Crédito": "an-b-pri", "Contra Entrega": "an-b-warn" }[estado] || "an-b-mut";
		return `<span class="an-badge ${cls}">${_an_esc(estado)}</span>`;
	}

	wa(cel, nombre) {
		let d = String(cel || "").replace(/\D/g, "");
		if (!d) return '<span class="an-muted">—</span>';
		if (d.length === 8) d = "502" + d;
		const txt = encodeURIComponent(`Hola ${nombre || ""}, le saludamos de ${this.ctx.company}.`);
		return `<a class="an-wa" href="https://wa.me/${d}?text=${txt}" target="_blank" rel="noopener" title="Escribir por WhatsApp">${_an_esc(cel)}</a>`;
	}

	// Tabla con buscador, orden por columna y «ver más».
	// cols: [{k, l, f: "money"|"int"|"num"|"pct"|"date"|"badge"|fn(row), num: bool}]
	table($w, cols, rows, opts = {}) {
		const st = { q: "", sort: opts.sort || null, dir: -1, limit: 25 };
		const fmt = (c, r) => {
			const v = r[c.k];
			if (typeof c.f === "function") return c.f(r);
			if (c.f === "money") return this.money(v);
			if (c.f === "int") return v === null || v === undefined ? "—" : this.int(v);
			if (c.f === "num") return v === null || v === undefined ? "—" : this.num(v);
			if (c.f === "pct") return v === null || v === undefined ? "—" : `${this.num(v)}%`;
			if (c.f === "date") return this.date(v);
			if (c.f === "badge") return this.badge(v);
			return _an_esc(v === null || v === undefined || v === "" ? "—" : v);
		};
		const isNum = (c) => c.num || ["money", "int", "num", "pct"].includes(c.f);
		const draw = () => {
			let data = rows;
			if (st.q) {
				const q = st.q.toLowerCase();
				data = data.filter((r) => cols.some((c) => String(r[c.k] ?? "").toLowerCase().includes(q)));
			}
			if (st.sort) {
				const k = st.sort;
				data = [...data].sort((a, b) => {
					const x = a[k], y = b[k];
					if (x === y) return 0;
					if (x === null || x === undefined) return 1;
					if (y === null || y === undefined) return -1;
					return (x > y ? 1 : -1) * st.dir;
				});
			}
			const shown = data.slice(0, st.limit);
			$w.find(".an-tw").html(data.length ? `<table class="an-t"><thead><tr>${cols.map((c) => `
				<th class="${isNum(c) ? "num" : ""}" data-k="${c.k}">${_an_esc(c.l)}${st.sort === c.k ? `<span class="an-sort"> ${st.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`).join("")}</tr></thead>
				<tbody>${shown.map((r) => `<tr>${cols.map((c) => `<td class="${isNum(c) ? "num" : ""}">${fmt(c, r)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
				: `<div class="an-empty">${_an_esc(opts.empty || "Sin datos en el período.")}</div>`);
			$w.find(".an-count").text(`${this.int(data.length)} fila(s)`);
			$w.find(".an-more").html(data.length > st.limit
				? `<button class="an-btn sec">Ver ${Math.min(50, data.length - st.limit)} más (de ${this.int(data.length)})</button>` : "");
			$w.find("th").on("click", (e) => {
				const k = $(e.currentTarget).data("k");
				st.dir = st.sort === k ? -st.dir : -1;
				st.sort = k;
				draw();
			});
			$w.find(".an-more button").on("click", () => { st.limit += 50; draw(); });
		};
		$w.html(`${opts.title ? `<h4>${_an_esc(opts.title)}</h4>` : ""}
			<div class="an-tbar"><input type="search" placeholder="Buscar…"><span class="an-muted an-count"></span></div>
			<div class="an-tw"></div><div class="an-more"></div>`);
		$w.find(".an-tbar input").on("input", frappe.utils.debounce((e) => { st.q = e.target.value.trim(); st.limit = 25; draw(); }, 200));
		draw();
	}

	// Sub-pestañas: [{id, label, n, html | render($pane)}]; recuerda la última por sección.
	tabs(sec, list) {
		const cur = list.find((t) => t.id === this.subtab[sec]) ? this.subtab[sec] : list[0].id;
		const $t = $(`<div><div class="an-tabs">${list.map((t) => `
			<button class="an-tab ${t.id === cur ? "on" : ""}" data-t="${t.id}">${_an_esc(t.label)}${t.n !== undefined ? `<span class="an-n">${this.int(t.n)}</span>` : ""}</button>`).join("")}
			</div><div class="an-pane"></div></div>`);
		const show = (id) => {
			this.subtab[sec] = id;
			$t.find(".an-tab").removeClass("on").filter(`[data-t="${id}"]`).addClass("on");
			const t = list.find((x) => x.id === id);
			const $p = $t.find(".an-pane").empty();
			if (t.render) t.render($p); else $p.html(t.html || "");
		};
		$t.find(".an-tab").on("click", (e) => show($(e.currentTarget).data("t")));
		show(cur);
		return $t;
	}

	pane(fn) {
		return ($p) => { const $c = $('<div class="an-card"></div>').appendTo($p); fn($c); };
	}

	// ── 1. Resumen ─────────────────────────────────────────────────────────
	r_resumen(d) {
		const k = d.kpis;
		this.$body.html(this.kpis([
			{ l: "Ventas", v: this.money(k.ventas), s: this.vari(k.ventas_var), tone: "pri" },
			{ l: "Tickets (ventas)", v: this.int(k.tickets), s: this.vari(k.tickets_var) },
			{ l: "Ticket promedio", v: this.money(k.ticket_prom), s: this.vari(k.ticket_prom_var) },
			{ l: "Clientes que compraron", v: this.int(k.clientes), s: this.vari(k.clientes_var), title: "Sin contar Consumidor Final" },
			{ l: "Recompran en el período", v: `${this.num(k.pct_recompra)}%`, s: `${this.int(k.recompran)} clientes con 2 compras o más`, tone: "ok" },
			{ l: "Clientes nuevos", v: this.int(k.nuevos), s: "Primera compra en este período" },
			{ l: "Hora / día de más venta", v: `${_an_esc(k.hora_pico)}`, s: _an_esc(k.dia_pico), sm: true },
			{ l: "Devoluciones", v: this.money(k.devoluciones_monto), s: `${this.int(k.devoluciones)} nota(s) de crédito`, tone: k.devoluciones ? "warn" : "" },
		]));
		const serie = d.serie || [];
		const max = Math.max(...serie.map((p) => p.ventas), 0) || 1;
		this.$body.append(this.tabs("resumen", [
			{ id: "tend", label: d.serie_semanal ? "Venta por semana" : "Venta por día", html: `<div class="an-card">
				<div class="an-cols">${serie.map((p) => `<div class="an-col" style="height:${(100 * p.ventas) / max}%" title="${_an_esc(`${this.date(p.fecha)}: ${this.money(p.ventas)} · ${p.tickets} ticket(s)`)}" data-tip="${_an_esc(`${d.serie_semanal ? "Semana del " : ""}${this.date(p.fecha)}: ${this.money(p.ventas)} · ${p.tickets} ticket(s)`)}"></div>`).join("")}</div>
				<div class="an-cols-x"><span>${this.date(serie[0] && serie[0].fecha)}</span><span>${this.date(serie.length && serie[serie.length - 1].fecha)}</span></div>
				<div class="an-tip">Toque o pase el cursor sobre una barra para ver el detalle.</div></div>` },
			{ id: "cond", label: "Cómo pagaron", html: `<div class="an-card">${this.bars(d.condiciones, "condicion", "monto",
				(v, r) => `${this.money(v)} · ${this.num(r.pct)}% · ${this.int(r.tickets)} tickets`,
				(r) => ({ "Contado": "ok", "Crédito": "", "Contra Entrega": "warn" }[r.condicion]))}</div>` },
			{ id: "tcli", label: "Top clientes", html: `<div class="an-card">${d.top_clientes.length ? this.bars(d.top_clientes, "nombre", "monto", (v) => this.money(v)) : '<div class="an-empty">Sin clientes identificados.</div>'}</div>` },
			{ id: "tprod", label: "Top productos", html: `<div class="an-card">${d.top_productos.length ? this.bars(d.top_productos, "nombre", "monto", (v, r) => `${this.money(v)} · ${this.num(r.cantidad)} u.`, "ok") : '<div class="an-empty">Sin ventas.</div>'}</div>` },
		]));
	}

	// ── 2. Clientes ────────────────────────────────────────────────────────
	r_clientes(d) {
		const k = d.kpis;
		this.$body.html(this.kpis([
			{ l: "Clientes que vuelven", v: `${this.num(k.pct_recurrentes)}%`, s: `${this.int(k.recurrentes)} de ${this.int(k.clientes)} compraron 2 veces o más`, tone: "ok" },
			{ l: "Activos", v: this.int(k.activos), s: "Compran a su ritmo de siempre", tone: "ok" },
			{ l: "En riesgo", v: this.int(k.en_riesgo), s: "Atrasados 1.5 a 3 veces su ritmo", tone: "warn" },
			{ l: "Dejaron de comprar", v: this.int(k.dejaron), s: "Más de 3 veces su ritmo sin comprar", tone: "bad" },
			{ l: "Venta mensual en riesgo", v: this.money(k.venta_mensual_en_riesgo), s: "Lo que esos clientes compraban por mes", tone: "bad" },
			{ l: "Nuevos en el período", v: this.int(k.nuevos), s: `${this.int(k.una_compra)} clientes con una sola compra (historial)` },
		]));
		const base = [
			{ k: "nombre", l: "Cliente" },
			{ k: "celular", l: "Celular", f: (r) => this.wa(r.celular, r.nombre) },
			{ k: "vendedor", l: "Vendedor" },
		];
		const cols = {
			recompran: [...base, { k: "compras", l: "Compras", f: "int" }, { k: "intervalo", l: "Cada (días)", f: "int" },
				{ k: "ticket_prom", l: "Ticket prom.", f: "money" }, { k: "monto", l: "Total histórico", f: "money" },
				{ k: "ultima", l: "Última", f: "date" }, { k: "estado", l: "Estado", f: "badge" }],
			riesgo: [...base, { k: "dias_sin_comprar", l: "Días sin comprar", f: "int" }, { k: "intervalo", l: "Compraba cada", f: "int" },
				{ k: "compras", l: "Compras", f: "int" }, { k: "ticket_prom", l: "Ticket prom.", f: "money" },
				{ k: "monto", l: "Total histórico", f: "money" }, { k: "ultima", l: "Última", f: "date" }],
			nuevos: [...base, { k: "primera", l: "Primera compra", f: "date" }, { k: "compras_periodo", l: "Compras", f: "int" },
				{ k: "monto_periodo", l: "Monto", f: "money" }, { k: "estado", l: "Estado", f: "badge" }],
			una: [...base, { k: "ultima", l: "Compró el", f: "date" }, { k: "dias_sin_comprar", l: "Hace (días)", f: "int" },
				{ k: "monto", l: "Monto", f: "money" }],
		};
		this.$body.append(this.tabs("clientes", [
			{ id: "rec", label: "Recompran", n: d.recompran.length, render: this.pane(($c) => this.table($c, cols.recompran, d.recompran, { sort: "compras" })) },
			{ id: "rie", label: "En riesgo", n: d.en_riesgo.length, render: this.pane(($c) => this.table($c, cols.riesgo, d.en_riesgo, { sort: "monto", empty: "Ningún cliente atrasado. ¡Bien!" })) },
			{ id: "dej", label: "Dejaron de comprar", n: d.dejaron.length, render: this.pane(($c) => this.table($c, cols.riesgo, d.dejaron, { sort: "monto", empty: "Ningún cliente perdido." })) },
			{ id: "nue", label: "Nuevos", n: d.nuevos.length, render: this.pane(($c) => this.table($c, cols.nuevos, d.nuevos, { sort: "monto_periodo" })) },
			{ id: "una", label: "Una sola compra", n: d.una_compra.length, render: this.pane(($c) => this.table($c, cols.una, d.una_compra, { sort: "monto" })) },
		]));
	}

	// ── 3. Horarios ────────────────────────────────────────────────────────
	r_horarios(d) {
		const k = d.kpis;
		this.$body.html(this.kpis([
			{ l: "Hora de más venta", v: _an_esc(k.hora_pico), s: this.money(k.hora_pico_monto), tone: "pri", sm: true },
			{ l: "Día de más venta", v: _an_esc(k.dia_pico), s: this.money(k.dia_pico_monto), tone: "ok", sm: true },
			{ l: "Mejor franja de la semana", v: _an_esc(k.mejor_franja), s: "Día y hora con más venta", sm: true },
			{ l: "Hora más floja (con ventas)", v: _an_esc(k.hora_baja), s: "Buena para promociones", tone: "warn", sm: true },
		]));
		const heat = ($c, mat, fmt, numeros) => {
			const horas = d.horas;
			if (!horas.length) return $c.html('<div class="an-empty">Sin ventas en el período.</div>');
			const max = Math.max(...mat.flat(), 0) || 1;
			const color = (v) => (v ? `rgba(21,51,117,${0.12 + (0.88 * v) / max})` : "#f3f4f6");
			$c.html(`<div style="overflow-x:auto"><table class="an-heat"><thead><tr><th></th>${horas.map((h) => `<th>${String(h).padStart(2, "0")}</th>`).join("")}</tr></thead>
				<tbody>${d.dias.map((dia, i) => `<tr><th style="text-align:right">${_an_esc(dia.slice(0, 3))}</th>${horas.map((h) => {
					const v = mat[i][h];
					const tip = `${dia} ${String(h).padStart(2, "0")}:00 · ${fmt(v)}`;
					return `<td style="background:${color(v)};color:${v / max > 0.55 ? "#fff" : "#0f172a"}" title="${_an_esc(tip)}" data-tip="${_an_esc(tip)}">${v && numeros ? v : ""}</td>`;
				}).join("")}</tr>`).join("")}</tbody></table></div>
				<div class="an-legend">Menos <i style="background:#f3f4f6"></i><i style="background:rgba(21,51,117,.35)"></i><i style="background:rgba(21,51,117,.65)"></i><i style="background:rgba(21,51,117,1)"></i> Más · toque una celda para ver el detalle</div>
				<div class="an-tip"></div>`);
		};
		const horas = d.por_hora.filter((h) => d.horas.includes(h.hora)).map((h) => ({ ...h, label: `${String(h.hora).padStart(2, "0")}:00` }));
		this.$body.append(this.tabs("horarios", [
			{ id: "heat", label: "Mapa (monto)", render: this.pane(($c) => heat($c, d.monto, (v) => this.money(v), false)) },
			{ id: "heatt", label: "Mapa (tickets)", render: this.pane(($c) => heat($c, d.tickets, (v) => `${v} ticket(s)`, true)) },
			{ id: "hora", label: "Por hora", html: `<div class="an-card">${this.bars(horas, "label", "monto", (v, r) => `${this.money(v)} · ${this.int(r.tickets)} t.`)}</div>` },
			{ id: "dia", label: "Por día", html: `<div class="an-card">${this.bars(d.por_dia, "dia", "monto", (v, r) => `${this.money(v)} · ${this.int(r.tickets)} t.`, "ok")}</div>` },
		]));
	}

	// ── 4. Condición de pago ───────────────────────────────────────────────
	r_pago(d) {
		const k = d.kpis;
		this.$body.html(this.kpis([
			{ l: "Pedidos contra entrega", v: `${this.num(k.pct_ce)}%`, s: `${this.int(k.ce_tickets)} tickets · ${this.money(k.ce_monto)}`, tone: "warn" },
			{ l: "Clientes que usan CE", v: this.int(k.clientes_ce), s: "Al menos un pedido contra entrega" },
			{ l: "Venta al crédito", v: `${this.num(k.pct_credito)}%`, s: "Del monto vendido", tone: "pri" },
			{ l: "Venta de contado", v: `${this.num(k.pct_contado)}%`, s: "Del monto vendido", tone: "ok" },
		]));
		const tono = (r) => ({ "Contado": "ok", "Crédito": "", "Contra Entrega": "warn" }[r.condicion]);
		this.$body.append(this.tabs("pago", [
			{ id: "res", label: "Resumen", render: this.pane(($c) => {
				$c.html(`<div class="an-grid2"><div><h4>Monto</h4>${this.bars(d.resumen, "condicion", "monto", (v, r) => `${this.money(v)} · ${this.num(r.pct)}%`, tono)}</div>
					<div><h4>Tickets</h4>${this.bars(d.resumen, "condicion", "tickets", (v, r) => `${this.int(v)} · ${this.num(r.pct_tickets)}%`, tono)}</div></div>
					<div style="margin-top:12px"></div>`);
				this.table($('<div>').appendTo($c), [{ k: "condicion", l: "Condición", f: "badge" }, { k: "tickets", l: "Tickets", f: "int" },
					{ k: "monto", l: "Monto", f: "money" }, { k: "ticket_prom", l: "Ticket prom.", f: "money" }, { k: "clientes", l: "Clientes", f: "int" }], d.resumen);
			}) },
			{ id: "mes", label: "Por mes", render: this.pane(($c) => this.table($c, [{ k: "mes", l: "Mes" },
				{ k: "Contado", l: "Contado", f: "money" }, { k: "Crédito", l: "Crédito", f: "money" }, { k: "Contra Entrega", l: "Contra entrega", f: "money" }], d.meses)) },
			{ id: "ce", label: "Clientes contra entrega", n: d.clientes_ce.length, render: this.pane(($c) => this.table($c, [
				{ k: "nombre", l: "Cliente" }, { k: "pedidos_ce", l: "Pedidos CE", f: "int" }, { k: "tickets", l: "Compras totales", f: "int" },
				{ k: "pct_ce", l: "% en CE", f: "pct" }, { k: "monto_ce", l: "Monto CE", f: "money" }], d.clientes_ce, { sort: "pedidos_ce" })) },
		]));
	}

	// ── 5. Productos ───────────────────────────────────────────────────────
	r_productos(d) {
		const k = d.kpis;
		this.$body.html(this.kpis([
			{ l: "Producto estrella", v: _an_esc(k.top), sm: true, tone: "ok" },
			{ l: "Productos vendidos", v: this.int(k.vendidos), s: "Distintos en el período" },
			{ l: "Con stock y sin venta", v: this.int(k.sin_venta), s: `${this.money(k.valor_sin_venta)} inmovilizados`, tone: "bad" },
			{ l: "Para ofertar", v: this.int(k.para_ofertar), s: `${this.money(k.valor_ofertar)} en stock`, tone: "warn" },
		]));
		this.$body.append(this.tabs("productos", [
			{ id: "top", label: "Más vendidos", n: d.vendidos.length, render: this.pane(($c) => this.table($c, [
				{ k: "nombre", l: "Producto" }, { k: "grupo", l: "Grupo" }, { k: "cantidad", l: "Cantidad", f: "num" },
				{ k: "monto", l: "Monto", f: "money" }, { k: "tickets", l: "Tickets", f: "int" }, { k: "clientes", l: "Clientes", f: "int" },
				{ k: "var_cantidad", l: "vs anterior", f: (r) => r.var_cantidad === null ? '<span class="an-muted">nuevo</span>' : `<span class="${r.var_cantidad >= 0 ? "an-up" : "an-down"}">${r.var_cantidad >= 0 ? "▲" : "▼"} ${this.num(Math.abs(r.var_cantidad))}%</span>`, num: true },
				{ k: "stock", l: "Stock", f: "num" }], d.vendidos, { sort: "monto" })) },
			{ id: "sin", label: "Sin venta", n: d.sin_venta.length, render: this.pane(($c) => this.table($c, [
				{ k: "nombre", l: "Producto" }, { k: "grupo", l: "Grupo" }, { k: "stock", l: "Stock", f: "num" }, { k: "uom", l: "UdM" },
				{ k: "valor_stock", l: "Valor en stock", f: "money" }, { k: "ultima_venta", l: "Última venta", f: (r) => r.ultima_venta ? this.date(r.ultima_venta) : '<span class="an-badge an-b-bad">Nunca</span>' },
				{ k: "dias_sin_venta", l: "Días sin venta", f: "int" }], d.sin_venta, { sort: "valor_stock", empty: "Todo lo que tiene stock se vendió en el período." })) },
			{ id: "ofe", label: "Para ofertar", n: d.ofertar.length, render: this.pane(($c) => this.table($c, [
				{ k: "nombre", l: "Producto" }, { k: "stock", l: "Stock", f: "num" }, { k: "vendido", l: "Vendido", f: "num" },
				{ k: "dias_inventario", l: "Días de inventario", f: "int" }, { k: "valor_stock", l: "Valor en stock", f: "money" },
				{ k: "motivo", l: "Por qué" }], d.ofertar, { sort: "valor_stock", empty: "Nada que ofertar: el stock va al ritmo de la venta." })) },
		]));
	}

	// ── 6. Venta cruzada ───────────────────────────────────────────────────
	r_cruzada(d) {
		const k = d.kpis;
		this.$body.html(this.kpis([
			{ l: "Tickets con 2+ productos", v: `${this.num(k.pct_multi)}%`, s: `${this.int(k.tickets_multi)} de ${this.int(k.tickets)}`, tone: "pri" },
			{ l: "Combinaciones frecuentes", v: this.int(k.pares), s: "Pares que se repiten en 2 tickets o más" },
		]));
		this.$body.append(this.tabs("cruzada", [
			{ id: "pares", label: "Se compran juntos", n: d.pares.length, render: this.pane(($c) => this.table($c, [
				{ k: "a_nombre", l: "Producto A" }, { k: "b_nombre", l: "Producto B" }, { k: "juntos", l: "Tickets juntos", f: "int" },
				{ k: "pct_a", l: "Quien lleva A, lleva B", f: "pct" }, { k: "pct_b", l: "Quien lleva B, lleva A", f: "pct" }],
				d.pares, { sort: "juntos", empty: "Todavía no hay combinaciones que se repitan." })) },
			{ id: "cli", label: "Sugerencias por cliente", render: ($p) => this._cruzada_cliente($p, d) },
		]));
	}

	_cruzada_cliente($p, d) {
		const $c = $('<div class="an-card"></div>').appendTo($p);
		$c.html(`<div class="an-tbar"><div style="flex:1;min-width:220px"><label class="an-muted" style="font-size:11px;font-weight:700">CLIENTE</label>
			<input list="an-cli-list" id="an-cli" placeholder="Escriba el nombre del cliente…" style="width:100%" value="${_an_esc((d.cliente || {}).nombre || "")}">
			<datalist id="an-cli-list">${d.clientes.map((c) => `<option value="${_an_esc(c.nombre)}">`).join("")}</datalist></div></div>
			<div id="an-cli-res"></div>`);
		const $res = $c.find("#an-cli-res");
		if (!d.cliente) {
			$res.html('<div class="an-empty">Elija un cliente para ver qué compran sus clientes parecidos que él todavía no compra.</div>');
		} else {
			$res.html(`<div class="an-grid2"><div class="an-sug"></div><div class="an-par"></div></div>
				<div class="an-muted" style="margin-top:8px">Compra ${this.int(d.cliente.productos.length)} producto(s) en el período.</div>`);
			this.table($res.find(".an-sug"), [{ k: "nombre", l: "Le puede interesar" }, { k: "clientes_parecidos", l: "Lo compran clientes parecidos", f: "int" }],
				d.sugerencias, { title: "Sugerencias", sort: "clientes_parecidos", empty: "Sin sugerencias: no hay clientes con compras parecidas." });
			this.table($res.find(".an-par"), [{ k: "nombre", l: "Cliente parecido" }, { k: "en_comun", l: "Productos en común", f: "int" }, { k: "similitud", l: "Parecido", f: "pct" }],
				d.parecidos, { title: "Clientes con compras parecidas", sort: "similitud" });
		}
		$c.find("#an-cli").on("change", (e) => {
			const c = d.clientes.find((x) => x.nombre === e.target.value);
			if (c) this.load(false, { customer: c.cliente });
		});
	}

	// ── 7. Crédito y pronóstico ────────────────────────────────────────────
	r_credito(d) {
		const k = d.kpis;
		this.$body.html(this.kpis([
			{ l: "Cartera real", v: this.money(k.cartera), s: `${this.int(k.clientes_con_saldo)} cliente(s) con saldo`, tone: "pri" },
			{ l: "Vencido", v: this.money(k.vencido), s: `${this.num(k.pct_vencido)}% de la cartera`, tone: k.vencido ? "bad" : "ok" },
			{ l: "Por cobrar próximos 30 días", v: this.money(k.por_vencer_30), s: "Según fecha de vencimiento", tone: "ok" },
			{ l: "Venta al crédito esperada (30 días)", v: this.money(k.esperado_30), s: `${this.int(k.clientes_activos)} clientes al crédito activos`, title: "Ticket promedio × compras que haría en 30 días a su ritmo" },
		]));
		const semanas = d.cobros.map((c) => ({ ...c, label: c.semana === "Vencido" ? "Vencido (ya)" : `Semana del ${this.date(c.semana)}` }));
		this.$body.append(this.tabs("credito", [
			{ id: "pron", label: "Pronóstico por cliente", n: d.pronostico.length, render: this.pane(($c) => this.table($c, [
				{ k: "nombre", l: "Cliente" }, { k: "celular", l: "Celular", f: (r) => this.wa(r.celular, r.nombre) },
				{ k: "estado", l: "Estado", f: "badge" }, { k: "compras", l: "Compras crédito", f: "int" }, { k: "intervalo", l: "Cada (días)", f: "int" },
				{ k: "ticket_prom", l: "Ticket prom.", f: "money" }, { k: "proxima", l: "Próxima compra (est.)", f: "date" },
				{ k: "esperado_30", l: "Esperado 30 días", f: "money" }, { k: "saldo", l: "Saldo", f: "money" },
				{ k: "vencido", l: "Vencido", f: (r) => r.vencido ? `<span class="an-down">${this.money(r.vencido)}</span>` : this.money(0), num: true },
				{ k: "atraso_prom", l: "Paga con atraso (días)", f: (r) => r.atraso_prom === null ? "—" : (r.atraso_prom > 0 ? `<span class="an-down">${this.int(r.atraso_prom)}</span>` : `<span class="an-up">${this.int(r.atraso_prom)}</span>`), num: true }],
				d.pronostico, { sort: "esperado_30", empty: "No hay ventas al crédito." })) },
			{ id: "cob", label: "Cobros esperados", html: `<div class="an-card">${this.bars(semanas, "label", "monto", (v) => this.money(v), (r) => r.semana === "Vencido" ? "bad" : "ok")}</div>` },
			{ id: "ant", label: "Antigüedad", html: `<div class="an-card">${this.bars(d.antiguedad, "rango", "monto", (v) => this.money(v),
				(r) => ({ rojo: "bad", ambar: "warn", azul: "", verde: "ok" }[r.tono]))}</div>` },
		]));
	}

	// ── 8. Tickets ─────────────────────────────────────────────────────────
	r_tickets(d) {
		const k = d.kpis;
		this.$body.html(this.kpis([
			{ l: "Tickets", v: this.int(k.tickets), tone: "pri" },
			{ l: "Ticket promedio", v: this.money(k.ticket_prom), s: `La mitad de las ventas es menor a ${this.money(k.ticket_mediana)}` },
			{ l: "Productos por ticket", v: this.num(k.productos_ticket), s: `${this.num(k.pct_un_producto)}% lleva un solo producto`, tone: "ok" },
			{ l: "Ticket más alto", v: this.money(k.ticket_max) },
		]));
		const g = [{ k: "nombre", l: "Nombre" }, { k: "tickets", l: "Tickets", f: "int" }, { k: "monto", l: "Monto", f: "money" },
			{ k: "ticket_prom", l: "Ticket prom.", f: "money" }, { k: "productos_prom", l: "Productos/ticket", f: "num" }];
		this.$body.append(this.tabs("tickets", [
			{ id: "monto", label: "Por monto", html: `<div class="an-card">${this.bars(d.rangos, "rango", "tickets", (v, r) => `${this.int(v)} · ${this.num(r.pct)}%`)}</div>` },
			{ id: "art", label: "Por productos", html: `<div class="an-card">${this.bars(d.articulos.map((a) => ({ ...a, label: `${a.productos} producto(s)` })), "label", "tickets", (v, r) => `${this.int(v)} · ${this.num(r.pct)}%`, "ok")}</div>` },
			{ id: "vend", label: "Por vendedor", n: d.vendedores.length, render: this.pane(($c) => this.table($c, g, d.vendedores, { sort: "monto" })) },
			{ id: "usr", label: "Por usuario", n: d.usuarios.length, render: this.pane(($c) => this.table($c, g, d.usuarios, { sort: "monto" })) },
			{ id: "dia", label: "Por día", html: `<div class="an-card">${this.bars(d.por_dia, "dia", "ticket_prom", (v, r) => `${this.money(v)} prom. · ${this.int(r.tickets)} t.`)}</div>` },
		]));
	}
}
