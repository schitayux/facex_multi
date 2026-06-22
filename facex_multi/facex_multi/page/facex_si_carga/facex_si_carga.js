// FacEx Multi — Carga de Saldos Iniciales desde archivo TSV
// NO certifica, NO firma, NO envía a FEL.

frappe.pages["facex-si-carga"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: "Carga de Saldos Iniciales — FacEx",
		single_column: true,
	});
	new FacexSICarga(page, wrapper);
};

class FacexSICarga {
	constructor(page, wrapper) {
		this.page = page;
		this.wrapper = wrapper;
		this.$body = $(page.body);
		this.rows = [];
		this.validated = false;
		this.defaults = {};
		this._init();
	}

	_init() {
		this._render_shell();
		this._load_defaults();
	}

	_render_shell() {
		this.$body.html(`
<div id="si-app" style="max-width:1400px;margin:0 auto;padding:16px 8px;">

  <!-- ── CABECERA DE CARGA ── -->
  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:15px;font-weight:600;color:#333;margin-bottom:16px;">
      Parámetros globales de carga
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;">

      <div class="si-field">
        <label class="si-label">Compañía <span class="si-req">*</span></label>
        <select id="si-company" class="si-select"></select>
      </div>

      <div class="si-field">
        <label class="si-label">Ítem por defecto <span class="si-req">*</span></label>
        <div class="si-link-wrap">
          <input id="si-item" type="text" class="si-input" placeholder="Buscar ítem…" autocomplete="off">
          <div id="si-item-results" class="si-autocomplete"></div>
        </div>
      </div>

      <div class="si-field">
        <label class="si-label">Condiciones de pago</label>
        <select id="si-payment-terms" class="si-select">
          <option value="">(sin condición)</option>
        </select>
      </div>

      <div class="si-field">
        <label class="si-label">Estado FEL <span class="si-req">*</span></label>
        <select id="si-fel-status" class="si-select">
          <option value="00 No enviar">00 No enviar</option>
          <option value="02 Procesada">02 Procesada</option>
        </select>
      </div>

      <div class="si-field">
        <label class="si-label">Subir como pagadas</label>
        <select id="si-upload-paid" class="si-select">
          <option value="0">No</option>
          <option value="1">Sí</option>
        </select>
      </div>

      <div class="si-field">
        <label class="si-label">Serie (naming_series)</label>
        <select id="si-series" class="si-select">
          <option value="">(auto por compañía)</option>
        </select>
      </div>

    </div>
  </div>

  <!-- ── SUBIR ARCHIVO ── -->
  <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:20px 24px;margin-bottom:16px;">
    <div style="font-size:15px;font-weight:600;color:#333;margin-bottom:14px;">
      Archivo TXT (delimitado por tabulaciones)
    </div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <label class="si-file-label">
        <input type="file" id="si-file-input" accept=".txt,.tsv" style="display:none;">
        <span id="si-file-name" style="color:#6c757d;font-size:13px;">Ningún archivo seleccionado</span>
        <button type="button" class="si-btn si-btn-secondary" onclick="document.getElementById('si-file-input').click()">
          Elegir archivo
        </button>
      </label>
      <button type="button" id="si-btn-read" class="si-btn si-btn-primary" disabled>
        Leer archivo
      </button>
    </div>
    <div id="si-file-msg" style="margin-top:8px;font-size:13px;"></div>
  </div>

  <!-- ── GRID ── -->
  <div id="si-grid-section" style="display:none;">
    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:16px 18px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
        <div>
          <span style="font-size:15px;font-weight:600;color:#333;">Filas cargadas</span>
          <span id="si-row-count" style="margin-left:8px;font-size:13px;color:#6c757d;"></span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button type="button" id="si-btn-validate" class="si-btn si-btn-warning">
            Validar filas
          </button>
          <button type="button" id="si-btn-create" class="si-btn si-btn-success" disabled>
            Crear facturas
          </button>
        </div>
      </div>

      <!-- Info de omitidas -->
      <div id="si-skipped-box" style="display:none;background:#fff8e1;border:1px solid #ffe082;border-radius:4px;padding:10px 14px;margin-bottom:12px;font-size:13px;"></div>

      <div style="overflow-x:auto;">
        <table id="si-grid-table" class="si-table">
          <thead>
            <tr>
              <th style="width:36px;">#</th>
              <th>Estado</th>
              <th>Fecha</th>
              <th>UUID FEL</th>
              <th>Serie</th>
              <th>Número</th>
              <th>Establecimiento</th>
              <th>ID Receptor</th>
              <th>Cliente</th>
              <th>Gran Total</th>
              <th>IVA</th>
              <th>Ítem</th>
              <th>Cond. Pago</th>
              <th>Estado FEL</th>
              <th>Pagada</th>
              <th>Moneda</th>
            </tr>
          </thead>
          <tbody id="si-grid-body"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ── RESULTADOS FINALES ── -->
  <div id="si-results-section" style="display:none;">
    <div class="card" style="background:#fff;border:1px solid #d1d8dd;border-radius:6px;padding:20px 24px;">
      <div style="font-size:15px;font-weight:600;color:#333;margin-bottom:14px;">Resumen de carga</div>
      <div id="si-summary"></div>
      <div id="si-errors-detail" style="margin-top:12px;"></div>
    </div>
  </div>

</div>

<style>
.si-label { font-size:12px;font-weight:600;color:#6c757d;display:block;margin-bottom:4px;text-transform:uppercase;letter-spacing:.4px; }
.si-req { color:#e03e2d; }
.si-input,.si-select { width:100%;padding:7px 10px;border:1px solid #d1d8dd;border-radius:4px;font-size:13px;background:#fff;box-sizing:border-box; }
.si-input:focus,.si-select:focus { outline:none;border-color:#5e64ff;box-shadow:0 0 0 2px rgba(94,100,255,.15); }
.si-field { position:relative; }
.si-link-wrap { position:relative; }
.si-autocomplete { position:absolute;top:100%;left:0;right:0;z-index:999;background:#fff;border:1px solid #d1d8dd;border-radius:4px;max-height:200px;overflow-y:auto;display:none;box-shadow:0 4px 12px rgba(0,0,0,.12); }
.si-autocomplete div { padding:8px 12px;cursor:pointer;font-size:13px; }
.si-autocomplete div:hover { background:#f0f4ff; }
.si-btn { padding:7px 18px;border-radius:4px;border:none;cursor:pointer;font-size:13px;font-weight:500;transition:opacity .15s; }
.si-btn:disabled { opacity:.45;cursor:not-allowed; }
.si-btn-primary { background:#5e64ff;color:#fff; }
.si-btn-primary:hover:not(:disabled) { background:#4b51e0; }
.si-btn-secondary { background:#e9ecef;color:#495057; }
.si-btn-secondary:hover:not(:disabled) { background:#dee2e6; }
.si-btn-warning { background:#ff9f43;color:#fff; }
.si-btn-warning:hover:not(:disabled) { background:#e08a2f; }
.si-btn-success { background:#28a745;color:#fff; }
.si-btn-success:hover:not(:disabled) { background:#218838; }
.si-table { width:100%;border-collapse:collapse;font-size:12.5px;white-space:nowrap; }
.si-table th { background:#f8f9fa;border-bottom:2px solid #dee2e6;padding:8px 10px;text-align:left;font-size:11.5px;color:#495057;text-transform:uppercase;letter-spacing:.4px;font-weight:600; }
.si-table td { border-bottom:1px solid #f0f0f0;padding:6px 8px;vertical-align:middle; }
.si-table tr:hover td { background:#fafbff; }
.si-row-ok { background:transparent; }
.si-row-error td:first-child { border-left:3px solid #e03e2d; }
.si-row-dup td:first-child { border-left:3px solid #ff9f43; }
.si-row-create td:first-child { border-left:3px solid #5e64ff; }
.si-badge { display:inline-block;padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600; }
.si-badge-ok { background:#d4edda;color:#155724; }
.si-badge-error { background:#f8d7da;color:#721c24; }
.si-badge-dup { background:#fff3cd;color:#856404; }
.si-badge-crear { background:#cce5ff;color:#004085; }
.si-badge-pendiente { background:#f8f9fa;color:#6c757d; }
.si-editable { cursor:pointer;border-bottom:1px dashed #aaa;min-width:60px;display:inline-block; }
.si-editable:hover { background:#f0f4ff; }
.si-edit-input { border:1px solid #5e64ff;border-radius:3px;padding:3px 6px;font-size:12.5px;width:100%;box-sizing:border-box; }
.si-tooltip-err { font-size:11px;color:#e03e2d;display:block;margin-top:2px; }
</style>
		`);

		this._bind_events();
	}

