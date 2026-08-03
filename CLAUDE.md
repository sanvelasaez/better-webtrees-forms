# CLAUDE.md — Better Webtrees Forms (repo fuente)

Módulo custom de webtrees **2.2.6** que sustituye los formularios de edición/creación
de individuos (que en webtrees navegan a una página completa) por **popups AJAX**: al
pulsar "Editar hecho", "Añadir hecho" o "Añadir hijo/cónyuge/padre" aparece un modal con
los inputs del formulario y botones Guardar/Cancelar, sin recargar ni bloquear la
navegación. Todo con `fetch` + promesas.

Este directorio es la **fuente editable**. El código que webtrees ejecuta es una copia
compilada en `../myfamilytree/modules_v4/better-webtrees-forms/` (ver "Dónde se sirve").

## En qué consiste (arquitectura)

El módulo **no toca el core** de webtrees. Se apoya en una única palanca: un módulo
`ModuleGlobalInterface` inyecta un CSS + JS global en **todas** las páginas
(`BetterWebtreesFormsModule::headContent()`). Toda la lógica vive en el bundle JS de
cliente (`src/js/better-webtrees-forms.js`):

1. **Interceptar** (delegación de clicks en `document`): cuando se pulsa un `<a>` cuyo
   destino es un endpoint de formulario de individuo (allowlist `FORM_ROUTE_SEGMENTS`:
   `/edit-fact/`, `/add-fact/`, `/edit-record/`, `/add-child-to-individual/`,
   `/add-parent-to-individual/`, `/add-spouse-to-individual/`), se hace `preventDefault`.
   Los clicks con modificadores (ctrl/cmd/medio, `target=_blank`) se dejan pasar para no
   romper "abrir en pestaña nueva". El botón Delete de webtrees ya es AJAX nativo
   (`data-wt-post-url`) y no se toca.
2. **Abrir** (`openForm`): `fetch` de la URL → `DOMParser` → se extrae el primer
   `form[method="post"]` dentro de `#content` (los handlers `*Page` devuelven la página
   completa, así que el fragmento se extrae en cliente) → se inyecta en el modal
   Bootstrap `#bwf-modal` → se reinicializan los widgets (`webtrees.initializeTomSelect`).
3. **Guardar** (`submitForm`): se intercepta el `submit`, se hace `fetch` POST con
   `new FormData(form, submitter)` (incluye el botón pulsado y el `csrf_field()` oculto).
   Los handlers `*Action` responden con `redirect()` 302; `fetch` lo sigue. Si
   `response.ok` → se cierra el popup y se **recarga la ficha** (`location.reload()`,
   conserva el hash de pestaña); los FlashMessages de éxito/error aparecen tras recargar.
4. **Cancelar**: el botón `btn-secondary` del formulario solo cierra el modal.

Puntos de referencia en el core (solo lectura, `../myfamilytree`):
- Enlaces interceptados: `resources/views/edit/icon-fact-edit.phtml`, `fact-add-new.phtml`,
  `modules/relatives/tab.phtml`, `individual-page-menu.phtml`.
- Vistas de formulario: `resources/views/edit/edit-fact.phtml` (form con `.wt-page-content`),
  `resources/views/edit/new-individual.phtml` (form sin esa clase → por eso se extrae por
  `form[method="post"]`, no por clase).
- Rutas: `app/Http/Routes/WebRoutes.php` (segmentos `*-individual`, `edit-fact`, `add-fact`).
- Widget de selects: webtrees usa **tom-select** (no select2); `window.webtrees.initializeTomSelect`.

## Dónde se sirve (crítico)

El sitio en vivo (`http://localhost/myfamilytree`) carga el módulo desde
`../myfamilytree/modules_v4/better-webtrees-forms`, **no** desde este directorio fuente.
`webpack.config.js` (target `webtrees`, el de `npm run dev`/`build`) copia ahí:
- `module.php` y `BetterWebtreesFormsModule.php` (vía `copy-webpack-plugin`).
- `resources/js/better-webtrees-forms.js` y `resources/css/better-webtrees-forms.css`
  (salida de webpack + MiniCssExtract).

Si editas las rutas de salida en `webpack.config.js`, mantenlas apuntando a
`myfamilytree/modules_v4/better-webtrees-forms` o los cambios no se verán.

El módulo se autodescubre y **se habilita solo** en webtrees (aparece como
`_better-webtrees-forms_` en `wt_module`, status `enabled`). No requiere activación manual.

## Editar y compilar

```bash
npm install        # una vez
npm run build      # lint (airbnb-base) + webpack producción + copia a modules_v4
npm run dev        # igual, en watch
```

