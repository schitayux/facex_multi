# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import frappe
from frappe.model.document import Document

class FacExDomainBranding(Document):
	def validate(self):
		if self.auto_configure:
			if self.auto_configured:
				frappe.throw("La auto configuración ya fue ejecutada para este dominio y solo se permite una única ejecución.")

			# Execute the auto-configuration
			summary = execute_auto_configuration(self)
			self.auto_configure_summary = summary
			self.auto_configured = 1
			self.auto_configure = 0  # Reset checkbox so it does not trigger again

def execute_auto_configuration(doc):
	if not doc.company:
		frappe.throw("Por favor seleccione una Compañía para realizar la auto configuración.")

	company_name = doc.company
	# Retrieve company details
	if not frappe.db.exists("Company", company_name):
		frappe.throw(f"La compañía '{company_name}' no existe en el sistema.")

	company_doc = frappe.get_doc("Company", company_name)
	abbr = company_doc.abbr
	if not abbr:
		frappe.throw(f"La compañía '{company_name}' no tiene configurada una abreviatura (ABBR).")

	summary_lines = [
		f"--- RESUMEN DE AUTO CONFIGURACIÓN PARA: {company_name} ({abbr}) ---",
		""
	]

	# 1. ITEM GROUPS (GRUPOS DE ARTÍCULOS)
	# Root Group: Name of Company, parent: All Item Groups
	parent_ig_name = company_name
	if not frappe.db.exists("Item Group", parent_ig_name):
		parent_ig = frappe.get_doc({
			"doctype": "Item Group",
			"item_group_name": parent_ig_name,
			"parent_item_group": "All Item Groups",
			"is_group": 1,
			"bfel_company": company_name
		})
		parent_ig.insert(ignore_permissions=True)
		summary_lines.append(f"[✓] Grupo de Artículos Raíz creado: '{parent_ig_name}' bajo 'All Item Groups'")
	else:
		summary_lines.append(f"[i] Grupo de Artículos Raíz ya existía: '{parent_ig_name}'")

	# Child Group 1: Artículo - ABBR
	child1_name = f"Artículo - {abbr}"
	if not frappe.db.exists("Item Group", child1_name):
		child1 = frappe.get_doc({
			"doctype": "Item Group",
			"item_group_name": child1_name,
			"parent_item_group": parent_ig_name,
			"is_group": 0,
			"bfel_company": company_name
		})
		child1.insert(ignore_permissions=True)
		summary_lines.append(f"[✓] Grupo de Artículos Hijo creado: '{child1_name}' bajo '{parent_ig_name}'")
	else:
		summary_lines.append(f"[i] Grupo de Artículos Hijo ya existía: '{child1_name}'")

	# Child Group 2: Servicio - ABBR
	child2_name = f"Servicio - {abbr}"
	if not frappe.db.exists("Item Group", child2_name):
		child2 = frappe.get_doc({
			"doctype": "Item Group",
			"item_group_name": child2_name,
			"parent_item_group": parent_ig_name,
			"is_group": 0,
			"bfel_company": company_name
		})
		child2.insert(ignore_permissions=True)
		summary_lines.append(f"[✓] Grupo de Artículos Hijo creado: '{child2_name}' bajo '{parent_ig_name}'")
	else:
		summary_lines.append(f"[i] Grupo de Artículos Hijo ya existía: '{child2_name}'")

	# 2. PRICE LIST (LISTA DE PRECIOS)
	price_list_name = f"Precio de Venta {abbr}"
	if not frappe.db.exists("Price List", price_list_name):
		pl = frappe.get_doc({
			"doctype": "Price List",
			"price_list_name": price_list_name,
			"enabled": 1,
			"selling": 1,
			"buying": 0,
			"bfel_company": company_name
		})
		pl.insert(ignore_permissions=True)
		summary_lines.append(f"[✓] Lista de Precios creada: '{price_list_name}'")
	else:
		summary_lines.append(f"[i] Lista de Precios ya existía: '{price_list_name}'")

	# 3. PRINT FORMATS (FORMATOS DE IMPRESIÓN)
	# Duplicar desde FACEX (base: 'FAC CERTIFI', 'Recibo de Pago FacEx', 'Cotización FacEx', 'FAC FEL')
	base_pfs = ['FAC CERTIFI', 'Recibo de Pago FacEx', 'Cotización FacEx', 'FAC FEL']
	for base_pf_name in base_pfs:
		target_pf_name = f"{base_pf_name} - {abbr}"
		if not frappe.db.exists("Print Format", target_pf_name):
			if frappe.db.exists("Print Format", base_pf_name):
				base_pf = frappe.get_doc("Print Format", base_pf_name)
				new_pf = frappe.copy_doc(base_pf)
				new_pf.name = target_pf_name
				new_pf.print_format_name = target_pf_name
				new_pf.bfel_company = company_name
				new_pf.insert(ignore_permissions=True)
				summary_lines.append(f"[✓] Formato de Impresión duplicado: '{target_pf_name}'")
			else:
				summary_lines.append(f"[✗] Formato base '{base_pf_name}' no encontrado. No se pudo duplicar.")
		else:
			summary_lines.append(f"[i] Formato de Impresión ya existía: '{target_pf_name}'")

	# 4. TAXES (IMPUESTOS IVA / EXE)
	# Naming: IVA - ABBR and EXE - ABBR
	tax_account = f"IVA - {abbr}"
	# Check if the tax account exists. If not, inform user in summary
	if not frappe.db.exists("Account", tax_account):
		summary_lines.append(f"[i] Cuenta contable de impuestos '{tax_account}' no encontrada en el Catálogo. Se creará la plantilla pero verifique la cuenta contable.")

	# IVA Template
	iva_template_name = f"IVA - {abbr}"
	if not frappe.db.exists("Sales Taxes and Charges Template", iva_template_name):
		iva_temp = frappe.get_doc({
			"doctype": "Sales Taxes and Charges Template",
			"title": iva_template_name,
			"company": company_name,
			"is_default": 1,
			"taxes": [
				{
					"charge_type": "On Net Total",
					"account_head": tax_account if frappe.db.exists("Account", tax_account) else None,
					"rate": 12.0,
					"description": "IVA"
				}
			]
		})
		iva_temp.insert(ignore_permissions=True)
		summary_lines.append(f"[✓] Plantilla de Impuestos creada: '{iva_template_name}' (Tasa: 12%)")
	else:
		summary_lines.append(f"[i] Plantilla de Impuestos ya existía: '{iva_template_name}'")

	# EXE Template
	exe_template_name = f"EXE - {abbr}"
	if not frappe.db.exists("Sales Taxes and Charges Template", exe_template_name):
		exe_temp = frappe.get_doc({
			"doctype": "Sales Taxes and Charges Template",
			"title": exe_template_name,
			"company": company_name,
			"is_default": 0,
			"taxes": [
				{
					"charge_type": "On Net Total",
					"account_head": tax_account if frappe.db.exists("Account", tax_account) else None,
					"rate": 0.0,
					"description": "EXE"
				}
			]
		})
		exe_temp.insert(ignore_permissions=True)
		summary_lines.append(f"[✓] Plantilla de Impuestos Exentos creada: '{exe_template_name}' (Tasa: 0%)")
	else:
		summary_lines.append(f"[i] Plantilla de Impuestos Exentos ya existía: '{exe_template_name}'")

	# 5. EMPLOYEES / SALES PARTNER
	sp_name = f"Vendedor 1 - {abbr}"
	if not frappe.db.exists("Sales Partner", sp_name):
		sp = frappe.get_doc({
			"doctype": "Sales Partner",
			"partner_name": sp_name,
			"partner_type": "Agent",
			"bfel_company": company_name,
			"commission_rate": 100.0,
			"territory": "Guatemala"
		})
		sp.insert(ignore_permissions=True)
		summary_lines.append(f"[✓] Socio de Ventas (Vendedor) creado: '{sp_name}'")
	else:
		summary_lines.append(f"[i] Socio de Ventas ya existía: '{sp_name}'")

	# 6. BFEL SETTINGS
	new_settings_name = None
	# Check if already exists for this company
	existing_settings = frappe.db.get_value("BFEL Settings", {"company": company_name}, "name")
	if not existing_settings:
		base_settings_name = frappe.db.get_value("BFEL Settings", {"company": "FACEX"}, "name")
		if base_settings_name:
			base_settings = frappe.get_doc("BFEL Settings", base_settings_name)
			new_settings = frappe.copy_doc(base_settings)
			new_settings.name = None
			new_settings.company = company_name
			new_settings.nombrecomercial = f"{company_name} - (Modo de Prueba)"
			new_settings.nombreemisor = f"{company_name} - (Modo de Prueba)"
			new_settings.company_nit = company_doc.tax_id or base_settings.company_nit
			new_settings.insert(ignore_permissions=True)
			new_settings_name = new_settings.name
			summary_lines.append(f"[✓] BFEL Settings creado: '{new_settings_name}'")
			if not company_doc.tax_id:
				summary_lines.append(f"  [!] ADVERTENCIA: La compañía no tiene NIT configurado en ERPNext. Se usó el NIT de prueba '{base_settings.company_nit}'. Por favor, actualícelo en 'BFEL Settings'.")
		else:
			summary_lines.append(f"[✗] BFEL Settings base ('FACEX') no encontrado. No se pudo duplicar.")
	else:
		new_settings_name = existing_settings
		summary_lines.append(f"[i] BFEL Settings ya existía para esta compañía: '{new_settings_name}'")

	# 7. BFEL DOCUMENT MAP
	# Duplicate maps linked to base_settings (6o1tskl319) pointing to new settings
	if new_settings_name:
		base_settings_name = frappe.db.get_value("BFEL Settings", {"company": "FACEX"}, "name")
		if base_settings_name:
			base_maps = frappe.get_all("BFEL Document Map", filters={"bfel_settings": base_settings_name}, fields=["name"])
			duplicated_count = 0
			for bm in base_maps:
				base_map = frappe.get_doc("BFEL Document Map", bm.name)
				# Check if already exists for the new settings
				if not frappe.db.exists("BFEL Document Map", {"erpnext_doctype": base_map.erpnext_doctype, "bfel_settings": new_settings_name}):
					new_map = frappe.copy_doc(base_map)
					new_map.name = None
					new_map.bfel_settings = new_settings_name
					new_map.insert(ignore_permissions=True)
					duplicated_count += 1
			if duplicated_count > 0:
				summary_lines.append(f"[✓] BFEL Document Maps duplicados: {duplicated_count} mapeos asociados a '{new_settings_name}'")
			else:
				summary_lines.append(f"[i] Los mapeos de documentos BFEL ya existían o no había mapeos base.")

	summary_lines.append("")
	summary_lines.append("--- CONFIGURACIÓN FINALIZADA CON ÉXITO ---")

	return "\n".join(summary_lines)
