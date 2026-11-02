// Bot de Ventas por Live — corre en una PC de la tienda (ver LEEME.md).
//
// Un bot por número de WhatsApp: `node index.js` usa config.json y
// `node index.js config-ana.json` usa otro archivo, cada uno con su propia
// sesión de WhatsApp (.sesion_wa/<nombre del config>) y su propio QR.
//
// Abre WhatsApp Web en Chromium (se vincula con el QR, como un dispositivo
// más) y SOLO LEE: cada mensaje con «mío» que llega mientras la sesión de Live
// de SU número está abierta en FacEx se manda a facex_multi.api.live.recibir_mio
// con su línea, el teléfono, el texto, la hora del mensaje y la captura del
// live. Nunca envía mensajes ni los marca como leídos.
//
// La captura suele llegar como imagen aparte del texto «mío Luffy»: si llegó
// antes, se junta la última imagen del mismo chat (hasta VENTANA_MS antes); si
// llega después, va como seguimiento. Los mensajes sin «mío» que el cliente
// manda poco después (el personaje, la captura, preguntas) se le juntan a su
// pedido con recibir_seguimiento.

const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const CFG_FILE = path.resolve(__dirname, process.argv[2] || "config.json");
const CFG = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
const PERFIL = path.basename(CFG_FILE, ".json"); // carpeta de la sesión de WhatsApp de este número
let LINEA = ""; // número propio, se conoce al conectar
const VENTANA_MS = (CFG.ventana_imagen_seg || 180) * 1000;
const MIO_RE = /\b(mio|mia|mios|mias)\b/;

const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const log = (...a) => console.log(new Date().toLocaleTimeString(), LINEA ? `[${LINEA}]` : `[${PERFIL}]`, ...a);
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
		const q = new URLSearchParams({ linea: LINEA, ...(CFG.company ? { company: CFG.company } : {}) });
		const s = await api(`estado_bot?${q}`);
		if (s.sesion !== sesion.sesion) log(s.sesion ? `Sesión abierta: ${s.sesion} (desde ${s.abierta_desde}) · ${s.personajes.join(", ")}` : `El WhatsApp ${s.linea} no tiene sesión de Live abierta: los mensajes se ignoran.`);
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

const esImagen = (m) => m.hasMedia && m.type === "image";
const idDe = (m) => m.id?._serialized || m.id?.id || `${m.from}_${m.timestamp}_${(m.body || "").slice(0, 20)}`;

async function datosBase(msg) {
	const contacto = await msg.getContact().catch(() => ({}));
	return {
		linea: LINEA, telefono: contacto.number || msg.from.split("@")[0], nombre: contacto.pushname || contacto.name || "",
		texto: msg.body || "", llegada: fecha(msg.timestamp), msg_id: idDe(msg), company: CFG.company || undefined,
	};
}
async function conImagen(body, fuente) {
	if (!fuente) return body;
	for (let intento = 1; intento <= 3; intento++) {
		try {
			const media = await fuente.downloadMedia();
			if (media && media.data) {
				body.imagen = media.data;
				body.imagen_nombre = media.filename || `captura.${(media.mimetype || "image/jpeg").split("/")[1]}`;
				return body;
			}
		} catch (e) { if (intento === 3) log("No se pudo bajar la captura:", e.message); }
		await new Promise((r) => setTimeout(r, 2000 * intento));
	}
	log("La captura llegó vacía; quedó sin imagen.");
	return body;
}

// Mensajes ya tratados en esta corrida (el servidor además descarta duplicados).
const procesados = new Set();

// «mío»: crea el pedido. Si la captura llegó antes en el mismo chat, va junto.
async function enviarMio(msg) {
	const body = await conImagen(await datosBase(msg), esImagen(msg) ? msg : tomarImagen(msg.from, msg.timestamp * 1000));
	const r = await api("recibir_mio", body);
	log(r.pedido ? `«mío» ${body.telefono} → ${r.pedido} ${r.estado} ${r.alias || "(sin personaje)"}${body.imagen ? " con captura" : " sin captura"}` : `Ignorado (${r.ignorado}) ${body.telefono}`);
}

