// FacEx Multi — Pagos a Proveedores (/app/facex-pagos)
// Interfaz sobre el Payment Entry nativo de ERPNext (payment_type "Pay").
// Backend: facex_multi.api.compras.pagos. Cada pago = un Payment Entry con
// una forma de pago, varias facturas / notas de crédito, retenciones como
// deducciones y el sobrante como anticipo. Anticipos y notas de crédito
// sueltas se aplican a facturas con la Conciliación nativa.
//
// Vistas (dentro de #cp-content-root, mismas clases .cp-* que Compras):
//   home    proveedores con saldo + accesos
//   list    pagos realizados
//   form    nuevo pago / borrador / pago validado (arg: {name} o {supplier, factura})
//   estado  estado de cuenta del proveedor
//
// Ojo: el JS de las Pages se evalúa en el ámbito global; nombres propios (pg*/PG_*)
// para no chocar con los de facex-compras si ambas se abren en la misma pestaña.

frappe.pages["facex-pagos"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: "Pagos — FacEx", single_column: true });
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex-pagos") $("body").removeClass("facex-fullscreen-mode");
	});
	wrapper.facexPagos = new FacexPagos(page, wrapper);
	wrapper.facexPagos.setup_back_guard();
};

frappe.pages["facex-pagos"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	if (wrapper.facexPagos) wrapper.facexPagos.setup_back_guard();
};

const PG_STATUS = {
	0: ["Borrador", "#b45309", "#fef3c7"],
	1: ["Validado", "#047857", "#d1fae5"],
	2: ["Cancelado", "#6b7280", "#f3f4f6"],
};

