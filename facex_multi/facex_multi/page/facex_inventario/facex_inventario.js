// FacEx Multi — Módulo de Inventario (Entradas / Salidas / Transferencias / Reportes)
// Interfaz amigable sobre Stock Entry / Warehouse / Batch / Serial No nativos de ERPNext.
// Toda la lógica de stock, valuación y GL permanece en ERPNext core.
//
// Entradas y Salidas comparten toda la pantalla (formulario, grid, flotante de
// existencia, resultado post-guardado, pestaña de movimientos) mediante un
// parámetro "mode" ('in'/'out') — evita mantener dos copias del mismo flujo.

frappe.pages["facex-inventario"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "Inventario — FacEx",
		single_column: true,
	});
	// Mismo Modo Enfoque que FacEx / FacEx Screen. Frappe Desk es un SPA —
	// el <body> persiste entre rutas — así que hay que quitar la clase apenas
	// el usuario navega a OTRA pantalla, o el resto de ERPNext se quedaría
	// sin navbar/sidebar.
	$("body").addClass("facex-fullscreen-mode");
	frappe.router.on("change", () => {
		if (frappe.get_route()[0] !== "facex-inventario") {
			$("body").removeClass("facex-fullscreen-mode");
		}
	});
	// facex_transporte_module.js: mismo módulo compartido con FacEx clásico y
	// FacEx Screen para el menú aéreo de Transporte (ver _open_transporte).
	frappe.require(["/assets/facex_multi/js/facex_transporte_module.js"], function () {
		wrapper.facexInventario = new FacexInventario(page, wrapper);
		facex_multi.setup_back_guard({ to: "/app", is_dirty: () => (wrapper.facexInventario.entry_rows || []).length > 0 });
	});
};

frappe.pages["facex-inventario"].on_page_show = function (wrapper) {
	$("body").addClass("facex-fullscreen-mode");
	if (!wrapper.facexInventario) return;
	// Rearmar en cada re-entrada: on_page_load solo corre una vez por sesión
	// de pestaña (ver history_guard.js), así que sin esto el guard del botón
	// Atrás dejaría de funcionar después de la primera visita a esta página.
	facex_multi.setup_back_guard({ to: "/app", is_dirty: () => (wrapper.facexInventario.entry_rows || []).length > 0 });
};

const INV_MOVEMENTS = [
	{ key: "puede_hacer_entradas", id: "inv-card-entradas", mode: "in", title: "Entradas", desc: "Registrar ingresos de mercadería a un almacén." },
	{ key: "puede_hacer_salidas", id: "inv-card-salidas", mode: "out", title: "Salidas", desc: "Registrar egresos de mercadería de un almacén." },
	{ key: "puede_hacer_transferencias", id: "inv-card-transferencias", mode: "transfer", title: "Transferencias", desc: "Mover mercadería entre almacenes de la misma compañía." },
];

const INV_REPORTS = [
	{ key: "reporte_inv_kardex", id: "inv-rep-kardex", title: "Kardex de Movimientos", desc: "Entradas, salidas y transferencias por fecha, almacén o producto." },
	{ key: "reporte_inv_existencias", id: "inv-rep-existencias", title: "Existencias", desc: "Status de stock por almacén, antigüedad y productos sin rotación." },
	{ key: "reporte_inv_trazabilidad", id: "inv-rep-trazabilidad", title: "Trazabilidad Serie / Lote", desc: "Ubicación e historial por número de serie o lote." },
];

// Listas de Materiales para venta (paquetes/kits) y su operación de Transformación.
const INV_BOM = [
	{ key: "gestiona_listas_materiales", id: "inv-bom-listas", bom: "listas", title: "Listas de Materiales", desc: "Crear paquetes/kits de venta combinando varios productos, con stock en el padre o en los componentes." },
	{ key: "puede_hacer_transformaciones", id: "inv-bom-transformar", bom: "transformar", title: "Transformación", desc: "Convertir componentes en unidades del producto padre (solo Listas de Materiales con stock en el padre)." },
];

const WAREHOUSE_FIELD_LABEL = { source: "Almacén origen", target: "Almacén destino" };

const MOVEMENT_CONFIG = {
	in: {
		label: "Entrada",
		fields: ["target"],
		show_cost: true,
		show_account: true,
		show_total: true,
		api_create: "facex_multi.api.stock.create_stock_entry_in",
		api_list: "facex_multi.api.stock.list_stock_entries_in",
	},
	out: {
		label: "Salida",
		fields: ["source"],
		show_cost: false,
		show_account: true,
		show_total: true,
		api_create: "facex_multi.api.stock.create_stock_entry_out",
		api_list: "facex_multi.api.stock.list_stock_entries_out",
	},
	transfer: {
		label: "Transferencia",
		fields: ["source", "target"],
		show_cost: false,
		show_account: false,
		show_total: false,
		api_create: "facex_multi.api.stock.create_stock_entry_transfer",
		api_list: "facex_multi.api.stock.list_stock_entries_transfer",
	},
};

function cint(v) {
	return parseInt(v) || 0;
}

function flt(v) {
	return parseFloat(v) || 0;
}