	_bind_events() {
		const $body = this.$body;

		// Cambio de compañía
		$body.on("change", "#si-company", () => this._on_company_change());

		// Búsqueda de ítem
		let _item_timer = null;
		$body.on("input", "#si-item", (e) => {
			clearTimeout(_item_timer);
			const val = e.target.value.trim();
			if (val.length < 2) { $body.find("#si-item-results").hide(); return; }
			_item_timer = setTimeout(() => this._search_item(val), 300);
		});
		$body.on("click", "#si-item-results div", (e) => {
			const $d = $(e.target);
			$body.find("#si-item").val($d.data("label"));
			$body.find("#si-item").data("value", $d.data("value"));
			$body.find("#si-item-results").hide();
		});
		$(document).on("click.sicarga", (e) => {
			if (!$(e.target).closest(".si-link-wrap").length)
				$body.find("#si-item-results").hide();
		});

		// Selección de archivo
		$body.on("change", "#si-file-input", (e) => {
			const file = e.target.files[0];
			if (file) {
				$body.find("#si-file-name").text(file.name);
				$body.find("#si-btn-read").prop("disabled", false);
			}
		});

		// Leer archivo
		$body.on("click", "#si-btn-read", () => this._read_file());

		// Validar
		$body.on("click", "#si-btn-validate", () => this._validate_rows());

		// Crear
		$body.on("click", "#si-btn-create", () => this._create_invoices());
	}

