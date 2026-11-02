// FacEx Multi — Ventas por Live (pedidos de live TikTok → WhatsApp).
// Page sobre «FacEx Live Sesion» / «FacEx Live Pedido» (ver api/live.py).
//
// Rutas: facex-live (lista de sesiones) · facex-live/<sesión>/<sesion|bandeja|clientes>.
// 1) Sesión: personajes (una prenda cada uno, con su cantidad y unidad); vendedor, bodega, lista y
//    flete salen del perfil del usuario, igual que el WhatsApp del live (cada
//    vendedor transmite desde su número y su bot solo llena su sesión). 2) Bandeja «Mío»: lo que llega por
//    WhatsApp (a mano o por el bot de la tienda), con la captura del live y la
//    cola por personaje. 3) Cotizar y Facturar: un documento por tarjeta, por etapa;
//    confirmar, cobro, guía, cancelación con motivo y «Facturar listos».

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
.lv-per .lv-item .frappe-control{margin:0}.lv-per .lv-item .form-group{margin:0}.lv-per .lv-item .control-label{display:none}
.lv-per-item{display:flex;gap:6px;align-items:baseline;min-width:0}
.lv-per-item b{color:#153375;white-space:nowrap}.lv-per-item span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#374151}
.lv-scan{display:flex;gap:6px;margin-bottom:8px}
.lv-scan input{flex:1;height:38px;padding:0 10px;border:2px solid #153375;border-radius:8px;font-size:14px}
.lv-stock-n{font-size:12px;padding:2px 8px;border-radius:10px;background:#dcfce7;color:#166534;white-space:nowrap}
.lv-stock-n.bajo{background:#fee2e2;color:#991b1b}
.lv-flash{animation:lv-flash 1.2s ease 2}
@keyframes lv-flash{50%{box-shadow:0 0 0 3px #f59e0b}}
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
.lv td.c,.lv th.c{text-align:center}
.lv-flash-row,.lv tr.lv-flash-row td{animation:lv-titila .5s ease-in-out 6}
@keyframes lv-titila{50%{background:#fde68a}}
.lv-motivos{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.lv-motivos .lv-btn{height:40px;white-space:normal}
.lv-grupo{margin-bottom:18px;--g:#153375;--gt:#eef2ff}
.lv-grupo-h{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px;padding:8px 12px;border-radius:8px;border-left:6px solid var(--g);background:var(--gt);color:var(--g);font-size:15px;cursor:pointer;user-select:none}
.lv-grupo-h .lv-n{background:var(--g);color:#fff;border-radius:12px;padding:1px 10px;font-size:12px;font-weight:800}
.lv-grupo-h .lv-muted{font-size:12px}.lv-grupo-h .lv-caret{margin-left:auto;transition:transform .15s}
.lv-grupo.plegado .lv-caret{transform:rotate(-90deg)}.lv-grupo.plegado .lv-cli{display:none}
.lv-grupo .lv-card{border-left:4px solid var(--g)}
.lv-seccion{margin-bottom:22px}
.lv-seccion-h{font-size:18px;font-weight:800;color:#0f172a;text-transform:uppercase;letter-spacing:.6px;padding:4px 0 6px;margin-bottom:10px;border-bottom:3px solid #0f172a;display:flex;gap:8px;align-items:center}
.lv-seccion-h span{font-size:12px;background:#0f172a;color:#fff;border-radius:12px;padding:1px 10px;letter-spacing:0}
.lv-seccion .lv-grupo{margin-left:10px}
.lv-g-por_cotizar{--g:#b45309;--gt:#fffbeb}.lv-g-por_confirmar{--g:#1d4ed8;--gt:#eff6ff}
.lv-g-listos{--g:#15803d;--gt:#f0fdf4}.lv-g-por_forma_pago{--g:#6d28d9;--gt:#f5f3ff}
.lv-g-pendiente_guia{--g:#c2410c;--gt:#fff7ed}.lv-g-facturadas{--g:#475569;--gt:#f1f5f9}
.lv-doc-h{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.lv-card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.lv-card-h h4{min-width:0}
.lv-docno{flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:700;color:var(--g,#153375);background:var(--gt,#eef2ff);border:1px solid var(--g,#153375);border-radius:6px;padding:1px 8px;white-space:nowrap}
.lv-pie{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;padding-top:8px;border-top:1px solid #f1f5f9}
.lv-flujo,.lv-herr{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.lv-listo{font-size:12px;font-weight:700;color:#15803d}
.lv-mas{position:relative}
.lv-mas-menu{position:absolute;bottom:110%;right:0;background:#fff;border:1px solid #d1d8dd;box-shadow:0 10px 15px -3px rgba(0,0,0,.15);border-radius:8px;padding:6px;min-width:200px;z-index:1001;display:none}
.lv-mas.on .lv-mas-menu{display:block}
.lv-mas-menu button{display:block;width:100%;text-align:left;border:0;background:none;padding:7px 10px;border-radius:6px;font-size:13px;color:#1f2937;cursor:pointer}
.lv-mas-menu button:hover{background:#f1f5f9}.lv-mas-menu button.dng{color:#b91c1c}
.lv-lineas{margin:6px 0;border-top:1px dashed #e5e7eb;border-bottom:1px dashed #e5e7eb;padding:4px 0}
.lv-linea{display:flex;gap:8px;align-items:center;font-size:12px;padding:2px 0}.lv-linea span:first-child{flex:1;font-weight:600}
.lv-ico{display:inline-flex;align-items:center;padding:0 8px}
.lv-consulta{border-color:#d97706;color:#92400e;background:#fffbeb}
.lv-cons{border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;margin-bottom:8px}.lv-cons.si{border-color:#fcd34d;background:#fffbeb}
.lv-drawer{position:fixed;top:0;right:0;bottom:0;width:min(560px,100vw);background:#fff;box-shadow:-8px 0 24px rgba(0,0,0,.18);z-index:1030;display:flex;flex-direction:column}
.lv-drawer-h{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #e5e7eb;color:#153375}
.lv-drawer iframe{flex:1;border:0;width:100%}
.lv-ok{color:#1f6f54;font-weight:800;font-size:15px}
.lv-wa{border-color:#25d366;color:#128c7e;display:inline-flex;align-items:center;padding:0 8px}.lv-wa:hover{background:#25d366;color:#fff}
.lv-guia{display:inline-flex;align-items:center;gap:5px;background:#fff;color:#334155;border-color:#94a3b8}
.lv-guia.on{background:#1e293b;color:#fff;border-color:#1e293b}
.lv-guia-ico{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:6px;border:1px solid #cbd5e1;background:#fff;color:#94a3b8}
.lv-guia-ico.on{background:#1e293b;border-color:#1e293b;color:#fff}
.lv-user{position:relative;display:flex;align-items:center}
.lv-user-btn{padding:6px 10px;border-radius:20px;background:#f1f5f9;border:1px solid #cbd5e1;display:flex;align-items:center;cursor:pointer}
.lv-user-btn:hover{background:#e2e8f0}
.lv-user-menu{position:absolute;top:120%;right:0;background:#fff;border:1px solid #d1d8dd;box-shadow:0 10px 15px -3px rgba(0,0,0,.1);border-radius:10px;padding:14px;min-width:220px;max-width:90vw;z-index:1001}
.lv-user-menu .lv-btn{width:100%;margin-bottom:8px}.lv-user-menu .lv-btn:last-child{margin-bottom:0}
.lv-user-lbl{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6c757d;margin-bottom:4px}
.lv-user-name{font-size:14px;font-weight:700;color:#0f172a}
.lv-user-mail{font-size:12px;color:#6c757d;margin-bottom:14px;word-break:break-all}
@media(max-width:700px){.lv{padding:8px 6px}.lv-top h2{font-size:17px}}
`;

const LV_ESTADOS = ["Por revisar", "Mío", "En espera", "Confirmado", "Pagado", "Contra entrega", "Facturado", "Cancelado"];
const LV_POLL_MS = 15000;
const LV_MOTIVOS = ["Error del cliente", "No hay producto", "Mala digitación", "Traducción incorrecta", "Cliente canceló", "Cliente no confirmó"];
const LV_ICO_OJO = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const LV_ICO_USER = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
const LV_ICO_WA = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2zm0 18.15c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.19 8.19 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.24-8.24 4.54 0 8.23 3.7 8.23 8.24 0 4.54-3.69 8.24-8.22 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.12-.17.25-.64.81-.78.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.14.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.1-.22-.16-.47-.28z"/></svg>`;
const LV_ICO_TRUCK = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>`;

function _lv_esc(s) { return frappe.utils.escape_html(s == null ? "" : String(s)); }
function _lv_q(v) { return "Q " + (parseFloat(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function _lv_n(v) { return (parseFloat(v) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 }); }
function _lv_fecha(d) { if (!d) return ""; const p = String(d).slice(0, 10).split("-"); return `${p[2]}/${p[1]}/${p[0]}`; }
function _lv_hora(d) { return d ? String(d).slice(11, 19) : ""; }
function _lv_badge(e) { return `<span class="lv-badge lv-e-${_lv_esc(String(e || "").split(" ")[0])}">${_lv_esc(e)}</span>`; }
function _lv_norm(s) { return String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
// Alias que se sugiere a partir del nombre del ítem: sus primeras palabras
// con sentido (sin «conjunto», «niña», tallas, números…). Se puede editar.
const LV_RUIDO = new Set(("conjunto conjuntos set juego pijama pijamas ropa nino nina ninos ninas bebe bebes para de del la el los las " +
	"y con sin talla tallas unisex infantil dama caballero pieza piezas pcs pz").split(" "));
function _lv_alias_sugerido(nombre, usados) {
	const palabras = _lv_norm(nombre).split(" ").filter((w) => w.length > 1 && !LV_RUIDO.has(w) && !/^\d+$/.test(w) && !/^t\d+$/.test(w));
	const base = palabras.slice(0, 2).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Personaje";
	let alias = base, n = 2;
	while (usados && usados.has(_lv_norm(alias))) alias = `${base} ${n++}`;
	return alias;
}
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
		// Al volver a esta pestaña (p. ej. después de editar la cotización en
		// FacEx clásico) se refresca la sesión.
		document.addEventListener("visibilitychange", () => {
			if (!document.hidden && this.data && frappe.get_route()[0] === "facex-live" && frappe.get_route()[1]) this.load_sesion(this.data.sesion.name, true);
		});
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
			<div style="display:flex;gap:8px;align-items:center">${right || ""}
				<div class="lv-user" id="lv-user">
					<button class="lv-user-btn" data-act="usuario" title="${__("Perfil de Usuario")}">${LV_ICO_USER}</button>
					<div class="lv-user-menu" style="display:none">
						<div class="lv-user-lbl">${__("Usuario Conectado")}</div>
						<div class="lv-user-name">${_lv_esc(frappe.session.user_fullname || "Usuario")}</div>
						<div class="lv-user-mail">${_lv_esc(frappe.session.user)}</div>
						<button class="lv-btn" data-act="u-recargar" title="${__("Limpia la caché y recarga con la última versión")}">${__("Recargar")}</button>
						${this.ctx.permisos.puede_cambiar_password === 0 ? "" : `<button class="lv-btn" data-act="u-password">${__("Cambiar Contraseña")}</button>`}
						<button class="lv-btn dng" data-act="u-salir">${__("Cerrar Sesión")}</button>
					</div></div></div></div>`;
	}

	bind_back(to_lista) {
		this.$el.find("[data-act=volver]").on("click", () => {
			if (to_lista) this.salir_de_sesion(() => this.go()); else window.location.href = "/app/facex";
		});
		const $menu = this.$el.find(".lv-user-menu");
		this.$el.find("[data-act=usuario]").on("click", (e) => { e.stopPropagation(); $menu.fadeToggle(150); });
		$(document).off(".lvUserMenu").on("click.lvUserMenu", (e) => {
			if (!$(e.target).closest("#lv-user").length) $menu.fadeOut(150);
		});
		this.$el.find("[data-act=u-recargar]").on("click", () => facex_multi.reload_app(false));
		this.$el.find("[data-act=u-salir]").on("click", () => frappe.app.logout());
		this.$el.find("[data-act=u-password]").on("click", () => { $menu.fadeOut(150); this.cambiar_password(); });
	}

	cambiar_password() {
		const dlg = new frappe.ui.Dialog({
			title: __("Cambiar Contraseña"),
			fields: [
				{ fieldtype: "Password", fieldname: "old_password", label: __("Contraseña Actual"), reqd: 1 },
				{ fieldtype: "Password", fieldname: "new_password", label: __("Nueva Contraseña"), reqd: 1 },
				{ fieldtype: "Password", fieldname: "confirm_password", label: __("Confirmar Nueva Contraseña"), reqd: 1 },
			],
			primary_action_label: __("Actualizar Contraseña"),
			primary_action: (v) => {
				if (v.new_password !== v.confirm_password) {
					return frappe.msgprint({ title: __("Error de Validación"), message: __("La nueva contraseña y la confirmación no coinciden."), indicator: "red" });
				}
				frappe.call({
					method: "frappe.core.doctype.user.user.update_password",
					args: { old_password: v.old_password, new_password: v.new_password, logout_all_sessions: 0 },
					callback: (r) => { if (!r.exc) { frappe.show_alert({ message: __("Contraseña actualizada exitosamente."), indicator: "green" }); dlg.hide(); } },
				});
			},
		});
		dlg.show();
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
				<button class="lv-tab" data-t="clientes">Cotizar y Facturar</button>
				<button class="lv-tab" data-t="sesion">Sesión y personajes</button>
			</div><div id="lv-body"></div>`);
		this.bind_back(true);
		this.$el.find(".lv-tab").removeClass("on").filter(`[data-t=${this.tab}]`).addClass("on");
		this.$el.find(".lv-tab").on("click", (e) => {
			const t = $(e.currentTarget).data("t");
			if (t !== this.tab) this.salir_de_sesion(() => this.go(s.name, t));
		});
		const $b = this.$el.find("#lv-body");
		if (this.tab === "sesion") this.show_sesion_form(this.data, $b);
		else if (this.tab === "clientes") this.show_documentos($b);
		else this.show_bandeja($b);
		if (this.tab !== "sesion") this.start_poll();
	}

	show_sesion_form(data, $body) {
		const c = this.ctx;
		const puede = !!c.permisos.live_sesiones;
		const s = data ? data.sesion : {
			titulo: "", fecha: frappe.datetime.get_today(), estado: "Abierta",
			vendedor: c.defaults.vendedor, bodega: c.defaults.bodega, lista_precios: c.defaults.lista_precios, incluir_flete: 1,
			linea_whatsapp: c.defaults.linea_whatsapp, bfel_status: c.defaults.bfel_status,
		};
		// Un personaje = una prenda: el ítem va en el mismo personaje y se
		// separa en `prendas` solo al guardar. `info` (nombre, foto, stock en la
		// bodega, precio) vive solo en memoria y se recalcula al cambiar la
		// bodega o la lista.
		const prenda_de = (alias) => (data ? data.prendas : []).find((r) => _lv_norm(r.alias) === _lv_norm(alias)) || {};
		this.form = {
			personajes: data ? data.personajes.map((p) => ({
				alias: p.alias, unidades: p.unidades, foto: p.foto, notas: p.notas, item_code: prenda_de(p.alias).item_code || "",
			})) : [],
			info: {},
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
				<div class="lv-f" style="flex:0 1 170px"><label>Estado FEL</label>
					<select id="lv-fel" title="${__("Con el que se arman las cotizaciones. Viene de su usuario en FacEx Settings.")}">
						<option value="00 No enviar">00 No enviar</option><option value="01 Enviar">01 Enviar</option></select></div>
				<div class="lv-f" style="flex:0 1 200px"><label>Flete</label>
					<label style="text-transform:none;font-weight:600;display:flex;gap:6px;align-items:center;height:34px">
					<input type="checkbox" id="lv-flete" style="width:auto;height:auto" ${s.incluir_flete ? "checked" : ""} ${flete_bloq ? "disabled" : ""}>
					Incluir flete ${c.flete.item ? `<span class="lv-muted">(${_lv_q(c.flete.rate)})</span>` : `<span class="lv-err">sin ítem de flete</span>`}</label></div>
			</div></div>
			<div class="lv-card">
				<div class="lv-top" style="margin-bottom:6px"><b style="color:#153375;font-size:14px">Personajes (cada uno es una prenda)</b>
					${puede ? `<button class="lv-btn sm" data-act="add-per">+ Personaje sin escanear</button>` : ""}</div>
				${puede ? `<div class="lv-scan">
					<input id="lv-scan" placeholder="${__("Escanee el QR o código de barras de la prenda (o escriba el código y Enter)")}" autocomplete="off">
					<button class="lv-btn" data-act="camara" title="${__("Escanear con la cámara")}">📷</button></div>` : ""}
				<div class="lv-muted" style="margin-bottom:8px">${__("El que dice «mío» se lleva la prenda del personaje. «Cantidad» = cuánto se ofrece en el live, en la unidad de la prenda; los siguientes quedan en espera.")}</div>
				<div class="lv-pers" id="lv-pers"></div>
			</div>
			${puede ? `<div style="display:flex;gap:8px;justify-content:flex-end"><button class="lv-btn pri" data-act="guardar">Guardar sesión</button></div>` : ""}`);
		$body.find("#lv-estado").val(s.estado || "Abierta");
		$body.find("#lv-fel").val(s.bfel_status || c.defaults.bfel_status || "01 Enviar");

		const mk = (id, df, val) => {
			const ctl = frappe.ui.form.make_control({ df, parent: $body.find(id), render_input: true });
			ctl.set_value(val || "");
			return ctl;
		};
		const lista_filters = c.listas_permitidas ? { name: ["in", c.listas_permitidas] } : { selling: 1 };
		const bodega_filters = c.bodegas_permitidas ? { name: ["in", c.bodegas_permitidas] } : { company: c.company, is_group: 0 };
		this.ctl = {
			vendedor: mk("#lv-c-vendedor", { fieldtype: "Link", options: "Sales Partner", fieldname: "vendedor", read_only: c.defaults.vendedor_fijo ? 1 : 0 }, s.vendedor),
			bodega: mk("#lv-c-bodega", {
				fieldtype: "Link", options: "Warehouse", fieldname: "bodega", get_query: () => ({ filters: bodega_filters }),
				change: () => this.refresh_info(),
			}, s.bodega),
			lista: mk("#lv-c-lista", {
				fieldtype: "Link", options: "Price List", fieldname: "lista", get_query: () => ({ filters: lista_filters }),
				change: () => this.refresh_info(),
			}, s.lista_precios),
		};
		this.$pers = $body.find("#lv-pers");
		this.draw_personajes(puede);
		this.refresh_info();
		$body.find("[data-act=add-per]").on("click", () => {
			this.form.personajes.push({ alias: "", unidades: 1, foto: "", notas: "", item_code: "" });
			this.draw_personajes(true);
			this.$pers.find(".lv-per").last().find("input").first().focus();
		});
		const $scan = $body.find("#lv-scan");
		$scan.on("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const txt = $scan.val().trim();
			$scan.val("");
			if (txt) this.agregar_escaneado(txt, puede);
		});
		$body.find("[data-act=camara]").on("click", () => {
			new frappe.ui.Scanner({ dialog: true, multiple: false, on_scan: (r) => this.agregar_escaneado((r && r.decodedText) || "", puede) });
		});
		$body.find("[data-act=guardar]").on("click", () => this.guardar_sesion(data ? s.name : null));
		if (!puede) $body.find("input,select").prop("disabled", true);
		else setTimeout(() => $scan.focus(), 200);
		// Foto de cómo quedó al abrir, para saber si hay cambios al salir
		// (después de que los controles Link terminan de poner su valor).
		this._snap_sesion = null;
		if (data && puede) setTimeout(() => { this._snap_sesion = JSON.stringify(this.datos_sesion(s.name)); }, 500);
	}

	// Código escaneado → personaje nuevo con esa prenda, alias sugerido y,
	// como cantidad, el stock que hay en la bodega.
	agregar_escaneado(txt, puede) {
		txt = String(txt || "").trim();
		if (!txt) return;
		frappe.call({
			method: "facex_multi.api.live.item_escaneado",
			args: { txt, bodega: this.ctl.bodega.get_value(), price_list: this.ctl.lista.get_value() },
			callback: (r) => {
				const it = r.message;
				const f = this.form;
				f.info[it.item_code] = it;
				const ya = f.personajes.findIndex((p) => p.item_code === it.item_code);
				if (ya >= 0) {
					frappe.show_alert({ message: __("{0} ya está como «{1}».", [it.item_code, f.personajes[ya].alias || "sin alias"]), indicator: "orange" });
					this.$pers.find(".lv-per").eq(ya).addClass("lv-flash")[0].scrollIntoView({ block: "nearest" });
					return;
				}
				const usados = new Set(f.personajes.map((p) => _lv_norm(p.alias)));
				f.personajes.push({
					alias: _lv_alias_sugerido(it.item_name, usados), item_code: it.item_code, foto: "", notas: "",
					unidades: it.stock > 0 ? it.stock : 0,
				});
				this.draw_personajes(puede);
				frappe.show_alert({ message: __("{0} agregado", [it.item_name]), indicator: "green" });
				this.$el.find("#lv-scan").focus();
			},
		});
	}

	draw_personajes(puede) {
		const f = this.form;
		this.$pers.empty();
		if (!f.personajes.length) this.$pers.html(`<div class="lv-muted">${__("Escanee la primera prenda.")}</div>`);
		f.personajes.forEach((p, i) => {
			const inf = f.info[p.item_code] || {};
			// Foto propia del personaje (se guarda) o, de referencia, la principal del ítem (no se guarda).
			const foto = p.foto || inf.image || "";
			const $p = $(`<div class="lv-per">
				<div class="lv-per-h">
					${foto ? `<img class="lv-foto" src="${_lv_esc(foto)}" data-act="foto" title="${p.foto ? __("Cambiar foto") : __("Foto del producto (referencia). Clic para subir otra.")}">`
						: `<div class="lv-foto" data-act="foto">+ Foto</div>`}
					<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px">
						${p.item_code ? `<div class="lv-per-item"><b>${_lv_esc(p.item_code)}</b>
								<span title="${_lv_esc(inf.item_name || "")}">${_lv_esc(inf.item_name || "")}</span>
								${puede ? `<button class="lv-x" data-act="quitar-item" title="${__("Cambiar prenda")}">⟲</button>` : ""}</div>`
							: `<div class="lv-item"></div>`}
						<input class="lv-alias" placeholder="Alias / personaje" value="${_lv_esc(p.alias)}" title="${__("Lo que el cliente escribe después de «mío»")}">
						<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
							<span class="lv-muted">Cantidad</span> <input class="lv-unid" type="number" min="0" step="any" style="width:70px" value="${p.unidades || 0}"> <span class="lv-muted">${_lv_esc(inf.uom || "")}</span>
							<span class="lv-stock"></span>
							<span style="margin-left:auto;font-weight:700;color:#153375" class="lv-precio"></span>
						</div>
					</div>
					${puede ? `<button class="lv-x" data-act="del-per" title="Quitar personaje">×</button>` : ""}
				</div>
				<input type="file" accept="image/*" style="display:none" class="lv-foto-in">
			</div>`);
			$p.find(".lv-alias").on("input", (e) => { p.alias = $(e.target).val(); });
			$p.find(".lv-unid").on("input change", (e) => { p.unidades = parseFloat($(e.target).val()) || 0; this.paint_info(); });
			$p.find("[data-act=del-per]").on("click", () => { f.personajes.splice(i, 1); this.draw_personajes(puede); });
			$p.find("[data-act=quitar-item]").on("click", () => { p.item_code = ""; this.draw_personajes(puede); });
			$p.find("[data-act=foto]").on("click", () => puede && $p.find(".lv-foto-in").click());
			$p.find(".lv-foto-in").on("change", async (e) => {
				const file = e.target.files[0];
				if (!file) return;
				p.foto = await this.upload_public(file);
				this.draw_personajes(puede);
			});
			if (!p.item_code) {
				const ctl = frappe.ui.form.make_control({
					df: {
						fieldtype: "Link", options: "Item", fieldname: `item_${i}`, placeholder: "Prenda",
						change: () => {
							const v = ctl.get_value();
							if (!v || v === p.item_code) return;
							if (f.personajes.some((x) => x !== p && x.item_code === v)) {
								frappe.show_alert({ message: __("Esa prenda ya está en otro personaje."), indicator: "orange" });
								return ctl.set_value("");
							}
							p.item_code = v;
							this.refresh_info(() => {
								const it = f.info[v] || {};
								if (!p.alias) p.alias = _lv_alias_sugerido(it.item_name, new Set(f.personajes.filter((x) => x !== p).map((x) => _lv_norm(x.alias))));
								this.draw_personajes(puede);
							});
						},
					},
					parent: $p.find(".lv-item"), render_input: true,
				});
			}
			this.$pers.append($p);
		});
		this.paint_info();
	}

	refresh_info(done) {
		const items = [...new Set(this.form.personajes.map((p) => p.item_code).filter(Boolean))];
		if (!items.length) { this.paint_info(); return done && done(); }
		frappe.call({
			method: "facex_multi.api.live.info_items",
			args: { items_json: JSON.stringify(items), bodega: this.ctl.bodega.get_value(), price_list: this.ctl.lista.get_value() },
			callback: (r) => {
				const antes = Object.keys(this.form.info).length;
				Object.assign(this.form.info, r.message || {});
				// La primera vez llegan nombre y foto: hay que redibujar.
				if (!antes || done) { if (done) done(); else this.draw_personajes(!!this.ctx.permisos.live_sesiones); }
				else this.paint_info();
			},
		});
	}

	paint_info() {
		const f = this.form;
		this.$pers.find(".lv-per").each((i, el) => {
			const p = f.personajes[i];
			if (!p) return;
			const inf = f.info[p.item_code];
			$(el).find(".lv-precio").text(inf && inf.precio ? _lv_q(inf.precio) : "");
			const $st = $(el).find(".lv-stock");
			if (!inf) return $st.empty();
			if (inf.stock == null) return $st.html(`<span class="lv-muted">${__("Elija la bodega para ver el stock")}</span>`);
			const falta = (p.unidades || 0) > inf.stock;
			$st.html(`<span class="lv-stock-n ${inf.stock <= 0 || falta ? "bajo" : ""}" title="${falta ? __("Ofrece más de lo que hay en la bodega") : __("Stock en la bodega de la sesión")}">
				${__("Stock")}: <b>${(+inf.stock).toLocaleString("en-US", { maximumFractionDigits: 2 })}</b> ${_lv_esc(inf.uom || "")}</span>`);
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

	datos_sesion(name) {
		const f = this.form;
		return {
			name, company: this.ctx.company,
			titulo: this.$el.find("#lv-titulo").val(), fecha: this.$el.find("#lv-fecha").val(),
			estado: this.$el.find("#lv-estado").val(), linea_whatsapp: this.$el.find("#lv-linea").val(),
			vendedor: this.ctl.vendedor.get_value(), bodega: this.ctl.bodega.get_value(), lista_precios: this.ctl.lista.get_value(),
			incluir_flete: this.$el.find("#lv-flete").is(":checked") ? 1 : 0,
			bfel_status: this.$el.find("#lv-fel").val(),
			personajes: f.personajes.map(({ alias, unidades, foto, notas }) => ({ alias, unidades, foto, notas })),
			prendas: f.personajes.filter((p) => p.item_code).map((p) => ({ alias: p.alias, item_code: p.item_code, qty: 1 })),
		};
	}

	// Al salir de «Sesión y personajes» (otra pestaña o «← Sesiones») con
	// cambios sin guardar, se guardan solos antes de cambiar. Si el guardado
	// falla (p. ej. un personaje sin prenda), se queda en la pestaña con el error.
	salir_de_sesion(ir) {
		const s = this.data && this.data.sesion;
		const en_form = this.tab === "sesion" && s && this._snap_sesion && this.$el.find("#lv-titulo").length;
		if (!en_form || JSON.stringify(this.datos_sesion(s.name)) === this._snap_sesion) return ir();
		frappe.call({
			method: "facex_multi.api.live.guardar_sesion", args: { data_json: JSON.stringify(this.datos_sesion(s.name)) },
			freeze: true, freeze_message: __("Guardando…"),
			callback: () => {
				this._snap_sesion = null;
				frappe.show_alert({ message: __("Personajes y configuración del live guardados automáticamente"), indicator: "green" });
				this.reload_ctx_sesiones();
				ir();
			},
		});
	}

	guardar_sesion(name) {
		const data = this.datos_sesion(name);
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
			const u = _lv_esc(p.uom || "");
			return `<span class="lv-chip ${disp <= 0 ? "agotado" : ""}" data-alias="${_lv_esc(p.alias)}" title="${_lv_q(p.precio)}${u ? " / " + u : ""}">
				<b>${_lv_esc(p.alias)}</b> · ${disp > 0 ? `${_lv_n(disp)} de ${_lv_n(p.unidades)} ${u}` : "agotado"}${p.en_espera ? ` · ${_lv_n(p.en_espera)} en espera` : ""}</span>`;
		}).join("");
		const por_revisar = d.pedidos.filter((p) => p.estado === "Por revisar").length;
		$b.html(`
			<div class="lv-chips">${chips || `<span class="lv-muted">${__("La sesión no tiene personajes.")}</span>`}</div>
			${abierta ? `<div class="lv-card"><div class="lv-row">
				<div class="lv-f" style="flex:0 1 150px"><label>Teléfono</label><input id="lv-tel" inputmode="tel" placeholder="5555 1234"></div>
				<div class="lv-f"><label>Nombre (WhatsApp)</label><input id="lv-nom" placeholder="Se busca por teléfono"></div>
				<div class="lv-f"><label>Personaje</label><select id="lv-alias"><option value=""></option>
					${d.personajes.map((p) => `<option>${_lv_esc(p.alias)}</option>`).join("")}</select></div>
				<div class="lv-f" style="flex:0 1 80px"><label>Cantidad</label><input id="lv-cant" type="number" min="1" value="1"></div>
				<div class="lv-f" style="flex:0 1 140px"><label>Unidad</label><select id="lv-uom"></select></div>
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
				<th>Llegada</th><th>Captura</th><th>Cliente</th><th>Personaje</th><th class="n">Cantidad</th><th>Estado</th>
				<th class="c">Cotizado</th><th class="c">Facturado</th><th class="c">Guía</th><th>Acciones</th>
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
		const pintar_uoms = () => {
			const per = d.personajes.find((x) => x.alias === $b.find("#lv-alias").val());
			$b.find("#lv-uom").html(((per && per.uoms) || []).map((u) => `<option>${_lv_esc(u.uom)}</option>`).join(""));
		};
		$b.find("#lv-alias").on("change", pintar_uoms);
		$b.find(".lv-chip").on("click", (e) => { $b.find("#lv-alias").val($(e.currentTarget).data("alias")); pintar_uoms(); });
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
			alias: $b.find("#lv-alias").val(), cantidad: $b.find("#lv-cant").val() || 1, uom: $b.find("#lv-uom").val() || "",
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
					this._flash = m.name;
					this.load_sesion(this.data.sesion.name);
				};
				if (!captura) return fin();
				frappe.call({ method: "facex_multi.api.live.subir_captura", args: { name: m.name, filedata: captura }, callback: fin, error: fin });
			},
		});
	}

	draw_pedidos($tb) {
		const d = this.data;
		if (!d.pedidos.length) return $tb.html(`<tr><td colspan="10" class="lv-muted">${__("Todavía no llega ningún «mío».")}</td></tr>`);
		$tb.html(d.pedidos.map((p) => {
			const acts = [];
			const e = p.estado;
			// Confirmar y cobrar se hacen por documento en «Cotizar y Facturar».
			if (e === "Por revisar") acts.push(["revisar", "Revisar", "pri"]);
			if (e !== "Facturado" && e !== "Cancelado") acts.push(["editar", "Editar", ""], ["Cancelado", "Cancelar", "dng"]);
			return `<tr data-n="${_lv_esc(p.name)}" class="${this._flash === p.name ? "lv-flash-row" : ""}">
				<td>${_lv_hora(p.llegada)}<div class="lv-muted">${p.origen === "Bot WhatsApp" ? "bot" : "manual"}</div></td>
				<td>${p.captura ? `<img class="lv-thumb" src="${_lv_captura_url(p.name)}" data-act="ver">` : ""}</td>
				<td><b>${_lv_esc(p.cliente_nombre || p.nombre_wa || "—")}</b><div class="lv-muted">${_lv_esc(p.telefono || "")}</div>
					${p.consulta ? `<span class="lv-badge lv-e-Por" title="${__("El cliente escribió algo más: léalo antes de confirmar.")}">${__("Consulta")}</span>` : ""}
					${p.mensaje ? `<div class="lv-muted" style="max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${_lv_esc(p.mensaje)}">“${_lv_esc(p.mensaje.replace(/\n/g, " · "))}”</div>` : ""}</td>
				<td>${_lv_esc(p.alias || "—")}</td><td class="n">${p.cantidad || 1} <span class="lv-muted">${_lv_esc(p.uom || "")}</span></td>
				<td>${_lv_badge(e)}${e === "Cancelado" && p.motivo_cancelacion ? `<div class="lv-muted">${_lv_esc(p.motivo_cancelacion)}</div>` : ""}${p.metodo_pago ? `<div class="lv-muted">${_lv_esc(p.metodo_pago)} ${_lv_esc(p.referencia_pago || "")}</div>` : ""}</td>
				<td class="c">${p.cotizacion ? `<span class="lv-ok" title="${_lv_esc(p.cotizacion)}">✓</span>` : `<span class="lv-muted">—</span>`}</td>
				<td class="c">${p.facturada ? `<span class="lv-ok" title="${_lv_esc(p.cotizacion || "")}">✓</span>` : `<span class="lv-muted">—</span>`}</td>
				<td class="c"><span class="lv-guia-ico ${p.numero_guia ? "on" : ""}" title="${p.numero_guia ? _lv_esc(__("Guía {0}", [p.numero_guia])) : __("Sin guía")}">${LV_ICO_TRUCK}</span></td>
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
			if (act === "Cancelado") {
				return this.pedir_motivo(__("Cancelar el pedido de {0}", [p.cliente_nombre || p.telefono || p.name]),
					__("Si estaba apartado, sube el siguiente en espera."),
					(motivo) => this.actualizar(p.name, { estado: "Cancelado", motivo_cancelacion: motivo }));
			}
		});
		// La fila recién modificada titila 3 segundos.
		if (this._flash) setTimeout(() => { $tb.find(".lv-flash-row").removeClass("lv-flash-row"); this._flash = null; }, 3000);
	}

	actualizar(name, data) {
		frappe.call({
			method: "facex_multi.api.live.actualizar_pedido", args: { name, data_json: JSON.stringify(data) }, freeze: true,
			callback: (r) => {
				this._flash = name;
				if (r.message && r.message.aviso) frappe.show_alert({ message: r.message.aviso, indicator: "orange" });
				this.load_sesion(this.data.sesion.name);
			},
		});
	}

	// Motivo de cancelación con un botón por motivo (solo del live).
	pedir_motivo(titulo, nota, cb) {
		const dlg = new frappe.ui.Dialog({ title: titulo });
		dlg.$body.html(`${nota ? `<div class="lv-muted" style="margin-bottom:10px">${_lv_esc(nota)}</div>` : ""}
			<div class="lv-motivos">${LV_MOTIVOS.map((m) => `<button class="lv-btn dng" data-m="${_lv_esc(m)}">${_lv_esc(m)}</button>`).join("")}</div>`);
		dlg.$body.find("[data-m]").on("click", (e) => { dlg.hide(); cb($(e.currentTarget).data("m")); });
		dlg.show();
	}

	editar_pedido(p) {
		const d = this.data;
		const dlg = new frappe.ui.Dialog({
			title: __("Pedido {0}", [p.name]),
			fields: [
				{ fieldname: "mensaje", fieldtype: "HTML", options: p.mensaje ? `<div class="lv-muted" style="margin-bottom:8px;white-space:pre-line">${p.consulta ? `<b>${__("Tiene consultas:")}</b>\n` : ""}“${_lv_esc(p.mensaje)}”</div>` : "" },
				{ fieldname: "telefono", label: __("Teléfono"), fieldtype: "Data", default: p.telefono },
				{ fieldname: "cliente", label: __("Cliente"), fieldtype: "Link", options: "Customer", default: p.cliente },
				{ fieldname: "cb", fieldtype: "Column Break" },
				{ fieldname: "alias", label: __("Personaje"), fieldtype: "Select", options: ["", ...d.personajes.map((x) => x.alias)].join("\n"), default: p.alias,
					change: () => {
						const per = d.personajes.find((x) => x.alias === dlg.get_value("alias"));
						const uoms = ((per && per.uoms) || []).map((u) => u.uom);
						dlg.set_df_property("uom", "options", uoms.join("\n"));
						if (!uoms.includes(dlg.get_value("uom"))) dlg.set_value("uom", uoms[0] || "");
					} },
				{ fieldname: "cantidad", label: __("Cantidad"), fieldtype: "Int", default: p.cantidad || 1 },
				{ fieldname: "uom", label: __("Unidad"), fieldtype: "Select", options: (((d.personajes.find((x) => x.alias === p.alias) || {}).uoms) || []).map((u) => u.uom).join("\n"), default: p.uom },
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

	// ───────────────────────── cotizar y facturar ─────────────────────────
	// Una tarjeta por documento de venta (y una por cliente con lo que aún no
	// está en ninguno), agrupadas por etapa. Confirmar, cobro, guía y
	// cancelación se hacen por documento.
	show_documentos($b) {
		const d = this.data;
		const p = this.ctx.permisos;
		const docs = d.documentos || [];
		const listos = docs.filter((x) => x.grupo === "listos");
		// Como en FacEx: la cotización solo se confirma; la forma de pago se
		// indica ya en la factura. Cada subgrupo tiene un solo paso siguiente.
		const secciones = [
			["Cotizaciones", [
				["por_cotizar", "Pendiente de cotizar", "Pedidos apartados que todavía no están en un documento."],
				["por_confirmar", "Cotizaciones por confirmar", "El cliente aún no confirma por WhatsApp."],
			]],
			["Facturación", [
				["listos", "Listos para facturar", "Confirmadas: entran en «Facturar listos»."],
				["por_forma_pago", "Facturas por indicar forma de pago", "Pagado o Contra entrega."],
				["pendiente_guia", "Pendientes de guía", "Contra entrega sin número de guía."],
				["facturadas", "Facturadas", "Ciclo completo finalizado."],
			]],
		];
		const plegados = this._plegados();
		$b.html(`
			<div class="lv-top"><div class="lv-muted">${__("{0} documento(s) · {1} listo(s) para facturar", [docs.filter((x) => x.cotizacion).length, listos.length])}</div>
				${p.live_facturar ? `<button class="lv-btn ok" data-act="facturar" ${listos.length ? "" : "disabled"}>Facturar listos (${listos.length})</button>` : ""}</div>
			${secciones.map(([seccion, grupos]) => {
				const html = grupos.map(([g, titulo, nota]) => {
					const del_grupo = docs.filter((x) => x.grupo === g);
					if (!del_grupo.length) return "";
					return `<div class="lv-grupo lv-g-${g} ${plegados.includes(g) ? "plegado" : ""}" data-g="${g}">
						<div class="lv-grupo-h"><b>${titulo}</b> <span class="lv-n">${del_grupo.length}</span>
						${nota ? `<span class="lv-muted">${nota}</span>` : ""}<span class="lv-caret">▾</span></div>
						<div class="lv-cli">${del_grupo.map((x) => this.tarjeta_documento(x, g)).join("")}</div></div>`;
				}).join("");
				const n = docs.filter((x) => grupos.some(([g]) => g === x.grupo)).length;
				return html ? `<div class="lv-seccion"><div class="lv-seccion-h">${seccion} <span>${n}</span></div>${html}</div>` : "";
			}).join("") || `<div class="lv-muted">${__("Todavía no hay pedidos apartados.")}</div>`}`);

		$b.find(".lv-grupo-h").on("click", (e) => {
			const $g = $(e.currentTarget).closest(".lv-grupo").toggleClass("plegado");
			this._plegados($g.data("g"), $g.hasClass("plegado"));
		});
		$b.find("[data-act=mas]").on("click", (e) => {
			e.stopPropagation();
			const $m = $(e.currentTarget).closest(".lv-mas");
			const abrir = !$m.hasClass("on");
			$b.find(".lv-mas.on").removeClass("on");
			$m.toggleClass("on", abrir);
			if (abrir) $(document).one("click", () => $m.removeClass("on"));
		});
		$b.find("button[data-act]").on("click", (e) => {
			const act = $(e.currentTarget).data("act");
			if (act === "mas") return;
			$b.find(".lv-mas.on").removeClass("on");
			const x = docs.find((y) => y.key === $(e.currentTarget).closest("[data-k]").data("k"));
			if (act === "facturar") return this.facturar_listos(listos.length);
			if (act === "facturar-uno") return this.facturar_listos(1, x);
			if (act === "confirmar-facturar") return this.facturar_listos(1, x, true);
			if (act === "cot") return this.armar_cotizacion(x);
			if (act === "editar-cot") return this.editar_cotizacion(x.cotizacion);
			if (act === "wa") return facex_multi.wa.open(x.cotizacion, $(e.currentTarget).data("tipo"));
			if (act === "guia") return this.anotar_guia(x);
			if (act === "ver") return this.ver_documento(x);
			if (act === "consultas") return this.ver_consultas(x);
			if (act === "pagado") return this.marcar_pagado(x);
			if (act === "cancelar") {
				return this.pedir_motivo(__("Cancelar {0} de {1}", [x.cotizacion, x.nombre]),
					__("Se cancelan todos sus pedidos y se elimina la cotización en borrador."),
					(motivo) => this.accion_documento(x, "cancelar_documento", { motivo }));
			}
			if (["Confirmado", "Contra entrega"].includes(act)) return this.accion_documento(x, "estado_documento", { estado: act });
		});
		if (this._flash) setTimeout(() => { $b.find(".lv-flash-row").removeClass("lv-flash-row"); this._flash = null; }, 3000);
	}

	// Grupos plegados de «Cotizar y Facturar», recordados en este navegador.
	_plegados(g, plegar) {
		let l = [];
		try { l = JSON.parse(localStorage.getItem("lv_plegados") || "[]"); } catch (e) { /* sin storage */ }
		if (g === undefined) return l;
		l = l.filter((y) => y !== g);
		if (plegar) l.push(g);
		try { localStorage.setItem("lv_plegados", JSON.stringify(l)); } catch (e) { /* sin storage */ }
		return l;
	}

	// Tarjeta: a la izquierda el paso siguiente del grupo (flujo), a la
	// derecha las herramientas en íconos y lo poco frecuente en «⋯».
	tarjeta_documento(x, g) {
		const p = this.ctx.permisos;
		const wa = this.ctx.wa || {};
		const inf = x.info || {};
		const facturada = inf.docstatus === 1;
		const borrador = !!x.cotizacion && inf.docstatus === 0;
		const tipo_wa = facturada ? "factura" : "cotizacion";
		const e = x.estados;
		const lineas = x.lineas.map((l) => `<div class="lv-linea"><span>${_lv_esc(l.alias)}</span>
			<span>${l.cantidad} ${_lv_esc(l.uom || "")}</span>${_lv_badge(l.estado)}</div>`).join("");
		const doc = x.cotizacion
			? `<span class="lv-muted">${facturada ? (inf.bfel_uuid ? "certificada" : "validada") : "cotización"}</span> <b>${_lv_q(inf.grand_total)}</b>`
			: `<span class="lv-muted">${__("sin documento")}</span> <span class="lv-muted">aprox. ${_lv_q(x.subtotal)} + flete</span>`;
		const btn = (act, label, cls = "", title = "", extra = "") =>
			`<button class="lv-btn sm ${cls}" data-act="${act}" ${extra} ${title ? `title="${_lv_esc(title)}"` : ""}>${label}</button>`;
		const con_guia = x.cotizacion && (inf.bfel_pago_contra_entrega || x.numero_guia || e.includes("Contra entrega"));

		const flujo = [];
		if (g === "por_cotizar" && p.puede_guardar) flujo.push(btn("cot", "Cotizar", "pri", x.abiertas.length ? __("Ya tiene una cotización abierta: se le pregunta si sumar o crear otra") : ""));
		if (g === "por_confirmar") flujo.push(p.live_facturar
			? btn("confirmar-facturar", __("Confirmar y facturar"), "pri", __("Confirma la cotización y en seguida la valida y certifica en FEL"))
			: btn("Confirmado", "Confirmar", "pri"));
		if (g === "listos") flujo.push(p.live_facturar ? btn("facturar-uno", __("Facturar"), "ok", __("Valida y certifica en FEL solo esta cotización"))
			: `<span class="lv-listo">✓ ${__("Listo para facturar")}</span>`);
		if (g === "por_forma_pago") flujo.push(btn("pagado", "Pagado", "ok"), btn("Contra entrega", "Contra entrega", "", __("El transportista cobra al entregar")));
		if (g === "pendiente_guia") flujo.push(btn("guia", `${LV_ICO_TRUCK} ${__("Anotar guía")}`, "pri"));
		if (g === "facturadas") flujo.push(`<span class="lv-listo">✓ ${_lv_esc(x.metodo_pago || __("Completo"))}${x.numero_guia ? ` · ${__("guía")} ${_lv_esc(x.numero_guia)}` : ""}</span>`);

		const herr = [];
		if (x.consultas.length) herr.push(btn("consultas", `💬 ${x.consultas.length}`, x.tiene_consultas ? "lv-consulta" : "", x.tiene_consultas ? __("Tiene consultas") : __("Mensajes")));
		if (x.cotizacion) herr.push(btn("ver", LV_ICO_OJO, "lv-ico", __("Ver el documento")));
		if (x.cotizacion && wa[tipo_wa]) herr.push(btn("wa", LV_ICO_WA, "lv-wa", facturada ? __("Enviar la factura por WhatsApp") : __("Enviar la cotización por WhatsApp"), `data-tipo="${tipo_wa}"`));
		if (con_guia && g !== "pendiente_guia") herr.push(btn("guia", LV_ICO_TRUCK, `lv-guia ${x.numero_guia ? "on" : ""}`, x.numero_guia ? __("Guía {0}", [x.numero_guia]) : __("Anotar guía")));

		const mas = [];
		const item = (act, label, cls = "") => `<button class="${cls}" data-act="${act}">${label}</button>`;
		if (borrador && p.puede_guardar) mas.push(item("editar-cot", __("Actualizar cotización")));
		if (borrador) mas.push(item("cancelar", __("Cancelar…"), "dng"));
		if (mas.length) herr.push(`<span class="lv-mas">${btn("mas", "⋯", "", __("Más acciones"))}<div class="lv-mas-menu">${mas.join("")}</div></span>`);

		const flash = this._flash && (this._flash === x.key || this._flash === x.cotizacion);
		return `<div class="lv-card ${flash ? "lv-flash-row" : ""}" data-k="${_lv_esc(x.key)}">
			<div class="lv-card-h"><h4>${_lv_esc(x.nombre)}</h4>${x.cotizacion ? `<span class="lv-docno">${_lv_esc(x.cotizacion)}</span>` : ""}</div>
			<div class="lv-muted">${_lv_esc(x.telefono || "")}${x.metodo_pago ? ` · ${_lv_esc(x.metodo_pago)} ${_lv_esc(x.referencia_pago || "")}` : ""}</div>
			<div class="lv-lineas">${lineas}</div>
			<div class="lv-doc-h">${doc}</div>
			<div class="lv-pie"><div class="lv-flujo">${flujo.join("")}</div><div class="lv-herr">${herr.join("")}</div></div></div>`;
	}

	accion_documento(x, method, args) {
		frappe.call({
			method: `facex_multi.api.live.${method}`, args: { sesion: this.data.sesion.name, cotizacion: x.cotizacion, ...args },
			freeze: true,
			callback: (r) => {
				const m = r.message || {};
				if (m.aviso) frappe.show_alert({ message: m.aviso, indicator: "orange" });
				this._flash = x.key;
				this.load_sesion(this.data.sesion.name);
			},
		});
	}

	marcar_pagado(x) {
		const dlg = new frappe.ui.Dialog({
			title: __("Forma de pago · {0}", [x.cotizacion]),
			fields: [
				{ fieldname: "metodo_pago", label: __("Método"), fieldtype: "Select", options: "Transferencia\nDepósito\nEfectivo\nTarjeta de Crédito", default: x.metodo_pago || "Transferencia", reqd: 1 },
				{ fieldname: "referencia_pago", label: __("Referencia / boleta"), fieldtype: "Data", default: x.referencia_pago || "" },
			],
			primary_action_label: __("Marcar pagado"),
			primary_action: (v) => { dlg.hide(); this.accion_documento(x, "estado_documento", { ...v, estado: "Pagado" }); },
		});
		dlg.show();
	}

	// Cotizar lo pendiente; si el cliente ya tiene una cotización abierta, se
	// pregunta si sumarlo a ella o crear otra.
	armar_cotizacion(x) {
		const hacer = (destino) => frappe.call({
			method: "facex_multi.api.live.armar_cotizacion", args: { sesion: this.data.sesion.name, cliente: x.cliente, destino },
			freeze: true, freeze_message: __("Armando cotización…"),
			callback: (r) => {
				const m = r.message;
				frappe.show_alert({ message: `${m.invoice} · ${_lv_q(m.grand_total)}`, indicator: "green" });
				this._flash = m.invoice;
				this.load_sesion(this.data.sesion.name);
				if ((this.ctx.wa || {}).cotizacion) facex_multi.wa.open(m.invoice, "cotizacion");
			},
		});
		if (!x.abiertas.length) return hacer("nueva");
		const dlg = new frappe.ui.Dialog({ title: __("{0} ya tiene una cotización abierta", [x.nombre]) });
		dlg.$body.html(`<div class="lv-muted" style="margin-bottom:10px">${__("¿Sumar estos pedidos a un documento de venta abierto o crear uno nuevo?")}</div>
			<div class="lv-motivos">${x.abiertas.map((inv) => `<button class="lv-btn pri" data-d="${_lv_esc(inv)}">${__("Sumar a {0}", [_lv_esc(inv)])}</button>`).join("")}
			<button class="lv-btn" data-d="nueva">${__("Crear cotización nueva")}</button></div>`);
		dlg.$body.find("[data-d]").on("click", (e) => { dlg.hide(); hacer($(e.currentTarget).data("d")); });
		dlg.show();
	}

	// Vista rápida del documento en un panel a la derecha (formato de impresión).
	ver_documento(x) {
		frappe.call({
			method: "facex_multi.api.live.formato_vista", args: { sesion: this.data.sesion.name, cotizacion: x.cotizacion },
			callback: (r) => {
				const fmt = (r.message || {}).format;
				const url = `/printview?doctype=Sales+Invoice&name=${encodeURIComponent(x.cotizacion)}${fmt ? `&format=${encodeURIComponent(fmt)}` : ""}`;
				$(".lv-drawer").remove();
				const $d = $(`<div class="lv-drawer"><div class="lv-drawer-h"><b>${_lv_esc(x.cotizacion)} · ${_lv_esc(x.nombre)}</b>
					<button class="lv-x" data-act="cerrar" title="${__("Cerrar")}">×</button></div>
					<iframe src="${url}"></iframe></div>`).appendTo(this.$root);
				$d.find("[data-act=cerrar]").on("click", () => $d.remove());
			},
		});
	}

	// Lo que escribió el cliente en cada línea del documento, por hora.
	ver_consultas(x) {
		const dlg = new frappe.ui.Dialog({ title: x.tiene_consultas ? __("Tiene consultas · {0}", [x.nombre]) : __("Mensajes · {0}", [x.nombre]), size: "large" });
		dlg.$body.html(x.consultas.map((c) => `<div class="lv-cons ${c.consulta ? "si" : ""}">
			<div><b>${_lv_esc(c.alias || "—")}</b> <span class="lv-muted">${_lv_hora(c.llegada)} · ${_lv_esc(c.pedido)}</span>
				${c.consulta ? `<span class="lv-badge lv-e-Por">${__("Consulta")}</span>` : ""}</div>
			<div style="white-space:pre-line;margin-top:4px">${_lv_esc(c.mensaje)}</div></div>`).join(""));
		dlg.show();
	}

	// FacEx clásico en pestaña nueva, con la ruta para volver a esta sesión.
	editar_cotizacion(invoice) {
		const volver = `/app/facex-live/${encodeURIComponent(this.data.sesion.name)}/clientes`;
		window.open(`/app/facex?invoice=${encodeURIComponent(invoice)}&volver=${encodeURIComponent(volver)}`, "_blank");
	}

	anotar_guia(x) {
		const t = this.ctx.transportistas || [];
		const dlg = new frappe.ui.Dialog({
			title: __("Guía para {0} · {1}", [x.nombre, x.cotizacion]),
			fields: [
				{ fieldname: "numero_guia", label: __("Número de guía"), fieldtype: "Data", reqd: 1, default: x.numero_guia || "" },
				{ fieldname: "transportista", label: __("Transportista"), fieldtype: "Select", options: t.join("\n"), default: this.ctx.transportista_default || t[0] },
			],
			primary_action_label: x.numero_guia ? __("Cambiar") : __("Anotar"),
			primary_action: (v) => {
				dlg.hide();
				frappe.call({
					method: "facex_multi.api.live.anotar_guia",
					args: { sesion: this.data.sesion.name, cotizacion: x.cotizacion, numero_guia: v.numero_guia, transportista: v.transportista },
					freeze: true,
					callback: (r) => {
						frappe.show_alert({ message: __("Guía {0} anotada", [r.message.numero_guia]), indicator: "green" });
						this._flash = x.key;
						this.load_sesion(this.data.sesion.name);
					},
				});
			},
		});
		dlg.show();
		setTimeout(() => dlg.fields_dict.numero_guia.$input.focus(), 300);
	}

	facturar_listos(n, x, confirmar) {
		const pregunta = confirmar
			? __("Se confirma {0} de {1} y en seguida se valida y certifica en FEL. La forma de pago se indica después. ¿Continuar?", [x.cotizacion, _lv_esc(x.nombre)])
			: x
			? __("Se valida y certifica en FEL {0} de {1}. La forma de pago se indica después. ¿Continuar?", [x.cotizacion, _lv_esc(x.nombre)])
			: __("Se validan y certifican en FEL {0} factura(s). La forma de pago se indica después en cada factura. ¿Continuar?", [n]);
		const sesion = this.data.sesion.name;
		const facturar = () => frappe.call({
			method: "facex_multi.api.live.facturar_listos", args: { sesion, cotizacion: x ? x.cotizacion : null },
			freeze: true, freeze_message: __("Facturando…"),
			callback: (r) => {
				const res = (r.message || {}).resultados || [];
				if (x) this._flash = x.cotizacion;  // resalta la tarjeta en su nuevo grupo
				const r0 = res[0] || {};
				if (x && res.length === 1 && !r0.error && !r0.error_fel && !r0.error_pago) {
					frappe.show_alert({ message: __("{0} facturada{1}", [r0.invoice, r0.certificada ? " y certificada" : ""]), indicator: "green" });
				} else {
					const filas = res.map((y) => `<tr><td>${_lv_esc(y.nombre || y.cliente)}</td><td>${_lv_esc(y.invoice || "")}</td>
						<td>${y.error ? `<span class="lv-err">${_lv_esc(y.error)}</span>`
							: [y.certificada ? "✔ certificada" : "", y.error_fel ? `<span class="lv-err">FEL: ${_lv_esc(y.error_fel)}</span>` : "",
								y.error_pago ? `<span class="lv-err">Pago: ${_lv_esc(y.error_pago)}</span>` : (y.pago ? "✔ pago registrado" : "")].filter(Boolean).join("<br>")}</td></tr>`).join("");
					frappe.msgprint({
						title: __("Resultado de la facturación"), wide: true,
						message: `<table class="table table-bordered"><thead><tr><th>Cliente</th><th>Factura</th><th>Resultado</th></tr></thead><tbody>${filas}</tbody></table>`,
					});
				}
				this.load_sesion(sesion);
			},
		});
		frappe.confirm(pregunta, () => {
			if (!confirmar) return facturar();
			// Si confirmar falla, no se factura; si facturar falla, queda en «Listos para facturar».
			frappe.call({
				method: "facex_multi.api.live.estado_documento", args: { sesion, cotizacion: x.cotizacion, estado: "Confirmado" },
				freeze: true, freeze_message: __("Confirmando…"),
				callback: () => facturar(),
			});
		});
	}
}
