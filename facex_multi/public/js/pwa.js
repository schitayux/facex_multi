// FacEx como app instalable (PWA, fase 1): manifest, service worker mínimo y
// aviso de instalación en celular. El service worker solo cubre «sin conexión»
// (ver www/facex-sw.js); todo lo demás va siempre a la red.

(function () {
	const head = document.head;
	const add = (tag, attrs) => {
		const el = document.createElement(tag);
		Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
		head.appendChild(el);
	};
	if (!document.querySelector('link[rel="manifest"]')) {
		add("link", { rel: "manifest", href: "/api/method/facex_multi.api.pwa.manifest" });
	}
	add("link", { rel: "apple-touch-icon", href: "/assets/facex_multi/images/pwa/apple-touch-icon.png" });
	add("meta", { name: "mobile-web-app-capable", content: "yes" });
	add("meta", { name: "apple-mobile-web-app-capable", content: "yes" });
	add("meta", { name: "apple-mobile-web-app-title", content: "FacEx" });
	if (!document.querySelector('meta[name="theme-color"]')) add("meta", { name: "theme-color", content: "#153375" });

	if ("serviceWorker" in navigator) {
		window.addEventListener("load", () => {
			navigator.serviceWorker.register("/facex-sw.js").catch(() => { /* sin SW: la app funciona igual */ });
		});
	}

	// ── Aviso de instalación (solo celular, fuera de la app instalada) ────
	const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
	const ua = navigator.userAgent || "";
	const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
	const isIOS = /iPhone|iPad|iPod/i.test(ua);
	if (standalone || !isMobile) return;
	let dismissed = false;
	try { dismissed = !!localStorage.getItem("fx_pwa_dismissed"); } catch (e) { /* sin storage */ }
	if (dismissed) return;

	let deferred = null;
	window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; });

	const show = () => {
		if (document.getElementById("fx-pwa-banner") || !location.pathname.startsWith("/app/facex")) return;
		if (!isIOS && !deferred) return; // Android sin evento: el navegador no deja instalar
		const bar = document.createElement("div");
		bar.id = "fx-pwa-banner";
		bar.style.cssText = "position:fixed;left:10px;right:10px;bottom:10px;z-index:99999;background:#153375;color:#fff;border-radius:12px;padding:12px 14px;display:flex;gap:10px;align-items:center;box-shadow:0 6px 24px rgba(0,0,0,.35);font:14px system-ui,sans-serif;";
		bar.innerHTML = `<div style="flex:1;line-height:1.35"><b>Instale FacEx en su celular</b><br><span style="opacity:.85;font-size:12px">${isIOS ? "Toque Compartir y luego «Añadir a pantalla de inicio»." : "Acceso directo, pantalla completa y más rápido."}</span></div>
			${isIOS ? "" : `<button id="fx-pwa-install" style="background:#fff;color:#153375;border:0;border-radius:8px;padding:8px 14px;font-weight:700">Instalar</button>`}
			<button id="fx-pwa-close" aria-label="Cerrar" style="background:transparent;color:#fff;border:0;font-size:22px;line-height:1">&times;</button>`;
		document.body.appendChild(bar);
		const close = () => { bar.remove(); try { localStorage.setItem("fx_pwa_dismissed", "1"); } catch (e) { /* ok */ } };
		bar.querySelector("#fx-pwa-close").onclick = close;
		const btn = bar.querySelector("#fx-pwa-install");
		if (btn) btn.onclick = () => { deferred.prompt(); deferred.userChoice.finally(() => { deferred = null; close(); }); };
	};
	window.addEventListener("load", () => setTimeout(show, 4000));
})();
