/**
 * Better Webtrees Forms
 *
 * Sustituye los formularios de edición/creación de individuos de webtrees (que
 * navegan a una página completa) por popups AJAX rápidos + guardado en segundo
 * plano con un toast en la esquina inferior derecha.
 *
 * Estrategia (ver CLAUDE.md):
 *  - APERTURA RÁPIDA: en vez de pedir la página completa (`*Page`, layout con todo
 *    el chrome de webtrees), se pide una ruta gemela del módulo con prefijo `bwf-`
 *    que renderiza SOLO el fragmento del formulario (`layouts/ajax`). Se prefetcha
 *    al pasar el ratón/foco, así el modal abre al instante. Si el fragmento falla,
 *    respaldo: se pide la ruta original de core y se extrae el <form>.
 *  - GUARDADO EN 2º PLANO: al enviar, se cierra el modal de inmediato y el POST va
 *    al *Action de core en segundo plano, mostrando el progreso/resultado en un
 *    toast (cargando → éxito / pendiente+aprobar / error). Si el cambio queda
 *    pendiente y el usuario es moderador, el toast ofrece un botón para aprobarlo.
 */

import '../scss/better-webtrees-forms.scss';

// Interceptamos por CONVENCIÓN, no por lista cerrada: en webtrees los formularios
// de edición son rutas `*Page` (+ `*Action` POST) cuyo segmento empieza por un
// verbo de edición. Así, un formulario nuevo del core se convierte en popup sin
// tocar este archivo. Excluimos lo que webtrees ya sirve de forma nativa:
//  - `*Modal` (crear fuente/nota/repositorio, media…): sus segmentos llevan
//    `create-` o `media` y ya abren en el modal propio de webtrees.
//  - enlaces con `data-wt-post-url` (delete) o `data-bs-toggle="modal"` (ver
//    isNativeHandled) → los gestiona el core.
// El verbo debe ir a principio de segmento (`/edit-`, no `users-edit`) para no
// pillar rutas de admin/mapas.
const FORM_VERB_RE = /\/(add|edit|link|reorder|change)-/;
const NATIVE_MODAL_RE = /(create-|media)/;

// Subconjunto con gemelo rápido `bwf-` (fragmento layouts/ajax) registrado en
// PHP. Solo estos se reescriben a la ruta rápida; el resto usa el fallback
// genérico (fetch de la página completa + extracción del <form>), que funciona
// igual, solo un poco más lento. Añade aquí un segmento SI creas su handler bwf-.
const FAST_SEGMENTS = [
  '/edit-fact/',
  '/add-fact/',
  '/edit-record/',
  '/add-child-to-individual/',
  '/add-parent-to-individual/',
  '/add-spouse-to-individual/',
];

const MODAL_ID = 'bwf-modal';
const TOAST_CONTAINER_ID = 'bwf-toast-container';
// Región de contenido del layout de webtrees; dentro está el <form> a extraer.
const CONTENT_SELECTOR = '#content';
const FORM_SELECTOR = 'form[method="post"]';
const TITLE_SELECTOR = '.wt-page-title';
// Señales en el HTML de la ficha devuelta tras guardar (theme/idioma-agnósticas):
// enlace de aprobar (solo moderadores) y marca del banner de "pendiente".
// El data-wt-post-url del enlace accept puede venir con las barras SIN codificar
// (pretty-routing: `/accept/`) o CODIFICADAS (este Docker usa `?route=…%2Faccept%2FX1`);
// hay que casar ambas o el botón "Aprobar" no aparecería para el moderador. El
// flag `i` cubre `%2F`/`%2f`.
const ACCEPT_SELECTOR = '[data-wt-post-url*="/accept/"], [data-wt-post-url*="%2Faccept%2F" i]';
const PENDING_SELECTOR = '[data-wt-href*="pending_changes"]';

// TTL de la caché de prefetch. Alto a propósito: al cargar la página se
// prefetchean TODOS los formularios (prefetchAllForms), y el usuario puede
// tardar en pulsarlos; un TTL corto los dejaría caducar antes de usarse. El
// hover vuelve a prefetchear si hiciera falta, así que la peor consecuencia de
// un TTL alto es servir un formulario ligeramente antiguo (aceptable en edición).
const PREFETCH_TTL = 300000;

