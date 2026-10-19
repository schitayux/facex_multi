# Alta de Item: «Es inventariable» e Imagen (Quick Entry nativo y FacEx Inventario)

Fecha: 2026-10-15

## Qué hace
Al crear un producto con el botón **Nuevo** del ERP (el diálogo rápido nativo de Item, también desde un campo Link) el diálogo ahora incluye:

- **Es inventariable** (`is_stock_item`). Se precarga según **Manejar Inventario** (`maneja_inventario`) de *FacEx Configuracion Compania* de la compañía efectiva del usuario: marcado si la compañía maneja inventario, desmarcado si no. El usuario puede cambiarlo.
- **Imagen** (`image`): botón nativo de adjuntar / cámara. Solo la imagen principal; las imágenes adicionales siguen en la pestaña «Imágenes» del form completo.

Aplica a todos los usuarios, sin permisos por usuario. Si algo falla (red, error del endpoint), el diálogo abre igual con el default de ERPNext.

## FacEx Inventario → Maestro de ítems → «+ Crear»
Mismo criterio en el form propio de FacEx:
- **Inventariable** de un producto nuevo se precarga con «Manejar Inventario» de la compañía (antes siempre abría desmarcado). Serie/Lote siguen forzándolo a marcado.
- **Imagen principal**: en «Imágenes del Producto» aparece el botón **Adjuntar Imagen** también al crear (antes solo decía «Guarde el producto…»). La imagen se sube, se muestra la vista previa (con «Quitar») y al guardar se asigna como `Item.image`. Al editar un producto existente nada cambia (carrusel, «Agregar Imagen», eliminar).
- Servidor (`create_or_update_item`, solo en alta): acepta `image` únicamente si es un File subido por el mismo usuario (no acepta URLs arbitrarias) y lo vincula al ítem (`attached_to`). Imagen inválida → error claro y el ítem no se crea.
- Archivos: [page/facex/facex.js](../facex_multi/facex_multi/page/facex/facex.js) (`_maint_load_item_images`, `_clear_maint_item_form`, `_save_maint_item`) y [api/item.py](../facex_multi/api/item.py).
- Despliegue: solo código; `bench restart` y Ctrl+Shift+R (no requiere migrate ni cambios de datos).

## FacEx Inventario (página facex-inventario) → Maestro de ítems → «+ Nuevo producto»
Diálogo `_maestro_item_dialog` en [page/facex_inventario/facex_inventario.js](../facex_multi/facex_multi/page/facex_inventario/facex_inventario.js):
- Campo nuevo **Inventariable** (precargado con «Manejar Inventario» de la compañía; Serie/Lote lo fuerzan a marcado y de solo lectura). Antes este diálogo no enviaba `is_stock_item`, así que todo ítem nuevo quedaba NO inventariable.
- Campo nuevo **Imagen principal** (Attach Image), solo al crear; se guarda como `Item.image` con la validación de servidor descrita arriba.
- Al editar se carga el valor actual de `is_stock_item` (no cambia si el usuario no lo toca).

## Piezas del Quick Entry nativo
| Pieza | Archivo |
|---|---|
| Property Setters `allow_in_quick_entry = 1` sobre `Item.is_stock_item` e `Item.image` | [fixtures/property_setter.json](../facex_multi/fixtures/property_setter.json) |
| Filtro del fixture (para que `bench export-fixtures` no los pierda) | [hooks.py](../facex_multi/hooks.py) (`fixtures`) |
| Endpoint `facex_multi.api.item.get_new_item_defaults` | [api/item.py](../facex_multi/api/item.py) |
| `ItemQuickEntryForm` (precarga el default) | [public/js/item_quick_entry.js](../facex_multi/public/js/item_quick_entry.js), cargado en `app_include_js` |

## Qué NO se toca
FacEx Inventario / Mantenimiento de ítems (`create_or_update_item`), el form completo de Item, la pestaña de imágenes ([item.js](../facex_multi/public/js/item.js)), la lógica de Serie/Lote. No hay patch ni cambio de datos en Items existentes.

## Despliegue en productivo
1. Subir el código (pull del repo).
2. `bench --site <sitio> migrate` por cada sitio. El fixture crea los 2 Property Setters (solo agrega; no modifica registros existentes). Alternativa sin migrate completo: insertar los 2 Property Setters de `fixtures/property_setter.json` (`Item-is_stock_item-allow_in_quick_entry`, `Item-image-allow_in_quick_entry`) y ejecutar `bench --site <sitio> clear-cache`.
3. `bench restart` (o reiniciar workers/web) para que el endpoint nuevo esté activo. `app_include_js` no requiere `bench build`, pero los usuarios deben recargar con Ctrl+Shift+R.

## Verificación después de desplegar
1. En la consola de Frappe: Item → «Nuevo» → debe verse «Es inventariable» e «Imagen».
2. Neko y Disfavil (Manejar Inventario = 1): «Es inventariable» abre marcado. Una compañía con Manejar Inventario = 0: abre desmarcado.
3. Crear un ítem de prueba con imagen; abrirlo en el form completo y comprobar que la imagen principal aparece.
4. Comprobar que FacEx Inventario → Mantenimiento de ítems sigue creando y editando ítems igual que antes.
5. FacEx Inventario → Maestro de ítems → «+ Crear»: «Inventariable» abre según la compañía; adjuntar imagen, guardar, reabrir el ítem y ver la imagen en el carrusel.
6. FacEx Inventario → Maestro de ítems → «+ Nuevo producto» (diálogo): Inventariable e Imagen principal presentes; editar un ítem existente y confirmar que Inventariable refleja su valor real.
7. Eliminar los ítems de prueba.

## Rollback
Borrar los 2 Property Setters (Personalizar formulario → Item, o desde la lista de Property Setter) y `bench --site <sitio> clear-cache`. Quita los campos del Quick Entry; el script y el endpoint quedan inofensivos. Para retirar todo el código, revertir el commit.

## Notas
- La compañía se resuelve con `get_effective_company` (User Permission por defecto → default del usuario → default global), igual que el resto de FacEx.
- Un ítem creado por el Quick Entry no pasa por `create_or_update_item`: no hereda reglas propias de FacEx (sufijo de compañía, familia, etc.), igual que antes de este cambio.