class FacexInventario {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.$page_root = $(page.body);
		this.defaults = null;
		this.page.add_menu_item(__("FacEx - Clásico"), () => {
			window.location.href = "/app/facex";
		});
		// Barra superior (marca + accesos + perfil de usuario) persistente:
		// se dibuja UNA sola vez, fuera del área que las pantallas internas
		// (_render_shell / _render_movement / reportes / etc.) reemplazan por
		// completo en cada navegación — por eso this.$body queda apuntando al
		// contenedor interno, no al body completo de la página.
		this._render_topbar();
		this.$body = this.$page_root.find("#inv-content-root");
		this._init();
	}

	// ──────────────────────────────────────────────
	// Barra superior — misma marca/patrón de perfil de usuario (compañía,
	// contraseña, cerrar sesión) ya replicado en FacEx y FacEx Screen. Aquí
	// además hace de reemplazo al menú "..." estándar de Frappe, que el Modo
	// Enfoque oculta junto con el resto del navbar/page-head.
	// ──────────────────────────────────────────────

	_render_topbar() {
		this.$page_root.html(`
<style>${INV_TOPBAR_STYLES}</style>
<div class="inv-topbar">
	<div class="inv-topbar-left">
		<span class="inv-topbar-logo" id="inv-topbar-logo" title="Ir al menú principal" style="cursor:pointer;">
			<svg width="18" height="18" viewBox="0 0 24 24" fill="#153375"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
			FacEx <span class="inv-topbar-sub">Inventario</span>
		</span>
	</div>
	<div class="inv-topbar-right">
		<button type="button" class="inv-topbar-link" id="inv-topbar-billing">Facturador</button>
		<button type="button" class="inv-topbar-link" id="inv-topbar-pos">POS</button>
		<div class="inv-transporte-dropdown" id="inv-transporte-dropdown" style="display:none;">
			<button type="button" class="inv-topbar-link inv-transporte-btn" id="inv-btn-transporte" title="Transporte">
				Transporte
				<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
			</button>
			<div class="inv-transporte-menu" id="inv-transporte-menu"></div>
		</div>
		<div class="inv-user-dropdown" id="inv-user-dropdown">
			<button class="inv-user-btn" id="inv-btn-user-profile" title="Perfil de Usuario">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>
			</button>
			<div class="inv-user-menu" id="inv-user-menu" style="display:none;">
				<div class="inv-user-menu-label">Usuario Conectado</div>
				<div class="inv-user-fullname" id="inv-active-user-fullname"></div>
				<div class="inv-user-email" id="inv-active-user-email"></div>
				<div class="inv-company-switcher" id="inv-company-switcher-section" style="display:none;">
					<div class="inv-user-menu-label">Cambiar Compañía</div>
					<select id="inv-user-company-select" class="inv-select inv-company-select"></select>
					<button type="button" class="inv-btn inv-btn-secondary inv-user-menu-btn" id="inv-btn-switch-company">Aplicar Compañía</button>
					<hr />
				</div>
				<button type="button" class="inv-btn inv-btn-secondary inv-user-menu-btn" id="inv-btn-change-password">Cambiar Contraseña</button>
				<button type="button" class="inv-btn inv-btn-danger inv-user-menu-btn" id="inv-btn-logout">Cerrar Sesión</button>
			</div>
		</div>
	</div>
</div>
<div id="inv-content-root"></div>
		`);

		this.$page_root.find("#inv-topbar-billing").on("click", () => { window.location.href = "/app/facex"; });
		this.$page_root.find("#inv-topbar-pos").on("click", () => { window.location.href = "/app/facex-screen"; });

		// Logo (icono de compañía): un click lleva siempre al menú principal
		// de Inventario, mismo criterio que el icono de compañía en FacEx
		// clásico y FacEx Screen. Ignorado mientras this.defaults todavía no
		// ha terminado de cargar (primer render, antes de _load_defaults).
		this.$page_root.find("#inv-topbar-logo").on("click", () => {
			if (this.defaults) this._render_shell();
		});

		// Menú aéreo de Transporte — mismo patrón de dropdown flotante que el
		// perfil de usuario (toggle + cierre al hacer click afuera), poblado
		// una vez que this.defaults.permissions esté listo (ver _render_transporte_menu).
		this.$page_root.find("#inv-btn-transporte").on("click", (e) => {
			e.stopPropagation();
			const $menu = this.$page_root.find("#inv-transporte-menu");
			if ($menu.is(":hidden")) $menu.fadeIn(150);
			else $menu.fadeOut(150);
		});
		$(document).off(".invTransporteMenu").on("click.invTransporteMenu", (e) => {
			const $menu = this.$page_root.find("#inv-transporte-menu");
			if ($menu.length && !$(e.target).closest("#inv-transporte-dropdown").length) {
				$menu.fadeOut(150);
			}
		});

		this.$page_root.find("#inv-btn-user-profile").on("click", (e) => {
			e.stopPropagation();
			const $menu = this.$page_root.find("#inv-user-menu");
			if ($menu.is(":hidden")) {
				this.$page_root.find("#inv-active-user-fullname").text(frappe.session.user_fullname || "Usuario");
				this.$page_root.find("#inv-active-user-email").text(frappe.session.user);
				frappe.call({
					method: "facex_multi.api.invoice.get_user_companies",
					callback: (r) => {
						const companies = r.message || [];
						if (companies.length > 1) {
							const $sel = this.$page_root.find("#inv-user-company-select");
							const $sec = this.$page_root.find("#inv-company-switcher-section");
							const currentCompany = (this.defaults && this.defaults.company) || "";
							$sel.html(companies.map((c) => `<option value="${frappe.utils.escape_html(c)}" ${c === currentCompany ? "selected" : ""}>${frappe.utils.escape_html(c)}</option>`).join(""));
							$sec.show();
						}
					},
				});
				$menu.fadeIn(150);
			} else {
				$menu.fadeOut(150);
			}
		});

		this.$page_root.find("#inv-btn-switch-company").on("click", (e) => {
			e.stopPropagation();
			const company = this.$page_root.find("#inv-user-company-select").val();
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
				},
			});
		});

		this.$page_root.find("#inv-btn-logout").on("click", () => frappe.app.logout());

		this.$page_root.find("#inv-btn-change-password").on("click", (e) => {
			e.stopPropagation();
			this.$page_root.find("#inv-user-menu").fadeOut(150);
			this._show_change_password_dialog();
		});

		// Namespace propio (.invUserMenu), distinto de ".facexInv" que las
		// pantallas internas limpian en cada navegación — así el cierre del
		// dropdown de usuario sigue funcionando sin importar qué pantalla
		// interna esté activa.
		$(document).off(".invUserMenu").on("click.invUserMenu", (e) => {
			const $menu = this.$page_root.find("#inv-user-menu");
			if ($menu.length && !$(e.target).closest("#inv-user-dropdown").length) {
				$menu.fadeOut(150);
			}
		});
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

	// ──────────────────────────────────────────────
	// Transporte — menú aéreo de la topbar. Reutiliza FacexTransporteModule
	// (mismo módulo compartido con FacEx clásico / FacEx Screen); cada ítem
	// salta directo a su sección, gateado por su propio permiso específico
	// (mismo criterio que ya usan las tarjetas del hub del módulo).
	// ──────────────────────────────────────────────

	_has_transporte_access() {
		const p = (this.defaults && this.defaults.permissions) || {};
		if (!p.puede_ver_menu_transporte) return false;
		return !!(p.puede_editar_guias_transporte || p.puede_administrar_transportistas
			|| p.puede_ver_reportes_transporte || p.puede_cargar_liquidaciones_transporte || p.puede_ver_kpis_transporte);
	}

	_render_transporte_menu() {
		const hasAccess = this._has_transporte_access();
		this.$page_root.find("#inv-transporte-dropdown").toggle(hasAccess);
		if (!hasAccess) return;

		const p = this.defaults.permissions || {};
		const items = [];
		if (p.puede_administrar_transportistas) items.push({ label: "Transportistas", method: "showTransportistas" });
		if (p.puede_editar_guias_transporte) {
			items.push({ label: "Envíos Pendientes", method: "showPendingGuias" });
			items.push({ label: "Guías", method: "showGuias" });
		}
		if (p.puede_cargar_liquidaciones_transporte) items.push({ label: "Liquidaciones", method: "showLiquidaciones" });
		if (p.puede_ver_reportes_transporte) items.push({ label: "Reportes de Transporte", method: "showReportes" });

		const $menu = this.$page_root.find("#inv-transporte-menu");
		$menu.html(items.map((it) =>
			`<button type="button" class="inv-transporte-menu-item" data-method="${it.method}">${frappe.utils.escape_html(it.label)}</button>`
		).join(""));
		$menu.find(".inv-transporte-menu-item").on("click", (e) => {
			$menu.fadeOut(150);
			this._open_transporte($(e.currentTarget).data("method"));
		});
	}

	_transporte_module() {
		const ctx = { perms: this.defaults.permissions || {}, company: this.defaults.company };
		if (!this._transporteModuleInstance) {
			this._transporteModuleInstance = new FacexTransporteModule({
				$container: this.$body,
				...ctx,
				onBack: () => this._render_shell(),
			});
		} else {
			this._transporteModuleInstance.setContext(ctx);
		}
		return this._transporteModuleInstance;
	}

	_open_transporte(method) {
		this._transporte_module()[method]();
	}

	_init() {
		this._render_loading();
		this._load_defaults();
	}

	_render_loading() {
		this.$body.off();
		$(document).off(".facexInv");
		this.$body.html(`<div style="padding:40px;text-align:center;color:#6c757d;">Cargando...</div>`);
	}

	_load_defaults(company) {
		frappe.call({
			method: "facex_multi.api.stock.get_inventory_defaults",
			args: { company: company || null },
			callback: (r) => {
				this.defaults = r.message || {};
				this._render_transporte_menu();
				this._render_shell();
			},
			error: () => {
				this.$body.html(`<div style="padding:40px;text-align:center;color:#e03e2d;">No se pudo cargar el módulo de Inventario.</div>`);
			},
		});
	}

	// ──────────────────────────────────────────────
	// Shell principal (tarjetas de Movimientos / Reportes)
	// ──────────────────────────────────────────────

	_render_shell() {
		const d = this.defaults;
		const perms = d.permissions || {};
		const companies = d.companies || [];

		if (!companies.length) {
			this.$body.off();
			$(document).off(".facexInv");
			this.$body.html(`
<div style="max-width:600px;margin:60px auto;text-align:center;">
  <div style="font-size:15px;color:#495057;">No tiene ninguna compañía asignada.</div>
  <div style="font-size:13px;color:#6c757d;margin-top:6px;">Contacte a un administrador para que le asigne una compañía.</div>
</div>`);
			return;
		}

		this.$body.html(`
<div id="inv-app" style="max-width:1200px;margin:0 auto;padding:16px 8px;">

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 20px;margin-bottom:16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;justify-content:space-between;">
    <div style="display:flex;align-items:center;gap:10px;">
      <label class="inv-label" style="margin:0;">Compañía</label>
      <select id="inv-company" class="inv-select" style="min-width:220px;">
        ${companies.map(c => `<option value="${frappe.utils.escape_html(c)}" ${c === d.company ? "selected" : ""}>${frappe.utils.escape_html(c)}</option>`).join("")}
      </select>
    </div>
  </div>

  ${!perms.puede_ver_inventario ? `
  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:40px;text-align:center;">
    <div style="font-size:15px;color:#495057;">No tiene acceso al módulo de Inventario para esta compañía.</div>
    <div style="font-size:13px;color:#6c757d;margin-top:6px;">Contacte a un administrador para solicitar acceso.</div>
  </div>
  ` : `
  <div style="font-size:13px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;margin:4px 0 10px;">Movimientos</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-bottom:24px;">
    ${INV_MOVEMENTS.map(m => this._movement_card(m, !!perms[m.key])).join("")}
  </div>

  <div style="font-size:13px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;margin:4px 0 10px;">Listas de Materiales para Venta</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin-bottom:24px;">
    ${INV_BOM.map(b => this._bom_card(b, !!perms[b.key])).join("")}
  </div>

  <div style="font-size:13px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;margin:4px 0 10px;">Reportes de Operaciones</div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;">
    ${INV_REPORTS.map(r => this._report_card(r, !!perms[r.key])).join("")}
  </div>
  `}

</div>

<style>${INV_STYLES}</style>
		`);

		this._bind_shell_events();
	}

	_movement_card(item, allowed) {
		return `
<div id="${item.id}" class="inv-card ${allowed ? "" : "inv-card-disabled"}" data-action="${allowed ? item.key : ""}">
  <div class="inv-card-title">${item.title}</div>
  <div class="inv-card-desc">${item.desc}</div>
  ${allowed ? `<div class="inv-card-tag">Abrir →</div>` : `<div class="inv-card-tag" style="color:#adb5bd;">Sin acceso</div>`}
</div>`;
	}

	_report_card(item, allowed) {
		return `
<div id="${item.id}" class="inv-card ${allowed ? "" : "inv-card-disabled"}" data-report="${allowed ? item.key : ""}">
  <div class="inv-card-title">${item.title}</div>
  <div class="inv-card-desc">${item.desc}</div>
  ${allowed ? `<div class="inv-card-tag">Ver reporte →</div>` : `<div class="inv-card-tag" style="color:#adb5bd;">Sin acceso</div>`}
</div>`;
	}

	_bom_card(item, allowed) {
		return `
<div id="${item.id}" class="inv-card ${allowed ? "" : "inv-card-disabled"}" data-bom="${allowed ? item.bom : ""}">
  <div class="inv-card-title">${item.title}</div>
  <div class="inv-card-desc">${item.desc}</div>
  ${allowed ? `<div class="inv-card-tag">Abrir →</div>` : `<div class="inv-card-tag" style="color:#adb5bd;">Sin acceso</div>`}
</div>`;
	}

	_bind_shell_events() {
		// Siempre limpiar TODO lo previamente atado a $body antes de re-atar
		// (causa raíz de un bug ya corregido: handlers se acumulaban en cada render).
		this.$body.off();
		$(document).off(".facexInv");

		this.$body.on("change", "#inv-company", (e) => {
			this._load_defaults(e.target.value);
		});

		this.$body.on("click", "[data-action]", (e) => {
			const action = $(e.currentTarget).data("action");
			if (!action) return;
			const cfgItem = INV_MOVEMENTS.find((m) => m.key === action);
			if (cfgItem && cfgItem.mode) {
				this._open_movement(cfgItem.mode);
				return;
			}
			frappe.show_alert({ message: __("Próximamente: {0}", [action]), indicator: "blue" });
		});

		this.$body.on("click", "[data-report]", (e) => {
			const report = $(e.currentTarget).data("report");
			if (!report) return;
			if (report === "reporte_inv_kardex") { this._open_kardex(); return; }
			if (report === "reporte_inv_existencias") { this._open_existencias(); return; }
			if (report === "reporte_inv_trazabilidad") { this._open_trazabilidad(); return; }
			frappe.show_alert({ message: __("Próximamente: {0}", [report]), indicator: "blue" });
		});

		this.$body.on("click", "[data-bom]", (e) => {
			const bom = $(e.currentTarget).data("bom");
			if (!bom) return;
			if (bom === "listas") { this._open_lista_materiales(); return; }
			if (bom === "transformar") { this._open_transformacion(); return; }
		});
	}

	// ──────────────────────────────────────────────
	// Entradas / Salidas / Transferencias (Stock Entry)
	// ──────────────────────────────────────────────

	_open_movement(mode, prefill) {
		this.mode = mode;
		this.entry_rows = [];
		this._entry_uid = 0;
		this._saving = false;
		this._client_token = frappe.utils.get_random(20);

		this._entry_prefill_source = (prefill && prefill.source_warehouse) || "";
		this._entry_prefill_target = (prefill && prefill.target_warehouse) || "";
		this._entry_prefill_remarks = (prefill && prefill.remarks) || "";

		if (prefill && prefill.items) {
			prefill.items.forEach((it) => {
				this._entry_uid += 1;
				this.entry_rows.push({ ...it, uid: this._entry_uid });
			});
		}

		this._render_movement();
	}

	_render_movement() {
		const d = this.defaults;
		const cfg = MOVEMENT_CONFIG[this.mode];
		const warehouses = d.warehouses || [];
		const first_day = frappe.datetime.month_start();
		const last_day = frappe.datetime.month_end();

		this.$body.html(`
<div id="inv-entradas-app" style="max-width:1200px;margin:0 auto;padding:16px 8px;">

  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
    <button type="button" id="inv-back" class="inv-btn inv-btn-secondary">&larr; Volver</button>
    <div style="font-size:16px;font-weight:600;color:#333;">${cfg.label} de Inventario</div>
    <div style="font-size:12.5px;color:#6c757d;">${frappe.utils.escape_html(d.company)}</div>
  </div>

  <div class="inv-tabs">
    <div class="inv-tab inv-tab-active" data-tab="nueva">Nueva ${cfg.label}</div>
    <div class="inv-tab" data-tab="movs">Movimientos del Mes</div>
  </div>

  <div id="inv-e-tab-nueva">

    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:18px 20px;margin-bottom:16px;">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;">
        ${cfg.fields.map(f => `
        <div>
          <label class="inv-label">${WAREHOUSE_FIELD_LABEL[f]} <span style="color:#e03e2d;">*</span></label>
          <select id="inv-e-warehouse-${f}" class="inv-select inv-e-warehouse-field" data-wh="${f}" style="width:100%;">
            <option value="">Seleccione...</option>
            ${warehouses.map(w => `<option value="${frappe.utils.escape_html(w)}" ${w === (f === "source" ? this._entry_prefill_source : this._entry_prefill_target) ? "selected" : ""}>${frappe.utils.escape_html(w)}</option>`).join("")}
          </select>
        </div>`).join("")}
        <div>
          <label class="inv-label">Fecha</label>
          <input type="date" id="inv-e-date" class="inv-select" style="width:100%;" value="${frappe.datetime.get_today()}">
        </div>
        <div style="grid-column:1/-1;">
          <label class="inv-label">Comentario</label>
          <input type="text" id="inv-e-remarks" class="inv-select" style="width:100%;" placeholder="Motivo de la ${cfg.label.toLowerCase()} (opcional)" value="${frappe.utils.escape_html(this._entry_prefill_remarks)}">
        </div>
      </div>
    </div>

    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:18px 20px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:flex-end;gap:14px;flex-wrap:wrap;">
      <div style="flex:1;min-width:260px;">
        <label class="inv-label">Buscar producto para agregar</label>
        <div style="position:relative;max-width:420px;">
          <input type="text" id="inv-e-item-search" class="inv-select" style="width:100%;" placeholder="Código o nombre del producto..." autocomplete="off">
          <div id="inv-e-item-results" class="inv-autocomplete"></div>
        </div>
      </div>
      <button type="button" id="inv-e-paste-btn" class="inv-btn inv-btn-secondary" title="También puede pegar (Ctrl+V) directamente sobre la tabla">Pegar datos</button>
    </div>

    <div class="card" id="inv-e-grid-card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;margin-bottom:16px;overflow-x:auto;">
      <table class="inv-table" style="width:100%;">
        <thead>
          <tr>
            <th>Producto</th>
            <th style="width:100px;">Cantidad</th>
            <th style="width:80px;">UOM</th>
            <th style="width:140px;">Lote</th>
            <th style="width:200px;">N° de Serie</th>
            ${cfg.show_account ? `<th style="width:180px;">Cuenta Contable</th>` : ""}
            ${cfg.show_cost ? `<th style="width:110px;">Costo Unit.</th>` : ""}
            ${cfg.show_total ? `<th style="width:120px;">Total</th>` : ""}
            <th style="width:50px;"></th>
          </tr>
        </thead>
        <tbody id="inv-e-tbody"></tbody>
        ${cfg.show_total ? `
        <tfoot>
          <tr>
            <td colspan="${5 + (cfg.show_account ? 1 : 0) + (cfg.show_cost ? 1 : 0)}" style="text-align:right;font-weight:600;color:#495057;border-top:2px solid #dee2e6;">Total General</td>
            <td style="font-weight:700;color:#333;border-top:2px solid #dee2e6;" id="inv-e-grand-total">Q 0.00</td>
            <td style="border-top:2px solid #dee2e6;"></td>
          </tr>
        </tfoot>` : ""}
      </table>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button type="button" id="inv-e-save" class="inv-btn inv-btn-primary">Guardar ${cfg.label}</button>
    </div>

  </div>

  <div id="inv-e-tab-movs" style="display:none;">

    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 20px;margin-bottom:16px;display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;">
      <div>
        <label class="inv-label">Desde</label>
        <input type="date" id="inv-m-from" class="inv-select" value="${first_day}">
      </div>
      <div>
        <label class="inv-label">Hasta</label>
        <input type="date" id="inv-m-to" class="inv-select" value="${last_day}">
      </div>
      <button type="button" id="inv-m-refresh" class="inv-btn inv-btn-secondary">Actualizar</button>
    </div>

    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;overflow-x:auto;">
      <table class="inv-table" style="width:100%;">
        <thead>
          <tr>
            <th>Documento</th>
            <th>Fecha</th>
            <th>Almacén</th>
            <th style="width:70px;">Ítems</th>
            <th style="width:110px;">Valor</th>
            <th style="width:90px;">Estado</th>
            <th>Comentario</th>
          </tr>
        </thead>
        <tbody id="inv-m-tbody"><tr><td colspan="7" style="text-align:center;color:#adb5bd;padding:20px;">Cargando...</td></tr></tbody>
      </table>
    </div>

  </div>

</div>

<style>${INV_STYLES}</style>
		`);

		this._render_entry_rows();
		this._bind_movement_events();
	}

	_switch_movement_tab(tab) {
		this.$body.find(".inv-tab").removeClass("inv-tab-active");
		this.$body.find(`.inv-tab[data-tab="${tab}"]`).addClass("inv-tab-active");
		this.$body.find("#inv-e-tab-nueva").toggle(tab === "nueva");
		this.$body.find("#inv-e-tab-movs").toggle(tab === "movs");
		if (tab === "movs") this._load_movement_list();
	}

	_load_movement_list() {
		const cfg = MOVEMENT_CONFIG[this.mode];
		const from_date = this.$body.find("#inv-m-from").val();
		const to_date = this.$body.find("#inv-m-to").val();
		const $tbody = this.$body.find("#inv-m-tbody");
		$tbody.html(`<tr><td colspan="7" style="text-align:center;color:#adb5bd;padding:20px;">Cargando...</td></tr>`);

		frappe.call({
			method: cfg.api_list,
			args: { company: this.defaults.company, from_date, to_date },
			callback: (r) => {
				const rows = (r.message && r.message.rows) || [];
				if (!rows.length) {
					$tbody.html(`<tr><td colspan="7" style="text-align:center;color:#adb5bd;padding:20px;">Sin movimientos en este rango.</td></tr>`);
					return;
				}
				const STATUS = { 0: ["Borrador", "#6c757d"], 1: ["Sometido", "#28a745"], 2: ["Anulado", "#e03e2d"] };
				$tbody.html(rows.map((row) => {
					const [label, color] = STATUS[row.docstatus] || STATUS[0];
					const warehouse_display = this.mode === "transfer"
						? `${row.from_warehouse || ""} → ${row.to_warehouse || ""}`
						: (row.from_warehouse || row.to_warehouse || "");
					const value = this.mode === "in" ? row.total_incoming_value : row.total_outgoing_value;
					return `
<tr class="inv-mov-row" data-view="${frappe.utils.escape_html(row.name)}">
  <td><strong>${frappe.utils.escape_html(row.name)}</strong></td>
  <td>${frappe.utils.escape_html(row.posting_date || "")}</td>
  <td>${frappe.utils.escape_html(warehouse_display)}</td>
  <td>${row.item_count}</td>
  <td>${frappe.format(value, { fieldtype: "Currency" })}</td>
  <td><span style="color:${color};font-weight:600;">${label}</span></td>
  <td>${frappe.utils.escape_html(row.remarks || "")}</td>
</tr>`;
				}).join(""));
			},
		});
	}

	_render_entry_rows() {
		const cfg = MOVEMENT_CONFIG[this.mode];
		const pick_serials = cfg.fields.includes("source"); // out/transfer: la serie ya debe existir
		const ncols = 6 + (cfg.show_account ? 1 : 0) + (cfg.show_cost ? 1 : 0) + (cfg.show_total ? 1 : 0);
		const $tbody = this.$body.find("#inv-e-tbody");
		if (!this.entry_rows.length) {
			$tbody.html(`<tr id="inv-e-empty-row"><td colspan="${ncols}" style="text-align:center;color:#adb5bd;padding:20px;">Busque un producto arriba para agregarlo.</td></tr>`);
			this._recompute_grand_total();
			return;
		}
		$tbody.html(this.entry_rows.map((row) => `
<tr data-row-id="${row.uid}">
  <td>
    <span class="inv-row-info" data-info="${row.uid}" title="Ver existencia y costo">&#9432;</span>
    <strong>${frappe.utils.escape_html(row.item_code)}</strong><br>
    <span style="color:#6c757d;">${frappe.utils.escape_html(row.item_name || "")}</span>
  </td>
  <td><input type="number" min="0" step="any" class="inv-e-field" data-field="qty" value="${row.qty}"></td>
  <td><input type="text" class="inv-e-field" data-field="uom" value="${frappe.utils.escape_html(row.uom || "")}"></td>
  <td>${row.has_batch_no ? `<input type="text" class="inv-e-field" data-field="batch_no" value="${frappe.utils.escape_html(row.batch_no || "")}" placeholder="Lote">` : `<span style="color:#adb5bd;">—</span>`}</td>
  <td>${this._render_serial_cell(row, cfg, pick_serials)}</td>
  ${cfg.show_account ? `<td><input type="text" class="inv-e-field" data-field="expense_account" value="${frappe.utils.escape_html(row.expense_account || "")}" placeholder="${row._account_loading ? "Cargando…" : "Cuenta contable"}"></td>` : ""}
  ${cfg.show_cost ? `<td><input type="number" min="0" step="any" class="inv-e-field" data-field="rate" value="${row.rate || ""}" placeholder="0.00"></td>` : ""}
  ${cfg.show_total ? `<td class="inv-total-cell">${this._format_row_total(row)}</td>` : ""}
  <td><span class="inv-row-remove" data-remove="${row.uid}">&times;</span></td>
</tr>
		`).join(""));

		this._recompute_grand_total();
	}

	_render_serial_cell(row, cfg, pick_serials) {
		if (!row.has_serial_no) return `<span style="color:#adb5bd;">—</span>`;
		if (!pick_serials) {
			return `<input type="text" class="inv-e-field" data-field="serial_no" value="${frappe.utils.escape_html(row.serial_no || "")}" placeholder="Uno por línea o coma">`;
		}
		const count = (row.serial_no || "").split(/\n|,/).map((s) => s.trim()).filter(Boolean).length;
		const qty_n = cint(row.qty);
		const ok = qty_n > 0 && count === qty_n;
		return `<span class="inv-serial-picker" data-row="${row.uid}" style="cursor:pointer;text-decoration:underline;color:${ok ? "#28a745" : "#5e64ff"};">${count}/${qty_n || 0} series ${ok ? "&#10003;" : "— elegir"}</span>`;
	}

	_format_row_total(row) {
		const rate = this.mode === "in" ? flt(row.rate) : flt(row.auto_rate);
		const total = flt(row.qty) * rate;
		const sub = this.mode === "out"
			? `<br><span style="color:#adb5bd;font-size:10.5px;">@ ${frappe.format(rate, { fieldtype: "Currency" })}</span>`
			: "";
		return `${frappe.format(total, { fieldtype: "Currency" })}${sub}`;
	}

	_recompute_grand_total() {
		const cfg = MOVEMENT_CONFIG[this.mode];
		if (!cfg.show_total) return;
		let grand = 0;
		this.entry_rows.forEach((row) => {
			const rate = this.mode === "in" ? flt(row.rate) : flt(row.auto_rate);
			grand += flt(row.qty) * rate;
		});
		this.$body.find("#inv-e-grand-total").html(frappe.format(grand, { fieldtype: "Currency" }));
	}

	_update_row_display(uid) {
		const cfg = MOVEMENT_CONFIG[this.mode];
		const row = this.entry_rows.find((r) => r.uid === uid);
		if (!row) return;
		const $tr = this.$body.find(`tr[data-row-id="${uid}"]`);

		if (cfg.show_total) $tr.find(".inv-total-cell").html(this._format_row_total(row));

		if (row.has_serial_no && cfg.fields.includes("source")) {
			const count = (row.serial_no || "").split(/\n|,/).map((s) => s.trim()).filter(Boolean).length;
			const qty_n = cint(row.qty);
			const ok = qty_n > 0 && count === qty_n;
			$tr.find(".inv-serial-picker")
				.css("color", ok ? "#28a745" : "#5e64ff")
				.html(`${count}/${qty_n || 0} series ${ok ? "&#10003;" : "— elegir"}`);
		}

		this._recompute_grand_total();
	}

	_bind_movement_events() {
		this.$body.off();
		$(document).off(".facexInv");
		const $body = this.$body;

		$body.on("click", "#inv-back", () => this._render_shell());

		// Pestañas Nueva Entrada/Salida / Movimientos del Mes
		$body.on("click", ".inv-tab", (e) => this._switch_movement_tab($(e.currentTarget).data("tab")));
		$body.on("click", "#inv-m-refresh", () => this._load_movement_list());
		$body.on("click", ".inv-mov-row", (e) => {
			const name = $(e.currentTarget).data("view");
			frappe.call({
				method: "facex_multi.api.stock.get_stock_entry_detail",
				args: { name },
				freeze: true,
				callback: (r) => {
					if (!r.message) return;
					this._render_movement_result(r.message);
				},
			});
		});

		// Búsqueda de producto
		let _item_timer = null;
		$body.on("input", "#inv-e-item-search", (e) => {
			clearTimeout(_item_timer);
			const val = e.target.value.trim();
			if (val.length < 2) { $body.find("#inv-e-item-results").hide(); return; }
			_item_timer = setTimeout(() => this._movement_search_item(val), 300);
		});
		$body.on("click", "#inv-e-item-results div", (e) => {
			const $d = $(e.currentTarget);
			this._movement_add_row($d.data("item"));
			$body.find("#inv-e-item-search").val("").focus();
			$body.find("#inv-e-item-results").hide();
		});
		// Escaneo de código de barras / QR: Enter agrega el producto directamente
		// por coincidencia exacta (corrige además el guion/comilla mal leído por el lector).
		$body.on("keydown", "#inv-e-item-search", (e) => {
			if (e.key !== "Enter") return;
			e.preventDefault();
			clearTimeout(_item_timer);
			const $input = $body.find("#inv-e-item-search");
			const code = $input.val().trim();
			if (!code) return;
			$input.prop("disabled", true);
			frappe.call({
				method: "facex_multi.api.item.find_item_by_code",
				args: { txt: code, company: this.defaults.company },
				callback: (r) => {
					$input.prop("disabled", false).val("").focus();
					$body.find("#inv-e-item-results").hide();
					if (!r.message) {
						frappe.show_alert({ message: __("Producto no encontrado para el código {0}.", [code]), indicator: "orange" });
						return;
					}
					this._movement_add_row(r.message);
				},
				error: () => $input.prop("disabled", false).focus(),
			});
		});
		$(document).on("click.facexInv", (e) => {
			if (!$(e.target).closest("#inv-e-item-search, #inv-e-item-results").length)
				$body.find("#inv-e-item-results").hide();
			if (!$(e.target).closest(".inv-row-info, .inv-popover").length)
				$(".inv-popover").remove();
		});

		// Edición de celdas (input = actualización en vivo del total/badge de serie)
		$body.on("input", ".inv-e-field", (e) => {
			const $tr = $(e.target).closest("tr");
			const uid = $tr.data("row-id");
			const field = $(e.target).data("field");
			const row = this.entry_rows.find((r) => r.uid === uid);
			if (row) row[field] = $(e.target).val();
			this._update_row_display(uid);
		});

		// Quitar fila
		$body.on("click", "[data-remove]", (e) => {
			const uid = $(e.currentTarget).data("remove");
			this.entry_rows = this.entry_rows.filter((r) => r.uid !== uid);
			this._render_entry_rows();
		});

		// Flotante de existencia/costo por almacén
		$body.on("click", "[data-info]", (e) => {
			e.stopPropagation();
			const uid = $(e.currentTarget).data("info");
			const row = this.entry_rows.find((r) => r.uid === uid);
			if (row) this._show_stock_popover(row, e.currentTarget);
		});

		// Selector de números de serie disponibles (Salidas/Transferencias)
		$body.on("click", ".inv-serial-picker", (e) => {
			const uid = $(e.currentTarget).data("row");
			const row = this.entry_rows.find((r) => r.uid === uid);
			if (row) this._open_serial_picker(row);
		});

		// Cambio de almacén origen: refresca costo automático y limpia series
		// seleccionadas de un almacén distinto (ya no aplican).
		$body.on("change", "#inv-e-warehouse-source", () => {
			let changed = false;
			this.entry_rows.forEach((row) => {
				if (row.has_serial_no && row.serial_no) { row.serial_no = ""; changed = true; }
			});
			if (changed) this._render_entry_rows();
			this._refresh_out_rates();
		});

		$body.on("click", "#inv-e-save", () => this._movement_save());

		// Copiar/pegar masivo: botón, o Ctrl+V directo sobre la tarjeta del grid.
		$body.on("click", "#inv-e-paste-btn", () => this._open_paste_dialog());
		$body.on("paste", "#inv-e-grid-card", (e) => {
			const oe = e.originalEvent || e;
			const clipboard = oe.clipboardData;
			if (!clipboard) return;
			const text = clipboard.getData("text/plain") || "";
			const is_field = $(e.target).hasClass("inv-e-field");
			const is_multiline = /\n/.test(text.trim());
			if (is_field && !is_multiline) return; // pegado normal dentro de una sola celda
			e.preventDefault();
			this._paste_bulk_rows(text);
		});
	}

	_movement_search_item(txt) {
		frappe.call({
			method: "facex_multi.api.stock.search_items_for_stock",
			args: { txt, company: this.defaults.company },
			callback: (r) => {
				const $results = this.$body.find("#inv-e-item-results");
				const items = r.message || [];
				if (!items.length) {
					$results.html(`<div style="color:#adb5bd;">Sin resultados</div>`).show();
					return;
				}
				$results.html(items.map((it) => `
<div data-item='${JSON.stringify(it).replace(/'/g, "&#39;")}'>
  <strong>${frappe.utils.escape_html(it.item_code)}</strong> — ${frappe.utils.escape_html(it.item_name || "")}
</div>`).join("")).show();
			},
		});
	}

	_movement_add_row(item) {
		if (!item) return;
		const cfg = MOVEMENT_CONFIG[this.mode];
		this._entry_uid += 1;
		const uid = this._entry_uid;
		const row = {
			uid,
			item_code: item.item_code || item.name,
			item_name: item.item_name,
			uom: item.stock_uom,
			has_batch_no: cint(item.has_batch_no),
			has_serial_no: cint(item.has_serial_no),
			qty: 1,
			batch_no: "",
			serial_no: "",
			rate: "",
			auto_rate: 0,
			expense_account: "",
			_account_loading: cfg.show_account,
		};
		this.entry_rows.push(row);
		this._render_entry_rows();

		if (cfg.show_account) {
			frappe.call({
				method: "facex_multi.api.stock.get_default_expense_account",
				args: { item_code: row.item_code, company: this.defaults.company },
				callback: (r) => {
					const current = this.entry_rows.find((x) => x.uid === uid);
					if (!current) return; // la fila pudo haberse quitado mientras cargaba
					current.expense_account = r.message || "";
					current._account_loading = false;
					this._render_entry_rows();
				},
			});
		}

		if (this.mode === "out" && cfg.show_total) this._refresh_out_rates();
	}

	_refresh_out_rates() {
		if (this.mode !== "out") return;
		const warehouse = this.$body.find("#inv-e-warehouse-source").val();
		if (!warehouse || !this.entry_rows.length) { this._recompute_grand_total(); return; }

		frappe.call({
			method: "facex_multi.api.stock.get_valuation_rates",
			args: { item_codes: JSON.stringify(this.entry_rows.map((r) => r.item_code)), warehouse },
			callback: (r) => {
				const rates = r.message || {};
				this.entry_rows.forEach((row) => {
					row.auto_rate = flt(rates[row.item_code]);
					this._update_row_display(row.uid);
				});
			},
		});
	}

	// ──────────────────────────────────────────────
	// Copiar / pegar masivo (Ctrl+V sobre el grid, o botón "Pegar datos")
	// ──────────────────────────────────────────────

	_paste_columns() {
		const cfg = MOVEMENT_CONFIG[this.mode];
		const cols = ["Código", "Cantidad", "UOM", "Lote", "Serie"];
		if (cfg.show_account) cols.push("Cuenta Contable");
		if (cfg.show_cost) cols.push("Costo");
		return cols;
	}

	_open_paste_dialog() {
		const cols = this._paste_columns();
		const d = new frappe.ui.Dialog({
			title: "Pegar datos al grid",
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "hint",
					options: `<div style="font-size:12.5px;color:#6c757d;margin-bottom:8px;">
						Pegue filas separadas por tabulación (igual que copiar celdas desde Excel/Sheets), una por línea, en este orden:<br>
						<strong>${cols.join(" · ")}</strong><br>
						Deje en blanco lo que no aplique. También puede pegar directamente con Ctrl+V sobre la tabla.
					</div>`,
				},
				{ fieldtype: "Small Text", fieldname: "data", label: "Datos" },
			],
			primary_action_label: "Cargar",
			primary_action: (values) => {
				d.hide();
				this._paste_bulk_rows(values.data || "");
			},
		});
		d.show();
	}

	_paste_bulk_rows(text) {
		const cfg = MOVEMENT_CONFIG[this.mode];
		const lines = (text || "").replace(/\r/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
		if (!lines.length) return;

		let idx = 5; // 0:código 1:cantidad 2:uom 3:lote 4:serie
		const account_idx = cfg.show_account ? idx++ : -1;
		const rate_idx = cfg.show_cost ? idx++ : -1;

		const parsed = lines
			.map((line) => {
				const c = line.split("\t");
				return {
					item_code: (c[0] || "").trim(),
					qty: (c[1] || "").trim(),
					uom: (c[2] || "").trim(),
					batch_no: (c[3] || "").trim(),
					serial_no: (c[4] || "").trim(),
					expense_account: account_idx >= 0 ? (c[account_idx] || "").trim() : "",
					rate: rate_idx >= 0 ? (c[rate_idx] || "").trim() : "",
				};
			})
			.filter((r) => r.item_code);

		if (!parsed.length) {
			frappe.show_alert({ message: "No se reconoció ninguna fila válida para pegar.", indicator: "orange" });
			return;
		}

		frappe.call({
			method: "facex_multi.api.stock.validate_items_bulk",
			args: { item_codes: JSON.stringify(parsed.map((p) => p.item_code)), company: this.defaults.company },
			freeze: true,
			freeze_message: "Validando productos…",
			callback: (r) => {
				const found = r.message || {};
				const missing = [];
				const pending_account_uids = [];

				parsed.forEach((p) => {
					const meta = found[p.item_code];
					if (!meta) { missing.push(p.item_code); return; }

					this._entry_uid += 1;
					const uid = this._entry_uid;
					const needs_account = cfg.show_account && !p.expense_account;
					this.entry_rows.push({
						uid,
						item_code: p.item_code,
						item_name: meta.item_name,
						uom: p.uom || meta.stock_uom,
						has_batch_no: cint(meta.has_batch_no),
						has_serial_no: cint(meta.has_serial_no),
						qty: flt(p.qty) || 1,
						batch_no: p.batch_no,
						serial_no: p.serial_no,
						rate: p.rate,
						auto_rate: 0,
						expense_account: p.expense_account,
						_account_loading: needs_account,
					});
					if (needs_account) pending_account_uids.push(uid);
				});

				this._render_entry_rows();

				pending_account_uids.forEach((uid) => {
					const row = this.entry_rows.find((x) => x.uid === uid);
					frappe.call({
						method: "facex_multi.api.stock.get_default_expense_account",
						args: { item_code: row.item_code, company: this.defaults.company },
						callback: (rr) => {
							const current = this.entry_rows.find((x) => x.uid === uid);
							if (!current) return;
							current.expense_account = rr.message || "";
							current._account_loading = false;
							this._render_entry_rows();
						},
					});
				});

				if (this.mode === "out" && cfg.show_total) this._refresh_out_rates();

				const added = parsed.length - missing.length;
				frappe.show_alert({
					message: missing.length
						? `Se agregaron ${added} producto(s). No encontrados: ${missing.join(", ")}`
						: `Se agregaron ${added} producto(s).`,
					indicator: missing.length ? "orange" : "green",
				});
			},
		});
	}

	_open_serial_picker(row) {
		const warehouse = this.$body.find("#inv-e-warehouse-source").val();
		if (!warehouse) { frappe.show_alert({ message: "Seleccione primero el almacén origen.", indicator: "orange" }); return; }
		const qty_n = cint(row.qty);
		if (qty_n <= 0) { frappe.show_alert({ message: "Ingrese la cantidad antes de elegir las series.", indicator: "orange" }); return; }

		frappe.call({
			method: "facex_multi.api.stock.get_available_serials",
			args: { item_code: row.item_code, warehouse },
			freeze: true,
			callback: (r) => {
				const available = r.message || [];
				if (!available.length) {
					frappe.msgprint(`No hay números de serie disponibles de ${frappe.utils.escape_html(row.item_code)} en ${frappe.utils.escape_html(warehouse)}.`);
					return;
				}

				const already = (row.serial_no || "").split(/\n|,/).map((s) => s.trim()).filter(Boolean);
				const keep = already.filter((s) => available.includes(s)).slice(0, qty_n);
				const fill = available.filter((s) => !keep.includes(s)).slice(0, Math.max(0, qty_n - keep.length));
				const preselected = new Set([...keep, ...fill]);

				const d = new frappe.ui.Dialog({
					title: `Seleccionar series — ${row.item_code}`,
					fields: [
						{
							fieldtype: "HTML",
							fieldname: "info",
							options: `<div style="margin-bottom:8px;font-size:12.5px;color:#6c757d;">Necesita <strong>${qty_n}</strong> serie(s). Disponibles en <strong>${frappe.utils.escape_html(warehouse)}</strong>: ${available.length}.</div>`,
						},
						{
							fieldtype: "MultiCheck",
							fieldname: "serials",
							columns: 2,
							options: available.map((s) => ({ label: s, value: s, checked: preselected.has(s) })),
						},
					],
					primary_action_label: "Aplicar",
					primary_action: (values) => {
						const chosen = values.serials || [];
						if (chosen.length !== qty_n) {
							frappe.msgprint(`Debe seleccionar exactamente ${qty_n} serie(s) — hay ${chosen.length} seleccionadas.`);
							return;
						}
						row.serial_no = chosen.join("\n");
						d.hide();
						this._render_entry_rows();
					},
				});
				d.show();
			},
		});
	}

	_show_stock_popover(row, anchorEl) {
		$(".inv-popover").remove();
		const rect = anchorEl.getBoundingClientRect();
		const $pop = $(`
<div class="inv-popover" style="top:${rect.bottom + window.scrollY + 4}px;left:${rect.left + window.scrollX}px;">
  <div style="font-weight:600;margin-bottom:6px;">${frappe.utils.escape_html(row.item_code)}</div>
  <div class="inv-popover-body">Cargando...</div>
</div>`);
		$("body").append($pop);

		frappe.call({
			method: "facex_multi.api.stock.get_item_stock_summary",
			args: { item_code: row.item_code, company: this.defaults.company },
			callback: (r) => {
				const rows = r.message || [];
				const $b = $pop.find(".inv-popover-body");
				if (!rows.length) {
					$b.html(`<div style="color:#adb5bd;">Sin existencia registrada.</div>`);
					return;
				}
				$b.html(`
<table style="width:100%;font-size:12px;">
  <tr><th style="text-align:left;">Almacén</th><th style="text-align:right;">Cant.</th><th style="text-align:right;">Costo</th></tr>
  ${rows.map(w => `<tr>
    <td>${frappe.utils.escape_html(w.warehouse)}</td>
    <td style="text-align:right;">${frappe.format(w.actual_qty, { fieldtype: "Float" })}</td>
    <td style="text-align:right;">${frappe.format(w.valuation_rate, { fieldtype: "Currency" })}</td>
  </tr>`).join("")}
</table>`);
			},
		});
	}

	_movement_save() {
		if (this._saving) return;

		const cfg = MOVEMENT_CONFIG[this.mode];
		const source_warehouse = cfg.fields.includes("source") ? this.$body.find("#inv-e-warehouse-source").val() : "";
		const target_warehouse = cfg.fields.includes("target") ? this.$body.find("#inv-e-warehouse-target").val() : "";
		const posting_date = this.$body.find("#inv-e-date").val();
		const remarks = this.$body.find("#inv-e-remarks").val();

		for (const f of cfg.fields) {
			const val = f === "source" ? source_warehouse : target_warehouse;
			if (!val) { frappe.show_alert({ message: `Seleccione el ${WAREHOUSE_FIELD_LABEL[f].toLowerCase()}.`, indicator: "orange" }); return; }
		}
		if (this.mode === "transfer" && source_warehouse === target_warehouse) {
			frappe.show_alert({ message: "El almacén origen y destino no pueden ser el mismo.", indicator: "orange" });
			return;
		}
		if (!this.entry_rows.length) { frappe.show_alert({ message: "Agregue al menos un producto.", indicator: "orange" }); return; }

		const payload = {
			company: this.defaults.company,
			source_warehouse,
			target_warehouse,
			posting_date,
			remarks,
			items: this.entry_rows.map((r) => ({
				item_code: r.item_code,
				qty: r.qty,
				uom: r.uom,
				batch_no: r.batch_no,
				serial_no: r.serial_no,
				rate: r.rate,
				expense_account: r.expense_account,
			})),
		};
		const client_token = this._client_token;
		const target_desc = this.mode === "transfer"
			? `de <strong>${frappe.utils.escape_html(source_warehouse)}</strong> a <strong>${frappe.utils.escape_html(target_warehouse)}</strong>`
			: `en <strong>${frappe.utils.escape_html(source_warehouse || target_warehouse)}</strong>`;

		frappe.confirm(
			`¿Confirmar la ${cfg.label.toLowerCase()} de <strong>${this.entry_rows.length}</strong> producto(s) ${target_desc}?`,
			() => {
				if (this._saving) return; // guarda extra por si el diálogo se disparó dos veces
				this._saving = true;
				this.$body.find("#inv-e-save").prop("disabled", true);

				frappe.call({
					method: cfg.api_create,
					args: { payload: JSON.stringify(payload), client_token },
					freeze: true,
					freeze_message: `Registrando ${cfg.label.toLowerCase()}…`,
					callback: (r) => {
						this._saving = false;
						if (!r.message) { this.$body.find("#inv-e-save").prop("disabled", false); return; }
						// Recargar el documento recién creado desde el servidor — misma fuente
						// de datos que al reabrirlo desde Movimientos (costo real, cuenta, etc).
						frappe.call({
							method: "facex_multi.api.stock.get_stock_entry_detail",
							args: { name: r.message.name },
							callback: (r2) => {
								if (r2.message) this._render_movement_result(r2.message);
							},
						});
					},
					error: () => {
						this._saving = false;
						this.$body.find("#inv-e-save").prop("disabled", false);
					},
				});
			}
		);
	}

	// ──────────────────────────────────────────────
	// Documento guardado: Cancelar / Duplicar / Imprimir / Nuevo / Salir
	// ──────────────────────────────────────────────

	_render_movement_result(doc) {
		this.mode = doc.mode || this.mode;
		const cfg = MOVEMENT_CONFIG[this.mode];
		this._result_doc = doc;
		const is_cancelled = cint(doc.docstatus) === 2;
		this._result_cancelled = is_cancelled;

		this.$body.html(`
<div id="inv-result-app" style="max-width:900px;margin:0 auto;padding:16px 8px;">

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:24px;margin-bottom:16px;text-align:center;">
    <div style="font-size:13px;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;">${cfg.label} de Inventario</div>
    <div id="inv-r-name" style="font-size:22px;font-weight:700;color:${is_cancelled ? "#e03e2d" : "#28a745"};margin:6px 0;">${frappe.utils.escape_html(doc.name)}${is_cancelled ? " (Anulado)" : ""}</div>
    <div style="font-size:12.5px;color:#6c757d;">${frappe.utils.escape_html(this._movement_warehouse_display(doc))} · ${frappe.utils.escape_html(doc.posting_date || "")}</div>
  </div>

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;margin-bottom:16px;overflow-x:auto;">
    <table class="inv-table" style="width:100%;">
      <thead>
        <tr>
          <th>Producto</th>
          <th style="width:100px;">Cantidad</th>
          <th style="width:80px;">UOM</th>
          <th style="width:140px;">Lote</th>
          <th style="width:200px;">N° de Serie</th>
          ${cfg.show_account ? `<th style="width:180px;">Cuenta Contable</th>` : ""}
          ${cfg.show_cost ? `<th style="width:110px;">Costo Unit.</th>` : ""}
          ${cfg.show_total ? `<th style="width:120px;">Total</th>` : ""}
        </tr>
      </thead>
      <tbody>
        ${doc.items.map(r => `<tr>
          <td><strong>${frappe.utils.escape_html(r.item_code)}</strong><br><span style="color:#6c757d;">${frappe.utils.escape_html(r.item_name || "")}</span></td>
          <td>${frappe.utils.escape_html(String(r.qty))}</td>
          <td>${frappe.utils.escape_html(r.uom || "")}</td>
          <td>${r.batch_no ? frappe.utils.escape_html(r.batch_no) : `<span style="color:#adb5bd;">—</span>`}</td>
          <td>${r.serial_no ? frappe.utils.escape_html(r.serial_no).replace(/\n/g, "<br>") : `<span style="color:#adb5bd;">—</span>`}</td>
          ${cfg.show_account ? `<td>${frappe.utils.escape_html(r.expense_account || "")}</td>` : ""}
          ${cfg.show_cost ? `<td>${frappe.format(flt(r.rate), { fieldtype: "Currency" })}</td>` : ""}
          ${cfg.show_total ? `<td>${frappe.format(flt(r.qty) * flt(r.rate), { fieldtype: "Currency" })}</td>` : ""}
        </tr>`).join("")}
      </tbody>
      ${cfg.show_total ? `
      <tfoot>
        <tr>
          <td colspan="${5 + (cfg.show_account ? 1 : 0) + (cfg.show_cost ? 1 : 0)}" style="text-align:right;font-weight:600;color:#495057;border-top:2px solid #dee2e6;">Total General</td>
          <td style="font-weight:700;color:#333;border-top:2px solid #dee2e6;">${frappe.format(doc.items.reduce((sum, r) => sum + flt(r.qty) * flt(r.rate), 0), { fieldtype: "Currency" })}</td>
        </tr>
      </tfoot>` : ""}
    </table>
  </div>

  <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;">
    <button type="button" id="inv-r-cancelar" class="inv-btn inv-btn-danger" ${is_cancelled ? "disabled" : ""}>Cancelar</button>
    <button type="button" id="inv-r-duplicar" class="inv-btn inv-btn-secondary">Duplicar</button>
    <button type="button" id="inv-r-imprimir" class="inv-btn inv-btn-secondary">Imprimir</button>
    <button type="button" id="inv-r-nuevo" class="inv-btn inv-btn-primary">Nuevo</button>
    <button type="button" id="inv-r-volver" class="inv-btn inv-btn-secondary">Movimientos</button>
    <button type="button" id="inv-r-salir" class="inv-btn inv-btn-secondary">Salir</button>
  </div>

</div>

<style>${INV_STYLES}</style>
		`);

		this._bind_movement_result_events();
	}

	_movement_warehouse_display(doc) {
		if (this.mode === "transfer") return `${doc.source_warehouse || ""} → ${doc.target_warehouse || ""}`;
		return doc.source_warehouse || doc.target_warehouse || "";
	}

	_bind_movement_result_events() {
		this.$body.off();
		$(document).off(".facexInv");
		const doc = this._result_doc;

		this.$body.on("click", "#inv-r-cancelar", () => this._movement_cancel());
		this.$body.on("click", "#inv-r-duplicar", () => this._open_movement(this.mode, {
			source_warehouse: doc.source_warehouse,
			target_warehouse: doc.target_warehouse,
			remarks: doc.remarks,
			items: doc.items,
		}));
		this.$body.on("click", "#inv-r-imprimir", () => frappe.utils.print("Stock Entry", doc.name));
		this.$body.on("click", "#inv-r-nuevo", () => this._open_movement(this.mode));
		this.$body.on("click", "#inv-r-volver", () => {
			this._open_movement(this.mode);
			this._switch_movement_tab("movs");
		});
		this.$body.on("click", "#inv-r-salir", () => this._render_shell());
	}

	_movement_cancel() {
		if (this._result_cancelled) return;
		const doc = this._result_doc;

		frappe.confirm(
			`¿Anular el movimiento <strong>${frappe.utils.escape_html(doc.name)}</strong>? Esto revierte el stock afectado.`,
			() => {
				frappe.call({
					method: "facex_multi.api.stock.cancel_stock_entry",
					args: { name: doc.name },
					freeze: true,
					freeze_message: "Anulando…",
					callback: (r) => {
						if (!r.message) return;
						this._result_cancelled = true;
						this.$body.find("#inv-r-name").css("color", "#e03e2d").text(doc.name + " (Anulado)");
						this.$body.find("#inv-r-cancelar").prop("disabled", true);
						frappe.show_alert({ message: "Movimiento anulado.", indicator: "orange" });
					},
				});
			}
		);
	}

	// ──────────────────────────────────────────────
	// Filtro de Establecimiento (compartido entre Kardex / Existencias / Trazabilidad)
	// ──────────────────────────────────────────────

	// Solo se muestra si la compañía tiene más de un establecimiento — si solo
	// tiene uno, no hay nada que elegir y se omite el filtro por completo.
	_sucursal_filter_html(selectId) {
		const est = this.defaults.establishments || [];
		if (est.length <= 1) return "";
		return `
<div>
  <label class="inv-label">Establecimiento</label>
  <select id="${selectId}" class="inv-select">
    <option value="">Todas</option>
    ${est.map(e => `<option value="${frappe.utils.escape_html(e.id)}">${frappe.utils.escape_html(e.nombre)}</option>`).join("")}
    <option value="__unassigned__">Sin asignar</option>
  </select>
</div>`;
	}

	// "" (Todas) -> no se envía el filtro. "__unassigned__" -> se traduce a
	// cadena vacía para que el backend filtre por almacenes sin sucursal asignada.
	_establecimiento_param(selectId) {
		const val = this.$body.find(`#${selectId}`).val();
		if (!val) return undefined;
		return val === "__unassigned__" ? "" : val;
	}

	// Panel de filtros colapsable, reutilizado en Kardex / Existencias / Trazabilidad.
	// Los campos van en `_filter_panel_html(gridHtml, refreshBtnHtml)`.
	_filter_panel_html(gridHtml, actionsHtml) {
		return `
<div class="inv-filter-panel">
  <div class="inv-filter-header" data-toggle-filters="1">
    <span class="inv-filter-title">Filtros</span>
    <span class="inv-filter-chevron">&#9662;</span>
  </div>
  <div class="inv-filter-body">
    <div class="inv-filter-grid">${gridHtml}</div>
    <div class="inv-filter-actions">${actionsHtml}</div>
  </div>
</div>`;
	}

	_bind_filter_toggle() {
		this.$body.on("click", "[data-toggle-filters]", (e) => {
			const $panel = $(e.currentTarget).closest(".inv-filter-panel");
			$panel.find(".inv-filter-body").slideToggle(150);
			$panel.toggleClass("inv-filter-collapsed");
		});
	}

	// ──────────────────────────────────────────────
	// Reporte: Kardex de Movimientos
	// ──────────────────────────────────────────────

	_open_kardex() {
		this._render_kardex();
	}

	_render_kardex() {
		const d = this.defaults;
		const warehouses = d.warehouses || [];
		const NCOLS = 13;
		this.$body.html(`
<div id="inv-report-app" style="max-width:1500px;margin:0 auto;padding:16px 8px;">

  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
    <button type="button" id="inv-back" class="inv-btn inv-btn-secondary">&larr; Volver</button>
    <div style="font-size:16px;font-weight:600;color:#333;">Kardex de Movimientos</div>
    <div style="font-size:12.5px;color:#6c757d;">${frappe.utils.escape_html(d.company)} · incluye todo documento que afecte el stock (no solo los creados aquí)</div>
  </div>

  ${this._filter_panel_html(`
    <div><label class="inv-label">Desde</label><input type="date" id="inv-k-from" class="inv-select" value="${frappe.datetime.month_start()}"></div>
    <div><label class="inv-label">Hasta</label><input type="date" id="inv-k-to" class="inv-select" value="${frappe.datetime.month_end()}"></div>
    <div>
      <label class="inv-label">Tipo</label>
      <select id="inv-k-type" class="inv-select">
        <option value="">Todos</option>
        <option value="in">Entradas</option>
        <option value="out">Salidas</option>
        <option value="transfer">Transferencias</option>
      </select>
    </div>
    <div>
      <label class="inv-label">Almacén</label>
      <select id="inv-k-warehouse" class="inv-select">
        <option value="">Todos</option>
        ${warehouses.map(w => `<option value="${frappe.utils.escape_html(w)}">${frappe.utils.escape_html(w)}</option>`).join("")}
      </select>
    </div>
    ${this._sucursal_filter_html("inv-k-establecimiento")}
    <div style="position:relative;">
      <label class="inv-label">Producto</label>
      <input type="text" id="inv-k-item" class="inv-select" placeholder="Código o nombre..." autocomplete="off">
      <div id="inv-k-item-results" class="inv-autocomplete"></div>
      <input type="hidden" id="inv-k-item-code">
    </div>
  `, `<button type="button" id="inv-k-refresh" class="inv-btn inv-btn-primary">Filtrar</button>`)}

  <div class="inv-chart-card">
    <div class="inv-chart-title">Valor Acumulado en el tiempo</div>
    <div id="inv-k-chart"></div>
  </div>

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;overflow-x:auto;">
    <table class="inv-table" style="width:100%;">
      <thead>
        <tr>
          <th>Documento</th><th style="width:95px;">Fecha</th><th style="width:100px;">Tipo</th><th>Producto</th>
          <th style="width:90px;">Cantidad</th><th>Almacén</th><th>Establecimiento</th><th>Compañía</th>
          <th style="width:160px;">Cuenta Contable</th>
          <th style="width:100px;">Costo</th><th style="width:110px;">Valor</th>
          <th style="width:120px;">Valor Acumulado</th>
          <th style="width:90px;">Estado</th>
        </tr>
      </thead>
      <tbody id="inv-k-tbody"><tr><td colspan="${NCOLS}" style="text-align:center;color:#adb5bd;padding:20px;">Cargando...</td></tr></tbody>
    </table>
  </div>

</div>
<style>${INV_STYLES}</style>
		`);
		this._bind_kardex_events();
		this._load_kardex();
	}

	_bind_kardex_events() {
		this.$body.off();
		$(document).off(".facexInv");
		const $body = this.$body;
		this._bind_filter_toggle();

		$body.on("click", "#inv-back", () => this._render_shell());
		$body.on("click", "#inv-k-refresh", () => this._load_kardex());

		let _item_timer = null;
		$body.on("input", "#inv-k-item", (e) => {
			clearTimeout(_item_timer);
			const val = e.target.value.trim();
			if (!val) { $body.find("#inv-k-item-code").val(""); $body.find("#inv-k-item-results").hide(); return; }
			if (val.length < 2) { $body.find("#inv-k-item-results").hide(); return; }
			_item_timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.stock.search_items_for_stock",
					args: { txt: val, company: this.defaults.company },
					callback: (r) => {
						const items = r.message || [];
						const $res = $body.find("#inv-k-item-results");
						if (!items.length) { $res.html(`<div style="color:#adb5bd;">Sin resultados</div>`).show(); return; }
						$res.html(items.map((it) => `<div data-code="${frappe.utils.escape_html(it.item_code)}" data-label="${frappe.utils.escape_html(it.item_code)} — ${frappe.utils.escape_html(it.item_name || "")}"><strong>${frappe.utils.escape_html(it.item_code)}</strong> — ${frappe.utils.escape_html(it.item_name || "")}</div>`).join("")).show();
					},
				});
			}, 300);
		});
		$body.on("click", "#inv-k-item-results div", (e) => {
			const $d = $(e.currentTarget);
			$body.find("#inv-k-item").val($d.data("label"));
			$body.find("#inv-k-item-code").val($d.data("code"));
			$body.find("#inv-k-item-results").hide();
		});
		$(document).on("click.facexInv", (e) => {
			if (!$(e.target).closest("#inv-k-item, #inv-k-item-results").length) $body.find("#inv-k-item-results").hide();
		});

		$body.on("click", ".inv-kardex-row", (e) => {
			const voucher_type = $(e.currentTarget).data("vtype");
			const voucher_no = $(e.currentTarget).data("vname");
			if (voucher_type === "Stock Entry") {
				frappe.call({
					method: "facex_multi.api.stock.get_stock_entry_detail",
					args: { name: voucher_no },
					freeze: true,
					callback: (r) => { if (r.message) this._render_movement_result(r.message); },
				});
			} else {
				window.open(`/app/${encodeURIComponent(frappe.router.slug(voucher_type))}/${encodeURIComponent(voucher_no)}`, "_blank");
			}
		});
	}

	_load_kardex() {
		const $tbody = this.$body.find("#inv-k-tbody");
		const NCOLS = 13;
		$tbody.html(`<tr><td colspan="${NCOLS}" style="text-align:center;color:#adb5bd;padding:20px;">Cargando...</td></tr>`);

		frappe.call({
			method: "facex_multi.api.stock_reports.get_kardex",
			args: {
				company: this.defaults.company,
				from_date: this.$body.find("#inv-k-from").val(),
				to_date: this.$body.find("#inv-k-to").val(),
				movement_type: this.$body.find("#inv-k-type").val(),
				warehouse: this.$body.find("#inv-k-warehouse").val(),
				item_code: this.$body.find("#inv-k-item-code").val(),
				establecimiento: this._establecimiento_param("inv-k-establecimiento"),
			},
			callback: (r) => {
				const rows = (r.message && r.message.rows) || [];
				this._render_kardex_chart(rows);
				if (!rows.length) {
					$tbody.html(`<tr><td colspan="${NCOLS}" style="text-align:center;color:#adb5bd;padding:20px;">Sin movimientos en este rango.</td></tr>`);
					return;
				}
				const STATUS_COLOR = { Activo: "#28a745", Anulado: "#e03e2d" };
				const TYPE_COLOR = { Entrada: "#28a745", Salida: "#e03e2d", Transferencia: "#5e64ff" };
				$tbody.html(rows.map((row) => `
<tr class="inv-kardex-row" data-vtype="${frappe.utils.escape_html(row.voucher_type)}" data-vname="${frappe.utils.escape_html(row.voucher_no)}">
  <td><strong>${frappe.utils.escape_html(row.voucher_no)}</strong><br><span style="color:#6c757d;font-size:11px;">${frappe.utils.escape_html(row.voucher_type)}</span></td>
  <td>${frappe.utils.escape_html(row.posting_date || "")}</td>
  <td><span style="color:${TYPE_COLOR[row.movement_type_label] || "#333"};font-weight:600;">${frappe.utils.escape_html(row.movement_type_label)}</span></td>
  <td>${frappe.utils.escape_html(row.item_code)}<br><span style="color:#6c757d;">${frappe.utils.escape_html(row.item_name || "")}</span></td>
  <td>${frappe.utils.escape_html(String(row.actual_qty))} ${frappe.utils.escape_html(row.stock_uom || "")}</td>
  <td>${frappe.utils.escape_html(row.warehouse || "")}</td>
  <td>${frappe.utils.escape_html(row.establecimiento_nombre || "")}</td>
  <td>${frappe.utils.escape_html(row.company || "")}</td>
  <td>${row.expense_account ? frappe.utils.escape_html(row.expense_account) : `<span style="color:#adb5bd;">—</span>`}</td>
  <td>${frappe.format(row.valuation_rate, { fieldtype: "Currency" })}</td>
  <td>${frappe.format(row.stock_value_difference, { fieldtype: "Currency" })}</td>
  <td>${frappe.format(row.accumulated_value, { fieldtype: "Currency" })}</td>
  <td><span style="color:${STATUS_COLOR[row.status_label] || "#333"};font-weight:600;">${frappe.utils.escape_html(row.status_label)}</span></td>
</tr>`).join(""));
			},
		});
	}

	_render_kardex_chart(rows) {
		const $el = this.$body.find("#inv-k-chart");
		if (!rows.length) { $el.html(`<div style="color:#adb5bd;font-size:12.5px;padding:20px;text-align:center;">Sin datos para graficar.</div>`); return; }

		// Un punto por día: último valor acumulado de ese día (las filas ya
		// vienen ordenadas cronológicamente ascendente desde el servidor).
		const by_date = new Map();
		rows.forEach((r) => by_date.set(r.posting_date, r.accumulated_value));
		const labels = Array.from(by_date.keys());
		const values = Array.from(by_date.values());

		$el.empty();
		new frappe.Chart($el.get(0), {
			data: { labels, datasets: [{ name: "Valor Acumulado", values }] },
			type: "line",
			height: 220,
			colors: ["#5e64ff"],
			lineOptions: { regionFill: 1 },
			axisOptions: { xIsSeries: 1, shortenYAxisNumbers: 1 },
		});
	}

	// ──────────────────────────────────────────────
	// Reporte: Existencias (Status / Antigüedad / Sin Rotación)
	// ──────────────────────────────────────────────

	_open_existencias() {
		this._exist_tab = "status";
		this._render_existencias();
	}

	_render_existencias() {
		const d = this.defaults;
		const warehouses = d.warehouses || [];
		this.$body.html(`
<div id="inv-report-app" style="max-width:1300px;margin:0 auto;padding:16px 8px;">

  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
    <button type="button" id="inv-back" class="inv-btn inv-btn-secondary">&larr; Volver</button>
    <div style="font-size:16px;font-weight:600;color:#333;">Existencias</div>
    <div style="font-size:12.5px;color:#6c757d;">${frappe.utils.escape_html(d.company)}</div>
  </div>

  <div class="inv-tabs">
    <div class="inv-tab ${this._exist_tab === "status" ? "inv-tab-active" : ""}" data-etab="status">Status por Almacén</div>
    <div class="inv-tab ${this._exist_tab === "aging" ? "inv-tab-active" : ""}" data-etab="aging">Antigüedad</div>
    <div class="inv-tab ${this._exist_tab === "nonmoving" ? "inv-tab-active" : ""}" data-etab="nonmoving">Sin Rotación</div>
  </div>

  ${this._filter_panel_html(`
    <div>
      <label class="inv-label">Almacén</label>
      <select id="inv-x-warehouse" class="inv-select">
        <option value="">Todos</option>
        ${warehouses.map(w => `<option value="${frappe.utils.escape_html(w)}">${frappe.utils.escape_html(w)}</option>`).join("")}
      </select>
    </div>
    ${this._sucursal_filter_html("inv-x-establecimiento")}
    <div style="position:relative;">
      <label class="inv-label">Producto</label>
      <input type="text" id="inv-x-item" class="inv-select" placeholder="Código o nombre..." autocomplete="off">
      <div id="inv-x-item-results" class="inv-autocomplete"></div>
      <input type="hidden" id="inv-x-item-code">
    </div>
    ${this._exist_tab === "nonmoving" ? `
    <div>
      <label class="inv-label">Días sin salida</label>
      <input type="number" id="inv-x-days" class="inv-select" value="60" min="0" style="width:100px;">
    </div>` : ""}
  `, `<button type="button" id="inv-x-refresh" class="inv-btn inv-btn-primary">Filtrar</button>`)}

  <div class="inv-chart-card">
    <div class="inv-chart-title" id="inv-x-chart-title"></div>
    <div id="inv-x-chart"></div>
  </div>

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;overflow-x:auto;">
    <table class="inv-table" style="width:100%;" id="inv-x-table"></table>
  </div>

</div>
<style>${INV_STYLES}</style>
		`);
		this._bind_existencias_events();
		this._load_existencias();
	}

	_bind_existencias_events() {
		this.$body.off();
		$(document).off(".facexInv");
		const $body = this.$body;
		this._bind_filter_toggle();

		$body.on("click", "#inv-back", () => this._render_shell());
		$body.on("click", ".inv-tab", (e) => {
			this._exist_tab = $(e.currentTarget).data("etab");
			this._render_existencias();
		});
		$body.on("click", "#inv-x-refresh", () => this._load_existencias());

		let _item_timer = null;
		$body.on("input", "#inv-x-item", (e) => {
			clearTimeout(_item_timer);
			const val = e.target.value.trim();
			if (!val) { $body.find("#inv-x-item-code").val(""); $body.find("#inv-x-item-results").hide(); return; }
			if (val.length < 2) { $body.find("#inv-x-item-results").hide(); return; }
			_item_timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.stock.search_items_for_stock",
					args: { txt: val, company: this.defaults.company },
					callback: (r) => {
						const items = r.message || [];
						const $res = $body.find("#inv-x-item-results");
						if (!items.length) { $res.html(`<div style="color:#adb5bd;">Sin resultados</div>`).show(); return; }
						$res.html(items.map((it) => `<div data-code="${frappe.utils.escape_html(it.item_code)}" data-label="${frappe.utils.escape_html(it.item_code)} — ${frappe.utils.escape_html(it.item_name || "")}"><strong>${frappe.utils.escape_html(it.item_code)}</strong> — ${frappe.utils.escape_html(it.item_name || "")}</div>`).join("")).show();
					},
				});
			}, 300);
		});
		$body.on("click", "#inv-x-item-results div", (e) => {
			const $d = $(e.currentTarget);
			$body.find("#inv-x-item").val($d.data("label"));
			$body.find("#inv-x-item-code").val($d.data("code"));
			$body.find("#inv-x-item-results").hide();
		});
		$(document).on("click.facexInv", (e) => {
			if (!$(e.target).closest("#inv-x-item, #inv-x-item-results").length) $body.find("#inv-x-item-results").hide();
		});
	}

	_load_existencias() {
		const warehouse = this.$body.find("#inv-x-warehouse").val();
		const item_code = this.$body.find("#inv-x-item-code").val();
		const establecimiento = this._establecimiento_param("inv-x-establecimiento");
		const $table = this.$body.find("#inv-x-table");
		$table.html(`<tr><td style="text-align:center;color:#adb5bd;padding:20px;">Cargando...</td></tr>`);

		if (this._exist_tab === "status") {
			frappe.call({
				method: "facex_multi.api.stock_reports.get_stock_status",
				args: { company: this.defaults.company, warehouse, item_code, establecimiento },
				callback: (r) => this._render_existencias_status((r.message && r.message.rows) || []),
			});
		} else if (this._exist_tab === "aging") {
			frappe.call({
				method: "facex_multi.api.stock_reports.get_stock_aging",
				args: { company: this.defaults.company, warehouse, item_code, establecimiento },
				callback: (r) => this._render_existencias_aging((r.message && r.message.rows) || []),
			});
		} else {
			const days = this.$body.find("#inv-x-days").val();
			frappe.call({
				method: "facex_multi.api.stock_reports.get_non_moving_items",
				args: { company: this.defaults.company, warehouse, days, item_code, establecimiento },
				callback: (r) => this._render_existencias_nonmoving((r.message && r.message.rows) || []),
			});
		}
	}

	_render_existencias_status(rows) {
		const $table = this.$body.find("#inv-x-table");
		if (!rows.length) { $table.html(`<tr><td style="text-align:center;color:#adb5bd;padding:20px;">Sin existencias.</td></tr>`); this._render_exist_chart(null); return; }
		$table.html(`
<thead><tr><th>Producto</th><th>Almacén</th><th style="width:100px;">Cantidad</th><th style="width:110px;">Costo</th><th style="width:120px;">Valor</th></tr></thead>
<tbody>
${rows.map(r => `<tr>
  <td><strong>${frappe.utils.escape_html(r.item_code)}</strong><br><span style="color:#6c757d;">${frappe.utils.escape_html(r.item_name || "")}</span></td>
  <td>${frappe.utils.escape_html(r.warehouse)}</td>
  <td>${frappe.utils.escape_html(String(r.actual_qty))}</td>
  <td>${frappe.format(r.valuation_rate, { fieldtype: "Currency" })}</td>
  <td>${frappe.format(r.stock_value, { fieldtype: "Currency" })}</td>
</tr>`).join("")}
</tbody>`);

		const by_warehouse = new Map();
		rows.forEach((r) => by_warehouse.set(r.warehouse, (by_warehouse.get(r.warehouse) || 0) + flt(r.stock_value)));
		this._render_exist_chart({
			title: "Valor por Almacén",
			labels: Array.from(by_warehouse.keys()),
			values: Array.from(by_warehouse.values()),
			color: "#5e64ff",
		});
	}

	_render_existencias_aging(rows) {
		const $table = this.$body.find("#inv-x-table");
		if (!rows.length) { $table.html(`<tr><td style="text-align:center;color:#adb5bd;padding:20px;">Sin existencias.</td></tr>`); this._render_exist_chart(null); return; }
		const BUCKET_COLOR = { "0-30 días": "#28a745", "31-60 días": "#ff9f43", "61-90 días": "#e08a2f", "+90 días": "#e03e2d", "Sin dato": "#adb5bd" };
		$table.html(`
<thead><tr><th>Producto</th><th>Almacén</th><th style="width:100px;">Cantidad</th><th style="width:140px;">Último Ingreso</th><th style="width:80px;">Días</th><th style="width:110px;">Rango</th></tr></thead>
<tbody>
${rows.map(r => `<tr>
  <td><strong>${frappe.utils.escape_html(r.item_code)}</strong><br><span style="color:#6c757d;">${frappe.utils.escape_html(r.item_name || "")}</span></td>
  <td>${frappe.utils.escape_html(r.warehouse)}</td>
  <td>${frappe.utils.escape_html(String(r.actual_qty))}</td>
  <td>${r.last_receipt_date ? frappe.utils.escape_html(r.last_receipt_date) : "—"}</td>
  <td>${r.days_in_stock === null ? "—" : r.days_in_stock}</td>
  <td><span style="color:${BUCKET_COLOR[r.bucket] || "#333"};font-weight:600;">${frappe.utils.escape_html(r.bucket)}</span></td>
</tr>`).join("")}
</tbody>`);

		// Orden fijo 0-30 -> +90: rampa secuencial de un solo tono, clara->oscura,
		// validada con el script de la skill de dataviz (ordinal, mode light).
		const BUCKET_ORDER = ["0-30 días", "31-60 días", "61-90 días", "+90 días", "Sin dato"];
		const counts = new Map(BUCKET_ORDER.map((b) => [b, 0]));
		rows.forEach((r) => counts.set(r.bucket, (counts.get(r.bucket) || 0) + 1));
		const present = BUCKET_ORDER.filter((b) => counts.get(b) > 0);
		this._render_exist_chart({
			title: "Productos por Antigüedad",
			labels: present,
			values: present.map((b) => counts.get(b)),
			color: "#3987e5",
		});
	}

	_render_existencias_nonmoving(rows) {
		const $table = this.$body.find("#inv-x-table");
		if (!rows.length) { $table.html(`<tr><td style="text-align:center;color:#adb5bd;padding:20px;">Todos los productos con existencia han tenido salidas recientes.</td></tr>`); this._render_exist_chart(null); return; }
		$table.html(`
<thead><tr><th>Producto</th><th>Almacén</th><th style="width:100px;">Cantidad</th><th style="width:120px;">Valor</th><th style="width:140px;">Última Salida</th></tr></thead>
<tbody>
${rows.map(r => `<tr>
  <td><strong>${frappe.utils.escape_html(r.item_code)}</strong><br><span style="color:#6c757d;">${frappe.utils.escape_html(r.item_name || "")}</span></td>
  <td>${frappe.utils.escape_html(r.warehouse)}</td>
  <td>${frappe.utils.escape_html(String(r.actual_qty))}</td>
  <td>${frappe.format(flt(r.actual_qty) * flt(r.valuation_rate), { fieldtype: "Currency" })}</td>
  <td>${r.last_outgoing_date ? frappe.utils.escape_html(r.last_outgoing_date) : `<span style="color:#e03e2d;">Nunca</span>`}</td>
</tr>`).join("")}
</tbody>`);

		const top = [...rows]
			.map((r) => ({ label: r.item_code, value: flt(r.actual_qty) * flt(r.valuation_rate) }))
			.sort((a, b) => b.value - a.value)
			.slice(0, 10);
		this._render_exist_chart({
			title: "Valor Inmovilizado por Producto (top 10)",
			labels: top.map((t) => t.label),
			values: top.map((t) => t.value),
			color: "#e08a2f",
		});
	}

	_render_exist_chart(spec) {
		const $el = this.$body.find("#inv-x-chart");
		const $title = this.$body.find("#inv-x-chart-title");
		if (!spec || !spec.labels.length) {
			$title.text("");
			$el.html(`<div style="color:#adb5bd;font-size:12.5px;padding:20px;text-align:center;">Sin datos para graficar.</div>`);
			return;
		}
		$title.text(spec.title);
		$el.empty();
		new frappe.Chart($el.get(0), {
			data: { labels: spec.labels, datasets: [{ name: spec.title, values: spec.values }] },
			type: "bar",
			height: 220,
			colors: [spec.color],
			axisOptions: { shortenYAxisNumbers: 1 },
		});
	}

	// ──────────────────────────────────────────────
	// Reporte: Trazabilidad Serie / Lote
	// ──────────────────────────────────────────────

	_open_trazabilidad() {
		this._traz_tab = "serial";
		this._render_trazabilidad();
	}

	_render_trazabilidad() {
		const d = this.defaults;
		const warehouses = d.warehouses || [];
		this.$body.html(`
<div id="inv-report-app" style="max-width:1300px;margin:0 auto;padding:16px 8px;">

  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
    <button type="button" id="inv-back" class="inv-btn inv-btn-secondary">&larr; Volver</button>
    <div style="font-size:16px;font-weight:600;color:#333;">Trazabilidad Serie / Lote</div>
    <div style="font-size:12.5px;color:#6c757d;">${frappe.utils.escape_html(d.company)}</div>
  </div>

  <div class="inv-tabs">
    <div class="inv-tab ${this._traz_tab === "serial" ? "inv-tab-active" : ""}" data-ttab="serial">Por Serie</div>
    <div class="inv-tab ${this._traz_tab === "batch" ? "inv-tab-active" : ""}" data-ttab="batch">Por Lote</div>
  </div>

  ${this._filter_panel_html(`
    <div style="grid-column:span 2;">
      <label class="inv-label">${this._traz_tab === "serial" ? "N° de Serie" : "N° de Lote"} (opcional)</label>
      <input type="text" id="inv-t-search" class="inv-select" style="width:100%;" placeholder="Buscar...">
    </div>
    <div style="position:relative;">
      <label class="inv-label">Producto</label>
      <input type="text" id="inv-t-item" class="inv-select" placeholder="Código o nombre..." autocomplete="off">
      <div id="inv-t-item-results" class="inv-autocomplete"></div>
      <input type="hidden" id="inv-t-item-code">
    </div>
    <div>
      <label class="inv-label">Almacén</label>
      <select id="inv-t-warehouse" class="inv-select">
        <option value="">Todos</option>
        ${warehouses.map(w => `<option value="${frappe.utils.escape_html(w)}">${frappe.utils.escape_html(w)}</option>`).join("")}
      </select>
    </div>
    ${this._sucursal_filter_html("inv-t-establecimiento")}
  `, `<button type="button" id="inv-t-refresh" class="inv-btn inv-btn-primary">Buscar</button>`)}

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;overflow-x:auto;">
    <table class="inv-table" style="width:100%;" id="inv-t-table"></table>
  </div>

</div>
<style>${INV_STYLES}</style>
		`);
		this._bind_trazabilidad_events();
		this._load_trazabilidad();
	}

	_bind_trazabilidad_events() {
		this.$body.off();
		$(document).off(".facexInv");
		const $body = this.$body;
		this._bind_filter_toggle();

		$body.on("click", "#inv-back", () => this._render_shell());
		$body.on("click", ".inv-tab", (e) => {
			this._traz_tab = $(e.currentTarget).data("ttab");
			this._render_trazabilidad();
		});
		$body.on("click", "#inv-t-refresh", () => this._load_trazabilidad());

		let _item_timer = null;
		$body.on("input", "#inv-t-item", (e) => {
			clearTimeout(_item_timer);
			const val = e.target.value.trim();
			if (!val) { $body.find("#inv-t-item-code").val(""); $body.find("#inv-t-item-results").hide(); return; }
			if (val.length < 2) { $body.find("#inv-t-item-results").hide(); return; }
			_item_timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.stock.search_items_for_stock",
					args: { txt: val, company: this.defaults.company },
					callback: (r) => {
						const items = r.message || [];
						const $res = $body.find("#inv-t-item-results");
						if (!items.length) { $res.html(`<div style="color:#adb5bd;">Sin resultados</div>`).show(); return; }
						$res.html(items.map((it) => `<div data-code="${frappe.utils.escape_html(it.item_code)}" data-label="${frappe.utils.escape_html(it.item_code)} — ${frappe.utils.escape_html(it.item_name || "")}"><strong>${frappe.utils.escape_html(it.item_code)}</strong> — ${frappe.utils.escape_html(it.item_name || "")}</div>`).join("")).show();
					},
				});
			}, 300);
		});
		$body.on("click", "#inv-t-item-results div", (e) => {
			const $d = $(e.currentTarget);
			$body.find("#inv-t-item").val($d.data("label"));
			$body.find("#inv-t-item-code").val($d.data("code"));
			$body.find("#inv-t-item-results").hide();
		});
		$(document).on("click.facexInv", (e) => {
			if (!$(e.target).closest("#inv-t-item, #inv-t-item-results").length) $body.find("#inv-t-item-results").hide();
		});
	}

	_load_trazabilidad() {
		const search = this.$body.find("#inv-t-search").val();
		const item_code = this.$body.find("#inv-t-item-code").val();
		const warehouse = this.$body.find("#inv-t-warehouse").val();
		const establecimiento = this._establecimiento_param("inv-t-establecimiento");
		const $table = this.$body.find("#inv-t-table");
		$table.html(`<tr><td style="text-align:center;color:#adb5bd;padding:20px;">Cargando...</td></tr>`);

		if (this._traz_tab === "serial") {
			frappe.call({
				method: "facex_multi.api.stock_reports.get_serial_traceability",
				args: { company: this.defaults.company, serial_no: search, item_code, warehouse, establecimiento },
				callback: (r) => this._render_traz_serial((r.message && r.message.rows) || []),
			});
		} else {
			frappe.call({
				method: "facex_multi.api.stock_reports.get_batch_traceability",
				args: { company: this.defaults.company, batch_no: search, item_code, warehouse, establecimiento },
				callback: (r) => this._render_traz_batch((r.message && r.message.rows) || []),
			});
		}
	}

	_render_traz_serial(rows) {
		const $table = this.$body.find("#inv-t-table");
		if (!rows.length) { $table.html(`<tr><td style="text-align:center;color:#adb5bd;padding:20px;">Sin resultados.</td></tr>`); return; }
		const STATUS_COLOR = { Active: "#28a745", Delivered: "#5e64ff", Consumed: "#6c757d", Inactive: "#adb5bd", Expired: "#e03e2d" };
		$table.html(`
<thead><tr><th>N° Serie</th><th>Producto</th><th>Almacén Actual</th><th style="width:100px;">Estado</th><th>Último Documento</th></tr></thead>
<tbody>
${rows.map(r => `<tr>
  <td><strong>${frappe.utils.escape_html(r.serial_no)}</strong></td>
  <td>${frappe.utils.escape_html(r.item_code)}<br><span style="color:#6c757d;">${frappe.utils.escape_html(r.item_name || "")}</span></td>
  <td>${r.warehouse ? frappe.utils.escape_html(r.warehouse) : `<span style="color:#adb5bd;">—</span>`}</td>
  <td><span style="color:${STATUS_COLOR[r.status] || "#333"};font-weight:600;">${frappe.utils.escape_html(r.status || "")}</span></td>
  <td>${r.reference_name ? `${frappe.utils.escape_html(r.reference_doctype || "")}: ${frappe.utils.escape_html(r.reference_name)}` : "—"}</td>
</tr>`).join("")}
</tbody>`);
	}

	_render_traz_batch(rows) {
		const $table = this.$body.find("#inv-t-table");
		if (!rows.length) { $table.html(`<tr><td style="text-align:center;color:#adb5bd;padding:20px;">Sin resultados.</td></tr>`); return; }
		$table.html(`
<thead><tr><th>N° Lote</th><th>Producto</th><th>Almacén</th><th style="width:100px;">Cantidad</th><th style="width:130px;">Vencimiento</th></tr></thead>
<tbody>
${rows.map(r => `<tr>
  <td><strong>${frappe.utils.escape_html(r.batch_no)}</strong></td>
  <td>${frappe.utils.escape_html(r.item_code)}<br><span style="color:#6c757d;">${frappe.utils.escape_html(r.item_name || "")}</span></td>
  <td>${frappe.utils.escape_html(r.warehouse)}</td>
  <td>${frappe.utils.escape_html(String(r.qty_in_batch))}</td>
  <td>${r.expiry_date ? frappe.utils.escape_html(r.expiry_date) : "—"}</td>
</tr>`).join("")}
</tbody>`);
	}

	// ──────────────────────────────────────────────
	// Listas de Materiales para Venta (paquetes/kits)
	// ──────────────────────────────────────────────

	_open_lista_materiales() {
		frappe.call({
			method: "facex_multi.api.item.list_listas_materiales",
			args: { company: this.defaults.company },
			freeze: true,
			callback: (r) => {
				this._lm_rows = r.message || [];
				this._render_lista_materiales_list();
			},
		});
	}

	_render_lista_materiales_list() {
		const rows = this._lm_rows || [];

		this.$body.html(`
<div id="inv-lm-app" style="max-width:1000px;margin:0 auto;padding:16px 8px;">

  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
    <button type="button" id="inv-back" class="inv-btn inv-btn-secondary">&larr; Volver</button>
    <div style="font-size:16px;font-weight:600;color:#333;flex:1;">Listas de Materiales</div>
    <button type="button" id="inv-lm-new" class="inv-btn inv-btn-primary">+ Nueva Lista de Materiales</button>
  </div>

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;overflow-x:auto;">
    <table class="inv-table" style="width:100%;">
      <thead>
        <tr><th>Producto</th><th>Nombre</th><th style="width:120px;">Modo de Stock</th><th style="width:110px;">Estado</th></tr>
      </thead>
      <tbody>
        ${!rows.length ? `<tr><td colspan="4" style="text-align:center;color:#adb5bd;padding:20px;">Sin Listas de Materiales configuradas.</td></tr>` : rows.map(row => `
        <tr class="inv-mov-row" data-edit="${frappe.utils.escape_html(row.item_code)}">
          <td><strong>${frappe.utils.escape_html(row.item_code)}</strong></td>
          <td>${frappe.utils.escape_html(row.item_name || "")}</td>
          <td>${frappe.utils.escape_html(row.modo_stock || "")}</td>
          <td>${row.disabled ? `<span style="color:#adb5bd;">Deshabilitado</span>` : `<span style="color:#28a745;">Activo</span>`}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </div>

</div>
<style>${INV_STYLES}</style>
		`);

		this._bind_lista_materiales_list_events();
	}

	_bind_lista_materiales_list_events() {
		this.$body.off();
		$(document).off(".facexInv");
		this.$body.on("click", "#inv-back", () => this._render_shell());
		this.$body.on("click", "#inv-lm-new", () => this._open_lista_materiales_form());
		this.$body.on("click", "[data-edit]", (e) => {
			this._open_lista_materiales_form($(e.currentTarget).data("edit"));
		});
	}

	_open_lista_materiales_form(item_code) {
		this._lm_form = {
			item_code: item_code || "",
			item_name: "",
			modo_stock: "",
			items: [],
			uid_counter: 0,
		};

		if (!item_code) {
			this._render_lista_materiales_form();
			return;
		}

		frappe.call({
			method: "facex_multi.api.item.get_lista_materiales_detail",
			args: { item_code },
			freeze: true,
			callback: (r) => {
				const d = r.message || {};
				this._lm_form.modo_stock = d.modo_stock || "";
				(d.items || []).forEach((it) => {
					this._lm_form.uid_counter += 1;
					this._lm_form.items.push({
						uid: this._lm_form.uid_counter,
						item_code: it.item_code,
						item_name: it.item_name,
						qty: it.qty,
						uom: it.uom,
					});
				});
				frappe.call({
					method: "facex_multi.api.item.get_item",
					args: { name: item_code, company: this.defaults.company },
					callback: (r2) => {
						this._lm_form.item_name = (r2.message && r2.message.item_name) || item_code;
						this._render_lista_materiales_form();
					},
				});
			},
		});
	}

	_render_lista_materiales_form() {
		const f = this._lm_form;
		const is_edit = !!f.item_code;

		this.$body.html(`
<div id="inv-lm-form-app" style="max-width:900px;margin:0 auto;padding:16px 8px;">

  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
    <button type="button" id="inv-lm-back" class="inv-btn inv-btn-secondary">&larr; Volver</button>
    <div style="font-size:16px;font-weight:600;color:#333;">${is_edit ? "Editar" : "Nueva"} Lista de Materiales</div>
  </div>

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:18px 20px;margin-bottom:16px;">
    <label class="inv-label">Producto Padre</label>
    ${is_edit ? `
    <div style="font-size:14px;margin-top:6px;"><strong>${frappe.utils.escape_html(f.item_code)}</strong> — ${frappe.utils.escape_html(f.item_name || "")}</div>
    ` : `
    <div style="position:relative;max-width:420px;margin-top:6px;">
      <input type="text" id="inv-lm-item-search" class="inv-select" style="width:100%;" placeholder="Buscar producto existente..." autocomplete="off">
      <div id="inv-lm-item-results" class="inv-autocomplete"></div>
    </div>
    <div style="font-size:11.5px;color:#6c757d;margin-top:4px;">Debe ser un producto ya existente. Para crear productos nuevos use Mantenimiento &rarr; Productos.</div>
    `}
  </div>

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:18px 20px;margin-bottom:16px;">
    <label class="inv-label">Manejo de Stock</label>
    <div style="display:flex;gap:20px;margin-top:10px;flex-wrap:wrap;">
      <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;max-width:360px;">
        <input type="radio" name="inv-lm-modo" value="Padre" ${f.modo_stock === "Padre" ? "checked" : ""} style="margin-top:3px;">
        <span><strong>Padre lleva el stock</strong><br><span style="font-size:12px;color:#6c757d;">El producto padre tiene existencia propia. Se carga mediante la operación de Transformación.</span></span>
      </label>
      <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;max-width:360px;">
        <input type="radio" name="inv-lm-modo" value="Hijos" ${f.modo_stock === "Hijos" ? "checked" : ""} style="margin-top:3px;">
        <span><strong>Hijos llevan el stock</strong><br><span style="font-size:12px;color:#6c757d;">El padre es solo un agrupador (sin stock propio). Al venderlo se descuentan sus componentes automáticamente.</span></span>
      </label>
    </div>
  </div>

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:18px 20px;margin-bottom:16px;">
    <label class="inv-label">Buscar componente para agregar</label>
    <div style="position:relative;max-width:420px;margin-top:6px;">
      <input type="text" id="inv-lm-comp-search" class="inv-select" style="width:100%;" placeholder="Código o nombre del producto..." autocomplete="off">
      <div id="inv-lm-comp-results" class="inv-autocomplete"></div>
    </div>
  </div>

  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;margin-bottom:16px;overflow-x:auto;">
    <table class="inv-table" style="width:100%;">
      <thead>
        <tr><th>Producto</th><th style="width:160px;">Cantidad por unidad del padre</th><th style="width:80px;">UOM</th><th style="width:50px;"></th></tr>
      </thead>
      <tbody id="inv-lm-tbody"></tbody>
    </table>
  </div>

  <div style="display:flex;justify-content:space-between;gap:10px;">
    <div>
      ${is_edit ? `<button type="button" id="inv-lm-disable" class="inv-btn inv-btn-danger">Quitar de Listas de Materiales</button>` : ""}
    </div>
    <button type="button" id="inv-lm-save" class="inv-btn inv-btn-primary">Guardar</button>
  </div>

</div>
<style>${INV_STYLES}</style>
		`);

		this._lm_render_component_rows();
		this._bind_lista_materiales_form_events();
	}

	_lm_render_component_rows() {
		const rows = this._lm_form.items;
		const $tbody = this.$body.find("#inv-lm-tbody");
		if (!rows.length) {
			$tbody.html(`<tr><td colspan="4" style="text-align:center;color:#adb5bd;padding:20px;">Busque un producto arriba para agregarlo.</td></tr>`);
			return;
		}
		$tbody.html(rows.map((row) => `
<tr data-row-id="${row.uid}">
  <td><strong>${frappe.utils.escape_html(row.item_code)}</strong><br><span style="color:#6c757d;">${frappe.utils.escape_html(row.item_name || "")}</span></td>
  <td><input type="number" min="0" step="any" class="inv-lm-field" data-field="qty" value="${row.qty}"></td>
  <td>${frappe.utils.escape_html(row.uom || "")}</td>
  <td><span class="inv-row-remove" data-remove="${row.uid}">&times;</span></td>
</tr>`).join(""));
	}

	_bind_lista_materiales_form_events() {
		this.$body.off();
		$(document).off(".facexInv");
		const $body = this.$body;

		$body.on("click", "#inv-lm-back", () => this._open_lista_materiales());

		let _padre_timer = null;
		$body.on("input", "#inv-lm-item-search", (e) => {
			clearTimeout(_padre_timer);
			const val = e.target.value.trim();
			if (val.length < 2) { $body.find("#inv-lm-item-results").hide(); return; }
			_padre_timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.item.search_items",
					args: { txt: val, company: this.defaults.company },
					callback: (r) => {
						const items = r.message || [];
						const $results = $body.find("#inv-lm-item-results");
						if (!items.length) { $results.html(`<div style="color:#adb5bd;">Sin resultados</div>`).show(); return; }
						$results.html(items.map((it) => `
<div data-item='${JSON.stringify(it).replace(/'/g, "&#39;")}'>
  <strong>${frappe.utils.escape_html(it.item_code || it.name)}</strong> — ${frappe.utils.escape_html(it.item_name || "")}
