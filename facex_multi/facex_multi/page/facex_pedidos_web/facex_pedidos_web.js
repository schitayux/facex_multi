// FacEx Multi — Pedidos en línea (carrito de la página web de la compañía).
// Page sobre «FacEx Pedido en Linea» (ver api/pagina_web.py). Cada pedido llega
// con su cotización (factura en borrador): se abre en FacEx, se revisa con el
// cliente y se valida como cualquier otra. Requiere «Ver pedidos en línea» en
// FacEx Settings y que la compañía tenga «Página web» activada.

frappe.pages["facex-pedidos-web"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({ parent: wrapper, title: "Pedidos en línea — FacEx", single_column: true });
	wrapper.facexPedidosWeb = new FacexPedidosWeb(page);
};

frappe.pages["facex-pedidos-web"].on_page_show = function (wrapper) {
	if (wrapper.facexPedidosWeb) wrapper.facexPedidosWeb.cargar();
};

const PW_CSS = `
.pw{padding:12px 4px;font-size:13px;color:#1f2937}
.pw *{box-sizing:border-box}
.pw-top{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px;margin-bottom:12px}
.pw-top h2{margin:0;font-size:20px;color:#153375}
.pw-sub{color:#6b7280;font-size:12px;margin-top:2px}
.pw-sub a{color:#153375;font-weight:600}
.pw-acciones{display:flex;gap:8px;flex-wrap:wrap}
.pw-btn{height:32px;padding:0 12px;border-radius:6px;border:1px solid #153375;background:#fff;color:#153375;font-weight:600;cursor:pointer;white-space:nowrap}
.pw-btn.pri{background:#153375;color:#fff}.pw-btn.dng{border-color:#b91c1c;color:#b91c1c}.pw-btn.sm{height:28px;padding:0 9px;font-size:12px}
.pw-tabs{display:flex;gap:4px;border-bottom:2px solid #e5e7eb;margin-bottom:14px;flex-wrap:wrap}
.pw-tab{padding:8px 16px;border:0;background:none;cursor:pointer;font-weight:600;color:#6b7280;border-bottom:3px solid transparent;margin-bottom:-2px}
.pw-tab.on{color:#153375;border-color:#153375}
.pw-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px;display:flex;gap:16px;flex-wrap:wrap}
.pw-datos{flex:1 1 420px;min-width:0}
.pw-lado{flex:0 0 220px;display:flex;flex-direction:column;gap:8px;align-items:stretch}
.pw-nombre{font-size:16px;font-weight:700;color:#111827}
.pw-suave{color:#6b7280;font-size:12px}
.pw-pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:700;margin-right:6px}
.pw-pill.Recibido{background:#fef3c7;color:#92400e}.pw-pill.Cotizado{background:#dbeafe;color:#1e40af}
.pw-pill.Facturado{background:#dcfce7;color:#166534}.pw-pill.Cancelado{background:#f3f4f6;color:#4b5563}
.pw-tabla{width:100%;border-collapse:collapse;margin:8px 0;font-size:12px}
.pw-tabla td{padding:4px 6px;border-top:1px solid #f1f5f9}.pw-tabla td.n{text-align:right;white-space:nowrap}
.pw-error{background:#fef2f2;color:#991b1b;border:1px solid #fecaca;border-radius:6px;padding:6px 8px;margin-top:6px;font-size:12px}
.pw-vacio{padding:40px;text-align:center;color:#6b7280;background:#fff;border:1px dashed #cbd5e1;border-radius:10px}
.pw-total{font-size:18px;font-weight:700;text-align:right}
`;

function _pw_esc(v) {
	return frappe.utils.escape_html(v == null ? "" : String(v));
}

class FacexPedidosWeb {
	constructor(page) {
		this.page = page;
		this.lista = "activos";
		this.datos = null;
		if (!document.getElementById("pw-css")) $(`<style id="pw-css">${PW_CSS}</style>`).appendTo("head");
		this.$body = $(`<div class="pw"></div>`).appendTo(page.main);
		this.$body.on("click", "[data-pw]", (e) => this.accion($(e.currentTarget)));
		this.cargar();
	}

	cargar() {
		frappe.call({
			method: "facex_multi.api.pagina_web.pantalla",
			args: { lista: this.lista },
			callback: (r) => { this.datos = r.message; this.pintar(); },
			error: () => this.$body.html(`<div class="pw-vacio">No tiene acceso a los pedidos en línea de esta compañía.</div>`),
		});
	}

