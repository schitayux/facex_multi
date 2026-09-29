// FacEx Multi — Módulo de Compras (ciclo de compra estilo SAP B1)
// Interfaz sobre los documentos nativos de ERPNext: Orden de Compra
// (Purchase Order) → Entrada de Mercadería (Purchase Receipt) → Factura de
// Compra (Purchase Invoice). Toda la lógica contable y de stock permanece en
// ERPNext core; el backend vive en facex_multi.api.compras (documentos.py
// maneja los tres documentos con los mismos endpoints, parametrizados por
// `kind`: oc / en / fc).
//
// Vistas internas (una sola a la vez, dentro de #cp-content-root):
//   hub        tarjetas de documentos según permisos
//   list       lista de un documento (arg: kind)
//   form       formulario (arg: {kind, name} o {kind, pending})
//   fc-staging previsualización de una factura cargada desde Excel
//
// Responsive: las tablas marcadas .cp-cards se muestran como tarjetas bajo
// 720px (cada <td> lleva data-label) y la barra de acciones queda fija abajo.

frappe.pages["facex-compras"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: "Compras — FacEx", single_column: true });
	// Mismo Modo Enfoque que FacEx / Inventario: quitar la clase apenas se
	// navega a otra pantalla del Desk.
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex-compras") $("body").removeClass("facex-fullscreen-mode");
	});
	wrapper.facexCompras = new FacexCompras(page, wrapper);
	wrapper.facexCompras.setup_back_guard();
};

frappe.pages["facex-compras"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	// on_page_load corre una vez por pestaña: rearmar el guard en cada entrada.
	if (wrapper.facexCompras) wrapper.facexCompras.setup_back_guard();
};

// Catálogo de Tipo FEL para compras (bfel_multi_tipo en Purchase Invoice /
// Purchase Invoice Item). Ver facex_multi.patches.v1_0.add_purchase_bfel_multi_tipo.
const CP_TIPO_FEL = [
	["B", "B - Bien"], ["S", "S - Servicio"], ["C", "C - Combustible"],
	["I", "I - Importación"], ["E", "E - Exportación"], ["P", "P - Pequeño Contribuyente"],
	["L", "L - Exención Local"], ["N", "N - No Aplica"], ["X", "X - Sin Asignación"],
];

// Documentos del ciclo de compra. perms = checks de FacEx Settings por acción.
const CP_KINDS = {
	oc: {
		doctype: "Purchase Order", route: "purchase-order", print_format: "FacEx Orden de Compra",
		one: "Orden de Compra", many: "Órdenes de Compra", short: "OC", param: "orden",
		desc: "Pedidos a proveedores. Desde una orden validada se generan la Entrada y la Factura.",
		perms: { draft: "oc_grabar_borrador", submit: "oc_validar", cancel: "oc_cancelar" },
		states: [["0", "Borrador"], ["To Receive and Bill", "Por recibir y facturar"], ["To Receive", "Por recibir"],
			["To Bill", "Por facturar"], ["Completed", "Completada"], ["Closed", "Cerrada"], ["2", "Cancelada"]],
	},
	en: {
		doctype: "Purchase Receipt", route: "purchase-receipt", print_format: "FacEx Entrada de Mercaderia",
		one: "Entrada de Mercadería", many: "Entradas de Mercadería", short: "Entrada", param: "entrada",
		desc: "Recepción de la mercadería en bodega (con o sin orden). Al validarla ingresa el inventario.",
		perms: { draft: "entrada_compra_grabar_borrador", submit: "entrada_compra_validar", cancel: "entrada_compra_cancelar" },
		states: [["0", "Borrador"], ["To Bill", "Por facturar"], ["Partly Billed", "Facturada parcialmente"],
			["Completed", "Completada"], ["2", "Cancelada"]],
	},
	dv: {
		doctype: "Purchase Receipt", route: "purchase-receipt", print_format: "FacEx Entrada de Mercaderia",
		one: "Devolución de Mercadería", many: "Devoluciones de Mercadería", short: "Devolución", param: "devolucion",
		ret: true, source_label: "Entrada",
		desc: "Mercadería devuelta al proveedor, siempre contra una Entrada validada. Al validarla sale del inventario.",
		perms: { draft: "devolucion_compra_grabar_borrador", submit: "devolucion_compra_validar", cancel: "devolucion_compra_cancelar" },
		states: [["0", "Borrador"], ["Return", "Validada (sin nota de crédito)"], ["Completed", "Con nota de crédito"], ["2", "Cancelada"]],
	},
	fc: {
		doctype: "Purchase Invoice", route: "purchase-invoice", print_format: "FacEx Factura de Compra",
		one: "Factura de Compra", many: "Facturas de Compra", short: "Factura", param: "factura",
		desc: "Facturas de proveedores: directas, desde una orden o desde una entrada. Registran la cuenta por pagar.",
		perms: { draft: "factura_compra_grabar_borrador", submit: "puede_validar_compras", cancel: "puede_cancelar_compras" },
		states: [["0", "Borrador"], ["Unpaid", "Pendiente de pago"], ["Overdue", "Vencida"],
			["Partly Paid", "Pago parcial"], ["Paid", "Pagada"], ["2", "Cancelada"]],
	},
	nc: {
		doctype: "Purchase Invoice", route: "purchase-invoice", print_format: "FacEx Factura de Compra",
		one: "Nota de Crédito de Proveedor", many: "Notas de Crédito de Proveedor", short: "NC", param: "nota",
		ret: true, source_label: "Factura / Devolución",
		desc: "Créditos del proveedor contra una Factura (rebaja su saldo) o contra una Devolución de mercadería.",
		perms: { draft: "nc_compra_grabar_borrador", submit: "nc_compra_validar", cancel: "nc_compra_cancelar" },
		states: [["0", "Borrador"], ["Return", "Validada"], ["2", "Cancelada"]],
	},
};
const CP_ORDER = ["oc", "en", "dv", "fc", "nc"];

// Status nativos → etiqueta + color.
const CP_STATUS = {
	"Draft": ["Borrador", "#b45309", "#fef3c7"],
	"To Receive and Bill": ["Por recibir y facturar", "#1d4ed8", "#dbeafe"],
	"To Receive": ["Por recibir", "#1d4ed8", "#dbeafe"],
	"To Bill": ["Por facturar", "#7c3aed", "#ede9fe"],
	"Partly Billed": ["Facturada parcialmente", "#7c3aed", "#ede9fe"],
	"Completed": ["Completada", "#047857", "#d1fae5"],
	"Closed": ["Cerrada", "#475569", "#e2e8f0"],
	"On Hold": ["En espera", "#b45309", "#fef3c7"],
	"Delivered": ["Entregada", "#047857", "#d1fae5"],
	"Return Issued": ["Con devolución", "#475569", "#e2e8f0"],
	"Unpaid": ["Pendiente de pago", "#1d4ed8", "#dbeafe"],
	"Overdue": ["Vencida", "#b91c1c", "#fee2e2"],
	"Partly Paid": ["Pago parcial", "#7c3aed", "#ede9fe"],
	"Paid": ["Pagada", "#047857", "#d1fae5"],
	"Return": ["Validada", "#047857", "#d1fae5"],
	"Debit Note Issued": ["Con nota de crédito", "#475569", "#e2e8f0"],
	"Submitted": ["Validada", "#047857", "#d1fae5"],
	"Cancelled": ["Cancelada", "#6b7280", "#f3f4f6"],
};

// Campos de enlace de cada línea con su documento de origen (se conservan
// al grabar: así ERPNext actualiza % recibido / % facturado del origen).
const CP_LINK_FIELDS = {
	oc: [],
	en: ["purchase_order", "purchase_order_item"],
	fc: ["purchase_order", "po_detail", "purchase_receipt", "pr_detail"],
	dv: [],
	nc: [],
};

