"""
facex_multi.api.compras
-----------------------
Backend del page FacEx Compras (/app/facex-compras). Ciclo de compra estilo
SAP B1 sobre los documentos nativos de ERPNext:

    common.py    helpers compartidos + arranque del page (get_compras_defaults)
    facturas.py  Factura de Compra (Purchase Invoice)

Toda la lógica contable/stock queda en ERPNext: aquí solo se arman los
documentos y se aplican los permisos FacEx.
"""
