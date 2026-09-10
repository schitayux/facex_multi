"""
Patch (solo neko): carga inicial de Familias de Precio.

1. Crea las 21 Familias de Precio de neko con su matriz de precios por lista
   (hoja "Precios por Familia" de "Plantillas rev-134 neko - DEPURADO + MAPEO.xlsx",
   embebida abajo).
2. Asigna Item.custom_facex_familia a los 122 SKU mapeados (hoja "MAPEO SKU-FAMILIA")
   y les fija bfel_company = "Neko".
3. Activa la política exige_familia_item = 1 en la compañía Neko.
4. Concede "Mantener Familias" a los usuarios que ya pueden modificar ítems.

Los ítems sin familia en el mapeo (licra ACANALADA) quedan sin asignar y se
listan en el log para resolución manual. NO se tocan Item Price (ya están cargados).
"""
import frappe

COMPANY = "Neko"

FAMILIES = [
    {"familia": "PL-O-02", "descripcion": "Playera niño 2-12", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 192.0], ["Lista P. Mayorista (LP-MAY)", 180.0], ["Lista P. Distribuidor (LP-DIS)", 156.0], ["Lista P. Contra Entrega (LP-COD)", 204.0]]},
    {"familia": "PL-O-O1", "descripcion": "Playera niño 2-6", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 192.0], ["Lista P. Mayorista (LP-MAY)", 180.0], ["Lista P. Distribuidor (LP-DIS)", 156.0], ["Lista P. Contra Entrega (LP-COD)", 204.0]]},
    {"familia": "PL-A-A1", "descripcion": "Playera niña 4-8", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 192.0], ["Lista P. Mayorista (LP-MAY)", 180.0], ["Lista P. Distribuidor (LP-DIS)", 156.0], ["Lista P. Contra Entrega (LP-COD)", 204.0]]},
    {"familia": "PL-A-A2", "descripcion": "Playera niña 4-12", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 192.0], ["Lista P. Mayorista (LP-MAY)", 180.0], ["Lista P. Distribuidor (LP-DIS)", 156.0], ["Lista P. Contra Entrega (LP-COD)", 204.0]]},
    {"familia": "PL-B1", "descripcion": "Playera meses niño/niña 9-18", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 192.0], ["Lista P. Mayorista (LP-MAY)", 180.0], ["Lista P. Distribuidor (LP-DIS)", 144.0], ["Lista P. Contra Entrega (LP-COD)", 204.0]]},
    {"familia": "PL-M-D1", "descripcion": "Playera dama S-L", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 216.0], ["Lista P. Mayorista (LP-MAY)", 204.0], ["Lista P. Distribuidor (LP-DIS)", 180.0], ["Lista P. Contra Entrega (LP-COD)", 228.0]]},
    {"familia": "CT-M-D2", "descripcion": "Croptop dama S-M", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 204.0], ["Lista P. Mayorista (LP-MAY)", 168.0], ["Lista P. Contra Entrega (LP-COD)", 216.0]]},
    {"familia": "DB-O-O3", "descripcion": "Playera niño doble serigrafía 2-8", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 204.0], ["Lista P. Contra Entrega (LP-COD)", 216.0]]},
    {"familia": "ML-A", "descripcion": "Manga larga niño/niña", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 150.0], ["Lista P. Contra Entrega (LP-COD)", 162.0]]},
    {"familia": "LI-A-L4", "descripcion": "Licra niña campana 2-12", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 216.0], ["Lista P. Mayorista (LP-MAY)", 204.0], ["Lista P. Contra Entrega (LP-COD)", 228.0]]},
    {"familia": "LI-B1", "descripcion": "Licra campana meses", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 180.0], ["Lista P. Mayorista (LP-MAY)", 168.0], ["Lista P. Contra Entrega (LP-COD)", 192.0]]},
    {"familia": "VE-A-A3", "descripcion": "Vestido niña 2-8", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 300.0], ["Lista P. Contra Entrega (LP-COD)", 312.0]]},
    {"familia": "VE-A-B2", "descripcion": "Vestido meses niña 9-24", "uom": "Docena", "precios": [["Lista P. General (LP-GEN)", 276.0], ["Lista P. Contra Entrega (LP-COD)", 288.0]]},
    {"familia": "PL-SURTIDO", "descripcion": "(surtido / por unidad)", "uom": "Unidad", "precios": [["Lista P. General (LP-GEN)", 16.0]]},
    {"familia": "PL-M-D1 SURTIDA", "descripcion": "(surtido / por unidad)", "uom": "Unidad", "precios": [["Lista P. General (LP-GEN)", 18.0]]},
    {"familia": "PL-H-C1 SURTIDO", "descripcion": "(surtido / por unidad)", "uom": "Unidad", "precios": [["Lista P. General (LP-GEN)", 20.0]]},
    {"familia": "CT-M-D2 SURTIDO", "descripcion": "(surtido / por unidad)", "uom": "Unidad", "precios": [["Lista P. General (LP-GEN)", 17.0]]},
    {"familia": "VE-A-SURTIDA", "descripcion": "(surtido / por unidad)", "uom": "Unidad", "precios": [["Lista P. General (LP-GEN)", 25.0]]},
    {"familia": "VE-A-B2 SURTIDO", "descripcion": "(surtido / por unidad)", "uom": "Unidad", "precios": [["Lista P. General (LP-GEN)", 22.0]]},
    {"familia": "LI-B1 SURTIDO", "descripcion": "(surtido / por unidad)", "uom": "Unidad", "precios": [["Lista P. General (LP-GEN)", 15.0]]},
    {"familia": "LI-A-L4 SURTIDO", "descripcion": "(surtido / por unidad)", "uom": "Unidad", "precios": [["Lista P. General (LP-GEN)", 18.0]]},
]

