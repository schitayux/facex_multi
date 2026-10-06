// Enviar por WhatsApp (2026-10-06) — compartido por Facturador Clásico y Factura Screen.
//
// Las tres capas de permiso se resuelven en el servidor: `defaults.wa` solo trae
// los tipos que ESTE usuario puede enviar ({factura, cotizacion, pago}); si el
// tipo no está, la pantalla no dibuja el botón. Ver facex_multi/api/whatsapp.py.
//
// El mensaje abre WhatsApp (wa.me) con el texto listo. WhatsApp no deja adjuntar
// un archivo por enlace, así que el PDF del formato de impresión va como enlace
// temporal (7 días); en celular el diálogo ofrece también el menú de compartir
// del teléfono con el PDF real.

frappe.provide("facex_multi.wa");

(function () {
	const W = facex_multi.wa;
	const esc = (s) => frappe.utils.escape_html(s == null ? "" : String(s));

	W.ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.76-.87-2.03-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.16-.17.2-.35.22-.64.07-.3-.15-1.26-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.6.13-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.61-.92-2.2-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.21 3.07.15.2 2.1 3.2 5.08 4.49.71.3 1.26.49 1.69.63.71.23 1.36.2 1.87.12.57-.09 1.76-.72 2-1.41.25-.7.25-1.29.17-1.41-.07-.12-.27-.2-.57-.35M12.05 21.78h-.01a9.87 9.87 0 0 1-5.03-1.38l-.36-.21-3.74.98 1-3.65-.24-.37a9.86 9.86 0 0 1-1.51-5.26c0-5.45 4.44-9.88 9.89-9.88 2.64 0 5.12 1.03 6.99 2.9a9.83 9.83 0 0 1 2.89 6.99c0 5.45-4.44 9.88-9.88 9.88M20.46 3.49A11.82 11.82 0 0 0 12.05 0C5.5 0 .16 5.34.16 11.89c0 2.1.55 4.14 1.59 5.95L.06 24l6.3-1.65a11.88 11.88 0 0 0 5.68 1.45h.01c6.55 0 11.89-5.34 11.89-11.89 0-3.18-1.24-6.17-3.48-8.42"/></svg>`;

	// ¿Este usuario puede enviar `tipo`? (wa = defaults.wa)
	W.can = (wa, tipo) => !!(wa && wa[tipo]);

	// 8 dígitos → Guatemala (502); se quitan espacios, guiones y signos.
	W.digits = (raw) => {
		let d = String(raw || "").replace(/\D/g, "");
		if (d.length === 8) d = `502${d}`;
		return d;
	};

	// Abre el diálogo para `invoice` (Sales Invoice) del tipo factura | cotizacion | pago.
	W.open = (invoice, tipo) => {
		frappe.call({
			method: "facex_multi.api.whatsapp.get_context",
			args: { invoice, tipo },
			freeze: true,
			freeze_message: "Preparando mensaje…",
			callback: (r) => {
				if (r.exc || !r.message) return;
				W._dialog(r.message);
			},
		});
	};

	W._dialog = (ctx) => {
		const fields = [
			{ fieldtype: "Data", fieldname: "phone", label: "Teléfono de contacto", default: ctx.phone || "", reqd: 1,
				description: "Si no tiene código de país se usa Guatemala (502)." },
			{ fieldtype: "Small Text", fieldname: "message", label: "Mensaje", default: ctx.message, reqd: 1 },
		];
		if (ctx.attach) {
			fields.push({
				fieldtype: "Check", fieldname: "attach", label: `Adjuntar ${ctx.tipo_doc} (PDF, enlace válido ${ctx.dias} días)`, default: 1,
			});
		}
		if (ctx.sat_url) {
			fields.push({ fieldtype: "Check", fieldname: "sat", label: "Incluir enlace de verificación SAT", default: 1 });
		}
		const dlg = new frappe.ui.Dialog({
			title: `Enviar ${ctx.tipo_doc} ${ctx.invoice} por WhatsApp`,
			fields,
			primary_action_label: "Abrir WhatsApp",
			primary_action: (v) => W._send(dlg, ctx, v, false),
		});
		// Celular / PWA: menú de compartir con el PDF real (no necesita el teléfono).
		if (ctx.attach && navigator.canShare && navigator.share) {
			dlg.add_custom_action("Compartir PDF", () => W._send(dlg, ctx, dlg.get_values(true) || {}, true), "btn-default");
		}
		dlg.show();
	};

	W._text = (ctx, v, link) => {
		let text = (v.message || "").trim();
		if (v.sat && ctx.sat_url) text += `\n\nVerificar en SAT: ${ctx.sat_url}`;
		if (link) text += `\n\nDocumento PDF (válido ${ctx.dias} días): ${link}`;
		return text;
	};

	W._send = (dlg, ctx, v, as_file) => {
		const digits = W.digits(v.phone);
		if (!as_file && !digits) {
			frappe.msgprint("Ingrese un número de celular válido.");
			return;
		}
		if (!v.message || !String(v.message).trim()) {
			frappe.msgprint("Escriba el mensaje.");
			return;
		}
		// La pestaña de WhatsApp se abre en el clic (antes de las llamadas al
		// servidor) para que el navegador no la bloquee como ventana emergente.
		const pop = as_file ? null : window.open("", "_blank");
		const go = (link) => {
			if (as_file) {
				fetch(link).then((r) => r.blob()).then((blob) => {
					const file = new File([blob], `${ctx.invoice}.pdf`, { type: "application/pdf" });
					if (navigator.canShare({ files: [file] })) {
						return navigator.share({ files: [file], text: W._text(ctx, v, "") });
					}
					frappe.msgprint("Este dispositivo no puede compartir el archivo; use «Abrir WhatsApp».");
				}).catch(() => {});
				dlg.hide();
				return;
			}
			const url = `https://wa.me/${digits}?text=${encodeURIComponent(W._text(ctx, v, link))}`;
			if (pop) pop.location = url; else window.open(url, "_blank");
			dlg.hide();
		};
		if (ctx.attach && (v.attach || as_file)) {
			frappe.call({
				method: "facex_multi.api.whatsapp.create_link",
				args: { invoice: ctx.invoice, tipo: ctx.tipo },
				freeze: true,
				freeze_message: "Generando enlace del PDF…",
				callback: (r) => {
					if (r.exc || !r.message) { if (pop) pop.close(); return; }
					go(r.message.url);
				},
				error: () => { if (pop) pop.close(); },
			});
		} else {
			go("");
		}
	};

	// Botón estándar para barras con clase `cls`.
	W.button_html = (id, cls, label) =>
		`<button id="${id}" class="${cls}" title="Enviar por WhatsApp" style="display:none">${W.ICON}<span class="ef-btn-label">${esc(label || "WhatsApp")}</span></button>`;
})();