let modalEl = null;
let bodyEl = null;
let titleEl = null;
let toastContainer = null;

// Token de generación para descartar respuestas obsoletas. Cada openForm captura
// el valor actual; si al resolver el fetch ya no coincide (el usuario canceló o
// pulsó otro enlace), la respuesta se ignora en vez de montarse en el modal. Sin
// esto, varios fetch en vuelo se pisaban: el primero en resolver (no el último
// pulsado) acababa mostrándose. Cancelar el modal también lo incrementa.
let openToken = 0;

// Nº de acciones interactivas (abrir formulario/ayuda, guardar) en vuelo. El
// prefetch anticipado cede el paso mientras sea > 0: este backend serializa las
// peticiones de una misma sesión (lock de sesión de PHP) y es lento, así que una
// precarga en curso retrasaría el clic del usuario. Ver prefetchAllForms.
let interactiveInFlight = 0;

// Caché de prefetch: fastUrl → { ts, promise<html> }.
const prefetchCache = new Map();

/**
 * ¿La URL apunta a un endpoint de formulario de edición? Se decide por convención
 * (verbo de edición a principio de segmento) excluyendo los modales nativos.
 * Cubre tanto URLs "bonitas" (segmento en el path) como `?route=/...`.
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

  return FORM_VERB_RE.test(haystack) && !NATIVE_MODAL_RE.test(haystack);
};

/**
 * Reescribe la URL de core a su gemela rápida del módulo: el segmento
 * `/edit-fact/` pasa a `/bwf-edit-fact/`, etc. Actúa tanto sobre el path como
 * sobre el valor del parámetro `route` (este Docker usa `?route=`). Conserva el
 * resto de query (`url`, `include_hidden`, `fact_id`…). Si no matchea, devuelve
 * la misma URL (el flujo tiene respaldo a la ruta original).
 */
const toFastUrl = (href) => {
  let url;
  try {
    url = new URL(href, window.location.origin);
  } catch (_e) {
    return href;
  }

  const route = url.searchParams.get('route') || '';
  const haystack = `${url.pathname} ${route}`;
  const segment = FAST_SEGMENTS.find((seg) => haystack.indexOf(seg) !== -1);

  if (segment === undefined) {
    return href;
  }

  const fast = `/bwf-${segment.slice(1)}`;

  if (route.indexOf(segment) !== -1) {
    url.searchParams.set('route', route.replace(segment, fast));
  }
  if (url.pathname.indexOf(segment) !== -1) {
    url.pathname = url.pathname.replace(segment, fast);
  }

  return url.href;
};

/** Click "simple" (sin modificadores ni botón central / target nuevo). */
const isPlainClick = (event, anchor) => event.button === 0
  && !event.metaKey
  && !event.ctrlKey
  && !event.shiftKey
  && !event.altKey
  && anchor.target !== '_blank';

/** ¿El enlace lo gestiona webtrees nativamente (POST propio o modal propio)? */
const isNativeHandled = (anchor) => anchor.hasAttribute('data-wt-post-url')
  || anchor.getAttribute('data-bs-toggle') === 'modal';

/** ¿Debemos convertir este enlace en popup? Formulario de edición y no nativo. */
const shouldIntercept = (anchor) => isFormUrl(anchor.href) && !isNativeHandled(anchor);

/**
 * Inicializa las listas de reordenar (`reorder-*`). El core arranca Sortable desde
 * un <script> que empuja al stack `javascript` del layout (se renderiza al final,
 * FUERA de #content), así que el fallback de página completa lo pierde y hay que
 * replicarlo. Todas las variantes comparten markup: `.wt-sortable-list` con handle
 * `.card-header`, items `.wt-sortable-item` con `data-wt-sort-by-date`, y un botón
 * opcional `#btn-default-order` que ordena por fecha. Se marca con atributos (no
 * asignación a props de parámetro → no rompe no-param-reassign) para no duplicar.
 */
