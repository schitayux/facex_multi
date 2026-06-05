# Copyright (c) 2026, CHAPPSA and contributors
# For license information, please see license.txt

import re
import frappe

@frappe.whitelist(allow_guest=True)
def get_login_branding():
	# 1. Read host safely from the request headers
	host = getattr(frappe.local, "request", None) and frappe.local.request.host
	if not host:
		return {
			"enabled": False,
			"logo": "/assets/facex_multi/facex_branding/facex-default.png"
		}

	# Remove port if present
	if ":" in host:
		host = host.split(":")[0]

	# Sanitize the host string: only allow standard domain name characters to prevent header injection or traversal
	host = re.sub(r"[^a-zA-Z0-9\.\-]", "", host).lower()

	# 2. Query branding configuration from the database using ORM parameterization
	try:
		branding_name = frappe.db.get_value("FacEx Domain Branding", {"domain": host, "enabled": 1}, "name")
	except Exception:
		# Fallback if table doesn't exist yet or other query errors
		return {
			"enabled": False,
			"logo": "/assets/facex_multi/facex_branding/facex-default.png"
		}

	if branding_name:
		doc = frappe.get_doc("FacEx Domain Branding", branding_name)

		# 3. Resolve logo priority hierarchy
		logo_url = None

		# - A: Custom Logo Override (Priority 1)
		if doc.custom_logo:
			logo_url = doc.custom_logo

		# - B: Company Logo (Priority 2)
		if not logo_url and doc.company:
			logo_url = frappe.db.get_value("Company", doc.company, "company_logo")

		# - C: Associated Default Letter Head Logo (Priority 3)
		if not logo_url and doc.company:
			default_letter_head = frappe.db.get_value("Company", doc.company, "default_letter_head")
			if default_letter_head:
				logo_url = frappe.db.get_value("Letter Head", default_letter_head, "image")

		# - D: Legacy Repo Logo Path fallback (Priority 4)
		if not logo_url and doc.repo_logo_path:
			logo_url = doc.repo_logo_path

		# - E: Default FacEx logo fallback (Priority 5)
		if not logo_url:
			logo_url = "/assets/facex_multi/facex_branding/facex-default.png"

		# Parse allowed email domains into a clean list
		allowed_domains = []
		if doc.allowed_email_domains:
			allowed_domains = [d.strip() for d in doc.allowed_email_domains.split(",") if d.strip()]

		return {
			"enabled": True,
			"domain": doc.domain,
			"company": doc.company,
			"logo": logo_url,
			"primary_color": doc.primary_color or "",
			"welcome_text": doc.welcome_text or "",
			"allowed_email_domains": allowed_domains
		}
	else:
		return {
			"enabled": False,
			"logo": "/assets/facex_multi/facex_branding/facex-default.png"
		}
