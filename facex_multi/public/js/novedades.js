// Aviso de novedades FacEx 2.5: una vez por inicio de sesión (lo decide api/novedades.py).
(function () {
	if (!window.frappe || !frappe.boot || !frappe.boot.facex_novedades) return;
	const APP_URL = location.origin + "/app/facex";
	const li = (arr) => "<ul style='margin:4px 0 12px;padding-left:20px'>" + arr.map((t) => `<li>${t}</li>`).join("") + "</ul>";
	const h = (t) => `<div style='font-weight:700;color:#153375;margin-top:6px'>${t}</div>`;
	const html = `
	<div style="font-size:13px;line-height:1.5;max-height:65vh;overflow:auto">
		<div style="background:#fff7e0;border-left:4px solid #f5a623;padding:10px 12px;margin-bottom:12px;border-radius:4px">
			<b>Importante:</b> todo el sistema sigue funcionando igual que siempre. Lo único que cambió es que
			ahora se trabaja con <b>entero y unidad de medida «Media Docena»</b>.<br>
			Ya <b>no se usa 0.5</b>: la mitad de una docena ahora se registra como <b>1 MEDIA DOCENA</b>.
			Si escribes 0.5 el sistema lo convierte solo; si escribes 2.5 te avisará que quedarán 2 Docena y una fila nueva de 1 MEDIA DOCENA.
		</div>
		${h("Nuevas funcionalidades")}
		${li([
			"<b>Entero / Media Docena</b> en Facturación, Factura Screen e Inventario (entradas, salidas y traslados). Se puede elegir la unidad en cada fila.",
			"<b>Ver unidad de medida</b>: columna UdM en pantallas e impresiones.",
			"<b>Enviar por WhatsApp</b> facturas, cotizaciones y pagos (PDF por enlace, vigente 7 días), según los permisos de tu perfil.",
			"<b>App móvil instalable</b> con <b>lector de códigos por cámara</b> en Facturación, POS, Inventario y Recepción de traslados.",
			"<b>Recepción de traslados</b>: botón «Auto rellenar» (si tu perfil lo tiene) y comentario del traslado visible.",
			"<b>Líneas nuevas al inicio</b> de la lista en Facturación, POS e Inventario.",
		])}
		${h("Mejoras")}
		${li([
			"Modo celular: ticket deslizante en POS, líneas como tarjetas en Facturación, Inventario y Recepción; barras superiores sin cortar el menú de usuario.",
			"Recibo / factura <b>FAC CERTIFI - NEKO</b> con diseño compacto en una sola página.",
			"Reportes, cierre diario, candado de stock, inventario y traslados calculan en unidad base, de modo que la Media Docena suma correctamente.",
		])}
		${h("Bugs corregidos")}
		${li([
			"Al «Compartir PDF» se cerraba la sesión del usuario.",
			"Aviso falso de «Guarde los cambios» en facturas ya validadas.",
			"Avisos de permiso que aparecían al abrir Facturación.",
		])}
		${h("App móvil")}
		<div style="margin:4px 0 10px">Abre este enlace en tu celular e instálala: <a href="${APP_URL}" target="_blank"><b>${APP_URL}</b></a></div>
		<div style="border-top:1px solid #ddd;padding-top:10px">
			Esta es la <b>versión 2.5 de FacEx</b>. Gracias por reportar cualquier novedad o inquietud que se presente derivada de estos cambios.
		</div>
	</div>`;
	const open = () => {
		const d = new frappe.ui.Dialog({
			title: "FacEx 2.5 — Novedades (cambios del 05 al 06 de octubre)",
			size: "large",
			primary_action_label: "Entendido",
			primary_action() { d.hide(); },
		});
		d.$body.html(html);
		d.show();
	};
	$(document).ready(() => setTimeout(open, 1200));
})();
