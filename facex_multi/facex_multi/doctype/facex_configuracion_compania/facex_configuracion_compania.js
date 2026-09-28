frappe.ui.form.on("FacEx Configuracion Compania", {
	refresh(frm) {
		facex_series_setup(frm, frm.doc.company);
	},
	company(frm) {
		facex_series_setup(frm, frm.doc.company);
	},
});

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