SKU_FAMILIA = {
    "CT-M-D2": "CT-M-D2",
    "CT-M-SURTIDO": "CT-M-D2 SURTIDO",
    "DB-O-01": "DB-O-O3",
    "LI-A-ACAN-L6": None,
    "LI-A-ACAN-SURTIDO-L6": None,
    "LI-A-CAMP-L4": "LI-A-L4",
    "LI-A-CAMP-B1": "LI-B1",
    "LI-A-CAMP-SURTIDO-B1": "LI-B1 SURTIDO",
    "LI-A-CAMP-SURTIDO-L4": "LI-A-L4 SURTIDO",
    "ML-O-O2": "ML-A",
    "PL-A SKY06-A1": "PL-A-A1",
    "PL-A-B1": "PL-B1",
    "PL-A-BARB09-A2": "PL-A-A2",
    "PL-A-BLUE04-A1": "PL-A-A1",
    "PL-A-BLUE06-A1": "PL-A-A1",
    "PL-A-CAPY07-A2": "PL-A-A2",
    "PL-A-DALM01-A1": "PL-A-A1",
    "PL-A-DALM02-A1": "PL-A-A1",
    "PL-A-FLAM03-A1": "PL-A-A1",
    "PL-A-FROZ06-A2": "PL-A-A2",
    "PL-A-GATO04-A1": "PL-A-A1",
    "PL-A-GM02-A2": "PL-A-A2",
    "PL-A-GUES01-A2": "PL-A-A2",
    "PL-A-HUNT04-A2": "PL-A-A2",
    "PL-A-HUNT06-A2": "PL-A-A2",
    "PL-A-HUNT08-A2": "PL-A-A2",
    "PL-A-HUNT09-A2": "PL-A-A2",
    "PL-A-KITY06-A2": "PL-A-A2",
    "PL-A-KITY07-A2": "PL-A-A2",
    "PL-A-KURO02-A2": "PL-A-A2",
    "PL-A-KURO05-A2": "PL-A-A2",
    "PL-A-LABU01-A2": "PL-A-A2",
    "PL-A-LADY03-A2": "PL-A-A2",
    "PL-A-MARI06-A2": "PL-A-A2",
    "PL-A-MARIO18-A1": "PL-A-A1",
    "PL-A-MASH02-A1": "PL-A-A1",
    "PL-A-MIN11-A2": "PL-A-A2",
    "PL-A-MIN12-A2": "PL-A-A2",
    "PL-A-MIN13-A2": "PL-A-A2",
    "PL-A-MIN20-A2": "PL-A-A2",
    "PL-A-PAND03-A2": "PL-A-A2",
    "PL-A-PEAC03-A2": "PL-A-A2",
    "PL-A-PEPA05-A1": "PL-A-A1",
    "PL-A-POOH01-A2": "PL-A-A2",
    "PL-A-PRIN02-A2": "PL-A-A2",
    "PL-A-PRIN04-A2": "PL-A-A2",
    "PL-A-SIR06-A2": "PL-A-A2",
    "PL-A-SIR07-A2": "PL-A-A2",
    "PL-A-SIR09-A2": "PL-A-A2",
    "PL-A-SKY13-A1": "PL-A-A1",
    "PL-A-SKY15-A1": "PL-A-A1",
    "PL-A-SNPY02-A2": "PL-A-A2",
    "PL-A-STIC15-A2": "PL-A-A2",
    "PL-A-SURTIDO": "PL-SURTIDO",
    "PL-A-TOY01-A2": "PL-A-A2",
    "PL-A-UNI02-A2": "PL-A-A2",
    "PL-A-UNI16-A2": "PL-A-A2",
    "PL-A-UNI17-A2": "PL-A-A2",
    "PL-H-SURTIDO": "PL-H-C1 SURTIDO",
    "PL-M-DIOR01-D1": "PL-M-D1",
    "PL-M-GUES01-D1": "PL-M-D1",
    "PL-M-KARL02-D1": "PL-M-D1",
    "PL-M-POLO06-D1": "PL-M-D1",
    "PL-M-SURTIDO": "PL-M-D1 SURTIDA",
    "PL-M-TOMY02.D1": "PL-M-D1",
    "PL-O-AVEN03-O2": "PL-O-02",
    "PL-O-B1": "PL-B1",
    "PL-O-BOB02-O2": "PL-O-02",
    "PL-O-CAP04-O2": "PL-O-02",
    "PL-O-CAPY13-O2": "PL-O-02",
    "PL-O-CARS05-O1": "PL-O-O1",
    "PL-O-CARS07-O1": "PL-O-O1",
    "PL-O-DINO06-O2": "PL-O-02",
    "PL-O-DINO08-O2": "PL-O-02",
    "PL-O-DINO13-O1": "PL-O-O1",
    "PL-O-DINO16-O2": "PL-O-02",
    "PL-O-DINO17-O2": "PL-O-02",
    "PL-O-DINO18-O1": "PL-O-O1",
    "PL-O-DINO18-O2": "PL-O-02",
    "PL-O-DINO19-O2": "PL-O-02",
    "PL-O-HOTW02-O2": "PL-O-02",
    "PL-O-IRON03-O2": "PL-O-02",
    "PL-O-JERRY03-O2": "PL-O-02",
    "PL-O-LOON01-O2": "PL-O-02",
    "PL-O-MARIO10-O2": "PL-O-02",
    "PL-O-MARIO17-O2": "PL-O-02",
    "PL-O-MARIO18-O2": "PL-O-02",
    "PL-O-MARIO19-O2": "PL-O-02",
    "PL-O-MARIO21-O2": "PL-O-02",
    "PL-O-MICK03-O1": "PL-O-O1",
    "PL-O-MICK18-O1": "PL-O-O1",
    "PL-O-MINE01-O2": "PL-O-02",
    "PL-O-MINIO01-O2": "PL-O-02",
    "PL-O-MINIO02-O2": "PL-O-02",
    "PL-O-NARU02-O2": "PL-O-02",
    "PL-O-PAW24-O1": "PL-O-O1",
    "PL-O-PLIM01-O1": "PL-O-O1",
    "PL-O-POKE03-O2": "PL-O-02",
    "PL-O-POKE05-O2": "PL-O-02",
    "PL-O-ROBL02-O2": "PL-O-02",
    "PL-O-ROBL03-O2": "PL-O-02",
    "PL-O-ROBL04-O2": "PL-O-02",
    "PL-O-SHARK02-O1": "PL-O-O1",
    "PL-O-SNPY04-O2": "PL-O-02",
    "PL-O-SNPY05-O2": "PL-O-02",
    "PL-O-SNPY06-O2": "PL-O-02",
    "PL-O-SONI13-O2": "PL-O-02",
    "PL-O-SONI16-O2": "PL-O-02",
    "PL-O-SPIN09-O2": "PL-O-02",
    "PL-O-SPIN13-O2": "PL-O-02",
    "PL-O-SPIN16-O2": "PL-O-02",
    "PL-O-SPIN18-O2": "PL-O-02",
    "PL-O-SPIN19-O2": "PL-O-02",
    "PL-O-SUPR01-O2": "PL-O-02",
    "PL-O-SURTIDO": "PL-SURTIDO",
    "PL-O-TOY01-O2": "PL-O-02",
    "PL-O-TOY02-O2": "PL-O-02",
    "PL-O-TOY03-O2": "PL-O-02",
    "VE-A-A1": "VE-A-A3",
    "VE-A-B1": "VE-A-B2",
    "VE-A-SURTIDO": "VE-A-SURTIDA",
    "VE-A-SURTIDO-B1": "VE-A-B2 SURTIDO",
}



