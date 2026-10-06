// Lector de QR / códigos de barras con la cámara del celular (PWA, fase 3).
//
// Alimenta los mismos campos de escaneo que usa el lector físico: el código leído
// se escribe en el campo y se simula Enter, así que todo lo que ya hace el campo
// (agregar la línea, sumar +1 al re-escanear, cambiar de modo Entero/Media con el
// QR de modo) funciona igual. Modo continuo: la cámara queda abierta para leer
// varios productos seguidos.
//
// Usa el BarcodeDetector nativo (Chrome/Android) y, si no existe (iPhone, Firefox),
// la librería ZXing incluida en la app (se carga solo al primer uso).

frappe.provide("facex_multi.scanner");

(function () {
	const S = facex_multi.scanner;
	const FORMATS = ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "data_matrix"];
	const ZXING_URL = "/assets/facex_multi/js/vendor/zxing-library.min.js";
	let zxingPromise = null;

	// ¿Mostrar el botón de cámara? Celulares/tabletas (puntero táctil) y la app instalada.
	S.available = () => {
		const touch = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
		const standalone = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
		return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (touch || standalone));
	};

	S.ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>`;

	const loadZXing = () => {
		if (window.ZXing) return Promise.resolve();
		if (!zxingPromise) {
			zxingPromise = new Promise((resolve, reject) => {
				const s = document.createElement("script");
				s.src = ZXING_URL;
				s.onload = resolve;
				s.onerror = () => { zxingPromise = null; reject(new Error("No se pudo cargar el lector")); };
				document.head.appendChild(s);
			});
		}
		return zxingPromise;
	};

	// Decodifica un <canvas>/<img>/<video> (también sirve para pruebas). Devuelve texto o "".
	S.decode_image = async (source) => {
		if ("BarcodeDetector" in window) {
			try {
				const det = new window.BarcodeDetector({ formats: FORMATS });
				const res = await det.detect(source);
				if (res && res.length) return res[0].rawValue || "";
			} catch (e) { /* cae a ZXing */ }
		}
		await loadZXing();
		const reader = new window.ZXing.MultiFormatReader();
		const hints = new Map();
		hints.set(window.ZXing.DecodeHintType.TRY_HARDER, true);
		reader.setHints(hints);
		const canvas = document.createElement("canvas");
		const w = source.videoWidth || source.naturalWidth || source.width;
		const h = source.videoHeight || source.naturalHeight || source.height;
		canvas.width = w; canvas.height = h;
		canvas.getContext("2d").drawImage(source, 0, 0, w, h);
		const lum = new window.ZXing.HTMLCanvasElementLuminanceSource(canvas);
		try {
			return reader.decode(new window.ZXing.BinaryBitmap(new window.ZXing.HybridBinarizer(lum))).getText();
		} catch (e) {
			return "";
		}
	};

	// Abre la cámara. onCode(texto) se llama en cada lectura nueva.
	S.open = (opts) => {
		opts = opts || {};
		const dlg = new frappe.ui.Dialog({
			title: opts.title || "Escanear con la cámara",
			size: "small",
			fields: [{ fieldtype: "HTML", fieldname: "cam" }],
			secondary_action_label: "Cerrar",
			secondary_action: () => dlg.hide(),
		});
		dlg.fields_dict.cam.$wrapper.html(`
<div style="position:relative;background:#000;border-radius:10px;overflow:hidden;">
  <video id="fx-cam-video" playsinline muted autoplay style="width:100%;max-height:60vh;display:block;object-fit:cover;"></video>
  <div style="position:absolute;inset:18% 12%;border:3px solid rgba(255,255,255,.85);border-radius:14px;box-shadow:0 0 0 999px rgba(0,0,0,.25);pointer-events:none;"></div>
</div>
<div id="fx-cam-status" style="margin-top:8px;font-size:13px;color:#475569;text-align:center;min-height:20px;">Apunte al código…</div>
<div id="fx-cam-last" style="font-size:12px;color:#153375;text-align:center;font-weight:700;word-break:break-all;"></div>`);

		let stream = null, stopped = false, last = "", lastAt = 0, zreader = null;
		const $ = (sel) => dlg.fields_dict.cam.$wrapper.find(sel);
		const status = (t) => $("#fx-cam-status").text(t);

		const handle = (text) => {
			text = (text || "").trim();
			if (!text) return;
			const now = Date.now();
			// El mismo código seguido (la cámara lo ve varias veces) cuenta una vez.
			if (text === last && now - lastAt < 2500) return;
			last = text; lastAt = now;
			if (navigator.vibrate) navigator.vibrate(60);
			$("#fx-cam-last").text(text);
			status("Leído ✓ — siga con el siguiente");
			try { opts.onCode && opts.onCode(text); } catch (e) { console.error(e); }
		};

		const stop = () => {
			stopped = true;
			try { zreader && zreader.reset(); } catch (e) { /* ok */ }
			if (stream) stream.getTracks().forEach((t) => t.stop());
		};
		dlg.onhide = stop;

		const start = async () => {
			const video = $("#fx-cam-video")[0];
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
					audio: false,
				});
			} catch (e) {
				status("No se pudo abrir la cámara. Permita el acceso a la cámara en el navegador.");
				return;
			}
			if (stopped) { stop(); return; }
			video.srcObject = stream;
			await video.play().catch(() => {});
			if ("BarcodeDetector" in window) {
				const det = new window.BarcodeDetector({ formats: FORMATS });
				const tick = async () => {
					if (stopped) return;
					try {
						if (video.readyState >= 2) {
							const res = await det.detect(video);
							if (res && res.length) handle(res[0].rawValue);
						}
					} catch (e) { /* fotograma sin código */ }
					setTimeout(tick, 120);
				};
				tick();
			} else {
				try {
					await loadZXing();
					zreader = new window.ZXing.BrowserMultiFormatReader();
					zreader.decodeFromVideoElement(video, (result) => { if (result && !stopped) handle(result.getText()); });
				} catch (e) {
					status("No se pudo iniciar el lector de códigos.");
				}
			}
		};
		dlg.show();
		start();
		return dlg;
	};

	// Botón de cámara para un campo de escaneo: lo agrega a su lado y, en cada
	// lectura, escribe el código y simula Enter en el campo.
	S.attach = ($input, $after) => {
		if (!S.available() || !$input || !$input.length || $input.data("fxCam")) return;
		$input.data("fxCam", 1);
		const $btn = $(`<button type="button" class="fx-cam-btn" title="Escanear con la cámara" aria-label="Escanear con la cámara">${S.ICON}</button>`);
		$btn.css({ border: "1px solid #cbd5e1", background: "#fff", color: "#153375", borderRadius: "8px", padding: "6px 10px", marginLeft: "6px", cursor: "pointer", lineHeight: 1, verticalAlign: "middle" });
		($after && $after.length ? $after : $input).after($btn);
		$btn.on("click", () => S.open({
			onCode: (code) => {
				$input.val(code);
				$input.trigger($.Event("keydown", { key: "Enter", which: 13, keyCode: 13 }));
			},
		}));
	};
})();
