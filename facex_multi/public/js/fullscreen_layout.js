/*
 * Ancho de las pantallas FacEx (Clásico, Screen, Inventario, Cierre, Compras,
 * Pagos): mientras el body tenga la clase facex-fullscreen-mode, el Desk de
 * Frappe v16 envuelve la página en `.container` y en la columna
 * `.layout-main-section-wrapper` (ancho de grilla, aunque no haya barra
 * lateral). Sin esto el contenido queda pegado a la izquierda y desperdicia el
 * ancho de la pantalla. Compras y Pagos ya lo corregían por su cuenta; esta
 * regla lo hace igual para todas las pantallas FacEx.
 *
 * Además, el contenido que tiene un tope de ancho (1200px) pasa a 1440px,
 * siempre centrado: los formularios no se estiran en monitores grandes pero
 * se aprovecha mejor el espacio. Las tablas y listas ocupan el ancho que
 * tengan disponible.
 */
(function () {
	if (document.getElementById("fx-fullscreen-layout")) return;
	const css = `
body.facex-fullscreen-mode .page-container .container,
body.facex-fullscreen-mode .main-section > .container,
body.facex-fullscreen-mode .container.page-body,
body.facex-fullscreen-mode .layout-main-section-wrapper {
  flex: 0 0 100% !important;
  width: 100% !important; max-width: 100% !important;
  padding-left: 0 !important; padding-right: 0 !important;
  margin-left: 0 !important; margin-right: 0 !important;
}
body.facex-fullscreen-mode #ef-dashboard-view,
body.facex-fullscreen-mode #ef-reports-view,
body.facex-fullscreen-mode #ef-maintenance-view,
body.facex-fullscreen-mode #ef-transporte-view,
body.facex-fullscreen-mode #inv-app,
body.facex-fullscreen-mode #inv-entradas-app,
body.facex-fullscreen-mode #inv-trf-app,
body.facex-fullscreen-mode #inv-trn-app,
body.facex-fullscreen-mode .cd-wrap,
body.facex-fullscreen-mode .cp-wrap {
  max-width: 1440px !important;
  margin-left: auto !important; margin-right: auto !important;
}
`;
	const style = document.createElement("style");
	style.id = "fx-fullscreen-layout";
	style.textContent = css;
	document.head.appendChild(style);
})();
