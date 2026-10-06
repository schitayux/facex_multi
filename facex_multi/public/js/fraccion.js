// Entero / Fracción (2026-10-05) — piezas compartidas por Facturador Clásico,
// Factura Screen e Inventario (Entradas / Salidas / Transferencias).
//
// La compañía configura (FacEx Configuracion Compania → company_config.fraccion):
//   uom: unidad de fracción (ej. "Media Docena"), factor (0.5), etiqueta ("Media"),
//   unidades_base: unidades que la admiten (ej. ["Docena"]; los surtidos en
//   "Unidad" nunca), qr_fraccion / qr_entero: códigos de los QR de modo.
//
// Modo de lectura: "entero" (por defecto) o "fraccion". Se cambia con el
// selector en pantalla o leyendo el QR de modo y queda activo hasta que se
// cambie de nuevo; cada documento nuevo arranca en "entero".
//
// Una línea en fracción es una línea con uom = cfg.uom (ERPNext convierte con
// el factor de la ficha del ítem: 1 Media Docena = 0.5 Docena de stock y la
// mitad del precio de la lista). Nunca se suma a la línea de enteros del mismo
// código: el par (ítem, entero/fracción) es la llave de la línea.

frappe.provide("facex_multi.fraccion");

(function () {
	const F = facex_multi.fraccion;
	const esc = (s) => frappe.utils.escape_html(s == null ? "" : String(s));

	F.cfg = (company_config) => ((company_config || {}).fraccion) || {};
	F.on = (cfg) => !!(cfg && cfg.activo);
	F.normalize = (code) => String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

	// "fraccion" / "entero" si el código leído es un QR de modo; null si no.
	F.control_code = (cfg, code) => {
		if (!F.on(cfg)) return null;
		const c = F.normalize(code);
		if (c && c === F.normalize(cfg.qr_fraccion)) return "fraccion";
		if (c && c === F.normalize(cfg.qr_entero)) return "entero";
		return null;
	};

	F.admite = (cfg, stock_uom) => F.on(cfg) && !!stock_uom && (cfg.unidades_base || []).includes(stock_uom);
	F.is_frac = (cfg, row) => !!(cfg && cfg.uom && row && row.uom === cfg.uom);
	F.factor = (cfg) => parseFloat((cfg || {}).factor) || 0.5;

	// qty con parte decimal múltiplo exacto del factor (2.5 con factor 0.5 →
	// {enteros: 2, fracciones: 1}). null si no aplica (2, 2.3…).
	F.split = (cfg, qty) => {
		const f = F.factor(cfg);
		const q = parseFloat(qty) || 0;
		if (q <= 0) return null;
		const enteros = Math.floor(q + 1e-9);
		const resto = q - enteros;
		if (resto < 1e-9) return null;
		const n = resto / f;
		if (Math.abs(n - Math.round(n)) > 1e-6 || Math.round(n) < 1) return null;
		return { enteros, fracciones: Math.round(n) };
	};

	F.mode_name = (cfg, mode) => (mode === "fraccion" ? (cfg.etiqueta || "Media") : "Entero");

	// ── Estilos (una sola vez) ────────────────────────────────────────────
	F.inject_css = () => {
		if (document.getElementById("fx-fraccion-css")) return;
		const css = `
.fx-uom-frac { background:#fff3cd !important; color:#7a4a00 !important; border:1.5px solid #f0a500 !important; font-weight:800 !important; }
.fx-uom-sel { font-size:11px; padding:1px 2px; border-radius:6px; border:1px solid #cbd5e1; background:#f8fafc; color:#334155; margin-top:3px; width:auto; min-width:100%; max-width:none; }
.ef-td .fx-uom-sel { min-width:108px; }
.fx-uom-tag { display:inline-block; font-size:11px; padding:1px 6px; border-radius:6px; margin-top:3px; }
.fx-frac-toggle { display:inline-flex; border:1.5px solid #cbd5e1; border-radius:8px; overflow:hidden; font-size:12px; font-weight:700; user-select:none; vertical-align:middle; }
.fx-frac-toggle button { border:0; background:#fff; color:#475569; padding:5px 10px; cursor:pointer; line-height:1.2; }
.fx-frac-toggle button + button { border-left:1px solid #cbd5e1; }
.fx-frac-toggle button.fx-on-entero { background:#1e3a8a; color:#fff; }
.fx-frac-toggle button.fx-on-fraccion { background:#f0a500; color:#3b2600; }
.fx-frac-toggle.fx-frac-active { border-color:#f0a500; box-shadow:0 0 0 3px rgba(240,165,0,.25); }
.fx-frac-qr { border:0; background:transparent; color:#64748b; padding:0 6px; cursor:pointer; font-size:14px; vertical-align:middle; }
.fx-scan-frac { border:2px solid #f0a500 !important; background:#fffbeb !important; }
.fx-frac-banner { display:none; background:#f0a500; color:#3b2600; font-weight:800; font-size:12px; letter-spacing:.3px; padding:4px 10px; border-radius:6px; margin-left:6px; vertical-align:middle; }
.fx-frac-banner.fx-show { display:inline-block; animation: fxFracPulse 1.6s ease-in-out infinite; }
@keyframes fxFracPulse { 0%,100% { opacity:1 } 50% { opacity:.65 } }
.fx-frac-qr-sheet { display:flex; gap:24px; justify-content:center; flex-wrap:wrap; }
.fx-frac-qr-card { border:2px dashed #94a3b8; border-radius:10px; padding:14px 18px; text-align:center; width:260px; }
.fx-frac-qr-card svg { width:200px; height:200px; }
.fx-frac-qr-card h3 { margin:6px 0 2px; font-size:20px; font-weight:800; }
`;
		const el = document.createElement("style");
		el.id = "fx-fraccion-css";
		el.textContent = css;
		document.head.appendChild(el);
	};

	// Selector Entero | Media + botón de la hoja de QR + aviso parpadeante.
	F.toggle_html = (cfg, idp) => `
<span class="fx-frac-toggle" id="${idp}-toggle" title="Modo de lectura: Entero o ${esc(cfg.etiqueta || "Media")} (${esc(cfg.uom)}). También cambia leyendo el QR de modo.">
  <button type="button" data-fxmode="entero">Entero</button>
  <button type="button" data-fxmode="fraccion">${esc(cfg.etiqueta || "Media")}</button>
</span><button type="button" class="fx-frac-qr" id="${idp}-qr" title="Imprimir los QR de modo (Entero / ${esc(cfg.etiqueta || "Media")})">&#9638;</button><span class="fx-frac-banner" id="${idp}-banner">LEYENDO ${esc((cfg.uom || "").toUpperCase())}</span>`;

	// Pinta el estado del selector. $root contiene el html de toggle_html.
	F.paint_toggle = ($root, idp, mode, $scan) => {
		const $t = $root.find(`#${idp}-toggle`);
		$t.find("button").removeClass("fx-on-entero fx-on-fraccion");
		$t.find(`[data-fxmode="${mode}"]`).addClass(mode === "fraccion" ? "fx-on-fraccion" : "fx-on-entero");
		$t.toggleClass("fx-frac-active", mode === "fraccion");
		$root.find(`#${idp}-banner`).toggleClass("fx-show", mode === "fraccion");
		if ($scan) $scan.toggleClass("fx-scan-frac", mode === "fraccion");
	};

	F.mode_alert = (cfg, mode) => {
		frappe.show_alert({
			message: mode === "fraccion"
				? `Modo <b>${esc(F.mode_name(cfg, mode))}</b>: lo que lea se agrega como <b>${esc(cfg.uom)}</b> en su propia línea.`
				: "Modo <b>Entero</b>: lo que lea se agrega en la unidad normal del producto.",
			indicator: mode === "fraccion" ? "orange" : "blue",
		}, 4);
	};

	// Selector de UdM por fila (solo ítems que admiten fracción).
	F.uom_select_html = (cfg, row, stock_uom, attrs) => {
		const frac = F.is_frac(cfg, row);
		return `<select class="fx-uom-sel ${frac ? "fx-uom-frac" : ""}" ${attrs || ""} title="Unidad de medida de la línea">
  <option value="${esc(stock_uom)}" ${frac ? "" : "selected"}>${esc(stock_uom)}</option>
  <option value="${esc(cfg.uom)}" ${frac ? "selected" : ""}>${esc(cfg.uom)}</option>
</select>`;
	};

	// Cambio de UdM de una fila: ajusta precio y factor (precio de la fracción
	// = precio de la unidad base × factor). `rate_fields` = campos de precio.
	F.apply_uom_change = (cfg, row, new_uom, stock_uom, rate_fields) => {
		const was = F.is_frac(cfg, row);
		row.uom = new_uom;
		const now = F.is_frac(cfg, row);
		if (was === now) return;
		const f = F.factor(cfg);
		(rate_fields || []).forEach((k) => {
			const v = parseFloat(row[k]);
			if (!isNaN(v) && v) row[k] = Math.round((now ? v * f : v / f) * 1e6) / 1e6;
		});
		row.conversion_factor = now ? f : 1;
		row._stock_uom = stock_uom || row._stock_uom;
	};

	// Pregunta por la separación «2.5 → 2 enteros + 1 fracción».
	F.ask_split = (cfg, base_uom, sp, onYes, onNo) => {
		const frac_txt = `${sp.fracciones} ${esc((cfg.uom || "").toUpperCase())}`;
		frappe.confirm(
			`Esta fila quedará por <b>${sp.enteros} ${esc(base_uom || "")}</b> y se adicionará una nueva fila por <b>${frac_txt}</b> en automático.<br><br>¿Continuar?`,
			onYes, onNo
		);
	};

	// Resumen de fracciones del documento: {total, items, base_eq} o null.
	F.summary = (cfg, rows) => {
		const fr = (rows || []).filter((r) => r && r.item_code && F.is_frac(cfg, r));
		if (!fr.length) return null;
		const total = fr.reduce((s, r) => s + (parseFloat(r.qty) || 0), 0);
		return {
			total,
			items: new Set(fr.map((r) => r.item_code)).size,
			base_eq: Math.round(total * F.factor(cfg) * 1000) / 1000,
		};
	};

	// Antes de Guardar / Validar: si el documento lleva fracciones, se dice
	// cuántas y en cuántos ítems, y se pide confirmar.
	F.confirm_summary = (cfg, rows, accion, proceed, onNo) => {
		if (!F.on(cfg)) return proceed();
		const s = F.summary(cfg, rows);
		if (!s) return proceed();
		const bases = (cfg.unidades_base || []).join(" / ");
		frappe.confirm(
			`Este documento lleva <b>${s.total} ${esc(cfg.uom)}</b> (equivale a ${s.base_eq} ${esc(bases)}) ` +
			`en un total de <b>${s.items}</b> ítem(s).<br><br>¿${esc(accion)}?`,
			proceed, onNo
		);
	};

	// Hoja con los dos QR de modo para imprimir y pegar junto al lector.
	F.show_qr_sheet = (company) => {
		frappe.call({
			method: "facex_multi.api.fraccion.get_mode_qr_sheet",
			args: { company: company || null },
			callback: (r) => {
				if (r.exc || !r.message) return;
				const m = r.message;
				const card = (q, title, sub) => `
<div class="fx-frac-qr-card">${q.svg}<h3>${esc(title)}</h3><div style="font-size:12px;color:#475569;">${esc(sub)}</div></div>`;
				const html = `<div class="fx-frac-qr-sheet">
  ${card(m.fraccion, `MODO ${(m.fraccion.label || "").toUpperCase()}`, `Lee en ${m.fraccion.uom}`)}
  ${card(m.entero, "MODO ENTERO", "Lee en la unidad normal")}
</div>`;
				const d = new frappe.ui.Dialog({
					title: "QR de modo Entero / Fracción",
					size: "large",
					fields: [{ fieldtype: "HTML", fieldname: "qr" }],
					primary_action_label: "Imprimir",
					primary_action: () => {
						const w = window.open("", "_blank");
						if (!w) return;
						w.document.write(`<html><head><title>QR de modo</title><style>
body{font-family:sans-serif;padding:24px}
.fx-frac-qr-sheet{display:flex;gap:40px;justify-content:center;flex-wrap:wrap}
.fx-frac-qr-card{border:2px dashed #555;border-radius:10px;padding:16px 22px;text-align:center;width:280px}
.fx-frac-qr-card svg{width:230px;height:230px}
.fx-frac-qr-card h3{margin:8px 0 4px;font-size:22px}
</style></head><body>${html}</body></html>`);
						w.document.close();
						w.focus();
						setTimeout(() => w.print(), 300);
					},
				});
				d.fields_dict.qr.$wrapper.html(html);
				d.show();
			},
		});
	};

	F.inject_css();
})();
