frappe.query_reports["FacEx Facturas por Numero de Guia"] = {
	filters: [
		{
			fieldname: "numero_guia",
			label: __("Número de Guía"),
			fieldtype: "Data",
			reqd: 1,
		},
		{
			fieldname: "transportista",
			label: __("Transportista"),
			fieldtype: "Link",
			options: "FacEx Transportista",
		},
		{
			fieldname: "owners",
			label: __("Usuario Creador"),
			fieldtype: "MultiSelectList",
			get_data: function (txt) {
				return facex_multi_user_query_for_reports(txt);
			},
		},
	],
	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (column.fieldname === "numero_guia" && data && data.sales_invoice) {
			value = `<a href="/app/sales-invoice/${encodeURIComponent(data.sales_invoice)}">${value}</a>`;
		}
		return value;
	},
};

// Excluye System Manager (ya tienen acceso total, no aportan como filtro) —
// compartido con los demás reportes de FacEx (Multi/Inventario/Transporte).
function facex_multi_user_query_for_reports(txt) {
	return new Promise((resolve) => {
		frappe.call({
			method: "facex_multi.api.reports.user_query_for_reports",
			args: { txt: txt || "" },
			callback: (r) => {
				const rows = r.message || [];
				resolve(rows.map((row) => ({ value: row[0], description: row[1] || row[0] })));
			},
		});
	});
}
