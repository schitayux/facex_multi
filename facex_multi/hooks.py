app_name = "facex_multi"
app_title = "FacEx Multi"
app_publisher = "CHAPPSA"
app_description = "Interfaz rápida tipo POS para Sales Invoice con certificación FEL"
app_email = "soporte@chappsa.com"
app_license = "mit"

# La Page se auto-descubre desde facex_multi/facex_multi/page/facex/
# DocType eFast Invoice Payment (tabla hija para pagos) se auto-descubre desde doctype/

override_doctype_class = {
    "Supplier": "facex_multi.overrides.supplier.FacexSupplier"
}

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
    },
    "Item": {
        "before_save": "facex_multi.api.item.sync_description_from_item_name"
    },
    "Sales Invoice": {
        "before_insert": "facex_multi.api.invoice.fix_abbr_in_naming_series"
    }
}

after_migrate = [
    "facex_multi.api.permissions.ensure_stock_entry_permissions",
    "facex_multi.api.permissions.ensure_stock_entry_naming_series",
    "facex_multi.api.permissions.ensure_warehouse_establecimiento_field"
]

fixtures = [
    {
        "dt": "Custom DocPerm",
        "filters": [
            ["parent", "=", "Stock Entry"],
            ["role", "in", ["Sales User", "Accounts User", "Sales Manager", "Accounts Manager", "System Manager", "facex_multi"]]
        ]
    },
    {
        "dt": "Property Setter",
        "filters": [
            ["doc_type", "=", "Stock Entry"],
            ["field_name", "=", "naming_series"]
        ]
    },

    {
        # Solo los formatos base de FACEX (compañía de pruebas) se versionan
        # como fixture. Los clones "- ABBR" de las demás compañías son
        # ambientes productivos y se editan en vivo; si se incluyeran aquí,
        # cada "bench migrate" los revertiría al contenido del repo.
        "dt": "Print Format",
        "filters": [
            [
                "module",
                "=",
                "FacEx Multi"
            ],
            [
                "bfel_company",
                "=",
                "FACEX"
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
    },
    {
        "dt": "Client Script",
        "filters": [
            ["name", "like", "bfel-company-null-%"]
        ]
    }

]

web_include_js = "/assets/facex_multi/js/facex_login.js"

