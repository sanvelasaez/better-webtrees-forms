# CLAUDE.md — Better Webtrees Forms (repo fuente)

Módulo custom de webtrees **2.2.6** que sustituye los formularios de edición/creación
de individuos (que en webtrees navegan a una página completa) por **popups AJAX**: al
pulsar "Editar hecho", "Añadir hecho" o "Añadir hijo/cónyuge/padre" aparece un modal con
los inputs del formulario y botones Guardar/Cancelar, sin recargar ni bloquear la
navegación. Todo con `fetch` + promesas.

**v2** añade tres cosas: (1) apertura **rápida** de los popups sirviendo un fragmento
`layouts/ajax` (sin el chrome de la página) + **prefetch** al pasar el ratón; (2)
**guardado en segundo plano** con un **toast** abajo-derecha (cargando → éxito /
pendiente+Aprobar / error), sin recargar la página al confirmar; (3) estilos
**theme-agnósticos** (`--bs-*`, sirven con cualquier tema, no solo kripton).

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
2. **Prefetch** (`onPrefetchIntent`): al `mouseover`/`focusin` de un enlace interceptado
   se lanza el `fetch` del **fragmento rápido** (ver §A) y se cachea el HTML en un `Map`
   (`prefetchCache`, TTL 30 s). Así, al hacer clic, el formulario ya suele estar en caché.
3. **Abrir** (`openForm`): usa `toFastUrl(href)` para pedir la ruta **gemela `bwf-`**
   (fragmento `layouts/ajax`, sin chrome) → reutiliza la promesa prefetcheada → `DOMParser`
   → se extrae el `form[method="post"]` → se inyecta en el modal `#bwf-modal` → se
   reinicializan widgets (`webtrees.initializeTomSelect`) → **se re-ejecutan los `<script>`
   inline** (`runInlineScripts`). Si el fragmento falla o no trae `<form>`, **respaldo**:
   `fetch` de la URL original de core (página completa) y se extrae igual. `runInlineScripts`
   es crítico: `appendChild`/`innerHTML` no ejecutan los `<script>`, y webtrees los usa por
   campo. En particular los campos **NOTE** (`NoteStructure::edit()`) pintan un `<textarea>`
   y un `<select>` con el mismo `name="values[]"` y un script inline deshabilita el
   `<select>`; sin ejecutarlo se enviarían AMBOS y los conteos `levels`/`tags`/`values` no
   cuadran → el `*Action` revienta con un `assert` (HTTP 500). También reactiva el calendario.
4. **Guardar en 2º plano** (`backgroundSubmit`): al `submit` se hace `preventDefault`, se
   **cierra el modal de inmediato**, se crea un toast "Guardando…" y se lanza el POST a
   `form.action` (el `*Action` de core, que la vista ya apunta) con `FormData(form, submitter)`.
   El `*Action` responde `redirect()` 302 a la ficha; `fetch` lo sigue. Resolución del toast
   (`resolveSave`), a partir del HTML de la ficha devuelta (señales **theme/idioma-agnósticas**):
   - `!ok` → se extrae el texto del `.alert-danger` (error de validación) → toast rojo.
   - hay `[data-wt-post-url*="/accept/"]` (⇒ pendiente y el usuario es **moderador**) →
     toast "Guardado. Pendiente de revisión." + botón **Aprobar** que hace POST a esa URL
     con cabecera `X-CSRF-TOKEN` (de `<meta name="csrf">`); 200 → "Aprobado" y recarga la
     ficha si la estamos viendo.
   - hay `[data-wt-href*="pending_changes"]` sin enlace accept (editor no moderador) →
     "Guardado. Pendiente de revisión por un moderador".
   - ninguno (auto-aceptado) → "Guardado". En éxito aplicado/aprobado, si estamos viendo la
     ficha afectada se recarga tras ~1,5 s (para que el toast sea visible).
   Todo el texto del toast se inserta con `textContent` (nunca HTML del servidor) → sin XSS.
5. **Cancelar**: el botón `btn-secondary` del formulario solo cierra el modal.

### Rutas de fragmento (servidor) — §A

`BetterWebtreesFormsModule::boot()` (webtrees lo invoca en cada `ModuleCustomInterface`)
registra rutas GET **gemelas** de los endpoints de formulario de core, con prefijo `bwf-`
y renderizadas con `layouts/ajax` (solo el `<form>` + scripts inline, **sin** menú,
footer ni `head/bodyContent()` de todos los módulos → payload menor y render mucho más
barato en servidor). Cada handler vive en `src/php/RequestHandlers/` y **replica** el
data-gathering fino del `*Page` de core correspondiente, fijando `$this->layout =
'layouts/ajax'` en el constructor (la propiedad `$layout` viene del `ViewResponseTrait`;
**no** se puede redeclarar con otro valor inicial → PHP lo considera incompatible y da
Fatal error). El `action`/`post_url` del `<form>` sigue apuntando al `*Action` de core
(lo pone la propia vista), así que el **guardado no cambia**.

