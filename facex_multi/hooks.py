app_name = "facex_multi"
app_title = "FacEx Multi"
app_publisher = "CHAPPSA"
app_description = "Interfaz rápida tipo POS para Sales Invoice con certificación FEL"
app_email = "soporte@chappsa.com"
app_license = "mit"

# La Page se auto-descubre desde facex_multi/facex_multi/page/facex/
# DocType eFast Invoice Payment (tabla hija para pagos) se auto-descubre desde doctype/

# Roles que aparecerán en el menú de la app (opcional)
# add_to_apps_screen = [
#     {
#         "name": "facex_multi",
#         "logo": "/assets/facex_multi/images/logo.png",
#         "title": "FacEx Multi",
#         "route": "/facex-multi",
#         "has_permission": "facex_multi.api.invoice.has_efast_permission",
#     }
# ]

doc_events = {
    "Customer": {
        "validate": "facex_multi.api.customer.validate_customer_on_save"
    }
}
fixtures = [

    {
        "dt": "Print Format",
        "filters": [
            [
                "module",
                "=",
                "FacEx Multi"
            ]
        ]
    },
    {
        "dt": "Custom Field",
        "filters": [
            ["fieldname", "like", "bfel_%"]
        ]
    },
    {
        "dt": "Property Setter",
        "filters": [
            ["field_name", "like", "bfel_%"]
        ]
    }

]

web_include_js = "/assets/facex_multi/js/facex_login.js"

