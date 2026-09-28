frappe.provide("facex_multi.etiqueta_etiba");

/**
 * Diálogo compartido "e-Imprimir" de etiquetas eTIBA para un producto, con la
 * vista previa de la etiqueta en pantalla. Lo usan el Mantenimiento de
 * Productos de FacEx Clásico y el Maestro de Ítems de FacEx Inventario.
 *
 * La vista previa la dibuja eTIBA (etiba.api.vista_previa) a partir del mismo
 * ZPL/TSPL que se manda a la impresora, así que refleja el formato configurado
 * (tamaño ^PW/^LL o SIZE, textos, QR, códigos de barras, cajas).
 *
 *   facex_multi.etiqueta_etiba.disponible()  → ¿eTIBA instalada en el sitio?
 *   facex_multi.etiqueta_etiba.abrir({ item_code, company, vista_previa })
 *     vista_previa: true abre el diálogo grande centrado en la previsualización.
 */
(function () {
	const ns = facex_multi.etiqueta_etiba;

	ns.disponible = function () {
		return !!(frappe.boot && frappe.boot.versions && frappe.boot.versions.etiba);
	};

	ns.abrir = function (opts) {
		const item_code = opts && opts.item_code;
		const company = (opts && opts.company) || "";
		const vista_previa = !!(opts && opts.vista_previa);
		if (!item_code) {
			frappe.show_alert({ message: "Guarde el producto antes de imprimir la etiqueta.", indicator: "orange" });
			return;
		}
		frappe.call({
			method: "facex_multi.api.item.get_label_print_config",
			args: { item_code, company },
			freeze: true,
			callback: (r) => {
				const cfg = r.message || {};
				const formatos = cfg.formatos || [];
				if (!formatos.length) {
					frappe.msgprint("No hay formatos de etiqueta activos configurados en eTIBA.");
					return;
				}
				mostrar_dialogo({ item_code, company, vista_previa, cfg, formatos });
			},
		});
	};

	function formato_requiere_serie(formatos, nombre) {
		const f = formatos.find((x) => x.name === nombre);
		return !!(f && f.identificador_tipo === "Serie");
	}

	function mostrar_dialogo({ item_code, company, vista_previa, cfg, formatos }) {
		const formato_inicial = cfg.formato_sugerido || formatos[0].name;
		let timer = null;
		let peticion = 0;

		const refrescar = () => {
			clearTimeout(timer);
			timer = setTimeout(() => cargar_vista_previa(), 250);
		};

		const d = new frappe.ui.Dialog({
			title: `${vista_previa ? "Vista previa de etiqueta" : "Imprimir Etiqueta"} — ${item_code}`,
			size: vista_previa ? "large" : "",
			fields: [
				{
					label: "Formato", fieldname: "formato", fieldtype: "Select",
					options: formatos.map((f) => f.name), default: formato_inicial, reqd: 1,
					change: () => {
						const req = formato_requiere_serie(formatos, d.get_value("formato"));
						d.set_df_property("serie", "hidden", req ? 0 : 1);
						d.set_df_property("serie", "reqd", req ? 1 : 0);
						refrescar();
					},
				},
				{ fieldtype: "Column Break" },
				{
					label: "Cantidad", fieldname: "cantidad", fieldtype: "Int",
					default: cfg.cantidad_por_defecto || 1, reqd: 1,
					change: () => actualizar_pie(),
				},
				{ fieldtype: "Column Break" },
				{
					label: "Serie", fieldname: "serie", fieldtype: "Link", options: "Serial No",
					hidden: formato_requiere_serie(formatos, formato_inicial) ? 0 : 1,
					reqd: formato_requiere_serie(formatos, formato_inicial) ? 1 : 0,
					get_query: () => ({ filters: { item_code, status: "Active" } }),
					change: () => refrescar(),
				},
				{ fieldtype: "Section Break", label: "Vista previa" },
				{ fieldtype: "HTML", fieldname: "vista_previa_html" },
			],
			primary_action_label: "Imprimir",
			primary_action: (values) => {
				d.hide();
				enviar_a_imprimir({ item_code, company, values, print_service_url: cfg.print_service_url });
			},
		});

		let ultimo = null;
		const $wrap = d.fields_dict.vista_previa_html.$wrapper;

		function actualizar_pie() {
			if (!ultimo) return;
			const cant = Math.max(1, cint(d.get_value("cantidad")) || 1);
			$wrap.find(".fx-etq-copias").text(`${cant} ${cant === 1 ? "copia" : "copias"}`);
		}

		function cargar_vista_previa() {
			const formato = d.get_value("formato");
			if (!formato) return;
			const serie = d.get_value("serie") || "";
			const n = ++peticion;
			$wrap.find(".fx-etq-lienzo").css("opacity", 0.45);
			if (!$wrap.find(".fx-etq-lienzo").length) {
				$wrap.html(`<div style="padding:24px; text-align:center; color:#94a3b8;">Generando vista previa…</div>`);
			}
			frappe.call({
				method: "facex_multi.api.item.previsualizar_etiqueta_item",
				args: { item_code, formato, serie, company },
				callback: (r) => {
					if (n !== peticion) return; // llegó una respuesta más nueva
					ultimo = r.message;
					if (!ultimo || !ultimo.svg) {
						$wrap.html(`<div style="padding:24px; text-align:center; color:#94a3b8;">Sin vista previa.</div>`);
						return;
					}
					$wrap.html(html_vista_previa(ultimo, vista_previa, formato_requiere_serie(formatos, formato) && !serie));
					actualizar_pie();
				},
				error: () => {
					if (n !== peticion) return;
					$wrap.html(`<div style="padding:24px; text-align:center; color:#e03e2d;">No se pudo generar la vista previa.</div>`);
				},
			});
		}

		d.show();
		cargar_vista_previa();
	}

	function html_vista_previa(r, grande, sin_serie) {
		// Escala en pantalla: px por mm reales de la etiqueta.
		const px_mm = grande ? 8 : 5.5;
		const ancho_px = Math.round((r.ancho_mm || 50) * px_mm);
		const esc = frappe.utils.escape_html;
		const avisos = (r.advertencias || []).slice();
		if (sin_serie) avisos.unshift("Este formato imprime el número de serie: seleccione una serie para verla en la etiqueta (por ahora se muestra el código del producto).");
		return `
<div class="fx-etq-vista" style="background:#eef1f5; border-radius:8px; padding:${grande ? 28 : 18}px 12px; text-align:center;">
	<div class="fx-etq-lienzo" style="display:inline-block; width:${ancho_px}px; max-width:100%; background:#fff; border-radius:6px;
		box-shadow:0 1px 3px rgba(15,23,42,.18), 0 6px 18px rgba(15,23,42,.10); line-height:0; overflow:hidden;">
		${r.svg.replace("<svg ", '<svg style="width:100%; height:auto; display:block;" ')}
	</div>
	<div style="margin-top:10px; font-size:12px; color:#64748b; line-height:1.5;">
		${esc(String(r.ancho_mm))} × ${esc(String(r.alto_mm))} mm · ${esc(r.lenguaje || "")} · ${esc(String(r.dpi || 203))} dpi ·
		<span class="fx-etq-copias"></span>
	</div>
	${avisos.length ? `<div style="margin-top:8px; font-size:12px; color:#b45309; line-height:1.5;">${avisos.map((a) => esc(a)).join("<br>")}</div>` : ""}
	<div style="margin-top:6px; font-size:11px; color:#94a3b8;">Vista aproximada: la impresora puede variar ligeramente en fuentes y márgenes.</div>
</div>`;
	}

	function enviar_a_imprimir({ item_code, company, values, print_service_url }) {
		frappe.call({
			method: "facex_multi.api.item.imprimir_etiqueta_item",
			args: {
				item_code, formato: values.formato, cantidad: values.cantidad, serie: values.serie || "",
				company,
			},
			freeze: true,
			callback: (r) => {
				const zplcode = r.message;
				if (!zplcode) return;
				fetch(print_service_url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ zplcode }),
				})
					.then((response) => {
						if (response.ok) {
							frappe.show_alert({ message: __("Etiqueta enviada a imprimir."), indicator: "green" });
						} else {
							frappe.msgprint("El servicio de impresión de etiquetas respondió con un error.");
						}
					})
					.catch(() => {
						frappe.msgprint("No se pudo conectar con el servicio de impresión de etiquetas (¿está corriendo en este equipo?).");
					});
			},
		});
	}
})();
