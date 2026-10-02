# Theme Spec

> See `docs/specs/glossary.md` for Pane / Door vocabulary used in the surface hierarchy below.
> **Defers to `DESIGN.md`:** the named color rules (Bg-Only Chrome, Host-Theme-Only, Inset-Over-Border) and the Don'ts they carry. This spec owns the token plumbing under them.

VS Code supplies `--vscode-*`; standalone, website, and Pocket use `applyTheme()`
with bundled or installed themes — Pocket before first paint, including auth
([pocket-app.md](./pocket-app.md#design-system-and-theming) owns its
browser-chrome sync). **Every shipping host runs the same consumed-token
resolver** (`lib/src/lib/themes/vscode-color-resolver.ts`) before rendering.
`pnpm dev:lib` is the one exception: `lib/src/main.tsx` installs the resolver
only for a real webview and nothing on that path applies a theme, so the dev
server renders with no `--vscode-*` at all.

## Surface hierarchy

**Build every surface from the three list pairs** — the chrome, and full
standalone/Pocket screens like the auth flow, draw hierarchy from these
foreground/background pairs and nothing else (rationale):

- `app-bg` / `app-fg` — the page.
- `header-active-bg` / `header-active-fg` — the accent: a focused header, a
  titlebar band, the single primary action.
- `header-inactive-bg` / `header-inactive-fg` — a secondary surface: list rows,
  unfocused headers.

**Hierarchy is the background swap between pairs**; secondary text is alpha on
the same pair's own foreground (`text-app-fg/70`), never a separate token.

**Never carry resting structure** with `surface-raised`, `border` (panel.border),
`input-border`, or `muted` (descriptionForeground): themes may leave those unset,
so their resolved defaults form no cohesive hierarchy. `surface-raised` +
`border` are for *floating* surfaces only (popovers, dialogs, theme picker);
derive a hairline from the pair foreground at low alpha or an inset shadow
(Inset-Over-Border). Reference: `lib/src/remote/pocket-app/App.tsx`.

### Dynamic picks

`lib/src/theme-colors.css` binds most tokens to fixed VSCode keys. **Must derive dynamic tokens through the shared palette functions — runtime UI and diagnostics alike, never a fork:** Door bg/fg through `pickDoorPair`, focus ring through `pickFocusRing`, and `--color-alarm-vs-{header-active,header-inactive,door,terminal}` through `pickAlarmColor` (rationale). Their choice algorithms belong beside those functions.

The picks are published on `document.body` and refreshed on any `body` or `html`
class/style change, so applying a theme re-picks them.

Source of truth: `computeDynamicPalette()` in
`lib/src/lib/themes/dynamic-palette.ts`; `useDynamicPalette()` in
`lib/src/lib/themes/use-dynamic-palette.ts`.

## Runtime model

Two layers: `--vscode-*` holds imported or host-provided VSCode color data;
`--color-*` in `lib/src/theme-colors.css` provides the semantic Tailwind tokens
(`bg-app-bg`, `text-app-fg`, `bg-header-active-bg`).

**The colour tokens are a file a host can import without the app.**
`theme-colors.css` carries `--color-*` alone; `theme.css` layers the type scale,
fonts, animations, and component classes over it. A host rendering library
components inside its own design takes the first and never the second
(rationale).

`applyTheme()` writes the theme's `--vscode-*` to `document.body`, fills missing
consumed variables through the resolver, adds `vscode-light` / `vscode-dark` for
consumers that need the theme type, and **sets `body`'s `color-scheme` to that
polarity** so native controls follow the theme, not the OS. In real VSCode webviews
`installVscodeThemeVarResolver()` runs before React renders, materializing **only
the missing** consumed variables on `body.style` and removing stale materialized
ones once the host provides a real value.

**Selection backgrounds are flattened to opaque.** Theme authors give
`list.activeSelectionBackground` / `list.inactiveSelectionBackground` alpha;
Dormouse uses them as solid header and Workspace-tab fills, so `applyTheme()` composites
them over `sideBar.background` first (rationale).

**Must repair theme variables, theme class, and `color-scheme` lost during document hydration**, including when applying the same theme object; only an id change notifies listeners (rationale).

Each layer declares its theme-dependent tokens twice: at document level
(`@theme` so Tailwind generates utility classes, or `:root`) and on `body`, the
runtime source of truth. **Every token whose value contains `var()` — indirect
chains included — must appear at both levels with the same value**, since only
the `body` copy sees what `applyTheme()` writes to `body.style` (rationale).
`lib/src/lib/themes/consumed-keys.test.ts` enforces it **per file**, because a
host may import either layer alone. **The dynamic-palette tokens also carry
body-level baselines** matching their `@theme` declarations, so direct CSS-var
consumers render before `useDynamicPalette()` publishes refined values.

**Never put hardcoded color defaults or `var(..., fallback)` chains in
`theme-colors.css` or `theme.css`** (Host-Theme-Only Rule): hosts plus the resolver provide every
consumed `--vscode-*` before Dormouse renders.

Color IDs with `null` registry defaults are materialized component-equivalently,
since Dormouse consumes them as direct CSS variables: null foregrounds inherit
the nearest normal foreground — `list.inactiveSelectionForeground` takes
`sideBar.foreground`, then base `foreground`, **never**
`list.activeSelectionForeground` (rationale); null backgrounds inherit the
relevant surface; null borders become `transparent`, so existing border geometry
does not accidentally draw in `currentColor`.

Source of truth: `applyTheme()` in `lib/src/lib/themes/apply.ts`;
`installVscodeThemeVarResolver()` in
`lib/src/lib/themes/vscode-color-observer.ts`; `RESOLUTION_RULES` in
`lib/src/lib/themes/vscode-color-registry.ts`.

## Tool iframe themes

**Must publish the workbench's resolved `--vscode-*` variables, theme class, and `color-scheme` to proxied Tool iframes**, initially, after document loads, and on host theme changes, without reloading. **Never override third-party page backgrounds, fonts, or controls**; tools consume the variables themselves. Remove previously published variables absent from the next snapshot. Ordinary browser Surfaces and uninstrumented frames receive no theme.

**Must address only the current frame's proxy origin and verify its window identity for theme requests.** The shim accepts theme data only from its parent at the configured app origin, sets properties through CSSOM, and emits `dormouse:theme` after applying them to `html` and `body`.

Source of truth: `captureIframeTheme` / `connectIframeTheme` in `lib/src/lib/themes/iframe-theme.ts`; `iframeShim` in `lib/src/host/iframe-proxy-rewrite.ts`.

## Terminal color contract

Terminal content is orthogonal to the chrome: xterm.js reads terminal colors
straight from `--vscode-*` in `getTerminalTheme()`, after the resolver
materializes VSCode's terminal defaults (`RESOLUTION_RULES`).

**`getTerminalTheme()` carries no per-key default** — `REGISTRY_DEFAULTS` is the
one such table, and every shipping host materializes these keys first; an unset
key is omitted so xterm.js applies its own. Two exceptions: the
background/foreground pair, rostered under `DESIGN.md` → "Fixed Exceptions", and
`cursor`, which falls back to the resolved foreground because **the three colors
pushed to a DOM-less host must all be present** or the push is dropped whole.

Applying a theme updates existing terminals. **Adapters must use the
`terminal-theme.ts` API directly** — it is not re-exported through the
`terminal-registry` facade. Its `themeColorProvider` feeds the OSC 10/11/12
color-query answer.

**The owner's parser consumes `OSC 10/11/12 ; ?` and answers
`OSC <code> ; rgb:RRRR/GGGG/BBBB ST`** (8-bit channels doubled) from the active
terminal theme (rationale). **Only the `?` (report) form is intercepted**; *set*
requests pass through, and an unknown or unparseable theme falls the query
through to xterm.js. A parser with a DOM reads the theme; one without has it
pushed up ([vscode.md](vscode.md#osc-color-query-answering),
[standalone.md](standalone.md#burrow-service)).

Source of truth: `getTerminalTheme()` in `lib/src/lib/terminal-theme.ts`;
`formatOscColorResponse` in `lib/src/lib/terminal-protocol.ts`.

### OSC color queries on Windows require the bundled ConPTY

**Windows must spawn with `useConptyDll: true`** — the in-box
`CreatePseudoConsole` silently swallows color queries, while node-pty's bundled
OpenConsole (`conpty.dll`) forwards them (rationale). **Both distributions must
ship** `node-pty/prebuilds/<arch>/conpty.node` plus its sibling
`conpty/{conpty.dll,OpenConsole.exe}`: standalone via the Tauri
`resources: ["../sidecar/**/*"]` glob, the VS Code extension via
`cp -RL node_modules/node-pty dist/node-pty`. The flag also has an installer
consequence ([auto-update.md](auto-update.md#sidecar-teardown-on-windows)).

Source of truth: `useConptyDll` in `standalone/sidecar/pty-core.js`.

## Theme data

Bundled and installed themes are `DormouseTheme` objects in
`lib/src/lib/themes/`. A theme's `vars` map holds only consumed `--vscode-*`
variables plus resolver dependencies (`convertVscodeThemeColors()` filters
imported VSCode theme JSON to `CONSUMED_VSCODE_KEYS`), and **may omit any key
VSCode itself would omit** — `completeThemeVars()` fills those from registry
defaults and the inheritance rules above.

**Must check in both generated bundles so builds need no network.** **Must use `convertVscodeThemeColors` and `uiThemeToType` in both the build and browser importers.**

**Never** ship a theme in `bundled.json` without its `bundled-extensions.json`
record, or keep a record no theme uses — that file is the provenance the
supply-chain page publishes ([security-supply-chain.md](./security-supply-chain.md#disclosure)). Records carry the
`extensionId` joining them to the `<extensionId>.<slug>` theme ids;
`lib/src/lib/themes/bundled-extensions.test.ts` pins both directions.

**Must tolerate unreadable storage and failed active-id writes during theme restoration**, and **discard malformed installed-theme records while retaining valid ones.**

**`subscribeToActiveTheme()` notifies only on a *different* theme, compared by
id, not object identity** (rationale). It serves the website tutorial's theme step
([tutorial.md](./tutorial.md)); **never** reach for `onTerminalThemeChange()`
instead (rationale).

Source of truth: `DormouseTheme` in `lib/src/lib/themes/types.ts`; build importer in `lib/scripts/bundle-themes.mjs`; `fetchExtensionThemes` in `lib/src/lib/themes/openvsx.ts`; `lib/src/lib/themes/store.ts`.

## Where the user picks a theme

**Every host that lets the user pick a theme does it in the Settings dialog**;
**host chrome — the standalone titlebar, the website playground navbar — carries
none**. Pages with no Settings dialog — the `/playground/pocket` mounts and the
docs pages — use the free-floating `compact` picker (rationale).

- **VS Code offers none at all** (rationale). `VSCodeAdapter` sets the optional
  `hostOwnsTheme` capability and the dialog hides its Theme row
  (`docs/specs/transport.md` → Adapter model).
- **Each host restores at boot**, since the picker mounts only when the dialog
  opens: standalone calls `restoreActiveTheme()`; the website and Pocket use
  `useRestoredTheme()`, which applies at render init **and repeats after
  commit** (hydration again), Pocket passing `restorePocketTheme` so its
  browser-chrome sync rides the same lifecycle.
- **The host's fallback theme is module state, not a prop.**
  `setDefaultThemeId()` holds it and `restoreActiveTheme()` takes no argument, so
  every path re-resolving the active theme gets the same answer (rationale).
  **`useRestoredTheme()` latches it before its first restore and ahead of any
  child render** (rationale).
- **The picker renders the bundled default through hydration, then reconciles
  stored themes and selection in a layout effect** (rationale).
- **Every candidate previews in its own palette**, resolved through
  `resolveThemeVars` — the path `applyTheme` paints (rationale). Omissions
  resolve from the candidate's polarity, never the document's, and **previewing
  neither applies a theme nor writes storage**.
- **Chrome outside the previews styles itself in `--color-*` utilities.** A host
  rendering library JSX scans `lib/src` and imports `theme-colors.css`, or none
  of those utilities reach it (rationale). Controls *inside* a preview take
  `themePreviewButton`, inheriting the candidate's `currentColor`
  (Concentric-Corners exception: entry corners against the swatch).
- **`onPick` reports the choice, not the change.** `restoreActiveTheme` persists
  the id it resolved, so `dormouse:active-theme` exists whether or not anyone
  chose, and `subscribeToActiveTheme` is silent on a re-pick. Only the picker
  reports explicit choices.
- **`useAnchoredMenu` returns a dropdown's whole geometry; a caller never
  re-implements placement beside it** (rationale).

Source of truth: `ThemePicker` in `lib/src/components/ThemePicker.tsx`;
`setDefaultThemeId()` / `restoreActiveTheme()` / `resolveThemeVars` in
`lib/src/lib/themes/apply.ts`; `useRestoredTheme()` in
`lib/src/lib/themes/use-restored-theme.ts`; `useAnchoredMenu` in
`lib/src/components/use-anchored-menu.ts`; the colour import and `@source` in
`website/src/index.css`.

## Storybook simulation

**Must scan `standalone/src` in `lib/.storybook/preview.css`** for host utilities.

`lib/.storybook/themes.ts` builds the switcher's color maps from `bundled.json`
and **must run them through `completeThemeVars()` and `flattenSelectionAlpha()`**
so isolated stories see the materialized `--vscode-*` set the app sees; the
preview writes them to both `html` and `body` and publishes the dynamic palette
through `computeDynamicPalette()`.

**Must name `DejaVu Sans` before generic `monospace` as the symbol fallback in
visual snapshots in both browsers, and install `fonts-dejavu-core` in the Argos job** (rationale).

Source of truth: `applyStorybookTheme` in `lib/.storybook/preview.ts`.

## Theme debugger

The Theme Debugger serves VSCode, standalone, and the website
playground. **Must capture DOM-visible state through `ThemeDiagnosticSnapshot` without mutating theme storage or terminal colors.** Terminal colors are the visible CSS variables, including missing values, rather than an initialized xterm instance's palette. The copied report uses the same snapshot. **A real VSCode webview shows only the inferred theme kind**, since the host supplies CSS variables. In VS Code it traces only host-exposed `--vscode-*` variables and materialized fallbacks, **never raw built-in VS Code theme files**.

Every host with a picker reaches it as `Debug current theme` in the `ThemePicker` menu. VSCode has no picker and opens it through the `dormouse.debugTheme` command and the
`dormouse:openThemeDebugger` extension-to-webview message.

Source of truth: `captureThemeDiagnostics()` / `ThemeDiagnosticSnapshot` in
`lib/src/lib/themes/diagnostics.ts`.
