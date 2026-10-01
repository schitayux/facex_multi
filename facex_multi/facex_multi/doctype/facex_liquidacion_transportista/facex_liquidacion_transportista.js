// Cierre contable de la pasarela del recargo. El asiento se genera a pedido y
// en BORRADOR: son asientos reales, los revisa y los somete Contabilidad.
// Ver facex_multi/api/liquidacion_asiento.py para el detalle del asiento.
frappe.ui.form.on("FacEx Liquidacion Transportista", {
	refresh(frm) {
		if (frm.is_new()) return;

		if (frm.doc.journal_entry) {
			frm.add_custom_button(__("Ver asiento"), () => {
				frappe.set_route("Form", "Journal Entry", frm.doc.journal_entry);
			}, __("Contabilidad"));
			return;
		}

		frm.add_custom_button(__("Generar asiento"), () => {
			frappe.call({
				method: "facex_multi.api.liquidacion_asiento.preview_asiento",
				args: { name: frm.doc.name },
				freeze: true,
				callback: (r) => {
					if (r.exc || !r.message) return;
					const p = r.message;
					const money = (v) => format_currency(v || 0, "GTQ");
					const dif = flt(p.diferencia);
					// Se muestra el asiento ANTES de crearlo: el usuario ve exactamente
					// qué cuentas se mueven y por cuánto.
					const filas = [
						[p.cuenta_recargo, money(p.recargo), ""],
						...(dif < -0.005 ? [[p.cuenta_perdida, money(-dif), ""]] : []),
						[p.cuenta_banco, "", money(p.comision)],
						...(dif > 0.005 ? [[p.cuenta_ganancia, "", money(dif)]] : []),
					];
					const html = `
						<p>${__("Guías conciliadas")}: <b>${p.guias}</b><br>
						${__("Recargo cobrado al cliente")}: <b>${money(p.recargo)}</b><br>
						${__("Comisión real del transportista")}: <b>${money(p.comision)}</b><br>
						${__("Diferencia")}: <b style="color:${dif < 0 ? "#b91c1c" : "#15803d"}">${money(dif)}</b>
						${dif < 0 ? ` (${__("pérdida")})` : dif > 0 ? ` (${__("ganancia")})` : ""}</p>
						<table class="table table-bordered" style="font-size:12px;">
							<thead><tr><th>${__("Cuenta")}</th><th class="text-right">${__("Debe")}</th><th class="text-right">${__("Haber")}</th></tr></thead>
							<tbody>${filas.map((f) => `<tr><td>${frappe.utils.escape_html(f[0] || "")}</td><td class="text-right">${f[1]}</td><td class="text-right">${f[2]}</td></tr>`).join("")}</tbody>
						</table>
						<p class="text-muted">${__("El asiento se crea en BORRADOR. Revíselo y sométalo desde Contabilidad.")}</p>`;
					frappe.confirm(html, () => {
						frappe.call({
							method: "facex_multi.api.liquidacion_asiento.generar_asiento",
							args: { name: frm.doc.name },
							freeze: true,
							callback: (r2) => {
								if (r2.exc || !r2.message) return;
								frappe.show_alert({
									message: __("Asiento {0} creado en borrador", [r2.message.journal_entry]),
									indicator: "green",
								});
								frm.reload_doc();
							},
						});
					});
				},
			});
		}, __("Contabilidad"));
	},
});