const initSortableLists = (container) => {
  if (typeof window.Sortable !== 'function') {
    return;
  }

  const lists = container.querySelectorAll('.wt-sortable-list');
  lists.forEach((list) => {
    if (!list.hasAttribute('data-bwf-sortable')) {
      list.setAttribute('data-bwf-sortable', '1');
      window.Sortable.create(list, { handle: '.card-header' });
    }
  });

  const sortBtn = container.querySelector('#btn-default-order');
  if (sortBtn !== null && !sortBtn.hasAttribute('data-bwf-wired')) {
    sortBtn.setAttribute('data-bwf-wired', '1');
    sortBtn.addEventListener('click', () => {
      const byDate = (x, y) => Number(x.dataset.wtSortByDate) - Number(y.dataset.wtSortByDate);
      lists.forEach((list) => {
        Array.from(list.querySelectorAll(':scope > .wt-sortable-item'))
          .sort(byDate)
          .forEach((item) => list.appendChild(item));
      });
    });
  }
};

/** Reinicializa los widgets de webtrees dentro del contenedor inyectado. */
const initWidgets = (container) => {
  if (window.webtrees && typeof window.webtrees.initializeTomSelect === 'function') {
    container.querySelectorAll('.tom-select').forEach((el) => {
      window.webtrees.initializeTomSelect(el);
    });
  }
  initSortableLists(container);
};

/**
 * Re-ejecuta los <script> inline del fragmento inyectado. Ni innerHTML ni
 * appendChild ejecutan los <script>, y webtrees los usa por campo para
 * inicializar widgets. Crítico para las notas (`NoteStructure::edit()` pinta un
 * <textarea> y un <select> con el mismo name="values[]" y un script inline que
 * deshabilita el <select>); sin ese script se envían AMBOS y los conteos de
 * levels/tags/values no cuadran → el *Action revienta con un assert (HTTP 500).
 * De paso reactiva otros init inline (p.ej. el calendario de fechas).
 */
