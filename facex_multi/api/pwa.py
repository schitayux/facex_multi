# -*- coding: utf-8 -*-
"""FacEx como app instalable (PWA, fase 1): manifest por sitio/dominio."""
import json
import re

import frappe


@frappe.whitelist(allow_guest=True)
def manifest():
    host = ""
    req = getattr(frappe.local, "request", None)
    if req and req.host:
        host = re.sub(r"[^a-zA-Z0-9\.\-]", "", req.host.split(":")[0]).lower()
    name, color = "FacEx", "#153375"
    try:
        b = frappe.db.get_value("FacEx Domain Branding", {"domain": host, "enabled": 1},
                                ["company", "primary_color"], as_dict=True)
        if b:
            if b.company:
                name = frappe.get_cached_value("Company", b.company, "company_name") or name
            if b.primary_color and re.fullmatch(r"#[0-9a-fA-F]{6}", b.primary_color.strip()):
                color = b.primary_color.strip()
    except Exception:
        pass
    short = (name if len(name) <= 12 else "FacEx")
    base = "/assets/facex_multi/images/pwa/"
    data = {
        "name": f"{name} — FacEx" if name != "FacEx" else "FacEx",
        "short_name": short,
        "description": "Facturación, POS, inventario, compras y cierre diario.",
        "start_url": "/app/facex?source=pwa",
        "scope": "/",
        "display": "standalone",
        "orientation": "any",
        "background_color": "#f1f5f9",
        "theme_color": color,
        "lang": "es",
        "icons": [
            {"src": base + "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": base + "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": base + "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
        "shortcuts": [
            {"name": "Vender (POS)", "url": "/app/facex-screen", "icons": [{"src": base + "icon-192.png", "sizes": "192x192"}]},
            {"name": "Facturador", "url": "/app/facex?view=billing", "icons": [{"src": base + "icon-192.png", "sizes": "192x192"}]},
            {"name": "Inventario", "url": "/app/facex-inventario", "icons": [{"src": base + "icon-192.png", "sizes": "192x192"}]},
        ],
    }
    # El navegador necesita el JSON crudo (no el sobre {"message": ...} de las APIs).
    frappe.local.response.filename = "manifest.webmanifest"
    frappe.local.response.filecontent = json.dumps(data, ensure_ascii=False).encode("utf-8")
    frappe.local.response.content_type = "application/manifest+json"
    frappe.local.response.display_content_as = "inline"
    frappe.local.response.type = "download"