def _norm(x):
    import re
    if not x:
        return x
    x = re.sub(r"\s+", " ", str(x)).strip()
    return re.sub(r"\s*-\s*", "-", x)


def execute():
    if not frappe.db.exists("Company", COMPANY):
        return

    from facex_multi.api.familia import ensure_item_familia_field
    ensure_item_familia_field()

    # ---- 1. Familias ----
    fam_ok = 0
    for f in FAMILIES:
        name = _norm(f["familia"])
        if frappe.db.exists("FacEx Familia de Precio", name):
            doc = frappe.get_doc("FacEx Familia de Precio", name)
        else:
            doc = frappe.new_doc("FacEx Familia de Precio")
            doc.familia = name
        doc.bfel_company = COMPANY
        doc.descripcion = f.get("descripcion") or ""
        doc.uom = f["uom"]
        doc.activa = 1
        doc.set("precios", [])
        for price_list, rate in f["precios"]:
            if frappe.db.exists("Price List", price_list):
                doc.append("precios", {"price_list": price_list, "price_list_rate": rate})
        doc.flags.ignore_permissions = True
        doc.save()
        fam_ok += 1

    # ---- 2. Asignación a ítems ----
    asignados, sin_familia, no_item = [], [], []
    for sku, familia in SKU_FAMILIA.items():
        if not frappe.db.exists("Item", sku):
            no_item.append(sku)
            continue
        if not familia:
            sin_familia.append(sku)
            continue
        familia = _norm(familia)
        if not frappe.db.exists("FacEx Familia de Precio", familia):
            sin_familia.append(f"{sku} (familia {familia} inexistente)")
            continue
        current_company = frappe.db.get_value("Item", sku, "bfel_company")
        updates = {"custom_facex_familia": familia}
        if not current_company:
            updates["bfel_company"] = COMPANY
        frappe.db.set_value("Item", sku, updates, update_modified=False)
        asignados.append(sku)

    # ---- 3. Política de compañía ----
    row = frappe.db.get_value(
        "FacEx Settings", {"bfel_company": COMPANY, "user": ["is", "not set"]}, "name"
    )
    if row:
        frappe.db.set_value("FacEx Settings", row, "exige_familia_item", 1)

    # ---- 4. Permiso a quienes ya modifican ítems ----
    con_perm = frappe.get_all(
        "FacEx Settings",
        filters={"bfel_company": COMPANY, "modifica_items": 1},
        fields=["name"],
    )
    for r in con_perm:
        frappe.db.set_value("FacEx Settings", r.name,
                            {"mantiene_familias": 1, "consulta_familias": 1})

    frappe.db.commit()

    msg = (
        f"[backfill_neko_familias] familias={fam_ok} "
        f"items_asignados={len(asignados)} "
        f"sin_familia={sin_familia} "
        f"sku_sin_item={no_item} "
        f"usuarios_con_permiso={[r.name for r in con_perm]}"
    )
    print(msg)
    frappe.logger().info(msg)
