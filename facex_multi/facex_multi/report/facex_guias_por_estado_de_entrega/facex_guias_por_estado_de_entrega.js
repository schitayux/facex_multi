frappe.query_reports["FacEx Guias por Estado de Entrega"] = {
	filters: [
		{
			fieldname: "transportista",
			label: __("Transportista"),
			fieldtype: "Link",
			options: "FacEx Transportista",
		},
		{
			fieldname: "estado_entrega",
			label: __("Estado de Entrega"),
			fieldtype: "Select",
			options: "\nPendiente\nRecolectado\nEn tránsito\nEntregado\nAnulado",
		},
		{
			fieldname: "company",
			label: __("Compañía"),
			fieldtype: "Link",
			options: "Company",
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
