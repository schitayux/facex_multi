// Bot de Ventas por Live — corre en una PC de la tienda (ver LEEME.md).
//
// Abre WhatsApp Web en Chromium (se vincula con el QR, como un dispositivo
// más) y SOLO LEE: cada mensaje con «mío» que llega mientras hay una sesión de
// Live abierta en FacEx se manda a facex_multi.api.live.recibir_mio con el
// teléfono, el texto, la hora del mensaje y la captura del live. Nunca envía
// mensajes ni los marca como leídos.
//
// La captura suele llegar como imagen aparte del texto «mío Luffy»: se junta
// la última imagen del mismo chat (hasta VENTANA_MS antes) o se espera
// ESPERA_IMAGEN_MS a que llegue después.

const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const VENTANA_MS = (CFG.ventana_imagen_seg || 180) * 1000;
const ESPERA_IMAGEN_MS = (CFG.espera_imagen_seg || 30) * 1000;
const MIO_RE = /\b(mio|mia|mios|mias)\b/;

const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);
const pad = (n) => String(n).padStart(2, "0");
// Hora local de la PC (Guatemala), como la espera Frappe.
const fecha = (unix) => {
	const d = new Date(unix * 1000);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

async function api(method, body) {
	const res = await fetch(`${CFG.url.replace(/\/$/, "")}/api/method/facex_multi.api.live.${method}`, {
		method: body ? "POST" : "GET",
		headers: { Authorization: `token ${CFG.api_key}:${CFG.api_secret}`, "Content-Type": "application/json", Accept: "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	const j = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(j.exception || j._server_messages || `HTTP ${res.status}`);
	return j.message;
}

// ── Sesión abierta en FacEx ─────────────────────────────────────────────
let sesion = { sesion: "", abierta_desde: "" };
async function refrescarSesion() {
	try {
		const s = await api("estado_bot" + (CFG.company ? `?company=${encodeURIComponent(CFG.company)}` : ""));
		if (s.sesion !== sesion.sesion) log(s.sesion ? `Sesión abierta: ${s.sesion} (desde ${s.abierta_desde}) · ${s.personajes.join(", ")}` : "No hay sesión de Live abierta: los mensajes se ignoran.");
		sesion = s;
	} catch (e) {
		log("No se pudo consultar FacEx:", e.message);
	}
}
const desdeUnix = () => (sesion.abierta_desde ? new Date(sesion.abierta_desde.replace(" ", "T")).getTime() / 1000 : Infinity);

// ── Imágenes recientes por chat ─────────────────────────────────────────
const imagenes = new Map(); // chat → [{ts, msg}]
function guardarImagen(msg) {
	const lista = (imagenes.get(msg.from) || []).filter((x) => Date.now() - x.ts < VENTANA_MS);
	lista.push({ ts: msg.timestamp * 1000, msg });
	imagenes.set(msg.from, lista);
}
function tomarImagen(chat, cerca) {
	const lista = imagenes.get(chat) || [];
	const i = lista.map((x) => Math.abs(x.ts - cerca) <= VENTANA_MS).lastIndexOf(true);
	if (i < 0) return null;
	return lista.splice(i, 1)[0].msg;
}

const procesados = new Set();
async function enviar(msg, texto, imgMsg) {
	const id = msg.id._serialized;
	if (procesados.has(id)) return;
	procesados.add(id);
	const contacto = await msg.getContact();
	const telefono = contacto.number || msg.from.split("@")[0];
	const body = {
		telefono, texto, nombre: contacto.pushname || contacto.name || "",
		llegada: fecha(msg.timestamp), msg_id: id, company: CFG.company || undefined,
	};
	const fuente = imgMsg || (msg.hasMedia && msg.type === "image" ? msg : null);
	if (fuente) {
		try {
			const media = await fuente.downloadMedia();
			if (media) { body.imagen = media.data; body.imagen_nombre = media.filename || `captura.${(media.mimetype || "image/jpeg").split("/")[1]}`; }
		} catch (e) { log("No se pudo bajar la captura:", e.message); }
	}
	try {
		const r = await api("recibir_mio", body);
		log(r.pedido ? `«mío» ${telefono} → ${r.pedido} ${r.estado} ${r.alias || "(sin personaje)"}` : `Ignorado (${r.ignorado}) ${telefono}`);
	} catch (e) {
		procesados.delete(id); // reintenta en el próximo barrido
		log(`Error al registrar ${telefono}:`, e.message);
	}
}

async function procesar(msg) {
	if (msg.fromMe || msg.isStatus || !(msg.from.endsWith("@c.us") || msg.from.endsWith("@lid"))) return; // sin grupos ni estados
	if (msg.timestamp < desdeUnix()) return;
	if (msg.hasMedia && msg.type === "image") guardarImagen(msg);
	const texto = msg.body || "";
	if (!MIO_RE.test(norm(texto))) return;
	if (msg.hasMedia && msg.type === "image") return enviar(msg, texto, null); // captura con el «mío» en el pie
	const img = tomarImagen(msg.from, msg.timestamp * 1000);
	if (img) return enviar(msg, texto, img);
	// La captura todavía no llega: se espera un poco.
	setTimeout(() => enviar(msg, texto, tomarImagen(msg.from, msg.timestamp * 1000)), ESPERA_IMAGEN_MS);
}

// Al arrancar (o al abrirse una sesión) revisa los chats recientes para no
// perder los «mío» que llegaron con el bot apagado. El servidor descarta
// duplicados por ID de mensaje.
async function barrer(client) {
	if (!sesion.sesion) return;
	const desde = desdeUnix();
	const chats = (await client.getChats()).filter((c) => !c.isGroup && c.timestamp >= desde);
	for (const chat of chats) {
		const msgs = (await chat.fetchMessages({ limit: 30 })).filter((m) => !m.fromMe && m.timestamp >= desde);
		msgs.filter((m) => m.hasMedia && m.type === "image").forEach(guardarImagen);
		for (const m of msgs) {
			if (!MIO_RE.test(norm(m.body))) continue;
			await enviar(m, m.body, m.type === "image" ? null : tomarImagen(m.from, m.timestamp * 1000));
		}
	}
}

const client = new Client({
	authStrategy: new LocalAuth({ dataPath: path.join(__dirname, ".sesion_wa") }),
	puppeteer: { headless: !!CFG.headless, args: ["--no-sandbox"] },
});
client.on("qr", (qr) => { log("Escanee este QR con el WhatsApp del negocio (Dispositivos vinculados):"); qrcode.generate(qr, { small: true }); });
client.on("ready", async () => {
	log("WhatsApp conectado (solo lectura).");
	await refrescarSesion();
	await barrer(client).catch((e) => log("Barrido:", e.message));
	let anterior = sesion.sesion;
	setInterval(async () => {
		await refrescarSesion();
		if (sesion.sesion && sesion.sesion !== anterior) await barrer(client).catch((e) => log("Barrido:", e.message));
		anterior = sesion.sesion;
	}, 60 * 1000);
});
client.on("message", (msg) => procesar(msg).catch((e) => log("Mensaje:", e.message)));
client.on("disconnected", (r) => { log("WhatsApp desconectado:", r, "— reinicie el bot."); process.exit(1); });
client.initialize();