- Cambios de **JS** (`src/js`) o **SCSS** (`src/scss`) → recompilar y recargar la página.
- `resources/js` y `resources/css` son **salida compilada**; no editar a mano.
- El asset se cachea por `?hash=filemtime` (lo añade `assetUrl()`); el build actualiza el
  mtime, así que una recarga real trae el bundle nuevo.

### El lint corre antes del webpack y rompe el build

`npm run build` ejecuta `eslint` (airbnb-base) primero. Fallos frecuentes en Windows:
- **CRLF**: el editor escribe `CRLF`; airbnb exige `LF`. Tras editar JS:
  `npx eslint src/js/ --fix`.
- Reglas que rompen (no solo avisan): `no-param-reassign` (no mutar props de parámetros →
  usar helpers/`toggleAttribute`), `no-nested-ternary`, `import/no-useless-path-segments`.

## Probar en el navegador (Playwright MCP)

Config ya incluida: `.mcp.json` (servidor `playwright`) y `.claude/settings.local.json`
(permisos playwright + plugin `frontend-design@claude-plugins-official`). El servidor MCP
se carga **al iniciar la sesión de Claude en este directorio**; si acabas de crear la
config, reinicia la sesión (o `/mcp`) para que aparezcan las herramientas `mcp__playwright__*`.

Requisitos para ver los popups: **iniciar sesión** en webtrees (los enlaces de edición solo
se renderizan para usuarios con permiso de edición). URL de una ficha de individuo (URLs
tipo `index.php?route=`; el pretty-routing no está activo en este Docker):

```
http://localhost/myfamilytree/index.php?route=%2Fmyfamilytree%2Ftree%2Ftree1%2Findividual%2FX1
```

Gotchas al verificar:
1. **Primera visita da "Cookie check" (HTTP 406/301)**: webtrees fija una cookie; vuelve a
   navegar una vez y carga.
2. Prueba: click en el lápiz de un hecho → debe abrir el **popup** (sin cambiar de página);
   Guardar → cierra y recarga con el cambio; Cancelar → cierra sin cambios. Repetir con
   "Añadir hijo/cónyuge/padre" (pestaña Familiares) y "Añadir hecho".
3. Verifica en `browser_console_messages` que no hay errores JS y en
   `browser_network_requests` que el submit es un POST AJAX (no navegación).
4. **Capturas** → guardarlas en `.playwright-mcp/` (está en `.gitignore`).

## Cómo añadir soporte a un nuevo tipo de formulario

1. Localiza el endpoint GET (`*Page`) en `../myfamilytree/app/Http/Routes/WebRoutes.php` y
   copia su **segmento de ruta** (p.ej. `/add-child-to-family/`).
2. Añádelo al array `FORM_ROUTE_SEGMENTS` en `src/js/better-webtrees-forms.js`.
3. Confirma que su vista renderiza un `form[method="post"]` dentro de `#content` (casi todas
   lo hacen) y que el `*Action` responde con `redirect()`. Si el form necesita un widget
   distinto de tom-select (calendario, CKEditor…), amplía `initWidgets()`.
4. `npm run build` y probar con Playwright.

## Estructura

```
better-webtrees-forms/
├─ module.php                     # require + return new BetterWebtreesFormsModule()
├─ BetterWebtreesFormsModule.php  # ModuleCustom + ModuleGlobal: headContent()/customTranslations()
├─ src/js/better-webtrees-forms.js    # interceptor + popup + fetch (FUENTE)
├─ src/scss/better-webtrees-forms.scss# estilos del modal (FUENTE)
├─ resources/{js,css}/            # SALIDA compilada — no editar
├─ webpack.config.js package.json babel/postcss/eslint config
├─ .mcp.json .claude/             # playwright + frontend-design
└─ CLAUDE.md
```

## Límites conocidos

- **Alcance**: formularios de individuo (editar/añadir hecho; añadir hijo/cónyuge/padre;
  editar registro). `FORM_ROUTE_SEGMENTS` está listo para ampliar a familias/fuentes/notas.
- **Widgets avanzados**: se reinicializa tom-select. El popup de calendario y CKEditor, que
  webtrees inicializa con `<script>` inline (no se ejecutan al inyectar por `innerHTML`), no
  están reactivados: los campos de fecha funcionan como texto plano. Ampliar `initWidgets()`
  si se necesitan.
- **Errores de validación**: estos `*Action` de individuo siempre redirigen; los mensajes de
  error se muestran vía FlashMessages tras la recarga, no dentro del popup.
- No se empaquetan jQuery/Bootstrap/tom-select: se reutilizan los que webtrees ya carga.
