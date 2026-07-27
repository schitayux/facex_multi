frappe.ui.form.on('FacEx Guia Transportista', {
	abrir_rastreo(frm, cdt, cdn) {
		const row = locals[cdt][cdn];

		if (!row.transportista || !row.numero_guia) {
			frappe.msgprint(__('Seleccione Transportista y Número de Guía antes de rastrear.'));
			return;
		}

		frappe.db.get_value('FacEx Transportista', row.transportista, 'url_tracking').then(({ message }) => {
			const pattern = message && message.url_tracking;

			if (!pattern) {
				frappe.msgprint(__('El transportista {0} no tiene una URL de rastreo configurada.', [row.transportista]));
				return;
			}

			const url = pattern.replace('{guia}', encodeURIComponent(row.numero_guia));
			window.open(url, '_blank');
		});
	}
});
