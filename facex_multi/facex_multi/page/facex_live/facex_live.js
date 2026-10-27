// FacEx Multi — Ventas por Live (pedidos de live TikTok → WhatsApp).
// Page sobre «FacEx Live Sesion» / «FacEx Live Pedido» (ver api/live.py).
//
// Rutas: facex-live (lista de sesiones) · facex-live/<sesión>/<sesion|bandeja|clientes>.
// 1) Sesión: personajes (conjuntos) y sus prendas; vendedor, bodega, lista y
//    flete salen del perfil del usuario, igual que el WhatsApp del live (cada
//    vendedor transmite desde su número y su bot solo llena su sesión). 2) Bandeja «Mío»: lo que llega por
//    WhatsApp (a mano o por el bot de la tienda), con la captura del live y la
//    cola por personaje. 3) Clientes: cotización, envío por WhatsApp, guía y
//    «Facturar listos».

frappe.pages["facex-live"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: "Ventas por Live — FacEx", single_column: true });
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex-live") {
			$("body").removeClass("facex-fullscreen-mode");
			if (wrapper.facexLive) wrapper.facexLive.stop_poll();
		}
	});
	wrapper.facexLive = new FacexLive(page, wrapper);
};

frappe.pages["facex-live"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	if (wrapper.facexLive) wrapper.facexLive.handle_route();
};

const LV_CSS = `
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
.lv{width:100%;padding:12px 16px;min-height:calc(100vh - 110px);font-size:13px;color:#1f2937}
.lv *{box-sizing:border-box}
.lv-back{border:0;background:none;color:#153375;font-weight:700;cursor:pointer;padding:4px 8px;border-radius:6px}.lv-back:hover{background:#eef2ff}
.lv-top{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:10px}
.lv-top h2{margin:0;font-size:20px;color:#153375}
.lv-sub{color:#6b7280;font-size:12px}
.lv-tabs{display:flex;gap:4px;border-bottom:2px solid #e5e7eb;margin-bottom:14px;flex-wrap:wrap}
.lv-tab{padding:8px 16px;border:0;background:none;cursor:pointer;font-weight:600;color:#6b7280;border-bottom:3px solid transparent;margin-bottom:-2px}
.lv-tab.on{color:#153375;border-color:#153375}
.lv-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px}
.lv-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.lv-f{min-width:160px;flex:1 1 160px}
.lv-f label{display:block;font-size:11px;font-weight:700;color:#4b5563;margin-bottom:3px;text-transform:uppercase}
.lv-f input,.lv-f select{width:100%;height:34px;padding:0 8px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;color:#111}
.lv-f .frappe-control{margin:0}.lv-f .form-group{margin:0}.lv-f .control-label{display:none}
.lv-btn{height:34px;padding:0 14px;border-radius:6px;border:1px solid #153375;background:#fff;color:#153375;font-weight:600;cursor:pointer;white-space:nowrap}
.lv-btn.pri{background:#153375;color:#fff}.lv-btn.ok{background:#1f6f54;border-color:#1f6f54;color:#fff}
.lv-btn.dng{border-color:#b91c1c;color:#b91c1c}.lv-btn.sm{height:28px;padding:0 9px;font-size:12px}
.lv-btn:disabled{opacity:.45;cursor:not-allowed}
.lv table{width:100%;border-collapse:collapse}
.lv th{background:#eef2ff;color:#153375;text-align:left;padding:6px 8px;font-size:12px;border:1px solid #dbe3f0}
.lv td{padding:5px 8px;border:1px solid #e5e7eb;vertical-align:middle}
.lv td.n,.lv th.n{text-align:right;font-variant-numeric:tabular-nums}
.lv-scroll{overflow-x:auto}
.lv-badge{display:inline-block;padding:2px 10px;border-radius:12px;font-size:11px;font-weight:700;white-space:nowrap}
.lv-e-Por{background:#fef3c7;color:#92400e}.lv-e-Mío{background:#dbeafe;color:#1e40af}
.lv-e-En{background:#f3f4f6;color:#4b5563}.lv-e-Confirmado{background:#e0e7ff;color:#3730a3}
.lv-e-Pagado{background:#dcfce7;color:#166534}.lv-e-Contra{background:#ffedd5;color:#9a3412}
.lv-e-Facturado{background:#153375;color:#fff}.lv-e-Cancelado{background:#fee2e2;color:#991b1b;text-decoration:line-through}
.lv-e-Abierta{background:#dcfce7;color:#166534}.lv-e-Cerrada{background:#f3f4f6;color:#4b5563}
.lv-pers{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.lv-per{border:1px solid #dbe3f0;border-radius:10px;padding:10px;background:#fafbff}
.lv-per-h{display:flex;gap:10px;align-items:flex-start}
.lv-foto{width:64px;height:64px;border-radius:8px;object-fit:cover;background:#e5e7eb;flex:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#6b7280;font-size:11px;text-align:center}
.lv-per input{height:30px;border:1px solid #cbd5e1;border-radius:6px;padding:0 6px}
.lv-prenda{display:flex;gap:6px;align-items:center;margin-top:6px}
.lv-prenda .lv-item{flex:1}.lv-prenda .frappe-control{margin:0}.lv-prenda .form-group{margin:0}.lv-prenda .control-label{display:none}
.lv-x{border:0;background:none;color:#b91c1c;font-size:16px;cursor:pointer;padding:0 4px}
.lv-chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.lv-chip{border:1px solid #dbe3f0;border-radius:20px;padding:4px 12px;background:#fff;font-size:12px;cursor:pointer}
.lv-chip b{color:#153375}.lv-chip.agotado{background:#f3f4f6;color:#6b7280}.lv-chip.sel{outline:2px solid #153375}
.lv-paste{border:2px dashed #cbd5e1;border-radius:8px;min-height:80px;display:flex;align-items:center;justify-content:center;color:#6b7280;cursor:pointer;padding:6px;text-align:center;font-size:12px}
.lv-paste img{max-height:120px;max-width:100%;border-radius:6px}
.lv-thumb{width:44px;height:44px;object-fit:cover;border-radius:6px;cursor:zoom-in;background:#e5e7eb}
.lv-cli{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.lv-cli .lv-card{margin:0}
.lv-cli h4{margin:0 0 4px;font-size:15px;color:#153375}
.lv-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.lv-muted{color:#6b7280}.lv-warn{background:#fffbeb;border:1px solid #fcd34d;color:#92400e;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px}
.lv-err{color:#991b1b}
@media(max-width:700px){.lv{padding:8px 6px}.lv-top h2{font-size:17px}}
`;