	pintar() {
		const d = this.datos;
		const tabs = [["activos", "Por atender"], ["facturados", "Facturados"], ["cancelados", "Cancelados"]];
		const dominio = d.dominio ? `<a href="https://${_pw_esc(d.dominio)}" target="_blank" rel="noopener">🌐 ${_pw_esc(d.dominio)}</a>` : "Sin dominio";
		const envio = d.ultimo_envio
			? `Catálogo enviado ${_pw_esc(frappe.datetime.prettyDate(d.ultimo_envio))} · ${_pw_esc(d.estado_envio)}`
			: "El catálogo aún no se ha enviado.";
		this.$body.html(`
			<div class="pw-top">
				<div><h2>Pedidos en línea</h2><div class="pw-sub">${_pw_esc(d.company)} · ${dominio}</div><div class="pw-sub">${envio}</div></div>
				<div class="pw-acciones">
					${d.puede_gestionar ? `<button class="pw-btn" data-pw="categorias">Revisar categorías</button><button class="pw-btn" data-pw="publicar">Publicar catálogo</button>` : ""}
					<button class="pw-btn" data-pw="facex">Volver a FacEx</button>
				</div>
			</div>
			<div class="pw-tabs">${tabs.map(([k, t]) => `<button class="pw-tab ${k === this.lista ? "on" : ""}" data-pw="lista" data-lista="${k}">${t}${d.cuantos[k] ? ` (${d.cuantos[k]})` : ""}</button>`).join("")}</div>
			${d.pedidos.length ? d.pedidos.map((p) => this.tarjeta(p)).join("") : `<div class="pw-vacio">${this.lista === "activos" ? "No hay pedidos por atender." : "No hay pedidos aquí."}</div>`}
		`);
	}

	tarjeta(p) {
		const quien = p.empresa_cliente ? `${_pw_esc(p.empresa_cliente)} <span class="pw-suave">· ${_pw_esc(p.comprador_nombre)}</span>` : _pw_esc(p.comprador_nombre);
		const contacto = [
			p.telefono ? `<a href="tel:${_pw_esc(p.telefono)}">${_pw_esc(p.telefono)}</a>` : "",
			p.correo ? `<a href="mailto:${_pw_esc(p.correo)}">${_pw_esc(p.correo)}</a>` : "",
			p.nit && p.nit !== "CF" ? `NIT ${_pw_esc(p.nit)}` : "CF",
		].filter(Boolean).join(" · ");
		const filas = (p.articulos || []).map((a) => `<tr><td>${_pw_esc(a.descripcion)}</td><td class="n">${_pw_esc(a.cantidad)} ${_pw_esc(a.uom || "")}</td></tr>`).join("");
		const activo = ["Recibido", "Cotizado"].includes(p.estado);
		return `
			<div class="pw-card">
				<div class="pw-datos">
					<div><span class="pw-pill ${_pw_esc(p.estado)}">${p.estado === "Cotizado" ? "Por revisar" : _pw_esc(p.estado)}</span><span class="pw-suave">${_pw_esc(p.name)} · ${_pw_esc(frappe.datetime.str_to_user(p.recibido_el))}</span></div>
					<div class="pw-nombre" style="margin-top:6px">${quien}</div>
					<div class="pw-suave">${contacto}</div>
					${p.direccion ? `<div class="pw-suave">Entregar en: ${_pw_esc(p.direccion)}</div>` : ""}
					${p.comentario ? `<div class="pw-suave">Comentario: ${_pw_esc(p.comentario)}</div>` : ""}
					<table class="pw-tabla">${filas}</table>
					${p.notas ? `<div class="pw-suave">Notas: ${_pw_esc(p.notas)}</div>` : ""}
					${p.error && p.estado === "Recibido" ? `<div class="pw-error">No se pudo crear la cotización: ${_pw_esc(p.error)}</div>` : ""}
				</div>
				<div class="pw-lado">
					${p.cotizacion ? `<div class="pw-total">${p.total != null ? format_currency(p.total) : ""}</div><div class="pw-suave" style="text-align:right">Cotización ${_pw_esc(p.cotizacion)}</div>
						<button class="pw-btn pri" data-pw="abrir" data-si="${_pw_esc(p.cotizacion)}">${p.estado === "Facturado" ? "Ver factura" : "Abrir cotización en FacEx"}</button>` : ""}
					${p.estado === "Recibido" ? `<button class="pw-btn pri" data-pw="cotizar" data-p="${_pw_esc(p.name)}">Crear cotización</button>` : ""}
					${activo ? `<button class="pw-btn" data-pw="notas" data-p="${_pw_esc(p.name)}">Notas</button><button class="pw-btn dng" data-pw="cancelar" data-p="${_pw_esc(p.name)}">Cancelar pedido</button>` : ""}
				</div>
			</div>`;
	}

