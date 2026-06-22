/**
 * FacEx — Facturación Exprés (FacEx Multi)
 * Frappe v15 compatible | Sin dependencias externas
 * Toda la lógica fiscal/contable permanece en ERPNext core.
 */

// ---------------------------------------------------------------------------
// Page lifecycle hooks
// ---------------------------------------------------------------------------

frappe.pages["facex"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "FacEx",
		single_column: true,
	});
	// Force focus mode on load immediately to hide ERPNext panel
	$("body").addClass("facex-fullscreen-mode");
	// controls.bundle.js provides frappe.ui.form.make_control (Link, Date, etc.)
	// It is NOT included in desk.bundle.js, so must be required explicitly.
	frappe.require(["controls.bundle.js"], function () {
		wrapper.efast = new EFastSalePage(page, wrapper);
	});
};

frappe.pages["facex"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	if (!wrapper.efast) return;
	const params = frappe.utils.get_url_to_dict();
	if (params.invoice) {
		wrapper.efast.load_invoice(params.invoice);
	}
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
				
				// Bind analytics button
				this.$body.find("#ef-btn-show-analytics").on("click", () => {
					this._show_customer_analytics_dialog();
				});

				this._setup_dashboard_controls();
				this._setup_maintenance();

				const params = frappe.utils.get_url_to_dict();
				if (params.invoice) {
					this.load_invoice(params.invoice);
				} else {
					this._new_invoice();
					this._switch_view("dashboard");
				}
			},
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
       <span style="font-weight: 800; color: #153375;">FacEx Portal</span>
       <button id="ef-btn-toggle-fullscreen" class="ef-btn" style="margin-left: 12px; font-size: 11px; padding: 4px 10px; border-radius: 6px; display: flex; align-items: center; gap: 5px; border: 1px solid var(--ef-border); background: var(--ef-card); color: var(--ef-text);" title="Alternar Modo Enfoque (Pantalla Completa)">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
         <span id="ef-fullscreen-btn-text">Modo Enfoque</span>
       </button>
     </div>
     
     <div id="ef-navbar-company-badge" style="display: none; align-items: center; gap: 6px; background: #eef2ff; color: #4361ee; padding: 6px 14px; border-radius: 20px; font-size: 13px; font-weight: 700; border: 1px solid #c7d2fe; box-shadow: 0 1px 2px rgba(0,0,0,0.05); text-transform: uppercase; letter-spacing: 0.5px;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"></path><path d="M9 8h1"></path><path d="M9 12h1"></path><path d="M9 16h1"></path><path d="M14 8h1"></path><path d="M14 12h1"></path><path d="M14 16h1"></path><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"></path></svg>
        <span id="ef-active-company-name"></span>
     </div>

     <div class="ef-navbar-menu">
       <button class="ef-nav-btn ef-nav-active" data-view="dashboard">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>
         <span>Tablero</span>
       </button>
       <button class="ef-nav-btn" data-view="billing">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
         <span>Facturador (FacEx)</span>
       </button>
       <button class="ef-nav-btn" data-view="reports">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><path d="M3 20h18"/></svg>
         <span>Reportes y Recibos</span>
       </button>
       <button class="ef-nav-btn" data-view="maintenance">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/><circle cx="12" cy="12" r="3"/></svg>
         <span>Mantenimiento</span>
       </button>

       <div class="ef-user-dropdown" style="position: relative; margin-left: 12px; display: flex; align-items: center;">
         <button id="ef-btn-user-profile" class="ef-nav-btn" style="padding: 6px 10px; border-radius: 20px; background: #f1f5f9; border: 1px solid #cbd5e1; display: flex; align-items: center; gap: 6px; cursor: pointer;" title="Perfil de Usuario">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
         </button>
         <div id="ef-user-dropdown-menu" style="display: none; position: absolute; top: 120%; right: 0; background: white; border: 1px solid var(--ef-border); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); border-radius: 10px; padding: 14px; min-width: 200px; z-index: 1001;">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; margin-bottom: 4px;">Usuario Conectado</div>
            <div id="ef-active-user-fullname" style="font-size: 14px; font-weight: 700; color: #0f172a; line-height: 1.2;"></div>
            <div id="ef-active-user-email" style="font-size: 12px; color: #64748b; margin-bottom: 14px; word-break: break-all;"></div>
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

  <!-- ── VIEW 1: DASHBOARD / TABLERO ──────────────────────────────── -->
  <div id="ef-dashboard-view" class="ef-view-content" style="padding: 24px; max-width: 1200px; margin: 0 auto; font-family: var(--ef-font);">
    
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
    <div class="ef-dashboard-kpis" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 20px; margin-bottom: 24px;">
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

      <!-- ── HEADER ──────────────────────────────────────────────────── -->
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

        <!-- Encabezado en 3 Columnas -->
        <div class="ef-header-grid" style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; align-items: start;">
          
          <!-- Columna 1 -->
          <div class="ef-col">
            <div class="ef-field-group">
              <label class="ef-label">Establecimiento <span class="ef-req">*</span></label>
              <select id="ef-establecimiento" class="ef-select" tabindex="1"></select>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Serie <span class="ef-req">*</span></label>
              <select id="ef-naming-series" class="ef-select" tabindex="2"></select>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Cliente <span class="ef-req">*</span></label>
              <div style="display:flex;gap:4px">
                <div data-ctrl="customer" class="ef-link-ctrl" style="flex:1" tabindex="3"></div>
                <button id="ef-btn-show-analytics" class="ef-btn ef-btn-secondary" style="padding:6px 9px;" title="Ver Análisis de Ventas" tabindex="4">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
                </button>
              </div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Nombre para Factura</label>
              <input id="ef-bfel-nombre" type="text" class="ef-input" placeholder="Nombre en factura..." maxlength="100" tabindex="5" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">NIT (FEL)</label>
              <input id="ef-bfel-nit" type="text" class="ef-input" placeholder="CF" maxlength="20" tabindex="6" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label" style="color:var(--ef-primary); font-weight:600;">Estado FEL</label>
              <select id="ef-bfel-status" class="ef-select" style="border-color:var(--ef-primary); font-weight:600;" tabindex="7">
                <option value="01 Enviar">01 Enviar</option>
                <option value="00 No enviar">00 No enviar</option>
              </select>
            </div>
          </div>

          <!-- Columna 2 -->
          <div class="ef-col">
            <div class="ef-field-group">
              <label class="ef-label">Condición de Pago</label>
              <div data-ctrl="payment_terms_template" class="ef-link-ctrl" tabindex="8"></div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">F. Emisión <span class="ef-req">*</span></label>
              <input id="ef-posting-date" type="date" class="ef-input" tabindex="9" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">F. Vencimiento</label>
              <input id="ef-due-date" type="date" class="ef-input" tabindex="10" />
            </div>
            <!-- Campos informativos de FEL -->
            <div style="display:flex; gap:10px; margin-top:20px;">
              <div class="ef-field-group" style="flex:1">
                <label class="ef-label">UUID FEL</label>
                <input id="ef-bfel-uuid" type="text" class="ef-input ef-input-readonly" readonly placeholder="—" style="font-size:11px;" />
              </div>
              <div class="ef-field-group" style="flex:1">
                <label class="ef-label">No. Doc. FEL</label>
                <input id="ef-bfel-docto-no" type="text" class="ef-input ef-input-readonly" readonly placeholder="—" style="font-size:11px;" />
              </div>
            </div>
          </div>

          <!-- Columna 3 -->
          <div class="ef-col">
            <div class="ef-field-group">
              <label class="ef-label">Plantilla Impuestos</label>
              <div data-ctrl="taxes_and_charges" class="ef-link-ctrl" tabindex="10"></div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Vendedor</label>
              <div data-ctrl="sales_partner" class="ef-link-ctrl" tabindex="11"></div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Términos y Condiciones</label>
              <textarea id="ef-terms" class="ef-textarea ef-textarea-sm" rows="3" placeholder="Términos..." tabindex="12"></textarea>
            </div>
          </div>
        </div>

        <!-- Fila 4: Escenario Exento FEL (visible solo si taxes_and_charges empieza con EXE) -->
        <div id="ef-row-escenario" class="ef-hrow" style="grid-template-columns:220px 1fr; display:none;">
          <div class="ef-field-group">
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
          <button id="ef-add-row" class="ef-btn ef-btn-sm ef-btn-secondary">
            <span>+</span> Agregar Línea
          </button>
        </div>

        <div class="ef-table-wrapper">
          <table class="ef-table" id="ef-items-table">
            <thead>
              <tr>
                <th class="ef-th ef-th-idx">#</th>
                <th class="ef-th ef-th-item">Código Item</th>
                <th class="ef-th ef-th-name">Descripción FEL</th>
                <th class="ef-th ef-th-qty">Cantidad</th>
                <th class="ef-th ef-th-rate">Precio Unit.</th>
                <th class="ef-th ef-th-disc ef-col-disc">Desc %</th>
                <th class="ef-th ef-th-amount">Importe</th>
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
      <div style="background: var(--ef-card); border: 1px solid var(--ef-border); border-radius: 12px; padding: 18px; box-shadow: var(--ef-shadow); display: flex; flex-direction: column; gap: 6px; align-self: start;">
        <div style="font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; color: var(--ef-text-muted); margin-bottom: 12px; padding-left: 8px;">
          Portal de Reportes
        </div>
        <button class="ef-report-nav-btn ef-report-nav-active" data-report="sales_by_date">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span>Ventas por Fecha</span>
        </button>
        <button class="ef-report-nav-btn" data-report="sales_by_product">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
          <span>Ventas por Producto</span>
        </button>
        <button class="ef-report-nav-btn" data-report="cancelled_invoices">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          <span>Facturas Canceladas</span>
        </button>
        <button class="ef-report-nav-btn" data-report="customer_statement">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          <span>Estado de Cuenta</span>
        </button>
        <button class="ef-report-nav-btn" data-report="aging_receivables">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>Antigüedad de Saldos</span>
        </button>
        <button class="ef-report-nav-btn" data-report="quotations_report">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
          <span>Cotizaciones (Pre-Facturas)</span>
        </button>
        <button class="ef-report-nav-btn" data-report="payments_report">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
          <span>Recibos y Pagos</span>
        </button>
        <button class="ef-report-nav-btn" data-report="sales_growth_analysis">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
          <span>Crecimiento de Ventas</span>
        </button>
        
        <div style="border-top: 1px solid var(--ef-border); margin: 12px 0;"></div>
        
        <button class="ef-report-nav-btn" data-report="print_receipt" style="color: var(--ef-warning);">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
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
      <button class="ef-tab-btn ef-maint-tab-btn" data-maint-tab="precios">
        Precios
      </button>
    </div>

    <!-- Maint Tab Content: Clientes -->
    <div class="ef-maint-tab-content" id="ef-maint-tab-clientes">
      <div style="display: grid; grid-template-columns: 320px 1fr; gap: 24px; align-items: start;">
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:16px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <span class="ef-analytics-card-title" style="margin:0;">Listado de Clientes</span>
            <button id="ef-maint-cust-btn-load" class="ef-btn ef-btn-sm ef-btn-secondary" style="padding:2px 8px; font-size:10px;">Cargar Lista</button>
          </div>
          <input type="text" id="ef-maint-cust-search" class="ef-input" placeholder="Buscar cliente..." style="width:100%; margin-bottom:12px;" />
          <div id="ef-maint-cust-list" style="max-height: 400px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;"></div>
        </div>
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:20px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid var(--ef-border); padding-bottom:10px;">
            <span style="font-weight:700; color:var(--ef-primary); font-size:16px;" id="ef-maint-cust-title">Nuevo Cliente</span>
            <button id="ef-maint-cust-btn-new" class="ef-btn ef-btn-sm ef-btn-secondary">+ Nuevo</button>
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
              <label class="ef-label">Teléfono</label>
              <input type="text" id="ef-maint-cust-phone" class="ef-input" style="width:100%" />
            </div>
            <div class="ef-field-group" style="grid-column: span 2;">
              <label class="ef-label">Dirección</label>
              <input type="text" id="ef-maint-cust-addr" class="ef-input" style="width:100%" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Departamento</label>
              <input type="text" id="ef-maint-cust-dept" class="ef-input" style="width:100%" />
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Lista de precios</label>
              <div id="ef-maint-cust-price-list-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
            </div>
            <div class="ef-field-group">
              <label class="ef-label">Condiciones de pago</label>
              <div id="ef-maint-cust-payment-terms-ctrl" class="ef-link-ctrl" style="min-height: 32px;"></div>
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
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <span class="ef-analytics-card-title" style="margin:0;">Listado de Productos</span>
            <button id="ef-maint-item-btn-load" class="ef-btn ef-btn-sm ef-btn-secondary" style="padding:2px 8px; font-size:10px;">Cargar Lista</button>
          </div>
          <input type="text" id="ef-maint-item-search" class="ef-input" placeholder="Buscar producto..." style="width:100%; margin-bottom:12px;" />
          <div id="ef-maint-item-list" style="max-height: 400px; overflow-y:auto; display:flex; flex-direction:column; gap:6px;"></div>
        </div>
        <div class="ef-analytics-card" style="box-shadow: var(--ef-shadow); padding:20px;">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; border-bottom:1px solid var(--ef-border); padding-bottom:10px;">
            <span style="font-weight:700; color:var(--ef-primary); font-size:16px;" id="ef-maint-item-title">Nuevo Producto</span>
            <button id="ef-maint-item-btn-new" class="ef-btn ef-btn-sm ef-btn-secondary">+ Nuevo</button>
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
            <div class="ef-field-group" style="grid-column: span 2;">
              <label class="ef-label">Descripción FEL <span style="color:#64748b; font-weight:400; font-size:11px;">(max. 500 · se llena automáticamente desde el Nombre)</span></label>
              <textarea id="ef-maint-item-desc" class="ef-textarea" style="width:100%; height:80px;" maxlength="500" placeholder="Se completará automáticamente con el Nombre del ítem."></textarea>
            </div>
          </div>
          <div style="margin-top:20px; text-align:right;">
            <button id="ef-maint-item-btn-delete" class="ef-btn" style="background:#ef4444; color:white; padding:8px 24px; display:none; margin-right:8px;">Eliminar Producto</button>
            <button id="ef-maint-item-btn-save" class="ef-btn ef-btn-primary" style="padding:8px 24px;">Guardar Producto</button>
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
          <input type="text" id="ef-maint-prices-search" class="ef-input" placeholder="Filtrar por nombre..." style="width:220px;" />
        </div>
        <div class="ef-table-wrapper" style="max-height: 400px; overflow-y: auto;">
          <table class="ef-table">
            <thead>
              <tr>
                <th class="ef-th" style="width:150px;">Código</th>
                <th class="ef-th">Nombre Producto</th>
                <th class="ef-th" style="width:100px;">UOM</th>
                <th class="ef-th" style="width:180px; text-align:right;">Precio Standard</th>
                <th class="ef-th" style="width:120px;"></th>
              </tr>
            </thead>
            <tbody id="ef-maint-prices-tbody">
              <!-- Dynamically loaded -->
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </div>