| Ruta módulo (`/tree/{tree}/…`)              | Handler                          | Vista / espeja |
|---------------------------------------------|----------------------------------|----------------|
| `bwf-edit-fact/{xref}/{fact_id}`            | `EditFactFragment`               | `edit/edit-fact` / `EditFactPage` |
| `bwf-add-fact/{xref}/{fact}`                | `AddFactFragment`                | `edit/edit-fact` / `AddNewFact` |
| `bwf-edit-record/{xref}`                    | `EditRecordFragment`             | `edit/edit-record` / `EditRecordPage` |
| `bwf-add-child-to-individual/{xref}`        | `AddChildToIndividualFragment`   | `edit/new-individual` / `AddChildToIndividualPage` |
| `bwf-add-parent-to-individual/{xref}/{sex}` | `AddParentToIndividualFragment`  | `edit/new-individual` / `AddParentToIndividualPage` |
| `bwf-add-spouse-to-individual/{xref}`       | `AddSpouseToIndividualFragment`  | `edit/new-individual` / `AddSpouseToIndividualPage` |

- Los handlers **no se autoloadan**: `module.php` hace `require_once` de cada uno antes de
  `return new BetterWebtreesFormsModule()`. El container de webtrees los instancia por
  reflexión (`Container::make`), auto-inyectando `GedcomEditService`. Middleware `AuthEditor`
  en cada ruta (mismo permiso que core).
- **Nota de drift**: estos handlers duplican la lógica fina de 6 controladores de core
  (fijado a 2.2.6). Si se **actualiza webtrees**, revisar que `*Page` no haya cambiado su
  data-gathering ni el nombre/keys de la vista. Si un fragmento fallara, el JS cae al
  respaldo (fetch de la ruta original de core), así que la rotura es degradación, no caída.

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
- `module.php`, `BetterWebtreesFormsModule.php` y toda la carpeta `src/php/` (los handlers
  de fragmento) vía `copy-webpack-plugin`. El `require_once` de `module.php` usa rutas
  relativas a `__DIR__`, así que `src/php/` debe existir junto al `module.php` desplegado.
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
├─ module.php                     # require_once handlers + return new BetterWebtreesFormsModule()
├─ BetterWebtreesFormsModule.php  # ModuleCustom+Global: boot() (rutas bwf-), headContent()
├─ src/php/RequestHandlers/       # 6 handlers de fragmento (layouts/ajax) — se copian a modules_v4
├─ src/js/better-webtrees-forms.js    # interceptor + popup + prefetch + toast (FUENTE)
├─ src/scss/better-webtrees-forms.scss# estilos modal + toast, theme-agnósticos (FUENTE)
├─ resources/{js,css}/            # SALIDA compilada — no editar
├─ webpack.config.js package.json babel/postcss/eslint config
├─ .mcp.json .claude/             # playwright + frontend-design
└─ CLAUDE.md
```

## Límites conocidos

- **Alcance**: formularios de individuo (editar/añadir hecho; añadir hijo/cónyuge/padre;
  editar registro). `FORM_ROUTE_SEGMENTS` está listo para ampliar a familias/fuentes/notas.
- **Widgets avanzados**: se reinicializa tom-select y se re-ejecutan los `<script>` inline
  del fragmento (`runInlineScripts`), lo que reactiva el toggle de nota compartida y el
  calendario de fechas. CKEditor (editor enriquecido), si aparece, puede requerir init
  adicional en `initWidgets()`.
- **Errores de validación**: si el `*Action` responde !ok con HTML de error, se muestra el
  texto del `.alert-danger` en el toast rojo (no se reabre el formulario — decisión de UX).
- **Aprobación**: usa el endpoint nativo `PendingChangesAcceptRecord` (POST `/accept/{xref}`
  con `X-CSRF-TOKEN`). El botón Aprobar del toast solo aparece si el HTML de la ficha trae el
  enlace accept, que webtrees renderiza **solo para moderadores** → no hace falta comprobar
  permisos en cliente.
- No se empaquetan jQuery/Bootstrap/tom-select: se reutilizan los que webtrees ya carga.
