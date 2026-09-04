frappe.ui.form.on("FacEx Settings", {
	refresh(frm) {
		set_warehouse_query(frm);
		set_sales_partner_query(frm);
		set_price_list_query(frm);
	},
	bfel_company(frm) {
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