</div><!-- ef-main-layout -->
		`);

		// Bind navbar actions
		this.$body.on("click", ".ef-nav-btn", (e) => {
			const view = $(e.currentTarget).attr("data-view");
			if (view === "billing" && (!this.doc.name || this.doc.name === "new")) {
				this._action_new();
			} else {
				this._switch_view(view);
			}
		});
	}

	_switch_view(view) {
		this._current_view = view;

		// Toggle buttons in navbar
		this.$body.find(".ef-nav-btn").removeClass("ef-nav-active");
		this.$body.find(`.ef-nav-btn[data-view="${view}"]`).addClass("ef-nav-active");

		// Show action bar ONLY for billing view
		if (view === "billing") {
			$(this.wrapper).find("#ef-action-bar").show();
		} else {
			$(this.wrapper).find("#ef-action-bar").hide();
		}

		if (view === "dashboard") {
			this.$body.find("#ef-dashboard-view").show();
			this.$body.find("#ef-billing-view").hide();
			this.$body.find("#ef-reports-view").hide();
			this.$body.find("#ef-maintenance-view").hide();
			// Clear URL query params
			frappe.set_route("facex");
			this._load_dashboard_data();
		} else if (view === "billing") {
			this.$body.find("#ef-dashboard-view").hide();
			this.$body.find("#ef-billing-view").show();
			this.$body.find("#ef-reports-view").hide();
			this.$body.find("#ef-maintenance-view").hide();
			if (this.doc && this.doc.name && this.doc.name !== "new") {
				frappe.set_route("facex", "", { invoice: this.doc.name });
			} else {
				frappe.set_route("facex");
			}
			this._focus_first_field();
		} else if (view === "reports") {
			this.$body.find("#ef-dashboard-view").hide();
			this.$body.find("#ef-billing-view").hide();
			this.$body.find("#ef-reports-view").show();
			this.$body.find("#ef-maintenance-view").hide();
			frappe.set_route("facex", "", { view: "reports" });
			this._load_reports_view();
		} else if (view === "maintenance") {
			this.$body.find("#ef-dashboard-view").hide();
			this.$body.find("#ef-billing-view").hide();
			this.$body.find("#ef-reports-view").hide();
			this.$body.find("#ef-maintenance-view").show();
			frappe.set_route("facex", "", { view: "maintenance" });
			this._load_maintenance_view();
		}
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
					filters: {
						bfel_company: comp
					}
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
.ef-header-collapsed .ef-hrow, .ef-header-collapsed .ef-header-grid { display: none !important; }
.ef-header-collapsed { padding-bottom: 10px !important; }
.ef-header-brand { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

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
.ef-field-group { display: flex; flex-direction: column; gap: 3px; }
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
.ef-th-del   { width: 36px; }

.ef-tr {
  border-bottom: 1px solid #f1f5f9;
  transition: background .1s;
}
.ef-tr:hover { background: #fafbff; }
.ef-tr.ef-tr-active { background: #eef2ff; }

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
  .ef-table { font-size: 12px; }
  .ef-totals { min-width: 280px; }
}
@media (max-width: 600px) {
  .ef-header { padding: 10px 12px 8px; }
  .ef-hrow { grid-template-columns: 1fr !important; gap: 8px 0; }
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
.ef-navbar-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--ef-card);
  border-bottom: 2px solid var(--ef-border);
  padding: 12px 24px;
  position: sticky;
  top: 0;
  z-index: 1000;
  box-shadow: var(--ef-shadow);
}
.ef-navbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 20px;
  font-weight: 800;
  color: #153375;
}
.ef-navbar-menu {
  display: flex;
  gap: 12px;
}
.ef-nav-btn {
  background: none;
  border: none;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ef-text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
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

/* Navbar & Dashboard Styles */
.ef-navbar-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--ef-card);
  padding: 12px 24px;
  border-bottom: 1px solid var(--ef-border);
  position: sticky;
  top: 0;
  z-index: 1010;
  box-shadow: var(--ef-shadow);
}
.ef-navbar-brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 800;
}
.ef-navbar-menu {
  display: flex;
  gap: 12px;
}
.ef-nav-btn {
  background: transparent;
  border: none;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ef-text-muted);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
}
.ef-nav-btn:hover {
  background: #f1f5f9;
  color: var(--ef-primary);
}
.ef-nav-btn.ef-nav-active {
  background: #eff6ff;
  color: var(--ef-primary);
}
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

		// NIT
		this.$body.find("#ef-bfel-nit").on("change input", (e) => {
			this.doc.bfel_nit = e.target.value;
			this._mark_dirty();
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
					filters: {
						bfel_company: comp
					}
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
				this._mark_dirty();
			}, 50);
		};
		if (ctrl && ctrl.$input) {
			ctrl.$input.on("change blur awesomplete-selectcomplete", _onCtrlChange);
		}
		ctrl.df.change = _onCtrlChange;
	}

	_on_customer_change(customer) {

		if (!customer) {
			this.doc.customer_name = "";
			this.doc.bfel_nombre = "";
			this.doc.sales_partner = "";
			this.$body.find("#ef-customer-name").val("");
			this.$body.find("#ef-bfel-nombre").val("");
			if (this.controls.sales_partner) this.controls.sales_partner.set_value("");
			return;
		}
		frappe.call({
			method: "frappe.client.get_value",
			args: {
				doctype: "Customer",
				filters: { name: customer },
				fieldname: ["tax_id", "bfel_id_receptor", "payment_terms", "customer_name", "default_sales_partner", "default_price_list"],
			},
			callback: (r) => {
				if (!r.exc && r.message) {
					const cname = r.message.customer_name || customer;
					this.doc.customer_name = cname;

					if (!this.doc.bfel_nombre) {
						this.doc.bfel_nombre = cname;
						this.$body.find("#ef-bfel-nombre").val(cname);
					}

					if (r.message.default_price_list) {
						this.doc.selling_price_list = r.message.default_price_list;
					}

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

					if (r.message.default_sales_partner && !this.doc.sales_partner) {
						this.doc.sales_partner = r.message.default_sales_partner;
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
				}
			},
		});
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
			$row.show();
			$sel.prop("disabled", false);
		} else {
			$row.hide();
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
	}

	_item_row_html(idx, item) {
		const base_rate = item.price_list_rate !== undefined && item.price_list_rate !== null && parseFloat(item.price_list_rate) > 0 ? parseFloat(item.price_list_rate) : (parseFloat(item.rate) || 0);
		const amount = this._calc_amount(item.qty, base_rate, item.discount_percentage);
		return `
