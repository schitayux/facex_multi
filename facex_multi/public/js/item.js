frappe.ui.form.on('Item', {
	refresh(frm) {
		if (frm.is_new()) return;

		// Pestaña dedicada "Imágenes" (custom field HTML) — visibilidad garantizada,
		// no depende de que el dashboard de conexiones decida mostrarse.
		if (frm.fields_dict.custom_facex_imagenes_html) {
			const $tabWrapper = frm.fields_dict.custom_facex_imagenes_html.$wrapper;
			$tabWrapper.empty().append(FACEX_IMG_STYLE);
			const $tabContent = $('<div class="facex-img-content"></div>').appendTo($tabWrapper);
			facex_multi_load_item_images(frm, $tabContent);
		}
	}
});

const FACEX_IMG_STYLE = `
<style>
.facex-img-carousel { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 6px 0; }
.facex-img-stage {
  position: relative; display: flex; align-items: center; justify-content: center;
  width: 100%; min-height: 280px; background: rgba(15, 23, 42, .05); border-radius: 10px; padding: 10px;
}
.facex-img-main {
  max-width: 100%; max-height: 340px; object-fit: contain;
  border-radius: 8px; box-shadow: 0 2px 10px rgba(0, 0, 0, .12); background: #fff;
}
.facex-img-nav {
  position: absolute; top: 50%; transform: translateY(-50%);
  background: rgba(15, 23, 42, .55); color: #fff; border: none; width: 34px; height: 34px;
  border-radius: 50%; font-size: 15px; cursor: pointer; z-index: 2;
  display: flex; align-items: center; justify-content: center;
}
.facex-img-nav:hover { background: rgba(15, 23, 42, .8); }
.facex-img-prev { left: 8px; }
.facex-img-next { right: 8px; }
.facex-img-remove-main {
  position: absolute; top: 6px; right: 6px; width: 26px; height: 26px; border-radius: 50%;
  border: none; background: #ef4444; color: #fff; font-size: 14px; cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .3); z-index: 3;
}
.facex-img-caption { font-size: 12px; color: #64748b; text-align: center; }
.facex-img-thumbs { display: flex; gap: 8px; overflow-x: auto; max-width: 100%; padding: 4px 2px; }
.facex-img-thumb {
  width: 56px; height: 56px; object-fit: cover; border-radius: 6px; cursor: pointer;
  border: 2px solid transparent; opacity: .65; flex-shrink: 0;
}
.facex-img-thumb:hover { opacity: 1; }
.facex-img-thumb-active { opacity: 1; border-color: var(--primary-color, #2490ef); }
</style>
`;

function facex_multi_load_item_images(frm, $wrapper) {
	$wrapper.html(`<div class="text-muted" style="padding:8px 0;">${__('Cargando imágenes…')}</div>`);

	const reload = () => facex_multi_load_item_images(frm, $wrapper);

	frappe.call({
		method: 'facex_multi.api.item.get_item_images',
		args: { item_code: frm.doc.name },
		callback: (r) => {
			const images = r.message || [];
			$wrapper.empty();

			const $toolbar = $(`
				<div style="display:flex; justify-content:flex-end; margin-bottom:8px;">
					<button class="btn btn-xs btn-default facex-img-add-btn">${__('Agregar Imagen')}</button>
				</div>
			`);
			$wrapper.append($toolbar);

			const $body = $('<div class="facex-img-body"></div>');
			$wrapper.append($body);

			if (!images.length) {
				$body.html(`<div class="text-muted" style="padding:12px 0;">${__('No hay imágenes adjuntas para este producto.')}</div>`);
			} else {
				facex_multi_render_carousel(frm, $body, images, reload);
			}

			$toolbar.find('.facex-img-add-btn').on('click', () => {
				new frappe.ui.FileUploader({
					doctype: 'Item',
					docname: frm.doc.name,
					frm: frm,
					on_success: reload,
				});
			});
		},
	});
}

function facex_multi_render_carousel(frm, $wrapper, images, reload) {
	let idx = 0;

	const thumbs = images.map((img, i) => `
		<img class="facex-img-thumb" data-idx="${i}" src="${img.file_url}" title="${frappe.utils.escape_html(img.file_name || '')}">
	`).join('');

	$wrapper.html(`
		<div class="facex-img-carousel">
			<div class="facex-img-stage">
				<button class="facex-img-nav facex-img-prev" title="${__('Anterior')}">&#10094;</button>
				<img class="facex-img-main" src="">
				<button class="facex-img-remove-main" title="${__('Eliminar imagen')}">×</button>
				<button class="facex-img-nav facex-img-next" title="${__('Siguiente')}">&#10095;</button>
			</div>
			<div class="facex-img-caption"></div>
			${images.length > 1 ? `<div class="facex-img-thumbs">${thumbs}</div>` : ''}
		</div>
	`);

	const $main = $wrapper.find('.facex-img-main');
	const $caption = $wrapper.find('.facex-img-caption');

	const render = () => {
		const img = images[idx];
		$main.attr('src', img.file_url);
		$caption.text(`${img.file_name || ''} (${idx + 1}/${images.length})`);
		$wrapper.find('.facex-img-thumb').removeClass('facex-img-thumb-active')
			.filter(`[data-idx="${idx}"]`).addClass('facex-img-thumb-active');
		$wrapper.find('.facex-img-nav').toggle(images.length > 1);
	};

	$wrapper.find('.facex-img-prev').on('click', () => { idx = (idx - 1 + images.length) % images.length; render(); });
	$wrapper.find('.facex-img-next').on('click', () => { idx = (idx + 1) % images.length; render(); });
	$wrapper.find('.facex-img-thumb').on('click', (ev) => { idx = parseInt($(ev.currentTarget).attr('data-idx'), 10); render(); });

	$wrapper.find('.facex-img-remove-main').on('click', () => {
		frappe.confirm(__('¿Eliminar esta imagen del producto?'), () => {
			const file_name = images[idx].name || '';
			frappe.call({
				method: 'facex_multi.api.item.delete_item_image',
				args: { item_code: frm.doc.name, file_name },
				callback: () => {
					frappe.show_alert({ message: __('Imagen eliminada.'), indicator: 'green' });
					reload();
				},
			});
		});
	});

	render();
}
