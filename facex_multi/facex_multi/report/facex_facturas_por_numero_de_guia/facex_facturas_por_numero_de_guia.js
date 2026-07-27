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
	],
	formatter(value, row, column, data, default_formatter) {
		value = default_formatter(value, row, column, data);
		if (column.fieldname === "numero_guia" && data && data.sales_invoice) {
			value = `<a href="/app/sales-invoice/${encodeURIComponent(data.sales_invoice)}">${value}</a>`;
		}
		return value;
	},
};