<tr class="ef-tr" data-idx="${idx}" id="ef-row-${idx}">
  <td class="ef-td ef-td-idx">${idx + 1}</td>
  <td class="ef-td">
    <div class="ef-ac-wrapper" style="position:relative">
      <input type="text" class="ef-cell-input ef-item-code"
        data-field="item_code" data-idx="${idx}"
        value="${_esc(item.item_code || "")}"
        placeholder="Código..." autocomplete="off" />
    </div>
  </td>
  <td class="ef-td">
    <input type="text" class="ef-cell-input ef-item-desc"
      data-field="description" data-idx="${idx}"
      value="${_esc(item.description || item.item_name || "")}"
      placeholder="Descripción FEL (max. 500 caracteres)"
      maxlength="500" />
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
  <td class="ef-td">
    <button class="ef-btn-del ef-del-row" data-idx="${idx}" title="Eliminar fila">×</button>
  </td>
</tr>`;
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
						row.amount = this._calc_amount(row.qty, row.rate, row.discount_percentage);
						this._render_items();
						this._update_local_footer();
						this.$body.find(`#ef-row-${idx} .ef-qty`).focus().select();
					}
				}
			},
		});
	}

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
			const filters = {};
			if (doctype === "Item") {
				filters.bfel_company = comp;
			} else if (doctype === "Customer") {
				filters.bfel_company = comp;
			}

			_timer = setTimeout(() => {
				frappe.call({
					method: "frappe.desk.search.search_link",
					args: {
						txt: txt,
						doctype: doctype,
						ignore_user_permissions: 0,
						reference_doctype: "Sales Invoice",
						filters: filters
					},
					callback: (r) => {
						const results = r.results || r.message || [];
						open(Array.isArray(results) ? results : []);
					},
				});
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
	}

	_update_footer() {
		// Actualiza desde doc (post-save, datos reales de ERPNext)
		const d = this.doc;
		this.$body.find("#ef-subtotal").text(_fmtCurrency(d.total, d.currency));
		this.$body.find("#ef-discounts").text("- " + _fmtCurrency(d.discount_amount, d.currency));
		this.$body.find("#ef-taxes").text(_fmtCurrency(d.total_taxes_and_charges, d.currency));
		this.$body.find("#ef-grand-total").text(_fmtCurrency(d.grand_total, d.currency));
		this.$body.find("#ef-words").text(d.in_words || "");
	}

	// -----------------------------------------------------------------------
	// Lock / Unlock fields (after submit)
	// -----------------------------------------------------------------------

	_lock_fields() {
		const $b = this.$body;
		$b.find(
			"#ef-establecimiento, #ef-naming-series, #ef-posting-date, #ef-due-date, " +
			"#ef-bfel-nit, #ef-bfel-nombre, #ef-bfel-status, #ef-bfel-escenario-exento, #ef-terms"
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
			"#ef-bfel-nit, #ef-bfel-nombre, #ef-bfel-status, #ef-terms"
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
		 "#ef-btn-certify", "#ef-btn-cancel-doc", "#ef-btn-cancel-fel", "#ef-btn-print", "#ef-btn-open-erp", "#ef-btn-customer", "#ef-btn-pdf"].forEach(hide);
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
			// caso 3: pendiente de certificar FEL
			if (!isCertified && d.bfel_status !== "00 No enviar") {
				show("#ef-btn-certify"); enable("#ef-btn-certify");
				show("#ef-btn-cancel-doc"); enable("#ef-btn-cancel-doc"); // Permitir anular desde ERPNext si aún no es FEL
			} else if (isCertified && d.bfel_uuid && !d.bfel_documento_anulado) {
				show("#ef-btn-cancel-fel"); enable("#ef-btn-cancel-fel");
			} else if (!isCertified && d.bfel_status === "00 No enviar") {
				show("#ef-btn-cancel-doc"); enable("#ef-btn-cancel-doc");
			}

		} else if (isCancelled) {
			show("#ef-btn-print"); enable("#ef-btn-print");
			show("#ef-btn-open-erp"); enable("#ef-btn-open-erp");
		}

		// Factura no creada desde FacEx — vista limitada
		if (!isNew && d.es_fiscal === 0) {
			["#ef-btn-save", "#ef-btn-cancel-changes", "#ef-btn-submit", "#ef-btn-certify"].forEach(hide);
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

	_action_submit() {
		if (!this.doc.name || this.doc.name === "new") {
			frappe.show_alert({ message: "Primero guarde la factura.", indicator: "orange" });
			return;
		}

		if (this._request_pending) return;

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
					}
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

	_action_open_erp() {
		if (!this.doc.name || this.doc.name === "new") return;
		const url = `/app/sales-invoice/${encodeURIComponent(this.doc.name)}`;
		window.open(url, "_blank");
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
				$menu.fadeIn(150);
			} else {
				$menu.fadeOut(150);
			}
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

		// Fullscreen focus mode toggle
		this.$body.find("#ef-btn-toggle-fullscreen").on("click", (e) => {
			e.preventDefault();
			this.toggle_focus_mode();
		});

		// Force clean focus mode on load immediately
		$("body").addClass("facex-fullscreen-mode");
		localStorage.setItem("facex-focus-mode", "true");
		this.$body.find("#ef-fullscreen-btn-text").text("Modo ERPNext");
	}

	toggle_focus_mode() {
		const is_focus = $("body").hasClass("facex-fullscreen-mode");
		if (is_focus) {
			$("body").removeClass("facex-fullscreen-mode");
			localStorage.setItem("facex-focus-mode", "false");
			this.$body.find("#ef-fullscreen-btn-text").text("Modo Enfoque");
			frappe.show_alert({ message: "Modo Enfoque desactivado. Se muestran los marcos de ERPNext.", indicator: "info" });
		} else {
			$("body").addClass("facex-fullscreen-mode");
			localStorage.setItem("facex-focus-mode", "true");
			this.$body.find("#ef-fullscreen-btn-text").text("Modo ERPNext");
			frappe.show_alert({ message: "Modo Enfoque activado. Pantalla completa sin distracciones.", indicator: "green" });
		}
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

	_build_save_payload() {
		const d = this.doc;
		if (this.controls.customer) d.customer = this.controls.customer.get_value() || d.customer;
		if (this.controls.payment_terms_template) d.payment_terms_template = this.controls.payment_terms_template.get_value() || d.payment_terms_template;
		if (this.controls.taxes_and_charges) d.taxes_and_charges = this.controls.taxes_and_charges.get_value() || d.taxes_and_charges;
		if (this.controls.sales_partner) d.sales_partner = this.controls.sales_partner.get_value() || d.sales_partner;

		const payload = {
			doctype: "Sales Invoice",
			name: d.name !== "new" ? d.name : undefined,
			es_fiscal: 1,
			update_stock: 0,
			naming_series: d.naming_series,
			customer: d.customer,
			company: d.company || this.defaults.company || "",
			posting_date: d.posting_date,
			due_date: d.due_date,
			payment_terms_template: d.payment_terms_template || "",
			terms: d.terms || "",
			taxes_and_charges: d.taxes_and_charges || "",
			sales_partner: d.sales_partner || "",
			bfel_nit: d.bfel_nit || "",
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

		if (localStorage.getItem(STORAGE_KEY) === "1") {
			$header.addClass("ef-header-collapsed");
		}

		$btn.on("click", () => {
			const collapsed = $header.toggleClass("ef-header-collapsed").hasClass("ef-header-collapsed");
			localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
		});
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
				return {
					filters: { bfel_company: this.doc.company || this.defaults.company || "" }
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
					amount: parseFloat(this.doc.grand_total) || 0,
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
		const checked = !!this.doc.custom_pagado;
		const isSubmitted = this.doc.docstatus === 1;
		const $chk = this.$body.find("#ef-pagado");
		$chk.prop("checked", checked).prop("disabled", !isSubmitted);
		$chk.closest(".ef-toggle").css("opacity", isSubmitted ? "" : "0.5");
		this.$body.find("#ef-pagado-label")
			.text(checked ? "Pagado" : "Pendiente")
			.removeClass("ef-pagado-pending ef-pagado-done")
			.addClass(checked ? "ef-pagado-done" : "ef-pagado-pending");
		const $manualBtn = this.$body.find("#ef-btn-manual-payment");
		const $autoLbl   = this.$body.find("#ef-auto-pay-label");
		if (checked) {
			$manualBtn.show();
			$autoLbl.toggle(!this._manualPayment);
		} else {
			$manualBtn.hide();
			$autoLbl.hide();
		}
	}

	_render_payments_tab() {
		if (!this.doc.custom_efast_payments) this.doc.custom_efast_payments = [];
		const payments = this.doc.custom_efast_payments;
		const $tbody = this.$body.find("#ef-payments-body");
		$tbody.empty();

		if (!payments.length) {
			this.$body.find("#ef-payments-empty").show();
		} else {
			this.$body.find("#ef-payments-empty").hide();
			payments.forEach((p, idx) => $tbody.append(this._payment_row_html(idx, p)));
			this._bind_payment_row_events();
		}
		this._update_payments_total();

		// Detect manual vs auto mode from existing payments
		const _prows = this.doc.custom_efast_payments || [];
		const _isAuto = _prows.length === 1 && _prows[0].reference === "Automático x FacEx";
		if (this.doc.custom_pagado && _prows.length > 0 && !_isAuto) {
			this._manualPayment = true;
		} else if (!this.doc.custom_pagado) {
			this._manualPayment = false;
		}
		// Sync footer pagado UI
		this._sync_pagado_ui();
	}

	_payment_row_html(idx, p) {
		const METHODS = ["Efectivo", "Tarjeta de Crédito", "Transferencia", "Cheque"];
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
			});
			$row.find(".ef-pay-date").off("change").on("change", (e) => {
				payments[idx].payment_date = e.target.value;
			});
			$row.find(".ef-pay-ref").off("input").on("input", (e) => {
				payments[idx].reference = e.target.value;
			});
			$row.find(".ef-pay-amount").off("input change").on("input change", (e) => {
				let val = parseFloat(e.target.value) || 0;
				// Validar que no exceda el saldo de la factura
				const grandTotal = parseFloat(this.doc.grand_total) || 0;
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
		const grandTotal = parseFloat(this.doc.grand_total) || 0;
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
		const grandTotal = parseFloat(this.doc.grand_total) || 0;
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
		const pagado     = this.doc.custom_pagado || 0;
		const grandTotal = parseFloat(this.doc.grand_total) || 0;
		const totalPaid  = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
		const diff       = Math.abs(grandTotal - totalPaid);
		const currency   = this.doc.currency || "GTQ";

		if (diff > 0.01) {
			const msg = totalPaid > grandTotal
				? `El total pagado (${_fmtCurrency(totalPaid, currency)}) supera el total de la factura.`
				: `Hay un saldo pendiente de ${_fmtCurrency(grandTotal - totalPaid, currency)}.`;
			frappe.show_alert({ message: msg, indicator: "orange" });
		}

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
					this.doc.custom_pagado = r.message.pagado;
					frappe.show_alert({ message: "Pagos guardados correctamente.", indicator: "green" });
					this._render_payments_tab();
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
					filters: [
						["Customer", "bfel_company", "=", comp]
					]
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
					filters: [
						["Item", "bfel_company", "=", comp]
					]
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
					filters: [
						["Item Group", "bfel_company", "=", comp]
					]
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

		if (!this.rep_warehouse_ctrl) {
			const get_query_fn = () => {
				const comp = get_company();
				return {
					filters: {
						company: comp
					}
				};
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
			this.$body.find(".ef-filter-date, .ef-filter-customer, .ef-filter-warehouse, .ef-filter-establecimiento").show();
		} else if (report_id === "sales_by_product") {
			this.$body.find(".ef-filter-date, .ef-filter-customer, .ef-filter-item, .ef-filter-item-group, .ef-filter-warehouse, .ef-filter-establecimiento").show();
		} else if (report_id === "cancelled_invoices") {
			this.$body.find(".ef-filter-date, .ef-filter-customer, .ef-filter-establecimiento").show();
		} else if (report_id === "customer_statement") {
			this.$body.find(".ef-filter-customer, .ef-filter-date, .ef-filter-doc-type, .ef-filter-establecimiento").show();
		} else if (report_id === "aging_receivables") {
			this.$body.find(".ef-filter-customer, .ef-filter-establecimiento").show();
		} else if (report_id === "quotations_report") {
			this.$body.find(".ef-filter-date, .ef-filter-customer, .ef-filter-establecimiento").show();
		} else if (report_id === "payments_report") {
			this.$body.find(".ef-filter-date, .ef-filter-payment-method, .ef-filter-establecimiento").show();
		} else if (report_id === "uncertified_invoices") {
			this.$body.find(".ef-filter-establecimiento").show();
		} else if (report_id === "sales_growth_analysis") {
			this.$body.find(".ef-filter-year, .ef-filter-month, .ef-filter-establecimiento").show();
			this.$body.find("#ef-report-chart-container").show();
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
		}

		args.company = this.doc.company || this.defaults.company || "";

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
							<button class="ef-btn ef-btn-sm ef-btn-secondary ef-rep-print-quot" data-name="${inv.name}" style="padding:2px 8px; font-size:10px;">Imprimir F4</button>
						</td>
					</tr>
				`);
			});

			$tbody.off("click", ".ef-rep-print-quot").on("click", ".ef-rep-print-quot", (e) => {
				const name = $(e.currentTarget).data("name");
				frappe.call({
					method: "facex_multi.api.invoice.get_print_formats",
					args: { company: this.doc.company || this.defaults.company || "" },
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
							<button class="ef-btn ef-btn-sm ef-btn-secondary ef-rep-print-receipt" data-name="${pay.invoice}" style="padding:2px 8px; font-size:10px; font-weight:600;">Imprimir Recibo</button>
						</td>
					</tr>
				`);
			});

			$tbody.off("click", ".ef-rep-print-receipt").on("click", ".ef-rep-print-receipt", (e) => {
				const name = $(e.currentTarget).data("name");
				this._print_payment_receipt(name);
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

		frappe.db.get_value("Sales Invoice", inv_name, ["customer_name", "grand_total", "outstanding_amount", "custom_pagado"], (res) => {
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
					const balance = Math.max(0.0, parseFloat(res.grand_total || 0) - totalPaid);

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
						this._print_payment_receipt(inv_name);
					});

					this.$body.find("#ef-print-receipt-details").show();
				}
			});
		});
	}

	_print_payment_receipt(inv_name) {
		frappe.call({
			method: "facex_multi.api.invoice.get_print_formats",
			args: { company: this.doc.company || this.defaults.company || "" },
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
					filters: {
						bfel_company: comp
					}
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
					filters: {
						bfel_company: comp
					}
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

		// Bind automatic item code checkbox logic
		this.$body.on("change", "#ef-maint-item-auto-code", (e) => {
			const checked = $(e.currentTarget).prop("checked");
			if (checked) {
				this.$body.find("#ef-maint-item-code").val("").prop("disabled", true).attr("placeholder", "(Código Automático)");
			} else {
				this.$body.find("#ef-maint-item-code").prop("disabled", false).attr("placeholder", "Ej. PROD-001");
			}
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

		// ── Customers ──
		let custTimer = null;
		this.$body.find("#ef-maint-cust-search").on("input", (e) => {
			clearTimeout(custTimer);
			custTimer = setTimeout(() => {
				this._load_maint_customers($(e.target).val());
			}, 250);
		});

		this.$body.find("#ef-maint-cust-btn-load").on("click", () => {
			const txt = this.$body.find("#ef-maint-cust-search").val();
			this._load_maint_customers(txt);
		});

		this.$body.find("#ef-maint-cust-btn-new").on("click", () => {
			this._clear_maint_cust_form();
		});

		this.$body.find("#ef-maint-cust-btn-save").on("click", () => {
			this._save_maint_customer();
		});

		// ── Products ──
		let itemTimer = null;
		this.$body.find("#ef-maint-item-search").on("input", (e) => {
			clearTimeout(itemTimer);
			itemTimer = setTimeout(() => {
				this._load_maint_items($(e.target).val());
			}, 250);
		});

		this.$body.find("#ef-maint-item-btn-load").on("click", () => {
			const txt = this.$body.find("#ef-maint-item-search").val();
			this._load_maint_items(txt);
		});

		this.$body.find("#ef-maint-item-btn-new").on("click", () => {
			this._clear_maint_item_form();
		});

		this.$body.find("#ef-maint-item-btn-save").on("click", () => {
			this._save_maint_item();
		});

		// ── Prices ──
		let priceTimer = null;
		this.$body.find("#ef-maint-prices-search").on("input", (e) => {
			clearTimeout(priceTimer);
			priceTimer = setTimeout(() => {
				this._load_maint_prices($(e.target).val());
			}, 250);
		});

		this.$body.find("#ef-maint-price-list-select").on("change", () => {
			this._load_maint_prices();
		});

		this.$body.find("#ef-maint-cust-btn-delete").on("click", () => {
			this._delete_maint_customer();
		});

		this.$body.find("#ef-maint-item-btn-delete").on("click", () => {
			this._delete_maint_item();
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
			this._load_maint_customers();
			this._clear_maint_cust_form();
		} else if (tab === "productos") {
			this._load_maint_items();
			this._clear_maint_item_form();
		} else if (tab === "precios") {
			this._load_price_lists_dropdown_then_load_prices();
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

	// ── Customers Maintenance ──

	_load_maint_customers(txt = "") {
		const $list = this.$body.find("#ef-maint-cust-list");
		$list.html('<div style="text-align:center; padding:10px; color:#64748b;">Cargando...</div>');

		frappe.call({
			method: "facex_multi.api.item.get_customers_list",
			args: { txt, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				$list.empty();
				const customers = r.message || [];
				if (customers.length === 0) {
					$list.html('<div style="text-align:center; padding:10px; color:#64748b;">Sin clientes. Use "Cargar Lista" o busque.</div>');
					return;
				}
				customers.forEach((c) => {
					const $item = $(`
						<div class="ef-cust-result" style="padding:8px 12px; cursor:pointer; border-radius:6px; border:1px solid var(--ef-border); background:#ffffff; margin-bottom: 4px;">
							<div style="font-weight:600; color:var(--ef-text);" class="ef-maint-cust-name-lbl"></div>
							<div style="font-size:11px; color:#64748b;" class="ef-maint-cust-id-lbl"></div>
						</div>
					`);
					$item.find(".ef-maint-cust-name-lbl").text(c.customer_name || c.name);
					$item.find(".ef-maint-cust-id-lbl").text(`${c.name} ${c.tax_id ? `| NIT: ${c.tax_id}` : ""}`);
					
					$item.on("click", () => {
						this.$body.find("#ef-maint-cust-list .ef-cust-result").css("background", "#ffffff");
						$item.css("background", "#e0e7ff");
						this._load_maint_customer_details(c.name);
					});
					$list.append($item);
				});
			}
		});
	}

	_load_maint_customer_details(name) {
		frappe.call({
			method: "facex_multi.api.customer.get_customer",
			args: { name },
			callback: (r) => {
				if (r.message) {
					const c = r.message;
					this._current_maint_cust_name = c.name;
					this.$body.find("#ef-maint-cust-title").text(`Editar: ${c.customer_name}`);
					this.$body.find("#ef-maint-cust-name").val(c.customer_name);
					this.$body.find("#ef-maint-cust-ident").val(c.bfel_identificacion);
					this.$body.find("#ef-maint-cust-receptor").val(c.bfel_id_receptor);
					this.$body.find("#ef-maint-cust-phone").val(c.custom_telefono);
					this.$body.find("#ef-maint-cust-addr").val(c.custom_direccion);
					this.$body.find("#ef-maint-cust-dept").val(c.custom_departamento);
					if (this.maint_cust_price_list_ctrl) {
						this.maint_cust_price_list_ctrl.set_value(c.default_price_list || "");
					}
					if (this.maint_cust_payment_terms_ctrl) {
						this.maint_cust_payment_terms_ctrl.set_value(c.payment_terms || "");
					}
					this.$body.find("#ef-maint-cust-btn-delete").show();
				}
			}
		});
	}

	_clear_maint_cust_form() {
		this._current_maint_cust_name = null;
		this.$body.find("#ef-maint-cust-title").text("Nuevo Cliente");
		this.$body.find("#ef-maint-cust-name").val("");
		this.$body.find("#ef-maint-cust-ident").val("");
		this.$body.find("#ef-maint-cust-receptor").val("");
		this.$body.find("#ef-maint-cust-phone").val("");
		this.$body.find("#ef-maint-cust-addr").val("");
		this.$body.find("#ef-maint-cust-dept").val("");
		if (this.maint_cust_price_list_ctrl) {
			this.maint_cust_price_list_ctrl.set_value("");
		}
		if (this.maint_cust_payment_terms_ctrl) {
			this.maint_cust_payment_terms_ctrl.set_value("");
		}
		this.$body.find("#ef-maint-cust-btn-delete").hide();
		this.$body.find("#ef-maint-cust-list .ef-cust-result").css("background", "#ffffff");
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
			custom_telefono: this.$body.find("#ef-maint-cust-phone").val(),
			custom_direccion: this.$body.find("#ef-maint-cust-addr").val(),
			custom_departamento: this.$body.find("#ef-maint-cust-dept").val(),
			default_price_list: this.maint_cust_price_list_ctrl ? this.maint_cust_price_list_ctrl.get_value() : "",
			payment_terms: this.maint_cust_payment_terms_ctrl ? this.maint_cust_payment_terms_ctrl.get_value() : ""
		};

		frappe.call({
			method: "facex_multi.api.customer.create_or_update_customer",
			args: { data_json: JSON.stringify(data) },
			freeze: true,
			freeze_message: "Guardando cliente...",
			callback: (r) => {
				if (!r.exc) {
					frappe.show_alert({ message: "Cliente guardado exitosamente", indicator: "green" });
					this._load_maint_customers();
					this._clear_maint_cust_form();
				}
			}
		});
	}

	// ── Products Maintenance ──

	_load_maint_items(txt = "") {
		const $list = this.$body.find("#ef-maint-item-list");
		$list.html('<div style="text-align:center; padding:10px; color:#64748b;">Cargando...</div>');

		frappe.call({
			method: "facex_multi.api.item.search_items",
			args: { txt, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				$list.empty();
				const items = r.message || [];
				if (items.length === 0) {
					$list.html('<div style="text-align:center; padding:10px; color:#64748b;">Sin productos. Use "Cargar Lista" o busque.</div>');
					return;
				}
				items.forEach((it) => {
					const $item = $(`
						<div class="ef-cust-result" style="padding:8px 12px; cursor:pointer; border-radius:6px; border:1px solid var(--ef-border); background:#ffffff; margin-bottom: 4px;">
							<div style="font-weight:600; color:var(--ef-text);" class="ef-maint-item-name-lbl"></div>
							<div style="font-size:11px; color:#64748b;" class="ef-maint-item-code-lbl"></div>
						</div>
					`);
					$item.find(".ef-maint-item-name-lbl").text(it.item_name || it.name);
					$item.find(".ef-maint-item-code-lbl").text(`Código: ${it.name} | UOM: ${it.stock_uom}`);
					
					$item.on("click", () => {
						this.$body.find("#ef-maint-item-list .ef-cust-result").css("background", "#ffffff");
						$item.css("background", "#e0e7ff");
						this._load_maint_item_details(it.name);
					});
					$list.append($item);
				});
			}
		});
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
					this.$body.find("#ef-maint-item-btn-delete").show();
				}
			}
		});
	}

	_clear_maint_item_form() {
		this._current_maint_item_code = null;
		this.$body.find("#ef-maint-item-title").text("Nuevo Producto");
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
		this.$body.find("#ef-maint-item-btn-delete").hide();
		this.$body.find("#ef-maint-item-list .ef-cust-result").css("background", "#ffffff");
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
			description: this.$body.find("#ef-maint-item-desc").val()
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
					this._load_maint_items();
					this._clear_maint_item_form();
				}
			}
		});
	}

	// ── Prices Maintenance ──

	_load_maint_prices(txt = "") {
		const $tbody = this.$body.find("#ef-maint-prices-tbody");
		const plist = this.$body.find("#ef-maint-price-list-select").val();

		if (!plist) {
			$tbody.html('<tr><td colspan="5" style="text-align:center; padding:10px; color:#64748b;">Seleccione una Lista de Precios primero</td></tr>');
			return;
		}

		$tbody.html('<tr><td colspan="5" style="text-align:center; padding:10px; color:#64748b;">Cargando precios...</td></tr>');

		frappe.call({
			method: "facex_multi.api.item.get_all_prices",
			args: { price_list: plist, txt, company: this.doc.company || this.defaults.company || "" },
			callback: (r) => {
				$tbody.empty();
				const items = r.message || [];
				if (items.length === 0) {
					$tbody.html('<tr><td colspan="5" style="text-align:center; padding:10px; color:#64748b;">Sin productos</td></tr>');
					return;
				}
				items.forEach((it) => {
					const $row = $(`
						<tr class="ef-tr">
							<td class="ef-td font-weight-bold ef-lbl-code"></td>
							<td class="ef-td ef-lbl-name"></td>
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
					$row.find(".ef-lbl-uom").text(it.stock_uom);
					$row.find(".ef-lbl-currency").text(it.currency || "GTQ");
					
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
			}
		});
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
							this._load_maint_customers();
							this._clear_maint_cust_form();
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
							this._load_maint_items();
							this._clear_maint_item_form();
						}
					}
				});
			}
		);
	}
}


// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

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
