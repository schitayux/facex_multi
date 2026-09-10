import frappe
from frappe.model.document import Document
from frappe.utils import flt


class FacExFamiliadePrecio(Document):
    def validate(self):
        self.familia = (self.familia or "").strip()
        if not self.familia:
            frappe.throw("El código de la familia es obligatorio.")

        # Normalizar: colapsar espacios internos y quitar espacios alrededor de guiones.
        import re
        self.familia = re.sub(r"\s+", " ", self.familia).strip()
        self.familia = re.sub(r"\s*-\s*", "-", self.familia)

        seen = set()
        for row in self.precios or []:
            if not row.price_list:
                continue
            if row.price_list in seen:
                frappe.throw(f"La lista de precios «{row.price_list}» está repetida en la tabla de precios.")
            seen.add(row.price_list)
            if flt(row.price_list_rate) < 0:
                frappe.throw(f"El precio para «{row.price_list}» no puede ser negativo.")

        if flt(self.costo_estandar) < 0:
            frappe.throw("El costo estándar no puede ser negativo.")

    def on_trash(self):
        count = frappe.db.count("Item", {"custom_facex_familia": self.name})
        if count:
            frappe.throw(
                f"No se puede eliminar la familia «{self.name}»: {count} ítem(s) la tienen asignada. "
                "Reasigne esos ítems primero."
            )