	// ──────────────────────────────────────────────
	// Cargar defaults
	// ──────────────────────────────────────────────

	_load_defaults() {
		frappe.call({
			method: "facex_multi.api.si_carga.get_load_defaults",
			freeze: true,
			freeze_message: "Cargando configuración…",
			callback: (r) => {
				if (!r.message) return;
				const d = r.message;
				this.defaults = d;
				this._populate_companies(d.companies, d.company);
				this._populate_payment_terms(d.payment_terms);
				this._populate_series(d.naming_series);
			},
		});
	}

	_populate_companies(companies, selected) {
		const $sel = this.$body.find("#si-company");
		$sel.empty();
		companies.forEach((c) => {
			$sel.append(`<option value="${c}" ${c === selected ? "selected" : ""}>${c}</option>`);
		});
		this._on_company_change();
	}

	_populate_payment_terms(terms) {
		const $sel = this.$body.find("#si-payment-terms");
		terms.forEach((t) => $sel.append(`<option value="${t}">${t}</option>`));
	}

	_populate_series(series_list) {
		const $sel = this.$body.find("#si-series");
		$sel.empty().append('<option value="">(auto por compañía)</option>');
		series_list.forEach((s) => $sel.append(`<option value="${s}">${s}</option>`));
	}

	_on_company_change() {
		const company = this.$body.find("#si-company").val();
		if (!company) return;
		frappe.call({
			method: "facex_multi.api.si_carga.get_series_for_company",
			args: { company },
			callback: (r) => {
				if (r.message) this._populate_series(r.message);
			},
		});
		// Revalidar si ya hay filas
		if (this.rows.length) {
			this.validated = false;
			this._render_grid();
			this.$body.find("#si-btn-create").prop("disabled", true);
		}
	}

	// ──────────────────────────────────────────────
	// Búsqueda de ítem
	// ──────────────────────────────────────────────

