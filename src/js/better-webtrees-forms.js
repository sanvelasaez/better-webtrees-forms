/**
 * Better Webtrees Forms
 *
 * Intercepta los enlaces de edición/creación de individuos de webtrees (que
 * navegan a una página completa) y muestra su formulario en un popup AJAX,
 * sin bloquear la navegación. Usa fetch + promesas.
 *
 * Estrategia (ver CLAUDE.md):
 *  - Los handlers *Page devuelven el formulario dentro del layout completo, así
 *    que se descarga el HTML y se extrae el fragmento `.wt-page-content`.
 *  - Al enviar, el handler *Action responde con un redirect 302; fetch lo sigue
 *    hasta la ficha. Si `response.ok`, se cierra el popup y se recarga la página
 *    (los FlashMessages de éxito/error se muestran tras recargar).
 */

import '../scss/better-webtrees-forms.scss';

// Segmentos de ruta (GET → formulario) que abren popup. Ampliable: añade aquí
// el segmento de cualquier otro endpoint *Page que quieras convertir en popup.
const FORM_ROUTE_SEGMENTS = [
  '/edit-fact/',
  '/add-fact/',
  '/edit-record/',
  '/add-child-to-individual/',
  '/add-parent-to-individual/',
  '/add-spouse-to-individual/',
];

const MODAL_ID = 'bwf-modal';
// Región de contenido del layout de webtrees; dentro está el <form> a extraer.
const CONTENT_SELECTOR = '#content';
const FORM_SELECTOR = 'form[method="post"]';
const TITLE_SELECTOR = '.wt-page-title';

let modalEl = null;
let bodyEl = null;
let titleEl = null;

/**
 * ¿La URL apunta a un endpoint de formulario de la allowlist? Comprueba tanto
 * las URLs "bonitas" (segmento en el path) como las de tipo `?route=/...`.
 */
const isFormUrl = (href) => {
  let url;
  try {
    url = new URL(href, window.location.origin);
  } catch (_e) {
    return false;
  }

  if (url.origin !== window.location.origin) {
    return false;
  }

  const route = url.searchParams.get('route') || '';
  const haystack = `${url.pathname} ${route}`;

  return FORM_ROUTE_SEGMENTS.some((segment) => haystack.indexOf(segment) !== -1);
};

/** Click "simple" (sin modificadores ni botón central / target nuevo). */
const isPlainClick = (event, anchor) => event.button === 0
  && !event.metaKey
  && !event.ctrlKey
  && !event.shiftKey
  && !event.altKey
  && anchor.target !== '_blank';

/** Reinicializa los widgets de webtrees dentro del contenedor inyectado. */
const initWidgets = (container) => {
  if (window.webtrees && typeof window.webtrees.initializeTomSelect === 'function') {
    container.querySelectorAll('.tom-select').forEach((el) => {
      window.webtrees.initializeTomSelect(el);
    });
  }
};

const getModal = () => window.bootstrap.Modal.getOrCreateInstance(modalEl);

const showLoading = () => {
  titleEl.textContent = '';
  bodyEl.innerHTML = '<div class="bwf-loading text-center p-4">'
    + '<div class="spinner-border" role="status"></div></div>';
};

const showError = (message) => {
  bodyEl.innerHTML = `<div class="alert alert-danger m-3">${message}</div>`;
};

/** Recarga la ficha conservando el hash de pestaña actual. */
const reloadPage = () => {
  window.location.reload();
};

/**
 * Envía el formulario del popup por AJAX. El *Action responde con redirect;
 * si la respuesta es correcta cerramos y recargamos.
 */
const submitForm = async (form, submitter) => {
  const submitButtons = form.querySelectorAll('[type="submit"]');
  const setDisabled = (state) => {
    submitButtons.forEach((btn) => { btn.toggleAttribute('disabled', state); });
  };
  setDisabled(true);

  try {
    const response = await fetch(form.action, {
      method: 'POST',
      // El 2º argumento incluye el submit pulsado (p.ej. el name="url" del
      // formulario de añadir individuo, que tiene dos botones distintos).
      body: new FormData(form, submitter),
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    getModal().hide();
    reloadPage();
  } catch (_e) {
    setDisabled(false);
    showError('No se pudo guardar. Inténtalo de nuevo.');
  }
};

/**
 * Descarga el formulario de `url`, extrae el fragmento y lo inyecta en el popup.
 */
const openForm = async (url) => {
  showLoading();
  getModal().show();

  try {
    const response = await fetch(url, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const content = doc.querySelector(CONTENT_SELECTOR) || doc.body;
    // El formulario de edición es el primer <form method="post"> del contenido
    // (la búsqueda de cabecera queda fuera de #content). Cubre edit-fact y
    // new-individual (añadir hijo/cónyuge/padre) aunque tengan clases distintas.
    const form = content.querySelector(FORM_SELECTOR);

    if (form === null) {
      // El servidor redirigió (p.ej. sin permisos): abre la página normal.
      window.location.assign(url);
      return;
    }

    const heading = doc.querySelector(TITLE_SELECTOR);
    titleEl.textContent = heading ? heading.textContent.trim() : '';

    bodyEl.innerHTML = '';
    bodyEl.appendChild(form);
    initWidgets(bodyEl);

    const firstField = bodyEl.querySelector('input:not([type="hidden"]), select, textarea');
    if (firstField !== null) {
      firstField.focus();
    }
  } catch (_e) {
    showError('No se pudo cargar el formulario.');
  }
};

/** Crea el contenedor del modal una sola vez. */
const mountModal = () => {
  if (document.getElementById(MODAL_ID) !== null) {
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div class="modal fade bwf-modal" id="${MODAL_ID}" tabindex="-1"
         data-bs-backdrop="static" aria-hidden="true">
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h2 class="modal-title h5 bwf-modal-title"></h2>
            <button type="button" class="btn-close" data-bs-dismiss="modal"
                    aria-label="Close"></button>
          </div>
          <div class="modal-body bwf-modal-body"></div>
        </div>
      </div>
    </div>`;

  modalEl = wrapper.firstElementChild;
  document.body.appendChild(modalEl);
  bodyEl = modalEl.querySelector('.bwf-modal-body');
  titleEl = modalEl.querySelector('.bwf-modal-title');
};

/** Delegación de clicks: abre popup en enlaces de formulario. */
const onDocumentClick = (event) => {
  const anchor = event.target.closest('a[href]');
  if (anchor === null) {
    return;
  }

  // Dentro del popup: el "cancelar" (btn-secondary) solo cierra.
  if (modalEl && modalEl.contains(anchor)) {
    if (anchor.classList.contains('btn-secondary')) {
      event.preventDefault();
      getModal().hide();
    } else if (isFormUrl(anchor.href) && isPlainClick(event, anchor)) {
      event.preventDefault();
      openForm(anchor.href);
    }
    return;
  }

  if (isFormUrl(anchor.href) && isPlainClick(event, anchor)) {
    event.preventDefault();
    openForm(anchor.href);
  }
};

/** Delegación de submit: envía por AJAX los formularios inyectados. */
const onDocumentSubmit = (event) => {
  const form = event.target;
  if (modalEl && bodyEl.contains(form)) {
    event.preventDefault();
    submitForm(form, event.submitter);
  }
};

const init = () => {
  if (window.bootstrap === undefined || window.bootstrap.Modal === undefined) {
    return;
  }
  mountModal();
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('submit', onDocumentSubmit);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
