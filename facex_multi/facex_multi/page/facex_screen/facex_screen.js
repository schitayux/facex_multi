/**
 * FacEx Screen — Pantalla POS rápida (venta por tarjetas, tipo restaurante)
 * Reutiliza toda la lógica fiscal/contable de facex_multi.api.* (misma que FacEx clásico).
 * No duplica cálculos de impuestos: los totales finales los calcula ERPNext en save_draft().
 */

// ---------------------------------------------------------------------------
// Page lifecycle hooks
// ---------------------------------------------------------------------------

frappe.pages["facex-screen"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "FacEx Screen",
		single_column: true,
	});
	// Modo Enfoque es el único modo de esta pantalla (ya no hay botón para
	// alternarlo). Frappe Desk es un SPA — el <body> persiste entre rutas —
	// así que hay que quitar la clase apenas el usuario navega a OTRA
	// pantalla, o el resto de ERPNext se quedaría sin navbar/sidebar.
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex-screen") {
			$("body").removeClass("facex-fullscreen-mode");
		}
	});
	frappe.require(["/assets/facex_multi/js/facex_transporte_module.js", "/assets/facex_multi/js/ef_guide.js", "controls.bundle.js"], function () {
		wrapper.efscreen = new EFastPOSScreen(page, wrapper);
	});
};

frappe.pages["facex-screen"].on_page_show = function () {
	$("body").addClass("facex-fullscreen-mode");
};