function cpEsc(v) {
	return String(v == null ? "" : v)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cpFlt(v) {
	return parseFloat(v) || 0;
}

function cpMoney(n, currency) {
	const symbol = !currency || currency === "GTQ" ? "Q" : currency;
	return `${symbol} ${cpFlt(n).toLocaleString("es-GT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cpDate(d) {
	return d ? frappe.datetime.str_to_user(d) : "";
}

function cpPct(v) {
	return `${Math.round(cpFlt(v))}%`;
}

function cpStatusBadge(status, docstatus) {
	const key = status || (docstatus === 2 ? "Cancelled" : docstatus === 1 ? "Submitted" : "Draft");
	const [label, color, bg] = CP_STATUS[key] || [key, "#475569", "#e2e8f0"];
	return `<span class="cp-badge" style="color:${color};background:${bg};">${cpEsc(label)}</span>`;
}

function cpTipoOptions(selected) {
	return `<option value="">-</option>` + CP_TIPO_FEL.map(([v, l]) =>
		`<option value="${v}"${selected === v ? " selected" : ""}>${cpEsc(l)}</option>`).join("");
}

class FacexCompras {
	constructor(page, wrapper) {
		this.wrapper = wrapper;
		this.$root = $(page.body);
		this.defaults = null;
		this.view = null;
		this.kind = "fc";
		this.dirty = false;
		this._filters = {};
		this._render_frame();
		this.$body = this.$root.find("#cp-content-root");
		this._load_defaults();
	}

	// ──────────────────────────────────────────────
	// Navegación / botón Atrás
	// ──────────────────────────────────────────────

	setup_back_guard() {
		facex_multi.setup_back_guard({
			to: "/app/facex",
			is_dirty: () => this.dirty,
			on_back: () => this._internal_back(),
		});
	}

	// Atrás del navegador resuelto por dentro: formulario/staging → lista →
	// menú principal. Solo desde el menú principal se sale del page.
	_internal_back() {
		if (!this.view || this.view === "hub") return false;
		const go = () => (this.view === "list" ? this._go("hub") : this._go("list", this.kind));
		if (this.dirty) {
			frappe.confirm("Hay cambios sin guardar. ¿Desea salir de todos modos?", () => {
				this.dirty = false;
				go();
			});
			return true;
		}
		go();
		return true;
	}

	_go(view, arg) {
		this.view = view;
		this.dirty = false;
		this.$body.off();
		$(document).off(".cpView");
		window.scrollTo(0, 0);
		if (view === "hub") this._render_hub();
		else if (view === "list") this._render_list(arg);
		else if (view === "form") this._render_form(arg);
		else if (view === "fc-staging") this._render_fc_staging(arg);
	}

	// ──────────────────────────────────────────────
	// Marco: estilos + barra superior persistente
	// ──────────────────────────────────────────────

	_render_frame() {
		this.$root.html(`
<style>${CP_STYLES}</style>
<div class="cp-topbar">
	<button type="button" class="cp-logo" id="cp-logo" title="Menú de Compras">
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#153375" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
		FacEx <span class="cp-logo-sub">Compras</span>
	</button>
	<div class="cp-topbar-right">
		<div class="cp-topbar-links" id="cp-topbar-links"></div>
		<div class="cp-user">
			<button type="button" class="cp-user-btn" id="cp-user-btn" title="Perfil de Usuario">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
			</button>
			<div class="cp-user-menu" id="cp-user-menu">
				<div class="cp-menu-label">Usuario Conectado</div>
				<div class="cp-user-name">${cpEsc(frappe.session.user_fullname || "Usuario")}</div>
				<div class="cp-user-email">${cpEsc(frappe.session.user)}</div>
				<div class="cp-menu-links" id="cp-menu-links"></div>
				<div id="cp-company-section" style="display:none;">
					<div class="cp-menu-label">Cambiar Compañía</div>
					<select id="cp-company-select" class="cp-input" style="margin-bottom:8px;"></select>
					<button type="button" class="cp-btn cp-btn-secondary cp-block" id="cp-company-apply">Aplicar Compañía</button>
					<hr>
				</div>
				<button type="button" class="cp-btn cp-btn-secondary cp-block" id="cp-change-password">Cambiar Contraseña</button>
				<button type="button" class="cp-btn cp-btn-danger cp-block" id="cp-logout">Cerrar Sesión</button>
			</div>
		</div>
	</div>
</div>
<div id="cp-content-root"></div>`);

		this.$root.find("#cp-logo").on("click", () => {
			if (!this.defaults) return;
			if (this.dirty) {
				frappe.confirm("Hay cambios sin guardar. ¿Desea salir de todos modos?", () => this._go("hub"));
			} else {
				this._go("hub");
			}
		});

		const $menu = this.$root.find("#cp-user-menu");
		this.$root.find("#cp-user-btn").on("click", (e) => {
			e.stopPropagation();
			$menu.toggle();
		});
		$(document).off(".cpUserMenu").on("click.cpUserMenu", (e) => {
			if (!$(e.target).closest(".cp-user").length) $menu.hide();
		});
		this.$root.find("#cp-company-apply").on("click", () => {
			const company = this.$root.find("#cp-company-select").val();
			if (!company) return;
			frappe.call({
				method: "facex_multi.api.invoice.set_active_company",
				args: { company },
				freeze: true,
				freeze_message: `Cambiando a ${company}...`,
				callback: (r) => {
					if (!r.exc) window.location.reload();
				},
			});
		});
		this.$root.find("#cp-logout").on("click", () => frappe.app.logout());
		this.$root.find("#cp-change-password").on("click", () => {
			$menu.hide();
			this._change_password();
		});
	}

	_render_topbar_links() {
		const p = this.defaults.permissions || {};
		const links = [
			p.puede_facturar && ["Facturador", "/app/facex"],
			p.puede_ver_pos && ["POS", "/app/facex-screen"],
			p.puede_ver_menu_inventario && ["Inventario", "/app/facex-inventario"],
		].filter(Boolean);
		const html = links.map(([label, href]) =>
			`<a class="cp-topbar-link" href="${href}">${cpEsc(label)}</a>`).join("");
		this.$root.find("#cp-topbar-links").html(html);
		// En móvil los accesos viven dentro del menú de usuario.
		this.$root.find("#cp-menu-links").html(links.length
			? `<div class="cp-menu-label">Ir a</div>${html}<hr>` : "");

		const companies = this.defaults.companies || [];
		if (companies.length > 1) {
			this.$root.find("#cp-company-select").html(companies.map((c) =>
				`<option value="${cpEsc(c)}"${c === this.defaults.company ? " selected" : ""}>${cpEsc(c)}</option>`).join(""));
			this.$root.find("#cp-company-section").show();
		}
	}

	_change_password() {
		const dlg = new frappe.ui.Dialog({
			title: "Cambiar Contraseña",
			fields: [
				{ fieldtype: "Password", fieldname: "old_password", label: "Contraseña Actual", reqd: 1 },
				{ fieldtype: "Password", fieldname: "new_password", label: "Nueva Contraseña", reqd: 1 },
				{ fieldtype: "Password", fieldname: "confirm_password", label: "Confirmar Nueva Contraseña", reqd: 1 },
			],
			primary_action_label: "Actualizar Contraseña",
			primary_action: (v) => {
				if (v.new_password !== v.confirm_password) {
					frappe.msgprint({ title: "Error de Validación", message: "La nueva contraseña y la confirmación no coinciden.", indicator: "red" });
					return;
				}
				frappe.call({
					method: "frappe.core.doctype.user.user.update_password",
					args: { old_password: v.old_password, new_password: v.new_password, logout_all_sessions: 0 },
					callback: (r) => {
						if (!r.exc) {
							frappe.show_alert({ message: "Contraseña actualizada.", indicator: "green" });
							dlg.hide();
						}
					},
				});
			},
		});
		dlg.show();
	}

	// ──────────────────────────────────────────────
	// Arranque
	// ──────────────────────────────────────────────

	_load_defaults() {
		this.$body.html(`<div class="cp-empty">Cargando...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.common.get_compras_defaults",
			callback: (r) => {
				this.defaults = r.message || {};
				this._render_topbar_links();
				// Enlace directo: ?orden=… / ?entrada=… / ?factura=…
				const params = new URLSearchParams(window.location.search);
				const kind = CP_ORDER.find((k) => params.get(CP_KINDS[k].param));
				if (kind && this.perms.puede_compras) {
					this.kind = kind;
					this._go("form", { kind, name: params.get(CP_KINDS[kind].param) });
				} else {
					this._go("hub");
				}
			},
			error: () => {
				this.$body.html(`<div class="cp-empty" style="color:#b91c1c;">No se pudo cargar el módulo de Compras.</div>`);
			},
		});
	}

	get perms() {
		return (this.defaults && this.defaults.permissions) || {};
	}

	get company() {
		return (this.defaults && this.defaults.company) || "";
	}

	_can(kind, action) {
		return !!(this.perms.puede_compras && this.perms[CP_KINDS[kind].perms[action]]);
	}

	// ──────────────────────────────────────────────
	// Menú principal
	// ──────────────────────────────────────────────

	_render_hub() {
		const d = this.defaults;
		if (!(d.companies || []).length) {
			this.$body.html(`<div class="cp-empty">No tiene ninguna compañía asignada.<br>Contacte a un administrador.</div>`);
			return;
		}
		if (!this.perms.puede_compras) {
			this.$body.html(`<div class="cp-wrap"><div class="cp-card cp-empty">
				No tiene acceso al módulo de Compras en <b>${cpEsc(this.company)}</b>.<br>
				<span style="font-size:13px;">Contacte a un administrador para solicitar acceso.</span></div></div>`);
			return;
		}
		const card = (k, i) => {
			const c = CP_KINDS[k];
			const can = ["draft", "submit", "cancel"].filter((a) => this._can(k, a));
			const tag = can.length ? "Abrir →" : "Solo consulta →";
			return `
			<button type="button" class="cp-hub-card" data-kind="${k}">
				<div class="cp-hub-step">${i + 1}</div>
				<div class="cp-hub-title">${cpEsc(c.many)}</div>
				<div class="cp-hub-desc">${cpEsc(c.desc)}</div>
				<div class="cp-hub-tag">${tag}</div>
			</button>`;
		};
		this.$body.html(`
<div class="cp-wrap">
	<div class="cp-hub-head">
		<div>
			<div class="cp-h1">Compras</div>
			<div class="cp-muted">${cpEsc(this.company)}${this.perms.alcance_compras ? ` · Alcance: ${cpEsc(this.perms.alcance_compras)}` : ""}</div>
		</div>
	</div>
	<div class="cp-section-title">Documentos · Orden → Entrada → Factura · Devoluciones y notas de crédito</div>
	<div class="cp-hub-grid">${CP_ORDER.map(card).join("")}</div>
</div>`);
		this.$body.on("click", ".cp-hub-card", (e) => this._go("list", $(e.currentTarget).data("kind")));
	}

	// ──────────────────────────────────────────────
	// Lista (cualquier documento)
	// ──────────────────────────────────────────────

	_render_list(kind) {
		this.kind = kind = kind || this.kind;
		const c = CP_KINDS[kind];
		const f = this._filters[kind] || {
			start_date: frappe.datetime.month_start(),
			end_date: frappe.datetime.get_today(),
			supplier: "", supplier_label: "", estado: "",
		};
		this._filters[kind] = f;
		this.$body.html(`
<div class="cp-wrap">
	<div class="cp-page-head">
		<button type="button" class="cp-back" data-back="hub">← Compras</button>
		<div class="cp-h1">${cpEsc(c.many)}</div>
		<div class="cp-head-actions">
			${kind === "fc" && this._can("fc", "draft") ? `<button type="button" class="cp-btn cp-btn-secondary" id="cp-excel">Subir Excel</button>` : ""}
			${this._can(kind, "draft") ? `<button type="button" class="cp-btn cp-btn-primary" id="cp-new">+ Nueva</button>` : ""}
		</div>
	</div>
	<div class="cp-card cp-filters">
		<div class="cp-field"><label class="cp-label">Desde</label><input type="date" class="cp-input" id="cp-f-start" value="${cpEsc(f.start_date)}"></div>
		<div class="cp-field"><label class="cp-label">Hasta</label><input type="date" class="cp-input" id="cp-f-end" value="${cpEsc(f.end_date)}"></div>
		<div class="cp-field cp-field-wide"><label class="cp-label">Proveedor</label>
			<div class="cp-ac"><input type="text" class="cp-input" id="cp-f-supplier" placeholder="Todos" value="${cpEsc(f.supplier_label)}" data-value="${cpEsc(f.supplier)}"></div></div>
		<div class="cp-field"><label class="cp-label">Estado</label>
			<select class="cp-input" id="cp-f-status">
				<option value="">Todos</option>
				${c.states.map(([v, l]) => `<option value="${cpEsc(v)}"${f.estado === v ? " selected" : ""}>${cpEsc(l)}</option>`).join("")}
			</select></div>
		<div class="cp-field cp-field-btn"><button type="button" class="cp-btn cp-btn-secondary cp-block" id="cp-f-apply">Filtrar</button></div>
	</div>
	<div id="cp-list"></div>
</div>`);

		this.$body.on("click", "[data-back]", () => this._go("hub"));
		this.$body.on("click", "#cp-new", () => this._go("form", { kind }));
		this.$body.on("click", "#cp-excel", () => this._excel_dialog());
		this.$body.on("click", "#cp-f-apply", () => this._load_list());
		this.$body.on("click", "tr[data-name]", (e) => this._go("form", { kind, name: $(e.currentTarget).data("name") }));
		this._bind_supplier_ac(this.$body.find("#cp-f-supplier"));
		this._load_list();
	}

	_list_columns(kind) {
		// [encabezado, (fila) => html, clase]
		const cols = [
			["Documento", (x) => cpEsc(x.name), "cp-strong"],
			["Proveedor", (x) => cpEsc(x.supplier_name || x.supplier)],
			["Fecha", (x) => cpDate(x.fecha)],
		];
		if (kind === "oc") {
			cols.push(["Entrega", (x) => cpDate(x.schedule_date)]);
		} else if (kind === "dv") {
			cols.push(["Devolución de", (x) => cpEsc(x.return_against || "")]);
		} else if (kind === "nc") {
			cols.push(["No. NC Prov.", (x) => cpEsc(x.bill_no || "")]);
			cols.push(["Sobre factura", (x) => cpEsc(x.return_against || "—")]);
		} else if (kind === "en") {
			cols.push(["Envío / Remisión", (x) => cpEsc(x.supplier_delivery_note || "")]);
		} else {
			cols.push(["No. Factura Prov.", (x) => cpEsc(x.bill_no || "")]);
		}
		cols.push(["Total", (x) => cpMoney(Math.abs(cpFlt(x.grand_total)), x.currency), "cp-num cp-strong"]);
		if (kind === "oc") cols.push(["Recibido", (x) => (x.docstatus === 1 ? cpPct(x.per_received) : "—"), "cp-num"]);
		if (kind === "oc" || kind === "en") cols.push(["Facturado", (x) => (x.docstatus === 1 ? cpPct(x.per_billed) : "—"), "cp-num"]);
		if (kind === "fc") cols.push(["Saldo", (x) => (x.docstatus === 1 ? cpMoney(x.outstanding_amount, x.currency) : "—"), "cp-num"]);
		cols.push(["Estado", (x) => cpStatusBadge(x.status, x.docstatus)]);
		return cols;
	}

	_load_list() {
		const kind = this.kind;
		const $s = this.$body.find("#cp-f-supplier");
		const f = this._filters[kind];
		f.start_date = this.$body.find("#cp-f-start").val();
		f.end_date = this.$body.find("#cp-f-end").val();
		f.supplier = $s.val().trim() ? ($s.attr("data-value") || "") : "";
		f.supplier_label = f.supplier ? $s.val() : "";
		f.estado = this.$body.find("#cp-f-status").val();
		const $list = this.$body.find("#cp-list").html(`<div class="cp-empty">Cargando...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.documentos.get_document_list",
			args: { kind, company: this.company, start_date: f.start_date, end_date: f.end_date, supplier: f.supplier, estado: f.estado },
			callback: (r) => {
				if (this.view !== "list" || this.kind !== kind) return;
				const rows = r.message || [];
				if (!rows.length) {
					$list.html(`<div class="cp-card cp-empty">Sin ${cpEsc(CP_KINDS[kind].many.toLowerCase())} con estos filtros.</div>`);
					return;
				}
				const cols = this._list_columns(kind);
				const valid = rows.filter((x) => x.docstatus === 1);
				const total = valid.reduce((s, x) => s + Math.abs(cpFlt(x.grand_total)), 0);
				const saldo = valid.reduce((s, x) => s + cpFlt(x.outstanding_amount), 0);
				$list.html(`
<div class="cp-card cp-table-card">
	<table class="cp-table cp-cards">
		<thead><tr>${cols.map(([h, , cls]) => `<th class="${(cls || "").includes("cp-num") ? "cp-num" : ""}">${cpEsc(h)}</th>`).join("")}</tr></thead>
		<tbody>${rows.map((x) => `
			<tr data-name="${cpEsc(x.name)}" class="cp-row-link">
				${cols.map(([h, fn, cls]) => `<td data-label="${cpEsc(h)}" class="${cls || ""}">${fn(x)}</td>`).join("")}
			</tr>`).join("")}
		</tbody>
	</table>
	<div class="cp-list-foot">${rows.length} documento(s) · Validados: <b>${cpMoney(total)}</b>${kind === "fc" ? ` · Saldo: <b>${cpMoney(saldo)}</b>` : ""}</div>
</div>`);
			},
		});
	}

	// ──────────────────────────────────────────────
	// Formulario (cualquier documento)
	// ──────────────────────────────────────────────

	_empty_doc(kind, overrides) {
		const d = this.defaults;
		return Object.assign({
			kind, name: null, docstatus: 0, status: "", owner_fullname: "", validado_por_fullname: "",
			supplier: "", supplier_name: "",
			date: d.today, schedule_date: d.today,
			bill_no: "", bill_date: d.today, supplier_delivery_note: "", remarks: "",
			currency: d.currency || "GTQ",
			tax_type: d.default_tax_template || "",
			bfel_multi_tipo: "",
			source: null, related: [], update_stock: 0,
			items: [],
		}, overrides || {});
	}

	_render_form(arg) {
		const kind = (this.kind = arg.kind);
		if (!arg.name) {
			this.doc = this._empty_doc(kind, arg.pending);
			this._paint_form();
			if (this.doc.items.length) this.dirty = true;
			return;
		}
		this.$body.html(`<div class="cp-empty">Cargando...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.documentos.get_document",
			args: { kind, name: arg.name, company: this.company },
			callback: (r) => {
				if (!r.message) return;
				const d = r.message;
				this.doc = this._empty_doc(kind, {
					name: d.name, docstatus: d.docstatus, status: d.status,
					owner_fullname: d.owner_fullname, validado_por_fullname: d.validado_por_fullname,
					supplier: d.supplier, supplier_name: d.supplier_name || d.supplier,
					date: kind === "oc" ? d.transaction_date : d.posting_date,
					schedule_date: d.schedule_date || "",
					bill_no: d.bill_no || "", bill_date: d.bill_date || d.posting_date,
					supplier_delivery_note: d.supplier_delivery_note || "",
					remarks: this._user_remarks(d.remarks),
					currency: d.currency, tax_type: d.taxes_and_charges || "",
					bfel_multi_tipo: d.bfel_multi_tipo || "",
					grand_total: d.grand_total, total_taxes_and_charges: d.total_taxes_and_charges,
					net_total: d.net_total, outstanding_amount: d.outstanding_amount,
					per_received: d.per_received, per_billed: d.per_billed, update_stock: d.update_stock,
					related: d.related || [], source: d.return_source || null,
					items: (d.items || []).map((it) => {
						const row = {
							item_code: it.item_code, item_name: it.item_name || it.item_code,
							has_serial_no: it.has_serial_no, has_batch_no: it.has_batch_no, is_stock_item: it.is_stock_item,
							uom: it.uom, conversion_factor: it.conversion_factor, qty: it.qty, rate: it.rate,
							warehouse: it.warehouse || "", bfel_multi_tipo: it.bfel_multi_tipo || "",
							serial_no: it.serial_no || "", batch_no: it.batch_no || "",
							received_qty: it.received_qty,
							detail: it.detail, max_qty: it.max_qty,
						};
						CP_LINK_FIELDS[kind].forEach((f) => { row[f] = it[f] || ""; });
						return row;
					}),
				});
				this._paint_form();
			},
			error: () => this._go("list", kind),
		});
	}

	// ERPNext autocompleta remarks de la factura («Against Supplier Invoice …»):
	// no es una observación del usuario.
	_user_remarks(r) {
		r = r || "";
		return /^(Against Supplier Invoice|Contra factura del proveedor|No Remarks)/.test(r) ? "" : r;
	}

	// Factura que viene de una Entrada: no mueve inventario (ya ingresó).
	_from_receipt() {
		return this.doc.kind === "fc" && this.doc.items.some((it) => it.pr_detail);
	}

	_line_moves_stock(it) {
		const k = this.doc.kind;
		if (k === "dv") return !!it.is_stock_item;
		if (k === "nc") return !!it.is_stock_item && !!this.doc.update_stock;
		return !!it.is_stock_item && (k === "en" || (k === "fc" && !this._from_receipt()));
	}

	_paint_form() {
		const doc = this.doc;
		const kind = doc.kind;
		const c = CP_KINDS[kind];
		const editable = doc.docstatus === 0;
		const dis = editable ? "" : "disabled";
		const templates = this.defaults.tax_templates || [];
		const taxOptions = templates.length
			? templates.map((t) => `<option value="${cpEsc(t.name)}"${t.name === doc.tax_type ? " selected" : ""}>${cpEsc(t.name)} (${cpFlt(t.rate)}%)</option>`).join("")
			: `<option value="">Sin plantilla de impuestos configurada</option>`;
		const currencies = (this.defaults.currencies || ["GTQ"]).slice();
		if (doc.currency && !currencies.includes(doc.currency)) currencies.push(doc.currency);
		const ret = !!c.ret;
		const fromSource = ret || !!doc.source || doc.items.some((it) => CP_LINK_FIELDS[kind].some((f) => it[f]));
		const title = doc.name ? doc.name : `Nueva ${c.one}`;
		const srcLabel = doc.source ? CP_KINDS[doc.source.kind].one : "";
		const meta = [
			doc.owner_fullname && `Elaborado por <b>${cpEsc(doc.owner_fullname)}</b>`,
			doc.validado_por_fullname && `Validado por <b>${cpEsc(doc.validado_por_fullname)}</b>`,
			doc.source && `${ret ? "Contra" : "Desde"} ${cpEsc(srcLabel)} <b>${cpEsc(doc.source.name)}</b>`,
		].filter(Boolean).join(" · ");

		const field = (label, html, wide) => `<div class="cp-field${wide ? " cp-field-wide" : ""}"><label class="cp-label">${label}</label>${html}</div>`;
		const header = [
			field("Proveedor *", `<div class="cp-ac"><input type="text" class="cp-input" id="cp-h-supplier" placeholder="Buscar por nombre, código o NIT..." value="${cpEsc(doc.supplier_name || doc.supplier)}" data-value="${cpEsc(doc.supplier)}" ${editable && !fromSource ? "" : "disabled"}></div>`, true),
		];
		if (kind === "nc") {
			header.push(
				field("No. Nota de Crédito Proveedor *", `<input type="text" class="cp-input" id="cp-h-bill-no" value="${cpEsc(doc.bill_no)}" placeholder="Serie - número" ${dis}>`),
				field("Fecha Nota de Crédito", `<input type="date" class="cp-input" id="cp-h-bill-date" value="${cpEsc(doc.bill_date)}" ${dis}>`),
				field("Fecha de Registro", `<input type="date" class="cp-input" id="cp-h-date" value="${cpEsc(doc.date)}" ${dis}>`),
			);
		} else if (kind === "dv") {
			header.push(
				field("Fecha de Devolución", `<input type="date" class="cp-input" id="cp-h-date" value="${cpEsc(doc.date)}" ${dis}>`),
			);
		} else if (kind === "fc") {
			header.push(
				field("No. Factura Proveedor *", `<input type="text" class="cp-input" id="cp-h-bill-no" value="${cpEsc(doc.bill_no)}" placeholder="Serie - número" ${dis}>`),
				field("Fecha Factura *", `<input type="date" class="cp-input" id="cp-h-bill-date" value="${cpEsc(doc.bill_date)}" ${dis}>`),
				field("Fecha de Registro", `<input type="date" class="cp-input" id="cp-h-date" value="${cpEsc(doc.date)}" ${dis}>`),
			);
		} else if (kind === "oc") {
			header.push(
				field("Fecha", `<input type="date" class="cp-input" id="cp-h-date" value="${cpEsc(doc.date)}" ${dis}>`),
				field("Fecha de Entrega *", `<input type="date" class="cp-input" id="cp-h-schedule" value="${cpEsc(doc.schedule_date)}" ${dis}>`),
			);
		} else {
			header.push(
				field("Fecha de Recepción", `<input type="date" class="cp-input" id="cp-h-date" value="${cpEsc(doc.date)}" ${dis}>`),
				field("No. Envío / Remisión", `<input type="text" class="cp-input" id="cp-h-dn" value="${cpEsc(doc.supplier_delivery_note)}" placeholder="Documento del proveedor" ${dis}>`),
			);
		}
		header.push(
			field("Moneda", `<select class="cp-input" id="cp-h-currency" ${editable && !fromSource ? "" : "disabled"}>${currencies.map((x) => `<option${x === doc.currency ? " selected" : ""}>${cpEsc(x)}</option>`).join("")}</select>`),
			field("Tipo de Compra", `<select class="cp-input" id="cp-h-tax" ${ret ? "disabled" : dis}>${taxOptions}</select>`),
		);
		if (kind === "fc") header.push(field("Tipo FEL", `<select class="cp-input" id="cp-h-tipo" ${dis}>${cpTipoOptions(doc.bfel_multi_tipo)}</select>`));
		if (kind !== "oc") header.push(field("Observaciones", `<input type="text" class="cp-input" id="cp-h-remarks" value="${cpEsc(doc.remarks)}" ${dis}>`, true));

		this.$body.html(`
<div class="cp-wrap cp-has-actionbar">
	<div class="cp-page-head">
		<button type="button" class="cp-back" id="cp-form-back">← ${cpEsc(c.many)}</button>
		<div class="cp-h1">${cpEsc(title)} ${doc.name ? cpStatusBadge(doc.status, doc.docstatus) : `<span class="cp-badge" style="color:#1d4ed8;background:#dbeafe;">Nueva</span>`}</div>
		${meta ? `<div class="cp-muted cp-head-meta">${meta}</div>` : ""}
	</div>
	${this._related_html()}
	${ret && editable ? `<div class="cp-alert cp-alert-info">${this._return_hint()}</div>` : ""}
	${kind === "fc" && this._from_receipt() && editable ? `<div class="cp-alert cp-alert-info">Factura desde Entrada de Mercadería: el inventario ya ingresó con la entrada; esta factura solo registra la cuenta por pagar.</div>` : ""}

	<div class="cp-card"><div class="cp-grid">${header.join("")}</div></div>

	<div class="cp-card">
		<div class="cp-card-head">
			<div class="cp-section-title" style="margin:0;">${ret ? "Productos a devolver" : "Productos"}</div>
			${editable && !ret ? `<button type="button" class="cp-btn cp-btn-secondary" id="cp-add">+ Agregar producto</button>` : ""}
		</div>
		<div id="cp-items"></div>
	</div>

	<div class="cp-card cp-totals" id="cp-totals"></div>

	<div class="cp-actionbar">${this._actions_html()}</div>
</div>`);

		this._render_items();
		this._bind_form();
	}

	_return_hint() {
		const doc = this.doc;
		if (doc.kind === "dv") return "Indique cuánto devuelve de cada producto (hasta lo pendiente de la entrada). Sale de la misma bodega y con los mismos lotes/series; precios e impuestos son los de la entrada.";
		if (doc.source && doc.source.kind === "dv") return "Nota de crédito por la mercadería devuelta: solo registra el crédito del proveedor (el inventario ya salió con la devolución).";
		return doc.update_stock
			? "Nota de crédito sobre la factura: rebaja su saldo y, como esa factura ingresó el inventario, también saca del inventario lo que indique."
			: "Nota de crédito sobre la factura: rebaja su saldo. No mueve inventario (para devolver mercadería use una Devolución desde la Entrada).";
	}

	_related_html() {
		const rel = this.doc.related || [];
		if (!rel.length) return "";
		const chip = (r) => `<button type="button" class="cp-chip" data-rel-kind="${r.kind}" data-rel-name="${cpEsc(r.name)}">
			<span class="cp-chip-kind">${cpEsc(CP_KINDS[r.kind].short)}</span> ${cpEsc(r.name)} ${cpStatusBadge(r.status, r.docstatus)}</button>`;
		return `<div class="cp-related">${CP_ORDER.flatMap((k) => rel.filter((r) => r.kind === k)).map(chip).join("")}</div>`;
	}

	_actions_html() {
		const doc = this.doc;
		const kind = doc.kind;
		const c = CP_KINDS[kind];
		const editable = doc.docstatus === 0;
		const btn = (id, label, cls) => `<button type="button" class="cp-btn ${cls}" id="${id}">${label}</button>`;
		const out = [];
		if (doc.name) {
			out.push(`<a class="cp-btn cp-btn-ghost" href="/app/${c.route}/${encodeURIComponent(doc.name)}" target="_blank">Abrir en ERP</a>`);
			out.push(btn("cp-print", "Imprimir", "cp-btn-secondary"));
		}
		if (doc.name && editable && this._can(kind, "draft")) out.push(btn("cp-delete", "Eliminar", "cp-btn-danger"));
		if (doc.docstatus === 1 && this._can(kind, "cancel")) out.push(btn("cp-cancel", "Cancelar", "cp-btn-danger"));
		if (kind === "oc" && doc.docstatus === 1 && this._can("oc", "submit")) {
			if (doc.status === "Closed") out.push(btn("cp-reopen", "Reabrir", "cp-btn-secondary"));
			else if (doc.status !== "Completed") out.push(btn("cp-close", "Cerrar Orden", "cp-btn-secondary"));
		}
		out.push(`<span class="cp-spacer"></span>`);
		if (doc.docstatus === 1 && doc.status !== "Closed") {
			if (kind === "oc" && cpFlt(doc.per_received) < 100 && this._can("en", "draft") && doc.items.some((it) => it.is_stock_item)) {
				out.push(btn("cp-make-en", "Crear Entrada", "cp-btn-primary"));
			}
			if ((kind === "oc" || kind === "en") && cpFlt(doc.per_billed) < 100 && this._can("fc", "draft")) {
				out.push(btn("cp-make-fc", "Crear Factura", "cp-btn-primary"));
			}
			if (kind === "en" && doc.status !== "Return Issued" && this._can("dv", "draft")) {
				out.push(btn("cp-make-dv", "Crear Devolución", "cp-btn-secondary"));
			}
			if (kind === "fc" && this._can("nc", "draft")) {
				out.push(btn("cp-make-nc", "Crear Nota de Crédito", "cp-btn-secondary"));
			}
			if (kind === "dv" && cpFlt(doc.per_billed) < 100 && this._can("nc", "draft")) {
				out.push(btn("cp-make-nc", "Crear Nota de Crédito", "cp-btn-primary"));
			}
		}
		if (editable && this._can(kind, "draft")) out.push(btn("cp-save", "Grabar Borrador", "cp-btn-secondary"));
		if (editable && this._can(kind, "submit")) out.push(btn("cp-submit", "Validar", "cp-btn-primary"));
		return out.join("");
	}

	_bind_form() {
		const $b = this.$body;
		$b.on("click", "#cp-form-back", () => this._internal_back());
		$b.on("click", "#cp-add", () => this._add_item_dialog());
		$b.on("click", "#cp-save", () => this._save(false));
		$b.on("click", "#cp-submit", () => this._save(true));
		$b.on("click", "#cp-cancel", () => this._cancel());
		$b.on("click", "#cp-delete", () => this._delete());
		$b.on("click", "#cp-close", () => this._set_closed(1));
		$b.on("click", "#cp-reopen", () => this._set_closed(0));
		$b.on("click", "#cp-make-en", () => this._make_from("en"));
		$b.on("click", "#cp-make-fc", () => this._make_from("fc"));
		$b.on("click", "#cp-make-dv", () => this._make_from("dv"));
		$b.on("click", "#cp-make-nc", () => this._make_from("nc"));
		$b.on("click", "#cp-print", () => this._print());
		$b.on("click", ".cp-chip", (e) => {
			const $c = $(e.currentTarget);
			const go = () => this._go("form", { kind: $c.data("rel-kind"), name: $c.data("rel-name") });
			if (this.dirty) frappe.confirm("Hay cambios sin guardar. ¿Desea salir de todos modos?", go);
			else go();
		});

		if (this.doc.docstatus !== 0) return;
		this._bind_supplier_ac($b.find("#cp-h-supplier"), {
			on_pick: (s) => { this.doc.supplier = s.value; this.doc.supplier_name = s.label; this.dirty = true; },
		});
		$b.on("change input", ".cp-grid .cp-input", (e) => {
			if (e.target.id === "cp-h-supplier") return;
			this._read_header();
			this.dirty = true;
			this._render_totals();
		});

		// Líneas: delegación sobre el contenedor (sobrevive a los re-render).
		const line = (e) => this.doc.items[parseInt($(e.target).closest("[data-idx]").data("idx"))];
		$b.on("input", ".cp-l-qty", (e) => { const it = line(e); if (it) { it.qty = cpFlt(e.target.value); this._line_changed(e, it); } });
		$b.on("input", ".cp-l-rate", (e) => { const it = line(e); if (it) { it.rate = cpFlt(e.target.value); this._line_changed(e, it); } });
		$b.on("change", ".cp-l-wh", (e) => { const it = line(e); if (it) { it.warehouse = e.target.value; this.dirty = true; } });
		$b.on("change", ".cp-l-tipo", (e) => { const it = line(e); if (it) { it.bfel_multi_tipo = e.target.value; this.dirty = true; } });
		$b.on("input", ".cp-l-batch", (e) => { const it = line(e); if (it) { it.batch_no = e.target.value.trim(); this.dirty = true; } });
		$b.on("input", ".cp-l-serial", (e) => {
			const it = line(e);
			if (!it) return;
			const serials = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
			it.serial_no = serials.join("\n");
			it.qty = serials.length;
			$(e.target).closest("[data-idx]").find(".cp-l-qty-ro").text(it.qty);
			this._line_changed(e, it);
		});
		$b.on("click", ".cp-l-del", (e) => {
			this.doc.items.splice(parseInt($(e.currentTarget).closest("[data-idx]").data("idx")), 1);
			this.dirty = true;
			this._render_items();
		});
	}

	_line_changed(e, it) {
		this.dirty = true;
		$(e.target).closest("[data-idx]").find(".cp-l-amount").text(cpMoney(cpFlt(it.qty) * cpFlt(it.rate), this.doc.currency));
		this._render_totals();
	}

	_read_header() {
		const $b = this.$body;
		const doc = this.doc;
		const $s = $b.find("#cp-h-supplier");
		const val = (id) => ($b.find(id).val() || "").trim();
		// Solo cuenta un proveedor elegido de la lista (data-value); texto
		// libre sin elegir deja el campo vacío para que la validación lo marque.
		if (!$s.prop("disabled")) {
			doc.supplier = $s.val().trim() ? ($s.attr("data-value") || "") : "";
			doc.supplier_name = doc.supplier ? $s.val().trim() : "";
		}
		doc.date = val("#cp-h-date") || doc.date;
		if (doc.kind === "oc") doc.schedule_date = val("#cp-h-schedule");
		if (doc.kind === "fc" || doc.kind === "nc") {
			doc.bill_no = val("#cp-h-bill-no");
			doc.bill_date = val("#cp-h-bill-date");
		}
		if (doc.kind === "fc") doc.bfel_multi_tipo = val("#cp-h-tipo");
		if (doc.kind === "en") doc.supplier_delivery_note = val("#cp-h-dn");
		if (doc.kind !== "oc") doc.remarks = val("#cp-h-remarks");
		doc.currency = val("#cp-h-currency") || doc.currency;
		doc.tax_type = val("#cp-h-tax");
	}

	_source_tag(it) {
		const k = this.doc.kind;
		if (k === "en" && it.purchase_order) return `OC ${it.purchase_order}`;
		if (k === "fc" && it.purchase_receipt) return `Entrada ${it.purchase_receipt}`;
		if (k === "fc" && it.purchase_order) return `OC ${it.purchase_order}`;
		return "";
	}

	_render_return_items() {
		const doc = this.doc;
		const editable = doc.docstatus === 0;
		const dis = editable ? "" : "disabled";
		const $c = this.$body.find("#cp-items");
		if (!doc.items.length) {
			$c.html(`<div class="cp-empty">Sin productos.</div>`);
			this._render_totals();
			return;
		}
		$c.html(`
<table class="cp-table cp-cards cp-lines">
	<thead><tr>
		<th style="width:32px;">#</th><th>Producto</th><th class="cp-num" style="width:130px;">Cant. a devolver</th>
		<th class="cp-num" style="width:110px;">Precio Unit.</th><th class="cp-num" style="width:120px;">Total</th>
		<th style="width:170px;">Bodega</th><th style="width:36px;"></th>
	</tr></thead>
	<tbody>${doc.items.map((it, idx) => {
		const moves = this._line_moves_stock(it);
		const serialInput = moves && it.has_serial_no;
		return `
		<tr data-idx="${idx}">
			<td data-label="#" class="cp-muted">${idx + 1}</td>
			<td data-label="Producto" class="cp-cell-product">
				<div class="cp-strong">${cpEsc(it.item_code)}</div>
				<div class="cp-muted">${cpEsc(it.item_name || "")}${it.batch_no ? ` · Lote <b>${cpEsc(it.batch_no)}</b>` : ""}</div>
				${serialInput ? `<label class="cp-label cp-sub-label">Series que devuelve (una por línea)</label>
					<textarea class="cp-input cp-l-serial cp-mono" rows="3" ${dis}>${cpEsc(it.serial_no || "")}</textarea>` : ""}
			</td>
			<td data-label="Cant. a devolver" class="cp-num">${serialInput
				? `<span class="cp-strong cp-l-qty-ro">${cpFlt(it.qty)}</span>`
				: `<input type="number" class="cp-input cp-num cp-l-qty" min="0" max="${cpFlt(it.max_qty)}" step="any" value="${cpFlt(it.qty)}" ${dis}>`}
				${editable ? `<span class="cp-muted cp-uom">de ${cpFlt(it.max_qty)} ${cpEsc(it.uom || "")}</span>` : `<span class="cp-muted cp-uom">${cpEsc(it.uom || "")}</span>`}</td>
			<td data-label="Precio Unit." class="cp-num">${cpMoney(it.rate, doc.currency)}</td>
			<td data-label="Total" class="cp-num cp-strong cp-l-amount">${cpMoney(cpFlt(it.qty) * cpFlt(it.rate), doc.currency)}</td>
			<td data-label="Bodega">${cpEsc(it.warehouse || "—")}</td>
			<td class="cp-cell-del">${editable ? `<button type="button" class="cp-del cp-l-del" title="No devolver">×</button>` : ""}</td>
		</tr>`;
	}).join("")}
	</tbody>
</table>`);
		this._render_totals();
	}

	_render_items() {
		if (CP_KINDS[this.doc.kind].ret) return this._render_return_items();
		const doc = this.doc;
		const kind = doc.kind;
		const editable = doc.docstatus === 0;
		const dis = editable ? "" : "disabled";
		const whs = this.defaults.warehouses || [];
		const showTipo = kind === "fc";
		const $c = this.$body.find("#cp-items");
		if (!doc.items.length) {
			$c.html(`<div class="cp-empty">${editable ? "Use <b>+ Agregar producto</b> para comenzar." : "Sin productos."}</div>`);
			this._render_totals();
			return;
		}
		$c.html(`
<table class="cp-table cp-cards cp-lines">
	<thead><tr>
		<th style="width:32px;">#</th><th>Producto</th><th class="cp-num" style="width:90px;">Cant.</th>
		<th class="cp-num" style="width:120px;">Precio Unit.</th><th class="cp-num" style="width:120px;">Total</th>
		<th style="width:170px;">Bodega</th>${showTipo ? `<th style="width:150px;">Tipo FEL</th>` : ""}<th style="width:36px;"></th>
	</tr></thead>
	<tbody>${doc.items.map((it, idx) => {
		const moves = this._line_moves_stock(it);
		const serialInput = moves && it.has_serial_no;
		const whOptions = [`<option value="">Bodega...</option>`]
			.concat(whs.map((w) => `<option value="${cpEsc(w)}"${w === it.warehouse ? " selected" : ""}>${cpEsc(w)}</option>`))
			.concat(it.warehouse && !whs.includes(it.warehouse) ? [`<option selected>${cpEsc(it.warehouse)}</option>`] : [])
			.join("");
		const src = this._source_tag(it);
		return `
		<tr data-idx="${idx}">
			<td data-label="#" class="cp-muted">${idx + 1}</td>
			<td data-label="Producto" class="cp-cell-product">
				<div class="cp-strong">${cpEsc(it.item_code)}${src ? ` <span class="cp-tag">${cpEsc(src)}</span>` : ""}</div>
				<div class="cp-muted">${cpEsc(it.item_name || "")}${it.is_stock_item ? "" : ` · <i>sin inventario</i>`}${kind === "oc" && doc.docstatus === 1 ? ` · recibido ${cpFlt(it.received_qty)}` : ""}</div>
				${serialInput ? `<label class="cp-label cp-sub-label">Series (una por línea)</label>
					<textarea class="cp-input cp-l-serial cp-mono" rows="3" ${dis}>${cpEsc(it.serial_no || "")}</textarea>` : ""}
				${moves && it.has_batch_no ? `<label class="cp-label cp-sub-label">Lote del proveedor</label>
					<input type="text" class="cp-input cp-l-batch cp-mono" value="${cpEsc(it.batch_no || "")}" ${dis}>` : ""}
			</td>
			<td data-label="Cantidad" class="cp-num">${serialInput
				? `<span class="cp-strong cp-l-qty-ro">${cpFlt(it.qty)}</span>`
				: `<input type="number" class="cp-input cp-num cp-l-qty" min="0" step="any" value="${cpFlt(it.qty)}" ${dis}>`}
				<span class="cp-muted cp-uom">${cpEsc(it.uom || "")}</span></td>
			<td data-label="Precio Unit." class="cp-num"><input type="number" class="cp-input cp-num cp-l-rate" min="0" step="any" value="${cpFlt(it.rate)}" ${dis}></td>
			<td data-label="Total" class="cp-num cp-strong cp-l-amount">${cpMoney(cpFlt(it.qty) * cpFlt(it.rate), doc.currency)}</td>
			<td data-label="Bodega">${it.is_stock_item
				? `<select class="cp-input cp-l-wh" ${moves || kind === "oc" ? dis : "disabled"}>${whOptions}</select>`
				: `<span class="cp-muted">—</span>`}</td>
			${showTipo ? `<td data-label="Tipo FEL"><select class="cp-input cp-l-tipo" ${dis}>${cpTipoOptions(it.bfel_multi_tipo)}</select></td>` : ""}
			<td class="cp-cell-del">${editable ? `<button type="button" class="cp-del cp-l-del" title="Quitar">×</button>` : ""}</td>
		</tr>`;
	}).join("")}
	</tbody>
</table>`);
		this._render_totals();
	}

	_render_totals() {
		const doc = this.doc;
		let net, tax, grand;
		if (doc.docstatus !== 0 && doc.grand_total != null) {
			// Documento validado/cancelado: los totales reales de ERPNext.
			net = Math.abs(cpFlt(doc.net_total)); tax = Math.abs(cpFlt(doc.total_taxes_and_charges)); grand = Math.abs(cpFlt(doc.grand_total));
		} else {
			// Estimado en vivo (el definitivo lo calcula ERPNext al grabar). Si la
			// plantilla trae el impuesto incluido en el precio, el precio ya es
			// el total y el impuesto se desglosa hacia adentro.
			const t = (this.defaults.tax_templates || []).find((x) => x.name === doc.tax_type);
			const rate = t ? cpFlt(t.rate) / 100 : 0;
			const lines = doc.items.reduce((s, it) => s + cpFlt(it.qty) * cpFlt(it.rate), 0);
			if (t && t.included) {
				grand = lines;
				tax = grand - grand / (1 + rate);
				net = grand - tax;
			} else {
				net = lines;
				tax = net * rate;
				grand = net + tax;
			}
		}
		const row = (label, value, cls) => `<div class="cp-total-row${cls ? ` ${cls}` : ""}"><span>${label}</span><span>${value}</span></div>`;
		const out = [
			row("Subtotal", cpMoney(net, doc.currency)),
			row("Impuestos", cpMoney(tax, doc.currency)),
			row({ dv: "Total devuelto", nc: "Total acreditado" }[doc.kind] || "Total", cpMoney(grand, doc.currency), "cp-total-grand"),
		];
		if (doc.docstatus === 1) {
			if (doc.kind === "fc") out.push(row("Saldo pendiente", cpMoney(doc.outstanding_amount, doc.currency)));
			if (doc.kind === "nc" && cpFlt(doc.outstanding_amount)) out.push(row("Crédito disponible", cpMoney(Math.abs(cpFlt(doc.outstanding_amount)), doc.currency)));
			if (doc.kind === "oc") out.push(row("Recibido", cpPct(doc.per_received)));
			if (doc.kind === "oc" || doc.kind === "en") out.push(row("Facturado", cpPct(doc.per_billed)));
			if (doc.kind === "dv") out.push(row("Con nota de crédito", cpPct(doc.per_billed)));
		}
		this.$body.find("#cp-totals").html(out.join(""));
	}

	_add_item_dialog() {
		let picked = null;
		const dlg = new frappe.ui.Dialog({
			title: "Agregar Producto",
			fields: [
				{ fieldtype: "HTML", fieldname: "search_html", options: `
					<label class="cp-label">Buscar producto *</label>
					<div class="cp-ac"><input type="text" class="cp-input" id="cp-add-search" placeholder="Código o nombre..." autocomplete="off"></div>
					<div id="cp-add-picked" class="cp-picked" style="display:none;"></div>` },
				{ fieldtype: "Float", fieldname: "qty", label: "Cantidad", default: 1 },
				{ fieldtype: "Currency", fieldname: "rate", label: "Precio Unitario *", default: 0 },
			],
			primary_action_label: "Agregar",
			primary_action: (v) => {
				if (!picked) {
					frappe.msgprint({ message: "Seleccione un producto de la lista.", indicator: "orange" });
					return;
				}
				const it = {
					item_code: picked.item_code, item_name: picked.item_name,
					has_serial_no: picked.has_serial_no, has_batch_no: picked.has_batch_no,
					is_stock_item: picked.is_stock_item, uom: picked.uom, conversion_factor: 1,
					qty: cpFlt(v.qty) || 1, rate: cpFlt(v.rate),
					warehouse: picked.warehouse || "",
					bfel_multi_tipo: this.doc.bfel_multi_tipo || "",
					serial_no: "", batch_no: "",
				};
				if (this._line_moves_stock(it) && it.has_serial_no) it.qty = 0;
				this.doc.items.push(it);
				this.dirty = true;
				this._render_items();
				dlg.hide();
			},
		});
		dlg.show();
		const $search = dlg.$wrapper.find("#cp-add-search");
		this._bind_ac($search, {
			method: "facex_multi.api.compras.facturas.search_items",
			render: (it) => {
				const tag = it.has_serial_no ? "Serie" : it.has_batch_no ? "Lote" : it.is_stock_item ? "Inventario" : "Servicio";
				return `<div class="cp-strong">${cpEsc(it.item_code)} <span class="cp-tag">${tag}</span></div>
					<div class="cp-muted">${cpEsc(it.item_name)}</div>`;
			},
			on_pick: (it) => {
				picked = it;
				const serialQty = it.has_serial_no && this._line_moves_stock(it);
				$search.val(it.item_code);
				dlg.$wrapper.find("#cp-add-picked").html(`<b>${cpEsc(it.item_code)}</b> — ${cpEsc(it.item_name)}
					${serialQty ? "<br><i>Maneja series: la cantidad sale de las series que ingrese en la línea.</i>" : ""}
					${it.has_batch_no && this._line_moves_stock(it) ? "<br><i>Se gestiona por lote.</i>" : ""}
					${it.warehouse ? `<br>Bodega: <b>${cpEsc(it.warehouse)}</b>` : ""}`).show();
				dlg.set_df_property("qty", "hidden", !!serialQty);
			},
		});
		setTimeout(() => $search.trigger("focus"), 200);
	}

	_validate() {
		const doc = this.doc;
		const kind = doc.kind;
		const errors = [];
		if (CP_KINDS[kind].ret) {
			if (kind === "nc" && !doc.bill_no) errors.push("Ingrese el número de la nota de crédito del proveedor.");
			if (!doc.items.some((it) => cpFlt(it.qty) > 0)) errors.push("Indique la cantidad a devolver de al menos un producto.");
			doc.items.forEach((it, i) => {
				const n = `Línea ${i + 1} (${it.item_code})`;
				if (cpFlt(it.qty) < 0) errors.push(`${n}: la cantidad no puede ser negativa.`);
				if (cpFlt(it.qty) > cpFlt(it.max_qty) + 1e-9) errors.push(`${n}: solo quedan ${cpFlt(it.max_qty)} pendientes de devolver.`);
				if (this._line_moves_stock(it) && it.has_serial_no && cpFlt(it.qty) > 0 && !(it.serial_no || "").trim()) errors.push(`${n}: indique las series que devuelve.`);
			});
			return errors;
		}
		if (!doc.supplier) errors.push("Seleccione el proveedor de la lista.");
		if (kind === "fc") {
			if (!doc.bill_no) errors.push("Ingrese el número de factura del proveedor.");
			if (!doc.bill_date) errors.push("Ingrese la fecha de la factura del proveedor.");
		}
		if (kind === "oc") {
			if (!doc.schedule_date) errors.push("Ingrese la fecha de entrega.");
			else if (doc.date && doc.schedule_date < doc.date) errors.push("La fecha de entrega no puede ser anterior a la fecha de la orden.");
		}
		if (!doc.items.length) errors.push("Agregue al menos un producto.");
		if (kind === "en" && doc.items.length && !doc.items.some((it) => it.is_stock_item)) {
			errors.push("Una Entrada de Mercadería necesita al menos un producto de inventario.");
		}
		doc.items.forEach((it, i) => {
			const n = `Línea ${i + 1} (${it.item_code})`;
			const moves = this._line_moves_stock(it);
			if (cpFlt(it.rate) <= 0) errors.push(`${n}: el precio debe ser mayor a 0.`);
			if (moves && it.has_serial_no && !(it.serial_no || "").trim()) errors.push(`${n}: ingrese los números de serie (uno por línea).`);
			else if (cpFlt(it.qty) <= 0) errors.push(`${n}: la cantidad debe ser mayor a 0.`);
			if (moves && it.has_batch_no && !(it.batch_no || "").trim()) errors.push(`${n}: ingrese el número de lote.`);
			if ((moves || kind === "oc") && it.is_stock_item && !it.warehouse) errors.push(`${n}: seleccione la bodega.`);
		});
		return errors;
	}

	_payload() {
		const doc = this.doc;
		const kind = doc.kind;
		if (CP_KINDS[kind].ret) {
			return {
				name: doc.name, company: this.company, source: doc.source,
				posting_date: doc.date, remarks: doc.remarks, bill_no: doc.bill_no, bill_date: doc.bill_date,
				items: doc.items.filter((it) => cpFlt(it.qty) > 0).map((it) => ({ detail: it.detail, qty: it.qty, serial_no: it.serial_no })),
			};
		}
		const p = {
			name: doc.name, company: this.company, supplier: doc.supplier,
			currency: doc.currency, tax_type: doc.tax_type, remarks: doc.remarks,
		};
		if (kind === "oc") Object.assign(p, { transaction_date: doc.date, schedule_date: doc.schedule_date });
		if (kind === "en") Object.assign(p, { posting_date: doc.date, supplier_delivery_note: doc.supplier_delivery_note });
		if (kind === "fc") Object.assign(p, { posting_date: doc.date, bill_no: doc.bill_no, bill_date: doc.bill_date, bfel_multi_tipo: doc.bfel_multi_tipo });
		p.items = doc.items.map((it) => {
			const row = {
				item_code: it.item_code, qty: it.qty, rate: it.rate, uom: it.uom, conversion_factor: it.conversion_factor,
				warehouse: it.warehouse, serial_no: it.serial_no, batch_no: it.batch_no, bfel_multi_tipo: it.bfel_multi_tipo,
			};
			CP_LINK_FIELDS[kind].forEach((f) => { if (it[f]) row[f] = it[f]; });
			return row;
		});
		return p;
	}

	_save(then_submit) {
		this._read_header();
		const errors = this._validate();
		const kind = this.doc.kind;
		const c = CP_KINDS[kind];
		if (errors.length) {
			frappe.msgprint({ title: `Revise la ${c.one.toLowerCase()}`, message: errors.map((e) => `• ${cpEsc(e)}`).join("<br>"), indicator: "red" });
			return;
		}
		const run = () => {
			frappe.call({
				method: "facex_multi.api.compras.documentos.save_document",
				args: { kind, data_json: JSON.stringify(this._payload()) },
				freeze: true,
				freeze_message: "Grabando...",
				callback: (r) => {
					if (!r.message || !r.message.name) return;
					const name = r.message.name;
					this.dirty = false;
					if (!then_submit) {
						frappe.show_alert({ message: `Borrador grabado: <b>${cpEsc(name)}</b>`, indicator: "green" });
						this._go("form", { kind, name });
						return;
					}
					frappe.call({
						method: "facex_multi.api.compras.documentos.submit_document",
						args: { kind, name },
						freeze: true,
						freeze_message: "Validando...",
						callback: (r2) => {
							if (r2.message) frappe.show_alert({ message: `${cpEsc(c.one)} <b>${cpEsc(name)}</b> validada.`, indicator: "green" });
							this._go("form", { kind, name });
						},
						// El borrador sí quedó grabado: recargarlo para no perder el nombre.
						error: () => this._go("form", { kind, name }),
					});
				},
			});
		};
		if (then_submit) {
			const effect = {
				oc: "Quedará confirmada ante el proveedor; después solo podrá cerrarse o cancelarse.",
				dv: "Sacará del inventario la mercadería devuelta; después solo podrá cancelarse.",
				nc: this.doc.update_stock
					? "Rebajará la cuenta por pagar y sacará del inventario lo devuelto; después solo podrá cancelarse."
					: "Rebajará la cuenta por pagar con el proveedor; después solo podrá cancelarse.",
				en: "Ingresará el inventario en bodega; después solo podrá cancelarse.",
				fc: this._from_receipt()
					? "Registrará la cuenta por pagar; después solo podrá cancelarse."
					: "Registrará la cuenta por pagar y, si trae productos de inventario, los ingresará; después solo podrá cancelarse.",
			}[kind];
			frappe.confirm(`¿Validar esta ${cpEsc(c.one.toLowerCase())}? ${effect}`, run);
		} else {
			run();
		}
	}

	_cancel() {
		const c = CP_KINDS[this.doc.kind];
		const effect = {
			oc: "", en: " Se revertirá el inventario.", fc: " Se revertirán la cuenta por pagar y, si aplica, el inventario.",
			dv: " La mercadería vuelve a la bodega.", nc: " Se revierte el crédito del proveedor.",
		}[this.doc.kind];
		frappe.confirm(`¿Cancelar ${cpEsc(c.one.toLowerCase())} <b>${cpEsc(this.doc.name)}</b>?${effect}`, () => {
			frappe.call({
				method: "facex_multi.api.compras.documentos.cancel_document",
				args: { kind: this.doc.kind, name: this.doc.name },
				freeze: true,
				freeze_message: "Cancelando...",
				callback: (r) => {
					if (r.message) frappe.show_alert({ message: `${cpEsc(c.one)} cancelada.`, indicator: "blue" });
					this._go("form", { kind: this.doc.kind, name: this.doc.name });
				},
			});
		});
	}

	_delete() {
		frappe.confirm(`¿Eliminar el borrador <b>${cpEsc(this.doc.name)}</b>? No se puede deshacer.`, () => {
			frappe.call({
				method: "facex_multi.api.compras.documentos.delete_document",
				args: { kind: this.doc.kind, name: this.doc.name },
				freeze: true,
				callback: (r) => {
					if (!r.message) return;
					frappe.show_alert({ message: "Borrador eliminado.", indicator: "blue" });
					this.dirty = false;
					this._go("list", this.doc.kind);
				},
			});
		});
	}

	_set_closed(closed) {
		const msg = closed
			? `¿Cerrar la orden <b>${cpEsc(this.doc.name)}</b>? Ya no se esperará lo pendiente de recibir ni de facturar.`
			: `¿Reabrir la orden <b>${cpEsc(this.doc.name)}</b>?`;
		frappe.confirm(msg, () => {
			frappe.call({
				method: "facex_multi.api.compras.documentos.set_order_closed",
				args: { name: this.doc.name, closed },
				freeze: true,
				callback: () => this._go("form", { kind: "oc", name: this.doc.name }),
			});
		});
	}

	_make_from(target) {
		const source = this.doc;
		frappe.call({
			method: "facex_multi.api.compras.documentos.make_from",
			args: { source_kind: source.kind, name: source.name, target_kind: target },
			freeze: true,
			freeze_message: "Preparando...",
			callback: (r) => {
				if (!r.message) return;
				const m = r.message;
				this._go("form", {
					kind: target,
					pending: {
						supplier: m.supplier, supplier_name: m.supplier_name, currency: m.currency,
						tax_type: m.tax_type || this.defaults.default_tax_template || "",
						source: m.source, related: [{ kind: source.kind, name: source.name, docstatus: 1, status: source.status }],
						update_stock: m.update_stock || 0,
						items: m.items,
					},
				});
				this.dirty = true;
				const what = { fc: " y datos de la factura", nc: " y el número de la nota de crédito" }[target] || "";
				frappe.show_alert({ message: `Revise cantidades${what} y grabe.`, indicator: "blue" });
			},
		});
	}

	_print() {
		const c = CP_KINDS[this.doc.kind];
		const url = `/printview?doctype=${encodeURIComponent(c.doctype)}&name=${encodeURIComponent(this.doc.name)}`
			+ `&format=${encodeURIComponent(c.print_format)}&no_letterhead=1&trigger_print=1`;
		window.open(frappe.urllib.get_full_url(url), "_blank");
	}

	// ──────────────────────────────────────────────
	// Carga desde Excel (previsualización editable)
	// ──────────────────────────────────────────────

	_excel_dialog() {
		const dlg = new frappe.ui.Dialog({
			title: "Cargar Compra desde Excel",
			fields: [
				{ fieldtype: "HTML", options: `<div class="cp-help">
					<b>Hoja 1 – ENCABEZADO</b> (fila 2): Proveedor | Fecha Registro | No. Factura | Fecha Factura | Moneda<br>
					<b>Hoja 2 – DETALLE</b> (desde fila 2): Código Ítem | Precio Unitario | Serie | Lote<br>
					<i>Ítems con serie: una fila por unidad. Sin serie: cada fila suma 1 a la cantidad (se ajusta en la revisión).
					Por lote: indique el lote en la 4ª columna.</i></div>` },
				{ fieldtype: "Attach", fieldname: "excel_file", label: "Archivo Excel (.xlsx)", reqd: 1 },
			],
			primary_action_label: "Procesar",
			primary_action: (v) => {
				if (!v.excel_file) return;
				dlg.hide();
				frappe.call({
					method: "facex_multi.api.compras.facturas.process_purchase_excel",
					args: { file_url: v.excel_file, company: this.company },
					freeze: true,
					freeze_message: "Procesando Excel...",
					callback: (r) => {
						if (!r.message) return;
						if (!(r.message.items || []).length) {
							frappe.msgprint({ title: "Sin datos", message: (r.message.errors || []).map(cpEsc).join("<br>") || "El archivo no contiene líneas válidas.", indicator: "orange" });
							return;
						}
						this._go("fc-staging", r.message);
					},
				});
			},
		});
		dlg.show();
	}

	_render_fc_staging(result) {
		this.kind = "fc";
		const h = result.header || {};
		this.stg = {
			warnings: result.errors || [],
			fc: this._empty_doc("fc", {
				supplier: h.supplier || "", supplier_name: h.supplier || "",
				date: h.posting_date || this.defaults.today,
				bill_no: h.bill_no || "", bill_date: h.bill_date || this.defaults.today,
				currency: h.currency || this.defaults.currency,
				items: (result.items || []).map((it) => Object.assign({ bfel_multi_tipo: "" }, it)),
			}),
		};
		this.dirty = true;
		this._paint_staging();
	}

	_paint_staging() {
		const fc = this.stg.fc;
		const whs = this.defaults.warehouses || [];
		const rows = fc.items.map((it) => ({ it, errs: this._stg_row_errors(it) }));
		const bad = rows.filter((r) => r.errs.length).length;
		this.$body.html(`
<div class="cp-wrap cp-has-actionbar">
	<div class="cp-page-head">
		<button type="button" class="cp-back" id="cp-stg-back">← Facturas</button>
		<div class="cp-h1">Previsualización de importación</div>
		<div class="cp-muted cp-head-meta">Revise y corrija antes de pasar al formulario.</div>
	</div>
	${this.stg.warnings.length ? `<div class="cp-alert cp-alert-warn"><b>Advertencias del archivo:</b><br>${this.stg.warnings.map((w) => `• ${cpEsc(w)}`).join("<br>")}</div>` : ""}
	<div class="cp-card"><div class="cp-grid">
		<div class="cp-field cp-field-wide"><label class="cp-label">Proveedor (del archivo)</label><div class="cp-input cp-ro">${cpEsc(fc.supplier) || "—"}</div></div>
		<div class="cp-field"><label class="cp-label">No. Factura</label><div class="cp-input cp-ro">${cpEsc(fc.bill_no) || "—"}</div></div>
		<div class="cp-field"><label class="cp-label">Fecha Factura</label><div class="cp-input cp-ro">${cpDate(fc.bill_date)}</div></div>
		<div class="cp-field"><label class="cp-label">Moneda</label><div class="cp-input cp-ro">${cpEsc(fc.currency)}</div></div>
	</div><div class="cp-muted" style="margin-top:8px;">El encabezado se puede corregir en el formulario.</div></div>
	<div class="cp-card">
		<div class="cp-card-head"><div class="cp-section-title" style="margin:0;">Líneas (${rows.length})</div>
			<div class="${bad ? "cp-text-bad" : "cp-text-ok"}">${bad ? `${bad} línea(s) con error` : "✓ Todas las líneas son válidas"}</div></div>
		<table class="cp-table cp-cards cp-lines">
			<thead><tr><th style="width:28px;"></th><th>Producto</th><th class="cp-num" style="width:90px;">Cant.</th><th class="cp-num" style="width:120px;">Precio</th><th style="width:180px;">Bodega</th><th style="width:36px;"></th></tr></thead>
			<tbody>${rows.map(({ it, errs }, idx) => `
				<tr data-idx="${idx}" class="${errs.length ? "cp-row-bad" : ""}">
					<td data-label="Estado">${errs.length ? `<span class="cp-text-bad" title="${cpEsc(errs.join(" / "))}">✗</span>` : `<span class="cp-text-ok">✓</span>`}</td>
					<td data-label="Producto" class="cp-cell-product"><div class="cp-strong">${cpEsc(it.item_code)}</div><div class="cp-muted">${cpEsc(it.item_name || "")}</div>
						${it.has_serial_no ? `<textarea class="cp-input cp-mono cp-s-serial" rows="2">${cpEsc(it.serial_no || "")}</textarea>` : ""}
						${it.has_batch_no ? `<input type="text" class="cp-input cp-mono cp-s-batch" placeholder="Lote" value="${cpEsc(it.batch_no || "")}">` : ""}
						${errs.length ? `<div class="cp-text-bad cp-small">${errs.map(cpEsc).join(" · ")}</div>` : ""}</td>
					<td data-label="Cantidad" class="cp-num">${it.has_serial_no ? `<b>${cpFlt(it.qty)}</b>` : `<input type="number" class="cp-input cp-num cp-s-qty" value="${cpFlt(it.qty)}" min="0" step="any">`}</td>
					<td data-label="Precio" class="cp-num"><input type="number" class="cp-input cp-num cp-s-rate" value="${cpFlt(it.rate)}" min="0" step="any"></td>
					<td data-label="Bodega">${it.is_stock_item ? `<select class="cp-input cp-s-wh"><option value="">Bodega...</option>${whs.map((w) => `<option${w === it.warehouse ? " selected" : ""}>${cpEsc(w)}</option>`).join("")}</select>` : `<span class="cp-muted">—</span>`}</td>
					<td class="cp-cell-del"><button type="button" class="cp-del cp-s-del" title="Quitar">×</button></td>
				</tr>`).join("")}</tbody>
		</table>
	</div>
	<div class="cp-actionbar">
		<button type="button" class="cp-btn cp-btn-secondary" id="cp-stg-recheck">Revalidar</button>
		<span class="cp-spacer"></span>
		<button type="button" class="cp-btn cp-btn-primary" id="cp-stg-ok" ${bad || !rows.length ? "disabled" : ""}>Pasar al formulario</button>
	</div>
</div>`);

		const $b = this.$body;
		$b.off();
		const line = (e) => fc.items[parseInt($(e.target).closest("[data-idx]").data("idx"))];
		$b.on("click", "#cp-stg-back", () => this._internal_back());
		$b.on("input", ".cp-s-qty", (e) => { line(e).qty = cpFlt(e.target.value); });
		$b.on("input", ".cp-s-rate", (e) => { line(e).rate = cpFlt(e.target.value); });
		$b.on("change", ".cp-s-wh", (e) => { line(e).warehouse = e.target.value; });
		$b.on("input", ".cp-s-batch", (e) => { line(e).batch_no = e.target.value.trim(); });
		$b.on("input", ".cp-s-serial", (e) => {
			const it = line(e);
			const serials = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
			it.serial_no = serials.join("\n");
			it.qty = serials.length;
		});
		$b.on("click", ".cp-s-del", (e) => {
			fc.items.splice(parseInt($(e.currentTarget).closest("[data-idx]").data("idx")), 1);
			this._paint_staging();
		});
		$b.on("click", "#cp-stg-recheck", () => this._paint_staging());
		$b.on("click", "#cp-stg-ok", () => {
			if (fc.items.some((it) => this._stg_row_errors(it).length)) {
				this._paint_staging();
				return;
			}
			this._go("form", { kind: "fc", pending: fc });
			this.dirty = true;
			frappe.show_alert({ message: `${fc.items.length} línea(s) importadas. Revise el encabezado y grabe.`, indicator: "green" });
		});
	}

	_stg_row_errors(it) {
		const errs = [];
		if (cpFlt(it.rate) <= 0) errs.push("Precio debe ser > 0");
		if (it.has_serial_no && !cpFlt(it.qty)) errs.push("Requiere series");
		else if (cpFlt(it.qty) <= 0) errs.push("Cantidad debe ser > 0");
		if (it.has_batch_no && !(it.batch_no || "").trim()) errs.push("Requiere lote");
		if (it.is_stock_item && !it.warehouse) errs.push("Bodega requerida");
		return errs;
	}

	// ──────────────────────────────────────────────
	// Autocompletado genérico (proveedores / productos)
	// ──────────────────────────────────────────────

	_bind_supplier_ac($input, opts = {}) {
		this._bind_ac($input, {
			method: "facex_multi.api.compras.facturas.search_suppliers",
			render: (s) => `<div class="cp-strong">${cpEsc(s.label)}</div><div class="cp-muted">${cpEsc(s.value)}${s.tax_id ? ` · NIT ${cpEsc(s.tax_id)}` : ""}</div>`,
			on_pick: (s) => {
				$input.val(s.label).attr("data-value", s.value);
				if (opts.on_pick) opts.on_pick(s);
			},
		});
		// Escribir invalida la selección previa hasta elegir de nuevo.
		$input.on("input", () => $input.attr("data-value", ""));
	}

	_bind_ac($input, { method, render, on_pick }) {
		const $wrap = $input.closest(".cp-ac");
		const $dd = $(`<div class="cp-ac-list"></div>`).appendTo($wrap);
		let timer = null;
		let seq = 0;
		$input.attr("autocomplete", "off").on("input focus", () => {
			const txt = $input.val().trim();
			clearTimeout(timer);
			if (!txt) { $dd.hide(); return; }
			timer = setTimeout(() => {
				const my = ++seq;
				frappe.call({
					method,
					args: { txt, company: this.company },
					callback: (r) => {
						if (my !== seq) return;
						const list = r.message || [];
						if (!list.length) {
							$dd.html(`<div class="cp-ac-none">Sin resultados</div>`).show();
							return;
						}
						$dd.html(list.map((x, i) => `<div class="cp-ac-item" data-i="${i}">${render(x)}</div>`).join("")).show();
						$dd.find(".cp-ac-item").on("mousedown", (e) => {
							e.preventDefault();
							on_pick(list[parseInt($(e.currentTarget).data("i"))]);
							$dd.hide();
						});
					},
				});
			}, 250);
		});
		$input.on("blur", () => setTimeout(() => $dd.hide(), 150));
	}
}

