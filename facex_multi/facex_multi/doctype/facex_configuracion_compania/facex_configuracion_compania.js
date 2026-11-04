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

// ── Página web (ver api/pagina_web.py) ──────────────────────────────────
frappe.ui.form.on("FacEx Configuracion Compania", {
	refresh(frm) {
		if (frm.is_new() || !frm.doc.pagina_web_activa) return;
		frm.add_custom_button("Generar llave nueva", () =>
			frappe.call("facex_multi.api.pagina_web.generar_llave").then((r) => {
				frappe.msgprint({
					title: "Llave nueva",
					message: "Copie esta llave en <b>api/config.php</b> de la página y guarde la configuración. Hasta que estén iguales en los dos lados no se envía nada." +
						`<pre style="margin-top:10px;user-select:all">${frappe.utils.escape_html(r.message)}</pre>`,
				});
				frm.set_value("pagina_web_llave", r.message);
			}), "Página web");
		frm.add_custom_button("Publicar catálogo ahora", () =>
			frappe.call({
				method: "facex_multi.api.pagina_web.publicar_ahora",
				args: { company: frm.doc.company },
				freeze: true,
				freeze_message: "Enviando el catálogo a la página…",
			}).then((r) => {
				const m = r.message || {};
				frappe.msgprint({ title: m.ok ? "Catálogo enviado" : "No se pudo enviar", message: frappe.utils.escape_html(m.mensaje || ""), indicator: m.ok ? "green" : "red" });
				frm.reload_doc();
			}), "Página web");
		frm.add_custom_button("Pedidos en línea", () => frappe.set_route("facex-pedidos-web"), "Página web");
	},
});
