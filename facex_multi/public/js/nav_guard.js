frappe.provide("facex_multi");

/**
 * Navegación restringida (ver facex_multi/api/nav_guard.py): un usuario con
 * «Permitir navegar x ERP» desmarcado solo puede estar en las Pages de FacEx.
 *
 * El servidor (before_request) ya cubre las cargas completas de página, pero
 * dentro del Desk la navegación es SPA y no pasa por el servidor: aquí se
 * envuelve frappe.router.route para revisar la ruta ANTES de dibujarla. Si no
 * es una Page de FacEx se le pregunta al servidor a dónde ir (resolve_route):
 * un enlace a un documento (p. ej. /app/sales-invoice/X) se traduce a su
 * pantalla FacEx o a /printview; cualquier otra cosa → página de inicio.
 *
 * frappe.boot.facex_nav solo existe para usuarios restringidos: para los demás
 * esto no hace nada.
 */
(function () {
	function cfg() {
		const c = frappe.boot && frappe.boot.facex_nav;
		return c && c.restricted ? c : null;
	}

	// Para ocultar en las Pages los botones «Abrir en ERP».
	facex_multi.nav_restricted = () => !!cfg();

	const router = frappe.router;
	if (!router || router._facex_nav_guard) return;
	router._facex_nav_guard = true;

	const original_route = router.route;

	router.route = function () {
		const c = cfg();
		if (!c) return original_route.apply(this, arguments);

		const page = (this.get_sub_path() || "").split("/")[0];
		if ((c.pages || []).includes(page)) return original_route.apply(this, arguments);

		return frappe
			.xcall("facex_multi.api.nav_guard.resolve_route", { path: window.location.pathname })
			.then((r) => {
				if (!r || !r.restricted) {
					// Boot viejo: ya se le permitió navegar.
					frappe.boot.facex_nav = null;
					return original_route.apply(router);
				}
				if (!r.target) return original_route.apply(router);
				window.location.replace(r.target);
			})
			.catch(() => window.location.replace(c.home || "/desk/facex"));
	};
})();
