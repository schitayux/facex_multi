frappe.query_reports["FacEx Auditoria de Sistema"] = {
	filters: [
		{
			fieldname: "from_date",
			label: __("Desde"),
			fieldtype: "Date",
			default: frappe.datetime.month_start(),
			reqd: 1,
		},
		{
			fieldname: "to_date",
			label: __("Hasta"),
			fieldtype: "Date",
			default: frappe.datetime.get_today(),
			reqd: 1,
		},
		{
			fieldname: "company",
			label: __("Compañía"),
			fieldtype: "Link",
			options: "Company",
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