</div>`).join("")).show();
					},
				});
			}, 300);
		});
		$body.on("click", "#inv-lm-item-results div", (e) => {
			const it = $(e.currentTarget).data("item");
			this._lm_form.item_code = it.item_code || it.name;
			this._lm_form.item_name = it.item_name || "";
			$body.find("#inv-lm-item-search").val(`${this._lm_form.item_code} — ${this._lm_form.item_name}`);
			$body.find("#inv-lm-item-results").hide();
		});

		$body.on("change", "input[name='inv-lm-modo']", (e) => {
			this._lm_form.modo_stock = e.target.value;
		});

		let _comp_timer = null;
		$body.on("input", "#inv-lm-comp-search", (e) => {
			clearTimeout(_comp_timer);
			const val = e.target.value.trim();
			if (val.length < 2) { $body.find("#inv-lm-comp-results").hide(); return; }
			_comp_timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.stock.search_items_for_stock",
					args: { txt: val, company: this.defaults.company },
					callback: (r) => {
						const items = r.message || [];
						const $results = $body.find("#inv-lm-comp-results");
						if (!items.length) { $results.html(`<div style="color:#adb5bd;">Sin resultados</div>`).show(); return; }
						$results.html(items.map((it) => `
<div data-item='${JSON.stringify(it).replace(/'/g, "&#39;")}'>
  <strong>${frappe.utils.escape_html(it.item_code)}</strong> — ${frappe.utils.escape_html(it.item_name || "")}
