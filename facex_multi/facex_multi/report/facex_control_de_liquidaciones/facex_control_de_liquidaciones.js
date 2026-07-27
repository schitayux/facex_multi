frappe.query_reports["FacEx Control de Liquidaciones"] = {
	filters: [
		{
			fieldname: "customer",
			label: __("Cliente"),
			fieldtype: "Link",
			options: "Customer",
		},
		{
			fieldname: "transportista",
			label: __("Transportista"),
			fieldtype: "Link",
			options: "FacEx Transportista",
		},
		{
			fieldname: "estado_liquidacion",
			label: __("Estado"),
			fieldtype: "Select",
			options: "\nPendiente\nLiquidado",
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
