// FacEx Multi — Módulo de Compras (ciclo de compra estilo SAP B1)
// Interfaz sobre los documentos nativos de ERPNext (Purchase Invoice, y en
// fases siguientes Purchase Order / Purchase Receipt / devoluciones). Toda la
// lógica contable y de stock permanece en ERPNext core; el backend vive en
// facex_multi.api.compras.
//
// Vistas internas (una sola a la vez, dentro de #cp-content-root):
//   hub        tarjetas de documentos / reportes según permisos
//   fc-list    lista de Facturas de Compra
//   fc-form    formulario de Factura de Compra
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

// Documentos del ciclo de compra. Cada fase agrega su tarjeta aquí.
const CP_DOCS = [
	{ key: "puede_compras", view: "fc-list", title: "Facturas de Compra",
	  desc: "Registrar facturas de proveedores. Al validarlas ingresan el inventario y la cuenta por pagar." },
];

// Status nativo de Purchase Invoice → etiqueta + color.
const CP_PI_STATUS = {
	"Draft": ["Borrador", "#b45309", "#fef3c7"],
	"Unpaid": ["Pendiente de pago", "#1d4ed8", "#dbeafe"],
	"Overdue": ["Vencida", "#b91c1c", "#fee2e2"],
	"Partly Paid": ["Pago parcial", "#7c3aed", "#ede9fe"],
	"Paid": ["Pagada", "#047857", "#d1fae5"],
	"Return": ["Nota de crédito", "#475569", "#e2e8f0"],
	"Debit Note Issued": ["Con nota de crédito", "#475569", "#e2e8f0"],
	"Submitted": ["Validada", "#047857", "#d1fae5"],
	"Cancelled": ["Cancelada", "#6b7280", "#f3f4f6"],
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

function cpStatusBadge(status, docstatus) {
	const key = status || (docstatus === 2 ? "Cancelled" : docstatus === 1 ? "Submitted" : "Draft");
	const [label, color, bg] = CP_PI_STATUS[key] || [key, "#475569", "#e2e8f0"];
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
		this.dirty = false;
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
		const target = this.view === "fc-list" ? "hub" : "fc-list";
		if (this.dirty) {
			frappe.confirm("Hay cambios sin guardar. ¿Desea salir de todos modos?", () => {
				this.dirty = false;
				this._go(target);
			});
			return true;
		}
		this._go(target);
		return true;
	}

	_go(view, arg) {
		this.view = view;
		this.dirty = false;
		this.$body.off();
		$(document).off(".cpView");
		window.scrollTo(0, 0);
		if (view === "hub") this._render_hub();
		else if (view === "fc-list") this._render_fc_list();
		else if (view === "fc-form") this._render_fc_form(arg);
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
				const params = new URLSearchParams(window.location.search);
				const factura = params.get("factura");
				if (factura && (this.defaults.permissions || {}).puede_compras) {
					this._go("fc-form", factura);
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
		const card = (c) => `
			<button type="button" class="cp-hub-card" data-view="${c.view}">
				<div class="cp-hub-title">${cpEsc(c.title)}</div>
				<div class="cp-hub-desc">${cpEsc(c.desc)}</div>
				<div class="cp-hub-tag">Abrir →</div>
			</button>`;
		this.$body.html(`
<div class="cp-wrap">
	<div class="cp-hub-head">
		<div>
			<div class="cp-h1">Compras</div>
			<div class="cp-muted">${cpEsc(this.company)}${this.perms.alcance_compras ? ` · Alcance: ${cpEsc(this.perms.alcance_compras)}` : ""}</div>
		</div>
	</div>
	<div class="cp-section-title">Documentos</div>
	<div class="cp-hub-grid">${CP_DOCS.filter((c) => this.perms[c.key]).map(card).join("")}</div>
</div>`);
		this.$body.on("click", ".cp-hub-card", (e) => this._go($(e.currentTarget).data("view")));
	}

	// ──────────────────────────────────────────────
	// Facturas de Compra — lista
	// ──────────────────────────────────────────────

	_render_fc_list() {
		const f = this._fc_filters || {
			start_date: frappe.datetime.month_start(),
			end_date: frappe.datetime.get_today(),
			supplier: "", supplier_label: "", docstatus: "",
		};
		this._fc_filters = f;
		this.$body.html(`
<div class="cp-wrap">
	<div class="cp-page-head">
		<button type="button" class="cp-back" data-back="hub">← Compras</button>
		<div class="cp-h1">Facturas de Compra</div>
		<div class="cp-head-actions">
			<button type="button" class="cp-btn cp-btn-secondary" id="cp-fc-excel">Subir Excel</button>
			<button type="button" class="cp-btn cp-btn-primary" id="cp-fc-new">+ Nueva</button>
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
				<option value="0"${f.docstatus === "0" ? " selected" : ""}>Borrador</option>
				<option value="1"${f.docstatus === "1" ? " selected" : ""}>Validada</option>
				<option value="2"${f.docstatus === "2" ? " selected" : ""}>Cancelada</option>
			</select></div>
		<div class="cp-field cp-field-btn"><button type="button" class="cp-btn cp-btn-secondary cp-block" id="cp-f-apply">Filtrar</button></div>
	</div>
	<div id="cp-fc-list"></div>
</div>`);

		this.$body.on("click", "[data-back]", () => this._go("hub"));
		this.$body.on("click", "#cp-fc-new", () => this._go("fc-form", null));
		this.$body.on("click", "#cp-fc-excel", () => this._excel_dialog());
		this.$body.on("click", "#cp-f-apply", () => this._load_fc_list());
		this.$body.on("click", "tr[data-name]", (e) => this._go("fc-form", $(e.currentTarget).data("name")));
		this._bind_supplier_ac(this.$body.find("#cp-f-supplier"), { allow_empty: true });
		this._load_fc_list();
	}

	_load_fc_list() {
		const $s = this.$body.find("#cp-f-supplier");
		const f = this._fc_filters;
		f.start_date = this.$body.find("#cp-f-start").val();
		f.end_date = this.$body.find("#cp-f-end").val();
		f.supplier = $s.val().trim() ? ($s.attr("data-value") || "") : "";
		f.supplier_label = f.supplier ? $s.val() : "";
		f.docstatus = this.$body.find("#cp-f-status").val();
		const $list = this.$body.find("#cp-fc-list").html(`<div class="cp-empty">Cargando...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.facturas.get_purchase_list",
			args: { company: this.company, start_date: f.start_date, end_date: f.end_date, supplier: f.supplier, docstatus: f.docstatus },
			callback: (r) => {
				const rows = r.message || [];
				if (!rows.length) {
					$list.html(`<div class="cp-card cp-empty">Sin facturas de compra con estos filtros.</div>`);
					return;
				}
				const total = rows.filter((x) => x.docstatus === 1).reduce((s, x) => s + cpFlt(x.grand_total), 0);
				const saldo = rows.filter((x) => x.docstatus === 1).reduce((s, x) => s + cpFlt(x.outstanding_amount), 0);
				$list.html(`
<div class="cp-card cp-table-card">
	<table class="cp-table cp-cards">
		<thead><tr>
			<th>Documento</th><th>Proveedor</th><th>Fecha</th><th>No. Factura Prov.</th>
			<th class="cp-num">Total</th><th class="cp-num">Saldo</th><th>Estado</th>
		</tr></thead>
		<tbody>${rows.map((x) => `
			<tr data-name="${cpEsc(x.name)}" class="cp-row-link">
				<td data-label="Documento" class="cp-strong">${cpEsc(x.name)}</td>
				<td data-label="Proveedor">${cpEsc(x.supplier_name || x.supplier)}</td>
				<td data-label="Fecha">${cpDate(x.posting_date)}</td>
				<td data-label="No. Factura Prov.">${cpEsc(x.bill_no || "")}</td>
				<td data-label="Total" class="cp-num cp-strong">${cpMoney(x.grand_total, x.currency)}</td>
				<td data-label="Saldo" class="cp-num">${x.docstatus === 1 ? cpMoney(x.outstanding_amount, x.currency) : "—"}</td>
				<td data-label="Estado">${cpStatusBadge(x.status, x.docstatus)}</td>
			</tr>`).join("")}
		</tbody>
	</table>
	<div class="cp-list-foot">${rows.length} documento(s) · Validadas: <b>${cpMoney(total)}</b> · Saldo: <b>${cpMoney(saldo)}</b></div>
</div>`);
			},
		});
	}

	// ──────────────────────────────────────────────
	// Facturas de Compra — formulario
	// ──────────────────────────────────────────────

	_empty_fc(overrides) {
		const d = this.defaults;
		return Object.assign({
			name: null, docstatus: 0, status: "", owner_fullname: "",
			supplier: "", supplier_name: "",
			posting_date: d.today, bill_no: "", bill_date: d.today,
			currency: d.currency || "GTQ",
			tax_type: d.default_tax_template || "",
			bfel_multi_tipo: "",
			items: [],
		}, overrides || {});
	}

	_render_fc_form(name) {
		if (!name) {
			this.fc = this.fc_pending || this._empty_fc();
			this.fc_pending = null;
			this._paint_fc_form();
			if (this.fc.items.length) this.dirty = true;
			return;
		}
		this.$body.html(`<div class="cp-empty">Cargando factura...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.facturas.get_purchase_invoice",
			args: { name, company: this.company },
			callback: (r) => {
				if (!r.message) return;
				const d = r.message;
				this.fc = this._empty_fc({
					name: d.name, docstatus: d.docstatus, status: d.status, owner_fullname: d.owner_fullname,
					supplier: d.supplier, supplier_name: d.supplier_name || d.supplier,
					posting_date: d.posting_date, bill_no: d.bill_no || "", bill_date: d.bill_date || d.posting_date,
					currency: d.currency, tax_type: d.taxes_and_charges || "",
					bfel_multi_tipo: d.bfel_multi_tipo || "",
					grand_total: d.grand_total, total_taxes_and_charges: d.total_taxes_and_charges,
					net_total: d.net_total, outstanding_amount: d.outstanding_amount,
					items: (d.items || []).map((it) => ({
						item_code: it.item_code, item_name: it.item_name || it.item_code,
						has_serial_no: it.has_serial_no, has_batch_no: it.has_batch_no, is_stock_item: it.is_stock_item,
						uom: it.uom, qty: it.qty, rate: it.rate, warehouse: it.warehouse || "",
						bfel_multi_tipo: it.bfel_multi_tipo || "",
						serial_no: it.serial_no || "", batch_no: it.batch_no || "",
					})),
				});
				this._paint_fc_form();
			},
			error: () => this._go("fc-list"),
		});
	}

	_paint_fc_form() {
		const fc = this.fc;
		const p = this.perms;
		const editable = fc.docstatus === 0;
		const dis = editable ? "" : "disabled";
		const templates = this.defaults.tax_templates || [];
		const taxOptions = templates.length
			? templates.map((t) => `<option value="${cpEsc(t.name)}"${t.name === fc.tax_type ? " selected" : ""}>${cpEsc(t.name)} (${cpFlt(t.rate)}%)</option>`).join("")
			: `<option value="">Sin plantilla de impuestos configurada</option>`;
		const currencies = this.defaults.currencies || ["GTQ"];
		if (fc.currency && !currencies.includes(fc.currency)) currencies.push(fc.currency);
		const title = fc.name ? fc.name : "Nueva Factura de Compra";

		this.$body.html(`
<div class="cp-wrap cp-has-actionbar">
	<div class="cp-page-head">
		<button type="button" class="cp-back" id="cp-fc-back">← Facturas</button>
		<div class="cp-h1">${cpEsc(title)} ${fc.name ? cpStatusBadge(fc.status, fc.docstatus) : `<span class="cp-badge" style="color:#1d4ed8;background:#dbeafe;">Nueva</span>`}</div>
		${fc.owner_fullname ? `<div class="cp-muted cp-head-meta">Elaborado por <b>${cpEsc(fc.owner_fullname)}</b></div>` : ""}
	</div>

	<div class="cp-card">
		<div class="cp-grid">
			<div class="cp-field cp-field-wide"><label class="cp-label">Proveedor *</label>
				<div class="cp-ac"><input type="text" class="cp-input" id="cp-h-supplier" placeholder="Buscar por nombre, código o NIT..." value="${cpEsc(fc.supplier_name || fc.supplier)}" data-value="${cpEsc(fc.supplier)}" ${dis}></div></div>
			<div class="cp-field"><label class="cp-label">No. Factura Proveedor *</label>
				<input type="text" class="cp-input" id="cp-h-bill-no" value="${cpEsc(fc.bill_no)}" placeholder="Serie - número" ${dis}></div>
			<div class="cp-field"><label class="cp-label">Fecha Factura *</label>
				<input type="date" class="cp-input" id="cp-h-bill-date" value="${cpEsc(fc.bill_date)}" ${dis}></div>
			<div class="cp-field"><label class="cp-label">Fecha de Registro</label>
				<input type="date" class="cp-input" id="cp-h-posting-date" value="${cpEsc(fc.posting_date)}" ${dis}></div>
			<div class="cp-field"><label class="cp-label">Moneda</label>
				<select class="cp-input" id="cp-h-currency" ${dis}>${currencies.map((c) => `<option${c === fc.currency ? " selected" : ""}>${cpEsc(c)}</option>`).join("")}</select></div>
			<div class="cp-field"><label class="cp-label">Tipo de Compra</label>
				<select class="cp-input" id="cp-h-tax" ${dis}>${taxOptions}</select></div>
			<div class="cp-field"><label class="cp-label">Tipo FEL</label>
				<select class="cp-input" id="cp-h-tipo" ${dis}>${cpTipoOptions(fc.bfel_multi_tipo)}</select></div>
		</div>
	</div>

	<div class="cp-card">
		<div class="cp-card-head">
			<div class="cp-section-title" style="margin:0;">Productos</div>
			${editable ? `<button type="button" class="cp-btn cp-btn-secondary" id="cp-fc-add">+ Agregar producto</button>` : ""}
		</div>
		<div id="cp-fc-items"></div>
	</div>

	<div class="cp-card cp-totals" id="cp-fc-totals"></div>

	<div class="cp-actionbar">
		${fc.name ? `<a class="cp-btn cp-btn-ghost" href="/app/purchase-invoice/${encodeURIComponent(fc.name)}" target="_blank">Abrir en ERP</a>` : ""}
		${fc.name && editable && p.puede_compras ? `<button type="button" class="cp-btn cp-btn-danger" id="cp-fc-delete">Eliminar</button>` : ""}
		${fc.docstatus === 1 && p.puede_cancelar_compras ? `<button type="button" class="cp-btn cp-btn-danger" id="cp-fc-cancel">Cancelar Factura</button>` : ""}
		<span class="cp-spacer"></span>
		${editable && p.puede_compras ? `<button type="button" class="cp-btn cp-btn-secondary" id="cp-fc-save">Grabar Borrador</button>` : ""}
		${editable && p.puede_validar_compras ? `<button type="button" class="cp-btn cp-btn-primary" id="cp-fc-submit">Validar</button>` : ""}
	</div>
</div>`);

		this._render_fc_items();
		this._bind_fc_form();
	}

	_bind_fc_form() {
		const $b = this.$body;
		$b.on("click", "#cp-fc-back", () => this._internal_back());
		$b.on("click", "#cp-fc-add", () => this._add_item_dialog());
		$b.on("click", "#cp-fc-save", () => this._save_fc(false));
		$b.on("click", "#cp-fc-submit", () => this._save_fc(true));
		$b.on("click", "#cp-fc-cancel", () => this._cancel_fc());
		$b.on("click", "#cp-fc-delete", () => this._delete_fc());

		if (this.fc.docstatus !== 0) return;
		this._bind_supplier_ac($b.find("#cp-h-supplier"), {
			on_pick: (s) => { this.fc.supplier = s.value; this.fc.supplier_name = s.label; this.dirty = true; },
		});
		$b.on("change input", "#cp-h-bill-no,#cp-h-bill-date,#cp-h-posting-date,#cp-h-currency,#cp-h-tax,#cp-h-tipo", () => {
			this._read_fc_header();
			this.dirty = true;
			this._render_fc_totals();
		});

		// Líneas: delegación sobre el contenedor (sobrevive a los re-render).
		const line = (e) => this.fc.items[parseInt($(e.target).closest("[data-idx]").data("idx"))];
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
			this.fc.items.splice(parseInt($(e.currentTarget).closest("[data-idx]").data("idx")), 1);
			this.dirty = true;
			this._render_fc_items();
		});
	}

	_line_changed(e, it) {
		this.dirty = true;
		$(e.target).closest("[data-idx]").find(".cp-l-amount").text(cpMoney(cpFlt(it.qty) * cpFlt(it.rate), this.fc.currency));
		this._render_fc_totals();
	}

	_read_fc_header() {
		const $b = this.$body;
		const fc = this.fc;
		const $s = $b.find("#cp-h-supplier");
		// Solo cuenta un proveedor elegido de la lista (data-value); texto
		// libre sin elegir deja el campo vacío para que la validación lo marque.
		fc.supplier = $s.val().trim() ? ($s.attr("data-value") || "") : "";
		fc.supplier_name = fc.supplier ? $s.val().trim() : "";
		fc.bill_no = ($b.find("#cp-h-bill-no").val() || "").trim();
		fc.bill_date = $b.find("#cp-h-bill-date").val();
		fc.posting_date = $b.find("#cp-h-posting-date").val();
		fc.currency = $b.find("#cp-h-currency").val();
		fc.tax_type = $b.find("#cp-h-tax").val() || "";
		fc.bfel_multi_tipo = $b.find("#cp-h-tipo").val() || "";
	}

	_render_fc_items() {
		const fc = this.fc;
		const editable = fc.docstatus === 0;
		const dis = editable ? "" : "disabled";
		const whs = this.defaults.warehouses || [];
		const $c = this.$body.find("#cp-fc-items");
		if (!fc.items.length) {
			$c.html(`<div class="cp-empty">${editable ? "Use <b>+ Agregar producto</b> para comenzar." : "Sin productos."}</div>`);
			this._render_fc_totals();
			return;
		}
		$c.html(`
<table class="cp-table cp-cards cp-lines">
	<thead><tr>
		<th style="width:32px;">#</th><th>Producto</th><th class="cp-num" style="width:90px;">Cant.</th>
		<th class="cp-num" style="width:120px;">Precio Unit.</th><th class="cp-num" style="width:120px;">Total</th>
		<th style="width:170px;">Bodega</th><th style="width:150px;">Tipo FEL</th><th style="width:36px;"></th>
	</tr></thead>
	<tbody>${fc.items.map((it, idx) => {
		const whOptions = [`<option value="">Bodega...</option>`]
			.concat(whs.map((w) => `<option value="${cpEsc(w)}"${w === it.warehouse ? " selected" : ""}>${cpEsc(w)}</option>`))
			.concat(it.warehouse && !whs.includes(it.warehouse) ? [`<option selected>${cpEsc(it.warehouse)}</option>`] : [])
			.join("");
		return `
		<tr data-idx="${idx}">
			<td data-label="#" class="cp-muted">${idx + 1}</td>
			<td data-label="Producto" class="cp-cell-product">
				<div class="cp-strong">${cpEsc(it.item_code)}</div>
				<div class="cp-muted">${cpEsc(it.item_name || "")}${it.is_stock_item ? "" : ` · <i>sin inventario</i>`}</div>
				${it.has_serial_no ? `<label class="cp-label cp-sub-label">Series (una por línea)</label>
					<textarea class="cp-input cp-l-serial cp-mono" rows="3" ${dis}>${cpEsc(it.serial_no || "")}</textarea>` : ""}
				${it.has_batch_no ? `<label class="cp-label cp-sub-label">Lote del proveedor</label>
					<input type="text" class="cp-input cp-l-batch cp-mono" value="${cpEsc(it.batch_no || "")}" ${dis}>` : ""}
			</td>
			<td data-label="Cantidad" class="cp-num">${it.has_serial_no
				? `<span class="cp-strong cp-l-qty-ro">${cpFlt(it.qty)}</span>`
				: `<input type="number" class="cp-input cp-num cp-l-qty" min="0" step="any" value="${cpFlt(it.qty)}" ${dis}>`}
				<span class="cp-muted cp-uom">${cpEsc(it.uom || "")}</span></td>
			<td data-label="Precio Unit." class="cp-num"><input type="number" class="cp-input cp-num cp-l-rate" min="0" step="any" value="${cpFlt(it.rate)}" ${dis}></td>
			<td data-label="Total" class="cp-num cp-strong cp-l-amount">${cpMoney(cpFlt(it.qty) * cpFlt(it.rate), fc.currency)}</td>
			<td data-label="Bodega">${it.is_stock_item
				? `<select class="cp-input cp-l-wh" ${dis}>${whOptions}</select>`
				: `<span class="cp-muted">—</span>`}</td>
			<td data-label="Tipo FEL"><select class="cp-input cp-l-tipo" ${dis}>${cpTipoOptions(it.bfel_multi_tipo)}</select></td>
			<td class="cp-cell-del">${editable ? `<button type="button" class="cp-del cp-l-del" title="Quitar">×</button>` : ""}</td>
		</tr>`;
	}).join("")}
	</tbody>
</table>`);
		this._render_fc_totals();
	}

	_render_fc_totals() {
		const fc = this.fc;
		let net, tax, grand;
		if (fc.docstatus !== 0 && fc.grand_total != null) {
			// Documento validado/cancelado: los totales reales de ERPNext.
			net = fc.net_total; tax = fc.total_taxes_and_charges; grand = fc.grand_total;
		} else {
			// Estimado en vivo (el definitivo lo calcula ERPNext al grabar). Si la
			// plantilla trae el impuesto incluido en el precio, el precio ya es
			// el total y el impuesto se desglosa hacia adentro.
			const t = (this.defaults.tax_templates || []).find((x) => x.name === fc.tax_type);
			const rate = t ? cpFlt(t.rate) / 100 : 0;
			const lines = fc.items.reduce((s, it) => s + cpFlt(it.qty) * cpFlt(it.rate), 0);
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
		this.$body.find("#cp-fc-totals").html(`
			<div class="cp-total-row"><span>Subtotal</span><span>${cpMoney(net, fc.currency)}</span></div>
			<div class="cp-total-row"><span>Impuestos</span><span>${cpMoney(tax, fc.currency)}</span></div>
			<div class="cp-total-row cp-total-grand"><span>Total</span><span>${cpMoney(grand, fc.currency)}</span></div>
			${fc.docstatus === 1 ? `<div class="cp-total-row"><span>Saldo pendiente</span><span>${cpMoney(fc.outstanding_amount, fc.currency)}</span></div>` : ""}`);
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
				this.fc.items.push({
					item_code: picked.item_code, item_name: picked.item_name,
					has_serial_no: picked.has_serial_no, has_batch_no: picked.has_batch_no,
					is_stock_item: picked.is_stock_item, uom: picked.uom,
					qty: picked.has_serial_no ? 0 : (cpFlt(v.qty) || 1), rate: cpFlt(v.rate),
					warehouse: picked.warehouse || "",
					bfel_multi_tipo: this.fc.bfel_multi_tipo || "",
					serial_no: "", batch_no: "",
				});
				this.dirty = true;
				this._render_fc_items();
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
				$search.val(it.item_code);
				dlg.$wrapper.find("#cp-add-picked").html(`<b>${cpEsc(it.item_code)}</b> — ${cpEsc(it.item_name)}
					${it.has_serial_no ? "<br><i>Maneja series: la cantidad sale de las series que ingrese en la línea.</i>" : ""}
					${it.has_batch_no ? "<br><i>Se gestiona por lote.</i>" : ""}
					${it.warehouse ? `<br>Bodega: <b>${cpEsc(it.warehouse)}</b>` : ""}`).show();
				dlg.set_df_property("qty", "hidden", !!it.has_serial_no);
			},
		});
		setTimeout(() => $search.trigger("focus"), 200);
	}

	_validate_fc() {
		const fc = this.fc;
		const errors = [];
		if (!fc.supplier) errors.push("Seleccione el proveedor de la lista.");
		if (!fc.bill_no) errors.push("Ingrese el número de factura del proveedor.");
		if (!fc.bill_date) errors.push("Ingrese la fecha de la factura del proveedor.");
		if (!fc.items.length) errors.push("Agregue al menos un producto.");
		fc.items.forEach((it, i) => {
			const n = `Línea ${i + 1} (${it.item_code})`;
			if (cpFlt(it.rate) <= 0) errors.push(`${n}: el precio debe ser mayor a 0.`);
			if (it.has_serial_no && !cpFlt(it.qty)) errors.push(`${n}: ingrese al menos un número de serie.`);
			else if (cpFlt(it.qty) <= 0) errors.push(`${n}: la cantidad debe ser mayor a 0.`);
			if (it.has_batch_no && !(it.batch_no || "").trim()) errors.push(`${n}: ingrese el número de lote.`);
			if (it.is_stock_item && !it.warehouse) errors.push(`${n}: seleccione la bodega.`);
		});
		return errors;
	}

	_save_fc(then_submit) {
		this._read_fc_header();
		const errors = this._validate_fc();
		if (errors.length) {
			frappe.msgprint({ title: "Revise la factura", message: errors.map((e) => `• ${cpEsc(e)}`).join("<br>"), indicator: "red" });
			return;
		}
		const run = () => {
			const fc = this.fc;
			const payload = {
				name: fc.name, company: this.company, supplier: fc.supplier,
				posting_date: fc.posting_date, bill_no: fc.bill_no, bill_date: fc.bill_date,
				currency: fc.currency, tax_type: fc.tax_type, bfel_multi_tipo: fc.bfel_multi_tipo,
				items: fc.items.map((it) => ({
					item_code: it.item_code, qty: it.qty, rate: it.rate, warehouse: it.warehouse,
					serial_no: it.serial_no, batch_no: it.batch_no, bfel_multi_tipo: it.bfel_multi_tipo,
				})),
			};
			frappe.call({
				method: "facex_multi.api.compras.facturas.save_purchase_invoice",
				args: { data_json: JSON.stringify(payload) },
				freeze: true,
				freeze_message: "Grabando factura de compra...",
				callback: (r) => {
					if (!r.message || !r.message.name) return;
					const name = r.message.name;
					this.dirty = false;
					if (!then_submit) {
						frappe.show_alert({ message: `Borrador grabado: <b>${cpEsc(name)}</b>`, indicator: "green" });
						this._go("fc-form", name);
						return;
					}
					frappe.call({
						method: "facex_multi.api.compras.facturas.submit_purchase_invoice",
						args: { name },
						freeze: true,
						freeze_message: "Validando factura de compra...",
						callback: (r2) => {
							if (r2.message) frappe.show_alert({ message: `Factura <b>${cpEsc(name)}</b> validada.`, indicator: "green" });
							this._go("fc-form", name);
						},
						// El borrador sí quedó grabado: recargarlo para no perder el nombre.
						error: () => this._go("fc-form", name),
					});
				},
			});
		};
		if (then_submit) {
			frappe.confirm("¿Validar esta factura de compra? Ingresará el inventario y la cuenta por pagar; después solo podrá cancelarse.", run);
		} else {
			run();
		}
	}

	_cancel_fc() {
		frappe.confirm(`¿Cancelar la factura <b>${cpEsc(this.fc.name)}</b>? Se revertirán el inventario y la cuenta por pagar.`, () => {
			frappe.call({
				method: "facex_multi.api.compras.facturas.cancel_purchase_invoice",
				args: { name: this.fc.name },
				freeze: true,
				freeze_message: "Cancelando...",
				callback: (r) => {
					if (r.message) frappe.show_alert({ message: "Factura cancelada.", indicator: "blue" });
					this._go("fc-form", this.fc.name);
				},
			});
		});
	}

	_delete_fc() {
		frappe.confirm(`¿Eliminar el borrador <b>${cpEsc(this.fc.name)}</b>? No se puede deshacer.`, () => {
			frappe.call({
				method: "facex_multi.api.compras.facturas.delete_purchase_invoice",
				args: { name: this.fc.name },
				freeze: true,
				callback: (r) => {
					if (!r.message) return;
					frappe.show_alert({ message: "Borrador eliminado.", indicator: "blue" });
					this.dirty = false;
					this._go("fc-list");
				},
			});
		});
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
		const h = result.header || {};
		this.stg = {
			warnings: result.errors || [],
			fc: this._empty_fc({
				supplier: h.supplier || "", supplier_name: h.supplier || "",
				posting_date: h.posting_date || this.defaults.today,
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
			this.fc_pending = fc;
			this._go("fc-form", null);
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
