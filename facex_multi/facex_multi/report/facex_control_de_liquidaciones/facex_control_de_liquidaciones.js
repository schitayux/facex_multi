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
		{
			// Cierre de la pasarela: aisla las guías donde lo que el cliente pagó
			// por el envío no coincidió con la comisión real del transportista.
			fieldname: "resultado_comision",
			label: __("Resultado Comisión"),
			fieldtype: "Select",
			options: "\nGanancia\nPérdida\nExacto\nSin match",
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
		// Una pérdida (la comisión real superó lo que cobró el cliente) debe
		// saltar a la vista: es la señal de que el recargo por pieza o el flete
		// de la lista quedaron por debajo del costo real del envío.
		if (data && data.resultado_comision === "Pérdida"
			&& ["diferencia_comision", "resultado_comision"].includes(column.fieldname)) {
			value = `<span style="color:#b91c1c;font-weight:600;">${value}</span>`;
		} else if (data && data.resultado_comision === "Ganancia" && column.fieldname === "diferencia_comision") {
			value = `<span style="color:#15803d;">${value}</span>`;
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
