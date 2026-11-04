frappe.ui.form.on("FacEx Settings", {
	refresh(frm) {
		set_warehouse_query(frm);
		set_sales_partner_query(frm);
		set_price_list_query(frm);
		facex_series_setup(frm, frm.doc.bfel_company);
	},
	bfel_company(frm) {
		facex_series_setup(frm, frm.doc.bfel_company);
		frm.set_value("bodega_por_defecto", "");
		frm.set_value("socio_venta_por_defecto", "");
		frm.set_value("lista_precios_por_defecto", "");
		(frm.doc.bodegas_habilitadas || []).forEach((row) => {
			frappe.model.set_value(row.doctype, row.name, "warehouse", "");
		});
		(frm.doc.listas_precios_habilitadas || []).forEach((row) => {
			frappe.model.set_value(row.doctype, row.name, "price_list", "");
		});
		refresh_field("bodegas_habilitadas");
		refresh_field("listas_precios_habilitadas");
	},
});

frappe.ui.form.on("FacEx Settings Bodega", {
	bodegas_habilitadas_add(frm) {
		set_warehouse_query(frm);
	},
});

frappe.ui.form.on("FacEx Settings Lista Precios", {
	listas_precios_habilitadas_add(frm) {
		set_price_list_query(frm);
	},
});

function set_warehouse_query(frm) {
	const get_query = () => ({ filters: { company: frm.doc.bfel_company } });
	frm.set_query("bodega_por_defecto", get_query);
	frm.set_query("warehouse", "bodegas_habilitadas", get_query);
}

function set_sales_partner_query(frm) {
	frm.set_query("socio_venta_por_defecto", () => ({
		or_filters: [
			["bfel_company", "=", frm.doc.bfel_company],
			["bfel_company_null", "=", 0],
		],
	}));
}

function set_price_list_query(frm) {
	const get_query = () => ({
		filters: { selling: 1 },
		or_filters: [
			["bfel_company", "=", frm.doc.bfel_company],
			["bfel_company_null", "=", 0],
		],
	});
	frm.set_query("lista_precios_por_defecto", get_query);
	frm.set_query("price_list", "listas_precios_habilitadas", get_query);
}

// ── Series de Documentos (grid FacEx Serie Documento) ───────────────────
// Las opciones del Autocomplete «Serie» dependen del tipo de la fila; el
// servidor (api/series.py.validate_series_table) valida igual al guardar.
function facex_series_setup(frm, company) {
	if (!company) return;
	frappe.call({
		method: "facex_multi.api.series.get_series_options",
		args: { company },
		callback: (r) => {
			frm._facex_series_options = r.message || {};
			const all = [...new Set(Object.values(frm._facex_series_options).flat())];
			frm.fields_dict.series_documentos.grid.update_docfield_property("naming_series", "options", all);
		},
	});
}

function facex_series_row_options(frm, cdn) {
	const row = locals["FacEx Serie Documento"][cdn];
	const opts = (frm._facex_series_options || {})[row && row.tipo_documento] || [];
	frm.fields_dict.series_documentos.grid.update_docfield_property("naming_series", "options", opts);
}

frappe.ui.form.on("FacEx Serie Documento", {
	tipo_documento(frm, cdt, cdn) {
		facex_series_row_options(frm, cdn);
		const row = locals[cdt][cdn];
		const opts = (frm._facex_series_options || {})[row.tipo_documento] || [];
		if (row.naming_series && !opts.includes(row.naming_series)) {
			frappe.model.set_value(cdt, cdn, "naming_series", "");
		}
	},
	form_render(frm, cdt, cdn) {
		facex_series_row_options(frm, cdn);
	},
	por_defecto(frm, cdt, cdn) {
		// Solo una por defecto por tipo + establecimiento: desmarca las demás.
		const row = locals[cdt][cdn];
		if (!row.por_defecto) return;
		(frm.doc.series_documentos || []).forEach((r) => {
			if (r.name !== row.name && r.por_defecto
				&& r.tipo_documento === row.tipo_documento
				&& (r.establecimiento || "") === (row.establecimiento || "")) {
				frappe.model.set_value(cdt, r.name, "por_defecto", 0);
			}
		});
	},
});

// ── Página web: la sección solo se muestra si la compañía tiene página ──────
frappe.ui.form.on("FacEx Settings", {
	refresh(frm) { facex_settings_pagina_web(frm); },
	bfel_company(frm) { facex_settings_pagina_web(frm); },
});

function facex_settings_pagina_web(frm) {
	const mostrar = (v) => ["sb_pagina_web", "pagina_web_acceso", "cb_pagina_web", "pagina_web_gestionar"].forEach((f) => frm.toggle_display(f, v));
	if (!frm.doc.bfel_company || !frm.fields_dict.pagina_web_acceso) return mostrar(false);
	frappe.call({ method: "facex_multi.api.pagina_web.compania_tiene_pagina", args: { company: frm.doc.bfel_company } }).then((r) => mostrar(!!r.message));
}
