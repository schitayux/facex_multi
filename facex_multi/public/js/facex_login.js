(function() {
	'use strict';

	console.log("[FacEx Branding] Script loaded");

	// Run only if the login form elements are present in the DOM
	var emailInput = document.getElementById('login_email');
	var loginForm = document.querySelector('.form-signin');
	if (!emailInput && !loginForm) {
		console.log("[FacEx Branding] Login form elements not found, exiting");
		return;
	}

	var defaultLogo = "/assets/facex_multi/facex_branding/facex-default.png";
	var brandingData = null;

	// XSS Safe DOM updates helper
	function applyBranding(data) {
		console.log("[FacEx Branding] Applying branding:", data);

		// 1. Update logos
		var logoUrl = (data && data.logo) ? data.logo : defaultLogo;
		var logos = document.querySelectorAll('img.app-logo');
		console.log("[FacEx Branding] Found logo elements:", logos.length, "Setting src to:", logoUrl);
		logos.forEach(function(img) {
			img.setAttribute('src', logoUrl);
		});

		// 2. Update welcome headings (h4)
		var headings = document.querySelectorAll('.page-card-head h4');
		console.log("[FacEx Branding] Found heading elements:", headings.length);
		headings.forEach(function(h4) {
			if (data && data.welcome_text) {
				// Store original text if not already stored
				if (!h4.getAttribute('data-original-text')) {
					h4.setAttribute('data-original-text', h4.textContent);
				}
				h4.textContent = data.welcome_text;
			} else {
				// Restore original text
				var originalText = h4.getAttribute('data-original-text');
				if (originalText) {
					h4.textContent = originalText;
				}
			}
		});

		// 3. Update primary buttons styling
		var buttons = document.querySelectorAll('.btn-primary, .btn-login');
		console.log("[FacEx Branding] Found button elements:", buttons.length);
		buttons.forEach(function(btn) {
			if (data && data.primary_color) {
				btn.style.backgroundColor = data.primary_color;
				btn.style.borderColor = data.primary_color;
			} else {
				btn.style.backgroundColor = '';
				btn.style.borderColor = '';
			}
		});
	}

	// Safely add "Powered by FacEx | CHAPPSA" footer
	function addPoweredByFooter() {
		var cards = document.querySelectorAll('.login-content.page-card');
		console.log("[FacEx Branding] Found card elements for footer:", cards.length);
		cards.forEach(function(card) {
			if (!card.querySelector('.powered-by-facex')) {
				var p = document.createElement('p');
				p.className = 'powered-by-facex text-center text-muted small mt-3';
				p.style.fontSize = '12px';
				p.style.marginTop = '15px';
				p.textContent = 'Powered by FacEx | CHAPPSA';
				card.appendChild(p);
				console.log("[FacEx Branding] Added Powered by footer");
			}
		});
	}

	// Validate entered email domain against branding rules
	function validateEmailDomain() {
		var emailInput = document.getElementById('login_email');
		if (!emailInput) return;

		var email = emailInput.value.trim();
		console.log("[FacEx Branding] Email input changed:", email);
		if (!email) {
			// Show subdomain branding if email is empty
			applyBranding(brandingData);
			return;
		}

		// Extract domain from email
		var atIndex = email.lastIndexOf('@');
		if (atIndex === -1 || atIndex === email.length - 1) {
			applyBranding(brandingData);
			return;
		}

		var domain = email.substring(atIndex + 1).toLowerCase();

		// Check if domains restrictions exist
		if (brandingData && brandingData.allowed_email_domains && brandingData.allowed_email_domains.length > 0) {
			var isAllowed = brandingData.allowed_email_domains.some(function(allowedDomain) {
				var cleanAllowed = allowedDomain.trim().toLowerCase();
				return domain === cleanAllowed || domain.endsWith('.' + cleanAllowed);
			});

			console.log("[FacEx Branding] Domain check result for " + domain + ": " + isAllowed);

			if (!isAllowed) {
				// Revert to default branding if email domain does not match
				applyBranding(null);
			} else {
				// Restore client branding
				applyBranding(brandingData);
			}
		} else {
			// No restrictions configured, keep subdomain branding
			applyBranding(brandingData);
		}
	}

	// If this domain is configured with a post-login landing path, inject it as
	// the standard Frappe `redirect-to` query arg so login.js sends the user there
	// on a successful login. Only registered users of this site can log in, so
	// this effectively only redirects them. A `redirect-to` already present (e.g.
	// the user deep-linked to a page while logged out) is always respected.
	function maybeSetPostLoginRedirect(data) {
		if (!data || !data.enabled) return;

		var target = (data.redirect_after_login || "").trim();
		// internal absolute paths only ("/app/facex"), never protocol-relative ("//evil")
		if (target.charAt(0) !== '/' || target.charAt(1) === '/') return;

		var existing = "";
		try { existing = frappe.utils.get_url_arg('redirect-to') || ""; } catch (e) {}
		if (existing) {
			console.log("[FacEx Branding] redirect-to already set, keeping:", existing);
			return;
		}

		try {
			var url = new URL(window.location.href);
			url.searchParams.set('redirect-to', target);
			window.history.replaceState(null, '', url.toString());
			console.log("[FacEx Branding] Post-login redirect set to:", target);
		} catch (e) {
			console.warn("[FacEx Branding] Could not set post-login redirect:", e);
		}
	}

	var retries = 0;
	function initBranding() {
		if (typeof frappe === 'undefined' || !frappe.call) {
			retries++;
			if (retries < 100) { // Retry for up to 5 seconds
				setTimeout(initBranding, 50);
			} else {
				console.error("[FacEx Branding] frappe.call is not available after 5 seconds");
			}
			return;
		}

		console.log("[FacEx Branding] Initializing branding after", retries, "retries");
		addPoweredByFooter();

		frappe.call({
			method: 'facex_multi.api.branding.get_login_branding',
			callback: function(r) {
				console.log("[FacEx Branding] API response:", r);
				if (r.message) {
					maybeSetPostLoginRedirect(r.message);
					brandingData = r.message.enabled ? r.message : null;
					applyBranding(brandingData);

					// Bind event listeners to check email field
					var emailInput = document.getElementById('login_email');
					if (emailInput) {
						emailInput.addEventListener('input', validateEmailDomain);
						emailInput.addEventListener('change', validateEmailDomain);
						emailInput.addEventListener('blur', validateEmailDomain);
						console.log("[FacEx Branding] Event listeners bound to #login_email");
					} else {
						console.warn("[FacEx Branding] #login_email element not found to bind listeners");
					}
				}
			}
		});
	}

	// Hook into default login rendered events
	if (typeof jQuery !== 'undefined') {
		jQuery(document).ready(function() {
			jQuery(document).on('login_rendered', initBranding);
			// Run immediately if already visible
			if (jQuery('.for-login').is(':visible')) {
				initBranding();
			}
		});
	} else {
		// Fallback vanilla JS load
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', initBranding);
		} else {
			initBranding();
		}
	}
})();
