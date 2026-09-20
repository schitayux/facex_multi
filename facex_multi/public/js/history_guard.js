frappe.provide("facex_multi");

/**
 * Evita que el botón "Atrás" del navegador saque al usuario de una Page de
 * FacEx (FacEx, FacEx Screen, FacEx Inventario) hacia lo que hubiera antes en
 * el historial del navegador — a veces un sitio ajeno a ERPNext. En su lugar
 * redirige a `to`, pidiendo confirmación primero si `is_dirty()` devuelve
 * true (hay una factura, producto o movimiento sin guardar).
 *
 * Se apoya en el History API: al llamarse inserta un estado "guardia" en el
 * historial, de modo que el primer "Atrás" físico del usuario dispare un
 * evento popstate dentro de la app en vez de abandonarla.
 *
 * IMPORTANTE — hay que volver a llamarla en cada re-entrada a la página, no
 * solo una vez en on_page_load:
 *   1. Frappe Desk es un SPA: frappe.pages[name] se cachea, así que
 *      on_page_load de una Page solo se dispara UNA VEZ por sesión de
 *      pestaña. Las visitas siguientes (venga el usuario de donde venga)
 *      solo disparan on_page_show — si el guard no se rearma ahí, deja de
 *      funcionar después de la primera vez.
 *   2. El botón Atrás/Adelante del navegador puede restaurar la página desde
 *      el back-forward cache (bfcache) sin volver a ejecutar ningún script;
 *      por eso esta función también escucha "pageshow" con persisted=true
 *      para reinsertar el estado guardia en ese caso.
 * Por eso cada Page debe invocarla tanto en on_page_load como en
 * on_page_show (una vez que el controlador ya existe). Volver a llamarla es
 * seguro: reemplaza el listener anterior en vez de acumularlo.
 *
 * `on_back` (opcional) permite que la página resuelva el Atrás por dentro —
 * volver a la vista anterior del mismo page en vez de abandonarlo. Si
 * devuelve true el guard se reinserta y no se sale; si devuelve false (o no
 * se pasa) aplica el comportamiento de siempre: confirmar si hay cambios sin
 * guardar y salir a `to`.
 */
facex_multi.setup_back_guard = function ({ to = "/app", is_dirty = () => false, on_back = null } = {}) {
	const push_guard_state = () => history.pushState({ facex_back_guard: true }, "", window.location.href);
	push_guard_state();

	$(window)
		.off("popstate.facexBackGuard")
		.on("popstate.facexBackGuard", () => {
			// La navegación interna tiene prioridad: solo se considera salir
			// de la página cuando ya no hay a dónde volver por dentro.
			if (on_back && on_back()) {
				push_guard_state();
				return;
			}
			if (is_dirty()) {
				frappe.confirm(
					__("Hay cambios sin guardar. ¿Desea salir de todos modos?"),
					() => {
						window.location.href = to;
					},
					() => {
						// El usuario decidió quedarse: reinsertar el estado guardia.
						push_guard_state();
					}
				);
			} else {
				window.location.href = to;
			}
		});

	$(window)
		.off("pageshow.facexBackGuard")
		.on("pageshow.facexBackGuard", (e) => {
			if (e.originalEvent && e.originalEvent.persisted) push_guard_state();
		});
};