function _efs_esc(str) {
	if (str === undefined || str === null) return "";
	return String(str)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function _efs_fmt(n) {
	return (parseFloat(n) || 0).toLocaleString("es-GT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Main Controller
// ---------------------------------------------------------------------------

class EFastPOSScreen {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.$body = $(page.body);
		this.doc = this._empty_doc();
		this.defaults = {};
		this.company_config = {};
		this.perms = {};
		this.warehouses = [];
		this.priceLists = [];
		this.paymentTermsTemplates = [];
		this.allItems = [];
		this.itemGroups = [];
		this.activeGroup = "";
		this.searchTxt = "";
		this.filterInStock = true;
		this.posWarehouse = "";
		this.salesPartners = [];
		this.walkinCustomer = null;
		this._lastSavedInvoice = null;
		this.customerDetails = null;
		this.step = 1;
		this.heldCount = 0;
		this.pendingGuiasCount = 0;

		this._inject_styles();
		this._render_html();
		this._load_defaults_then_init();
	}

	_empty_doc() {
		return {
			doctype: "Sales Invoice",
			name: null,
			company: "",
			naming_series: "",
			bfel_establecimiento: "",
			customer: "",
			customer_name: "",
			posting_date: frappe.datetime.get_today(),
			due_date: frappe.datetime.get_today(),
			payment_terms_template: "",
			selling_price_list: "",
			taxes_and_charges: "",
			sales_partner: "",
			items: [],
		};
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	_load_defaults_then_init() {
		frappe.call({
			method: "facex_multi.api.invoice.get_defaults",
			callback: (r) => {
				const d = r.message || {};
				this.defaults = d;
				this.company_config = d.company_config || {};
				this.perms = d.permissions || {};
				this.posWarehouse = d.default_pos_warehouse || "";
				this.doc.company = d.company || "";
				this.doc.naming_series = (d.naming_series || [])[0] || "";
				this.doc.bfel_establecimiento = String(((d.establishments || [])[0] || {}).establecimiento_id || "");
				this.doc.taxes_and_charges = d.default_taxes_and_charges || "";
				this.doc.payment_terms_template = d.default_payment_terms_template || "";
				this.doc.posting_date = d.posting_date || this.doc.posting_date;
				this.doc.due_date = d.due_date || this.doc.due_date;
				this.doc.sales_partner = d.default_sales_partner || "";

				this._load_walkin_customer();
				this._load_warehouses();
				this._load_price_lists();
				this._load_payment_terms_templates();
				this._load_sales_partners();
				this._load_pos_data();
				this._render_step_encabezado();
				this._show_home();

				// El módulo "Transporte" del menú se arma por permiso dedicado
				// (puede_ver_menu_transporte, llave maestra en FacEx Settings),
				// no por permite_pago_contra_entrega — un usuario puede
				// administrar transportistas/reportes/liquidaciones aunque la
				// empresa no tenga habilitado el cobro Contra Entrega.
				this._render_main_menu();
				this._refresh_held_count();
				if (this.perms.puede_editar_guias_transporte) this._refresh_pending_guias_count();
			},
			error: () => {
				frappe.msgprint(__("No se pudieron cargar los valores por defecto."));
			},
		});
	}

	_load_walkin_customer() {
		frappe.call({
			method: "facex_multi.api.customer.get_or_create_walkin_customer",
			args: { company: this.doc.company },
			callback: (r) => {
				if (r.message) {
					this.walkinCustomer = r.message;
					this.doc.customer = r.message.name;
					this.doc.customer_name = r.message.customer_name;
					if (!this.doc.sales_partner && r.message.default_sales_partner) {
						this.doc.sales_partner = r.message.default_sales_partner;
					}
					this._render_customer_bar();
				}
			},
		});
	}

	_load_warehouses() {
		frappe.call({
			method: "facex_multi.api.invoice.get_warehouses",
			args: { company: this.doc.company },
			callback: (r) => {
				this.warehouses = r.message || [];
			},
		});
	}

	_load_price_lists() {
		frappe.call({
			method: "facex_multi.api.item.get_price_lists",
			args: { company: this.doc.company },
			callback: (r) => {
				this.priceLists = (r.message || []).filter((p) => p.selling);
				// Si la compañía activa tiene una única lista de precios
				// asociada (bfel_company), se usa directo sin obligar al
				// cajero a elegirla — solo se respeta una selección previa
				// (retomar venta en espera / factura ya cargada).
				if (this.priceLists.length === 1 && !this.doc.selling_price_list) {
					this.doc.selling_price_list = this.priceLists[0].name;
				}
				this._render_step_encabezado();
			},
		});
	}

	_load_payment_terms_templates() {
		frappe.call({
			method: "frappe.client.get_list",
			args: { doctype: "Payment Terms Template", fields: ["name"], limit_page_length: 0 },
			callback: (r) => {
				this.paymentTermsTemplates = (r.message || []).map((t) => t.name);
				this._render_documento_card();
			},
		});
	}

	_load_sales_partners() {
		frappe.call({
			method: "facex_multi.api.sales_partner.search_sales_partners",
			args: { company: this.doc.company },
			callback: (r) => {
				this.salesPartners = r.message || [];
				this._render_vendor_bar();
				if (this.$body.find("#efs-sec-documento-body").length) {
					this._render_documento_card();
				}
			},
		});
	}

	_load_pos_data() {
		frappe.call({
			method: "facex_multi.api.item.get_pos_item_groups",
			args: { company: this.doc.company },
			callback: (r) => {
				this.itemGroups = r.message || [];
				this._render_categories();
			},
		});
		frappe.call({
			method: "facex_multi.api.item.get_pos_items",
			args: { company: this.doc.company, warehouse: this.posWarehouse || undefined },
			freeze: true,
			freeze_message: __("Cargando productos…"),
			callback: (r) => {
				this.allItems = r.message || [];
				this._render_grid();
			},
		});
	}

	// -----------------------------------------------------------------------
	// Layout
	// -----------------------------------------------------------------------

	_render_html() {
		this.$body.html(`
			<div class="efs-wrap">
				<div class="efs-header">
					<div class="efs-header-left">
						<div class="efs-main-menu" id="efs-main-menu">
							<button type="button" class="efs-menu-trigger" id="efs-btn-main-menu" title="Menú">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
								Menú
								<span class="efs-held-badge" id="efs-menu-total-badge" style="display:none;">0</span>
							</button>
							<div class="efs-menu-panel" id="efs-menu-panel" style="display:none;"></div>
						</div>
						<span class="efs-logo">FacEx Screen</span>
						<span class="efs-company-badge" id="efs-company-badge"></span>
					</div>
					<div class="efs-header-right">
						<div class="efs-customer-pill" id="efs-customer-pill">
							<span id="efs-customer-name">Cargando cliente…</span>
							<button class="efs-btn-link" id="efs-btn-change-customer">Cambiar</button>
						</div>
						<div class="efs-customer-pill" id="efs-vendor-pill">
							<label class="efs-pill-label">Vendedor:</label>
							<select id="efs-vendor-select" class="efs-pill-select"></select>
						</div>

						<div class="efs-user-dropdown" id="efs-user-dropdown">
							<button class="efs-user-btn" id="efs-btn-user-profile" title="Perfil de Usuario">
								<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
							</button>
							<div class="efs-user-menu" id="efs-user-menu" style="display:none;">
								<div class="efs-user-menu-label">Usuario Conectado</div>
								<div class="efs-user-fullname" id="efs-active-user-fullname"></div>
								<div class="efs-user-email" id="efs-active-user-email"></div>
								<div class="efs-company-switcher" id="efs-company-switcher-section" style="display:none;">
									<div class="efs-user-menu-label">Cambiar Compañía</div>
									<select id="efs-company-select" class="efs-cust-detail-input efs-company-select"></select>
									<button type="button" class="btn btn-sm btn-default efs-user-menu-btn" id="efs-btn-switch-company">Aplicar Compañía</button>
									<hr />
								</div>
								<button type="button" class="btn btn-sm btn-default efs-user-menu-btn" id="efs-btn-change-password">Cambiar Contraseña</button>
								<button type="button" class="btn btn-sm btn-danger efs-user-menu-btn" id="efs-btn-logout">Cerrar Sesión</button>
							</div>
						</div>
					</div>
				</div>

				<div class="efs-home-view" id="efs-home-view" style="display:none;"></div>

				<div class="efs-stepbar" style="display:none;">
					<button class="efs-step-nav" id="efs-step-prev">← Inicio</button>
					<span class="efs-step-label" id="efs-step-label">Paso 1 de 3</span>
					<button class="efs-step-nav efs-step-nav-primary" id="efs-step-next">Siguiente →</button>
				</div>

				<div class="efs-body" style="display:none;">
					<div class="efs-main">
						<div class="efs-step-pane" id="efs-step-encabezado"></div>

						<div class="efs-step-pane" id="efs-step-productos" style="display:none;">
							<div class="efs-search-row">
								<input type="text" id="efs-search" class="efs-search-input" placeholder="Buscar producto por nombre o código…" />
								<label class="efs-instock-toggle">
									<input type="checkbox" id="efs-filter-instock" checked />
									En Stock
								</label>
							</div>
							<div class="efs-categories" id="efs-categories"></div>
							<div class="efs-grid" id="efs-grid"></div>
						</div>
					</div>

					<div class="efs-ticket">
						<div class="efs-ticket-header">Ticket</div>
						<div class="efs-ticket-lines" id="efs-ticket-lines">
							<div class="efs-ticket-empty" id="efs-ticket-empty">Toque un producto para agregarlo.</div>
						</div>
						<div class="efs-ticket-footer">
							<div class="efs-total-row efs-total-row-grand">
								<span>Subtotal</span>
								<span id="efs-subtotal">Q 0.00</span>
							</div>
							<button class="efs-btn-secondary" id="efs-btn-suspend" title="Guardar esta venta en espera (F6)" disabled>
								Suspender venta <span class="efs-kbd">F6</span>
							</button>
						</div>
					</div>
				</div>

				<div class="efs-overlay" id="efs-payment-view" style="display:none;"></div>
				<div class="efs-overlay" id="efs-held-view" style="display:none;"></div>
				<div class="efs-overlay" id="efs-confirm-view" style="display:none;"></div>
				<div class="efs-overlay" id="efs-history-view" style="display:none;"></div>
				<div class="efs-overlay" id="efs-transporte-view" style="display:none;"></div>
				<div class="efs-overlay" id="efs-alt-view" style="display:none;"></div>
				<div class="efs-overlay" id="efs-keyword-view" style="display:none;"></div>
			</div>
		`);

		this.$body.find("#efs-search").on("input", (e) => {
			this.searchTxt = e.target.value.trim().toLowerCase();
			this._render_grid();
		});
		// Soporte de lector de código de barras: el lector tipea el código y
		// termina con Enter, igual que un teclado. Si el filtro actual deja
		// exactamente un producto visible, se agrega solo y se limpia el
		// buscador para dejarlo listo para el siguiente escaneo.
		this.$body.find("#efs-search").on("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const matches = this._filtered_items();
			if (matches.length === 1) {
				this._add_or_prompt(matches[0]);
				this.searchTxt = "";
				const $search = this.$body.find("#efs-search");
				$search.val("");
				$search.trigger("focus");
			} else if (matches.length === 0) {
				frappe.show_alert({ message: __("Producto no encontrado."), indicator: "orange" });
			}
		});
		this.$body.find("#efs-filter-instock").on("change", (e) => {
			this.filterInStock = e.target.checked;
			this._render_grid();
		});

		this.$body.find("#efs-btn-change-customer").on("click", () => this._show_customer_picker());
		this.$body.find("#efs-vendor-select").on("change", (e) => {
			this.doc.sales_partner = e.target.value;
			this._render_vendor_bar();
		});
		this.$body.find("#efs-btn-suspend").on("click", () => this._suspend_sale());
		this._bind_user_menu();
		this._bind_main_menu();
		this.$body.find("#efs-step-prev").on("click", () => this._step_prev());
		this.$body.find("#efs-step-next").on("click", () => this._step_next());
		this._bind_keyboard_shortcuts();
		this._attach_static_hints();
	}

	// Ayudas contextuales (ⓘ tenue) siempre visibles sobre los controles
	// permanentes de la pantalla — no requieren activar nada. Los controles
	// dentro de vistas que se reconstruyen (ej. pago) se enganchan aparte,
	// junto a su propio render.
	_attach_static_hints() {
		if (typeof EFGuide === "undefined") return;
		EFGuide.attachHints(this.$body, [
			{ selector: "#efs-search", text: "Escribe el nombre o código del producto. Con lector de código de barras: escanea y Enter agrega el producto solo si hay una única coincidencia." },
			{ selector: ".efs-instock-toggle", text: "Si está activo, la grilla solo muestra productos con existencia disponible en la bodega actual." },
			{ selector: "#efs-btn-change-customer", text: "Cliente de esta venta. Por defecto es 'Consumidor Final'; toca aquí para buscar o crear otro." },
			{ selector: "#efs-vendor-select", text: "Selecciona el vendedor que atiende esta venta (útil para reportes de comisión)." },
			{ selector: ".efs-ticket-header", text: "Aquí aparecen los productos agregados. Usa +/− para la cantidad, o toca la línea para más opciones (bodega, descuento, adenda)." },
			{ selector: "#efs-btn-suspend", text: "Guarda esta venta en espera para retomarla después, sin perder lo agregado." },
		]);
	}

	// -----------------------------------------------------------------------
	// Atajos de teclado
	// -----------------------------------------------------------------------
	// Namespace propio ("efs", no "efast") para no interferir con el listener
	// global de FacEx clásico (facex.js, keydown.efast). Se reciclan las mismas
	// teclas que allá donde el significado es análogo (F2/F3/F4/F7/F8/F9/F10);
	// F6 es nueva (no usada en facex.js) para Suspender. Ventas en Espera usa
	// Ctrl+H (en vez de F7) para liberar F7 = Artículos Alternativos, igual
	// que en facex.js.
	_bind_keyboard_shortcuts() {
		$(document).off("keydown.efs").on("keydown.efs", (e) => {
			if (!$(this.wrapper).is(":visible")) return;
			if ($(".modal.show, .modal.in").length) return;

			if (e.key === "F2") {
				e.preventDefault();
				if (this.step === 2) this.$body.find("#efs-search").trigger("focus");
			} else if (e.key === "F3") {
				e.preventDefault();
				this._step_next();
			} else if (e.key === "F4") {
				e.preventDefault();
				if (this.$body.find("#efs-confirm-view").is(":visible")) this._print_invoice();
			} else if (e.key === "F6") {
				e.preventDefault();
				if ((this.doc.items || []).length) this._suspend_sale();
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "h") {
				e.preventDefault();
				this._show_held_view();
			} else if (e.key === "F7") {
				e.preventDefault();
				this._show_alternatives_view();
			} else if (e.key === "F8") {
				e.preventDefault();
				this._show_keyword_search_view();
			} else if (e.key === "F9") {
				e.preventDefault();
				this._new_sale();
			} else if (e.key === "F10") {
				e.preventDefault();
				this._show_customer_picker();
			}
		});
	}

	_bind_user_menu() {
		this.$body.find("#efs-btn-user-profile").on("click", (e) => {
			e.stopPropagation();
			const $menu = this.$body.find("#efs-user-menu");
			if ($menu.is(":hidden")) {
				this.$body.find("#efs-active-user-fullname").text(frappe.session.user_fullname || "Usuario");
				this.$body.find("#efs-active-user-email").text(frappe.session.user);
				frappe.call({
					method: "facex_multi.api.invoice.get_user_companies",
					callback: (r) => {
						const companies = r.message || [];
						if (companies.length > 1) {
							const $sel = this.$body.find("#efs-company-select");
							const $sec = this.$body.find("#efs-company-switcher-section");
							$sel.html(companies.map((c) => `<option value="${_efs_esc(c)}" ${c === this.doc.company ? "selected" : ""}>${_efs_esc(c)}</option>`).join(""));
							$sec.show();
						}
					},
				});
				$menu.fadeIn(150);
			} else {
				$menu.fadeOut(150);
			}
		});

		this.$body.find("#efs-btn-switch-company").on("click", (e) => {
			e.stopPropagation();
			const company = this.$body.find("#efs-company-select").val();
			if (!company) return;
			frappe.call({
				method: "facex_multi.api.invoice.set_active_company",
				args: { company },
				freeze: true,
				freeze_message: __("Cambiando a {0}…", [company]),
				callback: () => {
					frappe.show_alert({ message: __("Compañía cambiada. Recargando…"), indicator: "green" });
					setTimeout(() => window.location.reload(), 1200);
				},
			});
		});

		this.$body.find("#efs-btn-logout").on("click", () => frappe.app.logout());

		this.$body.find("#efs-btn-change-password").on("click", (e) => {
			e.stopPropagation();
			this.$body.find("#efs-user-menu").fadeOut(150);
			this._show_change_password_dialog();
		});

		$(document).on("click.efs_user_dropdown", (e) => {
			const $menu = this.$body.find("#efs-user-menu");
			if ($menu.length && !$(e.target).closest("#efs-user-dropdown").length) {
				$menu.fadeOut(150);
			}
		});
	}

	// -----------------------------------------------------------------------
	// Menú principal — agrupado por módulo, con submódulos desplegables tipo
	// acordeón (un módulo abierto a la vez). Nuevas opciones se agregan
	// empujando entradas dentro de _get_menu_modules(), sin tocar el layout.
	// -----------------------------------------------------------------------

	_bind_main_menu() {
		this.$body.find("#efs-btn-main-menu").on("click", (e) => {
			e.stopPropagation();
			const $panel = this.$body.find("#efs-menu-panel");
			if ($panel.is(":hidden")) {
				$panel.fadeIn(120);
			} else {
				$panel.fadeOut(120);
			}
		});

		$(document).on("click.efs_main_menu", (e) => {
			const $panel = this.$body.find("#efs-menu-panel");
			if ($panel.length && !$(e.target).closest("#efs-main-menu").length) {
				$panel.fadeOut(120);
			}
		});
	}

	// Llave maestra puede_ver_menu_transporte + al menos un permiso específico
	// habilitado — mismo criterio usado tanto por el módulo "Transporte" del
	// menú principal como por la tarjeta "Transporte" de la pantalla de
	// Inicio, para no duplicar la condición en dos lugares.
	_has_transporte_access() {
		const p = this.perms || {};
		if (!p.puede_ver_menu_transporte) return false;
		return !!(p.puede_editar_guias_transporte || p.puede_administrar_transportistas
			|| p.puede_ver_reportes_transporte || p.puede_cargar_liquidaciones_transporte || p.puede_ver_kpis_transporte);
	}

	_get_menu_modules() {
		const p = this.perms || {};
		const cartSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>`;
		const truckSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>`;
		const gearSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

		const modules = [];

		modules.push({
			id: "ventas",
			label: __("Ventas"),
			icon: cartSvg,
			items: [
				{ id: "held", label: __("Ventas en espera"), hotkey: "Ctrl+H", badgeId: "efs-held-badge", action: () => this._show_held_view() },
				{ id: "history", label: __("Historial"), action: () => this._show_history_view() },
			],
		});

		// "Transporte" — gateado por la llave maestra puede_ver_menu_transporte.
		// A diferencia de "Ventas", esto NO es un grupo con submenú: es
		// una sola fila de acción directa (mod.action, sin mod.items) que abre
		// el hub de tarjetas (_show_transporte_hub) en un solo click — ahí
		// adentro cada tarjeta ya respeta su propio permiso específico (mismo
		// criterio que antes gobernaba cada entrada del submenú).
		if (this._has_transporte_access()) {
			modules.push({
				id: "transporte",
				label: __("Transporte"),
				icon: truckSvg,
				badgeId: "efs-transporte-menu-badge",
				action: () => this._show_transporte_hub(),
			});
		}

		modules.push({
			id: "classic",
			label: __("← FacEx clásico"),
			icon: gearSvg,
			action: () => { window.location.href = "/app/facex"; },
		});

		return modules;
	}

	_render_main_menu() {
		const modules = this._get_menu_modules();
		const $panel = this.$body.find("#efs-menu-panel");

		// Dos formas de módulo: con mod.action (fila única, click directo —
		// caso de "Transporte", que ahora abre su hub de tarjetas de un solo
		// click) o con mod.items (grupo tipo acordeón, caso Ventas/Sistema).
		$panel.html(modules.map((mod) => {
			if (mod.action) {
				return `
					<div class="efs-menu-group" data-module="${mod.id}">
						<button type="button" class="efs-menu-group-header efs-menu-group-header-direct" data-module="${mod.id}">
							<span class="efs-menu-group-icon">${mod.icon}</span>
							<span class="efs-menu-group-label">${mod.label}</span>
							${mod.badgeId ? `<span class="efs-held-badge" id="${mod.badgeId}" style="display:none;">0</span>` : ""}
						</button>
					</div>
				`;
			}
			return `
				<div class="efs-menu-group" data-module="${mod.id}">
					<button type="button" class="efs-menu-group-header">
						<span class="efs-menu-group-icon">${mod.icon}</span>
						<span class="efs-menu-group-label">${mod.label}</span>
						<span class="efs-held-badge efs-menu-group-badge" id="efs-menu-group-badge-${mod.id}" style="display:none;">0</span>
						<svg class="efs-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
					</button>
					<div class="efs-menu-group-items">
						${mod.items.map((item) => `
							<button type="button" class="efs-menu-item" data-module="${mod.id}" data-item="${item.id}">
								<span class="efs-menu-item-label"${item.labelId ? ` id="${item.labelId}"` : ""}>${item.label}</span>
								${item.hotkey ? `<span class="efs-kbd">${item.hotkey}</span>` : ""}
								${item.badgeId ? `<span class="efs-held-badge" id="${item.badgeId}" style="display:none;">0</span>` : ""}
							</button>
						`).join("")}
					</div>
				</div>
			`;
		}).join(""));

		// Acordeón: al abrir un módulo (con submenú) se cierran los demás.
		$panel.find(".efs-menu-group-header").not(".efs-menu-group-header-direct").on("click", (e) => {
			const $group = $(e.currentTarget).closest(".efs-menu-group");
			const wasOpen = $group.hasClass("efs-menu-group-open");
			$panel.find(".efs-menu-group").removeClass("efs-menu-group-open");
			if (!wasOpen) $group.addClass("efs-menu-group-open");
		});

		// Módulos de acción directa: un click ejecuta y cierra el menú, sin pasar por el acordeón.
		$panel.find(".efs-menu-group-header-direct").on("click", (e) => {
			const mod = modules.find((m) => m.id === $(e.currentTarget).data("module"));
			$panel.fadeOut(120);
			if (mod && mod.action) mod.action();
		});

		$panel.find(".efs-menu-item").on("click", (e) => {
			const modId = $(e.currentTarget).data("module");
			const itemId = $(e.currentTarget).data("item");
			const mod = modules.find((m) => m.id === modId);
			const item = mod && mod.items && mod.items.find((i) => i.id === itemId);
			this.$body.find("#efs-menu-panel").fadeOut(120);
			if (item) item.action();
		});
	}

	_set_badge(id, n) {
		const $badge = this.$body.find(`#${id}`);
		if (n > 0) {
			$badge.text(n).show();
		} else {
			$badge.hide();
		}
	}

	_update_menu_total_badge() {
		this._set_badge("efs-menu-total-badge", (this.heldCount || 0) + (this.pendingGuiasCount || 0));
	}

	_show_change_password_dialog() {
		const dlg = new frappe.ui.Dialog({
			title: __("Cambiar Contraseña"),
			fields: [
				{ fieldtype: "Password", fieldname: "old_password", label: __("Contraseña Actual"), reqd: 1 },
				{ fieldtype: "Password", fieldname: "new_password", label: __("Nueva Contraseña"), reqd: 1 },
				{ fieldtype: "Password", fieldname: "confirm_password", label: __("Confirmar Nueva Contraseña"), reqd: 1 },
			],
			primary_action_label: __("Actualizar Contraseña"),
			primary_action: (values) => {
				if (values.new_password !== values.confirm_password) {
					frappe.msgprint({
						title: __("Error de Validación"),
						message: __("La nueva contraseña y la confirmación no coinciden."),
						indicator: "red",
					});
					return;
				}
				dlg.get_primary_btn().attr("disabled", true);
				frappe.call({
					method: "frappe.core.doctype.user.user.update_password",
					args: { old_password: values.old_password, new_password: values.new_password, logout_all_sessions: 0 },
					callback: (r) => {
						dlg.get_primary_btn().attr("disabled", false);
						if (!r.exc) {
							frappe.show_alert({ message: __("Contraseña actualizada exitosamente."), indicator: "green" });
							dlg.hide();
						}
					},
					error: () => dlg.get_primary_btn().attr("disabled", false),
				});
			},
		});
		dlg.show();
	}

	// -----------------------------------------------------------------------
	// Pantalla de Inicio — primera pantalla al entrar a FacEx Screen (y al
	// volver con "← Inicio" desde el paso 1). Reemplaza el wizard de venta
	// (stepbar + cuerpo) por tarjetas grandes: "Nueva Venta" sigue el flujo
	// normal de siempre (paso 1: cliente y encabezado); "Transporte" redirige
	// al hub; "Sistema" solo tiene FacEx Clásico, así que es acción directa
	// (no una sub-pantalla) — no hay nada más detrás para mostrar. Cada
	// tarjeta respeta permisos de FacEx Settings, igual que el resto del menú.
	// -----------------------------------------------------------------------

	// Frases cortas, positivas y de ambiente laboral (sin afirmaciones de
	// salud/dinero/política — contenido curado por nosotros, no una API
	// externa: así no dependemos de un tercero ni de contenido sin moderar
	// en una pantalla de venta). Se elige una por día del año, así que es
	// la misma todo el día y cambia automáticamente al día siguiente.
	_HOME_MOTIVATIONAL_MESSAGES = [
		"Cada cliente que atiendes hoy es una oportunidad de dejar una gran impresión.",
		"Un buen día empieza con una sonrisa — la tuya cuenta más de lo que crees.",
		"La constancia de hoy es el resultado de mañana.",
		"Gracias por hacer que cada venta sea una buena experiencia para alguien.",
		"Pequeños detalles, grandes resultados. ¡Vamos con todo hoy!",
		"Tu trabajo hace que esta empresa avance un paso más cada día.",
		"Hoy es una nueva oportunidad para superar el día de ayer.",
		"La actitud correcta convierte un día común en uno extraordinario.",
		"Cada factura bien hecha es un cliente satisfecho.",
		"El buen servicio se nota, y tú lo brindas todos los días.",
		"Un equipo que suma esfuerzos, multiplica resultados.",
		"La paciencia y la buena energía son tus mejores herramientas hoy.",
		"Celebra los pequeños logros del día — todos cuentan.",
		"Hoy puedes marcar la diferencia en la experiencia de alguien más.",
		"El esfuerzo constante siempre encuentra su recompensa.",
		"Buen ánimo, buen servicio, buenos resultados.",
		"Cada 'gracias' de un cliente es una señal de que vas por buen camino.",
		"La organización de hoy facilita el éxito de mañana.",
		"Trabajar con calidad es la mejor forma de dejar huella.",
		"Un problema resuelto a tiempo es una confianza ganada.",
		"Tu buena disposición hoy puede alegrar el día de alguien más.",
		"La excelencia es la suma de pequeños esfuerzos repetidos cada día.",
		"Hoy es un buen día para hacer bien las cosas.",
		"La confianza se construye con cada atención bien hecha.",
		"Ser puntual y claro con el cliente siempre suma.",
		"Cada día trae una nueva oportunidad de mejorar.",
		"El buen trabajo en equipo hace que todo fluya mejor.",
		"Tu esfuerzo de hoy es la base del éxito de mañana.",
		"Una actitud positiva es contagiosa — compártela hoy.",
		"Gracias por tu dedicación, se nota en cada detalle.",
	];

	_get_daily_motivational_message() {
		const list = this._HOME_MOTIVATIONAL_MESSAGES;
		const now = new Date();
		const start = new Date(now.getFullYear(), 0, 0);
		const dayOfYear = Math.floor((now - start) / 86400000);
		return list[dayOfYear % list.length];
	}

	_format_home_datetime(d) {
		let dateStr = d.toLocaleDateString("es-GT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
		dateStr = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
		const timeStr = d.toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
		return { dateStr, timeStr };
	}

	_show_home() {
		this.step = 0;
		this.$body.find(".efs-stepbar").hide();
		this.$body.find(".efs-body").hide();
		const $view = this.$body.find("#efs-home-view");
		const p = this.perms || {};

		const saleSvg = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"></circle><circle cx="20" cy="21" r="1"></circle><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path></svg>`;
		const truckSvg = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>`;
		const gearSvg = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

		const cards = [
			p.puede_facturar ? {
				icon: saleSvg, label: __("Nueva Venta"),
				desc: __("Seleccionar cliente y comenzar una factura."),
				action: () => this._show_step(1),
			} : null,
			this._has_transporte_access() ? {
				icon: truckSvg, label: __("Transporte"), badgeId: "efs-home-badge-transporte",
				desc: __("Envíos, guías, transportistas y liquidaciones."),
				action: () => this._show_transporte_hub(),
			} : null,
			{
				icon: gearSvg, label: __("Sistema"),
				desc: __("FacEx Clásico."),
				action: () => { window.location.href = "/app/facex"; },
			},
		].filter(Boolean);

		const fullname = frappe.session.user_fullname || frappe.session.user;
		const { dateStr, timeStr } = this._format_home_datetime(new Date());

		// Logo real de la compañía activa (no el de CHAPPSA) — mismo dato que
		// ya resuelve get_defaults para el establecimiento fiscal actual
		// (BFEL Establecimientos.logo, o Company.company_logo si la compañía
		// no tiene establecimientos configurados). Si no hay logo cargado, se
		// muestra el nombre de la compañía en su lugar en vez de dejar el
		// espacio vacío.
		const establishments = this.defaults.establishments || [];
		const currentEst = establishments.find((e) => String(e.establecimiento_id) === String(this.doc.bfel_establecimiento)) || establishments[0];
		const companyLogoUrl = currentEst && currentEst.logo ? currentEst.logo : "";
		const currentYear = new Date().getFullYear();

		$view.html(`
			<div class="efs-home-poweredby">
				<img src="/assets/facex_multi/images/chappsa-logo.png" alt="CHAPPSA" onerror="this.style.display='none'" />
				<span>© ${currentYear} CHAPPSA</span>
			</div>
			<div class="efs-home-wrap">
				<div class="efs-home-brand">
					${companyLogoUrl
						? `<img class="efs-home-logo" src="${_efs_esc(companyLogoUrl)}" alt="${_efs_esc(this.doc.company || "")}" onerror="this.style.display='none'" />`
						: `<div class="efs-home-logo-fallback">${_efs_esc(this.doc.company || "")}</div>`}
				</div>
				<div class="efs-home-welcome">
					<div class="efs-home-greeting">${__("¡Bienvenido, {0}!", [_efs_esc(fullname)])}</div>
					<div class="efs-home-datetime">
						<span id="efs-home-date">${_efs_esc(dateStr)}</span>
						<span class="efs-home-time-sep">·</span>
						<span id="efs-home-time">${_efs_esc(timeStr)}</span>
					</div>
					<div class="efs-home-session">
						${__("Conectado como")} <strong>${_efs_esc(fullname)}</strong> (${_efs_esc(frappe.session.user)}) —
						${__("Compañía")}: <strong>${_efs_esc(this.doc.company || "—")}</strong>
					</div>
				</div>
				<div class="efs-home-quote">${_efs_esc(this._get_daily_motivational_message())}</div>
				<div class="efs-home-cards">
					${cards.map((c, i) => `
						<button type="button" class="efs-home-card" data-idx="${i}">
							<span class="efs-home-card-icon">${c.icon}</span>
							<span class="efs-home-card-label">${c.label}${c.badgeId ? `<span class="efs-held-badge" id="${c.badgeId}" style="display:none;">0</span>` : ""}</span>
							<span class="efs-home-card-desc">${c.desc}</span>
						</button>
					`).join("")}
				</div>
			</div>
		`);
		$view.show();
		$view.find(".efs-home-card").on("click", (e) => {
			const card = cards[$(e.currentTarget).data("idx")];
			if (card) card.action();
		});

		if (p.puede_editar_guias_transporte) this._set_badge("efs-home-badge-transporte", this.pendingGuiasCount || 0);

		// Reloj en vivo — se limpia primero por si _show_home() se llama de
		// nuevo (evita acumular varios intervals corriendo en paralelo), y se
		// vuelve a limpiar al salir de Inicio (_show_step) para no seguir
		// actualizando un nodo oculto en segundo plano.
		clearInterval(this._homeClockTimer);
		this._homeClockTimer = setInterval(() => {
			const $date = this.$body.find("#efs-home-date");
			if (!$date.length) {
				clearInterval(this._homeClockTimer);
				return;
			}
			const parts = this._format_home_datetime(new Date());
			$date.text(parts.dateStr);
			this.$body.find("#efs-home-time").text(parts.timeStr);
		}, 1000);
	}

	// -----------------------------------------------------------------------
	// Wizard de pasos (Cliente/Encabezado → Productos → Pago)
	// -----------------------------------------------------------------------

	_show_step(n) {
		this.step = n;
		clearInterval(this._homeClockTimer);
		this.$body.find("#efs-home-view").hide();
		this.$body.find(".efs-body").show();
		this.$body.find("#efs-step-encabezado").toggle(n === 1);
		this.$body.find("#efs-step-productos").toggle(n === 2);
		this.$body.find(".efs-stepbar").show().toggle(n !== 3);
		this._render_stepbar();
		// Foco listo para tipear/escanear apenas se entra al grid de productos.
		if (n === 2) {
			setTimeout(() => this.$body.find("#efs-search").trigger("focus"), 0);
		}
	}

	_render_stepbar() {
		const NAMES = { 1: "Cliente y Encabezado", 2: "Productos", 3: "Pago" };
		const $prev = this.$body.find("#efs-step-prev");
		const $next = this.$body.find("#efs-step-next");
		this.$body.find("#efs-step-label").text(`Paso ${this.step} de 3: ${NAMES[this.step]}`);

		// "← Inicio" ya no es un callejón sin salida en el paso 1: regresa a
		// la pantalla de Inicio (_step_prev), así que queda habilitado ahí también.
		$prev.prop("disabled", false).text(this.step === 1 ? "← Inicio" : `← ${NAMES[this.step - 1]}`);

		if (this.step === 1) {
			$next.prop("disabled", false).text(`${NAMES[2]} →`).show();
		} else if (this.step === 2) {
			const hasItems = (this.doc.items || []).length > 0;
			$next.prop("disabled", !hasItems).text(hasItems ? `${NAMES[3]} →` : "Agregue productos").show();
		} else if (this.step === 3) {
			$next.hide();
		}
	}

	_step_prev() {
		if (this.step === 1) {
			this._show_home();
		} else if (this.step === 2) {
			this._show_step(1);
		} else if (this.step === 3) {
			this.$body.find("#efs-payment-view").hide();
			this._show_step(2);
		}
	}

	async _step_next() {
		if (this.step === 1) {
			if (!this.doc.customer) {
				frappe.show_alert({ message: __("Seleccione un cliente."), indicator: "orange" });
				this._show_customer_picker();
				return;
			}
			if (!this.doc.sales_partner) {
				frappe.show_alert({ message: __("Seleccione un vendedor."), indicator: "orange" });
				return;
			}
			this._show_step(2);
		} else if (this.step === 2) {
			if (!(this.doc.items || []).length) return;
			await this._proceed_to_payment();
		}
	}

	_render_step_encabezado() {
		const $el = this.$body.find("#efs-step-encabezado");
		if (!$el.length) return;

		$el.html(`
			<div class="efs-sections">
				<div class="efs-sec-card efs-sec-open" id="efs-sec-cliente">
					<div class="efs-sec-head">
						<div class="efs-sec-titlewrap">
							<div class="efs-sec-title">Cliente</div>
							<div class="efs-sec-summary" id="efs-sec-cliente-summary">Sin cliente seleccionado</div>
						</div>
						<span class="efs-sec-chev">▾</span>
					</div>
					<div class="efs-sec-body" id="efs-sec-cliente-body"></div>
				</div>

				<div class="efs-sec-card" id="efs-sec-documento">
					<div class="efs-sec-head">
						<div class="efs-sec-titlewrap">
							<div class="efs-sec-title">Documento</div>
							<div class="efs-sec-summary" id="efs-sec-documento-summary">—</div>
						</div>
						<span class="efs-sec-chev">▾</span>
					</div>
					<div class="efs-sec-body" id="efs-sec-documento-body"></div>
				</div>
			</div>
		`);

		$el.find(".efs-sec-head").on("click", function () {
			const $card = $(this).closest(".efs-sec-card");
			const wasOpen = $card.hasClass("efs-sec-open");
			$el.find(".efs-sec-card").removeClass("efs-sec-open");
			if (!wasOpen) $card.addClass("efs-sec-open");
		});

		this._render_cliente_card();
		this._render_documento_card();

		if (typeof EFGuide !== "undefined") {
			EFGuide.attachHints($el, [
				{ selector: "#efs-sec-cliente .efs-sec-title", text: "Selecciona o crea el cliente de esta factura. Toca la tarjeta para expandirla." },
				{ selector: "#efs-sec-documento .efs-sec-title", text: "Establecimiento, serie y condiciones del documento fiscal." },
			]);
		}
	}

	_render_cliente_card() {
		this.$body.find("#efs-sec-cliente-summary").text(this.doc.customer_name || "Sin cliente seleccionado");

		const $body = this.$body.find("#efs-sec-cliente-body");
		$body.html(`
			<div class="efs-field-row">
				<input type="text" id="efs-cust-search-inline" class="efs-search-input" placeholder="Buscar cliente por nombre o NIT…" autocomplete="off" />
			</div>
			<div class="efs-cust-list" id="efs-cust-quick-list"></div>
			<div class="efs-cust-details" id="efs-cust-details"></div>
			<button class="efs-btn-link" id="efs-btn-new-customer-inline" type="button">+ Nuevo Cliente</button>
		`);

		const renderList = (txt) => {
			frappe.call({
				method: "facex_multi.api.item.get_customers_list",
				args: { txt, company: this.doc.company },
				callback: (r) => {
					const rows = r.message || [];
					const $list = this.$body.find("#efs-cust-quick-list");
					if (!rows.length) {
						$list.html('<div class="efs-cust-empty">Sin resultados.</div>');
						return;
					}
					$list.html(
						rows.map((c) => `
							<div class="efs-cust-row ${c.name === this.doc.customer ? "efs-cust-row-active" : ""}" data-name="${_efs_esc(c.name)}" data-label="${_efs_esc(c.customer_name)}" data-sales-partner="${_efs_esc(c.default_sales_partner || "")}">
								<div class="efs-cust-name">${_efs_esc(c.customer_name)}</div>
								<div class="efs-cust-nit">${_efs_esc(c.tax_id || "")}</div>
							</div>
						`).join("")
					);
					$list.find(".efs-cust-row").on("click", (e) => {
						const $row = $(e.currentTarget);
						this.doc.customer = $row.data("name");
						this.doc.customer_name = $row.data("label");
						const defaultPartner = $row.data("sales-partner");
						if (!this.doc.sales_partner && defaultPartner) {
							this.doc.sales_partner = defaultPartner;
						}
						// Ya seleccionado: ocultar la lista de búsqueda y limpiar el
						// campo de texto en vez de re-renderizar toda la tarjeta
						// (lo cual volvía a disparar renderList("") y remostraba el
						// listado completo justo debajo del cliente ya elegido).
						this.$body.find("#efs-cust-search-inline").val("");
						$list.html("");
						this.$body.find("#efs-sec-cliente-summary").text(this.doc.customer_name);
						this._render_customer_bar();
						this._render_customer_details_panel();
						this._render_documento_card();
					});
				},
			});
		};

		this.$body.find("#efs-cust-search-inline").on("input", (e) => renderList(e.target.value.trim()));
		this.$body.find("#efs-btn-new-customer-inline").on("click", () => this._show_new_customer_dialog());
		renderList("");
		this._render_customer_details_panel();
	}

	_render_customer_details_panel() {
		const $panel = this.$body.find("#efs-cust-details");
		if (!$panel.length) return;

		if (!this.doc.customer) {
			$panel.html("");
			return;
		}

		if (!this.customerDetails || this.customerDetails.name !== this.doc.customer) {
			$panel.html('<div class="efs-cust-details-loading">Cargando datos del cliente…</div>');
			frappe.call({
				method: "facex_multi.api.customer.get_customer",
				args: { name: this.doc.customer, company: this.doc.company },
				callback: (r) => {
					this.customerDetails = r.message || null;
					this._render_customer_details_panel();
				},
			});
			return;
		}

		const cd = this.customerDetails;
		const direccion = [cd.direccion, cd.departamento].filter(Boolean).join(", ");
		$panel.html(`
			<div class="efs-cust-detail-row">
				<label>Identificación</label>
				<select id="efs-cust-fld-identificacion" class="efs-cust-detail-input">
					${["", "NIT", "CUI", "PASAPORTE", "CF"].map((v) => `<option value="${v}" ${v === (cd.bfel_identificacion || "") ? "selected" : ""}>${v || "-- Seleccione --"}</option>`).join("")}
				</select>
			</div>
			<div class="efs-cust-detail-row">
				<label>No. Identificador</label>
				<input type="text" id="efs-cust-fld-id-receptor" class="efs-cust-detail-input" value="${_efs_esc(cd.bfel_id_receptor || "")}" placeholder="NIT / CUI / CF" />
			</div>
			<div class="efs-cust-detail-row"><label>Dirección</label><span>${_efs_esc(direccion || "—")}</span></div>
		`);

		const saveField = (field, value) => {
			frappe.call({
				method: "facex_multi.api.customer.create_or_update_customer",
				args: {
					data_json: JSON.stringify({ name: this.doc.customer, [field]: value }),
					company: this.doc.company,
				},
				callback: () => {
					this.customerDetails[field] = value;
					frappe.show_alert({ message: __("Datos del cliente actualizados."), indicator: "green" });
				},
			});
		};

		$panel.find("#efs-cust-fld-identificacion").on("change", (e) => saveField("bfel_identificacion", e.target.value));
		$panel.find("#efs-cust-fld-id-receptor").on("change", (e) => saveField("bfel_id_receptor", e.target.value));
	}

	_render_documento_card() {
		const establishments = this.defaults.establishments || [];
		const seriesOptions = this.defaults.naming_series || [];
		const priceLists = this.priceLists || [];

		this.$body.find("#efs-sec-documento-summary").text(
			`${this.doc.bfel_establecimiento || "—"} · ${this.doc.naming_series || "—"} · ${this.doc.posting_date || "—"} · Vendedor: ${this.doc.sales_partner || "—"}`
		);

		const $body = this.$body.find("#efs-sec-documento-body");
		$body.html(`
			<div class="efs-field-row">
				<label>Establecimiento</label>
				<select id="efs-fld-establecimiento" class="efs-search-input">
					${establishments.map((e) => `<option value="${_efs_esc(e.establecimiento_id)}" ${String(e.establecimiento_id) === String(this.doc.bfel_establecimiento) ? "selected" : ""}>${_efs_esc(e.nombre_establecimiento || e.establecimiento_id)}</option>`).join("")}
				</select>
			</div>
			<div class="efs-field-row">
				<label>Serie de Facturación</label>
				<select id="efs-fld-serie" class="efs-search-input">
					${seriesOptions.map((s) => `<option value="${_efs_esc(s)}" ${s === this.doc.naming_series ? "selected" : ""}>${_efs_esc(s)}</option>`).join("")}
				</select>
			</div>
			<div class="efs-field-row">
				<label>Lista de Precios</label>
				<select id="efs-fld-price-list" class="efs-search-input" ${priceLists.length === 1 ? "disabled" : ""}>
					${priceLists.length === 1
						? `<option value="${_efs_esc(priceLists[0].name)}" selected>${_efs_esc(priceLists[0].name)}</option>`
						: `<option value="">(Por defecto)</option>${priceLists.map((p) => `<option value="${_efs_esc(p.name)}" ${p.name === this.doc.selling_price_list ? "selected" : ""}>${_efs_esc(p.name)}</option>`).join("")}`}
				</select>
			</div>
			<div class="efs-field-row">
				<label>Vendedor</label>
				<select id="efs-fld-vendedor" class="efs-search-input">
					<option value="">-- Seleccione --</option>
					${(this.salesPartners || []).map((p) => `<option value="${_efs_esc(p.name)}" ${p.name === this.doc.sales_partner ? "selected" : ""}>${_efs_esc(p.partner_name || p.name)}</option>`).join("")}
				</select>
			</div>
			<div class="efs-field-row2">
				<div class="efs-field-row">
					<label>F. Emisión</label>
					<input type="date" id="efs-fld-posting-date" class="efs-cust-detail-input" style="max-width:none;width:100%;" value="${_efs_esc(this.doc.posting_date || "")}" />
				</div>
				<div class="efs-field-row">
					<label>F. Vencimiento</label>
					<input type="date" id="efs-fld-due-date" class="efs-cust-detail-input" style="max-width:none;width:100%;" value="${_efs_esc(this.doc.due_date || "")}" />
				</div>
			</div>
			<div class="efs-field-row">
				<label>Condición de Pago</label>
				<select id="efs-fld-payment-terms" class="efs-search-input">
					<option value="">-- Ninguna --</option>
					${(this.paymentTermsTemplates || []).map((t) => `<option value="${_efs_esc(t)}" ${t === this.doc.payment_terms_template ? "selected" : ""}>${_efs_esc(t)}</option>`).join("")}
				</select>
			</div>
		`);

		$body.find("#efs-fld-establecimiento").on("change", (e) => {
			this.doc.bfel_establecimiento = e.target.value;
			frappe.call({
				method: "facex_multi.api.invoice.get_compatible_series",
				args: { company: this.doc.company, establecimiento: this.doc.bfel_establecimiento },
				callback: (r) => {
					this.defaults.naming_series = r.message || [];
					if (!this.defaults.naming_series.includes(this.doc.naming_series)) {
						this.doc.naming_series = this.defaults.naming_series[0] || "";
					}
					this._render_documento_card();
				},
			});
		});
		$body.find("#efs-fld-serie").on("change", (e) => { this.doc.naming_series = e.target.value; });
		$body.find("#efs-fld-price-list").on("change", (e) => { this.doc.selling_price_list = e.target.value; });
		$body.find("#efs-fld-vendedor").on("change", (e) => {
			this.doc.sales_partner = e.target.value;
			this._render_vendor_bar();
		});

		// F. Emisión: si cambia (típicamente al retomar una venta en espera de
		// fecha anterior y actualizarla a hoy), se recalcula F. Vencimiento a
		// partir de la Condición de Pago, o si no hay plantilla, se sube la
		// fecha de vencimiento cuando quedó antes que la nueva emisión — mismo
		// guard que ya usa FacEx clásico (facex.js) para nunca dejar due_date
		// < posting_date y evitar el error de ERPNext "Due Date cannot be
		// before Posting Date" (incluye el recálculo del Payment Schedule).
		$body.find("#efs-fld-posting-date").on("change", (e) => {
			this.doc.posting_date = e.target.value;
			if (this.doc.payment_terms_template) {
				this._on_payment_terms_change(this.doc.payment_terms_template);
			} else if (this.doc.due_date && this.doc.due_date < this.doc.posting_date) {
				this.doc.due_date = this.doc.posting_date;
				this.$body.find("#efs-fld-due-date").val(this.doc.due_date);
			}
		});
		$body.find("#efs-fld-due-date").on("change", (e) => {
			const val = e.target.value;
			if (val && this.doc.posting_date && val < this.doc.posting_date) {
				frappe.show_alert({ message: __("La fecha de vencimiento no puede ser anterior a la fecha de emisión."), indicator: "orange" });
				this.doc.due_date = this.doc.posting_date;
				this.$body.find("#efs-fld-due-date").val(this.doc.due_date);
			} else {
				this.doc.due_date = val;
			}
		});
		$body.find("#efs-fld-payment-terms").on("change", (e) => this._on_payment_terms_change(e.target.value));
	}

	// Reutiliza la misma regla que facex.js (FacEx clásico): due_date = último
	// término de la plantilla (credit_days) sumado a la fecha de emisión
	// actual. Sin plantilla, due_date cae de vuelta a la fecha de emisión.
	_on_payment_terms_change(tpl_name) {
		this.doc.payment_terms_template = tpl_name;
		if (!tpl_name) {
			this.doc.due_date = this.doc.posting_date || frappe.datetime.get_today();
			this.$body.find("#efs-fld-due-date").val(this.doc.due_date);
			return;
		}
		frappe.call({
			method: "frappe.client.get",
			args: { doctype: "Payment Terms Template", name: tpl_name },
			callback: (r) => {
				if (r.message && r.message.terms && r.message.terms.length > 0) {
					const lastTerm = r.message.terms[r.message.terms.length - 1];
					const creditDays = parseInt(lastTerm.credit_days || 0, 10);
					const posting = this.doc.posting_date || frappe.datetime.get_today();
					const due = frappe.datetime.add_days(posting, creditDays);
					this.doc.due_date = due;
					this.$body.find("#efs-fld-due-date").val(due);
				}
			},
		});
	}

	_render_company_badge() {
		this.$body.find("#efs-company-badge").text(this.doc.company || "");
	}

	_render_customer_bar() {
		this.$body.find("#efs-customer-name").text(`Cliente: ${this.doc.customer_name || this.doc.customer || "—"}`);
		this._render_company_badge();
		this._render_vendor_bar();
	}

	_render_vendor_bar() {
		const $pill = this.$body.find("#efs-vendor-pill");
		const $select = this.$body.find("#efs-vendor-select");
		const options = this.salesPartners || [];
		$select.html(
			`<option value="">-- Seleccione --</option>` +
			options.map((p) => `<option value="${_efs_esc(p.name)}" ${p.name === this.doc.sales_partner ? "selected" : ""}>${_efs_esc(p.partner_name || p.name)}</option>`).join("")
		);
		$select.val(this.doc.sales_partner || "");
		$pill.toggleClass("efs-pill-missing", !this.doc.sales_partner);
		if (this.$body.find("#efs-sec-documento-body").length) {
			this._render_documento_card();
		}
	}

	// -----------------------------------------------------------------------
	// Categorías y grid de productos
	// -----------------------------------------------------------------------

	_render_categories() {
		const $wrap = this.$body.find("#efs-categories");
		const tabs = [{ item_group: "", item_count: this.allItems.length, label: "Todos" }].concat(
			this.itemGroups.map((g) => ({ ...g, label: g.item_group }))
		);
		$wrap.html(
			tabs.map((t) => `
				<button class="efs-cat-tab ${t.item_group === this.activeGroup ? "efs-cat-tab-active" : ""}" data-group="${_efs_esc(t.item_group)}">
					${_efs_esc(t.label)}
				</button>
			`).join("")
		);
		$wrap.find(".efs-cat-tab").on("click", (e) => {
			this.activeGroup = $(e.currentTarget).data("group") || "";
			$wrap.find(".efs-cat-tab").removeClass("efs-cat-tab-active");
			$(e.currentTarget).addClass("efs-cat-tab-active");
			this._render_grid();
		});
	}

	_filtered_items() {
		return this.allItems.filter((it) => {
			if (this.activeGroup && it.item_group !== this.activeGroup) return false;
			if (this.searchTxt) {
				const hay = `${it.item_name} ${it.item_code} ${it.barcodes || ""}`.toLowerCase();
				if (!hay.includes(this.searchTxt)) return false;
			}
			if (this.filterInStock && it.is_stock_item && parseFloat(it.stock_qty) <= 0) return false;
			return true;
		});
	}

	_render_grid() {
		const $grid = this.$body.find("#efs-grid");
		const items = this._filtered_items();
		if (!items.length) {
			$grid.html('<div class="efs-grid-empty">Sin productos para mostrar.</div>');
			return;
		}
		$grid.html(items.map((it) => this._card_html(it)).join(""));
		$grid.find(".efs-card").on("click", (e) => {
			const item_code = $(e.currentTarget).data("item-code");
			const item = this.allItems.find((it) => it.item_code === item_code);
			if (item) this._add_or_prompt(item);
		});
		$grid.find(".efs-card-stock-btn").on("click", (e) => {
			e.stopPropagation();
			const item_code = $(e.currentTarget).data("item-code");
			this._show_stock_dialog(item_code);
		});
		$grid.find(".efs-card-lm-btn").on("click", (e) => {
			e.stopPropagation();
			const item_code = $(e.currentTarget).data("item-code");
			this._show_lista_materiales_dialog(item_code);
		});
	}

	_show_lista_materiales_dialog(item_code) {
		const dlg = new frappe.ui.Dialog({ title: __("Lista de Materiales — {0}", [item_code]) });
		dlg.$body.html('<div class="efs-stock-loading">Consultando detalle…</div>');
		dlg.show();

		frappe.call({
			method: "facex_multi.api.item.get_lista_materiales_detail",
			args: { item_code },
			callback: (r) => {
				const d = r.message || {};
				const items = d.items || [];
				const modo_label = d.modo_stock === "Padre"
					? "El producto tiene stock propio."
					: "El stock proviene de sus componentes.";
				const rows = items.length
					? items.map((it) => `
						<tr>
							<td>${_efs_esc(it.item_code)}</td>
							<td>${_efs_esc(it.item_name || "")}</td>
							<td style="text-align:right;">${_efs_fmt(it.qty)}</td>
							<td>${_efs_esc(it.uom || "")}</td>
						</tr>`).join("")
					: '<tr><td colspan="4" style="text-align:center;color:var(--efs-text-muted);">Sin componentes.</td></tr>';
				dlg.$body.html(`
					<div style="font-size:12.5px;color:var(--efs-text-muted);margin-bottom:10px;">${_efs_esc(modo_label)}</div>
					<table class="efs-stock-table">
						<thead><tr><th>Código</th><th>Producto</th><th style="text-align:right;">Cantidad</th><th>UOM</th></tr></thead>
						<tbody>${rows}</tbody>
					</table>
				`);
			},
		});
	}

	_show_stock_dialog(item_code) {
		const dlg = new frappe.ui.Dialog({ title: __("Saldos por Bodega — {0}", [item_code]) });
		dlg.$body.html('<div class="efs-stock-loading">Consultando inventario…</div>');
		dlg.show();

		frappe.call({
			method: "facex_multi.api.invoice.get_item_stock",
			args: { item_code, company: this.doc.company },
			callback: (r) => {
				const rows = r.message || [];
				if (!rows.length) {
					dlg.$body.html('<div class="efs-stock-loading">Sin registros de inventario para este producto.</div>');
					return;
				}
				if (!rows[0].is_stock_item) {
					dlg.$body.html('<div class="efs-stock-loading">Producto de servicio — no maneja inventario.</div>');
					return;
				}
				const uom = rows[0].stock_uom || "";
				const fmt = (n) => (parseFloat(n) || 0).toLocaleString("es-GT", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
				dlg.$body.html(`
					<table class="efs-stock-table">
						<thead><tr><th>Bodega</th><th>Disponible</th><th>Proyectado</th></tr></thead>
						<tbody>
							${rows.map((row) => `
								<tr>
									<td>${_efs_esc(row.warehouse)}</td>
									<td>${fmt(row.actual_qty)} ${_efs_esc(uom)}</td>
									<td>${fmt(row.projected_qty)}</td>
								</tr>
							`).join("")}
						</tbody>
					</table>
				`);
			},
		});
	}

	_cart_qty_for(item_code) {
		return (this.doc.items || [])
			.filter((r) => r.item_code === item_code)
			.reduce((sum, r) => sum + (parseFloat(r.qty) || 0), 0);
	}

	_card_html(it) {
		const qty = this._cart_qty_for(it.item_code);
		const initials = (it.item_name || it.item_code || "").trim().slice(0, 2).toUpperCase();
		const img = it.image_url
			? `<img src="${_efs_esc(it.image_url)}" class="efs-card-img" />`
			: `<div class="efs-card-placeholder">${_efs_esc(initials)}</div>`;
		const hasStock = !!it.is_stock_item && parseFloat(it.stock_qty) > 0;
		const lmBtn = it.is_lista_materiales
			? `<button class="efs-card-lm-btn" data-item-code="${_efs_esc(it.item_code)}" title="Ver detalle de Lista de Materiales">▶</button>`
			: "";
		return `
			<div class="efs-card ${hasStock ? "efs-card-instock" : ""}" data-item-code="${_efs_esc(it.item_code)}">
				${qty > 0 ? `<span class="efs-card-badge">${qty}</span>` : ""}
				<button class="efs-card-stock-btn" data-item-code="${_efs_esc(it.item_code)}" title="Ver saldos por bodega">≡</button>
				${lmBtn}
				${img}
				<div class="efs-card-name">${_efs_esc(it.item_name || it.item_code)}</div>
				<div class="efs-card-price">Q ${_efs_fmt(it.rate)}</div>
			</div>
		`;
	}

	// -----------------------------------------------------------------------
	// Carrito (ticket)
	// -----------------------------------------------------------------------

	_add_or_prompt(item) {
		if (item.is_stock_item && parseFloat(item.stock_qty) <= 0) {
			frappe.show_alert({
				message: __("{0} no tiene existencias en la bodega actual.", [item.item_name || item.item_code]),
				indicator: "orange",
			});
		}

		const mergeable = !item.has_serial_no && !item.custom_tiene_adenda;
		if (mergeable) {
			const existingIdx = this.doc.items.findIndex((r) => r.item_code === item.item_code);
			if (existingIdx !== -1) {
				const row = this.doc.items[existingIdx];
				row.qty = (parseFloat(row.qty) || 0) + 1;
				this._render_cart();
				this._render_grid();
				return;
			}
		}

		const idx = this._push_cart_row(item);
		if (item.has_serial_no || item.custom_tiene_adenda) {
			this._handle_item_serial_adenda(idx, item);
		}
		this._render_cart();
		this._render_grid();
		this._maybe_suggest_pair(item.item_code);
	}

	// ── Artículos en Par / Alternativos / Búsqueda por Palabras Clave ──────

	_maybe_suggest_pair(item_code) {
		frappe.call({
			method: "facex_multi.api.item_relations.get_item_pair_suggestion",
			args: { item_code },
			callback: (r) => {
				const pair = r.message;
				if (!pair || !pair.item_code) return;
				const alreadyInCart = (this.doc.items || []).some((row) => row.item_code === pair.item_code);
				if (alreadyInCart) return;
				frappe.confirm(
					`<strong>${_efs_esc(item_code)}</strong> tiene un artículo en par configurado: <strong>${_efs_esc(pair.item_name || pair.item_code)}</strong>. ¿Agregarlo también?`,
					() => {
						frappe.call({
							method: "facex_multi.api.invoice.get_item_details",
							args: { item_code: pair.item_code, company: this.doc.company },
							callback: (rr) => {
								const d = rr.message || {};
								this._add_or_prompt({
									item_code: pair.item_code,
									item_name: d.item_name || pair.item_name,
									rate: d.rate || 0,
									stock_uom: d.uom,
									is_stock_item: d.is_stock_item,
									has_serial_no: d.has_serial_no,
									custom_tiene_adenda: d.custom_tiene_adenda,
								});
							},
						});
					}
				);
			},
		});
	}

	_show_alternatives_view() {
		if (!(this.doc.items || []).length) {
			frappe.show_alert({ message: "Agregue primero un artículo al carrito.", indicator: "orange" });
			return;
		}
		const idx = this.doc.items.length - 1;
		const row = this.doc.items[idx];

		frappe.call({
			method: "facex_multi.api.item_relations.get_item_relations",
			args: { item_code: row.item_code, tipo: "Alternativo" },
			callback: (r) => {
				const options = r.message || [];
				if (!options.length) {
					frappe.show_alert({ message: `'${row.item_code}' no tiene artículos alternativos configurados.`, indicator: "orange" });
					return;
				}
				const $view = this.$body.find("#efs-alt-view");
				$view.html(`
					<div class="efs-wizard efs-history-wizard">
						<div class="efs-wizard-header">
							<button class="efs-step-nav" id="efs-alt-back">← Volver</button>
							<div class="efs-wizard-title">Alternativos de ${_efs_esc(row.item_code)}</div>
						</div>
						<div class="efs-history-results" id="efs-alt-results">
							${options.map((it) => `
								<div class="efs-cust-row" data-code="${_efs_esc(it.item_code)}">
									<strong>${_efs_esc(it.item_code)}</strong> — ${_efs_esc(it.item_name || "")}
								</div>`).join("")}
						</div>
					</div>
				`);
				$view.show();
				$view.find("#efs-alt-back").on("click", () => $view.hide());
				$view.find("#efs-alt-results [data-code]").on("click", (e) => {
					const item_code = $(e.currentTarget).data("code");
					$view.hide();
					frappe.call({
						method: "facex_multi.api.invoice.get_item_details",
						args: { item_code, company: this.doc.company },
						callback: (rr) => {
							const d = rr.message || {};
							Object.assign(row, {
								item_code,
								item_name: d.item_name || item_code,
								description: d.item_name || item_code,
								rate: parseFloat(d.rate) || 0,
								price_list_rate: parseFloat(d.rate) || 0,
								uom: d.uom || row.uom,
								is_stock_item: d.is_stock_item || 0,
								_has_serial_no: d.has_serial_no || 0,
								_custom_tiene_adenda: d.custom_tiene_adenda || 0,
							});
							this._render_cart();
						},
					});
				});
			},
		});
	}

	_show_keyword_search_view() {
		const $view = this.$body.find("#efs-keyword-view");
		$view.html(`
			<div class="efs-wizard efs-history-wizard">
				<div class="efs-wizard-header">
					<button class="efs-step-nav" id="efs-kw-back">← Volver</button>
					<div class="efs-wizard-title">Buscar por Palabras Clave / Referencias</div>
				</div>
				<div class="efs-history-filters">
					<div class="efs-field-row" style="flex:1;">
						<label>Buscar</label>
						<input type="text" id="efs-kw-search" class="efs-cust-detail-input" placeholder="Alias, número de referencia, u otro nombre..." autocomplete="off" />
					</div>
				</div>
				<div class="efs-history-results" id="efs-kw-results">
					<div class="efs-cust-details-loading">Escriba para buscar…</div>
				</div>
			</div>
		`);
		$view.show();
		$view.find("#efs-kw-back").on("click", () => $view.hide());

		let timer = null;
		$view.find("#efs-kw-search").on("input", (e) => {
			clearTimeout(timer);
			const txt = e.target.value.trim();
			const $results = $view.find("#efs-kw-results");
			if (txt.length < 2) {
				$results.html('<div class="efs-cust-details-loading">Escriba para buscar…</div>');
				return;
			}
			timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.item_relations.search_items_by_keywords",
					args: { txt, company: this.doc.company },
					callback: (r) => {
						const rows = r.message || [];
						if (!rows.length) {
							$results.html('<div class="efs-cust-details-loading">Sin resultados.</div>');
							return;
						}
						$results.html(rows.map((it) => `
							<div class="efs-cust-row" data-code="${_efs_esc(it.item_code)}">
								<strong>${_efs_esc(it.item_code)}</strong> — ${_efs_esc(it.item_name || "")}
								${it.matched_keywords ? `<br><small style="color:#6c757d;">${_efs_esc(it.matched_keywords)}</small>` : ""}
							</div>`).join(""));
						$results.find("[data-code]").on("click", (ev) => {
							const item_code = $(ev.currentTarget).data("code");
							const picked = rows.find((x) => x.item_code === item_code);
							$view.hide();
							this._add_or_prompt({
								item_code,
								item_name: picked ? picked.item_name : item_code,
								rate: picked ? parseFloat(picked.rate) || 0 : 0,
								stock_uom: picked ? picked.stock_uom : "Nos",
								is_stock_item: picked ? picked.is_stock_item : 1,
								has_serial_no: picked ? picked.has_serial_no : 0,
								custom_tiene_adenda: 0,
							});
						});
					},
				});
			}, 250);
		});
		setTimeout(() => $view.find("#efs-kw-search").trigger("focus"), 100);
	}

	_push_cart_row(item, qty = 1) {
		const row = {
			item_code: item.item_code,
			item_name: item.item_name,
			description: item.item_name,
			qty,
			rate: parseFloat(item.rate) || 0,
			price_list_rate: parseFloat(item.rate) || 0,
			discount_percentage: 0,
			uom: item.stock_uom || "Nos",
			warehouse: this.posWarehouse || this.defaults.default_warehouse || "",
			cost_center: this.defaults.default_cost_center || "",
			bfel_multi_tipo: (this.company_config || {}).tipo_x_defecto || "",
			bfel_comentario: "",
			is_stock_item: 1,
			_has_serial_no: item.has_serial_no || 0,
			_custom_tiene_adenda: item.custom_tiene_adenda || 0,
			_item_group: item.item_group || "",
			serial_no: "",
			tiene_adenda: 0,
		};
		this.doc.items.push(row);
		return this.doc.items.length - 1;
	}

	_change_qty(idx, delta) {
		const row = this.doc.items[idx];
		if (!row) return;
		row.qty = Math.max(0, (parseFloat(row.qty) || 0) + delta);
		if (row.qty === 0) {
			this.doc.items.splice(idx, 1);
		}
		this._render_cart();
		this._render_grid();
	}

	_set_qty(idx, value) {
		const row = this.doc.items[idx];
		if (!row) return;
		const qty = Math.max(0, parseFloat(value) || 0);
		if (qty === 0) {
			this.doc.items.splice(idx, 1);
		} else {
			row.qty = qty;
		}
		this._render_cart();
		this._render_grid();
	}

	_remove_line(idx) {
		this.doc.items.splice(idx, 1);
		this._render_cart();
		this._render_grid();
	}

	_calc_line_amount(row) {
		const qty = parseFloat(row.qty) || 0;
		const rate = parseFloat(row.rate) || 0;
		const disc = parseFloat(row.discount_percentage) || 0;
		const base = qty * rate;
		return base - (base * disc) / 100;
	}

	_render_cart() {
		const $lines = this.$body.find("#efs-ticket-lines");
		const items = this.doc.items || [];
		if (!items.length) {
			$lines.html('<div class="efs-ticket-empty" id="efs-ticket-empty">Toque un producto para agregarlo.</div>');
		} else {
			$lines.html(items.map((row, idx) => this._cart_row_html(idx, row)).join(""));
			$lines.find(".efs-qty-minus").on("click", (e) => this._change_qty(parseInt($(e.currentTarget).data("idx"), 10), -1));
			$lines.find(".efs-qty-plus").on("click", (e) => this._change_qty(parseInt($(e.currentTarget).data("idx"), 10), 1));
			$lines.find(".efs-qty-value").on("click", (e) => this._show_qty_keypad(parseInt($(e.currentTarget).data("idx"), 10)));
			$lines.find(".efs-line-remove").on("click", (e) => this._remove_line(parseInt($(e.currentTarget).data("idx"), 10)));
			$lines.find(".efs-line-options").on("click", (e) => this._show_line_options(parseInt($(e.currentTarget).data("idx"), 10)));
		}
		this.$body.find("#efs-btn-suspend").prop("disabled", !items.length);
		this._update_totals();
	}

	_cart_row_html(idx, row) {
		const cfg = this.company_config || {};
		const adendaBadge = row._has_serial_no || row._custom_tiene_adenda
			? `<span class="efs-line-tag ${row.tiene_adenda || row.serial_no ? "efs-line-tag-ok" : "efs-line-tag-pending"}">${row.tiene_adenda || row.serial_no ? "Adenda ✓" : "Adenda pendiente"}</span>`
			: "";
		const details = [];
		if ((cfg.mostrar_almacen || row._has_serial_no || row._custom_tiene_adenda) && row.warehouse) {
			details.push(`Almacén: ${_efs_esc(row.warehouse)}`);
		}
		if (cfg.mostrar_desc_pct && parseFloat(row.discount_percentage) > 0) details.push(`Desc: ${_efs_fmt(row.discount_percentage)}%`);
		if (cfg.mostrar_tipo && row.bfel_multi_tipo) details.push(`Tipo: ${_efs_esc(row.bfel_multi_tipo)}`);
		if (row.bfel_comentario) details.push(`💬 ${_efs_esc(row.bfel_comentario)}`);
		const detailsRow = details.length ? `<div class="efs-line-details">${details.join(" · ")}</div>` : "";
		const needsSerialOrAdenda = row._has_serial_no || row._custom_tiene_adenda;
		// El botón "..." siempre tiene sentido ahora: el Comentario está
		// disponible incondicionalmente en _render_line_options_dialog.
		const showOptionsBtn = true;
		// Layout en 3 filas (nombre / detalles / controles) en vez de una sola
		// grilla de 5 columnas: antes la columna del nombre quedaba exprimida
		// por el stepper+monto+opciones+quitar en la misma fila, así que
		// cualquier descripción o comentario un poco largo se partía en muchas
		// líneas angostas y la fila crecía mucho hacia abajo. Ahora nombre y
		// detalles usan el ancho completo del ticket; los controles (cantidad,
		// precio, importe, "…", quitar) quedan juntos en su propia fila.
		return `
			<div class="efs-ticket-line">
				<div class="efs-line-top">
					<div class="efs-line-name">${_efs_esc(row.item_name)} ${adendaBadge}</div>
					<button class="efs-line-remove" data-idx="${idx}" title="Quitar">×</button>
				</div>
				${detailsRow}
				<div class="efs-line-bottom">
					<div class="efs-line-qty">
						<button class="efs-qty-btn efs-qty-minus" data-idx="${idx}">−</button>
						<span class="efs-qty-value" data-idx="${idx}">${row.qty}</span>
						<button class="efs-qty-btn efs-qty-plus" data-idx="${idx}">+</button>
					</div>
					<div class="efs-line-bottom-right">
						<span class="efs-line-rate">Q ${_efs_fmt(row.rate)} c/u</span>
						<span class="efs-line-amount">Q ${_efs_fmt(this._calc_line_amount(row))}</span>
						${showOptionsBtn ? `<button class="efs-line-options" data-idx="${idx}" title="Más opciones">⋯</button>` : ""}
					</div>
				</div>
			</div>
		`;
	}

	_update_totals() {
		const subtotal = (this.doc.items || []).reduce((sum, r) => sum + this._calc_line_amount(r), 0);
		this.$body.find("#efs-subtotal").text(`Q ${_efs_fmt(subtotal)}`);
		this._render_stepbar();
	}

	_show_qty_keypad(idx) {
		const row = this.doc.items[idx];
		if (!row) return;
		let value = "";
		const d = new frappe.ui.Dialog({
			title: __("Cantidad — {0}", [row.item_name]),
			fields: [{ fieldtype: "HTML", fieldname: "efs_keypad_html" }],
			primary_action_label: __("Aplicar"),
			primary_action: () => {
				this._set_qty(idx, value || row.qty);
				d.hide();
			},
		});
		const $wrapper = d.fields_dict.efs_keypad_html.$wrapper;
		this._render_numpad($wrapper, {
			initial: String(row.qty || ""),
			onChange: (v) => { value = v; },
		});
		d.show();
	}

	_render_numpad($wrapper, { initial = "", onChange }) {
		let value = initial;
		$wrapper.html(`
			<div class="efs-numpad">
				<div class="efs-numpad-display" id="efs-numpad-display">${_efs_esc(value || "0")}</div>
				<div class="efs-numpad-keys">
					${["1","2","3","4","5","6","7","8","9",".","0","⌫"].map((k) => `<button class="efs-numpad-key" data-key="${k}">${k}</button>`).join("")}
				</div>
			</div>
		`);
		const $display = $wrapper.find("#efs-numpad-display");
		$wrapper.find(".efs-numpad-key").on("click", (e) => {
			const key = $(e.currentTarget).data("key");
			if (key === "⌫") {
				value = value.slice(0, -1);
			} else if (key === "." && value.includes(".")) {
				// no-op
			} else {
				value = (value === "0" ? "" : value) + key;
			}
			$display.text(value || "0");
			if (onChange) onChange(value);
		});
	}

	_show_line_options(idx) {
		const row = this.doc.items[idx];
		if (!row) return;
		const needsSerialOrAdenda = row._has_serial_no || row._custom_tiene_adenda;

		// Para ítems con serie/adenda, el almacén determina qué series hay
		// disponibles después — se acota el selector a bodegas donde el ítem
		// realmente tenga existencias (fallback: todas las bodegas de la compañía).
		if (needsSerialOrAdenda) {
			frappe.call({
				method: "facex_multi.api.invoice.get_item_stock",
				args: { item_code: row.item_code, company: this.doc.company },
				freeze: true,
				freeze_message: __("Consultando existencias…"),
				callback: (r) => {
					const stockRows = (r.message || []).filter((x) => parseFloat(x.actual_qty) > 0);
					const whOptions = stockRows.length ? stockRows.map((x) => x.warehouse) : (this.warehouses || []);
					this._render_line_options_dialog(idx, whOptions);
				},
			});
			return;
		}

		this._render_line_options_dialog(idx, this.warehouses || []);
	}

	_render_line_options_dialog(idx, warehouseOptions) {
		const row = this.doc.items[idx];
		if (!row) return;
		const cfg = this.company_config || {};
		const needsSerialOrAdenda = row._has_serial_no || row._custom_tiene_adenda;

		const fields = [];
		if (this.perms.puede_editar_precio) {
			fields.push({ fieldname: "rate", fieldtype: "Currency", label: __("Precio Unitario"), default: row.rate || 0 });
		}
		// El almacén se muestra siempre que el ítem maneje series/lotes o adenda
		// (de ahí depende qué se puede seleccionar después), además de cuando la
		// compañía tiene la columna Almacén activada.
		if (cfg.mostrar_almacen || needsSerialOrAdenda) {
			fields.push({
				fieldname: "warehouse", fieldtype: "Select", label: __("Almacén"),
				options: warehouseOptions.join("\n"), default: row.warehouse || warehouseOptions[0] || "", reqd: 1,
			});
		}
		if (cfg.mostrar_desc_pct) {
			fields.push({ fieldname: "discount_percentage", fieldtype: "Percent", label: __("Descuento %"), default: row.discount_percentage || 0 });
		}
		if (cfg.mostrar_tipo) {
			fields.push({ fieldname: "bfel_multi_tipo", fieldtype: "Select", label: __("Tipo FEL"), options: "\nB\nS", default: row.bfel_multi_tipo || "" });
		}
		// Comentario interno: siempre disponible, no depende de company_config
		// (nota libre del cajero, no fiscal, no se imprime en el documento).
		fields.push({ fieldname: "bfel_comentario", fieldtype: "Small Text", label: __("Comentario"), default: row.bfel_comentario || "" });

		if (!fields.length) {
			frappe.show_alert({ message: __("No hay más opciones disponibles para esta línea."), indicator: "blue" });
			return;
		}

		const dlg = new frappe.ui.Dialog({
			title: __("Más opciones — {0}", [row.item_name || row.item_code]),
			fields,
			primary_action_label: __("Aplicar"),
			primary_action: (values) => {
				const previousWarehouse = row.warehouse;
				Object.assign(row, values);
				dlg.hide();
				this._render_cart();

				if (!needsSerialOrAdenda) return;

				// Marcado el almacén, se reabre serie/adenda si cambió de bodega
				// o aún está pendiente — en una sola ventana, sin duplicar el
				// paso de escaneo (ver _start_serial_or_adenda).
				const warehouseChanged = values.warehouse && values.warehouse !== previousWarehouse;
				const stillPending = row._has_serial_no ? !row.serial_no : !row.tiene_adenda;
				if (warehouseChanged || stillPending) {
					this._start_serial_or_adenda(idx, () => this._render_cart());
				}
			},
		});

		// Guarda el almacén en memoria (row.warehouse) tan pronto se cambia el
		// campo, sin esperar a "Aplicar" — así el botón de Serie/Adenda de abajo
		// ya usa la bodega recién elegida aunque no se haya confirmado el diálogo.
		if (dlg.fields_dict.warehouse) {
			dlg.fields_dict.warehouse.$input.on("change", () => {
				row.warehouse = dlg.fields_dict.warehouse.get_value();
			});
		}

		if (needsSerialOrAdenda) {
			const completa = row.tiene_adenda || row.serial_no;
			const $btn = $(`
				<button type="button" class="btn btn-default btn-sm efs-adenda-edit-btn">
					${completa ? __("Editar Serie / Adenda DIGECAM") : __("Completar Serie / Adenda DIGECAM (obligatorio)")}
				</button>
			`);
			$btn.on("click", () => {
				dlg.hide();
				this._start_serial_or_adenda(idx, () => this._render_cart());
			});
			dlg.$body.append($btn);
		}

		dlg.show();
	}

	// -----------------------------------------------------------------------
	// Serie / Adenda DIGECAM (portado de facex.js, adaptado a esta pantalla)
	// -----------------------------------------------------------------------

	// Punto único de entrada al flujo de serie/adenda: si el ítem maneja AMBOS
	// (típico de ARMAS), abre directo la ventana de Adenda —que ya trae su
	// propio campo Serie acotado al almacén— en vez de pedir la serie dos
	// veces (picker aparte + campo Serie dentro de la adenda).
	_start_serial_or_adenda(idx, callback) {
		const row = this.doc.items[idx];
		if (!row) return;
		if (row._has_serial_no && row._custom_tiene_adenda) {
			this._show_adenda_dialog(idx, "arma", callback);
		} else if (row._has_serial_no) {
			this._show_serial_picker(idx, callback);
		} else if (row._custom_tiene_adenda) {
			const tipo = (row._item_group === "ARMAS") ? "arma" : "municion";
			this._show_adenda_dialog(idx, tipo, callback);
		} else if (callback) {
			callback();
		}
	}

	_handle_item_serial_adenda(idx, details) {
		const cfg = this.company_config || {};
		const wantsSerial = details.has_serial_no && cfg.maneja_series;
		const wantsAdenda = details.custom_tiene_adenda && cfg.maneja_adendas;

		if (wantsSerial && wantsAdenda) {
			this._show_adenda_dialog(idx, "arma");
		} else if (wantsSerial) {
			this._show_serial_picker(idx);
		} else if (wantsAdenda) {
			this._show_adenda_dialog(idx, "municion");
		}
	}

	_show_serial_picker(idx, callback) {
		const row = this.doc.items[idx];
		if (!row) return;
		const warehouse = row.warehouse || this.posWarehouse || this.defaults.default_warehouse || "";
		const item_code = row.item_code;

		const dlg = new frappe.ui.Dialog({
			title: __("Seleccionar Serie — {0}", [item_code]),
			fields: [
				{ fieldname: "buscar", fieldtype: "Data", label: __("Buscar"), placeholder: __("Filtrar por número de serie…") },
			],
		});

		const $list = $(`
			<div class="efs-serial-list">
				<div class="efs-serial-loading">Cargando series…</div>
			</div>
		`);
		dlg.$body.append($list);

		let all_series = [];
		const render = (filter) => {
			const q = (filter || "").toLowerCase();
			const visible = q ? all_series.filter((s) => s.name.toLowerCase().includes(q)) : all_series;
			if (!visible.length) {
				$list.html('<div class="efs-serial-empty">Sin series disponibles en la bodega seleccionada.</div>');
				return;
			}
			$list.html(
				visible.map((s) => `
					<div class="efs-serial-row" data-serial="${_efs_esc(s.name)}">
						<span class="efs-serial-code">${_efs_esc(s.name)}</span>
						<span class="efs-serial-wh">${_efs_esc(s.warehouse || "")}</span>
					</div>
				`).join("")
			);
			$list.find(".efs-serial-row").on("click", (e) => {
				const serial = String($(e.currentTarget).attr("data-serial"));
				row.serial_no = serial;
				row.qty = 1;
				this._render_cart();
				dlg.hide();
				if (callback) callback();
			});
		};

		frappe.call({
			method: "facex_multi.api.invoice.get_serial_nos_for_item",
			args: { item_code, warehouse, company: this.doc.company },
			callback: (r) => {
				all_series = r.message || [];
				render("");
			},
		});

		dlg.fields_dict.buscar.$input.on("input", function () {
			render($(this).val().trim());
		});

		dlg.show();
	}

	_show_adenda_dialog(idx, tipo, on_success, on_cancel) {
		const row = this.doc.items[idx];
		if (!row) return;
		const es_arma = tipo === "arma";
		let resolved = false;

		let fields;
		if (es_arma) {
			fields = [
				{ fieldname: "serie_digecam", fieldtype: "Link", label: "Serie", reqd: 1, options: "Serial No",
					default: row.serial_no || "",
					get_query: () => ({
						filters: {
							item_code: row.item_code,
							status: "Active",
							...(row.warehouse ? { warehouse: row.warehouse } : {}),
						},
					}) },
				{ fieldname: "sb0", fieldtype: "Section Break" },
				{ fieldname: "color", fieldtype: "Data", label: "Color" },
				{ fieldname: "cb1", fieldtype: "Column Break" },
				{ fieldname: "largo", fieldtype: "Data", label: "Largo del Cañón" },
				{ fieldname: "sb2", fieldtype: "Section Break" },
				{ fieldname: "modelo", fieldtype: "Data", label: "Modelo" },
				{ fieldname: "cb2", fieldtype: "Column Break" },
				{ fieldname: "oficio", fieldtype: "Data", label: "Oficio (Autorización DIGECAM)" },
				{ fieldname: "sb3", fieldtype: "Section Break" },
				{ fieldname: "tenencia_1", fieldtype: "Data", label: "Tenencia 1", reqd: 1 },
				{ fieldname: "cb3", fieldtype: "Column Break" },
				{ fieldname: "tenencia_2", fieldtype: "Data", label: "Tenencia 2", reqd: 1 },
				{ fieldname: "sb4", fieldtype: "Section Break" },
				{ fieldname: "codigo", fieldtype: "Data", label: "Código Cliente DIGECAM" },
				{ fieldname: "cb4", fieldtype: "Column Break" },
				{ fieldname: "expediente", fieldtype: "Data", label: "Expediente" },
			];
		} else {
			fields = [
				{ fieldname: "licencia", fieldtype: "Data", label: "Licencia" },
				{ fieldname: "cb1", fieldtype: "Column Break" },
				{ fieldname: "autorizacion", fieldtype: "Data", label: "Autorización" },
				{ fieldname: "sb2", fieldtype: "Section Break" },
				{ fieldname: "lote", fieldtype: "Data", label: "Lote" },
				{ fieldname: "cb2", fieldtype: "Column Break" },
				{ fieldname: "custom_tenencia_municion", fieldtype: "Data", label: "Tenencia", reqd: 1 },
				{ fieldname: "sb3", fieldtype: "Section Break" },
				{ fieldname: "custom_codigo_cliente_municion", fieldtype: "Data", label: "Código Cliente", reqd: 1 },
			];
		}

		const dlg = new frappe.ui.Dialog({
			title: __("Adenda DIGECAM — {0}", [row.item_name || row.item_code]),
			fields,
			primary_action_label: __("Guardar Adenda"),
			primary_action: (values) => {
				Object.assign(row, values);
				if (es_arma) {
					if (values.serie_digecam) {
						row.serial_no = values.serie_digecam;
						row.qty = 1;
					}
					delete row.serie_digecam;
				}
				row.tiene_adenda = 1;
				resolved = true;
				this._render_cart();
				dlg.hide();
				if (on_success) on_success();
			},
			secondary_action_label: __("Cancelar"),
			secondary_action: () => dlg.hide(),
		});

		const _orig_hide = dlg.hide.bind(dlg);
		dlg.hide = () => {
			_orig_hide();
			if (!resolved && on_cancel) on_cancel();
		};

		dlg.show();
	}

	_adendas_pendientes() {
		return (this.doc.items || [])
			.map((row, idx) => ({ row, idx }))
			.filter(({ row }) => (row._has_serial_no || row._custom_tiene_adenda) && !row.tiene_adenda && !row.serial_no);
	}

	// -----------------------------------------------------------------------
	// Cliente (mostrador / búsqueda / alta rápida)
	// -----------------------------------------------------------------------

	// `onSelect(name, customer_name)`: si se pasa, se usa en vez de mutar
	// this.doc.customer directo — permite reutilizar el mismo buscador desde
	// contextos donde elegir cliente no significa "cambiar el cliente de la
	// venta en curso" (p. ej. corregir el cliente de una factura ya cerrada).
	_show_customer_picker(onSelect) {
		const d = new frappe.ui.Dialog({
			title: __("Seleccionar Cliente"),
			fields: [
				{ fieldname: "buscar", fieldtype: "Data", label: __("Buscar"), placeholder: __("Nombre, NIT o código…") },
			],
			primary_action_label: __("+ Nuevo Cliente"),
			primary_action: () => {
				d.hide();
				this._show_new_customer_dialog(onSelect);
			},
		});
		const $list = $('<div class="efs-cust-list"></div>');
		d.$body.append($list);

		const search = (txt) => {
			frappe.call({
				method: "facex_multi.api.item.get_customers_list",
				args: { txt, company: this.doc.company },
				callback: (r) => {
					const rows = r.message || [];
					if (!rows.length) {
						$list.html('<div class="efs-cust-empty">Sin resultados.</div>');
						return;
					}
					$list.html(
						rows.map((c) => `
							<div class="efs-cust-row" data-name="${_efs_esc(c.name)}" data-label="${_efs_esc(c.customer_name)}" data-sales-partner="${_efs_esc(c.default_sales_partner || "")}">
								<div class="efs-cust-name">${_efs_esc(c.customer_name)}</div>
								<div class="efs-cust-nit">${_efs_esc(c.tax_id || "")}</div>
							</div>
						`).join("")
					);
					$list.find(".efs-cust-row").on("click", (e) => {
						const $row = $(e.currentTarget);
						const name = $row.data("name");
						const label = $row.data("label");
						if (onSelect) {
							d.hide();
							onSelect(name, label);
							return;
						}
						this.doc.customer = name;
						this.doc.customer_name = label;
						const defaultPartner = $row.data("sales-partner");
						if (!this.doc.sales_partner && defaultPartner) {
							this.doc.sales_partner = defaultPartner;
						}
						this._render_customer_bar();
						d.hide();
					});
				},
			});
		};

		d.fields_dict.buscar.$input.on("input", function () {
			const txt = $(this).val().trim();
			if (txt.length >= 2) search(txt);
		});

		d.show();
		search("");
	}

	_show_new_customer_dialog(onCreate) {
		const d = new frappe.ui.Dialog({
			title: __("Nuevo Cliente"),
			fields: [
				{ fieldname: "customer_name", fieldtype: "Data", label: __("Nombre"), reqd: 1 },
				{ fieldname: "bfel_identificacion", fieldtype: "Select", label: __("Tipo Identificación"), options: "NIT\nCUI\nPASAPORTE\nCF", default: "CF" },
				{ fieldname: "bfel_id_receptor", fieldtype: "Data", label: __("NIT / CUI") },
			],
			primary_action_label: __("Guardar"),
			primary_action: (values) => {
				frappe.call({
					method: "facex_multi.api.item.get_price_lists",
					args: { company: this.doc.company },
					callback: (rp) => {
						const price_list = ((rp.message || [])[0] || {}).name || "";
						frappe.call({
							method: "facex_multi.api.customer.create_or_update_customer",
							args: {
								data_json: JSON.stringify({ ...values, default_price_list: price_list }),
								company: this.doc.company,
							},
							freeze: true,
							callback: (r) => {
								if (r.message) {
									const name = r.message.name;
									const label = r.message.customer_name || values.customer_name;
									if (onCreate) {
										d.hide();
										onCreate(name, label);
										return;
									}
									this.doc.customer = name;
									this.doc.customer_name = label;
									this._render_customer_bar();
									d.hide();
								}
							},
						});
					},
				});
			},
		});
		d.show();
	}

	// -----------------------------------------------------------------------
	// Wizard de pago
	// -----------------------------------------------------------------------

	// `suspend`: true fuerza bfel_venta_suspendida=1 (botón "Suspender venta");
	// null/omitido conserva el valor que ya traía el documento (no lo toca) —
	// así, solo pasar por el paso de Pago y volver a Productos sin cobrar no
	// hace que una venta en espera desaparezca del listado (antes se forzaba
	// a 0 en cada llegada a Pago, aunque no se pagara ni se cambiara nada).
	// El flag deja de importar de todas formas en cuanto la factura se llega
	// a validar (docstatus=1), porque get_held_sales ya filtra por docstatus=0.
	_build_save_payload({ suspend = null } = {}) {
		const d = this.doc;
		return {
			doctype: "Sales Invoice",
			name: d.name || undefined,
			es_fiscal: 1,
			update_stock: 1,
			naming_series: !d.name ? d.naming_series : undefined,
			customer: d.customer,
			company: d.company,
			posting_date: d.posting_date,
			due_date: d.due_date,
			payment_terms_template: d.payment_terms_template || "",
			taxes_and_charges: d.taxes_and_charges || "",
			selling_price_list: d.selling_price_list || "",
			sales_partner: d.sales_partner || "",
			bfel_establecimiento: String(d.bfel_establecimiento || ""),
			bfel_status: "01 Enviar",
			bfel_venta_suspendida: suspend === null ? (d.bfel_venta_suspendida ? 1 : 0) : (suspend ? 1 : 0),
			items: (d.items || []).map((r) => ({
				item_code: r.item_code,
				item_name: r.item_name || "",
				description: r.description || r.item_name || "",
				warehouse: r.warehouse || this.posWarehouse || this.defaults.default_warehouse || "",
				qty: parseFloat(r.qty) || 1,
				uom: r.uom || "",
				rate: parseFloat(r.rate) || 0,
				discount_percentage: parseFloat(r.discount_percentage) || 0,
				cost_center: r.cost_center || this.defaults.default_cost_center || "",
				bfel_multi_tipo: r.bfel_multi_tipo || "",
				bfel_comentario: r.bfel_comentario || "",
				serial_no: r.serial_no || "",
				tiene_adenda: r.tiene_adenda || 0,
				tenencia_1: r.tenencia_1 || "",
				tenencia_2: r.tenencia_2 || "",
				codigo: r.codigo || "",
				oficio: r.oficio || "",
				expediente: r.expediente || "",
				color: r.color || "",
				largo: r.largo || "",
				modelo: r.modelo || "",
				licencia: r.licencia || "",
				autorizacion: r.autorizacion || "",
				lote: r.lote || "",
				custom_tenencia_municion: r.custom_tenencia_municion || "",
				custom_codigo_cliente_municion: r.custom_codigo_cliente_municion || "",
			})).filter((r) => r.item_code),
		};
	}

	async _proceed_to_payment() {
		// Si la factura ya fue validada (submit_invoke corrió en un intento
		// anterior de "Confirmar Pago" que no llegó a completar save_payments),
		// ya no se puede volver a guardar como borrador — ERPNext la congela.
		// En ese caso no se reintenta save_draft (causaba "La factura ya fue
		// validada (submitted). No se puede editar en este estado."): se
		// reabre la misma vista de pago con los últimos totales conocidos,
		// para que el cajero solo tenga que terminar de registrar el pago.
		if (this.doc._submitted && this._lastSavedInvoice) {
			this.step = 3;
			this._render_payment_view(this._lastSavedInvoice);
			return;
		}

		if (!this.doc.sales_partner) {
			frappe.show_alert({ message: __("Seleccione un Vendedor antes de cobrar."), indicator: "orange" }, 5);
			return;
		}

		const pendientes = this._adendas_pendientes();
		for (const { row, idx } of pendientes) {
			const tipo = (row._item_group === "ARMAS") ? "arma" : "municion";
			frappe.show_alert({ message: __("Complete la adenda para: {0}", [row.item_name]), indicator: "orange" }, 5);
			await new Promise((resolve) => this._show_adenda_dialog(idx, tipo, resolve, resolve));
		}

		frappe.call({
			method: "facex_multi.api.invoice.save_draft",
			args: { doc_json: JSON.stringify(this._build_save_payload()) },
			freeze: true,
			freeze_message: __("Guardando venta…"),
			callback: (r) => {
				if (r.message) {
					this.doc.name = r.message.name;
					this.doc.grand_total = r.message.grand_total;
					this._lastSavedInvoice = r.message;
					this.step = 3;
					this._render_payment_view(r.message);
				}
			},
		});
	}

	_render_payment_view(savedDoc) {
		const total = parseFloat(savedDoc.grand_total || 0);
		this.paymentState = {
			total, method: "Efectivo", tendered: "", primaryAmount: total.toFixed(2), reference: "", payments: [], changeDue: 0,
			guias: [], guiasResolved: false, guiasSkipped: false,
		};

		const methods = ["Efectivo"];
		if ((this.company_config || {}).permite_pago_credito) methods.push("Crédito");
		methods.push("Tarjeta de Crédito", "Transferencia", "Cheque");
		if ((this.company_config || {}).permite_pago_contra_entrega && (this.perms || {}).puede_editar_guias_transporte) {
			methods.push("Contra Entrega");
		}

		const $view = this.$body.find("#efs-payment-view");
		$view.html(`
			<div class="efs-wizard">
				<div class="efs-wizard-header">
					${this.doc._submitted
						? `<span class="efs-step-nav" style="opacity:.5;cursor:default;" title="${_efs_esc(__("La factura ya fue validada: los productos ya no se pueden editar."))}">← Productos</span>`
						: `<button class="efs-step-nav" id="efs-pay-back">← Productos</button>`}
					<div class="efs-wizard-title">Cobrar</div>
					<button class="efs-step-nav" id="efs-pay-reset" title="${_efs_esc(__("Borra montos, referencias y métodos adicionales; empieza el cobro de nuevo."))}">Reiniciar pago</button>
				</div>
				<div class="efs-wizard-total">Total a cobrar<br><span>Q ${_efs_fmt(total)}</span></div>

				<div class="efs-pay-methods" id="efs-pay-methods">
					${methods.map((m) => `
						<button class="efs-pay-method-btn ${m === "Efectivo" ? "efs-pay-method-active" : ""}" data-method="${_efs_esc(m)}">${_efs_esc(m)}</button>
					`).join("")}
				</div>

				<div class="efs-pay-primary-covered" id="efs-pay-primary-covered" style="display:none;">
					El total ya quedó cubierto con los métodos agregados abajo — no hace falta completar nada aquí arriba.
				</div>

				<div class="efs-pay-cash" id="efs-pay-cash">
					<div class="efs-pay-quick-cash">
						${[50, 100, 200, 500].map((q) => `<button class="efs-quick-cash-btn" data-amt="${q}">Q${q}</button>`).join("")}
						<button class="efs-quick-cash-btn" id="efs-pay-exact">Monto exacto</button>
					</div>
					<div id="efs-pay-numpad"></div>
					<div class="efs-pay-change" id="efs-pay-change"></div>
				</div>

				<div class="efs-field-row" id="efs-pay-amount-row" style="display:none;">
					<label>Monto a aplicar</label>
					<input type="number" id="efs-pay-amount" class="efs-search-input" min="0" step="any" />
				</div>

				<div class="efs-field-row" id="efs-pay-reference-row" style="display:none;">
					<label>Número de Referencia</label>
					<input type="text" id="efs-pay-reference" class="efs-search-input" placeholder="Autorización / referencia del pago" />
				</div>

				<div class="efs-pay-credito-note" id="efs-pay-credito-note" style="display:none;">
					Se registrará como venta al crédito: la factura quedará pendiente de cobro, sin pago inmediato.
				</div>

				<div class="efs-pay-credito-note" id="efs-pay-contra-entrega-note" style="display:none;">
					Pago contra entrega: cobra el transportista al entregar, no se cobra en caja. Registre la guía de envío.
				</div>
				<button class="efs-btn-secondary" id="efs-btn-guias-transporte" style="display:none;">Envíos x Transporte</button>

				<div class="efs-pay-splits" id="efs-pay-splits"></div>
				<button class="efs-btn-link" id="efs-pay-add-split">+ Agregar otro método de pago</button>

				<div class="efs-pay-summary" id="efs-pay-summary"></div>

				<button class="efs-btn-charge" id="efs-pay-confirm">Confirmar Pago</button>
			</div>
		`);
		$view.show();

		if (typeof EFGuide !== "undefined") {
			EFGuide.attachHints($view, [
				{ selector: "#efs-pay-methods", text: "Elige la forma de pago. 'Crédito' deja la factura pendiente de cobro; 'Contra Entrega' la cobra el transportista al entregar." },
				{ selector: ".efs-pay-quick-cash", text: "Ingresa el monto que el cliente entrega en efectivo, o usa los montos rápidos (Q50, Q100...) o 'Monto exacto'." },
				{ selector: "#efs-pay-amount-row label", text: "Monto que se aplicará con este método de pago." },
				{ selector: "#efs-pay-reference-row label", text: "Número de autorización o referencia del pago (tarjeta, transferencia, cheque)." },
				{ selector: "#efs-pay-add-split", text: "Si el cliente paga con más de un método (ej. parte efectivo, parte tarjeta), agrega otro método aquí." },
				{ selector: "#efs-pay-confirm", text: "Confirma el pago y certifica la factura ante SAT (FEL)." },
			]);
		}

		this._render_numpad($view.find("#efs-pay-numpad"), {
			initial: "",
			onChange: (v) => {
				this.paymentState.tendered = v;
				this._update_change_display();
			},
		});

		$view.find("#efs-pay-back").on("click", () => {
			$view.hide();
			this._show_step(2);
		});

		$view.find("#efs-pay-reset").on("click", () => this._reset_payment());

		$view.find("#efs-pay-reference").on("input", (e) => {
			this.paymentState.reference = e.target.value;
		});

		$view.find("#efs-pay-amount").on("input", (e) => {
			this.paymentState.primaryAmount = e.target.value;
			this._update_change_display();
		});

		$view.find(".efs-pay-method-btn").on("click", (e) => {
			$view.find(".efs-pay-method-btn").removeClass("efs-pay-method-active");
			$(e.currentTarget).addClass("efs-pay-method-active");
			this.paymentState.method = $(e.currentTarget).data("method");
			this.paymentState.reference = "";
			$view.find("#efs-pay-reference").val("");

			const isCredito = this.paymentState.method === "Crédito";
			const isContraEntrega = this.paymentState.method === "Contra Entrega";
			const isEfectivo = this.paymentState.method === "Efectivo";
			const isOther = !isCredito && !isContraEntrega && !isEfectivo;
			$view.find("#efs-pay-cash").toggle(isEfectivo);
			$view.find("#efs-pay-amount-row").toggle(isOther);
			$view.find("#efs-pay-reference-row").toggle(isOther);
			$view.find("#efs-pay-credito-note").toggle(isCredito);
			$view.find("#efs-pay-contra-entrega-note").toggle(isContraEntrega);
			$view.find("#efs-btn-guias-transporte").toggle(isContraEntrega);
			$view.find("#efs-pay-add-split, #efs-pay-splits").toggle(!isCredito && !isContraEntrega);
			if (isCredito || isContraEntrega) {
				this.paymentState.payments = [];
				$view.find("#efs-pay-splits").empty();
			}
			if (isContraEntrega) {
				this._update_guias_transporte_button();
			}
			if (isOther) {
				const splitsTotal = (this.paymentState.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
				const remaining = Math.max(0, this.paymentState.total - splitsTotal);
				this.paymentState.primaryAmount = remaining.toFixed(2);
				$view.find("#efs-pay-amount").val(this.paymentState.primaryAmount);
			}
			this._update_change_display();
		});

		$view.find(".efs-quick-cash-btn[data-amt]").on("click", (e) => {
			this.paymentState.tendered = String($(e.currentTarget).data("amt"));
			$view.find("#efs-pay-numpad .efs-numpad-display").text(this.paymentState.tendered);
			this._update_change_display();
		});
		$view.find("#efs-pay-exact").on("click", () => {
			this.paymentState.tendered = String(total.toFixed(2));
			$view.find("#efs-pay-numpad .efs-numpad-display").text(this.paymentState.tendered);
			this._update_change_display();
		});

		$view.find("#efs-pay-add-split").on("click", () => this._add_split_row());
		$view.find("#efs-btn-guias-transporte").on("click", () => this._open_payment_guias_dialog());
		$view.find("#efs-pay-confirm").on("click", () => this._confirm_payment());

		this._update_change_display();
	}

	// Recalcula cuánto se aplica con el método activo (efectivo o no) y refresca
	// el resumen de pago. Efectivo puede generar cambio (exceso físico a
	// devolver); los demás métodos se limitan a lo pendiente — no tiene sentido
	// "cambio" en tarjeta/transferencia/cheque, así que se recorta con aviso.
	_update_change_display() {
		const $view = this.$body.find("#efs-payment-view");
		const st = this.paymentState;

		if (st.method === "Crédito" || st.method === "Contra Entrega") {
			this.paymentState.currentAmount = 0;
			this.paymentState.changeDue = 0;
			$view.find("#efs-pay-primary-covered").hide();
			this._render_pay_summary();
			return;
		}

		const splitsTotal = (st.payments || []).reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
		const remaining = Math.max(0, st.total - splitsTotal);
		const isEfectivo = st.method === "Efectivo";
		const isOther = !isEfectivo;

		// Si los métodos agregados abajo ("+ Agregar otro método de pago") ya
		// cubren el total, la sección de arriba deja de pedir nada — evita el
		// conflicto de que siga solicitando monto/referencia "global" cuando
		// el cobro ya se resolvió a detalle en los splits.
		const covered = remaining <= 0.004;
		$view.find("#efs-pay-primary-covered").toggle(covered);
		$view.find("#efs-pay-cash").toggle(isEfectivo && !covered);
		$view.find("#efs-pay-amount-row").toggle(isOther && !covered);
		$view.find("#efs-pay-reference-row").toggle(isOther && !covered);

		if (covered) {
			this.paymentState.currentAmount = 0;
			this.paymentState.changeDue = 0;
		} else if (isEfectivo) {
			const tendered = parseFloat(st.tendered) || 0;
			this.paymentState.currentAmount = Math.min(tendered, remaining);
			this.paymentState.changeDue = Math.max(0, tendered - remaining);
			$view.find("#efs-pay-change").html(
				`Recibido: Q ${_efs_fmt(tendered)} &nbsp;|&nbsp; Cambio: <strong>Q ${_efs_fmt(this.paymentState.changeDue)}</strong>`
			);
		} else {
			const typed = parseFloat(st.primaryAmount);
			const amt = isNaN(typed) ? remaining : Math.max(0, typed);
			if (amt > remaining + 0.004) {
				this.paymentState.primaryAmount = remaining.toFixed(2);
				$view.find("#efs-pay-amount").val(this.paymentState.primaryAmount);
				frappe.show_alert({ message: __("El monto no puede superar lo pendiente (Q {0}) para este método.", [_efs_fmt(remaining)]), indicator: "orange" });
			}
			this.paymentState.currentAmount = Math.min(amt, remaining);
			this.paymentState.changeDue = 0;
		}
		this._render_pay_summary();
	}

	// "Reiniciar pago": limpia montos, referencias y métodos adicionales sin
	// perder el borrador ya guardado — el cajero puede rearmar el cobro desde
	// cero si se equivocó, sin tener que salir a Productos y volver a entrar.
	_reset_payment() {
		const $view = this.$body.find("#efs-payment-view");
		this.paymentState.method = "Efectivo";
		this.paymentState.tendered = "";
		this.paymentState.primaryAmount = this.paymentState.total.toFixed(2);
		this.paymentState.reference = "";
		this.paymentState.payments = [];
		this.paymentState.guias = [];
		this.paymentState.guiasResolved = false;
		this.paymentState.guiasSkipped = false;
		$view.find(".efs-pay-method-btn").removeClass("efs-pay-method-active");
		$view.find(`.efs-pay-method-btn[data-method="Efectivo"]`).addClass("efs-pay-method-active");
		$view.find("#efs-pay-cash").show();
		$view.find("#efs-pay-amount-row, #efs-pay-reference-row, #efs-pay-credito-note, #efs-pay-contra-entrega-note, #efs-btn-guias-transporte").hide();
		$view.find("#efs-pay-add-split, #efs-pay-splits").show();
		$view.find("#efs-pay-splits").empty();
		$view.find("#efs-pay-reference").val("");
		$view.find("#efs-pay-amount").val("");
		$view.find("#efs-pay-numpad .efs-numpad-display").text("0");
		this._update_change_display();
		frappe.show_alert({ message: __("Pago reiniciado."), indicator: "blue" });
	}

	// Agrupa lo aplicado por forma de pago (splits + método activo) para el
	// resumen y para la validación de pago parcial/completo al confirmar.
	_compute_payment_totals() {
		const st = this.paymentState;
		const byMethod = {};
		(st.payments || []).forEach((p) => {
			byMethod[p.payment_method] = (byMethod[p.payment_method] || 0) + (parseFloat(p.amount) || 0);
		});
		if (st.method !== "Crédito" && st.currentAmount > 0) {
			byMethod[st.method] = (byMethod[st.method] || 0) + st.currentAmount;
		}
		const totalApplied = Object.values(byMethod).reduce((s, v) => s + v, 0);
		const pending = Math.max(0, st.total - totalApplied);
		return { byMethod, totalApplied, pending, change: st.changeDue || 0 };
	}

	_render_pay_summary() {
		const $sum = this.$body.find("#efs-pay-summary");
		const st = this.paymentState;

		if (st.method === "Crédito") {
			$sum.html(`
				<div class="efs-pay-summary-row efs-pay-summary-total"><span>Total</span><span>Q ${_efs_fmt(st.total)}</span></div>
				<div class="efs-pay-summary-note">Sin cobro inmediato — venta al crédito.</div>
			`);
			return;
		}

		if (st.method === "Contra Entrega") {
			const n = (st.guias || []).length;
			$sum.html(`
				<div class="efs-pay-summary-row efs-pay-summary-total"><span>Total</span><span>Q ${_efs_fmt(st.total)}</span></div>
				<div class="efs-pay-summary-note">Sin cobro inmediato — cobra el transportista al entregar.</div>
				<div class="efs-pay-summary-note">${n ? __("{0} guía(s) registrada(s).", [n]) : __("Sin guía registrada — puede completarse después.")}</div>
			`);
			return;
		}

		const { byMethod, totalApplied, pending, change } = this._compute_payment_totals();
		const methodRows = Object.entries(byMethod)
			.filter(([, amt]) => amt > 0.004)
			.map(([method, amt]) => `<div class="efs-pay-summary-method"><span>${_efs_esc(method)}</span><span>Q ${_efs_fmt(amt)}</span></div>`)
			.join("");

		$sum.html(`
			${methodRows}
			<div class="efs-pay-summary-row"><span>Total</span><span>Q ${_efs_fmt(st.total)}</span></div>
			<div class="efs-pay-summary-row efs-pay-summary-total"><span>Pagado</span><span>Q ${_efs_fmt(totalApplied)}</span></div>
			${pending > 0.004 ? `<div class="efs-pay-summary-row efs-pay-summary-pending"><span>Pendiente</span><span>Q ${_efs_fmt(pending)}</span></div>` : ""}
			${change > 0.004 ? `<div class="efs-pay-summary-row efs-pay-summary-change"><span>Cambio a entregar</span><span>Q ${_efs_fmt(change)}</span></div>` : ""}
		`);
	}

	_add_split_row() {
		const $splits = this.$body.find("#efs-pay-splits");
		const remaining = Math.max(0, this.paymentState.total - (this.paymentState.payments || []).reduce((s, p) => s + p.amount, 0));
		const idx = this.paymentState.payments.length;
		this.paymentState.payments.push({ payment_method: "Efectivo", amount: remaining, reference: "" });
		$splits.append(`
			<div class="efs-split-row" data-idx="${idx}">
				<select class="efs-split-method">
					${["Efectivo", "Tarjeta de Crédito", "Transferencia", "Cheque"].map((m) => `<option value="${_efs_esc(m)}">${_efs_esc(m)}</option>`).join("")}
				</select>
				<input type="number" class="efs-split-amount" value="${remaining.toFixed(2)}" min="0" step="any" />
				<input type="text" class="efs-split-reference" placeholder="Referencia…" style="display:none;" />
				<button class="efs-line-remove" data-idx="${idx}">×</button>
			</div>
		`);
		const $row = $splits.find(`.efs-split-row[data-idx="${idx}"]`);
		$row.find(".efs-split-method").on("change", (e) => {
			this.paymentState.payments[idx].payment_method = e.target.value;
			this.paymentState.payments[idx].reference = "";
			$row.find(".efs-split-reference").val("").toggle(e.target.value !== "Efectivo");
		});
		$row.find(".efs-split-amount").on("input", (e) => {
			this.paymentState.payments[idx].amount = parseFloat(e.target.value) || 0;
			this._update_change_display();
		});
		$row.find(".efs-split-reference").on("input", (e) => {
			this.paymentState.payments[idx].reference = e.target.value;
		});
		$row.find(".efs-line-remove").on("click", () => {
			this.paymentState.payments.splice(idx, 1);
			$row.remove();
			this._update_change_display();
		});
		this._update_change_display();
	}

	_ensure_submitted(callback) {
		// Idempotente: si ya se validó en un intento previo (p. ej. save_payments
		// falló después de un submit exitoso), no reintenta submit_invoice —
		// evita el error "Solo se puede validar una factura en estado Borrador."
		// La certificación FEL queda como acción manual aparte (botones en la
		// pantalla de confirmación), no se encadena automáticamente aquí.
		if (this.doc._submitted) {
			callback();
			return;
		}
		frappe.call({
			method: "facex_multi.api.invoice.submit_invoice",
			args: { name: this.doc.name },
			freeze: true,
			freeze_message: __("Validando factura…"),
			callback: () => {
				this.doc._submitted = true;
				callback();
			},
		});
	}

	_ensure_certified(callback) {
		// La validación (submit) y el envío a FEL son dos pasos separados en
		// ERPNext/brainfel — en FacEx Screen se encadenan automáticamente para
		// no exigir un paso manual extra en el flujo rápido de venta.
		if (this.doc._certified) {
			callback();
			return;
		}
		frappe.call({
			method: "facex_multi.api.invoice.certify_invoice",
			args: { name: this.doc.name },
			freeze: true,
			freeze_message: __("Enviando a FEL…"),
			callback: (r) => {
				this.doc._certified = !!(r.message && r.message.success);
				callback();
			},
			error: () => {
				this.doc._certified = false;
				frappe.show_alert({
					message: __("La venta se guardó pero no se pudo certificar en FEL. Puede reintentar desde la pantalla de confirmación."),
					indicator: "orange",
				}, 8);
				callback();
			},
		});
	}

	_confirm_payment() {
		const st = this.paymentState;

		// Venta al crédito: sin pago inmediato, solo certificar la factura.
		if (st.method === "Crédito") {
			this._lastPaymentsApplied = null;
			this._ensure_submitted(() => this._show_confirmation(0));
			return;
		}

		// Contra Entrega: sin pago inmediato — cobra el transportista al
		// entregar. Antes de continuar, exige haber pasado por el diálogo de
		// guías al menos una vez (llenarla o "Completar después" explícito) —
		// obligatorio abordarlo, pero no obligatorio llenarlo.
		if (st.method === "Contra Entrega") {
			if (!st.guiasResolved) {
				frappe.show_alert({ message: __("Registre la guía de envío o elija \"Completar después\" antes de confirmar."), indicator: "orange" }, 6);
				this._open_payment_guias_dialog();
				return;
			}
			this._lastPaymentsApplied = null;
			this._save_contra_entrega_then_submit(() => {
				this._refresh_pending_guias_count();
				this._show_confirmation(0);
			});
			return;
		}

		const payments = [...(st.payments || [])];
		if (st.currentAmount > 0) {
			payments.push({ payment_method: st.method, amount: st.currentAmount, reference: st.reference || "" });
		}
		const totalApplied = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
		if (totalApplied <= 0) {
			frappe.show_alert({ message: __("Ingrese un monto de pago válido."), indicator: "orange" });
			return;
		}
		const sinReferencia = payments.find((p) => p.payment_method !== "Efectivo" && !p.reference);
		if (sinReferencia) {
			frappe.show_alert({ message: __("Ingrese el número de referencia para {0}.", [sinReferencia.payment_method]), indicator: "orange" });
			return;
		}

		// Si no cuadra (queda parcial): bloquear si la compañía exige pago
		// completo, o pedir confirmación explícita antes de continuar.
		const pending = Math.max(0, st.total - totalApplied);
		if (pending > 0.004) {
			if ((this.company_config || {}).exige_pago_completo) {
				frappe.show_alert({
					message: __("Esta compañía exige el pago completo. Falta Q {0} por cobrar.", [_efs_fmt(pending)]),
					indicator: "red",
				}, 6);
				return;
			}
			frappe.confirm(
				__("El pago no cubre el total — falta Q {0} por cobrar. ¿Confirma continuar con un pago PARCIAL?", [_efs_fmt(pending)]),
				() => this._do_confirm_payment(payments)
			);
			return;
		}

		this._do_confirm_payment(payments);
	}

	_do_confirm_payment(payments) {
		const st = this.paymentState;
		// Se guarda el desglose tal cual se aplicó — si más adelante se corrige
		// el cliente (pantalla de confirmación → "¿Actualizar Cliente para
		// Factura?"), se reaplica el mismo pago a la factura nueva sin pedirle
		// de nuevo al cajero que lo tipee.
		this._lastPaymentsApplied = payments;
		// ERPNext exige que la factura esté presentada (submitted) antes de poder
		// referenciarla desde un Payment Entry — por eso se certifica primero.
		this._ensure_submitted(() => {
			frappe.call({
				method: "facex_multi.api.invoice.save_payments",
				args: {
					invoice_name: this.doc.name,
					payments_json: JSON.stringify(payments),
					pagado: 1,
				},
				freeze: true,
				freeze_message: __("Registrando pago…"),
				callback: () => {
					this._show_confirmation(st.changeDue || 0);
				},
			});
		});
	}

	// Persiste bfel_pago_contra_entrega + las guías capturadas (si las hay)
	// en el borrador antes de someterlo — save_draft no toca esos campos si
	// no vienen en el payload, así que hay que reenviarlos explícitamente
	// (a diferencia de Crédito, que no necesita guardar nada adicional).
	_save_contra_entrega_then_submit(callback) {
		const guias = (this.paymentState.guias || []).map((g) => ({
			transportista: g.transportista,
			numero_guia: g.numero_guia,
			piezas: parseInt(g.piezas) || 1,
			estado_entrega: "Pendiente",
			destino: g.destino || "",
			monto_cod: parseFloat(g.monto_cod) || 0,
		}));

		// Caso de reintento: la factura ya quedó sometida en un intento previo
		// (ver _proceed_to_payment) — save_draft ya no aplica (docstatus=1).
		// Se usa save_guias_transporte (allow_on_submit) para no perder las
		// guías capturadas en este intento en vez de descartarlas en silencio.
		if (this.doc._submitted) {
			if (!guias.length) {
				callback();
				return;
			}
			frappe.call({
				method: "facex_multi.api.invoice.save_guias_transporte",
				args: { invoice_name: this.doc.name, guias_json: JSON.stringify(guias) },
				freeze: true,
				freeze_message: __("Guardando envío…"),
				callback: () => callback(),
			});
			return;
		}

		const payload = this._build_save_payload();
		payload.bfel_pago_contra_entrega = 1;
		payload.bfel_guias_transportista = guias;
		frappe.call({
			method: "facex_multi.api.invoice.save_draft",
			args: { doc_json: JSON.stringify(payload) },
			freeze: true,
			freeze_message: __("Guardando envío…"),
			callback: () => this._ensure_submitted(callback),
		});
	}

	_update_guias_transporte_button() {
		const $btn = this.$body.find("#efs-btn-guias-transporte");
		const n = (this.paymentState.guias || []).length;
		$btn.text(n ? __("Envíos x Transporte ({0})", [n]) : __("Envíos x Transporte"));
		$btn.toggleClass("efs-pay-method-active", !!n);
	}

	// Abre el diálogo de guías atado al pago en curso (this.paymentState) —
	// usado por el botón "Envíos x Transporte" y por el aviso de
	// _confirm_payment cuando el cajero intenta confirmar sin resolverlo.
	_open_payment_guias_dialog() {
		const st = this.paymentState;
		this._show_guias_transporte_dialog({
			initialRows: st.guias.length ? st.guias : [{ monto_cod: st.total }],
			onSave: (rows) => {
				st.guias = rows;
				st.guiasResolved = true;
				st.guiasSkipped = false;
				this._update_guias_transporte_button();
				this._render_pay_summary();
			},
			onSkip: (rows) => {
				st.guias = rows;
				st.guiasResolved = true;
				st.guiasSkipped = true;
				this._update_guias_transporte_button();
				this._render_pay_summary();
			},
		});
	}

	// Dialog con filas dinámicas (transportista/guía/piezas/destino/monto COD),
	// igual patrón que los splits de pago. "Guardar Guías" exige transportista
	// + número de guía por fila; "Completar después" (si se pasa onSkip) cierra
	// sin exigir nada — el envío queda pendiente y se retoma desde "Envíos
	// Pendientes" (FacexTransporteModule tiene su propia versión simplificada
	// de este diálogo, sin onSkip, para ese flujo).
	//   initialRows: filas con las que arranca el diálogo.
	//   onSave(rows): filas completas y válidas.
	//   onSkip(rows): si se pasa, agrega el botón "Completar después" con las
	//     filas parciales tal como quedaron (pueden estar vacías).
	_show_guias_transporte_dialog({ initialRows = [], onSave, onSkip } = {}) {
		const openDialog = (transportistas) => {
			const options = transportistas.map((t) => `<option value="${_efs_esc(t.name)}">${_efs_esc(t.name)}</option>`).join("");
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
					if (!transportista && !numero_guia) return; // fila vacía, se ignora
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
				secondary_action_label: onSkip ? __("Completar después") : __("Cancelar"),
				secondary_action: () => {
					dlg.hide();
					if (onSkip) onSkip(collectRows().filter((r) => r.transportista && r.numero_guia));
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
	// Confirmación
	// -----------------------------------------------------------------------

	// `skipCustomerGate`: true cuando se vuelve a mostrar esta pantalla justo
	// después de corregir el cliente (_rebill_with_new_customer) o al recargar
	// una factura ya resuelta desde Historial — no tiene sentido volver a
	// preguntar, así que el botón de cliente queda bloqueado desde el inicio.
	// En el caso normal (false), arranca visible hasta que el cajero responda
	// "¿Actualizar Cliente para Factura?" (una sola vez por factura: al elegir
	// "Continuar con Cliente" queda bloqueado igual que skipCustomerGate).
	//
	// Certificar/Imprimir y Vista Previa/WhatsApp son dos candados separados:
	// Certificar FEL, Solo Imprimir y Nueva Venta solo requieren la decisión
	// de cliente resuelta; Vista Previa y WhatsApp además requieren haber
	// certificado o impreso la factura (en esta misma pantalla o antes —
	// isCertified/isPrintOnlyLocked se persisten en la factura vía
	// bfel_uuid/bfel_impreso_sin_certificar, así que sobreviven a salir y
	// volver a entrar desde Historial). Certificar y Solo Imprimir son
	// mutuamente excluyentes y la decisión, una vez tomada, ya no se ofrece
	// la otra opción — ni siquiera al recargar la factura después.
	_show_confirmation(changeDue, { skipCustomerGate = false } = {}) {
		this.$body.find("#efs-payment-view").hide();
		const $view = this.$body.find("#efs-confirm-view");
		const isCertified = !!(this.doc._certified || this.doc.bfel_uuid);
		const isPrintOnlyLocked = !!this.doc.bfel_impreso_sin_certificar;
		const alreadyProcessed = isCertified || isPrintOnlyLocked;
		const canCancel = !!(this.perms || {}).puede_anular_facturas;
		const canEditGuias = !!(this.perms || {}).puede_editar_guias_transporte;
		// Fuente de verdad: this.doc.bfel_guias_transportista (lo que ya está
		// guardado en la factura, incluyendo al recargarla desde Historial).
		// this.doc._confirmGuias ya no se usa para el conteo — quedaba en 0 al
		// reabrir una factura con guías ya capturadas en un clic previo.
		const guiasCount = (this.doc.bfel_guias_transportista || []).length;
		$view.html(`
			${canEditGuias ? `
				<button class="efs-fab-guia-transporte" id="efs-confirm-guias-transporte" ${skipCustomerGate ? "" : "disabled"} title="${__("Asociar Guía de Transporte")}">
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<rect x="1" y="3" width="15" height="13"></rect>
						<polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon>
						<circle cx="5.5" cy="18.5" r="2.5"></circle>
						<circle cx="18.5" cy="18.5" r="2.5"></circle>
					</svg>
					<span>${guiasCount ? __("Guía ({0})", [guiasCount]) : __("Guía de Transporte")}</span>
				</button>
			` : ""}
			<div class="efs-confirm">
				<div class="efs-confirm-icon">✓</div>
				<div class="efs-confirm-title">Venta completada</div>
				<div class="efs-confirm-invoice">${_efs_esc(this.doc.name)}</div>
				${changeDue > 0 ? `<div class="efs-confirm-change">Cambio a entregar: <strong>Q ${_efs_fmt(changeDue)}</strong></div>` : ""}
				${skipCustomerGate
					? `<div class="efs-confirm-customer-locked" id="efs-confirm-customer-locked">${__("Cargando cliente…")}</div>`
					: `<button class="efs-btn-secondary efs-confirm-update-customer" id="efs-confirm-update-customer">¿Actualizar Cliente para Factura?</button>`}
				${this._render_mini_ticket_html()}
				<div class="efs-confirm-actions efs-confirm-actions-grid">
					${isPrintOnlyLocked ? "" : `<button class="efs-btn-secondary efs-btn-green" id="efs-confirm-cert-print" ${skipCustomerGate ? "" : "disabled"}>Certificar FEL e Imprimir</button>`}
					${isCertified ? "" : `<button class="efs-btn-secondary efs-btn-yellow" id="efs-confirm-print-only" ${skipCustomerGate ? "" : "disabled"}>Solo Imprimir (sin certificar)</button>`}
					<button class="efs-btn-secondary" id="efs-confirm-preview" ${alreadyProcessed ? "" : "disabled"}>Vista Preliminar</button>
					<button class="efs-btn-secondary" id="efs-confirm-email" ${alreadyProcessed ? "" : "disabled"}>Enviar x WhatsApp</button>
					<button class="efs-btn-charge" id="efs-confirm-new" ${skipCustomerGate ? "" : "disabled"}>Nueva Venta</button>
				</div>
				${canCancel ? `
					<div class="efs-confirm-danger-zone">
						<button class="efs-btn-danger" id="efs-confirm-cancel" ${alreadyProcessed ? "" : "disabled"}>
							${isCertified ? "Anular Factura FEL" : "Cancelar Factura Interna"}
						</button>
					</div>
				` : ""}
			</div>
		`);
		$view.show();

		$view.find("#efs-confirm-cert-print").on("click", () => {
			this._ensure_certified(() => {
				this._print_invoice();
				if (this.doc._certified) {
					$view.find("#efs-confirm-print-only").remove();
					$view.find("#efs-confirm-preview, #efs-confirm-email, #efs-confirm-cancel").prop("disabled", false);
					if (canCancel) $view.find("#efs-confirm-cancel").text(__("Anular Factura FEL"));
				}
			});
		});
		$view.find("#efs-confirm-print-only").on("click", () => {
			frappe.confirm(
				__("Esta factura ya NO se podrá certificar en FEL si continúa solo con la impresión. ¿Desea continuar?"),
				() => {
					frappe.call({
						method: "facex_multi.api.invoice.mark_printed_without_cert",
						args: { name: this.doc.name },
						freeze: true,
						callback: () => {
							this.doc.bfel_impreso_sin_certificar = 1;
							this._open_local_print(true);
							$view.find("#efs-confirm-cert-print").remove();
							$view.find("#efs-confirm-preview, #efs-confirm-email, #efs-confirm-cancel").prop("disabled", false);
						},
					});
				}
			);
		});
		$view.find("#efs-confirm-preview").on("click", () => this._show_ticket_preview());
		$view.find("#efs-confirm-email").on("click", () => this._send_whatsapp());
		$view.find("#efs-confirm-new").on("click", () => this._new_sale());
		$view.find("#efs-confirm-cancel").on("click", () => this._show_cancel_invoice_dialog());
		$view.find("#efs-confirm-guias-transporte").on("click", () => this._open_confirm_guias_dialog($view));

		if (skipCustomerGate) {
			this._show_locked_customer_label($view);
		} else {
			$view.find("#efs-confirm-update-customer").on("click", () => this._show_update_customer_gate());
		}
	}

	// Botón opcional en la pantalla de confirmación (cualquier método de pago,
	// no solo Contra Entrega) para asociar una guía de transporte a la venta
	// recién completada — o revisar/completar las que ya tenía, al reabrir la
	// factura desde Historial. Primero muestra en modo lectura lo que YA está
	// guardado en this.doc.bfel_guias_transportista (antes esto se perdía: el
	// diálogo siempre arrancaba en blanco y no había forma de ver lo ya
	// capturado). "+ Agregar guía" sigue usando filas en blanco y
	// save_guias_transporte (que AGREGA, no reemplaza), así que las guías ya
	// existentes nunca se reenvían — evita duplicarlas.
	_open_confirm_guias_dialog($view) {
		const dlg = new frappe.ui.Dialog({
			title: __("Guía de Transporte — {0}", [this.doc.name]),
			fields: [{ fieldname: "html", fieldtype: "HTML" }],
		});

		const renderExisting = () => {
			const rows = this.doc.bfel_guias_transportista || [];
			dlg.fields_dict.html.$wrapper.html(`
				${rows.length ? `
					<table class="efs-stock-table">
						<thead><tr><th>${__("Transportista")}</th><th>${__("Guía")}</th><th>${__("Piezas")}</th><th>${__("Destino")}</th><th>${__("Monto COD")}</th><th>${__("Estado")}</th></tr></thead>
						<tbody>
							${rows.map((r) => `
								<tr>
									<td>${_efs_esc(r.transportista || "")}</td>
									<td>${_efs_esc(r.numero_guia || "")}</td>
									<td>${r.piezas || 0}</td>
									<td>${_efs_esc(r.destino || "")}</td>
									<td>Q ${_efs_fmt(r.monto_cod)}</td>
									<td>${_efs_esc(r.estado_entrega || "")}</td>
								</tr>
							`).join("")}
						</tbody>
					</table>
				` : `<div class="efs-cust-details-loading">${__("Todavía no tiene guías registradas.")}</div>`}
				<button type="button" class="efs-btn-link" id="efs-confirm-guia-add-more" style="margin-top:10px;">${__("+ Agregar guía")}</button>
			`);
			dlg.$wrapper.find("#efs-confirm-guia-add-more").on("click", () => {
				dlg.hide();
				this._show_guias_transporte_dialog({
					initialRows: [{}],
					onSave: (newRows) => {
						frappe.call({
							method: "facex_multi.api.invoice.save_guias_transporte",
							args: { invoice_name: this.doc.name, guias_json: JSON.stringify(newRows) },
							freeze: true,
							freeze_message: __("Guardando guía…"),
							callback: (r) => {
								this.doc.bfel_guias_transportista = (r.message && r.message.bfel_guias_transportista) || this.doc.bfel_guias_transportista;
								frappe.show_alert({ message: __("Guía registrada para {0}.", [this.doc.name]), indicator: "green" });
								$view.find("#efs-confirm-guias-transporte span").text(__("Guía ({0})", [(this.doc.bfel_guias_transportista || []).length]));
							},
						});
					},
				});
			});
		};

		renderExisting();
		dlg.show();
	}

	// "Anular Factura FEL" (certificada: primero ante la SAT, delega 100% a
	// brainfel.cancel_sales_invoice_fel, y solo si eso funciona cancela en
	// ERPNext) o "Cancelar Factura Interna" (no certificada: cancelación
	// directa en ERPNext). Gated por permiso puede_anular_facturas.
	_show_cancel_invoice_dialog() {
		// Se recalcula aquí (no se recibe como parámetro) para reflejar el
		// estado real del doc al momento del clic — si se certificó en esta
		// misma pantalla justo antes, this.doc._certified ya lo refleja aunque
		// el botón se haya renderizado inicialmente sin certificar.
		const isCertified = !!(this.doc._certified || this.doc.bfel_uuid);
		const doCancel = (motivo) => {
			const method = isCertified
				? "facex_multi.api.invoice.cancel_certified_invoice_fel"
				: "facex_multi.api.invoice.cancel_invoice";
			const args = isCertified ? { name: this.doc.name, motivo_anulacion: motivo } : { name: this.doc.name };
			frappe.call({
				method,
				args,
				freeze: true,
				freeze_message: __("Anulando factura…"),
				callback: () => {
					frappe.show_alert({
						message: __("Factura {0} anulada correctamente.", [this.doc.name]),
						indicator: "green",
					}, 6);
					this._new_sale();
				},
			});
		};

		if (isCertified) {
			const dlg = new frappe.ui.Dialog({
				title: __("Anular Factura FEL"),
				fields: [
					{
						fieldtype: "Small Text",
						fieldname: "motivo_anulacion",
						label: __("Motivo de anulación FEL"),
						reqd: 1,
					},
				],
				primary_action_label: __("Anular ante la SAT"),
				primary_action: (values) => {
					if (!values.motivo_anulacion) {
						frappe.msgprint(__("El motivo de anulación es obligatorio."));
						return;
					}
					dlg.hide();
					frappe.confirm(
						__("Esta acción es irreversible: se anulará el documento ante la SAT y se revertirá la contabilidad/inventario en ERPNext. ¿Confirma continuar?"),
						() => doCancel(values.motivo_anulacion)
					);
				},
			});
			dlg.show();
		} else {
			frappe.confirm(
				__("¿Confirma cancelar internamente la factura {0}? Esta acción revertirá la contabilidad/inventario en ERPNext y no se puede deshacer.", [this.doc.name]),
				() => doCancel()
			);
		}
	}

	// El cliente ya quedó resuelto para esta venta (se confirmó o se corrigió
	// una vez) — se reemplaza el botón de pregunta por una etiqueta fija, para
	// que ya no se pueda volver a abrir el diálogo de cambio de cliente.
	_show_locked_customer_label($view) {
		frappe.call({
			method: "facex_multi.api.customer.get_customer",
			args: { name: this.doc.customer, company: this.doc.company },
			callback: (r) => {
				const cd = r.message || {};
				const idStr = [cd.bfel_identificacion, cd.bfel_id_receptor].filter(Boolean).join(" ");
				const label = this.doc.customer_name || this.doc.customer;
				const text = idStr ? __("Cliente: {0} — {1}", [label, idStr]) : __("Cliente: {0}", [label]);
				let $locked = $view.find("#efs-confirm-customer-locked");
				if (!$locked.length) {
					$locked = $(`<div class="efs-confirm-customer-locked" id="efs-confirm-customer-locked"></div>`);
					$view.find("#efs-confirm-update-customer").replaceWith($locked);
				}
				$locked.text(text);
			},
		});
	}

	// Mini-ticket compacto embebido directo en la pantalla de confirmación,
	// para que el cajero vea un resumen clave (cliente, productos, total,
	// forma de pago) sin tener que abrir Vista Preliminar.
	_render_mini_ticket_html() {
		const items = this.doc.items || [];
		const payments = this._lastPaymentsApplied || [];
		const rows = items.map((it) => `
			<div class="efs-mini-ticket-row">
				<span class="efs-mini-ticket-qty">${_efs_esc(it.qty)}×</span>
				<span class="efs-mini-ticket-name">${_efs_esc(it.item_name)}</span>
				<span class="efs-mini-ticket-amt">Q ${_efs_fmt(it.amount)}</span>
			</div>
		`).join("");
		const payRows = payments.length
			? payments.map((p) => `
				<div class="efs-mini-ticket-row efs-mini-ticket-pay">
					<span>${_efs_esc(p.payment_method)}</span>
					<span class="efs-mini-ticket-amt">Q ${_efs_fmt(p.amount)}</span>
				</div>
			`).join("")
			: `<div class="efs-mini-ticket-row efs-mini-ticket-pay"><span>${__("Crédito — sin pago inmediato")}</span></div>`;

		return `
			<div class="efs-mini-ticket">
				<div class="efs-mini-ticket-head">
					<span>${_efs_esc(this.doc.customer_name || this.doc.customer || "")}</span>
					<span>${_efs_esc(this.doc.posting_date || "")}</span>
				</div>
				<div class="efs-mini-ticket-items">${rows}</div>
				<div class="efs-mini-ticket-row efs-mini-ticket-total">
					<span>TOTAL</span>
					<span>Q ${_efs_fmt(this.doc.grand_total)}</span>
				</div>
				<div class="efs-mini-ticket-payhead">${__("Forma(s) de pago")}</div>
				${payRows}
			</div>
		`;
	}

	// -----------------------------------------------------------------------
	// Corregir cliente al final de la venta (pantalla Venta Completada)
	// -----------------------------------------------------------------------

	_show_update_customer_gate() {
		const $view = this.$body.find("#efs-confirm-view");
		frappe.call({
			method: "facex_multi.api.customer.get_customer",
			args: { name: this.doc.customer, company: this.doc.company },
			freeze: true,
			callback: (r) => {
				const cd = r.message || {};
				const direccion = [cd.direccion, cd.departamento].filter(Boolean).join(", ");
				const dlg = new frappe.ui.Dialog({
					title: __("¿Actualizar datos-cliente de facturación?"),
					primary_action_label: __("Continuar con Cliente"),
					primary_action: () => {
						dlg.hide();
						$view.find("#efs-confirm-cert-print, #efs-confirm-print-only, #efs-confirm-new").prop("disabled", false);
						this._show_locked_customer_label($view);
					},
				});
				dlg.$body.html(`
					<div class="efs-cust-details">
						<div class="efs-cust-detail-row"><label>Cliente</label><span>${_efs_esc(this.doc.customer_name || this.doc.customer)}</span></div>
						<div class="efs-cust-detail-row"><label>Identificación</label><span>${_efs_esc(cd.bfel_identificacion || "—")} ${_efs_esc(cd.bfel_id_receptor || "")}</span></div>
						<div class="efs-cust-detail-row"><label>Dirección</label><span>${_efs_esc(direccion || "—")}</span></div>
					</div>
					<p style="margin-top:14px;">${__("¿Desea actualizar los datos de facturación de esta venta a otro cliente?")}</p>
				`);
				// El footer del Dialog arranca oculto (class="modal-footer hide")
				// hasta que se configura una acción — set_secondary_action_label +
				// set_secondary_action son el mecanismo correcto para el botón
				// secundario (agregar un <button> a mano al footer no lo muestra).
				dlg.set_secondary_action_label(__("Modificar a Cliente"));
				dlg.set_secondary_action(() => {
					dlg.hide();
					this._show_customer_picker((name, label) => this._rebill_with_new_customer(name, label));
				});
				dlg.show();
			},
		});
	}

	_rebill_with_new_customer(newCustomer, newCustomerLabel) {
		frappe.call({
			method: "facex_multi.api.invoice.rebill_with_new_customer",
			args: {
				invoice_name: this.doc.name,
				new_customer: newCustomer,
				payments_json: this._lastPaymentsApplied ? JSON.stringify(this._lastPaymentsApplied) : null,
			},
			freeze: true,
			freeze_message: __("Actualizando cliente y regenerando factura…"),
			callback: (r) => {
				const result = r.message || {};
				this.doc = result.new_invoice;
				this._lastSavedInvoice = result.new_invoice;

				if (result.original_was_certified) {
					frappe.msgprint({
						title: __("Factura original conservada"),
						indicator: "orange",
						message: __(
							"La factura original ya estaba certificada en FEL (documento fiscal real ante la SAT) y no se eliminó. " +
							"Ahora existen dos facturas para esta venta: la original (certificada, cliente anterior) y {0} (cliente actualizado: {1}). " +
							"Si necesita anular la original, use el proceso formal de Nota de Crédito.",
							[_efs_esc(result.new_invoice.name), _efs_esc(newCustomerLabel)]
						),
					});
				} else {
					frappe.show_alert({
						message: __("Cliente actualizado. Factura anterior reemplazada por {0}.", [result.new_invoice.name]),
						indicator: "blue",
					}, 6);
				}

				this._show_confirmation(0, { skipCustomerGate: true });
			},
		});
	}

	_resolve_print_format(callback) {
		frappe.call({
			method: "facex_multi.api.invoice.get_print_formats",
			args: { company: this.doc.company },
			callback: (r) => {
				const formats = r.message || [];
				const fmt = formats.find((f) => f.toUpperCase().includes("CERTIFI"))
					|| formats.find((f) => f.toUpperCase().includes("FEL"))
					|| formats[0] || "";
				callback(fmt);
			},
		});
	}

	_open_local_print(triggerPrint) {
		this._resolve_print_format((fmt) => {
			let url = `/printview?doctype=Sales+Invoice&name=${encodeURIComponent(this.doc.name)}`;
			if (triggerPrint) url += "&trigger_print=1";
			if (fmt) url += `&format=${encodeURIComponent(fmt)}`;
			window.open(url, "_blank");
		});
	}

	// "Vista Preliminar" usa específicamente el formato "Recibo Ticket FacEx"
	// (cliente, fecha, detalle de productos y formas de pago) en vez del
	// formato fiscal CERTIFI/FEL que resuelve _resolve_print_format — ese
	// sigue reservado para "Certificar FEL e Imprimir"/"Solo Imprimir", que sí
	// necesitan el documento tributario oficial. Si por alguna razón el
	// formato ticket no existe para la compañía, cae al mismo criterio de
	// siempre en vez de fallar.
	_show_ticket_preview() {
		frappe.call({
			method: "facex_multi.api.invoice.get_print_formats",
			args: { company: this.doc.company },
			callback: (r) => {
				const formats = r.message || [];
				const fmt = formats.find((f) => f.toUpperCase().includes("TICKET"));
				if (fmt) {
					const url = `/printview?doctype=Sales+Invoice&name=${encodeURIComponent(this.doc.name)}&format=${encodeURIComponent(fmt)}`;
					window.open(url, "_blank");
				} else {
					this._open_local_print(false);
				}
			},
		});
	}

	// -----------------------------------------------------------------------
	// Venta en espera (suspender / retomar)
	// -----------------------------------------------------------------------

	_suspend_sale() {
		if (!(this.doc.items || []).length) return;
		frappe.call({
			method: "facex_multi.api.invoice.save_draft",
			args: { doc_json: JSON.stringify(this._build_save_payload({ suspend: true })) },
			freeze: true,
			freeze_message: __("Guardando venta en espera…"),
			callback: (r) => {
				if (!r.message) return;
				frappe.show_alert({ message: __("Venta guardada en espera: {0}", [r.message.name]), indicator: "blue" }, 5);
				this._new_sale();
				this._refresh_held_count();
			},
		});
	}

	_refresh_held_count() {
		frappe.call({
			method: "facex_multi.api.invoice.get_held_sales",
			args: { company: this.doc.company },
			callback: (r) => {
				this.heldCount = (r.message || []).length;
				this._set_badge("efs-held-badge", this.heldCount);
				this._set_badge("efs-menu-group-badge-ventas", this.heldCount);
				this._update_menu_total_badge();
			},
		});
	}

	_show_held_view() {
		const $view = this.$body.find("#efs-held-view");
		$view.html(`
			<div class="efs-wizard efs-history-wizard">
				<div class="efs-wizard-header">
					<button class="efs-step-nav" id="efs-held-back">← Volver</button>
					<div class="efs-wizard-title">Ventas en Espera</div>
				</div>
				<div class="efs-history-filters">
					<div class="efs-field-row">
						<label>Desde</label>
						<input type="date" id="efs-held-from" class="efs-cust-detail-input" />
					</div>
					<div class="efs-field-row">
						<label>Hasta</label>
						<input type="date" id="efs-held-to" class="efs-cust-detail-input" />
					</div>
					<div class="efs-field-row">
						<label>Vendedor</label>
						<select id="efs-held-vendedor" class="efs-cust-detail-input">
							<option value="">-- Todos --</option>
						</select>
					</div>
					<div class="efs-field-row">
						<label>Usuario Creador</label>
						<select id="efs-held-owner" class="efs-cust-detail-input">
							<option value="">-- Todos --</option>
						</select>
					</div>
					<button class="efs-step-nav" id="efs-held-clear">Limpiar filtros</button>
				</div>
				<div class="efs-history-results" id="efs-held-results">
					<div class="efs-cust-details-loading">Cargando…</div>
				</div>
			</div>
		`);
		$view.show();
		$view.find("#efs-held-back").on("click", () => $view.hide());

		const applyFilters = () => this._render_held_results();
		$view.find("#efs-held-from, #efs-held-to, #efs-held-vendedor, #efs-held-owner").on("change", applyFilters);
		$view.find("#efs-held-clear").on("click", () => {
			$view.find("#efs-held-from, #efs-held-to").val("");
			$view.find("#efs-held-vendedor, #efs-held-owner").val("");
			applyFilters();
		});

		frappe.call({
			method: "facex_multi.api.invoice.get_held_sales",
			args: { company: this.doc.company },
			callback: (r) => {
				this._heldSalesRaw = r.message || [];

				// Opciones de los filtros se derivan de los datos ya cargados
				// (no hace falta un endpoint aparte para listar vendedores/usuarios).
				const vendedores = [...new Set(this._heldSalesRaw.map((r) => r.sales_partner).filter(Boolean))];
				const owners = [...new Map(this._heldSalesRaw.filter((r) => r.owner).map((r) => [r.owner, r.owner_fullname || r.owner])).entries()];
				$view.find("#efs-held-vendedor").append(vendedores.map((v) => `<option value="${_efs_esc(v)}">${_efs_esc(v)}</option>`).join(""));
				$view.find("#efs-held-owner").append(owners.map(([email, label]) => `<option value="${_efs_esc(email)}">${_efs_esc(label)}</option>`).join(""));

				this._render_held_results();
			},
		});
	}

	_render_held_results() {
		const $view = this.$body.find("#efs-held-view");
		const $results = this.$body.find("#efs-held-results");
		const rows = this._heldSalesRaw || [];

		const from = $view.find("#efs-held-from").val();
		const to = $view.find("#efs-held-to").val();
		const vendedor = $view.find("#efs-held-vendedor").val();
		const owner = $view.find("#efs-held-owner").val();

		const filtered = rows.filter((row) => {
			if (from && row.posting_date < from) return false;
			if (to && row.posting_date > to) return false;
			if (vendedor && row.sales_partner !== vendedor) return false;
			if (owner && row.owner !== owner) return false;
			return true;
		});

		if (!filtered.length) {
			$results.html('<div class="efs-cust-details-loading">No hay ventas en espera con estos filtros.</div>');
			return;
		}

		const canDelete = !!(this.perms || {}).puede_eliminar_ventas_espera;
		$results.html(`
			<table class="efs-stock-table">
				<thead><tr><th>Factura</th><th>Cliente</th><th>Fecha</th><th>Vendedor</th><th>Creado por</th><th>Total</th><th></th>${canDelete ? "<th></th>" : ""}</tr></thead>
				<tbody>
					${filtered.map((row) => `
						<tr class="efs-hist-row" data-name="${_efs_esc(row.name)}">
							<td>${_efs_esc(row.name)}</td>
							<td>${_efs_esc(row.customer_name || "")}</td>
							<td>${_efs_esc(row.posting_date)}</td>
							<td>${_efs_esc(row.sales_partner || "—")}</td>
							<td>${_efs_esc(row.owner_fullname || row.owner || "—")}</td>
							<td>Q ${_efs_fmt(row.grand_total)}</td>
							<td>Retomar →</td>
							${canDelete ? `<td><button class="efs-line-remove efs-held-delete" data-name="${_efs_esc(row.name)}" title="Eliminar definitivamente">×</button></td>` : ""}
						</tr>
					`).join("")}
				</tbody>
			</table>
		`);
		$results.find(".efs-hist-row").on("click", (e) => {
			const name = $(e.currentTarget).data("name");
			this.$body.find("#efs-held-view").hide();
			this._resume_held_sale(name);
		});
		$results.find(".efs-held-delete").on("click", (e) => {
			e.stopPropagation();
			const name = $(e.currentTarget).data("name");
			frappe.confirm(
				__("¿Eliminar definitivamente la venta en espera {0}? Esta acción no se puede deshacer.", [name]),
				() => {
					frappe.call({
						method: "facex_multi.api.invoice.delete_held_sale",
						args: { name },
						freeze: true,
						freeze_message: __("Eliminando…"),
						callback: () => {
							frappe.show_alert({ message: __("Venta en espera eliminada."), indicator: "blue" });
							this._heldSalesRaw = (this._heldSalesRaw || []).filter((r) => r.name !== name);
							this._render_held_results();
							this._refresh_held_count();
						},
					});
				}
			);
		});
	}

	// -----------------------------------------------------------------------
	// Módulo Transporte del menú principal — toda la lógica (hub, Maestros,
	// Documentos, Reportes, KPIs) vive en FacexTransporteModule
	// (public/js/facex_transporte_module.js), compartida con FacEx Clásico.
	// Aquí solo se monta dentro del overlay de la página y se conecta el
	// permiso/compañía activos; ver _has_transporte_access en
	// _get_menu_modules para el gate del punto de entrada del menú.
	// -----------------------------------------------------------------------

	_transporte_module() {
		if (!this._transporteModuleInstance) {
			this._transporteModuleInstance = new FacexTransporteModule({
				$container: this.$body.find("#efs-transporte-view"),
				perms: this.perms,
				company: this.doc.company,
				onBack: () => this.$body.find("#efs-transporte-view").hide(),
			});
		} else {
			this._transporteModuleInstance.setContext({ perms: this.perms, company: this.doc.company });
		}
		return this._transporteModuleInstance;
	}

	// Hub de Transporte: única pantalla a la que lleva el menú principal
	// (un click). Vive en FacexTransporteModule#showHub — aquí solo se
	// muestra el overlay que lo contiene y se le delega el render.
	_show_transporte_hub() {
		this.$body.find("#efs-transporte-view").show();
		this._transporte_module().showHub();
	}

	// Badges de Envíos Pendientes fuera del módulo (menú principal, tarjeta
	// de Inicio) — el badge dentro del hub del módulo se resuelve solo, ver
	// FacexTransporteModule#showHub.
	_refresh_pending_guias_count() {
		frappe.call({
			method: "facex_multi.api.invoice.get_pending_guias",
			args: { company: this.doc.company },
			callback: (r) => {
				this.pendingGuiasCount = (r.message || []).length;
				this._set_badge("efs-transporte-menu-badge", this.pendingGuiasCount);
				this._set_badge("efs-home-badge-transporte", this.pendingGuiasCount);
				this._update_menu_total_badge();
			},
		});
	}

	_resume_held_sale(name) {
		const doResume = () => {
			frappe.call({
				method: "facex_multi.api.invoice.get_invoice",
				args: { name },
				freeze: true,
				freeze_message: __("Cargando venta…"),
				callback: (r) => {
					if (!r.message) return;
					this.doc = r.message;
					// Los marcadores _has_serial_no/_custom_tiene_adenda/_item_group son
					// transitorios (nunca se persisten en BD) — se restauran cruzando el
					// catálogo ya cargado en memoria por item_code. Los datos reales de
					// serie/adenda (serial_no, tiene_adenda, color, etc.) ya vienen
					// completos desde la BD, no hay que tocarlos.
					(this.doc.items || []).forEach((row) => {
						const match = this.allItems.find((it) => it.item_code === row.item_code);
						row._has_serial_no = match ? match.has_serial_no : 0;
						row._custom_tiene_adenda = match ? match.custom_tiene_adenda : 0;
						row._item_group = match ? match.item_group : "";
					});

					// ERPNext fuerza posting_date a la fecha de hoy en cada guardado
					// (esta app no marca "set_posting_time"), así que una venta en
					// espera de días atrás quedaría con due_date < posting_date en el
					// próximo save_draft/submit sin que el cajero toque nada — mismo
					// error validado en pruebas de backend. Se adelanta aquí: se
					// actualiza la fecha de emisión a hoy al retomar y se recalcula
					// la fecha de vencimiento (por plantilla de pago o igualada a
					// hoy), dejando ambos campos editables por si se quiere otra fecha.
					const wasStale = this.doc.posting_date && this.doc.posting_date !== frappe.datetime.get_today();
					this.doc.posting_date = frappe.datetime.get_today();

					this.customerDetails = null;
					this._render_customer_bar();
					this._render_step_encabezado();
					this._render_cart();
					this._render_grid();
					this._show_step(2);
					this._refresh_held_count();

					if (this.doc.payment_terms_template) {
						this._on_payment_terms_change(this.doc.payment_terms_template);
					} else if (!this.doc.due_date || this.doc.due_date < this.doc.posting_date) {
						this.doc.due_date = this.doc.posting_date;
						this.$body.find("#efs-fld-due-date").val(this.doc.due_date);
					}
					if (wasStale) {
						frappe.show_alert({ message: __("Fecha de emisión actualizada a hoy."), indicator: "blue" }, 4);
					}
				},
			});
		};

		if ((this.doc.items || []).length && this.doc.name !== name) {
			frappe.confirm(
				__("Ya tiene una venta en curso en esta pantalla. ¿Descartarla y retomar la venta en espera?"),
				doResume
			);
		} else {
			doResume();
		}
	}

	// -----------------------------------------------------------------------
	// Historial de facturas
	// -----------------------------------------------------------------------

	_show_history_view() {
		const $view = this.$body.find("#efs-history-view");
		const todayStr = frappe.datetime.get_today();
		const monthStart = `${todayStr.slice(0, 8)}01`;
		this.historyRange = this.historyRange || { from: monthStart, to: todayStr };

		$view.html(`
			<div class="efs-wizard efs-history-wizard">
				<div class="efs-wizard-header">
					<button class="efs-step-nav" id="efs-history-back">← Volver</button>
					<div class="efs-wizard-title">Historial de Facturas</div>
				</div>
				<div class="efs-history-filters">
					<div class="efs-field-row">
						<label>Desde</label>
						<input type="date" id="efs-hist-from" class="efs-cust-detail-input" value="${_efs_esc(this.historyRange.from)}" />
					</div>
					<div class="efs-field-row">
						<label>Hasta</label>
						<input type="date" id="efs-hist-to" class="efs-cust-detail-input" value="${_efs_esc(this.historyRange.to)}" />
					</div>
					<button class="efs-step-nav efs-step-nav-primary" id="efs-hist-search">Buscar</button>
				</div>
				<div class="efs-history-results" id="efs-history-results">
					<div class="efs-cust-details-loading">Cargando…</div>
				</div>
			</div>
		`);
		$view.show();

		$view.find("#efs-history-back").on("click", () => $view.hide());
		$view.find("#efs-hist-search").on("click", () => {
			this.historyRange.from = $view.find("#efs-hist-from").val() || monthStart;
			this.historyRange.to = $view.find("#efs-hist-to").val() || todayStr;
			this._load_history();
		});

		this._load_history();
	}

	_load_history() {
		const $view = this.$body.find("#efs-history-view");
		const $results = this.$body.find("#efs-history-results");
		$results.html('<div class="efs-cust-details-loading">Cargando…</div>');
		frappe.call({
			method: "facex_multi.api.invoice.get_invoice_history",
			args: {
				company: this.doc.company,
				from_date: this.historyRange.from,
				to_date: this.historyRange.to,
			},
			callback: (r) => {
				const rows = r.message || [];
				if (!rows.length) {
					$results.html('<div class="efs-cust-details-loading">Sin facturas en este rango.</div>');
					return;
				}
				const estadoLabel = (row) => {
					if (row.docstatus === 2) return "Cancelada";
					if (row.docstatus === 1) return row.bfel_uuid ? "Certificada" : "Validada";
					return "Borrador";
				};
				const truckIcon = (active, count) => `
					<span class="efs-hist-guia-icon ${active ? "efs-hist-guia-icon-active" : ""}" title="${active ? __("{0} guía(s) de transporte vinculada(s)", [count]) : __("Sin guía de transporte")}">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="1" y="3" width="15" height="13"></rect>
							<polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon>
							<circle cx="5.5" cy="18.5" r="2.5"></circle>
							<circle cx="18.5" cy="18.5" r="2.5"></circle>
						</svg>
					</span>
				`;
				const pagoIcon = (paid) => `
					<span class="efs-hist-pago-icon ${paid ? "efs-hist-pago-icon-active" : ""}" title="${paid ? __("Factura pagada — ver detalle de pago") : __("Aún no marcada como pagada")}">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
							<rect x="2" y="6" width="20" height="12" rx="2"></rect>
							<circle cx="12" cy="12" r="2.5"></circle>
							<line x1="6" y1="12" x2="6.01" y2="12"></line>
							<line x1="18" y1="12" x2="18.01" y2="12"></line>
						</svg>
					</span>
				`;
				$results.html(`
					<table class="efs-stock-table">
						<thead><tr><th>Factura</th><th>Cliente</th><th>Fecha</th><th>Total</th><th>Estado</th><th></th><th></th></tr></thead>
						<tbody>
							${rows.map((row) => `
								<tr class="efs-hist-row" data-name="${_efs_esc(row.name)}" data-docstatus="${_efs_esc(row.docstatus)}">
									<td>${_efs_esc(row.name)}</td>
									<td>${_efs_esc(row.customer_name || "")}</td>
									<td>${_efs_esc(row.posting_date)}</td>
									<td>Q ${_efs_fmt(row.grand_total)}</td>
									<td>${_efs_esc(estadoLabel(row))}</td>
									<td>${truckIcon(row.guias_count > 0, row.guias_count)}</td>
									<td class="efs-hist-pago-cell" data-name="${_efs_esc(row.name)}">${pagoIcon(!!row.custom_pagado)}</td>
								</tr>
							`).join("")}
						</tbody>
					</table>
				`);
				$results.find(".efs-hist-pago-cell").on("click", (e) => {
					e.stopPropagation();
					this._show_payment_detail_dialog($(e.currentTarget).data("name"));
				});
				$results.find(".efs-hist-row").on("click", (e) => {
					const name = $(e.currentTarget).data("name");
					const docstatus = parseInt($(e.currentTarget).data("docstatus"), 10);
					$view.hide();
					if (docstatus === 1) {
						// Validada (certificada o no) — se recarga tal como quedó
						// en FacEx Screen, en la misma pantalla de "Venta Completada"
						// (ticket, botones de certificar/imprimir/email) en vez de
						// mandar al cajero al formulario crudo de ERPNext.
						frappe.call({
							method: "facex_multi.api.invoice.get_invoice",
							args: { name },
							freeze: true,
							freeze_message: __("Cargando factura…"),
							callback: (r) => {
								if (!r.message) return;
								this.doc = r.message;
								this._lastSavedInvoice = r.message;
								this._show_confirmation(0, { skipCustomerGate: true });
							},
						});
					} else if (docstatus === 0) {
						// Borrador sin terminar — se retoma igual que una venta en
						// espera, para poder seguir editándola desde donde quedó.
						this._resume_held_sale(name);
					} else {
						// Cancelada: no hay acciones de FacEx Screen aplicables
						// (no se puede certificar/cobrar), se abre en ERPNext.
						window.open(`/app/sales-invoice/${encodeURIComponent(name)}`, "_blank");
					}
				});
			},
		});
	}

	// Icono de Pago del Historial — abre el detalle (custom_efast_payments)
	// de la factura clickeada, sin navegar fuera del Historial.
	_show_payment_detail_dialog(name) {
		frappe.call({
			method: "facex_multi.api.invoice.get_invoice_payment_detail",
			args: { name },
			freeze: true,
			freeze_message: __("Cargando pagos…"),
			callback: (r) => {
				const data = r.message || {};
				const invoice = data.invoice || {};
				const payments = data.payments || [];
				const dlg = new frappe.ui.Dialog({
					title: __("Detalle de Pago — {0}", [name]),
					fields: [{ fieldname: "html", fieldtype: "HTML" }],
				});
				const rowsHtml = payments.length
					? payments.map((p) => `
						<tr>
							<td>${_efs_esc(p.payment_method || "")}</td>
							<td>${_efs_esc(p.payment_date || "")}</td>
							<td>${_efs_esc(p.reference || "")}</td>
							<td>Q ${_efs_fmt(p.amount)}</td>
						</tr>
					`).join("")
					: `<tr><td colspan="4" class="efs-cust-details-loading">${__("Sin pagos registrados.")}</td></tr>`;
				dlg.fields_dict.html.$wrapper.html(`
					<div class="efs-pago-detail-summary">
						<span>${__("Total factura")}: <strong>Q ${_efs_fmt(invoice.grand_total)}</strong></span>
						<span>${__("Saldo pendiente")}: <strong>Q ${_efs_fmt(invoice.outstanding_amount)}</strong></span>
					</div>
					<table class="efs-stock-table">
						<thead><tr><th>Forma de Pago</th><th>Fecha</th><th>Referencia</th><th>Monto</th></tr></thead>
						<tbody>${rowsHtml}</tbody>
					</table>
				`);
				dlg.show();
			},
		});
	}

	_print_invoice() {
		const url = frappe.urllib.get_full_url(
			`/api/method/facex_multi.api.invoice.preview_fel_pdf?invoice_name=${encodeURIComponent(this.doc.name)}`
		);
		window.open(url, "_blank");
	}

	_send_whatsapp() {
		// this.doc.bfel_uuid solo viene poblado al recargar la factura desde
		// Historial — si se certificó en esta misma sesión, _ensure_certified
		// únicamente marca this.doc._certified (ver _show_confirmation).
		const isCertified = !!(this.doc._certified || this.doc.bfel_uuid);
		const dlg = new frappe.ui.Dialog({
			title: __("Enviar por WhatsApp"),
			fields: [
				{
					fieldtype: "Data",
					fieldname: "phone",
					label: __("Número de celular"),
					description: __("Incluya código de país si es distinto a Guatemala (502). Ej: 55123456"),
					reqd: 1,
				},
				...(isCertified ? [{
					fieldtype: "Check",
					fieldname: "include_sat_link",
					label: __("Incluir enlace de verificación SAT"),
					description: __("El mismo enlace que codifica el QR del documento oficial, para que el cliente pueda validarlo directo con la SAT."),
					default: 1,
				}] : []),
			],
			primary_action_label: __("Abrir WhatsApp"),
			primary_action: (values) => {
				let digits = (values.phone || "").replace(/\D/g, "");
				if (digits.length === 8) digits = `502${digits}`;
				if (!digits) {
					frappe.msgprint(__("Ingrese un número de celular válido."));
					return;
				}
				const total = format_currency(this.doc.grand_total, this.doc.currency);
				const buildAndOpen = (verifyUrl) => {
					let text =
						`Hola ${this.doc.customer_name || ""}, adjunto su comprobante de compra.\n` +
						`Factura: ${this.doc.name}\n` +
						`Fecha: ${this.doc.posting_date}\n` +
						`Total: ${total}`;
					if (verifyUrl) text += `\nVerificar documento en SAT: ${verifyUrl}`;
					const url = `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
					window.open(url, "_blank");
					dlg.hide();
				};
				if (isCertified && values.include_sat_link) {
					frappe.call({
						method: "facex_multi.api.invoice.get_fel_verification_url",
						args: { invoice_name: this.doc.name },
						freeze: true,
						callback: (r) => buildAndOpen(r.message || ""),
						error: () => buildAndOpen(""),
					});
				} else {
					buildAndOpen("");
				}
			},
		});
		dlg.show();
	}

	_new_sale() {
		this.doc = this._empty_doc();
		this.customerDetails = null;
		this._lastSavedInvoice = null;
		this.doc.company = this.defaults.company || "";
		this.doc.naming_series = (this.defaults.naming_series || [])[0] || "";
		this.doc.bfel_establecimiento = String(((this.defaults.establishments || [])[0] || {}).establecimiento_id || "");
		this.doc.taxes_and_charges = this.defaults.default_taxes_and_charges || "";
		this.doc.payment_terms_template = this.defaults.default_payment_terms_template || "";
		this.doc.sales_partner = this.defaults.default_sales_partner || "";
		if (this.walkinCustomer) {
			this.doc.customer = this.walkinCustomer.name;
			this.doc.customer_name = this.walkinCustomer.customer_name;
			if (!this.doc.sales_partner) {
				this.doc.sales_partner = this.walkinCustomer.default_sales_partner || "";
			}
		}
		this._render_customer_bar();
		this._render_cart();
		this._render_grid();
		this._render_step_encabezado();
		this.$body.find("#efs-confirm-view").hide();
		this.$body.find("#efs-payment-view").hide();
		this._show_step(1);
	}

	// -----------------------------------------------------------------------
	// Estilos
	// -----------------------------------------------------------------------

	_inject_styles() {
		if ($("#efs-styles").length) return;
		$("head").append(`
			<style id="efs-styles">
${EFS_CSS}
			</style>
		`);
	}
}