const LV_ESTADOS = ["Por revisar", "Mío", "En espera", "Confirmado", "Pagado", "Contra entrega", "Facturado", "Cancelado"];
const LV_POLL_MS = 15000;

function _lv_esc(s) { return frappe.utils.escape_html(s == null ? "" : String(s)); }
function _lv_q(v) { return "Q " + (parseFloat(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _lv_fecha(d) { if (!d) return ""; const p = String(d).slice(0, 10).split("-"); return `${p[2]}/${p[1]}/${p[0]}`; }
function _lv_hora(d) { return d ? String(d).slice(11, 19) : ""; }
function _lv_badge(e) { return `<span class="lv-badge lv-e-${_lv_esc(String(e || "").split(" ")[0])}">${_lv_esc(e)}</span>`; }
function _lv_norm(s) { return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function _lv_captura_url(pedido) { return `/api/method/facex_multi.api.live.ver_captura?name=${encodeURIComponent(pedido)}`; }
function _lv_read_b64(file) {
	return new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(file); });
}

class FacexLive {
	constructor(page, wrapper) {
		this.page = page;
		this.$root = $(page.body);
		this.ctx = null;
		this.data = null; // get_sesion
		this.tab = "bandeja";
		this.captura = null; // data URL de la captura pegada en la bandeja
		this.timer = null;
		this.page.add_menu_item(__("FacEx - Clásico"), () => { window.location.href = "/app/facex"; });
		this.$root.html(`<style>${LV_CSS}</style><div class="lv" id="lv-root"></div>`);
		this.$el = this.$root.find("#lv-root");
		this.load_ctx();
	}

	load_ctx() {
		frappe.call({
			method: "facex_multi.api.live.get_contexto",
			callback: (r) => { this.ctx = r.message; this.handle_route(); },
			error: () => this.$el.html(`<div class="lv-card">${__("No tiene acceso a Ventas por Live. Solicite el permiso «Ver página Live» en FacEx Settings.")}</div>`),
		});
	}

	go(...parts) { frappe.set_route("facex-live", ...parts.filter(Boolean)); }

	handle_route() {
		if (!this.ctx) return;
		const [, sesion, tab] = frappe.get_route();
		this.stop_poll();
		if (!sesion) return this.show_lista();
		if (sesion === "nueva") return this.show_sesion_form(null);
		this.tab = tab || "bandeja";
		this.load_sesion(sesion);
	}

	load_sesion(name, quiet) {
		frappe.call({
			method: "facex_multi.api.live.get_sesion", args: { name }, freeze: !quiet,
			callback: (r) => {
				this.data = r.message;
				if (quiet && this.tab === "bandeja" && this._typing()) return; // no borrar lo que se está escribiendo
				this.draw_sesion();
			},
		});
	}

	_typing() {
		const a = document.activeElement;
		return a && this.$el[0].contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && $(a).val();
	}

	start_poll() {
		this.stop_poll();
		if (!this.data || this.data.sesion.estado !== "Abierta") return;
		this.timer = setInterval(() => {
			if (frappe.get_route()[0] !== "facex-live" || document.hidden) return;
			this.load_sesion(this.data.sesion.name, true);
		}, LV_POLL_MS);
	}

	stop_poll() { if (this.timer) clearInterval(this.timer); this.timer = null; }

	header(sub, right) {
		return `<div class="lv-top"><div style="display:flex;align-items:center;gap:10px">
			<button class="lv-back" data-act="volver">← ${sub ? "Sesiones" : "FacEx"}</button>
			<div><h2>Ventas por Live</h2><div class="lv-sub">${_lv_esc(this.ctx.company)}${sub ? " · " + sub : ""}</div></div></div>
			<div style="display:flex;gap:8px;align-items:center">${right || ""}</div></div>`;
	}

	bind_back(to_lista) {
		this.$el.find("[data-act=volver]").on("click", () => {
			if (to_lista) this.go(); else window.location.href = "/app/facex";
		});
	}

	// ───────────────────────── lista de sesiones ─────────────────────────
	show_lista() {
		const c = this.ctx;
		const filas = (c.sesiones || []).map((s) => `<tr class="lv-click" data-n="${_lv_esc(s.name)}" style="cursor:pointer">
			<td>${_lv_fecha(s.fecha)}</td><td><b>${_lv_esc(s.titulo || s.name)}</b><div class="lv-muted">${_lv_esc(s.name)}</div></td>
			<td>${_lv_esc(s.linea_whatsapp || "—")}</td><td>${_lv_esc(s.lista_precios || "")}</td><td>${_lv_esc(s.vendedor || "")}</td><td>${_lv_badge(s.estado)}</td></tr>`).join("");
		this.$el.html(`${this.header("", c.permisos.live_sesiones ? `<button class="lv-btn pri" data-act="nueva">+ Nueva sesión</button>` : "")}
			<div class="lv-card lv-scroll">${filas ? `<table><thead><tr><th>Fecha</th><th>Sesión</th><th>WhatsApp</th><th>Lista</th><th>Vendedor</th><th>Estado</th></tr></thead><tbody>${filas}</tbody></table>`
				: `<div class="lv-muted">${__("Todavía no hay sesiones de Live.")}</div>`}</div>`);
		this.bind_back(false);
		this.$el.find("[data-act=nueva]").on("click", () => this.go("nueva"));
		this.$el.find("tr.lv-click").on("click", (e) => this.go($(e.currentTarget).data("n"), "bandeja"));
	}

	// ───────────────────────── sesión ─────────────────────────
	draw_sesion() {
		const s = this.data.sesion;
		this.$el.html(`${this.header(`${_lv_esc(s.titulo || s.name)} · ${_lv_fecha(s.fecha)}${s.linea_whatsapp ? ` · WA ${_lv_esc(s.linea_whatsapp)}` : ""} ${_lv_badge(s.estado)}`)}
			<div class="lv-tabs">
				<button class="lv-tab" data-t="bandeja">Bandeja «Mío»</button>
				<button class="lv-tab" data-t="clientes">Clientes</button>
				<button class="lv-tab" data-t="sesion">Sesión y personajes</button>
			</div><div id="lv-body"></div>`);
		this.bind_back(true);
		this.$el.find(".lv-tab").removeClass("on").filter(`[data-t=${this.tab}]`).addClass("on");
		this.$el.find(".lv-tab").on("click", (e) => this.go(s.name, $(e.currentTarget).data("t")));
		const $b = this.$el.find("#lv-body");
		if (this.tab === "sesion") this.show_sesion_form(this.data, $b);
		else if (this.tab === "clientes") this.show_clientes($b);
		else this.show_bandeja($b);
		if (this.tab !== "sesion") this.start_poll();
	}

	show_sesion_form(data, $body) {
		const c = this.ctx;
		const puede = !!c.permisos.live_sesiones;
		const s = data ? data.sesion : {
			titulo: "", fecha: frappe.datetime.get_today(), estado: "Abierta",
			vendedor: c.defaults.vendedor, bodega: c.defaults.bodega, lista_precios: c.defaults.lista_precios, incluir_flete: 1,
			linea_whatsapp: c.defaults.linea_whatsapp,
		};
		// Cada personaje lleva una llave `k` y sus prendas la misma: así siguen
		// juntas aunque se le cambie el alias (o mientras todavía no tiene).
		this.seq = 0;
		const personajes = data ? data.personajes.map((p) => ({ k: ++this.seq, alias: p.alias, unidades: p.unidades, foto: p.foto, notas: p.notas })) : [];
		const k_de = (alias) => (personajes.find((p) => _lv_norm(p.alias) === _lv_norm(alias)) || {}).k;
		this.form = {
			personajes,
			prendas: data ? data.prendas.map((r) => ({ k: k_de(r.alias), item_code: r.item_code, qty: r.qty })) : [],
			precios: {},
		};
		if (!$body) {
			this.$el.html(`${this.header("Nueva sesión")}<div id="lv-body"></div>`);
			this.bind_back(true);
			$body = this.$el.find("#lv-body");
		}
		const flete_bloq = !c.flete.puede_quitar;
		$body.html(`
			${!puede ? `<div class="lv-warn">${__("Solo lectura: no tiene permiso para editar sesiones de Live.")}</div>` : ""}
			<div class="lv-card"><div class="lv-row">
				<div class="lv-f" style="flex:2 1 240px"><label>Título</label><input id="lv-titulo" value="${_lv_esc(s.titulo || "")}" placeholder="Live del jueves noche"></div>
				<div class="lv-f"><label>Fecha</label><input id="lv-fecha" type="date" value="${_lv_esc(s.fecha || "")}"></div>
				<div class="lv-f"><label>WhatsApp del live</label><input id="lv-linea" inputmode="tel" value="${_lv_esc(s.linea_whatsapp || "")}" placeholder="8 dígitos" title="El bot de este número llena esta sesión"></div>
				<div class="lv-f"><label>Estado</label><select id="lv-estado"><option>Abierta</option><option>Cerrada</option></select></div>
			</div><div class="lv-row" style="margin-top:10px">
				<div class="lv-f" id="lv-c-vendedor"><label>Vendedor</label></div>
				<div class="lv-f" id="lv-c-bodega"><label>Bodega</label></div>
				<div class="lv-f" id="lv-c-lista"><label>Lista de precios</label></div>
				<div class="lv-f" style="flex:0 1 200px"><label>Flete</label>
					<label style="text-transform:none;font-weight:600;display:flex;gap:6px;align-items:center;height:34px">
					<input type="checkbox" id="lv-flete" style="width:auto;height:auto" ${s.incluir_flete ? "checked" : ""} ${flete_bloq ? "disabled" : ""}>
					Incluir flete ${c.flete.item ? `<span class="lv-muted">(${_lv_q(c.flete.rate)})</span>` : `<span class="lv-err">sin ítem de flete</span>`}</label></div>
			</div></div>
			<div class="lv-card">
				<div class="lv-top" style="margin-bottom:6px"><b style="color:#153375;font-size:14px">Personajes (cada uno es un conjunto)</b>
					${puede ? `<button class="lv-btn sm" data-act="add-per">+ Personaje</button>` : ""}</div>
				<div class="lv-muted" style="margin-bottom:8px">${__("El que dice «mío» se lleva todas las prendas del personaje. «Conjuntos» = cuántos hay; los siguientes quedan en espera.")}</div>
				<div class="lv-pers" id="lv-pers"></div>
			</div>
			${puede ? `<div style="display:flex;gap:8px;justify-content:flex-end"><button class="lv-btn pri" data-act="guardar">Guardar sesión</button></div>` : ""}`);
		$body.find("#lv-estado").val(s.estado || "Abierta");

		const mk = (id, df, val) => {
			const ctl = frappe.ui.form.make_control({ df, parent: $body.find(id), render_input: true });
			ctl.set_value(val || "");
			return ctl;
		};
		const lista_filters = c.listas_permitidas ? { name: ["in", c.listas_permitidas] } : { selling: 1 };
		const bodega_filters = c.bodegas_permitidas ? { name: ["in", c.bodegas_permitidas] } : { company: c.company, is_group: 0 };
		this.ctl = {
			vendedor: mk("#lv-c-vendedor", { fieldtype: "Link", options: "Sales Partner", fieldname: "vendedor", read_only: c.defaults.vendedor_fijo ? 1 : 0 }, s.vendedor),
			bodega: mk("#lv-c-bodega", { fieldtype: "Link", options: "Warehouse", fieldname: "bodega", get_query: () => ({ filters: bodega_filters }) }, s.bodega),
			lista: mk("#lv-c-lista", {
				fieldtype: "Link", options: "Price List", fieldname: "lista", get_query: () => ({ filters: lista_filters }),
				change: () => this.refresh_precios(),
			}, s.lista_precios),
		};
		this.$pers = $body.find("#lv-pers");
		this.draw_personajes(puede);
		this.refresh_precios();
		$body.find("[data-act=add-per]").on("click", () => {
			this.form.personajes.push({ k: ++this.seq, alias: "", unidades: 1, foto: "", notas: "" });
			this.draw_personajes(true);
			this.$pers.find(".lv-alias").last().focus();
		});
		$body.find("[data-act=guardar]").on("click", () => this.guardar_sesion(data ? s.name : null));
		if (!puede) $body.find("input,select").prop("disabled", true);
	}

	draw_personajes(puede) {
		const f = this.form;
		this.$pers.empty();
		if (!f.personajes.length) this.$pers.html(`<div class="lv-muted">${__("Agregue el primer personaje.")}</div>`);
		f.personajes.forEach((p, i) => {
			const $p = $(`<div class="lv-per">
				<div class="lv-per-h">
					${p.foto ? `<img class="lv-foto" src="${_lv_esc(p.foto)}" data-act="foto" title="Cambiar foto">` : `<div class="lv-foto" data-act="foto">+ Foto</div>`}
					<div style="flex:1;display:flex;flex-direction:column;gap:6px">
						<input class="lv-alias" placeholder="Alias / personaje" value="${_lv_esc(p.alias)}">
						<div style="display:flex;gap:6px;align-items:center">
							<input class="lv-unid" type="number" min="0" style="width:70px" value="${p.unidades || 0}"> <span class="lv-muted">conjuntos</span>
							<span style="margin-left:auto;font-weight:700;color:#153375" class="lv-precio"></span>
						</div>
					</div>
					${puede ? `<button class="lv-x" data-act="del-per" title="Quitar personaje">×</button>` : ""}
				</div>
				<div class="lv-prendas"></div>
				${puede ? `<button class="lv-btn sm" style="margin-top:6px" data-act="add-prenda">+ Prenda</button>` : ""}
				<input type="file" accept="image/*" style="display:none" class="lv-foto-in">
			</div>`);
			$p.find(".lv-alias").on("input", (e) => { p.alias = $(e.target).val(); });
			$p.find(".lv-unid").on("change", (e) => { p.unidades = parseInt($(e.target).val(), 10) || 0; });
			$p.find("[data-act=del-per]").on("click", () => {
				f.prendas = f.prendas.filter((r) => r.k !== p.k);
				f.personajes.splice(i, 1);
				this.draw_personajes(puede);
			});
			$p.find("[data-act=foto]").on("click", () => puede && $p.find(".lv-foto-in").click());
			$p.find(".lv-foto-in").on("change", async (e) => {
				const file = e.target.files[0];
				if (!file) return;
				p.foto = await this.upload_public(file);
				this.draw_personajes(puede);
			});
			$p.find("[data-act=add-prenda]").on("click", () => {
				f.prendas.push({ k: p.k, item_code: "", qty: 1 });
				this.draw_personajes(puede);
			});
			const $pr = $p.find(".lv-prendas");
			f.prendas.forEach((r, j) => {
				if (r.k !== p.k) return;
				const $r = $(`<div class="lv-prenda"><div class="lv-item"></div>
					<input type="number" min="1" step="1" style="width:56px" value="${r.qty || 1}" title="Cantidad por conjunto">
					${puede ? `<button class="lv-x" title="Quitar prenda">×</button>` : ""}</div>`);
				const ctl = frappe.ui.form.make_control({
					df: {
						fieldtype: "Link", options: "Item", fieldname: `item_${j}`, placeholder: "Prenda",
						change: () => { r.item_code = ctl.get_value(); this.refresh_precios(); },
					},
					parent: $r.find(".lv-item"), render_input: true,
				});
				ctl.set_value(r.item_code || "");
				$r.find("input[type=number]").on("change", (e) => { r.qty = parseFloat($(e.target).val()) || 1; this.paint_precios(); });
				$r.find(".lv-x").on("click", () => { f.prendas.splice(j, 1); this.draw_personajes(puede); });
				$pr.append($r);
			});
			this.$pers.append($p);
		});
		this.paint_precios();
	}

	refresh_precios() {
		const lista = this.ctl && this.ctl.lista.get_value();
		const items = [...new Set(this.form.prendas.map((r) => r.item_code).filter(Boolean))];
		if (!lista || !items.length) { this.form.precios = {}; return this.paint_precios(); }
		frappe.call({
			method: "facex_multi.api.live.precios_items", args: { items_json: JSON.stringify(items), price_list: lista },
			callback: (r) => { this.form.precios = r.message || {}; this.paint_precios(); },
		});
	}

	paint_precios() {
		const f = this.form;
		this.$pers.find(".lv-per").each((i, el) => {
			const p = f.personajes[i];
			if (!p) return;
			const total = f.prendas.filter((r) => r.k === p.k && r.item_code)
				.reduce((a, r) => a + (parseFloat(f.precios[r.item_code]) || 0) * (parseFloat(r.qty) || 1), 0);
			$(el).find(".lv-precio").text(total ? _lv_q(total) : "");
		});
	}

	async upload_public(file) {
		const fd = new FormData();
		fd.append("file", file, file.name);
		fd.append("is_private", "0");
		fd.append("folder", "Home/Attachments");
		const res = await fetch("/api/method/upload_file", { method: "POST", body: fd, headers: { "X-Frappe-CSRF-Token": frappe.csrf_token } });
		const j = await res.json();
		if (!res.ok || !j.message) { frappe.msgprint(__("No se pudo subir la foto.")); return ""; }
		return j.message.file_url;
	}

	guardar_sesion(name) {
		const f = this.form;
		const data = {
			name, company: this.ctx.company,
			titulo: this.$el.find("#lv-titulo").val(), fecha: this.$el.find("#lv-fecha").val(),
			estado: this.$el.find("#lv-estado").val(), linea_whatsapp: this.$el.find("#lv-linea").val(),
			vendedor: this.ctl.vendedor.get_value(), bodega: this.ctl.bodega.get_value(), lista_precios: this.ctl.lista.get_value(),
			incluir_flete: this.$el.find("#lv-flete").is(":checked") ? 1 : 0,
			personajes: f.personajes.map(({ alias, unidades, foto, notas }) => ({ alias, unidades, foto, notas })),
			prendas: f.prendas.filter((r) => r.item_code).map((r) => ({
				alias: (f.personajes.find((p) => p.k === r.k) || {}).alias || "", item_code: r.item_code, qty: r.qty,
			})),
		};
		frappe.call({
			method: "facex_multi.api.live.guardar_sesion", args: { data_json: JSON.stringify(data) }, freeze: true,
			callback: (r) => {
				frappe.show_alert({ message: __("Sesión guardada"), indicator: "green" });
				this.reload_ctx_sesiones();
				if (name) this.load_sesion(name); else this.go(r.message.name, "bandeja");
			},
		});
	}

	reload_ctx_sesiones() {
		frappe.call({ method: "facex_multi.api.live.get_contexto", callback: (r) => { this.ctx = r.message; } });
	}

	// ───────────────────────── bandeja «Mío» ─────────────────────────
	show_bandeja($b) {
		const d = this.data;
		const abierta = d.sesion.estado === "Abierta";
		const chips = d.personajes.map((p) => {
			const disp = p.unidades - p.ocupados;
			return `<span class="lv-chip ${disp <= 0 ? "agotado" : ""}" data-alias="${_lv_esc(p.alias)}" title="${_lv_q(p.precio)}">
				<b>${_lv_esc(p.alias)}</b> · ${disp > 0 ? `${disp} de ${p.unidades}` : "agotado"}${p.en_espera ? ` · ${p.en_espera} en espera` : ""}</span>`;
		}).join("");
		const por_revisar = d.pedidos.filter((p) => p.estado === "Por revisar").length;
		$b.html(`
			<div class="lv-chips">${chips || `<span class="lv-muted">${__("La sesión no tiene personajes.")}</span>`}</div>
			${abierta ? `<div class="lv-card"><div class="lv-row">
				<div class="lv-f" style="flex:0 1 150px"><label>Teléfono</label><input id="lv-tel" inputmode="tel" placeholder="5555 1234"></div>
				<div class="lv-f"><label>Nombre (WhatsApp)</label><input id="lv-nom" placeholder="Se busca por teléfono"></div>
				<div class="lv-f"><label>Personaje</label><select id="lv-alias"><option value=""></option>
					${d.personajes.map((p) => `<option>${_lv_esc(p.alias)}</option>`).join("")}</select></div>
				<div class="lv-f" style="flex:0 1 90px"><label>Conjuntos</label><input id="lv-cant" type="number" min="1" value="1"></div>
				<div class="lv-f" style="flex:0 1 110px"><label>Hora del mensaje</label><input id="lv-hora" type="time" step="1"></div>
				<div class="lv-f" style="flex:1 1 200px"><label>Captura del live</label>
					<div class="lv-paste" id="lv-paste" tabindex="0">${__("Pegue (Ctrl+V) o toque para elegir la captura")}</div>
					<input type="file" accept="image/*" id="lv-cap-in" style="display:none"></div>
				<button class="lv-btn pri" data-act="registrar">Registrar «Mío»</button>
			</div><div class="lv-muted" id="lv-cli-hint" style="margin-top:6px"></div></div>`
			: `<div class="lv-warn">${__("La sesión está cerrada: no entran pedidos nuevos.")}</div>`}
			${abierta && !d.sesion.linea_whatsapp ? `<div class="lv-warn">${__("La sesión no tiene WhatsApp del live: el bot no la llena, solo entra lo que se registre a mano.")}</div>` : ""}
			${por_revisar ? `<div class="lv-warn">${__("{0} mensaje(s) por revisar: asigne cliente y personaje.", [por_revisar])}</div>` : ""}
			<div class="lv-card lv-scroll"><table><thead><tr>
				<th>Llegada</th><th>Captura</th><th>Cliente</th><th>Personaje</th><th class="n">Conj.</th><th>Estado</th><th>Acciones</th>
			</tr></thead><tbody id="lv-ped"></tbody></table></div>`);
		this.draw_pedidos($b.find("#lv-ped"));
		if (!abierta) return;

		this.captura = null;
		const $paste = $b.find("#lv-paste");
		const set_cap = (url) => { this.captura = url; $paste.html(url ? `<img src="${url}">` : __("Pegue (Ctrl+V) o toque para elegir la captura")); };
		$paste.on("click", () => $b.find("#lv-cap-in").click());
		$b.find("#lv-cap-in").on("change", async (e) => { if (e.target.files[0]) set_cap(await _lv_read_b64(e.target.files[0])); });
		$b.off("paste").on("paste", async (e) => {
			const items = (e.originalEvent.clipboardData || {}).items || [];
			for (const it of items) {
				if (it.type && it.type.startsWith("image/")) { e.preventDefault(); set_cap(await _lv_read_b64(it.getAsFile())); return; }
			}
		});
		$b.find(".lv-chip").on("click", (e) => $b.find("#lv-alias").val($(e.currentTarget).data("alias")));
		$b.find("#lv-tel").on("change", (e) => {
			const tel = $(e.target).val();
			if (String(tel).replace(/\D/g, "").length < 8) return;
			frappe.call({
				method: "facex_multi.api.live.buscar_cliente_telefono", args: { telefono: tel },
				callback: (r) => {
					const m = r.message || {};
					this.cliente_tel = m.cliente || null;
					$b.find("#lv-cli-hint").html(m.cliente ? `Cliente: <b>${_lv_esc(m.nombre)}</b>`
						: (this.ctx.permisos.crea_clientes ? __("Cliente nuevo: se crea con este teléfono y nombre.") : `<span class="lv-err">${__("No existe cliente con ese teléfono y no tiene permiso para crearlo.")}</span>`));
					if (m.nombre && !$b.find("#lv-nom").val()) $b.find("#lv-nom").val(m.nombre);
				},
			});
		});
		$b.find("[data-act=registrar]").on("click", () => this.registrar($b));
	}

	registrar($b) {
		const tel = $b.find("#lv-tel").val();
		if (String(tel).replace(/\D/g, "").length < 8) return frappe.msgprint(__("Escriba el teléfono (8 dígitos)."));
		const hora = $b.find("#lv-hora").val();
		const args = {
			sesion: this.data.sesion.name, telefono: tel, nombre: $b.find("#lv-nom").val(),
			alias: $b.find("#lv-alias").val(), cantidad: $b.find("#lv-cant").val() || 1,
			// La hora del mensaje decide quién llegó primero; sin hora, la de ahora.
			llegada: hora ? `${frappe.datetime.get_today()} ${hora.length === 5 ? hora + ":00" : hora}` : null,
		};
		const captura = this.captura;
		frappe.call({
			method: "facex_multi.api.live.registrar_mio", args, freeze: true,
			callback: (r) => {
				const m = r.message;
				const fin = () => {
					frappe.show_alert({ message: `${__("Registrado")}: ${m.estado}`, indicator: m.estado === "Mío" ? "green" : "orange" });
					this.cliente_tel = null;
					this.load_sesion(this.data.sesion.name);
				};
				if (!captura) return fin();
				frappe.call({ method: "facex_multi.api.live.subir_captura", args: { name: m.name, filedata: captura }, callback: fin, error: fin });
			},
		});
	}

	draw_pedidos($tb) {
		const d = this.data;
		if (!d.pedidos.length) return $tb.html(`<tr><td colspan="7" class="lv-muted">${__("Todavía no llega ningún «mío».")}</td></tr>`);
		$tb.html(d.pedidos.map((p) => {
			const acts = [];
			const e = p.estado;
			if (e === "Por revisar") acts.push(["revisar", "Revisar", "pri"]);
			if (e === "Mío") acts.push(["Confirmado", "Confirmar", "pri"]);
			if (e === "Mío" || e === "Confirmado") acts.push(["Pagado", "Pagado", "ok"], ["Contra entrega", "Contra entrega", ""]);
			if (e === "Pagado" || e === "Contra entrega") acts.push(["Confirmado", "Deshacer cobro", "sm"]);
			if (e !== "Facturado" && e !== "Cancelado") acts.push(["editar", "Editar", ""], ["Cancelado", "Cancelar", "dng"]);
			return `<tr data-n="${_lv_esc(p.name)}">
				<td>${_lv_hora(p.llegada)}<div class="lv-muted">${p.origen === "Bot WhatsApp" ? "bot" : "manual"}</div></td>
				<td>${p.captura ? `<img class="lv-thumb" src="${_lv_captura_url(p.name)}" data-act="ver">` : ""}</td>
				<td><b>${_lv_esc(p.cliente_nombre || p.nombre_wa || "—")}</b><div class="lv-muted">${_lv_esc(p.telefono || "")}</div>
					${p.mensaje ? `<div class="lv-muted" style="max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${_lv_esc(p.mensaje)}">“${_lv_esc(p.mensaje)}”</div>` : ""}</td>
				<td>${_lv_esc(p.alias || "—")}</td><td class="n">${p.cantidad || 1}</td>
				<td>${_lv_badge(e)}${p.metodo_pago ? `<div class="lv-muted">${_lv_esc(p.metodo_pago)} ${_lv_esc(p.referencia_pago || "")}</div>` : ""}</td>
				<td><div class="lv-acts" style="margin:0">${acts.map(([a, l, k]) => `<button class="lv-btn sm ${k}" data-act="${_lv_esc(a)}">${l}</button>`).join("")}</div></td></tr>`;
		}).join(""));
		$tb.find("[data-act=ver]").on("click", (e) => {
			const n = $(e.target).closest("tr").data("n");
			const dlg = new frappe.ui.Dialog({ title: __("Captura del live"), size: "large" });
			dlg.$body.html(`<img src="${_lv_captura_url(n)}" style="max-width:100%;display:block;margin:auto">`);
			dlg.show();
		});
		$tb.find("button[data-act]").on("click", (e) => {
			const act = $(e.currentTarget).data("act");
			const p = d.pedidos.find((x) => x.name === $(e.currentTarget).closest("tr").data("n"));
			if (act === "revisar" || act === "editar") return this.editar_pedido(p);
			if (act === "Pagado") return this.marcar_pagado(p);
			if (act === "Cancelado") {
				return frappe.confirm(__("¿Cancelar el pedido de {0}? Si estaba apartado, sube el siguiente en espera.", [_lv_esc(p.cliente_nombre || p.telefono)]),
					() => this.actualizar(p.name, { estado: "Cancelado" }));
			}
			this.actualizar(p.name, { estado: act });
		});
	}

	actualizar(name, data) {
		frappe.call({
			method: "facex_multi.api.live.actualizar_pedido", args: { name, data_json: JSON.stringify(data) }, freeze: true,
			callback: () => this.load_sesion(this.data.sesion.name),
		});
	}

	marcar_pagado(p) {
		const dlg = new frappe.ui.Dialog({
			title: __("Pago recibido"),
			fields: [
				{ fieldname: "metodo_pago", label: __("Método"), fieldtype: "Select", options: "Transferencia\nDepósito\nEfectivo\nTarjeta de Crédito", default: p.metodo_pago || "Transferencia", reqd: 1 },
				{ fieldname: "referencia_pago", label: __("Referencia / boleta"), fieldtype: "Data", default: p.referencia_pago || "" },
			],
			primary_action_label: __("Marcar pagado"),
			primary_action: (v) => { dlg.hide(); this.actualizar(p.name, { ...v, estado: "Pagado" }); },
		});
		dlg.show();
	}

	editar_pedido(p) {
		const d = this.data;
		const dlg = new frappe.ui.Dialog({
			title: __("Pedido {0}", [p.name]),
			fields: [
				{ fieldname: "mensaje", fieldtype: "HTML", options: p.mensaje ? `<div class="lv-muted" style="margin-bottom:8px">“${_lv_esc(p.mensaje)}”</div>` : "" },
				{ fieldname: "telefono", label: __("Teléfono"), fieldtype: "Data", default: p.telefono },
				{ fieldname: "cliente", label: __("Cliente"), fieldtype: "Link", options: "Customer", default: p.cliente },
				{ fieldname: "cb", fieldtype: "Column Break" },
				{ fieldname: "alias", label: __("Personaje"), fieldtype: "Select", options: ["", ...d.personajes.map((x) => x.alias)].join("\n"), default: p.alias },
				{ fieldname: "cantidad", label: __("Conjuntos"), fieldtype: "Int", default: p.cantidad || 1 },
				{ fieldname: "sb", fieldtype: "Section Break" },
				{ fieldname: "notas", label: __("Notas"), fieldtype: "Small Text", default: p.notas },
			],
			primary_action_label: __("Guardar"),
			primary_action: (v) => { dlg.hide(); this.actualizar(p.name, v); },
		});
		if (!p.cliente && p.telefono) {
			frappe.call({
				method: "facex_multi.api.live.buscar_cliente_telefono", args: { telefono: p.telefono },
				callback: (r) => { if (r.message && r.message.cliente) dlg.set_value("cliente", r.message.cliente); },
			});
		}
		dlg.show();
	}

	// ───────────────────────── clientes ─────────────────────────
	show_clientes($b) {
		const d = this.data;
		const p = this.ctx.permisos;
		const wa = this.ctx.wa || {};
		const listos = d.clientes.filter((c) => c.estados.length && c.estados.every((e) => ["Pagado", "Contra entrega"].includes(e)));
		$b.html(`
			<div class="lv-top"><div class="lv-muted">${__("{0} cliente(s) · {1} listos para facturar", [d.clientes.length, listos.length])}</div>
				${p.live_facturar ? `<button class="lv-btn ok" data-act="facturar" ${listos.length ? "" : "disabled"}>Facturar listos (${listos.length})</button>` : ""}</div>
			<div class="lv-cli">${d.clientes.map((c) => {
				const inf = c.cotizacion_info || {};
				const facturada = inf.docstatus === 1;
				const doc = c.cotizacion ? `<a href="/app/sales-invoice/${encodeURIComponent(c.cotizacion)}" target="_blank">${_lv_esc(c.cotizacion)}</a>
					· ${facturada ? (inf.bfel_uuid ? "certificada" : "validada") : "cotización"} · <b>${_lv_q(inf.grand_total)}</b>` : `<span class="lv-muted">sin cotización</span>`;
				const puede_cot = !facturada && c.estados.some((e) => ["Mío", "Confirmado", "Pagado", "Contra entrega"].includes(e));
				const tipo_wa = facturada ? "factura" : "cotizacion";
				return `<div class="lv-card" data-c="${_lv_esc(c.cliente)}">
					<h4>${_lv_esc(c.nombre)}</h4>
					<div class="lv-muted">${_lv_esc(c.telefono || "")} · ${c.conjuntos} conjunto(s) · aprox. ${_lv_q(c.subtotal)} + flete</div>
					<div style="margin:6px 0">${c.estados.map(_lv_badge).join(" ")}</div>
					<div>${doc}</div>
					<div class="lv-acts">
						${puede_cot && p.puede_guardar ? `<button class="lv-btn sm pri" data-act="cot">${c.cotizacion && !facturada ? "Actualizar cotización" : "Armar cotización"}</button>` : ""}
						${c.cotizacion && wa[tipo_wa] && facturada === (tipo_wa === "factura") ? `<button class="lv-btn sm ok" data-act="wa" data-tipo="${tipo_wa}">${facturada ? "Factura por WA" : "Cotización por WA"}</button>` : ""}
						${c.cotizacion && inf.bfel_pago_contra_entrega ? `<button class="lv-btn sm" data-act="guia">Anotar guía</button>` : ""}
					</div></div>`;
			}).join("") || `<div class="lv-muted">${__("Todavía no hay clientes con pedidos.")}</div>`}</div>`);

		$b.find("button[data-act]").on("click", (e) => {
			const act = $(e.currentTarget).data("act");
			const cli = $(e.currentTarget).closest("[data-c]").data("c");
			const c = d.clientes.find((x) => x.cliente === cli);
			if (act === "facturar") return this.facturar_listos(listos.length);
			if (act === "cot") return this.armar_cotizacion(cli);
			if (act === "wa") return facex_multi.wa.open(c.cotizacion, $(e.currentTarget).data("tipo"));
			if (act === "guia") return this.anotar_guia(c);
		});
	}

	armar_cotizacion(cliente) {
		frappe.call({
			method: "facex_multi.api.live.armar_cotizacion", args: { sesion: this.data.sesion.name, cliente },
			freeze: true, freeze_message: __("Armando cotización…"),
			callback: (r) => {
				const m = r.message;
				frappe.show_alert({ message: `${m.invoice} · ${_lv_q(m.grand_total)}`, indicator: "green" });
				this.load_sesion(this.data.sesion.name);
				if ((this.ctx.wa || {}).cotizacion) facex_multi.wa.open(m.invoice, "cotizacion");
			},
		});
	}

	anotar_guia(c) {
		const t = this.ctx.transportistas || [];
		const dlg = new frappe.ui.Dialog({
			title: __("Guía para {0}", [c.nombre]),
			fields: [
				{ fieldname: "numero_guia", label: __("Número de guía"), fieldtype: "Data", reqd: 1 },
				{ fieldname: "transportista", label: __("Transportista"), fieldtype: "Select", options: t.join("\n"), default: this.ctx.transportista_default || t[0] },
			],
			primary_action_label: __("Anotar"),
			primary_action: (v) => {
				dlg.hide();
				frappe.call({
					method: "facex_multi.api.live.anotar_guia",
					args: { sesion: this.data.sesion.name, cliente: c.cliente, numero_guia: v.numero_guia, transportista: v.transportista },
					freeze: true,
					callback: (r) => { frappe.show_alert({ message: __("Guía {0} anotada", [r.message.numero_guia]), indicator: "green" }); this.load_sesion(this.data.sesion.name); },
				});
			},
		});
		dlg.show();
		setTimeout(() => dlg.fields_dict.numero_guia.$input.focus(), 300);
	}

	facturar_listos(n) {
		frappe.confirm(__("Se validan, certifican en FEL y cobran {0} factura(s). ¿Continuar?", [n]), () => {
			frappe.call({
				method: "facex_multi.api.live.facturar_listos", args: { sesion: this.data.sesion.name },
				freeze: true, freeze_message: __("Facturando…"),
				callback: (r) => {
					const res = (r.message || {}).resultados || [];
					const filas = res.map((x) => `<tr><td>${_lv_esc(x.nombre || x.cliente)}</td><td>${_lv_esc(x.invoice || "")}</td>
						<td>${x.error ? `<span class="lv-err">${_lv_esc(x.error)}</span>`
							: [x.certificada ? "✔ certificada" : "", x.error_fel ? `<span class="lv-err">FEL: ${_lv_esc(x.error_fel)}</span>` : "",
								x.error_pago ? `<span class="lv-err">Pago: ${_lv_esc(x.error_pago)}</span>` : "✔ pago registrado"].filter(Boolean).join("<br>")}</td></tr>`).join("");
					frappe.msgprint({
						title: __("Resultado de la facturación"), wide: true,
						message: `<table class="table table-bordered"><thead><tr><th>Cliente</th><th>Factura</th><th>Resultado</th></tr></thead><tbody>${filas}</tbody></table>`,
					});
					this.load_sesion(this.data.sesion.name);
				},
			});
		});
	}
}
