// Quick Entry nativo de Item (botón «Nuevo» desde el ERP): agrega «Es inventariable»
// e «Imagen» (Property Setters en fixtures) y precarga «Es inventariable» según
// «Manejar Inventario» de la compañía. Si algo falla queda el default de ERPNext.
if (frappe.ui.form.QuickEntryForm && !frappe.ui.form.ItemQuickEntryForm) {
	frappe.ui.form.ItemQuickEntryForm = class ItemQuickEntryForm extends frappe.ui.form.QuickEntryForm {
		render_dialog() {
			const done = () => super.render_dialog();
			if (!this.doc) return done();
			frappe.call({
				method: "facex_multi.api.item.get_new_item_defaults",
				callback: (r) => {
					if (r && r.message && this.doc) this.doc.is_stock_item = r.message.is_stock_item;
					done();
				},
				error: done,
			});
		}
	};
}