const runInlineScripts = (container) => {
  // Algunos <script> del fragmento envuelven su init en
  // `document.addEventListener('DOMContentLoaded', cb)` (p.ej. el editor de
  // nombre de webtrees, que ahí cablea GIVN/SURN → la línea NAME). Como el
  // evento ya disparó al cargar la página, ese cb no volvería a ejecutarse y la
  // persona se guardaría con el NAME sin actualizar. Interceptamos esos
  // registros durante la re-ejecución para invocarlos de inmediato (el DOM ya
  // está listo), imitando el comportamiento de la página completa.
  const originalAdd = document.addEventListener;
  document.addEventListener = function patchedAdd(type, listener, options) {
    if (type === 'DOMContentLoaded' && typeof listener === 'function') {
      try {
        listener.call(document, new Event('DOMContentLoaded'));
      } catch (err) {
        // Un init que falle no debe abortar el resto de scripts del fragmento.
      }
      return undefined;
    }
    return originalAdd.call(this, type, listener, options);
  };

  try {
    container.querySelectorAll('script').forEach((old) => {
      const script = document.createElement('script');
      Array.from(old.attributes).forEach((attr) => {
        script.setAttribute(attr.name, attr.value);
      });
      script.textContent = old.textContent;
      old.parentNode.replaceChild(script, old);
    });
  } finally {
    delete document.addEventListener;
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

/** Descarga texto de una URL (fragmento o página). Lanza si !ok. */
const fetchText = async (url) => {
  const response = await fetch(url, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
    credentials: 'same-origin',
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.text();
};

/** Lanza (o reutiliza) el prefetch del fragmento rápido y cachea la promesa. */
const prefetch = (fastUrl) => {
  const cached = prefetchCache.get(fastUrl);
  if (cached && Date.now() - cached.ts < PREFETCH_TTL) {
    return cached.promise;
  }

  const promise = fetchText(fastUrl);
  // Un prefetch fallido no debe envenenar la caché (respaldo a ruta original).
  promise.catch(() => prefetchCache.delete(fastUrl));
  prefetchCache.set(fastUrl, { ts: Date.now(), promise });

  return promise;
};

/** Extrae el <form>, el título y los scripts de contenido del HTML. */
const extractFragment = (html) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const contentEl = doc.querySelector(CONTENT_SELECTOR);
  const content = contentEl || doc.body;
  const form = content.querySelector(FORM_SELECTOR);
  const heading = doc.querySelector(TITLE_SELECTOR);

  // En el FALLBACK de página completa (hay un #content real), webtrees renderiza
  // algunos <script> inline DENTRO de #content pero FUERA del <form> — los empuja
  // al stack `javascript` del layout (p.ej. el cableado de la línea NAME a partir
  // de GIVN/SURN, o el arranque de widgets de un campo). Como solo montamos el
  // <form>, hay que arrastrarlos o se pierden y el formulario queda a medias. Los
  // <script src> globales (calendario, lightbox, CKEditor…) van FUERA de #content
  // y NO se tocan. En el fragmento bwf (layouts/ajax, sin #content) no aplica.
  const scripts = contentEl && form
    ? Array.from(contentEl.querySelectorAll('script:not([src])')).filter((s) => !form.contains(s))
    : [];

  return { form, title: heading ? heading.textContent.trim() : '', scripts };
};

/**
 * Neutraliza los enlaces "modal" de webtrees dentro del contenedor. La ayuda "i"
 * y algunos subformularios usan `data-bs-toggle="modal"
 * data-bs-target="#wt-ajax-modal" data-wt-href="…"`; su data-api de Bootstrap
 * (registrado antes que este módulo, así que gana la carrera de eventos) abriría
 * el #wt-ajax-modal COMPARTIDO, que oculta nuestro popup (no apila) y aquí llega
 * vacío. Les quitamos los `data-bs-*` para que el data-api ya no los reconozca y
 * los marcamos con `data-bwf-modal`; así los abrimos nosotros en un modal apilado
 * propio (ver onDocumentClick) y, al cerrarlo, se vuelve al formulario intacto.
 */
const neutralizeModalLinks = (container) => {
  container.querySelectorAll('a[data-bs-toggle="modal"][data-wt-href]').forEach((link) => {
    link.setAttribute('data-bwf-modal', link.getAttribute('data-wt-href'));
    link.removeAttribute('data-bs-toggle');
    link.removeAttribute('data-bs-target');
  });
};

/** Inyecta el formulario extraído en el modal y activa sus widgets/scripts. */
const mountForm = (fragment) => {
  titleEl.textContent = fragment.title;
  bodyEl.innerHTML = '';
  bodyEl.appendChild(fragment.form);
  // Scripts de #content que van fuera del <form> (cableado de NAME, etc.): se
  // adjuntan para que runInlineScripts los ejecute junto a los del propio form.
  fragment.scripts.forEach((script) => bodyEl.appendChild(script));
  // Los enlaces de ayuda "i" / subformularios se abren apilados, no pisando este.
  neutralizeModalLinks(bodyEl);
  initWidgets(bodyEl);
  // Después de initWidgets: algún script inline (p.ej. el toggle de nota
  // compartida) llama a `.tomselect.disable()` y necesita el widget ya creado.
  runInlineScripts(bodyEl);

  const firstField = bodyEl.querySelector('input:not([type="hidden"]), select, textarea');
  if (firstField !== null) {
    firstField.focus();
  }
};

/**
 * Abre el popup: intenta el fragmento rápido (prefetcheado); si falla o no trae
 * formulario, respaldo a la ruta original de core (página completa).
 */
const openForm = async (originalHref) => {
  openToken += 1;
  const token = openToken;
  interactiveInFlight += 1;
  showLoading();
  getModal().show();

  try {
    let fragment = null;

    try {
      fragment = extractFragment(await prefetch(toFastUrl(originalHref)));
    } catch (_e) {
      fragment = null;
    }

    // Superado por otra apertura o por un cancelar mientras se descargaba: descartar.
    if (token !== openToken) {
      return;
    }

    if (fragment === null || fragment.form === null) {
      try {
        fragment = extractFragment(await fetchText(originalHref));
      } catch (_e2) {
        if (token === openToken) {
          showError('No se pudo cargar el formulario.');
        }
        return;
      }
      if (token !== openToken) {
        return;
      }
    }

    if (fragment.form === null) {
      // Red de seguridad (detección por contenido): si el destino resultó NO ser
      // un formulario (falso positivo de la convención, redirección por permisos,
      // página sin <form>), degradamos a navegación normal en vez de mostrar error.
      getModal().hide();
      window.location.assign(originalHref);
      return;
    }

    mountForm(fragment);
  } finally {
    interactiveInFlight -= 1;
  }
};

/**
 * Abre en un modal APILADO (encima del actual) el contenido de un enlace "modal"
 * de webtrees: la ayuda "i" (`data-bs-toggle="modal"` + `data-wt-href`, p.ej.
 * `/help/NAME`) y los subformularios que webtrees sirve al #wt-ajax-modal
 * compartido. El comportamiento nativo abre ese modal compartido, lo que aquí
 * OCULTA nuestro popup (no apila) y encima llega vacío; al cerrarlo perderías lo
 * escrito. Lo sustituimos por un modal propio: se muestra encima y, al cerrarlo,
 * se vuelve al formulario sin haberlo tocado. El fragmento ya trae su
 * `.modal-header` + `.modal-body`, así que se inyecta tal cual en un
 * `.modal-content`.
 */
const openStackedContent = async (url) => {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = '<div class="modal fade bwf-modal bwf-modal--stacked" tabindex="-1"'
    + ' aria-hidden="true"><div class="modal-dialog modal-lg modal-dialog-scrollable">'
    + '<div class="modal-content"></div></div></div>';
  const el = wrapper.firstElementChild;
  document.body.appendChild(el);

  const content = el.querySelector('.modal-content');
  content.innerHTML = '<div class="bwf-loading text-center p-4">'
    + '<div class="spinner-border" role="status"></div></div>';
  el.addEventListener('hidden.bs.modal', () => el.remove());
  window.bootstrap.Modal.getOrCreateInstance(el).show();

  interactiveInFlight += 1;
  try {
    const html = await fetchText(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    content.innerHTML = '';
    Array.from(doc.body.childNodes).forEach((node) => content.appendChild(node));
    // Enlaces "modal" anidados (ayuda dentro de ayuda, etc.) → también apilados.
    neutralizeModalLinks(content);
    // Por si el fragmento fuese un subformulario con inicialización inline.
    runInlineScripts(content);
  } catch (_e) {
    content.innerHTML = '<div class="alert alert-danger m-3">No se pudo cargar el contenido.</div>';
  } finally {
    interactiveInFlight -= 1;
  }
};

// ---------------------------------------------------------------------------
// Toast (esquina inferior derecha)
// ---------------------------------------------------------------------------

/** Lee el token CSRF que webtrees publica en <meta name="csrf">. */
const csrfToken = () => {
  const meta = document.querySelector('meta[name="csrf"]');
  return meta ? meta.getAttribute('content') : '';
};

/**
 * Recarga la ficha (para reflejar el cambio) SOLO si estamos viéndola. `finalUrl`
 * es la URL de la ficha a la que redirige el *Action. Se retrasa un poco para
 * que el toast de resultado sea visible antes de recargar.
 */
const reloadIfViewing = (finalUrl) => {
  let target;
  try {
    target = new URL(finalUrl, window.location.origin);
  } catch (_e) {
    return;
  }

  const here = window.location;
  if (target.pathname === here.pathname && target.search === here.search) {
    window.setTimeout(() => window.location.reload(), 1500);
  }
};

const mountToastContainer = () => {
  if (document.getElementById(TOAST_CONTAINER_ID) !== null) {
    return;
  }

  const el = document.createElement('div');
  el.id = TOAST_CONTAINER_ID;
  el.className = 'bwf-toast-container toast-container position-fixed bottom-0 end-0 p-3';
  document.body.appendChild(el);
  toastContainer = el;
};

const VARIANTS = ['bwf-toast--loading', 'bwf-toast--success', 'bwf-toast--danger', 'bwf-toast--pending'];

/**
 * Crea un toast Bootstrap y devuelve una API para actualizar su estado. Todo el
 * texto se inserta con textContent (nunca HTML del servidor) para evitar XSS.
 */
const createToast = () => {
  const el = document.createElement('div');
  el.className = 'toast bwf-toast border-0';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.innerHTML = '<div class="d-flex align-items-center">'
    + '<div class="toast-body bwf-toast-body d-flex align-items-center gap-2 flex-grow-1"></div>'
    + '<div class="bwf-toast-actions d-flex align-items-center gap-2 pe-2"></div>'
    + '<button type="button" class="btn-close me-2 m-auto" data-bs-dismiss="toast" aria-label="Cerrar"></button>'
    + '</div>';

  toastContainer.appendChild(el);
  const body = el.querySelector('.bwf-toast-body');
  const actions = el.querySelector('.bwf-toast-actions');
  const bs = window.bootstrap.Toast.getOrCreateInstance(el, { autohide: false });
  bs.show();
  el.addEventListener('hidden.bs.toast', () => el.remove());

  const setVariant = (variant) => {
    VARIANTS.forEach((cls) => el.classList.remove(cls));
    el.classList.add(variant);
  };

  const setText = (text) => {
    body.textContent = text;
  };

  const autohide = (delay) => {
    window.setTimeout(() => bs.hide(), delay);
  };

  return {
    loading(text) {
      setVariant('bwf-toast--loading');
      actions.innerHTML = '';
      body.innerHTML = '<span class="spinner-border spinner-border-sm" role="status"></span>';
      const span = document.createElement('span');
      span.textContent = text;
      body.appendChild(span);
    },
    success(text) {
      setVariant('bwf-toast--success');
      actions.innerHTML = '';
      setText(text);
      autohide(4000);
    },
    error(text) {
      setVariant('bwf-toast--danger');
      actions.innerHTML = '';
      setText(text);
    },
    pending(text, acceptUrl, finalUrl) {
      setVariant('bwf-toast--pending');
      setText(text);
      actions.innerHTML = '';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-sm btn-light';
      button.textContent = 'Aprobar';
      button.addEventListener('click', () => {
        button.disabled = true;
        this.loading('Aprobando…');
        fetch(acceptUrl, {
          method: 'POST',
          headers: {
            'X-CSRF-TOKEN': csrfToken(),
            'X-Requested-With': 'XMLHttpRequest',
          },
          credentials: 'same-origin',
        }).then((response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          this.success('Aprobado.');
          reloadIfViewing(finalUrl);
        }).catch(() => {
          this.error('No se pudo aprobar. Inténtalo de nuevo.');
        });
      });
      actions.appendChild(button);
    },
  };
};

/** Extrae el texto del `.alert-danger` de una respuesta de error de validación. */
const extractError = (html) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const alert = doc.querySelector('.alert-danger');
  return alert ? alert.textContent.trim() : '';
};

/** Resuelve el toast según el HTML de la ficha devuelta tras un guardado ok. */
const resolveSave = (toast, html, finalUrl) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const acceptLink = doc.querySelector(ACCEPT_SELECTOR);
  const isPending = doc.querySelector(PENDING_SELECTOR) !== null;

  if (acceptLink !== null) {
    // Pendiente y el usuario es moderador → ofrecer aprobar.
    toast.pending('Guardado. Pendiente de revisión.', acceptLink.getAttribute('data-wt-post-url'), finalUrl);
  } else if (isPending) {
    toast.success('Guardado. Pendiente de revisión por un moderador.');
    reloadIfViewing(finalUrl);
  } else {
    toast.success('Guardado.');
    reloadIfViewing(finalUrl);
  }
};

/**
 * Envía el formulario del popup en segundo plano. Cierra el modal al instante y
 * muestra el progreso en el toast. Los *Action responden con redirect a la ficha
 * (fetch lo sigue); un error de validación devuelve HTML con `.alert-danger`.
 */
const backgroundSubmit = async (form, submitter) => {
  const formData = new FormData(form, submitter);
  const { action } = form;

  getModal().hide();

  const toast = createToast();
  toast.loading('Guardando…');

  interactiveInFlight += 1;
  try {
    const response = await fetch(action, {
      method: 'POST',
      body: formData,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'same-origin',
    });

    const html = await response.text();

    if (!response.ok) {
      toast.error(extractError(html) || `No se pudo guardar (HTTP ${response.status}).`);
      return;
    }

    resolveSave(toast, html, response.url);
  } catch (_e) {
    toast.error('No se pudo guardar. Inténtalo de nuevo.');
  } finally {
    interactiveInFlight -= 1;
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
         aria-hidden="true">
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

  // Al cerrar el modal (cancelar, Esc, aspa, backdrop) invalidamos cualquier
  // carga en vuelo: si el usuario canceló, un fetch que resuelva tarde no debe
  // montarse ni reabrir contenido obsoleto.
  modalEl.addEventListener('hidden.bs.modal', () => {
    openToken += 1;
  });
};

/** Delegación de clicks: abre popup en enlaces de formulario. */
const onDocumentClick = (event) => {
  const anchor = event.target.closest('a[href]');
  if (anchor === null) {
    return;
  }

  // Enlace "modal" de webtrees (ayuda "i", subformularios) neutralizado dentro de
  // CUALQUIER popup nuestro (base o apilado) → abrir apilado encima, sin tocar el
  // actual. Va antes que el resto para funcionar también en modales apilados.
  if (anchor.hasAttribute('data-bwf-modal') && anchor.closest('.bwf-modal') !== null) {
    if (isPlainClick(event, anchor)) {
      event.preventDefault();
      openStackedContent(anchor.getAttribute('data-bwf-modal'));
    }
    return;
  }

  // Dentro del popup: el "cancelar" (btn-secondary) solo cierra.
  if (modalEl && modalEl.contains(anchor)) {
    if (anchor.classList.contains('btn-secondary')) {
      event.preventDefault();
      getModal().hide();
    } else if (shouldIntercept(anchor) && isPlainClick(event, anchor)) {
      event.preventDefault();
      openForm(anchor.href);
    }
    return;
  }

  if (shouldIntercept(anchor) && isPlainClick(event, anchor)) {
    event.preventDefault();
    openForm(anchor.href);
  }
};

/**
 * Prefetch anticipado de TODOS los enlaces de formulario de la página tras
 * cargarla, en ratos libres del navegador y en lotes pequeños para no competir
 * con el render inicial. Así, al pulsar cualquiera, su formulario ya está en
 * caché (`prefetchCache` dedupe por fastUrl) → abre al instante y con el
 * contenido correcto. Es solo un calentamiento de caché: el token de openForm
 * sigue garantizando que se muestre el ÚLTIMO pulsado, no el primero que resuelva.
 */
const prefetchAllForms = () => {
  const seen = new Set();
  const queue = [];
  document.querySelectorAll('a[href]').forEach((anchor) => {
    if ((modalEl && modalEl.contains(anchor)) || !shouldIntercept(anchor)) {
      return;
    }
    const fast = toFastUrl(anchor.href);
    // Solo precargamos EN MASA los que tienen gemelo rápido `bwf-` (fragmento
    // `layouts/ajax`, barato). Las páginas completas (sin gemelo) son caras y se
    // prefetchean al pasar el ratón (una sola, bajo intención del usuario).
    if (fast !== anchor.href && !seen.has(fast)) {
      seen.add(fast);
      queue.push(fast);
    }
  });

  // Worker ESTRICTAMENTE SECUENCIAL (una precarga a la vez, encadenada con
  // .then(pump)). webtrees serializa las peticiones de una misma sesión (lock de
  // sesión de PHP) y este backend es lento; lanzar varias a la vez las encolaría
  // TODAS por delante del próximo clic del usuario. Además, mientras haya una
  // acción interactiva en vuelo (abrir formulario/ayuda, guardar) cedemos el paso
  // para no meter una precarga por delante de lo que el usuario espera ahora.
  const pump = () => {
    if (queue.length === 0) {
      return;
    }
    if (interactiveInFlight > 0) {
      window.setTimeout(pump, 400);
      return;
    }
    const url = queue.shift();
    prefetch(url).catch(() => {}).then(pump);
  };
  pump();
};

/** Programa el prefetch total cuando el navegador esté ocioso. */
const schedulePrefetchAll = () => {
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(prefetchAllForms, { timeout: 3000 });
  } else {
    window.setTimeout(prefetchAllForms, 800);
  }
};

/** Prefetch del fragmento al pasar el ratón/foco por un enlace interceptado. */
const onPrefetchIntent = (event) => {
  const anchor = event.target.closest('a[href]');
  if (anchor === null || (modalEl && modalEl.contains(anchor))) {
    return;
  }
  if (shouldIntercept(anchor)) {
    prefetch(toFastUrl(anchor.href));
  }
};

/** Delegación de submit: envía por AJAX (en 2º plano) los formularios inyectados. */
const onDocumentSubmit = (event) => {
  const form = event.target;
  if (modalEl && bodyEl.contains(form)) {
    event.preventDefault();
    backgroundSubmit(form, event.submitter);
  }
};

const init = () => {
  if (window.bootstrap === undefined || window.bootstrap.Modal === undefined) {
    return;
  }
  mountModal();
  mountToastContainer();
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('submit', onDocumentSubmit);
  document.addEventListener('mouseover', onPrefetchIntent);
  document.addEventListener('focusin', onPrefetchIntent);
  schedulePrefetchAll();
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