// Sin «mío»: se le junta al «mío» reciente del mismo cliente (personaje que
// faltaba, captura, o consulta para que la lea el vendedor). Nunca crea pedidos.
async function enviarSeguimiento(msg) {
	const body = await conImagen(await datosBase(msg), esImagen(msg) ? msg : null);
	if (!body.texto && !body.imagen) return;
	const r = await api("recibir_seguimiento", body);
	if (r.pedido && r.ignorado !== "duplicado") log(`   ↳ ${body.telefono} → ${r.pedido}: ${(r.uso || []).join(", ") || "mensaje agregado"} · ${r.estado} ${r.alias || ""}`);
	// Una imagen que no se usó puede ser la captura del próximo «mío».
	if (esImagen(msg) && !(r.uso || []).includes("captura")) guardarImagen(msg);
}

// Un chat a la vez y en orden, para que el «mío» llegue antes que lo que sigue.
const colas = new Map();
function procesar(msg) {
	if (msg.fromMe || msg.isStatus || !(msg.from.endsWith("@c.us") || msg.from.endsWith("@lid"))) return; // sin grupos ni estados
	if (msg.timestamp < desdeUnix()) return;
	const id = idDe(msg);
	if (procesados.has(id)) return;
	procesados.add(id);
	const tarea = async () => {
		const mio = MIO_RE.test(norm(msg.body));
		log(`Mensaje de ${msg.from.split("@")[0]}: ${esImagen(msg) ? "[imagen] " : ""}${(msg.body || "").slice(0, 60)}`);
		try {
			await (mio ? enviarMio(msg) : enviarSeguimiento(msg));
		} catch (e) {
			procesados.delete(id); // reintenta en el próximo barrido
			log("Error al registrar:", e.message);
		}
	};
	const cola = (colas.get(msg.from) || Promise.resolve()).then(tarea);
	colas.set(msg.from, cola);
	return cola;
}

// Cada minuto (y al arrancar) revisa los chats recientes: así no se pierde
// ningún mensaje aunque WhatsApp Web no avise o el bot haya estado apagado.
let barriendo = false;
async function barrer(client) {
	if (!sesion.sesion || barriendo) return;
	barriendo = true;
	try {
		const desde = desdeUnix();
		const chats = (await client.getChats()).filter((c) => !c.isGroup && c.timestamp >= desde);
		for (const chat of chats) {
			const msgs = (await chat.fetchMessages({ limit: 30 })).filter((m) => !m.fromMe && m.timestamp >= desde);
			msgs.sort((a, b) => a.timestamp - b.timestamp);
			for (const m of msgs) await procesar(m);
		}
	} finally {
		barriendo = false;
	}
}

const client = new Client({
	authStrategy: new LocalAuth({ dataPath: path.join(__dirname, ".sesion_wa", PERFIL) }),
	puppeteer: { headless: !!CFG.headless, args: ["--no-sandbox"] },
});
client.on("qr", (qr) => { log("Escanee este QR con el WhatsApp del negocio (Dispositivos vinculados):"); qrcode.generate(qr, { small: true }); });
client.on("authenticated", () => log("Sesión de WhatsApp reconocida, cargando chats…"));
client.on("auth_failure", (m) => { log("WhatsApp rechazó la sesión guardada:", m, "— borre la carpeta .sesion_wa y vuelva a escanear el QR."); process.exit(1); });
client.on("loading_screen", (pct) => log(`Cargando WhatsApp Web ${pct}%`));
client.on("ready", async () => {
	clearTimeout(lento);
	LINEA = client.info.wid.user.replace(/\D/g, "").slice(-8);
	log("WhatsApp conectado (solo lectura).");
	await refrescarSesion();
	await barrer(client).catch((e) => log("Barrido:", e.message));
	setInterval(async () => {
		await refrescarSesion();
		await barrer(client).catch((e) => log("Barrido:", e.message));
	}, 60 * 1000);
});
client.on("message", (msg) => { procesar(msg); });
client.on("disconnected", (r) => { log("WhatsApp desconectado:", r, "— reinicie el bot."); process.exit(1); });
client.on("change_state", (st) => log("Estado de WhatsApp:", st));
process.on("unhandledRejection", (e) => log("Error:", e && e.message ? e.message : e));
log(`Abriendo WhatsApp Web (perfil ${PERFIL}, FacEx ${CFG.url})…`);
const lento = setTimeout(() => log("Lleva 2 minutos sin conectar. Revise que no haya otro bot abierto con el mismo perfil (ps aux | grep node) y que la ventana de Chromium no muestre un aviso."), 120 * 1000);
client.initialize().catch((e) => { log("No se pudo abrir WhatsApp Web:", e.message); process.exit(1); });
