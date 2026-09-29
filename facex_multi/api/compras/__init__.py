"""
facex_multi.api.compras
-----------------------
Backend del page FacEx Compras (/app/facex-compras). Ciclo de compra estilo
SAP B1 sobre los documentos nativos de ERPNext:

    common.py      helpers compartidos + arranque del page (get_compras_defaults)
                   + «Validado por» (custom field + hook on_submit)
    documentos.py  Orden de Compra / Entrada de Mercadería / Factura de Compra:
                   lista, lectura, grabar, validar, cancelar, eliminar,
                   crear desde (OC → Entrada / Factura, Entrada → Factura)
    facturas.py    búsquedas, carga de Excel y alias históricos de la factura

Formatos de impresión: templates/print_formats/facex_compra.html (común a los
tres Print Formats «FacEx Orden de Compra / Entrada de Mercaderia / Factura de
Compra»).

Toda la lógica contable/stock queda en ERPNext: aquí solo se arman los
documentos y se aplican los permisos FacEx.
"""
