/**
 * EF Guide — motor ligero de tours guiados (spotlight + nube) y de ayudas
 * contextuales (ícono ⓘ con tooltip) compartido por FacEx clásico
 * (facex.js) y FacEx Screen (facex_screen.js). Sin dependencias externas,
 * mismo patrón de "módulo compartido cargado por frappe.require" que
 * facex_transporte_module.js.
 *
 * No decide NADA de negocio: solo dibuja UI encima de selectores que cada
 * página ya conoce. Toda la lógica fiscal/contable sigue intacta.
 */
window.EFGuide = (function () {
	let stylesInjected = false;
	let activeTour = null;

	function _esc(s) {
		if (s === undefined || s === null) return "";
		return String(s)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function injectStyles() {
		if (stylesInjected) return;
		stylesInjected = true;
		$(`<style id="ef-guide-styles">
			.efg-spotlight {
				position: fixed; z-index: 100000; border-radius: 10px;
				border: 2px solid #4361ee;
				box-shadow: 0 0 0 9999px rgba(15,23,42,.45), 0 4px 18px rgba(67,97,238,.35);
				pointer-events: none;
				transition: top .25s ease, left .25s ease, width .25s ease, height .25s ease;
			}
			.efg-cloud {
				position: fixed; z-index: 100001; max-width: 320px; visibility: hidden;
				background: #ffffff; color: #1e293b; border-radius: 12px;
				border: 1px solid #e2e8f0; box-shadow: 0 12px 28px rgba(15,23,42,.18);
				padding: 14px 16px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
				transition: top .2s ease, left .2s ease;
			}
			.efg-cloud-step { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: #4361ee; margin-bottom: 4px; }
			.efg-cloud-title { font-size: 14px; font-weight: 700; margin-bottom: 4px; color: #0f172a; }
			.efg-cloud-text { font-size: 13px; line-height: 1.45; color: #334155; }
			.efg-cloud-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; gap: 8px; }
			.efg-cloud-nav { display: flex; gap: 6px; }
			.efg-btn {
				border: 1px solid #e2e8f0; background: #f8fafc; color: #1e293b;
				font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 8px; cursor: pointer;
			}
			.efg-btn-next { background: #4361ee; border-color: #4361ee; color: #fff; }
			.efg-btn-skip { background: transparent; border: none; color: #94a3b8; padding: 6px 4px; }
			.efg-btn:hover { filter: brightness(.97); }

			/* Ícono de ayuda contextual, siempre visible pero tenue */
			.efg-hint-badge {
				display: inline-flex; align-items: center; justify-content: center;
				width: 15px; height: 15px; margin-left: 5px; border-radius: 50%;
				font-size: 11px; line-height: 1; color: #94a3b8; background: rgba(148,163,184,.15);
				cursor: help; opacity: .6; vertical-align: middle;
				animation: efg-pulse 3.2s ease-in-out infinite;
			}
			.efg-hint-badge:hover, .efg-hint-badge:focus {
				opacity: 1; color: #4361ee; background: rgba(67,97,238,.14); outline: none;
			}
			@keyframes efg-pulse {
				0%, 100% { box-shadow: 0 0 0 0 rgba(67,97,238,0); }
				50% { box-shadow: 0 0 0 4px rgba(67,97,238,.10); }
			}
			.efg-hint-tip {
				position: fixed; z-index: 100002; max-width: 260px;
				background: #0f172a; color: #f1f5f9; border-radius: 8px;
				padding: 8px 12px; font-size: 12px; line-height: 1.4;
				box-shadow: 0 8px 20px rgba(0,0,0,.25);
			}
		</style>`).appendTo("head");
	}

	// -------------------------------------------------------------------
	// Tour guiado paso a paso (spotlight + nube con Siguiente/Atrás/Salir)
	// -------------------------------------------------------------------
	function startTour(steps) {
		injectStyles();
		endTour();
		const list = (steps || []).filter(Boolean);
		if (!list.length) return;
		activeTour = { steps: list, idx: 0 };
		activeTour.$spot = $('<div class="efg-spotlight"></div>').appendTo("body");
		activeTour.$cloud = $('<div class="efg-cloud"></div>').appendTo("body");
		$(window).on("resize.efguide scroll.efguide", () => _position());
		$(document).on("keydown.efguide", (e) => {
			if (e.key === "Escape") endTour();
			else if (e.key === "ArrowRight") _next();
			else if (e.key === "ArrowLeft") _prev();
		});
		_showStep(0);
	}

	function endTour() {
		if (!activeTour) return;
		$(window).off("resize.efguide scroll.efguide");
		$(document).off("keydown.efguide");
		activeTour.$spot && activeTour.$spot.remove();
		activeTour.$cloud && activeTour.$cloud.remove();
		activeTour = null;
	}

	function _showStep(idx) {
		if (!activeTour) return;
		const steps = activeTour.steps;
		if (idx < 0) idx = 0;
		if (idx >= steps.length) { endTour(); return; }
		activeTour.idx = idx;
		const step = steps[idx];

		const proceed = () => {
			setTimeout(() => {
				if (!activeTour) return;
				const $target = $(step.selector).first();
				if (!$target.length || $target.is(":hidden")) {
					// Paso no aplicable en el estado actual (campo oculto/no
					// cargado todavía) — se salta en vez de romper el tour.
					if (idx < steps.length - 1) return _showStep(idx + 1);
					return endTour();
				}
				$target[0].scrollIntoView({ behavior: "smooth", block: "center" });
				setTimeout(() => {
					if (!activeTour) return;
					activeTour.$currentTarget = $target;
					_paintCloud(step, idx, steps.length);
					_position();
				}, 180);
			}, 60);
		};

		if (typeof step.before === "function") {
			try { step.before(); } catch (e) { /* no bloquear el tour por un error de UI */ }
		}
		proceed();
	}

	function _position() {
		if (!activeTour || !activeTour.$currentTarget) return;
		const $t = activeTour.$currentTarget;
		if (!$t.length || !document.body.contains($t[0]) || $t.is(":hidden")) { endTour(); return; }
		const rect = $t[0].getBoundingClientRect();
		const pad = 6;
		activeTour.$spot.css({
			top: rect.top - pad, left: rect.left - pad,
			width: rect.width + pad * 2, height: rect.height + pad * 2,
		});
		const $cloud = activeTour.$cloud;
		const cw = $cloud.outerWidth() || 300, ch = $cloud.outerHeight() || 120;
		let top = rect.bottom + 14;
		const left = Math.min(Math.max(8, rect.left), window.innerWidth - cw - 8);
		if (top + ch > window.innerHeight - 8) {
			top = Math.max(8, rect.top - ch - 14);
		}
		$cloud.css({ top, left, visibility: "visible" });
	}

	function _paintCloud(step, idx, total) {
		const $cloud = activeTour.$cloud;
		$cloud.html(`
			<div class="efg-cloud-step">Paso ${idx + 1} de ${total}</div>
			<div class="efg-cloud-title">${_esc(step.title || "")}</div>
			<div class="efg-cloud-text">${_esc(step.text || "")}</div>
			<div class="efg-cloud-actions">
				<button class="efg-btn efg-btn-skip" data-act="skip">Salir</button>
				<div class="efg-cloud-nav">
					${idx > 0 ? '<button class="efg-btn efg-btn-prev" data-act="prev">← Atrás</button>' : ""}
					<button class="efg-btn efg-btn-next" data-act="next">${idx === total - 1 ? "Finalizar" : "Siguiente →"}</button>
				</div>
			</div>
		`);
		$cloud.off("click").on("click", "[data-act]", (e) => {
			const act = $(e.currentTarget).data("act");
			if (act === "skip") endTour();
			else if (act === "next") _next();
			else if (act === "prev") _prev();
		});
	}

	function _next() { if (activeTour) _showStep(activeTour.idx + 1); }
	function _prev() { if (activeTour) _showStep(activeTour.idx - 1); }

	// -------------------------------------------------------------------
	// Íconos de ayuda contextual permanentes (nube tenue al pasar/tocar)
	// -------------------------------------------------------------------
	function attachHints($container, hints) {
		injectStyles();
		const $root = ($container && $container.jquery && $container.length) ? $container : $(document);
		clearHints($root);

		(hints || []).forEach((h) => {
			const $target = $root.find(h.selector).first();
			if (!$target.length) return;

			const $badge = $('<span class="efg-hint-badge" tabindex="0">ⓘ</span>');
			const tag = ($target.prop("tagName") || "").toUpperCase();
			if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
				$badge.insertAfter($target);
			} else {
				$target.append($badge);
			}

			let $tip = null;
			const show = () => {
				$(".efg-hint-tip").remove();
				$tip = $(`<div class="efg-hint-tip">${_esc(h.text || "")}</div>`).appendTo("body");
				const r = $badge[0].getBoundingClientRect();
				const tw = $tip.outerWidth() || 200;
				$tip.css({
					top: r.bottom + 8,
					left: Math.min(Math.max(8, r.left), window.innerWidth - tw - 12),
				});
			};
			const hide = () => { if ($tip) { $tip.remove(); $tip = null; } };
			$badge.on("mouseenter focus", show).on("mouseleave blur", hide);
			$badge.on("click", (e) => { e.stopPropagation(); $tip ? hide() : show(); });
		});
	}

	function clearHints($container) {
		const $root = ($container && $container.jquery && $container.length) ? $container : $(document);
		$root.find(".efg-hint-badge").remove();
		$(".efg-hint-tip").remove();
	}

	return { startTour, endTour, attachHints, clearHints };
})();