	accion($b) {
		const que = $b.data("pw");
		const p = $b.data("p");
		const llamar = (method, args, aviso) =>
			frappe.call({ method: `facex_multi.api.pagina_web.${method}`, args, freeze: true }).then((r) => {
				const m = (r.message && r.message.aviso) || aviso;
				if (m) frappe.show_alert({ message: m, indicator: "green" });
				this.cargar();
				return r;
			});
		if (que === "lista") { this.lista = $b.data("lista"); this.cargar(); }
		if (que === "facex") frappe.set_route("facex");
		if (que === "abrir") frappe.set_route("facex", "", { invoice: $b.data("si") });
		if (que === "cotizar") llamar("reintentar_cotizacion", { pedido: p }, "Cotización creada");
		if (que === "publicar") {
			frappe.call({ method: "facex_multi.api.pagina_web.publicar_ahora", freeze: true, freeze_message: "Enviando el catálogo a la página…" }).then((r) => {
				const m = r.message || {};
				frappe.msgprint({ title: m.ok ? "Catálogo enviado" : "No se pudo enviar", message: _pw_esc(m.mensaje), indicator: m.ok ? "green" : "red" });
				this.cargar();
			});
		}
		if (que === "notas") {
			const actual = (this.datos.pedidos.find((x) => x.name === p) || {}).notas || "";
			frappe.prompt({ fieldname: "notas", fieldtype: "Small Text", label: "Notas internas", default: actual }, (v) => llamar("guardar_notas", { pedido: p, notas: v.notas }, "Notas guardadas"), "Notas del pedido", "Guardar");
		}
		if (que === "cancelar") {
			frappe.prompt({ fieldname: "motivo", fieldtype: "Data", label: "Motivo", reqd: 1 }, (v) => llamar("cancelar_pedido", { pedido: p, motivo: v.motivo }, "Pedido cancelado"), "Cancelar el pedido", "Cancelar pedido");
		}
		if (que === "categorias") this.categorias();
	}

	categorias() {
		frappe.call({ method: "facex_multi.api.pagina_web.vista_previa_categorias", freeze: true }).then((r) => {
			const cambios = (r.message && r.message.cambios) || [];
			if (!cambios.length) {
				frappe.msgprint({ title: "Categorías", message: "Todos los productos ya están en su categoría.", indicator: "green" });
				return;
			}
			const filas = cambios.map((c, i) => `<tr><td><input type="checkbox" data-i="${i}" checked></td><td>${_pw_esc(c.item_name)}<div class="pw-suave">${_pw_esc(c.item_code)}</div></td><td class="pw-suave">${_pw_esc(c.actual)}</td><td><b>${_pw_esc(c.nuevo)}</b></td></tr>`).join("");
			const dlg = new frappe.ui.Dialog({
				title: `Categorías sugeridas (${cambios.length} de ${r.message.total_productos} productos)`,
				size: "extra-large",
				fields: [{ fieldtype: "HTML", fieldname: "tabla" }],
				primary_action_label: "Aplicar a los marcados",
				primary_action: () => {
					const items = dlg.$wrapper.find("input[data-i]:checked").map((_, el) => cambios[$(el).data("i")].item_code).get();
					if (!items.length) return;
					frappe.call({ method: "facex_multi.api.pagina_web.aplicar_categorias", args: { items }, freeze: true }).then((x) => {
						dlg.hide();
						frappe.show_alert({ message: `${x.message.cambiados} productos cambiados de grupo`, indicator: "green" });
						this.cargar();
					});
				},
			});
			dlg.fields_dict.tabla.$wrapper.html(`
				<p class="pw-suave">Solo se cambia el grupo de los productos marcados. Los que ya están dentro del catálogo no se tocan.</p>
				<div style="max-height:60vh;overflow:auto"><table class="pw-tabla"><tr><td></td><td><b>Producto</b></td><td><b>Grupo actual</b></td><td><b>Grupo nuevo</b></td></tr>${filas}</table></div>`);
			dlg.show();
		});
	}
}