</div>`).join("")).show();
					},
				});
			}, 300);
		});
		$body.on("click", "#inv-lm-comp-results div", (e) => {
			const it = $(e.currentTarget).data("item");
			if (this._lm_form.item_code && it.item_code === this._lm_form.item_code) {
				frappe.show_alert({ message: "El producto padre no puede ser componente de sí mismo.", indicator: "orange" });
				return;
			}
			if (this._lm_form.items.some((r) => r.item_code === it.item_code)) {
				frappe.show_alert({ message: "Ese componente ya fue agregado.", indicator: "orange" });
				return;
			}
			this._lm_form.uid_counter += 1;
			this._lm_form.items.push({
				uid: this._lm_form.uid_counter,
				item_code: it.item_code,
				item_name: it.item_name,
				qty: 1,
				uom: it.stock_uom,
			});
			this._lm_render_component_rows();
			$body.find("#inv-lm-comp-search").val("").focus();
			$body.find("#inv-lm-comp-results").hide();
		});

		$(document).on("click.facexInv", (e) => {
			if (!$(e.target).closest("#inv-lm-item-search, #inv-lm-item-results").length) $body.find("#inv-lm-item-results").hide();
			if (!$(e.target).closest("#inv-lm-comp-search, #inv-lm-comp-results").length) $body.find("#inv-lm-comp-results").hide();
		});

		$body.on("input", ".inv-lm-field", (e) => {
			const uid = $(e.target).closest("tr").data("row-id");
			const row = this._lm_form.items.find((r) => r.uid === uid);
			if (row) row.qty = $(e.target).val();
		});

		$body.on("click", "[data-remove]", (e) => {
			const uid = $(e.currentTarget).data("remove");
			this._lm_form.items = this._lm_form.items.filter((r) => r.uid !== uid);
			this._lm_render_component_rows();
		});

		$body.on("click", "#inv-lm-save", () => this._lm_save());
		$body.on("click", "#inv-lm-disable", () => this._lm_disable());
	}

	_lm_save() {
		const f = this._lm_form;
		if (!f.item_code) { frappe.show_alert({ message: "Seleccione el producto padre.", indicator: "orange" }); return; }
		if (!f.modo_stock) { frappe.show_alert({ message: "Seleccione el modo de manejo de stock.", indicator: "orange" }); return; }
		if (!f.items.length) { frappe.show_alert({ message: "Agregue al menos un componente.", indicator: "orange" }); return; }
		for (const row of f.items) {
			if (!(flt(row.qty) > 0)) {
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
				company: this.defaults.company,
			},
			freeze: true,
			freeze_message: "Guardando…",
			callback: (r) => {
				if (!r.message) return;
				frappe.show_alert({ message: "Lista de Materiales guardada.", indicator: "green" });
				this._open_lista_materiales();
			},
		});
	}

	_lm_disable() {
		const item_code = this._lm_form.item_code;
		frappe.confirm(
			`¿Quitar a <strong>${frappe.utils.escape_html(item_code)}</strong> de las Listas de Materiales? Volverá a ser un producto normal.`,
			() => {
				frappe.call({
					method: "facex_multi.api.item.disable_lista_materiales",
					args: { item_code, company: this.defaults.company },
					freeze: true,
					callback: (r) => {
						if (!r.message) return;
						frappe.show_alert({ message: "Lista de Materiales eliminada.", indicator: "green" });
						this._open_lista_materiales();
					},
				});
			}
		);
	}

	// ──────────────────────────────────────────────
	// Transformación (Listas de Materiales en modo 'Padre')
	// ──────────────────────────────────────────────

	_open_transformacion() {
		this._trf = {
			item_code: "",
			item_name: "",
			cantidad: 1,
			components: [],
			target_warehouse: "",
		};
		this._trf_tab = "nueva";
		this._trf_client_token = frappe.utils.get_random(20);
		this._render_transformacion();
	}

	_render_transformacion() {
		const d = this.defaults;
		const t = this._trf;
		const warehouses = d.warehouses || [];
		const first_day = frappe.datetime.month_start();
		const last_day = frappe.datetime.month_end();

		this.$body.html(`
