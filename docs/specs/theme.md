# Theme Spec

> See `docs/specs/glossary.md` for Pane / Door vocabulary used in the surface hierarchy below.
> **Defers to `DESIGN.md`:** the named color rules (Bg-Only Chrome, Host-Theme-Only, Inset-Over-Border) and the Don'ts they carry. This spec owns the token plumbing under them.

VS Code supplies `--vscode-*` itself; standalone, website, and Pocket get the
same variable shape from `applyTheme()` and a bundled or installed theme — Pocket
before its first paint, auth screens included
([pocket-app.md](./pocket-app.md#design-system-and-theming) owns its
browser-chrome sync). **Every path runs the same consumed-token resolver**
(`lib/src/lib/themes/vscode-color-resolver.ts`), so omitted theme JSON keys
behave like VSCode registry defaults before Dormouse renders.

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
the same pair's own foreground (`text-app-fg/70`), never a separate token. The
rest is `DESIGN.md`'s: bg-only chrome, no pass-through `--mt-*` layer or one-off
tokens, no `text-muted` inside a header — **use `hover:bg-current/10`** there,
with the `text-alarm-vs-*` ringing tint and destructive-action error styling as
the semantic exceptions.

**Never carry resting structure** with `surface-raised`, `border` (panel.border),
`input-border`, or `muted` (descriptionForeground): themes may leave those unset,
so their resolved defaults form no cohesive hierarchy. `surface-raised` +
`border` are for *floating* surfaces only (popovers, dialogs, theme picker);
derive a hairline from the pair foreground at low alpha or an inset shadow
(Inset-Over-Border). Reference: `lib/src/remote/pocket-app/App.tsx`.

### Dynamic picks

`lib/src/theme.css` binds most tokens to a fixed VSCode key. Seven are picked at
runtime instead:

| Token | Pick |
|---|---|
| `--color-door-bg` / `--color-door-fg` | whichever pair — inactive-header or terminal bg/fg — sits further from `--color-app-bg` in OKLab |
| `--color-focus-ring` | a chromatic `focusBorder`, else a chromatic active-header background, else the candidate furthest from `--color-app-bg`; "chromatic" is OKLab chroma ≥ `FOCUS_RING_SATURATION_FLOOR` |
| `--color-alarm-vs-{header-active,header-inactive,door,terminal}` | plain white or black, by the OKLab lightness of the background the alert treatment sits on (rationale) |

The terminal alarm tint drives the whole-Pane spoken-alarm overlay.
`--color-alarm-vs-door` derives from `--color-door-bg` the same pass computes, so
the pass after a theme change reads the stale door bg; the `MutationObserver`
re-firing on the pass's own `body.style` write corrects it on the next.

**Never fork the dynamic picks:** runtime UI and diagnostics must use
`pickDoorPair()`, `pickFocusRing()`, and `pickAlarmColor()`.

Source of truth: `computeDynamicPalette()` in
`lib/src/lib/themes/dynamic-palette.ts`; OKLab distance/chroma helpers in
`lib/src/lib/color-contrast.ts`; `useDynamicPalette()` in
`lib/src/lib/themes/use-dynamic-palette.ts` (mounted by Wall and
MobileTerminalUi, publishes on `document.body`); exports in
`lib/src/lib/themes/index.ts`.

## Runtime model

Two layers: `--vscode-*` holds imported or host-provided VSCode color data;
`--color-*` in `lib/src/theme.css` provides the semantic Tailwind tokens
(`bg-app-bg`, `text-app-fg`, `bg-header-active-bg`).

`applyTheme()` writes the theme's `--vscode-*` to `document.body`, fills missing
consumed variables through the resolver, adds `vscode-light` / `vscode-dark` for
consumers that need the theme type, and **sets `body`'s `color-scheme` to that
polarity** so native controls (form inputs, scrollbars, autofill) follow the
theme, not the OS. In real VSCode webviews
`installVscodeThemeVarResolver()` runs before React renders, materializing **only
the missing** consumed variables on `body.style` and removing stale materialized
ones once the host provides a real value.

**Selection backgrounds are flattened to opaque.** Theme authors give
`list.activeSelectionBackground` / `list.inactiveSelectionBackground` alpha;
Dormouse uses them as solid header/AppBar fills, so `applyTheme()` composites
them over `sideBar.background` first (rationale).

**A same-theme `applyTheme()` call is a no-op only while the expected inline
`--vscode-*` variables and the `vscode-light` / `vscode-dark` class are still on
`document.body`**, and **ThemePicker re-restores in a layout effect after mount**
— React Router document hydration can reconcile those writes away (rationale).

`theme.css` declares the theme-dependent tokens twice: at document level
(`@theme` so Tailwind generates utility classes, or `:root`) and on `body`, the
runtime source of truth. **Every token whose value contains `var()` — indirect
chains included — must appear at both levels with the same value**, since only
the `body` copy sees what `applyTheme()` writes to `body.style` (rationale).
`lib/src/lib/themes/consumed-keys.test.ts` enforces it. **The seven
dynamic-palette tokens also carry body-level baselines** matching their `@theme`
declarations, so direct CSS-var consumers (the mobile gesture SVG, a bell ringing
before the first pass) render before `useDynamicPalette()` publishes refined
values.

**Never put hardcoded color defaults or `var(..., fallback)` chains in
`theme.css`** (Host-Theme-Only Rule): hosts plus the resolver provide every
consumed `--vscode-*` before Dormouse renders.

Color IDs with `null` registry defaults are materialized component-equivalently,
since Dormouse consumes them as direct CSS variables: null foregrounds inherit
the nearest normal foreground — `list.inactiveSelectionForeground` takes
`sideBar.foreground`, then base `foreground`, **never**
`list.activeSelectionForeground` (rationale); null backgrounds inherit the
relevant surface; null borders become `transparent`, so existing border geometry
does not accidentally draw in `currentColor`.

Source of truth: `applyTheme()` in `lib/src/lib/themes/apply.ts`;
`flattenSelectionAlpha()` in `lib/src/lib/themes/flatten-alpha.ts`;
`installVscodeThemeVarResolver()` in
`lib/src/lib/themes/vscode-color-observer.ts`; `RESOLUTION_RULES` in
`lib/src/lib/themes/vscode-color-registry.ts`.

## Terminal color contract

Terminal content is orthogonal to the chrome: xterm.js reads terminal colors
straight from `--vscode-*` in `getTerminalTheme()`, which fills `ITheme`'s
background, foreground, cursor, selectionBackground, and 16 ANSI entries. The
resolver materializes the VSCode terminal defaults first — when unset,
`terminal.background` inherits `editor.background`, `terminalCursor.foreground`
inherits `terminal.foreground`, `terminal.selectionBackground` inherits
`editor.selectionBackground`, and `terminal.foreground` takes VSCode's terminal
foreground registry default.

A `MutationObserver` re-reads these on class or style mutations of `body` or
`html`, so applying a theme updates existing terminals. **Adapters must use the
`terminal-theme.ts` API directly** — it is not re-exported through the
`terminal-registry` facade. Its `themeColorProvider` answers OSC 10/11/12 color
queries; the escape contract is [terminal-escapes.md](./terminal-escapes.md)'s.

Source of truth: `getTerminalTheme()` in `lib/src/lib/terminal-theme.ts`.

## Theme data

Bundled and installed themes are `DormouseTheme` objects in
`lib/src/lib/themes/`. A theme's `vars` map holds only consumed `--vscode-*`
variables plus resolver dependencies (`convertVscodeThemeColors()` filters
imported VSCode theme JSON to `CONSUMED_VSCODE_KEYS`), and **may omit any key
VSCode itself would omit** — `completeThemeVars()` fills those from registry
defaults and the inheritance rules above.

`lib/scripts/bundle-themes.mjs` bakes the bundled themes at build time (VSIX from
OpenVSX → unzip → resolve `%nls%` labels → filter colors → `bundled.json` +
`bundled-extensions.json`, **both checked in so builds need no network**).
`lib/src/lib/themes/openvsx.ts` does the same in-browser for user-installed
themes, **dynamically importing `fflate` and `jsonc-parser`** to keep them out of
the initial bundle. The build script cannot import TS, so it restates the
consumed-key list; `lib/src/lib/themes/consumed-keys.test.ts` pins the two.

**Never** ship a theme in `bundled.json` without its `bundled-extensions.json`
record, or keep a record no theme uses — that file is the provenance the
supply-chain page publishes ([SECURITY.md](../../SECURITY.md)). Records carry the
`extensionId` joining them to the `<extensionId>.<slug>` theme ids;
`lib/src/lib/themes/bundled-extensions.test.ts` pins both directions.

**`subscribeToActiveTheme()` notifies only on a *different* theme, compared by
id, not object identity** (rationale) — so a same-theme re-apply, re-selecting
the active theme, and the boot-time `restoreActiveTheme()` never read as a user
picking one. It exists for the website tutorial's theme step
([tutorial.md](./tutorial.md)); **never** reach for `onTerminalThemeChange()`
instead (rationale).

Source of truth: `subscribeToActiveTheme()` in `lib/src/lib/themes/apply.ts`;
`onTerminalThemeChange()` in `lib/src/lib/terminal-theme.ts`.

## Where the user picks a theme

**Every host that lets the user pick a theme does it in the Settings dialog**,
opened from the far right of the baseboard (alarm sections in
[alert.md](./alert.md)); **host chrome — the standalone titlebar, the website
playground navbar — carries none**.

- **VS Code offers none at all** (rationale). `VSCodeAdapter` sets the optional
  `hostOwnsTheme` capability and the dialog hides its Theme row
  (`docs/specs/transport.md` → Adapter model).
- **Each host restores at boot**, since the picker mounts only when the dialog
  opens: `standalone/src/main.tsx` calls `restoreActiveTheme()`; the website
  playground pages and Pocket use `useRestoredTheme()`, which applies at render
  init **and repeats after commit** (hydration again). Pocket passes
  `restorePocketTheme` as its `restore` argument so the browser-chrome sync rides
  the same lifecycle.
- The two `/playground/pocket` marketing mounts and the docs pages keep the
  free-floating `compact` picker (rationale); the docs pages give it two
  placements, floating at `lg` and inline in the mobile bar. **Both variants
  show the active theme's `ThemeSwatch`** — beside its label on the dialog
  trigger, beside the word "Theme" in `compact`.
- **`compact` takes its menu offset from style, never a Tailwind class**
  (`menuSide`): the website renders against the lib's *prebuilt* stylesheet, so
  a utility the lib never emitted is absent there and the menu drops to its
  static position.
- **`onPick` reports the choice, not the change.** `restoreActiveTheme` persists
  the id it resolved, so `dormouse:active-theme` exists whether or not anyone
  chose, and `subscribeToActiveTheme` is silent on a re-pick. Only the picker
  can answer "has this person chosen yet".
- **The host's fallback theme is module state, not a prop.**
  `setDefaultThemeId()` holds it and `restoreActiveTheme()` takes no argument, so
  every path re-resolving the active theme gets the same answer (rationale).
  **`useRestoredTheme()` latches it before its first restore and ahead of any
  child render** (rationale).
- **Never use `window.confirm`** — no native dialog in app chrome at all
  (`DESIGN.md` → "Don't"; rationale). Uninstalling is a single click, matching
  `WatchedCommandList`'s remove control in the same dialog, and **the picker
  row's `X` keeps a gap from the row's select target** (rationale).
- **The dropdown renders `position: fixed`, anchored off the measured trigger
  rect**, because the `overflow-y-auto` dialog surface would clip an
  absolutely-positioned one; it closes on scroll. Anchoring and dismissal are
  shared with the dialog's Shell row. **The dialog owns the dropdown's open
  state** so `Escape` closes the menu before the dialog; `ModalFrame`'s
  capture-phase handler would otherwise swallow the key.
- **Heights follow the viewport, never a fixed pixel budget**: both surfaces cap
  at `OVERLAY_MAX_HEIGHT` (dialog `.modal`, dropdown `.popover`), not a `dvh` of
  their own. The list's `max-h-80` is a *ceiling*, not a floor — the panel cap
  shrinks it on a short screen while the footer actions stay put. Pinned by the
  `OpenOnShortViewport` story, not a unit test (rationale).

Source of truth: `lib/src/components/SettingsDialog.tsx`; `setDefaultThemeId()` /
`restoreActiveTheme()` in `lib/src/lib/themes/apply.ts`; `useRestoredTheme()` in
`lib/src/lib/themes/use-restored-theme.ts`; `restorePocketTheme` in
`lib/src/remote/pocket-app/pocket-theme.ts`; `useAnchoredMenu` /
`useCloseOnOutsideAndEscape` in `lib/src/components/use-anchored-menu.ts`;
`OVERLAY_MAX_HEIGHT` in `lib/src/components/design.tsx`.

## Storybook simulation

`lib/.storybook/themes.ts` builds the switcher's color maps from `bundled.json`
and **must run them through `completeThemeVars()` and `flattenSelectionAlpha()`**
(with `applyTheme()`'s host typography defaults) so isolated stories see the
materialized `--vscode-*` set the app sees. The preview decorator writes them to
both `html` (VSCode's host globals) and `body` (matching `applyTheme()`), and
publishes the dynamic palette through `computeDynamicPalette()` so stories
outside a full Wall — doors, focus rings, ringing bells — still get the runtime
picks. `PREFERRED_STORYBOOK_THEME` in `lib/.storybook/preview.ts` names
the default simulated host theme, **falling back to the first bundled theme** so
a renamed or removed bundle cannot leave stories without theme vars.

## Theme debugger

A diagnostic-only Theme Debugger shared by VSCode, standalone, and the website
playground. **It never mutates theme storage or terminal colors** — it snapshots
DOM-visible state: theme metadata, every visible `--vscode-*` tagged
host-provided vs Dormouse-materialized with its declaration site and resolver
trace, the `--color-*` tokens with their bound key, the terminal palette xterm.js
reads, and the dynamic picks with candidate metrics and a prose reason
(`ThemeDiagnosticSnapshot` owns the shape). The copied report is a text dump of
the same snapshot. **A real VSCode webview shows only the *inferred* theme
kind**, since VSCode exposes CSS variables and not raw built-in theme JSON.

Every host reaches it as `Debug current theme` in the `ThemePicker` menu, so on
`/playground/pocket` it rides the `compact` variant (two mounts, defaulting to
Kimbie Dark; `/pocket` redirects before rendering a picker). VSCode has no picker
and opens it through the `dormouse.debugTheme` command and the
`dormouse:openThemeDebugger` extension-to-webview message.

Source of truth: `captureThemeDiagnostics()` / `ThemeDiagnosticSnapshot` in
`lib/src/lib/themes/diagnostics.ts`.
