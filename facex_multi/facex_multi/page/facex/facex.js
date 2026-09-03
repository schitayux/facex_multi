/**
 * FacEx — Facturación Exprés (FacEx Multi)
 * Frappe v15 compatible | Sin dependencias externas
 * Toda la lógica fiscal/contable permanece en ERPNext core.
 */

const EF_MAINT_CUST_PAGE_LENGTH = 15;
const EF_MAINT_ITEM_PAGE_LENGTH = 15;
const EF_MAINT_SUPP_PAGE_LENGTH = 15;
const EF_MAINT_LM_PAGE_LENGTH = 15;

// ---------------------------------------------------------------------------
// Page lifecycle hooks
// ---------------------------------------------------------------------------

frappe.pages["facex"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "FacEx",
		single_column: true,
	});
	// Modo Enfoque es el único modo de esta pantalla (ya no hay botón para
	// alternarlo). Frappe Desk es un SPA — el <body> persiste entre rutas —
	// así que hay que quitar la clase apenas el usuario navega a OTRA
	// pantalla, o el resto de ERPNext se quedaría sin navbar/sidebar.
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex") {
			$("body").removeClass("facex-fullscreen-mode");
		}
	});
	// controls.bundle.js provides frappe.ui.form.make_control (Link, Date, etc.)
	// It is NOT included in desk.bundle.js, so must be required explicitly.
	frappe.require(["/assets/facex_multi/js/facex_transporte_module.js", "/assets/facex_multi/js/ef_guide.js", "controls.bundle.js"], function () {
		wrapper.efast = new EFastSalePage(page, wrapper);
		facex_multi.setup_back_guard({ to: "/app", is_dirty: () => wrapper.efast._dirty });
	});
};

frappe.pages["facex"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	if (!wrapper.efast) return;
	// Rearmar en cada re-entrada: on_page_load solo corre una vez por sesión
	// de pestaña (ver history_guard.js), así que sin esto el guard del botón
	// Atrás dejaría de funcionar después de la primera visita a esta página.
	facex_multi.setup_back_guard({ to: "/app", is_dirty: () => wrapper.efast._dirty });
	const params = frappe.urllib.get_dict();
	if (params.invoice) {
		wrapper.efast.load_invoice(params.invoice);
	}
	// No forzar "home" aquí: cada _switch_view interno llama frappe.set_route
	// para reflejar la vista actual en la URL, y ese set_route puede volver a
	// disparar on_page_show antes de que window.location.href refleje el
	// query string recién puesto — leerlo aquí en ese instante ve params
	// desactualizados (vacíos) y rebota a "home" en medio de una navegación
	// normal a Reportes/Mantenimiento, causando un ciclo de renders y
	// llamadas que cuelga el navegador. El aterrizaje en Inicio en la carga
	// inicial ya lo cubre on_page_load/_load_defaults_then_init.
};

// ---------------------------------------------------------------------------
// Main Controller
// ---------------------------------------------------------------------------

class EFastSalePage {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.$body = $(page.body);
		this.doc = this._empty_doc();
		this.defaults = {};
		this.perms = this._full_perms();
		this.company_config = {};
		this.controls = {};
		this._loading = false;
		this._dirty = false;
		this._manualPayment = false;
		this._request_pending = false;

		this._inject_styles();
		this._render_html();
		this._setup_action_bar();
		this._load_defaults_then_init();
	}

	// -----------------------------------------------------------------------
	// Initialization
	// -----------------------------------------------------------------------

	_load_defaults_then_init() {
		frappe.call({
			method: "facex_multi.api.invoice.get_defaults",
			freeze: false,
			callback: (r) => {
				if (!r.exc && r.message) {
					this.defaults = r.message;
					this.perms = r.message.permissions || this._full_perms();
					this.company_config = r.message.company_config || {};
					if (this.defaults.company) {
						this.$body.find("#ef-navbar-company-badge").css("display", "flex");
						this.$body.find("#ef-active-company-name").text(this.defaults.company);
					}
				}
				this._setup_header_controls();
				this._setup_item_table();
				this._setup_tabs();
				this._setup_payments_tab();
				this._bind_events();
				this._setup_invoice_search();
				this._setup_collapse_btn();
				this._setup_section_accordion();

				// Bind analytics button
				this.$body.find("#ef-btn-show-analytics").on("click", () => {
					this._show_customer_analytics_dialog();
				});

				this._setup_dashboard_controls();
				this._setup_maintenance();
				this._apply_perms();
				this._apply_column_visibility();

				const params = frappe.urllib.get_dict();
				if (params.invoice) {
					this.load_invoice(params.invoice);
				} else {
					this._new_invoice();
					this._switch_view("home");
				}
			},
		});

		// Load warehouses for item grid dropdown
		this.warehouses = [];
		frappe.call({
			method: "facex_multi.api.invoice.get_warehouses",
			callback: (r) => {
				if (!r.exc && r.message) {
					this.warehouses = r.message;
				}
			}
		});
	}

	_empty_doc() {
		return {
			doctype: "Sales Invoice",
			name: "new",
			docstatus: 0,
			es_fiscal: 1,
			bfel_facex_multi: 1,
			naming_series: "",
			customer: "",
			customer_name: "",
			posting_date: frappe.datetime.get_today(),
			due_date: frappe.datetime.get_today(),
			payment_terms_template: "",
			terms: "",
			taxes_and_charges: "",
			sales_partner: "",
			bfel_nit: "",
			bfel_identificacion: "",
			bfel_nombre: "",
			bfel_status: "01 Enviar",
			bfel_escenario_exento: "",
			bfel_establecimiento: "",
			company: "",
			currency: "GTQ",
			items: [],
			taxes: [],
			total: 0,
			total_taxes_and_charges: 0,
			discount_amount: 0,
			grand_total: 0,
			in_words: "",
			update_stock: 0,
			_taxes_template: null,
		};
	}

	_new_invoice() {
		this._dirty = false;
		this._manualPayment = false;
		this.doc = this._empty_doc();
		this.doc.company = this.defaults.company || "";
		this.doc.naming_series = (this.defaults.naming_series || [])[0] || "SINV-.YYYY.-";
		this.doc.taxes_and_charges = "";
		this.doc.payment_terms_template = this.defaults.default_payment_terms_template || "";
		this.doc.sales_partner = this.defaults.default_sales_partner || "";
		// true mientras sales_partner venga de un default (usuario o cliente) y no
		// de una elección manual del cajero — permite que el default más específico
		// del Cliente (ver _on_customer_change) reemplace al default del usuario.
		this._sales_partner_is_default = true;
		this.doc.bfel_status = "01 Enviar";
		this.doc.posting_date = frappe.datetime.get_today();
		this.doc.due_date = frappe.datetime.get_today();

		// Dejar en blanco originalmente para obligar a seleccionar manualmente
		this.doc.bfel_establecimiento = "";

		this._sync_ui_from_doc();
		this._update_action_bar_state();
		this.$body.find("#ef-status-badge").text("NUEVO").removeClass().addClass("ef-badge ef-badge-new");
		this.$body.find("#ef-doc-title").text("NUEVA PRE-FACTURA");
		this.$body.find("#ef-doc-name").text("");
		if (this.doc.taxes_and_charges) {
			this._fetch_tax_template(this.doc.taxes_and_charges);
		} else {
			this._update_local_footer();
		}
		this._focus_first_field();
		this._switch_view("billing");
	}

	// -----------------------------------------------------------------------
	// HTML Render
	// -----------------------------------------------------------------------

	_render_html() {
		this.$body.html(`
<div class="ef-main-layout" style="background: var(--ef-bg); min-height: 100vh;">

  <!-- ── NAV HEADER ────────────────────────────────────────────────── -->
  <div class="ef-navbar-top">
     <div class="ef-navbar-brand" style="display: flex; align-items: center; gap: 8px;">
       <svg class="ef-bolt" width="20" height="20" viewBox="0 0 24 24" fill="#153375"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
       <button id="ef-btn-guide" class="ef-btn" style="margin-left: 12px; font-size: 11px; padding: 4px 10px; border-radius: 6px; display: flex; align-items: center; gap: 5px; border: 1px solid var(--ef-border); background: var(--ef-card); color: var(--ef-text);" title="Guía paso a paso de esta pantalla">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 2-3 4"/><path d="M12 17h.01"/></svg>
         <span>Guía</span>
       </button>
     </div>

     <div id="ef-navbar-company-badge" style="display: none; align-items: center; gap: 6px; background: #eef2ff; color: #4361ee; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 700; border: 1px solid #c7d2fe; box-shadow: 0 1px 2px rgba(0,0,0,0.05); text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer;" title="Ir al menú principal">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"></path><path d="M9 8h1"></path><path d="M9 12h1"></path><path d="M9 16h1"></path><path d="M14 8h1"></path><path d="M14 12h1"></path><path d="M14 16h1"></path><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"></path></svg>
        <span id="ef-active-company-name"></span>
     </div>

     <div class="ef-navbar-menu">
       <button class="ef-nav-btn ef-nav-active" data-view="home" title="Inicio">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
         <span>Inicio</span>
       </button>

       <div class="ef-main-menu" id="ef-main-menu">
         <button type="button" class="ef-menu-trigger" id="ef-btn-main-menu" title="Menú">
           <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>
           <span id="ef-menu-trigger-label">Menú</span>
         </button>
         <div class="ef-menu-panel" id="ef-menu-panel" style="display:none;">
           <div class="ef-menu-group" data-group="ventas">
             <button type="button" class="ef-menu-group-header">
               <span class="ef-menu-group-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
               <span class="ef-menu-group-label">Ventas</span>
               <svg class="ef-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
             </button>
             <div class="ef-menu-group-items">
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="billing" title="Facturador (FacEx)">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                 <span class="ef-menu-item-label">Facturador (FacEx)</span>
               </button>
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="pos" title="POS">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="14" x2="10" y2="14"/></svg>
                 <span class="ef-menu-item-label">POS</span>
               </button>
             </div>
           </div>
           <div class="ef-menu-group" data-group="reportes">
             <button type="button" class="ef-menu-group-header">
               <span class="ef-menu-group-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg></span>
               <span class="ef-menu-group-label">Tablero y Reportes</span>
               <svg class="ef-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
             </button>
             <div class="ef-menu-group-items">
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="dashboard" title="Tablero">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
                 <span class="ef-menu-item-label">Tablero</span>
               </button>
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="reports" title="Reportes y Recibos">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><path d="M3 20h18"/></svg>
                 <span class="ef-menu-item-label">Reportes y Recibos</span>
               </button>
             </div>
           </div>
           <div class="ef-menu-group" data-group="gestion">
             <button type="button" class="ef-menu-group-header">
               <span class="ef-menu-group-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/><circle cx="12" cy="12" r="3"/></svg></span>
               <span class="ef-menu-group-label">Gestión</span>
               <svg class="ef-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
             </button>
             <div class="ef-menu-group-items">
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="maintenance" title="Mantenimiento">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/><circle cx="12" cy="12" r="3"/></svg>
                 <span class="ef-menu-item-label">Mantenimiento</span>
               </button>
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="purchase" title="Compras">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
                 <span class="ef-menu-item-label">Compras</span>
               </button>
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="inventario" title="Inventario">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 8V21H3V8"/><path d="M1 3h22v5H1z"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                 <span class="ef-menu-item-label">Inventario</span>
               </button>
             </div>
           </div>
           <div class="ef-menu-group" data-group="transporte" id="ef-menu-group-transporte" style="display:none;">
             <button type="button" class="ef-menu-group-header">
               <span class="ef-menu-group-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg></span>
               <span class="ef-menu-group-label">Transporte</span>
               <svg class="ef-menu-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
             </button>
             <div class="ef-menu-group-items">
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="transporte" data-transporte-section="transportistas" id="ef-menu-transporte-transportistas" title="Transportistas">
                 <span class="ef-menu-item-label">Transportistas</span>
               </button>
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="transporte" data-transporte-section="pendientes" id="ef-menu-transporte-pendientes" title="Envíos Pendientes">
                 <span class="ef-menu-item-label">Envíos Pendientes</span>
               </button>
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="transporte" data-transporte-section="guias" id="ef-menu-transporte-guias" title="Guías">
                 <span class="ef-menu-item-label">Guías</span>
               </button>
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="transporte" data-transporte-section="liquidaciones" id="ef-menu-transporte-liquidaciones" title="Liquidaciones">
                 <span class="ef-menu-item-label">Liquidaciones</span>
               </button>
               <button type="button" class="ef-nav-btn ef-menu-item" data-view="transporte" data-transporte-section="reportes" id="ef-menu-transporte-reportes" title="Reportes de Transporte">
                 <span class="ef-menu-item-label">Reportes de Transporte</span>
               </button>
             </div>
           </div>
         </div>
       </div>

       <div class="ef-user-dropdown" style="position: relative; margin-left: 12px; display: flex; align-items: center;">
         <button id="ef-btn-user-profile" class="ef-nav-btn" style="padding: 6px 10px; border-radius: 20px; background: #f1f5f9; border: 1px solid #cbd5e1; display: flex; align-items: center; gap: 6px; cursor: pointer;" title="Perfil de Usuario">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
         </button>
         <div id="ef-user-dropdown-menu" style="display: none; position: absolute; top: 120%; right: 0; background: white; border: 1px solid var(--ef-border); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); border-radius: 10px; padding: 14px; min-width: 200px; max-width: 90vw; max-height: calc(100vh - 80px); overflow-y: auto; z-index: 1001;">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 4px;">Usuario Conectado</div>
            <div id="ef-active-user-fullname" style="font-size: 14px; font-weight: 700; color: #0f172a; line-height: 1.2;"></div>
            <div id="ef-active-user-email" style="font-size: 12px; color: #64748b; margin-bottom: 14px; word-break: break-all;"></div>
            <div id="ef-company-switcher-section" style="display:none; margin-bottom: 12px;">
              <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 6px;">Cambiar Compañía</div>
              <select id="ef-company-select" style="width: 100%; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 6px; font-size: 13px; margin-bottom: 8px; color: #0f172a; background: #f8fafc;"></select>
              <button id="ef-btn-switch-company" class="ef-btn" style="width: 100%; background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; display: flex; align-items: center; justify-content: center; gap: 6px; border-radius: 6px; padding: 8px; margin-bottom: 8px; cursor: pointer; font-size: 13px; font-weight: 500;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"></path><path d="M9 8h1"></path><path d="M9 12h1"></path><path d="M9 16h1"></path><path d="M14 8h1"></path><path d="M14 12h1"></path><path d="M14 16h1"></path><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"></path></svg>
                Aplicar Compañía
              </button>
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin-bottom: 10px;">
            </div>
            <button id="ef-btn-change-password" class="ef-btn" style="width: 100%; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; display: flex; align-items: center; justify-content: center; gap: 6px; border-radius: 6px; padding: 8px; margin-bottom: 8px; cursor: pointer; font-size: 13px; font-weight: 500;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
              Cambiar Contraseña
            </button>
            <button id="ef-btn-logout" class="ef-btn" style="width: 100%; background: #fee2e2; color: #dc2626; border: 1px solid #fca5a5; display: flex; align-items: center; justify-content: center; gap: 6px; border-radius: 6px; padding: 8px;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
              Cerrar Sesión
            </button>
         </div>
       </div>

     </div>
  </div>

  <!-- ── VIEW 0: INICIO (landing) ────────────────────────────────── -->
  <div id="ef-home-view" class="ef-view-content" style="display:none;">
    <div class="ef-home-wrap">
      <div class="ef-home-welcome">
        <div class="ef-home-greeting" id="ef-home-greeting">¡Bienvenido!</div>
        <div class="ef-home-datetime">
          <span id="ef-home-date"></span>
          <span class="ef-home-time-sep">·</span>
          <span id="ef-home-time"></span>
        </div>
        <div class="ef-home-session" id="ef-home-session"></div>
      </div>
      <div class="ef-home-quote" id="ef-home-quote"></div>
      <div class="ef-home-cards" id="ef-home-cards"></div>
      <div class="ef-home-footer" id="ef-home-footer"></div>
    </div>
  </div>

  <!-- ── VIEW 1: DASHBOARD / TABLERO ──────────────────────────────── -->
  <div id="ef-dashboard-view" class="ef-view-content" style="display:none; padding: 24px; max-width: 1200px; margin: 0 auto; font-family: var(--ef-font);">
    
    <!-- Encabezado de Bienvenida -->
    <div class="ef-dashboard-welcome" style="background: linear-gradient(135deg, #153375, #4361ee); color: white; padding: 26px 30px; border-radius: 12px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 10px 15px -3px rgba(21,51,117,0.2);">
      <div>
        <h1 style="margin:0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; color: #ffffff !important;">¡Bienvenido a FacEx!</h1>
        <p style="margin: 6px 0 0 0; opacity: 0.9; font-size: 13px; color: #ffffff !important;">Facturación Exprés rápida con certificación FEL y reportes dinámicos.</p>
      </div>
      <button id="ef-dash-btn-billing" class="ef-btn" style="background: white; color: #153375; font-weight: 700; border-radius: 6px; padding: 10px 18px; border: none; font-size: 13px;">
        Crear Factura Rápida
      </button>
    </div>

    <!-- Filtros del Dashboard -->
    <div class="ef-dashboard-filters" style="background: var(--ef-card); border: 1px solid var(--ef-border); border-radius: 12px; padding: 18px; margin-bottom: 24px; display: flex; flex-wrap: wrap; gap: 16px; align-items: center; box-shadow: var(--ef-shadow);">
      <div class="ef-filter-group" style="display:flex; flex-direction:column; gap:4px;">
        <label class="ef-label" style="font-weight: 700; font-size:10px;">Fecha Inicio</label>
        <input type="date" id="ef-dash-start-date" class="ef-input" style="width: 135px; padding: 5px 8px;" />
      </div>
      <div class="ef-filter-group" style="display:flex; flex-direction:column; gap:4px;">
        <label class="ef-label" style="font-weight: 700; font-size:10px;">Fecha Fin</label>
        <input type="date" id="ef-dash-end-date" class="ef-input" style="width: 135px; padding: 5px 8px;" />
      </div>
      <div class="ef-filter-group" style="display:flex; flex-direction:column; gap:4px; flex: 1; min-width: 180px;">
        <label class="ef-label" style="font-weight: 700; font-size:10px;">Cliente</label>
        <div id="ef-dash-customer-ctrl" class="ef-link-ctrl" style="min-height:30px;"></div>
      </div>
      <div class="ef-filter-group" style="align-self: flex-end; display:flex; gap:8px;">
        <button id="ef-dash-btn-apply" class="ef-btn ef-btn-primary" style="padding: 7px 14px; font-size:12px;">
          Filtrar
        </button>
        <button id="ef-dash-btn-clear" class="ef-btn ef-btn-secondary" style="padding: 7px 14px; font-size:12px;">
          Limpiar
        </button>
      </div>
    </div>

    <!-- Fila de KPIs -->
    <div class="ef-dashboard-kpis" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; margin-bottom: 24px;">
      <!-- KPI 1 -->
      <div class="ef-stat-card" id="ef-kpi-card-today" style="border-left: 4px solid var(--ef-primary); text-align: left; box-shadow: var(--ef-shadow); display: flex; flex-direction: column; justify-content: center; min-height: 85px;">
        <div class="ef-stat-label">Ventas Hoy</div>
        <div id="ef-kpi-today-total" class="ef-stat-value" style="font-family:monospace; font-size: 22px;">Q 0.00</div>
        <div id="ef-kpi-today-count" style="font-size: 11px; color: var(--ef-text-muted); margin-top: 4px;">0 facturas</div>
      </div>
      <!-- KPI 2 -->
      <div class="ef-stat-card" id="ef-kpi-card-month" style="border-left: 4px solid var(--ef-success); text-align: left; box-shadow: var(--ef-shadow); display: flex; flex-direction: column; justify-content: center; min-height: 85px;">
        <div class="ef-stat-label">Ventas del Mes</div>
        <div id="ef-kpi-month-total" class="ef-stat-value" style="color: var(--ef-success); font-family:monospace; font-size: 22px;">Q 0.00</div>
        <div id="ef-kpi-month-count" style="font-size: 11px; color: var(--ef-text-muted); margin-top: 4px;">0 facturas</div>
      </div>
      <!-- KPI 3 -->
      <div class="ef-stat-card" id="ef-kpi-card-draft" style="border-left: 4px solid var(--ef-info); text-align: left; box-shadow: var(--ef-shadow); display: flex; flex-direction: column; justify-content: center; min-height: 85px;">
        <div class="ef-stat-label">Ventas Borrador/Cotización</div>
        <div id="ef-kpi-draft-total" class="ef-stat-value" style="color: var(--ef-info); font-family:monospace; font-size: 22px;">Q 0.00</div>
        <div id="ef-kpi-draft-count" style="font-size: 11px; color: var(--ef-text-muted); margin-top: 4px;">0 facturas</div>
      </div>
      <!-- KPI 4 -->
      <div class="ef-stat-card" id="ef-kpi-card-fel" style="border-left: 4px solid var(--ef-warning); text-align: left; box-shadow: var(--ef-shadow); display: flex; flex-direction: column; justify-content: center; min-height: 85px;">
        <div class="ef-stat-label">Facturas Certificadas FEL</div>
        <div id="ef-kpi-fel-processed" class="ef-stat-value" style="color: var(--ef-warning); font-size: 22px;">0</div>
        <div id="ef-kpi-fel-pending" style="font-size: 11px; color: var(--ef-text-muted); margin-top: 4px;">0 pendientes de envío</div>
      </div>
    </div>

    <!-- Contenido Analítico Inferior -->
    <div style="display: grid; grid-template-columns: 1.6fr 1fr; gap: 24px; align-items: start;">
      
      <!-- Listado de Facturas -->
      <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow);">
        <div class="ef-analytics-card-title" style="display:flex; justify-content:space-between; align-items:center;">
          <span>Ventas Recientes</span>
          <span style="font-size:11px; color:var(--ef-text-muted); text-transform:none;">Últimas 50 facturas</span>
        </div>
        <div class="ef-table-wrapper" style="max-height: 400px; overflow-y: auto;">
          <table class="ef-table">
            <thead>
              <tr>
                <th class="ef-th">Factura</th>
                <th class="ef-th">Cliente</th>
                <th class="ef-th">Fecha</th>
                <th class="ef-th ef-td-num">Total</th>
                <th class="ef-th">FEL</th>
                <th class="ef-th" style="width: 50px;"></th>
              </tr>
            </thead>
            <tbody id="ef-dash-invoice-tbody">
              <!-- rows dynamically loaded -->
            </tbody>
          </table>
        </div>
      </div>

      <!-- Barra lateral: Productos y Cliente -->
      <div style="display: flex; flex-direction: column; gap: 24px;">
        
        <!-- Top Productos -->
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow);">
          <div class="ef-analytics-card-title">Top 15 Productos Vendidos</div>
          <div style="padding: 16px; display:flex; flex-direction:column; gap:14px;" id="ef-dash-top-products">
            <!-- dynamic progress bars -->
          </div>
        </div>

        <!-- Estadísticas de Cliente Seleccionado -->
        <div id="ef-dash-customer-stats-card" class="ef-analytics-card" style="box-shadow: var(--ef-shadow); display:none;">
          <div class="ef-analytics-card-title" style="display:flex; justify-content:space-between; align-items:center;">
            <span>Análisis Cliente</span>
            <button id="ef-dash-btn-customer-analysis" class="ef-btn ef-btn-sm ef-btn-secondary" style="padding:2px 8px; font-size:10px;">
              Historial Detallado (F10)
            </button>
          </div>
          <div style="padding: 14px; display:flex; flex-direction:column; gap:10px;">
            <div style="display:flex; justify-content:space-between; font-size:12px; border-bottom:1px solid #f1f5f9; padding-bottom:6px;">
              <span>Total Compras:</span>
              <strong id="ef-dash-cust-sales" style="color:var(--ef-primary); font-family:monospace;">Q 0.00</strong>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; border-bottom:1px solid #f1f5f9; padding-bottom:6px;">
              <span>Facturas Emitidas:</span>
              <strong id="ef-dash-cust-invoices">0</strong>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; border-bottom:1px solid #f1f5f9; padding-bottom:6px;">
              <span>Límite de Crédito:</span>
              <strong id="ef-dash-cust-credit" style="font-family:monospace;">Q 0.00</strong>
            </div>
            <div style="display:flex; justify-content:space-between; font-size:12px; padding-bottom:2px;">
              <span>Saldo Pendiente:</span>
              <strong id="ef-dash-cust-outstanding" style="color:var(--ef-warning); font-family:monospace;">Q 0.00</strong>
            </div>
          </div>
        </div>

      </div>
    </div>

  </div>

  <!-- ── VIEW 2: BILLING INTERFACE ───────────────────────────────── -->
  <div id="ef-billing-view" class="ef-view-content" style="display:none;">
    <div class="ef-wrapper">

      <!-- ── HEADER (tira de identidad + tarjetas Cliente/Documento/FEL) ── -->
      <div class="ef-header">
        <div class="ef-header-top">
          <div class="ef-doc-info">
            <span id="ef-doc-title" class="ef-doc-title" style="font-weight: 700; color: var(--ef-text); margin-right: 8px;"></span>
            <span id="ef-status-badge" class="ef-badge ef-badge-new">NUEVO</span>
            <span id="ef-doc-name" class="ef-doc-name"></span>
          </div>
          <div class="ef-invoice-search">
            <div class="ef-search-wrapper">
              <svg class="ef-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input id="ef-invoice-search" type="text" class="ef-search-input" placeholder="Buscar factura o cliente..." autocomplete="off" />
            </div>
          </div>
          <div class="ef-header-total">
            <span class="ef-header-total-label">Total</span>
            <span id="ef-header-grand-total" class="ef-header-total-value">Q 0.00</span>
          </div>
          <div class="ef-header-brand">
            <div class="ef-header-title">
              <div class="ef-title-main">
                <svg class="ef-bolt" width="20" height="20" viewBox="0 0 24 24" fill="#153375"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                FacEx
              </div>
              <div class="ef-header-subtitle">Facturación Exprés</div>
            </div>
            <button id="ef-btn-collapse" class="ef-btn-collapse" title="Expandir / contraer encabezado">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>
            </button>
          </div>
        </div>

        <!-- Tarjetas colapsables: Cliente / Documento / Facturación FEL.
             Solo una permanece abierta a la vez (ver _setup_section_accordion). -->
        <div class="ef-sections">

          <!-- CLIENTE -->
          <div class="ef-sec-card" id="ef-sec-cliente">
            <div class="ef-sec-head">
              <div class="ef-sec-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>
              <div class="ef-sec-titlewrap">
                <div class="ef-sec-title">Cliente</div>
                <div class="ef-sec-summary" id="ef-sec-cliente-summary">Sin cliente seleccionado</div>
              </div>
              <svg class="ef-sec-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="ef-sec-body">
              <div class="ef-field-group">
                <label class="ef-label">Cliente <span class="ef-req">*</span></label>
                <div style="display:flex;gap:4px">
                  <div data-ctrl="customer" class="ef-link-ctrl" style="flex:1" tabindex="1"></div>
                  <button id="ef-btn-show-analytics" class="ef-btn ef-btn-secondary" style="padding:6px 9px;" title="Ver Análisis de Ventas" tabindex="2">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                  </button>
                </div>
              </div>
              <div class="ef-field-group">
                <label class="ef-label">Nombre para Factura</label>
                <input id="ef-bfel-nombre" type="text" class="ef-input" placeholder="Nombre en factura..." maxlength="100" tabindex="3" />
              </div>
              <div class="ef-field-row2">
                <div class="ef-field-group">
                  <label class="ef-label">NIT / Identificación (FEL)</label>
                  <select id="ef-bfel-identificacion" class="ef-input" tabindex="4">
                    <option value="">-- Seleccione --</option>
                    <option value="NIT">NIT</option>
                    <option value="CUI">CUI</option>
                    <option value="PASAPORTE">PASAPORTE</option>
                    <option value="CF">CF</option>
                  </select>
                </div>
                <div class="ef-field-group">
                  <label class="ef-label">ID Receptor (FEL)</label>
                  <input id="ef-bfel-nit" type="text" class="ef-input" placeholder="CF" maxlength="20" tabindex="5" />
                </div>
              </div>
            </div>
          </div>

          <!-- DOCUMENTO -->
          <div class="ef-sec-card" id="ef-sec-documento">
            <div class="ef-sec-head">
              <div class="ef-sec-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
              <div class="ef-sec-titlewrap">
                <div class="ef-sec-title">Documento</div>
                <div class="ef-sec-summary" id="ef-sec-documento-summary">Sin datos de documento</div>
              </div>
              <svg class="ef-sec-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="ef-sec-body">
              <div class="ef-field-row2">
                <div class="ef-field-group">
                  <label class="ef-label">Establecimiento <span class="ef-req">*</span></label>
                  <select id="ef-establecimiento" class="ef-select" tabindex="6"></select>
                </div>
                <div class="ef-field-group">
                  <label class="ef-label">Serie <span class="ef-req">*</span></label>
                  <select id="ef-naming-series" class="ef-select" tabindex="7"></select>
                </div>
              </div>
              <div class="ef-field-row2">
                <div class="ef-field-group">
                  <label class="ef-label">F. Emisión <span class="ef-req">*</span></label>
                  <input id="ef-posting-date" type="date" class="ef-input" tabindex="8" />
                </div>
                <div class="ef-field-group">
                  <label class="ef-label">F. Vencimiento</label>
                  <input id="ef-due-date" type="date" class="ef-input" tabindex="9" />
                </div>
              </div>
              <div class="ef-field-group">
                <label class="ef-label">Condición de Pago</label>
                <div data-ctrl="payment_terms_template" class="ef-link-ctrl" tabindex="10"></div>
              </div>
              <div class="ef-field-row2">
                <div class="ef-field-group">
                  <label class="ef-label">Plantilla Impuestos</label>
                  <div data-ctrl="taxes_and_charges" class="ef-link-ctrl" tabindex="11"></div>
                </div>
                <div class="ef-field-group">
                  <label class="ef-label">Vendedor</label>
                  <div data-ctrl="sales_partner" class="ef-link-ctrl" tabindex="12"></div>
                </div>
              </div>
              <div class="ef-field-group">
                <label class="ef-label">Términos y Condiciones</label>
                <textarea id="ef-terms" class="ef-textarea ef-textarea-sm" rows="2" placeholder="Términos..." tabindex="13"></textarea>
              </div>
            </div>
          </div>

          <!-- FACTURACIÓN FEL -->
          <div class="ef-sec-card ef-sec-open ef-sec-locked" id="ef-sec-fel">
            <div class="ef-sec-head">
              <div class="ef-sec-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg></div>
              <div class="ef-sec-titlewrap">
                <div class="ef-sec-title">Facturación FEL</div>
                <div class="ef-sec-summary" id="ef-sec-fel-summary">Pendiente de envío a SAT</div>
              </div>
              <svg class="ef-sec-chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="ef-sec-body">
              <div class="ef-field-group">
                <label class="ef-label" style="color:var(--ef-primary); font-weight:600;">Estado FEL</label>
                <select id="ef-bfel-status" class="ef-select" style="border-color:var(--ef-primary); font-weight:600;" tabindex="14">
                  <option value="01 Enviar">01 Enviar</option>
                  <option value="00 No enviar">00 No enviar</option>
                </select>
              </div>

              <!-- Escenario Exento: visible solo si taxes_and_charges empieza con EXE -->
              <div id="ef-row-escenario" class="ef-field-group" style="display:none;">
                <label class="ef-label">Escenario Exento <span class="ef-req">*</span></label>
                <select id="ef-bfel-escenario-exento" class="ef-select" disabled>
                  <option value="">— seleccione escenario —</option>
                  <option value="01 Exportación">01 Exportación</option>
                  <option value="02 Art. 7 No. 4 Ley del IVA">02 Art. 7 No. 4 Ley del IVA</option>
                  <option value="03 Art. 7 No. 5 Ley del IVA">03 Art. 7 No. 5 Ley del IVA</option>
                  <option value="04 Art. 7 No. 9 Ley del IVA">04 Art. 7 No. 9 Ley del IVA</option>
                  <option value="05 Art. 7 No. 10 Ley del IVA">05 Art. 7 No. 10 Ley del IVA</option>
                  <option value="06 Art. 7 No. 13 Ley del IVA">06 Art. 7 No. 13 Ley del IVA</option>
                  <option value="07 Art. 7 No. 14 Ley del IVA">07 Art. 7 No. 14 Ley del IVA</option>
                  <option value="08 Art. 8 No. 1 Ley del IVA">08 Art. 8 No. 1 Ley del IVA</option>
                  <option value="09 Art. 7 No. 15 Ley del IVA">09 Art. 7 No. 15 Ley del IVA</option>
                  <option value="10 Art. 55 Ley del IVA">10 Art. 55 Ley del IVA</option>
                  <option value="11 Decreto 29-89 Ley de Maquila">11 Decreto 29-89 Ley de Maquila</option>
                  <option value="12 Decreto 65-89 Ley de Zonas Francas">12 Decreto 65-89 Ley de Zonas Francas</option>
                  <option value="22 Nota de Crédito / Débito Exportación">22 Nota de Crédito / Débito Exportación</option>
                </select>
              </div>

              <!-- Antes de certificar: sin campos vacíos, solo un mensaje -->
              <div class="ef-fel-pending" id="ef-fel-pending-msg">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                El UUID y número de autorización aparecerán aquí una vez certificada.
              </div>

              <!-- Después de certificar: aparecen los campos avanzados FEL (punto 6) -->
              <div class="ef-fel-cert" id="ef-fel-cert-block" style="display:none;">
                <div class="ef-field-group">
                  <label class="ef-label">UUID FEL</label>
                  <input id="ef-bfel-uuid" type="text" class="ef-input ef-input-readonly" readonly placeholder="—" style="font-size:11px;" />
                </div>
                <div class="ef-field-group" style="margin-top:8px;">
                  <label class="ef-label">No. Doc. FEL</label>
                  <input id="ef-bfel-docto-no" type="text" class="ef-input ef-input-readonly" readonly placeholder="—" style="font-size:11px;" />
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>

      <!-- ── TABS NAVIGATION ───────────────────────────────────────────── -->
      <div class="ef-tabs-nav">
        <button class="ef-tab-btn ef-tab-active" data-tab="factura">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Factura
        </button>
        <button class="ef-tab-btn" data-tab="pagos">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
          Pagos
        </button>
      </div>

      <!-- ── TAB: FACTURA ─────────────────────────────────────────────── -->
      <div class="ef-tab-content" id="ef-tab-factura">

      <!-- ── ITEMS TABLE ──────────────────────────────────────────────── -->
      <div class="ef-items-section">
        <div class="ef-items-header">
          <span class="ef-section-title">Detalle de Productos / Servicios</span>
          <div style="display:flex; gap:8px; align-items:center;">
            <input type="text" id="ef-barcode-scan" class="ef-input" style="width:220px;"
              placeholder="Escanear código de barras / QR..." autocomplete="off" title="Escanee un código de barras o QR para agregar el producto (o sumar cantidad si ya está en la lista)." />
            <button id="ef-add-row" class="ef-btn ef-btn-sm ef-btn-secondary">
              <span>+</span> Agregar Línea
            </button>
          </div>
        </div>

        <div class="ef-table-wrapper">
          <table class="ef-table" id="ef-items-table">
            <thead>
              <tr>
                <th class="ef-th ef-th-idx">#</th>
                <th class="ef-th ef-th-item">Código Item</th>
                <th class="ef-th ef-th-name">Descripción FEL</th>
                <th class="ef-th ef-th-wh ef-col-wh">Almacén</th>
                <th class="ef-th ef-th-qty">Cantidad</th>
                <th class="ef-th ef-th-rate">Precio Unit.</th>
                <th class="ef-th ef-th-disc ef-col-disc">Desc %</th>
                <th class="ef-th ef-th-amount">Importe</th>
                <th class="ef-th ef-th-adenda ef-col-adenda">Adenda</th>
                <th class="ef-th ef-th-tipo ef-col-tipo">Tipo</th>
                <th class="ef-th ef-th-del"></th>
              </tr>
            </thead>
            <tbody id="ef-items-body">
              <!-- rows injected by JS -->
            </tbody>
          </table>
        </div>

        <div id="ef-items-empty" class="ef-empty-state" style="display:none">
          <p>Sin líneas. Haga clic en <strong>Agregar Línea</strong> o presione <kbd>F2</kbd>.</p>
        </div>
      </div>

      <!-- ── FOOTER TOTALES ───────────────────────────────────────────── -->
      <div class="ef-footer">
        <div class="ef-footer-inner">
          <div class="ef-footer-pay-status">
            <div class="ef-label" style="margin-bottom:6px">Estado de Pago</div>
            <div class="ef-pagado-toggle">
              <label class="ef-toggle">
                <input id="ef-pagado" type="checkbox" />
                <span class="ef-toggle-slider"></span>
              </label>
              <span id="ef-pagado-label" class="ef-pagado-status ef-pagado-pending">Pendiente</span>
            </div>
            <button id="ef-btn-manual-payment" class="ef-btn ef-btn-sm ef-btn-secondary" style="display:none;margin-top:8px;font-size:11px">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Detalle manual de pago
            </button>
            <div id="ef-auto-pay-label" style="display:none;margin-top:6px;font-size:11px;color:#2dc653;font-weight:600">✓ Pago automático</div>
          </div>
          <div class="ef-totals">
            <div class="ef-total-row">
              <span class="ef-total-label">Subtotal</span>
              <span id="ef-subtotal" class="ef-total-value">Q 0.00</span>
            </div>
            <div class="ef-total-row">
              <span class="ef-total-label">Descuentos</span>
              <span id="ef-discounts" class="ef-total-value ef-total-discount">- Q 0.00</span>
            </div>
            <div class="ef-total-row">
              <span class="ef-total-label">Impuestos</span>
              <span id="ef-taxes" class="ef-total-value">Q 0.00</span>
            </div>
            <div class="ef-total-row ef-total-row--grand">
              <span class="ef-total-label">TOTAL</span>
              <span id="ef-grand-total" class="ef-total-value ef-grand">Q 0.00</span>
            </div>
            <div class="ef-words-row">
              <span id="ef-words" class="ef-words"></span>
            </div>
          </div>
        </div>
      </div>

      </div><!-- /ef-tab-factura -->

      <!-- ── TAB: PAGOS ───────────────────────────────────────────────── -->
      <div class="ef-tab-content" id="ef-tab-pagos" style="display:none">
        <div class="ef-payments-section">
          <div class="ef-payments-header">
            <div class="ef-pay-summary">
              <div class="ef-pay-row">
                <span>Total Factura:</span>
                <strong id="ef-pay-total">Q 0.00</strong>
              </div>
              <div class="ef-pay-row">
                <span>Total Pagado:</span>
                <strong id="ef-pay-paid">Q 0.00</strong>
              </div>
              <div class="ef-pay-row ef-pay-balance-row">
                <span>Saldo:</span>
                <strong id="ef-pay-balance">Q 0.00</strong>
              </div>
            </div>
          </div>
          <div class="ef-payments-table-wrap">
            <div class="ef-items-header">
              <span class="ef-section-title">Formas de Pago</span>
              <button id="ef-add-payment" class="ef-btn ef-btn-sm ef-btn-secondary">+ Agregar</button>
            </div>
            <div id="ef-pay-contra-entrega-note" class="ef-contra-entrega-note" style="display:none">
              Contra Entrega: el transportista cobra al entregar, esta línea no se contabiliza en bancos ahora. Se registrará un pago automático cuando se concilie la liquidación del transportista.
            </div>
            <div class="ef-table-wrapper">
              <table class="ef-table" id="ef-payments-table">
                <thead>
                  <tr>
                    <th class="ef-th">#</th>
                    <th class="ef-th">Forma de Pago</th>
                    <th class="ef-th">Fecha</th>
                    <th class="ef-th">Referencia</th>
                    <th class="ef-th ef-td-num">Monto</th>
                    <th class="ef-th"></th>
                  </tr>
                </thead>
                <tbody id="ef-payments-body"></tbody>
              </table>
            </div>
            <div id="ef-payments-empty" class="ef-empty-state" style="display:none">
              <p>Sin pagos registrados. Haga clic en <strong>Agregar</strong>.</p>
            </div>
          </div>
          <div class="ef-payments-actions">
            <button id="ef-btn-save-payments" class="ef-btn ef-btn-primary">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              Guardar Pagos
            </button>
          </div>
        </div>
      </div><!-- /ef-tab-pagos -->

      <!-- Spacer para que la accion bar no tape el footer -->
      <div style="height: 80px;"></div>

    </div><!-- ef-wrapper -->
  </div><!-- /ef-billing-view -->

  <!-- ── VIEW 3: REPORTS & RECEIPTS PORTAL ───────────────────────── -->
  <div id="ef-reports-view" class="ef-view-content" style="display:none; padding: 24px; max-width: 1300px; margin: 0 auto; font-family: var(--ef-font);">
    <div style="display: grid; grid-template-columns: 280px 1fr; gap: 24px; min-height: 750px;">
      
      <!-- Left Sidebar Menu -->
      <div style="background: var(--ef-card); border: 1px solid var(--ef-border); border-radius: 12px; padding: 14px; box-shadow: var(--ef-shadow); display: flex; flex-direction: column; gap: 2px; align-self: start;">
        <div style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; color: var(--ef-text-muted); margin-bottom: 10px; padding-left: 8px;">
          Portal de Reportes
        </div>

        <!-- Group: Ventas -->
        <div class="ef-report-group" data-group="ventas">
          <button class="ef-report-group-header" data-group="ventas">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
            <span>Ventas</span>
            <svg class="ef-group-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="ef-report-group-items" data-group-items="ventas">
            <button class="ef-report-nav-btn ef-report-nav-active" data-report="sales_by_date">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <span>Ventas por Fecha</span>
            </button>
            <button class="ef-report-nav-btn" data-report="sales_by_product">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
              <span>Ventas por Producto</span>
            </button>
            <button class="ef-report-nav-btn" data-report="cancelled_invoices">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              <span>Facturas Canceladas</span>
            </button>
            <button class="ef-report-nav-btn" data-report="quotations_report">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              <span>Cotizaciones</span>
            </button>
            <button class="ef-report-nav-btn" data-report="sales_growth_analysis">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
              <span>Crecimiento de Ventas</span>
            </button>
          </div>
        </div>

        <!-- Group: Clientes -->
        <div class="ef-report-group" data-group="clientes">
          <button class="ef-report-group-header" data-group="clientes">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <span>Clientes</span>
            <svg class="ef-group-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="ef-report-group-items" data-group-items="clientes">
            <button class="ef-report-nav-btn" data-report="customer_statement">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="11" y1="9" x2="8" y2="9"/></svg>
              <span>Estado de Cuenta</span>
            </button>
            <button class="ef-report-nav-btn" data-report="aging_receivables">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>Antigüedad de Saldos</span>
            </button>
          </div>
        </div>

        <!-- Group: Bancos -->
        <div class="ef-report-group" data-group="bancos">
          <button class="ef-report-group-header" data-group="bancos">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
            <span>Bancos</span>
            <svg class="ef-group-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="ef-report-group-items" data-group-items="bancos">
            <button class="ef-report-nav-btn" data-report="payments_report">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
              <span>Recibos y Pagos</span>
            </button>
          </div>
        </div>

        <!-- Los reportes de Transporte (Guías por Estado, Facturas por Guía,
             Control de Liquidaciones) se movieron al tab "Transporte" del
             nav principal, junto con Maestros y Documentos — ver
             #ef-transporte-view / FacexTransporteModule#showReportes. -->

        <!-- Group: Rentabilidad -->
        <div class="ef-report-group" data-group="rentabilidad">
          <button class="ef-report-group-header" data-group="rentabilidad">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            <span>Rentabilidad</span>
            <svg class="ef-group-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="ef-report-group-items" data-group-items="rentabilidad">
            <button class="ef-report-nav-btn" data-report="utility_analysis">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/></svg>
              <span>Análisis de Utilidad</span>
            </button>
          </div>
        </div>

        <div style="border-top: 1px solid var(--ef-border); margin: 8px 0;"></div>

        <button class="ef-report-nav-btn" data-report="print_receipt" style="color: var(--ef-warning);">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
          <span>Imprimir Recibo</span>
        </button>
      </div>
      
      <!-- Right Main Panel -->
      <div style="display: flex; flex-direction: column; gap: 20px; min-width: 0;">
        
        <!-- Header Info -->
        <div style="background: var(--ef-card); border: 1px solid var(--ef-border); border-radius: 12px; padding: 20px; box-shadow: var(--ef-shadow); display: flex; justify-content: space-between; align-items: center;">
          <div>
            <h2 id="ef-report-title" style="margin: 0; font-size: 18px; font-weight: 800; color: #153375;"></h2>
            <p id="ef-report-desc" style="margin: 6px 0 0 0; font-size: 12px; color: var(--ef-text-muted);"></p>
          </div>
          <div style="display: flex; gap: 8px;">
            <button id="ef-report-btn-export" class="ef-btn ef-btn-secondary" style="padding: 8px 14px; font-size: 12px; display: flex; align-items: center; gap: 6px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              <span>Exportar CSV</span>
            </button>
            <button id="ef-report-btn-print-pdf" class="ef-btn ef-btn-primary" style="padding: 8px 14px; font-size: 12px; display: none; align-items: center; gap: 6px; background-color: #d9383a; border-color: #d9383a; color: white;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
              <span>Imprimir PDF</span>
            </button>
          </div>
        </div>
        
        <!-- Interactive Filter Bar -->
        <div id="ef-report-filters" style="background: var(--ef-card); border: 1px solid var(--ef-border); border-radius: 12px; padding: 18px; box-shadow: var(--ef-shadow); display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end;">
          <!-- date filters -->
          <div class="ef-rep-filter ef-filter-date" style="display: flex; flex-direction: column; gap: 4px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Fecha Inicio</label>
            <input type="date" id="ef-rep-start-date" class="ef-input" style="width: 140px; padding: 6px 10px;" />
          </div>
          <div class="ef-rep-filter ef-filter-date" style="display: flex; flex-direction: column; gap: 4px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Fecha Fin</label>
            <input type="date" id="ef-rep-end-date" class="ef-input" style="width: 140px; padding: 6px 10px;" />
          </div>
          
          <!-- company filter -->
          <div class="ef-rep-filter ef-filter-company" style="display: flex; flex-direction: column; gap: 4px; width: 200px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Compañía</label>
            <select id="ef-rep-company" class="ef-select" style="padding: 6px 10px;"></select>
          </div>

          <!-- establecimiento filter -->
          <div class="ef-rep-filter ef-filter-establecimiento" style="display: flex; flex-direction: column; gap: 4px; width: 220px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Establecimiento</label>
            <select id="ef-rep-establecimiento" class="ef-select" style="padding: 6px 10px;"></select>
          </div>
          
          <!-- customer filter -->
          <div class="ef-rep-filter ef-filter-customer" style="display: flex; flex-direction: column; gap: 4px; width: 220px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Cliente</label>
            <div id="ef-rep-customer-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
          </div>
          
          <!-- item filter -->
          <div class="ef-rep-filter ef-filter-item" style="display: flex; flex-direction: column; gap: 4px; width: 200px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Item / Producto</label>
            <div id="ef-rep-item-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
          </div>

          <!-- item group filter -->
          <div class="ef-rep-filter ef-filter-item-group" style="display: flex; flex-direction: column; gap: 4px; width: 150px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Grupo de Items</label>
            <div id="ef-rep-item-group-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
          </div>

          <!-- supplier filter (utility analysis) -->
          <div class="ef-rep-filter ef-filter-supplier" style="display: flex; flex-direction: column; gap: 4px; width: 200px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Proveedor</label>
            <div id="ef-rep-supplier-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
          </div>

          <!-- cost basis filter (utility analysis) -->
          <div class="ef-rep-filter ef-filter-cost-basis" style="display: flex; flex-direction: column; gap: 4px; width: 200px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Base de Costo</label>
            <select id="ef-rep-cost-basis" class="ef-select" style="padding: 6px 10px;">
              <option value="estandar">Costo Estándar (ficha)</option>
              <option value="ponderado">Promedio Ponderado (sistema)</option>
              <option value="ultima_compra">Último Precio de Compra</option>
            </select>
          </div>

          <!-- warehouse filter -->
          <div class="ef-rep-filter ef-filter-warehouse" style="display: flex; flex-direction: column; gap: 4px; width: 160px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Bodega / Almacén</label>
            <div id="ef-rep-warehouse-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
          </div>

          <!-- payment method filter -->
          <div class="ef-rep-filter ef-filter-payment-method" style="display: flex; flex-direction: column; gap: 4px; width: 160px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Método de Pago</label>
            <select id="ef-rep-payment-method" class="ef-select" style="padding: 6px 10px;">
              <option value="">— Todos —</option>
              <option value="Efectivo">Efectivo</option>
              <option value="Tarjeta de Crédito">Tarjeta de Crédito</option>
              <option value="Tarjeta de Débito">Tarjeta de Débito</option>
              <option value="Transferencia Bancaria">Transferencia Bancaria</option>
              <option value="Cheque">Cheque</option>
              <option value="Crédito">Crédito</option>
              <option value="Otros">Otros</option>
            </select>
          </div>

          <!-- document type filter (customer statement) -->
          <div class="ef-rep-filter ef-filter-doc-type" style="display: flex; flex-direction: column; gap: 4px; width: 180px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Tipo de Documento</label>
            <select id="ef-rep-doc-type" class="ef-select" style="padding: 6px 10px;">
              <option value="">— Todos —</option>
              <option value="Facturas">Facturas (Excluyendo Devoluciones)</option>
              <option value="Notas de Crédito">Notas de Crédito</option>
              <option value="Notas de Débito">Notas de Débito</option>
            </select>
          </div>

          <!-- year filter -->
          <div class="ef-rep-filter ef-filter-year" style="display: flex; flex-direction: column; gap: 4px; width: 100px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Año</label>
            <select id="ef-rep-year" class="ef-select" style="padding: 6px 10px; font-weight: bold;"></select>
          </div>
          
          <!-- month filter -->
          <div class="ef-rep-filter ef-filter-month" style="display: flex; flex-direction: column; gap: 4px; width: 120px;">
            <label class="ef-label" style="font-weight: 700; font-size: 10px;">Mes</label>
            <select id="ef-rep-month" class="ef-select" style="padding: 6px 10px; font-weight: bold;">
              <option value="1">Enero</option>
              <option value="2">Febrero</option>
              <option value="3">Marzo</option>
              <option value="4">Abril</option>
              <option value="5">Mayo</option>
              <option value="6">Junio</option>
              <option value="7">Julio</option>
              <option value="8">Agosto</option>
              <option value="9">Septiembre</option>
              <option value="10">Octubre</option>
              <option value="11">Noviembre</option>
              <option value="12">Diciembre</option>
            </select>
          </div>
          
          <!-- buttons -->
          <div style="display: flex; gap: 8px;">
            <button id="ef-rep-btn-apply" class="ef-btn ef-btn-primary" style="padding: 8px 16px; font-size: 12px; font-weight: 700;">
              Generar Reporte
            </button>
          </div>
        </div>
        
        <!-- KPI Row -->
        <div id="ef-report-kpi-row" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px;">
          <!-- dynamic kpi cards go here -->
        </div>

        <!-- Sleek Locking Panel for Permissions -->
        <div id="ef-report-unauthorized" style="display: none; background: rgba(255, 255, 255, 0.8); backdrop-filter: blur(10px); border: 1px solid var(--ef-border); border-radius: 12px; padding: 60px 24px; text-align: center; box-shadow: var(--ef-shadow);">
          <div style="max-width: 400px; margin: 0 auto; display: flex; flex-direction: column; align-items: center; gap: 16px;">
            <div style="width: 64px; height: 64px; border-radius: 50%; background: #ffeef0; display: flex; align-items: center; justify-content: center; color: var(--ef-danger);">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </div>
            <h3 style="margin: 0; font-size: 18px; font-weight: 800; color: #153375;">Acceso Restringido</h3>
            <p style="margin: 0; font-size: 13px; color: var(--ef-text-muted); line-height: 1.5;">
              No cuenta con los roles correspondientes (Administrador, Gerente de Finanzas o Ventas) para ver estos datos financieros. Por favor, solicite accesos a su administrador.
            </p>
            <button id="ef-rep-btn-go-back" class="ef-btn ef-btn-secondary" style="margin-top: 10px; width: 100%;">
              Volver al Tablero
            </button>
          </div>
        </div>
        
        <!-- Main Content Area -->
        <div id="ef-report-data-card" class="ef-analytics-card" style="box-shadow: var(--ef-shadow); margin-bottom: 30px;">
          
          <!-- Chart Container (only shown for sales growth) -->
          <div id="ef-report-chart-container" style="display: none; padding: 24px; border-bottom: 1px solid var(--ef-border); background: linear-gradient(180deg, #fafbfd 0%, #ffffff 100%);">
            <!-- stunning vanilla SVG chart injected here -->
          </div>

          <!-- Print Receipt UI (only shown for print receipt tab) -->
          <div id="ef-report-print-receipt-container" style="display: none; padding: 30px 24px;">
            <div style="max-width: 500px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; background: #fafbfe; padding: 24px; border-radius: 12px; border: 1px dashed var(--ef-border);">
              <h3 style="margin: 0; font-size: 14px; font-weight: 700; color: #153375; display: flex; align-items: center; gap: 8px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                Imprimir Recibo de Pago FacEx
              </h3>
              <p style="margin: 0; font-size: 12px; color: var(--ef-text-muted);">
                Seleccione una factura validada para ver su desglose de abonos y generar su comprobante de pago personalizado en formato de ticket.
              </p>
              
              <div style="display: flex; flex-direction: column; gap: 6px;">
                <label class="ef-label" style="font-weight: 700;">Buscar Factura Validada</label>
                <div id="ef-print-invoice-link-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
              </div>
              
              <div id="ef-print-receipt-details" style="display: none; margin-top: 10px; border-top: 1px solid var(--ef-border); padding-top: 16px; display: flex; flex-direction: column; gap: 12px;">
                <div style="display: flex; justify-content: space-between; font-size: 12px;">
                  <span>Cliente:</span>
                  <strong id="ef-receipt-cust-name" style="color: var(--ef-text);"></strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 12px;">
                  <span>Total Factura:</span>
                  <strong id="ef-receipt-grand-total" style="font-family: monospace;"></strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 12px;">
                  <span>Total Recibido/Pagado:</span>
                  <strong id="ef-receipt-total-paid" style="color: var(--ef-success); font-family: monospace;"></strong>
                </div>
                <div style="display: flex; justify-content: space-between; font-size: 12px; border-bottom: 1px solid var(--ef-border); padding-bottom: 12px;">
                  <span>Saldo Restante:</span>
                  <strong id="ef-receipt-balance" style="color: var(--ef-danger); font-family: monospace;"></strong>
                </div>

                <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--ef-text-muted); margin-bottom: 4px;">Historial de Abonos</div>
                <div class="ef-table-wrapper" style="max-height: 150px; overflow-y: auto;">
                  <table class="ef-table" style="font-size: 11px;">
                    <thead>
                      <tr>
                        <th class="ef-th" style="padding: 4px 8px;">Método</th>
                        <th class="ef-th" style="padding: 4px 8px;">Fecha</th>
                        <th class="ef-th ef-td-num" style="padding: 4px 8px;">Monto</th>
                      </tr>
                    </thead>
                    <tbody id="ef-receipt-payments-tbody">
                      <!-- dynamic rows -->
                    </tbody>
                  </table>
                </div>

                <div style="display: flex; gap: 10px; margin-top: 8px;">
                  <button id="ef-btn-print-receipt-format" class="ef-btn ef-btn-primary" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px; font-weight: 700;">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                    Imprimir Recibo (PDF)
                  </button>
                </div>
              </div>
            </div>
          </div>
          
          <div id="ef-report-table-title" class="ef-analytics-card-title">Detalle de Registros</div>
          
          <!-- Table -->
          <div class="ef-table-wrapper" id="ef-report-table-wrapper" style="max-height: 600px; overflow-y: auto;">
            <table class="ef-table" id="ef-report-table">
              <thead id="ef-report-thead">
                <!-- dynamic headers -->
              </thead>
              <tbody id="ef-report-tbody">
                <!-- dynamic rows -->
              </tbody>
            </table>
          </div>
          
          <div id="ef-report-empty" class="ef-empty-state" style="display: none; padding: 40px 20px;">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--ef-text-muted); margin-bottom: 12px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            <p>No se encontraron registros coincidentes con los filtros seleccionados.</p>
          </div>
          
        </div>
        
      </div>
    </div>
  </div>

  <!-- ── VIEW 4: MAINTENANCE / MANTENIMIENTO ───────────────────────── -->
  <div id="ef-maintenance-view" class="ef-view-content" style="display:none; padding: 24px; max-width: 1200px; margin: 0 auto; font-family: var(--ef-font);">
    <div style="background: linear-gradient(135deg, #153375, #4361ee); color: white; padding: 20px 24px; border-radius: 12px; margin-bottom: 24px; box-shadow: 0 10px 15px -3px rgba(21,51,117,0.2);">
      <h1 style="margin:0; font-size: 20px; font-weight: 800; color: #ffffff !important;">Panel de Mantenimiento</h1>
      <p style="margin: 4px 0 0 0; opacity: 0.9; font-size: 12px; color: #ffffff !important;">Administra clientes, catálogo de productos y precios estándar de venta.</p>
    </div>

    <!-- Sub-navigation for Maintenance -->
    <div class="ef-tabs-nav" style="margin-bottom: 20px;">
      <button class="ef-tab-btn ef-maint-tab-btn ef-tab-active" data-maint-tab="clientes">
        Clientes
      </button>
      <button class="ef-tab-btn ef-maint-tab-btn" data-maint-tab="productos">
        Productos
      </button>
      <button class="ef-tab-btn ef-maint-tab-btn" data-maint-tab="listas-materiales">
        Listas de Materiales
      </button>
      <button class="ef-tab-btn ef-maint-tab-btn" data-maint-tab="precios">
        Precios
      </button>
      <button class="ef-tab-btn ef-maint-tab-btn" data-maint-tab="asignacion-precios">
        Asignación de Precios
      </button>
      <button class="ef-tab-btn ef-maint-tab-btn" data-maint-tab="proveedores">
        Proveedores
      </button>
    </div>

    <!-- Maint Tab Content: Clientes -->
    <div class="ef-maint-tab-content" id="ef-maint-tab-clientes">
      <div style="display: grid; grid-template-columns: 320px 1fr; gap: 24px; align-items: start;">
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:16px;">
          <div style="margin-bottom:10px;">
            <span class="ef-analytics-card-title" style="margin:0;">Buscar Cliente</span>
          </div>
          <div class="ef-field-group" style="margin-bottom:10px;">
            <label class="ef-label">Buscar por</label>
            <select id="ef-maint-cust-search-field" class="ef-input" style="width:100%;">
              <option value="nombre">Nombre</option>
              <option value="nit">NIT / Identificación</option>
              <option value="codigo">Código de cliente</option>
              <option value="grupo">Grupo de cliente</option>
            </select>
          </div>
          <div class="ef-field-group" style="margin-bottom:12px;">
            <label class="ef-label">Texto a buscar</label>
            <input type="text" id="ef-maint-cust-search" class="ef-input" placeholder="Escriba y presione Buscar..." style="width:100%;" />
          </div>
          <button id="ef-maint-cust-btn-search" class="ef-btn ef-btn-primary" style="width:100%; margin-bottom:8px;">Buscar</button>
          <button id="ef-maint-cust-btn-all" class="ef-btn ef-btn-sm ef-btn-secondary" style="width:100%; margin-bottom:8px;">Ver todos los clientes</button>
          <div id="ef-maint-cust-search-status" style="font-size:11px; color:#64748b; text-align:center; min-height:14px;"></div>
        </div>
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:20px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid var(--ef-border); padding-bottom:10px;">
            <span style="font-weight:700; color:var(--ef-primary); font-size:16px;" id="ef-maint-cust-title">Búsqueda de clientes</span>
            <button id="ef-maint-cust-btn-new" class="ef-btn ef-btn-sm ef-btn-secondary">+ Crear</button>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 16px;">
            <div class="ef-field-group">
              <label class="ef-label">Nombre del Cliente <span class="ef-req">*</span></label>
              <input type="text" id="ef-maint-cust-name" class="ef-input" style="width:100%" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">NIT / Identificación (FEL)</label>
              <select id="ef-maint-cust-ident" class="ef-input" style="width:100%">
                <option value="">-- Seleccione --</option>
                <option value="NIT">NIT</option>
                <option value="CUI">CUI</option>
                <option value="PASAPORTE">PASAPORTE</option>
                <option value="CF">CF</option>
              </select>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">ID Receptor (FEL)</label>
              <input type="text" id="ef-maint-cust-receptor" class="ef-input" style="width:100%" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Grupo de cliente</label>
              <div id="ef-maint-cust-group-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
            </div>
            <div class="ef-field-group" style="grid-column: span 2;">
              <details id="ef-maint-cust-contacto-section" style="border:1px solid var(--ef-border); border-radius:8px; padding:10px 14px;">
                <summary style="cursor:pointer; font-weight:700; color:var(--ef-primary); font-size:13px;">Contacto</summary>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-top:14px;">
                  <div class="ef-field-group">
                    <label class="ef-label">Nombre</label>
                    <input type="text" id="ef-maint-cust-contact-nombre" class="ef-input" style="width:100%" />
                  </div>
                  <div class="ef-field-group">
                    <label class="ef-label">Apellido</label>
                    <input type="text" id="ef-maint-cust-contact-apellido" class="ef-input" style="width:100%" />
                  </div>
                  <div class="ef-field-group">
                    <label class="ef-label">Email</label>
                    <input type="email" id="ef-maint-cust-contact-email" class="ef-input" style="width:100%" />
                  </div>
                  <div class="ef-field-group">
                    <label class="ef-label">Teléfono</label>
                    <input type="text" id="ef-maint-cust-contact-telefono" class="ef-input" style="width:100%" />
                  </div>
                </div>
              </details>
            </div>
            <div class="ef-field-group" style="grid-column: span 2;">
              <details id="ef-maint-cust-direccion-section" style="border:1px solid var(--ef-border); border-radius:8px; padding:10px 14px;">
                <summary style="cursor:pointer; font-weight:700; color:var(--ef-primary); font-size:13px;">Dirección</summary>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-top:14px;">
                  <div class="ef-field-group" style="grid-column: span 2;">
                    <label class="ef-label">Dirección</label>
                    <input type="text" id="ef-maint-cust-addr" class="ef-input" style="width:100%" />
                  </div>
                  <div class="ef-field-group">
                    <label class="ef-label">Departamento</label>
                    <input type="text" id="ef-maint-cust-dept" class="ef-input" style="width:100%" />
                  </div>
                </div>
              </details>
            </div>
            <div class="ef-field-group" style="grid-column: span 2;">
              <details id="ef-maint-cust-terminos-section" open style="border:1px solid var(--ef-border); border-radius:8px; padding:10px 14px;">
                <summary style="cursor:pointer; font-weight:700; color:var(--ef-primary); font-size:13px;">Términos y condiciones</summary>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:16px; margin-top:14px;">
                  <div class="ef-field-group">
                    <label class="ef-label">Lista de precios</label>
                    <div id="ef-maint-cust-price-list-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
                  </div>
                  <div class="ef-field-group">
                    <label class="ef-label">Condiciones de pago</label>
                    <div id="ef-maint-cust-payment-terms-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
                  </div>
                  <div class="ef-field-group">
                    <label class="ef-label">Vendedor</label>
                    <div id="ef-maint-cust-sales-partner-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
                  </div>
                  <div class="ef-field-group">
                    <label class="ef-label">Límite de Crédito <span style="color:#64748b; font-weight:400; font-size:11px;">(para la compañía activa)</span></label>
                    <input type="number" id="ef-maint-cust-credit-limit" class="ef-input" style="width:100%" min="0" step="any" placeholder="0.00" />
                  </div>
                </div>
              </details>
            </div>
          </div>
          <div style="margin-top:20px; text-align:right;">
            <button id="ef-maint-cust-btn-delete" class="ef-btn" style="background:#ef4444; color:white; padding:8px 24px; display:none; margin-right:8px;">Eliminar Cliente</button>
            <button id="ef-maint-cust-btn-save" class="ef-btn ef-btn-primary" style="padding:8px 24px;">Guardar Cliente</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Maint Tab Content: Productos -->
    <div class="ef-maint-tab-content" id="ef-maint-tab-productos" style="display:none;">
      <div style="display: grid; grid-template-columns: 320px 1fr; gap: 24px; align-items: start;">
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:16px;">
          <div style="margin-bottom:10px;">
            <span class="ef-analytics-card-title" style="margin:0;">Buscar Producto</span>
          </div>
          <div class="ef-field-group" style="margin-bottom:10px;">
            <label class="ef-label">Buscar por</label>
            <select id="ef-maint-item-search-field" class="ef-input" style="width:100%;">
              <option value="nombre">Nombre</option>
              <option value="codigo">Código</option>
              <option value="grupo">Grupo de artículos</option>
            </select>
          </div>
          <div class="ef-field-group" style="margin-bottom:12px;">
            <label class="ef-label">Texto a buscar</label>
            <input type="text" id="ef-maint-item-search" class="ef-input" placeholder="Escriba y presione Buscar..." style="width:100%;" />
          </div>
          <button id="ef-maint-item-btn-search" class="ef-btn ef-btn-primary" style="width:100%; margin-bottom:8px;">Buscar</button>
          <button id="ef-maint-item-btn-all" class="ef-btn ef-btn-sm ef-btn-secondary" style="width:100%; margin-bottom:8px;">Ver todos los productos</button>
          <div id="ef-maint-item-search-status" style="font-size:11px; color:#64748b; text-align:center; min-height:14px;"></div>
        </div>
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:20px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid var(--ef-border); padding-bottom:10px;">
            <span style="font-weight:700; color:var(--ef-primary); font-size:16px;" id="ef-maint-item-title">Búsqueda de productos</span>
            <button id="ef-maint-item-btn-new" class="ef-btn ef-btn-sm ef-btn-secondary">+ Crear</button>
          </div>
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 16px;">
            <div class="ef-field-group" id="ef-maint-item-code-group">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                <label class="ef-label" style="margin:0;">Código del Ítem <span class="ef-req">*</span></label>
                <label class="ef-label" style="margin:0; display:flex; align-items:center; gap:4px; font-weight:normal; cursor:pointer;" id="ef-maint-item-auto-code-label">
                  <input type="checkbox" id="ef-maint-item-auto-code" checked style="margin:0;" />
                  <span>Código Automático</span>
                </label>
              </div>
              <input type="text" id="ef-maint-item-code" class="ef-input" style="width:100%" placeholder="(Código Automático)" disabled />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Nombre del Ítem <span class="ef-req">*</span></label>
              <input type="text" id="ef-maint-item-name" class="ef-input" style="width:100%" />
            </div>
            <div class="ef-field-group" style="display:none;">
              <label class="ef-label">Unidad de Medida (UOM)</label>
              <div id="ef-maint-item-uom-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Grupo de Artículos</label>
              <div id="ef-maint-item-group-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Gestionado por</label>
              <select id="ef-maint-item-gestionado-por" class="ef-input" style="width:100%">
                <option value="General">General</option>
                <option value="Serie">Serie (No. Serie)</option>
                <option value="Lote">Lote (Batch)</option>
              </select>
            </div>
            <div class="ef-field-group" style="display:flex; align-items:flex-end; padding-bottom:4px;">
              <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:13px; color:var(--ef-text); user-select:none;">
                <input type="checkbox" id="ef-maint-item-is-stock" style="width:16px; height:16px; margin:0; accent-color:var(--ef-primary);" />
                <span>Inventariable</span>
              </label>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Costo Estándar <span style="color:#64748b; font-weight:400; font-size:11px;">(usado por el Análisis de Utilidad)</span></label>
              <input type="number" id="ef-maint-item-costo-estandar" class="ef-input" style="width:100%" min="0" step="any" placeholder="0.00" />
            </div>
            <div class="ef-field-group" style="grid-column: span 2;">
              <label class="ef-label">Descripción FEL <span style="color:#64748b; font-weight:400; font-size:11px;">(max. 500 · se llena automáticamente desde el Nombre)</span></label>
              <textarea id="ef-maint-item-desc" class="ef-textarea" style="width:100%; height:80px;" maxlength="500" placeholder="Se completará automáticamente con el Nombre del ítem."></textarea>
            </div>
            <div class="ef-field-group" style="grid-column: span 2; border-top:1px solid var(--ef-border); padding-top:14px;">
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <label class="ef-label" style="margin:0;">Imágenes del Producto</label>
                <button id="ef-maint-item-images-add-btn" class="ef-btn ef-btn-sm ef-btn-secondary" style="display:none;">Agregar Imagen</button>
              </div>
              <div id="ef-maint-item-images-body"></div>
            </div>
            <div class="ef-field-group" style="grid-column: span 2; border-top:1px solid var(--ef-border); padding-top:14px;">
              <label class="ef-label">Palabras de Búsqueda / Referencias <span style="color:#64748b; font-weight:400; font-size:11px;">(alias, números de referencia u otros nombres — usados por la búsqueda F8)</span></label>
              <textarea id="ef-maint-item-keywords" class="ef-textarea" style="width:100%; height:70px;" placeholder="Ej: TRW-12345, disco freno delantero, repuesto genérico Toyota..."></textarea>
            </div>
            <div class="ef-field-group" id="ef-maint-item-relations-wrap" style="grid-column: span 2; border-top:1px solid var(--ef-border); padding-top:14px; display:none;">
              <div style="display:grid; grid-template-columns: 1fr 1fr; gap:24px;">
                <div>
                  <label class="ef-label" style="margin-bottom:8px; display:block;">Artículos en Par <span style="color:#64748b; font-weight:400; font-size:11px;">(se sugiere agregar el par automáticamente en la venta)</span></label>
                  <input type="text" id="ef-maint-item-par-search" class="ef-input" style="width:100%; margin-bottom:4px;" placeholder="Buscar producto para agregar como par..." autocomplete="off" />
                  <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--ef-text); margin-bottom:8px; cursor:pointer;">
                    <input type="checkbox" id="ef-maint-item-par-twoway" checked style="margin:0;" /> Bidireccional
                  </label>
                  <div class="ef-table-wrapper">
                    <table class="ef-table" style="width:100%;">
                      <thead><tr><th class="ef-th">Producto</th><th class="ef-th" style="width:90px; text-align:center;">Bidir.</th><th class="ef-th" style="width:36px;"></th></tr></thead>
                      <tbody id="ef-maint-item-par-tbody"><tr><td colspan="3" style="text-align:center; color:#94a3b8; padding:14px;">Sin pares configurados.</td></tr></tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <label class="ef-label" style="margin-bottom:8px; display:block;">Artículos Alternativos <span style="color:#64748b; font-weight:400; font-size:11px;">(sustitutos equivalentes — acceso rápido F7 en la venta)</span></label>
                  <input type="text" id="ef-maint-item-alt-search" class="ef-input" style="width:100%; margin-bottom:4px;" placeholder="Buscar producto para agregar como alternativo..." autocomplete="off" />
                  <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--ef-text); margin-bottom:8px; cursor:pointer;">
                    <input type="checkbox" id="ef-maint-item-alt-twoway" checked style="margin:0;" /> Bidireccional
                  </label>
                  <div class="ef-table-wrapper">
                    <table class="ef-table" style="width:100%;">
                      <thead><tr><th class="ef-th">Producto</th><th class="ef-th" style="width:90px; text-align:center;">Bidir.</th><th class="ef-th" style="width:36px;"></th></tr></thead>
                      <tbody id="ef-maint-item-alt-tbody"><tr><td colspan="3" style="text-align:center; color:#94a3b8; padding:14px;">Sin alternativos configurados.</td></tr></tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div style="margin-top:20px; text-align:right;">
            <button id="ef-maint-item-btn-print-label" class="ef-btn ef-btn-secondary" style="padding:8px 24px; display:none; margin-right:8px;" title="Imprimir etiqueta del producto (eTIBA)">e-Imprimir</button>
            <button id="ef-maint-item-btn-delete" class="ef-btn" style="background:#ef4444; color:white; padding:8px 24px; display:none; margin-right:8px;">Eliminar Producto</button>
            <button id="ef-maint-item-btn-save" class="ef-btn ef-btn-primary" style="padding:8px 24px;">Guardar Producto</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Maint Tab Content: Listas de Materiales -->
    <div class="ef-maint-tab-content" id="ef-maint-tab-listas-materiales" style="display:none;">
      <div style="display: grid; grid-template-columns: 320px 1fr; gap: 24px; align-items: start;">
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:16px;">
          <div style="margin-bottom:10px;">
            <span class="ef-analytics-card-title" style="margin:0;">Buscar Lista de Materiales</span>
          </div>
          <div class="ef-field-group" style="margin-bottom:10px;">
            <label class="ef-label">Buscar por</label>
            <select id="ef-maint-lm-search-field" class="ef-input" style="width:100%;">
              <option value="nombre">Nombre</option>
              <option value="codigo">Código</option>
            </select>
          </div>
          <div class="ef-field-group" style="margin-bottom:12px;">
            <label class="ef-label">Texto a buscar</label>
            <input type="text" id="ef-maint-lm-search" class="ef-input" placeholder="Escriba y presione Buscar..." style="width:100%;" />
          </div>
          <button id="ef-maint-lm-btn-search" class="ef-btn ef-btn-primary" style="width:100%; margin-bottom:8px;">Buscar</button>
          <button id="ef-maint-lm-btn-all" class="ef-btn ef-btn-sm ef-btn-secondary" style="width:100%; margin-bottom:8px;">Ver todas las Listas de Materiales</button>
          <div id="ef-maint-lm-search-status" style="font-size:11px; color:#64748b; text-align:center; min-height:14px;"></div>
        </div>
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:20px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid var(--ef-border); padding-bottom:10px;">
            <span style="font-weight:700; color:var(--ef-primary); font-size:16px;" id="ef-maint-lm-title">Búsqueda de Listas de Materiales</span>
            <button id="ef-maint-lm-btn-new" class="ef-btn ef-btn-sm ef-btn-secondary">+ Crear</button>
          </div>

          <div class="ef-field-group" id="ef-maint-lm-padre-group">
            <label class="ef-label">Producto Padre <span class="ef-req">*</span></label>
            <input type="text" id="ef-maint-lm-padre-search" class="ef-input" style="width:100%" placeholder="Buscar producto existente..." autocomplete="off" />
            <div style="font-size:11px; color:#64748b; margin-top:4px;">Debe ser un producto ya existente. Use la pestaña Productos para crear uno nuevo.</div>
          </div>

          <div class="ef-field-group" style="margin-top:16px;">
            <label class="ef-label">Manejo de Stock</label>
            <div style="display:flex; gap:20px; margin-top:8px; flex-wrap:wrap;">
              <label style="display:flex; gap:8px; align-items:flex-start; cursor:pointer; max-width:320px;">
                <input type="radio" name="ef-maint-lm-modo" value="Padre" style="margin-top:3px;">
                <span><strong>Padre lleva el stock</strong><br><span style="font-size:11px; color:#64748b;">El producto padre tiene existencia propia (se carga con Transformación, en Inventario).</span></span>
              </label>
              <label style="display:flex; gap:8px; align-items:flex-start; cursor:pointer; max-width:320px;">
                <input type="radio" name="ef-maint-lm-modo" value="Hijos" style="margin-top:3px;">
                <span><strong>Hijos llevan el stock</strong><br><span style="font-size:11px; color:#64748b;">El padre es solo agrupador; al venderlo se descuentan sus componentes automáticamente.</span></span>
              </label>
            </div>
          </div>

          <div class="ef-field-group" style="margin-top:16px;">
            <label class="ef-label">Agregar componente</label>
            <input type="text" id="ef-maint-lm-comp-search" class="ef-input" style="width:100%; max-width:420px;" placeholder="Código o nombre del producto..." autocomplete="off" />
          </div>

          <div class="ef-table-wrapper" style="margin-top:14px; max-height:280px; overflow-y:auto;">
            <table class="ef-table">
              <thead>
                <tr>
                  <th class="ef-th">Producto</th>
                  <th class="ef-th" style="width:170px;">Cantidad por unidad del padre</th>
                  <th class="ef-th" style="width:40px;"></th>
                </tr>
              </thead>
              <tbody id="ef-maint-lm-tbody">
                <tr><td colspan="3" style="text-align:center; color:#94a3b8; padding:14px;">Busque un producto arriba para agregarlo.</td></tr>
              </tbody>
            </table>
          </div>

          <div style="margin-top:20px; text-align:right;">
            <button id="ef-maint-lm-btn-delete" class="ef-btn" style="background:#ef4444; color:white; padding:8px 24px; display:none; margin-right:8px;">Quitar de Listas de Materiales</button>
            <button id="ef-maint-lm-btn-save" class="ef-btn ef-btn-primary" style="padding:8px 24px;">Guardar</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Maint Tab Content: Proveedores -->
    <div class="ef-maint-tab-content" id="ef-maint-tab-proveedores" style="display:none;">
      <div style="display: grid; grid-template-columns: 320px 1fr; gap: 24px; align-items: start;">
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:16px;">
          <div style="margin-bottom:10px;">
            <span class="ef-analytics-card-title" style="margin:0;">Buscar Proveedor</span>
          </div>
          <div class="ef-field-group" style="margin-bottom:10px;">
            <label class="ef-label">Buscar por</label>
            <select id="ef-maint-supp-search-field" class="ef-input" style="width:100%;">
              <option value="nombre">Nombre</option>
              <option value="codigo">Código</option>
              <option value="nit">NIT / ID Fiscal</option>
            </select>
          </div>
          <div class="ef-field-group" style="margin-bottom:12px;">
            <label class="ef-label">Texto a buscar</label>
            <input type="text" id="ef-maint-supp-search" class="ef-input" placeholder="Escriba y presione Buscar..." style="width:100%;" />
          </div>
          <button id="ef-maint-supp-btn-search" class="ef-btn ef-btn-primary" style="width:100%; margin-bottom:8px;">Buscar</button>
          <button id="ef-maint-supp-btn-all" class="ef-btn ef-btn-sm ef-btn-secondary" style="width:100%; margin-bottom:8px;">Ver todos los proveedores</button>
          <div id="ef-maint-supp-search-status" style="font-size:11px; color:#64748b; text-align:center; min-height:14px;"></div>
        </div>
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:20px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid var(--ef-border); padding-bottom:10px;">
            <span id="ef-maint-supp-form-title" style="font-weight:700; color:var(--ef-primary); font-size:16px;">Búsqueda de proveedores</span>
            <button id="ef-maint-supp-btn-new" class="ef-btn ef-btn-sm ef-btn-secondary">+ Crear</button>
          </div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
            <div style="grid-column:1/-1;">
              <label class="ef-label">Nombre del Proveedor <span class="ef-req">*</span></label>
              <input type="text" id="ef-maint-supp-name" class="ef-input" style="width:100%" placeholder="Nombre comercial o razón social"/>
            </div>
            <div>
              <label class="ef-label">NIT / ID Fiscal</label>
              <input type="text" id="ef-maint-supp-nit" class="ef-input" style="width:100%" placeholder="Ej: 12345678-9"/>
            </div>
            <div>
              <label class="ef-label">Teléfono</label>
              <input type="text" id="ef-maint-supp-phone" class="ef-input" style="width:100%" placeholder="Ej: 2222-3333"/>
            </div>
            <div style="grid-column:1/-1;">
              <label class="ef-label">Dirección</label>
              <input type="text" id="ef-maint-supp-address" class="ef-input" style="width:100%" placeholder="Dirección fiscal"/>
            </div>
          </div>
          <div style="margin-top:20px; text-align:right;">
            <button id="ef-maint-supp-btn-delete" class="ef-btn" style="background:#ef4444; color:white; padding:8px 24px; display:none; margin-right:8px;">Eliminar Proveedor</button>
            <button id="ef-maint-supp-btn-save" class="ef-btn ef-btn-primary" style="padding:8px 24px;">Guardar Proveedor</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Maint Tab Content: Precios -->
    <div class="ef-maint-tab-content" id="ef-maint-tab-precios" style="display:none;">
      <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:20px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:12px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-weight:700; color:var(--ef-primary); font-size:16px;">Mantenimiento de Precios</span>
            <select id="ef-maint-price-list-select" class="ef-select" style="width:240px; padding: 4px 8px; font-size: 13px;"></select>
          </div>
          <div id="ef-maint-prices-status" style="font-size:11px; color:#64748b;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
          <div>
            <button id="ef-maint-prices-btn-mark-all" class="ef-btn ef-btn-sm ef-btn-secondary">Marcar todos</button>
            <button id="ef-maint-prices-btn-unmark-all" class="ef-btn ef-btn-sm ef-btn-secondary">Desmarcar todos</button>
          </div>
          <div style="display:flex; align-items:center; gap:10px;">
            <span id="ef-maint-prices-selected-count" style="font-size:12px; color:#64748b;">0 seleccionado(s)</span>
            <button id="ef-maint-prices-btn-export" class="ef-btn ef-btn-sm ef-btn-primary">Exportar seleccionados a Excel</button>
          </div>
        </div>
        <div class="ef-table-wrapper" style="max-height: 640px; overflow-y: auto;">
          <table class="ef-table">
            <thead>
              <tr>
                <th class="ef-th" style="width:36px; text-align:center;"><input type="checkbox" id="ef-maint-prices-select-all" title="Seleccionar todos" /></th>
                <th class="ef-th" style="width:150px;">Código</th>
                <th class="ef-th">Nombre Producto</th>
                <th class="ef-th" style="width:160px;">Grupo de Productos</th>
                <th class="ef-th" style="width:100px;">UOM</th>
                <th class="ef-th" style="width:180px; text-align:right;">Precio Standard</th>
                <th class="ef-th" style="width:120px;"></th>
              </tr>
              <tr class="ef-cust-popup-filter-row">
                <td></td>
                <td><input type="text" id="ef-maint-prices-f-codigo" class="ef-input ef-maint-prices-filter" placeholder="Filtrar..." style="width:100%; font-size:11px; padding:3px 6px;" /></td>
                <td><input type="text" id="ef-maint-prices-f-nombre" class="ef-input ef-maint-prices-filter" placeholder="Filtrar..." style="width:100%; font-size:11px; padding:3px 6px;" /></td>
                <td><input type="text" id="ef-maint-prices-f-grupo" class="ef-input ef-maint-prices-filter" placeholder="Filtrar..." style="width:100%; font-size:11px; padding:3px 6px;" /></td>
                <td></td>
                <td></td>
                <td></td>
              </tr>
            </thead>
            <tbody id="ef-maint-prices-tbody">
              <!-- Dynamically loaded -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Maint Tab Content: Asignación de Precios -->
    <div class="ef-maint-tab-content" id="ef-maint-tab-asignacion-precios" style="display:none;">
      <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:20px; margin-bottom:16px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span style="font-weight:700; color:var(--ef-primary); font-size:16px;">Asignación de Precios por Utilidad</span>
        </div>
        <p style="margin:0 0 18px 0; font-size:12px; color:#64748b;">
          Calcula precios de venta a partir de un costo (estándar, promedio ponderado del sistema, último precio de compra o manual)
          y un % de utilidad sobre costo. La utilidad se calcula siempre sobre el neto; el precio con IVA puede redondearse a un paso comercial.
        </p>

        <!-- Bloque 1: Buscar productos -->
        <div style="border:1px solid var(--ef-border); border-radius:8px; padding:14px; margin-bottom:14px;">
          <div style="font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:var(--ef-text-muted); margin-bottom:10px;">1 · Buscar productos</div>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:14px; align-items:end;">
            <div class="ef-field-group">
              <label class="ef-label">Proveedor</label>
              <div id="ef-ap-supplier-ctrl" class="ef-link-ctrl" style="min-height:32px;"></div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Grupo de Artículos</label>
              <div id="ef-ap-group-ctrl" class="ef-link-ctrl" style="min-height:32px;"></div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Ítem</label>
              <div id="ef-ap-item-ctrl" class="ef-link-ctrl" style="min-height:32px;"></div>
            </div>
            <div class="ef-field-group">
              <button id="ef-ap-btn-search" class="ef-btn ef-btn-primary" style="width:100%;">Buscar</button>
            </div>
          </div>
        </div>

        <!-- Bloque 2: Parámetros de cálculo -->
        <div style="border:1px solid var(--ef-border); border-radius:8px; padding:14px;">
          <div style="font-size:11px; font-weight:800; text-transform:uppercase; letter-spacing:.6px; color:var(--ef-text-muted); margin-bottom:10px;">2 · Parámetros de cálculo</div>
          <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:14px; align-items:end;">
            <div class="ef-field-group">
              <label class="ef-label">Lista de Precios</label>
              <select id="ef-ap-price-list" class="ef-input" style="width:100%;"></select>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Base de Costo</label>
              <select id="ef-ap-cost-basis" class="ef-input" style="width:100%;">
                <option value="estandar">Costo Estándar (ficha)</option>
                <option value="ponderado">Promedio Ponderado (sistema)</option>
                <option value="ultima_compra">Último Precio de Compra</option>
              </select>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">% Utilidad (global)</label>
              <input type="number" id="ef-ap-util-global" class="ef-input" style="width:100%;" min="0" step="any" value="0" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Tasa IVA % <span style="color:#94a3b8; font-weight:400; font-size:11px;">(según la compañía)</span></label>
              <input type="number" id="ef-ap-iva" class="ef-input" style="width:100%; background:#f1f5f9; color:#64748b;" readonly tabindex="-1" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Redondear precio c/IVA a</label>
              <select id="ef-ap-round-step" class="ef-input" style="width:100%;">
                <option value="0">Ninguno (2 decimales)</option>
                <option value="0.05">0.05</option>
                <option value="0.10">0.10</option>
                <option value="0.25">0.25</option>
                <option value="0.50">0.50</option>
                <option value="1">1.00</option>
              </select>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Dirección de redondeo</label>
              <select id="ef-ap-round-mode" class="ef-input" style="width:100%;">
                <option value="up">Hacia arriba</option>
                <option value="nearest">Al más cercano</option>
                <option value="down">Hacia abajo</option>
              </select>
            </div>
          </div>
        </div>

        <div id="ef-ap-status" style="font-size:11px; color:#64748b; margin-top:12px; min-height:14px;"></div>
        <div id="ef-ap-store-hint" style="font-size:11.5px; margin-top:4px;"></div>
      </div>

      <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:16px;">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
          <div>
            <button id="ef-ap-mark-all" class="ef-btn ef-btn-sm ef-btn-secondary">Marcar todos</button>
            <button id="ef-ap-unmark-all" class="ef-btn ef-btn-sm ef-btn-secondary">Desmarcar todos</button>
            <button id="ef-ap-apply-util" class="ef-btn ef-btn-sm ef-btn-secondary" title="Reinicia 'Costo a usar' con la base de costo elegida y '% Util' con el % global, en todas las filas">Recalcular con % global</button>
          </div>
          <div style="display:flex; align-items:center; gap:12px;">
            <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:var(--ef-text); cursor:pointer;">
              <input type="checkbox" id="ef-ap-save-cost" style="margin:0;" />
              Guardar costo usado como Costo Estándar del producto
            </label>
            <span id="ef-ap-selected-count" style="font-size:12px; color:#64748b;">0 seleccionado(s)</span>
            <button id="ef-ap-btn-apply" class="ef-btn ef-btn-sm ef-btn-primary">Aplicar precios seleccionados</button>
          </div>
        </div>
        <div class="ef-table-wrapper" style="max-height:620px; overflow-y:auto; overflow-x:auto;">
          <table class="ef-table">
            <thead>
              <tr>
                <th class="ef-th" rowspan="2" style="width:34px; text-align:center; vertical-align:bottom;"><input type="checkbox" id="ef-ap-select-all" /></th>
                <th class="ef-th" rowspan="2" style="width:130px; vertical-align:bottom;">Código</th>
                <th class="ef-th" rowspan="2" style="vertical-align:bottom;">Nombre</th>
                <th class="ef-th" colspan="3" style="text-align:center;">Costos de referencia</th>
                <th class="ef-th" colspan="4" style="text-align:center; background:#eef2ff;">Nuevo precio a asignar</th>
                <th class="ef-th" colspan="4" style="text-align:center; background:#f1f5f9;">Situación actual</th>
              </tr>
              <tr>
                <th class="ef-th ef-td-num" style="width:95px;">Estándar</th>
                <th class="ef-th ef-td-num" style="width:95px;">Ponderado</th>
                <th class="ef-th ef-td-num" style="width:95px;">Últ. compra</th>
                <th class="ef-th ef-td-num" style="width:110px; background:#eef2ff;">Costo a usar</th>
                <th class="ef-th ef-td-num" style="width:78px; background:#eef2ff;">% Util</th>
                <th class="ef-th ef-td-num" style="width:110px; background:#eef2ff;">Neto</th>
                <th class="ef-th ef-td-num" style="width:110px; background:#eef2ff;">c/IVA</th>
                <th class="ef-th ef-td-num" style="width:100px; background:#f1f5f9;">Precio actual (neto)</th>
                <th class="ef-th ef-td-num" style="width:100px; background:#f1f5f9;">Precio actual c/IVA</th>
                <th class="ef-th ef-td-num" style="width:95px; background:#f1f5f9;">Costo (base)</th>
                <th class="ef-th ef-td-num" style="width:95px; background:#f1f5f9;">Utilidad actual</th>
              </tr>
            </thead>
            <tbody id="ef-ap-tbody">
              <tr><td colspan="14" style="text-align:center; color:#94a3b8; padding:20px;">Filtre por proveedor, grupo de artículos o ítem y presione Buscar.</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- El mantenimiento de Transportistas se movió al tab "Transporte" del
         nav principal (Maestros → Transportistas) — ver #ef-transporte-view
         / FacexTransporteModule#showTransportistas. -->

  </div>

  <!-- ── VIEW 5: COMPRAS ────────────────────────────────────────────── -->
  <div id="ef-purchase-view" class="ef-view-content" style="display:none; padding: 24px; max-width: 1300px; margin: 0 auto; font-family: var(--ef-font);">
    <!-- Banner -->
    <div style="background:linear-gradient(135deg,#1e3a5f,#2563eb);color:#fff;padding:20px 24px;border-radius:12px;margin-bottom:20px;box-shadow:0 10px 15px -3px rgba(30,58,95,.2);display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
      <div>
        <h1 style="margin:0;font-size:20px;font-weight:800;color:#fff;">Módulo de Compras</h1>
        <p style="margin:4px 0 0;opacity:.9;font-size:12px;color:#fff;">Registro de facturas de proveedores con control de inventario y series.</p>
      </div>
      <div style="display:flex;gap:10px;">
        <button id="ef-purch-btn-excel" class="ef-btn" style="background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3);">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          Subir Excel
        </button>
        <button id="ef-purch-btn-new" class="ef-btn" style="background:#fff;color:#1e3a5f;border:none;font-weight:700;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Nueva Compra
        </button>
      </div>
    </div>

    <!-- LIST SECTION -->
    <div id="ef-purch-list-section">
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:14px 16px;margin-bottom:14px;display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
        <div><div class="ef-label">Desde</div><input type="date" id="ef-purch-f-start" class="ef-cell-input" style="width:130px"/></div>
        <div><div class="ef-label">Hasta</div><input type="date" id="ef-purch-f-end" class="ef-cell-input" style="width:130px"/></div>
        <div><div class="ef-label">Proveedor</div><input type="text" id="ef-purch-f-supplier" class="ef-cell-input" placeholder="Todos" style="width:200px"/></div>
        <div><div class="ef-label">Estado</div>
          <select id="ef-purch-f-status" class="ef-cell-input" style="width:120px">
            <option value="">Todos</option><option value="0">Borrador</option>
            <option value="1">Validado</option><option value="2">Cancelado</option>
          </select>
        </div>
        <button id="ef-purch-btn-filter" class="ef-btn ef-btn-secondary" style="height:32px">Filtrar</button>
      </div>
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;">
        <table class="ef-table" style="width:100%">
          <thead><tr>
            <th class="ef-th">No. Factura ERPNext</th>
            <th class="ef-th">Proveedor</th>
            <th class="ef-th">Fecha</th>
            <th class="ef-th">No. Factura Proveedor</th>
            <th class="ef-th ef-td-num">Total</th>
            <th class="ef-th">Estado</th>
            <th class="ef-th"></th>
          </tr></thead>
          <tbody id="ef-purch-list-body"></tbody>
        </table>
        <div id="ef-purch-list-empty" style="display:none;padding:32px;text-align:center;color:#94a3b8;font-size:13px">Sin facturas de compra en el período.</div>
      </div>
    </div>

    <!-- STAGING SECTION (previsualización estilo DTW/Odoo) -->
    <div id="ef-purch-staging-section" style="display:none">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <button id="ef-purch-stg-back" class="ef-btn ef-btn-secondary" style="gap:4px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg> Cancelar
        </button>
        <span style="font-size:16px;font-weight:700;color:#1e3a5f">Previsualización de Importación</span>
        <span style="font-size:12px;color:#64748b;margin-left:4px">Revisa y corrige antes de confirmar</span>
      </div>

      <!-- Header editable -->
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:18px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:#1e3a5f;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">Datos del Encabezado</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px">
          <div><label class="ef-label">Proveedor *</label><input type="text" id="ef-stg-supplier" class="ef-cell-input" style="width:100%"/></div>
          <div><label class="ef-label">No. Factura *</label><input type="text" id="ef-stg-bill-no" class="ef-cell-input" style="width:100%"/></div>
          <div><label class="ef-label">Fecha Factura</label><input type="date" id="ef-stg-bill-date" class="ef-cell-input" style="width:100%"/></div>
          <div><label class="ef-label">Fecha Registro</label><input type="date" id="ef-stg-posting-date" class="ef-cell-input" style="width:100%"/></div>
          <div><label class="ef-label">Moneda</label>
            <select id="ef-stg-currency" class="ef-cell-input" style="width:100%">
              <option value="GTQ">GTQ – Quetzal</option><option value="USD">USD – Dólar</option>
            </select></div>
          <div><label class="ef-label">Tipo de Compra</label>
            <select id="ef-stg-tax-type" class="ef-cell-input" style="width:100%"></select></div>
          <div><label class="ef-label">Tipo FEL</label>
            <select id="ef-stg-tipo" class="ef-cell-input" style="width:100%"></select></div>
        </div>
      </div>

      <!-- Resumen de validación -->
      <div id="ef-stg-summary" style="display:none;margin-bottom:12px;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:600"></div>

      <!-- Grid editable (DTW style) -->
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px">
        <div style="font-size:11px;font-weight:700;color:#1e3a5f;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">
          Líneas de Detalle
          <span id="ef-stg-line-count" style="font-weight:400;color:#64748b;margin-left:8px"></span>
        </div>
        <div style="overflow-x:auto">
          <table class="ef-table" style="min-width:920px;width:100%;table-layout:fixed">
            <thead><tr>
              <th class="ef-th" style="width:32px">#</th>
              <th class="ef-th" style="width:30px;text-align:center" title="Estado">✓</th>
              <th class="ef-th" style="width:120px">Código</th>
              <th class="ef-th" style="min-width:140px">Descripción</th>
              <th class="ef-th" style="width:65px">Cant.</th>
              <th class="ef-th" style="width:105px">Precio Unit.</th>
              <th class="ef-th" style="width:100px">Total</th>
              <th class="ef-th" style="width:145px">Bodega</th>
              <th class="ef-th" style="width:48px;text-align:center" title="Actualizar inventario">Stock</th>
              <th class="ef-th" style="width:28px"></th>
            </tr></thead>
            <tbody id="ef-stg-items-body"></tbody>
          </table>
        </div>
      </div>

      <!-- Errores globales -->
      <div id="ef-stg-errors" style="display:none;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:12px 16px;margin-bottom:14px;font-size:12px;color:#991b1b"></div>

      <!-- Botones de acción -->
      <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;align-items:center">
        <span id="ef-stg-ok-count" style="font-size:12px;color:#64748b;margin-right:auto"></span>
        <button id="ef-purch-stg-revalidate" class="ef-btn ef-btn-secondary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Revalidar
        </button>
        <button id="ef-purch-stg-confirm" class="ef-btn ef-btn-primary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Confirmar e Importar
        </button>
      </div>
    </div>

    <!-- FORM SECTION -->
    <div id="ef-purch-form-section" style="display:none">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">
        <button id="ef-purch-btn-back" class="ef-btn ef-btn-secondary" style="gap:4px">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg> Lista
        </button>
        <span id="ef-purch-form-title" style="font-size:16px;font-weight:700;color:#1e3a5f">Nueva Factura de Compra</span>
        <span id="ef-purch-status-badge" class="ef-badge ef-badge-new"></span>
      </div>

      <!-- Header -->
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:20px;margin-bottom:14px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;">
          <div><label class="ef-label">Proveedor *</label>
            <input type="text" id="ef-purch-supplier" class="ef-cell-input" style="width:100%" placeholder="Buscar proveedor..."/></div>
          <div><label class="ef-label">No. Factura Proveedor *</label>
            <input type="text" id="ef-purch-bill-no" class="ef-cell-input" style="width:100%" placeholder="Ej: 0BFA0640 - 1939096728"/></div>
          <div><label class="ef-label">Fecha Factura Proveedor *</label>
            <input type="date" id="ef-purch-bill-date" class="ef-cell-input" style="width:100%"/></div>
          <div><label class="ef-label">Fecha de Registro</label>
            <input type="date" id="ef-purch-posting-date" class="ef-cell-input" style="width:100%"/></div>
          <div><label class="ef-label">Moneda</label>
            <select id="ef-purch-currency" class="ef-cell-input" style="width:100%">
              <option value="GTQ">GTQ – Quetzal</option><option value="USD">USD – Dólar</option>
            </select></div>
          <div><label class="ef-label">Tipo de Compra</label>
            <select id="ef-purch-tax-type" class="ef-cell-input" style="width:100%"></select></div>
          <div><label class="ef-label">Tipo FEL</label>
            <select id="ef-purch-tipo" class="ef-cell-input" style="width:100%"></select></div>
        </div>
      </div>

      <!-- Items grid -->
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px;">
        <div class="ef-items-header" style="margin-bottom:12px;">
          <span class="ef-section-title">Productos Comprados</span>
          <button id="ef-purch-btn-add-item" class="ef-btn ef-btn-sm ef-btn-secondary">+ Agregar Ítem</button>
        </div>
        <div style="overflow-x:auto">
          <table class="ef-table" style="min-width:960px;width:100%">
            <thead><tr>
              <th class="ef-th" style="width:36px">#</th>
              <th class="ef-th" style="width:120px">Código</th>
              <th class="ef-th">Descripción / Series</th>
              <th class="ef-th" style="width:70px">Cant.</th>
              <th class="ef-th" style="width:70px">UdM</th>
              <th class="ef-th" style="width:110px">Precio Unit.</th>
              <th class="ef-th" style="width:110px">Total</th>
              <th class="ef-th" style="width:155px">Bodega</th>
              <th class="ef-th" style="width:150px">Tipo FEL</th>
              <th class="ef-th" style="width:44px;text-align:center" title="Actualizar Inventario">Stock</th>
              <th class="ef-th" style="width:30px"></th>
            </tr></thead>
            <tbody id="ef-purch-items-body"></tbody>
          </table>
        </div>
        <div id="ef-purch-items-empty" style="padding:24px;text-align:center;color:#94a3b8;font-size:13px">Haz clic en <strong>+ Agregar Ítem</strong> para comenzar.</div>
      </div>

      <!-- Totals -->
      <div style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px;display:flex;justify-content:flex-end;">
        <div style="min-width:260px;">
          <div class="ef-total-row"><span class="ef-total-label">Subtotal</span><span id="ef-purch-subtotal" class="ef-total-value">Q 0.00</span></div>
          <div class="ef-total-row"><span id="ef-purch-tax-label" class="ef-total-label">IVA (12%)</span><span id="ef-purch-tax" class="ef-total-value">Q 0.00</span></div>
          <div class="ef-total-row ef-total-row--grand"><span class="ef-total-label">TOTAL</span><span id="ef-purch-grand" class="ef-total-value ef-grand">Q 0.00</span></div>
        </div>
      </div>

      <!-- Action buttons -->
      <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap;align-items:center;">
        <a id="ef-purch-btn-open-erp" href="#" target="_blank" class="ef-btn ef-btn-secondary" style="display:none;text-decoration:none;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          Abrir ERP
        </a>
        <button id="ef-purch-btn-cancel-doc" class="ef-btn" style="background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5;display:none;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          Cancelar Factura
        </button>
        <button id="ef-purch-btn-save" class="ef-btn ef-btn-secondary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/></svg>
          Guardar Borrador
        </button>
        <button id="ef-purch-btn-submit" class="ef-btn ef-btn-primary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Validar Compra
        </button>
      </div>
    </div>
  </div>

  <!-- ── VIEW 6: TRANSPORTE (Maestros, Documentos, Reportes, KPIs) ──── -->
  <!-- Contenido delegado por completo a FacexTransporteModule (compartido
       con FacEx Screen) — ver _switch_view("transporte") más abajo. -->
  <div id="ef-transporte-view" class="ef-view-content" style="display:none; padding: 24px; max-width: 1200px; margin: 0 auto; font-family: var(--ef-font);">
    <div id="ef-transporte-module-container"></div>
  </div>

</div><!-- ef-main-layout -->
		`);

		// Bind navbar actions
		this.$body.on("click", ".ef-nav-btn", (e) => {
			const $el = $(e.currentTarget);
			const view = $el.attr("data-view");
			if (view === "pos") {
				// Navegación completa (no es un view interno de este page) —
				// recarga limpia de FacEx Screen, sin arrastrar estado de esta
				// sesión de FacEx clásico.
				window.location.href = "/app/facex-screen";
			} else if (view === "inventario") {
				window.location.href = "/app/facex-inventario";
			} else if (view === "billing" && (!this.doc.name || this.doc.name === "new")) {
				this._action_new();
			} else {
				this._switch_view(view, { section: $el.attr("data-transporte-section") });
			}
		});

		// Icono de compañía (navbar): un click lleva siempre al menú principal.
		this.$body.find("#ef-navbar-company-badge").on("click", () => this._switch_view("home"));

		this._bind_main_menu();
	}

	// Menú "Menú" agrupado del navbar — mismo patrón que #efs-menu-panel de
	// FacEx Screen (acordeón + click afuera cierra). Los ítems reutilizan
	// .ef-nav-btn con data-view, así que _switch_view/_apply_perms no
	// necesitan saber si un botón vive suelto en la barra o dentro del panel.
	_bind_main_menu() {
		const $panel = this.$body.find("#ef-menu-panel");

		this.$body.find("#ef-btn-main-menu").on("click", (e) => {
			e.stopPropagation();
			if ($panel.is(":hidden")) $panel.fadeIn(120);
			else $panel.fadeOut(120);
		});

		$panel.find(".ef-menu-group-header").not(".ef-menu-group-header-direct").on("click", (e) => {
			const $group = $(e.currentTarget).closest(".ef-menu-group");
			const wasOpen = $group.hasClass("ef-menu-group-open");
			$panel.find(".ef-menu-group").removeClass("ef-menu-group-open");
			if (!wasOpen) $group.addClass("ef-menu-group-open");
		});

		$(document).on("click.ef_main_menu", (e) => {
			if ($panel.length && !$(e.target).closest("#ef-main-menu").length) {
				$panel.fadeOut(120);
			}
		});
	}

	_switch_view(view, opts = {}) {
		this._current_view = view;

		// Toggle buttons in navbar
		this.$body.find(".ef-nav-btn").removeClass("ef-nav-active");
		this.$body.find(`.ef-nav-btn[data-view="${view}"]`).addClass("ef-nav-active");

		// Cierra el menú "Menú" agrupado (si estaba abierto) y refleja la
		// vista actual en el trigger, para que siga siendo obvio dónde está
		// parado el usuario aunque los botones ya no estén sueltos en la barra.
		const VIEW_LABELS = {
			home: "Inicio", dashboard: "Tablero", billing: "Facturador", reports: "Reportes",
			maintenance: "Mantenimiento", purchase: "Compras", transporte: "Transporte",
		};
		this.$body.find("#ef-menu-trigger-label").text(VIEW_LABELS[view] || "Menú");
		this.$body.find("#ef-menu-panel").hide();
		this.$body.find(".ef-menu-group").removeClass("ef-menu-group-open");

		// Show action bar ONLY for billing view
		if (view === "billing") {
			$(this.wrapper).find("#ef-action-bar").show();
		} else {
			$(this.wrapper).find("#ef-action-bar").hide();
		}

		// Oculta las vistas de nivel superior antes de mostrar la elegida —
		// única línea que necesita conocer #ef-transporte-view, para no tener
		// que repetir un .hide() nuevo en cada rama existente.
		this.$body.find(".ef-view-content").hide();

		// El reloj en vivo de Inicio solo debe correr mientras esa vista esté
		// visible — se detiene al salir, igual que el patrón ya usado en
		// facex_screen.js para su pantalla de bienvenida.
		if (view !== "home" && this._homeClockTimer) {
			clearInterval(this._homeClockTimer);
			this._homeClockTimer = null;
		}

		if (view === "home") {
			this.$body.find("#ef-home-view").show();
			frappe.set_route("facex");
			this._show_home();
		} else if (view === "dashboard") {
			this.$body.find("#ef-dashboard-view").show();
			// Clear URL query params
			frappe.set_route("facex");
			this._load_dashboard_data();
		} else if (view === "billing") {
			this.$body.find("#ef-billing-view").show();
			if (this.doc && this.doc.name && this.doc.name !== "new") {
				frappe.set_route("facex", "", { invoice: this.doc.name });
			} else {
				frappe.set_route("facex");
			}
			this._focus_first_field();
		} else if (view === "reports") {
			this.$body.find("#ef-reports-view").show();
			frappe.set_route("facex", "", { view: "reports" });
			this._load_reports_view();
		} else if (view === "maintenance") {
			this.$body.find("#ef-maintenance-view").show();
			frappe.set_route("facex", "", { view: "maintenance" });
			this._load_maintenance_view();
		} else if (view === "purchase") {
			this.$body.find("#ef-purchase-view").show();
			frappe.set_route("facex", "", { view: "purchase" });
			this._init_purchase_view();
		} else if (view === "transporte") {
			this.$body.find("#ef-transporte-view").show();
			frappe.set_route("facex", "", { view: "transporte" });
			// Ítems del acordeón "Transporte" del menú aéreo saltan directo a su
			// sección (data-transporte-section); sin sección (tarjeta de Inicio,
			// o el propio grupo del menú) cae al hub de tarjetas de siempre.
			const TRANSPORTE_SECTIONS = {
				transportistas: "showTransportistas",
				pendientes: "showPendingGuias",
				guias: "showGuias",
				liquidaciones: "showLiquidaciones",
				reportes: "showReportes",
			};
			const method = TRANSPORTE_SECTIONS[opts.section] || "showHub";
			this._transporte_module()[method]();
		}
	}

	// Transporte (Maestros, Documentos, Reportes, KPIs) vive por completo en
	// FacexTransporteModule (public/js/facex_transporte_module.js),
	// compartido con FacEx Screen — aquí solo se monta una vez dentro del
	// contenedor del tab y se mantiene sincronizado con perms/company.
	// Es un tab de nivel superior igual que Inventario o POS, así que no
	// se le pasa onBack (el módulo no dibuja botón de "volver" en el hub).
	_transporte_module() {
		if (!this._transporteModuleInstance) {
			this._transporteModuleInstance = new FacexTransporteModule({
				$container: this.$body.find("#ef-transporte-module-container"),
				perms: this.perms,
				company: this.defaults.company,
			});
		} else {
			this._transporteModuleInstance.setContext({ perms: this.perms, company: this.defaults.company });
		}
		return this._transporteModuleInstance;
	}

	// Mismas frases (y misma fórmula de "una por día") que _get_daily_motivational_message()
	// en facex_screen.js, para que el mensaje del día sea consistente entre
	// FacEx Clásico y FacEx Screen.
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
		"La sonrisa que ofreces hoy puede ser el mejor regalo para un cliente.",
		"Cada reto de hoy es una oportunidad disfrazada de aprendizaje.",
		"Tu compromiso diario construye la reputación de la empresa.",
		"Un cliente bien atendido siempre regresa.",
		"La honestidad en cada venta genera clientes para toda la vida.",
		"Hoy es el día perfecto para superar tus propias expectativas.",
		"La disciplina de hoy es la libertad de mañana.",
		"Cada tarea bien hecha suma a un gran resultado.",
		"El buen humor multiplica la productividad del equipo.",
		"Escuchar al cliente es el primer paso para servirlo bien.",
		"La empatía transforma una transacción en una relación.",
		"Cada meta cumplida es un paso más cerca del éxito.",
		"Tu profesionalismo deja huella en cada interacción.",
		"La proactividad de hoy evita los problemas de mañana.",
		"Un 'buenos días' sincero puede cambiar el rumbo de un día difícil.",
		"La colaboración hace que los grandes proyectos parezcan sencillos.",
		"Cada minuto bien invertido hoy se multiplica mañana.",
		"La claridad en la comunicación evita malos entendidos.",
		"Aprender algo nuevo cada día te hace mejor profesional.",
		"El respeto mutuo es la base de un gran equipo.",
		"Cada cliente satisfecho es la mejor publicidad que existe.",
		"La perseverancia convierte los obstáculos en logros.",
		"Hoy tienes la oportunidad de hacer algo memorable.",
		"Un ambiente positivo se construye con actitudes positivas.",
		"La responsabilidad de hoy es el reconocimiento de mañana.",
		"Cada 'sí se puede' empieza con una decisión personal.",
		"El buen trato es gratis y su impacto es invaluable.",
		"La curiosidad de aprender más te acerca a la excelencia.",
		"Cada venta es una oportunidad de generar confianza duradera.",
		"Ser amable no cuesta nada y vale mucho.",
		"La gratitud diaria mejora el ambiente de todo el equipo.",
		"Cada día es una página en blanco para escribir un buen resultado.",
		"La energía positiva se contagia — repártela hoy.",
		"El buen ejemplo inspira más que cualquier discurso.",
		"Cada esfuerzo, por pequeño que sea, construye grandes logros.",
		"La confianza se gana con hechos, no con palabras.",
		"Un equipo unido supera cualquier desafío.",
		"Hoy es un buen día para aprender de los errores de ayer.",
		"La paciencia con un cliente difícil siempre da frutos.",
		"Cada detalle cuenta cuando se trata de dar un buen servicio.",
		"La actitud de servicio transforma cualquier trabajo en vocación.",
		"El compromiso con la calidad nunca pasa desapercibido.",
		"Cada meta compartida se logra más rápido en equipo.",
		"La puntualidad es una forma silenciosa de respeto.",
		"Hoy puedes ser la razón por la que alguien sonría.",
		"La resiliencia de hoy forja el carácter de mañana.",
		"Cada cliente merece tu mejor versión, no solo tu atención.",
		"El orden y la organización ahorran tiempo y energía.",
		"La buena comunicación evita el 90% de los problemas.",
		"Cada logro del equipo es motivo de celebración.",
		"Hoy es una nueva oportunidad de dar lo mejor de ti.",
		"La confianza en uno mismo abre puertas inesperadas.",
		"Cada palabra amable puede alegrar el día de otra persona.",
		"El trabajo bien hecho siempre encuentra su reconocimiento.",
		"La flexibilidad ante el cambio es una gran fortaleza.",
		"Cada cliente satisfecho refuerza la confianza en la marca.",
		"El esfuerzo silencioso también construye grandes resultados.",
		"Hoy es un buen momento para agradecer a quien te apoya.",
		"La iniciativa propia abre camino a nuevas oportunidades.",
		"Cada aprendizaje de hoy te prepara para el reto de mañana.",
		"La calidad en el detalle diferencia a los mejores equipos.",
		"Un problema resuelto con calma vale más que uno resuelto con prisa.",
		"Cada venta bien cerrada es el resultado de un buen proceso.",
		"La confianza del cliente se construye con cada interacción honesta.",
		"Hoy puedes marcar la diferencia con solo una buena actitud.",
		"El trabajo en equipo multiplica las capacidades individuales.",
		"Cada nueva idea puede mejorar la forma en que trabajamos.",
		"La constancia vence lo que la intensidad no logra sola.",
		"Un cliente escuchado es un cliente que confía.",
		"Hoy es el momento ideal para dar el siguiente paso.",
		"La calma frente a la presión es una habilidad que se entrena.",
		"Cada acierto de hoy suma experiencia para el futuro.",
		"El buen servicio empieza con una buena disposición.",
		"La transparencia genera confianza duradera.",
		"Cada día que mejoras un poco, te acercas a la excelencia.",
		"El buen ánimo es una decisión, no una casualidad.",
		"Hoy es un gran día para fortalecer una relación con un cliente.",
		"La organización de las tareas facilita alcanzar las metas.",
		"Cada pequeño avance cuenta en el camino al éxito.",
		"La empatía con el equipo fortalece la confianza mutua.",
		"Un buen trato genera clientes leales, no solo ventas.",
		"Hoy puedes convertir un problema en una oportunidad.",
		"La actitud con la que empiezas el día define cómo lo terminas.",
		"Cada esfuerzo consciente construye una mejor versión de ti mismo.",
		"El respeto al tiempo de los demás también es profesionalismo.",
		"La confianza del equipo se construye día a día.",
		"Cada cliente fiel es el resultado de un buen servicio constante.",
		"Hoy es un buen día para escuchar más y hablar menos.",
		"La determinación convierte los sueños en metas alcanzables.",
		"El buen humor en el trabajo hace más ligera cualquier carga.",
		"Cada decisión bien pensada evita muchos problemas después.",
		"La generosidad con el conocimiento hace crecer a todo el equipo.",
		"Hoy tienes la oportunidad de aprender algo que no sabías ayer.",
		"La calidad del servicio se refleja en los detalles más pequeños.",
		"Cada cliente satisfecho recomienda sin que se lo pidas.",
		"El buen liderazgo se demuestra con el ejemplo diario.",
		"Hoy es un buen momento para reconocer el esfuerzo de un compañero.",
		"La paciencia es una herramienta poderosa en la atención al cliente.",
		"Cada tarea cumplida a tiempo genera confianza en el equipo.",
		"El entusiasmo de hoy contagia el ánimo de mañana.",
		"Cada tropiezo es una lección disfrazada de dificultad.",
		"La buena actitud transforma el trabajo rutinario en algo especial.",
		"Hoy puedes ser el motivo por el que el equipo avance más rápido.",
		"La confianza se construye poco a poco, con cada acción correcta.",
		"Cada cliente que regresa confirma que vas por buen camino.",
		"El compromiso silencioso también deja huella.",
		"Hoy es un buen día para dar las gracias sin esperar nada a cambio.",
		"La calidad no es un accidente, es el resultado del esfuerzo diario.",
		"Cada meta lograda merece ser celebrada, aunque sea pequeña.",
		"La disposición a ayudar fortalece cualquier equipo de trabajo.",
		"Hoy puedes sorprender a alguien con un excelente servicio.",
		"La perseverancia es la diferencia entre intentarlo y lograrlo.",
		"Cada buena decisión de hoy facilita el trabajo de mañana.",
		"El respeto y la cortesía nunca pasan de moda.",
		"Hoy es un buen día para ser la mejor versión de ti mismo.",
		"La confianza mutua hace que el trabajo en equipo fluya mejor.",
		"Cada cliente merece sentirse escuchado y valorado.",
		"El esfuerzo constante siempre deja resultados visibles.",
		"Hoy puedes construir una relación de confianza con solo ser honesto.",
		"La buena energía se nota incluso en los días más ocupados.",
		"Cada logro individual fortalece al equipo completo.",
		"La responsabilidad con cada tarea construye una gran reputación.",
		"Hoy es un buen día para simplificar algo que era complicado.",
		"La cortesía en cada llamada o mensaje también es servicio.",
		"Cada aprendizaje compartido hace más fuerte al equipo.",
		"El buen trabajo no necesita anunciarse, se nota solo.",
		"Hoy puedes ser el ejemplo de una gran actitud de servicio.",
		"La confianza del cliente se gana con consistencia, no con promesas.",
		"Cada día trae la oportunidad de hacer las cosas un poco mejor.",
		"El entusiasmo por aprender abre muchas puertas.",
		"Hoy es un buen momento para revisar los detalles con calma.",
		"La generosidad con el tiempo de los demás también cuenta.",
		"Cada cliente atendido con calidez recordará esa experiencia.",
		"La responsabilidad compartida hace más liviana la carga.",
		"Hoy puedes dar un paso más hacia tu mejor versión profesional.",
		"La confianza se refuerza cumpliendo lo que se promete.",
		"Cada pequeño gesto de cortesía construye grandes relaciones.",
		"El buen ánimo del equipo se refleja en la atención al cliente.",
		"Hoy es un buen día para aprender de quienes tienen más experiencia.",
		"La calma y la claridad resuelven más que la prisa.",
		"Cada cliente bien atendido es una inversión en el futuro del negocio.",
		"La actitud de mejora continua nunca pasa de moda.",
		"Hoy puedes fortalecer la confianza de un cliente con solo cumplir tu palabra.",
		"El buen trabajo en equipo convierte metas difíciles en alcanzables.",
		"Cada día es una nueva oportunidad de superarte a ti mismo.",
		"La empatía y el buen servicio siempre van de la mano.",
		"Hoy es un buen momento para celebrar los avances, por pequeños que sean.",
		"La confianza se construye con acciones consistentes, día tras día.",
		"Cada cliente satisfecho es un embajador silencioso de tu trabajo.",
		"Hoy tienes todo lo necesario para hacer un gran trabajo.",
	];

	_get_daily_motivational_message() {
		const list = this._HOME_MOTIVATIONAL_MESSAGES;
		const now = new Date();
		const start = new Date(now.getFullYear(), 0, 0);
		const dayOfYear = Math.floor((now - start) / 86400000);
		return list[dayOfYear % list.length];
	}

	// Pantalla de aterrizaje ("Inicio"): saludo, reloj/fecha en vivo y
	// tarjetas de navegación filtradas por permiso — mismo patrón que
	// _show_home() en facex_screen.js, adaptado a los ef-* tokens y a las
	// vistas internas (_switch_view) de este page.
	_show_home() {
		const fullname = frappe.session.user_fullname || frappe.session.user;
		const company  = this.defaults.company || "";
		this.$body.find("#ef-home-greeting").text(`¡Bienvenido, ${fullname}!`);
		this.$body.find("#ef-home-session").html(
			`Conectado como <strong>${_esc(fullname)}</strong> (${_esc(frappe.session.user)})` +
			(company ? ` — Compañía: <strong>${_esc(company)}</strong>` : "")
		);
		this.$body.find("#ef-home-quote").text(this._get_daily_motivational_message());

		// Logo real de la compañía activa (BFEL Establecimientos.logo /
		// Company.company_logo, resuelto por get_defaults) + logo de CHAPPSA —
		// mismo dato y mismo asset estático que usa el pie de página de
		// facex_screen.js, aquí juntos en el footer en vez de repartidos entre
		// encabezado y esquina flotante.
		const establishments = this.defaults.establishments || [];
		const currentEst = establishments.find((e) => String(e.establecimiento_id) === String(this.doc.bfel_establecimiento)) || establishments[0];
		const companyLogoUrl = currentEst && currentEst.logo ? currentEst.logo : "";
		const currentYear = new Date().getFullYear();
		this.$body.find("#ef-home-footer").html(`
			<div class="ef-home-footer-brand">
				${companyLogoUrl
					? `<img class="ef-home-footer-logo" src="${_esc(companyLogoUrl)}" alt="${_esc(company)}" onerror="this.style.display='none'" />`
					: `<span class="ef-home-footer-logo-fallback">${_esc(company)}</span>`}
			</div>
			<div class="ef-home-footer-sep"></div>
			<div class="ef-home-footer-poweredby">
				<img src="/assets/facex_multi/images/chappsa-logo.png" alt="CHAPPSA" onerror="this.style.display='none'" />
				<span>© ${currentYear} CHAPPSA</span>
			</div>
		`);

		const tick = () => {
			const now = new Date();
			let dateStr = now.toLocaleDateString("es-GT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
			dateStr = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
			const timeStr = now.toLocaleTimeString("es-GT", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
			this.$body.find("#ef-home-date").text(dateStr);
			this.$body.find("#ef-home-time").text(timeStr);
		};
		tick();
		clearInterval(this._homeClockTimer);
		this._homeClockTimer = setInterval(() => {
			if (this._current_view !== "home") { clearInterval(this._homeClockTimer); this._homeClockTimer = null; return; }
			tick();
		}, 1000);

		const p = this.perms || {};
		const icon = (paths) => `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

		const cards = [
			p.puede_ver_tablero && {
				label: "Tablero",
				desc: "KPIs de ventas, facturas recientes y productos más vendidos.",
				icon: icon(`<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>`),
				action: () => this._switch_view("dashboard"),
			},
			p.puede_facturar && {
				label: "Facturar Rápida",
				desc: "Crear y validar facturas con certificación FEL.",
				icon: icon(`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>`),
				action: () => {
					if (!this.doc.name || this.doc.name === "new") this._action_new();
					else this._switch_view("billing");
				},
			},
			this._any_report_access() && {
				label: "Reportes",
				desc: "Ventas, cobros, cotizaciones y estados de cuenta.",
				icon: icon(`<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><path d="M3 20h18"/>`),
				action: () => this._switch_view("reports"),
			},
			p.puede_ver_menu_inventario && {
				label: "Inventario",
				desc: "Entradas, salidas y transferencias de stock.",
				icon: icon(`<path d="M21 8V21H3V8"/><path d="M1 3h22v5H1z"/><line x1="10" y1="12" x2="14" y2="12"/>`),
				action: () => { window.location.href = "/app/facex-inventario"; },
			},
			p.puede_compras && {
				label: "Compras",
				desc: "Registrar y validar facturas de proveedores.",
				icon: icon(`<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>`),
				action: () => this._switch_view("purchase"),
			},
			this._has_transporte_access() && {
				label: "Transporte",
				desc: "Guías, transportistas y liquidaciones de envío.",
				icon: icon(`<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>`),
				action: () => this._switch_view("transporte"),
			},
			p.puede_ver_pos && {
				label: "POS",
				desc: "Punto de venta rápido tipo caja.",
				icon: icon(`<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="14" x2="10" y2="14"/>`),
				action: () => { window.location.href = "/app/facex-screen"; },
			},
			{
				label: "Mantenimiento",
				desc: "Clientes, productos, proveedores y precios.",
				icon: icon(`<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/><circle cx="12" cy="12" r="3"/>`),
				action: () => this._switch_view("maintenance"),
			},
		].filter(Boolean);

		const $cards = this.$body.find("#ef-home-cards");
		$cards.html(cards.map((c, i) => `
			<button class="ef-home-card" data-idx="${i}">
				<div class="ef-home-card-icon">${c.icon}</div>
				<div class="ef-home-card-label">${_esc(c.label)}</div>
				<div class="ef-home-card-desc">${_esc(c.desc)}</div>
			</button>
		`).join(""));
		$cards.find(".ef-home-card").off("click").on("click", (e) => {
			const card = cards[$(e.currentTarget).data("idx")];
			if (card) card.action();
		});
	}

	_setup_dashboard_controls() {
		// Default dates
		const today = frappe.datetime.get_today();
		const start_of_month = frappe.datetime.month_start();
		this.$body.find("#ef-dash-start-date").val(start_of_month);
		this.$body.find("#ef-dash-end-date").val(today);

		// Customer search control
		const $container = this.$body.find("#ef-dash-customer-ctrl");
		if ($container.length && !this.dashboard_customer_ctrl) {
			const get_query_fn = () => {
				const comp = this.doc.company || this.defaults.company || "";
				return {
					or_filters: [
						["bfel_company", "=", comp],
						["bfel_company_null", "=", 0],
					],
				};
			};
			const ctrl = frappe.ui.form.make_control({
				parent: $container[0],
				df: {
					only_select: 1,
					label: "Cliente",
					fieldtype: "Link",
					fieldname: "dashboard_customer",
					options: "Customer",
					reqd: 0,
					only_input: 1,
					get_query: get_query_fn
				},
				render_input: true,
				only_input: false,
			});
			ctrl.get_query = get_query_fn;
			ctrl.refresh();
			this.dashboard_customer_ctrl = ctrl;

			// Handle change
			const _onCustomerChange = () => {
				setTimeout(() => {
					const customer = ctrl.get_value() || "";
					if (customer) {
						this._load_dashboard_data();
					} else {
						this.$body.find("#ef-dash-customer-stats-card").hide();
						this._load_dashboard_data();
					}
				}, 50);
			};
			if (ctrl && ctrl.$input) {
				ctrl.$input.on("change blur awesomplete-selectcomplete", _onCustomerChange);
			}
			ctrl.df.change = _onCustomerChange;
		}

		// Apply and Clear buttons
		this.$body.find("#ef-dash-btn-apply").off("click").on("click", () => {
			this._load_dashboard_data();
		});

		this.$body.find("#ef-dash-btn-clear").off("click").on("click", () => {
			this.$body.find("#ef-dash-start-date").val(start_of_month);
			this.$body.find("#ef-dash-end-date").val(today);
			if (this.dashboard_customer_ctrl) {
				this.dashboard_customer_ctrl.set_value("");
			}
			this.$body.find("#ef-dash-customer-stats-card").hide();
			this._load_dashboard_data();
		});

		this.$body.find("#ef-dash-btn-billing").off("click").on("click", () => {
			this._action_new();
		});

		// Bind the click on customer stat detail button
		this.$body.find("#ef-dash-btn-customer-analysis").off("click").on("click", () => {
			if (this.dashboard_customer_ctrl) {
				const cust = this.dashboard_customer_ctrl.get_value();
				if (cust) {
					this._show_customer_analytics_dialog(cust);
				}
			}
		});
	}

	_load_dashboard_data() {
		const start_date = this.$body.find("#ef-dash-start-date").val();
		const end_date = this.$body.find("#ef-dash-end-date").val();
		const customer = this.dashboard_customer_ctrl ? this.dashboard_customer_ctrl.get_value() : "";

		frappe.call({
			method: "facex_multi.api.invoice.get_dashboard_stats",
			args: {
				start_date: start_date,
				end_date: end_date,
				customer: customer,
				company: this.doc.company || this.defaults.company || ""
			},
			freeze: true,
			freeze_message: "Actualizando tablero...",
			callback: (r) => {
				if (!r.exc && r.message) {
					const data = r.message;
					
					// KPIs
					this.$body.find("#ef-kpi-today-total").text(format_currency(data.today_total, "GTQ"));
					this.$body.find("#ef-kpi-today-count").text(`${data.today_count} facturas`);
					this.$body.find("#ef-kpi-month-total").text(format_currency(data.month_total, "GTQ"));
					this.$body.find("#ef-kpi-month-count").text(`${data.month_count} facturas`);
					this.$body.find("#ef-kpi-draft-total").text(format_currency(data.draft_total, "GTQ"));
					this.$body.find("#ef-kpi-draft-count").text(`${data.draft_count} facturas`);
					this.$body.find("#ef-kpi-fel-processed").text(data.fel_processed);
					this.$body.find("#ef-kpi-fel-pending").text(`${data.fel_pending} pendientes`);

					// Customer specific card
					if (customer && data.customer_stats && data.customer_stats.invoice_count !== undefined) {
						const stats = data.customer_stats;
						this.$body.find("#ef-dash-cust-sales").text(format_currency(stats.total_sales, "GTQ"));
						this.$body.find("#ef-dash-cust-invoices").text(stats.invoice_count);
						this.$body.find("#ef-dash-cust-credit").text(format_currency(stats.credit_limit, "GTQ"));
						this.$body.find("#ef-dash-cust-outstanding").text(format_currency(stats.outstanding_balance, "GTQ"));
						this.$body.find("#ef-dash-customer-stats-card").show();
					} else {
						this.$body.find("#ef-dash-customer-stats-card").hide();
					}

					// Ventas Recientes Table
					const $tbody = this.$body.find("#ef-dash-invoice-tbody");
					$tbody.empty();
					if (data.invoices && data.invoices.length > 0) {
						data.invoices.forEach((inv) => {
							let bfel_badge = "";
							const status = inv.bfel_status || "";
							if (inv.docstatus === 2 || inv.bfel_documento_anulado === 1) {
								bfel_badge = `<span class="ef-badge ef-badge-cancelled" style="background:#fee2e2; color:#991b1b; font-weight: bold;">Anulado Fel</span>`;
							} else if (inv.docstatus === 1 && !inv.bfel_uuid) {
								bfel_badge = `<span class="ef-badge ef-badge-warning" style="background:#ffeaa7; color:#d63031; font-weight: bold;">X CERTIFICAR</span>`;
							} else if (status.includes("Procesada")) {
								bfel_badge = `<span class="ef-badge ef-badge-active" style="background:#d8f3dc; color:#2dc653;">Certificada</span>`;
							} else if (status.includes("Enviar")) {
								bfel_badge = `<span class="ef-badge ef-badge-new" style="background:#ffe3e0; color:#e63946;">Pendiente</span>`;
							} else {
								bfel_badge = `<span class="ef-badge ef-badge-draft" style="background:#e2e8f0; color:#64748b;">No Enviar</span>`;
							}

							const row_html = `
								<tr class="ef-tr-interactive" data-name="${inv.name}" data-customer="${inv.customer}">
									<td class="ef-td"><a class="ef-inv-link" href="#" style="color:var(--ef-primary); font-weight:700; text-decoration:underline;">${inv.name}</a></td>
									<td class="ef-td"><a class="ef-cust-link" href="#" style="color:var(--ef-primary); font-weight:500; text-decoration:underline;">${inv.customer_name || inv.customer}</a></td>
									<td class="ef-td">${inv.posting_date}</td>
									<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700;">${format_currency(inv.grand_total, "GTQ")}</td>
									<td class="ef-td">${bfel_badge}</td>
									<td class="ef-td" style="text-align:right;">
										<button class="ef-btn ef-btn-sm ef-btn-secondary ef-dash-view-inv" data-name="${inv.name}" style="padding:2px 8px; font-size:10px;">Ver</button>
									</td>
								</tr>
							`;
							$tbody.append(row_html);
						});

						// Bind click on customer name to show analytics dialog
						$tbody.off("click", ".ef-cust-link").on("click", ".ef-cust-link", (e) => {
							e.preventDefault();
							e.stopPropagation();
							const customer = $(e.currentTarget).closest("tr").attr("data-customer");
							if (customer) {
								this._show_customer_analytics_dialog(customer);
							}
						});

						// Bind click on invoice name or view button to load invoice in biller
						$tbody.off("click", ".ef-inv-link, .ef-dash-view-inv").on("click", ".ef-inv-link, .ef-dash-view-inv", (e) => {
							e.preventDefault();
							e.stopPropagation();
							const name = $(e.currentTarget).closest("tr").attr("data-name");
							if (name) {
								this.load_invoice(name);
							}
						});
					} else {
						$tbody.append(`<tr><td colspan="6" style="text-align:center; padding:30px; color:var(--ef-text-muted);">No se encontraron facturas en este rango.</td></tr>`);
					}

					// Top Products
					const $products_wrap = this.$body.find("#ef-dash-top-products");
					$products_wrap.empty();
					if (data.items_summary && data.items_summary.length > 0) {
						const max_amount = Math.max(...data.items_summary.map(i => i.amount)) || 1;
						data.items_summary.slice(0, 15).forEach((item) => {
							const percent = Math.min(100, Math.max(8, (item.amount / max_amount) * 100));
							const item_html = `
								<div class="ef-item-progress" style="display:flex; flex-direction:column; gap:4px;">
									<div style="display:flex; justify-content:space-between; font-size:11px;">
										<span style="font-weight:600; color:var(--ef-text); max-width:200px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${item.item_name}">${item.item_name}</span>
										<span style="font-family:monospace; font-weight:700; color:var(--ef-primary);">${format_currency(item.amount, "GTQ")}</span>
									</div>
									<div style="background:#e2e8f0; height:6px; border-radius:3px; overflow:hidden; width:100%;">
										<div style="background:linear-gradient(90deg, #4361ee, #4cc9f0); width:${percent}%; height:100%; border-radius:3px;"></div>
									</div>
									<div style="font-size:9px; color:var(--ef-text-muted); text-align:right; margin-top:-2px;">${item.qty} uds.</div>
								</div>
							`;
							$products_wrap.append(item_html);
						});
					} else {
						$products_wrap.append(`<div style="text-align:center; padding:20px; color:var(--ef-text-muted); font-size:11px;">Sin datos de productos.</div>`);
					}
				}
			}
		});
	}

	// -----------------------------------------------------------------------
	// Styles (inline — no build step needed)
	// -----------------------------------------------------------------------

	_inject_styles() {
		if (document.getElementById("ef-styles")) return;
		const css = `
/* ── FacEx Styles ────────────────────────────────────────────────── */
:root {
  --ef-primary: #4361ee;
  --ef-primary-dark: #3a0ca3;
  --ef-success: #2dc653;
  --ef-warning: #f8961e;
  --ef-danger: #e63946;
  --ef-info: #4cc9f0;
  --ef-bg: #f8f9fb;
  --ef-card: #ffffff;
  --ef-border: #e2e8f0;
  --ef-text: #1e293b;
  --ef-text-muted: #64748b;
  --ef-radius: 8px;
  --ef-shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
  --ef-shadow-lg: 0 10px 25px rgba(0,0,0,.12);
  --ef-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

/* Inicio (landing) */
#ef-home-view { flex: 1; display: flex; align-items: center; justify-content: center; min-height: calc(100vh - 48px); padding: 24px; }
.ef-home-wrap { width: 100%; max-width: 1000px; }
.ef-home-welcome { text-align: center; margin-bottom: 30px; }
.ef-home-greeting { font-size: 26px; font-weight: 800; color: var(--ef-text); letter-spacing: -.3px; }
.ef-home-datetime { margin-top: 8px; font-size: 15px; color: var(--ef-text-muted); font-weight: 600; text-transform: capitalize; }
.ef-home-time-sep { margin: 0 6px; }
.ef-home-session { margin-top: 6px; font-size: 12px; color: var(--ef-text-muted); }
.ef-home-quote {
  max-width: 640px; margin: 0 auto 28px; padding: 14px 20px; text-align: center; font-size: 14px; font-style: italic;
  color: var(--ef-primary); background: #eef2ff; border: 1px solid #c7d2fe; border-radius: var(--ef-radius);
  animation: ef-home-quote-fade .5s ease;
}
@keyframes ef-home-quote-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
.ef-home-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; }
.ef-home-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 10px; text-align: left;
  padding: 24px 20px; border: 1px solid var(--ef-border); border-radius: var(--ef-radius); background: var(--ef-card);
  cursor: pointer; transition: border-color .15s, box-shadow .15s, transform .15s; box-shadow: var(--ef-shadow);
  font-family: var(--ef-font);
}
.ef-home-card:hover { border-color: var(--ef-primary); box-shadow: var(--ef-shadow-lg); transform: translateY(-2px); }
.ef-home-card-icon { color: var(--ef-primary); }
.ef-home-card-label { font-weight: 800; font-size: 16px; color: var(--ef-text); }
.ef-home-card-desc { font-size: 12.5px; color: var(--ef-text-muted); line-height: 1.4; }

.ef-home-footer {
  margin-top: 30px; padding-top: 18px; border-top: 1px solid var(--ef-border);
  display: flex; align-items: center; justify-content: center; gap: 16px; flex-wrap: wrap;
}
.ef-home-footer-brand { display: flex; align-items: center; }
.ef-home-footer-logo { max-height: 40px; width: auto; }
.ef-home-footer-logo-fallback { font-size: 15px; font-weight: 800; color: var(--ef-primary); letter-spacing: -.2px; }
.ef-home-footer-sep { width: 1px; height: 24px; background: var(--ef-border); }
.ef-home-footer-poweredby { display: flex; align-items: center; gap: 8px; }
.ef-home-footer-poweredby img { height: 20px; width: auto; }
.ef-home-footer-poweredby span { font-size: 11px; color: var(--ef-text-muted); font-weight: 600; white-space: nowrap; }

/* Fullscreen Focus Mode */
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

body.facex-fullscreen-mode .ef-main-layout {
  margin-top: 0 !important;
}

.ef-wrapper {
  font-family: var(--ef-font);
  background: var(--ef-bg);
  min-height: 100vh;
  color: var(--ef-text);
  font-size: 13px;
}

/* Header */
.ef-header {
  background: var(--ef-card);
  border-bottom: 1px solid var(--ef-border);
  padding: 16px 20px 12px;
  position: sticky;
  top: 0;
  z-index: 100;
  box-shadow: var(--ef-shadow);
}
.ef-header-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.ef-doc-info { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.ef-doc-name { font-size: 15px; font-weight: 600; color: var(--ef-primary); }

/* Invoice search bar */
.ef-invoice-search { flex: 1; max-width: 360px; min-width: 0; }
.ef-search-wrapper { position: relative; }
.ef-search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--ef-text-muted);
  pointer-events: none;
}
.ef-search-input {
  width: 100%;
  padding: 7px 10px 7px 30px;
  border: 1px solid var(--ef-border);
  border-radius: 6px;
  font-size: 13px;
  color: var(--ef-text);
  background: #f8f9fb;
  box-sizing: border-box;
  font-family: var(--ef-font);
  transition: border-color .15s, background .15s;
}
.ef-search-input:focus {
  outline: none;
  border-color: var(--ef-primary);
  background: #fff;
  box-shadow: 0 0 0 3px rgba(67,97,238,.12);
}
.ef-search-input::placeholder { color: var(--ef-text-muted); font-style: italic; }

/* Brand wrapper + collapse button */
.ef-header-collapsed .ef-btn-collapse svg { transform: rotate(180deg); }
.ef-header-collapsed .ef-hrow, .ef-header-collapsed .ef-sections { display: none !important; }
.ef-header-collapsed { padding-bottom: 10px !important; }
.ef-header-brand { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

/* Total en la tira de identidad: visible siempre, sin bajar hasta el footer */
.ef-header-total { display: flex; flex-direction: column; align-items: flex-end; gap: 0; flex-shrink: 0; }
.ef-header-total-label { font-size: 9.5px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; color: var(--ef-text-muted); }
.ef-header-total-value { font-size: 17px; font-weight: 800; font-variant-numeric: tabular-nums; color: var(--ef-primary-dark); }

.ef-header-title {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.ef-btn-collapse {
  background: none;
  border: 1px solid var(--ef-border);
  border-radius: 6px;
  padding: 5px 7px;
  cursor: pointer;
  color: var(--ef-text-muted);
  display: flex;
  align-items: center;
  transition: all .15s;
  flex-shrink: 0;
}
.ef-btn-collapse:hover { background: #f1f5f9; color: var(--ef-text); border-color: #cbd5e1; }
.ef-btn-collapse svg { transition: transform .25s; }
.ef-header-collapsed .ef-btn-collapse svg { transform: rotate(180deg); }

/* Collapsed state: oculta filas de campos, mantiene top (búsqueda + badge) */
.ef-header-collapsed .ef-hrow { display: none !important; }
.ef-header-collapsed { padding-bottom: 10px !important; }
.ef-title-main {
  font-size: 20px;
  font-weight: 800;
  color: #153375;
  letter-spacing: -0.5px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.ef-bolt { flex-shrink: 0; }
.ef-header-subtitle {
  font-size: 10px;
  font-weight: 600;
  color: #153375;
  letter-spacing: .8px;
  text-transform: uppercase;
  opacity: .7;
}

/* Badge */
.ef-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .5px;
  text-transform: uppercase;
}
.ef-badge-new      { background: #e2e8f0; color: #475569; }
.ef-badge-draft    { background: #dbeafe; color: #1d4ed8; }
.ef-badge-submitted{ background: #dcfce7; color: #166534; }
.ef-badge-certified{ background: #fef3c7; color: #92400e; }
.ef-badge-cancelled{ background: #fee2e2; color: #991b1b; }

/* Compact header rows */
.ef-hrow {
  display: grid;
  gap: 6px 14px;
  align-items: end;
  margin-bottom: 8px;
}
.ef-hrow:last-child { margin-bottom: 0; }

/* Tarjetas colapsables Cliente / Documento / Facturación FEL. Responsive:
   3 columnas en desktop, 2 en tablet, 1 en móvil (ver sección Responsive). */
.ef-sections {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 12px;
  align-items: start;
}
.ef-sec-card {
  background: var(--ef-card);
  border: 1px solid var(--ef-border);
  border-radius: var(--ef-radius);
  box-shadow: var(--ef-shadow);
  overflow: hidden;
}
.ef-sec-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  cursor: pointer;
  user-select: none;
}
.ef-sec-icon {
  width: 24px; height: 24px; border-radius: 6px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--ef-bg); color: var(--ef-primary);
}
.ef-sec-titlewrap { min-width: 0; }
.ef-sec-title { font-size: 12px; font-weight: 700; color: var(--ef-text); }
.ef-sec-summary {
  font-size: 10.5px; color: var(--ef-text-muted); margin-top: 1px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ef-sec-chev { margin-left: auto; flex-shrink: 0; color: var(--ef-text-muted); transition: transform .15s; }
.ef-sec-card.ef-sec-open .ef-sec-chev { transform: rotate(180deg); }
.ef-sec-body { display: none; padding: 2px 12px 12px; border-top: 1px solid var(--ef-border); }
.ef-sec-card.ef-sec-open .ef-sec-body { display: block; padding-top: 10px; }

/* Facturación FEL siempre desplegada: no es un acordeón, es informativa */
.ef-sec-locked .ef-sec-head { cursor: default; }
.ef-sec-locked .ef-sec-chev { display: none; }

/* Mensaje sin ruido antes de certificar FEL (punto 6: campos avanzados
   solo aparecen cuando existe certificación real) */
.ef-fel-pending {
  display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: var(--ef-bg); border-radius: 6px; font-size: 11px; color: var(--ef-text-muted);
}
.ef-fel-pending svg { flex-shrink: 0; }

/* Empareja 2 campos afines en una sola fila para reducir la altura total
   del encabezado (ej. Establecimiento+Serie, Fechas, IDs FEL) */
.ef-field-row2 { display: flex; gap: 10px; }
.ef-field-row2 > .ef-field-group { flex: 1; min-width: 0; }

.ef-field-group { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ef-field-check { display: flex; flex-direction: column; align-items: flex-start; }
/* Toggle switch */
.ef-toggle { display: inline-flex; align-items: center; cursor: pointer; margin-top: 3px; }
.ef-toggle input { display: none; }
.ef-toggle-slider {
  width: 36px; height: 20px; background: #cbd5e1;
  border-radius: 20px; position: relative; transition: background .2s;
}
.ef-toggle-slider::after {
  content: ''; position: absolute; left: 3px; top: 3px;
  width: 14px; height: 14px; background: #fff; border-radius: 50%;
  transition: transform .2s; box-shadow: 0 1px 3px rgba(0,0,0,.2);
}
.ef-toggle input:checked + .ef-toggle-slider { background: var(--ef-primary); }
.ef-toggle input:checked + .ef-toggle-slider::after { transform: translateX(16px); }

.ef-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--ef-text-muted);
  text-transform: uppercase;
  letter-spacing: .4px;
}
.ef-req { color: var(--ef-danger); }

.ef-input, .ef-select, .ef-textarea {
  width: 100%;
  border: 1px solid var(--ef-border);
  border-radius: 5px;
  padding: 6px 9px;
  font-size: 13px;
  color: var(--ef-text);
  background: #fff;
  transition: border-color .15s;
  font-family: var(--ef-font);
  box-sizing: border-box;
}
.ef-input:focus, .ef-select:focus, .ef-textarea:focus {
  outline: none;
  border-color: var(--ef-primary);
  box-shadow: 0 0 0 3px rgba(67,97,238,.12);
}
.ef-input:disabled, .ef-select:disabled, .ef-textarea:disabled {
  background: #f1f5f9 !important;
  color: var(--ef-text-muted) !important;
  cursor: not-allowed;
}
.ef-input-readonly {
  background: #f8f9fa !important;
  color: var(--ef-text-muted) !important;
  cursor: default;
}
.ef-textarea { resize: vertical; min-height: 80px; }
.ef-textarea-sm { min-height: 38px; }
.ef-select { cursor: pointer; }

/* Override Frappe control dentro del header */
.ef-link-ctrl .control-value,
.ef-link-ctrl .form-control,
.ef-link-ctrl input[data-fieldname] {
  border: 1px solid var(--ef-border) !important;
  border-radius: 5px !important;
  padding: 6px 9px !important;
  font-size: 13px !important;
  height: auto !important;
  box-shadow: none !important;
}
.ef-link-ctrl .control-label { display: none !important; }
.ef-link-ctrl .form-group { margin-bottom: 0 !important; }
.ef-link-ctrl .link-btn { top: 6px !important; }
.ef-link-ctrl .clearfix { display: none !important; }

/* Items section */
.ef-items-section {
  background: var(--ef-card);
  margin: 12px 0 0;
  border-top: 1px solid var(--ef-border);
  border-bottom: 1px solid var(--ef-border);
}
.ef-items-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 20px;
  border-bottom: 1px solid var(--ef-border);
}
.ef-section-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .5px;
  color: var(--ef-text-muted);
}

/* Table */
.ef-table-wrapper { overflow-x: auto; -webkit-overflow-scrolling: touch; }
.ef-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.ef-th {
  background: #f1f5f9;
  padding: 8px 10px;
  text-align: left;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .4px;
  color: var(--ef-text-muted);
  border-bottom: 2px solid var(--ef-border);
  white-space: nowrap;
}
.ef-th-idx   { width: 36px; text-align: center; }
.ef-th-item  { width: 160px; }
.ef-th-name  { min-width: 180px; }
.ef-th-wh    { width: 130px; }
.ef-th-qty   { width: 70px; text-align: right; }
.ef-th-rate  { width: 100px; text-align: right; }
.ef-th-disc  { width: 70px; text-align: right; }
.ef-th-amount{ width: 110px; text-align: right; }
.ef-th-adenda{ width: 80px; text-align: center; }
.ef-th-tipo  { width: 58px; text-align: center; }
.ef-th-del   { width: 36px; }
.ef-td-tipo  { text-align: center; padding: 3px 4px; }

.ef-tr {
  border-bottom: 1px solid #f1f5f9;
  transition: background .1s;
}
.ef-tr:hover { background: #fafbff; }
.ef-tr.ef-tr-active { background: #eef2ff; }
.ef-tr.ef-tr-no-stock { border-left: 3px solid #f59e0b; background: rgba(251,191,36,0.07) !important; }
.ef-tr.ef-tr-no-stock.ef-tr-active { background: rgba(251,191,36,0.15) !important; }
.ef-no-stock-badge { display: inline-block; font-size: 10px; font-weight: 700; color: #92400e; background: #fef3c7; border: 1px solid #f59e0b; border-radius: 3px; padding: 0 4px; margin-left: 4px; vertical-align: middle; white-space: nowrap; }

.ef-td {
  padding: 4px 6px;
  vertical-align: middle;
}
.ef-td-idx { text-align: center; color: var(--ef-text-muted); font-size: 11px; }
.ef-td-num { text-align: right; }

/* Cell inputs */
.ef-cell-input {
  width: 100%;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 13px;
  color: var(--ef-text);
  background: transparent;
  font-family: var(--ef-font);
  box-sizing: border-box;
  transition: border-color .12s, background .12s;
}
.ef-cell-input:focus {
  outline: none;
  border-color: var(--ef-primary);
  background: #fff;
  box-shadow: 0 0 0 2px rgba(67,97,238,.12);
}
.ef-cell-input[readonly] {
  color: var(--ef-text-muted);
  cursor: default;
}
.ef-cell-input:disabled {
  color: var(--ef-text-muted);
  cursor: not-allowed;
  background: #f8f9fa;
}
.ef-cell-input.ef-input-num { text-align: right; }

/* Autocomplete dropdown */
.ef-autocomplete {
  position: absolute;
  background: #fff;
  border: 1px solid var(--ef-border);
  border-radius: 6px;
  box-shadow: var(--ef-shadow-lg);
  z-index: 9999;
  min-width: 220px;
  max-height: 240px;
  overflow-y: auto;
  font-size: 13px;
}
.ef-autocomplete-item {
  padding: 7px 12px;
  cursor: pointer;
  transition: background .1s;
  border-bottom: 1px solid #f8fafc;
}
.ef-autocomplete-item:hover,
.ef-autocomplete-item.ef-ac-active {
  background: #eef2ff;
  color: var(--ef-primary);
}
.ef-autocomplete-item .ef-ac-desc {
  font-size: 11px;
  color: var(--ef-text-muted);
  display: block;
}
.ef-autocomplete-item.ef-ac-empty {
  color: var(--ef-text-muted);
  cursor: default;
  font-style: italic;
}

/* Delete button */
.ef-btn-del {
  background: none;
  border: none;
  color: #cbd5e1;
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color .15s, background .15s;
  line-height: 1;
}
.ef-btn-del:hover { color: var(--ef-danger); background: #fee2e2; }

/* Stock popover button */
.ef-btn-stock {
  position: absolute; right: 2px; top: 50%; transform: translateY(-50%);
  background: none; border: none; color: #94a3b8; cursor: pointer;
  font-size: 12px; padding: 1px 4px; border-radius: 3px; line-height: 1;
  transition: color .15s, background .15s; z-index: 1; tabindex: -1;
}
.ef-btn-stock:hover { color: var(--ef-primary); background: #eff6ff; }

/* Item images button */
.ef-btn-image {
  position: absolute; right: 20px; top: 50%; transform: translateY(-50%);
  background: none; border: none; color: #94a3b8; cursor: pointer;
  font-size: 12px; padding: 1px 4px; border-radius: 3px; line-height: 1;
  transition: color .15s, background .15s; z-index: 1; tabindex: -1;
}
.ef-btn-image:hover { color: var(--ef-primary); background: #eff6ff; }
.ef-item-code { padding-right: 58px !important; }

/* Lista de Materiales — botón acordeón */
.ef-btn-lm {
  position: absolute; right: 38px; top: 50%; transform: translateY(-50%);
  background: none; border: none; color: #94a3b8; cursor: pointer;
  font-size: 10px; padding: 1px 4px; border-radius: 3px; line-height: 1;
  transition: color .15s, background .15s, transform .15s; z-index: 1; tabindex: -1;
}
.ef-btn-lm:hover { color: var(--ef-primary); background: #eff6ff; }
.ef-btn-lm-open { color: var(--ef-primary); transform: translateY(-50%) rotate(90deg); }
.ef-tr-lm-detail td.ef-td-lm-detail { padding: 0; border-bottom: 1px solid var(--ef-border); }
.ef-lm-detail-wrap { padding: 10px 16px 12px 44px; background: #f8fafc; }
.ef-lm-detail-note { font-size: 11.5px; color: #64748b; margin-bottom: 6px; }
.ef-lm-detail-loading { padding: 10px 16px 12px 44px; background: #f8fafc; font-size: 12px; color: #94a3b8; }
.ef-lm-detail-table { width: 100%; max-width: 560px; border-collapse: collapse; font-size: 12px; }
.ef-lm-detail-table th { text-align: left; padding: 4px 8px; font-size: 10.5px; color: #64748b; border-bottom: 1px solid var(--ef-border); }
.ef-lm-detail-table td { padding: 4px 8px; border-bottom: 1px solid #eef2f7; }

/* Adenda DIGECAM button */
.ef-th-adenda { width: 80px; text-align: center; }
.ef-td-adenda { text-align: center; padding: 3px 4px; }
.ef-btn-adenda {
  font-size: 10px; font-weight: 600; padding: 2px 6px;
  border-radius: 10px; border: 1px solid; cursor: pointer;
  white-space: nowrap; transition: opacity .15s;
}
.ef-btn-adenda:hover { opacity: .8; }
.ef-adenda-ok {
  background: #dcfce7; color: #16a34a; border-color: #86efac;
}
.ef-adenda-pending {
  background: #fff7ed; color: #c2410c; border-color: #fdba74;
}

/* Stock popover panel */
.ef-stock-popover {
  position: fixed; z-index: 9999;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
  box-shadow: 0 4px 24px rgba(0,0,0,.15);
  min-width: 280px; max-width: 420px; font-size: 12px;
}
.ef-stock-popover-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; border-bottom: 1px solid #f1f5f9;
  font-weight: 600; font-size: 13px; color: #334155;
}
.ef-stock-popover-title { display: flex; flex-direction: column; gap: 1px; }
.ef-stock-popover-title small { font-weight: 400; color: #64748b; font-size: 11px; }
.ef-stock-close {
  background: none; border: none; color: #94a3b8;
  cursor: pointer; font-size: 18px; line-height: 1; padding: 0 2px;
}
.ef-stock-close:hover { color: #ef4444; }
.ef-stock-popover-body { padding: 8px 4px; }
.ef-stock-loading, .ef-stock-empty {
  padding: 16px; text-align: center; color: #94a3b8; font-size: 12px;
}
.ef-stock-table { width: 100%; border-collapse: collapse; }
.ef-stock-table th {
  text-align: left; padding: 4px 10px;
  border-bottom: 1px solid #e2e8f0; color: #64748b;
  font-weight: 600; font-size: 11px; text-transform: uppercase;
}
.ef-stock-table th.ef-stock-qty-h { text-align: right; }
.ef-stock-table td { padding: 5px 10px; border-bottom: 1px solid #f8fafc; }
.ef-stock-qty-v { text-align: right; font-family: monospace; font-weight: 700; }
.ef-stock-row-sel td { background: #f0fdf4; color: #166534; }
.ef-stock-row-sel .ef-stock-qty-v { color: #16a34a; }
.ef-stock-row-warn td { background: #fef2f2; }
.ef-stock-row-warn .ef-stock-qty-v { color: #dc2626; }
.ef-stock-row-low .ef-stock-qty-v { color: #d97706; }
.ef-stock-svc { padding: 14px; text-align: center; color: #64748b; font-style: italic; }

/* Carrete de imágenes de producto */
.ef-img-carousel { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 6px 0; }
.ef-img-stage {
  position: relative; display: flex; align-items: center; justify-content: center;
  width: 100%; min-height: 320px; background: #0f172a0d; border-radius: 10px; padding: 10px;
}
.ef-img-main-link { display: block; max-width: 100%; }
.ef-img-main {
  max-width: 100%; max-height: 380px; object-fit: contain;
  border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.12); background: #fff;
}
.ef-img-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  background: rgba(15,23,42,.55); color: #fff; border: none; width: 34px; height: 34px;
  border-radius: 50%; font-size: 15px; cursor: pointer; z-index: 2;
  display: flex; align-items: center; justify-content: center; transition: background .15s;
}
.ef-img-nav:hover { background: rgba(15,23,42,.8); }
.ef-img-prev { left: 8px; }
.ef-img-next { right: 8px; }
.ef-img-remove-main {
  position: absolute; top: 6px; right: 6px; width: 26px; height: 26px; border-radius: 50%;
  border: none; background: #ef4444; color: #fff; font-size: 14px; cursor: pointer;
  box-shadow: 0 1px 3px rgba(0,0,0,.3); z-index: 3;
}
.ef-img-caption { font-size: 12px; color: #64748b; text-align: center; }
.ef-img-thumbs {
  display: flex; gap: 8px; overflow-x: auto; max-width: 100%; padding: 4px 2px;
}
.ef-img-thumb {
  width: 56px; height: 56px; object-fit: cover; border-radius: 6px; cursor: pointer;
  border: 2px solid transparent; opacity: .65; transition: opacity .15s, border-color .15s; flex-shrink: 0;
}
.ef-img-thumb:hover { opacity: 1; }
.ef-img-thumb-active { opacity: 1; border-color: var(--ef-primary); }

/* Empty state */
.ef-empty-state {
  padding: 40px;
  text-align: center;
  color: var(--ef-text-muted);
}

/* Footer totals */
.ef-footer {
  background: var(--ef-card);
  border-top: 2px solid var(--ef-border);
  padding: 16px 20px;
}
.ef-footer-inner { display: flex; justify-content: space-between; align-items: flex-start; }
.ef-footer-pay-status {
  display: flex; flex-direction: column; gap: 6px;
  padding-right: 24px; border-right: 1px solid var(--ef-border);
  margin-right: 24px; min-width: 160px;
}
.ef-totals { min-width: 320px; }
.ef-total-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid #f1f5f9;
}
.ef-total-row--grand {
  border-bottom: 2px solid var(--ef-border);
  padding: 8px 0;
  margin-top: 2px;
}
.ef-total-label { color: var(--ef-text-muted); font-size: 12px; font-weight: 500; }
.ef-total-value { font-family: "SF Mono", "Consolas", monospace; font-size: 14px; }
.ef-total-discount { color: var(--ef-danger); }
.ef-grand { font-size: 22px; font-weight: 700; color: var(--ef-primary); }
.ef-total-row--grand .ef-total-label { font-size: 14px; font-weight: 700; color: var(--ef-text); }
.ef-words-row { margin-top: 6px; }
.ef-words { font-size: 11px; color: var(--ef-text-muted); font-style: italic; }

/* ── Action Bar ─────────────────────────── */
.ef-action-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  min-height: 64px;
  background: #fff;
  border-top: 1px solid var(--ef-border);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 20px;
  z-index: 1050;
  box-shadow: 0 -4px 20px rgba(0,0,0,.08);
  flex-wrap: wrap;
}

/* Buttons */
.ef-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  border-radius: 6px;
  padding: 9px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all .15s;
  font-family: var(--ef-font);
  white-space: nowrap;
}
.ef-btn:disabled {
  opacity: .38;
  cursor: not-allowed;
  pointer-events: none;
}
.ef-btn-sm { padding: 5px 12px; font-size: 12px; }

.ef-btn-primary   { background: var(--ef-primary); color: #fff; }
.ef-btn-primary:hover   { background: var(--ef-primary-dark); }

.ef-btn-success   { background: var(--ef-success); color: #fff; }
.ef-btn-success:hover   { background: #21a547; }

.ef-btn-warning   { background: var(--ef-warning); color: #fff; }
.ef-btn-warning:hover   { background: #e07e0c; }

.ef-btn-info      { background: var(--ef-info); color: #fff; }
.ef-btn-info:hover      { background: #29a8d4; }

.ef-btn-secondary { background: #f1f5f9; color: var(--ef-text); border: 1px solid var(--ef-border); }
.ef-btn-secondary:hover { background: #e2e8f0; }

.ef-btn-light     { background: #f8fafc; color: var(--ef-text); border: 1px solid var(--ef-border); }
.ef-btn-light:hover     { background: #e2e8f0; }

.ef-btn-danger    { background: var(--ef-danger); color: #fff; }
.ef-btn-danger:hover    { background: #c1121f; }

.ef-btn-teal      { background: #0d9488; color: #fff; }
.ef-btn-teal:hover      { background: #0b7a70; }

.ef-contra-entrega-note {
  background: #f0fdfa;
  border: 1px solid #99f6e4;
  color: #0f766e;
  font-size: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 10px;
}

.ef-btn-link {
  background: none;
  border: none;
  color: var(--ef-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  padding: 4px 0;
}
.ef-btn-link:hover { text-decoration: underline; }

.ef-empty-hint {
  padding: 14px;
  text-align: center;
  color: var(--ef-text-muted);
  font-size: 13px;
}

/* Diálogo "Guía de Transporte" — filas dinámicas */
.ef-guias-hint {
  font-size: 12px;
  color: var(--ef-text-muted);
  margin-bottom: 10px;
}
.ef-guias-rows { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
.ef-guia-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr .7fr 1.1fr 1fr auto;
  gap: 8px;
  align-items: center;
}
.ef-guia-row select,
.ef-guia-row input {
  padding: 7px 9px;
  border: 1px solid var(--ef-border);
  border-radius: 6px;
  font-size: 13px;
  font-family: var(--ef-font);
  width: 100%;
}
.ef-guia-row .ef-line-remove {
  background: none;
  border: none;
  color: var(--ef-danger);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  padding: 4px 8px;
}

/* Dirty pulse on save button */
@keyframes ef-pulse {
  from { box-shadow: 0 0 0 0 rgba(248,150,30,.5); }
  to   { box-shadow: 0 0 0 7px rgba(248,150,30,0); }
}
.ef-btn-save-dirty {
  background: var(--ef-warning) !important;
  animation: ef-pulse .9s ease-in-out infinite;
}

/* Keyboard shortcut badges inside buttons */
.ef-kbd {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(0,0,0,0.18);
  color: inherit;
  font-family: monospace;
  letter-spacing: .5px;
  pointer-events: none;
  opacity: .9;
}

/* Spinner overlay */
.ef-loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(255,255,255,.5);
  z-index: 9998;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* FEL info badge in footer */
.ef-fel-info {
  margin-top: 10px;
  padding: 8px 12px;
  background: #f0fdf4;
  border: 1px solid #bbf7d0;
  border-radius: 6px;
  font-size: 11px;
  color: #166534;
  display: none;
}
.ef-fel-info.ef-visible { display: block; }

/* Responsive */
@media (max-width: 900px) {
  .ef-hrow { grid-template-columns: repeat(2, 1fr) !important; }
  .ef-sections { grid-template-columns: 1fr 1fr; gap: 10px; }
  .ef-sec-card:nth-child(3) { grid-column: 1 / -1; }
  .ef-table { font-size: 12px; }
  .ef-totals { min-width: 280px; }
}
@media (max-width: 600px) {
  .ef-header { padding: 10px 12px 8px; }
  .ef-hrow { grid-template-columns: 1fr !important; gap: 8px 0; }
  .ef-sections { grid-template-columns: 1fr; gap: 8px; }
  .ef-sec-card:nth-child(3) { grid-column: auto; }
  .ef-field-row2 { gap: 8px; }
  .ef-header-total { order: 4; width: 100%; align-items: flex-start; margin-top: 4px; }
  .ef-items-header { padding: 8px 12px; }
  .ef-action-bar { gap: 5px; padding: 6px 8px; justify-content: center; }
  .ef-btn { padding: 8px 10px; font-size: 12px; gap: 4px; }
  .ef-btn .ef-btn-label { display: none; }
  .ef-btn .ef-kbd { display: none; }
  .ef-footer { padding: 12px; }
  .ef-footer-inner { justify-content: center; }
  .ef-totals { min-width: 100%; }
  .ef-grand { font-size: 18px; }
  /* Search bar baja a su propia fila en móvil */
  .ef-header-top { flex-wrap: wrap; }
  .ef-doc-info { flex: 1; }
  .ef-invoice-search { order: 3; flex: 0 0 100%; max-width: 100%; }
  .ef-header-brand { flex-shrink: 0; }
}
@media (max-width: 480px) {
  .ef-col-disc { display: none; }
  .ef-title-main { font-size: 16px; }
  /* En pantallas muy angostas, campos emparejados vuelven a apilarse
     (ej. fechas, IDs FEL) para que no queden ilegibles */
  .ef-field-row2 { flex-direction: column; gap: 6px; }
}

/* ── Tabs ──────────────────────────────────────────────────────── */
.ef-tabs-nav {
  display: flex;
  background: var(--ef-card);
  border-bottom: 2px solid var(--ef-border);
  padding: 0 20px;
  gap: 0;
  position: sticky;
  top: 0;
  z-index: 90;
}
.ef-tab-btn {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -2px;
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ef-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color .15s, border-color .15s;
  font-family: var(--ef-font);
}
.ef-tab-btn:hover { color: var(--ef-text); }
.ef-tab-btn.ef-tab-active {
  color: var(--ef-primary);
  border-bottom-color: var(--ef-primary);
}
.ef-tab-btn.ef-tab-disabled {
  color: #cbd5e1 !important;
  cursor: not-allowed;
  opacity: .45;
  pointer-events: none;
}
.ef-tab-content { display: block; }

/* ── Payments ──────────────────────────────────────────────────── */
.ef-payments-section { background: var(--ef-card); }
.ef-payments-header {
  display: flex;
  justify-content: flex-end;
  align-items: flex-start;
  padding: 16px 20px;
  border-bottom: 1px solid var(--ef-border);
  gap: 20px;
  flex-wrap: wrap;
  background: var(--ef-card);
}
.ef-pagado-toggle { display: flex; align-items: center; gap: 10px; }
.ef-pagado-status {
  font-size: 12px; font-weight: 700;
  padding: 2px 10px; border-radius: 20px;
}
.ef-pagado-pending { background: #fef3c7; color: #92400e; }
.ef-pagado-done    { background: #dcfce7; color: #166534; }
.ef-pay-summary { display: flex; flex-direction: column; gap: 4px; text-align: right; font-size: 13px; }
.ef-pay-row { display: flex; justify-content: flex-end; gap: 12px; }
.ef-pay-balance-row { font-size: 15px; font-weight: 700; margin-top: 4px; }
.ef-payments-table-wrap { padding: 0; }
.ef-payments-actions {
  padding: 16px 20px;
  border-top: 1px solid var(--ef-border);
  background: var(--ef-card);
}

/* ── Analytics ─────────────────────────────────────────────────── */
.ef-analytics-section { min-height: 300px; background: var(--ef-bg); }
.ef-analytics-placeholder {
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  min-height: 300px; color: var(--ef-text-muted); gap: 12px; padding: 40px;
}
.ef-stat-card {
  background: var(--ef-card); border: 1px solid var(--ef-border);
  border-radius: var(--ef-radius); padding: 16px; text-align: center;
}
.ef-stat-label {
  font-size: 11px; font-weight: 600; color: var(--ef-text-muted);
  text-transform: uppercase; letter-spacing: .4px; margin-bottom: 8px;
}
.ef-stat-value { font-size: 20px; font-weight: 800; color: var(--ef-primary); }
.ef-analytics-card {
  background: var(--ef-card); border: 1px solid var(--ef-border);
  border-radius: var(--ef-radius); overflow: hidden;
}
.ef-analytics-card-title {
  font-size: 12px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .5px; color: var(--ef-text-muted);
  padding: 10px 12px; border-bottom: 1px solid var(--ef-border); background: #f8f9fb;
}
.ef-inv-row:hover { background: #f8f9fb; }

/* ── Customer dialog search ────────────────────────────────────── */
.ef-cust-result {
  padding: 6px 10px; cursor: pointer; border-radius: 4px;
  display: flex; justify-content: space-between; align-items: center;
  transition: background .1s;
}
.ef-cust-result:hover { background: #f1f5f9; }

/* ── Navbar superior ────────────────────────────────────────────── */
/* Solo quedan 2-3 elementos en la barra (Inicio, botón Menú, usuario) —
   las 8 vistas antes desplegadas en botones planos ahora viven agrupadas
   dentro de #ef-menu-panel (ver bloque "Menú principal agrupado" abajo).
   flex-wrap se conserva como red de seguridad ante nombres de compañía
   largos u otros elementos que empujen el ancho disponible. */
.ef-navbar-top {
  display: flex;
  flex-wrap: wrap;
  row-gap: 8px;
  justify-content: space-between;
  align-items: center;
  background: var(--ef-card);
  border-bottom: 1px solid var(--ef-border);
  padding: 10px 24px;
  position: sticky;
  top: 0;
  z-index: 1010;
  box-shadow: var(--ef-shadow);
}
.ef-navbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 800;
  color: #153375;
  flex-shrink: 0;
}
.ef-navbar-menu {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  justify-content: flex-end;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
}
.ef-nav-btn {
  background: none;
  border: none;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ef-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  white-space: nowrap;
  transition: all 0.15s;
}
.ef-nav-btn:hover {
  background: #f1f5f9;
  color: var(--ef-text);
}
.ef-nav-btn.ef-nav-active {
  background: #eef2ff;
  color: var(--ef-primary);
}
@media (max-width: 1150px) {
  .ef-navbar-top { justify-content: center; }
  .ef-navbar-menu { justify-content: center; width: 100%; }
}
@media (max-width: 620px) {
  .ef-nav-btn span { display: none; }
  .ef-nav-btn { padding: 8px 10px; }
}

/* ── Menú principal agrupado (mismo patrón que #efs-menu-panel de FacEx
   Screen) — acordeón con grupos, un solo trigger en vez de 8 botones
   planos que competían por ancho en la barra superior. ────────────── */
.ef-main-menu { position: relative; display: flex; align-items: center; }
.ef-menu-trigger {
  display: inline-flex; align-items: center; gap: 7px; background: none; border: 1px solid var(--ef-border);
  color: var(--ef-text); cursor: pointer; font-size: 13px; font-weight: 600; padding: 8px 14px; border-radius: 8px;
}
.ef-menu-trigger:hover { background: #f1f5f9; }
.ef-menu-panel {
  position: absolute; top: 120%; left: 0; background: var(--ef-card); border: 1px solid var(--ef-border);
  box-shadow: 0 10px 25px rgba(0,0,0,.15); border-radius: 10px; padding: 6px;
  min-width: 260px; max-width: 90vw; max-height: calc(100vh - 80px); overflow-y: auto; z-index: 1001;
}
.ef-menu-group + .ef-menu-group { border-top: 1px solid var(--ef-border); margin-top: 2px; padding-top: 2px; }
.ef-menu-group-header {
  width: 100%; display: flex; align-items: center; gap: 10px; background: none; border: none; cursor: pointer;
  padding: 10px 8px; border-radius: 6px; font-size: 13px; font-weight: 700; color: var(--ef-text); text-align: left;
}
.ef-menu-group-header:hover { background: #f1f5f9; }
.ef-menu-group-icon { display: inline-flex; color: var(--ef-primary); }
.ef-menu-group-label { flex: 1; }
.ef-menu-chevron { color: var(--ef-text-muted); transition: transform .15s; flex-shrink: 0; }
.ef-menu-group-open > .ef-menu-group-header .ef-menu-chevron { transform: rotate(180deg); }
.ef-menu-group-items { display: none; flex-direction: column; padding: 2px 4px 6px 30px; }
.ef-menu-group-open > .ef-menu-group-items { display: flex; }
.ef-menu-item {
  display: flex; align-items: center; gap: 8px; background: none; border: none; cursor: pointer;
  padding: 8px; border-radius: 6px; font-size: 13px; color: var(--ef-text); text-align: left; width: 100%;
}
.ef-menu-item:hover { background: #f1f5f9; }
.ef-menu-item.ef-nav-active { background: #eef2ff; color: var(--ef-primary); font-weight: 700; }
.ef-menu-item-label { flex: 1; }

/* ── Dashboard & Progress Bars ───────────────────────────────────── */
.ef-progress-bar-container {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}
.ef-progress-bar-label {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.ef-progress-bar-bg {
  height: 8px;
  background: #e2e8f0;
  border-radius: 4px;
  overflow: hidden;
}
.ef-progress-bar-fill {
  height: 100%;
  background: var(--ef-primary);
  border-radius: 4px;
  transition: width 0.3s ease;
}

/* Dashboard Styles */
.ef-stat-card {
  background: var(--ef-card);
  border: 1px solid var(--ef-border);
  border-radius: 12px;
  padding: 18px 24px;
  box-shadow: var(--ef-shadow);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  
}

.ef-stat-label {
  font-size: 11px;
  text-transform: uppercase;
  color: var(--ef-text-muted);
  font-weight: 700;
  letter-spacing: 0.5px;
}
.ef-stat-value {
  font-size: 24px;
  font-weight: 800;
  color: var(--ef-text);
  margin-top: 4px;
}
.ef-analytics-card {
  background: var(--ef-card);
  border: 1px solid var(--ef-border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: var(--ef-shadow);
}
.ef-analytics-card-title {
  padding: 16px 20px;
  background: #fafbfd;
  border-bottom: 1px solid var(--ef-border);
  font-size: 13px;
  font-weight: 700;
  color: var(--ef-text);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.ef-tr-interactive {
  cursor: pointer;
  transition: background 0.15s ease;
}
.ef-tr-interactive:hover {
  background: #f8fafc;
}

/* ── Reports Portal Styles ────────────────────────────────────────── */
.ef-report-nav-btn {
  background: transparent;
  border: none;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ef-text-muted);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  transition: all 0.2s ease;
  width: 100%;
}
.ef-report-nav-btn:hover {
  background: #f1f5f9;
  color: var(--ef-primary);
}
.ef-report-nav-btn.ef-report-nav-active {
  background: #eff6ff;
  color: var(--ef-primary);
  border-left: 3px solid var(--ef-primary);
  border-radius: 0 6px 6px 0;
  padding-left: 11px;
}
.ef-report-group {
  display: flex;
  flex-direction: column;
  gap: 0;
}
.ef-report-group-header {
  background: transparent;
  border: none;
  padding: 8px 10px;
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--ef-text-muted);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  transition: background 0.15s ease, color 0.15s ease;
  margin-top: 4px;
}
.ef-report-group-header:hover {
  background: #f1f5f9;
  color: var(--ef-primary);
}
.ef-report-group-header .ef-group-chevron {
  margin-left: auto;
  transition: transform 0.2s ease;
}
.ef-report-group-header.ef-group-collapsed .ef-group-chevron {
  transform: rotate(-90deg);
}
.ef-report-group-items {
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow: hidden;
  transition: max-height 0.2s ease;
}
.ef-report-group-items.ef-group-hidden {
  display: none;
}
.ef-report-group-items .ef-report-nav-btn {
  padding-left: 28px;
  font-size: 12px;
}

/* Fix long dropdown cut-off */
.awesomplete > ul, .awesomplete ul, .link-select-container ul {
  max-height: 250px !important;
  overflow-y: auto !important;
  z-index: 999999 !important;
}
		`;
		$("<style>").attr("id", "ef-styles").html(css).appendTo("head");
	}

	// -----------------------------------------------------------------------
	// Header Controls (Frappe ControlLink)
	// -----------------------------------------------------------------------

	_setup_header_controls() {
		// Establecimiento <select>
		const $est = this.$body.find("#ef-establecimiento");
		$est.empty();
		$est.append(`<option value="">-- Seleccionar Establecimiento --</option>`);
		const establishments = this.defaults.establishments || [];
		establishments.forEach((e) => {
			$est.append(`<option value="${e.establecimiento_id}">${e.establecimiento_id} - ${e.nombre_establecimiento}</option>`);
		});
		$est.on("change", () => {
			this.doc.bfel_establecimiento = $est.val();
			this._mark_dirty();
			this._load_naming_series_for_selected_establishment();
		});

		// Naming series <select>
		const $ns = this.$body.find("#ef-naming-series");
		$ns.on("change", () => {
			this.doc.naming_series = $ns.val();
			this._mark_dirty();
		});

		// Link fields vía Frappe ControlLink
		this._make_link_ctrl("customer", "Customer", true);
		this._make_link_ctrl("payment_terms_template", "Payment Terms Template", false);
		this._make_link_ctrl("taxes_and_charges", "Sales Taxes and Charges Template", false);
		this._make_link_ctrl("sales_partner", "Sales Partner", false);

		// Fecha de emisión
		this.$body.find("#ef-posting-date").on("change", (e) => {
			this.doc.posting_date = e.target.value;
			if (this.doc.payment_terms_template) {
				this._on_payment_terms_change(this.doc.payment_terms_template);
			} else {
				if (this.doc.due_date && this.doc.due_date < this.doc.posting_date) {
					this.doc.due_date = this.doc.posting_date;
					this.$body.find("#ef-due-date").val(this.doc.due_date);
				}
			}
			this._mark_dirty();
		});

		// Fecha vencimiento
		this.$body.find("#ef-due-date").on("change", (e) => {
			const val = e.target.value;
			if (val && this.doc.posting_date && val < this.doc.posting_date) {
				frappe.show_alert({
					message: "La fecha de vencimiento no puede ser anterior a la fecha de emisión.",
					indicator: "orange"
				});
				this.doc.due_date = this.doc.posting_date;
				this.$body.find("#ef-due-date").val(this.doc.due_date);
			} else {
				this.doc.due_date = val;
			}
			this._mark_dirty();
		});

		// Identificación (FEL): NIT / CUI / PASAPORTE / CF
		this.$body.find("#ef-bfel-identificacion").on("change", (e) => {
			this.doc.bfel_identificacion = e.target.value;
			this._mark_dirty();
			this._lookup_bfel_identificacion_name(this.$body.find("#ef-bfel-nit").val());
		});

		// ID Receptor (FEL)
		this.$body.find("#ef-bfel-nit").on("change input", (e) => {
			this.doc.bfel_nit = e.target.value;
			this._mark_dirty();
		});
		this.$body.find("#ef-bfel-nit").on("change", (e) => {
			this._lookup_bfel_identificacion_name(e.target.value);
		});

		// Nombre para factura
		this.$body.find("#ef-bfel-nombre").on("change input", (e) => {
			this.doc.bfel_nombre = e.target.value;
			this._mark_dirty();
		});

		// bfel_status
		this.$body.find("#ef-bfel-status").on("change", (e) => {
			this.doc.bfel_status = e.target.value;
			this._mark_dirty();
		});

		// bfel_escenario_exento
		this.$body.find("#ef-bfel-escenario-exento").on("change", (e) => {
			this.doc.bfel_escenario_exento = e.target.value;
			this._mark_dirty();
		});

		// Terms
		this.$body.find("#ef-terms").on("change input", (e) => {
			this.doc.terms = e.target.value;
			this._mark_dirty();
		});

	}

	_load_naming_series_for_selected_establishment(callback) {
		const comp = this.doc.company || this.defaults.company || "";
		const est = this.$body.find("#ef-establecimiento").val();
		if (!comp || !est) {
			const $ns = this.$body.find("#ef-naming-series");
			$ns.empty();
			this.doc.naming_series = "";
			if (callback) callback();
			return;
		}

		frappe.call({
			method: "facex_multi.api.invoice.get_compatible_series",
			args: { company: comp, establecimiento: est },
			callback: (r) => {
				const series = r.message || [];
				const $ns = this.$body.find("#ef-naming-series");
				$ns.empty();
				series.forEach((s) => $ns.append(`<option value="${s}">${s}</option>`));
				
				// Mantener la serie actual si es válida para este establecimiento, sino elegir la primera
				if (this.doc.naming_series && series.includes(this.doc.naming_series)) {
					$ns.val(this.doc.naming_series);
				} else {
					const first_val = series[0] || "";
					$ns.val(first_val);
					this.doc.naming_series = first_val;
				}
				if (callback) callback();
			}
		});
	}

	_make_link_ctrl(fieldname, options_doctype, required) {
		const $container = this.$body.find(`[data-ctrl="${fieldname}"]`);
		if (!$container.length) return;

		const get_query_fn = () => {
			const comp = this.doc.company || this.defaults.company || "";
			if (options_doctype === "Customer" || options_doctype === "Sales Partner") {
				return {
					or_filters: [
						["bfel_company", "=", comp],
						["bfel_company_null", "=", 0],
					],
				};
			} else if (options_doctype === "Sales Taxes and Charges Template") {
				return {
					filters: {
						company: comp
					}
				};
			} else if (options_doctype === "Warehouse") {
				return {
					filters: {
						company: comp
					}
				};
			}
			return {};
		};

		const ctrl = frappe.ui.form.make_control({
			parent: $container[0],
			df: {
					only_select: 1,
				label: fieldname,
				fieldtype: "Link",
				fieldname: fieldname,
				options: options_doctype,
				reqd: required ? 1 : 0,
				in_list_view: 0,
				only_input: options_doctype === "Customer" ? 1 : 0,
				get_query: get_query_fn
			},
			render_input: true,
			only_input: false,
		});
		ctrl.get_query = get_query_fn;
		ctrl.refresh();
		this.controls[fieldname] = ctrl;

		const _onCtrlChange = () => {
			setTimeout(() => {
				const val = ctrl.get_value() || "";
				if (this.doc[fieldname] === val) return;
				this.doc[fieldname] = val;
				if (fieldname === "customer") this._on_customer_change(val);
				if (fieldname === "payment_terms_template") this._on_payment_terms_change(val);
				if (fieldname === "taxes_and_charges") this._on_taxes_change(val);
				if (fieldname === "sales_partner") this._sales_partner_is_default = false;
				this._mark_dirty();
			}, 50);
		};
		if (ctrl && ctrl.$input) {
			ctrl.$input.on("change blur awesomplete-selectcomplete", _onCtrlChange);
		}
		ctrl.df.change = _onCtrlChange;
	}

	// Consulta el nombre registrado para el ID Receptor ingresado (BFEL Settings ->
	// url_retorna_cliente para NIT, url_retorna_cui para CUI; solo aplica si el
	// certificador es Grupo CDS) y lo asigna automáticamente en "Nombre para Factura".
	// PASAPORTE y CF no tienen consulta automática.
	_lookup_bfel_identificacion_name(identificacion) {
		identificacion = (identificacion || "").trim();
		const tipo = this.$body.find("#ef-bfel-identificacion").val();
		if (!identificacion || (tipo !== "NIT" && tipo !== "CUI")) return;

		frappe.call({
			method: "facex_multi.api.customer.lookup_identificacion_name",
			args: { identificacion, tipo, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				const res = r.message || {};
				if (res.found && res.customer_name) {
					this.doc.bfel_nombre = res.customer_name;
					this.$body.find("#ef-bfel-nombre").val(res.customer_name);
					this._mark_dirty();
				}
			}
		});
	}

	_on_customer_change(customer) {

		if (!customer) {
			this.doc.customer_name = "";
			this.doc.bfel_nombre = "";
			this.doc.sales_partner = "";
			this._sales_partner_is_default = true;
			this.doc.bfel_identificacion = "";
			this.$body.find("#ef-customer-name").val("");
			this.$body.find("#ef-bfel-nombre").val("");
			this.$body.find("#ef-bfel-identificacion").val("");
			if (this.controls.sales_partner) this.controls.sales_partner.set_value("");
			this._update_header_sections();
			return;
		}
		frappe.call({
			method: "frappe.client.get_value",
			args: {
				doctype: "Customer",
				filters: { name: customer },
				fieldname: ["tax_id", "bfel_id_receptor", "bfel_identificacion", "payment_terms", "customer_name", "default_sales_partner", "default_price_list"],
			},
			callback: (r) => {
				if (!r.exc && r.message) {
					const cname = r.message.customer_name || customer;
					this.doc.customer_name = cname;

					// Actualizar siempre "Nombre para Factura" al cambiar/seleccionar cliente
					this.doc.bfel_nombre = cname;
					this.$body.find("#ef-bfel-nombre").val(cname);

					if (r.message.default_price_list) {
						this.doc.selling_price_list = r.message.default_price_list;
					}

					this.doc.bfel_identificacion = r.message.bfel_identificacion || "";
					this.$body.find("#ef-bfel-identificacion").val(this.doc.bfel_identificacion);

					const nit = r.message.bfel_id_receptor || r.message.tax_id;
					if (nit) {
						this.doc.bfel_nit = nit;
						this.$body.find("#ef-bfel-nit").val(nit);
					}

					if (r.message.payment_terms && !this.doc.payment_terms_template) {
						this.doc.payment_terms_template = r.message.payment_terms;
						if (this.controls.payment_terms_template) {
							this.controls.payment_terms_template.set_value(r.message.payment_terms);
						}
						this._on_payment_terms_change(r.message.payment_terms);
					}

					if (r.message.default_sales_partner && (!this.doc.sales_partner || this._sales_partner_is_default)) {
						this.doc.sales_partner = r.message.default_sales_partner;
						this._sales_partner_is_default = true;
						if (this.controls.sales_partner) {
							this.controls.sales_partner.set_value(r.message.default_sales_partner);
						}
					}

					if (!this.doc.taxes_and_charges && this.defaults.default_taxes_and_charges) {
						this.doc.taxes_and_charges = this.defaults.default_taxes_and_charges;
						if (this.controls.taxes_and_charges) {
							this.controls.taxes_and_charges.set_value(this.defaults.default_taxes_and_charges);
						}
						this._fetch_tax_template(this.doc.taxes_and_charges);
					}
					this._maybe_autoselect_establecimiento();
					this._update_header_sections();
				}
			},
		});
	}

	// Si la compañía activa solo tiene un Establecimiento configurado en
	// BFEL Settings > Datos Empresa > Establecimientos, lo selecciona de una
	// vez al elegir cliente para que el usuario no tenga que marcarlo a mano.
	// Si hay más de uno, se deja la selección manual como hasta ahora.
	_maybe_autoselect_establecimiento() {
		const establishments = this.defaults.establishments || [];
		if (establishments.length !== 1) return;

		const $est = this.$body.find("#ef-establecimiento");
		if ($est.val()) return; // ya tiene uno seleccionado, no lo pisamos

		const only = establishments[0].establecimiento_id;
		$est.val(only);
		this.doc.bfel_establecimiento = only;
		this._load_naming_series_for_selected_establishment(() => {
			this._update_header_sections();
		});
		this._mark_dirty();
	}

	_on_payment_terms_change(tpl_name) {
		this.doc.payment_terms_template = tpl_name;
		if (!tpl_name) {
			this.doc.due_date = this.doc.posting_date || frappe.datetime.get_today();
			this.$body.find("#ef-due-date").val(this.doc.due_date);
			return;
		}
		frappe.call({
			method: "frappe.client.get",
			args: { doctype: "Payment Terms Template", name: tpl_name },
			callback: (r) => {
				if (r.message && r.message.terms && r.message.terms.length > 0) {
					const lastTerm = r.message.terms[r.message.terms.length - 1];
					const creditDays = parseInt(lastTerm.credit_days || 0);
					const posting = this.doc.posting_date || frappe.datetime.get_today();
					const due = frappe.datetime.add_days(posting, creditDays);
					this.doc.due_date = due;
					this.$body.find("#ef-due-date").val(due);
				}
			},
		});
	}

	_on_taxes_change(tpl_name) {
		this.doc.taxes_and_charges = tpl_name;
		this._toggle_escenario_exento(tpl_name);
		this._fetch_tax_template(tpl_name);
	}

	_fetch_tax_template(tpl_name) {
		if (!tpl_name) {
			this.doc._taxes_template = null;
			this._update_local_footer();
			return;
		}
		frappe.call({
			method: "frappe.client.get",
			args: { doctype: "Sales Taxes and Charges Template", name: tpl_name },
			callback: (r) => {
				this.doc._taxes_template = (r.message && r.message.taxes) ? r.message.taxes : [];
				this._update_local_footer();
			},
		});
	}

	_toggle_escenario_exento(tpl_name) {
		const isExe = (tpl_name || "").substring(0, 3).toUpperCase() === "EXE";
		const $row = this.$body.find("#ef-row-escenario");
		const $sel = this.$body.find("#ef-bfel-escenario-exento");
		if (isExe) {
			$row.css("display", "flex");
			$sel.prop("disabled", false);
		} else {
			$row.css("display", "none");
			$sel.val("").prop("disabled", true);
			this.doc.bfel_escenario_exento = "";
		}
	}

	// -----------------------------------------------------------------------
	// Dirty state tracking
	// -----------------------------------------------------------------------

	_mark_dirty() {
		this._dirty = true;
		this._update_action_bar_state();
	}

	// -----------------------------------------------------------------------
	// Items Table
	// -----------------------------------------------------------------------

	_setup_item_table() {
		this.$body.find("#ef-add-row").on("click", () => this._add_item_row());

		// Escaneo de código de barras / QR: agrega la línea automáticamente,
		// o suma 1 a la cantidad si el producto ya está en la lista.
		this.$body.find("#ef-barcode-scan").on("keydown", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			const $input = this.$body.find("#ef-barcode-scan");
			const code = $input.val().trim();
			if (!code) return;
			$input.prop("disabled", true);
			frappe.call({
				method: "facex_multi.api.item.find_item_by_code",
				args: { txt: code, company: this.doc.company || this.defaults.company || "" },
				callback: (r) => {
					$input.val("").prop("disabled", false).trigger("focus");
					if (!r.message) {
						frappe.show_alert({ message: __("Producto no encontrado para el código {0}.", [code]), indicator: "orange" });
						return;
					}
					this._add_or_increment_item(r.message);
				},
				error: () => {
					$input.prop("disabled", false).trigger("focus");
				},
			});
		});
	}

	// Agrega una nueva línea para el ítem escaneado, o suma 1 a la cantidad
	// si ya existe en la lista (salvo que maneje número de serie).
	_add_or_increment_item(it) {
		if (!it.has_serial_no) {
			const idx = this.doc.items.findIndex((row) => row.item_code === it.item_code);
			if (idx !== -1) {
				this.doc.items[idx].qty = (parseFloat(this.doc.items[idx].qty) || 0) + 1;
				this._render_items();
				this._update_local_footer();
				this._mark_dirty();
				this.$body.find(`#ef-row-${idx} .ef-qty`).trigger("focus");
				return;
			}
		}
		this._add_item_row({ item_code: it.item_code });
		const newIdx = this.doc.items.length - 1;
		this._fetch_item_details(newIdx, it.item_code);
	}

	_render_items() {
		const $tbody = this.$body.find("#ef-items-body");
		$tbody.empty();

		if (!this.doc.items || this.doc.items.length === 0) {
			this.$body.find("#ef-items-empty").show();
			return;
		}
		this.$body.find("#ef-items-empty").hide();

		this.doc.items.forEach((item, idx) => {
			$tbody.append(this._item_row_html(idx, item));
			this._bind_row_events(idx);
		});
		this._apply_column_visibility();
	}

	_item_row_html(idx, item) {
		const base_rate = item.price_list_rate !== undefined && item.price_list_rate !== null && parseFloat(item.price_list_rate) > 0 ? parseFloat(item.price_list_rate) : (parseFloat(item.rate) || 0);
		const amount = this._calc_amount(item.qty, base_rate, item.discount_percentage);
		const _no_stock = item.is_stock_item && (item._no_stock || !item.warehouse);
		const _no_stock_cls = _no_stock ? " ef-tr-no-stock" : "";
		const _no_stock_badge = _no_stock
			? `<span class="ef-no-stock-badge">${!item.warehouse ? "Sin bodega" : "Sin stock"}</span>`
			: "";

		// Botón adenda DIGECAM — solo para ARMAS y MUNICIÓN
		const _grupo = item._item_group || item.item_group || "";
		let _adenda_td = '<td class="ef-td ef-td-adenda ef-col-adenda"></td>';
		if (_grupo === "ARMAS" || _grupo === "MUNICIÓN") {
			const _ok = _grupo === "ARMAS"
				? !!(item.tenencia_1 && item.tenencia_2 && item.codigo && item.oficio && item.expediente && item.serial_no)
				: !!(item.custom_tenencia_municion && item.custom_codigo_cliente_municion && item.lote && item.licencia && item.autorizacion);
			const _cls   = _ok ? "ef-adenda-ok" : "ef-adenda-pending";
			const _lbl   = _ok ? "&#10003;&nbsp;Adenda" : "&#9888;&nbsp;Adenda";
			const _title = _ok ? "Editar adenda DIGECAM" : "Completar adenda DIGECAM (obligatorio)";
			_adenda_td = `<td class="ef-td ef-td-adenda ef-col-adenda"><button class="ef-btn-adenda ${_cls}" data-idx="${idx}" title="${_title}">${_lbl}</button></td>`;
		}
		const _tipo_val = item.bfel_multi_tipo || "";
		const _tipo_td = `<td class="ef-td ef-td-tipo ef-col-tipo">
  <select class="ef-cell-input ef-tipo" data-idx="${idx}" style="width:100%; font-size:12px; text-align:center;">
    <option value=""  ${_tipo_val === ""  ? "selected" : ""}>-</option>
    <option value="B" ${_tipo_val === "B" ? "selected" : ""}>B</option>
    <option value="S" ${_tipo_val === "S" ? "selected" : ""}>S</option>
  </select>
</td>`;

		const _lm_btn = item._is_lista_materiales
			? `<button class="ef-btn-lm${item._lm_expanded ? " ef-btn-lm-open" : ""}" data-idx="${idx}" tabindex="-1" title="Ver detalle de Lista de Materiales">▶</button>`
			: "";
		const _lm_row = item._is_lista_materiales
			? `<tr class="ef-tr-lm-detail" id="ef-row-lm-${idx}" style="display:${item._lm_expanded ? "" : "none"};">
  <td class="ef-td-lm-detail" colspan="11">${this._lm_detail_html(item)}</td>
</tr>`
			: "";

		return `
<tr class="ef-tr${_no_stock_cls}" data-idx="${idx}" id="ef-row-${idx}">
  <td class="ef-td ef-td-idx">${idx + 1}</td>
  <td class="ef-td">
    <div class="ef-ac-wrapper" style="position:relative">
      <input type="text" class="ef-cell-input ef-item-code"
        data-field="item_code" data-idx="${idx}"
        value="${_esc(item.item_code || "")}"
        placeholder="Código..." autocomplete="off" />
      <button class="ef-btn-image" data-idx="${idx}" tabindex="-1" title="Ver imágenes del producto">▦</button>
      <button class="ef-btn-stock" data-idx="${idx}" tabindex="-1" title="Ver saldos por bodega">≡</button>
      ${_lm_btn}
    </div>
  </td>
  <td class="ef-td">
    <input type="text" class="ef-cell-input ef-item-desc"
      data-field="description" data-idx="${idx}"
      value="${_esc(item.description || item.item_name || "")}"
      placeholder="Descripción FEL (max. 500 caracteres)"
      maxlength="500" />
  </td>
  <td class="ef-td ef-col-wh">
    <select class="ef-cell-input ef-warehouse" data-field="warehouse" data-idx="${idx}" style="width:100%; font-size:12px;">
      <option value="">(Almacén)</option>
      ${(this.warehouses || []).map(w => `<option value="${_esc(w)}"${item.warehouse === w ? ' selected' : ''}>${_esc(w)}</option>`).join('')}
    </select>
    ${_no_stock_badge}
  </td>
  <td class="ef-td ef-td-num">
    <input type="number" class="ef-cell-input ef-input-num ef-qty"
      data-field="qty" data-idx="${idx}"
      value="${item.qty || 1}" min="0" step="any" />
  </td>
  <td class="ef-td ef-td-num">
    <input type="number" class="ef-cell-input ef-input-num ef-rate"
      data-field="rate" data-idx="${idx}"
      value="${base_rate || 0}" min="0" step="any" />
  </td>
  <td class="ef-td ef-td-num ef-col-disc">
    <input type="number" class="ef-cell-input ef-input-num ef-disc"
      data-field="discount_percentage" data-idx="${idx}"
      value="${item.discount_percentage || 0}" min="0" max="100" step="any" />
  </td>
  <td class="ef-td ef-td-num">
    <input type="text" class="ef-cell-input ef-input-num ef-amount"
      data-field="amount" data-idx="${idx}"
      value="${_fmt(amount)}" readonly />
  </td>
  ${_adenda_td}
  ${_tipo_td}
  <td class="ef-td">
    <button class="ef-btn-del ef-del-row" data-idx="${idx}" title="Eliminar fila">×</button>
  </td>
</tr>${_lm_row}`;
	}

	_bind_row_events(idx) {
		const $row = this.$body.find(`#ef-row-${idx}`);

		// item_code → autocomplete
		const $itemCode = $row.find(".ef-item-code");
		this._setup_ac($itemCode, "Item", (value) => {
			this.doc.items[idx].item_code = value;
			this._fetch_item_details(idx, value);
		});
		$itemCode.on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				setTimeout(() => {
					const typed = $itemCode.val().trim();
					if (typed) {
						this.doc.items[idx].item_code = typed;
						this._fetch_item_details(idx, typed);
					}
				}, 50);
			}
		});
		$itemCode.on("blur", () => {
			const typed = $itemCode.val().trim();
			if (typed && typed !== (this.doc.items[idx].item_code || "")) {
				this.doc.items[idx].item_code = typed;
				this._fetch_item_details(idx, typed);
			}
		});
		$itemCode.on("input change", () => this._mark_dirty());

		// description editable en FEL (sustituye item_name en la UI del Facturador)
		$row.find(".ef-item-desc").on("change input", (e) => {
			this.doc.items[idx].description = e.target.value;
			this._mark_dirty();
		});

		// warehouse select
		$row.find(".ef-warehouse").on("change", (e) => {
			this.doc.items[idx].warehouse = e.target.value;
			this._mark_dirty();
			this._update_row_stock_flag(idx);
		});

		// tipo FEL select
		$row.find(".ef-tipo").on("change", (e) => {
			this.doc.items[idx].bfel_multi_tipo = e.target.value;
			this._mark_dirty();
		});

		// qty / rate / discount → recalcular amount local
		["qty", "rate", "discount_percentage"].forEach((field) => {
			$row.find(`[data-field="${field}"]`).on("input change", (e) => {
				const val = parseFloat(e.target.value) || 0;
				this.doc.items[idx][field] = val;
				if (field === "rate") {
					this.doc.items[idx].price_list_rate = val;
				}
				this._update_row_amount(idx);
				this._mark_dirty();
			});
		});

		// Adenda DIGECAM button (editar o completar)
		$row.find(".ef-btn-adenda").on("click", (e) => {
			e.stopPropagation();
			const row = this.doc.items[idx];
			const grupo = row._item_group || row.item_group || "";
			if (grupo === "ARMAS") {
				this._show_adenda_dialog(idx, "arma");
			} else if (grupo === "MUNICIÓN") {
				this._show_adenda_dialog(idx, "municion");
			}
		});

		// Stock popover button
		$row.find(".ef-btn-stock").on("click", (e) => {
			e.stopPropagation();
			const item_code = this.doc.items[idx].item_code;
			if (!item_code) {
				frappe.show_alert({ message: "Seleccione un producto primero.", indicator: "orange" });
				return;
			}
			const warehouse = this.doc.items[idx].warehouse || "";
			const qty       = parseFloat(this.doc.items[idx].qty) || 0;
			this._show_stock_popover(e.currentTarget, item_code, warehouse, qty);
		});

		// Imágenes del producto
		$row.find(".ef-btn-image").on("click", (e) => {
			e.stopPropagation();
			const item_code = this.doc.items[idx].item_code;
			if (!item_code) {
				frappe.show_alert({ message: "Seleccione un producto primero.", indicator: "orange" });
				return;
			}
			this._show_item_images_dialog(item_code);
		});

		// Lista de Materiales — acordeón bajo demanda (no automático)
		$row.find(".ef-btn-lm").on("click", (e) => {
			e.stopPropagation();
			this._toggle_lista_materiales_row(idx);
		});

		// Delete row
		$row.find(".ef-del-row").on("click", () => this._remove_item_row(idx));

		// Highlight active row
		$row.on("focusin", () => {
			this.$body.find(".ef-tr").removeClass("ef-tr-active");
			$row.addClass("ef-tr-active");
		});

		// Tab en última celda editable → nueva fila
		$row.find("input:last").on("keydown", (e) => {
			if (e.key === "Tab" && !e.shiftKey && idx === this.doc.items.length - 1) {
				e.preventDefault();
				this._add_item_row();
			}
		});
	}

	_add_item_row(item = {}) {
		const defaults = this.defaults;
		const row = {
			item_code: item.item_code || "",
			item_name: item.item_name || "",
			warehouse: item.warehouse || defaults.default_warehouse || "",
			qty: item.qty || 1,
			uom: item.uom || "",
			rate: item.rate || 0,
			discount_percentage: item.discount_percentage || 0,
			amount: item.amount || 0,
			cost_center: item.cost_center || defaults.default_cost_center || "",
			description: item.description || "",
		};
		this.doc.items.push(row);
		this._render_items();
		const newIdx = this.doc.items.length - 1;
		this.$body.find(`#ef-row-${newIdx} .ef-item-code`).focus();
		this._update_local_footer();
		this._mark_dirty();

		// REFUERZO: Recargar template de impuestos si no está cargado pero hay taxes_and_charges seleccionado
		if (this.doc.taxes_and_charges && !this.doc._taxes_template) {
			this._fetch_tax_template(this.doc.taxes_and_charges);
		}
	}

	_remove_item_row(idx) {
		this.doc.items.splice(idx, 1);
		this._render_items();
		this._update_local_footer();
		this._mark_dirty();
	}

	_fetch_item_details(idx, item_code) {
		if (!item_code) return;
		frappe.call({
			method: "facex_multi.api.invoice.get_item_details",
			args: {
				item_code: item_code,
				company: this.doc.company || this.defaults.company || "",
				customer: this.doc.customer || "",
				warehouse: this.defaults.default_warehouse || "",
				price_list: this.doc.selling_price_list || "",
			},
			callback: (r) => {
				if (!r.exc && r.message) {
					const d = r.message;
					const row = this.doc.items[idx];
					if (row) {
						row.item_name = d.item_name || row.item_name;
						row.rate = d.rate !== undefined ? d.rate : row.rate;
						row.uom = d.uom || row.uom;
						row.description = d.description || "";
						if (d.warehouse) row.warehouse = d.warehouse;
						if (d.cost_center) row.cost_center = d.cost_center;
						// Guardar flags de serie/adenda en el row
						row._has_serial_no = d.has_serial_no || 0;
						row._custom_tiene_adenda = d.custom_tiene_adenda || 0;
						row._item_group = d.item_group || "";
						row.is_stock_item = d.is_stock_item || 0;
						// Pre-llenar tipo FEL con default de configuración si no tiene valor
						if (!row.bfel_multi_tipo) {
							row.bfel_multi_tipo = (this.company_config || {}).tipo_x_defecto || "";
						}
						row.amount = this._calc_amount(row.qty, row.rate, row.discount_percentage);
						// Lista de Materiales: solo se guarda el flag — el detalle se consulta
						// bajo demanda con el botón ▶ de la fila (ver _toggle_lista_materiales_row),
						// no se muestra automáticamente al seleccionar el producto.
						row._is_lista_materiales = !!d.is_lista_materiales;
						row._modo_stock_lista = d.modo_stock_lista || "";
						if (!row._is_lista_materiales) {
							row._lm_expanded = false;
							row._lm_detail = null;
						}
						this._render_items();
						this._update_local_footer();
						this._handle_item_serial_adenda(idx, d);
						this._update_row_stock_flag(idx);
						this._maybe_suggest_pair(item_code);
					}
				}
			},
		});
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
					`<strong>${_esc(item_code)}</strong> tiene un artículo en par configurado: <strong>${_esc(pair.item_name || pair.item_code)}</strong>. ¿Agregarlo también a la factura?`,
					() => {
						this._add_item_row({ item_code: pair.item_code });
						this._fetch_item_details(this.doc.items.length - 1, pair.item_code);
					}
				);
			},
		});
	}

	_show_alternatives_dialog() {
		const $focused = $(document.activeElement).closest("[data-idx]");
		const idx = $focused.length ? parseInt($focused.attr("data-idx")) : NaN;
		const row = !isNaN(idx) ? this.doc.items[idx] : null;
		if (!row || !row.item_code) {
			frappe.show_alert({ message: "Seleccione primero una fila con un artículo.", indicator: "orange" });
			return;
		}
		frappe.call({
			method: "facex_multi.api.item_relations.get_item_relations",
			args: { item_code: row.item_code, tipo: "Alternativo" },
			callback: (r) => {
				const options = r.message || [];
				if (!options.length) {
					frappe.show_alert({ message: `'${row.item_code}' no tiene artículos alternativos configurados.`, indicator: "orange" });
					return;
				}
				this._render_item_picker_dialog({
					title: `Alternativos de ${row.item_code}`,
					options,
					onPick: (item_code) => {
						this.doc.items[idx].item_code = item_code;
						this._fetch_item_details(idx, item_code);
					},
				});
			},
		});
	}

	_show_keyword_search_dialog() {
		const dlg = new frappe.ui.Dialog({
			title: "Buscar por Palabras Clave / Referencias (F8)",
			fields: [
				{ fieldname: "txt", fieldtype: "Data", label: "Buscar", description: "Alias, número de referencia, u otro nombre del producto" },
				{ fieldname: "results_html", fieldtype: "HTML" },
			],
		});
		const $results = () => dlg.fields_dict.results_html.$wrapper;
		$results().html('<div style="padding:16px; color:#94a3b8; text-align:center;">Escriba para buscar…</div>');

		let timer = null;
		dlg.fields_dict.txt.$input.on("input", () => {
			clearTimeout(timer);
			const txt = dlg.fields_dict.txt.get_value().trim();
			if (txt.length < 2) {
				$results().html('<div style="padding:16px; color:#94a3b8; text-align:center;">Escriba para buscar…</div>');
				return;
			}
			timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.item_relations.search_items_by_keywords",
					args: { txt, company: this.doc.company || this.defaults.company || "" },
					callback: (r) => {
						const rows = r.message || [];
						if (!rows.length) {
							$results().html('<div style="padding:16px; color:#94a3b8; text-align:center;">Sin resultados.</div>');
							return;
						}
						$results().html(rows.map((it) => `
							<div class="ef-cust-result" data-code="${_esc(it.item_code)}" style="cursor:pointer;">
								<strong>${_esc(it.item_code)}</strong> — ${_esc(it.item_name || "")}
								${it.matched_keywords ? `<br><span style="color:#64748b; font-size:11px;">${_esc(it.matched_keywords)}</span>` : ""}
							</div>`).join(""));
						$results().find(".ef-cust-result").on("click", (e) => {
							const item_code = $(e.currentTarget).data("code");
							dlg.hide();
							this._add_item_row({ item_code });
							this._fetch_item_details(this.doc.items.length - 1, item_code);
						});
					},
				});
			}, 250);
		});

		dlg.show();
		setTimeout(() => dlg.fields_dict.txt.$input.trigger("focus"), 100);
	}

	_render_item_picker_dialog({ title, options, onPick }) {
		const dlg = new frappe.ui.Dialog({
			title,
			fields: [{ fieldname: "picker_html", fieldtype: "HTML" }],
		});
		const $wrap = dlg.fields_dict.picker_html.$wrapper;
		$wrap.html(options.map((it) => `
			<div class="ef-cust-result" data-code="${_esc(it.item_code)}" style="cursor:pointer;">
				<strong>${_esc(it.item_code)}</strong> — ${_esc(it.item_name || "")}
			</div>`).join(""));
		$wrap.find(".ef-cust-result").on("click", (e) => {
			const item_code = $(e.currentTarget).data("code");
			dlg.hide();
			onPick(item_code);
		});
		dlg.show();
	}

	_toggle_lista_materiales_row(idx) {
		const row = this.doc.items[idx];
		if (!row || !row._is_lista_materiales) return;

		row._lm_expanded = !row._lm_expanded;

		if (row._lm_expanded && !row._lm_detail && !row._lm_loading) {
			row._lm_loading = true;
			this._render_items();
			frappe.call({
				method: "facex_multi.api.item.get_lista_materiales_detail",
				args: { item_code: row.item_code },
				callback: (r) => {
					row._lm_loading = false;
					row._lm_detail = r.message || { items: [] };
					this._render_items();
				},
				error: () => {
					row._lm_loading = false;
					this._render_items();
				},
			});
		} else {
			this._render_items();
		}
	}

	_lm_detail_html(item) {
		if (item._lm_loading) {
			return `<div class="ef-lm-detail-loading">Cargando detalle…</div>`;
		}
		const detail = item._lm_detail;
		if (!detail) {
			return `<div class="ef-lm-detail-loading">—</div>`;
		}
		const modo_label = (detail.modo_stock || item._modo_stock_lista) === "Padre"
			? "El producto tiene stock propio."
			: "El stock proviene de sus componentes.";
		const rows = (detail.items || []).map((it) => `
			<tr>
				<td>${_esc(it.item_code)}</td>
				<td>${_esc(it.item_name || "")}</td>
				<td style="text-align:right;">${_fmt(it.qty)}</td>
				<td>${_esc(it.uom || "")}</td>
			</tr>`).join("");
		return `
			<div class="ef-lm-detail-wrap">
				<div class="ef-lm-detail-note">${_esc(modo_label)}</div>
				<table class="ef-lm-detail-table">
					<thead><tr><th>Código</th><th>Producto</th><th style="text-align:right;">Cantidad</th><th>UOM</th></tr></thead>
					<tbody>${rows || '<tr><td colspan="4" style="text-align:center;color:#adb5bd;">Sin componentes.</td></tr>'}</tbody>
				</table>
			</div>`;
	}

	_update_row_stock_flag(idx) {
		const row = this.doc.items[idx];
		if (!row || !row.item_code || !row.is_stock_item) {
			if (row) row._no_stock = false;
			this._apply_row_stock_class(idx);
			return;
		}
		if (!row.warehouse) {
			row._no_stock = true;
			this._apply_row_stock_class(idx);
			return;
		}
		frappe.call({
			method: "facex_multi.api.invoice.get_item_stock",
			args: { item_code: row.item_code, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				if (this.doc.items[idx] !== row) return;
				const whRow = (r.message || []).find(wr => wr.warehouse === row.warehouse);
				row._no_stock = !whRow || parseFloat(whRow.actual_qty || 0) <= 0;
				this._apply_row_stock_class(idx);
			},
		});
	}

	_apply_row_stock_class(idx) {
		const row = this.doc.items[idx];
		const $row = this.$body.find(`#ef-row-${idx}`);
		if (!$row.length) return;
		const noStock = !!(row && row.is_stock_item && (row._no_stock || !row.warehouse));
		$row.toggleClass("ef-tr-no-stock", noStock);
		const $wh = $row.find(".ef-col-wh");
		$wh.find(".ef-no-stock-badge").remove();
		if (noStock) {
			const label = !row.warehouse ? "Sin bodega" : "Sin stock";
			$wh.append(`<span class="ef-no-stock-badge">${label}</span>`);
		}
	}

	_show_stock_popover(btn, item_code, selected_warehouse, requested_qty) {
		$(".ef-stock-popover").remove();
		$(document).off("click.ef-stock-popover");

		const $pop = $(`
			<div class="ef-stock-popover">
				<div class="ef-stock-popover-header">
					<div class="ef-stock-popover-title">
						<span>${_esc(item_code)}</span>
						<small>Saldos por bodega</small>
					</div>
					<button class="ef-stock-close" title="Cerrar">×</button>
				</div>
				<div class="ef-stock-popover-body">
					<div class="ef-stock-loading">Consultando inventario…</div>
				</div>
			</div>`);

		$("body").append($pop);

		// Posicionar junto al botón (debajo o arriba según espacio)
		const rect = btn.getBoundingClientRect();
		const popH = 220;
		const top  = (rect.bottom + popH > window.innerHeight)
			? rect.top - popH - 4
			: rect.bottom + 4;
		$pop.css({ top: Math.max(4, top), left: Math.max(4, rect.left) });

		$pop.find(".ef-stock-close").on("click", () => {
			$pop.remove();
			$(document).off("click.ef-stock-popover");
		});
		setTimeout(() => {
			$(document).on("click.ef-stock-popover", (ev) => {
				if (!$pop.is(ev.target) && $pop.has(ev.target).length === 0) {
					$pop.remove();
					$(document).off("click.ef-stock-popover");
				}
			});
		}, 50);

		frappe.call({
			method: "facex_multi.api.invoice.get_item_stock",
			args: { item_code, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				const $body = $pop.find(".ef-stock-popover-body");
				const rows  = r.message || [];

				if (!rows.length) {
					$body.html('<div class="ef-stock-empty">Sin registros de inventario para este producto.</div>');
					return;
				}

				// Producto de servicio (is_stock_item = 0)
				if (!rows[0].is_stock_item) {
					$body.html('<div class="ef-stock-svc">Producto de servicio — no maneja inventario.</div>');
					return;
				}

				const uom = rows[0].stock_uom || "";
				const fmt = (n) => parseFloat(n || 0).toLocaleString("es-GT", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

				let html = `<table class="ef-stock-table">
					<thead><tr>
						<th>Bodega</th>
						<th class="ef-stock-qty-h">Disponible</th>
						<th class="ef-stock-qty-h">Proyectado</th>
					</tr></thead><tbody>`;

				rows.forEach(row => {
					const qty     = parseFloat(row.actual_qty || 0);
					const proj    = parseFloat(row.projected_qty || 0);
					const isSel   = row.warehouse === selected_warehouse;
					const isShort = requested_qty > 0 && qty < requested_qty;
					const cls     = isSel ? (isShort ? "ef-stock-row-warn" : "ef-stock-row-sel")
					                      : (isShort ? "ef-stock-row-low"  : "");
					const arrow   = isSel ? "▶ " : "";
					html += `<tr class="${cls}">
						<td>${arrow}${_esc(row.warehouse)}</td>
						<td class="ef-stock-qty-v">${fmt(qty)} ${_esc(uom)}</td>
						<td class="ef-stock-qty-v" style="color:#94a3b8;">${fmt(proj)}</td>
					</tr>`;
				});

				html += `</tbody></table>`;
				$body.html(html);

				// Ajustar posición real ahora que tenemos contenido
				const popRect = $pop[0].getBoundingClientRect();
				if (popRect.right > window.innerWidth - 4) {
					$pop.css("left", Math.max(4, window.innerWidth - popRect.width - 8));
				}
			},
		});
	}

	_show_item_images_dialog(item_code) {
		const d = new frappe.ui.Dialog({
			title: `Imágenes del producto: ${item_code}`,
			size: "large",
			fields: [{ fieldtype: "HTML", fieldname: "ef_gallery_html" }],
		});
		const $wrapper = d.fields_dict.ef_gallery_html.$wrapper;
		$wrapper.html('<div class="ef-stock-loading">Cargando imágenes…</div>');
		d.show();

		frappe.call({
			method: "facex_multi.api.item.get_item_images",
			args: { item_code },
			callback: (r) => {
				const images = r.message || [];
				if (!images.length) {
					$wrapper.html('<div class="ef-stock-empty">Este producto no tiene imágenes adjuntas.</div>');
					return;
				}
				this._render_image_carousel($wrapper, images);
			},
		});
	}

	_render_image_carousel($wrapper, images, opts = {}) {
		let idx = 0;
		const editable = !!opts.editable;

		const thumbs = images.map((img, i) => `
			<img class="ef-img-thumb" data-idx="${i}" src="${img.file_url}" title="${_esc(img.file_name || "")}">
		`).join("");

		$wrapper.html(`
			<div class="ef-img-carousel">
				<div class="ef-img-stage">
					<button class="ef-img-nav ef-img-prev" title="Anterior">&#10094;</button>
					<a class="ef-img-main-link" href="#" target="_blank">
						<img class="ef-img-main" src="">
					</a>
					${editable ? '<button class="ef-img-remove-main" title="Eliminar imagen">×</button>' : ""}
					<button class="ef-img-nav ef-img-next" title="Siguiente">&#10095;</button>
				</div>
				<div class="ef-img-caption"></div>
				${images.length > 1 ? `<div class="ef-img-thumbs">${thumbs}</div>` : ""}
			</div>
		`);

		const $main = $wrapper.find(".ef-img-main");
		const $mainLink = $wrapper.find(".ef-img-main-link");
		const $caption = $wrapper.find(".ef-img-caption");

		const render = () => {
			const img = images[idx];
			$main.attr("src", img.file_url);
			$mainLink.attr("href", img.file_url);
			$caption.text(`${img.file_name || ""} (${idx + 1}/${images.length})`);
			$wrapper.find(".ef-img-thumb").removeClass("ef-img-thumb-active")
				.filter(`[data-idx="${idx}"]`).addClass("ef-img-thumb-active");
			$wrapper.find(".ef-img-nav").toggle(images.length > 1);
		};

		$wrapper.find(".ef-img-prev").on("click", () => { idx = (idx - 1 + images.length) % images.length; render(); });
		$wrapper.find(".ef-img-next").on("click", () => { idx = (idx + 1) % images.length; render(); });
		$wrapper.find(".ef-img-thumb").on("click", (e) => { idx = parseInt($(e.currentTarget).attr("data-idx"), 10); render(); });

		if (editable) {
			$wrapper.find(".ef-img-remove-main").on("click", () => {
				frappe.confirm("¿Eliminar esta imagen del producto?", () => {
					frappe.call({
						method: "facex_multi.api.item.delete_item_image",
						args: { item_code: opts.item_code, file_name: images[idx].name || "" },
						callback: () => {
							frappe.show_alert({ message: "Imagen eliminada.", indicator: "green" });
							if (opts.onDeleted) opts.onDeleted();
						},
					});
				});
			});
		}

		render();
	}

	// -----------------------------------------------------------------------
	// Series y Adendas DIGECAM
	// -----------------------------------------------------------------------

	_handle_item_serial_adenda(idx, details) {
		const cfg = this.company_config || {};
		const has_serial = details.has_serial_no;
		const tiene_adenda = details.custom_tiene_adenda;

		if (has_serial && cfg.maneja_series) {
			this._show_serial_picker(idx, () => {
				if (tiene_adenda && cfg.maneja_adendas) {
					this._show_adenda_dialog(idx, "arma");
				} else {
					this.$body.find(`#ef-row-${idx} .ef-qty`).focus().select();
				}
			});
		} else if (tiene_adenda && cfg.maneja_adendas) {
			this._show_adenda_dialog(idx, "municion");
		} else {
			this.$body.find(`#ef-row-${idx} .ef-qty`).focus().select();
		}
	}

	_show_serial_picker(idx, callback) {
		const row = this.doc.items[idx];
		const warehouse = row.warehouse || this.defaults.default_warehouse || "";
		const item_code = row.item_code;

		const dlg = new frappe.ui.Dialog({
			title: __("Seleccionar Serie — {0}", [item_code]),
			fields: [
				{
					fieldname: "buscar",
					fieldtype: "Data",
					label: __("Buscar"),
					placeholder: __("Filtrar por número de serie…"),
				},
			],
		});

		// Panel de lista debajo del campo de búsqueda
		const $list = $(`
			<div id="ef-serial-list" style="
				margin-top:8px; max-height:320px; overflow-y:auto;
				border:1px solid #e0e0e0; border-radius:4px; background:#fff;
			">
				<div class="ef-serial-loading" style="padding:16px; color:#888; text-align:center;">
					Cargando series…
				</div>
			</div>`);
		dlg.$body.append($list);

		let all_series = [];

		const render = (filter) => {
			const q = (filter || "").toLowerCase();
			const visible = q ? all_series.filter(s => s.name.toLowerCase().includes(q)) : all_series;
			if (!visible.length) {
				$list.html(`<div style="padding:16px; color:#888; text-align:center;">Sin series disponibles en la bodega seleccionada.</div>`);
				return;
			}
			const html = visible.map(s => `
				<div class="ef-serial-row" data-serial="${frappe.utils.escape_html(s.name)}" style="
					padding:10px 14px; cursor:pointer; border-bottom:1px solid #f0f0f0;
					display:flex; justify-content:space-between; align-items:center;
				">
					<span style="font-weight:600; font-size:13px; font-family:monospace;">${frappe.utils.escape_html(s.name)}</span>
					<span style="color:#888; font-size:11px;">${frappe.utils.escape_html(s.warehouse || "")}</span>
				</div>`).join("");
			$list.html(html);

			$list.find(".ef-serial-row").on("mouseenter", function() {
				$(this).css("background", "#f0f7ff");
			}).on("mouseleave", function() {
				$(this).css("background", "");
			}).on("click", (ev) => {
				const serial = $(ev.currentTarget).data("serial");
				row.serial_no = serial;
				row.qty = 1;
				this._render_items();
				this._update_local_footer();
				this._mark_dirty();
				dlg.hide();
				if (callback) callback();
			});
		};

		frappe.call({
			method: "facex_multi.api.invoice.get_serial_nos_for_item",
			args: { item_code, warehouse },
			callback: (r) => {
				all_series = r.message || [];
				render("");
			},
		});

		dlg.fields_dict.buscar.$input.on("input", function() {
			render($(this).val().trim());
		});

		dlg.show();
	}

	_show_adenda_dialog(idx, tipo, on_success, on_cancel) {
		const row = this.doc.items[idx];
		const es_arma = tipo === "arma";
		let resolved = false;

		let fields;
		if (es_arma) {
			fields = [
				{
					fieldname: "serie_digecam", fieldtype: "Link", label: "Serie", reqd: 1,
					options: "Serial No",
					get_query: () => ({ filters: { item_code: row.item_code, status: "Active" } }),
				},
				{ fieldname: "sb0",        fieldtype: "Section Break" },
				{ fieldname: "color",      fieldtype: "Data", label: "Color" },
				{ fieldname: "cb1",        fieldtype: "Column Break" },
				{ fieldname: "largo",      fieldtype: "Data", label: "Largo del Cañón" },
				{ fieldname: "sb2",        fieldtype: "Section Break" },
				{ fieldname: "modelo",     fieldtype: "Data", label: "Modelo" },
				{ fieldname: "cb2",        fieldtype: "Column Break" },
				{ fieldname: "oficio",     fieldtype: "Data", label: "Oficio (Autorización DIGECAM)" },
				{ fieldname: "sb3",        fieldtype: "Section Break" },
				{ fieldname: "tenencia_1", fieldtype: "Data", label: "Tenencia 1", reqd: 1 },
				{ fieldname: "cb3",        fieldtype: "Column Break" },
				{ fieldname: "tenencia_2", fieldtype: "Data", label: "Tenencia 2", reqd: 1 },
				{ fieldname: "sb4",        fieldtype: "Section Break" },
				{ fieldname: "codigo",     fieldtype: "Data", label: "Código Cliente DIGECAM" },
				{ fieldname: "cb4",        fieldtype: "Column Break" },
				{ fieldname: "expediente", fieldtype: "Data", label: "Expediente" },
			];
		} else {
			fields = [
				{ fieldname: "licencia",                       fieldtype: "Data", label: "Licencia" },
				{ fieldname: "cb1",                            fieldtype: "Column Break" },
				{ fieldname: "autorizacion",                   fieldtype: "Data", label: "Autorización" },
				{ fieldname: "sb2",                            fieldtype: "Section Break" },
				{ fieldname: "lote",                           fieldtype: "Data", label: "Lote" },
				{ fieldname: "cb2",                            fieldtype: "Column Break" },
				{ fieldname: "custom_tenencia_municion",       fieldtype: "Data", label: "Tenencia", reqd: 1 },
				{ fieldname: "sb3",                            fieldtype: "Section Break" },
				{ fieldname: "custom_codigo_cliente_municion", fieldtype: "Data", label: "Código Cliente", reqd: 1 },
			];
		}

		const title = es_arma
			? __("Adenda DIGECAM — {0}", [row.item_name || row.item_code])
			: __("Adenda DIGECAM — {0}", [row.item_name || row.item_code]);

		const dlg = new frappe.ui.Dialog({
			title,
			fields,
			primary_action_label: __("Guardar Adenda"),
			primary_action: (values) => {
				Object.assign(row, values);
				// Para ARMA: mapear serie_digecam → serial_no real del item
				if (es_arma) {
					if (values.serie_digecam) {
						row.serial_no = values.serie_digecam;
						row.qty = 1;
					}
					delete row.serie_digecam;
				}
				row.tiene_adenda = 1;
				resolved = true;
				this._render_items();
				this._update_local_footer();
				this._mark_dirty();
				dlg.hide();
				if (on_success) {
					on_success();
				} else {
					this.$body.find(`#ef-row-${idx} .ef-qty`).focus().select();
				}
			},
			secondary_action_label: __("Cancelar"),
			secondary_action: () => { dlg.hide(); },
		});

		// Detectar cierre sin guardar (X, Escape, secondary_action)
		const _orig_hide = dlg.hide.bind(dlg);
		dlg.hide = () => {
			_orig_hide();
			if (!resolved && on_cancel) on_cancel();
		};

		// Pre-poblar con valores existentes en el row
		const SKIP = new Set(["cb1","cb2","cb3","cb4","sb0","sb2","sb3","sb4"]);
		const pre = {};
		fields.forEach(f => {
			if (f.fieldname && !SKIP.has(f.fieldname)) {
				// serie_digecam es el campo proxy para serial_no en el dialog
				pre[f.fieldname] = (f.fieldname === "serie_digecam")
					? (row.serial_no || "")
					: (row[f.fieldname] || "");
			}
		});
		dlg.set_values(pre);
		dlg.show();
	}

	// -----------------------------------------------------------------------
	// Adenda helpers y validación pre-submit
	// -----------------------------------------------------------------------

	_arma_completa(row) {
		return !!(row.tenencia_1 && row.tenencia_2 && row.codigo &&
		          row.oficio && row.expediente && row.serial_no);
	}

	_municion_completa(row) {
		return !!(row.custom_tenencia_municion && row.custom_codigo_cliente_municion &&
		          row.lote && row.licencia && row.autorizacion);
	}

	_adendas_pendientes() {
		return (this.doc.items || [])
			.map((row, idx) => ({ row, idx }))
			.filter(({ row }) => {
				const g = row._item_group || row.item_group || "";
				if (g === "ARMAS")    return !this._arma_completa(row);
				if (g === "MUNICIÓN") return !this._municion_completa(row);
				return false;
			});
	}

	_adenda_como_promise(idx, tipo) {
		return new Promise((resolve, reject) => {
			this._show_adenda_dialog(idx, tipo, resolve, reject);
		});
	}

	_guardar_antes_de_submit() {
		return new Promise((resolve, reject) => {
			frappe.call({
				method: "facex_multi.api.invoice.save_draft",
				args: { doc_json: JSON.stringify(this._build_save_payload()) },
				freeze: true,
				freeze_message: __("Guardando adendas..."),
				callback: (r) => {
					if (!r.exc && r.message) {
						const cachedTpl = this.doc._taxes_template;
						this._dirty = false;
						this.doc = r.message;
						this.doc._taxes_template = cachedTpl;
						this._sync_ui_from_doc();
						this._update_action_bar_state();
						resolve();
					} else {
						reject();
					}
				},
				error: () => reject(),
			});
		});
	}

	async _validar_adendas_pendientes() {
		const pendientes = this._adendas_pendientes();
		for (const { row, idx } of pendientes) {
			const tipo  = (row._item_group || row.item_group) === "ARMAS" ? "arma" : "municion";
			const label = row.item_name || row.item_code;
			frappe.show_alert({
				message: __("Complete la adenda para: {0}", [label]),
				indicator: "orange",
			}, 5);
			await this._adenda_como_promise(idx, tipo);
		}
	}

	// Permissions
	// -----------------------------------------------------------------------

	_full_perms() {
		return {
			puede_ver_tablero: 1, puede_facturar: 1,
			puede_guardar: 1, puede_validar: 1, puede_certificar: 1,
			puede_compras: 1, puede_validar_compras: 1, puede_cancelar_compras: 1,
			crea_clientes: 1, modifica_clientes: 1,
			crea_proveedores: 1, modifica_proveedores: 1,
			crea_items: 1, modifica_items: 1, actualiza_precios: 1, gestiona_listas_materiales: 1,
			asignacion_precios: 1,
			reporte_ventas_fecha: 1, reporte_ventas_producto: 1,
			reporte_facturas_canceladas: 1, reporte_estados_cuenta: 1,
			reporte_antiguedad_saldos: 1, reporte_cotizaciones: 1,
			reporte_recibos_pagos: 1, reporte_crecimiento_ventas: 1,
			reporte_imprimir_recibo: 1, reporte_analisis_utilidad: 1,
		};
	}

	// Únicos flags de permisos que gatean navegación de nivel superior
	// (nav bar Y tarjetas de Inicio, ver _show_home) — factorizados aquí para
	// no repetir el mismo criterio en dos lugares.
	_report_perm_map() {
		return {
			sales_by_date:         "reporte_ventas_fecha",
			sales_by_product:      "reporte_ventas_producto",
			cancelled_invoices:    "reporte_facturas_canceladas",
			customer_statement:    "reporte_estados_cuenta",
			aging_receivables:     "reporte_antiguedad_saldos",
			quotations_report:     "reporte_cotizaciones",
			payments_report:       "reporte_recibos_pagos",
			sales_growth_analysis: "reporte_crecimiento_ventas",
			print_receipt:         "reporte_imprimir_recibo",
			utility_analysis:      "reporte_analisis_utilidad",
		};
	}

	_any_report_access() {
		const p = this.perms || {};
		return Object.values(this._report_perm_map()).some((f) => p[f]);
	}

	_has_transporte_access() {
		const p = this.perms || {};
		return !!(p.puede_ver_menu_transporte && (
			p.puede_editar_guias_transporte || p.puede_administrar_transportistas
			|| p.puede_ver_reportes_transporte || p.puede_cargar_liquidaciones_transporte || p.puede_ver_kpis_transporte
		));
	}

	_apply_perms() {
		const p = this.perms;

		// --- Navegación principal ---
		if (!p.puede_ver_tablero) this.$body.find(".ef-nav-btn[data-view='dashboard']").hide();
		if (!p.puede_facturar)    this.$body.find(".ef-nav-btn[data-view='billing']").hide();
		if (!p.puede_compras)     this.$body.find(".ef-nav-btn[data-view='purchase']").hide();
		// Deny-by-default: a diferencia de los anteriores (ON salvo que se
		// desactiven explícitamente), estos botones arrancan ocultos y solo
		// se muestran si el permiso viene explícitamente en 1.
		if (p.puede_ver_pos) this.$body.find(".ef-nav-btn[data-view='pos']").show();
		else this.$body.find(".ef-nav-btn[data-view='pos']").hide();
		if (p.puede_ver_menu_inventario) this.$body.find(".ef-nav-btn[data-view='inventario']").show();
		else this.$body.find(".ef-nav-btn[data-view='inventario']").hide();
		// Transporte: el grupo del menú solo aparece si puede_ver_menu_transporte
		// está activo Y al menos un sub-permiso específico también lo está; cada
		// ítem del acordeón se muestra/oculta además según su propio permiso
		// (mismo criterio que ya usan las tarjetas del hub en FacexTransporteModule).
		const hasTransporteAccess = this._has_transporte_access();
		this.$body.find("#ef-menu-group-transporte").toggle(hasTransporteAccess);
		if (hasTransporteAccess) {
			this.$body.find("#ef-menu-transporte-transportistas").toggle(!!p.puede_administrar_transportistas);
			this.$body.find("#ef-menu-transporte-pendientes").toggle(!!p.puede_editar_guias_transporte);
			this.$body.find("#ef-menu-transporte-guias").toggle(!!p.puede_editar_guias_transporte);
			this.$body.find("#ef-menu-transporte-liquidaciones").toggle(!!p.puede_cargar_liquidaciones_transporte);
			this.$body.find("#ef-menu-transporte-reportes").toggle(!!p.puede_ver_reportes_transporte);
		}

		// --- Reportes: ocultar tabs no permitidos ---
		const REPORT_PERM = this._report_perm_map();
		this.$body.find(".ef-report-nav-btn").each((_, el) => {
			const report = $(el).data("report");
			const field  = REPORT_PERM[report];
			if (field && !p[field]) $(el).hide();
		});
		// Ocultar cabecera de grupo si todos sus reportes fueron ocultados explícitamente
		this.$body.find(".ef-report-group").each((_, grpEl) => {
			const $grp = $(grpEl);
			const allHidden = $grp.find(".ef-report-nav-btn").toArray().every(btn => btn.style.display === 'none');
			if (allHidden) $grp.hide();
		});
		// Si ningún reporte visible, ocultar tab Reportes del nav
		if (!this._any_report_access()) this.$body.find(".ef-nav-btn[data-view='reports']").hide();

		// Si un grupo del menú agrupado (Ventas / Tablero y Reportes / Gestión)
		// se queda sin ningún ítem visible tras lo anterior, ocultar también
		// su encabezado — evita mostrar un grupo vacío que no despliega nada.
		this.$body.find("#ef-menu-panel > .ef-menu-group").not("[data-group='transporte']").each((_, grpEl) => {
			const $grp = $(grpEl);
			const $items = $grp.find(".ef-menu-item");
			const allHidden = $items.length > 0 && $items.toArray().every((btn) => btn.style.display === "none");
			$grp.toggle(!allHidden);
		});

		// --- Mantenimiento ---
		if (!p.crea_clientes)    this.$body.find("#ef-maint-cust-btn-new").hide();
		if (!p.modifica_clientes) {
			this.$body.find("#ef-maint-cust-btn-save").hide();
			this.$body.find("#ef-maint-cust-btn-delete").hide();
			// Campo de formulario de cliente en modo sólo lectura
			this.$body.find("#ef-maint-tab-clientes .ef-input, #ef-maint-tab-clientes .ef-link-ctrl input")
				.prop("readonly", true).css("background", "#f8fafc");
		}
		if (!p.crea_items)    this.$body.find("#ef-maint-item-btn-new").hide();
		if (!p.modifica_items) {
			this.$body.find("#ef-maint-item-btn-save").hide();
			this.$body.find("#ef-maint-item-btn-delete").hide();
			this.$body.find("#ef-maint-tab-productos .ef-input, #ef-maint-tab-productos .ef-link-ctrl input")
				.prop("readonly", true).css("background", "#f8fafc");
		}
		if (!p.actualiza_precios) {
			this.$body.find(".ef-maint-tab-btn[data-maint-tab='precios']").hide();
		}
		if (!p.asignacion_precios) {
			this.$body.find(".ef-maint-tab-btn[data-maint-tab='asignacion-precios']").hide();
		}
		if (!p.gestiona_listas_materiales) {
			this.$body.find(".ef-maint-tab-btn[data-maint-tab='listas-materiales']").hide();
		}
		if (!p.crea_proveedores && !p.modifica_proveedores) {
			this.$body.find(".ef-maint-tab-btn[data-maint-tab='proveedores']").hide();
		}
		if (!p.crea_proveedores) {
			this.$body.find("#ef-maint-supp-btn-new").hide();
		}
		if (!p.modifica_proveedores) {
			this.$body.find("#ef-maint-supp-btn-save").hide();
			this.$body.find("#ef-maint-supp-btn-delete").hide();
			this.$body.find("#ef-maint-tab-proveedores .ef-input")
				.prop("readonly", true).css("background", "#f8fafc");
		}
		// Acciones del Facturador se aplican en _update_action_bar_state
		// (llamado por el estado de la factura actual)
		this._update_action_bar_state();
	}

	// -----------------------------------------------------------------------

	_update_row_amount(idx) {
		const row = this.doc.items[idx];
		if (!row) return;
		const base_rate = row.price_list_rate !== undefined && row.price_list_rate !== null && parseFloat(row.price_list_rate) > 0 ? parseFloat(row.price_list_rate) : (parseFloat(row.rate) || 0);
		row.amount = this._calc_amount(row.qty, base_rate, row.discount_percentage);
		this.$body.find(`#ef-row-${idx} .ef-amount`).val(_fmt(row.amount));
		this._update_local_footer();
	}

	_calc_amount(qty, rate, disc) {
		qty = parseFloat(qty) || 0;
		rate = parseFloat(rate) || 0;
		disc = parseFloat(disc) || 0;
		const base = qty * rate;
		return base - (base * disc) / 100;
	}

	// -----------------------------------------------------------------------
	// Lightweight Autocomplete
	// -----------------------------------------------------------------------

	_setup_ac($input, doctype, onSelect) {
		let $dropdown = null;
		let _timer = null;
		let _results = [];
		let _active = -1;

		const close = () => {
			if ($dropdown) { $dropdown.remove(); $dropdown = null; }
			_active = -1;
		};

		const open = (results) => {
			close();
			if (!results.length) {
				$dropdown = $(`<div class="ef-autocomplete"><div class="ef-autocomplete-item ef-ac-empty">Sin resultados</div></div>`);
			} else {
				_results = results;
				const items = results
					.map((r, i) => `<div class="ef-autocomplete-item" data-i="${i}">
						${_esc(r.value)}
						${r.description ? `<span class="ef-ac-desc">${_esc(r.description)}</span>` : ""}
					</div>`)
					.join("");
				$dropdown = $(`<div class="ef-autocomplete">${items}</div>`);
			}

			const offset = $input.offset();
			const inputH = $input.outerHeight();
			$dropdown.css({
				top: offset.top + inputH + 2,
				left: offset.left,
				width: Math.max(240, $input.outerWidth()),
			});
			$("body").append($dropdown);

			$dropdown.on("mousedown", ".ef-autocomplete-item:not(.ef-ac-empty)", (e) => {
				const i = parseInt($(e.currentTarget).data("i"));
				const r = _results[i];
				$input.val(r.value);
				onSelect(r.value, r.description || "");
				close();
			});
		};

		const highlight = (dir) => {
			if (!$dropdown) return;
			const $items = $dropdown.find(".ef-autocomplete-item:not(.ef-ac-empty)");
			$items.removeClass("ef-ac-active");
			_active = Math.max(0, Math.min(_active + dir, $items.length - 1));
			$items.eq(_active).addClass("ef-ac-active");
		};

		$input.on("input", () => {
			const txt = $input.val().trim();
			clearTimeout(_timer);
			if (txt.length < 1) { close(); return; }

			const comp = this.doc.company || this.defaults.company || "";

			_timer = setTimeout(() => {
				if (doctype === "Item") {
					frappe.call({
						method: "facex_multi.api.item.search_items",
						args: { txt, company: comp },
						callback: (r) => {
							const rows = r.message || [];
							const results = rows.map((it) => ({
								value: it.name,
								description: it.item_name || "",
							}));
							open(results);
						},
					});
				} else if (doctype === "Customer") {
					frappe.call({
						method: "facex_multi.api.item.get_customers_list",
						args: { txt, company: comp },
						callback: (r) => {
							const rows = r.message || [];
							const results = rows.map((c) => ({
								value: c.name,
								description: c.customer_name || "",
							}));
							open(results);
						},
					});
				} else {
					frappe.call({
						method: "frappe.desk.search.search_link",
						args: {
							txt,
							doctype,
							ignore_user_permissions: 0,
							reference_doctype: "Sales Invoice",
							filters: {},
						},
						callback: (r) => {
							const results = r.results || r.message || [];
							open(Array.isArray(results) ? results : []);
						},
					});
				}
			}, 180);
		});

		$input.on("keydown", (e) => {
			if (!$dropdown) return;
			if (e.key === "ArrowDown") { e.preventDefault(); highlight(1); }
			else if (e.key === "ArrowUp") { e.preventDefault(); highlight(-1); }
			else if (e.key === "Enter") {
				e.preventDefault();
				const $active = $dropdown.find(".ef-ac-active");
				if ($active.length) {
					const i = parseInt($active.data("i"));
					const r = _results[i];
					$input.val(r.value);
					onSelect(r.value, r.description || "");
				}
				close();
			} else if (e.key === "Escape") {
				close();
			}
		});

		$input.on("blur", () => setTimeout(close, 180));
	}

	// -----------------------------------------------------------------------
	// Footer Totals
	// -----------------------------------------------------------------------

	_update_local_footer() {
		// Calcular desde items: separar base bruta de los amounts netos
		let grossBeforeDisc = 0;
		let gross = 0;
		(this.doc.items || []).forEach((r) => {
			const qty  = parseFloat(r.qty) || 0;
			const base_rate = r.price_list_rate !== undefined && r.price_list_rate !== null && parseFloat(r.price_list_rate) > 0 ? parseFloat(r.price_list_rate) : (parseFloat(r.rate) || 0);
			const disc = parseFloat(r.discount_percentage) || 0;
			const base = qty * base_rate;
			grossBeforeDisc += base;
			gross += (base - base * disc / 100);
		});
		const itemDiscounts = grossBeforeDisc - gross;

		let taxes = 0;
		let anyIncluded = false;
		const taxRows = this.doc._taxes_template || [];
		taxRows.forEach((tx) => {
			const rate = parseFloat(tx.rate || 0);
			if (tx.charge_type === "On Net Total") {
				if (tx.included_in_print_rate) {
					// IVA embebido: extraer del gross
					anyIncluded = true;
					taxes += gross * rate / (100 + rate);
				} else {
					taxes += gross * rate / 100;
				}
			} else if (tx.charge_type === "Actual") {
				taxes += parseFloat(tx.tax_amount || 0);
			}
		});

		// Si el impuesto está embebido: subtotal = gross - tax; grand = gross
		// Si no está embebido: subtotal = gross; grand = gross + taxes
		const subtotal = anyIncluded ? (gross - taxes) : gross;
		const grand    = anyIncluded ? gross : (gross + taxes);

		this.$body.find("#ef-subtotal").text(_fmtCurrency(subtotal, this.doc.currency));
		this.$body.find("#ef-discounts").text("- " + _fmtCurrency(itemDiscounts, this.doc.currency));
		this.$body.find("#ef-taxes").text(_fmtCurrency(taxes, this.doc.currency));
		this.$body.find("#ef-grand-total").text(_fmtCurrency(grand, this.doc.currency));
		this.$body.find("#ef-header-grand-total").text(_fmtCurrency(grand, this.doc.currency));
	}

	_update_footer() {
		// Actualiza desde doc (post-save, datos reales de ERPNext)
		const d = this.doc;
		this.$body.find("#ef-subtotal").text(_fmtCurrency(d.total, d.currency));
		this.$body.find("#ef-discounts").text("- " + _fmtCurrency(d.discount_amount, d.currency));
		this.$body.find("#ef-taxes").text(_fmtCurrency(d.total_taxes_and_charges, d.currency));
		this.$body.find("#ef-grand-total").text(_fmtCurrency(d.grand_total, d.currency));
		this.$body.find("#ef-header-grand-total").text(_fmtCurrency(d.grand_total, d.currency));
		this.$body.find("#ef-words").text(d.in_words || "");
	}

	// -----------------------------------------------------------------------
	// Lock / Unlock fields (after submit)
	// -----------------------------------------------------------------------

	_lock_fields() {
		const $b = this.$body;
		$b.find(
			"#ef-establecimiento, #ef-naming-series, #ef-posting-date, #ef-due-date, " +
			"#ef-bfel-identificacion, #ef-bfel-nit, #ef-bfel-nombre, #ef-bfel-status, #ef-bfel-escenario-exento, #ef-terms"
		).prop("disabled", true);
		Object.values(this.controls).forEach((ctrl) => {
			if (ctrl && ctrl.$input) ctrl.$input.prop("disabled", true);
		});
		$b.find(".ef-cell-input:not([readonly])").prop("disabled", true);
		$b.find("#ef-add-row").prop("disabled", true);
		$b.find(".ef-btn-del").prop("disabled", true).css("visibility", "hidden");
	}

	_unlock_fields() {
		const $b = this.$body;
		$b.find(
			"#ef-establecimiento, #ef-naming-series, #ef-posting-date, #ef-due-date, " +
			"#ef-bfel-identificacion, #ef-bfel-nit, #ef-bfel-nombre, #ef-bfel-status, #ef-terms"
		).prop("disabled", false);
		// bfel_escenario_exento solo se habilita si la plantilla de impuestos empieza con EXE
		this._toggle_escenario_exento(this.doc.taxes_and_charges);
		Object.values(this.controls).forEach((ctrl) => {
			if (ctrl && ctrl.$input) ctrl.$input.prop("disabled", false);
		});
		$b.find(".ef-cell-input:not([readonly])").prop("disabled", false);
		$b.find("#ef-add-row").prop("disabled", false);
		$b.find(".ef-btn-del").prop("disabled", false).css("visibility", "visible");
	}

	// -----------------------------------------------------------------------
	// Sync UI ← Doc
	// -----------------------------------------------------------------------

	_sync_ui_from_doc() {
		const d = this.doc;

		// Establecer valor de establecimiento
		this.$body.find("#ef-establecimiento").val(d.bfel_establecimiento || "");

		// Cargar series compatibles en base al establecimiento
		this._load_naming_series_for_selected_establishment();

		["customer", "payment_terms_template", "taxes_and_charges", "sales_partner"].forEach((f) => {
			if (this.controls[f]) {
				this.controls[f].set_value(d[f] || "");
			}
		});

		this.$body.find("#ef-posting-date").val(d.posting_date || "");
		this.$body.find("#ef-due-date").val(d.due_date || "");
		this.$body.find("#ef-bfel-nombre").val(d.bfel_nombre || "");
		this.$body.find("#ef-bfel-identificacion").val(d.bfel_identificacion || "");
		this.$body.find("#ef-bfel-nit").val(d.bfel_nit || "");
		this.$body.find("#ef-bfel-status").val(d.bfel_status || "01 Enviar");
		this.$body.find("#ef-terms").val(d.terms || "");
		this._toggle_escenario_exento(d.taxes_and_charges);
		this.$body.find("#ef-bfel-escenario-exento").val(d.bfel_escenario_exento || "");

		this._render_items();
		this._update_footer();
		this._update_status_badge();
		this._update_fel_info();
		this._render_payments_tab();
		this._update_action_bar_state();

		// Bloquear campos si ya fue validada, cancelada, o si no es una factura FacEx
		const _isNew = d.name === "new" || !d.name;
		if (d.docstatus === 1 || d.docstatus === 2 || (!_isNew && d.es_fiscal === 0)) {
			setTimeout(() => this._lock_fields(), 60);
		} else {
			this._unlock_fields();
		}

		// Visibilidad de Pagos
		if (d.docstatus === 1) {
			this.$body.find('[data-tab="pagos"]').show();
			this.$body.find(".ef-footer-pay-status").show();
		} else {
			this.$body.find('[data-tab="pagos"]').hide();
			this.$body.find(".ef-footer-pay-status").hide();
			if (this.$body.find('[data-tab="pagos"]').hasClass("ef-tab-active")) {
				this._switch_tab("factura");
			}
		}
	}

	_update_status_badge() {
		const $badge = this.$body.find("#ef-status-badge");
		const $name = this.$body.find("#ef-doc-name");
		const $title = this.$body.find("#ef-doc-title");
		const d = this.doc;

		$name.text(d.name !== "new" ? d.name : "");

		let doc_title = "";
		if (d.name === "new" || !d.name) {
			doc_title = "NUEVA PRE-FACTURA";
			$badge.text("NUEVO").removeClass().addClass("ef-badge ef-badge-new");
		} else if (d.docstatus === 0) {
			doc_title = "PRE-FACTURA";
			$badge.text("BORRADOR").removeClass().addClass("ef-badge ef-badge-draft");
		} else if (d.docstatus === 1) {
			const fel = d.bfel_status;
			if (fel === "02 Procesada" || d.bfel_uuid) {
				doc_title = "FACTURA";
				$badge.text("CERTIFICADO").removeClass().addClass("ef-badge ef-badge-certified");
			} else if (fel === "01 Enviar") {
				doc_title = "FACTURA (Pendiente Certificar)";
				$badge.text("VALIDADO").removeClass().addClass("ef-badge ef-badge-submitted");
			} else if (fel === "00 No enviar") {
				doc_title = "FACTURA (interna)";
				$badge.text("VALIDADO").removeClass().addClass("ef-badge ef-badge-submitted");
			} else {
				doc_title = "FACTURA";
				$badge.text("VALIDADO").removeClass().addClass("ef-badge ef-badge-submitted");
			}
		} else if (d.docstatus === 2) {
			doc_title = "FACTURA (Cancelada)";
			$badge.text("CANCELADO").removeClass().addClass("ef-badge ef-badge-cancelled");
		}
		$title.text(doc_title);
	}

	_update_fel_info() {
		const d = this.doc;
		this.$body.find("#ef-bfel-uuid").val(d.bfel_uuid || "");
		this.$body.find("#ef-bfel-docto-no").val(d.bfel_docto_no || "");

		// Punto 6: los campos avanzados FEL (UUID, No. Doc.) solo se muestran
		// una vez que la factura tiene certificación real; antes, solo un aviso.
		const certified = !!d.bfel_uuid;
		this.$body.find("#ef-fel-cert-block").toggle(certified);
		this.$body.find("#ef-fel-pending-msg").toggle(!certified);

		this._update_header_sections();
	}

	// -----------------------------------------------------------------------
	// Action Bar
	// -----------------------------------------------------------------------

	_setup_action_bar() {
		const $bar = $(`
<div class="ef-action-bar" id="ef-action-bar">
  <button id="ef-btn-save" class="ef-btn ef-btn-primary" title="Guardar borrador (F3)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
    <span class="ef-btn-label">Guardar</span>
    <kbd class="ef-kbd">F3</kbd>
  </button>
  <button id="ef-btn-cancel-changes" class="ef-btn ef-btn-danger" title="Descartar cambios" style="display:none">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    <span class="ef-btn-label">Cancelar</span>
  </button>
  <button id="ef-btn-submit" class="ef-btn ef-btn-success" title="Validar factura (F3)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
    <span class="ef-btn-label">Validar</span>
    <kbd class="ef-kbd">F3</kbd>
  </button>
  <button id="ef-btn-certify" class="ef-btn ef-btn-warning" title="Certificar FEL (F3)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
    <span class="ef-btn-label">Certificar</span>
    <kbd class="ef-kbd">F3</kbd>
  </button>
  <button id="ef-btn-cancel-fel" class="ef-btn ef-btn-danger" title="Cancelar FEL" style="display:none">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
    <span class="ef-btn-label">Cancelar FEL</span>
  </button>
  <button id="ef-btn-cancel-doc" class="ef-btn ef-btn-danger" title="Anular Factura ERPNext" style="display:none">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
    <span class="ef-btn-label">Anular</span>
  </button>
  <button id="ef-btn-duplicate" class="ef-btn ef-btn-secondary" title="Duplicar como nueva pre-factura" style="display:none">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
    <span class="ef-btn-label">Duplicar</span>
  </button>
  <button id="ef-btn-guia-transporte" class="ef-btn ef-btn-teal" title="Guía de Transporte" style="display:none">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"></rect><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"></polygon><circle cx="5.5" cy="18.5" r="2.5"></circle><circle cx="18.5" cy="18.5" r="2.5"></circle></svg>
    <span class="ef-btn-label">Guía de Transporte</span>
  </button>
  <button id="ef-btn-print" class="ef-btn ef-btn-info" title="Imprimir (F4)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
    <span class="ef-btn-label">Imprimir</span>
    <kbd class="ef-kbd">F4</kbd>
  </button>
  <button id="ef-btn-pdf" class="ef-btn ef-btn-danger" title="Descargar PDF" style="display:none">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
    <span class="ef-btn-label">PDF</span>
  </button>
  <button id="ef-btn-new" class="ef-btn ef-btn-light" title="Nueva Factura (F9)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
    <span class="ef-btn-label">Nueva Fac</span>
    <kbd class="ef-kbd">F9</kbd>
  </button>
  <button id="ef-btn-customer" class="ef-btn ef-btn-secondary" title="Buscar / crear cliente (F10)">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    <span class="ef-btn-label">Cliente</span>
    <kbd class="ef-kbd">F10</kbd>
  </button>
  <button id="ef-btn-open-erp" class="ef-btn ef-btn-light" title="Abrir en ERPNext">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
    <span class="ef-btn-label">Abrir ERP</span>
  </button>
</div>`);
		$(this.wrapper).append($bar);
		$bar.hide();

		$bar.find("#ef-btn-save").on("click", () => this._action_save());
		$bar.find("#ef-btn-cancel-changes").on("click", () => this._action_cancel_changes());
		$bar.find("#ef-btn-submit").on("click", () => this._action_submit());
		$bar.find("#ef-btn-certify").on("click", () => this._action_certify());
		$bar.find("#ef-btn-cancel-doc").on("click", () => this._action_cancel_doc());
		$bar.find("#ef-btn-cancel-fel").on("click", () => this._action_cancel_fel());
		$bar.find("#ef-btn-duplicate").on("click", () => this._action_duplicate());
		$bar.find("#ef-btn-guia-transporte").on("click", () => this._action_guias_transporte());
		$bar.find("#ef-btn-print").on("click", () => this._action_print());
		$bar.find("#ef-btn-pdf").on("click", () => this._action_pdf());
		$bar.find("#ef-btn-new").on("click", () => this._action_new());
		$bar.find("#ef-btn-customer").on("click", () => this._action_customer());
		$bar.find("#ef-btn-open-erp").on("click", () => this._action_open_erp());

		this.$bar = $bar;
		this._update_action_bar_state();
	}

	_update_action_bar_state() {
		const d = this.doc;
		const isNew       = d.name === "new" || !d.name;
		const isDraft     = d.docstatus === 0;
		const isSubmitted = d.docstatus === 1;
		const isCancelled = d.docstatus === 2;
		const isCertified = isSubmitted && d.bfel_status === "02 Procesada";
		const isDirty     = this._dirty;
		const hasItems    = d.items && d.items.length > 0;

		const btn    = (id) => this.$bar && this.$bar.find(id);
		const show   = (id) => btn(id).show();
		const hide   = (id) => btn(id).hide();
		const enable = (id) => btn(id).prop("disabled", false);

		// Ocultar todo primero, luego mostrar solo lo necesario
		["#ef-btn-save", "#ef-btn-cancel-changes", "#ef-btn-submit",
		 "#ef-btn-certify", "#ef-btn-cancel-doc", "#ef-btn-cancel-fel", "#ef-btn-print", "#ef-btn-open-erp", "#ef-btn-customer", "#ef-btn-pdf",
		 "#ef-btn-duplicate", "#ef-btn-guia-transporte"].forEach(hide);
		btn("#ef-btn-save").removeClass("ef-btn-save-dirty");

		// Siempre visibles: Nueva Fac
		show("#ef-btn-new"); enable("#ef-btn-new");

		if (isNew) {
			// caso 1: sin guardar → Guardar + Nueva Fac + Cliente
			show("#ef-btn-customer"); enable("#ef-btn-customer");
			show("#ef-btn-save"); btn("#ef-btn-save").prop("disabled", !hasItems);

		} else if (isDraft) {
			if (isDirty) {
				// borrador con cambios: Guardar pulsante + Cancelar
				show("#ef-btn-save"); btn("#ef-btn-save").prop("disabled", !hasItems);
				btn("#ef-btn-save").addClass("ef-btn-save-dirty");
				show("#ef-btn-cancel-changes"); enable("#ef-btn-cancel-changes");
			} else {
				// caso 2: borrador limpio → Validar + Imprimir + Abrir ERP
				show("#ef-btn-submit"); btn("#ef-btn-submit").prop("disabled", !hasItems);
				show("#ef-btn-print"); enable("#ef-btn-print");
				show("#ef-btn-open-erp"); enable("#ef-btn-open-erp");
			}

		} else if (isSubmitted) {
			show("#ef-btn-print"); enable("#ef-btn-print");
			show("#ef-btn-open-erp"); enable("#ef-btn-open-erp");
			show("#ef-btn-duplicate"); enable("#ef-btn-duplicate");
			// caso 3: pendiente de certificar FEL
			if (!isCertified && d.bfel_status !== "00 No enviar") {
				show("#ef-btn-certify"); enable("#ef-btn-certify");
				show("#ef-btn-cancel-doc"); enable("#ef-btn-cancel-doc"); // Permitir anular desde ERPNext si aún no es FEL
			} else if (isCertified && d.bfel_uuid && !d.bfel_documento_anulado) {
				show("#ef-btn-cancel-fel"); enable("#ef-btn-cancel-fel");
			} else if (!isCertified && d.bfel_status === "00 No enviar") {
				show("#ef-btn-cancel-doc"); enable("#ef-btn-cancel-doc");
			}
			// Asociar Guía de Transporte: solo con factura ya validada y permiso
			// puede_editar_guias_transporte (mismo flag que gatea el botón
			// equivalente en facex_screen.js).
			if (this.perms && this.perms.puede_editar_guias_transporte) {
				show("#ef-btn-guia-transporte"); enable("#ef-btn-guia-transporte");
				this._refresh_guia_transporte_label();
			}

		} else if (isCancelled) {
			show("#ef-btn-print"); enable("#ef-btn-print");
			show("#ef-btn-open-erp"); enable("#ef-btn-open-erp");
			show("#ef-btn-duplicate"); enable("#ef-btn-duplicate");
		}

		// Factura no creada desde FacEx — vista limitada
		if (!isNew && d.es_fiscal === 0) {
			["#ef-btn-save", "#ef-btn-cancel-changes", "#ef-btn-submit", "#ef-btn-certify", "#ef-btn-duplicate"].forEach(hide);
			show("#ef-btn-print"); enable("#ef-btn-print");
			show("#ef-btn-open-erp"); enable("#ef-btn-open-erp");
		}

		// Botón PDF: si tiene bfel_uuid, chequear url_pdf con cache
		if (d.bfel_uuid) {
			const cacheKey = d.company;
			this._url_pdf_cache = this._url_pdf_cache || {};
			if (this._url_pdf_cache[cacheKey] !== undefined) {
				if (this._url_pdf_cache[cacheKey]) {
					show("#ef-btn-pdf"); enable("#ef-btn-pdf");
				} else {
					hide("#ef-btn-pdf");
				}
			} else {
				frappe.call({
					method: "frappe.client.get_value",
					args: {
						doctype: "BFEL Settings",
						filters: { company: d.company, enabled: 1 },
						fieldname: "url_pdf"
					},
					callback: (r) => {
						const url = r.message ? r.message.url_pdf : null;
						this._url_pdf_cache[cacheKey] = url || "";
						if (url) {
							if (this.doc && this.doc.bfel_uuid === d.bfel_uuid) {
								show("#ef-btn-pdf"); enable("#ef-btn-pdf");
							}
						} else {
							hide("#ef-btn-pdf");
						}
					}
				});
			}
		} else {
			hide("#ef-btn-pdf");
		}

		// Permisos FacEx Settings — prevalecen sobre estado del documento
		const p = this.perms;
		if (!p.puede_guardar)    hide("#ef-btn-save");
		if (!p.puede_validar)    hide("#ef-btn-submit");
		if (!p.puede_certificar) hide("#ef-btn-certify");
		if (!p.puede_guardar)    hide("#ef-btn-duplicate");

		this._update_tabs_state();
	}

	// -----------------------------------------------------------------------
	// Actions
	// -----------------------------------------------------------------------

	_action_save() {
		if (this._request_pending) return;
		if (!this._validate_header()) return;

		// REFUERZO: Validar que si hay taxes_and_charges se hayan calculado antes de guardar
		if (this.doc.taxes_and_charges && !this.doc._taxes_template) {
			frappe.show_alert({ message: "Calculando impuestos, por favor espere un momento e intente guardar de nuevo.", indicator: "orange" });
			this._fetch_tax_template(this.doc.taxes_and_charges);
			return;
		}

		this._request_pending = true;
		this.$body.find("#ef-btn-save").prop("disabled", true);

		frappe.call({
			method: "facex_multi.api.invoice.save_draft",
			args: { doc_json: JSON.stringify(this._build_save_payload()) },
			freeze: true,
			freeze_message: "Guardando factura...",
			callback: (r) => {
				this._request_pending = false;
				this.$body.find("#ef-btn-save").prop("disabled", false);
				if (!r.exc && r.message) {
					const cachedTpl = this.doc._taxes_template;
					this._dirty = false;
					this.doc = r.message;
					this.doc._taxes_template = cachedTpl;
					this._sync_ui_from_doc();
					this._update_action_bar_state();
					frappe.show_alert({
						message: `Guardado: <strong>${this.doc.name}</strong>`,
						indicator: "green",
					});
				}
			},
			error: () => {
				this._request_pending = false;
				this.$body.find("#ef-btn-save").prop("disabled", false);
			}
		});
	}

	_action_cancel_changes() {
		frappe.confirm(
			"¿Descartar cambios y regresar al último estado guardado?",
			() => {
				this._dirty = false;
				this.load_invoice(this.doc.name);
			}
		);
	}

	async _action_submit() {
		if (!this.doc.name || this.doc.name === "new") {
			frappe.show_alert({ message: "Primero guarde la factura.", indicator: "orange" });
			return;
		}
		if (this._request_pending) return;

		// ── Pre-check 1: cliente genérico no puede comprar ARMAS ni MUNICIÓN ──
		const GRUPOS_RESTRINGIDOS = ["ARMAS", "MUNICIÓN"];
		const tiene_restringidos = (this.doc.items || [])
			.some(i => GRUPOS_RESTRINGIDOS.includes(i._item_group || i.item_group || ""));

		if (tiene_restringidos && this.doc.customer) {
			try {
				const cdata = await frappe.xcall("frappe.client.get_value", {
					doctype: "Customer",
					filters: { name: this.doc.customer },
					fieldname: ["custom_cliente_generico"],
				});
				if (cdata && cdata.custom_cliente_generico) {
					frappe.msgprint({
						title: __("Venta no permitida"),
						indicator: "red",
						message: __("No se puede facturar Armas o Munición a un cliente genérico."),
					});
					return;
				}
			} catch (_) { /* si falla la consulta, continuar — el servidor valida también */ }
		}

		// ── Pre-check 2: completar adendas DIGECAM pendientes ──
		try {
			await this._validar_adendas_pendientes();
		} catch (_) {
			frappe.show_alert({
				message: __("Complete todas las adendas DIGECAM antes de validar."),
				indicator: "orange",
			});
			return;
		}

		// ── Guardar adendas en BD antes de someter ──
		if (this._dirty) {
			try {
				await this._guardar_antes_de_submit();
			} catch (_) {
				frappe.show_alert({ message: __("Error al guardar adendas. Intente de nuevo."), indicator: "red" });
				return;
			}
		}

		// ── Confirmación y submit ──
		frappe.confirm(
			`¿Desea <strong>Validar</strong> la factura <strong>${this.doc.name}</strong>?<br>
			 Esta acción no se puede deshacer directamente.`,
			() => {
				if (this._request_pending) return;
				this._request_pending = true;
				this.$body.find("#ef-btn-submit").prop("disabled", true);

				frappe.call({
					method: "facex_multi.api.invoice.submit_invoice",
					args: { name: this.doc.name },
					freeze: true,
					freeze_message: "Validando factura...",
					callback: (r) => {
						this._request_pending = false;
						this.$body.find("#ef-btn-submit").prop("disabled", false);
						if (!r.exc && r.message) {
							this._dirty = false;
							this.load_invoice(this.doc.name);
							frappe.show_alert({
								message: `Factura <strong>${this.doc.name}</strong> validada.`,
								indicator: "green",
							});
						}
					},
					error: () => {
						this._request_pending = false;
						this.$body.find("#ef-btn-submit").prop("disabled", false);
					},
				});
			}
		);
	}

	_action_certify() {
		if (!this.doc.name || this.doc.docstatus !== 1) {
			frappe.show_alert({ message: "Solo se puede certificar una factura Validada.", indicator: "orange" });
			return;
		}
		if (this.doc.bfel_status === "02 Procesada") {
			frappe.show_alert({ message: "Esta factura ya fue certificada en FEL.", indicator: "blue" });
			return;
		}

		if (this._request_pending) return;
		this._request_pending = true;
		this.$body.find("#ef-btn-certify").prop("disabled", true);

		frappe.call({
			method: "frappe.client.get_value",
			args: {
				doctype: "BFEL Settings",
				filters: { company: this.doc.company, enabled: 1 },
				fieldname: ["certifier", "test_mode"]
			},
			callback: (r) => {
				const settings = r.message || {};
				const certifier = settings.certifier || "Digifact";
				const testMode = settings.test_mode || "N";

				frappe.confirm(
					`¿Certificar <strong>${this.doc.name}</strong> en FEL (${certifier})?`,
					() => {
						frappe.call({
							method: "facex_multi.api.invoice.certify_invoice",
							args: { name: this.doc.name },
							freeze: true,
							freeze_message: "Certificando en FEL...",
							callback: (r) => {
								this._request_pending = false;
								this.$body.find("#ef-btn-certify").prop("disabled", false);
								if (!r.exc && r.message && r.message.success) {
									const res = r.message;
									const isTest = res.test_mode === true || res.test_mode === 1 || res.test_mode === "Y" || (res.test_mode === undefined && testMode === "Y");
									frappe.msgprint({
										title: "Certificación FEL Exitosa",
										indicator: "green",
										message: `UUID: <strong>${res.uuid || "-"}</strong><br>
										          Serie: ${res.serie || "-"} &nbsp; No.: ${res.numero || "-"}<br>
										          ${isTest ? "<em>(MODO PRUEBA)</em>" : ""}`,
									});
									this.load_invoice(this.doc.name);
								}
							},
							error: () => {
								this._request_pending = false;
								this.$body.find("#ef-btn-certify").prop("disabled", false);
							}
						});
					},
					() => {
						this._request_pending = false;
						this.$body.find("#ef-btn-certify").prop("disabled", false);
					}
				);
			},
			error: () => {
				this._request_pending = false;
				this.$body.find("#ef-btn-certify").prop("disabled", false);
			}
		});
	}

	_action_cancel_doc() {
		if (!this.doc.name || this.doc.docstatus !== 1) {
			frappe.show_alert({ message: "Solo se puede anular una factura Validada.", indicator: "orange" });
			return;
		}

		frappe.confirm(
			`¿Seguro que desea <strong>Anular</strong> la factura <strong>${this.doc.name}</strong> en ERPNext?<br><br>
			 <span style="color:red; font-weight:bold;">Nota: Dado que este documento aún no ha sido certificado en FEL (SAT), únicamente se anulará de forma local en ERPNext, revirtiendo asientos contables e inventario.</span>`,
			() => {
				frappe.call({
					method: "facex_multi.api.invoice.cancel_invoice",
					args: { name: this.doc.name },
					freeze: true,
					freeze_message: "Anulando factura...",
					callback: (r) => {
						if (!r.exc && r.message && r.message.success) {
							frappe.show_alert({ message: `Factura <strong>${this.doc.name}</strong> Anulada localmente con éxito (sin afectación FEL).`, indicator: "green" });
							this.load_invoice(this.doc.name);
						}
					},
				});
			}
		);
	}

	_action_print() {
		if (!this.doc.name || this.doc.name === "new") return;

		// Si está validada (docstatus === 1) pero no ha sido certificada (y no es "00 No enviar")
		if (this.doc.docstatus === 1 && this.doc.bfel_status !== "02 Procesada" && this.doc.bfel_status !== "00 No enviar") {
			frappe.show_alert({
				message: "La factura está validada pero no ha sido certificada en FEL. No se puede imprimir.",
				indicator: "red"
			});
			return;
		}

		frappe.call({
			method: "facex_multi.api.invoice.get_print_formats",
			args: { company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				const formats = r.message || [];
				let defaultFormat = "";

				if (this.doc.docstatus === 0) {
					// Guardada sin validar (Borrador) → buscar la que contenga "COTI"
					defaultFormat = formats.find(f => f.toUpperCase().includes("COTI")) || "";
				} else if (this.doc.docstatus === 1) {
					// Validada → buscar la que contenga "CERTIFI" o "FEL"
					defaultFormat = formats.find(f => f.toUpperCase().includes("CERTIFI")) || formats.find(f => f.toUpperCase().includes("FEL")) || "";
				}

				if (defaultFormat) {
					this._open_print(defaultFormat);
				} else {
					if (formats.length <= 1) {
						this._open_print(formats[0] || "");
					} else {
						this._show_print_format_dialog(formats);
					}
				}
			},
		});
	}

	_action_pdf() {
		if (!this.doc.name || this.doc.name === "new") return;
		if (!this.doc.bfel_uuid) {
			frappe.show_alert({ message: "El documento debe estar certificado para descargar su PDF.", indicator: "orange" });
			return;
		}
		const url = frappe.urllib.get_full_url(`/api/method/facex_multi.api.invoice.preview_fel_pdf?invoice_name=${encodeURIComponent(this.doc.name)}`);
		window.open(url, "_blank");
	}

	_open_print(format) {
		let url = `/printview?doctype=Sales+Invoice&name=${encodeURIComponent(this.doc.name)}&trigger_print=1`;
		if (format) url += `&format=${encodeURIComponent(format)}`;
		window.open(url, "_blank");
	}

	_show_print_format_dialog(formats) {
		const d = new frappe.ui.Dialog({
			title: "Seleccionar Formato de Impresión",
			fields: [{
				fieldtype: "Select",
				fieldname: "format",
				label: "Formato de Impresión",
				options: formats.join("\n"),
				default: formats[0],
			}],
			primary_action_label: "Imprimir",
			primary_action: (values) => {
				d.hide();
				this._open_print(values.format);
			},
		});
		d.show();
	}

	_action_new() {
		if (this.doc.docstatus === 0 && this.doc.name !== "new" && this.doc.name) {
			frappe.confirm(
				"¿Crear nueva factura? Los cambios no guardados se perderán.",
				() => this._new_invoice()
			);
		} else {
			this._new_invoice();
		}
	}

	_action_duplicate() {
		if (this._request_pending) return;
		if (!this.doc || !this.doc.name || this.doc.name === "new") return;

		frappe.confirm(
			`¿Duplicar la factura <strong>${this.doc.name}</strong> como una nueva pre-factura? ` +
			`No se copiarán los datos de certificación FEL (UUID, serie, número, fecha) ni los pagos ya aplicados; ` +
			`la copia quedará en estado "01 Enviar".`,
			() => {
				this._request_pending = true;
				frappe.call({
					method: "facex_multi.api.invoice.duplicate_invoice",
					args: { name: this.doc.name },
					freeze: true,
					freeze_message: "Duplicando factura...",
					callback: (r) => {
						this._request_pending = false;
						if (!r.exc && r.message) {
							this._dirty = false;
							this.doc = r.message;
							this.doc._taxes_template = null;
							this._sync_ui_from_doc();
							this._update_action_bar_state();
							if (this.doc.taxes_and_charges) {
								this._fetch_tax_template(this.doc.taxes_and_charges);
							}
							this._switch_view("billing");
							frappe.show_alert({
								message: "Factura duplicada. Revise los datos y presione Guardar.",
								indicator: "blue",
							});
						}
					},
					error: () => { this._request_pending = false; }
				});
			}
		);
	}

	_action_open_erp() {
		if (!this.doc.name || this.doc.name === "new") return;
		const url = `/app/sales-invoice/${encodeURIComponent(this.doc.name)}`;
		window.open(url, "_blank");
	}

	_refresh_guia_transporte_label() {
		const count = (this.doc.bfel_guias_transportista || []).length;
		const $label = this.$bar && this.$bar.find("#ef-btn-guia-transporte .ef-btn-label");
		if ($label && $label.length) {
			$label.text(count ? __("Guía ({0})", [count]) : __("Guía de Transporte"));
		}
	}

	// Mismo flujo que el botón "Guía de Transporte" de facex_screen.js
	// (_open_confirm_guias_dialog): muestra en modo lectura lo ya guardado en
	// this.doc.bfel_guias_transportista y permite agregar más filas vía
	// save_guias_transporte (AGREGA, no reemplaza, así que las guías
	// existentes nunca se reenvían).
	_action_guias_transporte() {
		if (!this.doc || !this.doc.name || this.doc.name === "new" || this.doc.docstatus !== 1) return;

		const dlg = new frappe.ui.Dialog({
			title: __("Guía de Transporte — {0}", [this.doc.name]),
			fields: [{ fieldname: "html", fieldtype: "HTML" }],
		});

		const renderExisting = () => {
			const rows = this.doc.bfel_guias_transportista || [];
			dlg.fields_dict.html.$wrapper.html(`
				${rows.length ? `
					<table class="ef-table">
						<thead><tr><th>${__("Transportista")}</th><th>${__("Guía")}</th><th>${__("Piezas")}</th><th>${__("Destino")}</th><th>${__("Monto COD")}</th><th>${__("Estado")}</th></tr></thead>
						<tbody>
							${rows.map((r) => `
								<tr>
									<td>${_esc(r.transportista || "")}</td>
									<td>${_esc(r.numero_guia || "")}</td>
									<td>${r.piezas || 0}</td>
									<td>${_esc(r.destino || "")}</td>
									<td>Q ${_fmt(r.monto_cod)}</td>
									<td>${_esc(r.estado_entrega || "")}</td>
								</tr>
							`).join("")}
						</tbody>
					</table>
				` : `<div class="ef-empty-hint">${__("Todavía no tiene guías registradas.")}</div>`}
				<button type="button" class="ef-btn-link" id="ef-guia-add-more" style="margin-top:10px;">${__("+ Agregar guía")}</button>
			`);
			dlg.$wrapper.find("#ef-guia-add-more").on("click", () => {
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
								this._refresh_guia_transporte_label();
							},
						});
					},
				});
			});
		};

		renderExisting();
		dlg.show();
	}

	// Diálogo con filas dinámicas (transportista/guía/piezas/destino/monto
	// COD) — mismo patrón que _show_guias_transporte_dialog en
	// facex_screen.js. "Guardar Guías" exige transportista + número de guía
	// por fila.
	_show_guias_transporte_dialog({ initialRows = [], onSave } = {}) {
		const openDialog = (transportistas) => {
			const options = transportistas.map((t) => `<option value="${_esc(t.name)}">${_esc(t.name)}</option>`).join("");
			const $rows = $('<div class="ef-guias-rows"></div>');
			const $addBtn = $(`<button class="ef-btn-link" type="button">${__("+ Agregar otra guía")}</button>`);

			const addRow = (data = {}) => {
				const $row = $(`
					<div class="ef-guia-row">
						<select class="ef-guia-transportista">
							<option value="">${__("Transportista…")}</option>
							${options}
						</select>
						<input type="text" class="ef-guia-numero" placeholder="${__("Número de guía")}" />
						<input type="number" class="ef-guia-piezas" placeholder="${__("Piezas")}" min="1" value="1" />
						<input type="text" class="ef-guia-destino" placeholder="${__("Destino")}" />
						<input type="number" class="ef-guia-monto" placeholder="${__("Monto COD")}" min="0" step="any" />
						<button class="ef-line-remove" type="button">×</button>
					</div>
				`);
				$row.find(".ef-guia-transportista").val(data.transportista || "");
				$row.find(".ef-guia-numero").val(data.numero_guia || "");
				$row.find(".ef-guia-piezas").val(data.piezas || 1);
				$row.find(".ef-guia-destino").val(data.destino || "");
				$row.find(".ef-guia-monto").val(data.monto_cod != null && data.monto_cod !== "" ? data.monto_cod : "");
				$row.find(".ef-line-remove").on("click", () => {
					if ($rows.children().length > 1) {
						$row.remove();
					} else {
						$row.find("input").val("");
						$row.find(".ef-guia-piezas").val(1);
						$row.find("select").val("");
					}
				});
				$rows.append($row);
			};

			(initialRows.length ? initialRows : [{}]).forEach((g) => addRow(g));
			$addBtn.on("click", () => addRow());

			const collectRows = () => {
				const out = [];
				$rows.find(".ef-guia-row").each((_, el) => {
					const $r = $(el);
					const transportista = $r.find(".ef-guia-transportista").val();
					const numero_guia = ($r.find(".ef-guia-numero").val() || "").trim();
					if (!transportista && !numero_guia) return; // fila vacía, se ignora
					out.push({
						transportista,
						numero_guia,
						piezas: parseInt($r.find(".ef-guia-piezas").val()) || 1,
						destino: $r.find(".ef-guia-destino").val() || "",
						monto_cod: parseFloat($r.find(".ef-guia-monto").val()) || 0,
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
				secondary_action_label: __("Cancelar"),
				secondary_action: () => dlg.hide(),
			});

			dlg.$body.append(
				$('<div class="ef-guias-hint"></div>').text(__("Puede agregar varias guías si el envío se divide en varios paquetes o transportistas.")),
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
	// Load existing invoice
	// -----------------------------------------------------------------------

	load_invoice(name) {
		frappe.call({
			method: "facex_multi.api.invoice.get_invoice",
			args: { name: name },
			freeze: true,
			freeze_message: "Cargando factura...",
			callback: (r) => {
				if (!r.exc && r.message) {
					this._dirty = false;
					this.doc = r.message;
					this.doc._taxes_template = null;
					this._sync_ui_from_doc();
					this._update_action_bar_state();
					if (this.doc.taxes_and_charges) {
						this._fetch_tax_template(this.doc.taxes_and_charges);
					}
					this._switch_view("billing");
					frappe.show_alert({
						message: `Cargado: <strong>${this.doc.name}</strong>`,
						indicator: "blue",
					});
				}
			},
		});
	}

	_show_change_password_dialog() {
		const dlg = new frappe.ui.Dialog({
			title: "Cambiar Contraseña",
			fields: [
				{
					fieldtype: "Password",
					fieldname: "old_password",
					label: "Contraseña Actual",
					reqd: 1,
				},
				{
					fieldtype: "Password",
					fieldname: "new_password",
					label: "Nueva Contraseña",
					reqd: 1,
				},
				{
					fieldtype: "Password",
					fieldname: "confirm_password",
					label: "Confirmar Nueva Contraseña",
					reqd: 1,
				}
			],
			primary_action_label: "Actualizar Contraseña",
			primary_action: (values) => {
				if (values.new_password !== values.confirm_password) {
					frappe.msgprint({
						title: "Error de Validación",
						message: "La nueva contraseña y la confirmación no coinciden.",
						indicator: "red"
					});
					return;
				}

				dlg.get_primary_btn().attr("disabled", true);

				frappe.call({
					method: "frappe.core.doctype.user.user.update_password",
					args: {
						old_password: values.old_password,
						new_password: values.new_password,
						logout_all_sessions: 0
					},
					callback: (r) => {
						dlg.get_primary_btn().attr("disabled", false);
						if (!r.exc) {
							frappe.show_alert({
								message: "Contraseña actualizada exitosamente.",
								indicator: "green"
							});
							dlg.hide();
						}
					},
					error: () => {
						dlg.get_primary_btn().attr("disabled", false);
					}
				});
			}
		});
		dlg.show();
	}

	// -----------------------------------------------------------------------
	// Keyboard Shortcuts
	// -----------------------------------------------------------------------

	_bind_events() {
		// User profile dropdown
		this.$body.find("#ef-btn-user-profile").on("click", (e) => {
			e.stopPropagation();
			const $menu = this.$body.find("#ef-user-dropdown-menu");
			if ($menu.is(":hidden")) {
				this.$body.find("#ef-active-user-fullname").text(frappe.session.user_fullname || "Usuario");
				this.$body.find("#ef-active-user-email").text(frappe.session.user);
				// Load companies for switcher
				frappe.call({
					method: "facex_multi.api.invoice.get_user_companies",
					callback: (r) => {
						if (!r.exc && r.message && r.message.length > 1) {
							const $sel = this.$body.find("#ef-company-select");
							const $sec = this.$body.find("#ef-company-switcher-section");
							const currentCompany = this.defaults.company || "";
							$sel.empty();
							r.message.forEach(c => {
								$sel.append(`<option value="${_esc(c)}"${c === currentCompany ? ' selected' : ''}>${_esc(c)}</option>`);
							});
							$sec.show();
						}
					}
				});
				$menu.fadeIn(150);
			} else {
				$menu.fadeOut(150);
			}
		});

		this.$body.find("#ef-btn-switch-company").on("click", (e) => {
			e.stopPropagation();
			const company = this.$body.find("#ef-company-select").val();
			if (!company) return;
			frappe.call({
				method: "facex_multi.api.invoice.set_active_company",
				args: { company },
				freeze: true,
				freeze_message: `Cambiando a ${company}...`,
				callback: (r) => {
					if (!r.exc) {
						frappe.show_alert({ message: `Compañía cambiada a <b>${company}</b>. Recargando...`, indicator: "green" });
						setTimeout(() => window.location.reload(), 1200);
					}
				}
			});
		});

		this.$body.find("#ef-btn-logout").on("click", () => {
			frappe.app.logout();
		});

		this.$body.find("#ef-btn-change-password").on("click", (e) => {
			e.stopPropagation();
			this.$body.find("#ef-user-dropdown-menu").fadeOut(150);
			this._show_change_password_dialog();
		});

		$(document).on("click.ef_user_dropdown", (e) => {
			const $menu = this.$body.find("#ef-user-dropdown-menu");
			if (!$(e.target).closest('.ef-user-dropdown').length) {
				$menu.fadeOut(150);
			}
		});

		$(document).off("keydown.efast").on("keydown.efast", (e) => {
			// Bail if EFast page is not the active/visible page
			if (!$(this.wrapper).is(":visible")) return;
			// Bail if a modal or dialog is open
			if ($(".modal.show, .modal.in").length) return;

			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				this._action_save();
			} else if ((e.ctrlKey || e.metaKey) && e.key === "n") {
				e.preventDefault();
				this._action_new();
			} else if (e.key === "F2") {
				e.preventDefault();
				this._add_item_row();

			// ── F3: Guardar → Validar → Certificar (contextual) ───────────
			} else if (e.key === "F3") {
				e.preventDefault();
				const d = this.doc;
				const hasItems = d.items && d.items.length > 0;
				if (!d.name || d.name === "new" || this._dirty) {
					if (!hasItems) {
						frappe.show_alert({ message: "Agregue al menos un artículo antes de guardar.", indicator: "orange" });
					} else {
						this._action_save();
					}
				} else if (d.docstatus === 0) {
					if (!hasItems) {
						frappe.show_alert({ message: "Agregue al menos un artículo antes de validar.", indicator: "orange" });
					} else {
						this._action_submit();
					}
				} else if (d.docstatus === 1 && d.bfel_status !== "02 Procesada") {
					this._action_certify();
				}

			// ── F4: Imprimir ───────────────────────────────────────────────
			} else if (e.key === "F4") {
				e.preventDefault();
				this._action_print();

			// ── F9: Nuevo documento ────────────────────────────────────────
			} else if (e.key === "F9") {
				e.preventDefault();
				this._action_new();

			// ── F7: Artículos Alternativos (fila activa) ────────────────────
			} else if (e.key === "F7") {
				e.preventDefault();
				this._show_alternatives_dialog();

			// ── F8: Buscar por Palabras de Búsqueda ──────────────────────────
			} else if (e.key === "F8") {
				e.preventDefault();
				this._show_keyword_search_dialog();

			// ── F10: Buscar / crear cliente / Ver análisis ──────────────────
			} else if (e.key === "F10") {
				e.preventDefault();
				if (this._current_view === "dashboard") {
					if (this.dashboard_customer_ctrl) {
						const cust = this.dashboard_customer_ctrl.get_value();
						if (cust) this._show_customer_analytics_dialog(cust);
					}
				} else {
					if (!this.doc.name || this.doc.name === "new") {
						this._action_customer();
					}
				}
			}
		});

		// Guía paso a paso — tour contextual según la vista actual
		this.$body.find("#ef-btn-guide").on("click", (e) => {
			e.preventDefault();
			this._start_guide_tour();
		});
	}

	// -----------------------------------------------------------------------
	// Guía paso a paso (EFGuide) — un tour por vista/pestaña, disparado con
	// el botón "Guía" del navbar. No duplica lógica: solo señala en qué
	// campo hacer clic y qué significa, el usuario ejecuta la acción real.
	// -----------------------------------------------------------------------
	_start_guide_tour() {
		const view = this._current_view;
		if (view === "maintenance") {
			const tab = this.$body.find(".ef-maint-tab-btn.ef-tab-active").data("maint-tab") || "clientes";
			const builders = {
				clientes: () => this._guide_steps_maint_clientes(),
				productos: () => this._guide_steps_maint_productos(),
				precios: () => this._guide_steps_maint_precios(),
			};
			if (!builders[tab]) {
				frappe.show_alert({ message: __("No hay guía disponible para esta pestaña todavía."), indicator: "orange" });
				return;
			}
			EFGuide.startTour(builders[tab]());
		} else if (view === "billing") {
			EFGuide.startTour(this._guide_steps_billing());
		} else if (view === "dashboard") {
			EFGuide.startTour(this._guide_steps_dashboard());
		} else {
			frappe.show_alert({ message: __("La guía está disponible en Tablero, Facturador y Mantenimiento."), indicator: "orange" });
		}
	}

	_guide_steps_maint_clientes() {
		const goTo = () => {
			this._switch_view("maintenance");
			this.$body.find('.ef-maint-tab-btn[data-maint-tab="clientes"]').trigger("click");
		};
		return [
			{ before: goTo, selector: "#ef-maint-cust-btn-new", title: "Nuevo cliente",
				text: "Haz clic en '+ Nuevo' para limpiar el formulario y comenzar un cliente desde cero." },
			{ selector: "#ef-maint-cust-name", title: "Nombre",
				text: "Escribe el nombre completo o la razón social del cliente." },
			{ selector: "#ef-maint-cust-ident", title: "Identificación (FEL)",
				text: "Elige NIT si es contribuyente, CF si es Consumidor Final, o CUI/Pasaporte según el caso." },
			{ selector: "#ef-maint-cust-receptor", title: "No. de identificación",
				text: "Escribe el NIT o CUI. Si el NIT existe en SAT, el nombre se autocompleta al salir del campo." },
			{ selector: "#ef-maint-cust-price-list-ctrl", title: "Lista de precios (opcional)",
				text: "Asigna una lista de precios especial para este cliente, si aplica." },
			{ selector: "#ef-maint-cust-btn-save", title: "Guardar",
				text: "Haz clic en 'Guardar Cliente' para crearlo. Aparecerá de inmediato en el listado de la izquierda." },
		];
	}

	_guide_steps_maint_productos() {
		const goTo = () => {
			this._switch_view("maintenance");
			this.$body.find('.ef-maint-tab-btn[data-maint-tab="productos"]').trigger("click");
		};
		return [
			{ before: goTo, selector: "#ef-maint-item-btn-new", title: "Nuevo producto",
				text: "Haz clic en '+ Crear' para iniciar un producto desde cero." },
			{ selector: "#ef-maint-item-auto-code-label", title: "Código del ítem",
				text: "Deja 'Código Automático' activo para que el sistema lo asigne, o desactívalo para escribir uno propio." },
			{ selector: "#ef-maint-item-name", title: "Nombre",
				text: "Nombre del producto. También se usa para completar la Descripción FEL automáticamente." },
			{ selector: "#ef-maint-item-group-ctrl", title: "Grupo de artículos",
				text: "Selecciona la categoría a la que pertenece este producto." },
			{ selector: "#ef-maint-item-gestionado-por", title: "Gestionado por",
				text: "'Serie' si cada unidad tiene número único (ej. armas), 'Lote' si se maneja por lote, o 'General' para productos normales." },
			{ selector: "#ef-maint-item-is-stock", title: "Inventariable",
				text: "Actívalo si este producto controla existencias en bodega." },
			{ selector: "#ef-maint-item-btn-save", title: "Guardar",
				text: "Haz clic en 'Guardar Producto' para crearlo." },
		];
	}

	_guide_steps_maint_precios() {
		const goTo = () => {
			this._switch_view("maintenance");
			this.$body.find('.ef-maint-tab-btn[data-maint-tab="precios"]').trigger("click");
		};
		return [
			{ before: goTo, selector: "#ef-maint-price-list-select", title: "Lista de precios",
				text: "Elige la Lista de Precios que quieres revisar o editar." },
			{ selector: "#ef-maint-prices-f-nombre", title: "Buscar producto",
				text: "Filtra por código, nombre o grupo directamente desde los encabezados de la tabla para encontrar el producto más rápido." },
			{ selector: "#ef-maint-tab-precios .ef-table", title: "Editar precio",
				text: "Haz clic sobre el precio de un producto en la tabla para editarlo directamente; se guarda al confirmar." },
		];
	}

	_guide_steps_billing() {
		const openSection = (id) => {
			const $card = this.$body.find(`#${id}`);
			if (!$card.hasClass("ef-sec-open")) $card.find(".ef-sec-head").trigger("click");
		};
		return [
			{ before: () => { this._switch_view("billing"); openSection("ef-sec-cliente"); },
				selector: '[data-ctrl="customer"]', title: "Cliente",
				text: "Busca o crea el cliente al que le vas a facturar." },
			{ before: () => openSection("ef-sec-documento"), selector: "#ef-establecimiento", title: "Establecimiento",
				text: "Selecciona el establecimiento fiscal (punto de emisión ante SAT)." },
			{ selector: "#ef-naming-series", title: "Serie",
				text: "Elige la serie del documento (correlativo de facturación)." },
			{ selector: "#ef-add-row", title: "Agregar productos",
				text: "Haz clic aquí para agregar una línea por cada producto o servicio que vendes." },
			{ selector: "#ef-items-table", title: "Detalle de la factura",
				text: "Escribe o busca el código del producto y ajusta Cantidad y Precio Unitario; el Importe se calcula solo." },
			{ selector: "#ef-bfel-status", title: "Estado FEL",
				text: "Deja '01 Enviar' para certificar ante SAT al guardar, o '00 No enviar' si es un documento interno." },
			{ selector: ".ef-pagado-toggle", title: "Estado de pago",
				text: "Actívalo si el cliente ya pagó de contado; si no, la factura queda pendiente de cobro." },
			{ selector: "#ef-btn-save", title: "Guardar borrador",
				text: "Guarda como borrador (F3) para revisar antes de certificar." },
			{ selector: "#ef-btn-submit", title: "Validar factura",
				text: "Cuando todo esté listo, 'Validar factura' certifica y envía el documento a SAT." },
		];
	}

	_guide_steps_dashboard() {
		const goTo = () => this._switch_view("dashboard");
		return [
			{ before: goTo, selector: ".ef-dashboard-filters", title: "Filtros",
				text: "Filtra el tablero por rango de fechas y por cliente." },
			{ selector: "#ef-dash-btn-apply", title: "Aplicar filtro",
				text: "Haz clic en 'Filtrar' para aplicar el rango elegido a todo el tablero." },
			{ selector: "#ef-kpi-card-today", title: "KPIs en vivo",
				text: "Ventas de hoy, del mes, en borrador y facturas certificadas FEL, siempre actualizados." },
			{ selector: '.ef-analytics-card:contains("Ventas Recientes")', title: "Informe: Ventas Recientes",
				text: "Aquí ves las últimas 50 facturas del filtro aplicado. Haz clic en una fila para abrirla en el Facturador." },
			{ selector: "#ef-dash-top-products", title: "Top productos",
				text: "Los 15 productos más vendidos en el rango filtrado — útil para identificar qué se vende más." },
			{ selector: "#ef-dash-customer-ctrl", title: "Análisis por cliente",
				text: "Selecciona un cliente aquí para ver su tarjeta de Análisis: compras totales, facturas, crédito y saldo pendiente." },
		];
	}

	// -----------------------------------------------------------------------
	// Validation
	// -----------------------------------------------------------------------

	_validate_header() {
		if (this.controls.customer) {
			this.doc.customer = this.controls.customer.get_value() || this.doc.customer;
		}
		if (!this.doc.customer) {
			frappe.show_alert({ message: "El campo <strong>Cliente</strong> es obligatorio.", indicator: "red" });
			if (this.controls.customer && this.controls.customer.$input) this.controls.customer.$input.focus();
			return false;
		}
		if (!this.doc.bfel_establecimiento) {
			frappe.show_alert({ message: "El campo <strong>Establecimiento</strong> es obligatorio.", indicator: "red" });
			this.$body.find("#ef-establecimiento").focus();
			return false;
		}
		if (!this.doc.posting_date) {
			frappe.show_alert({ message: "La <strong>Fecha de Emisión</strong> es obligatoria.", indicator: "red" });
			this.$body.find("#ef-posting-date").focus();
			return false;
		}
		if (!this.doc.items || this.doc.items.length === 0) {
			frappe.show_alert({ message: "Agregue al menos un <strong>ítem</strong> a la factura.", indicator: "red" });
			this.$body.find("#ef-add-row").focus();
			return false;
		}
		return true;
	}

	// -----------------------------------------------------------------------
	// Build payload for save
	// -----------------------------------------------------------------------

	_apply_column_visibility() {
		const cfg = this.company_config || {};
		const map = [
			[".ef-col-wh",     cfg.mostrar_almacen  !== undefined ? cfg.mostrar_almacen  : 1],
			[".ef-col-disc",   cfg.mostrar_desc_pct !== undefined ? cfg.mostrar_desc_pct : 1],
			[".ef-col-adenda", cfg.mostrar_adenda   !== undefined ? cfg.mostrar_adenda   : 1],
			[".ef-col-tipo",   cfg.mostrar_tipo     !== undefined ? cfg.mostrar_tipo     : 1],
		];
		map.forEach(([sel, show]) => {
			this.$body.find(sel).css("display", show ? "" : "none");
		});
	}

	_build_save_payload() {
		const d = this.doc;
		if (this.controls.customer) d.customer = this.controls.customer.get_value() || d.customer;
		if (this.controls.payment_terms_template) d.payment_terms_template = this.controls.payment_terms_template.get_value() || d.payment_terms_template;
		if (this.controls.taxes_and_charges) d.taxes_and_charges = this.controls.taxes_and_charges.get_value() || d.taxes_and_charges;
		if (this.controls.sales_partner) d.sales_partner = this.controls.sales_partner.get_value() || d.sales_partner;

		const _cfg = this.company_config || {};
		const _update_stock = (_cfg.maneja_inventario && (d.items || []).some(r => r.is_stock_item)) ? 1 : 0;

		const payload = {
			doctype: "Sales Invoice",
			name: d.name !== "new" ? d.name : undefined,
			es_fiscal: 1,
			update_stock: _update_stock,
			naming_series: (!d.name || d.name === "new") ? d.naming_series : undefined,
			customer: d.customer,
			company: d.company || this.defaults.company || "",
			posting_date: d.posting_date,
			due_date: d.due_date,
			payment_terms_template: d.payment_terms_template || "",
			terms: d.terms || "",
			taxes_and_charges: d.taxes_and_charges || "",
			sales_partner: d.sales_partner || "",
			bfel_nit: d.bfel_nit || "",
			bfel_identificacion: d.bfel_identificacion || "",
			bfel_nombre: d.bfel_nombre || "",
			bfel_status: d.bfel_status || "01 Enviar",
			bfel_escenario_exento: d.bfel_escenario_exento || "",
			selling_price_list: d.selling_price_list || "",
			bfel_establecimiento: d.bfel_establecimiento || "",
			items: (d.items || []).map((r) => ({
				item_code: r.item_code,
				item_name: r.item_name || "",
				description: r.description || r.item_name || "",
				warehouse: r.warehouse || this.defaults.default_warehouse || "",
				qty: parseFloat(r.qty) || 1,
				uom: r.uom || "",
				rate: parseFloat(r.rate) || 0,
				discount_percentage: parseFloat(r.discount_percentage) || 0,
				cost_center: r.cost_center || this.defaults.default_cost_center || "",
				// Campos DIGECAM / adenda
				serial_no:                      r.serial_no || "",
				tiene_adenda:                   r.tiene_adenda || 0,
				tenencia_1:                     r.tenencia_1 || "",
				tenencia_2:                     r.tenencia_2 || "",
				codigo:                         r.codigo || "",
				oficio:                         r.oficio || "",
				expediente:                     r.expediente || "",
				color:                          r.color || "",
				largo:                          r.largo || "",
				modelo:                         r.modelo || "",
				licencia:                       r.licencia || "",
				autorizacion:                   r.autorizacion || "",
				lote:                           r.lote || "",
				custom_tenencia_municion:        r.custom_tenencia_municion || "",
				custom_codigo_cliente_municion:  r.custom_codigo_cliente_municion || "",
				bfel_multi_tipo:                 r.bfel_multi_tipo || "",
			})).filter((r) => r.item_code),
		};

		// Dejar que ERPNext (backend) construya la tabla de impuestos completa
		// con todas las configuraciones contables basado en la plantilla seleccionada.
		// Solo enviamos una tabla vacía si el usuario explícitamente quitó la plantilla.
		if (!d.taxes_and_charges) {
			payload.taxes = [];
		}

		return payload;
	}

	// -----------------------------------------------------------------------
	// Invoice search bar
	// -----------------------------------------------------------------------

	_setup_invoice_search() {
		const $input = this.$body.find("#ef-invoice-search");
		if (!$input.length) return;

		let $dropdown = null;
		let _timer = null;
		let _results = [];
		let _active = -1;

		const close = () => {
			if ($dropdown) { $dropdown.remove(); $dropdown = null; }
			_active = -1;
		};

		const open = (results) => {
			close();
			if (!results.length) {
				$dropdown = $(`<div class="ef-autocomplete"><div class="ef-autocomplete-item ef-ac-empty">Sin resultados</div></div>`);
			} else {
				_results = results;
				const items = results.map((r, i) => `<div class="ef-autocomplete-item" data-i="${i}">
					${_esc(r.value)}
					${r.description ? `<span class="ef-ac-desc">${_esc(r.description)}</span>` : ""}
				</div>`).join("");
				$dropdown = $(`<div class="ef-autocomplete">${items}</div>`);
			}
			const offset = $input.offset();
			$dropdown.css({
				top: offset.top + $input.outerHeight() + 2,
				left: offset.left,
				width: Math.max(300, $input.outerWidth()),
			});
			$("body").append($dropdown);

			$dropdown.on("mousedown", ".ef-autocomplete-item:not(.ef-ac-empty)", (e) => {
				const r = _results[parseInt($(e.currentTarget).data("i"))];
				$input.val("").blur();
				close();
				this._load_invoice_with_dirty_check(r.value);
			});
		};

		$input.on("input", () => {
			const txt = $input.val().trim();
			clearTimeout(_timer);
			if (txt.length < 1) { close(); return; }
			_timer = setTimeout(() => {
				frappe.call({
					method: "frappe.desk.search.search_link",
					args: { txt, doctype: "Sales Invoice", ignore_user_permissions: 0, reference_doctype: "Sales Invoice" },
					callback: (r) => {
						const results = r.results || r.message || [];
						open(Array.isArray(results) ? results : []);
					},
				});
			}, 200);
		});

		$input.on("keydown", (e) => {
			if (!$dropdown) return;
			const $items = $dropdown.find(".ef-autocomplete-item:not(.ef-ac-empty)");
			if (e.key === "ArrowDown") {
				e.preventDefault();
				$items.removeClass("ef-ac-active");
				_active = Math.min(_active + 1, $items.length - 1);
				$items.eq(_active).addClass("ef-ac-active");
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				$items.removeClass("ef-ac-active");
				_active = Math.max(_active - 1, 0);
				$items.eq(_active).addClass("ef-ac-active");
			} else if (e.key === "Enter") {
				e.preventDefault();
				const $a = $dropdown.find(".ef-ac-active");
				if ($a.length) {
					const r = _results[parseInt($a.data("i"))];
					$input.val("").blur();
					close();
					this._load_invoice_with_dirty_check(r.value);
				}
			} else if (e.key === "Escape") {
				close();
				$input.val("");
			}
		});

		$input.on("blur", () => setTimeout(close, 180));
	}

	_load_invoice_with_dirty_check(name) {
		if (this._dirty) {
			frappe.confirm(
				"Hay cambios sin guardar. ¿Descartar y abrir la factura seleccionada?",
				() => { this._dirty = false; this.load_invoice(name); }
			);
		} else {
			this.load_invoice(name);
		}
	}

	// -----------------------------------------------------------------------
	// Collapse / expand header
	// -----------------------------------------------------------------------

	_setup_collapse_btn() {
		const STORAGE_KEY = "ef_header_collapsed";
		const $header = this.$body.find(".ef-header");
		const $btn = this.$body.find("#ef-btn-collapse");

		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "1") {
			$header.addClass("ef-header-collapsed");
		} else if (stored === null && window.innerWidth <= 600) {
			// Primera visita en un dispositivo móvil: arranca colapsado para
			// dejar más espacio a la tabla de items; el usuario puede expandirlo.
			$header.addClass("ef-header-collapsed");
		}

		$btn.on("click", () => {
			const collapsed = $header.toggleClass("ef-header-collapsed").hasClass("ef-header-collapsed");
			localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
		});
	}

	// -----------------------------------------------------------------------
	// Tarjetas colapsables del encabezado (Cliente / Documento / Facturación FEL)
	// -----------------------------------------------------------------------

	_setup_section_accordion() {
		this.$body.on("click", ".ef-sec-head", (e) => {
			const $card = $(e.currentTarget).closest(".ef-sec-card");
			if ($card.hasClass("ef-sec-locked")) return; // Facturación FEL: siempre desplegada
			const wasOpen = $card.hasClass("ef-sec-open");
			this.$body.find(".ef-sec-card").not(".ef-sec-locked").removeClass("ef-sec-open");
			if (!wasOpen) $card.addClass("ef-sec-open");
		});

		// Resumen en vivo mientras se edita, sin esperar a guardar
		this.$body.on(
			"change input",
			"#ef-establecimiento, #ef-naming-series, #ef-due-date, #ef-posting-date, #ef-bfel-status, #ef-bfel-nombre, #ef-bfel-nit, #ef-bfel-identificacion",
			() => this._update_header_sections()
		);

		// Cliente abierta por defecto: es el primer dato que se captura en una venta
		this.$body.find("#ef-sec-cliente").addClass("ef-sec-open");
	}

	_update_header_sections() {
		const d = this.doc;
		const $b = this.$body;

		// Cliente
		const custName = d.customer_name || d.customer || "";
		const nit = $b.find("#ef-bfel-nit").val() || "";
		$b.find("#ef-sec-cliente-summary").text(
			custName ? (nit ? `${custName} · ${nit}` : custName) : "Sin cliente seleccionado"
		);

		// Documento
		const est = $b.find("#ef-establecimiento").val() || "";
		const serie = $b.find("#ef-naming-series").val() || "";
		const due = $b.find("#ef-due-date").val() || "";
		let docSummary = [est, serie].filter(Boolean).join(" · ");
		if (due) docSummary += (docSummary ? " · vence " : "vence ") + due;
		$b.find("#ef-sec-documento-summary").text(docSummary || "Sin datos de documento");

		// Facturación FEL
		const felStatus = $b.find("#ef-bfel-status").val() || "";
		let felSummary;
		if (d.bfel_uuid) {
			felSummary = "Certificada · UUID " + String(d.bfel_uuid).slice(0, 8) + "…";
		} else if (felStatus === "00 No enviar") {
			felSummary = "No se enviará a SAT";
		} else {
			felSummary = "Pendiente de envío a SAT";
		}
		$b.find("#ef-sec-fel-summary").text(felSummary);
	}

	// -----------------------------------------------------------------------
	// Focus helpers
	// -----------------------------------------------------------------------

	_focus_first_field() {
		setTimeout(() => {
			if (this.controls.customer && this.controls.customer.$input) {
				this.controls.customer.$input.focus();
			}
		}, 100);
	}

	// -----------------------------------------------------------------------
	// Tab navigation
	// -----------------------------------------------------------------------

	_setup_tabs() {
		this.$body.on("click", ".ef-tab-btn", (e) => {
			const tab = $(e.currentTarget).data("tab");
			this._switch_tab(tab);
		});

		// Analytics: click en fila de factura → cargar en FacEx
		this.$body.on("click", "[data-load-invoice]", (e) => {
			const name = $(e.currentTarget).data("load-invoice");
			if (!name) return;
			this._switch_tab("factura");
			this._load_invoice_with_dirty_check(name);
		});
	}

	_switch_tab(tabName) {
		const isNew    = this.doc.name === "new" || !this.doc.name;
		const isFiscal = this.doc.es_fiscal !== 0;

		if (tabName === "pagos") {
			if (isNew) {
				frappe.show_alert({ message: "Primero guarde la factura para acceder a Pagos.", indicator: "orange" });
				return;
			}
			if (!isFiscal) {
				frappe.show_alert({ message: "Los pagos solo están disponibles para facturas fiscales.", indicator: "orange" });
				return;
			}
			if (!this._can_access_payments()) {
				frappe.show_alert({ message: "No tiene permisos para acceder a Pagos.", indicator: "red" });
				return;
			}
		}
		if (tabName === "analisis" && !this._can_access_analytics()) {
			frappe.show_alert({ message: "No tiene permisos para ver el Análisis de Ventas.", indicator: "red" });
			return;
		}

		this.$body.find(".ef-tab-btn").removeClass("ef-tab-active");
		this.$body.find(`.ef-tab-btn[data-tab="${tabName}"]`).addClass("ef-tab-active");
		this.$body.find(".ef-tab-content").hide();
		this.$body.find(`#ef-tab-${tabName}`).show();
	}

	_update_tabs_state() {
		const isNew    = this.doc.name === "new" || !this.doc.name;
		const isFiscal = this.doc.es_fiscal !== 0;

		// Pagos: requires saved + fiscal document + payment permission
		const canPay = !isNew && isFiscal && this._can_access_payments();
		this.$body.find('.ef-tab-btn[data-tab="pagos"]').toggleClass("ef-tab-disabled", !canPay);

		// Análisis: requires analytics permission
		const canAnal = this._can_access_analytics();
		this.$body.find('.ef-tab-btn[data-tab="analisis"]').toggleClass("ef-tab-disabled", !canAnal);
	}

	_can_access_payments() {
		const roles = frappe.user_roles || [];
		return ["Accounts User", "Accounts Manager", "System Manager"].some((r) => roles.includes(r));
	}

	_can_access_analytics() {
		const roles = frappe.user_roles || [];
		return ["Sales User", "Sales Manager", "Accounts User", "Accounts Manager", "System Manager"].some((r) => roles.includes(r));
	}

	// -----------------------------------------------------------------------
	// Customer dialog (F11)
	// -----------------------------------------------------------------------

	_action_customer() {
		this._show_customer_dialog();
	}

	_show_customer_dialog() {
		const hasCustomer = !!this.doc.customer;

		const dlg = new frappe.ui.Dialog({
			title: "Cliente",
			size: "large",
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "mode_btns",
					options: `<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid #e2e8f0">
						<button id="ef-dlg-modificar" class="btn btn-secondary btn-sm" style="display:none">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
							Modificar
						</button>
						<button id="ef-dlg-crear" class="btn btn-default btn-sm">
							<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:middle;margin-right:4px"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
							Crear Nuevo
						</button>
						<span id="ef-dlg-mode-label" style="margin-left:auto;font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.3px"></span>
					</div>`,
				},
				{
					fieldtype: "HTML",
					fieldname: "search_html",
					options: `<div style="margin-bottom:14px">
						<label class="ef-label" style="display:block;margin-bottom:4px">Buscar cliente existente</label>
						<input id="ef-cust-search-input" type="text" class="ef-input"
							placeholder="Nombre, NIT o código..." style="width:100%" autocomplete="off" />
						<div id="ef-cust-search-results" style="margin-top:6px;max-height:180px;overflow-y:auto"></div>
					</div>`,
				},
				{ fieldtype: "Section Break", label: "General" },
				{ fieldname: "customer_name",       fieldtype: "Data", label: "Nombre Cliente", reqd: 1 },
				{ fieldname: "bfel_identificacion", fieldtype: "Data", label: "Identificación (FEL)" },
				{ fieldname: "bfel_id_receptor",    fieldtype: "Data", label: "ID Receptor (FEL)" },
				{ fieldtype: "Column Break" },
				{ fieldname: "custom_direccion",    fieldtype: "Data", label: "Dirección" },
				{ fieldname: "custom_departamento", fieldtype: "Data", label: "Departamento" },
				{ fieldname: "custom_telefono",     fieldtype: "Data", label: "Teléfono" },
				{ fieldtype: "Section Break", label: "Configuraciones", collapsible: 1, collapsed: 1 },
				{ fieldname: "payment_terms",         fieldtype: "Link", label: "Condición de Pago",  options: "Payment Terms Template" },
				{ fieldname: "default_price_list",    fieldtype: "Link", label: "Lista de Precios",   options: "Price List" },
				{ fieldtype: "Column Break" },
				{ fieldname: "default_sales_partner", fieldtype: "Link", label: "Socio de Ventas",    options: "Sales Partner" },
			],
			primary_action_label: "Guardar",
			primary_action: (values) => this._save_customer_from_dialog(dlg, values),
		});

		dlg._ef_customer_name = "";
		dlg._ef_mode = "";
		dlg.show();

		// Helper to get the dialog primary button reliably
		const _getPrimaryBtn = () =>
			dlg.get_primary_btn ? dlg.get_primary_btn() : dlg.$wrapper.find(".modal-footer .btn-primary");

		// Función para cambiar modo: "view" | "edit" | "create"
		const setMode = (mode) => {
			dlg._ef_mode = mode;
			const $modificar   = dlg.$wrapper.find("#ef-dlg-modificar");
			const $label       = dlg.$wrapper.find("#ef-dlg-mode-label");
			const $savePrimary = _getPrimaryBtn();

			if (mode === "view") {
				this._set_dialog_fields_readonly(dlg, true);
				$modificar.show();
				$label.text("Vista");
				$savePrimary.prop("disabled", true);
			} else if (mode === "edit") {
				this._set_dialog_fields_readonly(dlg, false);
				$modificar.hide();
				$label.text("Modificando");
				$savePrimary.prop("disabled", false);
			} else {
				// create
				this._clear_dialog_fields(dlg);
				this._set_dialog_fields_readonly(dlg, false);
				$modificar.hide();
				$label.text("Nuevo Cliente");
				$savePrimary.prop("disabled", false);
			}
		};

		dlg._ef_setMode = setMode;

		dlg.$wrapper.find("#ef-dlg-modificar").on("click", () => setMode("edit"));
		dlg.$wrapper.find("#ef-dlg-crear").on("click", () => setMode("create"));

		this._setup_customer_dialog_search(dlg);

		if (dlg.fields_dict.default_sales_partner) {
			dlg.fields_dict.default_sales_partner.get_query = () => {
				const comp = this.doc.company || this.defaults.company || "";
				return {
					or_filters: [
						["bfel_company", "=", comp],
						["bfel_company_null", "=", 0],
					],
				};
			};
		}

		// Use setTimeout so the dialog DOM (fields, footer) is fully rendered
		setTimeout(() => {
			if (hasCustomer) {
				setMode("view");
				this._load_customer_into_dialog(dlg, this.doc.customer);
			} else {
				setMode("create");
			}
		}, 80);
	}

	_setup_customer_dialog_search(dlg) {
		const $input   = dlg.$wrapper.find("#ef-cust-search-input");
		const $results = dlg.$wrapper.find("#ef-cust-search-results");
		let _timer = null;

		const render = (customers) => {
			if (!customers.length) {
				$results.html('<div style="color:#64748b;font-size:12px;padding:4px 0">Sin resultados.</div>');
				return;
			}
			const html = customers.map((c) => `
				<div class="ef-cust-result" data-name="${_esc(c.name)}"
					style="padding:6px 10px;cursor:pointer;border-radius:4px;display:flex;justify-content:space-between;align-items:center">
					<div>
						<strong>${_esc(c.customer_name || c.name)}</strong>
						<span style="color:#64748b;font-size:11px;margin-left:8px">${_esc(c.name)}</span>
					</div>
					${c.tax_id ? `<span style="font-size:11px;color:#64748b">${_esc(c.tax_id)}</span>` : ""}
				</div>`).join("");
			$results.html(html);
			$results.find(".ef-cust-result").on("click", (e) => {
				const name = $(e.currentTarget).data("name");
				$input.val("");
				$results.html("");
				if (dlg._ef_setMode) dlg._ef_setMode("view");
				this._load_customer_into_dialog(dlg, name);
			});
		};

		$input.on("input", () => {
			clearTimeout(_timer);
			const txt = $input.val().trim();
			if (txt.length < 2) { $results.html(""); return; }
			_timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.customer.search_customer",
					args: { txt, company: this.doc.company || this.defaults.company || "" },
					callback: (r) => render(r.message || []),
				});
			}, 250);
		});
	}

	_load_customer_into_dialog(dlg, name) {
		frappe.call({
			method: "facex_multi.api.customer.get_customer",
			args: { name, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				if (!r.exc && r.message) {
					const c = r.message;
					dlg._ef_customer_name = c.name;
					const fieldnames = [
						"customer_name", "bfel_identificacion", "bfel_id_receptor",
						"custom_direccion", "custom_departamento", "custom_telefono",
						"payment_terms", "default_price_list", "default_sales_partner",
					];
					fieldnames.forEach((f) => {
						if (dlg.fields_dict[f]) dlg.fields_dict[f].set_value(c[f] || "");
					});
					// Re-aplicar readonly si estamos en modo vista (los set_value pueden habilitar campos)
					if (dlg._ef_mode === "view") {
						this._set_dialog_fields_readonly(dlg, true);
						const $btn = dlg.get_primary_btn ? dlg.get_primary_btn() : dlg.$wrapper.find(".modal-footer .btn-primary");
						$btn.prop("disabled", true);
					}
					frappe.show_alert({ message: `Cargado: <strong>${c.customer_name}</strong>`, indicator: "blue" });
				}
			},
		});
	}

	_save_customer_from_dialog(dlg, values) {
		const data = {
			name: dlg._ef_customer_name || "",
			customer_name: values.customer_name,
			bfel_identificacion: values.bfel_identificacion || "",
			bfel_id_receptor: values.bfel_id_receptor || "",
			custom_direccion: values.custom_direccion || "",
			custom_departamento: values.custom_departamento || "",
			custom_telefono: values.custom_telefono || "",
			payment_terms: values.payment_terms || "",
			default_price_list: values.default_price_list || "",
			default_sales_partner: values.default_sales_partner || "",
		};
		frappe.call({
			method: "facex_multi.api.customer.create_or_update_customer",
			args: { 
				data_json: JSON.stringify(data),
				company: this.doc.company || this.defaults.company || ""
			},
			freeze: true,
			freeze_message: "Guardando cliente...",
			callback: (r) => {
				if (!r.exc && r.message) {
					const res = r.message;
					frappe.show_alert({ message: `Cliente guardado: <strong>${res.customer_name}</strong>`, indicator: "green" });
					dlg.hide();
					if (this.controls.customer) {
						this.controls.customer.set_value(res.name);
						this.doc.customer = res.name;
						this._on_customer_change(res.name);
						this._mark_dirty();
					}
				}
			},
		});
	}

	_set_dialog_fields_readonly(dlg, readonly) {
		const fieldnames = [
			"customer_name", "bfel_identificacion", "bfel_id_receptor",
			"custom_direccion", "custom_departamento", "custom_telefono",
			"payment_terms", "default_price_list", "default_sales_partner",
		];
		fieldnames.forEach((f) => {
			const fd = dlg.fields_dict[f];
			if (!fd) return;
			// Frappe API (triggers re-render)
			try {
				dlg.set_df_property(f, "read_only", readonly ? 1 : 0);
				dlg.refresh_field(f);
			} catch (_) {}
			// Direct DOM fallback for immediate visual effect
			if (fd.$wrapper) {
				fd.$wrapper.find("input, textarea").prop("disabled", readonly);
				fd.$wrapper.find("input, textarea").css({
					"background": readonly ? "#f1f5f9" : "",
					"cursor": readonly ? "not-allowed" : "",
					"color": readonly ? "#64748b" : "",
				});
				// Hide/show link icon on Link fields
				if (readonly) {
					fd.$wrapper.find(".btn.btn-default.link-btn, .link-btn").hide();
					fd.$wrapper.find("input").prop("readonly", true);
				} else {
					fd.$wrapper.find(".btn.btn-default.link-btn, .link-btn").show();
					fd.$wrapper.find("input").prop("readonly", false).prop("disabled", false);
				}
			}
		});
	}

	_clear_dialog_fields(dlg) {
		const fieldnames = [
			"customer_name", "bfel_identificacion", "bfel_id_receptor",
			"custom_direccion", "custom_departamento", "custom_telefono",
			"payment_terms", "default_price_list", "default_sales_partner",
		];
		fieldnames.forEach((f) => {
			if (dlg.fields_dict[f]) dlg.fields_dict[f].set_value("");
		});
		dlg._ef_customer_name = "";
	}

	// -----------------------------------------------------------------------
	// Payments tab
	// -----------------------------------------------------------------------

	_setup_payments_tab() {
		this.$body.on("click", "#ef-add-payment", () => this._add_payment_row());

		this.$body.on("change", "#ef-pagado", (e) => {
			const checked = e.target.checked;
			// Solo permitir en facturas validadas
			if (this.doc.docstatus !== 1) {
				e.target.checked = !checked;
				frappe.show_alert({ message: "Solo se puede marcar como Pagada una factura <strong>Validada</strong>.", indicator: "orange" });
				return;
			}
			this.doc.custom_pagado = checked ? 1 : 0;
			if (!checked) {
				// Desmarcar: eliminar todas las filas de pago y guardar
				this.doc.custom_efast_payments = [];
				this._manualPayment = false;
				this._sync_pagado_ui();
				this._auto_save_pagado(0);
				return;
			}
			// Marcar: si no es manual, agregar fila automática y guardar
			if (!this._manualPayment) {
				this.doc.custom_efast_payments = [{
					payment_method: "Efectivo",
					payment_date: this.doc.posting_date || frappe.datetime.get_today(),
					reference: "Automático x FacEx",
					// Usar outstanding_amount (no grand_total): cuando la factura
					// tiene redondeo (rounding_adjustment != 0), ERPNext valida el
					// Payment Entry contra el saldo pendiente real, no contra el
					// grand_total sin redondear.
					amount: parseFloat(this.doc.outstanding_amount) || 0,
				}];
			}
			this._sync_pagado_ui();
			this._auto_save_pagado(1);
		});

		this.$body.on("click", "#ef-btn-manual-payment", () => {
			this._manualPayment = true;
			// Clear auto-added payment row
			this.doc.custom_efast_payments = [];
			this._sync_pagado_ui();
			this._render_payments_tab();
			this._switch_tab("pagos");
		});

		this.$body.on("click", "#ef-btn-save-payments", () => this._save_payments());
	}

	_sync_pagado_ui() {
		const checked         = !!this.doc.custom_pagado;
		const isSubmitted     = this.doc.docstatus === 1;
		const hasSubmittedPEs = !!(this.doc._payment_entries && this.doc._payment_entries.has_submitted);
		const canToggle       = isSubmitted && !hasSubmittedPEs;
		const $chk = this.$body.find("#ef-pagado");
		$chk.prop("checked", checked).prop("disabled", !canToggle);
		$chk.closest(".ef-toggle").css("opacity", canToggle ? "" : "0.5");
		this.$body.find("#ef-pagado-label")
			.text(checked ? "Pagado" : "Pendiente")
			.removeClass("ef-pagado-pending ef-pagado-done")
			.addClass(checked ? "ef-pagado-done" : "ef-pagado-pending");
		const $manualBtn = this.$body.find("#ef-btn-manual-payment");
		const $autoLbl   = this.$body.find("#ef-auto-pay-label");
		if (checked && !hasSubmittedPEs) {
			$manualBtn.show();
			$autoLbl.toggle(!this._manualPayment);
		} else {
			$manualBtn.hide();
			$autoLbl.hide();
		}
	}

	_render_payments_tab() {
		if (!this.doc.custom_efast_payments) this.doc.custom_efast_payments = [];
		const pes             = this.doc._payment_entries || { submitted: [], draft: [], has_submitted: false };
		const hasSubmittedPEs = pes.has_submitted;
		const $tbody          = this.$body.find("#ef-payments-body");
		const $empty          = this.$body.find("#ef-payments-empty");
		const $addBtn         = this.$body.find("#ef-add-payment");
		const $saveBtn        = this.$body.find("#ef-btn-save-payments");
		$tbody.empty();

		if (hasSubmittedPEs) {
			// Mostrar PEs validados como filas de solo lectura
			$empty.hide();
			$addBtn.hide();
			$saveBtn.hide();
			// Aviso en la parte superior de la tabla
			const $notice = $(`<tr><td colspan="6" style="padding:8px 10px;background:#f0fdf4;border-bottom:1px solid #bbf7d0;font-size:11px;color:#166534;">
				<strong>✓ Pagos validados en ERPNext.</strong> Para modificarlos gestione el Comprobante de Pago directamente en ERPNext.
			</td></tr>`);
			$tbody.append($notice);
			pes.submitted.forEach((pe) => {
				const link = `/app/payment-entry/${encodeURIComponent(pe.name)}`;
				const row = `<tr class="ef-tr">
					<td class="ef-td ef-td-idx" style="color:#166534">✓</td>
					<td class="ef-td">${pe.mode_of_payment || ""}</td>
					<td class="ef-td">${pe.posting_date || ""}</td>
					<td class="ef-td"><a href="${link}" target="_blank" style="color:#2563eb;text-decoration:underline;font-size:11px">${pe.name}</a></td>
					<td class="ef-td ef-td-num">${_fmtCurrency(pe.paid_amount, this.doc.currency || "GTQ")}</td>
					<td class="ef-td"></td>
				</tr>`;
				$tbody.append(row);
			});
		} else {
			const payments = this.doc.custom_efast_payments;
			$addBtn.show();
			$saveBtn.show();
			if (!payments.length) {
				$empty.show();
			} else {
				$empty.hide();
				payments.forEach((p, idx) => $tbody.append(this._payment_row_html(idx, p)));
				this._bind_payment_row_events();
			}
			this._update_payments_total();
			this._update_contra_entrega_note();

			// Detect manual vs auto mode from existing payments
			const _isAuto = payments.length === 1 && payments[0].reference === "Automático x FacEx";
			if (this.doc.custom_pagado && payments.length > 0 && !_isAuto) {
				this._manualPayment = true;
			} else if (!this.doc.custom_pagado) {
				this._manualPayment = false;
			}
		}

		// Sync footer pagado UI
		this._sync_pagado_ui();
	}

	_update_contra_entrega_note() {
		const payments = this.doc.custom_efast_payments || [];
		const has = payments.some((p) => p.payment_method === "Contra Entrega");
		this.$body.find("#ef-pay-contra-entrega-note").toggle(has);
	}

	_can_offer_contra_entrega() {
		return !!((this.company_config || {}).permite_pago_contra_entrega && (this.perms || {}).puede_editar_guias_transporte);
	}

	_payment_row_html(idx, p) {
		const METHODS = ["Efectivo", "Tarjeta de Crédito", "Transferencia", "Cheque"];
		if (this._can_offer_contra_entrega()) METHODS.push("Contra Entrega");
		const opts = METHODS.map((m) =>
			`<option value="${m}"${p.payment_method === m ? " selected" : ""}>${m}</option>`
		).join("");
		return `<tr class="ef-tr" data-pay-idx="${idx}" id="ef-pay-row-${idx}">
  <td class="ef-td ef-td-idx">${idx + 1}</td>
  <td class="ef-td">
    <select class="ef-cell-input ef-pay-method" data-pay-idx="${idx}">${opts}</select>
  </td>
  <td class="ef-td">
    <input type="date" class="ef-cell-input ef-pay-date" data-pay-idx="${idx}"
      value="${p.payment_date || frappe.datetime.get_today()}" />
  </td>
  <td class="ef-td">
    <input type="text" class="ef-cell-input ef-pay-ref" data-pay-idx="${idx}"
      value="${_esc(p.reference || "")}" placeholder="Ref..." />
  </td>
  <td class="ef-td ef-td-num">
    <input type="number" class="ef-cell-input ef-input-num ef-pay-amount" data-pay-idx="${idx}"
      value="${parseFloat(p.amount) || 0}" min="0" step="any" />
  </td>
  <td class="ef-td">
    <button class="ef-btn-del ef-del-payment" data-pay-idx="${idx}" title="Eliminar">×</button>
  </td>
</tr>`;
	}

	_bind_payment_row_events() {
		const payments = this.doc.custom_efast_payments || [];
		payments.forEach((p, idx) => {
			const $row = this.$body.find(`#ef-pay-row-${idx}`);
			$row.find(".ef-pay-method").off("change").on("change", (e) => {
				payments[idx].payment_method = e.target.value;
				this._update_contra_entrega_note();
			});
			$row.find(".ef-pay-date").off("change").on("change", (e) => {
				payments[idx].payment_date = e.target.value;
			});
			$row.find(".ef-pay-ref").off("input").on("input", (e) => {
				payments[idx].reference = e.target.value;
			});
			$row.find(".ef-pay-amount").off("input change").on("input change", (e) => {
				let val = parseFloat(e.target.value) || 0;
				// Validar que no exceda el saldo de la factura (outstanding_amount,
				// que ya refleja el redondeo aplicado por ERPNext)
				const grandTotal = parseFloat(this.doc.outstanding_amount) || 0;
				const currentOthers = payments.reduce((s, p, i) => s + (i !== idx ? (parseFloat(p.amount) || 0) : 0), 0);
				const maxAllowed = grandTotal - currentOthers;
				if (val > maxAllowed) {
					val = maxAllowed;
					e.target.value = val;
				}
				payments[idx].amount = val;
				this._update_payments_total();
			});
			$row.find(".ef-del-payment").off("click").on("click", () => {
				payments.splice(idx, 1);
				this._render_payments_tab();
			});
		});
	}

	_add_payment_row() {
		if (!this.doc.custom_efast_payments) this.doc.custom_efast_payments = [];
		const payments = this.doc.custom_efast_payments;
		const grandTotal = parseFloat(this.doc.outstanding_amount) || 0;
		const totalPaid = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
		let balance = grandTotal - totalPaid;
		if (balance < 0) balance = 0;

		this.doc.custom_efast_payments.push({
			payment_method: "Efectivo",
			payment_date: frappe.datetime.get_today(),
			reference: "",
			amount: balance,
		});
		this._render_payments_tab();
	}

	_update_payments_total() {
		const payments = this.doc.custom_efast_payments || [];
		const grandTotal = parseFloat(this.doc.outstanding_amount) || 0;
		const totalPaid  = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
		const balance    = grandTotal - totalPaid;
		const currency   = this.doc.currency || "GTQ";

		this.$body.find("#ef-pay-total").text(_fmtCurrency(grandTotal, currency));
		this.$body.find("#ef-pay-paid").text(_fmtCurrency(totalPaid, currency));
		this.$body.find("#ef-pay-balance")
			.text(_fmtCurrency(balance, currency))
			.css("color", Math.abs(balance) < 0.01 ? "#2dc653" : (balance < 0 ? "#e63946" : "#f8961e"));

		// Enable Guardar Pagos if totalPaid > 0 and totalPaid <= grandTotal and there's at least one payment row
		const isValid = payments.length > 0 && totalPaid > 0 && totalPaid <= grandTotal;
		const $btnSave = this.$body.find("#ef-btn-save-payments");
		if (isValid) {
			$btnSave.prop("disabled", false).removeClass("ef-btn-disabled");
			$btnSave.css({ opacity: 1, pointerEvents: 'auto' });
		} else {
			$btnSave.prop("disabled", true).addClass("ef-btn-disabled");
			$btnSave.css({ opacity: 0.5, pointerEvents: 'none' });
		}
	}

	_save_payments() {
		if (!this.doc.name || this.doc.name === "new") {
			frappe.show_alert({ message: "Primero guarde la factura antes de registrar pagos.", indicator: "orange" });
			return;
		}
		const payments   = this.doc.custom_efast_payments || [];
		// In manual mode, require at least one row
		if (this._manualPayment && this.doc.custom_pagado && !payments.length) {
			frappe.show_alert({ message: "Ingrese al menos una línea de pago en el desglose manual.", indicator: "red" });
			return;
		}
		// Si hay filas de pago, la factura se marca como pagada independientemente del toggle
		const pagado     = payments.length > 0 ? 1 : 0;
		const grandTotal = parseFloat(this.doc.outstanding_amount) || 0;
		const totalPaid  = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
		const diff       = Math.abs(grandTotal - totalPaid);
		const currency   = this.doc.currency || "GTQ";

		if (diff > 0.01) {
			const msg = totalPaid > grandTotal
				? `El total pagado (${_fmtCurrency(totalPaid, currency)}) supera el total de la factura.`
				: `Hay un saldo pendiente de ${_fmtCurrency(grandTotal - totalPaid, currency)}.`;
			frappe.show_alert({ message: msg, indicator: "orange" });
		}

		const hasContraEntrega = payments.some((p) => p.payment_method === "Contra Entrega");
		const invoiceName = this.doc.name;

		frappe.call({
			method: "facex_multi.api.invoice.save_payments",
			args: {
				invoice_name: this.doc.name,
				payments_json: JSON.stringify(payments),
				pagado: pagado,
			},
			freeze: true,
			freeze_message: "Guardando pagos...",
			callback: (r) => {
				if (!r.exc && r.message) {
					frappe.show_alert({ message: "Pagos guardados correctamente.", indicator: "green" });
					this.load_invoice(invoiceName);
					if (hasContraEntrega) {
						frappe.confirm(
							__("Esta factura quedó marcada como Contra Entrega. ¿Desea ingresar el detalle de la guía de transporte ahora?"),
							() => this._action_guias_transporte(),
							() => frappe.show_alert({
								message: __("Podrá completarla después desde el botón \"Guía de Transporte\" o desde Envíos Pendientes."),
								indicator: "blue",
							}),
						);
					}
				}
			},
		});
	}

	_auto_save_pagado(pagadoVal) {
		if (!this.doc.name || this.doc.name === "new") return;
		const payments = this.doc.custom_efast_payments || [];
		frappe.call({
			method: "facex_multi.api.invoice.save_payments",
			args: {
				invoice_name: this.doc.name,
				payments_json: JSON.stringify(payments),
				pagado: pagadoVal,
			},
			freeze: true,
			freeze_message: "Guardando estado de pago...",
			callback: (r) => {
				if (!r.exc && r.message) {
					const msg = pagadoVal
						? "Factura marcada como <strong>Pagada</strong>."
						: "Pago <strong>eliminado</strong>.";
					frappe.show_alert({ message: msg, indicator: pagadoVal ? "green" : "blue" });
					this.load_invoice(this.doc.name);
				}
			},
		});
	}

	// -----------------------------------------------------------------------
	// Analytics tab
	// -----------------------------------------------------------------------

	_show_customer_analytics_dialog(customer) {
		customer = customer || this.doc.customer;
		if (!customer) {
			frappe.show_alert({ message: "Seleccione un cliente primero.", indicator: "orange" });
			return;
		}

		const dlg = new frappe.ui.Dialog({
			title: 'Análisis de Ventas - ' + customer,
			fields: [
				{ fieldtype: 'HTML', fieldname: 'analytics_html' }
			],
			size: 'large'
		});

		dlg.get_field('analytics_html').$wrapper.html('<div style="padding:40px;text-align:center;color:#64748b;font-size:13px">Cargando análisis...</div>');
		dlg.show();

		frappe.call({
			method: "facex_multi.api.analytics.get_customer_analytics",
			args: { customer, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				if (!r.exc && r.message) {
					const html = this._generate_analytics_html(r.message);
					dlg.get_field('analytics_html').$wrapper.html(html);

					// Bind click to open invoice
					dlg.get_field('analytics_html').$wrapper.find(".ef-inv-row").on("click", (e) => {
						const inv = $(e.currentTarget).attr("data-load-invoice");
						if (inv) {
							dlg.hide();
							this.load_invoice(inv);
						}
					});
				} else {
					dlg.get_field('analytics_html').$wrapper.html('<div style="padding:40px;text-align:center;color:#e63946;font-size:13px">Error al cargar datos.</div>');
				}
			},
		});
	}

	_generate_analytics_html(data) {
		const s        = data.stats_6m || {};
		const currency = this.doc.currency || "GTQ";
		const months   = (data.monthly_chart || []).map((m) => m.month);
		const totals   = (data.monthly_chart || []).map((m) => parseFloat(m.total || 0));
		const maxTotal = Math.max(...totals, 1);

		const barsHtml = months.map((m, i) => {
			const pct = (totals[i] / maxTotal * 100).toFixed(0);
			return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:3px">
				<div style="font-size:10px;color:#64748b">${_fmtCurrency(totals[i], currency)}</div>
				<div style="width:100%;background:#e2e8f0;border-radius:3px;height:80px;display:flex;align-items:flex-end">
					<div style="width:100%;background:var(--ef-primary);border-radius:3px;height:${pct}%;min-height:3px"></div>
				</div>
				<div style="font-size:10px;color:#64748b;white-space:nowrap">${m.substring(5)}</div>
			</div>`;
		}).join("");

		const lastInvHtml = (data.last_invoices || []).map((inv) => {
			const isPaid = inv.docstatus === 1 && (inv.custom_pagado === 1 || (parseFloat(inv.outstanding_amount) || 0) < 0.01);
			const isPartial = inv.docstatus === 1 && !isPaid && (parseFloat(inv.outstanding_amount) || 0) < (parseFloat(inv.grand_total) || 0) - 0.01;
			const badge  = inv.docstatus === 1
				? (isPaid ? '<span class="ef-badge ef-badge-submitted" style="font-size:10px">PAGADA</span>'
				           : (isPartial ? '<span class="ef-badge ef-badge-certified" style="font-size:10px">PARCIAL</span>'
				                        : '<span class="ef-badge ef-badge-cancelled" style="font-size:10px">NO PAGADA</span>'))
				: '<span class="ef-badge ef-badge-new" style="font-size:10px">BORRADOR</span>';
			return `<div class="ef-inv-row" data-load-invoice="${_esc(inv.name)}" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--ef-border);cursor:pointer">
				<div>
					<strong style="font-size:13px">${_esc(inv.name)}</strong>
					<span style="color:#64748b;font-size:11px;margin-left:8px">${_esc(inv.posting_date)}</span>
				</div>
				<div style="display:flex;align-items:center;gap:10px">
					<span style="font-weight:600">${_fmtCurrency(inv.grand_total, currency)}</span>
					${badge}
				</div>
			</div>`;
		}).join("") || '<div style="padding:16px;color:#64748b;font-size:12px">Sin facturas recientes.</div>';

		const outstandingHtml = (data.outstanding || []).map((inv) =>
			`<div style="display:flex;justify-content:space-between;padding:6px 12px;border-bottom:1px solid var(--ef-border)">
				<span style="font-size:12px">${_esc(inv.name)} <span style="color:#64748b">${_esc(inv.posting_date)}</span></span>
				<span style="color:#e63946;font-weight:600;font-size:12px">${_fmtCurrency(inv.outstanding_amount, currency)}</span>
			</div>`
		).join("") || '<div style="padding:10px 12px;color:#64748b;font-size:12px">Sin saldos pendientes.</div>';

		return `<div style="padding:16px 20px">
			<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px">
				<div class="ef-stat-card"><div class="ef-stat-label">Facturas (6 meses)</div><div class="ef-stat-value">${s.count || 0}</div></div>
				<div class="ef-stat-card"><div class="ef-stat-label">Total (6 meses)</div><div class="ef-stat-value" style="font-size:15px">${_fmtCurrency(s.total, currency)}</div></div>
				<div class="ef-stat-card"><div class="ef-stat-label">Factura más alta</div><div class="ef-stat-value" style="font-size:15px">${_fmtCurrency(s.max_invoice, currency)}</div></div>
				<div class="ef-stat-card"><div class="ef-stat-label">Promedio / factura</div><div class="ef-stat-value" style="font-size:15px">${_fmtCurrency(s.avg_invoice, currency)}</div></div>
			</div>
			<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
				<div class="ef-analytics-card">
					<div class="ef-analytics-card-title">Ventas mensuales (6 meses)</div>
					${months.length
						? `<div style="display:flex;gap:6px;align-items:flex-end;padding:12px;height:130px">${barsHtml}</div>`
						: '<div style="padding:20px;text-align:center;color:#94a3b8;font-size:12px">Sin datos</div>'}
				</div>
				<div class="ef-analytics-card">
					<div class="ef-analytics-card-title">Saldos Pendientes</div>
					${outstandingHtml}
				</div>
			</div>
			<div class="ef-analytics-card">
				<div class="ef-analytics-card-title">Últimas Facturas</div>
				${lastInvHtml}
			</div>
		</div>`;
	}

	// -----------------------------------------------------------------------
	// Cancel FEL Action
	// -----------------------------------------------------------------------
	_action_cancel_fel() {
		if (!this.doc.name || this.doc.name === "new") return;

		frappe.prompt({
			label: 'Motivo de anulación FEL',
			fieldname: 'motivo_anulacion',
			fieldtype: 'Data',
			reqd: 1
		}, (values) => {
			frappe.call({
				method: 'brainfel.api.certify_sales_invoice.cancel_sales_invoice_fel',
				args: {
					sales_invoice_name: this.doc.name,
					motivo_anulacion: values.motivo_anulacion
				},
				freeze: true,
				freeze_message: "Anulando en portal FEL...",
				callback: (r) => {
					if (!r.exc && r.message && r.message.success) {
						frappe.show_alert({
							message: r.message.message || "Documento anulado correctamente en FEL.",
							indicator: 'green'
						});
						// Reload to reflect cancelled state
						this.load_invoice(this.doc.name);
					}
				}
			});
		}, 'Anulación FEL', 'Anular');
	}

	// -----------------------------------------------------------------------
	// Reports & Receipts Portal Logic
	// -----------------------------------------------------------------------

	_load_reports_view() {
		frappe.call({
			method: "facex_multi.api.reports.has_reports_permission",
			callback: (r) => {
				const has_perm = r.message;
				if (!has_perm) {
					this.$body.find("#ef-report-filters").hide();
					this.$body.find("#ef-report-kpi-row").hide();
					this.$body.find("#ef-report-data-card").hide();
					this.$body.find("#ef-report-unauthorized").show();
					
					this.$body.find("#ef-rep-btn-go-back").off("click").on("click", () => {
						this._switch_view("dashboard");
					});
					return;
				}

				this.$body.find("#ef-report-unauthorized").hide();
				this.$body.find("#ef-report-kpi-row").show();
				this.$body.find("#ef-report-data-card").show();

				this._setup_report_filters();
				this._setup_report_events();

				if (!this._active_report) {
					this._active_report = "sales_by_date";
				}
				this._switch_report(this._active_report);
			}
		});
	}

	_switch_report(report_id) {
		this._active_report = report_id;

		this.$body.find(".ef-report-nav-btn").removeClass("ef-report-nav-active");
		this.$body.find(`.ef-report-nav-btn[data-report="${report_id}"]`).addClass("ef-report-nav-active");

		const reportsMeta = {
			sales_by_date: {
				title: "Ventas por Fecha",
				desc: "Muestra el total facturado detallado por rango de fechas, clientes y almacenes."
			},
			sales_by_product: {
				title: "Ventas por Producto",
				desc: "Analiza el volumen de ventas y los ingresos generados por cada artículo o grupo de artículos."
			},
			cancelled_invoices: {
				title: "Facturas Canceladas",
				desc: "Listado de documentos anulados con detalles de montos, usuarios y fechas de modificación."
			},
			customer_statement: {
				title: "Estado de Cuenta de Clientes",
				desc: "Historial completo de cargos, pagos recibidos y saldos aislados de la facturación FacEx."
			},
			aging_receivables: {
				title: "Antigüedad de Saldos",
				desc: "Parámetros de vencimiento de cartera pendiente por cobrar organizados en rangos de días."
			},
			quotations_report: {
				title: "Cotizaciones (Borradores)",
				desc: "Registro de pre-facturas y cotizaciones en estado borrador pendientes de validar y firmar."
			},
			payments_report: {
				title: "Recibos y Pagos",
				desc: "Reporte consolidado de transacciones de abonos emitidos y formas de pago utilizadas."
			},
			uncertified_invoices: {
				title: "Errores FEL / Sin Certificar",
				desc: "Facturas validadas (docstatus=1) en estado '01 Enviar' que carecen de firma electrónica o tienen errores."
			},
			sales_growth_analysis: {
				title: "Crecimiento de Ventas (Comparativo)",
				desc: "Análisis del año actual contra el año anterior graficado mes a mes sin dependencias externas."
			},
			utility_analysis: {
				title: "Análisis de Utilidad",
				desc: "Utilidad Q y % de cada producto: precio de venta neto contra el costo estándar, el promedio ponderado del sistema o el último precio de compra."
			},
			print_receipt: {
				title: "Imprimir Recibo de Pago",
				desc: "Busque cualquier factura del sistema para reimprimir su comprobante de pago personalizado."
			}
		};

		const meta = reportsMeta[report_id] || { title: "Reporte", desc: "" };
		this.$body.find("#ef-report-title").text(meta.title);
		this.$body.find("#ef-report-desc").text(meta.desc);

		this._update_filter_visibility(report_id);

		if (report_id !== "print_receipt") {
			this.$body.find("#ef-report-tbody").empty();
			this.$body.find("#ef-report-thead").empty();
			this.$body.find("#ef-report-kpi-row").empty();
			this.$body.find("#ef-report-empty").hide();
			
			this._run_active_report();
		}
	}

	_setup_report_events() {
		this.$body.find(".ef-report-nav-btn").off("click").on("click", (e) => {
			const report_id = $(e.currentTarget).data("report");
			this._switch_report(report_id);
		});

		// Group header toggle
		this.$body.find(".ef-report-group-header").off("click").on("click", (e) => {
			const group = $(e.currentTarget).data("group");
			const $header = $(e.currentTarget);
			const $items = this.$body.find(`.ef-report-group-items[data-group-items="${group}"]`);
			$header.toggleClass("ef-group-collapsed");
			$items.toggleClass("ef-group-hidden");
		});

		// Company change reloads the report
		this.$body.find("#ef-rep-company").off("change").on("change", () => {
			this._run_active_report();
		});

		this.$body.find("#ef-rep-btn-apply").off("click").on("click", () => {
			this._run_active_report();
		});

		this.$body.find("#ef-report-btn-export").off("click").on("click", () => {
			this._export_report_csv();
		});

		this.$body.find("#ef-report-btn-print-pdf").off("click").on("click", () => {
			this._print_report_pdf();
		});
	}

	_setup_report_filters() {
		const today = frappe.datetime.get_today();
		const start_of_month = frappe.datetime.month_start();
		
		if (!this.$body.find("#ef-rep-start-date").val()) {
			this.$body.find("#ef-rep-start-date").val(start_of_month);
		}
		if (!this.$body.find("#ef-rep-end-date").val()) {
			this.$body.find("#ef-rep-end-date").val(today);
		}

		const get_company = () => this.doc.company || this.defaults.company || "";

		if (!this.rep_customer_ctrl) {
			const get_query_fn = () => {
				const comp = get_company();
				return {
					or_filters: [
						["Customer", "bfel_company", "=", comp],
						["Customer", "bfel_company_null", "=", 0],
					],
				};
			};
			this.rep_customer_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-rep-customer-ctrl")[0],
				df: {
					only_select: 1,
					label: "Cliente",
					fieldtype: "Link",
					fieldname: "rep_customer",
					options: "Customer",
					reqd: 0,
					get_query: get_query_fn
				},
				render_input: true,
				only_input: false,
			});
			this.rep_customer_ctrl.get_query = get_query_fn;
			this.rep_customer_ctrl.refresh();
		}

		if (!this.rep_item_ctrl) {
			const get_query_fn = () => {
				const comp = get_company();
				return {
					or_filters: [
						["Item", "bfel_company", "=", comp],
						["Item", "bfel_company_null", "=", 0],
					],
				};
			};
			this.rep_item_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-rep-item-ctrl")[0],
				df: {
					only_select: 1,
					label: "Item",
					fieldtype: "Link",
					fieldname: "rep_item",
					options: "Item",
					reqd: 0,
					get_query: get_query_fn
				},
				render_input: true,
				only_input: false,
			});
			this.rep_item_ctrl.get_query = get_query_fn;
			this.rep_item_ctrl.refresh();
		}

		if (!this.rep_item_group_ctrl) {
			const get_query_fn = () => {
				const comp = get_company();
				return {
					or_filters: [
						["Item Group", "bfel_company", "=", comp],
						["Item Group", "bfel_company_null", "=", 0],
					],
				};
			};
			this.rep_item_group_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-rep-item-group-ctrl")[0],
				df: {
					only_select: 1,
					label: "Grupo de Items",
					fieldtype: "Link",
					fieldname: "rep_item_group",
					options: "Item Group",
					reqd: 0,
					get_query: get_query_fn
				},
				render_input: true,
				only_input: false,
			});
			this.rep_item_group_ctrl.get_query = get_query_fn;
			this.rep_item_group_ctrl.refresh();
		}

		if (!this.rep_supplier_ctrl) {
			this.rep_supplier_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-rep-supplier-ctrl")[0],
				df: {
					only_select: 1,
					label: "Proveedor",
					fieldtype: "Link",
					fieldname: "rep_supplier",
					options: "Supplier",
					reqd: 0,
				},
				render_input: true,
				only_input: false,
			});
			this.rep_supplier_ctrl.refresh();
		}

		if (!this.rep_warehouse_ctrl) {
			const get_query_fn = () => {
				const comp = get_company();
				const filters = { company: comp };
				if ((this.warehouses || []).length) {
					filters.name = ["in", this.warehouses];
				}
				return { filters };
			};
			this.rep_warehouse_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-rep-warehouse-ctrl")[0],
				df: {
					only_select: 1,
					label: "Bodega",
					fieldtype: "Link",
					fieldname: "rep_warehouse",
					options: "Warehouse",
					reqd: 0,
					get_query: get_query_fn
				},
				render_input: true,
				only_input: false,
			});
			this.rep_warehouse_ctrl.get_query = get_query_fn;
			this.rep_warehouse_ctrl.refresh();
		}

		if (!this.rep_print_invoice_ctrl) {
			const get_query_fn = () => {
				const comp = get_company();
				return {
					filters: {
						docstatus: 1,
						company: comp
					}
				};
			};
			this.rep_print_invoice_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-print-invoice-link-ctrl")[0],
				df: {
					only_select: 1,
					label: "Factura",
					fieldtype: "Link",
					fieldname: "rep_print_invoice",
					options: "Sales Invoice",
					reqd: 0,
					get_query: get_query_fn
				},
				render_input: true,
				only_input: false,
			});
			this.rep_print_invoice_ctrl.get_query = get_query_fn;
			this.rep_print_invoice_ctrl.refresh();
			
			const _onInvoiceChange = () => {
				setTimeout(() => {
					const inv_name = this.rep_print_invoice_ctrl.get_value();
					if (inv_name) {
						this._load_invoice_payment_receipt_details(inv_name);
					} else {
						this.$body.find("#ef-print-receipt-details").hide();
					}
				}, 50);
			};
			if (this.rep_print_invoice_ctrl && this.rep_print_invoice_ctrl.$input) {
				this.rep_print_invoice_ctrl.$input.on("change blur awesomplete-selectcomplete", _onInvoiceChange);
			}
			this.rep_print_invoice_ctrl.df.change = _onInvoiceChange;
		}

		const $yearSelect = this.$body.find("#ef-rep-year");
		if ($yearSelect.length && !$yearSelect.children().length) {
			const currentYear = new Date().getFullYear();
			for (let y = currentYear; y >= currentYear - 5; y--) {
				$yearSelect.append(`<option value="${y}">${y}</option>`);
			}
		}
		const currentMonth = new Date().getMonth() + 1;
		this.$body.find("#ef-rep-month").val(currentMonth);

		// Populate company selector
		const $repCo = this.$body.find("#ef-rep-company");
		if ($repCo.length && !$repCo.data("populated")) {
			$repCo.data("populated", true);
			$repCo.append(`<option value="">— Todas —</option>`);
			frappe.call({
				method: "facex_multi.api.invoice.get_user_companies",
				callback: (r) => {
					const companies = r.message || [];
					const current = this.doc.company || this.defaults.company || "";
					companies.forEach((c) => {
						const sel = c === current ? ' selected' : '';
						$repCo.append(`<option value="${_esc(c)}"${sel}>${_esc(c)}</option>`);
					});
					// Si solo hay una compañía, seleccionarla por defecto
					if (companies.length === 1) {
						$repCo.val(companies[0]);
					}
				}
			});
		}

		// Populate establishment selector
		const $repEst = this.$body.find("#ef-rep-establecimiento");
		if ($repEst.length) {
			const prev_val = $repEst.val();
			$repEst.empty();
			$repEst.append(`<option value="">— Todos —</option>`);
			const establishments = this.defaults.establishments || [];
			establishments.forEach((e) => {
				$repEst.append(`<option value="${e.establecimiento_id}">${e.establecimiento_id} - ${e.nombre_establecimiento}</option>`);
			});
			if (prev_val) {
				$repEst.val(prev_val);
			}
		}
	}

	_update_filter_visibility(report_id) {
		this.$body.find(".ef-rep-filter").hide();
		this.$body.find("#ef-report-filters").show();
		this.$body.find("#ef-report-btn-export").show();
		this.$body.find("#ef-report-table-title").show();
		this.$body.find("#ef-report-table-wrapper").show();
		this.$body.find("#ef-report-chart-container").hide();
		this.$body.find("#ef-report-print-receipt-container").hide();

		if (report_id === "customer_statement" || report_id === "aging_receivables") {
			this.$body.find("#ef-report-btn-print-pdf").css("display", "flex");
		} else {
			this.$body.find("#ef-report-btn-print-pdf").hide();
		}

		if (report_id === "sales_by_date") {
			this.$body.find(".ef-filter-company, .ef-filter-date, .ef-filter-customer, .ef-filter-warehouse, .ef-filter-establecimiento").show();
		} else if (report_id === "sales_by_product") {
			this.$body.find(".ef-filter-company, .ef-filter-date, .ef-filter-customer, .ef-filter-item, .ef-filter-item-group, .ef-filter-warehouse, .ef-filter-establecimiento").show();
		} else if (report_id === "cancelled_invoices") {
			this.$body.find(".ef-filter-company, .ef-filter-date, .ef-filter-customer, .ef-filter-establecimiento").show();
		} else if (report_id === "customer_statement") {
			this.$body.find(".ef-filter-company, .ef-filter-customer, .ef-filter-date, .ef-filter-doc-type, .ef-filter-establecimiento").show();
		} else if (report_id === "aging_receivables") {
			this.$body.find(".ef-filter-company, .ef-filter-customer, .ef-filter-establecimiento").show();
		} else if (report_id === "quotations_report") {
			this.$body.find(".ef-filter-company, .ef-filter-date, .ef-filter-customer, .ef-filter-establecimiento").show();
		} else if (report_id === "payments_report") {
			this.$body.find(".ef-filter-company, .ef-filter-date, .ef-filter-payment-method, .ef-filter-establecimiento").show();
		} else if (report_id === "uncertified_invoices") {
			this.$body.find(".ef-filter-company, .ef-filter-establecimiento").show();
		} else if (report_id === "sales_growth_analysis") {
			this.$body.find(".ef-filter-company, .ef-filter-year, .ef-filter-month, .ef-filter-establecimiento").show();
			this.$body.find("#ef-report-chart-container").show();
		} else if (report_id === "utility_analysis") {
			this.$body.find(".ef-filter-company, .ef-filter-cost-basis, .ef-filter-item, .ef-filter-item-group, .ef-filter-supplier").show();
		} else if (report_id === "print_receipt") {
			this.$body.find("#ef-report-filters").hide();
			this.$body.find("#ef-report-btn-export").hide();
			this.$body.find("#ef-report-table-title").hide();
			this.$body.find("#ef-report-table-wrapper").hide();
			this.$body.find("#ef-report-print-receipt-container").show();
		}
	}

	_run_active_report() {
		const report_id = this._active_report;
		if (!report_id || report_id === "print_receipt") return;

		const start_date = this.$body.find("#ef-rep-start-date").val();
		const end_date = this.$body.find("#ef-rep-end-date").val();
		const customer = this.rep_customer_ctrl ? this.rep_customer_ctrl.get_value() : "";
		const item_code = this.rep_item_ctrl ? this.rep_item_ctrl.get_value() : "";
		const item_group = this.rep_item_group_ctrl ? this.rep_item_group_ctrl.get_value() : "";
		const warehouse = this.rep_warehouse_ctrl ? this.rep_warehouse_ctrl.get_value() : "";
		const payment_method = this.$body.find("#ef-rep-payment-method").val();
		const doc_type_filter = this.$body.find("#ef-rep-doc-type").val();
		const year = this.$body.find("#ef-rep-year").val() || new Date().getFullYear();
		const month = this.$body.find("#ef-rep-month").val() || (new Date().getMonth() + 1);
		const establecimiento = this.$body.find("#ef-rep-establecimiento").val();
		const cost_basis = this.$body.find("#ef-rep-cost-basis").val() || "estandar";
		const supplier = this.rep_supplier_ctrl ? this.rep_supplier_ctrl.get_value() : "";

		if (report_id === "customer_statement" && !customer) {
			frappe.msgprint({
				title: __("Filtro Requerido"),
				message: __("Por favor seleccione un cliente para generar su Estado de Cuenta."),
				indicator: "orange"
			});
			return;
		}

		let method = "";
		let args = {};

		if (report_id === "sales_by_date") {
			method = "facex_multi.api.reports.get_sales_by_date";
			args = { start_date, end_date, customer, warehouse, establecimiento };
		} else if (report_id === "sales_by_product") {
			method = "facex_multi.api.reports.get_sales_by_product";
			args = { start_date, end_date, item_code, item_group, customer, warehouse, establecimiento };
		} else if (report_id === "cancelled_invoices") {
			method = "facex_multi.api.reports.get_cancelled_invoices";
			args = { start_date, end_date, customer, establecimiento };
		} else if (report_id === "customer_statement") {
			method = "facex_multi.api.reports.get_customer_statement";
			args = { customer, start_date, end_date, doc_type_filter, establecimiento };
		} else if (report_id === "aging_receivables") {
			method = "facex_multi.api.reports.get_aging_receivables";
			args = { customer, establecimiento };
		} else if (report_id === "quotations_report") {
			method = "facex_multi.api.reports.get_quotations_report";
			args = { start_date, end_date, customer, establecimiento };
		} else if (report_id === "payments_report") {
			method = "facex_multi.api.reports.get_payments_report";
			args = { start_date, end_date, payment_method, establecimiento };
		} else if (report_id === "uncertified_invoices") {
			method = "facex_multi.api.reports.get_uncertified_invoices";
			args = { establecimiento };
		} else if (report_id === "sales_growth_analysis") {
			method = "facex_multi.api.reports.get_sales_growth_analysis";
			args = { year, month, establecimiento };
		} else if (report_id === "utility_analysis") {
			method = "facex_multi.api.utilidad.get_utility_analysis";
			args = { cost_basis, item_code, item_group, supplier };
		}

		// Si el filtro de compañía está en "Todas" (vacío), el backend resolverá por permisos del usuario
		const selectedCompany = this.$body.find("#ef-rep-company").val();
		args.company = selectedCompany !== undefined ? selectedCompany : (this.doc.company || this.defaults.company || "");

		frappe.call({
			method: method,
			args: args,
			freeze: true,
			freeze_message: "Generando reporte...",
			callback: (r) => {
				if (!r.exc && r.message) {
					this._render_report_data(report_id, r.message);
				}
			}
		});
	}

	_render_report_data(report_id, data) {
		const $thead = this.$body.find("#ef-report-thead");
		const $tbody = this.$body.find("#ef-report-tbody");
		const $kpis = this.$body.find("#ef-report-kpi-row");
		const $empty = this.$body.find("#ef-report-empty");

		$thead.empty();
		$tbody.empty();
		$kpis.empty();
		$empty.hide();

		this._last_report_data = data;
		this._last_report_id = report_id;

		if (report_id === "sales_by_date") {
			const invoices = data.invoices || [];
			const sum = data.summary || {};

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-primary); cursor: default;">
					<div class="ef-stat-label">Total Facturado</div>
					<div class="ef-stat-value" style="font-family:monospace;">${_fmtCurrency(sum.total_sales, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-success); cursor: default;">
					<div class="ef-stat-label">Impuestos Consolidados</div>
					<div class="ef-stat-value" style="color: var(--ef-success); font-family:monospace;">${_fmtCurrency(sum.total_tax, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-info); cursor: default;">
					<div class="ef-stat-label">Ticket Promedio</div>
					<div class="ef-stat-value" style="color: var(--ef-info); font-family:monospace;">${_fmtCurrency(sum.avg_sale, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-text-muted); cursor: default;">
					<div class="ef-stat-label">Transacciones</div>
					<div class="ef-stat-value" style="color: var(--ef-text-muted);">${sum.count} facturas</div>
				</div>
			`);

			if (invoices.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Factura</th>
					<th class="ef-th">Fecha</th>
					<th class="ef-th">Cliente</th>
					<th class="ef-th ef-td-num">Subtotal/Base</th>
					<th class="ef-th ef-td-num">Impuestos</th>
					<th class="ef-th ef-td-num">Total</th>
					<th class="ef-th ef-td-num">Pendiente</th>
				</tr>
			`);

			invoices.forEach(inv => {
				$tbody.append(`
					<tr>
						<td class="ef-td"><a class="ef-inv-load-link" data-name="${inv.name}" style="color:var(--ef-primary); font-weight:700; text-decoration:underline; cursor:pointer;">${inv.name}</a></td>
						<td class="ef-td">${inv.posting_date}</td>
						<td class="ef-td">${inv.customer_name || inv.customer}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(inv.total, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(inv.total_taxes_and_charges, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700;">${_fmtCurrency(inv.grand_total, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; color:${inv.outstanding_amount > 0 ? "var(--ef-warning)" : "var(--ef-success)"};">${_fmtCurrency(inv.outstanding_amount, "GTQ")}</td>
					</tr>
				`);
			});

		} else if (report_id === "sales_by_product") {
			const products = data.products || [];
			const sum = data.summary || {};

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-primary); cursor: default;">
					<div class="ef-stat-label">Monto Total Vendido</div>
					<div class="ef-stat-value" style="font-family:monospace;">${_fmtCurrency(sum.total_amount, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-success); cursor: default;">
					<div class="ef-stat-label">Unidades Vendidas</div>
					<div class="ef-stat-value" style="color: var(--ef-success); font-family:monospace;">${_fmt(sum.total_qty)} uds</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-info); cursor: default;">
					<div class="ef-stat-label">Productos Distintos</div>
					<div class="ef-stat-value" style="color: var(--ef-info);">${sum.count} ítems</div>
				</div>
			`);

			if (products.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Código Ítem</th>
					<th class="ef-th">Descripción</th>
					<th class="ef-th ef-td-num">Cantidad</th>
					<th class="ef-th ef-td-num">Precio Prom.</th>
					<th class="ef-th ef-td-num">Importe Total</th>
				</tr>
			`);

			products.forEach(p => {
				$tbody.append(`
					<tr>
						<td class="ef-td" style="font-weight:600;">${p.item_code}</td>
						<td class="ef-td">${p.item_name}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmt(p.total_qty)}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(p.avg_rate, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700;">${_fmtCurrency(p.total_amount, "GTQ")}</td>
					</tr>
				`);
			});

		} else if (report_id === "cancelled_invoices") {
			const invoices = data.invoices || [];
			const sum = data.summary || {};

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-danger); cursor: default;">
					<div class="ef-stat-label">Monto Total Cancelado</div>
					<div class="ef-stat-value" style="color: var(--ef-danger); font-family:monospace;">${_fmtCurrency(sum.total_amount, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-text-muted); cursor: default;">
					<div class="ef-stat-label" style="font-weight:bold;">Facturas Anuladas</div>
					<div class="ef-stat-value" style="color: var(--ef-text-muted);">${sum.count} facturas</div>
				</div>
			`);

			if (invoices.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Factura</th>
					<th class="ef-th">Fecha Emisión</th>
					<th class="ef-th">Cliente</th>
					<th class="ef-th ef-td-num">Monto Anulado</th>
					<th class="ef-th" style="text-align:center;">Anulado FEL</th>
					<th class="ef-th">Cancelado por</th>
					<th class="ef-th">Fecha Anulación</th>
				</tr>
			`);

			invoices.forEach(inv => {
				const anulado_badge = (inv.bfel_documento_anulado === 1 || inv.bfel_documento_anulado === "1")
					? `<span class="ef-badge" style="background:#ffe3e0; color:#e63946; font-weight:700; padding: 2px 6px; border-radius: 4px;">SÍ</span>`
					: `<span class="ef-badge" style="background:#e2e8f0; color:#475569; padding: 2px 6px; border-radius: 4px;">NO</span>`;

				$tbody.append(`
					<tr>
						<td class="ef-td" style="font-weight:700; color:var(--ef-text-muted);">${inv.name}</td>
						<td class="ef-td">${inv.posting_date}</td>
						<td class="ef-td">${inv.customer_name || inv.customer}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700; color:var(--ef-danger);">${_fmtCurrency(inv.grand_total, "GTQ")}</td>
						<td class="ef-td" style="text-align:center;">${anulado_badge}</td>
						<td class="ef-td">${inv.modified_by}</td>
						<td class="ef-td">${inv.modified}</td>
					</tr>
				`);
			});

		} else if (report_id === "customer_statement") {
			const ledger = data.ledger || [];
			const sum = data.summary || {};

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-primary); cursor: default;">
					<div class="ef-stat-label">Total Cargos (Facturado)</div>
					<div class="ef-stat-value" style="font-family:monospace;">${_fmtCurrency(sum.total_invoiced, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-success); cursor: default;">
					<div class="ef-stat-label">Total Abonos (Pagado)</div>
					<div class="ef-stat-value" style="color: var(--ef-success); font-family:monospace;">${_fmtCurrency(sum.total_paid, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-warning); cursor: default;">
					<div class="ef-stat-label">Saldo Pendiente</div>
					<div class="ef-stat-value" style="color: var(--ef-warning); font-family:monospace;">${_fmtCurrency(sum.outstanding_balance, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-text-muted); cursor: default;">
					<div class="ef-stat-label">Límite de Crédito Autorizado</div>
					<div class="ef-stat-value" style="color: var(--ef-text-muted); font-family:monospace;">${_fmtCurrency(sum.credit_limit, "GTQ")}</div>
				</div>
			`);

			if (ledger.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Factura</th>
					<th class="ef-th">Serie - No</th>
					<th class="ef-th">Fecha Emisión</th>
					<th class="ef-th">Fecha Vencimiento</th>
					<th class="ef-th">Tipo</th>
					<th class="ef-th ef-td-num">Monto Cargo</th>
					<th class="ef-th ef-td-num">Monto Abono</th>
					<th class="ef-th ef-td-num">Saldo Restante</th>
					<th class="ef-th">Estado Pago</th>
				</tr>
			`);

			ledger.forEach(row => {
				const status_badge = row.status === "Liquidado" 
					? `<span class="ef-badge ef-badge-active" style="background:#d8f3dc; color:#2dc653;">Liquidado</span>`
					: `<span class="ef-badge ef-badge-new" style="background:#ffe3e0; color:#e63946;">Pendiente</span>`;

				$tbody.append(`
					<tr>
						<td class="ef-td"><a class="ef-inv-load-link" data-name="${row.name}" style="color:var(--ef-primary); font-weight:700; text-decoration:underline; cursor:pointer;">${row.name}</a></td>
						<td class="ef-td" style="font-weight:600;">${row.serie_no || "—"}</td>
						<td class="ef-td">${row.posting_date}</td>
						<td class="ef-td">${row.due_date || "—"}</td>
						<td class="ef-td"><span style="font-weight:600; color:var(--ef-text);">${row.doc_type_desc || "Factura"}</span></td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(row.grand_total, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; color:var(--ef-success);">${_fmtCurrency(row.paid_amount, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700; color:${row.balance > 0 ? "var(--ef-warning)" : "var(--ef-success)"}">${_fmtCurrency(row.balance, "GTQ")}</td>
						<td class="ef-td">${status_badge}</td>
					</tr>
				`);
			});

		} else if (report_id === "aging_receivables") {
			const aging = data.aging || [];
			const sum = data.summary || {};

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-danger); cursor: default;">
					<div class="ef-stat-label">Total Cartera Vencida</div>
					<div class="ef-stat-value" style="color: var(--ef-danger); font-family:monospace;">${_fmtCurrency(sum.total_outstanding, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-primary); cursor: default;">
					<div class="ef-stat-label">Corriente (0-30 días)</div>
					<div class="ef-stat-value" style="color: var(--ef-primary); font-family:monospace;">${_fmtCurrency(sum.total_0_30, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-warning); cursor: default;">
					<div class="ef-stat-label">Vencido (31-60 días)</div>
					<div class="ef-stat-value" style="color: var(--ef-warning); font-family:monospace;">${_fmtCurrency(sum.total_31_60, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid #7209b7; cursor: default;">
					<div class="ef-stat-label">Vencido Crítico (61+ días)</div>
					<div class="ef-stat-value" style="color: #7209b7; font-family:monospace;">${_fmtCurrency(sum.total_61_90 + sum.total_91_plus, "GTQ")}</div>
				</div>
			`);

			if (aging.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th" style="width: 40px;"></th>
					<th class="ef-th">Cliente</th>
					<th class="ef-th ef-td-num">Saldo Vencido</th>
					<th class="ef-th ef-td-num">0 - 30 días</th>
					<th class="ef-th ef-td-num">31 - 60 días</th>
					<th class="ef-th ef-td-num">61 - 90 días</th>
					<th class="ef-th ef-td-num">91+ días</th>
				</tr>
			`);

			aging.forEach((row, idx) => {
				const detailId = `aging-detail-${idx}`;
				$tbody.append(`
					<tr class="ef-aging-summary-row" data-target="#${detailId}" style="cursor: pointer; background-color: var(--ef-card);">
						<td class="ef-td" style="text-align: center;">
							<span class="ef-aging-toggle-icon" style="display: inline-block; transition: transform 0.2s; font-size: 10px;">▶</span>
						</td>
						<td class="ef-td" style="font-weight:700;">${row.customer_name}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700; color:var(--ef-danger);">${_fmtCurrency(row.total_outstanding, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(row.range_0_30, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(row.range_31_60, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(row.range_61_90, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; color:var(--ef-danger);">${_fmtCurrency(row.range_91_plus, "GTQ")}</td>
					</tr>
					<tr id="${detailId}" class="ef-aging-detail-row" style="display: none; background-color: #f8fafc;">
						<td colspan="7" style="padding: 12px 12px 16px 40px; border-top: none;">
							<div style="border-left: 3px solid var(--ef-primary); padding-left: 15px;">
								<h5 style="margin: 0 0 10px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--ef-text-muted);">Detalle de Facturas Vencidas</h5>
								<table style="width: 100%; border-collapse: collapse; font-size: 12px; background: white; border: 1px solid var(--ef-border); border-radius: 6px; overflow: hidden; box-shadow: var(--ef-shadow);">
									<thead>
										<tr style="background: #f1f5f9; border-bottom: 1px solid var(--ef-border);">
											<th style="padding: 8px 12px; text-align: left; font-weight: 700; font-size: 11px; border: none;">Factura</th>
											<th style="padding: 8px 12px; text-align: left; font-weight: 700; font-size: 11px; border: none;">Serie - No</th>
											<th style="padding: 8px 12px; text-align: left; font-weight: 700; font-size: 11px; border: none;">Fecha Contabilización</th>
											<th style="padding: 8px 12px; text-align: left; font-weight: 700; font-size: 11px; border: none;">Fecha Vencimiento</th>
											<th style="padding: 8px 12px; text-align: right; font-weight: 700; font-size: 11px; border: none;">Días Mora</th>
											<th style="padding: 8px 12px; text-align: right; font-weight: 700; font-size: 11px; border: none;">Original</th>
											<th style="padding: 8px 12px; text-align: right; font-weight: 700; font-size: 11px; border: none;">Saldo Pendiente</th>
											<th style="padding: 8px 12px; padding-left: 15px; border: none; padding-left: 15px;">Rango</th>
										</tr>
									</thead>
									<tbody>
										${(row.invoices || []).map(inv => `
											<tr style="border-bottom: 1px solid #f1f5f9;">
												<td style="padding: 8px 12px; border: none;"><a class="ef-inv-load-link" data-name="${inv.name}" style="color:var(--ef-primary); font-weight:700; text-decoration:underline; cursor:pointer;">${inv.name}</a></td>
												<td style="padding: 8px 12px; font-weight: 600; border: none;">${inv.serie_no || "—"}</td>
												<td style="padding: 8px 12px; border: none;">${inv.posting_date}</td>
												<td style="padding: 8px 12px; border: none;">${inv.due_date || "—"}</td>
												<td style="padding: 8px 12px; text-align: right; font-weight: 700; color: ${inv.days_due > 0 ? "var(--ef-danger)" : "var(--ef-text-muted)"}; border: none;">${inv.days_due}</td>
												<td style="padding: 8px 12px; text-align: right; font-family: monospace; border: none;">${_fmtCurrency(inv.grand_total, "GTQ")}</td>
												<td style="padding: 8px 12px; text-align: right; font-family: monospace; font-weight: 700; color: var(--ef-danger); border: none;">${_fmtCurrency(inv.outstanding_amount, "GTQ")}</td>
												<td style="padding: 8px 12px; padding-left: 15px; border: none;">
													<span class="ef-badge" style="background-color: ${inv.days_due <= 30 ? "#e0f2fe" : inv.days_due <= 60 ? "#fef3c7" : "#fee2e2"}; color: ${inv.days_due <= 30 ? "#0369a1" : inv.days_due <= 60 ? "#b45309" : "#b91c1c"}; font-weight: 700; padding: 2px 6px; border-radius: 4px;">${inv.bucket}</span>
												</td>
											</tr>
										`).join("")}
									</tbody>
								</table>
							</div>
						</td>
					</tr>
				`);
			});

			$tbody.off("click", ".ef-aging-summary-row").on("click", ".ef-aging-summary-row", (e) => {
				const targetSelector = $(e.currentTarget).data("target");
				const $detailRow = $tbody.find(targetSelector);
				const $icon = $(e.currentTarget).find(".ef-aging-toggle-icon");
				
				if ($detailRow.is(":visible")) {
					$detailRow.hide();
					$icon.css("transform", "rotate(0deg)");
				} else {
					$detailRow.show();
					$icon.css("transform", "rotate(90deg)");
				}
			});

		} else if (report_id === "quotations_report") {
			const invoices = data.invoices || [];
			const sum = data.summary || {};

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-warning); cursor: default;">
					<div class="ef-stat-label">Total Cotizado (Pre-Facturas)</div>
					<div class="ef-stat-value" style="color: var(--ef-warning); font-family:monospace;">${_fmtCurrency(sum.total_amount, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-text-muted); cursor: default;">
					<div class="ef-stat-label">Cotizaciones Abiertas</div>
					<div class="ef-stat-value" style="color: var(--ef-text-muted);">${sum.count} cotizaciones</div>
				</div>
			`);

			if (invoices.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Borrador ID</th>
					<th class="ef-th">Fecha Creación</th>
					<th class="ef-th">Cliente</th>
					<th class="ef-th ef-td-num">Monto Cotizado</th>
					<th class="ef-th">Estado FEL</th>
					<th class="ef-th">Acción</th>
				</tr>
			`);

			invoices.forEach(inv => {
				$tbody.append(`
					<tr>
						<td class="ef-td"><a class="ef-inv-load-link" data-name="${inv.name}" style="color:var(--ef-primary); font-weight:700; text-decoration:underline; cursor:pointer;">${inv.name}</a></td>
						<td class="ef-td">${inv.posting_date}</td>
						<td class="ef-td">${inv.customer_name || inv.customer}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700;">${_fmtCurrency(inv.grand_total, "GTQ")}</td>
						<td class="ef-td"><span class="ef-badge ef-badge-draft">${inv.bfel_status}</span></td>
						<td class="ef-td">
							<button class="ef-btn ef-btn-sm ef-btn-secondary ef-rep-print-quot" data-name="${inv.name}" data-company="${inv.company || ""}" style="padding:2px 8px; font-size:10px;">Imprimir F4</button>
						</td>
					</tr>
				`);
			});

			$tbody.off("click", ".ef-rep-print-quot").on("click", ".ef-rep-print-quot", (e) => {
				const name = $(e.currentTarget).data("name");
				// Usar SIEMPRE la compañía real de la factura de la fila, no la compañía
				// activa de sesión/editor: el reporte puede listar facturas de varias
				// compañías a la vez (filtro "Todas"), y mezclar formatos entre
				// compañías imprimiría membretes/datos fiscales equivocados.
				const company = $(e.currentTarget).data("company");
				frappe.call({
					method: "facex_multi.api.invoice.get_print_formats",
					args: { company: company || this.doc.company || this.defaults.company || "" },
					callback: (r) => {
						const formats = r.message || [];
						const defaultFormat = formats.find(f => f.toUpperCase().includes("COTI")) || "Cotización FacEx";
						const url = `/printview?doctype=Sales+Invoice&name=${encodeURIComponent(name)}&format=${encodeURIComponent(defaultFormat)}`;
						window.open(url, "_blank");
					}
				});
			});

		} else if (report_id === "payments_report") {
			const payments = data.payments || [];
			const sum = data.summary || {};

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-success); cursor: default;">
					<div class="ef-stat-label">Total Recibido (Abonos)</div>
					<div class="ef-stat-value" style="color: var(--ef-success); font-family:monospace;">${_fmtCurrency(sum.total_received, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-text-muted); cursor: default;">
					<div class="ef-stat-label">Transacciones Realizadas</div>
					<div class="ef-stat-value" style="color: var(--ef-text-muted);">${sum.count} abonos</div>
				</div>
			`);

			if (payments.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Fecha Pago</th>
					<th class="ef-th">Factura Origen</th>
					<th class="ef-th">Cliente</th>
					<th class="ef-th">Método Pago</th>
					<th class="ef-th">Referencia</th>
					<th class="ef-th ef-td-num">Monto Abono</th>
					<th class="ef-th" style="width:110px; text-align:center;">Acciones</th>
				</tr>
			`);

			payments.forEach(pay => {
				$tbody.append(`
					<tr>
						<td class="ef-td">${pay.payment_date}</td>
						<td class="ef-td"><a class="ef-inv-load-link" data-name="${pay.invoice}" style="color:var(--ef-primary); font-weight:700; text-decoration:underline; cursor:pointer;">${pay.invoice}</a></td>
						<td class="ef-td">${pay.customer_name || pay.customer}</td>
						<td class="ef-td" style="font-weight:600;">${pay.payment_method}</td>
						<td class="ef-td" style="font-family:monospace; font-size:11px;">${pay.reference || '—'}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700; color:var(--ef-success);">${_fmtCurrency(pay.amount, "GTQ")}</td>
						<td class="ef-td" style="text-align:center;">
							<button class="ef-btn ef-btn-sm ef-btn-secondary ef-rep-print-receipt" data-name="${pay.invoice}" data-company="${pay.company || ""}" style="padding:2px 8px; font-size:10px; font-weight:600;">Imprimir Recibo</button>
						</td>
					</tr>
				`);
			});

			$tbody.off("click", ".ef-rep-print-receipt").on("click", ".ef-rep-print-receipt", (e) => {
				const name = $(e.currentTarget).data("name");
				const company = $(e.currentTarget).data("company");
				this._print_payment_receipt(name, company);
			});

		} else if (report_id === "uncertified_invoices") {
			const invoices = data.invoices || [];
			const sum = data.summary || {};

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-danger); cursor: default;">
					<div class="ef-stat-label">Total en Retención FEL</div>
					<div class="ef-stat-value" style="color: var(--ef-danger); font-family:monospace;">${_fmtCurrency(sum.total_amount, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-warning); cursor: default;">
					<div class="ef-stat-label">Facturas Pendientes de Firma</div>
					<div class="ef-stat-value" style="color: var(--ef-warning);">${sum.count} documentos</div>
				</div>
			`);

			if (invoices.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Factura</th>
					<th class="ef-th">Fecha Emisión</th>
					<th class="ef-th">Cliente</th>
					<th class="ef-th ef-td-num">Monto Total</th>
					<th class="ef-th">Registro de Error FEL</th>
				</tr>
			`);

			invoices.forEach(inv => {
				const errorSnippet = inv.bfel_error_log 
					? `<div style="background:#fff2f4; color:#d9383a; font-size:11px; padding:6px 10px; border-radius:6px; border:1px solid #ffe3e6; max-width:400px; white-space:pre-wrap; word-break:break-all; font-family:monospace;">${_esc(inv.bfel_error_log)}</div>`
					: `<span style="color:#94a3b8; font-style:italic;">Sin registro de error detallado</span>`;

				$tbody.append(`
					<tr>
						<td class="ef-td"><a class="ef-inv-load-link" data-name="${inv.name}" style="color:var(--ef-primary); font-weight:700; text-decoration:underline; cursor:pointer;">${inv.name}</a></td>
						<td class="ef-td">${inv.posting_date}</td>
						<td class="ef-td">${inv.customer_name || inv.customer}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700;">${_fmtCurrency(inv.grand_total, "GTQ")}</td>
						<td class="ef-td">${errorSnippet}</td>
					</tr>
				`);
			});

		} else if (report_id === "sales_growth_analysis") {
			const chart_data = data.chart_data || [];
			const sum = data.summary || {};

			const growth_color = sum.overall_growth >= 0 ? "var(--ef-success)" : "var(--ef-danger)";
			const growth_prefix = sum.overall_growth >= 0 ? "+" : "";

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-primary); cursor: default;">
					<div class="ef-stat-label">Ventas Mes Seleccionado (${data.month_name} ${data.year})</div>
					<div class="ef-stat-value" style="font-family:monospace;">${_fmtCurrency(sum.total_current, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid #153375; cursor: default;">
					<div class="ef-stat-label">Ventas Mes Anterior (${data.prev_month_name} ${data.prev_year})</div>
					<div class="ef-stat-value" style="color: #153375; font-family:monospace;">${_fmtCurrency(sum.total_previous, "GTQ")}</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid ${growth_color}; cursor: default;">
					<div class="ef-stat-label">Crecimiento Consolidado</div>
					<div class="ef-stat-value" style="color: ${growth_color}; font-family:monospace;">${growth_prefix}${sum.overall_growth}%</div>
				</div>
			`);

			this._render_svg_growth_chart(chart_data, data.year, data.prev_year, data.month_name, data.prev_month_name);

			if (chart_data.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Día</th>
					<th class="ef-th ef-td-num">Mes Anterior (${data.prev_month_name} ${data.prev_year})</th>
					<th class="ef-th ef-td-num">Mes Seleccionado (${data.month_name} ${data.year})</th>
					<th class="ef-th ef-td-num">Variación Monetaria</th>
					<th class="ef-th ef-td-num">Crecimiento (%)</th>
				</tr>
			`);

			chart_data.forEach(row => {
				const diff = row.current_year - row.previous_year;
				const diff_color = diff >= 0 ? "var(--ef-success)" : "var(--ef-danger)";
				const diff_prefix = diff >= 0 ? "+" : "";
				const growth_prefix_row = row.growth >= 0 ? "+" : "";

				$tbody.append(`
					<tr>
						<td class="ef-td" style="font-weight:700;">${row.month_name}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; color:var(--ef-text-muted);">${_fmtCurrency(row.previous_year, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700;">${_fmtCurrency(row.current_year, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; color:${diff_color}; font-weight:600;">${diff_prefix}${_fmtCurrency(diff, "GTQ")}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; color:${diff_color}; font-weight:700;">${growth_prefix_row}${row.growth}%</td>
					</tr>
				`);
			});

		} else if (report_id === "utility_analysis") {
			const rows = data.rows || [];
			const sum = data.summary || {};
			const cur = sum.currency || "GTQ";
			const basisLabels = {
				estandar: "Costo Estándar", ponderado: "Promedio Ponderado", ultima_compra: "Último Precio de Compra"
			};
			const utilProm = sum.util_pct_promedio || 0;
			const utilPromColor = utilProm >= 0 ? "var(--ef-success)" : "var(--ef-danger)";

			$kpis.append(`
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-primary); cursor: default;">
					<div class="ef-stat-label">Productos Analizados</div>
					<div class="ef-stat-value">${sum.count || 0} ítems</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid ${utilPromColor}; cursor: default;">
					<div class="ef-stat-label">Utilidad % Promedio (${basisLabels[sum.cost_basis] || ""})</div>
					<div class="ef-stat-value" style="color:${utilPromColor}; font-family:monospace;">${_fmt(utilProm)}%</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-danger); cursor: default;">
					<div class="ef-stat-label">Con Utilidad Negativa</div>
					<div class="ef-stat-value" style="color: var(--ef-danger);">${sum.con_utilidad_negativa || 0} ítems</div>
				</div>
				<div class="ef-stat-card" style="border-left: 4px solid var(--ef-text-muted); cursor: default;">
					<div class="ef-stat-label">Lista de Precios · IVA</div>
					<div class="ef-stat-value" style="font-size:13px;">${_esc(sum.price_list || "")} · ${_fmt(sum.iva_rate || 0)}%${sum.iva_inclusive ? " (incl.)" : ""}</div>
				</div>
			`);

			if (rows.length === 0) {
				$empty.show();
				return;
			}

			$thead.append(`
				<tr>
					<th class="ef-th">Código</th>
					<th class="ef-th">Nombre</th>
					<th class="ef-th">Grupo</th>
					<th class="ef-th ef-td-num">Precio Neto</th>
					<th class="ef-th ef-td-num">Precio c/IVA</th>
					<th class="ef-th ef-td-num">Costo (${basisLabels[sum.cost_basis] || "base"})</th>
					<th class="ef-th ef-td-num">Utilidad Q</th>
					<th class="ef-th ef-td-num">Utilidad %</th>
				</tr>
			`);

			rows.forEach(r => {
				const negativo = r.precio_neto > 0 && r.utilidad_q < 0;
				const sinCosto = !(r.costo > 0);
				const utilColor = negativo ? "var(--ef-danger)" : "var(--ef-success)";
				$tbody.append(`
					<tr${negativo ? ' style="background:#fff5f5;"' : ''}>
						<td class="ef-td" style="font-weight:600;">${_esc(r.item_code)}</td>
						<td class="ef-td">${_esc(r.item_name)}</td>
						<td class="ef-td">${_esc(r.item_group)}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(r.precio_neto, cur)}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; color:var(--ef-text-muted);">${_fmtCurrency(r.precio_con_iva, cur)}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace;">${sinCosto ? '<span style="color:var(--ef-warning);">sin costo</span>' : _fmtCurrency(r.costo, cur)}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700; color:${utilColor};">${sinCosto ? "—" : _fmtCurrency(r.utilidad_q, cur)}</td>
						<td class="ef-td ef-td-num" style="font-family:monospace; font-weight:700; color:${utilColor};">${sinCosto ? "—" : _fmt(r.utilidad_pct) + "%"}</td>
					</tr>
				`);
			});
		}

		$tbody.off("click", ".ef-inv-load-link").on("click", ".ef-inv-load-link", (e) => {
			const inv_name = $(e.currentTarget).data("name");
			this._switch_view("billing");
			this._load_invoice_with_dirty_check(inv_name);
		});
	}

	_render_svg_growth_chart(chart_data, year, prev_year, month_name = "", prev_month_name = "") {
		const $container = this.$body.find("#ef-report-chart-container");
		$container.empty();

		if (!chart_data || chart_data.length === 0) {
			$container.html('<div style="text-align:center; color:var(--ef-text-muted); font-size:12px; padding:20px;">Sin datos para graficar</div>');
			return;
		}

		let maxVal = 0.0;
		chart_data.forEach(m => {
			if (m.current_year > maxVal) maxVal = m.current_year;
			if (m.previous_year > maxVal) maxVal = m.previous_year;
		});

		maxVal = maxVal > 0 ? maxVal * 1.15 : 10000.0;

		const svgWidth = 850;
		const svgHeight = 280;
		const paddingLeft = 75;
		const paddingRight = 40;
		const paddingTop = 40;
		const paddingBottom = 40;

		const plotWidth = svgWidth - paddingLeft - paddingRight;
		const plotHeight = svgHeight - paddingTop - paddingBottom;
		const xSpacing = plotWidth / (chart_data.length - 1 || 1);

		const currentPoints = [];
		const prevPoints = [];

		chart_data.forEach((m, idx) => {
			const cx = paddingLeft + idx * xSpacing;
			const cyCurr = paddingTop + plotHeight * (1.0 - (m.current_year / maxVal));
			const cyPrev = paddingTop + plotHeight * (1.0 - (m.previous_year / maxVal));

			currentPoints.push({ x: cx, y: cyCurr, data: m });
			prevPoints.push({ x: cx, y: cyPrev, data: m });
		});

		let svg = `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" height="100%" style="overflow:visible; font-family:var(--ef-font); font-size:10px;">`;

		svg += `
			<defs>
				<linearGradient id="glowCurrent" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="var(--ef-primary)" stop-opacity="0.15"/>
					<stop offset="100%" stop-color="var(--ef-primary)" stop-opacity="0.0"/>
				</linearGradient>
				<filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
					<drop-shadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.15"/>
				</filter>
			</defs>
		`;

		const gridSteps = 4;
		for (let g = 0; g <= gridSteps; g++) {
			const lineY = paddingTop + (plotHeight / gridSteps) * g;
			const gridVal = maxVal * (1.0 - (g / gridSteps));

			svg += `
				<line x1="${paddingLeft}" y1="${lineY}" x2="${svgWidth - paddingRight}" y2="${lineY}" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="2, 4"/>
				<text x="${paddingLeft - 10}" y="${lineY + 3}" fill="var(--ef-text-muted)" text-anchor="end" font-family="monospace">${_fmtCurrency(gridVal, "GTQ")}</text>
			`;
		}

		chart_data.forEach((m, idx) => {
			const cx = paddingLeft + idx * xSpacing;
			const isLabelVisible = chart_data.length <= 12 || (idx % 5 === 0) || (idx === chart_data.length - 1);
			const labelText = isLabelVisible ? m.month_name.replace("Día ", "") : "";
			svg += `
				<line class="ef-chart-guide" id="ef-chart-guide-${idx}" x1="${cx}" y1="${paddingTop}" x2="${cx}" y2="${svgHeight - paddingBottom}" stroke="#cbd5e1" stroke-width="1.5" stroke-dasharray="3, 3" style="display:none;"/>
				${isLabelVisible ? `<text x="${cx}" y="${svgHeight - paddingBottom + 16}" fill="var(--ef-text-muted)" text-anchor="middle" font-weight="600">${labelText}</text>` : ''}
			`;
		});

		let areaPath = `M ${currentPoints[0].x} ${svgHeight - paddingBottom} `;
		currentPoints.forEach(pt => {
			areaPath += `L ${pt.x} ${pt.y} `;
		});
		areaPath += `L ${currentPoints[currentPoints.length - 1].x} ${svgHeight - paddingBottom} Z`;

		svg += `<path d="${areaPath}" fill="url(#glowCurrent)" />`;

		let prevPath = "";
		prevPoints.forEach((pt, idx) => {
			prevPath += `${idx === 0 ? "M" : "L"} ${pt.x} ${pt.y} `;
		});
		svg += `<path d="${prevPath}" fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-dasharray="4, 4" />`;

		let currPath = "";
		currentPoints.forEach((pt, idx) => {
			currPath += `${idx === 0 ? "M" : "L"} ${pt.x} ${pt.y} `;
		});
		svg += `<path d="${currPath}" fill="none" stroke="var(--ef-primary)" stroke-width="3" filter="url(#shadow)" />`;

		currentPoints.forEach((pt, idx) => {
			const ptPrev = prevPoints[idx];

			svg += `
				<circle id="ef-pt-prev-${idx}" cx="${ptPrev.x}" cy="${ptPrev.y}" r="4.5" fill="#ffffff" stroke="#94a3b8" stroke-width="2.5" style="transition: r 0.15s ease;"/>
			`;

			svg += `
				<circle id="ef-pt-curr-${idx}" cx="${pt.x}" cy="${pt.y}" r="5" fill="#ffffff" stroke="var(--ef-primary)" stroke-width="3" style="transition: r 0.15s ease;"/>
			`;

			svg += `
				<rect class="ef-chart-hover-zone" data-idx="${idx}" x="${pt.x - xSpacing / 2}" y="${paddingTop}" width="${xSpacing}" height="${plotHeight}" fill="transparent" style="cursor:crosshair;"/>
			`;
		});

		svg += `</svg>`;

		const currentLabel = month_name ? `${month_name} ${year}` : `Año Actual (${year})`;
		const prevLabel = prev_month_name ? `${prev_month_name} ${prev_year}` : `Año Anterior (${prev_year})`;

		const legend = `
			<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; font-size:11px;">
				<div style="display:flex; gap:16px;">
					<span style="display:flex; align-items:center; gap:6px;">
						<span style="width:12px; height:3px; background:var(--ef-primary); display:inline-block; border-radius:2px;"></span>
						<strong style="color:var(--ef-text);">${currentLabel}</strong>
					</span>
					<span style="display:flex; align-items:center; gap:6px;">
						<span style="width:12px; height:3px; border-top:3px dashed #94a3b8; display:inline-block;"></span>
						<strong style="color:var(--ef-text-muted);">${prevLabel}</strong>
					</span>
				</div>
				<div id="ef-chart-tooltip" style="opacity:0; pointer-events:none; transition:opacity 0.15s ease; background:#1e293b; color:#ffffff; padding:8px 12px; border-radius:6px; font-size:11px; box-shadow:var(--ef-shadow-lg); font-family:var(--ef-font);">
				</div>
			</div>
		`;

		$container.append(legend);
		$container.append(svg);

		const $tooltip = this.$body.find("#ef-chart-tooltip");
		const $zones = this.$body.find(".ef-chart-hover-zone");

		$zones.on("mouseenter", (e) => {
			const idx = $(e.currentTarget).data("idx");
			const m = chart_data[idx];

			this.$body.find(`#ef-chart-guide-${idx}`).show();

			this.$body.find(`#ef-pt-prev-${idx}`).attr("r", "7.5");
			this.$body.find(`#ef-pt-curr-${idx}`).attr("r", "8");

			const changeSymbol = m.growth >= 0 ? "▲" : "▼";
			const changeColor = m.growth >= 0 ? "#2dc653" : "#e63946";

			$tooltip.html(`
				<div style="font-weight:700; margin-bottom:4px; border-bottom:1px solid #475569; padding-bottom:3px; text-transform:uppercase;">${m.month_name}</div>
				<div>${month_name || year}: <span style="font-family:monospace; font-weight:700; color:#4cc9f0;">${_fmtCurrency(m.current_year, "GTQ")}</span></div>
				<div>${prev_month_name || prev_year}: <span style="font-family:monospace; color:#cbd5e1;">${_fmtCurrency(m.previous_year, "GTQ")}</span></div>
				<div style="margin-top:4px; font-weight:600; color:${changeColor};">${changeSymbol} Variación: ${m.growth}%</div>
			`);
			$tooltip.css("opacity", "1");
		});

		$zones.on("mouseleave", (e) => {
			const idx = $(e.currentTarget).data("idx");

			this.$body.find(`#ef-chart-guide-${idx}`).hide();

			this.$body.find(`#ef-pt-prev-${idx}`).attr("r", "4.5");
			this.$body.find(`#ef-pt-curr-${idx}`).attr("r", "5");

			$tooltip.css("opacity", "0");
		});
	}

	_print_report_pdf() {
		const report_id = this._last_report_id;
		const data = this._last_report_data;

		if (!report_id || !data) return;

		let title = "";
		let htmlContent = "";

		if (report_id === "customer_statement") {
			title = "Estado de Cuenta Clientes";
			const sum = data.summary || {};
			const ledger = data.ledger || [];

			htmlContent = `
				<div class="print-header">
					<h2>Estado de Cuenta de Clientes</h2>
					<div class="meta-info">
						<div><strong>Cliente:</strong> ${sum.customer_name || ""}</div>
						<div><strong>Fecha Emisión:</strong> ${frappe.datetime.get_today()}</div>
						<div><strong>Compañía:</strong> ${this.doc.company || this.defaults.company || ""}</div>
					</div>
				</div>
				<div class="kpis">
					<div class="kpi-card">
						<div class="label">Total Cargo (Facturado)</div>
						<div class="value">${_fmtCurrency(sum.total_invoiced, "GTQ")}</div>
					</div>
					<div class="kpi-card">
						<div class="label">Total Abono (Pagado)</div>
						<div class="value">${_fmtCurrency(sum.total_paid, "GTQ")}</div>
					</div>
					<div class="kpi-card">
						<div class="label">Saldo Pendiente</div>
						<div class="value" style="color: #f8961e;">${_fmtCurrency(sum.outstanding_balance, "GTQ")}</div>
					</div>
					<div class="kpi-card">
						<div class="label">Límite de Crédito</div>
						<div class="value">${_fmtCurrency(sum.credit_limit, "GTQ")}</div>
					</div>
				</div>
				<table>
					<thead>
						<tr>
							<th>Factura</th>
							<th>Serie - No</th>
							<th>Fecha Emisión</th>
							<th>Fecha Vencimiento</th>
							<th>Tipo</th>
							<th class="num">Monto Cargo</th>
							<th class="num">Monto Abono</th>
							<th class="num">Saldo Restante</th>
							<th>Estado</th>
						</tr>
					</thead>
					<tbody>
						${ledger.map(row => `
							<tr>
								<td>${row.name}</td>
								<td>${row.serie_no || "—"}</td>
								<td>${row.posting_date}</td>
								<td>${row.due_date || "—"}</td>
								<td>${row.doc_type_desc || "Factura"}</td>
								<td class="num">${_fmtCurrency(row.grand_total, "GTQ")}</td>
								<td class="num" style="color: #2dc653;">${_fmtCurrency(row.paid_amount, "GTQ")}</td>
								<td class="num" style="font-weight: bold; color: ${row.balance > 0 ? "#f8961e" : "#2dc653"};">${_fmtCurrency(row.balance, "GTQ")}</td>
								<td>${row.status}</td>
							</tr>
						`).join("")}
					</tbody>
				</table>
			`;
		} else if (report_id === "aging_receivables") {
			title = "Antigüedad de Saldos";
			const sum = data.summary || {};
			const aging = data.aging || [];

			htmlContent = `
				<div class="print-header">
					<h2>Reporte de Antigüedad de Saldos (Aging)</h2>
					<div class="meta-info">
						<div><strong>Fecha Emisión:</strong> ${frappe.datetime.get_today()}</div>
						<div><strong>Compañía:</strong> ${this.doc.company || this.defaults.company || ""}</div>
					</div>
				</div>
				<div class="kpis">
					<div class="kpi-card">
						<div class="label">Total Cartera Vencida</div>
						<div class="value" style="color: #e63946;">${_fmtCurrency(sum.total_outstanding, "GTQ")}</div>
					</div>
					<div class="kpi-card">
						<div class="label">Corriente (0-30 días)</div>
						<div class="value">${_fmtCurrency(sum.total_0_30, "GTQ")}</div>
					</div>
					<div class="kpi-card">
						<div class="label">Vencido (31-60 días)</div>
						<div class="value">${_fmtCurrency(sum.total_31_60, "GTQ")}</div>
					</div>
					<div class="kpi-card">
						<div class="label">Vencido Crítico (61+ días)</div>
						<div class="value" style="color: #7209b7;">${_fmtCurrency(sum.total_61_90 + sum.total_91_plus, "GTQ")}</div>
					</div>
				</div>
				
				${aging.map(row => `
					<div style="margin-top: 25px; border-bottom: 2px solid #cbd5e1; padding-bottom: 5px; page-break-inside: avoid;">
						<div style="display: flex; justify-content: space-between; align-items: center;">
							<h3 style="margin: 0; color: #1e293b;">${row.customer_name}</h3>
							<span style="font-weight: bold; color: #e63946; font-size: 14px;">Total Saldo: ${_fmtCurrency(row.total_outstanding, "GTQ")}</span>
						</div>
						<div style="display: flex; gap: 20px; font-size: 11px; margin-top: 5px; color: #64748b;">
							<div><strong>0-30 días:</strong> ${_fmtCurrency(row.range_0_30, "GTQ")}</div>
							<div><strong>31-60 días:</strong> ${_fmtCurrency(row.range_31_60, "GTQ")}</div>
							<div><strong>61-90 días:</strong> ${_fmtCurrency(row.range_61_90, "GTQ")}</div>
							<div><strong>91+ días:</strong> ${_fmtCurrency(row.range_91_plus, "GTQ")}</div>
						</div>
					</div>
					<table style="margin-top: 8px; margin-bottom: 15px; font-size: 11px; page-break-inside: avoid;">
						<thead>
							<tr style="background: #f8fafc;">
								<th>Factura</th>
								<th>Serie - No</th>
								<th>Fecha Contabilización</th>
								<th>Fecha Vencimiento</th>
								<th class="num">Días Mora</th>
								<th class="num">Original</th>
								<th class="num">Saldo</th>
								<th>Rango</th>
							</tr>
						</thead>
						<tbody>
							${(row.invoices || []).map(inv => `
								<tr>
									<td>${inv.name}</td>
									<td>${inv.serie_no || "—"}</td>
									<td>${inv.posting_date}</td>
									<td>${inv.due_date || "—"}</td>
									<td class="num" style="font-weight: bold; color: ${inv.days_due > 0 ? "#e63946" : "#64748b"};">${inv.days_due}</td>
									<td class="num">${_fmtCurrency(inv.grand_total, "GTQ")}</td>
									<td class="num" style="font-weight: bold; color: #e63946;">${_fmtCurrency(inv.outstanding_amount, "GTQ")}</td>
									<td>${inv.bucket}</td>
								</tr>
							`).join("")}
						</tbody>
					</table>
				`).join("")}
			`;
		}

		const printWindow = window.open("", "_blank");
		printWindow.document.write(`
			<html>
				<head>
					<title>${title}</title>
					<style>
						body {
							font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
							color: #1e293b;
							margin: 30px;
							font-size: 12px;
							line-height: 1.4;
						}
						.print-header {
							border-bottom: 2px solid #1e293b;
							padding-bottom: 15px;
							margin-bottom: 20px;
						}
						.print-header h2 {
							margin: 0;
							color: #153375;
							font-size: 22px;
						}
						.meta-info {
							display: flex;
							justify-content: space-between;
							margin-top: 10px;
							font-size: 11px;
							color: #64748b;
						}
						.kpis {
							display: grid;
							grid-template-columns: repeat(4, 1fr);
							gap: 15px;
							margin-bottom: 25px;
						}
						.kpi-card {
							border: 1px solid #e2e8f0;
							border-radius: 8px;
							padding: 12px;
							background: #f8fafc;
						}
						.kpi-card .label {
							font-size: 10px;
							color: #64748b;
							text-transform: uppercase;
							margin-bottom: 4px;
							font-weight: 600;
						}
						.kpi-card .value {
							font-size: 16px;
							font-weight: bold;
							font-family: monospace;
						}
						table {
							width: 100%;
							border-collapse: collapse;
							margin-top: 15px;
						}
						th, td {
							border: 1px solid #e2e8f0;
							padding: 8px 10px;
							text-align: left;
						}
						th {
							background: #f1f5f9;
							font-weight: 600;
							font-size: 11px;
						}
						.num {
							text-align: right;
							font-family: monospace;
						}
						@media print {
							body { margin: 15px; }
							@page { margin: 1.5cm; }
						}
					</style>
				</head>
				<body>
					${htmlContent}
					<script>
						window.onload = function() {
							setTimeout(function() {
								window.print();
							}, 250);
						}
					</script>
				</body>
			</html>
		`);
		printWindow.document.close();
	}

	_export_report_csv() {
		const report_id = this._last_report_id;
		const data = this._last_report_data;

		if (!report_id || !data) return;

		let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
		let filename = `${report_id}_export.csv`;

		if (report_id === "sales_by_date") {
			csvContent += "Factura,Fecha,Cliente,Subtotal,Impuestos,Total,Saldo Pendiente\n";
			(data.invoices || []).forEach(inv => {
				csvContent += `"${inv.name}","${inv.posting_date}","${inv.customer_name || inv.customer}",${inv.total},${inv.total_taxes_and_charges},${inv.grand_total},${inv.outstanding_amount}\n`;
			});
		} else if (report_id === "sales_by_product") {
			csvContent += "Codigo Item,Descripcion,Cantidad,Precio Promedio,Importe Total\n";
			(data.products || []).forEach(p => {
				csvContent += `"${p.item_code}","${p.item_name}",${p.total_qty},${p.avg_rate},${p.total_amount}\n`;
			});
		} else if (report_id === "cancelled_invoices") {
			csvContent += "Factura,Fecha,Cliente,Monto Anulado,Cancelado por,Fecha Cancelacion\n";
			(data.invoices || []).forEach(inv => {
				csvContent += `"${inv.name}","${inv.posting_date}","${inv.customer_name || inv.customer}",${inv.grand_total},"${inv.modified_by}","${inv.modified}"\n`;
			});
		} else if (report_id === "customer_statement") {
			csvContent += `Estado de Cuenta - ${data.summary ? data.summary.customer_name : ''}\n`;
			csvContent += "Factura,Fecha Emision,Cargo (Facturado),Abono (Pagado),Saldo Restante,Estado\n";
			(data.ledger || []).forEach(row => {
				csvContent += `"${row.name}","${row.posting_date}",${row.grand_total},${row.paid_amount},${row.balance},"${row.status}"\n`;
			});
		} else if (report_id === "aging_receivables") {
			csvContent += "Cliente,Saldo Vencido,0-30 dias,31-60 dias,61-90 dias,91+ dias\n";
			(data.aging || []).forEach(row => {
				csvContent += `"${row.customer_name}",${row.total_outstanding},${row.range_0_30},${row.range_31_60},${row.range_61_90},${row.range_91_plus}\n`;
			});
		} else if (report_id === "quotations_report") {
			csvContent += "Cotizacion,Fecha,Cliente,Monto Cotizado,Estado FEL\n";
			(data.invoices || []).forEach(inv => {
				csvContent += `"${inv.name}","${inv.posting_date}","${inv.customer_name || inv.customer}",${inv.grand_total},"${inv.bfel_status}"\n`;
			});
		} else if (report_id === "payments_report") {
			csvContent += "Fecha Pago,Factura,Cliente,Metodo,Referencia,Monto\n";
			(data.payments || []).forEach(pay => {
				csvContent += `"${pay.payment_date}","${pay.invoice}","${pay.customer_name || pay.customer}","${pay.payment_method}","${pay.reference || ''}",${pay.amount}\n`;
			});
		} else if (report_id === "uncertified_invoices") {
			csvContent += "Factura,Fecha,Cliente,Monto,Error FEL\n";
			(data.invoices || []).forEach(inv => {
				const sanitizedError = (inv.bfel_error_log || "").replace(/"/g, '""');
				csvContent += `"${inv.name}","${inv.posting_date}","${inv.customer_name || inv.customer}",${inv.grand_total},"${sanitizedError}"\n`;
			});
		} else if (report_id === "sales_growth_analysis") {
			csvContent += `Crecimiento de Ventas - ${data.year} vs ${data.prev_year}\n`;
			csvContent += "Mes,Ventas Año Anterior,Ventas Año Actual,Crecimiento (%)\n";
			(data.chart_data || []).forEach(m => {
				csvContent += `"${m.month_name}",${m.previous_year},${m.current_year},${m.growth}\n`;
			});
		} else if (report_id === "utility_analysis") {
			csvContent += "Codigo,Nombre,Grupo,Precio Neto,Precio c/IVA,Costo Estandar,Costo Prom Ponderado,Ultimo Precio Compra,Costo Usado,Utilidad Q,Utilidad %,Margen s/Precio %\n";
			(data.rows || []).forEach(r => {
				csvContent += `"${r.item_code}","${(r.item_name || '').replace(/"/g, '""')}","${r.item_group}",${r.precio_neto},${r.precio_con_iva},${r.costo_estandar},${r.costo_ponderado},${r.costo_ultima_compra},${r.costo},${r.utilidad_q},${r.utilidad_pct.toFixed(2)},${r.margen_sobre_precio_pct.toFixed(2)}\n`;
			});
		} else {
			return;
		}

		const encodedUri = encodeURI(csvContent);
		const link = document.createElement("a");
		link.setAttribute("href", encodedUri);
		link.setAttribute("download", filename);
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	}

	_load_invoice_payment_receipt_details(inv_name) {
		if (!inv_name) return;

		frappe.db.get_value("Sales Invoice", inv_name, ["company", "customer_name", "grand_total", "outstanding_amount", "custom_pagado"], (res) => {
			if (!res) {
				frappe.show_alert({ message: __("Factura no encontrada"), indicator: "red" });
				this.$body.find("#ef-print-receipt-details").hide();
				return;
			}

			this.$body.find("#ef-receipt-cust-name").text(res.customer_name || "");
			this.$body.find("#ef-receipt-grand-total").text(_fmtCurrency(res.grand_total, "GTQ"));

			frappe.call({
				method: "frappe.client.get_list",
				args: {
					doctype: "eFast Invoice Payment",
					filters: { parent: inv_name },
					fields: ["payment_method", "payment_date", "reference", "amount"],
					order_by: "payment_date desc"
				},
				callback: (payRes) => {
					const payments = payRes.message || [];
					const totalPaid = payments.reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0.0);
					// Usar outstanding_amount (no grand_total): refleja el redondeo aplicado por ERPNext
					const balance = Math.max(0.0, parseFloat(res.outstanding_amount || 0) - totalPaid);

					this.$body.find("#ef-receipt-total-paid").text(_fmtCurrency(totalPaid, "GTQ"));
					this.$body.find("#ef-receipt-balance").text(_fmtCurrency(balance, "GTQ"));

					const $tbody = this.$body.find("#ef-receipt-payments-tbody");
					$tbody.empty();

					if (payments.length === 0) {
						$tbody.append('<tr><td colspan="3" style="text-align:center; color:var(--ef-text-muted);">Sin abonos registrados</td></tr>');
					} else {
						payments.forEach(p => {
							$tbody.append(`
								<tr>
									<td style="padding: 4px 8px; font-weight:600;">${p.payment_method}</td>
									<td style="padding: 4px 8px; color:var(--ef-text-muted);">${p.payment_date}</td>
									<td style="padding: 4px 8px; text-align:right; font-family:monospace; font-weight:700;">${_fmtCurrency(p.amount, "GTQ")}</td>
								</tr>
							`);
						});
					}

					this.$body.find("#ef-btn-print-receipt-format").off("click").on("click", () => {
						this._print_payment_receipt(inv_name, res.company);
					});

					this.$body.find("#ef-print-receipt-details").show();
				}
			});
		});
	}

	_print_payment_receipt(inv_name, company) {
		// Usar SIEMPRE la compañía real de la factura (pasada por el llamador o
		// resuelta aquí), no la compañía activa de sesión/editor: imprimir con el
		// formato de otra compañía mezclaría membretes/datos fiscales equivocados.
		frappe.call({
			method: "facex_multi.api.invoice.get_print_formats",
			args: { company: company || this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				const formats = r.message || [];
				const defaultFormat = formats.find(f => f.toUpperCase().includes("RECI")) || "Recibo de Pago FacEx";
				const url = `/printview?doctype=Sales+Invoice&name=${encodeURIComponent(inv_name)}&format=${encodeURIComponent(defaultFormat)}`;
				window.open(url, "_blank");
			}
		});
	}

	/* ── Maintenance Section ────────────────────────────────────────── */

	_setup_maintenance() {
		if (!this.maint_cust_price_list_ctrl) {
			const get_query_fn = () => {
				const comp = this.doc.company || this.defaults.company || "";
				return {
					or_filters: [
						["bfel_company", "=", comp],
						["bfel_company_null", "=", 0],
					],
				};
			};
			this.maint_cust_price_list_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-maint-cust-price-list-ctrl")[0],
				df: {
					only_select: 1,
					label: "Lista de precios",
					fieldtype: "Link",
					fieldname: "default_price_list",
					options: "Price List",
					reqd: 0,
					only_input: 1,
					get_query: get_query_fn
				},
				render_input: true,
				only_input: false,
			});
			this.maint_cust_price_list_ctrl.get_query = get_query_fn;
			this.maint_cust_price_list_ctrl.refresh();
		}

		if (!this.maint_cust_payment_terms_ctrl) {
			this.maint_cust_payment_terms_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-maint-cust-payment-terms-ctrl")[0],
				df: {
					only_select: 1,
					label: "Condiciones de pago",
					fieldtype: "Link",
					fieldname: "payment_terms",
					options: "Payment Terms Template",
					reqd: 0,
				},
				render_input: true,
				only_input: false,
			});
			this.maint_cust_payment_terms_ctrl.refresh();
		}

		if (!this.maint_cust_sales_partner_ctrl) {
			this.maint_cust_sales_partner_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-maint-cust-sales-partner-ctrl")[0],
				df: {
					only_select: 1,
					label: "Vendedor",
					fieldtype: "Link",
					fieldname: "default_sales_partner",
					options: "Sales Partner",
					reqd: 0,
				},
				render_input: true,
				only_input: false,
			});
			this.maint_cust_sales_partner_ctrl.refresh();
		}

		if (!this.maint_cust_group_ctrl) {
			this.maint_cust_group_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-maint-cust-group-ctrl")[0],
				df: {
					only_select: 1,
					label: "Grupo de cliente",
					fieldtype: "Link",
					fieldname: "customer_group",
					options: "Customer Group",
					reqd: 0,
				},
				render_input: true,
				only_input: false,
			});
			this.maint_cust_group_ctrl.refresh();
		}

		if (!this.maint_item_uom_ctrl) {
			this.maint_item_uom_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-maint-item-uom-ctrl")[0],
				df: {
					only_select: 1,
					label: "UOM",
					fieldtype: "Link",
					fieldname: "stock_uom",
					options: "UOM",
					reqd: 1,
				},
				render_input: true,
				only_input: false,
			});
			this.maint_item_uom_ctrl.refresh();
		}

		if (!this.maint_item_group_ctrl) {
			const get_query_fn = () => {
				const comp = this.doc.company || this.defaults.company || "";
				return {
					or_filters: [
						["bfel_company", "=", comp],
						["bfel_company_null", "=", 0],
					],
				};
			};
			this.maint_item_group_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-maint-item-group-ctrl")[0],
				df: {
					only_select: 1,
					label: "Grupo de artículos",
					fieldtype: "Link",
					fieldname: "item_group",
					options: "Item Group",
					reqd: 0,
					only_input: 1,
					get_query: get_query_fn
				},
				render_input: true,
				only_input: false,
			});
			this.maint_item_group_ctrl.get_query = get_query_fn;
			this.maint_item_group_ctrl.refresh();
		}

		// ── Asignación de Precios: controles de filtro ──
		if (!this.ap_supplier_ctrl) {
			this.ap_supplier_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-ap-supplier-ctrl")[0],
				df: { only_select: 1, label: "Proveedor", fieldtype: "Link", fieldname: "ap_supplier", options: "Supplier", reqd: 0 },
				render_input: true, only_input: false,
			});
			this.ap_supplier_ctrl.refresh();
		}
		if (!this.ap_group_ctrl) {
			const gq = () => {
				const comp = this.doc.company || this.defaults.company || "";
				return { or_filters: [["bfel_company", "=", comp], ["bfel_company_null", "=", 0]] };
			};
			this.ap_group_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-ap-group-ctrl")[0],
				df: { only_select: 1, label: "Grupo de artículos", fieldtype: "Link", fieldname: "ap_group", options: "Item Group", reqd: 0, get_query: gq },
				render_input: true, only_input: false,
			});
			this.ap_group_ctrl.get_query = gq;
			this.ap_group_ctrl.refresh();
		}
		if (!this.ap_item_ctrl) {
			const gq = () => {
				const comp = this.doc.company || this.defaults.company || "";
				return { or_filters: [["Item", "bfel_company", "=", comp], ["Item", "bfel_company_null", "=", 0]] };
			};
			this.ap_item_ctrl = frappe.ui.form.make_control({
				parent: this.$body.find("#ef-ap-item-ctrl")[0],
				df: { only_select: 1, label: "Ítem", fieldtype: "Link", fieldname: "ap_item", options: "Item", reqd: 0, get_query: gq },
				render_input: true, only_input: false,
			});
			this.ap_item_ctrl.get_query = gq;
			this.ap_item_ctrl.refresh();
		}

		this.$body.find("#ef-ap-btn-search").off("click").on("click", () => this._search_pricing_rows());
		this.$body.find("#ef-ap-btn-apply").off("click").on("click", () => this._apply_pricing_prices());
		this.$body.find("#ef-ap-mark-all").off("click").on("click", () => {
			this.$body.find("#ef-ap-tbody .ef-ap-row-check").prop("checked", true);
			this._update_ap_selected_count();
		});
		this.$body.find("#ef-ap-unmark-all").off("click").on("click", () => {
			this.$body.find("#ef-ap-tbody .ef-ap-row-check").prop("checked", false);
			this._update_ap_selected_count();
		});
		this.$body.find("#ef-ap-select-all").off("change").on("change", (e) => {
			this.$body.find("#ef-ap-tbody .ef-ap-row-check").prop("checked", $(e.currentTarget).prop("checked"));
			this._update_ap_selected_count();
		});
		this.$body.find("#ef-ap-apply-util").off("click").on("click", () => {
			const g = parseFloat(this.$body.find("#ef-ap-util-global").val()) || 0;
			const basis = this.$body.find("#ef-ap-cost-basis").val();
			this.$body.find("#ef-ap-tbody tr[data-item]").each((_, tr) => {
				const $tr = $(tr);
				const baseCost = parseFloat($tr.attr(`data-costo-${basis}`)) || 0;
				$tr.find(".ef-ap-cost-input").val(baseCost ? baseCost.toFixed(4) : "");
				$tr.find(".ef-ap-util-input").val(g);
				this._recalc_pricing_row($tr);
			});
		});
		this.$body.on("input", ".ef-ap-cost-input, .ef-ap-util-input", (e) => {
			this._recalc_pricing_row($(e.currentTarget).closest("tr"));
		});
		// El cambio de base de costo / redondeo re-evalúa la 'Situación actual' y los
		// precios calculados de todas las filas (sin tocar lo que el usuario ya editó).
		this.$body.on("change", "#ef-ap-round-step, #ef-ap-round-mode, #ef-ap-cost-basis", () => {
			this.$body.find("#ef-ap-tbody tr[data-item]").each((_, tr) => this._recalc_pricing_row($(tr)));
		});
		this.$body.on("change", "#ef-ap-tbody .ef-ap-row-check", () => this._update_ap_selected_count());

		// Bind automatic item code checkbox logic
		this.$body.on("change", "#ef-maint-item-auto-code", (e) => {
			const checked = $(e.currentTarget).prop("checked");
			if (checked) {
				this.$body.find("#ef-maint-item-code").val("").prop("disabled", true).attr("placeholder", "(Código Automático)");
			} else {
				this.$body.find("#ef-maint-item-code").prop("disabled", false).attr("placeholder", "Ej. PROD-001");
			}
		});

		// Gestionado por → sincronizar checkbox ¿Inventariable?
		this.$body.on("change", "#ef-maint-item-gestionado-por", (e) => {
			const val = $(e.currentTarget).val();
			const forced = val === "Serie" || val === "Lote";
			this.$body.find("#ef-maint-item-is-stock")
				.prop("checked", forced || this.$body.find("#ef-maint-item-is-stock").prop("checked"))
				.prop("disabled", forced);
			if (forced) this.$body.find("#ef-maint-item-is-stock").prop("checked", true);
		});

		// Auto-sync: descripción siempre = item_name al escribir
		this.$body.on("input", "#ef-maint-item-name", (e) => {
			this.$body.find("#ef-maint-item-desc").val($(e.target).val());
		});

		// Sub-tab switching
		this.$body.on("click", ".ef-maint-tab-btn", (e) => {
			const tab = $(e.currentTarget).data("maint-tab");
			this.$body.find(".ef-maint-tab-btn").removeClass("ef-tab-active");
			$(e.currentTarget).addClass("ef-tab-active");
			this.$body.find(".ef-maint-tab-content").hide();
			this.$body.find(`#ef-maint-tab-${tab}`).show();
			this._on_maint_tab_switch(tab);
		});

		// ── Customers (búsqueda-primero, estilo SAP) ──
		this.$body.find("#ef-maint-cust-btn-search").on("click", () => {
			this._search_maint_customers();
		});

		this.$body.find("#ef-maint-cust-search").on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this._search_maint_customers();
			}
		});

		this.$body.find("#ef-maint-cust-btn-all").on("click", () => {
			this._view_all_maint_customers();
		});

		this.$body.find("#ef-maint-cust-btn-new").on("click", () => {
			this._clear_maint_cust_form();
			this._set_maint_cust_form_mode("create");
		});

		this.$body.find("#ef-maint-cust-btn-save").on("click", () => {
			this._save_maint_customer();
		});

		this.$body.find("#ef-maint-cust-receptor").on("change", (e) => {
			this._lookup_maint_cust_name(e.target.value);
		});

		// ── Products (búsqueda-primero, estilo SAP) ──
		this.$body.find("#ef-maint-item-btn-search").on("click", () => {
			this._search_maint_items();
		});

		this.$body.find("#ef-maint-item-search").on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this._search_maint_items();
			}
		});

		this.$body.find("#ef-maint-item-btn-all").on("click", () => {
			this._view_all_maint_items();
		});

		this.$body.find("#ef-maint-item-btn-new").on("click", () => {
			this._clear_maint_item_form();
			this._set_maint_item_form_mode("create");
		});

		this.$body.find("#ef-maint-item-btn-save").on("click", () => {
			this._save_maint_item();
		});

		// ── Listas de Materiales (búsqueda-primero, estilo SAP) ──
		this.$body.find("#ef-maint-lm-btn-search").on("click", () => {
			this._search_maint_lms();
		});

		this.$body.find("#ef-maint-lm-search").on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this._search_maint_lms();
			}
		});

		this.$body.find("#ef-maint-lm-btn-all").on("click", () => {
			this._view_all_maint_lms();
		});

		this.$body.find("#ef-maint-lm-btn-new").on("click", () => {
			this._clear_maint_lm_form();
			this._set_maint_lm_form_mode("create");
		});

		this.$body.find("#ef-maint-lm-btn-save").on("click", () => {
			this._save_maint_lm();
		});

		this.$body.find("#ef-maint-lm-btn-delete").on("click", () => {
			this._delete_maint_lm();
		});

		this._setup_ac(this.$body.find("#ef-maint-lm-padre-search"), "Item", (value, description) => {
			if (this._maint_lm_form) {
				this._maint_lm_form.item_code = value;
				this._maint_lm_form.item_name = description;
			}
		});

		this._setup_ac(this.$body.find("#ef-maint-lm-comp-search"), "Item", (value, description) => {
			this._maint_lm_add_component(value, description);
			this.$body.find("#ef-maint-lm-comp-search").val("");
		});

		this.$body.on("change", "input[name='ef-maint-lm-modo']", (e) => {
			if (this._maint_lm_form) this._maint_lm_form.modo_stock = e.target.value;
		});

		this.$body.on("input", ".ef-maint-lm-qty", (e) => {
			const uid = $(e.target).closest("tr").data("row-id");
			const row = (this._maint_lm_form.items || []).find((r) => r.uid === uid);
			if (row) row.qty = $(e.target).val();
		});

		this.$body.on("click", ".ef-maint-lm-remove", (e) => {
			const uid = $(e.currentTarget).data("remove");
			this._maint_lm_form.items = (this._maint_lm_form.items || []).filter((r) => r.uid !== uid);
			this._render_maint_lm_rows();
		});

		// ── Artículos en Par / Alternativos ──
		this._setup_ac(this.$body.find("#ef-maint-item-par-search"), "Item", (value) => {
			this._maint_add_relation("Par", value);
			this.$body.find("#ef-maint-item-par-search").val("");
		});

		this._setup_ac(this.$body.find("#ef-maint-item-alt-search"), "Item", (value) => {
			this._maint_add_relation("Alternativo", value);
			this.$body.find("#ef-maint-item-alt-search").val("");
		});

		this.$body.on("click", ".ef-maint-relation-remove", (e) => {
			this._maint_remove_relation($(e.currentTarget).data("remove"));
		});

		// ── Prices ──
		let priceTimer = null;
		this.$body.find(".ef-maint-prices-filter").on("input", () => {
			clearTimeout(priceTimer);
			priceTimer = setTimeout(() => {
				this._load_maint_prices();
			}, 250);
		});

		this.$body.find("#ef-maint-price-list-select").on("change", () => {
			this._load_maint_prices();
		});

		this.$body.find("#ef-maint-prices-select-all").on("change", (e) => {
			const checked = $(e.target).prop("checked");
			this.$body.find(".ef-price-chk").prop("checked", checked);
			this._update_maint_prices_selected_count();
		});

		this.$body.find("#ef-maint-prices-btn-mark-all").on("click", () => {
			this.$body.find(".ef-price-chk, #ef-maint-prices-select-all").prop("checked", true);
			this._update_maint_prices_selected_count();
		});

		this.$body.find("#ef-maint-prices-btn-unmark-all").on("click", () => {
			this.$body.find(".ef-price-chk, #ef-maint-prices-select-all").prop("checked", false);
			this._update_maint_prices_selected_count();
		});

		this.$body.find("#ef-maint-prices-btn-export").on("click", () => {
			const names = this.$body.find(".ef-price-chk:checked").map((_, el) => $(el).data("code")).get();
			if (!names.length) {
				frappe.show_alert({ message: "Seleccione al menos un producto para exportar.", indicator: "orange" });
				return;
			}
			this._export_maint_prices_excel(names);
		});

		this.$body.find("#ef-maint-cust-btn-delete").on("click", () => {
			this._delete_maint_customer();
		});

		this.$body.find("#ef-maint-item-btn-delete").on("click", () => {
			this._delete_maint_item();
		});

		this.$body.find("#ef-maint-item-btn-print-label").on("click", () => {
			this._imprimir_etiqueta_maint_item();
		});

		// ── Suppliers (búsqueda-primero, estilo SAP) ──
		this.$body.find("#ef-maint-supp-btn-search").on("click", () => {
			this._search_maint_suppliers();
		});

		this.$body.find("#ef-maint-supp-search").on("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this._search_maint_suppliers();
			}
		});

		this.$body.find("#ef-maint-supp-btn-all").on("click", () => {
			this._view_all_maint_suppliers();
		});

		this.$body.find("#ef-maint-supp-btn-new").on("click", () => {
			this._clear_maint_supp_form();
			this._set_maint_supp_form_mode("create");
		});

		this.$body.find("#ef-maint-supp-btn-save").on("click", () => {
			this._save_maint_supplier();
		});

		this.$body.find("#ef-maint-supp-btn-delete").on("click", () => {
			this._delete_maint_supplier();
		});
	}

	_load_maintenance_view() {
		// Default tab is Clientes
		this.$body.find(".ef-maint-tab-btn").removeClass("ef-tab-active");
		this.$body.find('.ef-maint-tab-btn[data-maint-tab="clientes"]').addClass("ef-tab-active");
		this.$body.find(".ef-maint-tab-content").hide();
		this.$body.find("#ef-maint-tab-clientes").show();
		this._on_maint_tab_switch("clientes");
	}

	_on_maint_tab_switch(tab) {
		if (tab === "clientes") {
			this._clear_maint_cust_form();
			this._set_maint_cust_form_mode("search");
		} else if (tab === "productos") {
			this._clear_maint_item_form();
			this._set_maint_item_form_mode("search");
		} else if (tab === "listas-materiales") {
			this._clear_maint_lm_form();
			this._set_maint_lm_form_mode("search");
		} else if (tab === "precios") {
			this._load_price_lists_dropdown_then_load_prices();
		} else if (tab === "asignacion-precios") {
			this._load_pricing_assignment();
		} else if (tab === "proveedores") {
			this._clear_maint_supp_form();
			this._set_maint_supp_form_mode("search");
		}
	}

	// ── Price Lists Dropdown ──

	_load_price_lists_dropdown_then_load_prices() {
		const $select = this.$body.find("#ef-maint-price-list-select");
		$select.empty().append('<option value="">Cargando listas...</option>');

		frappe.call({
			method: "facex_multi.api.item.get_price_lists",
			args: { company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				$select.empty();
				const lists = r.message || [];
				if (lists.length === 0) {
					$select.append('<option value="">Sin listas activas</option>');
					return;
				}
				lists.forEach((list) => {
					// We prioritize Selling price lists or show both
					const label = `${list.name} (${list.currency})`;
					$select.append(`<option value="${_esc(list.name)}">${_esc(label)}</option>`);
				});

				// Auto-select defaults
				const defaultList = this.defaults.default_price_list || "Standard Selling";
				if ($select.find(`option[value="${defaultList}"]`).length) {
					$select.val(defaultList);
				} else if (lists.length > 0) {
					$select.val(lists[0].name);
				}

				this._load_maint_prices();
			}
		});
	}

	// ── Asignación de Precios por Utilidad ──

	_ap_company() {
		return this.doc.company || this.defaults.company || "";
	}

	// Redondeo del precio con IVA — espejo de facex_multi.api.utilidad._round_price
	_ap_round_price(value) {
		const step = parseFloat(this.$body.find("#ef-ap-round-step").val()) || 0;
		const mode = this.$body.find("#ef-ap-round-mode").val() || "nearest";
		if (!(step > 0)) return Math.round((value + 1e-9) * 100) / 100;
		const eps = 1e-9;
		let q = value / step;
		if (mode === "up") q = Math.ceil(q - eps);
		else if (mode === "down") q = Math.floor(q + eps);
		else q = Math.floor(q + 0.5 + eps);
		return Math.round(q * step * 100) / 100;
	}

	_ap_update_store_hint() {
		const $h = this.$body.find("#ef-ap-store-hint");
		if (this._ap_iva_inclusive) {
			$h.html('Esta lista de precios guarda el precio <b>CON IVA</b> (redondeado). El precio neto es informativo.').css("color", "#1d4ed8");
		} else {
			$h.html('Esta lista de precios guarda el precio <b>NETO</b> (= precio con IVA redondeado ÷ IVA). El precio con IVA es informativo.').css("color", "#64748b");
		}
	}

	_load_pricing_assignment() {
		const $select = this.$body.find("#ef-ap-price-list");
		$select.empty().append('<option value="">Cargando listas...</option>');
		this.$body.find("#ef-ap-tbody").html(
			'<tr><td colspan="14" style="text-align:center; color:#94a3b8; padding:20px;">Filtre por proveedor, grupo de artículos o ítem y presione Buscar.</td></tr>'
		);
		this.$body.find("#ef-ap-status").text("");
		this.$body.find("#ef-ap-util-global").val(0);
		this._ap_iva_inclusive = false;
		this._update_ap_selected_count();

		frappe.call({
			method: "facex_multi.api.item.get_price_lists",
			args: { company: this._ap_company() },
			callback: (r) => {
				$select.empty();
				const lists = (r.message || []).filter((l) => l.selling || !l.buying);
				const src = lists.length ? lists : (r.message || []);
				if (!src.length) {
					$select.append('<option value="">Sin listas activas</option>');
				} else {
					src.forEach((l) => $select.append(`<option value="${_esc(l.name)}">${_esc(l.name)} (${_esc(l.currency)})</option>`));
				}
				frappe.call({
					method: "facex_multi.api.utilidad.get_pricing_context",
					args: { company: this._ap_company() },
					callback: (cr) => {
						const ctx = cr.message || {};
						if (ctx.iva_rate != null) this.$body.find("#ef-ap-iva").val(ctx.iva_rate);
						this._ap_iva_inclusive = !!ctx.iva_inclusive;
						this._ap_update_store_hint();
						if (ctx.default_price_list && $select.find(`option[value="${ctx.default_price_list}"]`).length) {
							$select.val(ctx.default_price_list);
						}
					},
				});
			},
		});
	}

	_search_pricing_rows() {
		const supplier = this.ap_supplier_ctrl ? this.ap_supplier_ctrl.get_value() : "";
		const item_group = this.ap_group_ctrl ? this.ap_group_ctrl.get_value() : "";
		const item_code = this.ap_item_ctrl ? this.ap_item_ctrl.get_value() : "";
		const price_list = this.$body.find("#ef-ap-price-list").val();

		if (!supplier && !item_group && !item_code) {
			frappe.show_alert({ message: "Indique un proveedor, un grupo de artículos o un ítem.", indicator: "orange" });
			return;
		}

		const $status = this.$body.find("#ef-ap-status");
		$status.text("Buscando...");

		frappe.call({
			method: "facex_multi.api.utilidad.get_pricing_rows",
			args: { company: this._ap_company(), supplier, item_group, item_code, price_list },
			freeze: true,
			freeze_message: "Cargando productos...",
			callback: (r) => {
				const data = r.message || { rows: [] };
				$status.text(data.rows.length ? `${data.rows.length} producto(s).` : "Sin productos para el filtro.");
				this._render_pricing_rows(data);
			},
		});
	}

	_render_pricing_rows(data) {
		const $tbody = this.$body.find("#ef-ap-tbody");
		const rows = data.rows || [];
		const cur = data.currency || "GTQ";
		const basis = this.$body.find("#ef-ap-cost-basis").val();
		const globalUtil = parseFloat(this.$body.find("#ef-ap-util-global").val()) || 0;
		if (data.iva_rate != null) this.$body.find("#ef-ap-iva").val(data.iva_rate);
		if (data.iva_inclusive != null) this._ap_iva_inclusive = !!data.iva_inclusive;
		this._ap_update_store_hint();
		this.$body.find("#ef-ap-select-all").prop("checked", false);

		if (!rows.length) {
			$tbody.html('<tr><td colspan="14" style="text-align:center; color:#94a3b8; padding:20px;">Sin resultados.</td></tr>');
			this._update_ap_selected_count();
			return;
		}

		const gs = "background:#eef2ff;";   // grupo "Nuevo precio"
		const as = "background:#f8fafc;";   // grupo "Situación actual"
		$tbody.html(rows.map((r) => {
			const baseKey = { estandar: r.costo_estandar, ponderado: r.costo_ponderado, ultima_compra: r.costo_ultima_compra }[basis] || 0;
			return `
			<tr data-item="${_esc(r.item_code)}" data-cur="${_esc(cur)}" data-precio-actual="${r.precio_actual}"
				data-costo-estandar="${r.costo_estandar}" data-costo-ponderado="${r.costo_ponderado}" data-costo-ultima_compra="${r.costo_ultima_compra}">
				<td class="ef-td" style="text-align:center;"><input type="checkbox" class="ef-ap-row-check" /></td>
				<td class="ef-td" style="font-weight:600;">${_esc(r.item_code)}</td>
				<td class="ef-td">${_esc(r.item_name)}</td>
				<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(r.costo_estandar, cur)}</td>
				<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(r.costo_ponderado, cur)}</td>
				<td class="ef-td ef-td-num" style="font-family:monospace;">${_fmtCurrency(r.costo_ultima_compra, cur)}</td>
				<td class="ef-td ef-td-num" style="${gs}"><input type="number" class="ef-input ef-ap-cost-input" style="width:100px; text-align:right; font-size:12px; padding:3px 6px;" min="0" step="any" value="${baseKey ? Number(baseKey).toFixed(4) : ''}" /></td>
				<td class="ef-td ef-td-num" style="${gs}"><input type="number" class="ef-input ef-ap-util-input" style="width:66px; text-align:right; font-size:12px; padding:3px 6px;" min="0" step="any" value="${globalUtil}" /></td>
				<td class="ef-td ef-td-num ef-ap-neto" style="font-family:monospace; font-weight:700; ${gs}">—</td>
				<td class="ef-td ef-td-num ef-ap-iva-val" style="font-family:monospace; font-weight:700; ${gs}">—</td>
				<td class="ef-td ef-td-num ef-ap-actual-neto" style="font-family:monospace; color:#64748b; ${as}">—</td>
				<td class="ef-td ef-td-num ef-ap-actual-iva" style="font-family:monospace; color:#64748b; ${as}">—</td>
				<td class="ef-td ef-td-num ef-ap-costo-base" style="font-family:monospace; color:#64748b; ${as}">—</td>
				<td class="ef-td ef-td-num ef-ap-util-actual" style="font-family:monospace; ${as}">—</td>
			</tr>`;
		}).join(""));

		$tbody.find("tr[data-item]").each((_, tr) => this._recalc_pricing_row($(tr)));
		this._update_ap_selected_count();
	}

	_recalc_pricing_row($tr) {
		const cost = parseFloat($tr.find(".ef-ap-cost-input").val()) || 0;
		const util = parseFloat($tr.find(".ef-ap-util-input").val()) || 0;
		const iva = parseFloat(this.$body.find("#ef-ap-iva").val()) || 0;
		const cur = $tr.attr("data-cur") || "GTQ";
		const factor = 1 + iva / 100;
		const netoBruto = cost * (1 + util / 100);
		const conIva = this._ap_round_price(netoBruto * factor);
		const neto = factor ? conIva / factor : conIva;   // deriva del con-IVA ya redondeado
		$tr.attr("data-neto", neto);
		$tr.attr("data-con-iva", conIva);
		$tr.attr("data-costo", cost);
		$tr.find(".ef-ap-neto").text(cost ? _fmtCurrency(neto, cur) : "—");
		$tr.find(".ef-ap-iva-val").text(cost ? _fmtCurrency(conIva, cur) : "—");

		// ── Grupo "Situación actual": precio vigente (neto y c/IVA), costo base y utilidad ──
		const basis = this.$body.find("#ef-ap-cost-basis").val();
		const costoBase = parseFloat($tr.attr(`data-costo-${basis}`)) || 0;
		const precioActual = parseFloat($tr.attr("data-precio-actual")) || 0;
		// Item Price guarda c/IVA si la lista es inclusiva; si no, guarda el neto.
		const precioActualNeto = (this._ap_iva_inclusive && factor) ? precioActual / factor : precioActual;
		const precioActualConIva = (this._ap_iva_inclusive) ? precioActual : precioActual * factor;
		$tr.find(".ef-ap-actual-neto").text(precioActual ? _fmtCurrency(precioActualNeto, cur) : "—");
		$tr.find(".ef-ap-actual-iva").text(precioActual ? _fmtCurrency(precioActualConIva, cur) : "—");
		$tr.find(".ef-ap-costo-base").text(costoBase ? _fmtCurrency(costoBase, cur) : "—");
		if (costoBase > 0 && precioActual > 0) {
			const utilActual = (precioActualNeto - costoBase) / costoBase * 100;
			const col = utilActual < 0 ? "var(--ef-danger)" : (utilActual < 5 ? "#b45309" : "var(--ef-success)");
			$tr.find(".ef-ap-util-actual").text(_fmt(utilActual) + "%").css({ color: col, "font-weight": 700 });
		} else {
			$tr.find(".ef-ap-util-actual").text("—").css({ color: "#94a3b8", "font-weight": 400 });
		}
	}

	_update_ap_selected_count() {
		const n = this.$body.find("#ef-ap-tbody .ef-ap-row-check:checked").length;
		this.$body.find("#ef-ap-selected-count").text(`${n} seleccionado(s)`);
	}

	_apply_pricing_prices() {
		const price_list = this.$body.find("#ef-ap-price-list").val();
		if (!price_list) {
			frappe.show_alert({ message: "Seleccione una lista de precios.", indicator: "orange" });
			return;
		}
		const rows = [];
		this.$body.find("#ef-ap-tbody tr[data-item]").each((_, tr) => {
			const $tr = $(tr);
			if (!$tr.find(".ef-ap-row-check").prop("checked")) return;
			const costo = parseFloat($tr.find(".ef-ap-cost-input").val()) || 0;
			const util_pct = parseFloat($tr.find(".ef-ap-util-input").val()) || 0;
			const neto = parseFloat($tr.attr("data-neto")) || 0;
			rows.push({ item_code: $tr.attr("data-item"), costo, util_pct, neto });
		});
		if (!rows.length) {
			frappe.show_alert({ message: "Marque al menos un producto.", indicator: "orange" });
			return;
		}
		const sinCosto = rows.filter((r) => !(r.costo > 0)).length;
		if (sinCosto === rows.length) {
			frappe.show_alert({ message: "Ninguna fila seleccionada tiene un costo válido (> 0).", indicator: "orange" });
			return;
		}
		// Ítems que quedarían al costo (utilidad 0) o por debajo — requieren confirmación explícita.
		const alCosto = rows.filter((r) => r.costo > 0 && r.neto <= r.costo + 0.005).map((r) => r.item_code);
		const guardar = this.$body.find("#ef-ap-save-cost").prop("checked") ? 1 : 0;
		const round_step = parseFloat(this.$body.find("#ef-ap-round-step").val()) || 0;
		const round_mode = this.$body.find("#ef-ap-round-mode").val() || "nearest";
		const modeLbl = { up: "hacia arriba", down: "hacia abajo", nearest: "al más cercano" }[round_mode];
		const queGraba = this._ap_iva_inclusive
			? "el precio <b>CON IVA</b> (redondeado)"
			: "el precio <b>NETO</b> (derivado del precio con IVA redondeado)";

		const warnAlCosto = alCosto.length
			? `<div style="color:#b91c1c; font-weight:700;">⚠ ${alCosto.length === 1 ? "Este ítem quedaría" : "Estos ítems quedarían"} al costo (utilidad 0) o por debajo:</div>`
			+ `<div style="margin:3px 0 6px; font-family:monospace;">${alCosto.map(_esc).join(", ")}</div>`
			+ `<div>¿Está seguro de venderlo${alCosto.length === 1 ? "" : "s"} así?</div><hr style="margin:10px 0; border:none; border-top:1px solid var(--ef-border);">`
			: "";

		frappe.confirm(
			warnAlCosto
			+ `Se asignará ${queGraba} a <b>${rows.length - sinCosto}</b> producto(s) en la lista <b>${_esc(price_list)}</b>.`
			+ (round_step > 0 ? `<br>El precio con IVA se redondea a <b>${round_step.toFixed(2)}</b> ${modeLbl}.` : `<br>El precio con IVA se deja a 2 decimales.`)
			+ (sinCosto ? `<br><span style="color:#b45309;">${sinCosto} fila(s) sin costo válido se omitirán.</span>` : "")
			+ (guardar ? `<br>También se guardará el costo usado como Costo Estándar del producto.` : ""),
			() => {
				frappe.call({
					method: "facex_multi.api.utilidad.apply_utility_prices",
					args: {
						rows_json: JSON.stringify(rows),
						price_list,
						company: this._ap_company(),
						guardar_costo_estandar: guardar,
						round_step,
						round_mode,
					},
					freeze: true,
					freeze_message: "Aplicando precios...",
					callback: (r) => {
						const res = r.message || { updated: [], errors: [] };
						frappe.show_alert({
							message: `${res.updated.length} precio(s) actualizado(s).` + (res.errors.length ? ` ${res.errors.length} con error.` : ""),
							indicator: res.errors.length ? "orange" : "green",
						}, 7);
						if (res.errors.length) {
							frappe.msgprint({
								title: "Errores al asignar precios",
								message: res.errors.map((e) => `<b>${_esc(e.item_code)}</b>: ${_esc(e.error)}`).join("<br>"),
								indicator: "orange",
							});
						}
						this._search_pricing_rows();
					},
				});
			}
		);
	}

	// ── Customers Maintenance (búsqueda-primero, estilo SAP) ──

	_search_maint_customers() {
		const txt = (this.$body.find("#ef-maint-cust-search").val() || "").trim();
		const field = this.$body.find("#ef-maint-cust-search-field").val() || "nombre";

		if (!txt) {
			frappe.show_alert({ message: "Escriba un texto para buscar.", indicator: "orange" });
			return;
		}

		const filters = {};
		filters[field] = txt;
		this._open_maint_cust_browser(filters);
	}

	_view_all_maint_customers() {
		this.$body.find("#ef-maint-cust-search").val("");
		this._open_maint_cust_browser({});
	}

	// Abre (o reinicia) el buscador paginado de clientes: navega de a
	// EF_MAINT_CUST_PAGE_LENGTH resultados usando los botones Anterior/Siguiente,
	// y permite refinar por cualquier combinación de columnas desde la fila de
	// filtros del propio popup, sin tener que volver a abrirlo.
	_open_maint_cust_browser(filters) {
		this._maint_cust_browser_filters = Object.assign(
			{ nombre: "", codigo: "", nit: "", grupo: "", celular: "", vendedor: "" },
			filters
		);
		this._maint_cust_browser_start = 0;
		this._maint_cust_browser_selected = new Set();
		this._maint_cust_active_filter_key = null;
		if (this._maint_cust_browser_dialog) {
			this._maint_cust_browser_dialog.hide();
			this._maint_cust_browser_dialog = null;
		}
		this._fetch_and_render_maint_cust_page();
	}

	_fetch_and_render_maint_cust_page() {
		const filters = this._maint_cust_browser_filters;
		const start = this._maint_cust_browser_start;
		const $status = this.$body.find("#ef-maint-cust-search-status");
		$status.text("Buscando...");

		frappe.call({
			method: "facex_multi.api.customer.search_customers_maintenance",
			args: {
				...filters,
				company: this.doc.company || this.defaults.company || "",
				start,
				page_length: EF_MAINT_CUST_PAGE_LENGTH,
			},
			callback: (r) => {
				const res = r.message || { rows: [], total: 0 };
				$status.text(res.total ? `${res.total} resultado(s).` : "Sin resultados.");
				this._render_maint_cust_results_popup(res.rows, res.total, start);
			}
		});
	}

	_mark_all_maint_customers() {
		const filters = this._maint_cust_browser_filters;
		frappe.call({
			method: "facex_multi.api.customer.search_customers_maintenance",
			args: {
				...filters,
				company: this.doc.company || this.defaults.company || "",
				start: 0,
				page_length: 5000,
			},
			freeze: true,
			freeze_message: "Marcando todos los resultados...",
			callback: (r) => {
				const res = r.message || { rows: [] };
				res.rows.forEach((c) => this._maint_cust_browser_selected.add(c.name));
				this._fetch_and_render_maint_cust_page();
			}
		});
	}

	_render_maint_cust_results_popup(rows, total, start) {
		const page_length = EF_MAINT_CUST_PAGE_LENGTH;
		const totalPages = Math.max(1, Math.ceil(total / page_length));
		const currentPage = Math.floor(start / page_length) + 1;
		const filters = this._maint_cust_browser_filters;

		if (!this._maint_cust_browser_dialog) {
			const dialog = new frappe.ui.Dialog({
				title: "Resultados de búsqueda",
				size: "extra-large",
				fields: [{ fieldtype: "HTML", fieldname: "results_html" }],
				primary_action_label: "Exportar seleccionados a Excel",
				primary_action: () => {
					const selected = Array.from(this._maint_cust_browser_selected);
					if (!selected.length) {
						frappe.show_alert({ message: "Seleccione al menos un cliente para exportar.", indicator: "orange" });
						return;
					}
					this._export_maint_customers_excel(selected);
				},
			});
			dialog.$wrapper.on("hidden.bs.modal", () => {
				this._maint_cust_browser_dialog = null;
				clearTimeout(this._maint_cust_filter_timer);
			});
			this._maint_cust_browser_dialog = dialog;
			dialog.show();
		}

		const dialog = this._maint_cust_browser_dialog;
		dialog.set_title(`Resultados de búsqueda (${total})`);

		const filterCell = (key) => `
			<td><input type="text" class="ef-input ef-cust-popup-filter" data-key="${key}"
				placeholder="Filtrar..." value="${_esc(filters[key] || "")}"
				style="width:100%; font-size:11px; padding:3px 6px;" /></td>
		`;

		const rowsHtml = rows.length ? rows.map((c) => `
			<tr>
				<td style="text-align:center;"><input type="checkbox" class="ef-cust-popup-chk" data-name="${_esc(c.name)}" ${this._maint_cust_browser_selected.has(c.name) ? "checked" : ""} /></td>
				<td>${_esc(c.customer_name || "")}</td>
				<td>${_esc(c.name || "")}</td>
				<td>${_esc(c.tax_id || c.bfel_id_receptor || "")}</td>
				<td>${_esc(c.customer_group || "")}</td>
				<td>${_esc(c.mobile_no || "")}</td>
				<td>${_esc(c.default_sales_partner || "")}</td>
				<td>${c.disabled ? '<span style="color:#ef4444;">Sí</span>' : "No"}</td>
				<td style="text-align:center;">
					<button class="ef-btn ef-btn-sm ef-btn-secondary ef-cust-popup-edit" data-name="${_esc(c.name)}">Editar</button>
				</td>
			</tr>
		`).join("") : `<tr><td colspan="9" style="text-align:center; padding:14px; color:#64748b;">Sin resultados con estos filtros.</td></tr>`;

		dialog.fields_dict.results_html.$wrapper.html(`
			<div style="overflow-x:auto;">
				<table class="ef-table" style="width:100%;">
					<thead>
						<tr>
							<th style="width:36px; text-align:center;"><input type="checkbox" id="ef-cust-popup-select-all" title="Seleccionar todos en esta página" /></th>
							<th>Nombre</th>
							<th>Código</th>
							<th>NIT / Identificación</th>
							<th>Grupo</th>
							<th>Celular</th>
							<th>Vendedor</th>
							<th>Deshabilitado</th>
							<th style="width:80px;"></th>
						</tr>
						<tr class="ef-cust-popup-filter-row">
							<td></td>
							${filterCell("nombre")}
							${filterCell("codigo")}
							${filterCell("nit")}
							${filterCell("grupo")}
							${filterCell("celular")}
							${filterCell("vendedor")}
							<td></td>
							<td></td>
						</tr>
					</thead>
					<tbody>${rowsHtml}</tbody>
				</table>
			</div>
			<div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px; flex-wrap:wrap; gap:8px;">
				<div>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-cust-popup-mark-all">Marcar todos (${total})</button>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-cust-popup-unmark-all">Desmarcar todos</button>
				</div>
				<div style="display:flex; align-items:center; gap:10px;">
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-cust-popup-prev" ${currentPage <= 1 ? "disabled" : ""}>&laquo; Anterior</button>
					<span style="font-size:12px; color:#64748b;">Página ${currentPage} de ${totalPages} &mdash; ${this._maint_cust_browser_selected.size} seleccionado(s)</span>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-cust-popup-next" ${currentPage >= totalPages ? "disabled" : ""}>Siguiente &raquo;</button>
				</div>
			</div>
		`);

		dialog.$wrapper.find("#ef-cust-popup-select-all").on("change", (e) => {
			const checked = $(e.target).prop("checked");
			dialog.$wrapper.find(".ef-cust-popup-chk").each((_, el) => {
				$(el).prop("checked", checked);
				const name = $(el).data("name");
				if (checked) this._maint_cust_browser_selected.add(name);
				else this._maint_cust_browser_selected.delete(name);
			});
			this._render_maint_cust_results_popup(rows, total, start);
		});

		dialog.$wrapper.find("tbody tr").on("click", (e) => {
			if ($(e.target).is("button, input") || $(e.target).closest("button").length) return;
			const $chk = $(e.currentTarget).find(".ef-cust-popup-chk");
			if (!$chk.length) return;
			$chk.prop("checked", !$chk.prop("checked")).trigger("change");
		});

		dialog.$wrapper.find(".ef-cust-popup-chk").on("change", (e) => {
			const name = $(e.currentTarget).data("name");
			if ($(e.currentTarget).prop("checked")) this._maint_cust_browser_selected.add(name);
			else this._maint_cust_browser_selected.delete(name);
			dialog.$wrapper.find("#ef-cust-popup-prev, #ef-cust-popup-next").siblings("span")
				.text(`Página ${currentPage} de ${totalPages} — ${this._maint_cust_browser_selected.size} seleccionado(s)`);
		});

		dialog.$wrapper.find(".ef-cust-popup-edit").on("click", (e) => {
			e.stopPropagation();
			const name = $(e.currentTarget).data("name");
			dialog.hide();
			this._maint_cust_browser_dialog = null;
			this._load_maint_customer_details(name);
		});

		dialog.$wrapper.find("#ef-cust-popup-prev").on("click", () => {
			this._maint_cust_browser_start = Math.max(0, start - page_length);
			this._fetch_and_render_maint_cust_page();
		});
		dialog.$wrapper.find("#ef-cust-popup-next").on("click", () => {
			this._maint_cust_browser_start = start + page_length;
			this._fetch_and_render_maint_cust_page();
		});

		dialog.$wrapper.find("#ef-cust-popup-mark-all").on("click", () => {
			this._mark_all_maint_customers();
		});
		dialog.$wrapper.find("#ef-cust-popup-unmark-all").on("click", () => {
			this._maint_cust_browser_selected.clear();
			this._render_maint_cust_results_popup(rows, total, start);
		});

		dialog.$wrapper.find(".ef-cust-popup-filter").on("input", (e) => {
			const key = $(e.currentTarget).data("key");
			this._maint_cust_browser_filters[key] = $(e.currentTarget).val();
			this._maint_cust_active_filter_key = key;
			clearTimeout(this._maint_cust_filter_timer);
			this._maint_cust_filter_timer = setTimeout(() => {
				this._maint_cust_browser_start = 0;
				this._fetch_and_render_maint_cust_page();
			}, 350);
		});

		if (this._maint_cust_active_filter_key) {
			const $input = dialog.$wrapper.find(`.ef-cust-popup-filter[data-key="${this._maint_cust_active_filter_key}"]`);
			if ($input.length) {
				$input.trigger("focus");
				const val = $input.val() || "";
				$input[0].setSelectionRange(val.length, val.length);
			}
		}
	}

	_export_maint_customers_excel(names) {
		const company = this.doc.company || this.defaults.company || "";
		const url = `/api/method/facex_multi.api.customer.export_customers_excel?names_json=${encodeURIComponent(JSON.stringify(names))}&company=${encodeURIComponent(company)}`;
		window.open(url, "_blank");
	}

	_set_maint_cust_form_mode(mode) {
		this._maint_cust_mode = mode;
		const enable = mode !== "search";

		this.$body.find(
			"#ef-maint-cust-name, #ef-maint-cust-ident, #ef-maint-cust-receptor, " +
			"#ef-maint-cust-contact-nombre, #ef-maint-cust-contact-apellido, " +
			"#ef-maint-cust-contact-email, #ef-maint-cust-contact-telefono, " +
			"#ef-maint-cust-addr, #ef-maint-cust-dept, #ef-maint-cust-credit-limit"
		).prop("disabled", !enable);

		[
			this.maint_cust_group_ctrl,
			this.maint_cust_price_list_ctrl,
			this.maint_cust_payment_terms_ctrl,
			this.maint_cust_sales_partner_ctrl,
		].forEach((ctrl) => {
			if (!ctrl) return;
			ctrl.df.read_only = !enable;
			ctrl.refresh();
		});

		const $save = this.$body.find("#ef-maint-cust-btn-save");
		const $delete = this.$body.find("#ef-maint-cust-btn-delete");

		if (mode === "search") {
			$save.hide();
			$delete.hide();
			this.$body.find("#ef-maint-cust-title").text("Búsqueda de clientes");
		} else if (mode === "create") {
			$save.show().text("Crear Cliente");
			$delete.hide();
			this.$body.find("#ef-maint-cust-title").text("Nuevo Cliente");
		} else if (mode === "edit") {
			$save.show().text("Guardar Cambios");
			if (this.perms.modifica_clientes) $delete.show(); else $delete.hide();
		}
	}

	_lookup_maint_cust_name(idReceptor) {
		idReceptor = (idReceptor || "").trim();
		const tipo = this.$body.find("#ef-maint-cust-ident").val();
		if ((tipo !== "NIT" && tipo !== "CUI") || !idReceptor) return;

		frappe.call({
			method: "facex_multi.api.customer.lookup_identificacion_name",
			args: { identificacion: idReceptor, tipo, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				const res = r.message || {};
				if (res.found && res.customer_name) {
					this.$body.find("#ef-maint-cust-name").val(res.customer_name);
				}
			}
		});
	}

	_load_maint_customer_details(name) {
		frappe.call({
			method: "facex_multi.api.customer.get_customer",
			args: { name, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				if (r.message) {
					const c = r.message;
					this._current_maint_cust_name = c.name;
					this.$body.find("#ef-maint-cust-title").text(`Editar: ${c.customer_name}`);
					this.$body.find("#ef-maint-cust-name").val(c.customer_name);
					this.$body.find("#ef-maint-cust-ident").val(c.bfel_identificacion);
					this.$body.find("#ef-maint-cust-receptor").val(c.bfel_id_receptor);
					this.$body.find("#ef-maint-cust-addr").val(c.direccion);
					this.$body.find("#ef-maint-cust-dept").val(c.departamento);
					this.$body.find("#ef-maint-cust-contact-nombre").val(c.contacto_nombre);
					this.$body.find("#ef-maint-cust-contact-apellido").val(c.contacto_apellido);
					this.$body.find("#ef-maint-cust-contact-email").val(c.contacto_email);
					this.$body.find("#ef-maint-cust-contact-telefono").val(c.contacto_telefono);
					this.$body.find("#ef-maint-cust-credit-limit").val(c.credit_limit || 0);
					if (this.maint_cust_price_list_ctrl) {
						this.maint_cust_price_list_ctrl.set_value(c.default_price_list || "");
					}
					if (this.maint_cust_payment_terms_ctrl) {
						this.maint_cust_payment_terms_ctrl.set_value(c.payment_terms || "");
					}
					if (this.maint_cust_sales_partner_ctrl) {
						this.maint_cust_sales_partner_ctrl.set_value(c.default_sales_partner || "");
					}
					if (this.maint_cust_group_ctrl) {
						this.maint_cust_group_ctrl.set_value(c.customer_group || "");
					}
					this._set_maint_cust_form_mode("edit");
				}
			}
		});
	}

	_clear_maint_cust_form() {
		this._current_maint_cust_name = null;
		this.$body.find("#ef-maint-cust-name").val("");
		this.$body.find("#ef-maint-cust-ident").val("");
		this.$body.find("#ef-maint-cust-receptor").val("");
		this.$body.find("#ef-maint-cust-addr").val("");
		this.$body.find("#ef-maint-cust-dept").val("");
		this.$body.find("#ef-maint-cust-contact-nombre").val("");
		this.$body.find("#ef-maint-cust-contact-apellido").val("");
		this.$body.find("#ef-maint-cust-contact-email").val("");
		this.$body.find("#ef-maint-cust-contact-telefono").val("");
		this.$body.find("#ef-maint-cust-credit-limit").val("");
		if (this.maint_cust_price_list_ctrl) {
			this.maint_cust_price_list_ctrl.set_value("");
		}
		if (this.maint_cust_payment_terms_ctrl) {
			this.maint_cust_payment_terms_ctrl.set_value("");
		}
		if (this.maint_cust_sales_partner_ctrl) {
			this.maint_cust_sales_partner_ctrl.set_value("");
		}
		if (this.maint_cust_group_ctrl) {
			this.maint_cust_group_ctrl.set_value("");
		}
		this.$body.find("#ef-maint-cust-btn-delete").hide();
	}

	_save_maint_customer() {
		const name = this._current_maint_cust_name || "";
		const customer_name = this.$body.find("#ef-maint-cust-name").val().trim();
		if (!customer_name) {
			frappe.show_alert({ message: "El nombre es obligatorio.", indicator: "red" });
			return;
		}

		const data = {
			name,
			customer_name,
			bfel_identificacion: this.$body.find("#ef-maint-cust-ident").val(),
			bfel_id_receptor: this.$body.find("#ef-maint-cust-receptor").val(),
			direccion: this.$body.find("#ef-maint-cust-addr").val(),
			departamento: this.$body.find("#ef-maint-cust-dept").val(),
			contacto_nombre: this.$body.find("#ef-maint-cust-contact-nombre").val(),
			contacto_apellido: this.$body.find("#ef-maint-cust-contact-apellido").val(),
			contacto_email: this.$body.find("#ef-maint-cust-contact-email").val(),
			contacto_telefono: this.$body.find("#ef-maint-cust-contact-telefono").val(),
			default_price_list: this.maint_cust_price_list_ctrl ? this.maint_cust_price_list_ctrl.get_value() : "",
			payment_terms: this.maint_cust_payment_terms_ctrl ? this.maint_cust_payment_terms_ctrl.get_value() : "",
			default_sales_partner: this.maint_cust_sales_partner_ctrl ? this.maint_cust_sales_partner_ctrl.get_value() : "",
			customer_group: this.maint_cust_group_ctrl ? this.maint_cust_group_ctrl.get_value() : "",
			credit_limit: parseFloat(this.$body.find("#ef-maint-cust-credit-limit").val()) || 0,
		};
		const company = this.doc.company || this.defaults.company || "";

		frappe.call({
			method: "facex_multi.api.customer.create_or_update_customer",
			args: { data_json: JSON.stringify(data), company },
			freeze: true,
			freeze_message: "Guardando cliente...",
			callback: (r) => {
				if (!r.exc) {
					frappe.show_alert({ message: "Cliente guardado exitosamente", indicator: "green" });
					this._clear_maint_cust_form();
					this._set_maint_cust_form_mode("search");
				}
			}
		});
	}

	// ── Products Maintenance ──

	_search_maint_items() {
		const txt = (this.$body.find("#ef-maint-item-search").val() || "").trim();
		const field = this.$body.find("#ef-maint-item-search-field").val() || "nombre";

		if (!txt) {
			frappe.show_alert({ message: "Escriba un texto para buscar.", indicator: "orange" });
			return;
		}

		const filters = {};
		filters[field] = txt;
		this._open_maint_item_browser(filters);
	}

	_view_all_maint_items() {
		this.$body.find("#ef-maint-item-search").val("");
		this._open_maint_item_browser({});
	}

	_open_maint_item_browser(filters) {
		this._maint_item_browser_filters = Object.assign({ nombre: "", codigo: "", grupo: "" }, filters);
		this._maint_item_browser_start = 0;
		this._maint_item_browser_selected = new Set();
		this._maint_item_active_filter_key = null;
		if (this._maint_item_browser_dialog) {
			this._maint_item_browser_dialog.hide();
			this._maint_item_browser_dialog = null;
		}
		this._fetch_and_render_maint_item_page();
	}

	_fetch_and_render_maint_item_page() {
		const filters = this._maint_item_browser_filters;
		const start = this._maint_item_browser_start;
		const $status = this.$body.find("#ef-maint-item-search-status");
		$status.text("Buscando...");

		frappe.call({
			method: "facex_multi.api.item.search_items_maintenance",
			args: {
				...filters,
				company: this.doc.company || this.defaults.company || "",
				start,
				page_length: EF_MAINT_ITEM_PAGE_LENGTH,
			},
			callback: (r) => {
				const res = r.message || { rows: [], total: 0 };
				$status.text(res.total ? `${res.total} resultado(s).` : "Sin resultados.");
				this._render_maint_item_results_popup(res.rows, res.total, start);
			}
		});
	}

	_mark_all_maint_items() {
		const filters = this._maint_item_browser_filters;
		frappe.call({
			method: "facex_multi.api.item.search_items_maintenance",
			args: {
				...filters,
				company: this.doc.company || this.defaults.company || "",
				start: 0,
				page_length: 5000,
			},
			freeze: true,
			freeze_message: "Marcando todos los resultados...",
			callback: (r) => {
				const res = r.message || { rows: [] };
				res.rows.forEach((it) => this._maint_item_browser_selected.add(it.name));
				this._fetch_and_render_maint_item_page();
			}
		});
	}

	_render_maint_item_results_popup(rows, total, start) {
		const page_length = EF_MAINT_ITEM_PAGE_LENGTH;
		const totalPages = Math.max(1, Math.ceil(total / page_length));
		const currentPage = Math.floor(start / page_length) + 1;
		const filters = this._maint_item_browser_filters;

		if (!this._maint_item_browser_dialog) {
			const dialog = new frappe.ui.Dialog({
				title: "Resultados de búsqueda",
				size: "extra-large",
				fields: [{ fieldtype: "HTML", fieldname: "results_html" }],
				primary_action_label: "Exportar seleccionados a Excel",
				primary_action: () => {
					const selected = Array.from(this._maint_item_browser_selected);
					if (!selected.length) {
						frappe.show_alert({ message: "Seleccione al menos un producto para exportar.", indicator: "orange" });
						return;
					}
					this._export_maint_items_excel(selected);
				},
			});
			dialog.$wrapper.on("hidden.bs.modal", () => {
				this._maint_item_browser_dialog = null;
				clearTimeout(this._maint_item_filter_timer);
			});
			this._maint_item_browser_dialog = dialog;
			dialog.show();
		}

		const dialog = this._maint_item_browser_dialog;
		dialog.set_title(`Resultados de búsqueda (${total})`);

		const filterCell = (key) => `
			<td><input type="text" class="ef-input ef-item-popup-filter" data-key="${key}"
				placeholder="Filtrar..." value="${_esc(filters[key] || "")}"
				style="width:100%; font-size:11px; padding:3px 6px;" /></td>
		`;

		const rowsHtml = rows.length ? rows.map((it) => `
			<tr>
				<td style="text-align:center;"><input type="checkbox" class="ef-item-popup-chk" data-name="${_esc(it.name)}" ${this._maint_item_browser_selected.has(it.name) ? "checked" : ""} /></td>
				<td>${_esc(it.item_name || "")}</td>
				<td>${_esc(it.name || "")}</td>
				<td>${_esc(it.item_group || "")}</td>
				<td>${_esc(it.stock_uom || "")}</td>
				<td>${_esc(it.gestionado_por || "General")}</td>
				<td>${it.is_stock_item ? "Sí" : "No"}</td>
				<td>${it.disabled ? '<span style="color:#ef4444;">Sí</span>' : "No"}</td>
				<td style="text-align:center;">
					<button class="ef-btn ef-btn-sm ef-btn-secondary ef-item-popup-edit" data-name="${_esc(it.name)}">Editar</button>
				</td>
			</tr>
		`).join("") : `<tr><td colspan="9" style="text-align:center; padding:14px; color:#64748b;">Sin resultados con estos filtros.</td></tr>`;

		dialog.fields_dict.results_html.$wrapper.html(`
			<div style="overflow-x:auto;">
				<table class="ef-table" style="width:100%;">
					<thead>
						<tr>
							<th style="width:36px; text-align:center;"><input type="checkbox" id="ef-item-popup-select-all" title="Seleccionar todos en esta página" /></th>
							<th>Nombre</th>
							<th>Código</th>
							<th>Grupo</th>
							<th>UOM</th>
							<th>Gestionado por</th>
							<th>Inventariable</th>
							<th>Deshabilitado</th>
							<th style="width:80px;"></th>
						</tr>
						<tr class="ef-cust-popup-filter-row">
							<td></td>
							${filterCell("nombre")}
							${filterCell("codigo")}
							${filterCell("grupo")}
							<td></td>
							<td></td>
							<td></td>
							<td></td>
							<td></td>
						</tr>
					</thead>
					<tbody>${rowsHtml}</tbody>
				</table>
			</div>
			<div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px; flex-wrap:wrap; gap:8px;">
				<div>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-item-popup-mark-all">Marcar todos (${total})</button>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-item-popup-unmark-all">Desmarcar todos</button>
				</div>
				<div style="display:flex; align-items:center; gap:10px;">
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-item-popup-prev" ${currentPage <= 1 ? "disabled" : ""}>&laquo; Anterior</button>
					<span style="font-size:12px; color:#64748b;">Página ${currentPage} de ${totalPages} &mdash; ${this._maint_item_browser_selected.size} seleccionado(s)</span>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-item-popup-next" ${currentPage >= totalPages ? "disabled" : ""}>Siguiente &raquo;</button>
				</div>
			</div>
		`);

		dialog.$wrapper.find("#ef-item-popup-select-all").on("change", (e) => {
			const checked = $(e.target).prop("checked");
			dialog.$wrapper.find(".ef-item-popup-chk").each((_, el) => {
				$(el).prop("checked", checked);
				const name = $(el).data("name");
				if (checked) this._maint_item_browser_selected.add(name);
				else this._maint_item_browser_selected.delete(name);
			});
			this._render_maint_item_results_popup(rows, total, start);
		});

		dialog.$wrapper.find("tbody tr").on("click", (e) => {
			if ($(e.target).is("button, input") || $(e.target).closest("button").length) return;
			const $chk = $(e.currentTarget).find(".ef-item-popup-chk");
			if (!$chk.length) return;
			$chk.prop("checked", !$chk.prop("checked")).trigger("change");
		});

		dialog.$wrapper.find(".ef-item-popup-chk").on("change", (e) => {
			const name = $(e.currentTarget).data("name");
			if ($(e.currentTarget).prop("checked")) this._maint_item_browser_selected.add(name);
			else this._maint_item_browser_selected.delete(name);
			dialog.$wrapper.find("#ef-item-popup-prev, #ef-item-popup-next").siblings("span")
				.text(`Página ${currentPage} de ${totalPages} — ${this._maint_item_browser_selected.size} seleccionado(s)`);
		});

		dialog.$wrapper.find(".ef-item-popup-edit").on("click", (e) => {
			e.stopPropagation();
			const name = $(e.currentTarget).data("name");
			dialog.hide();
			this._maint_item_browser_dialog = null;
			this._load_maint_item_details(name);
		});

		dialog.$wrapper.find("#ef-item-popup-prev").on("click", () => {
			this._maint_item_browser_start = Math.max(0, start - page_length);
			this._fetch_and_render_maint_item_page();
		});
		dialog.$wrapper.find("#ef-item-popup-next").on("click", () => {
			this._maint_item_browser_start = start + page_length;
			this._fetch_and_render_maint_item_page();
		});

		dialog.$wrapper.find("#ef-item-popup-mark-all").on("click", () => {
			this._mark_all_maint_items();
		});
		dialog.$wrapper.find("#ef-item-popup-unmark-all").on("click", () => {
			this._maint_item_browser_selected.clear();
			this._render_maint_item_results_popup(rows, total, start);
		});

		dialog.$wrapper.find(".ef-item-popup-filter").on("input", (e) => {
			const key = $(e.currentTarget).data("key");
			this._maint_item_browser_filters[key] = $(e.currentTarget).val();
			this._maint_item_active_filter_key = key;
			clearTimeout(this._maint_item_filter_timer);
			this._maint_item_filter_timer = setTimeout(() => {
				this._maint_item_browser_start = 0;
				this._fetch_and_render_maint_item_page();
			}, 350);
		});

		if (this._maint_item_active_filter_key) {
			const $input = dialog.$wrapper.find(`.ef-item-popup-filter[data-key="${this._maint_item_active_filter_key}"]`);
			if ($input.length) {
				$input.trigger("focus");
				const val = $input.val() || "";
				$input[0].setSelectionRange(val.length, val.length);
			}
		}
	}

	_export_maint_items_excel(names) {
		const company = this.doc.company || this.defaults.company || "";
		const url = `/api/method/facex_multi.api.item.export_items_excel?names_json=${encodeURIComponent(JSON.stringify(names))}&company=${encodeURIComponent(company)}`;
		window.open(url, "_blank");
	}

	_set_maint_item_form_mode(mode) {
		this._maint_item_mode = mode;
		const enable = mode !== "search";

		this.$body.find(
			"#ef-maint-item-name, #ef-maint-item-auto-code, #ef-maint-item-gestionado-por, " +
			"#ef-maint-item-is-stock, #ef-maint-item-desc, #ef-maint-item-keywords, #ef-maint-item-costo-estandar"
		).prop("disabled", !enable);

		[this.maint_item_uom_ctrl, this.maint_item_group_ctrl].forEach((ctrl) => {
			if (!ctrl) return;
			ctrl.df.read_only = !enable;
			ctrl.refresh();
		});

		const $save = this.$body.find("#ef-maint-item-btn-save");
		const $delete = this.$body.find("#ef-maint-item-btn-delete");

		if (mode === "search") {
			$save.hide();
			$delete.hide();
			this.$body.find("#ef-maint-item-btn-print-label").hide();
			this.$body.find("#ef-maint-item-title").text("Búsqueda de productos");
		} else if (mode === "create") {
			$save.show().text("Crear Producto");
			$delete.hide();
			this.$body.find("#ef-maint-item-title").text("Nuevo Producto");
		} else if (mode === "edit") {
			$save.show().text("Guardar Cambios");
			if (this.perms.modifica_items) $delete.show(); else $delete.hide();
		}
	}

	_load_maint_item_details(name) {
		const plist = this.$body.find("#ef-maint-price-list-select").val() || "";
		frappe.call({
			method: "facex_multi.api.item.get_item",
			args: { name, price_list: plist, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				if (r.message) {
					const it = r.message;
					this._current_maint_item_code = it.item_code;
					this._set_maint_item_form_mode("edit");
					this.$body.find("#ef-maint-item-title").text(`Editar: ${it.item_name}`);
					this.$body.find("#ef-maint-item-auto-code-label").hide();
					this.$body.find("#ef-maint-item-code").val(it.item_code).prop("disabled", true);
					this.$body.find("#ef-maint-item-name").val(it.item_name);
					if (this.maint_item_uom_ctrl) {
						this.maint_item_uom_ctrl.set_value(it.stock_uom || "Nos");
					}
					if (this.maint_item_group_ctrl) {
						this.maint_item_group_ctrl.set_value(it.item_group || "");
					}
					this.$body.find("#ef-maint-item-desc").val(it.description);
					const gestionado = it.has_serial_no ? "Serie" : (it.has_batch_no ? "Lote" : "General");
					this.$body.find("#ef-maint-item-gestionado-por").val(gestionado);
					const isStockForced = gestionado === "Serie" || gestionado === "Lote";
					this.$body.find("#ef-maint-item-is-stock")
						.prop("checked", isStockForced || !!it.is_stock_item)
						.prop("disabled", isStockForced);
					if (frappe.boot.versions && frappe.boot.versions.etiba) this.$body.find("#ef-maint-item-btn-print-label").show();
					this._maint_load_item_images(it.item_code);
					this.$body.find("#ef-maint-item-keywords").val(it.palabras_busqueda || "");
					this.$body.find("#ef-maint-item-costo-estandar").val(it.costo_estandar || "");
					this.$body.find("#ef-maint-item-relations-wrap").show();
					this._load_maint_item_relations(it.item_code);
				}
			}
		});
	}

	_load_maint_item_relations(item_code) {
		this._maint_relations = { Par: [], Alternativo: [] };
		frappe.call({
			method: "facex_multi.api.item_relations.get_item_relations",
			args: { item_code },
			callback: (r) => {
				const rows = r.message || [];
				this._maint_relations.Par = rows.filter((row) => row.tipo === "Par");
				this._maint_relations.Alternativo = rows.filter((row) => row.tipo === "Alternativo");
				this._render_maint_relation_rows("Par");
				this._render_maint_relation_rows("Alternativo");
			},
		});
	}

	_render_maint_relation_rows(tipo) {
		const rows = (this._maint_relations && this._maint_relations[tipo]) || [];
		const $tbody = this.$body.find(tipo === "Par" ? "#ef-maint-item-par-tbody" : "#ef-maint-item-alt-tbody");
		if (!rows.length) {
			$tbody.html(`<tr><td colspan="3" style="text-align:center; color:#94a3b8; padding:14px;">Sin ${tipo === "Par" ? "pares" : "alternativos"} configurados.</td></tr>`);
			return;
		}
		$tbody.html(rows.map((row) => `
			<tr>
				<td class="ef-td"><strong>${_esc(row.item_code)}</strong><br><span style="color:#64748b;font-size:11px;">${_esc(row.item_name || "")}</span></td>
				<td class="ef-td" style="text-align:center;">${row.two_way ? "✓" : "—"}</td>
				<td class="ef-td" style="text-align:center;"><span class="ef-maint-relation-remove" data-remove="${row.name}" style="cursor:pointer;color:#ef4444;font-weight:700;">&times;</span></td>
			</tr>`).join(""));
	}

	_maint_add_relation(tipo, item_relacionado) {
		const item_code = this._current_maint_item_code;
		if (!item_code) {
			frappe.show_alert({ message: "Guarde el producto antes de agregar relaciones.", indicator: "orange" });
			return;
		}
		if (item_relacionado === item_code) {
			frappe.show_alert({ message: "Un producto no puede relacionarse consigo mismo.", indicator: "orange" });
			return;
		}
		const twoWayId = tipo === "Par" ? "#ef-maint-item-par-twoway" : "#ef-maint-item-alt-twoway";
		const two_way = this.$body.find(twoWayId).prop("checked") ? 1 : 0;
		frappe.call({
			method: "facex_multi.api.item_relations.add_item_relation",
			args: {
				item_code, item_relacionado, tipo, two_way,
				company: this.doc.company || this.defaults.company || "",
			},
			freeze: true,
			callback: (r) => {
				if (!r.exc) this._load_maint_item_relations(item_code);
			},
		});
	}

	_maint_remove_relation(name) {
		frappe.call({
			method: "facex_multi.api.item_relations.remove_item_relation",
			args: { name, company: this.doc.company || this.defaults.company || "" },
			freeze: true,
			callback: (r) => {
				if (!r.exc && this._current_maint_item_code) this._load_maint_item_relations(this._current_maint_item_code);
			},
		});
	}

	_maint_load_item_images(item_code) {
		const $wrapper = this.$body.find("#ef-maint-item-images-body");
		const $addBtn = this.$body.find("#ef-maint-item-images-add-btn");

		if (!item_code) {
			$wrapper.html('<div style="padding:8px 0; color:#94a3b8; font-size:12px;">Guarde el producto para poder agregar imágenes.</div>');
			$addBtn.hide();
			return;
		}

		$addBtn.show().off("click").on("click", () => {
			new frappe.ui.FileUploader({
				doctype: "Item",
				docname: item_code,
				on_success: () => this._maint_load_item_images(item_code),
			});
		});

		$wrapper.html('<div class="ef-stock-loading">Cargando imágenes…</div>');
		frappe.call({
			method: "facex_multi.api.item.get_item_images",
			args: { item_code },
			callback: (r) => {
				const images = r.message || [];
				if (!images.length) {
					$wrapper.html('<div style="padding:8px 0; color:#94a3b8; font-size:12px;">Sin imágenes adjuntas.</div>');
					return;
				}
				this._render_image_carousel($wrapper, images, {
					editable: true,
					item_code,
					onDeleted: () => this._maint_load_item_images(item_code),
				});
			},
		});
	}

	_imprimir_etiqueta_maint_item() {
		const item_code = this._current_maint_item_code;
		if (!item_code) {
			frappe.show_alert({ message: "Guarde el producto antes de imprimir la etiqueta.", indicator: "orange" });
			return;
		}
		frappe.call({
			method: "facex_multi.api.item.get_label_print_config",
			args: { item_code, company: this.doc.company || this.defaults.company || "" },
			freeze: true,
			callback: (r) => {
				const cfg = r.message || {};
				const formatos = cfg.formatos || [];
				if (!formatos.length) {
					frappe.msgprint("No hay formatos de etiqueta activos configurados en eTIBA.");
					return;
				}
				const fields = [
					{
						label: "Formato", fieldname: "formato", fieldtype: "Select",
						options: formatos.map((f) => f.name), default: cfg.formato_sugerido || formatos[0].name, reqd: 1,
					},
					{
						label: "Cantidad", fieldname: "cantidad", fieldtype: "Int",
						default: cfg.cantidad_por_defecto || 1, reqd: 1,
					},
				];
				if (cfg.requiere_serie) {
					fields.push({
						label: "Serie", fieldname: "serie", fieldtype: "Link", options: "Serial No", reqd: 1,
						get_query: () => ({ filters: { item_code, status: "Active" } }),
					});
				}
				const d = new frappe.ui.Dialog({
					title: `Imprimir Etiqueta — ${item_code}`,
					fields,
					primary_action_label: "Imprimir",
					primary_action: (values) => {
						d.hide();
						this._enviar_etiqueta_a_imprimir(item_code, values, cfg.print_service_url);
					},
				});
				d.show();
			},
		});
	}

	_enviar_etiqueta_a_imprimir(item_code, values, print_service_url) {
		frappe.call({
			method: "facex_multi.api.item.imprimir_etiqueta_item",
			args: {
				item_code, formato: values.formato, cantidad: values.cantidad, serie: values.serie || "",
				company: this.doc.company || this.defaults.company || "",
			},
			freeze: true,
			callback: (r) => {
				const zplcode = r.message;
				if (!zplcode) return;
				fetch(print_service_url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ zplcode }),
				})
					.then((response) => {
						if (response.ok) {
							frappe.show_alert({ message: __("Etiqueta enviada a imprimir."), indicator: "green" });
						} else {
							frappe.msgprint("El servicio de impresión de etiquetas respondió con un error.");
						}
					})
					.catch(() => {
						frappe.msgprint("No se pudo conectar con el servicio de impresión de etiquetas (¿está corriendo en este equipo?).");
					});
			},
		});
	}

	_clear_maint_item_form() {
		this._current_maint_item_code = null;
		this._maint_load_item_images(null);
		this.$body.find("#ef-maint-item-auto-code-label").show();
		this.$body.find("#ef-maint-item-auto-code").prop("checked", true);
		this.$body.find("#ef-maint-item-code").val("").prop("disabled", true).attr("placeholder", "(Código Automático)");
		this.$body.find("#ef-maint-item-name").val("");
		if (this.maint_item_uom_ctrl) {
			this.maint_item_uom_ctrl.set_value("Nos");
		}
		if (this.maint_item_group_ctrl) {
			this.maint_item_group_ctrl.set_value("");
		}
		this.$body.find("#ef-maint-item-desc").val("");
		this.$body.find("#ef-maint-item-gestionado-por").val("General");
		this.$body.find("#ef-maint-item-is-stock").prop("checked", false).prop("disabled", false);
		this.$body.find("#ef-maint-item-btn-delete").hide();
		this.$body.find("#ef-maint-item-btn-print-label").hide();
		this.$body.find("#ef-maint-item-keywords").val("");
		this.$body.find("#ef-maint-item-costo-estandar").val("");
		this.$body.find("#ef-maint-item-relations-wrap").hide();
		this._maint_relations = { Par: [], Alternativo: [] };
	}

	_save_maint_item() {
		const is_new = !this._current_maint_item_code;
		const auto_code = is_new && this.$body.find("#ef-maint-item-auto-code").prop("checked") ? 1 : 0;
		const item_code = this.$body.find("#ef-maint-item-code").val().trim();
		const item_name = this.$body.find("#ef-maint-item-name").val().trim();

		if (!item_name || (!auto_code && !item_code)) {
			frappe.show_alert({ message: "Código y Nombre son campos obligatorios.", indicator: "red" });
			return;
		}

		const plist = this.$body.find("#ef-maint-price-list-select").val() || "";
		const data = {
			item_code: is_new ? (auto_code ? "" : item_code) : this._current_maint_item_code,
			item_name,
			auto_code,
			stock_uom: this.maint_item_uom_ctrl ? this.maint_item_uom_ctrl.get_value() : "Nos",
			item_group: this.maint_item_group_ctrl ? this.maint_item_group_ctrl.get_value() : "",
			price_list: plist,
			description: this.$body.find("#ef-maint-item-desc").val(),
			gestionado_por: this.$body.find("#ef-maint-item-gestionado-por").val() || "General",
			is_stock_item:  this.$body.find("#ef-maint-item-is-stock").prop("checked") ? 1 : 0,
			palabras_busqueda: this.$body.find("#ef-maint-item-keywords").val() || "",
			costo_estandar: parseFloat(this.$body.find("#ef-maint-item-costo-estandar").val()) || 0,
		};

		frappe.call({
			method: "facex_multi.api.item.create_or_update_item",
			args: { 
				data_json: JSON.stringify(data),
				company: this.doc.company || this.defaults.company || ""
			},
			freeze: true,
			freeze_message: "Guardando producto...",
			callback: (r) => {
				if (!r.exc) {
					frappe.show_alert({ message: "Producto guardado exitosamente", indicator: "green" });
					this._clear_maint_item_form();
					this._set_maint_item_form_mode("search");
				}
			}
		});
	}

	// ── Listas de Materiales (paquetes/kits de venta) ──

	_search_maint_lms() {
		const txt = (this.$body.find("#ef-maint-lm-search").val() || "").trim();
		const field = this.$body.find("#ef-maint-lm-search-field").val() || "nombre";

		if (!txt) {
			frappe.show_alert({ message: "Escriba un texto para buscar.", indicator: "orange" });
			return;
		}

		const filters = {};
		filters[field] = txt;
		this._open_maint_lm_browser(filters);
	}

	_view_all_maint_lms() {
		this.$body.find("#ef-maint-lm-search").val("");
		this._open_maint_lm_browser({});
	}

	_open_maint_lm_browser(filters) {
		this._maint_lm_browser_filters = Object.assign({ nombre: "", codigo: "", modo: "" }, filters);
		this._maint_lm_browser_start = 0;
		this._maint_lm_browser_selected = new Set();
		this._maint_lm_active_filter_key = null;
		if (this._maint_lm_browser_dialog) {
			this._maint_lm_browser_dialog.hide();
			this._maint_lm_browser_dialog = null;
		}
		this._fetch_and_render_maint_lm_page();
	}

	_fetch_and_render_maint_lm_page() {
		const filters = this._maint_lm_browser_filters;
		const start = this._maint_lm_browser_start;
		const $status = this.$body.find("#ef-maint-lm-search-status");
		$status.text("Buscando...");

		frappe.call({
			method: "facex_multi.api.item.search_listas_materiales_maintenance",
			args: {
				...filters,
				company: this.doc.company || this.defaults.company || "",
				start,
				page_length: EF_MAINT_LM_PAGE_LENGTH,
			},
			callback: (r) => {
				const res = r.message || { rows: [], total: 0 };
				$status.text(res.total ? `${res.total} resultado(s).` : "Sin resultados.");
				this._render_maint_lm_results_popup(res.rows, res.total, start);
			}
		});
	}

	_mark_all_maint_lms() {
		const filters = this._maint_lm_browser_filters;
		frappe.call({
			method: "facex_multi.api.item.search_listas_materiales_maintenance",
			args: {
				...filters,
				company: this.doc.company || this.defaults.company || "",
				start: 0,
				page_length: 5000,
			},
			freeze: true,
			freeze_message: "Marcando todos los resultados...",
			callback: (r) => {
				const res = r.message || { rows: [] };
				res.rows.forEach((row) => this._maint_lm_browser_selected.add(row.name));
				this._fetch_and_render_maint_lm_page();
			}
		});
	}

	_render_maint_lm_results_popup(rows, total, start) {
		const page_length = EF_MAINT_LM_PAGE_LENGTH;
		const totalPages = Math.max(1, Math.ceil(total / page_length));
		const currentPage = Math.floor(start / page_length) + 1;
		const filters = this._maint_lm_browser_filters;

		if (!this._maint_lm_browser_dialog) {
			const dialog = new frappe.ui.Dialog({
				title: "Resultados de búsqueda",
				size: "extra-large",
				fields: [{ fieldtype: "HTML", fieldname: "results_html" }],
				primary_action_label: "Exportar seleccionados a Excel",
				primary_action: () => {
					const selected = Array.from(this._maint_lm_browser_selected);
					if (!selected.length) {
						frappe.show_alert({ message: "Seleccione al menos una Lista de Materiales para exportar.", indicator: "orange" });
						return;
					}
					this._export_maint_lms_excel(selected);
				},
			});
			dialog.$wrapper.on("hidden.bs.modal", () => {
				this._maint_lm_browser_dialog = null;
				clearTimeout(this._maint_lm_filter_timer);
			});
			this._maint_lm_browser_dialog = dialog;
			dialog.show();
		}

		const dialog = this._maint_lm_browser_dialog;
		dialog.set_title(`Resultados de búsqueda (${total})`);

		const filterCell = (key) => `
			<td><input type="text" class="ef-input ef-lm-popup-filter" data-key="${key}"
				placeholder="Filtrar..." value="${_esc(filters[key] || "")}"
				style="width:100%; font-size:11px; padding:3px 6px;" /></td>
		`;

		const rowsHtml = rows.length ? rows.map((row) => `
			<tr>
				<td style="text-align:center;"><input type="checkbox" class="ef-lm-popup-chk" data-name="${_esc(row.name)}" ${this._maint_lm_browser_selected.has(row.name) ? "checked" : ""} /></td>
				<td>${_esc(row.item_name || "")}</td>
				<td>${_esc(row.name || "")}</td>
				<td>${_esc(row.modo_stock || "")}</td>
				<td style="text-align:center;">${row.num_componentes || 0}</td>
				<td>${row.disabled ? '<span style="color:#ef4444;">Sí</span>' : "No"}</td>
				<td style="text-align:center;">
					<button class="ef-btn ef-btn-sm ef-btn-secondary ef-lm-popup-edit" data-name="${_esc(row.name)}">Editar</button>
				</td>
			</tr>
		`).join("") : `<tr><td colspan="7" style="text-align:center; padding:14px; color:#64748b;">Sin resultados con estos filtros.</td></tr>`;

		dialog.fields_dict.results_html.$wrapper.html(`
			<div style="overflow-x:auto;">
				<table class="ef-table" style="width:100%;">
					<thead>
						<tr>
							<th style="width:36px; text-align:center;"><input type="checkbox" id="ef-lm-popup-select-all" title="Seleccionar todos en esta página" /></th>
							<th>Nombre</th>
							<th>Código</th>
							<th>Modo de Stock</th>
							<th>Componentes</th>
							<th>Deshabilitado</th>
							<th style="width:80px;"></th>
						</tr>
						<tr class="ef-cust-popup-filter-row">
							<td></td>
							${filterCell("nombre")}
							${filterCell("codigo")}
							<td>
								<select class="ef-input ef-lm-popup-filter" data-key="modo" style="width:100%; font-size:11px; padding:3px 6px;">
									<option value="">Todos</option>
									<option value="Padre" ${filters.modo === "Padre" ? "selected" : ""}>Padre</option>
									<option value="Hijos" ${filters.modo === "Hijos" ? "selected" : ""}>Hijos</option>
								</select>
							</td>
							<td></td>
							<td></td>
							<td></td>
						</tr>
					</thead>
					<tbody>${rowsHtml}</tbody>
				</table>
			</div>
			<div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px; flex-wrap:wrap; gap:8px;">
				<div>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-lm-popup-mark-all">Marcar todos (${total})</button>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-lm-popup-unmark-all">Desmarcar todos</button>
				</div>
				<div style="display:flex; align-items:center; gap:10px;">
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-lm-popup-prev" ${currentPage <= 1 ? "disabled" : ""}>&laquo; Anterior</button>
					<span style="font-size:12px; color:#64748b;">Página ${currentPage} de ${totalPages} &mdash; ${this._maint_lm_browser_selected.size} seleccionado(s)</span>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-lm-popup-next" ${currentPage >= totalPages ? "disabled" : ""}>Siguiente &raquo;</button>
				</div>
			</div>
		`);

		dialog.$wrapper.find("#ef-lm-popup-select-all").on("change", (e) => {
			const checked = $(e.target).prop("checked");
			dialog.$wrapper.find(".ef-lm-popup-chk").each((_, el) => {
				$(el).prop("checked", checked);
				const name = $(el).data("name");
				if (checked) this._maint_lm_browser_selected.add(name);
				else this._maint_lm_browser_selected.delete(name);
			});
			this._render_maint_lm_results_popup(rows, total, start);
		});

		dialog.$wrapper.find("tbody tr").on("click", (e) => {
			if ($(e.target).is("button, input, select") || $(e.target).closest("button").length) return;
			const $chk = $(e.currentTarget).find(".ef-lm-popup-chk");
			if (!$chk.length) return;
			$chk.prop("checked", !$chk.prop("checked")).trigger("change");
		});

		dialog.$wrapper.find(".ef-lm-popup-chk").on("change", (e) => {
			const name = $(e.currentTarget).data("name");
			if ($(e.currentTarget).prop("checked")) this._maint_lm_browser_selected.add(name);
			else this._maint_lm_browser_selected.delete(name);
			dialog.$wrapper.find("#ef-lm-popup-prev, #ef-lm-popup-next").siblings("span")
				.text(`Página ${currentPage} de ${totalPages} — ${this._maint_lm_browser_selected.size} seleccionado(s)`);
		});

		dialog.$wrapper.find(".ef-lm-popup-edit").on("click", (e) => {
			e.stopPropagation();
			const name = $(e.currentTarget).data("name");
			dialog.hide();
			this._maint_lm_browser_dialog = null;
			this._load_maint_lm_details(name);
		});

		dialog.$wrapper.find("#ef-lm-popup-prev").on("click", () => {
			this._maint_lm_browser_start = Math.max(0, start - page_length);
			this._fetch_and_render_maint_lm_page();
		});
		dialog.$wrapper.find("#ef-lm-popup-next").on("click", () => {
			this._maint_lm_browser_start = start + page_length;
			this._fetch_and_render_maint_lm_page();
		});

		dialog.$wrapper.find("#ef-lm-popup-mark-all").on("click", () => {
			this._mark_all_maint_lms();
		});
		dialog.$wrapper.find("#ef-lm-popup-unmark-all").on("click", () => {
			this._maint_lm_browser_selected.clear();
			this._render_maint_lm_results_popup(rows, total, start);
		});

		dialog.$wrapper.find(".ef-lm-popup-filter").on("input change", (e) => {
			const key = $(e.currentTarget).data("key");
			this._maint_lm_browser_filters[key] = $(e.currentTarget).val();
			this._maint_lm_active_filter_key = $(e.currentTarget).is("select") ? null : key;
			clearTimeout(this._maint_lm_filter_timer);
			this._maint_lm_filter_timer = setTimeout(() => {
				this._maint_lm_browser_start = 0;
				this._fetch_and_render_maint_lm_page();
			}, 350);
		});

		if (this._maint_lm_active_filter_key) {
			const $input = dialog.$wrapper.find(`.ef-lm-popup-filter[data-key="${this._maint_lm_active_filter_key}"]`);
			if ($input.length) {
				$input.trigger("focus");
				const val = $input.val() || "";
				$input[0].setSelectionRange(val.length, val.length);
			}
		}
	}

	_export_maint_lms_excel(names) {
		const company = this.doc.company || this.defaults.company || "";
		const url = `/api/method/facex_multi.api.item.export_listas_materiales_excel?names_json=${encodeURIComponent(JSON.stringify(names))}&company=${encodeURIComponent(company)}`;
		window.open(url, "_blank");
	}

	_set_maint_lm_form_mode(mode) {
		this._maint_lm_mode = mode;
		const enable = mode !== "search";

		this.$body.find("#ef-maint-lm-comp-search, input[name='ef-maint-lm-modo']").prop("disabled", !enable);
		this.$body.find("#ef-maint-lm-padre-search").prop("disabled", !enable || mode === "edit");

		const $save = this.$body.find("#ef-maint-lm-btn-save");
		const $delete = this.$body.find("#ef-maint-lm-btn-delete");

		if (mode === "search") {
			$save.hide();
			$delete.hide();
			this.$body.find("#ef-maint-lm-title").text("Búsqueda de Listas de Materiales");
		} else if (mode === "create") {
			$save.show();
			$delete.hide();
			this.$body.find("#ef-maint-lm-title").text("Nueva Lista de Materiales");
		} else if (mode === "edit") {
			$save.show();
			if (this.perms.gestiona_listas_materiales) $delete.show(); else $delete.hide();
		}
	}

	_load_maint_lm_details(item_code) {
		frappe.call({
			method: "facex_multi.api.item.get_lista_materiales_detail",
			args: { item_code },
			freeze: true,
			callback: (r) => {
				const d = r.message || {};
				this._maint_lm_form = {
					item_code,
					item_name: item_code,
					modo_stock: d.modo_stock || "",
					items: [],
					uid_counter: 0,
				};
				(d.items || []).forEach((it) => {
					this._maint_lm_form.uid_counter += 1;
					this._maint_lm_form.items.push({
						uid: this._maint_lm_form.uid_counter,
						item_code: it.item_code,
						item_name: it.item_name,
						qty: it.qty,
					});
				});
				frappe.call({
					method: "facex_multi.api.item.get_item",
					args: { name: item_code, company: this.doc.company || this.defaults.company || "" },
					callback: (r2) => {
						this._maint_lm_form.item_name = (r2.message && r2.message.item_name) || item_code;
						this._set_maint_lm_form_mode("edit");
						this.$body.find("#ef-maint-lm-title").text(`Editar: ${this._maint_lm_form.item_name}`);
						this.$body.find("#ef-maint-lm-padre-search").val(`${item_code} — ${this._maint_lm_form.item_name}`);
						this.$body.find("input[name='ef-maint-lm-modo']").prop("checked", false);
						this.$body.find(`input[name='ef-maint-lm-modo'][value='${this._maint_lm_form.modo_stock}']`).prop("checked", true);
						this._render_maint_lm_rows();
					},
				});
			},
		});
	}

	_clear_maint_lm_form() {
		this._maint_lm_form = { item_code: "", item_name: "", modo_stock: "", items: [], uid_counter: 0 };
		this.$body.find("#ef-maint-lm-padre-search").val("");
		this.$body.find("input[name='ef-maint-lm-modo']").prop("checked", false);
		this.$body.find("#ef-maint-lm-btn-delete").hide();
		this._render_maint_lm_rows();
	}

	_maint_lm_add_component(item_code, item_name) {
		if (!this._maint_lm_form) this._maint_lm_form = { item_code: "", item_name: "", modo_stock: "", items: [], uid_counter: 0 };
		if (!item_code) return;
		if (this._maint_lm_form.item_code && item_code === this._maint_lm_form.item_code) {
			frappe.show_alert({ message: "El producto padre no puede ser componente de sí mismo.", indicator: "orange" });
			return;
		}
		if (this._maint_lm_form.items.some((r) => r.item_code === item_code)) {
			frappe.show_alert({ message: "Ese componente ya fue agregado.", indicator: "orange" });
			return;
		}
		this._maint_lm_form.uid_counter += 1;
		this._maint_lm_form.items.push({ uid: this._maint_lm_form.uid_counter, item_code, item_name, qty: 1 });
		this._render_maint_lm_rows();
	}

	_render_maint_lm_rows() {
		const items = (this._maint_lm_form && this._maint_lm_form.items) || [];
		const $tbody = this.$body.find("#ef-maint-lm-tbody");
		if (!items.length) {
			$tbody.html('<tr><td colspan="3" style="text-align:center; color:#94a3b8; padding:14px;">Busque un producto arriba para agregarlo.</td></tr>');
			return;
		}
		$tbody.html(items.map((row) => `
			<tr data-row-id="${row.uid}">
				<td class="ef-td"><strong>${_esc(row.item_code)}</strong><br><span style="color:#64748b;font-size:11px;">${_esc(row.item_name || "")}</span></td>
				<td class="ef-td"><input type="number" min="0" step="any" class="ef-input ef-input-num ef-maint-lm-qty" style="width:100%" value="${row.qty}"></td>
				<td class="ef-td" style="text-align:center;"><span class="ef-maint-lm-remove" data-remove="${row.uid}" style="cursor:pointer;color:#ef4444;font-weight:700;">&times;</span></td>
			</tr>`).join(""));
	}

	_save_maint_lm() {
		const f = this._maint_lm_form;
		if (!f || !f.item_code) { frappe.show_alert({ message: "Seleccione el producto padre.", indicator: "orange" }); return; }
		if (!f.modo_stock) { frappe.show_alert({ message: "Seleccione el modo de manejo de stock.", indicator: "orange" }); return; }
		if (!f.items.length) { frappe.show_alert({ message: "Agregue al menos un componente.", indicator: "orange" }); return; }
		for (const row of f.items) {
			if (!(parseFloat(row.qty) > 0)) {
				frappe.show_alert({ message: `Cantidad inválida para '${row.item_code}'.`, indicator: "orange" });
				return;
			}
		}

		frappe.call({
			method: "facex_multi.api.item.save_lista_materiales",
			args: {
				item_code: f.item_code,
				modo_stock: f.modo_stock,
				items_json: JSON.stringify(f.items.map((r) => ({ item_code: r.item_code, qty: r.qty }))),
				company: this.doc.company || this.defaults.company || "",
			},
			freeze: true,
			freeze_message: "Guardando…",
			callback: (r) => {
				if (!r.message) return;
				frappe.show_alert({ message: "Lista de Materiales guardada.", indicator: "green" });
				this._clear_maint_lm_form();
				this._set_maint_lm_form_mode("search");
			},
		});
	}

	_delete_maint_lm() {
		const item_code = this._maint_lm_form && this._maint_lm_form.item_code;
		if (!item_code) return;
		frappe.confirm(
			`¿Quitar a <strong>${_esc(item_code)}</strong> de las Listas de Materiales? Volverá a ser un producto normal.`,
			() => {
				frappe.call({
					method: "facex_multi.api.item.disable_lista_materiales",
					args: { item_code, company: this.doc.company || this.defaults.company || "" },
					freeze: true,
					callback: (r) => {
						if (!r.message) return;
						frappe.show_alert({ message: "Lista de Materiales eliminada.", indicator: "green" });
						this._clear_maint_lm_form();
						this._set_maint_lm_form_mode("search");
					},
				});
			}
		);
	}

	// ── Prices Maintenance ──

	_load_maint_prices() {
		const $tbody = this.$body.find("#ef-maint-prices-tbody");
		const $status = this.$body.find("#ef-maint-prices-status");
		const plist = this.$body.find("#ef-maint-price-list-select").val();
		const txt = this.$body.find("#ef-maint-prices-f-nombre").val() || "";
		const codigo = this.$body.find("#ef-maint-prices-f-codigo").val() || "";
		const grupo = this.$body.find("#ef-maint-prices-f-grupo").val() || "";

		if (!plist) {
			$tbody.html('<tr><td colspan="7" style="text-align:center; padding:10px; color:#64748b;">Seleccione una Lista de Precios primero</td></tr>');
			this._update_maint_prices_selected_count();
			return;
		}

		$tbody.html('<tr><td colspan="7" style="text-align:center; padding:10px; color:#64748b;">Cargando precios...</td></tr>');

		frappe.call({
			method: "facex_multi.api.item.get_all_prices",
			args: { price_list: plist, txt, codigo, grupo, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				$tbody.empty();
				const items = r.message || [];
				$status.text(items.length ? `${items.length} producto(s).` : "");
				this.$body.find("#ef-maint-prices-select-all").prop("checked", false);
				if (items.length === 0) {
					$tbody.html('<tr><td colspan="7" style="text-align:center; padding:10px; color:#64748b;">Sin productos</td></tr>');
					this._update_maint_prices_selected_count();
					return;
				}
				items.forEach((it) => {
					const $row = $(`
						<tr class="ef-tr">
							<td class="ef-td" style="text-align:center;"><input type="checkbox" class="ef-price-chk" data-code="${_esc(it.item_code)}" /></td>
							<td class="ef-td font-weight-bold ef-lbl-code"></td>
							<td class="ef-td ef-lbl-name"></td>
							<td class="ef-td ef-lbl-group"></td>
							<td class="ef-td ef-lbl-uom"></td>
							<td class="ef-td" style="text-align:right;">
								<span style="font-size:12px; font-weight:600; color:#64748b; margin-right:4px;" class="ef-lbl-currency"></span>
								<input type="number" class="ef-input ef-input-num ef-price-input" style="width:120px; display:inline-block;" step="any" min="0" value="${it.price}" />
							</td>
							<td class="ef-td" style="text-align:center;">
								<button class="ef-btn ef-btn-sm ef-btn-primary ef-btn-save-price" style="padding:4px 10px; font-size:11px;">Guardar</button>
							</td>
						</tr>
					`);
					$row.find(".ef-lbl-code").text(it.item_code);
					$row.find(".ef-lbl-name").text(it.item_name);
					$row.find(".ef-lbl-group").text(it.item_group || "");
					$row.find(".ef-lbl-uom").text(it.stock_uom);
					$row.find(".ef-lbl-currency").text(it.currency || "GTQ");

					$row.find(".ef-price-chk").on("change", () => {
						this._update_maint_prices_selected_count();
					});

					$row.find(".ef-btn-save-price").on("click", () => {
						const priceVal = parseFloat($row.find(".ef-price-input").val()) || 0;
						frappe.call({
							method: "facex_multi.api.item.update_item_price",
							args: {
								item_code: it.item_code,
								rate: priceVal,
								price_list: plist,
								company: this.doc.company || this.defaults.company || ""
							},
							freeze: true,
							freeze_message: "Actualizando precio...",
							callback: (res) => {
								if (!res.exc) {
									frappe.show_alert({ message: `Precio actualizado para ${it.item_code} en ${plist}`, indicator: "green" });
								}
							}
						});
					});

					$tbody.append($row);
				});
				this._update_maint_prices_selected_count();
			}
		});
	}

	_update_maint_prices_selected_count() {
		const n = this.$body.find(".ef-price-chk:checked").length;
		this.$body.find("#ef-maint-prices-selected-count").text(`${n} seleccionado(s)`);
	}

	_export_maint_prices_excel(names) {
		const plist = this.$body.find("#ef-maint-price-list-select").val() || "";
		const company = this.doc.company || this.defaults.company || "";
		const url = `/api/method/facex_multi.api.item.export_item_prices_excel?names_json=${encodeURIComponent(JSON.stringify(names))}&price_list=${encodeURIComponent(plist)}&company=${encodeURIComponent(company)}`;
		window.open(url, "_blank");
	}

	_delete_maint_customer() {
		const name = this._current_maint_cust_name;
		if (!name) return;

		frappe.confirm(
			`¿Estás seguro de que deseas eliminar permanentemente el cliente <strong>${name}</strong>? Esta acción no se puede deshacer.`,
			() => {
				frappe.call({
					method: "facex_multi.api.item.delete_customer",
					args: { customer_name: name, company: this.doc.company || this.defaults.company || "" },
					freeze: true,
					freeze_message: "Eliminando cliente...",
					callback: (r) => {
						if (!r.exc) {
							frappe.show_alert({ message: "Cliente eliminado exitosamente", indicator: "green" });
							this._clear_maint_cust_form();
							this._set_maint_cust_form_mode("search");
						}
					}
				});
			}
		);
	}

	_delete_maint_item() {
		const code = this._current_maint_item_code;
		if (!code) return;

		frappe.confirm(
			`¿Estás seguro de que deseas eliminar permanentemente el producto con código <strong>${code}</strong>? Esta acción no se puede deshacer.`,
			() => {
				frappe.call({
					method: "facex_multi.api.item.delete_item",
					args: { item_code: code, company: this.doc.company || this.defaults.company || "" },
					freeze: true,
					freeze_message: "Eliminando producto...",
					callback: (r) => {
						if (!r.exc) {
							frappe.show_alert({ message: "Producto eliminado exitosamente", indicator: "green" });
							this._clear_maint_item_form();
							this._set_maint_item_form_mode("search");
						}
					}
				});
			}
		);
	}

	// ─── Supplier maintenance ───────────────────────────────────────────────

	_search_maint_suppliers() {
		const txt = (this.$body.find("#ef-maint-supp-search").val() || "").trim();
		const field = this.$body.find("#ef-maint-supp-search-field").val() || "nombre";

		if (!txt) {
			frappe.show_alert({ message: "Escriba un texto para buscar.", indicator: "orange" });
			return;
		}

		const filters = {};
		filters[field] = txt;
		this._open_maint_supp_browser(filters);
	}

	_view_all_maint_suppliers() {
		this.$body.find("#ef-maint-supp-search").val("");
		this._open_maint_supp_browser({});
	}

	_open_maint_supp_browser(filters) {
		this._maint_supp_browser_filters = Object.assign({ nombre: "", codigo: "", nit: "", telefono: "" }, filters);
		this._maint_supp_browser_start = 0;
		this._maint_supp_browser_selected = new Set();
		this._maint_supp_active_filter_key = null;
		if (this._maint_supp_browser_dialog) {
			this._maint_supp_browser_dialog.hide();
			this._maint_supp_browser_dialog = null;
		}
		this._fetch_and_render_maint_supp_page();
	}

	_fetch_and_render_maint_supp_page() {
		const filters = this._maint_supp_browser_filters;
		const start = this._maint_supp_browser_start;
		const $status = this.$body.find("#ef-maint-supp-search-status");
		$status.text("Buscando...");

		frappe.call({
			method: "facex_multi.api.purchase.search_suppliers_maintenance",
			args: {
				...filters,
				company: this.doc.company || this.defaults.company || "",
				start,
				page_length: EF_MAINT_SUPP_PAGE_LENGTH,
			},
			callback: (r) => {
				const res = r.message || { rows: [], total: 0 };
				$status.text(res.total ? `${res.total} resultado(s).` : "Sin resultados.");
				this._render_maint_supp_results_popup(res.rows, res.total, start);
			}
		});
	}

	_mark_all_maint_suppliers() {
		const filters = this._maint_supp_browser_filters;
		frappe.call({
			method: "facex_multi.api.purchase.search_suppliers_maintenance",
			args: {
				...filters,
				company: this.doc.company || this.defaults.company || "",
				start: 0,
				page_length: 5000,
			},
			freeze: true,
			freeze_message: "Marcando todos los resultados...",
			callback: (r) => {
				const res = r.message || { rows: [] };
				res.rows.forEach((s) => this._maint_supp_browser_selected.add(s.name));
				this._fetch_and_render_maint_supp_page();
			}
		});
	}

	_render_maint_supp_results_popup(rows, total, start) {
		const page_length = EF_MAINT_SUPP_PAGE_LENGTH;
		const totalPages = Math.max(1, Math.ceil(total / page_length));
		const currentPage = Math.floor(start / page_length) + 1;
		const filters = this._maint_supp_browser_filters;

		if (!this._maint_supp_browser_dialog) {
			const dialog = new frappe.ui.Dialog({
				title: "Resultados de búsqueda",
				size: "extra-large",
				fields: [{ fieldtype: "HTML", fieldname: "results_html" }],
				primary_action_label: "Exportar seleccionados a Excel",
				primary_action: () => {
					const selected = Array.from(this._maint_supp_browser_selected);
					if (!selected.length) {
						frappe.show_alert({ message: "Seleccione al menos un proveedor para exportar.", indicator: "orange" });
						return;
					}
					this._export_maint_suppliers_excel(selected);
				},
			});
			dialog.$wrapper.on("hidden.bs.modal", () => {
				this._maint_supp_browser_dialog = null;
				clearTimeout(this._maint_supp_filter_timer);
			});
			this._maint_supp_browser_dialog = dialog;
			dialog.show();
		}

		const dialog = this._maint_supp_browser_dialog;
		dialog.set_title(`Resultados de búsqueda (${total})`);

		const filterCell = (key) => `
			<td><input type="text" class="ef-input ef-supp-popup-filter" data-key="${key}"
				placeholder="Filtrar..." value="${_esc(filters[key] || "")}"
				style="width:100%; font-size:11px; padding:3px 6px;" /></td>
		`;

		const rowsHtml = rows.length ? rows.map((s) => `
			<tr>
				<td style="text-align:center;"><input type="checkbox" class="ef-supp-popup-chk" data-name="${_esc(s.name)}" ${this._maint_supp_browser_selected.has(s.name) ? "checked" : ""} /></td>
				<td>${_esc(s.supplier_name || "")}</td>
				<td>${_esc(s.name || "")}</td>
				<td>${_esc(s.tax_id || "")}</td>
				<td>${_esc(s.custom_telefono || "")}</td>
				<td>${_esc(s.custom_direccion || "")}</td>
				<td>${s.disabled ? '<span style="color:#ef4444;">Sí</span>' : "No"}</td>
				<td style="text-align:center;">
					<button class="ef-btn ef-btn-sm ef-btn-secondary ef-supp-popup-edit" data-name="${_esc(s.name)}">Editar</button>
				</td>
			</tr>
		`).join("") : `<tr><td colspan="8" style="text-align:center; padding:14px; color:#64748b;">Sin resultados con estos filtros.</td></tr>`;

		dialog.fields_dict.results_html.$wrapper.html(`
			<div style="overflow-x:auto;">
				<table class="ef-table" style="width:100%;">
					<thead>
						<tr>
							<th style="width:36px; text-align:center;"><input type="checkbox" id="ef-supp-popup-select-all" title="Seleccionar todos en esta página" /></th>
							<th>Nombre</th>
							<th>Código</th>
							<th>NIT / ID Fiscal</th>
							<th>Teléfono</th>
							<th>Dirección</th>
							<th>Deshabilitado</th>
							<th style="width:80px;"></th>
						</tr>
						<tr class="ef-cust-popup-filter-row">
							<td></td>
							${filterCell("nombre")}
							${filterCell("codigo")}
							${filterCell("nit")}
							${filterCell("telefono")}
							<td></td>
							<td></td>
							<td></td>
						</tr>
					</thead>
					<tbody>${rowsHtml}</tbody>
				</table>
			</div>
			<div style="display:flex; justify-content:space-between; align-items:center; margin-top:14px; flex-wrap:wrap; gap:8px;">
				<div>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-supp-popup-mark-all">Marcar todos (${total})</button>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-supp-popup-unmark-all">Desmarcar todos</button>
				</div>
				<div style="display:flex; align-items:center; gap:10px;">
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-supp-popup-prev" ${currentPage <= 1 ? "disabled" : ""}>&laquo; Anterior</button>
					<span style="font-size:12px; color:#64748b;">Página ${currentPage} de ${totalPages} &mdash; ${this._maint_supp_browser_selected.size} seleccionado(s)</span>
					<button class="ef-btn ef-btn-sm ef-btn-secondary" id="ef-supp-popup-next" ${currentPage >= totalPages ? "disabled" : ""}>Siguiente &raquo;</button>
				</div>
			</div>
		`);

		dialog.$wrapper.find("#ef-supp-popup-select-all").on("change", (e) => {
			const checked = $(e.target).prop("checked");
			dialog.$wrapper.find(".ef-supp-popup-chk").each((_, el) => {
				$(el).prop("checked", checked);
				const name = $(el).data("name");
				if (checked) this._maint_supp_browser_selected.add(name);
				else this._maint_supp_browser_selected.delete(name);
			});
			this._render_maint_supp_results_popup(rows, total, start);
		});

		dialog.$wrapper.find("tbody tr").on("click", (e) => {
			if ($(e.target).is("button, input") || $(e.target).closest("button").length) return;
			const $chk = $(e.currentTarget).find(".ef-supp-popup-chk");
			if (!$chk.length) return;
			$chk.prop("checked", !$chk.prop("checked")).trigger("change");
		});

		dialog.$wrapper.find(".ef-supp-popup-chk").on("change", (e) => {
			const name = $(e.currentTarget).data("name");
			if ($(e.currentTarget).prop("checked")) this._maint_supp_browser_selected.add(name);
			else this._maint_supp_browser_selected.delete(name);
			dialog.$wrapper.find("#ef-supp-popup-prev, #ef-supp-popup-next").siblings("span")
				.text(`Página ${currentPage} de ${totalPages} — ${this._maint_supp_browser_selected.size} seleccionado(s)`);
		});

		dialog.$wrapper.find(".ef-supp-popup-edit").on("click", (e) => {
			e.stopPropagation();
			const name = $(e.currentTarget).data("name");
			dialog.hide();
			this._maint_supp_browser_dialog = null;
			this._load_maint_supp_form(name);
		});

		dialog.$wrapper.find("#ef-supp-popup-prev").on("click", () => {
			this._maint_supp_browser_start = Math.max(0, start - page_length);
			this._fetch_and_render_maint_supp_page();
		});
		dialog.$wrapper.find("#ef-supp-popup-next").on("click", () => {
			this._maint_supp_browser_start = start + page_length;
			this._fetch_and_render_maint_supp_page();
		});

		dialog.$wrapper.find("#ef-supp-popup-mark-all").on("click", () => {
			this._mark_all_maint_suppliers();
		});
		dialog.$wrapper.find("#ef-supp-popup-unmark-all").on("click", () => {
			this._maint_supp_browser_selected.clear();
			this._render_maint_supp_results_popup(rows, total, start);
		});

		dialog.$wrapper.find(".ef-supp-popup-filter").on("input", (e) => {
			const key = $(e.currentTarget).data("key");
			this._maint_supp_browser_filters[key] = $(e.currentTarget).val();
			this._maint_supp_active_filter_key = key;
			clearTimeout(this._maint_supp_filter_timer);
			this._maint_supp_filter_timer = setTimeout(() => {
				this._maint_supp_browser_start = 0;
				this._fetch_and_render_maint_supp_page();
			}, 350);
		});

		if (this._maint_supp_active_filter_key) {
			const $input = dialog.$wrapper.find(`.ef-supp-popup-filter[data-key="${this._maint_supp_active_filter_key}"]`);
			if ($input.length) {
				$input.trigger("focus");
				const val = $input.val() || "";
				$input[0].setSelectionRange(val.length, val.length);
			}
		}
	}

	_export_maint_suppliers_excel(names) {
		const company = this.doc.company || this.defaults.company || "";
		const url = `/api/method/facex_multi.api.purchase.export_suppliers_excel?names_json=${encodeURIComponent(JSON.stringify(names))}&company=${encodeURIComponent(company)}`;
		window.open(url, "_blank");
	}

	_set_maint_supp_form_mode(mode) {
		this._maint_supp_mode = mode;
		const enable = mode !== "search";

		this.$body.find(
			"#ef-maint-supp-name, #ef-maint-supp-nit, #ef-maint-supp-phone, #ef-maint-supp-address"
		).prop("disabled", !enable);

		const $save = this.$body.find("#ef-maint-supp-btn-save");
		const $delete = this.$body.find("#ef-maint-supp-btn-delete");

		if (mode === "search") {
			$save.hide();
			$delete.hide();
			this.$body.find("#ef-maint-supp-form-title").text("Búsqueda de proveedores");
		} else if (mode === "create") {
			$save.show();
			$delete.hide();
			this.$body.find("#ef-maint-supp-form-title").text("Nuevo Proveedor");
		} else if (mode === "edit") {
			$save.show();
			if (this.perms.modifica_proveedores) $delete.show(); else $delete.hide();
		}
	}

	_clear_maint_supp_form() {
		this._current_maint_supp = "";
		this.$body.find("#ef-maint-supp-name").val("");
		this.$body.find("#ef-maint-supp-nit").val("");
		this.$body.find("#ef-maint-supp-phone").val("");
		this.$body.find("#ef-maint-supp-address").val("");
		this.$body.find("#ef-maint-supp-btn-delete").hide();
	}

	_load_maint_supp_form(name) {
		const company = this.doc.company || this.defaults.company || "";
		frappe.call({
			method: "facex_multi.api.purchase.get_supplier",
			args:   { name, company },
			callback: (r) => {
				if (r.exc || !r.message) return;
				const d = r.message;
				this._current_maint_supp = d.name;
				this._set_maint_supp_form_mode("edit");
				this.$body.find("#ef-maint-supp-form-title").text(`Editar: ${d.supplier_name}`);
				this.$body.find("#ef-maint-supp-name").val(d.supplier_name);
				this.$body.find("#ef-maint-supp-nit").val(d.tax_id || "");
				this.$body.find("#ef-maint-supp-phone").val(d.custom_telefono || "");
				this.$body.find("#ef-maint-supp-address").val(d.custom_direccion || "");
			},
		});
	}

	_save_maint_supplier() {
		const supplier_name = this.$body.find("#ef-maint-supp-name").val().trim();
		if (!supplier_name) {
			frappe.msgprint({ message: "El nombre del proveedor es obligatorio.", indicator: "orange" });
			return;
		}
		const company = this.doc.company || this.defaults.company || "";
		const data = {
			name:             this._current_maint_supp || "",
			supplier_name,
			tax_id:           this.$body.find("#ef-maint-supp-nit").val().trim(),
			custom_telefono:  this.$body.find("#ef-maint-supp-phone").val().trim(),
			custom_direccion: this.$body.find("#ef-maint-supp-address").val().trim(),
		};
		frappe.call({
			method: "facex_multi.api.purchase.create_or_update_supplier",
			args:   { data_json: JSON.stringify(data), company },
			freeze: true, freeze_message: "Guardando proveedor...",
			callback: (r) => {
				if (!r.exc && r.message) {
					frappe.show_alert({ message: `Proveedor <strong>${r.message.supplier_name}</strong> guardado.`, indicator: "green" });
					this._clear_maint_supp_form();
					this._set_maint_supp_form_mode("search");
				}
			},
		});
	}

	_delete_maint_supplier() {
		const name = this._current_maint_supp;
		if (!name) return;
		frappe.confirm(
			`¿Eliminar el proveedor <strong>${_esc(name)}</strong>? Esta acción no se puede deshacer.`,
			() => {
				frappe.call({
					method: "frappe.client.delete",
					args:   { doctype: "Supplier", name },
					freeze: true, freeze_message: "Eliminando proveedor...",
					callback: (r) => {
						if (!r.exc) {
							frappe.show_alert({ message: "Proveedor eliminado.", indicator: "green" });
							this._clear_maint_supp_form();
							this._set_maint_supp_form_mode("search");
						}
					},
				});
			}
		);
	}

	// ═══════════════════════════════════════════════════════════════════════
	// MÓDULO DE COMPRAS
	// ═══════════════════════════════════════════════════════════════════════

	_init_purchase_view() {
		// Solo inicializar eventos una vez
		if (this._purch_events_bound) {
			this._show_purch_list();
			return;
		}
		this._purch_events_bound = true;
		this._purch_doc          = this._empty_purch_doc();
		this._purch_defaults     = null;
		this._purch_warehouses   = [];

		// Cargar defaults de compra
		frappe.call({
			method: "facex_multi.api.purchase.get_purchase_defaults",
			args:   { company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				if (!r.exc && r.message) {
					this._purch_defaults = r.message;
					// Set default dates
					const today = frappe.datetime.get_today();
					this.$body.find("#ef-purch-posting-date").val(today);
					this.$body.find("#ef-purch-bill-date").val(today);
					this.$body.find("#ef-purch-f-start").val(frappe.datetime.month_start());
					this.$body.find("#ef-purch-f-end").val(today);
					this._populate_purch_tax_selects();
					this._populate_purch_tipo_selects();
					if (this._purch_doc) this._purch_doc.tax_type = r.message.default_tax_template || "";
				}
			},
		});

		// Cargar almacenes de la compañía conectada para el grid de líneas
		frappe.call({
			method: "facex_multi.api.invoice.get_warehouses",
			args:   { company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				if (!r.exc && r.message) {
					this._purch_warehouses = r.message;
					this._render_purch_items();
				}
			},
		});

		// Set default dates on first open
		const today = frappe.datetime.get_today();
		this.$body.find("#ef-purch-f-start").val(frappe.datetime.month_start());
		this.$body.find("#ef-purch-f-end").val(today);
		this.$body.find("#ef-purch-posting-date").val(today);
		this.$body.find("#ef-purch-bill-date").val(today);

		// Eventos lista
		this.$body.on("click", "#ef-purch-btn-new",    () => this._new_purch());
		this.$body.on("click", "#ef-purch-btn-excel",  () => this._show_excel_dialog());
		this.$body.on("click", "#ef-purch-btn-filter", () => this._load_purch_list());
		this.$body.on("click", "#ef-purch-btn-back",         () => this._show_purch_list());
		this.$body.on("click", "#ef-purch-stg-back",         () => this._show_purch_list());
		this.$body.on("click", "#ef-purch-stg-revalidate",   () => this._stg_revalidate());
		this.$body.on("click", "#ef-purch-stg-confirm",      () => this._stg_confirm());

		// Eventos formulario
		this.$body.on("click",  "#ef-purch-btn-add-item",  () => this._add_purch_item());
		this.$body.on("click",  "#ef-purch-btn-save",      () => this._save_purch());
		this.$body.on("click",  "#ef-purch-btn-submit",    () => this._submit_purch());
		this.$body.on("click",  "#ef-purch-btn-cancel-doc",() => this._cancel_purch());

		// Supplier autocomplete
		this.$body.on("input", "#ef-purch-supplier", (e) => {
			const txt = e.target.value;
			clearTimeout(this._purch_supplier_timer);
			this._purch_supplier_timer = setTimeout(() => {
				if (txt.length < 1) return;
				const company = this.doc.company || this.defaults.company || "";
				frappe.call({
					method: "facex_multi.api.purchase.search_suppliers",
					args:   { txt, company },
					callback: (r) => {
						if (!r.exc && r.message) this._show_supplier_suggestions(r.message);
					},
				});
			}, 300);
		});

		this._show_purch_list();
	}

	_empty_purch_doc() {
		return {
			name: null, docstatus: 0,
			supplier: "", posting_date: frappe.datetime.get_today(),
			bill_no: "", bill_date: frappe.datetime.get_today(),
			currency: "GTQ",
			tax_type: (this._purch_defaults && this._purch_defaults.default_tax_template) || "",
			bfel_multi_tipo: "",
			items: [],
		};
	}

	_show_purch_list() {
		this.$body.find("#ef-purch-list-section").show();
		this.$body.find("#ef-purch-form-section").hide();
		this.$body.find("#ef-purch-staging-section").hide();
		this._load_purch_list();
	}

	_show_purch_form() {
		this.$body.find("#ef-purch-list-section").hide();
		this.$body.find("#ef-purch-staging-section").hide();
		this.$body.find("#ef-purch-form-section").show();
	}

	_show_purch_staging() {
		this.$body.find("#ef-purch-list-section").hide();
		this.$body.find("#ef-purch-form-section").hide();
		this.$body.find("#ef-purch-staging-section").show();
	}

	_load_purch_list() {
		const company    = this.doc.company || this.defaults.company || "";
		const start_date = this.$body.find("#ef-purch-f-start").val();
		const end_date   = this.$body.find("#ef-purch-f-end").val();
		const supplier   = this.$body.find("#ef-purch-f-supplier").val();
		const docstatus  = this.$body.find("#ef-purch-f-status").val();

		frappe.call({
			method: "facex_multi.api.purchase.get_purchase_list",
			args:   { company, start_date, end_date, supplier, docstatus },
			freeze: true, freeze_message: "Cargando compras...",
			callback: (r) => {
				if (!r.exc) this._render_purch_list(r.message || []);
			},
		});
	}

	_render_purch_list(rows) {
		const $body  = this.$body.find("#ef-purch-list-body");
		const $empty = this.$body.find("#ef-purch-list-empty");
		$body.empty();
		if (!rows.length) { $empty.show(); return; }
		$empty.hide();

		const STATUS = { 0: ["Borrador","#f59e0b"], 1: ["Validado","#10b981"], 2: ["Cancelado","#ef4444"] };
		rows.forEach(inv => {
			const [label, color] = STATUS[inv.docstatus] || ["?", "#888"];
			const currency = inv.currency || "GTQ";
			$body.append(`<tr class="ef-tr" style="cursor:pointer" data-pi="${_esc(inv.name)}">
				<td class="ef-td" style="font-weight:600;color:#1e3a5f">${_esc(inv.name)}</td>
				<td class="ef-td">${_esc(inv.supplier)}</td>
				<td class="ef-td">${inv.posting_date || ""}</td>
				<td class="ef-td">${_esc(inv.bill_no || "")}</td>
				<td class="ef-td ef-td-num">${_fmtCurrency(inv.grand_total, currency)}</td>
				<td class="ef-td"><span style="background:${color}22;color:${color};border-radius:20px;padding:2px 10px;font-size:11px;font-weight:600">${label}</span></td>
				<td class="ef-td"><button class="ef-btn ef-btn-sm ef-btn-secondary ef-purch-open" data-pi="${_esc(inv.name)}">Abrir</button></td>
			</tr>`);
		});

		$body.off("click", ".ef-purch-open").on("click", ".ef-purch-open", (e) => {
			e.stopPropagation();
			this._load_purch_form($(e.currentTarget).data("pi"));
		});
		$body.off("click", "tr[data-pi]").on("click", "tr[data-pi]", (e) => {
			if (!$(e.target).hasClass("ef-purch-open")) {
				this._load_purch_form($(e.currentTarget).data("pi"));
			}
		});
	}

	_new_purch() {
		this._purch_doc = this._empty_purch_doc();
		const today = frappe.datetime.get_today();
		this.$body.find("#ef-purch-supplier").val("");
		this.$body.find("#ef-purch-bill-no").val("");
		this.$body.find("#ef-purch-bill-date").val(today);
		this.$body.find("#ef-purch-posting-date").val(today);
		this.$body.find("#ef-purch-currency").val("GTQ");
		this._populate_purch_tax_selects();
		this._populate_purch_tipo_selects();
		this.$body.find("#ef-purch-tax-type").val(this._purch_doc.tax_type || "");
		this.$body.find("#ef-purch-tipo").val(this._purch_doc.bfel_multi_tipo || "");
		this.$body.find("#ef-purch-supplier,#ef-purch-bill-no,#ef-purch-bill-date,#ef-purch-posting-date,#ef-purch-currency,#ef-purch-tax-type,#ef-purch-tipo")
			.prop("disabled", false);
		this.$body.find("#ef-purch-form-title").text("Nueva Factura de Compra");
		this.$body.find("#ef-purch-status-badge").text("NUEVO").attr("class","ef-badge ef-badge-new");
		this.$body.find("#ef-purch-btn-cancel-doc").hide();
		this.$body.find("#ef-purch-btn-save,#ef-purch-btn-submit,#ef-purch-btn-add-item").show().prop("disabled", false);
		this.$body.find("#ef-purch-btn-open-erp").hide();
		this._render_purch_items();
		this._show_purch_form();
	}

	_load_purch_form(name) {
		frappe.call({
			method: "facex_multi.api.purchase.get_purchase_invoice",
			args:   { name },
			freeze: true, freeze_message: "Cargando factura de compra...",
			callback: (r) => {
				if (r.exc || !r.message) return;
				const d = r.message;
				this._purch_doc = {
					name:         d.name,
					docstatus:    d.docstatus,
					supplier:     d.supplier,
					posting_date: d.posting_date,
					bill_no:      d.bill_no,
					bill_date:    d.bill_date,
					currency:     d.currency || "GTQ",
					tax_type:     d.taxes_and_charges || "",
					bfel_multi_tipo: d.bfel_multi_tipo || "",
					items: (d.items || []).map(it => ({
						item_code:    it.item_code,
						item_name:    it.item_name || it.item_code,
						has_serial_no: it.has_serial_no || 0,
						is_stock_item: it.is_stock_item || 1,
						qty:          it.qty,
						rate:         it.rate,
						amount:       it.amount || (parseFloat(it.qty || 0) * parseFloat(it.rate || 0)),
						warehouse:    it.warehouse || "",
						bfel_multi_tipo: it.bfel_multi_tipo || "",
						serial_no:    it.serial_no || "",
						update_stock: it.is_stock_item !== 0 ? 1 : 0,
						_fetched:     true,
					})),
				};

				const STATUS_LABELS = { 0:["BORRADOR","ef-badge-draft"], 1:["VALIDADO","ef-badge-submitted"], 2:["CANCELADO","ef-badge-cancelled"] };
				const [lbl, cls] = STATUS_LABELS[d.docstatus] || ["?",""];
				this.$body.find("#ef-purch-form-title").text(`Factura de Compra: ${d.name}`);
				this.$body.find("#ef-purch-status-badge").text(lbl).attr("class",`ef-badge ${cls}`);
				this.$body.find("#ef-purch-supplier").val(d.supplier);
				this.$body.find("#ef-purch-bill-no").val(d.bill_no || "");
				this.$body.find("#ef-purch-bill-date").val(d.bill_date || "");
				this.$body.find("#ef-purch-posting-date").val(d.posting_date || "");
				this.$body.find("#ef-purch-currency").val(d.currency || "GTQ");
				this._populate_purch_tax_selects();
				this._populate_purch_tipo_selects();
				this.$body.find("#ef-purch-tax-type").val(this._purch_doc.tax_type || "");
				this.$body.find("#ef-purch-tipo").val(this._purch_doc.bfel_multi_tipo || "");

				const isEditable = d.docstatus === 0;
				this.$body.find("#ef-purch-btn-save,#ef-purch-btn-add-item").toggle(isEditable);
				this.$body.find("#ef-purch-btn-submit").toggle(isEditable && !!this.perms.puede_validar_compras);
				this.$body.find("#ef-purch-btn-cancel-doc").toggle(d.docstatus === 1 && !!this.perms.puede_cancelar_compras);
				this.$body.find("#ef-purch-btn-open-erp").toggle(!!d.name).attr("href", `/app/purchase-invoice/${encodeURIComponent(d.name)}`);
				this.$body.find("#ef-purch-supplier,#ef-purch-bill-no,#ef-purch-bill-date,#ef-purch-posting-date,#ef-purch-currency,#ef-purch-tax-type,#ef-purch-tipo")
					.prop("disabled", !isEditable);

				this._render_purch_items();
				this._show_purch_form();
			},
		});
	}

	_render_purch_items() {
		const items  = this._purch_doc.items || [];
		const $tbody = this.$body.find("#ef-purch-items-body");
		const $empty = this.$body.find("#ef-purch-items-empty");
		$tbody.empty();

		if (!items.length) { $empty.show(); } else { $empty.hide(); }

		const isEditable = this._purch_doc.docstatus === 0;
		const currency   = this._purch_doc.currency || "GTQ";

		// 11 columns: # | Código | Descripción/Series | Cant | UdM | Precio | Total | Bodega | Tipo FEL | Stock | Del
		items.forEach((it, idx) => {
			const serialBlock = it.has_serial_no
				? `<div style="margin-top:5px;border-top:1px dashed #e2e8f0;padding-top:4px">
					<div style="font-size:10px;font-weight:600;color:#64748b;margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em">
						Nos. de Serie <span style="font-weight:400;color:#94a3b8">(una por línea)</span>
					</div>
					<textarea id="ef-pi-serial-${idx}" class="ef-pi-serial" data-idx="${idx}" rows="3"
						style="width:100%;font-size:11px;font-family:monospace;resize:vertical;border:1px solid #cbd5e1;border-radius:4px;padding:4px 6px;box-sizing:border-box;background:${isEditable ? "#f8fafc" : "#f1f5f9"}"
						placeholder="Escribe un serial por línea..."
						${!isEditable ? "disabled" : ""}>${_esc(it.serial_no || "")}</textarea>
				  </div>`
				: "";

			const qtyCell = it.has_serial_no
				? `<div style="text-align:center">
					<span id="ef-pi-qty-${idx}" style="font-size:18px;font-weight:800;color:#1e3a5f;display:block;line-height:1">${it.qty || 0}</span>
					<span style="font-size:9px;color:#94a3b8;text-transform:uppercase">series</span>
				   </div>`
				: `<input type="number" class="ef-cell-input ef-input-num ef-pi-qty" data-idx="${idx}"
					value="${it.qty || 1}" min="1" step="1"
					style="width:56px;text-align:right;font-weight:700"
					${!isEditable ? "disabled" : ""}>`;

			const stockCell = it.has_serial_no
				? `<div style="text-align:center;font-size:10px;color:#94a3b8">auto</div>`
				: `<div style="text-align:center">
					<input type="checkbox" class="ef-pi-stock" data-idx="${idx}"
						title="${it.is_stock_item ? "Actualizar inventario" : "No es ítem de inventario"}"
						${it.update_stock ? "checked" : ""}
						${(!isEditable || !it.is_stock_item) ? "disabled" : ""}
						style="cursor:${isEditable && it.is_stock_item ? "pointer" : "default"};width:15px;height:15px">
				   </div>`;

			const $tr = $(`<tr class="ef-tr" style="vertical-align:top">
				<td class="ef-td ef-td-idx" style="padding-top:10px">${idx + 1}</td>
				<td class="ef-td" style="font-weight:700;font-size:12px;color:#1e3a5f;padding-top:10px">${_esc(it.item_code)}</td>
				<td class="ef-td" style="font-size:12px">
					<div style="color:#334155;font-weight:500">${_esc(it.item_name || it.item_code)}</div>
					${serialBlock}
				</td>
				<td class="ef-td" style="padding-top:10px">${qtyCell}</td>
				<td class="ef-td" style="padding-top:10px;font-size:12px;color:#64748b">${_esc(it.uom || "")}</td>
				<td class="ef-td" style="padding-top:8px">
					<input type="number" class="ef-cell-input ef-input-num ef-pi-rate" data-idx="${idx}"
						value="${parseFloat(it.rate || 0).toFixed(2)}" min="0" step="any"
						style="width:96px;text-align:right" ${!isEditable ? "disabled" : ""}>
				</td>
				<td class="ef-td ef-td-num" id="ef-pi-amount-${idx}" style="padding-top:10px;font-weight:700">
					${_fmtCurrency((it.qty || 0) * (it.rate || 0), currency)}
				</td>
				<td class="ef-td" style="padding-top:8px">
					<select class="ef-cell-input ef-pi-wh" data-idx="${idx}"
						style="width:138px;font-size:11px" ${!isEditable ? "disabled" : ""}>
						<option value="">Bodega...</option>
						${(this._purch_warehouses || []).map(w => `<option value="${_esc(w)}"${it.warehouse === w ? ' selected' : ''}>${_esc(w)}</option>`).join('')}
						${(it.warehouse && !(this._purch_warehouses || []).includes(it.warehouse))
							? `<option value="${_esc(it.warehouse)}" selected>${_esc(it.warehouse)}</option>`
							: ''}
					</select>
				</td>
				<td class="ef-td" style="padding-top:8px">
					<select class="ef-cell-input ef-pi-tipo" data-idx="${idx}"
						style="width:145px;font-size:11px" ${!isEditable ? "disabled" : ""}>
						${_purchTipoOptionsHtml(it.bfel_multi_tipo || "")}
					</select>
				</td>
				<td class="ef-td" style="padding-top:10px">${stockCell}</td>
				<td class="ef-td" style="padding-top:8px">
					${isEditable ? `<button class="ef-btn-del ef-pi-del" data-idx="${idx}" title="Eliminar">×</button>` : ""}
				</td>
			</tr>`);

			$tbody.append($tr);
		});

		this._bind_purch_item_events();
		this._update_purch_totals();
	}

	_bind_purch_item_events() {
		// Usar delegación desde $tbody para no perder eventos tras re-renders parciales
		const $tbody = this.$body.find("#ef-purch-items-body");

		$tbody.off("input change click").on("input change", ".ef-pi-qty", (e) => {
			const idx = parseInt($(e.target).data("idx"));
			const it  = this._purch_doc.items[idx];
			if (!it) return;
			it.qty    = parseFloat(e.target.value) || 1;
			it.amount = it.qty * it.rate;
			this.$body.find(`#ef-pi-amount-${idx}`).text(_fmtCurrency(it.amount, this._purch_doc.currency));
			this._update_purch_totals();
		}).on("input change", ".ef-pi-rate", (e) => {
			const idx = parseInt($(e.target).data("idx"));
			const it  = this._purch_doc.items[idx];
			if (!it) return;
			it.rate   = parseFloat(e.target.value) || 0;
			it.amount = it.qty * it.rate;
			this.$body.find(`#ef-pi-amount-${idx}`).text(_fmtCurrency(it.amount, this._purch_doc.currency));
			this._update_purch_totals();
		}).on("input change", ".ef-pi-wh", (e) => {
			const idx = parseInt($(e.target).data("idx"));
			const it  = this._purch_doc.items[idx];
			if (it) it.warehouse = e.target.value;
		}).on("change", ".ef-pi-tipo", (e) => {
			const idx = parseInt($(e.target).data("idx"));
			const it  = this._purch_doc.items[idx];
			if (it) it.bfel_multi_tipo = e.target.value;
		}).on("change", ".ef-pi-stock", (e) => {
			const idx = parseInt($(e.target).data("idx"));
			const it  = this._purch_doc.items[idx];
			if (it) it.update_stock = e.target.checked ? 1 : 0;
		}).on("input", ".ef-pi-serial", (e) => {
			const idx     = parseInt($(e.target).data("idx"));
			const it      = this._purch_doc.items[idx];
			if (!it) return;
			const serials = e.target.value.split("\n").map(s => s.trim()).filter(Boolean);
			it.serial_no  = serials.join("\n");
			it.qty        = serials.length || 1;
			this.$body.find(`#ef-pi-qty-${idx}`).text(it.qty);
			it.amount = it.qty * it.rate;
			this.$body.find(`#ef-pi-amount-${idx}`).text(_fmtCurrency(it.amount, this._purch_doc.currency));
			this._update_purch_totals();
		}).on("click", ".ef-pi-del", (e) => {
			const idx = parseInt($(e.currentTarget).data("idx"));
			this._purch_doc.items.splice(idx, 1);
			this._render_purch_items();
		});
	}

	// Puebla los selects de "Tipo de Compra" con las plantillas de impuestos
	// reales y activas de la compañía conectada (en vez de categorías fijas
	// normal/exento/importación que no siempre existen como plantilla real).
	_populate_purch_tax_selects() {
		const templates = (this._purch_defaults && this._purch_defaults.tax_templates) || [];
		const options = templates.length
			? templates.map(t => `<option value="${_esc(t.name)}">${_esc(t.name)} (${t.rate}%)</option>`).join('')
			: `<option value="">Sin plantilla de impuestos configurada</option>`;
		["#ef-purch-tax-type", "#ef-stg-tax-type"].forEach(sel => {
			const $sel = this.$body.find(sel);
			const current = $sel.val();
			$sel.html(options);
			if (current && templates.some(t => t.name === current)) $sel.val(current);
		});
	}

	// Puebla los selects de "Tipo FEL" (bfel_multi_tipo) de encabezado, tanto
	// en el formulario normal como en el de staging (importación desde Excel).
	_populate_purch_tipo_selects() {
		["#ef-purch-tipo", "#ef-stg-tipo"].forEach(sel => {
			const $sel = this.$body.find(sel);
			const current = $sel.val();
			$sel.html(_purchTipoOptionsHtml(current || ""));
		});
	}

	_update_purch_totals() {
		const items     = this._purch_doc.items || [];
		const currency  = this._purch_doc.currency || "GTQ";
		const templates = (this._purch_defaults && this._purch_defaults.tax_templates) || [];
		const selected  = templates.find(t => t.name === this._purch_doc.tax_type);
		const subtotal  = items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
		const taxRate   = selected ? (parseFloat(selected.rate) || 0) / 100 : 0;
		const tax       = subtotal * taxRate;
		const grand     = subtotal + tax;
		const taxPct    = Math.round(taxRate * 100);
		this.$body.find("#ef-purch-tax-label").text(taxPct > 0 ? `Impuesto (${taxPct}%)` : "Impuesto (0%)");
		this.$body.find("#ef-purch-subtotal").text(_fmtCurrency(subtotal, currency));
		this.$body.find("#ef-purch-tax").text(_fmtCurrency(tax, currency));
		this.$body.find("#ef-purch-grand").text(_fmtCurrency(grand, currency));
	}

	_add_purch_item() {
		const company = this.doc.company || this.defaults.company || "";
		let _selectedItem = null;

		const dlg = new frappe.ui.Dialog({
			title: "Agregar Producto",
			fields: [
				{
					fieldtype: "HTML",
					options: `<div style="margin-bottom:8px">
						<label class="ef-label" style="display:block;margin-bottom:4px">Buscar Producto *</label>
						<input id="ef-pi-add-search" type="text" class="ef-cell-input" style="width:100%" placeholder="Escribe código o nombre del producto..."/>
						<div id="ef-pi-add-results" style="border:1px solid #e2e8f0;border-radius:6px;max-height:200px;overflow-y:auto;display:none;background:#fff;box-shadow:0 4px 12px rgba(0,0,0,.08);margin-top:2px"></div>
						<div id="ef-pi-add-selected" style="display:none;margin-top:6px;padding:8px 10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;font-size:12px;color:#0369a1"></div>
					</div>`,
				},
				{ fieldtype: "Float",    fieldname: "rate", label: "Precio Unitario *", reqd: 1, default: 0 },
				{ fieldtype: "Int",      fieldname: "qty",  label: "Cantidad (para ítems sin serie)",  default: 1 },
			],
			primary_action_label: "Agregar",
			primary_action: (vals) => {
				if (!_selectedItem) {
					frappe.msgprint({ message: "Selecciona un producto de la lista.", indicator: "orange" });
					return;
				}
				const info = _selectedItem;
				const qty  = info.has_serial_no ? 0 : (parseInt(vals.qty) || 1);
				const rate = parseFloat(vals.rate) || 0;
				this._purch_doc.items.push({
					item_code:     info.item_code,
					item_name:     info.item_name,
					item_group:    info.item_group,
					has_serial_no: info.has_serial_no,
					is_stock_item: info.is_stock_item,
					qty,
					rate,
					amount:       qty * rate,
					uom:          info.uom,
					warehouse:    info.warehouse,
					bfel_multi_tipo: this._purch_doc.bfel_multi_tipo || "",
					serial_no:    "",
					update_stock: info.is_stock_item ? 1 : 0,
					_fetched:     true,
				});
				this._render_purch_items();
				dlg.hide();
			},
		});

		dlg.show();

		// Activar búsqueda con debounce
		const $search  = dlg.$wrapper.find("#ef-pi-add-search");
		const $results = dlg.$wrapper.find("#ef-pi-add-results");
		const $sel     = dlg.$wrapper.find("#ef-pi-add-selected");

		$search.on("input", () => {
			const txt = $search.val().trim();
			clearTimeout(this._pi_search_timer);
			if (txt.length < 1) { $results.hide().empty(); return; }

			this._pi_search_timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.purchase.search_items",
					args:   { txt, company },
					callback: (r) => {
						$results.empty();
						if (r.exc || !r.message || !r.message.length) {
							$results.hide();
							return;
						}
						r.message.forEach(it => {
							const badge = it.has_serial_no
								? `<span style="background:#fef3c7;color:#92400e;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px">Serie</span>`
								: it.is_stock_item
									? `<span style="background:#dcfce7;color:#15803d;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px">Stock</span>`
									: `<span style="background:#f1f5f9;color:#64748b;border-radius:4px;padding:1px 5px;font-size:10px;margin-left:4px">Servicio</span>`;
							const $row = $(`<div class="ef-pi-add-res-row" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:12px;display:flex;justify-content:space-between;align-items:center">
								<div>
									<strong style="color:#1e3a5f">${_esc(it.item_code)}</strong>${badge}<br>
									<span style="color:#64748b">${_esc(it.item_name)}</span>
								</div>
								<span style="font-size:11px;color:#94a3b8">${_esc(it.item_group || "")}</span>
							</div>`);
							$row.on("mouseenter", () => $row.css("background","#f8fafc"));
							$row.on("mouseleave", () => $row.css("background",""));
							$row.on("click", () => {
								_selectedItem = it;
								$search.val(it.item_code);
								$results.hide().empty();
								$sel.html(`<strong>${_esc(it.item_code)}</strong> – ${_esc(it.item_name)}
									${it.has_serial_no ? " <em>(maneja series)</em>" : ""}
									${it.warehouse ? ` · Bodega: <strong>${_esc(it.warehouse)}</strong>` : ""}`)
									.show();
								// Si es serial, ocultamos el campo qty
								dlg.set_df_property("qty", "hidden", !!it.has_serial_no);
								$search.trigger("blur");
							});
							$results.append($row);
						});
						$results.show();
					},
				});
			}, 280);
		});

		$(document).on("click.piadddlg", (e) => {
			if (!$(e.target).closest("#ef-pi-add-results, #ef-pi-add-search").length) {
				$results.hide();
				$(document).off("click.piadddlg");
			}
		});
	}

	_validate_purch() {
		const d      = this._purch_doc;
		const errors = [];
		if (!d.supplier)    errors.push("Proveedor es obligatorio.");
		if (!d.bill_no)     errors.push("Número de factura del proveedor es obligatorio.");
		if (!d.bill_date)   errors.push("Fecha de factura del proveedor es obligatoria.");
		if (!d.items.length) errors.push("Agregue al menos un producto.");

		d.items.forEach((it, i) => {
			const n = i + 1;
			if (!it.rate || it.rate <= 0)
				errors.push(`Línea ${n} (${it.item_code}): el precio debe ser mayor a 0.`);
			if (it.has_serial_no) {
				const serials = (it.serial_no || "").split("\n").map(s => s.trim()).filter(Boolean);
				if (!serials.length)
					errors.push(`Línea ${n} (${it.item_code}): ingrese al menos un número de serie.`);
				else if (serials.length !== it.qty && it.qty > 0)
					errors.push(`Línea ${n} (${it.item_code}): la cantidad (${it.qty}) no coincide con los seriales ingresados (${serials.length}).`);
			} else if (!it.qty || it.qty <= 0) {
				errors.push(`Línea ${n} (${it.item_code}): la cantidad debe ser mayor a 0.`);
			}
			if (it.is_stock_item && it.update_stock && !it.warehouse)
				errors.push(`Línea ${n} (${it.item_code}): bodega requerida para ítem de inventario.`);
		});
		return errors;
	}

	_read_purch_form_to_doc() {
		this._purch_doc.supplier     = this.$body.find("#ef-purch-supplier").val().trim();
		this._purch_doc.bill_no      = this.$body.find("#ef-purch-bill-no").val().trim();
		this._purch_doc.bill_date    = this.$body.find("#ef-purch-bill-date").val();
		this._purch_doc.posting_date = this.$body.find("#ef-purch-posting-date").val();
		this._purch_doc.currency     = this.$body.find("#ef-purch-currency").val();
		this._purch_doc.tax_type     = this.$body.find("#ef-purch-tax-type").val();
		this._purch_doc.bfel_multi_tipo = this.$body.find("#ef-purch-tipo").val();
	}

	_save_purch() {
		this._read_purch_form_to_doc();
		const errors = this._validate_purch();
		if (errors.length) {
			frappe.msgprint({ title: "Errores de validación", message: errors.map(e => `• ${e}`).join("<br>"), indicator: "red" });
			return;
		}
		const company = this.doc.company || this.defaults.company || "";
		const payload = Object.assign({}, this._purch_doc, { company });
		frappe.call({
			method: "facex_multi.api.purchase.save_purchase_invoice",
			args:   { data_json: JSON.stringify(payload) },
			freeze: true, freeze_message: "Guardando factura de compra...",
			callback: (r) => {
				if (!r.exc && r.message && r.message.name) {
					frappe.show_alert({ message: `Guardado: <strong>${r.message.name}</strong>`, indicator: "green" });
					this._load_purch_form(r.message.name);
				}
			},
		});
	}

	_submit_purch() {
		this._read_purch_form_to_doc();
		const errors = this._validate_purch();
		if (errors.length) {
			frappe.msgprint({ title: "Errores de validación", message: errors.map(e => `• ${e}`).join("<br>"), indicator: "red" });
			return;
		}
		frappe.confirm("¿Validar esta factura de compra? Esta acción actualizará el inventario y no se puede deshacer fácilmente.", () => {
			this._save_purch_then_submit();
		});
	}

	_save_purch_then_submit() {
		const company = this.doc.company || this.defaults.company || "";
		const payload = Object.assign({}, this._purch_doc, { company });
		frappe.call({
			method: "facex_multi.api.purchase.save_purchase_invoice",
			args:   { data_json: JSON.stringify(payload) },
			freeze: true, freeze_message: "Guardando...",
			callback: (r) => {
				if (r.exc || !r.message) return;
				frappe.call({
					method: "facex_multi.api.purchase.submit_purchase_invoice",
					args:   { name: r.message.name },
					freeze: true, freeze_message: "Validando factura de compra...",
					callback: (r2) => {
						if (!r2.exc && r2.message) {
							frappe.show_alert({ message: `Factura <strong>${r2.message.name}</strong> validada correctamente.`, indicator: "green" });
							this._load_purch_form(r2.message.name);
						}
					},
				});
			},
		});
	}

	_cancel_purch() {
		frappe.confirm("¿Cancelar esta factura de compra? Se revertirán los movimientos de inventario.", () => {
			frappe.call({
				method: "facex_multi.api.purchase.cancel_purchase_invoice",
				args:   { name: this._purch_doc.name },
				freeze: true, freeze_message: "Cancelando...",
				callback: (r) => {
					if (!r.exc && r.message) {
						frappe.show_alert({ message: "Factura cancelada.", indicator: "blue" });
						this._load_purch_form(r.message.name);
					}
				},
			});
		});
	}

	_show_supplier_suggestions(list) {
		const $inp  = this.$body.find("#ef-purch-supplier");
		const $wrap = $inp.closest("div");
		$wrap.find(".ef-sugg-dropdown").remove();
		if (!list.length) return;
		const $dd = $(`<div class="ef-sugg-dropdown" style="position:absolute;z-index:9999;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,.1);max-height:200px;overflow-y:auto;width:300px"></div>`);
		list.forEach(s => {
			$dd.append(`<div class="ef-sugg-item" data-value="${_esc(s.value)}" style="padding:8px 12px;cursor:pointer;font-size:13px;border-bottom:1px solid #f1f5f9">${_esc(s.label)}</div>`);
		});
		$wrap.css("position", "relative").append($dd);
		$dd.on("click", ".ef-sugg-item", (e) => {
			$inp.val($(e.currentTarget).data("value"));
			$dd.remove();
		});
		$(document).one("click", () => $dd.remove());
	}

	_show_excel_dialog() {
		const company = this.doc.company || this.defaults.company || "";
		const dlg = new frappe.ui.Dialog({
			title: "Cargar Compra desde Excel",
			fields: [
				{
					fieldtype: "HTML",
					options: `<div style="margin-bottom:12px;font-size:12px;color:#475569;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:12px">
						<strong>Estructura del archivo Excel:</strong><br>
						<strong>Hoja 1 – ENCABEZADO</strong> (fila 2): Proveedor | Fecha Registro | No. Factura | Fecha Factura | Moneda<br>
						<strong>Hoja 2 – DETALLE</strong> (desde fila 2): Código Ítem | Precio Unitario | Serie<br>
						<em>Para ítems con serie: una fila por unidad. Para ítems sin serie: una fila por ítem (la columna Serie va vacía).</em>
					</div>`,
				},
				{ fieldtype: "Attach", fieldname: "excel_file", label: "Archivo Excel (.xlsx)", reqd: 1 },
			],
			primary_action_label: "Procesar",
			primary_action: (vals) => {
				if (!vals.excel_file) return;
				dlg.hide();
				frappe.call({
					method: "facex_multi.api.purchase.process_purchase_excel",
					args:   { file_url: vals.excel_file, company },
					freeze: true, freeze_message: "Procesando Excel...",
					callback: (r) => {
						if (r.exc || !r.message) return;
						this._load_excel_result(r.message);
					},
				});
			},
		});
		dlg.show();
	}

	// ── STAGING (DTW / Odoo style) ──────────────────────────────────────

	_load_excel_result(result) {
		// Construir staging rows a partir del resultado del parser
		this._stg_header = {
			supplier:     result.header.supplier     || "",
			bill_no:      result.header.bill_no      || "",
			bill_date:    result.header.bill_date    || frappe.datetime.get_today(),
			posting_date: result.header.posting_date || frappe.datetime.get_today(),
			currency:     result.header.currency     || "GTQ",
			tax_type:     (this._purch_defaults && this._purch_defaults.default_tax_template) || "",
			bfel_multi_tipo: "",
		};

		this._stg_rows = result.items.map((it, i) => ({
			_idx:         i,
			item_code:    it.item_code,
			item_name:    it.item_name  || it.item_code,
			item_group:   it.item_group || "",
			has_serial_no: it.has_serial_no || 0,
			is_stock_item: 1,
			qty:           it.qty,
			rate:          it.rate,
			amount:        it.qty * it.rate,
			warehouse:     it.warehouse || "",
			bfel_multi_tipo: it.bfel_multi_tipo || "",
			serial_no:     it.serial_no || "",
			update_stock:  1,
			_errors:       [],  // se llena en revalidar
		}));

		// Advertencias del parser (ítems no encontrados, etc.)
		if (result.errors && result.errors.length) {
			this.$body.find("#ef-stg-errors")
				.html("<strong>Advertencias del archivo:</strong><br>" + result.errors.map(e => `• ${_esc(e)}`).join("<br>"))
				.show();
		} else {
			this.$body.find("#ef-stg-errors").hide();
		}

		if (!this._stg_rows.length) {
			frappe.msgprint({ title: "Sin datos", message: "El archivo no contiene líneas de detalle válidas.", indicator: "orange" });
			return;
		}

		this._stg_populate_header();
		this._stg_revalidate();
		this._show_purch_staging();
	}

	_stg_populate_header() {
		const h = this._stg_header;
		this.$body.find("#ef-stg-supplier").val(h.supplier);
		this.$body.find("#ef-stg-bill-no").val(h.bill_no);
		this.$body.find("#ef-stg-bill-date").val(h.bill_date);
		this.$body.find("#ef-stg-posting-date").val(h.posting_date);
		this.$body.find("#ef-stg-currency").val(h.currency);
		this._populate_purch_tax_selects();
		this._populate_purch_tipo_selects();
		this.$body.find("#ef-stg-tax-type").val(h.tax_type || "");
		this.$body.find("#ef-stg-tipo").val(h.bfel_multi_tipo || "");
	}

	_stg_read_header() {
		this._stg_header.supplier     = this.$body.find("#ef-stg-supplier").val().trim();
		this._stg_header.bill_no      = this.$body.find("#ef-stg-bill-no").val().trim();
		this._stg_header.bill_date    = this.$body.find("#ef-stg-bill-date").val();
		this._stg_header.posting_date = this.$body.find("#ef-stg-posting-date").val();
		this._stg_header.currency     = this.$body.find("#ef-stg-currency").val();
		this._stg_header.tax_type     = this.$body.find("#ef-stg-tax-type").val();
		this._stg_header.bfel_multi_tipo = this.$body.find("#ef-stg-tipo").val();
	}

	_stg_validate_rows() {
		(this._stg_rows || []).forEach(row => {
			const errs = [];
			if (!row.item_code) errs.push("Código de ítem vacío.");
			if (!row.rate || row.rate <= 0) errs.push("Precio debe ser > 0.");
			if (row.has_serial_no) {
				const serials = (row.serial_no || "").split("\n").map(s => s.trim()).filter(Boolean);
				if (!serials.length) errs.push("Requiere número(s) de serie.");
				else if (serials.length !== row.qty) errs.push(`Series (${serials.length}) ≠ Cant. (${row.qty}).`);
			} else if (!row.qty || row.qty <= 0) {
				errs.push("Cantidad debe ser > 0.");
			}
			if (row.is_stock_item && row.update_stock && !row.warehouse) errs.push("Bodega requerida.");
			row._errors = errs;
		});
	}

	_stg_revalidate() {
		// Leer cambios del grid antes de revalidar
		this._stg_read_header();
		this._stg_read_grid_changes();
		this._stg_validate_rows();
		this._stg_render_grid();
		this._stg_update_summary();
	}

	_stg_read_grid_changes() {
		// Leer valores editados inline en el grid actual
		(this._stg_rows || []).forEach((row, i) => {
			const $qty  = this.$body.find(`.ef-stg-qty[data-sidx="${i}"]`);
			const $rate = this.$body.find(`.ef-stg-rate[data-sidx="${i}"]`);
			const $wh   = this.$body.find(`.ef-stg-wh[data-sidx="${i}"]`);
			const $ser  = this.$body.find(`.ef-stg-serial[data-sidx="${i}"]`);
			const $stk  = this.$body.find(`.ef-stg-stock[data-sidx="${i}"]`);

			if ($qty.length)  row.qty          = parseFloat($qty.val())  || row.qty;
			if ($rate.length) row.rate         = parseFloat($rate.val()) || row.rate;
			if ($wh.length)   row.warehouse    = $wh.val();
			if ($stk.length)  row.update_stock = $stk.is(":checked") ? 1 : 0;
			if ($ser.length) {
				const serials = $ser.val().split("\n").map(s => s.trim()).filter(Boolean);
				row.serial_no = serials.join("\n");
				row.qty       = serials.length || row.qty;
			}
			row.amount = row.qty * row.rate;
		});
	}

	_stg_render_grid() {
		const $tbody = this.$body.find("#ef-stg-items-body");
		const currency = this._stg_header.currency || "GTQ";
		$tbody.empty();

		(this._stg_rows || []).forEach((row, i) => {
			const ok      = row._errors.length === 0;
			const rowBg   = ok ? "" : "background:#fef2f2;";
			const statusIco = ok
				? `<span title="OK" style="color:#10b981;font-size:15px;font-weight:700;display:block;text-align:center">✓</span>`
				: `<span title="${_esc(row._errors.join(' / '))}" style="color:#ef4444;font-size:15px;font-weight:700;display:block;text-align:center;cursor:help">✗</span>`;
			const errTip = !ok
				? `<tr class="ef-stg-err-row"><td colspan="10" style="padding:3px 8px 6px 48px;font-size:11px;color:#b91c1c;background:#fff0f0">
					${row._errors.map(e => `⚠ ${_esc(e)}`).join(" &nbsp;·&nbsp; ")}
				  </td></tr>`
				: "";

			const serialCell = row.has_serial_no
				? `<textarea class="ef-cell-input ef-stg-serial" data-sidx="${i}" rows="2"
					style="width:100%;font-size:10px;font-family:monospace;resize:vertical;border:none">${_esc(row.serial_no || "")}</textarea>`
				: "";

			const stockCell = row.has_serial_no
				? `<span style="display:block;text-align:center;color:#94a3b8;font-size:11px">auto</span>`
				: `<input type="checkbox" class="ef-stg-stock" data-sidx="${i}" ${row.update_stock ? "checked" : ""}
					style="display:block;margin:0 auto;cursor:pointer">`;

			$tbody.append(`
			<tr class="ef-tr ef-stg-main-row" style="${rowBg}">
				<td class="ef-td ef-td-idx">${i + 1}</td>
				<td class="ef-td" style="padding:4px 6px">${statusIco}</td>
				<td class="ef-td" style="font-weight:600;font-size:12px;color:#1e3a5f">${_esc(row.item_code)}</td>
				<td class="ef-td" style="font-size:11px;color:#475569">${_esc(row.item_name)}
					${serialCell}</td>
				<td class="ef-td">
					${row.has_serial_no
						? `<span class="ef-stg-qty-display" data-sidx="${i}" style="display:block;text-align:center;font-weight:700;color:#1e3a5f">${row.qty}</span>`
						: `<input type="number" class="ef-cell-input ef-stg-qty" data-sidx="${i}" value="${row.qty}"
							min="1" step="1" style="width:54px;border:none;text-align:right">`}
				</td>
				<td class="ef-td">
					<input type="number" class="ef-cell-input ef-stg-rate" data-sidx="${i}" value="${parseFloat(row.rate||0).toFixed(2)}"
						min="0" step="any" style="width:88px;border:none;text-align:right">
				</td>
				<td class="ef-td ef-td-num" id="ef-stg-amount-${i}">${_fmtCurrency(row.amount, currency)}</td>
				<td class="ef-td">
					<input type="text" class="ef-cell-input ef-stg-wh" data-sidx="${i}" value="${_esc(row.warehouse||"")}"
						placeholder="Bodega" style="width:130px;font-size:11px;border:none">
				</td>
				<td class="ef-td" style="padding:4px 6px">${stockCell}</td>
				<td class="ef-td" style="padding:4px 6px">
					<button class="ef-btn-del ef-stg-del" data-sidx="${i}" title="Eliminar línea">×</button>
				</td>
			</tr>
			${errTip}`);
		});

		// Eventos inline (live recalculo)
		$tbody.find(".ef-stg-rate,.ef-stg-qty").off("input").on("input", (e) => {
			const i    = parseInt($(e.target).data("sidx"));
			const row  = this._stg_rows[i];
			if (!row) return;
			if ($(e.target).hasClass("ef-stg-qty")) row.qty = parseFloat(e.target.value) || 1;
			else row.rate = parseFloat(e.target.value) || 0;
			row.amount = row.qty * row.rate;
			this.$body.find(`#ef-stg-amount-${i}`).text(_fmtCurrency(row.amount, currency));
		});

		$tbody.find(".ef-stg-serial").off("input").on("input", (e) => {
			const i   = parseInt($(e.target).data("sidx"));
			const row = this._stg_rows[i];
			if (!row) return;
			const serials = e.target.value.split("\n").map(s => s.trim()).filter(Boolean);
			row.serial_no = serials.join("\n");
			row.qty       = serials.length || 1;
			row.amount    = row.qty * row.rate;
			this.$body.find(`.ef-stg-qty-display[data-sidx="${i}"]`).text(row.qty);
			this.$body.find(`#ef-stg-amount-${i}`).text(_fmtCurrency(row.amount, currency));
		});

		$tbody.find(".ef-stg-wh").off("change").on("change", (e) => {
			const i = parseInt($(e.target).data("sidx"));
			if (this._stg_rows[i]) this._stg_rows[i].warehouse = e.target.value;
		});

		$tbody.find(".ef-stg-stock").off("change").on("change", (e) => {
			const i = parseInt($(e.target).data("sidx"));
			if (this._stg_rows[i]) this._stg_rows[i].update_stock = e.target.checked ? 1 : 0;
		});

		$tbody.find(".ef-stg-del").off("click").on("click", (e) => {
			const i = parseInt($(e.currentTarget).data("sidx"));
			this._stg_rows.splice(i, 1);
			this._stg_rows.forEach((r, ni) => { r._idx = ni; });
			this._stg_validate_rows();
			this._stg_render_grid();
			this._stg_update_summary();
		});
	}

	_stg_update_summary() {
		const rows   = this._stg_rows || [];
		const total  = rows.length;
		const ok     = rows.filter(r => r._errors.length === 0).length;
		const bad    = total - ok;
		const h      = this._stg_header;
		const hErrs  = [];
		if (!h.supplier)  hErrs.push("Proveedor vacío");
		if (!h.bill_no)   hErrs.push("No. Factura vacío");
		if (!h.bill_date) hErrs.push("Fecha Factura vacía");

		this.$body.find("#ef-stg-line-count").text(`${total} línea(s)`);
		this.$body.find("#ef-stg-ok-count").text(
			`${ok} OK${bad ? ` · ${bad} con error` : ""}${hErrs.length ? ` · Encabezado: ${hErrs.join(", ")}` : ""}`
		);

		const $sum = this.$body.find("#ef-stg-summary");
		const allOk = ok === total && total > 0 && !hErrs.length;
		if (allOk) {
			$sum.css({ background: "#f0fdf4", border: "1px solid #86efac", color: "#166534" })
				.html(`✓ Todos los datos son válidos. Listo para importar (${total} línea(s)).`).show();
		} else {
			const parts = [];
			if (hErrs.length) parts.push(`Encabezado: ${hErrs.join(", ")}`);
			if (bad)          parts.push(`${bad} línea(s) con errores`);
			$sum.css({ background: "#fef9c3", border: "1px solid #fde047", color: "#713f12" })
				.html(`⚠ ${parts.join(" · ")}. Corrige antes de importar.`).show();
		}

		this.$body.find("#ef-purch-stg-confirm").prop("disabled", !allOk);
	}

	_stg_confirm() {
		this._stg_read_header();
		this._stg_read_grid_changes();
		this._stg_validate_rows();

		const bad = (this._stg_rows || []).filter(r => r._errors.length > 0);
		if (bad.length) {
			frappe.msgprint({ title: "Errores pendientes", message: `Hay ${bad.length} línea(s) con errores. Corrígelas antes de importar.`, indicator: "red" });
			this._stg_render_grid();
			this._stg_update_summary();
			return;
		}
		const h = this._stg_header;
		if (!h.supplier || !h.bill_no) {
			frappe.msgprint({ title: "Encabezado incompleto", message: "Proveedor y Número de Factura son obligatorios.", indicator: "red" });
			return;
		}

		// Pasar a formulario normal con los datos corregidos
		this._purch_doc = this._empty_purch_doc();
		Object.assign(this._purch_doc, h);
		this._purch_doc.items = (this._stg_rows || []).map(row => ({
			item_code:     row.item_code,
			item_name:     row.item_name,
			item_group:    row.item_group,
			has_serial_no: row.has_serial_no,
			is_stock_item: row.is_stock_item,
			qty:           row.qty,
			rate:          row.rate,
			amount:        row.amount,
			warehouse:     row.warehouse,
			bfel_multi_tipo: row.bfel_multi_tipo || "",
			serial_no:     row.serial_no || "",
			update_stock:  row.update_stock,
			_fetched:      true,
		}));

		// Poblar form header
		this.$body.find("#ef-purch-supplier").val(h.supplier);
		this.$body.find("#ef-purch-bill-no").val(h.bill_no);
		this.$body.find("#ef-purch-bill-date").val(h.bill_date);
		this.$body.find("#ef-purch-posting-date").val(h.posting_date);
		this.$body.find("#ef-purch-currency").val(h.currency);
		this._populate_purch_tax_selects();
		this._populate_purch_tipo_selects();
		this.$body.find("#ef-purch-tax-type").val(h.tax_type || "");
		this.$body.find("#ef-purch-tipo").val(h.bfel_multi_tipo || "");
		this.$body.find("#ef-purch-form-title").text("Nueva Factura de Compra (desde Excel)");
		this.$body.find("#ef-purch-status-badge").text("NUEVO").attr("class","ef-badge ef-badge-new");
		this.$body.find("#ef-purch-btn-cancel-doc").hide();
		this.$body.find("#ef-purch-btn-save,#ef-purch-btn-submit,#ef-purch-btn-add-item").show().prop("disabled", false);

		this._render_purch_items();
		this._show_purch_form();
		frappe.show_alert({ message: `${this._purch_doc.items.length} línea(s) importada(s) correctamente.`, indicator: "green" });
	}
}


// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

// Catálogo de Tipo FEL para compras (bfel_multi_tipo en Purchase Invoice /
// Purchase Invoice Item). Ver facex_multi.patches.v1_0.add_purchase_bfel_multi_tipo.
const PURCH_TIPO_OPTIONS = [
	{ value: "B", label: "B - Bien" },
	{ value: "S", label: "S - Servicio" },
	{ value: "C", label: "C - Combustible" },
	{ value: "I", label: "I - Importación" },
	{ value: "E", label: "E - Exportación" },
	{ value: "P", label: "P - Pequeño Contribuyente" },
	{ value: "L", label: "L - Exención Local" },
	{ value: "N", label: "N - No Aplica" },
	{ value: "X", label: "X - Sin Asignación" },
];

function _purchTipoOptionsHtml(selected) {
	const blank = `<option value=""${!selected ? ' selected' : ''}>-</option>`;
	return blank + PURCH_TIPO_OPTIONS.map(o =>
		`<option value="${o.value}"${selected === o.value ? ' selected' : ''}>${_esc(o.label)}</option>`
	).join('');
}

function _esc(str) {
	return String(str || "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function _fmt(n) {
	return parseFloat(n || 0).toFixed(2);
}

function _fmtCurrency(n, currency) {
	const symbol = currency === "GTQ" ? "Q" : (currency || "Q");
	return `${symbol} ${parseFloat(n || 0).toLocaleString("es-GT", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	})}`;
}