<div id="inv-trf-app" style="max-width:1200px;margin:0 auto;padding:16px 8px;">

  <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
    <button type="button" id="inv-back" class="inv-btn inv-btn-secondary">&larr; Volver</button>
    <div style="font-size:16px;font-weight:600;color:#333;">Transformación de Inventario</div>
    <div style="font-size:12.5px;color:#6c757d;">${frappe.utils.escape_html(d.company)}</div>
  </div>

  <div class="inv-tabs">
    <div class="inv-tab ${this._trf_tab === "nueva" ? "inv-tab-active" : ""}" data-ttab="nueva">Nueva Transformación</div>
    <div class="inv-tab ${this._trf_tab === "movs" ? "inv-tab-active" : ""}" data-ttab="movs">Movimientos del Mes</div>
  </div>

  <div id="inv-trf-tab-nueva" style="display:${this._trf_tab === "nueva" ? "" : "none"};">

    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:18px 20px;margin-bottom:16px;">
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;align-items:end;">
        <div>
          <label class="inv-label">Producto Padre (Lista de Materiales)</label>
          <div style="position:relative;">
            <input type="text" id="inv-trf-item-search" class="inv-select" style="width:100%;" placeholder="Buscar producto..." autocomplete="off" value="${t.item_code ? frappe.utils.escape_html(`${t.item_code} — ${t.item_name}`) : ""}">
            <div id="inv-trf-item-results" class="inv-autocomplete"></div>
          </div>
        </div>
        <div>
          <label class="inv-label">Cantidad a Transformar</label>
          <input type="number" min="0" step="any" id="inv-trf-cantidad" class="inv-select" style="width:100%;" value="${t.cantidad}" ${t.item_code ? "" : "disabled"}>
        </div>
        <div>
          <label class="inv-label">Almacén Destino (Producto Padre) <span style="color:#e03e2d;">*</span></label>
          <select id="inv-trf-warehouse-target" class="inv-select" style="width:100%;" ${t.item_code ? "" : "disabled"}>
            <option value="">Seleccione...</option>
            ${warehouses.map(w => `<option value="${frappe.utils.escape_html(w)}" ${w === t.target_warehouse ? "selected" : ""}>${frappe.utils.escape_html(w)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label class="inv-label">Fecha</label>
          <input type="date" id="inv-trf-date" class="inv-select" style="width:100%;" value="${frappe.datetime.get_today()}">
        </div>
        <div style="grid-column:1/-1;">
          <label class="inv-label">Comentario</label>
          <input type="text" id="inv-trf-remarks" class="inv-select" style="width:100%;" placeholder="Motivo de la transformación (opcional)">
        </div>
      </div>
    </div>

    <div class="card" id="inv-trf-comp-card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;margin-bottom:16px;overflow-x:auto;">
      <table class="inv-table" style="width:100%;">
        <thead>
          <tr>
            <th>Componente</th>
            <th style="width:110px;">Cant. Necesaria</th>
            <th style="width:220px;">Almacén Origen</th>
            <th style="width:140px;">Lote</th>
            <th style="width:200px;">N° de Serie</th>
          </tr>
        </thead>
        <tbody id="inv-trf-tbody"></tbody>
      </table>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:10px;">
      <button type="button" id="inv-trf-save" class="inv-btn inv-btn-primary">Guardar Transformación</button>
    </div>

  </div>

  <div id="inv-trf-tab-movs" style="display:${this._trf_tab === "movs" ? "" : "none"};">

    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 20px;margin-bottom:16px;display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap;">
      <div>
        <label class="inv-label">Desde</label>
        <input type="date" id="inv-m-from" class="inv-select" value="${first_day}">
      </div>
      <div>
        <label class="inv-label">Hasta</label>
        <input type="date" id="inv-m-to" class="inv-select" value="${last_day}">
      </div>
      <button type="button" id="inv-m-refresh" class="inv-btn inv-btn-secondary">Actualizar</button>
    </div>

    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;overflow-x:auto;">
      <table class="inv-table" style="width:100%;">
        <thead>
          <tr><th>Documento</th><th>Fecha</th><th style="width:70px;">Ítems</th><th style="width:110px;">Valor</th><th style="width:90px;">Estado</th><th>Comentario</th></tr>
        </thead>
        <tbody id="inv-m-tbody"><tr><td colspan="6" style="text-align:center;color:#adb5bd;padding:20px;">Cargando...</td></tr></tbody>
      </table>
    </div>

  </div>

</div>
<style>${INV_STYLES}</style>
		`);

		this._trf_render_components();
		this._bind_transformacion_events();
	}

	_trf_render_components() {
		const t = this._trf;
		const $tbody = this.$body.find("#inv-trf-tbody");
		if (!t.item_code) {
			$tbody.html(`<tr><td colspan="5" style="text-align:center;color:#adb5bd;padding:20px;">Busque un producto padre (Lista de Materiales, modo Padre) arriba.</td></tr>`);
			return;
		}
		if (!t.components.length) {
			$tbody.html(`<tr><td colspan="5" style="text-align:center;color:#adb5bd;padding:20px;">Este producto no tiene componentes.</td></tr>`);
			return;
		}
		$tbody.html(t.components.map((c) => {
			const needed = flt(c.qty_per_unit) * flt(t.cantidad);
			const stock_hint = (c.stock || []).map(s => `${frappe.utils.escape_html(s.warehouse)}: ${flt(s.actual_qty)}`).join(" · ") || "Sin existencia";
			return `
<tr data-comp="${frappe.utils.escape_html(c.item_code)}">
  <td><strong>${frappe.utils.escape_html(c.item_code)}</strong><br><span style="color:#6c757d;">${frappe.utils.escape_html(c.item_name || "")}</span></td>
  <td>${needed} ${frappe.utils.escape_html(c.stock_uom || "")}</td>
  <td>
    <select class="inv-select inv-trf-source" data-comp="${frappe.utils.escape_html(c.item_code)}" style="width:100%;">
      <option value="">Seleccione...</option>
      ${(this.defaults.warehouses || []).map(w => `<option value="${frappe.utils.escape_html(w)}" ${w === c.source_warehouse ? "selected" : ""}>${frappe.utils.escape_html(w)}</option>`).join("")}
    </select>
    <div style="font-size:10.5px;color:#6c757d;margin-top:3px;">${stock_hint}</div>
  </td>
  <td>${c.has_batch_no ? `<input type="text" class="inv-trf-field" data-comp="${frappe.utils.escape_html(c.item_code)}" data-field="batch_no" value="${frappe.utils.escape_html(c.batch_no || "")}" placeholder="Lote">` : `<span style="color:#adb5bd;">—</span>`}</td>
  <td>${c.has_serial_no ? `<input type="text" class="inv-trf-field" data-comp="${frappe.utils.escape_html(c.item_code)}" data-field="serial_no" value="${frappe.utils.escape_html(c.serial_no || "")}" placeholder="Uno por línea o coma">` : `<span style="color:#adb5bd;">—</span>`}</td>
</tr>`;
		}).join(""));
	}

	_bind_transformacion_events() {
		this.$body.off();
		$(document).off(".facexInv");
		const $body = this.$body;

		$body.on("click", "#inv-back", () => this._render_shell());
		$body.on("click", ".inv-tab", (e) => this._switch_transformacion_tab($(e.currentTarget).data("ttab")));
		$body.on("click", "#inv-m-refresh", () => this._load_transformacion_list());
		$body.on("click", ".inv-mov-row", (e) => this._trf_view_detail($(e.currentTarget).data("view")));

		let _timer = null;
		$body.on("input", "#inv-trf-item-search", (e) => {
			clearTimeout(_timer);
			const val = e.target.value.trim();
			if (val.length < 2) { $body.find("#inv-trf-item-results").hide(); return; }
			_timer = setTimeout(() => {
				frappe.call({
					method: "facex_multi.api.stock.search_items_padre_transformables",
					args: { txt: val, company: this.defaults.company },
					callback: (r) => {
						const items = r.message || [];
						const $results = $body.find("#inv-trf-item-results");
						if (!items.length) { $results.html(`<div style="color:#adb5bd;">Sin resultados</div>`).show(); return; }
						$results.html(items.map((it) => `
<div data-item='${JSON.stringify(it).replace(/'/g, "&#39;")}'>
  <strong>${frappe.utils.escape_html(it.item_code)}</strong> — ${frappe.utils.escape_html(it.item_name || "")}
</div>`).join("")).show();
					},
				});
			}, 300);
		});
		$body.on("click", "#inv-trf-item-results div", (e) => {
			const it = $(e.currentTarget).data("item");
			$body.find("#inv-trf-item-results").hide();
			this._trf_load_bom(it.item_code);
		});
		$(document).on("click.facexInv", (e) => {
			if (!$(e.target).closest("#inv-trf-item-search, #inv-trf-item-results").length) $body.find("#inv-trf-item-results").hide();
		});

		$body.on("input", "#inv-trf-cantidad", (e) => {
			this._trf.cantidad = e.target.value;
			this._trf_render_components();
		});
		$body.on("change", "#inv-trf-warehouse-target", (e) => { this._trf.target_warehouse = e.target.value; });
		$body.on("change", ".inv-trf-source", (e) => {
			const comp = $(e.target).data("comp");
			const row = this._trf.components.find((c) => c.item_code === comp);
			if (row) row.source_warehouse = e.target.value;
		});
		$body.on("input", ".inv-trf-field", (e) => {
			const comp = $(e.target).data("comp");
			const field = $(e.target).data("field");
			const row = this._trf.components.find((c) => c.item_code === comp);
			if (row) row[field] = e.target.value;
		});

		$body.on("click", "#inv-trf-save", () => this._trf_save());
	}

	_switch_transformacion_tab(tab) {
		this._trf_tab = tab;
		this.$body.find(".inv-tab").removeClass("inv-tab-active");
		this.$body.find(`.inv-tab[data-ttab="${tab}"]`).addClass("inv-tab-active");
		this.$body.find("#inv-trf-tab-nueva").toggle(tab === "nueva");
		this.$body.find("#inv-trf-tab-movs").toggle(tab === "movs");
		if (tab === "movs") this._load_transformacion_list();
	}

	_trf_load_bom(item_code) {
		frappe.call({
			method: "facex_multi.api.stock.get_lista_materiales_for_transform",
			args: { item_code, company: this.defaults.company },
			freeze: true,
			callback: (r) => {
				if (!r.message) return;
				const d = r.message;
				this._trf.item_code = item_code;
				this._trf.item_name = d.item_name || "";
				this._trf.components = (d.items || []).map((it) => ({
					item_code: it.item_code,
					item_name: it.item_name,
					qty_per_unit: it.qty,
					stock_uom: it.stock_uom,
					has_batch_no: cint(it.has_batch_no),
					has_serial_no: cint(it.has_serial_no),
					stock: it.stock || [],
					source_warehouse: "",
					batch_no: "",
					serial_no: "",
				}));
				this._render_transformacion();
			},
		});
	}

	_trf_save() {
		const t = this._trf;
		if (!t.item_code) { frappe.show_alert({ message: "Seleccione el producto padre.", indicator: "orange" }); return; }
		const cantidad = flt(t.cantidad);
		if (!(cantidad > 0)) { frappe.show_alert({ message: "La cantidad a transformar debe ser mayor a cero.", indicator: "orange" }); return; }
		const target_warehouse = this.$body.find("#inv-trf-warehouse-target").val();
		if (!target_warehouse) { frappe.show_alert({ message: "Seleccione el almacén destino del producto padre.", indicator: "orange" }); return; }
		if (!t.components.length) { frappe.show_alert({ message: "Este producto no tiene componentes configurados.", indicator: "orange" }); return; }
		for (const c of t.components) {
			if (!c.source_warehouse) {
				frappe.show_alert({ message: `Seleccione el almacén origen de '${c.item_code}'.`, indicator: "orange" });
				return;
			}
		}

		const posting_date = this.$body.find("#inv-trf-date").val();
		const remarks = this.$body.find("#inv-trf-remarks").val();

		const payload = {
			company: this.defaults.company,
			item_padre: t.item_code,
			cantidad,
			target_warehouse,
			posting_date,
			remarks,
			componentes: t.components.map((c) => ({
				item_code: c.item_code,
				source_warehouse: c.source_warehouse,
				batch_no: c.batch_no,
				serial_no: c.serial_no,
			})),
		};
		const client_token = this._trf_client_token;

		frappe.confirm(
			`¿Confirmar la transformación de <strong>${cantidad}</strong> unidad(es) de <strong>${frappe.utils.escape_html(t.item_code)}</strong>?`,
			() => {
				frappe.call({
					method: "facex_multi.api.stock.create_transformacion",
					args: { payload: JSON.stringify(payload), client_token },
					freeze: true,
					freeze_message: "Registrando transformación…",
					callback: (r) => {
						if (!r.message) return;
						frappe.show_alert({ message: `Transformación ${r.message.name} registrada.`, indicator: "green" });
						this._open_transformacion();
					},
				});
			}
		);
	}

	_load_transformacion_list() {
		const from_date = this.$body.find("#inv-m-from").val();
		const to_date = this.$body.find("#inv-m-to").val();
		const $tbody = this.$body.find("#inv-m-tbody");
		$tbody.html(`<tr><td colspan="6" style="text-align:center;color:#adb5bd;padding:20px;">Cargando...</td></tr>`);

		frappe.call({
			method: "facex_multi.api.stock.list_stock_entries_transform",
			args: { company: this.defaults.company, from_date, to_date },
			callback: (r) => {
				const rows = (r.message && r.message.rows) || [];
				if (!rows.length) {
					$tbody.html(`<tr><td colspan="6" style="text-align:center;color:#adb5bd;padding:20px;">Sin transformaciones en este rango.</td></tr>`);
					return;
				}
				const STATUS = { 0: ["Borrador", "#6c757d"], 1: ["Sometido", "#28a745"], 2: ["Anulado", "#e03e2d"] };
				$tbody.html(rows.map((row) => {
					const [label, color] = STATUS[row.docstatus] || STATUS[0];
					return `
<tr class="inv-mov-row" data-view="${frappe.utils.escape_html(row.name)}">
  <td><strong>${frappe.utils.escape_html(row.name)}</strong></td>
  <td>${frappe.utils.escape_html(row.posting_date || "")}</td>
  <td>${row.item_count}</td>
  <td>${frappe.format(row.total_incoming_value, { fieldtype: "Currency" })}</td>
  <td><span style="color:${color};font-weight:600;">${label}</span></td>
  <td>${frappe.utils.escape_html(row.remarks || "")}</td>
</tr>`;
				}).join(""));
			},
		});
	}

	_trf_view_detail(name) {
		frappe.call({
			method: "facex_multi.api.stock.get_stock_entry_detail",
			args: { name },
			freeze: true,
			callback: (r) => {
				if (!r.message) return;
				this._show_transformacion_detail(r.message);
			},
		});
	}

	_show_transformacion_detail(doc) {
		const is_cancelled = cint(doc.docstatus) === 2;
		const padre = doc.items.find((it) => cint(it.is_finished_item));
		const componentes = doc.items.filter((it) => !cint(it.is_finished_item));

		const rows_html = `
<tr style="background:#f0f4ff;">
  <td><strong>${frappe.utils.escape_html(padre ? padre.item_code : "")}</strong><br><span style="color:#6c757d;">${frappe.utils.escape_html(padre ? padre.item_name || "" : "")}</span></td>
  <td>Producido</td>
  <td>+${padre ? flt(padre.qty) : 0} ${frappe.utils.escape_html(padre ? padre.uom || "" : "")}</td>
</tr>
${componentes.map((c) => `
<tr>
  <td><strong>${frappe.utils.escape_html(c.item_code)}</strong><br><span style="color:#6c757d;">${frappe.utils.escape_html(c.item_name || "")}</span></td>
  <td>Consumido</td>
  <td>-${flt(c.qty)} ${frappe.utils.escape_html(c.uom || "")}</td>
</tr>`).join("")}`;

		const d = new frappe.ui.Dialog({
			title: `Transformación ${doc.name}${is_cancelled ? " (Anulado)" : ""}`,
			fields: [
				{
					fieldtype: "HTML",
					fieldname: "detail",
					options: `
<div style="font-size:12.5px;color:#6c757d;margin-bottom:10px;">${frappe.utils.escape_html(doc.posting_date || "")}${doc.remarks ? " · " + frappe.utils.escape_html(doc.remarks) : ""}</div>
<table class="inv-table" style="width:100%;"><thead><tr><th>Producto</th><th style="width:90px;">Tipo</th><th style="width:130px;">Cantidad</th></tr></thead><tbody>${rows_html}</tbody></table>
<style>${INV_STYLES}</style>`,
				},
			],
			primary_action_label: is_cancelled ? "Cerrar" : "Anular",
			primary_action: () => {
				if (is_cancelled) { d.hide(); return; }
				frappe.confirm(`¿Anular la transformación <strong>${doc.name}</strong>? Esta acción no se puede deshacer.`, () => {
					frappe.call({
						method: "facex_multi.api.stock.cancel_stock_entry",
						args: { name: doc.name },
						freeze: true,
						callback: (r) => {
							if (!r.message) return;
							d.hide();
							frappe.show_alert({ message: "Transformación anulada.", indicator: "green" });
							this._load_transformacion_list();
						},
					});
				});
			},
		});
		d.show();
	}
}