// Modo Enfoque (oculta navbar/sidebar del Desk) — mismo bloque que FacEx /
// Inventario; cada Page carga su copia porque cada una tiene su <style>.
const CP_STYLES = `
body.facex-fullscreen-mode .navbar,
body.facex-fullscreen-mode .page-head,
body.facex-fullscreen-mode .layout-side-section,
body.facex-fullscreen-mode .standard-sidebar-wrapper,
body.facex-fullscreen-mode .standard-sidebar,
body.facex-fullscreen-mode .desk-sidebar,
body.facex-fullscreen-mode .sidebar-left,
body.facex-fullscreen-mode .left-sidebar,
body.facex-fullscreen-mode .sidebar,
body.facex-fullscreen-mode .page-sidebar,
body.facex-fullscreen-mode .body-sidebar-container,
body.facex-fullscreen-mode .body-sidebar,
body.facex-fullscreen-mode .footer {
  display: none !important; width: 0 !important; min-width: 0 !important; max-width: 0 !important;
  margin: 0 !important; padding: 0 !important;
}
body.facex-fullscreen-mode .layout-main-section,
body.facex-fullscreen-mode .page-content,
body.facex-fullscreen-mode .page-container,
body.facex-fullscreen-mode .layout-main,
body.facex-fullscreen-mode .page-body,
body.facex-fullscreen-mode .workspace-layout,
body.facex-fullscreen-mode .layout-container,
body.facex-fullscreen-mode #space-layout,
body.facex-fullscreen-mode .main-section {
  width: 100% !important; max-width: 100% !important; margin: 0 !important; padding: 0 !important;
  display: block !important;
}

.cp-topbar { position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;border-bottom:1px solid #d1d8dd;padding:10px 20px; }
.cp-logo { display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;color:#153375;background:none;border:none;padding:0;cursor:pointer; }
.cp-logo-sub { font-weight:600;font-size:13px;color:#6c757d; }
.cp-topbar-right { display:flex;align-items:center;gap:10px; }
.cp-topbar-links { display:flex;gap:4px; }
.cp-topbar-link { display:block;padding:6px 10px;border-radius:4px;font-size:13px;font-weight:500;color:#495057;text-decoration:none; }
.cp-topbar-link:hover { background:#f1f5f9;color:#153375;text-decoration:none; }
.cp-menu-links .cp-topbar-link { padding:8px 6px; }
.cp-menu-links { display:none; }
.cp-user { position:relative; }
.cp-user-btn { padding:6px 10px;border-radius:20px;background:#f1f5f9;border:1px solid #cbd5e1;display:flex;align-items:center;cursor:pointer; }
.cp-user-menu { display:none;position:absolute;top:120%;right:0;width:250px;max-width:calc(100vw - 24px);background:#fff;border:1px solid #d1d8dd;border-radius:10px;box-shadow:0 10px 15px -3px rgba(0,0,0,.1);padding:14px;z-index:1001; }
.cp-menu-label { font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6c757d;margin-bottom:4px; }
.cp-user-name { font-size:14px;font-weight:700;color:#0f172a; }
.cp-user-email { font-size:12px;color:#6c757d;margin-bottom:12px;word-break:break-all; }
.cp-block { display:block;width:100%;margin-bottom:8px; }

.cp-wrap { max-width:1200px;margin:0 auto;padding:16px; }
.cp-has-actionbar { padding-bottom:24px; }
.cp-h1 { font-size:20px;font-weight:800;color:#153375;display:flex;align-items:center;gap:10px;flex-wrap:wrap; }
.cp-muted { color:#6c757d;font-size:12.5px; }
.cp-strong { font-weight:700;color:#1e293b; }
.cp-small { font-size:11.5px; }
.cp-mono { font-family:monospace;font-size:12px; }
.cp-section-title { font-size:12px;font-weight:700;color:#6c757d;text-transform:uppercase;letter-spacing:.5px;margin:18px 0 10px; }
.cp-card { background:#fff;border:1px solid #d1d8dd;border-radius:8px;padding:16px;margin-bottom:14px; }
.cp-card-head { display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap; }
.cp-empty { padding:32px 16px;text-align:center;color:#6c757d; }
.cp-page-head { display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px; }
.cp-head-actions { margin-left:auto;display:flex;gap:8px;flex-wrap:wrap; }
.cp-head-meta { flex-basis:100%; }
.cp-back { background:none;border:1px solid #d1d8dd;border-radius:6px;padding:6px 12px;font-size:13px;color:#475569;cursor:pointer; }
.cp-back:hover { background:#f1f5f9; }
.cp-hub-head { display:flex;align-items:center;justify-content:space-between;margin-bottom:6px; }
.cp-hub-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px; }
.cp-hub-card { text-align:left;background:#fff;border:1px solid #d1d8dd;border-radius:8px;padding:18px 20px;cursor:pointer;transition:box-shadow .15s,border-color .15s; }
.cp-hub-card:hover { box-shadow:0 2px 10px rgba(0,0,0,.08);border-color:#153375; }
.cp-hub-title { font-size:15px;font-weight:700;color:#1e293b;margin-bottom:4px; }
.cp-hub-desc { font-size:12.5px;color:#6c757d;line-height:1.4; }
.cp-hub-tag { margin-top:10px;font-size:12px;font-weight:600;color:#153375; }

.cp-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px; }
.cp-filters { display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;align-items:end; }
.cp-field-wide { grid-column:span 2; }
.cp-label { display:block;font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px; }
.cp-sub-label { margin-top:8px; }
.cp-input { width:100%;box-sizing:border-box;padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13.5px;background:#fff;color:#1e293b;min-height:36px; }
.cp-input:focus { outline:none;border-color:#153375;box-shadow:0 0 0 2px rgba(21,51,117,.15); }
.cp-input:disabled { background:#f8fafc;color:#475569; }
.cp-ro { background:#f8fafc; }
.cp-num { text-align:right; }
input.cp-num { max-width:120px;margin-left:auto;display:block; }

.cp-btn { display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border-radius:6px;border:1px solid transparent;font-size:13.5px;font-weight:600;cursor:pointer;text-decoration:none;min-height:38px; }
.cp-btn:hover { text-decoration:none; }
.cp-btn:disabled { opacity:.5;cursor:not-allowed; }
.cp-btn-primary { background:#153375;color:#fff; }
.cp-btn-primary:hover:not(:disabled) { background:#0f2657;color:#fff; }
.cp-btn-secondary { background:#eef2f7;color:#1e293b;border-color:#d1d8dd; }
.cp-btn-secondary:hover:not(:disabled) { background:#e2e8f0; }
.cp-btn-danger { background:#fff;color:#b91c1c;border-color:#fca5a5; }
.cp-btn-danger:hover:not(:disabled) { background:#fef2f2; }
.cp-btn-ghost { background:none;color:#475569; }
.cp-btn-ghost:hover { background:#f1f5f9;color:#1e293b; }
.cp-badge { display:inline-block;padding:2px 10px;border-radius:20px;font-size:11.5px;font-weight:700;white-space:nowrap; }
.cp-tag { display:inline-block;font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;background:#eef2f7;color:#475569;margin-left:4px; }

.cp-table-card { padding:0;overflow:hidden; }
.cp-table { width:100%;border-collapse:collapse;font-size:13px; }
.cp-table th { background:#f8f9fa;border-bottom:2px solid #dee2e6;padding:9px 10px;text-align:left;font-size:11px;color:#495057;text-transform:uppercase;letter-spacing:.4px;font-weight:700; }
.cp-table th.cp-num { text-align:right; }
.cp-table td { border-bottom:1px solid #f0f0f0;padding:8px 10px;vertical-align:top; }
.cp-row-link { cursor:pointer; }
.cp-row-link:hover td { background:#f5f8ff; }
.cp-row-bad td { background:#fff5f5; }
.cp-uom { display:block;font-size:11px;margin-top:2px; }
.cp-del { background:none;border:none;color:#b91c1c;font-size:20px;line-height:1;cursor:pointer;padding:2px 6px; }
.cp-list-foot { padding:10px 14px;font-size:12.5px;color:#475569;border-top:1px solid #eef2f7;background:#fafbfc; }
.cp-totals { max-width:360px;margin-left:auto; }
.cp-total-row { display:flex;justify-content:space-between;padding:4px 0;font-size:13.5px;color:#334155; }
.cp-total-grand { font-size:17px;font-weight:800;color:#153375;border-top:1px solid #e2e8f0;margin-top:4px;padding-top:8px; }
.cp-actionbar { display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:#fff;border:1px solid #d1d8dd;border-radius:8px;padding:10px 12px; }
.cp-spacer { flex:1; }
.cp-alert { border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px; }
.cp-alert-warn { background:#fffbeb;border:1px solid #fde68a;color:#92400e; }
.cp-text-bad { color:#b91c1c;font-weight:600; }
.cp-text-ok { color:#047857;font-weight:600; }
.cp-help { font-size:12.5px;color:#475569;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px;margin-bottom:10px; }
.cp-picked { margin-top:8px;padding:8px 10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;font-size:12.5px;color:#0c4a6e; }

.cp-ac { position:relative; }
.cp-ac-list { display:none;position:absolute;top:100%;left:0;right:0;z-index:1050;background:#fff;border:1px solid #cbd5e1;border-radius:6px;box-shadow:0 6px 16px rgba(0,0,0,.12);max-height:260px;overflow-y:auto;margin-top:2px; }
.cp-ac-item { padding:8px 12px;cursor:pointer;border-bottom:1px solid #f1f5f9; }
.cp-ac-item:hover { background:#f5f8ff; }
.cp-ac-none { padding:10px 12px;color:#6c757d;font-size:12.5px; }

.cp-hub-card { position:relative; }
.cp-hub-step { position:absolute;top:14px;right:16px;width:24px;height:24px;border-radius:50%;background:#eef2f7;color:#153375;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center; }
.cp-alert-info { background:#f0f9ff;border:1px solid #bae6fd;color:#0c4a6e; }
.cp-related { display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px; }
.cp-chip { display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #d1d8dd;border-radius:20px;padding:4px 6px 4px 10px;font-size:12.5px;font-weight:600;color:#1e293b;cursor:pointer; }
.cp-chip:hover { border-color:#153375;background:#f5f8ff; }
.cp-chip-kind { font-size:10.5px;font-weight:700;color:#6c757d;text-transform:uppercase; }

/* ── Móvil ─────────────────────────────────────────────── */
@media (max-width: 720px) {
  .cp-topbar { padding:8px 12px; }
  .cp-topbar-links { display:none; }
  .cp-menu-links { display:block; }
  .cp-wrap { padding:12px; }
  .cp-has-actionbar { padding-bottom:88px; }
  .cp-h1 { font-size:18px; }
  .cp-field-wide { grid-column:auto; }
  .cp-grid, .cp-filters { grid-template-columns:1fr 1fr; }
  .cp-grid .cp-field-wide, .cp-filters .cp-field-wide, .cp-filters .cp-field-btn { grid-column:1 / -1; }
  .cp-head-actions { margin-left:0;width:100%; }
  .cp-head-actions .cp-btn { flex:1; }
  .cp-totals { max-width:none; }

  /* Tablas → tarjetas: cada fila es una tarjeta, cada celda "Etiqueta  valor". */
  .cp-cards thead { display:none; }
  .cp-cards, .cp-cards tbody, .cp-cards tr, .cp-cards td { display:block;width:100%; }
  .cp-table-card { background:none;border:none; }
  .cp-cards tr { position:relative;background:#fff;border:1px solid #d1d8dd;border-radius:8px;margin-bottom:10px;padding:8px 12px; }
  .cp-lines tr { padding-right:36px; }
  .cp-cards td { border:none;padding:4px 0;display:flex;justify-content:space-between;align-items:center;gap:12px;text-align:right; }
  .cp-cards td::before { content:attr(data-label);font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;letter-spacing:.3px;text-align:left;flex-shrink:0; }
  .cp-cards td.cp-cell-product { display:block;text-align:left; }
  .cp-cards td.cp-cell-product::before { display:none; }
  .cp-cards td.cp-cell-del { position:absolute;top:6px;right:4px;width:auto;padding:0; }
  .cp-cards td.cp-cell-del::before { display:none; }
  .cp-cards td[data-label="#"] { display:none; }
  .cp-cards td select.cp-input { max-width:60%; }
  .cp-cards td input.cp-num { max-width:140px; }
  .cp-uom { display:inline;margin-left:6px; }
  .cp-list-foot { background:none;border:none;padding:4px 2px; }

  /* Acciones fijas abajo, al alcance del pulgar. */
  .cp-actionbar { position:fixed;left:0;right:0;bottom:0;z-index:90;border-radius:0;border-width:1px 0 0;padding:10px 12px calc(10px + env(safe-area-inset-bottom));box-shadow:0 -4px 12px rgba(0,0,0,.06); }
  .cp-actionbar .cp-spacer { display:none; }
  .cp-actionbar .cp-btn { flex:1 1 auto; }
}
`;
