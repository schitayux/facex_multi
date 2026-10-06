/* FacEx — service worker (PWA, fase 1).
 * Deliberadamente mínimo: TODO va a la red (los datos y el código de las
 * pantallas siempre son los vigentes tras un despliegue). Solo guarda la página
 * «sin conexión» para mostrarla cuando falla la red al abrir una pantalla. */
const VERSION = "facex-pwa-1";
const OFFLINE_URL = "/assets/facex_multi/offline.html";

self.addEventListener("install", (e) => {
	e.waitUntil(caches.open(VERSION).then((c) => c.add(OFFLINE_URL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener("fetch", (e) => {
	const req = e.request;
	if (req.mode !== "navigate") return; // todo lo demás: red normal
	e.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
});