// Modo Enfoque — mismo bloque genérico ya usado por FacEx y FacEx Screen
// (oculta navbar/sidebar/footer de Frappe Desk y expande el contenido a
// ancho completo). Cada página carga su propia copia porque cada una tiene
// su <style> propio, pero la clase de body (facex-fullscreen-mode) es la
// misma en las tres, así que basta con que UNA la agregue/quite.
const INV_TOPBAR_STYLES = `
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

.inv-topbar { display:flex;align-items:center;justify-content:space-between;background:#fff;border-bottom:1px solid #d1d8dd;padding:10px 20px; }
.inv-topbar-left, .inv-topbar-right { display:flex;align-items:center;gap:14px; }
.inv-topbar-logo { display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;color:#153375; }
.inv-topbar-sub { font-weight:600;font-size:13px;color:#6c757d; }
.inv-topbar-link { background:none;border:none;padding:6px 10px;border-radius:4px;font-size:13px;font-weight:500;color:#495057;cursor:pointer; }
.inv-topbar-link:hover { background:#f1f5f9;color:#153375; }

.inv-transporte-dropdown { position:relative;display:flex;align-items:center; }
.inv-transporte-btn { display:flex;align-items:center;gap:4px; }
.inv-transporte-menu { display:none;position:absolute;top:120%;left:0;background:#fff;border:1px solid #d1d8dd;box-shadow:0 10px 15px -3px rgba(0,0,0,.1);border-radius:10px;padding:6px;min-width:220px;max-width:90vw;max-height:calc(100vh - 80px);overflow-y:auto;z-index:1001; }
.inv-transporte-menu-item { display:block;width:100%;text-align:left;background:none;border:none;padding:9px 12px;border-radius:6px;font-size:13px;color:#333;cursor:pointer; }
.inv-transporte-menu-item:hover { background:#f1f5f9;color:#153375; }

.inv-user-dropdown { position:relative;display:flex;align-items:center; }
.inv-user-btn { padding:6px 10px;border-radius:20px;background:#f1f5f9;border:1px solid #cbd5e1;display:flex;align-items:center;gap:6px;cursor:pointer; }
.inv-user-btn:hover { background:#e2e8f0; }
.inv-user-menu { display:none;position:absolute;top:120%;right:0;background:#fff;border:1px solid #d1d8dd;box-shadow:0 10px 15px -3px rgba(0,0,0,.1);border-radius:10px;padding:14px;min-width:220px;max-width:90vw;max-height:calc(100vh - 80px);overflow-y:auto;z-index:1001; }
.inv-user-menu-label { font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6c757d;margin-bottom:4px; }
.inv-user-fullname { font-size:14px;font-weight:700;color:#0f172a;line-height:1.2; }
.inv-user-email { font-size:12px;color:#6c757d;margin-bottom:14px;word-break:break-all; }
.inv-company-select { width:100%;margin-bottom:8px; }
.inv-user-menu-btn { width:100%;margin-bottom:8px; }
.inv-user-menu-btn:last-child { margin-bottom:0; }
`;