const EFS_CSS = `
:root {
  --efs-primary: #4361ee;
  --efs-success: #2dc653;
  --efs-danger: #e63946;
  --efs-bg: #f8f9fb;
  --efs-card: #ffffff;
  --efs-border: #e2e8f0;
  --efs-text: #1e293b;
  --efs-text-muted: #64748b;
  --efs-radius: 12px;
  --efs-shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
}

/* Modo Enfoque (pantalla completa) — oculta los marcos de ERPNext, igual que FacEx clásico.
   Es el único modo de esta pantalla (sin botón para alternarlo); el listener de
   frappe.router en on_page_load quita la clase del body al salir de la página. */
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
  display: none !important;
  width: 0 !important;
  min-width: 0 !important;
  max-width: 0 !important;
  margin: 0 !important;
  padding: 0 !important;
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
  width: 100% !important;
  max-width: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding-left: 0 !important;
  padding-right: 0 !important;
  display: block !important;
}

.efs-wrap {
  display: flex; flex-direction: column; height: 100vh;
  position: fixed; inset: 0; z-index: 90;
  background: var(--efs-bg); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--efs-text);
}

.efs-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 20px; background: var(--efs-card); border-bottom: 1px solid var(--efs-border);
}
.efs-header-left, .efs-header-right { display: flex; align-items: center; gap: 14px; }
.efs-logo { font-weight: 800; font-size: 18px; color: var(--efs-primary); }
.efs-company-badge { font-size: 12px; color: var(--efs-text-muted); background: #eef2ff; padding: 3px 10px; border-radius: 20px; }
.efs-btn-link { background: none; border: none; color: var(--efs-primary); cursor: pointer; font-size: 13px; text-decoration: none; }
.efs-customer-pill { display: flex; align-items: center; gap: 8px; font-size: 13px; background: #f1f5f9; padding: 5px 12px; border-radius: 20px; }
.efs-pill-missing { background: #fff7ed; color: #c2410c; }

.efs-main-menu { position: relative; display: flex; align-items: center; }
.efs-menu-trigger {
  display: inline-flex; align-items: center; gap: 7px; background: none; border: 1px solid var(--efs-border);
  color: var(--efs-text); cursor: pointer; font-size: 13px; font-weight: 600; padding: 7px 12px; border-radius: 8px;
}
.efs-menu-trigger:hover { background: #f1f5f9; }
.efs-menu-panel {
  position: absolute; top: 120%; left: 0; background: var(--efs-card); border: 1px solid var(--efs-border);
  box-shadow: var(--efs-shadow-lg, 0 10px 25px rgba(0,0,0,.15)); border-radius: 10px; padding: 6px;
  min-width: 260px; max-width: 90vw; max-height: calc(100vh - 80px); overflow-y: auto; z-index: 300;
}
.efs-menu-group + .efs-menu-group { border-top: 1px solid var(--efs-border); margin-top: 2px; padding-top: 2px; }
.efs-menu-group-header {
  width: 100%; display: flex; align-items: center; gap: 10px; background: none; border: none; cursor: pointer;
  padding: 10px 8px; border-radius: 6px; font-size: 13px; font-weight: 700; color: var(--efs-text); text-align: left;
}
.efs-menu-group-header:hover { background: #f1f5f9; }
.efs-menu-group-icon { display: inline-flex; color: var(--efs-primary); }
.efs-menu-group-label { flex: 1; }
.efs-menu-chevron { color: var(--efs-text-muted); transition: transform .15s; flex-shrink: 0; }
.efs-menu-group-open > .efs-menu-group-header .efs-menu-chevron { transform: rotate(180deg); }
.efs-menu-group-items { display: none; flex-direction: column; padding: 2px 4px 6px 30px; }
.efs-menu-group-open > .efs-menu-group-items { display: flex; }
.efs-menu-item {
  display: flex; align-items: center; gap: 8px; background: none; border: none; cursor: pointer;
  padding: 8px; border-radius: 6px; font-size: 13px; color: var(--efs-text); text-align: left;
}
.efs-menu-item:hover { background: #f1f5f9; }
.efs-menu-item-label { flex: 1; }

.efs-user-dropdown { position: relative; display: flex; align-items: center; }
.efs-user-btn {
  width: 32px; height: 32px; border-radius: 50%; background: #f1f5f9; border: 1px solid #cbd5e1;
  display: flex; align-items: center; justify-content: center; cursor: pointer; color: #475569;
}
.efs-user-btn:hover { background: #e2e8f0; }
.efs-user-menu {
  position: absolute; top: 120%; right: 0; background: var(--efs-card); border: 1px solid var(--efs-border);
  box-shadow: var(--efs-shadow-lg, 0 10px 25px rgba(0,0,0,.15)); border-radius: 10px; padding: 14px;
  min-width: 220px; max-width: 90vw; max-height: calc(100vh - 80px); overflow-y: auto; z-index: 300;
}
.efs-user-menu-label { font-size: 11px; text-transform: uppercase; letter-spacing: .5px; color: var(--efs-text-muted); margin-bottom: 4px; }
.efs-user-fullname { font-size: 14px; font-weight: 700; color: var(--efs-text); line-height: 1.2; }
.efs-user-email { font-size: 12px; color: var(--efs-text-muted); margin-bottom: 14px; word-break: break-all; }
.efs-company-select { width: 100%; margin-bottom: 8px; }
.efs-user-menu-btn { width: 100%; margin-bottom: 8px; }
.efs-user-menu-btn:last-child { margin-bottom: 0; }

.efs-home-view { flex: 1; display: flex; align-items: center; justify-content: center; overflow-y: auto; padding: 24px; }
.efs-home-wrap { width: 100%; max-width: 900px; }
.efs-home-brand { display: flex; justify-content: center; margin-bottom: 18px; }
.efs-home-logo { max-height: 64px; width: auto; }
.efs-home-logo-fallback { font-size: 20px; font-weight: 800; color: var(--efs-primary); letter-spacing: -.3px; }
.efs-home-poweredby {
  position: fixed; right: 18px; bottom: 14px; display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; background: rgba(255,255,255,.92); border: 1px solid var(--efs-border); border-radius: 20px;
  box-shadow: var(--efs-shadow); z-index: 5;
}
.efs-home-poweredby img { height: 22px; width: auto; }
.efs-home-poweredby span { font-size: 11px; color: var(--efs-text-muted); font-weight: 600; white-space: nowrap; }
.efs-home-welcome { text-align: center; margin-bottom: 18px; }
.efs-home-greeting { font-size: 24px; font-weight: 800; color: var(--efs-text); letter-spacing: -.3px; }
.efs-home-datetime { margin-top: 6px; font-size: 14px; color: var(--efs-text-muted); font-weight: 600; text-transform: capitalize; }
.efs-home-time-sep { margin: 0 6px; }
.efs-home-session { margin-top: 6px; font-size: 12px; color: var(--efs-text-muted); }
.efs-home-quote {
  max-width: 640px; margin: 0 auto 28px; padding: 14px 20px; text-align: center; font-size: 14px; font-style: italic;
  color: var(--efs-primary); background: #eef2ff; border: 1px solid #c7d2fe; border-radius: var(--efs-radius);
  animation: efs-home-quote-fade .5s ease;
}
@keyframes efs-home-quote-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
.efs-home-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; }
.efs-home-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 10px; text-align: left;
  padding: 26px 22px; border: 1px solid var(--efs-border); border-radius: var(--efs-radius); background: #fff;
  cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .15s;
  box-shadow: var(--efs-shadow);
}
.efs-home-card:hover { border-color: var(--efs-primary); box-shadow: 0 6px 16px rgba(21,51,117,.14); transform: translateY(-2px); }
.efs-home-card-icon { color: var(--efs-primary); }
.efs-home-card-label { font-weight: 800; font-size: 18px; color: var(--efs-text); }
.efs-home-card-desc { font-size: 13px; color: var(--efs-text-muted); }

.efs-stepbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 10px 20px; background: var(--efs-card); border-bottom: 1px solid var(--efs-border);
}
.efs-step-label { font-size: 13px; font-weight: 700; color: var(--efs-text-muted); }
.efs-step-nav {
  padding: 8px 16px; border-radius: 20px; border: 1px solid var(--efs-border); background: #fff;
  cursor: pointer; font-size: 13px; font-weight: 600;
}
.efs-step-nav:disabled { opacity: .4; cursor: not-allowed; }
.efs-step-nav-primary { background: var(--efs-primary); color: #fff; border-color: var(--efs-primary); }
.efs-step-nav-primary:disabled { background: #cbd5e1; border-color: #cbd5e1; }

.efs-body { flex: 1; display: flex; overflow: hidden; }
.efs-main { flex: 1; display: flex; flex-direction: column; padding: 16px; overflow: hidden; }
.efs-step-pane { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.efs-field-row { margin-bottom: 16px; }
.efs-field-row label { display: block; font-size: 12px; font-weight: 700; color: var(--efs-text-muted); margin-bottom: 6px; }
.efs-field-row2 { display: flex; gap: 12px; }
.efs-field-row2 .efs-field-row { flex: 1; }

.efs-sections { max-width: 560px; margin: 20px auto; width: 100%; overflow-y: auto; }
.efs-sec-card {
  background: var(--efs-card); border: 1px solid var(--efs-border); border-radius: var(--efs-radius);
  margin-bottom: 12px; overflow: hidden;
}
.efs-sec-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; cursor: pointer; }
.efs-sec-title { font-size: 14px; font-weight: 700; }
.efs-sec-summary { font-size: 12px; color: var(--efs-text-muted); margin-top: 2px; }
.efs-sec-chev { transition: transform .15s; color: var(--efs-text-muted); }
.efs-sec-open .efs-sec-chev { transform: rotate(180deg); }
.efs-sec-body { display: none; padding: 0 18px 18px; }
.efs-sec-open .efs-sec-body { display: block; }
.efs-pill-label { font-size: 13px; color: var(--efs-text-muted); }
.efs-pill-select {
  border: none; background: transparent; font-size: 13px; font-weight: 600; color: var(--efs-text);
  cursor: pointer; max-width: 200px;
}
.efs-cust-row-active { background: #eef2ff; }
.efs-cust-details { margin: 10px 0; padding: 10px 12px; background: #f8fafc; border-radius: 8px; }
.efs-cust-detail-row { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
.efs-cust-detail-row label { color: var(--efs-text-muted); font-weight: 600; }
.efs-cust-detail-input { max-width: 160px; padding: 5px 8px; font-size: 12px; border: 1px solid var(--efs-border); border-radius: 6px; }
.efs-cust-details-loading { font-size: 12px; color: var(--efs-text-muted); padding: 6px 0; }
.efs-search-row { margin-bottom: 10px; display: flex; align-items: center; gap: 12px; }
.efs-search-input {
  width: 100%; padding: 10px 14px; border: 1px solid var(--efs-border); border-radius: var(--efs-radius);
  font-size: 14px; background: var(--efs-card);
}
.efs-instock-toggle {
  display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600;
  color: var(--efs-text-muted); white-space: nowrap; cursor: pointer; user-select: none;
}
.efs-instock-toggle input { cursor: pointer; }
.efs-search-row .efs-search-input { flex: 1; width: auto; }
.efs-card-instock { border-color: #86efac; background: #f0fdf4; }
.efs-categories { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 10px; flex-shrink: 0; }
.efs-cat-tab {
  padding: 8px 16px; border-radius: 20px; border: 1px solid var(--efs-border); background: var(--efs-card);
  cursor: pointer; font-size: 13px; white-space: nowrap; font-weight: 600; color: var(--efs-text-muted);
}
.efs-cat-tab-active { background: var(--efs-primary); color: #fff; border-color: var(--efs-primary); }

.efs-grid {
  flex: 1; overflow-y: auto; display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; align-content: start;
}
.efs-grid-empty, .efs-ticket-empty { text-align: center; color: var(--efs-text-muted); padding: 40px; grid-column: 1/-1; }
.efs-card {
  position: relative; background: var(--efs-card); border: 1px solid var(--efs-border); border-radius: var(--efs-radius);
  box-shadow: var(--efs-shadow); cursor: pointer; padding: 10px; text-align: center; user-select: none;
  transition: transform .08s;
}
.efs-card:active { transform: scale(0.96); }
.efs-card-img { width: 100%; height: 90px; object-fit: cover; border-radius: 8px; margin-bottom: 6px; background: #f1f5f9; }
.efs-card-placeholder {
  width: 100%; height: 90px; border-radius: 8px; margin-bottom: 6px; background: #eef2ff;
  display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 22px; color: var(--efs-primary);
}
.efs-card-name { font-size: 12px; font-weight: 600; line-height: 1.3; height: 32px; overflow: hidden; }
.efs-card-price { font-size: 13px; font-weight: 700; color: var(--efs-primary); margin-top: 4px; }
.efs-card-badge {
  position: absolute; top: -6px; right: -6px; background: var(--efs-danger); color: #fff;
  border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; box-shadow: 0 1px 3px rgba(0,0,0,.3);
}
.efs-card-stock-btn {
  position: absolute; top: 4px; left: 4px; width: 20px; height: 20px; border-radius: 50%;
  border: 1px solid var(--efs-border); background: rgba(255,255,255,.9); color: var(--efs-text-muted);
  font-size: 12px; line-height: 1; cursor: pointer; z-index: 2;
}
.efs-card-stock-btn:hover { color: var(--efs-primary); border-color: var(--efs-primary); }
.efs-card-lm-btn {
  position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border-radius: 50%;
  border: 1px solid var(--efs-border); background: rgba(255,255,255,.9); color: var(--efs-text-muted);
  font-size: 10px; line-height: 1; cursor: pointer; z-index: 2;
}
.efs-card-lm-btn:hover { color: var(--efs-primary); border-color: var(--efs-primary); }
.efs-stock-loading { padding: 16px; text-align: center; color: var(--efs-text-muted); }
.efs-stock-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.efs-stock-table th, .efs-stock-table td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--efs-border); }
.efs-stock-table th { color: var(--efs-text-muted); font-weight: 700; font-size: 11px; }

.efs-ticket {
  width: 340px; flex-shrink: 0; background: var(--efs-card); border-left: 1px solid var(--efs-border);
  display: flex; flex-direction: column;
}
.efs-ticket-header { padding: 14px 18px; font-weight: 700; font-size: 15px; border-bottom: 1px solid var(--efs-border); }
.efs-ticket-lines { flex: 1; overflow-y: auto; padding: 8px; }
.efs-ticket-line {
  display: flex; flex-direction: column; gap: 4px;
  padding: 10px 8px; border-bottom: 1px solid #f1f5f9;
}
.efs-line-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.efs-line-name { font-size: 13px; font-weight: 600; line-height: 1.35; flex: 1; }
.efs-line-tag { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 8px; margin-left: 6px; white-space: nowrap; }
.efs-line-tag-ok { background: #dcfce7; color: #16a34a; }
.efs-line-tag-pending { background: #fff7ed; color: #c2410c; }
.efs-line-details { font-size: 11px; color: var(--efs-text-muted); line-height: 1.4; }
.efs-line-bottom { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.efs-line-bottom-right { display: flex; align-items: center; gap: 10px; }
.efs-line-qty { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.efs-qty-btn { width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--efs-border); background: #fff; cursor: pointer; flex-shrink: 0; }
.efs-qty-value { min-width: 22px; text-align: center; font-weight: 700; cursor: pointer; }
.efs-line-rate { font-size: 11px; color: var(--efs-text-muted); white-space: nowrap; }
.efs-line-amount { font-size: 13px; font-weight: 700; white-space: nowrap; }
.efs-line-options {
  background: #fff; border: 1px solid var(--efs-border); color: var(--efs-text-muted);
  border-radius: 50%; width: 24px; height: 24px; font-size: 16px; line-height: 1; cursor: pointer; flex-shrink: 0;
}
.efs-line-options:hover { color: var(--efs-primary); border-color: var(--efs-primary); }
.efs-line-remove {
  background: none; border: none; color: #cbd5e1; font-size: 16px; cursor: pointer; flex-shrink: 0; line-height: 1;
}
.efs-line-remove:hover { color: var(--efs-danger); }
.efs-adenda-edit-btn { margin-top: 8px; width: 100%; }

.efs-ticket-footer { padding: 14px 18px; border-top: 1px solid var(--efs-border); }
.efs-total-row { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 12px; }
.efs-total-row-grand { font-size: 20px; font-weight: 800; color: var(--efs-primary); }
.efs-btn-charge {
  width: 100%; padding: 14px; background: var(--efs-primary); color: #fff; border: none;
  border-radius: var(--efs-radius); font-size: 16px; font-weight: 700; cursor: pointer;
}
.efs-btn-charge:disabled { background: #cbd5e1; cursor: not-allowed; }
.efs-btn-secondary {
  padding: 12px; background: #fff; border: 1px solid var(--efs-border); border-radius: var(--efs-radius);
  font-size: 14px; font-weight: 600; cursor: pointer; flex: 1;
}
.efs-btn-green { background: var(--efs-success); border-color: var(--efs-success); color: #fff; }
.efs-btn-yellow { background: #f5a623; border-color: #f5a623; color: #fff; }
.efs-btn-secondary:disabled {
  background: #e2e8f0 !important; border-color: #e2e8f0 !important; color: #94a3b8 !important;
  cursor: not-allowed;
}
#efs-btn-suspend { width: 100%; margin-top: 10px; }
.efs-kbd {
  display: inline-block; margin-left: 6px; padding: 1px 6px; font-size: 10px; font-weight: 700;
  border: 1px solid var(--efs-border); border-radius: 4px; background: #f8f9fb; color: var(--efs-text-muted);
}
.efs-held-badge {
  display: inline-block; margin-left: 6px; padding: 1px 7px; font-size: 11px; font-weight: 700;
  border-radius: 10px; background: var(--efs-danger); color: #fff;
}

.efs-overlay {
  position: fixed; inset: 0; background: var(--efs-bg); z-index: 200; overflow-y: auto;
}
.efs-wizard { max-width: 480px; margin: 0 auto; padding: 24px; }
.efs-wizard-header { display: flex; align-items: center; gap: 16px; margin-bottom: 20px; }
.efs-wizard-title { font-size: 18px; font-weight: 800; }
.efs-wizard-total {
  text-align: center; font-size: 14px; color: var(--efs-text-muted); margin-bottom: 20px;
}
.efs-wizard-total span { display: block; font-size: 36px; font-weight: 800; color: var(--efs-primary); }
.efs-pay-methods { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; margin-bottom: 16px; }
.efs-pay-method-btn {
  padding: 14px; border-radius: var(--efs-radius); border: 2px solid var(--efs-border); background: #fff;
  cursor: pointer; font-weight: 700; font-size: 13px;
}
.efs-pay-method-active { border-color: var(--efs-primary); color: var(--efs-primary); background: #eef2ff; }
.efs-pay-quick-cash { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.efs-quick-cash-btn {
  padding: 8px 14px; border-radius: 20px; border: 1px solid var(--efs-border); background: #fff; cursor: pointer; font-weight: 600;
}
.efs-numpad { text-align: center; }
.efs-numpad-display {
  font-size: 32px; font-weight: 800; padding: 12px; background: #fff; border-radius: var(--efs-radius);
  border: 1px solid var(--efs-border); margin-bottom: 10px;
}
.efs-numpad-keys { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.efs-numpad-key {
  padding: 16px; font-size: 18px; font-weight: 700; border-radius: 10px; border: 1px solid var(--efs-border);
  background: #fff; cursor: pointer;
}
.efs-pay-change { text-align: center; margin: 14px 0; font-size: 15px; }
.efs-pay-credito-note {
  text-align: center; margin: 14px 0; font-size: 13px; color: #c2410c; background: #fff7ed;
  padding: 12px; border-radius: var(--efs-radius);
}
.efs-pay-primary-covered {
  text-align: center; margin: 0 0 14px; font-size: 13px; color: #16a34a; background: #f0fdf4;
  padding: 12px; border-radius: var(--efs-radius);
}
.efs-wizard-header #efs-pay-reset { margin-left: auto; font-size: 12px; padding: 6px 12px; }
.efs-pay-splits { margin-bottom: 10px; }
.efs-split-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
.efs-split-row select, .efs-split-row input { padding: 8px; border-radius: 8px; border: 1px solid var(--efs-border); }
.efs-split-row select { flex: 1 1 140px; }
.efs-split-row input { flex: 1 1 90px; min-width: 80px; max-width: 140px; }
.efs-pay-summary {
  margin: 16px 0; padding: 14px 16px; background: #f8fafc; border: 1px solid var(--efs-border);
  border-radius: var(--efs-radius); font-size: 13px;
}
.efs-pay-summary-method, .efs-pay-summary-row {
  display: flex; justify-content: space-between; padding: 4px 0; color: var(--efs-text-muted);
}
.efs-pay-summary-row { border-top: 1px solid var(--efs-border); margin-top: 4px; padding-top: 8px; }
.efs-pay-summary-total { font-weight: 800; font-size: 16px; color: var(--efs-text); }
.efs-pay-summary-pending { color: #c2410c; font-weight: 700; }
.efs-pay-summary-change { color: var(--efs-success); font-weight: 700; }
.efs-pay-summary-note { text-align: center; color: var(--efs-text-muted); padding-top: 6px; }
#efs-pay-confirm { margin-top: 20px; }
#efs-btn-guias-transporte { width: 100%; margin: 10px 0; }
.efs-guias-hint { color: var(--efs-text-muted); font-size: 13px; margin-bottom: 12px; }
.efs-guias-rows { display: flex; flex-direction: column; gap: 8px; }
.efs-guia-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.efs-guia-row select, .efs-guia-row input { padding: 8px; border-radius: 8px; border: 1px solid var(--efs-border); }
.efs-guia-row select { flex: 2 1 160px; }
.efs-guia-row input.efs-guia-numero { flex: 2 1 140px; }
.efs-guia-row input.efs-guia-destino { flex: 2 1 140px; }
.efs-guia-row input.efs-guia-piezas, .efs-guia-row input.efs-guia-monto { flex: 1 1 90px; min-width: 80px; max-width: 130px; }

.efs-confirm { max-width: 420px; margin: 60px auto; text-align: center; }
.efs-confirm-icon {
  width: 70px; height: 70px; border-radius: 50%; background: var(--efs-success); color: #fff;
  font-size: 36px; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;
}
.efs-fab-guia-transporte {
  position: absolute; top: 20px; right: 20px; z-index: 5;
  display: flex; align-items: center; gap: 8px;
  padding: 10px 16px; border: none; border-radius: 999px;
  background: #0d9488; color: #fff; font-size: 13px; font-weight: 700;
  cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.15);
}
.efs-fab-guia-transporte:hover:not(:disabled) { background: #0f766e; }
.efs-fab-guia-transporte:disabled { background: #cbd5e1; color: #64748b; cursor: not-allowed; box-shadow: none; }
.efs-confirm-title { font-size: 22px; font-weight: 800; margin-bottom: 6px; }
.efs-confirm-invoice { font-size: 14px; color: var(--efs-text-muted); margin-bottom: 16px; }
.efs-confirm-change { font-size: 16px; margin-bottom: 20px; }
.efs-confirm-update-customer {
  width: 100%; padding: 14px; font-size: 14px; font-weight: 700;
  border: 2px dashed var(--efs-primary); color: var(--efs-primary); background: #eef2ff;
}
.efs-confirm-customer-locked {
  padding: 10px; margin-bottom: 4px; font-size: 13px; color: var(--efs-text-muted);
  background: #f8fafc; border-radius: var(--efs-radius);
}
.efs-confirm-actions { display: flex; gap: 10px; margin-top: 20px; }
.efs-confirm-actions-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 20px;
}
.efs-confirm-actions-grid #efs-confirm-new { grid-column: 1 / -1; }

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

.efs-confirm-danger-zone { margin-top: 24px; padding-top: 16px; border-top: 1px dashed var(--efs-border); }
.efs-btn-danger {
  width: 100%; padding: 12px; background: #fff; border: 1px solid var(--efs-danger); color: var(--efs-danger);
  border-radius: var(--efs-radius); font-size: 13px; font-weight: 700; cursor: pointer;
}
.efs-btn-danger:hover:not(:disabled) { background: var(--efs-danger); color: #fff; }
.efs-btn-danger:disabled { border-color: #e2e8f0; color: #94a3b8; cursor: not-allowed; }

.efs-history-wizard { max-width: 900px; }
.efs-liq-wizard-wide { max-width: 96vw; }
.efs-history-filters { display: flex; align-items: flex-end; gap: 14px; margin-bottom: 20px; flex-wrap: wrap; }
.efs-history-filters .efs-field-row { margin-bottom: 0; }
.efs-history-results { overflow-x: auto; }
.efs-hist-row { cursor: pointer; }
.efs-hist-row:hover { background: #f0f7ff; }
.efs-hist-guia-icon { display: inline-flex; color: #cbd5e1; }
.efs-hist-guia-icon-active { color: #0d9488; }
.efs-hist-pago-cell { cursor: pointer; }
.efs-hist-pago-icon { display: inline-flex; color: #cbd5e1; }
.efs-hist-pago-icon-active { color: var(--efs-success); }
.efs-pending-actions { display: flex; gap: 8px; }
.efs-pending-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--efs-border); border-radius: 8px; background: #fff; color: var(--efs-text-muted); cursor: pointer; transition: border-color .15s, color .15s, background .15s; }
.efs-pending-icon-btn:hover { border-color: var(--efs-primary); color: var(--efs-primary); background: #f0f4ff; }
.efs-pending-assign-btn:hover { border-color: #0d9488; color: #0d9488; background: #ecfdf9; }
.efs-pago-detail-summary { display: flex; gap: 20px; margin-bottom: 12px; font-size: 13px; color: var(--efs-text-muted); }

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

.efs-serial-list, .efs-cust-list { margin-top: 8px; max-height: 320px; overflow-y: auto; border: 1px solid #e0e0e0; border-radius: 4px; background: #fff; }
.efs-serial-loading, .efs-serial-empty, .efs-cust-empty { padding: 16px; color: #888; text-align: center; }
.efs-serial-row, .efs-cust-row {
  padding: 10px 14px; cursor: pointer; border-bottom: 1px solid #f0f0f0; display: flex; justify-content: space-between; align-items: center;
}
.efs-serial-row:hover, .efs-cust-row:hover { background: #f0f7ff; }
.efs-serial-code { font-weight: 600; font-size: 13px; font-family: monospace; }
.efs-serial-wh { color: #888; font-size: 11px; }
.efs-cust-name { font-weight: 600; font-size: 13px; }
.efs-cust-nit { color: #888; font-size: 11px; }

/* ── Responsive: ventana angosta / laptop chico / tablet ──────────────
   Antes esta pantalla no tenía ni un solo @media — el panel de ticket
   fijo (340px) exprimía la grilla de productos en ventanas angostas.
   Debajo de 700px el ticket baja como bloque bajo la grilla en vez de
   competir por el ancho. */
@media (max-width: 900px) {
  .efs-ticket { width: 300px; }
}
@media (max-width: 700px) {
  .efs-body { flex-direction: column; overflow-y: auto; }
  .efs-main { overflow: visible; }
  .efs-grid { overflow-y: visible; }
  .efs-ticket {
    width: 100%; flex-shrink: 0; max-height: 55vh;
    border-left: none; border-top: 2px solid var(--efs-border);
  }
  .efs-header { flex-wrap: wrap; row-gap: 8px; }
}
@media (max-width: 480px) {
  .efs-company-badge { display: none; }
}
`;
