frappe.provide("facex_multi");

/**
 * Dentro de las Pages de FacEx (FacEx, FacEx Screen, FacEx Cierre, FacEx
 * Inventario — todas marcan <body class="facex-fullscreen-mode">, ver cada
 * *.js y history_guard.js) los campos Link de Frappe traen de fábrica una
 * flechita "Abrir" (ControlLink) que navega al formulario nativo de ERPNext
 * y saca al usuario de la Page. El catálogo detrás del campo (autocompletar,
 * validación, buscador) sigue funcionando igual; esto solo quita esa
 * navegación mientras estemos en modo pantalla completa de FacEx. Fuera de
 * esas Pages (Desk normal) no se toca nada.
 */
(function () {
	function in_facex_fullscreen() {
		return document.body.classList.contains("facex-fullscreen-mode");
	}

	// Oculta la flecha vía CSS — no toca el botón "Limpiar" (X) del campo.
	frappe.dom.set_style(`
		body.facex-fullscreen-mode .link-field .link-btn .btn-open {
			display: none !important;
		}
	`);

	// Refuerzo en fase de captura: por si el clic llega antes de que el CSS
	// se aplique, o algún control recrea el botón después de montado.
	document.addEventListener(
		"click",
		function (e) {
			if (!in_facex_fullscreen()) return;
			if (!e.target.closest(".link-field .link-btn .btn-open")) return;
			e.preventDefault();
			e.stopPropagation();
		},
		true
	);
})();