function pgEsc(v) {
	return String(v == null ? "" : v)
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pgFlt(v) {
	return Math.round((parseFloat(v) || 0) * 100) / 100;
}

function pgMoney(n, currency) {
	const symbol = !currency || currency === "GTQ" ? "Q" : currency;
	return `${symbol} ${(parseFloat(n) || 0).toLocaleString("es-GT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function pgDate(d) {
	return d ? frappe.datetime.str_to_user(d) : "";
}

function pgBadge(docstatus) {
	const [label, color, bg] = PG_STATUS[docstatus] || PG_STATUS[0];
	return `<span class="cp-badge" style="color:${color};background:${bg};">${label}</span>`;
}

class FacexPagos {
	constructor(page, wrapper) {
		this.wrapper = wrapper;
		this.$root = $(page.body);
		this.defaults = null;
		this.view = null;
		this.dirty = false;
		this._filters = null;
		this._render_frame();
		this.$body = this.$root.find("#cp-content-root");
		this._load_defaults();
	}

	setup_back_guard() {
		facex_multi.setup_back_guard({
			to: "/app/facex",
			is_dirty: () => this.dirty,
			on_back: () => this._internal_back(),
		});
	}

	_internal_back() {
		if (!this.view || this.view === "home") return false;
		const go = () => this._go(this.view === "form" && this._came_from === "list" ? "list" : "home");
		if (this.dirty) {
			frappe.confirm("Hay cambios sin guardar. ¿Desea salir de todos modos?", () => { this.dirty = false; go(); });
			return true;
		}
		go();
		return true;
	}

	_go(view, arg) {
		if (view === "form") this._came_from = this.view;
		this.view = view;
		this.dirty = false;
		this.$body.off();
		window.scrollTo(0, 0);
		if (view === "home") this._render_home();
		else if (view === "list") this._render_list();
		else if (view === "form") this._render_form(arg || {});
		else if (view === "estado") this._render_estado(arg || {});
	}

	get perms() {
		return (this.defaults && this.defaults.permissions) || {};
	}

	get company() {
		return (this.defaults && this.defaults.company) || "";
	}

	_can(action) {
		return !!(this.perms.puede_compras && this.perms[`pago_proveedor_${action}`]);
	}

	_load_defaults() {
		this.$body.html(`<div class="cp-empty">Cargando...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.pagos.get_pagos_defaults",
			callback: (r) => {
				this.defaults = r.message || {};
				this._render_topbar_links();
				const q = new URLSearchParams(window.location.search);
				if (!this.perms.puede_compras) return this._go("home");
				if (q.get("pago")) this._go("form", { name: q.get("pago") });
				else if (q.get("proveedor") && q.get("estado")) this._go("estado", { supplier: q.get("proveedor") });
				else if (q.get("proveedor")) this._go("form", { supplier: q.get("proveedor"), factura: q.get("factura") });
				else this._go("home");
			},
			error: () => this.$body.html(`<div class="cp-empty" style="color:#b91c1c;">No se pudo cargar FacEx Pagos.</div>`),
		});
	}

	// ──────────────────────────────────────────────
	// Inicio: proveedores con saldo
	// ──────────────────────────────────────────────

	_render_home() {
		const d = this.defaults;
		if (!this.perms.puede_compras) {
			this.$body.html(`<div class="cp-wrap"><div class="cp-card cp-empty">
				No tiene acceso a Pagos a Proveedores en <b>${pgEsc(this.company)}</b>.<br>
				<span style="font-size:13px;">Contacte a un administrador para solicitar acceso.</span></div></div>`);
			return;
		}
		this.$body.html(`
<div class="cp-wrap">
	<div class="cp-page-head">
		<div class="cp-h1">Pagos a Proveedores</div>
		<div class="cp-head-actions">
			<button type="button" class="cp-btn cp-btn-secondary" id="pg-estado">Estado de cuenta</button>
			<button type="button" class="cp-btn cp-btn-secondary" id="pg-list">Pagos realizados</button>
			${this._can("grabar_borrador") ? `<button type="button" class="cp-btn cp-btn-primary" id="pg-new">+ Nuevo pago</button>` : ""}
		</div>
		<div class="cp-muted cp-head-meta">${pgEsc(this.company)}</div>
	</div>
	${d.config_incompleta ? `<div class="cp-alert cp-alert-warn">Faltan las cuentas de pago de esta compañía (FacEx Configuración Compañía → Pagos a Proveedores).</div>` : ""}
	<div class="cp-card cp-filters">
		<div class="cp-field cp-field-wide"><label class="cp-label">Buscar proveedor</label>
			<input type="text" class="cp-input" id="pg-q" placeholder="Nombre o código..."></div>
	</div>
	<div class="cp-section-title">Proveedores con saldo</div>
	<div id="pg-suppliers"><div class="cp-empty">Cargando...</div></div>
</div>`);
		const $b = this.$body;
		$b.on("click", "#pg-new", () => this._go("form", {}));
		$b.on("click", "#pg-list", () => this._go("list"));
		$b.on("click", "#pg-estado", () => this._go("estado", {}));
		$b.on("click", "[data-pay]", (e) => { e.stopPropagation(); this._go("form", { supplier: $(e.currentTarget).data("pay") }); });
		$b.on("click", "tr[data-supplier]", (e) => this._go("estado", { supplier: $(e.currentTarget).data("supplier") }));
		let timer = null;
		$b.on("input", "#pg-q", (e) => { clearTimeout(timer); timer = setTimeout(() => this._load_suppliers(e.target.value.trim()), 300); });
		this._load_suppliers("");
	}

	_load_suppliers(txt) {
		frappe.call({
			method: "facex_multi.api.compras.pagos.get_suppliers_with_balance",
			args: { company: this.company, txt },
			callback: (r) => {
				if (this.view !== "home") return;
				const rows = r.message || [];
				const $c = this.$body.find("#pg-suppliers");
				if (!rows.length) {
					$c.html(`<div class="cp-card cp-empty">No hay proveedores con saldo pendiente.</div>`);
					return;
				}
				const total = rows.reduce((s, x) => s + (parseFloat(x.saldo) || 0), 0);
				$c.html(`
<div class="cp-card cp-table-card">
	<table class="cp-table cp-cards">
		<thead><tr><th>Proveedor</th><th class="cp-num">Facturas</th><th class="cp-num">Vencido</th><th class="cp-num">Anticipos</th><th class="cp-num">Saldo</th><th></th></tr></thead>
		<tbody>${rows.map((x) => `
			<tr class="cp-row-link" data-supplier="${pgEsc(x.supplier)}">
				<td data-label="Proveedor" class="cp-strong">${pgEsc(x.supplier_name || x.supplier)}</td>
				<td data-label="Facturas" class="cp-num">${x.facturas || 0}</td>
				<td data-label="Vencido" class="cp-num ${x.vencido > 0 ? "cp-text-bad" : ""}">${pgMoney(x.vencido)}</td>
				<td data-label="Anticipos" class="cp-num">${x.anticipos ? pgMoney(x.anticipos) : "—"}</td>
				<td data-label="Saldo" class="cp-num cp-strong">${pgMoney(x.saldo)}</td>
				<td class="cp-num">${this._can("grabar_borrador") && x.saldo > 0 ? `<button type="button" class="cp-btn cp-btn-secondary" data-pay="${pgEsc(x.supplier)}">Pagar</button>` : ""}</td>
			</tr>`).join("")}
		</tbody>
	</table>
	<div class="cp-list-foot">${rows.length} proveedor(es) · Saldo total: <b>${pgMoney(total)}</b> · Toque un proveedor para ver su estado de cuenta.</div>
</div>`);
			},
		});
	}

	// ──────────────────────────────────────────────
	// Pagos realizados
	// ──────────────────────────────────────────────

	_render_list() {
		const f = this._filters || (this._filters = {
			start_date: frappe.datetime.month_start(), end_date: frappe.datetime.get_today(),
			supplier: "", supplier_label: "", estado: "",
		});
		this.$body.html(`
<div class="cp-wrap">
	<div class="cp-page-head">
		<button type="button" class="cp-back" id="pg-back">← Pagos</button>
		<div class="cp-h1">Pagos realizados</div>
		<div class="cp-head-actions">${this._can("grabar_borrador") ? `<button type="button" class="cp-btn cp-btn-primary" id="pg-new">+ Nuevo pago</button>` : ""}</div>
	</div>
	<div class="cp-card cp-filters">
		<div class="cp-field"><label class="cp-label">Desde</label><input type="date" class="cp-input" id="pg-f-start" value="${pgEsc(f.start_date)}"></div>
		<div class="cp-field"><label class="cp-label">Hasta</label><input type="date" class="cp-input" id="pg-f-end" value="${pgEsc(f.end_date)}"></div>
		<div class="cp-field cp-field-wide"><label class="cp-label">Proveedor</label>
			<div class="cp-ac"><input type="text" class="cp-input" id="pg-f-supplier" placeholder="Todos" value="${pgEsc(f.supplier_label)}" data-value="${pgEsc(f.supplier)}"></div></div>
		<div class="cp-field"><label class="cp-label">Estado</label>
			<select class="cp-input" id="pg-f-status">
				<option value="">Todos</option>
				${[["0", "Borrador"], ["1", "Validado"], ["2", "Cancelado"]].map(([v, l]) => `<option value="${v}"${f.estado === v ? " selected" : ""}>${l}</option>`).join("")}
			</select></div>
		<div class="cp-field cp-field-btn"><button type="button" class="cp-btn cp-btn-secondary cp-block" id="pg-f-apply">Filtrar</button></div>
	</div>
	<div id="pg-list"></div>
</div>`);
		const $b = this.$body;
		$b.on("click", "#pg-back", () => this._go("home"));
		$b.on("click", "#pg-new", () => this._go("form", {}));
		$b.on("click", "#pg-f-apply", () => this._load_list());
		$b.on("click", "tr[data-name]", (e) => this._go("form", { name: $(e.currentTarget).data("name") }));
		this._bind_supplier_ac($b.find("#pg-f-supplier"));
		this._load_list();
	}

	_load_list() {
		const $b = this.$body;
		const f = this._filters;
		const $s = $b.find("#pg-f-supplier");
		f.start_date = $b.find("#pg-f-start").val();
		f.end_date = $b.find("#pg-f-end").val();
		f.supplier = $s.val().trim() ? ($s.attr("data-value") || "") : "";
		f.supplier_label = f.supplier ? $s.val() : "";
		f.estado = $b.find("#pg-f-status").val();
		const $l = $b.find("#pg-list").html(`<div class="cp-empty">Cargando...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.pagos.get_payment_list",
			args: { company: this.company, start_date: f.start_date, end_date: f.end_date, supplier: f.supplier, estado: f.estado },
			callback: (r) => {
				if (this.view !== "list") return;
				const rows = r.message || [];
				if (!rows.length) {
					$l.html(`<div class="cp-card cp-empty">Sin pagos con estos filtros.</div>`);
					return;
				}
				const total = rows.filter((x) => x.docstatus === 1).reduce((s, x) => s + (parseFloat(x.paid_amount) || 0), 0);
				$l.html(`
<div class="cp-card cp-table-card">
	<table class="cp-table cp-cards">
		<thead><tr><th>Pago</th><th>Proveedor</th><th>Fecha</th><th>Forma</th><th>Referencia</th><th class="cp-num">Monto</th><th class="cp-num">Anticipo</th><th>Estado</th></tr></thead>
		<tbody>${rows.map((x) => `
			<tr class="cp-row-link" data-name="${pgEsc(x.name)}">
				<td data-label="Pago" class="cp-strong">${pgEsc(x.name)}</td>
				<td data-label="Proveedor">${pgEsc(x.party_name || x.party)}</td>
				<td data-label="Fecha">${pgDate(x.posting_date)}</td>
				<td data-label="Forma">${pgEsc(x.mode_of_payment || "")}</td>
				<td data-label="Referencia">${pgEsc((x.reference_no || "").startsWith("EFE-") ? "" : x.reference_no)}</td>
				<td data-label="Monto" class="cp-num cp-strong">${pgMoney(x.paid_amount)}</td>
				<td data-label="Anticipo" class="cp-num">${x.unallocated_amount > 0 ? pgMoney(x.unallocated_amount) : "—"}</td>
				<td data-label="Estado">${pgBadge(x.docstatus)}</td>
			</tr>`).join("")}
		</tbody>
	</table>
	<div class="cp-list-foot">${rows.length} pago(s) · Validados: <b>${pgMoney(total)}</b></div>
</div>`);
			},
		});
	}

	// ──────────────────────────────────────────────
	// Formulario de pago
	// ──────────────────────────────────────────────

	_render_form(arg) {
		this.pago = {
			name: null, docstatus: 0, supplier: arg.supplier || "", supplier_name: "",
			posting_date: this.defaults.today, forma: (this.defaults.formas[0] || {}).key || "",
			reference_no: "", remarks: "", retenciones: {}, cargos_bancarios: 0,
			amount: 0, amount_manual: false,
			facturas: [], notas: [], anticipos: [], preselect: arg.factura || null,
		};
		if (!arg.name) {
			this._paint_form();
			if (this.pago.supplier) this._load_open_docs();
			return;
		}
		this.$body.html(`<div class="cp-empty">Cargando pago...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.pagos.get_payment",
			args: { name: arg.name, company: this.company },
			callback: (r) => {
				const d = r.message;
				if (!d) return;
				const p = this.pago;
				const fee = (d.deductions || []).filter((x) => x.tipo === "cargos").reduce((s, x) => s + x.amount, 0);
				Object.assign(p, {
					name: d.name, docstatus: d.docstatus, supplier: d.party, supplier_name: d.supplier_name || d.party_name,
					posting_date: d.posting_date, forma: d.forma,
					reference_no: (d.reference_no || "").startsWith("EFE-") ? "" : d.reference_no,
					remarks: d.remarks || "", owner_fullname: d.owner_fullname, validado_por_fullname: d.validado_por_fullname,
					paid_amount: d.paid_amount, unallocated_amount: d.unallocated_amount,
					cargos_bancarios: fee, amount: pgFlt(d.paid_amount - fee), amount_manual: true,
					doc: d,
				});
				(d.deductions || []).forEach((x) => { if (x.tipo === "isr" || x.tipo === "iva") p.retenciones[x.tipo] = Math.abs(x.amount); });
				p.refs = (d.references || []).map((x) => ({ name: x.reference_name, amount: x.allocated_amount }));
				if (d.docstatus === 0) {
					this._paint_form();
					this._load_open_docs();
				} else {
					this._paint_view();
				}
			},
			error: () => this._go("list"),
		});
	}

	_load_open_docs() {
		const p = this.pago;
		frappe.call({
			method: "facex_multi.api.compras.pagos.get_open_documents",
			args: { supplier: p.supplier, company: this.company },
			callback: (r) => {
				if (this.view !== "form" || this.pago !== p) return;
				const d = r.message || {};
				p.supplier_name = d.supplier_name || p.supplier;
				const refAmt = {};
				(p.refs || []).forEach((x) => { refAmt[x.name] = Math.abs(x.amount); });
				p.facturas = (d.facturas || []).map((x) => ({ ...x, amount: refAmt[x.name] || (p.preselect === x.name ? pgFlt(x.outstanding_amount) : 0) }));
				p.notas = (d.notas || []).map((x) => ({ ...x, amount: refAmt[x.name] || 0 }));
				p.anticipos = d.anticipos || [];
				p.preselect = null;
				this.$body.find("#pg-h-supplier").val(p.supplier_name).attr("data-value", p.supplier);
				this._paint_docs();
				this._recalc();
			},
		});
	}

	_paint_form() {
		const p = this.pago;
		const formas = this.defaults.formas || [];
		const rets = this.defaults.retenciones || [];
		const editable = p.docstatus === 0 && this._can("grabar_borrador");
		const dis = editable ? "" : "disabled";
		this.$body.html(`
<div class="cp-wrap cp-has-actionbar">
	<div class="cp-page-head">
		<button type="button" class="cp-back" id="pg-back">← ${this._came_from === "list" ? "Pagos realizados" : "Pagos"}</button>
		<div class="cp-h1">${p.name ? pgEsc(p.name) : "Nuevo pago a proveedor"} ${p.name ? pgBadge(p.docstatus) : `<span class="cp-badge" style="color:#1d4ed8;background:#dbeafe;">Nuevo</span>`}</div>
		${p.owner_fullname ? `<div class="cp-muted cp-head-meta">Elaborado por <b>${pgEsc(p.owner_fullname)}</b></div>` : ""}
	</div>
	${this.defaults.config_incompleta ? `<div class="cp-alert cp-alert-warn">Faltan las cuentas de pago de esta compañía (FacEx Configuración Compañía → Pagos a Proveedores).</div>` : ""}
	<div class="cp-card"><div class="cp-grid">
		<div class="cp-field cp-field-wide"><label class="cp-label">Proveedor *</label>
			<div class="cp-ac"><input type="text" class="cp-input" id="pg-h-supplier" placeholder="Buscar proveedor..." value="${pgEsc(p.supplier_name || p.supplier)}" data-value="${pgEsc(p.supplier)}" ${p.name ? "disabled" : dis}></div></div>
		<div class="cp-field"><label class="cp-label">Fecha</label><input type="date" class="cp-input" id="pg-h-date" value="${pgEsc(p.posting_date)}" ${dis}></div>
		<div class="cp-field"><label class="cp-label">Forma de pago *</label>
			<select class="cp-input" id="pg-h-forma" ${dis}>${formas.map((f) => `<option value="${f.key}"${f.key === p.forma ? " selected" : ""}>${pgEsc(f.label)}</option>`).join("") || `<option value="">Sin cuentas configuradas</option>`}</select></div>
		<div class="cp-field" id="pg-ref-wrap"><label class="cp-label">No. cheque / referencia *</label><input type="text" class="cp-input" id="pg-h-ref" value="${pgEsc(p.reference_no)}" ${dis}></div>
		<div class="cp-field cp-field-wide"><label class="cp-label">Observaciones</label><input type="text" class="cp-input" id="pg-h-remarks" value="${pgEsc(p.remarks)}" ${dis}></div>
	</div></div>

	<div id="pg-docs"><div class="cp-card cp-empty">${p.supplier ? "Cargando documentos..." : "Seleccione el proveedor para ver sus facturas pendientes."}</div></div>

	<div class="cp-card">
		<div class="cp-section-title" style="margin-top:0;">Retenciones y cargos</div>
		<div class="cp-grid">
			${rets.map((r) => `<div class="cp-field"><label class="cp-label">${pgEsc(r.label)}</label><input type="number" min="0" step="any" class="cp-input cp-num pg-ret" data-tipo="${r.key}" value="${pgFlt(p.retenciones[r.key] || 0)}" ${dis}></div>`).join("")}
			<div class="cp-field" id="pg-fee-wrap"><label class="cp-label">Cargos bancarios</label><input type="number" min="0" step="any" class="cp-input cp-num" id="pg-fee" value="${pgFlt(p.cargos_bancarios)}" ${dis}></div>
		</div>
		<div class="cp-muted" style="margin-top:6px;">La retención se descuenta de lo que recibe el proveedor y queda como impuesto por pagar. Los cargos bancarios salen del banco además del pago.</div>
	</div>

	<div class="cp-card cp-totals" id="pg-totals"></div>

	<div class="cp-actionbar">
		${p.name ? `<a class="cp-btn cp-btn-ghost" href="/app/payment-entry/${encodeURIComponent(p.name)}" target="_blank">Abrir en ERP</a>` : ""}
		${p.name && editable ? `<button type="button" class="cp-btn cp-btn-danger" id="pg-delete">Eliminar</button>` : ""}
		<span class="cp-spacer"></span>
		${editable ? `<button type="button" class="cp-btn cp-btn-secondary" id="pg-save">Grabar Borrador</button>` : ""}
		${p.docstatus === 0 && this._can("validar") ? `<button type="button" class="cp-btn cp-btn-primary" id="pg-submit">Validar pago</button>` : ""}
	</div>
</div>`);
		this._toggle_forma_fields();
		this._bind_form();
		this._recalc();
	}

	_toggle_forma_fields() {
		const f = (this.defaults.formas || []).find((x) => x.key === this.pago.forma) || {};
		this.$body.find("#pg-ref-wrap").toggle(!!f.needs_ref);
		this.$body.find("#pg-fee-wrap").toggle(this.pago.forma !== "efectivo");
	}

	_paint_docs() {
		const p = this.pago;
		const editable = p.docstatus === 0 && this._can("grabar_borrador");
		const dis = editable ? "" : "disabled";
		const inv = p.facturas;
		const html = [];
		html.push(`<div class="cp-card">
			<div class="cp-card-head"><div class="cp-section-title" style="margin:0;">Facturas pendientes (${inv.length})</div>
				${editable && inv.length ? `<button type="button" class="cp-btn cp-btn-secondary" id="pg-all">Pagar todas</button>` : ""}</div>
			${inv.length ? `<table class="cp-table cp-cards">
				<thead><tr><th style="width:32px;"></th><th>Factura</th><th>No. Proveedor</th><th>Fecha</th><th>Vence</th><th class="cp-num">Saldo</th><th class="cp-num" style="width:140px;">A pagar</th></tr></thead>
				<tbody>${inv.map((x, i) => `
					<tr data-inv="${i}">
						<td data-label="Pagar"><input type="checkbox" class="pg-chk" ${x.amount > 0 ? "checked" : ""} ${dis}></td>
						<td data-label="Factura" class="cp-strong">${pgEsc(x.name)}</td>
						<td data-label="No. Proveedor">${pgEsc(x.bill_no || "")}</td>
						<td data-label="Fecha">${pgDate(x.posting_date)}</td>
						<td data-label="Vence" class="${x.vencida ? "cp-text-bad" : ""}">${pgDate(x.due_date)}${x.vencida ? " · vencida" : ""}</td>
						<td data-label="Saldo" class="cp-num">${pgMoney(x.outstanding_amount)}</td>
						<td data-label="A pagar" class="cp-num"><input type="number" min="0" step="any" class="cp-input cp-num pg-amt" value="${pgFlt(x.amount) || ""}" placeholder="0.00" ${dis}></td>
					</tr>`).join("")}</tbody></table>` : `<div class="cp-empty">El proveedor no tiene facturas pendientes. Un pago sin facturas queda como anticipo.</div>`}
		</div>`);
		if (p.notas.length) {
			html.push(`<div class="cp-card">
				<div class="cp-section-title" style="margin-top:0;">Notas de crédito disponibles</div>
				<table class="cp-table cp-cards">
					<thead><tr><th style="width:32px;"></th><th>Nota de crédito</th><th>No. Proveedor</th><th>Fecha</th><th class="cp-num">Crédito</th><th class="cp-num" style="width:140px;">Aplicar</th></tr></thead>
					<tbody>${p.notas.map((x, i) => `
						<tr data-nc="${i}">
							<td data-label="Aplicar"><input type="checkbox" class="pg-nchk" ${x.amount > 0 ? "checked" : ""} ${dis}></td>
							<td data-label="Nota" class="cp-strong">${pgEsc(x.name)}</td>
							<td data-label="No. Proveedor">${pgEsc(x.bill_no || "")}</td>
							<td data-label="Fecha">${pgDate(x.posting_date)}</td>
							<td data-label="Crédito" class="cp-num">${pgMoney(x.credito)}</td>
							<td data-label="Aplicar" class="cp-num"><input type="number" min="0" step="any" class="cp-input cp-num pg-namt" value="${pgFlt(x.amount) || ""}" placeholder="0.00" ${dis}></td>
						</tr>`).join("")}</tbody></table>
			</div>`);
		}
		if (p.anticipos.length) {
			html.push(`<div class="cp-card">
				<div class="cp-section-title" style="margin-top:0;">Anticipos sin aplicar</div>
				<table class="cp-table cp-cards">
					<thead><tr><th>Pago</th><th>Fecha</th><th>Referencia</th><th class="cp-num">Disponible</th><th></th></tr></thead>
					<tbody>${p.anticipos.map((x) => `
						<tr><td data-label="Pago" class="cp-strong">${pgEsc(x.name)}</td>
							<td data-label="Fecha">${pgDate(x.posting_date)}</td>
							<td data-label="Referencia">${pgEsc((x.reference_no || "").startsWith("EFE-") ? "" : x.reference_no)}</td>
							<td data-label="Disponible" class="cp-num">${pgMoney(x.unallocated_amount)}</td>
							<td class="cp-num">${this._can("validar") && inv.length ? `<button type="button" class="cp-btn cp-btn-secondary" data-apply-pe="${pgEsc(x.name)}">Aplicar a factura</button>` : ""}</td></tr>`).join("")}
					</tbody></table>
				<div class="cp-muted" style="margin-top:6px;">Aplicar un anticipo no mueve dinero: descuenta la factura con lo que ya se le pagó al proveedor.</div>
			</div>`);
		}
		this.$body.find("#pg-docs").html(html.join(""));
	}

	_bind_form() {
		const $b = this.$body;
		const p = this.pago;
		$b.on("click", "#pg-back", () => this._internal_back());
		$b.on("click", "#pg-save", () => this._save(false));
		$b.on("click", "#pg-submit", () => this._save(true));
		$b.on("click", "#pg-delete", () => this._delete());
		$b.on("click", "[data-apply-pe]", (e) => this._apply_dialog("Payment Entry", $(e.currentTarget).data("apply-pe")));
		if (p.docstatus !== 0) return;
		if (!p.name) {
			this._bind_supplier_ac($b.find("#pg-h-supplier"), {
				on_pick: (s) => {
					p.supplier = s.value; p.supplier_name = s.label; p.refs = []; p.amount_manual = false;
					this.dirty = true;
					this.$body.find("#pg-docs").html(`<div class="cp-card cp-empty">Cargando documentos...</div>`);
					this._load_open_docs();
				},
			});
		}
		$b.on("change", "#pg-h-forma", (e) => { p.forma = e.target.value; this.dirty = true; this._toggle_forma_fields(); this._recalc(); });
		$b.on("input change", "#pg-h-date,#pg-h-ref,#pg-h-remarks", () => { this.dirty = true; });
		$b.on("input", ".pg-ret", (e) => { p.retenciones[$(e.target).data("tipo")] = pgFlt(e.target.value); this.dirty = true; this._recalc(); });
		$b.on("input", "#pg-fee", (e) => { p.cargos_bancarios = pgFlt(e.target.value); this.dirty = true; this._recalc(); });
		$b.on("input", "#pg-amount", (e) => { p.amount = pgFlt(e.target.value); p.amount_manual = true; this.dirty = true; this._recalc(false); });
		$b.on("click", "#pg-amount-reset", () => { p.amount_manual = false; this._recalc(); });
		$b.on("click", "#pg-all", () => {
			p.facturas.forEach((x) => { x.amount = pgFlt(x.outstanding_amount); });
			this.dirty = true; this._paint_docs(); this._recalc();
		});
		const row = (e, list, attr) => list[parseInt($(e.target).closest(`[${attr}]`).attr(attr))];
		$b.on("change", ".pg-chk", (e) => {
			const x = row(e, p.facturas, "data-inv");
			x.amount = e.target.checked ? pgFlt(x.outstanding_amount) : 0;
			$(e.target).closest("tr").find(".pg-amt").val(x.amount || "");
			this.dirty = true; this._recalc();
		});
		$b.on("input", ".pg-amt", (e) => {
			const x = row(e, p.facturas, "data-inv");
			x.amount = pgFlt(e.target.value);
			$(e.target).closest("tr").find(".pg-chk").prop("checked", x.amount > 0);
			this.dirty = true; this._recalc();
		});
		$b.on("change", ".pg-nchk", (e) => {
			const x = row(e, p.notas, "data-nc");
			x.amount = e.target.checked ? pgFlt(x.credito) : 0;
			$(e.target).closest("tr").find(".pg-namt").val(x.amount || "");
			this.dirty = true; this._recalc();
		});
		$b.on("input", ".pg-namt", (e) => {
			const x = row(e, p.notas, "data-nc");
			x.amount = pgFlt(e.target.value);
			$(e.target).closest("tr").find(".pg-nchk").prop("checked", x.amount > 0);
			this.dirty = true; this._recalc();
		});
	}

	_sums() {
		const p = this.pago;
		const facturas = p.facturas.reduce((s, x) => s + pgFlt(x.amount), 0);
		const notas = p.notas.reduce((s, x) => s + pgFlt(x.amount), 0);
		const ret = Object.values(p.retenciones).reduce((s, v) => s + pgFlt(v), 0);
		const fee = p.forma === "efectivo" ? 0 : pgFlt(p.cargos_bancarios);
		const needed = pgFlt(facturas - notas - ret);
		return { facturas, notas, ret, fee, needed };
	}

	_recalc(paint_amount = true) {
		const p = this.pago;
		const s = this._sums();
		if (!p.amount_manual) p.amount = Math.max(s.needed, 0);
		const anticipo = pgFlt(p.amount - s.needed);
		const editable = p.docstatus === 0 && this._can("grabar_borrador");
		const row = (l, v, cls) => `<div class="cp-total-row${cls ? ` ${cls}` : ""}"><span>${l}</span><span>${v}</span></div>`;
		const $t = this.$body.find("#pg-totals");
		const amountInput = `<input type="number" min="0" step="any" class="cp-input cp-num" id="pg-amount" value="${pgFlt(p.amount)}" ${editable ? "" : "disabled"} style="max-width:150px;">`;
		if (paint_amount || !$t.find("#pg-amount").length) {
			$t.html(`
				${row("Facturas a pagar", pgMoney(s.facturas))}
				${s.notas ? row("(−) Notas de crédito", pgMoney(s.notas)) : ""}
				${s.ret ? row("(−) Retenciones", pgMoney(s.ret)) : ""}
				<div class="cp-total-row cp-total-grand" style="align-items:center;"><span>Monto a entregar</span>${amountInput}</div>
				<div id="pg-extra"></div>`);
		}
		const extra = [];
		if (anticipo > 0.004) extra.push(row("Queda como anticipo", pgMoney(anticipo), "pg-warn"));
		if (anticipo < -0.004) extra.push(`<div class="cp-text-bad" style="font-size:12.5px;padding:4px 0;">Faltan ${pgMoney(-anticipo)} para cubrir las facturas seleccionadas.</div>`);
		if (s.fee) extra.push(row("Cargos bancarios (adicional)", pgMoney(s.fee)));
		if (s.fee) extra.push(row("Sale del banco", pgMoney(pgFlt(p.amount) + s.fee), "cp-strong"));
		if (p.amount_manual && editable && Math.abs(anticipo) > 0.004) extra.push(`<button type="button" class="cp-btn cp-btn-ghost" id="pg-amount-reset" style="padding:4px 0;min-height:0;">Ajustar al total de las facturas</button>`);
		$t.find("#pg-extra").html(extra.join(""));
	}

	_payload() {
		const p = this.pago;
		const $b = this.$body;
		return {
			name: p.name, company: this.company, supplier: p.supplier,
			posting_date: $b.find("#pg-h-date").val(), forma: p.forma,
			reference_no: ($b.find("#pg-h-ref").val() || "").trim(),
			remarks: ($b.find("#pg-h-remarks").val() || "").trim(),
			amount: pgFlt(p.amount), cargos_bancarios: p.forma === "efectivo" ? 0 : pgFlt(p.cargos_bancarios),
			retenciones: Object.entries(p.retenciones).filter(([, v]) => pgFlt(v) > 0).map(([tipo, amount]) => ({ tipo, amount })),
			facturas: p.facturas.filter((x) => pgFlt(x.amount) > 0).map((x) => ({ name: x.name, amount: pgFlt(x.amount) })),
			notas: p.notas.filter((x) => pgFlt(x.amount) > 0).map((x) => ({ name: x.name, amount: pgFlt(x.amount) })),
		};
	}

	_validate(data) {
		const p = this.pago;
		const errors = [];
		const f = (this.defaults.formas || []).find((x) => x.key === p.forma);
		if (!p.supplier) errors.push("Seleccione el proveedor.");
		if (!f) errors.push("Seleccione la forma de pago.");
		if (f && f.needs_ref && !data.reference_no) errors.push(`Ingrese el número de ${f.label.toLowerCase()} / referencia.`);
		p.facturas.forEach((x) => { if (pgFlt(x.amount) > pgFlt(x.outstanding_amount) + 0.004) errors.push(`${x.name}: no puede pagar más que su saldo (${pgMoney(x.outstanding_amount)}).`); });
		p.notas.forEach((x) => { if (pgFlt(x.amount) > pgFlt(x.credito) + 0.004) errors.push(`${x.name}: el crédito disponible es ${pgMoney(x.credito)}.`); });
		const s = this._sums();
		if (s.notas > s.facturas + 0.004) errors.push("Las notas de crédito no pueden superar las facturas pagadas.");
		if (pgFlt(p.amount) <= 0) errors.push("El monto a entregar debe ser mayor a cero.");
		else if (pgFlt(p.amount) < s.needed - 0.004) errors.push(`El monto a entregar no cubre las facturas seleccionadas (faltan ${pgMoney(s.needed - p.amount)}).`);
		return errors;
	}

	_save(then_submit) {
		const data = this._payload();
		const errors = this._validate(data);
		if (errors.length) {
			frappe.msgprint({ title: "Revise el pago", message: errors.map((e) => `• ${pgEsc(e)}`).join("<br>"), indicator: "red" });
			return;
		}
		const s = this._sums();
		const anticipo = pgFlt(data.amount - s.needed);
		const run = () => frappe.call({
			method: "facex_multi.api.compras.pagos.save_payment",
			args: { data_json: JSON.stringify(data) },
			freeze: true,
			freeze_message: "Grabando pago...",
			callback: (r) => {
				if (!r.message || !r.message.name) return;
				const name = r.message.name;
				this.dirty = false;
				if (!then_submit) {
					frappe.show_alert({ message: `Borrador grabado: <b>${pgEsc(name)}</b>`, indicator: "green" });
					this._go("form", { name });
					return;
				}
				frappe.call({
					method: "facex_multi.api.compras.pagos.submit_payment",
					args: { name },
					freeze: true,
					freeze_message: "Validando pago...",
					callback: (r2) => {
						if (r2.message) frappe.show_alert({ message: `Pago <b>${pgEsc(name)}</b> validado.`, indicator: "green" });
						this._go("form", { name });
					},
					error: () => this._go("form", { name }),
				});
			},
		});
		if (!then_submit) return run();
		const forma = ((this.defaults.formas || []).find((x) => x.key === data.forma) || {}).label || "";
		frappe.confirm(`¿Validar el pago de <b>${pgMoney(data.amount)}</b> (${pgEsc(forma)}) a <b>${pgEsc(this.pago.supplier_name || this.pago.supplier)}</b>?`
			+ (anticipo > 0.004 ? `<br>${pgMoney(anticipo)} quedarán como anticipo.` : "")
			+ `<br>Sale el dinero y baja la cuenta por pagar; después solo podrá cancelarse.`, run);
	}

	_delete() {
		frappe.confirm(`¿Eliminar el borrador <b>${pgEsc(this.pago.name)}</b>?`, () => {
			frappe.call({
				method: "facex_multi.api.compras.pagos.delete_payment",
				args: { name: this.pago.name },
				freeze: true,
				callback: (r) => {
					if (!r.message) return;
					frappe.show_alert({ message: "Borrador eliminado.", indicator: "blue" });
					this.dirty = false;
					this._go("list");
				},
			});
		});
	}

	_apply_dialog(credit_doctype, credit_name) {
		const p = this.pago;
		const credit = credit_doctype === "Payment Entry"
			? p.anticipos.find((x) => x.name === credit_name).unallocated_amount
			: (p.notas.find((x) => x.name === credit_name) || {}).credito;
		const first = p.facturas[0];
		const dlg = new frappe.ui.Dialog({
			title: `Aplicar ${credit_name}`,
			fields: [
				{ fieldtype: "HTML", options: `<div class="cp-help">Disponible: <b>${pgMoney(credit)}</b>. No mueve dinero: descuenta la factura con lo ya pagado al proveedor.</div>` },
				{ fieldtype: "Select", fieldname: "invoice", label: "Factura", reqd: 1, default: first ? first.name : "",
				  options: p.facturas.map((x) => ({ value: x.name, label: `${x.name} · ${x.bill_no || ""} · saldo ${pgMoney(x.outstanding_amount)}` })) },
				{ fieldtype: "Currency", fieldname: "amount", label: "Monto a aplicar", reqd: 1,
				  default: first ? Math.min(pgFlt(credit), pgFlt(first.outstanding_amount)) : 0 },
			],
			primary_action_label: "Aplicar",
			primary_action: (v) => {
				frappe.call({
					method: "facex_multi.api.compras.pagos.apply_credit",
					args: { company: this.company, supplier: p.supplier, credit_doctype, credit_name, invoice: v.invoice, amount: v.amount },
					freeze: true,
					callback: (r) => {
						if (!r.message) return;
						dlg.hide();
						frappe.show_alert({ message: `Aplicado. Saldo de ${pgEsc(v.invoice)}: ${pgMoney(r.message.outstanding)}`, indicator: "green" });
						this._load_open_docs();
					},
				});
			},
		});
		// Al cambiar de factura, propone el menor entre el crédito y su saldo.
		dlg.fields_dict.invoice.$input.on("change", () => {
			const inv = p.facturas.find((x) => x.name === dlg.fields_dict.invoice.$input.val());
			if (inv) dlg.set_value("amount", Math.min(pgFlt(credit), pgFlt(inv.outstanding_amount)));
		});
		dlg.show();
	}

	// Pago validado / cancelado: solo lectura.
	_paint_view() {
		const p = this.pago;
		const d = p.doc;
		const formas = { efectivo: "Efectivo", cheque: "Cheque", transferencia: "Transferencia", deposito: "Depósito bancario" };
		const refs = d.references || [];
		const ded = d.deductions || [];
		const facturas = refs.filter((x) => x.allocated_amount > 0).reduce((s, x) => s + x.allocated_amount, 0);
		const notas = refs.filter((x) => x.allocated_amount < 0).reduce((s, x) => s - x.allocated_amount, 0);
		const row = (l, v, cls) => `<div class="cp-total-row${cls ? ` ${cls}` : ""}"><span>${l}</span><span>${v}</span></div>`;
		this.$body.html(`
<div class="cp-wrap cp-has-actionbar">
	<div class="cp-page-head">
		<button type="button" class="cp-back" id="pg-back">← ${this._came_from === "list" ? "Pagos realizados" : "Pagos"}</button>
		<div class="cp-h1">${pgEsc(p.name)} ${pgBadge(p.docstatus)}</div>
		<div class="cp-muted cp-head-meta">Elaborado por <b>${pgEsc(p.owner_fullname)}</b>${p.validado_por_fullname ? ` · Validado por <b>${pgEsc(p.validado_por_fullname)}</b>` : ""}</div>
	</div>
	<div class="cp-card"><div class="cp-grid">
		<div class="cp-field cp-field-wide"><label class="cp-label">Proveedor</label><div class="cp-input cp-ro">${pgEsc(p.supplier_name)}</div></div>
		<div class="cp-field"><label class="cp-label">Fecha</label><div class="cp-input cp-ro">${pgDate(p.posting_date)}</div></div>
		<div class="cp-field"><label class="cp-label">Forma de pago</label><div class="cp-input cp-ro">${pgEsc(formas[p.forma] || d.mode_of_payment || "")}</div></div>
		${p.reference_no ? `<div class="cp-field"><label class="cp-label">Referencia</label><div class="cp-input cp-ro">${pgEsc(p.reference_no)}</div></div>` : ""}
		<div class="cp-field"><label class="cp-label">Cuenta</label><div class="cp-input cp-ro">${pgEsc(d.paid_from)}</div></div>
		${p.remarks ? `<div class="cp-field cp-field-wide"><label class="cp-label">Observaciones</label><div class="cp-input cp-ro">${pgEsc(p.remarks)}</div></div>` : ""}
	</div></div>
	<div class="cp-card">
		<div class="cp-section-title" style="margin-top:0;">Documentos aplicados</div>
		${refs.length ? `<table class="cp-table cp-cards"><thead><tr><th>Documento</th><th>No. Proveedor</th><th>Fecha</th><th class="cp-num">Aplicado</th></tr></thead>
			<tbody>${refs.map((x) => `<tr class="cp-row-link" data-open="${pgEsc(x.reference_name)}" data-ret="${x.is_return ? 1 : 0}">
				<td data-label="Documento" class="cp-strong">${x.allocated_amount < 0 ? "Nota de crédito" : "Factura"} ${pgEsc(x.reference_name)}</td>
				<td data-label="No. Proveedor">${pgEsc(x.bill_no || "")}</td><td data-label="Fecha">${pgDate(x.posting_date)}</td>
				<td data-label="Aplicado" class="cp-num">${pgMoney(x.allocated_amount)}</td></tr>`).join("")}</tbody></table>`
			: `<div class="cp-empty">Pago sin facturas (anticipo).</div>`}
	</div>
	<div class="cp-card cp-totals">
		${row("Facturas pagadas", pgMoney(facturas))}
		${notas ? row("(−) Notas de crédito", pgMoney(notas)) : ""}
		${ded.filter((x) => x.amount < 0).map((x) => row(`(−) ${pgEsc(x.description || x.account)}`, pgMoney(-x.amount))).join("")}
		${d.unallocated_amount > 0 ? row("(+) Anticipo", pgMoney(d.unallocated_amount)) : ""}
		${row("Monto entregado", pgMoney(p.amount), "cp-total-grand")}
		${p.cargos_bancarios ? row("Cargos bancarios", pgMoney(p.cargos_bancarios)) : ""}
	</div>
	<div class="cp-actionbar">
		<a class="cp-btn cp-btn-ghost" href="/app/payment-entry/${encodeURIComponent(p.name)}" target="_blank">Abrir en ERP</a>
		<button type="button" class="cp-btn cp-btn-secondary" id="pg-print">Imprimir</button>
		${p.docstatus === 1 && this._can("cancelar") ? `<button type="button" class="cp-btn cp-btn-danger" id="pg-cancel">Cancelar pago</button>` : ""}
		<span class="cp-spacer"></span>
		<button type="button" class="cp-btn cp-btn-secondary" id="pg-estado">Estado de cuenta</button>
	</div>
</div>`);
		const $b = this.$body;
		$b.on("click", "#pg-back", () => this._internal_back());
		$b.on("click", "#pg-print", () => {
			const url = `/printview?doctype=Payment%20Entry&name=${encodeURIComponent(p.name)}&format=${encodeURIComponent("FacEx Pago a Proveedor")}&no_letterhead=1&trigger_print=1`;
			window.open(frappe.urllib.get_full_url(url), "_blank");
		});
		$b.on("click", "#pg-estado", () => this._go("estado", { supplier: p.supplier }));
		$b.on("click", "tr[data-open]", (e) => {
			const $r = $(e.currentTarget);
			window.open(`/app/facex-compras?${$r.data("ret") ? "nota" : "factura"}=${encodeURIComponent($r.data("open"))}`, "_blank");
		});
		$b.on("click", "#pg-cancel", () => {
			frappe.confirm(`¿Cancelar el pago <b>${pgEsc(p.name)}</b>? Las facturas vuelven a quedar pendientes.`, () => {
				frappe.call({
					method: "facex_multi.api.compras.pagos.cancel_payment",
					args: { name: p.name },
					freeze: true,
					callback: (r) => {
						if (r.message) frappe.show_alert({ message: "Pago cancelado.", indicator: "blue" });
						this._go("form", { name: p.name });
					},
				});
			});
		});
	}

	// ──────────────────────────────────────────────
	// Estado de cuenta
	// ──────────────────────────────────────────────

	_render_estado(arg) {
		const st = this._estado || (this._estado = {
			supplier: "", supplier_label: "",
			start_date: frappe.datetime.add_months(frappe.datetime.get_today(), -3), end_date: frappe.datetime.get_today(),
		});
		if (arg.supplier) { st.supplier = arg.supplier; st.supplier_label = arg.supplier; }
		this.$body.html(`
<div class="cp-wrap">
	<div class="cp-page-head cp-noprint">
		<button type="button" class="cp-back" id="pg-back">← Pagos</button>
		<div class="cp-h1">Estado de cuenta de proveedor</div>
	</div>
	<div class="cp-card cp-filters cp-noprint">
		<div class="cp-field cp-field-wide"><label class="cp-label">Proveedor</label>
			<div class="cp-ac"><input type="text" class="cp-input" id="pg-e-supplier" placeholder="Buscar proveedor..." value="${pgEsc(st.supplier_label)}" data-value="${pgEsc(st.supplier)}"></div></div>
		<div class="cp-field"><label class="cp-label">Desde</label><input type="date" class="cp-input" id="pg-e-start" value="${pgEsc(st.start_date)}"></div>
		<div class="cp-field"><label class="cp-label">Hasta</label><input type="date" class="cp-input" id="pg-e-end" value="${pgEsc(st.end_date)}"></div>
		<div class="cp-field cp-field-btn"><button type="button" class="cp-btn cp-btn-secondary cp-block" id="pg-e-apply">Consultar</button></div>
	</div>
	<div id="pg-estado-body"><div class="cp-card cp-empty">Seleccione un proveedor.</div></div>
</div>`);
		const $b = this.$body;
		$b.on("click", "#pg-back", () => this._go("home"));
		$b.on("click", "#pg-e-apply", () => this._load_estado());
		$b.on("click", "#pg-e-print", () => window.print());
		$b.on("click", "#pg-e-pay", () => this._go("form", { supplier: st.supplier }));
		this._bind_supplier_ac($b.find("#pg-e-supplier"), { on_pick: () => this._load_estado() });
		if (st.supplier) this._load_estado();
	}

	_load_estado() {
		const $b = this.$body;
		const st = this._estado;
		const $s = $b.find("#pg-e-supplier");
		st.supplier = $s.val().trim() ? ($s.attr("data-value") || "") : "";
		st.supplier_label = st.supplier ? $s.val() : "";
		st.start_date = $b.find("#pg-e-start").val();
		st.end_date = $b.find("#pg-e-end").val();
		if (!st.supplier) return;
		const $c = $b.find("#pg-estado-body").html(`<div class="cp-empty">Cargando...</div>`);
		frappe.call({
			method: "facex_multi.api.compras.pagos.get_statement",
			args: { supplier: st.supplier, company: this.company, start_date: st.start_date, end_date: st.end_date },
			callback: (r) => {
				if (this.view !== "estado") return;
				const d = r.message;
				$s.val(d.supplier_name || d.supplier);
				st.supplier_label = d.supplier_name || d.supplier;
				const open = d.open || {};
				const pend = (open.facturas || []).reduce((s, x) => s + x.outstanding_amount, 0);
				const cred = (open.notas || []).reduce((s, x) => s + x.credito, 0) + (open.anticipos || []).reduce((s, x) => s + x.unallocated_amount, 0);
				$c.html(`
<div class="cp-card">
	<div class="cp-card-head">
		<div><div class="cp-strong" style="font-size:16px;">${pgEsc(d.supplier_name)}</div>
			<div class="cp-muted">${d.supplier_tax_id ? `NIT ${pgEsc(d.supplier_tax_id)} · ` : ""}${pgEsc(d.company)} · del ${pgDate(d.start_date)} al ${pgDate(d.end_date)}</div></div>
		<div class="cp-noprint" style="display:flex;gap:8px;">
			<button type="button" class="cp-btn cp-btn-secondary" id="pg-e-print">Imprimir</button>
			${this._can("grabar_borrador") && pend > 0 ? `<button type="button" class="cp-btn cp-btn-primary" id="pg-e-pay">Pagar</button>` : ""}
		</div>
	</div>
	<table class="cp-table cp-cards">
		<thead><tr><th>Fecha</th><th>Documento</th><th>Referencia</th><th class="cp-num">Cargo</th><th class="cp-num">Abono</th><th class="cp-num">Saldo</th></tr></thead>
		<tbody>
			<tr><td data-label="Fecha">${pgDate(d.start_date)}</td><td data-label="Documento" class="cp-strong">Saldo inicial</td><td></td><td></td><td></td><td data-label="Saldo" class="cp-num cp-strong">${pgMoney(d.opening)}</td></tr>
			${d.rows.map((x) => `<tr>
				<td data-label="Fecha">${pgDate(x.posting_date)}</td>
				<td data-label="Documento">${pgEsc(x.tipo)} ${pgEsc(x.voucher_no)}</td>
				<td data-label="Referencia">${pgEsc(x.bill_no || ((x.reference_no || "").startsWith("EFE-") ? x.mode_of_payment || "" : x.reference_no || ""))}</td>
				<td data-label="Cargo" class="cp-num">${x.cargo ? pgMoney(x.cargo) : ""}</td>
				<td data-label="Abono" class="cp-num">${x.abono ? pgMoney(x.abono) : ""}</td>
				<td data-label="Saldo" class="cp-num">${pgMoney(x.saldo)}</td></tr>`).join("")}
			<tr><td></td><td data-label="Documento" class="cp-strong">Saldo al ${pgDate(d.end_date)}</td><td></td><td></td><td></td><td data-label="Saldo" class="cp-num cp-strong">${pgMoney(d.closing)}</td></tr>
		</tbody>
	</table>
</div>
<div class="cp-card">
	<div class="cp-section-title" style="margin-top:0;">Documentos abiertos hoy</div>
	${(open.facturas || []).length ? `<table class="cp-table cp-cards"><thead><tr><th>Factura</th><th>No. Proveedor</th><th>Fecha</th><th>Vence</th><th class="cp-num">Saldo</th></tr></thead>
		<tbody>${open.facturas.map((x) => `<tr><td data-label="Factura" class="cp-strong">${pgEsc(x.name)}</td><td data-label="No. Proveedor">${pgEsc(x.bill_no || "")}</td>
			<td data-label="Fecha">${pgDate(x.posting_date)}</td><td data-label="Vence" class="${x.vencida ? "cp-text-bad" : ""}">${pgDate(x.due_date)}</td>
			<td data-label="Saldo" class="cp-num">${pgMoney(x.outstanding_amount)}</td></tr>`).join("")}</tbody></table>` : `<div class="cp-muted">Sin facturas pendientes.</div>`}
	<div class="cp-totals" style="margin-top:10px;">
		<div class="cp-total-row"><span>Facturas pendientes</span><span>${pgMoney(pend)}</span></div>
		${cred ? `<div class="cp-total-row"><span>(−) Créditos a favor (NC / anticipos)</span><span>${pgMoney(cred)}</span></div>` : ""}
		<div class="cp-total-row cp-total-grand"><span>Saldo neto</span><span>${pgMoney(pend - cred)}</span></div>
	</div>
</div>`);
			},
		});
	}

	// ──────────────────────────────────────────────
	// Marco: estilos + barra superior persistente
	// ──────────────────────────────────────────────

	_render_frame() {
		this.$root.html(`
<style>${PG_STYLES}</style>
<div class="cp-topbar">
	<button type="button" class="cp-logo" id="cp-logo" title="Pagos a Proveedores">
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#153375" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
		FacEx <span class="cp-logo-sub">Pagos</span>
	</button>
	<div class="cp-topbar-right">
		<div class="cp-topbar-links" id="cp-topbar-links"></div>
		<div class="cp-user">
			<button type="button" class="cp-user-btn" id="cp-user-btn" title="Perfil de Usuario">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
			</button>
			<div class="cp-user-menu" id="cp-user-menu">
				<div class="cp-menu-label">Usuario Conectado</div>
				<div class="cp-user-name">${pgEsc(frappe.session.user_fullname || "Usuario")}</div>
				<div class="cp-user-email">${pgEsc(frappe.session.user)}</div>
				<div class="cp-menu-links" id="cp-menu-links"></div>
				<div id="cp-company-section" style="display:none;">
					<div class="cp-menu-label">Cambiar Compañía</div>
					<select id="cp-company-select" class="cp-input" style="margin-bottom:8px;"></select>
					<button type="button" class="cp-btn cp-btn-secondary cp-block" id="cp-company-apply">Aplicar Compañía</button>
					<hr>
				</div>
				<button type="button" class="cp-btn cp-btn-secondary cp-block" id="cp-reload" title="Limpia la caché y recarga con la última versión"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-right:4px"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>Recargar</button>
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
				frappe.confirm("Hay cambios sin guardar. ¿Desea salir de todos modos?", () => this._go("home"));
			} else {
				this._go("home");
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
		this.$root.find("#cp-reload").on("click", () => facex_multi.reload_app(!!this.dirty));
		this.$root.find("#cp-logout").on("click", () => frappe.app.logout());
		this.$root.find("#cp-change-password").on("click", () => {
			$menu.hide();
			this._change_password();
		});
	}

	_render_topbar_links() {
		const p = this.defaults.permissions || {};
		const links = [
			p.puede_compras && ["Compras", "/app/facex-compras"],
			p.puede_facturar && ["Facturador", "/app/facex"],
			p.puede_ver_pos && ["POS", "/app/facex-screen"],
			p.puede_ver_menu_inventario && ["Inventario", "/app/facex-inventario"],
		].filter(Boolean);
		const html = links.map(([label, href]) =>
			`<a class="cp-topbar-link" href="${href}">${pgEsc(label)}</a>`).join("");
		this.$root.find("#cp-topbar-links").html(html);
		// En móvil los accesos viven dentro del menú de usuario.
		this.$root.find("#cp-menu-links").html(links.length
			? `<div class="cp-menu-label">Ir a</div>${html}<hr>` : "");

		const companies = this.defaults.companies || [];
		if (companies.length > 1) {
			this.$root.find("#cp-company-select").html(companies.map((c) =>
				`<option value="${pgEsc(c)}"${c === this.defaults.company ? " selected" : ""}>${pgEsc(c)}</option>`).join(""));
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
	// Autocompletado genérico (proveedores / productos)
	// ──────────────────────────────────────────────

	_bind_supplier_ac($input, opts = {}) {
		this._bind_ac($input, {
			method: "facex_multi.api.compras.facturas.search_suppliers",
			render: (s) => `<div class="cp-strong">${pgEsc(s.label)}</div><div class="cp-muted">${pgEsc(s.value)}${s.tax_id ? ` · NIT ${pgEsc(s.tax_id)}` : ""}</div>`,
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
const PG_STYLES = `
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
/* v16: el Desk envuelve el page en .container y en la columna
   .layout-main-section-wrapper (ancho de grilla aunque no haya barra lateral). */
body.facex-fullscreen-mode .page-container .container,
body.facex-fullscreen-mode .main-section > .container,
body.facex-fullscreen-mode .container.page-body,
body.facex-fullscreen-mode .layout-main-section-wrapper {
  flex: 0 0 100% !important;
  width: 100% !important; max-width: 100% !important; padding-left: 0 !important; padding-right: 0 !important;
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

.pg-warn { color:#b45309;font-weight:700; }
@media print {
  .cp-topbar, .cp-noprint, .cp-actionbar { display:none !important; }
  .cp-card { border:none; padding:0; }
  .cp-cards thead { display:table-header-group !important; }
}

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
