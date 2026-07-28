/**
 * FacexTransporteModule — módulo compartido de Transporte (Maestros,
 * Documentos, Reportes y KPIs), instanciado tanto por FacEx Screen
 * (page/facex_screen) como por FacEx Clásico (page/facex). Fuente única
 * de esta lógica: antes vivía duplicada en ambos controladores; ahora
 * cada host solo monta el módulo dentro de su propio contenedor y le
 * delega la navegación interna (hub → sub-pantallas → volver al hub).
 *
 * Se sirve como asset estático (apps/facex_multi/facex_multi/public está
 * symlinkeado a sites/assets/facex_multi), sin build step: basta con
 * cargar este archivo antes de instanciar la clase, vía frappe.require.
 *
 * Reutiliza el prefijo de clases CSS "efs-" heredado de FacEx Screen — no
 * colisiona con el prefijo "ef-" (una sola f) de FacEx Clásico, así que no
 * hubo necesidad de renombrar las plantillas HTML originales.
 */

function _eft_esc(str) {
	if (str === undefined || str === null) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function _eft_fmt(n) {
	return (parseFloat(n) || 0).toLocaleString("es-GT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const ESTADOS_GUIA = ["Pendiente", "Recolectado", "En tránsito", "Entregado", "Anulado"];

class FacexTransporteModule {
	// $container: dónde se monta cada pantalla (se reemplaza por completo en
	//   cada navegación interna, igual que un mini-router).
	// perms: objeto de permisos de FacEx Settings (this.perms del host).
	// company: compañía activa del host.
	// onBack: opcional — si se pasa, el hub muestra un botón "← Volver" que
	//   lo invoca (Screen lo usa para cerrar el overlay de Transporte).
	//   Si no se pasa (Clásico, donde Transporte es un tab de nivel superior
	//   como Inventario o POS), el hub no muestra botón de volver.
	constructor({ $container, perms, company, onBack } = {}) {
		this.$container = $container;
		this.perms = perms || {};
		this.company = company || "";
		this.onBack = typeof onBack === "function" ? onBack : null;
		this._injectStyles();
	}

	setContext({ perms, company } = {}) {
		if (perms) this.perms = perms;
		if (company !== undefined) this.company = company;
	}

	_injectStyles() {
		if (FacexTransporteModule._stylesInjected) return;
		FacexTransporteModule._stylesInjected = true;
		$(`<style id="facex-transporte-module-styles">${EFT_STYLES}</style>`).appendTo("head");
	}

	_hasAccess() {
		const p = this.perms || {};
		if (!p.puede_ver_menu_transporte) return false;
		return !!(p.puede_editar_guias_transporte || p.puede_administrar_transportistas
			|| p.puede_ver_reportes_transporte || p.puede_cargar_liquidaciones_transporte || p.puede_ver_kpis_transporte);
	}

	_wizardHeader(title, { back = false, extraHtml = "" } = {}) {
		return `
			<div class="efs-wizard-header">
				${back ? `<button type="button" class="efs-step-nav" id="eft-back-btn">← Volver</button>` : ""}
				<div class="efs-wizard-title">${_eft_esc(title)}</div>
				${extraHtml}
			</div>
		`;
	}

	// -----------------------------------------------------------------------
	// Hub — pantalla única de entrada, tarjetas por Maestros / Documentos /
	// Reportes (cada una visible solo si el permiso correspondiente aplica) +
	// KPIs al final.
	// -----------------------------------------------------------------------

	showHub() {
		const p = this.perms || {};

		const truckSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>`;
		const usersSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>`;
		const reportSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"></line><line x1="12" y1="20" x2="12" y2="4"></line><line x1="6" y1="20" x2="6" y2="14"></line></svg>`;
		const cashSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"></rect><circle cx="12" cy="12" r="2.5"></circle></svg>`;
		const checklistSvg = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><path d="M8 12l2.5 2.5L16 9"></path></svg>`;

		const sections = [
			{
				title: __("Maestros"),
				cards: [
					p.puede_administrar_transportistas ? {
						icon: usersSvg, label: __("Transportistas"),
						desc: __("Catálogo de transportistas: nombre, teléfono y URL de rastreo."),
						action: () => this.showTransportistas(),
					} : null,
				].filter(Boolean),
			},
			{
				title: __("Documentos"),
				cards: [
					p.puede_editar_guias_transporte ? {
						icon: truckSvg, label: __("Envíos Pendientes"), badgeId: "eft-hub-badge-pending",
						desc: __("Facturas Contra Entrega sin guía capturada todavía."),
						action: () => this.showPendingGuias(),
					} : null,
					p.puede_editar_guias_transporte ? {
						icon: checklistSvg, label: __("Guías"),
						desc: __("Cambiar estatus de entrega y rastrear guías ya capturadas."),
						action: () => this.showGuias(),
					} : null,
					p.puede_cargar_liquidaciones_transporte ? {
						icon: cashSvg, label: __("Liquidaciones"),
						desc: __("Cargar y conciliar liquidaciones de transportistas."),
						action: () => this.showLiquidaciones(),
					} : null,
				].filter(Boolean),
			},
			{
				title: __("Reportes"),
				cards: [
					p.puede_ver_reportes_transporte ? {
						icon: reportSvg, label: __("Reportes de Transporte"),
						desc: __("Guías por estado, facturas por guía, control de liquidaciones."),
						action: () => this.showReportes(),
					} : null,
				].filter(Boolean),
			},
		].filter((s) => s.cards.length);

		const flatCards = [];
		sections.forEach((s) => s.cards.forEach((c) => flatCards.push(c)));

		this.$container.html(`
			<div class="efs-wizard efs-history-wizard">
				${this._wizardHeader(__("Transporte"), { back: !!this.onBack })}
				${sections.length ? sections.map((s) => `
					<div class="efs-hub-section">
						<div class="efs-hub-section-title">${s.title}</div>
						<div class="efs-hub-cards">
							${s.cards.map((c) => `
								<button type="button" class="efs-hub-card" data-card-idx="${flatCards.indexOf(c)}">
									<span class="efs-hub-card-icon">${c.icon}</span>
									<span class="efs-hub-card-label">${c.label}${c.badgeId ? `<span class="efs-held-badge" id="${c.badgeId}" style="display:none;">0</span>` : ""}</span>
									<span class="efs-hub-card-desc">${c.desc}</span>
								</button>
							`).join("")}
						</div>
					</div>
				`).join("") : `<div class="efs-cust-details-loading">${__("No tiene permisos habilitados para el módulo de Transporte. Consulte con un administrador (FacEx Settings).")}</div>`}
				${p.puede_ver_kpis_transporte ? `
					<div class="efs-hub-section">
						<div class="efs-hub-section-title">${__("Indicadores")}</div>
						<div id="eft-hub-kpis"><div class="efs-cust-details-loading">${__("Cargando KPIs…")}</div></div>
					</div>
				` : ""}
			</div>
		`);
		if (this.onBack) this.$container.find("#eft-back-btn").on("click", () => this.onBack());
		this.$container.find(".efs-hub-card").on("click", (e) => {
			const card = flatCards[$(e.currentTarget).data("card-idx")];
			if (card) card.action();
		});

		if (p.puede_ver_kpis_transporte) this._loadKpis(this.$container.find("#eft-hub-kpis"));
		if (p.puede_editar_guias_transporte) {
			frappe.call({
				method: "facex_multi.api.invoice.get_pending_guias",
				args: { company: this.company },
				callback: (r) => {
					const n = (r.message || []).length;
					const $badge = this.$container.find("#eft-hub-badge-pending");
					if (n > 0) $badge.text(n).show();
					else $badge.hide();
				},
			});
		}
	}

	// -----------------------------------------------------------------------
	// Reportes — los 3 reportes de transporte son "Report" nativos de Frappe
	// (Script Report, ref_doctype Sales Invoice); se corren aquí mismo vía el
	// runner nativo frappe.desk.query_report.run (mismo motor y permisos por
	// rol que ya tenía el Report) y se pintan como tabla simple, sin abrir
	// pestaña nueva.
	// -----------------------------------------------------------------------

	showReportes() {
		const $view = this.$container;
		const reports = [
			{ key: "guias_estado", report_name: "FacEx Guias por Estado de Entrega", label: __("Guías por Estado") },
			{ key: "facturas_guia", report_name: "FacEx Facturas por Numero de Guia", label: __("Facturas por Guía") },
			{ key: "control_liquidaciones", report_name: "FacEx Control de Liquidaciones", label: __("Control de Liquidaciones") },
		];
		this._reportsConfig = reports;

		$view.html(`
			<div class="efs-wizard efs-history-wizard">
				${this._wizardHeader(__("Reportes de Transporte"), { back: true })}
				<div class="efs-report-tabs" id="eft-report-tabs">
					${reports.map((r, i) => `<button type="button" class="efs-report-tab${i === 0 ? " efs-report-tab-active" : ""}" data-key="${r.key}">${r.label}</button>`).join("")}
				</div>
				<div class="efs-report-filters" id="eft-report-filters"></div>
				<div class="efs-report-results" id="eft-report-results"></div>
			</div>
		`);
		$view.find("#eft-back-btn").on("click", () => this.showHub());

		$view.find(".efs-report-tab").on("click", (e) => {
			$view.find(".efs-report-tab").removeClass("efs-report-tab-active");
			$(e.currentTarget).addClass("efs-report-tab-active");
			this._renderReportFilters($(e.currentTarget).data("key"));
		});

		this._renderReportFilters(reports[0].key);
	}

	_populateTransportistaSelect($sel) {
		return frappe.db.get_list("FacEx Transportista", {
			fields: ["name"],
			order_by: "transportista_nombre asc",
			limit: 200,
		}).then((rows) => {
			$sel.append((rows || []).map((r) => `<option value="${_eft_esc(r.name)}">${_eft_esc(r.name)}</option>`).join(""));
		});
	}

	_renderReportFilters(key) {
		const reportName = (this._reportsConfig.find((r) => r.key === key) || {}).report_name;
		const $filters = this.$container.find("#eft-report-filters");
		const $results = this.$container.find("#eft-report-results");
		$results.html("");

		if (key === "facturas_guia") {
			$filters.html(`
				<div class="efs-report-filter-row">
					<input type="text" id="eft-rep-numero-guia" class="efs-input" placeholder="${__("Número de guía (requerido)")}" />
					<select id="eft-rep-transportista" class="efs-input"><option value="">${__("Transportista (todos)")}</option></select>
					<button type="button" class="efs-btn-secondary" id="eft-rep-run">${__("Buscar")}</button>
				</div>
			`);
			this._populateTransportistaSelect($filters.find("#eft-rep-transportista"));
			$filters.find("#eft-rep-run").on("click", () => {
				const numero_guia = ($filters.find("#eft-rep-numero-guia").val() || "").trim();
				if (!numero_guia) {
					frappe.show_alert({ message: __("Ingrese un número de guía."), indicator: "orange" });
					return;
				}
				this._runReport(reportName, { numero_guia, transportista: $filters.find("#eft-rep-transportista").val() || "" }, $results);
			});
		} else if (key === "guias_estado") {
			$filters.html(`
				<div class="efs-report-filter-row">
					<select id="eft-rep-transportista" class="efs-input"><option value="">${__("Transportista (todos)")}</option></select>
					<select id="eft-rep-estado" class="efs-input">
						<option value="">${__("Estado (todos)")}</option>
						${ESTADOS_GUIA.map((e) => `<option value="${_eft_esc(e)}">${_eft_esc(e)}</option>`).join("")}
					</select>
					<button type="button" class="efs-btn-secondary" id="eft-rep-run">${__("Filtrar")}</button>
				</div>
			`);
			this._populateTransportistaSelect($filters.find("#eft-rep-transportista"));
			const run = () => this._runReport(reportName, {
				transportista: $filters.find("#eft-rep-transportista").val() || "",
				estado_entrega: $filters.find("#eft-rep-estado").val() || "",
				company: this.company,
			}, $results);
			$filters.find("#eft-rep-run").on("click", run);
			run();
		} else {
			$filters.html(`
				<div class="efs-report-filter-row">
					<select id="eft-rep-transportista" class="efs-input"><option value="">${__("Transportista (todos)")}</option></select>
					<select id="eft-rep-estado" class="efs-input">
						<option value="">${__("Estado (todos)")}</option>
						<option value="Pendiente">${__("Pendiente")}</option>
						<option value="Liquidado">${__("Liquidado")}</option>
					</select>
					<button type="button" class="efs-btn-secondary" id="eft-rep-run">${__("Filtrar")}</button>
				</div>
			`);
			this._populateTransportistaSelect($filters.find("#eft-rep-transportista"));
			const run = () => this._runReport(reportName, {
				transportista: $filters.find("#eft-rep-transportista").val() || "",
				estado_liquidacion: $filters.find("#eft-rep-estado").val() || "",
			}, $results);
			$filters.find("#eft-rep-run").on("click", run);
			run();
		}
	}

	_runReport(reportName, filters, $results) {
		$results.html(`<div class="efs-cust-details-loading">${__("Cargando…")}</div>`);
		frappe.call({
			method: "frappe.desk.query_report.run",
			args: { report_name: reportName, filters: JSON.stringify(filters) },
			callback: (r) => this._renderReportTable(r.message || {}, $results),
		});
	}

	_renderReportTable(result, $results) {
		const columns = result.columns || [];
		const rows = result.result || [];
		if (!rows.length) {
			$results.html(`<div class="efs-cust-details-loading">${__("Sin resultados.")}</div>`);
			return;
		}
		$results.html(`
			<div class="efs-history-results">
				<table class="efs-stock-table">
					<thead><tr>${columns.map((c) => `<th>${_eft_esc(c.label)}</th>`).join("")}</tr></thead>
					<tbody>
						${rows.map((row) => `
							<tr>
								${columns.map((c) => {
									let val = row[c.fieldname];
									if (c.fieldtype === "Currency") {
										val = val != null ? `Q ${_eft_fmt(val)}` : "";
									} else if (c.fieldtype === "Check") {
										val = val ? "✓" : "";
									} else {
										val = val != null ? _eft_esc(val) : "";
									}
									if (c.fieldname === "numero_guia" && row.sales_invoice) {
										val = `<a href="/app/sales-invoice/${encodeURIComponent(row.sales_invoice)}">${val}</a>`;
									}
									return `<td>${val}</td>`;
								}).join("")}
							</tr>
						`).join("")}
					</tbody>
				</table>
			</div>
		`);
	}

	// -----------------------------------------------------------------------
	// KPIs — tarjetas de conteo por estado + monto COD pendiente + barras
	// simples (CSS puro, sin librería de gráficos) de envíos por día.
	// -----------------------------------------------------------------------

	_loadKpis($box) {
		frappe.call({
			method: "facex_multi.api.invoice.get_transporte_kpis",
			args: { company: this.company, days: 14 },
			callback: (r) => this._renderKpis($box, r.message || {}),
		});
	}

	_renderKpis($box, data) {
		const countMap = {};
		(data.por_estado || []).forEach((r) => { countMap[r.estado] = r.total; });
		const cod = data.cod_pendiente || { total: 0, cantidad: 0 };
		const days = data.days || 14;

		const tilesHtml = ESTADOS_GUIA.map((estado) => `
			<div class="efs-kpi-tile">
				<div class="efs-kpi-tile-value">${countMap[estado] || 0}</div>
				<div class="efs-kpi-tile-label">${_eft_esc(estado)}</div>
			</div>
		`).join("");

		const porDia = data.por_dia || [];
		const maxDia = Math.max(1, ...porDia.map((r) => r.total));
		const barsHtml = porDia.length
			? porDia.map((r) => `
				<div class="efs-kpi-bar-col" title="${_eft_esc(r.fecha)}: ${r.total}">
					<div class="efs-kpi-bar" style="height:${Math.round((r.total / maxDia) * 100)}%"></div>
					<div class="efs-kpi-bar-label">${_eft_esc((r.fecha || "").slice(5))}</div>
				</div>
			`).join("")
			: `<div class="efs-cust-details-loading">${__("Sin envíos con fecha de envío registrada en los últimos {0} días.", [days])}</div>`;

		$box.html(`
			<div class="efs-kpi-section-title">${__("Guías por Estado")}</div>
			<div class="efs-kpi-tiles">${tilesHtml}</div>
			<div class="efs-kpi-tiles efs-kpi-tiles-cod">
				<div class="efs-kpi-tile efs-kpi-tile-cod">
					<div class="efs-kpi-tile-value">Q ${_eft_fmt(cod.total)}</div>
					<div class="efs-kpi-tile-label">${__("COD pendiente de liquidar ({0} guía(s))", [cod.cantidad])}</div>
				</div>
			</div>
			<div class="efs-kpi-section-title">${__("Envíos por Día (últimos {0} días)", [days])}</div>
			<div class="efs-kpi-bars">${barsHtml}</div>
		`);
	}

	// -----------------------------------------------------------------------
	// Envíos Pendientes (Pago Contra Entrega sin guía capturada)
	// -----------------------------------------------------------------------

	showPendingGuias() {
		const $view = this.$container;
		$view.html(`
			<div class="efs-wizard efs-history-wizard">
				${this._wizardHeader(__("Envíos Pendientes"), { back: true })}
				<div class="efs-history-results" id="eft-pending-guias-results">
					<div class="efs-cust-details-loading">${__("Cargando…")}</div>
				</div>
			</div>
		`);
		$view.find("#eft-back-btn").on("click", () => this.showHub());

		frappe.call({
			method: "facex_multi.api.invoice.get_pending_guias",
			args: { company: this.company },
			callback: (r) => {
				this._pendingGuiasRaw = r.message || [];
				this._renderPendingGuiasResults();
			},
		});
	}

	_renderPendingGuiasResults() {
		const $results = this.$container.find("#eft-pending-guias-results");
		const rows = this._pendingGuiasRaw || [];

		if (!rows.length) {
			$results.html(`<div class="efs-cust-details-loading">${__("No hay envíos pendientes de guía.")}</div>`);
			return;
		}

		const eyeIcon = `
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
				<circle cx="12" cy="12" r="3"></circle>
			</svg>
		`;
		const truckIcon = `
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<rect x="1" y="3" width="15" height="13"></rect>
				<polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon>
				<circle cx="5.5" cy="18.5" r="2.5"></circle>
				<circle cx="18.5" cy="18.5" r="2.5"></circle>
			</svg>
		`;
		$results.html(`
			<table class="efs-stock-table">
				<thead><tr><th>${__("Factura")}</th><th>${__("Cliente")}</th><th>${__("Fecha")}</th><th>${__("Total")}</th><th></th></tr></thead>
				<tbody>
					${rows.map((row) => `
						<tr data-name="${_eft_esc(row.name)}">
							<td>${_eft_esc(row.name)}</td>
							<td>${_eft_esc(row.customer_name || "")}</td>
							<td>${_eft_esc(row.posting_date)}</td>
							<td>Q ${_eft_fmt(row.grand_total)}</td>
							<td class="efs-pending-actions">
								<button type="button" class="efs-pending-icon-btn efs-pending-view-btn" data-name="${_eft_esc(row.name)}" title="${__("Ver factura")}">${eyeIcon}</button>
								<button type="button" class="efs-pending-icon-btn efs-pending-assign-btn" data-name="${_eft_esc(row.name)}" title="${__("Asignar guía")}">${truckIcon}</button>
							</td>
						</tr>
					`).join("")}
				</tbody>
			</table>
		`);
		$results.find(".efs-pending-view-btn").on("click", (e) => {
			this._showInvoiceSummaryPopup($(e.currentTarget).data("name"));
		});
		$results.find(".efs-pending-assign-btn").on("click", (e) => {
			const name = $(e.currentTarget).data("name");
			const row = rows.find((r) => r.name === name);
			this._openGuiaCaptureDialog({
				initialRows: [{ monto_cod: row ? row.grand_total : 0 }],
				onSave: (guiaRows) => {
					frappe.call({
						method: "facex_multi.api.invoice.save_guias_transporte",
						args: { invoice_name: name, guias_json: JSON.stringify(guiaRows) },
						freeze: true,
						freeze_message: __("Guardando guía…"),
						callback: () => {
							frappe.show_alert({ message: __("Guía registrada para {0}.", [name]), indicator: "green" });
							this._pendingGuiasRaw = (this._pendingGuiasRaw || []).filter((r) => r.name !== name);
							this._renderPendingGuiasResults();
						},
					});
				},
			});
		});
	}

	// Resumen rápido de una factura en un popup, sin navegar fuera de Envíos
	// Pendientes ni depender de ningún estado del host.
	_showInvoiceSummaryPopup(name) {
		const dlg = new frappe.ui.Dialog({
			title: __("Factura {0}", [name]),
			size: "small",
		});
		dlg.$body.html(`<div class="efs-cust-details-loading">${__("Cargando…")}</div>`);
		dlg.show();
		frappe.call({
			method: "facex_multi.api.invoice.get_invoice",
			args: { name },
			callback: (r) => {
				const doc = r.message;
				if (!doc) {
					dlg.$body.html(`<div class="efs-cust-details-loading">${__("No se pudo cargar la factura.")}</div>`);
					return;
				}
				const items = doc.items || [];
				const rows = items.map((it) => `
					<div class="efs-mini-ticket-row">
						<span class="efs-mini-ticket-qty">${_eft_esc(it.qty)}×</span>
						<span class="efs-mini-ticket-name">${_eft_esc(it.item_name)}</span>
						<span class="efs-mini-ticket-amt">Q ${_eft_fmt(it.amount)}</span>
					</div>
				`).join("");
				const estadoLabel = doc.docstatus === 2 ? __("Cancelada") : (doc.docstatus === 1 ? (doc.bfel_uuid ? __("Certificada") : __("Validada")) : __("Borrador"));
				dlg.$body.html(`
					<div class="efs-mini-ticket">
						<div class="efs-mini-ticket-head">
							<span>${_eft_esc(doc.customer_name || doc.customer || "")}</span>
							<span>${_eft_esc(doc.posting_date || "")}</span>
						</div>
						<div class="efs-mini-ticket-items">${rows}</div>
						<div class="efs-mini-ticket-row efs-mini-ticket-total">
							<span>TOTAL</span>
							<span>Q ${_eft_fmt(doc.grand_total)}</span>
						</div>
						<div class="efs-mini-ticket-payhead">${__("Estado")}: ${_eft_esc(estadoLabel)}</div>
					</div>
				`);
			},
		});
	}

	// Diálogo genérico para capturar una o varias guías (transportista/número/
	// piezas/destino/monto COD) al asignar guía desde Envíos Pendientes.
	_openGuiaCaptureDialog({ initialRows = [], onSave } = {}) {
		const openDialog = (transportistas) => {
			const options = transportistas.map((t) => `<option value="${_eft_esc(t.name)}">${_eft_esc(t.name)}</option>`).join("");
			const $rows = $('<div class="efs-guias-rows"></div>');
			const $addBtn = $(`<button class="efs-btn-link" type="button">${__("+ Agregar otra guía")}</button>`);

			const addRow = (data = {}) => {
				const $row = $(`
					<div class="efs-guia-row">
						<select class="efs-guia-transportista">
							<option value="">${__("Transportista…")}</option>
							${options}
						</select>
						<input type="text" class="efs-guia-numero" placeholder="${__("Número de guía")}" />
						<input type="number" class="efs-guia-piezas" placeholder="${__("Piezas")}" min="1" value="1" />
						<input type="text" class="efs-guia-destino" placeholder="${__("Destino")}" />
						<input type="number" class="efs-guia-monto" placeholder="${__("Monto COD")}" min="0" step="any" />
						<button class="efs-line-remove" type="button">×</button>
					</div>
				`);
				$row.find(".efs-guia-transportista").val(data.transportista || "");
				$row.find(".efs-guia-numero").val(data.numero_guia || "");
				$row.find(".efs-guia-piezas").val(data.piezas || 1);
				$row.find(".efs-guia-destino").val(data.destino || "");
				$row.find(".efs-guia-monto").val(data.monto_cod != null && data.monto_cod !== "" ? data.monto_cod : "");
				$row.find(".efs-line-remove").on("click", () => {
					if ($rows.children().length > 1) {
						$row.remove();
					} else {
						$row.find("input").val("");
						$row.find(".efs-guia-piezas").val(1);
						$row.find("select").val("");
					}
				});
				$rows.append($row);
			};

			(initialRows.length ? initialRows : [{}]).forEach((g) => addRow(g));
			$addBtn.on("click", () => addRow());

			const collectRows = () => {
				const out = [];
				$rows.find(".efs-guia-row").each((_, el) => {
					const $r = $(el);
					const transportista = $r.find(".efs-guia-transportista").val();
					const numero_guia = ($r.find(".efs-guia-numero").val() || "").trim();
					if (!transportista && !numero_guia) return;
					out.push({
						transportista,
						numero_guia,
						piezas: parseInt($r.find(".efs-guia-piezas").val()) || 1,
						destino: $r.find(".efs-guia-destino").val() || "",
						monto_cod: parseFloat($r.find(".efs-guia-monto").val()) || 0,
					});
				});
				return out;
			};

			const dlg = new frappe.ui.Dialog({
				title: __("Envíos por Transporte"),
				size: "large",
				primary_action_label: __("Guardar Guías"),
				primary_action: () => {
					const rows = collectRows();
					const incompletas = rows.some((r) => !r.transportista || !r.numero_guia);
					if (incompletas) {
						frappe.show_alert({ message: __("Cada guía necesita Transportista y Número de Guía."), indicator: "orange" });
						return;
					}
					dlg.hide();
					if (onSave) onSave(rows);
				},
			});

			dlg.$body.append(
				$('<div class="efs-guias-hint"></div>').text(__("Puede agregar varias guías si el envío se divide en varios paquetes o transportistas.")),
				$rows,
				$addBtn,
			);
			dlg.show();
		};

		if (this._transportistaOptions) {
			openDialog(this._transportistaOptions);
			return;
		}
		frappe.db.get_list("FacEx Transportista", {
			filters: { activo: 1 },
			fields: ["name"],
			order_by: "transportista_nombre asc",
			limit: 100,
		}).then((rows) => {
			this._transportistaOptions = rows || [];
			openDialog(this._transportistaOptions);
		});
	}

	// -----------------------------------------------------------------------
	// Guías — cambiar estatus de entrega y rastrear guías ya capturadas
	// (a diferencia de Envíos Pendientes, que solo lista facturas SIN guía
	// todavía). El cambio de estatus pasa por update_guia_estado, que hace
	// doc.save() del Sales Invoice — mismo permiso puede_editar_guias_transporte
	// que ya gobierna captura/edición de guías, sin bypasses.
	// -----------------------------------------------------------------------

	showGuias() {
		const $view = this.$container;
		$view.html(`
			<div class="efs-wizard efs-history-wizard">
				${this._wizardHeader(__("Guías"), { back: true })}
				<div class="efs-report-filters">
					<div class="efs-report-filter-row">
						<select id="eft-guias-transportista" class="efs-input"><option value="">${__("Transportista (todos)")}</option></select>
						<select id="eft-guias-estado" class="efs-input">
							<option value="">${__("Estado (todos)")}</option>
							${ESTADOS_GUIA.map((e) => `<option value="${_eft_esc(e)}">${_eft_esc(e)}</option>`).join("")}
						</select>
						<button type="button" class="efs-btn-secondary" id="eft-guias-filter">${__("Filtrar")}</button>
					</div>
				</div>
				<div class="efs-history-results" id="eft-guias-results">
					<div class="efs-cust-details-loading">${__("Cargando…")}</div>
				</div>
			</div>
		`);
		$view.find("#eft-back-btn").on("click", () => this.showHub());
		this._populateTransportistaSelect($view.find("#eft-guias-transportista"));

		frappe.db.get_list("FacEx Transportista", { fields: ["name", "url_tracking"], limit: 200 }).then((rows) => {
			this._transportistaTrackingUrls = {};
			(rows || []).forEach((r) => { this._transportistaTrackingUrls[r.name] = r.url_tracking || ""; });
		});

		const run = () => this._loadGuias({
			transportista: $view.find("#eft-guias-transportista").val() || "",
			estado_entrega: $view.find("#eft-guias-estado").val() || "",
		});
		$view.find("#eft-guias-filter").on("click", run);
		run();
	}

	_loadGuias(filters) {
		const $results = this.$container.find("#eft-guias-results");
		$results.html(`<div class="efs-cust-details-loading">${__("Cargando…")}</div>`);
		frappe.call({
			method: "facex_multi.api.invoice.get_guias_transporte",
			args: { company: this.company, estado_entrega: filters.estado_entrega, transportista: filters.transportista },
			callback: (r) => {
				this._guiasRaw = r.message || [];
				this._renderGuiasResults();
			},
		});
	}

	_renderGuiasResults() {
		const $results = this.$container.find("#eft-guias-results");
		const rows = this._guiasRaw || [];
		const urls = this._transportistaTrackingUrls || {};

		if (!rows.length) {
			$results.html(`<div class="efs-cust-details-loading">${__("No hay guías capturadas con estos filtros.")}</div>`);
			return;
		}

		$results.html(`
			<table class="efs-stock-table">
				<thead>
					<tr>
						<th>${__("Guía")}</th><th>${__("Transportista")}</th><th>${__("Factura")}</th><th>${__("Cliente")}</th>
						<th>${__("Piezas")}</th><th>${__("Destino")}</th><th>${__("Monto COD")}</th><th>${__("Liquidado")}</th>
						<th>${__("Estado")}</th><th></th>
					</tr>
				</thead>
				<tbody>
					${rows.map((row, idx) => `
						<tr data-idx="${idx}">
							<td>${_eft_esc(row.numero_guia)}</td>
							<td>${_eft_esc(row.transportista || "")}</td>
							<td><a href="/app/sales-invoice/${encodeURIComponent(row.sales_invoice)}">${_eft_esc(row.sales_invoice)}</a></td>
							<td>${_eft_esc(row.customer_name || "")}</td>
							<td>${row.piezas || 0}</td>
							<td>${_eft_esc(row.destino || "")}</td>
							<td>Q ${_eft_fmt(row.monto_cod)}</td>
							<td>${row.liquidado ? "✓" : "—"}</td>
							<td>
								<select class="efs-input efs-guias-estado-select" data-idx="${idx}">
									${ESTADOS_GUIA.map((e) => `<option value="${e}" ${e === row.estado_entrega ? "selected" : ""}>${e}</option>`).join("")}
								</select>
							</td>
							<td>${urls[row.transportista] && urls[row.transportista].includes("{guia}") ? `<button type="button" class="efs-btn-link efs-guias-track" data-idx="${idx}">${__("Rastrear")}</button>` : ""}</td>
						</tr>
					`).join("")}
				</tbody>
			</table>
		`);

		$results.find(".efs-guias-estado-select").on("change", (e) => {
			const $sel = $(e.currentTarget);
			const row = rows[$sel.data("idx")];
			const nuevoEstado = $sel.val();
			frappe.call({
				method: "facex_multi.api.invoice.update_guia_estado",
				args: { sales_invoice: row.sales_invoice, guia_name: row.guia_name, estado_entrega: nuevoEstado },
				freeze: true,
				freeze_message: __("Actualizando estado…"),
				callback: () => {
					row.estado_entrega = nuevoEstado;
					frappe.show_alert({ message: __("Estado actualizado: {0}.", [row.numero_guia]), indicator: "green" });
				},
				error: () => {
					$sel.val(row.estado_entrega);
				},
			});
		});

		$results.find(".efs-guias-track").on("click", (e) => {
			const row = rows[$(e.currentTarget).data("idx")];
			const pattern = urls[row.transportista];
			if (pattern) window.open(pattern.replace("{guia}", encodeURIComponent(row.numero_guia)), "_blank");
		});
	}

	// -----------------------------------------------------------------------
	// Transportistas — catálogo embebido. El permiso real lo sigue validando
	// el controller del doctype (FacExTransportista.validate/on_trash vía
	// get_facex_can_administer_transportistas), así que se guarda con
	// frappe.client.insert/save normales, sin duplicar esa lógica aquí.
	// -----------------------------------------------------------------------

	showTransportistas() {
		const $view = this.$container;
		$view.html(`
			<div class="efs-wizard efs-history-wizard">
				${this._wizardHeader(__("Transportistas"), { back: true, extraHtml: `<button type="button" class="efs-btn-link" id="eft-btn-new-transportista" style="margin-left:auto;">${__("+ Nuevo Transportista")}</button>` })}
				<div class="efs-history-results" id="eft-transportistas-results">
					<div class="efs-cust-details-loading">${__("Cargando…")}</div>
				</div>
			</div>
		`);
		$view.find("#eft-back-btn").on("click", () => this.showHub());
		$view.find("#eft-btn-new-transportista").on("click", () => this._showTransportistaFormDialog());
		this._loadTransportistas();
	}

	_loadTransportistas() {
		frappe.db.get_list("FacEx Transportista", {
			fields: ["name", "transportista_nombre", "abreviatura", "activo", "telefono_contacto", "url_tracking", "codigo_credito_default"],
			order_by: "transportista_nombre asc",
			limit: 500,
		}).then((rows) => {
			this._transportistasRaw = rows || [];
			this._renderTransportistasResults();
		});
	}

	_renderTransportistasResults() {
		const $results = this.$container.find("#eft-transportistas-results");
		const rows = this._transportistasRaw || [];
		if (!rows.length) {
			$results.html(`<div class="efs-cust-details-loading">${__("No hay transportistas registrados.")}</div>`);
			return;
		}
		$results.html(`
			<table class="efs-stock-table">
				<thead><tr><th>${__("Nombre")}</th><th>${__("Abrev.")}</th><th>${__("Teléfono")}</th><th>${__("Estado")}</th><th></th></tr></thead>
				<tbody>
					${rows.map((row) => `
						<tr class="efs-hist-row" data-name="${_eft_esc(row.name)}">
							<td>${_eft_esc(row.transportista_nombre)}</td>
							<td>${_eft_esc(row.abreviatura || "")}</td>
							<td>${_eft_esc(row.telefono_contacto || "")}</td>
							<td>${row.activo ? __("Activo") : __("Inactivo")}</td>
							<td>${__("Editar")} →</td>
						</tr>
					`).join("")}
				</tbody>
			</table>
		`);
		$results.find(".efs-hist-row").on("click", (e) => {
			const row = rows.find((r) => r.name === $(e.currentTarget).data("name"));
			if (row) this._showTransportistaFormDialog(row.name);
		});
	}

	_showTransportistaFormDialog(existingName) {
		const openDialog = (existingDoc) => {
			const dlg = new frappe.ui.Dialog({
				title: existingDoc ? __("Editar Transportista") : __("Nuevo Transportista"),
				fields: [
					{ fieldname: "transportista_nombre", fieldtype: "Data", label: __("Nombre del Transportista"), reqd: 1 },
					{ fieldname: "abreviatura", fieldtype: "Data", label: __("Abreviatura") },
					{ fieldname: "telefono_contacto", fieldtype: "Data", label: __("Teléfono de Contacto") },
					{ fieldname: "eft_col_break_transportista", fieldtype: "Column Break" },
					{ fieldname: "activo", fieldtype: "Check", label: __("Activo"), default: 1 },
					{ fieldname: "codigo_credito_default", fieldtype: "Data", label: __("Código de Crédito por Defecto") },
					{ fieldname: "url_tracking", fieldtype: "Data", label: __("URL de Rastreo"), description: __("Debe incluir el placeholder {guia}, ej: https://transportista.com/tracking/?guia={guia}") },
				],
				primary_action_label: __("Guardar"),
				primary_action: (values) => {
					const payload = existingDoc ? Object.assign({}, existingDoc, values) : Object.assign({ doctype: "FacEx Transportista" }, values);
					frappe.call({
						method: existingDoc ? "frappe.client.save" : "frappe.client.insert",
						args: { doc: payload },
						freeze: true,
						freeze_message: __("Guardando…"),
						callback: () => {
							frappe.show_alert({ message: __("Transportista guardado."), indicator: "green" });
							dlg.hide();
							this._loadTransportistas();
						},
					});
				},
			});
			if (existingDoc) {
				dlg.set_values(existingDoc);
			} else {
				dlg.set_value("activo", 1);
			}
			dlg.show();
		};

		if (existingName) {
			frappe.db.get_doc("FacEx Transportista", existingName).then(openDialog);
		} else {
			openDialog(null);
		}
	}

	// -----------------------------------------------------------------------
	// Liquidaciones — lista + editor embebidos. La conciliación automática
	// (match_encontrado, sales_invoice, liquidado en la guía, total_depositado)
	// la sigue haciendo FacExLiquidacionTransportista.validate() tal cual —
	// solo se envía el doc completo, igual que haría el form estándar.
	// -----------------------------------------------------------------------

	showLiquidaciones() {
		const $view = this.$container;
		$view.html(`
			<div class="efs-wizard efs-history-wizard efs-liq-wizard-wide">
				${this._wizardHeader(__("Liquidaciones de Transporte"), { back: true, extraHtml: `<button type="button" class="efs-btn-link" id="eft-btn-new-liquidacion" style="margin-left:auto;">${__("+ Nueva Liquidación")}</button>` })}
				<div class="efs-history-results" id="eft-liquidaciones-results">
					<div class="efs-cust-details-loading">${__("Cargando…")}</div>
				</div>
				<div id="eft-liquidacion-editor" style="display:none;"></div>
			</div>
		`);
		$view.find("#eft-back-btn").on("click", () => this.showHub());
		$view.find("#eft-btn-new-liquidacion").on("click", () => this.showLiquidacionEditor());
		this._loadLiquidaciones();
	}

	_loadLiquidaciones() {
		this.$container.find("#eft-liquidaciones-results").show();
		this.$container.find("#eft-btn-new-liquidacion").show();
		this.$container.find("#eft-liquidacion-editor").hide().empty();
		frappe.db.get_list("FacEx Liquidacion Transportista", {
			fields: ["name", "transportista", "fecha", "cliente", "codigo_credito", "total_depositado"],
			order_by: "fecha desc, creation desc",
			limit: 200,
		}).then((rows) => {
			this._liquidacionesRaw = rows || [];
			this._renderLiquidacionesResults();
		});
	}

	_renderLiquidacionesResults() {
		const $results = this.$container.find("#eft-liquidaciones-results");
		const rows = this._liquidacionesRaw || [];
		if (!rows.length) {
			$results.html(`<div class="efs-cust-details-loading">${__("No hay liquidaciones registradas.")}</div>`);
			return;
		}
		$results.html(`
			<table class="efs-stock-table">
				<thead><tr><th>${__("Liquidación")}</th><th>${__("Transportista")}</th><th>${__("Fecha")}</th><th>${__("Cliente")}</th><th>${__("Total Depositado")}</th></tr></thead>
				<tbody>
					${rows.map((row) => `
						<tr class="efs-hist-row" data-name="${_eft_esc(row.name)}">
							<td>${_eft_esc(row.name)}</td>
							<td>${_eft_esc(row.transportista || "")}</td>
							<td>${_eft_esc(row.fecha || "")}</td>
							<td>${_eft_esc(row.cliente || "")}</td>
							<td>Q ${_eft_fmt(row.total_depositado)}</td>
						</tr>
					`).join("")}
				</tbody>
			</table>
		`);
		$results.find(".efs-hist-row").on("click", (e) => {
			this.showLiquidacionEditor($(e.currentTarget).data("name"));
		});
	}

	// Orden fijo de columnas para pegado desde Excel (coincide con el orden
	// visual de la tabla y con el formato que ya usan los transportistas en
	// sus hojas de liquidación) — se mapea por POSICIÓN, no por nombre de
	// columna, así que no importa si el usuario pega con o sin fila de
	// títulos, siempre que respete este orden.
	_LIQ_DETALLE_COLUMNS = ["guia", "piezas", "estado", "monto_cod", "efectivo", "comision", "valor_comision", "monto_liquidado", "operacion", "autorizacion", "numero_cuenta"];

	_normalizeHeaderToken(s) {
		return (s || "").toString().trim().toLowerCase()
			.normalize("NFD").replace(/[̀-ͯ]/g, "")
			.replace(/[^a-z0-9]/g, "");
	}

	// Reconoce la fila de títulos aunque venga en cualquier orden/mayúsculas
	// (GUIA, MONTO COD, VALOR COMISION, NUMERO DE CUENTA, etc.) — si al menos
	// 3 celdas de la primera línea calzan con un nombre de columna conocido,
	// se asume que es encabezado y se descarta; si no, se trata como dato.
	_parseLiqExcelPaste(text) {
		const HEADER_TOKENS = ["guia", "piezas", "estado", "montocod", "cod", "efectivo", "comision", "valorcomision", "montoliquidado", "operacion", "autorizacion", "numerocuenta", "numerodecuenta", "nodecuenta"];
		const normalize = (s) => this._normalizeHeaderToken(s);

		const lines = (text || "").replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
		if (!lines.length) return [];

		let dataLines = lines;
		const firstCells = lines[0].split("\t").map(normalize);
		const looksLikeHeader = firstCells.filter((c) => HEADER_TOKENS.includes(c)).length >= 3;
		if (looksLikeHeader) dataLines = lines.slice(1);

		const parseNum = (v) => {
			const cleaned = String(v == null ? "" : v).replace(/[Qq$,\s%]/g, "").trim();
			const n = parseFloat(cleaned);
			return isNaN(n) ? 0 : n;
		};

		const NUMERIC_COLS = ["monto_cod", "efectivo", "comision", "valor_comision", "monto_liquidado"];
		const rows = [];
		dataLines.forEach((line) => {
			const cells = line.split("\t");
			if (!(cells[0] || "").trim()) return;
			const row = {};
			this._LIQ_DETALLE_COLUMNS.forEach((col, idx) => {
				const raw = cells[idx] != null ? cells[idx].trim() : "";
				if (col === "piezas") row[col] = parseInt(parseNum(raw)) || 0;
				else if (NUMERIC_COLS.includes(col)) row[col] = parseNum(raw);
				else row[col] = raw;
			});
			rows.push(row);
		});
		return rows;
	}

	_openLiquidacionPasteDialog(onApply) {
		const dlg = new frappe.ui.Dialog({
			title: __("Pegar desde Excel"),
			fields: [
				{
					fieldname: "hint", fieldtype: "HTML",
					options: `<div class="efs-cust-details-loading">${__("Copie el rango de Excel (con o sin fila de títulos) y péguelo abajo. Orden de columnas esperado: Guía, Piezas, Estado, Monto COD, Efectivo, Comisión %, Valor Comisión, Monto Liquidado, Operación, Autorización, Número de Cuenta.")}</div>`,
				},
				{ fieldname: "paste_area", fieldtype: "Small Text", label: __("Pegue aquí (Ctrl+V)") },
			],
			primary_action_label: __("Aplicar"),
			primary_action: (values) => {
				const rows = this._parseLiqExcelPaste(values.paste_area);
				if (!rows.length) {
					frappe.show_alert({ message: __("No se detectaron filas válidas en lo pegado."), indicator: "orange" });
					return;
				}
				dlg.hide();
				onApply(rows);
				frappe.show_alert({ message: __("{0} fila(s) agregada(s) desde Excel.", [rows.length]), indicator: "green" });
			},
		});
		dlg.show();
	}

	showLiquidacionEditor(name) {
		this.$container.find("#eft-liquidaciones-results").hide();
		this.$container.find("#eft-btn-new-liquidacion").hide();
		const $editor = this.$container.find("#eft-liquidacion-editor");
		$editor.show();

		const render = (doc) => {
			const rows = (doc && doc.detalle) || [];
			// Cliente por defecto en liquidaciones nuevas: nombre de la compañía
			// activa — el transportista casi siempre liquida contra la razón
			// social de la empresa, no un cliente puntual.
			const defaultCliente = doc ? (doc.cliente || "") : (this.company || "");

			$editor.html(`
				<div class="efs-liq-editor-back">
					<button type="button" class="efs-btn-link" id="eft-liq-editor-back">${__("← Volver a la lista")}</button>
				</div>
				<div class="efs-liq-header-fields">
					<div class="efs-liq-field">
						<label>${__("Transportista")}</label>
						<select id="eft-liq-transportista" class="efs-input"></select>
					</div>
					<div class="efs-liq-field">
						<label>${__("Fecha")}</label>
						<input type="date" id="eft-liq-fecha" class="efs-input" value="${_eft_esc((doc && doc.fecha) || frappe.datetime.get_today())}" />
					</div>
					<div class="efs-liq-field">
						<label>${__("Código de Crédito")}</label>
						<input type="text" id="eft-liq-codigo-credito" class="efs-input" value="${_eft_esc((doc && doc.codigo_credito) || "")}" />
					</div>
					<div class="efs-liq-field">
						<label>${__("Cliente")}</label>
						<input type="text" id="eft-liq-cliente" class="efs-input" value="${_eft_esc(defaultCliente)}" />
					</div>
				</div>
				<div class="efs-liq-table-wrap">
					<table class="efs-liq-table">
						<thead>
							<tr>
								<th>${__("Guía")}</th><th>${__("Piezas")}</th><th>${__("Estado")}</th><th>${__("Monto COD")}</th><th>${__("Efectivo")}</th>
								<th>${__("Comisión %")}</th><th>${__("Valor Comisión")}</th><th>${__("Monto Liquidado")}</th>
								<th>${__("Operación")}</th><th>${__("Autorización")}</th><th>${__("Núm. Cuenta")}</th><th>${__("Match")}</th><th></th>
							</tr>
						</thead>
						<tbody id="eft-liq-table-body"></tbody>
					</table>
				</div>
				<div class="efs-liq-table-actions">
					<button type="button" class="efs-btn-link" id="eft-liq-add-row">${__("+ Agregar guía")}</button>
					<button type="button" class="efs-btn-link" id="eft-liq-paste-excel">${__("📋 Pegar desde Excel")}</button>
				</div>
				<div class="efs-liq-footer-totals" id="eft-liq-footer-totals"></div>
				<div class="efs-liq-actions">
					<button type="button" class="efs-btn-charge" id="eft-liq-save">${__("Guardar Liquidación")}</button>
				</div>
			`);

			this._populateTransportistaSelect(
				$editor.find("#eft-liq-transportista").append(`<option value="">${__("Transportista…")}</option>`)
			).then(() => {
				$editor.find("#eft-liq-transportista").val((doc && doc.transportista) || "");
			});

			// Autocompletar Código de Crédito al elegir transportista — solo en
			// interacción real del usuario, así que no pisa el código ya
			// guardado al reabrir una liquidación existente.
			$editor.find("#eft-liq-transportista").on("change", (e) => {
				const t = e.target.value;
				if (!t) return;
				frappe.db.get_value("FacEx Transportista", t, "codigo_credito_default", (r) => {
					if (r && r.codigo_credito_default) {
						$editor.find("#eft-liq-codigo-credito").val(r.codigo_credito_default);
					}
				});
			});

			const $tbody = $editor.find("#eft-liq-table-body");

			// Total = suma de Efectivo (cobrado bruto). Total Depositado = suma
			// de Monto Liquidado (neto, después de comisión) — ambos se
			// recalculan en vivo desde los inputs, no solo tras guardar.
			// Diferencia = Total Depositado - Total (normalmente negativa: el
			// total de comisiones retenidas; sirve para cuadrar contra la suma
			// de Valor Comisión).
			const recalcTotals = () => {
				let totalEfectivo = 0;
				let totalDepositado = 0;
				$tbody.find(".efs-liq-row").each((_, el) => {
					const $r = $(el);
					totalEfectivo += parseFloat($r.find(".efs-liq-efectivo").val()) || 0;
					totalDepositado += parseFloat($r.find(".efs-liq-monto-liquidado").val()) || 0;
				});
				const diferencia = totalDepositado - totalEfectivo;
				$editor.find("#eft-liq-footer-totals").html(`
					<div class="efs-liq-total-box"><span>${__("Total Depositado")}</span><strong>Q ${_eft_fmt(totalDepositado)}</strong></div>
					<div class="efs-liq-total-box"><span>${__("Total")}</span><strong>Q ${_eft_fmt(totalEfectivo)}</strong></div>
					<div class="efs-liq-total-box${Math.abs(diferencia) > 0.009 ? " efs-liq-total-box-diff" : ""}"><span>${__("Diferencia")}</span><strong>Q ${_eft_fmt(diferencia)}</strong></div>
				`);
			};
			$tbody.on("input", ".efs-liq-efectivo, .efs-liq-monto-liquidado", recalcTotals);

			const addRow = (data = {}) => {
				const $row = $(`
					<tr class="efs-liq-row">
						<td><input type="text" class="efs-liq-guia" value="${_eft_esc(data.guia || "")}" /></td>
						<td><input type="number" min="0" class="efs-liq-piezas" value="${data.piezas != null ? data.piezas : ""}" /></td>
						<td><input type="text" class="efs-liq-estado" value="${_eft_esc(data.estado || "")}" /></td>
						<td><input type="number" step="any" class="efs-liq-monto-cod" value="${data.monto_cod != null ? data.monto_cod : ""}" /></td>
						<td><input type="number" step="any" class="efs-liq-efectivo" value="${data.efectivo != null ? data.efectivo : ""}" /></td>
						<td><input type="number" step="any" class="efs-liq-comision" value="${data.comision != null ? data.comision : ""}" /></td>
						<td><input type="number" step="any" class="efs-liq-valor-comision" value="${data.valor_comision != null ? data.valor_comision : ""}" /></td>
						<td><input type="number" step="any" class="efs-liq-monto-liquidado" value="${data.monto_liquidado != null ? data.monto_liquidado : ""}" /></td>
						<td><input type="text" class="efs-liq-operacion" value="${_eft_esc(data.operacion || "")}" /></td>
						<td><input type="text" class="efs-liq-autorizacion" value="${_eft_esc(data.autorizacion || "")}" /></td>
						<td><input type="text" class="efs-liq-numero-cuenta" value="${_eft_esc(data.numero_cuenta || "")}" /></td>
						<td class="efs-liq-match">${data.match_encontrado ? `✓ ${_eft_esc(data.sales_invoice || "")}` : (data.guia ? "—" : "")}</td>
						<td><button type="button" class="efs-line-remove">×</button></td>
					</tr>
				`);
				$row.find(".efs-line-remove").on("click", () => {
					if ($tbody.children().length > 1) {
						$row.remove();
					} else {
						$row.find("input").val("");
					}
					recalcTotals();
				});
				$tbody.append($row);
			};
			(rows.length ? rows : [{}]).forEach((r) => addRow(r));
			recalcTotals();
			$editor.find("#eft-liq-add-row").on("click", () => addRow());

			$editor.find("#eft-liq-paste-excel").on("click", () => {
				this._openLiquidacionPasteDialog((parsedRows) => {
					// Quita la(s) fila(s) vacías de arranque antes de agregar lo
					// pegado, sin tocar filas que el usuario ya haya llenado a mano.
					$tbody.find(".efs-liq-row").each((_, el) => {
						const $r = $(el);
						if (!($r.find(".efs-liq-guia").val() || "").trim()) $r.remove();
					});
					parsedRows.forEach((r) => addRow(r));
					recalcTotals();
				});
			});

			$editor.find("#eft-liq-editor-back").on("click", () => this._loadLiquidaciones());

			$editor.find("#eft-liq-save").on("click", () => {
				const detalle = [];
				$tbody.find(".efs-liq-row").each((idx, el) => {
					const $r = $(el);
					const guia = ($r.find(".efs-liq-guia").val() || "").trim();
					if (!guia) return;
					detalle.push({
						guia,
						piezas: parseInt($r.find(".efs-liq-piezas").val()) || 0,
						estado: $r.find(".efs-liq-estado").val() || "",
						monto_cod: parseFloat($r.find(".efs-liq-monto-cod").val()) || 0,
						efectivo: parseFloat($r.find(".efs-liq-efectivo").val()) || 0,
						comision: parseFloat($r.find(".efs-liq-comision").val()) || 0,
						valor_comision: parseFloat($r.find(".efs-liq-valor-comision").val()) || 0,
						monto_liquidado: parseFloat($r.find(".efs-liq-monto-liquidado").val()) || 0,
						operacion: $r.find(".efs-liq-operacion").val() || "",
						autorizacion: $r.find(".efs-liq-autorizacion").val() || "",
						numero_cuenta: $r.find(".efs-liq-numero-cuenta").val() || "",
					});
				});

				const transportista = $editor.find("#eft-liq-transportista").val();
				const fecha = $editor.find("#eft-liq-fecha").val();
				if (!transportista || !fecha || !detalle.length) {
					frappe.show_alert({ message: __("Debe indicar transportista, fecha y al menos una guía."), indicator: "orange" });
					return;
				}

				const payload = doc ? Object.assign({}, doc) : { doctype: "FacEx Liquidacion Transportista", naming_series: "LIQ-.YYYY.-" };
				payload.transportista = transportista;
				payload.fecha = fecha;
				payload.codigo_credito = $editor.find("#eft-liq-codigo-credito").val() || "";
				payload.cliente = $editor.find("#eft-liq-cliente").val() || "";
				payload.detalle = detalle;

				frappe.call({
					method: doc ? "frappe.client.save" : "frappe.client.insert",
					args: { doc: payload },
					freeze: true,
					freeze_message: __("Guardando liquidación…"),
					callback: (r) => {
						const saved = r.message;
						const matched = (saved.detalle || []).filter((d) => d.match_encontrado).length;
						const total = (saved.detalle || []).length;
						frappe.show_alert({
							message: __("Liquidación guardada: {0}/{1} guías conciliadas automáticamente.", [matched, total]),
							indicator: matched === total ? "green" : "orange",
						}, 6);
						render(saved);
					},
				});
			});
		};

		if (name) {
			frappe.db.get_doc("FacEx Liquidacion Transportista", name).then(render);
		} else {
			render(null);
		}
	}
}

FacexTransporteModule._stylesInjected = false;

// CSS reutilizado tal cual (prefijo "efs-") de FacEx Screen, más las
// variables --efs-* que antes solo se declaraban ahí — necesarias aquí
// porque FacEx Clásico no las define (usa su propio prefijo "ef-").
const EFT_STYLES = `
:root {
  --efs-primary: #4361ee;
  --efs-success: #2dc653;
  --efs-danger: #e63946;
  --efs-border: #e2e8f0;
  --efs-text: #1e293b;
  --efs-text-muted: #64748b;
  --efs-radius: 12px;
}
.efs-wizard { max-width: 480px; margin: 0 auto; padding: 24px; }
.efs-wizard-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.efs-wizard-title { font-size: 18px; font-weight: 800; }
.efs-history-wizard { max-width: 900px; }
.efs-liq-wizard-wide { max-width: 96vw; }
.efs-history-results { overflow-x: auto; }
.efs-hist-row { cursor: pointer; }
.efs-hist-row:hover { background: #f0f7ff; }
.efs-pending-actions { display: flex; gap: 8px; }
.efs-pending-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--efs-border); border-radius: 8px; background: #fff; color: var(--efs-text-muted); cursor: pointer; transition: border-color .15s, color .15s, background .15s; }
.efs-pending-icon-btn:hover { border-color: var(--efs-primary); color: var(--efs-primary); background: #f0f4ff; }
.efs-pending-assign-btn:hover { border-color: #0d9488; color: #0d9488; background: #ecfdf9; }
.efs-cust-details-loading { font-size: 12px; color: var(--efs-text-muted); padding: 6px 0; }
.efs-stock-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.efs-stock-table th, .efs-stock-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--efs-border); }
.efs-stock-table th { color: var(--efs-text-muted); font-weight: 700; font-size: 11px; }
.efs-line-remove { background: none; border: none; font-size: 18px; color: var(--efs-text-muted); cursor: pointer; padding: 0 6px; }
.efs-line-remove:hover { color: var(--efs-danger); }
.efs-btn-charge {
  width: 100%; padding: 14px; background: var(--efs-primary); color: #fff; border: none;
  border-radius: var(--efs-radius); font-size: 16px; font-weight: 700; cursor: pointer;
}
.efs-btn-charge:disabled { background: #cbd5e1; cursor: not-allowed; }
.efs-btn-secondary {
  padding: 12px; background: #fff; border: 1px solid var(--efs-border); border-radius: var(--efs-radius);
  font-size: 14px; font-weight: 600; cursor: pointer; flex: 1;
}
.efs-btn-link { background: none; border: none; color: var(--efs-primary); cursor: pointer; font-size: 13px; text-decoration: none; }
.efs-held-badge {
  display: inline-block; margin-left: 6px; padding: 1px 7px; font-size: 11px; font-weight: 700;
  border-radius: 10px; background: var(--efs-danger); color: #fff;
}
.efs-step-nav {
  padding: 8px 16px; border-radius: 20px; border: 1px solid var(--efs-border); background: #fff;
  cursor: pointer; font-size: 13px; font-weight: 600;
}
.efs-step-nav:disabled { opacity: .4; cursor: not-allowed; }
.efs-input { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--efs-border); font-size: 13px; background: #fff; }
.efs-report-tabs { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
.efs-report-tab {
  padding: 8px 14px; border-radius: 20px; border: 1px solid var(--efs-border); background: #fff;
  cursor: pointer; font-size: 13px; font-weight: 600; color: var(--efs-text-muted);
}
.efs-report-tab-active { background: var(--efs-primary); border-color: var(--efs-primary); color: #fff; }
.efs-report-filters { margin-bottom: 14px; }
.efs-report-filter-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.efs-report-results { overflow-x: auto; }
.efs-guias-hint { color: var(--efs-text-muted); font-size: 13px; margin-bottom: 12px; }
.efs-guias-rows { display: flex; flex-direction: column; gap: 8px; }
.efs-guia-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.efs-guia-row select, .efs-guia-row input { padding: 8px; border-radius: 8px; border: 1px solid var(--efs-border); }
.efs-guia-row select { flex: 2 1 160px; }
.efs-guia-row input.efs-guia-numero { flex: 2 1 140px; }
.efs-guia-row input.efs-guia-destino { flex: 2 1 140px; }
.efs-guia-row input.efs-guia-piezas, .efs-guia-row input.efs-guia-monto { flex: 1 1 90px; min-width: 80px; max-width: 130px; }
.efs-mini-ticket {
  text-align: left; background: #fff; border: 1px dashed var(--efs-border); border-radius: var(--efs-radius);
  padding: 12px 14px; margin-top: 16px; font-family: "Courier New", monospace; font-size: 12px;
}
.efs-mini-ticket-head {
  display: flex; justify-content: space-between; font-weight: 700; padding-bottom: 6px;
  border-bottom: 1px dashed var(--efs-border); margin-bottom: 6px;
}
.efs-mini-ticket-items { max-height: 180px; overflow-y: auto; }
.efs-mini-ticket-row { display: flex; gap: 6px; padding: 2px 0; }
.efs-mini-ticket-qty { flex: 0 0 auto; color: var(--efs-text-muted); }
.efs-mini-ticket-name { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.efs-mini-ticket-amt { flex: 0 0 auto; text-align: right; }
.efs-mini-ticket-total {
  font-weight: 800; font-size: 14px; border-top: 1px dashed var(--efs-border); margin-top: 6px; padding-top: 6px;
  justify-content: space-between;
}
.efs-mini-ticket-payhead {
  font-weight: 700; text-transform: uppercase; font-size: 10px; color: var(--efs-text-muted);
  margin-top: 10px; padding-top: 6px; border-top: 1px dashed var(--efs-border);
}
.efs-mini-ticket-pay { justify-content: space-between; color: var(--efs-text-muted); }
.efs-liq-editor-back { margin-bottom: 14px; }
.efs-liq-header-fields { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.efs-liq-field { display: flex; flex-direction: column; gap: 4px; min-width: 160px; }
.efs-liq-field label { font-size: 11px; font-weight: 700; color: var(--efs-text-muted); text-transform: uppercase; letter-spacing: .03em; }
.efs-liq-table-wrap { overflow-x: auto; margin-bottom: 10px; }
.efs-liq-table { border-collapse: collapse; font-size: 12px; width: 100%; }
.efs-liq-table th, .efs-liq-table td { padding: 6px; border-bottom: 1px solid var(--efs-border); white-space: nowrap; }
.efs-liq-table th { text-align: left; color: var(--efs-text-muted); font-size: 10px; text-transform: uppercase; }
.efs-liq-table input { width: 90px; padding: 5px 6px; border-radius: 6px; border: 1px solid var(--efs-border); font-size: 12px; }
.efs-liq-table input.efs-liq-guia { width: 110px; }
.efs-liq-match { font-size: 11px; color: var(--efs-success); white-space: normal; max-width: 140px; }
.efs-liq-table-actions { display: flex; gap: 16px; align-items: center; margin-top: 4px; }
.efs-liq-footer-totals { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--efs-border); }
.efs-liq-total-box {
  display: flex; flex-direction: column; gap: 2px; padding: 10px 16px; border-radius: var(--efs-radius);
  background: #f8fafc; border: 1px solid var(--efs-border); min-width: 150px;
}
.efs-liq-total-box span { font-size: 11px; font-weight: 700; color: var(--efs-text-muted); text-transform: uppercase; letter-spacing: .03em; }
.efs-liq-total-box strong { font-size: 16px; font-family: monospace; color: var(--efs-text); }
.efs-liq-total-box-diff { background: #fff7ed; border-color: #fdba74; }
.efs-liq-total-box-diff strong { color: #c2410c; }
.efs-liq-actions { margin-top: 14px; max-width: 320px; }
.efs-hub-section { margin-bottom: 28px; }
.efs-hub-section-title { font-weight: 700; font-size: 13px; margin-bottom: 12px; color: var(--efs-text-muted); text-transform: uppercase; letter-spacing: .03em; }
.efs-hub-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 14px; }
.efs-hub-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left;
  padding: 16px; border: 1px solid var(--efs-border); border-radius: var(--efs-radius); background: #fff;
  cursor: pointer; transition: border-color .15s, box-shadow .15s;
}
.efs-hub-card:hover { border-color: #0d9488; box-shadow: 0 2px 8px rgba(13,148,136,.12); }
.efs-hub-card-icon { color: #0d9488; }
.efs-hub-card-label { font-weight: 700; font-size: 14px; }
.efs-hub-card-desc { font-size: 12px; color: var(--efs-text-muted); }
.efs-kpi-section-title { font-weight: 700; font-size: 13px; margin: 22px 0 10px; color: var(--efs-text-muted); text-transform: uppercase; letter-spacing: .03em; }
.efs-kpi-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
.efs-kpi-tile { background: #f8fafc; border-radius: var(--efs-radius); padding: 14px; text-align: center; }
.efs-kpi-tile-value { font-size: 24px; font-weight: 800; color: var(--efs-primary); }
.efs-kpi-tile-label { font-size: 11px; color: var(--efs-text-muted); margin-top: 2px; }
.efs-kpi-tiles-cod { margin-top: 10px; }
.efs-kpi-tile-cod { background: #f0fdfa; grid-column: 1 / -1; }
.efs-kpi-tile-cod .efs-kpi-tile-value { color: #0d9488; }
.efs-kpi-bars {
  display: flex; align-items: flex-end; gap: 6px; height: 140px; padding: 10px 6px 0;
  border-bottom: 1px solid var(--efs-border); overflow-x: auto;
}
.efs-kpi-bar-col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; min-width: 22px; flex: 1; }
.efs-kpi-bar { width: 100%; max-width: 26px; background: #0d9488; border-radius: 4px 4px 0 0; min-height: 2px; }
.efs-kpi-bar-label { font-size: 10px; color: var(--efs-text-muted); margin-top: 6px; white-space: nowrap; }
`;

window.FacexTransporteModule = FacexTransporteModule;