const INV_STYLES = `
.inv-filter-panel { background:#fff;border:1px solid #d1d8dd;border-radius:6px;margin-bottom:16px;overflow:hidden; }
.inv-filter-header { display:flex;align-items:center;justify-content:space-between;padding:12px 20px;cursor:pointer;user-select:none; }
.inv-filter-header:hover { background:#fafbff; }
.inv-filter-title { font-size:13px;font-weight:600;color:#333; }
.inv-filter-chevron { color:#6c757d;font-size:12px;transition:transform .15s; }
.inv-filter-collapsed .inv-filter-chevron { transform:rotate(-90deg); }
.inv-filter-body { padding:4px 20px 18px; }
.inv-filter-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;text-align:left;align-items:end; }
.inv-filter-actions { margin-top:14px;text-align:left; }
.inv-chart-card { background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:18px 20px;margin-bottom:16px; }
.inv-chart-title { font-size:13px;font-weight:600;color:#333;margin-bottom:10px; }
.inv-tabs { display:flex;gap:4px;border-bottom:1px solid #d1d8dd;margin-bottom:16px; }
.inv-tab { padding:9px 16px;font-size:13px;font-weight:500;color:#6c757d;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px; }
.inv-tab:hover { color:#333; }
.inv-tab-active { color:#5e64ff;border-bottom-color:#5e64ff;font-weight:600; }
.inv-mov-row { cursor:pointer; }
.inv-mov-row:hover td { background:#f0f4ff; }
.inv-label { font-size:12px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px; }
.inv-select { padding:7px 10px;border:1px solid #d1d8dd;border-radius:4px;font-size:13px;background:#fff; }
.inv-select:focus { outline:none;border-color:#5e64ff;box-shadow:0 0 0 2px rgba(94,100,255,.15); }
.inv-card { background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:18px 20px;cursor:pointer;transition:box-shadow .15s,border-color .15s; }
.inv-card:hover { box-shadow:0 2px 10px rgba(0,0,0,.08);border-color:#5e64ff; }
.inv-card-title { font-size:14px;font-weight:600;color:#333;margin-bottom:4px; }
.inv-card-desc { font-size:12.5px;color:#6c757d;line-height:1.4; }
.inv-card-disabled { opacity:.5;cursor:not-allowed; }
.inv-card-disabled:hover { box-shadow:none;border-color:#d1d8dd; }
.inv-card-tag { display:inline-block;margin-top:10px;font-size:11px;font-weight:600;color:#5e64ff; }
.inv-btn { padding:7px 18px;border-radius:4px;border:none;cursor:pointer;font-size:13px;font-weight:500; }
.inv-btn:disabled { opacity:.5;cursor:not-allowed; }
.inv-btn-primary { background:#5e64ff;color:#fff; }
.inv-btn-primary:hover:not(:disabled) { background:#4b51e0; }
.inv-btn-secondary { background:#e9ecef;color:#495057; }
.inv-btn-secondary:hover:not(:disabled) { background:#dee2e6; }
.inv-btn-danger { background:#fff;color:#e03e2d;border:1px solid #e03e2d; }
.inv-btn-danger:hover:not(:disabled) { background:#fdeeee; }
.inv-autocomplete { position:absolute;top:100%;left:0;right:0;z-index:999;background:#fff;border:1px solid #d1d8dd;border-radius:4px;max-height:220px;overflow-y:auto;display:none;box-shadow:0 4px 12px rgba(0,0,0,.12); }
.inv-autocomplete div { padding:8px 12px;cursor:pointer;font-size:13px; }
.inv-autocomplete div:hover { background:#f0f4ff; }
.inv-table { width:100%;border-collapse:collapse;font-size:12.5px; }
.inv-table th { background:#f8f9fa;border-bottom:2px solid #dee2e6;padding:8px 10px;text-align:left;font-size:11px;color:#495057;text-transform:uppercase;letter-spacing:.4px;font-weight:600; }
.inv-table td { border-bottom:1px solid #f0f0f0;padding:6px 8px;vertical-align:middle; }
.inv-table input { width:100%;padding:5px 7px;border:1px solid #d1d8dd;border-radius:3px;font-size:12.5px;box-sizing:border-box; }
.inv-row-remove { cursor:pointer;color:#e03e2d;font-weight:700; }
.inv-row-info { cursor:pointer;color:#5e64ff;margin-right:4px; }
.inv-popover { position:absolute;z-index:1050;background:#fff;border:1px solid #d1d8dd;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.15);padding:12px 14px;min-width:260px;font-size:12.5px; }
`;