	_search_item(txt) {
		frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "Item",
				filters: [["item_name", "like", `%${txt}%`], ["disabled", "=", 0]],
				fields: ["name", "item_name"],
				limit: 15,
			},
			callback: (r) => {
				const $ac = this.$body.find("#si-item-results");
				$ac.empty();
				if (!r.message || !r.message.length) { $ac.hide(); return; }
				r.message.forEach((item) => {
					$ac.append(
						`<div data-value="${item.name}" data-label="${item.item_name}">
              <strong>${item.item_name}</strong> <span style="color:#999;font-size:11px;">(${item.name})</span>
            </div>`
					);
				});
				$ac.show();
			},
		});
	}

	_get_item_code() {
		const val = this.$body.find("#si-item").data("value");
		const txt = this.$body.find("#si-item").val().trim();
		// Si el usuario escribió exactamente el item_name o item_code
		return val || txt || "";
	}

	// ──────────────────────────────────────────────
	// Leer archivo
	// ──────────────────────────────────────────────

	_read_file() {
		const file_input = this.$body.find("#si-file-input")[0];
		if (!file_input.files.length) {
			frappe.show_alert({ message: "Seleccione un archivo primero.", indicator: "orange" });
			return;
		}

		const company = this.$body.find("#si-company").val();
		if (!company) {
			frappe.show_alert({ message: "Seleccione una compañía.", indicator: "orange" });
			return;
		}

		const item = this._get_item_code();
		if (!item) {
			frappe.show_alert({ message: "Ingrese el ítem por defecto.", indicator: "orange" });
			return;
		}

		const reader = new FileReader();
		reader.onload = (e) => {
			// Decodificar como Latin-1 (Windows-1252) para archivos SAT Guatemala
			let content = e.target.result;
			if (content instanceof ArrayBuffer) {
				const decoder = new TextDecoder("windows-1252");
				content = decoder.decode(content);
			}
			this.$body.find("#si-file-msg").html(
				'<span style="color:#5e64ff;">Parseando archivo…</span>'
			);
			frappe.call({
				method: "facex_multi.api.si_carga.parse_file",
				args: { file_content: content },
				freeze: true,
				freeze_message: "Leyendo archivo…",
				callback: (r) => {
					if (!r.message) return;
					const data = r.message;
					this.rows = data.rows;
					this.parsed_data = data;
					this.validated = false;

					// Aplicar defaults globales a cada fila
					const global_fel = this.$body.find("#si-fel-status").val();
					const global_paid = this.$body.find("#si-upload-paid").val();
					const global_pt = this.$body.find("#si-payment-terms").val();

					this.rows.forEach((row) => {
						if (!row.bfel_status) row.bfel_status = global_fel;
						if (row.upload_as_paid === null || row.upload_as_paid === undefined)
							row.upload_as_paid = parseInt(global_paid) || 0;
						if (!row.payment_terms) row.payment_terms = global_pt;
						row.item_code = item;
					});

					const msg =
						`<span style="color:#28a745;">✔ ${data.total_ok} fila(s) cargadas</span>` +
						(data.total_skipped
							? ` <span style="color:#ff9f43;"> — ${data.total_skipped} omitidas</span>`
							: "");
					this.$body.find("#si-file-msg").html(msg);

					this._render_grid();
					this._show_skipped(data.skipped || []);
				},
			});
		};
		// Leer como ArrayBuffer para poder decodificar con TextDecoder (windows-1252)
		reader.readAsArrayBuffer(file_input.files[0]);
	}

	// ──────────────────────────────────────────────
	// Renderizar grid
	// ──────────────────────────────────────────────

	_render_grid() {
		this.$body.find("#si-grid-section").show();
		this.$body.find("#si-row-count").text(`(${this.rows.length} filas)`);

		const $tbody = this.$body.find("#si-grid-body");
		$tbody.empty();

		this.rows.forEach((row, idx) => {
			const rowClass = this._row_class(row);
			const statusBadge = this._status_badge(row);
			const errors = (row._errors || []).join(" | ");
			const warnings = (row._warnings || []).join(" | ");

			const errTip = errors
				? `<span class="si-tooltip-err" title="${errors}">⚠ ${errors.substring(0,60)}${errors.length>60?"…":""}</span>`
				: (warnings ? `<span class="si-tooltip-err" style="color:#ff9f43;" title="${warnings}">ℹ ${warnings.substring(0,60)}${warnings.length>60?"…":""}</span>` : "");

			$tbody.append(`
<tr class="${rowClass}" data-idx="${idx}">
  <td style="text-align:center;color:#999;">${idx + 1}</td>
  <td>${statusBadge}${errTip}</td>
  <td>${row.posting_date || ""}</td>
  <td style="font-size:11px;color:#666;max-width:120px;overflow:hidden;text-overflow:ellipsis;" title="${row.bfel_uuid || ""}">${(row.bfel_uuid || "").substring(0,12)}…</td>
  <td>${row.bfel_docto_serie || ""}</td>
  <td>${row.bfel_docto_no || ""}</td>
  <td>
    <span class="si-editable" data-field="bfel_establecimiento" data-idx="${idx}">${row.bfel_establecimiento || "—"}</span>
  </td>
  <td>${row.id_receptor || ""}</td>
  <td>
    <span class="si-editable" data-field="customer" data-idx="${idx}" style="max-width:160px;overflow:hidden;text-overflow:ellipsis;display:inline-block;" title="${row.customer_name || ''}">${row.customer || row.customer_name || "—"}</span>
  </td>
  <td style="text-align:right;">${this._fmt_money(row.gran_total, row.currency)}</td>
  <td style="text-align:right;">${row.tiene_iva ? this._fmt_money(row.iva_monto, row.currency) : "—"}</td>
  <td>
    <span class="si-editable" data-field="item_code" data-idx="${idx}">${row.item_code || "—"}</span>
  </td>
  <td>
    <span class="si-editable" data-field="payment_terms" data-idx="${idx}">${row.payment_terms || "—"}</span>
  </td>
  <td>
    <select class="si-edit-select" data-field="bfel_status" data-idx="${idx}" style="font-size:12px;padding:3px 6px;border:1px solid #dee2e6;border-radius:3px;">
      <option value="00 No enviar" ${row.bfel_status === "00 No enviar" ? "selected" : ""}>00 No enviar</option>
      <option value="02 Procesada" ${row.bfel_status === "02 Procesada" ? "selected" : ""}>02 Procesada</option>
    </select>
  </td>
  <td style="text-align:center;">
    <input type="checkbox" class="si-paid-chk" data-idx="${idx}" ${row.upload_as_paid ? "checked" : ""}>
  </td>
  <td>${row.currency || "GTQ"}</td>
</tr>`);
		});

		// Bind editable cells
		$tbody.off(".sicarga").on("click.sicarga", ".si-editable", (e) => {
			this._inline_edit($(e.currentTarget));
		});
		$tbody.on("change.sicarga", ".si-edit-select", (e) => {
			const $el = $(e.currentTarget);
			const idx = parseInt($el.data("idx"));
			const field = $el.data("field");
			this.rows[idx][field] = $el.val();
		});
		$tbody.on("change.sicarga", ".si-paid-chk", (e) => {
			const $el = $(e.currentTarget);
			const idx = parseInt($el.data("idx"));
			this.rows[idx].upload_as_paid = $el.is(":checked") ? 1 : 0;
		});
	}

	_inline_edit($span) {
		const idx = parseInt($span.data("idx"));
		const field = $span.data("field");
		const current = this.rows[idx][field] || "";

		const $input = $(`<input type="text" class="si-edit-input" value="${current}">`);
		$span.replaceWith($input);
		$input.focus();

		$input.on("blur keydown", (e) => {
			if (e.type === "keydown" && e.key !== "Enter" && e.key !== "Escape") return;
			const newVal = e.key === "Escape" ? current : $input.val().trim();
			this.rows[idx][field] = newVal;
			// Re-render solo esta celda
			const $newSpan = $(`<span class="si-editable" data-field="${field}" data-idx="${idx}">${newVal || "—"}</span>`);
			$input.replaceWith($newSpan);
			$newSpan.on("click.sicarga", () => this._inline_edit($newSpan));
		});
	}

	_row_class(row) {
		const st = row._customer_status || "pendiente";
		if (st === "error" || (row._errors && row._errors.length)) return "si-row-error";
		if (st === "duplicado") return "si-row-dup";
		if (st === "crear") return "si-row-create";
		return "si-row-ok";
	}

	_status_badge(row) {
		const st = row._customer_status || "pendiente";
		const map = {
			ok: ["si-badge-ok", "✔ OK"],
			crear: ["si-badge-crear", "+ Crear"],
			error: ["si-badge-error", "✖ Error"],
			duplicado: ["si-badge-dup", "⚠ Dup"],
			pendiente: ["si-badge-pendiente", "— Pendiente"],
		};
		const [cls, label] = map[st] || map.pendiente;
		return `<span class="si-badge ${cls}">${label}</span> `;
	}

	_fmt_money(amount, currency) {
		if (!amount) return "—";
		const fmt = new Intl.NumberFormat("es-GT", {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		});
		return `${currency || "GTQ"} ${fmt.format(amount)}`;
	}

	_show_skipped(skipped) {
		const $box = this.$body.find("#si-skipped-box");
		if (!skipped.length) { $box.hide(); return; }
		let html = `<strong>${skipped.length} fila(s) omitidas del archivo:</strong><ul style="margin:6px 0 0 0;padding-left:20px;">`;
		skipped.slice(0, 20).forEach((s) => {
			html += `<li>Línea ${s.linea}: ${s.razon} <span style="color:#999;">(${s.uuid || s.serie + "/" + s.numero})</span></li>`;
		});
		if (skipped.length > 20) html += `<li>… y ${skipped.length - 20} más</li>`;
		html += "</ul>";
		$box.html(html).show();
	}

	// ──────────────────────────────────────────────
	// Validar filas
	// ──────────────────────────────────────────────

	_validate_rows() {
		const company = this.$body.find("#si-company").val();
		const item = this._get_item_code();

		if (!company) { frappe.show_alert({ message: "Seleccione una compañía.", indicator: "orange" }); return; }
		if (!item) { frappe.show_alert({ message: "Ingrese el ítem por defecto.", indicator: "orange" }); return; }
		if (!this.rows.length) { frappe.show_alert({ message: "Cargue un archivo primero.", indicator: "orange" }); return; }

		// Sincronizar item_code a filas sin ítem
		this.rows.forEach((row) => { if (!row.item_code) row.item_code = item; });

		frappe.call({
			method: "facex_multi.api.si_carga.validate_rows",
			args: {
				rows_json: JSON.stringify(this.rows),
				company: company,
				default_item: item,
			},
			freeze: true,
			freeze_message: "Validando filas…",
			callback: (r) => {
				if (!r.message) return;
				this.rows = r.message.rows;
				this.validated = true;

				this._render_grid();

				const errors = this.rows.filter((row) => (row._errors || []).length).length;
				const dups = this.rows.filter((row) => row._customer_status === "duplicado").length;
				const crear = this.rows.filter((row) => row._customer_status === "crear").length;
				const ok = this.rows.filter((row) => row._customer_status === "ok").length;

				const parts = [];
				if (ok) parts.push(`<span style="color:#28a745;">${ok} OK</span>`);
				if (crear) parts.push(`<span style="color:#5e64ff;">${crear} clientes a crear</span>`);
				if (dups) parts.push(`<span style="color:#ff9f43;">${dups} duplicados</span>`);
				if (errors) parts.push(`<span style="color:#e03e2d;">${errors} con errores</span>`);

				this.$body.find("#si-file-msg").html(
					`<strong>Validación:</strong> ${parts.join(" · ")}`
				);

				const canCreate = this.rows.some(
					(row) => !(row._errors || []).length && row._customer_status !== "duplicado"
				);
				this.$body.find("#si-btn-create").prop("disabled", !canCreate);

				if (!errors && !dups) {
					frappe.show_alert({ message: "Todas las filas son válidas. Puede crear las facturas.", indicator: "green" });
				} else {
					frappe.show_alert({
						message: `Validación completa: ${errors} errores, ${dups} duplicados.`,
						indicator: errors ? "red" : "orange",
					});
				}
			},
		});
	}

	// ──────────────────────────────────────────────
	// Crear facturas
	// ──────────────────────────────────────────────

	_create_invoices() {
		if (!this.validated) {
			frappe.show_alert({ message: "Valide las filas antes de crear facturas.", indicator: "orange" });
			return;
		}

		const company = this.$body.find("#si-company").val();
		const item = this._get_item_code();
		const payment_terms = this.$body.find("#si-payment-terms").val();
		const bfel_status = this.$body.find("#si-fel-status").val();
		const upload_as_paid = this.$body.find("#si-upload-paid").val();
		const naming_series = this.$body.find("#si-series").val();

		// Solo enviar filas sin errores ni duplicados
		const valid_rows = this.rows.filter(
			(row) => !(row._errors || []).length && row._customer_status !== "duplicado"
		);

		if (!valid_rows.length) {
			frappe.show_alert({ message: "No hay filas válidas para crear.", indicator: "orange" });
			return;
		}

		frappe.confirm(
			`¿Crear <strong>${valid_rows.length}</strong> Sales Invoice(s) como saldos iniciales?<br>
      <small>Esta acción NO puede deshacerse fácilmente. Las facturas quedarán en estado Borrador.</small>`,
			() => {
				frappe.call({
					method: "facex_multi.api.si_carga.create_invoices",
					args: {
						rows_json: JSON.stringify(valid_rows),
						company: company,
						default_item: item,
						payment_terms: payment_terms || "",
						bfel_status: bfel_status,
						upload_as_paid: parseInt(upload_as_paid) || 0,
						naming_series: naming_series || "",
					},
					freeze: true,
					freeze_message: "Creando facturas…",
					callback: (r) => {
						if (!r.message) return;
						this._show_results(r.message);
					},
				});
			}
		);
	}

	// ──────────────────────────────────────────────
	// Mostrar resultados
	// ──────────────────────────────────────────────

	_show_results(data) {
		this.$body.find("#si-results-section").show();

		const s = data.summary;
		const summary_html = `
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:16px;">
  ${this._stat_card("Facturas creadas", s.created, "#28a745")}
  ${this._stat_card("Errores", s.errors, s.errors ? "#e03e2d" : "#aaa")}
  ${this._stat_card("Clientes creados", s.customers_created, "#5e64ff")}
  ${this._stat_card("Marcadas pagadas", s.paid, "#ff9f43")}
</div>`;

		this.$body.find("#si-summary").html(summary_html);

		// Links a facturas creadas
		if (s.invoices && s.invoices.length) {
			let links = '<div style="font-size:13px;margin-bottom:8px;"><strong>Facturas creadas:</strong> ';
			links += s.invoices.slice(0, 20).map((n) =>
				`<a href="/app/sales-invoice/${n}" target="_blank">${n}</a>`
			).join(", ");
			if (s.invoices.length > 20) links += ` y ${s.invoices.length - 20} más.`;
			links += "</div>";
			this.$body.find("#si-errors-detail").html(links);
		}

		// Detalle de errores
		const errors = data.results.filter((r) => r.status === "error");
		if (errors.length) {
			let err_html = `<div style="font-size:13px;margin-top:10px;">
        <strong style="color:#e03e2d;">${errors.length} error(es):</strong>
        <ul style="margin:6px 0 0 0;padding-left:20px;">`;
			errors.forEach((r) => {
				err_html += `<li>Línea ${r.linea} (${r.uuid || r.serie_numero}): ${r.error}</li>`;
			});
			err_html += "</ul></div>";
			this.$body.find("#si-errors-detail").append(err_html);
		}

		// Scroll
		this.$body.find("#si-results-section")[0].scrollIntoView({ behavior: "smooth" });

		frappe.show_alert({
			message: `Carga completa: ${s.created} creadas, ${s.errors} errores.`,
			indicator: s.errors ? "orange" : "green",
		});
	}

	_stat_card(label, value, color) {
		return `
<div style="background:#f8f9fa;border-radius:6px;padding:14px;text-align:center;">
  <div style="font-size:28px;font-weight:700;color:${color};">${value}</div>
  <div style="font-size:12px;color:#6c757d;margin-top:4px;">${label}</div>
</div>`;
	}
}
