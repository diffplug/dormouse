# Theme Spec

> See `docs/specs/glossary.md` for Pane / Door vocabulary used in the surface hierarchy below.

Dormouse's theme contract is small: render the terminal chrome with
VSCode-appropriate surfaces, and terminal content with theme-appropriate
xterm.js colors.

VSCode extension mode gets `--vscode-*` variables from VSCode. Standalone,
website, and Pocket apply the same shape of variables to `document.body` with
`applyTheme()` from a bundled or installed Dormouse theme. Pocket restores
before its first paint — auth screens included — and additionally syncs
document-level browser chrome (`color-scheme`, `meta[name="theme-color"]`, see
[pocket-app.md](./pocket-app.md#design-system-and-theming)). All paths run
the same consumed-token resolver from
`lib/src/lib/themes/vscode-color-resolver.ts` so omitted theme JSON keys behave
like VSCode registry defaults before Dormouse renders.

## Surface hierarchy

**Use bg-only chrome** for panes and doors — never borders to make the hierarchy
work. The chrome is anchored on VSCode's file-tree styling, whose colors are
designed to read clearly inside the sidebar host area.

**Build every surface from the three list pairs.** The chrome — and full
standalone/Pocket screens like the auth flow — must draw hierarchy from three
cohesive foreground/background pairs, and nothing else:

- `app-bg` / `app-fg` — the page.
- `header-active-bg` / `header-active-fg` — the accent: a focused header, a
  titlebar band, the single primary action. (Kimbie Dark renders it caramel.)
- `header-inactive-bg` / `header-inactive-fg` — a secondary surface: list rows,
  unfocused headers.

Hierarchy is the background swap between these pairs; secondary text is alpha on
the same pair's own foreground (`text-app-fg/70`), never a separate token.

**Never reintroduce** a pass-through `--mt-*` layer or one-off tokens for tabs,
badges, accents, or button hovers unless the hierarchy cannot express a new
rendered surface.

**Never carry resting structure** with `surface-raised`, `border` (panel.border),
`input-border`, or `muted` (descriptionForeground): themes leave those unset, and
the resolver then hands back a generic value unrelated to the theme. Kimbie Dark
is the cautionary case — `editorWidget.background` is near-black (`#131510`, a
dark patch, not a gentle lift), and `panel.border` / `input.border` /
`descriptionForeground` are all unset, so hairlines land on VSCode's flat
`#80808059` (or `transparent`, for `input.border`, which has no registry default
in any kind) and a card-and-border layout collapses into invisible edges.
`surface-raised` + `border` are for *floating* surfaces only (popovers, dialogs,
theme picker). Derive a genuinely needed hairline from a pair foreground at low
alpha or an inset shadow (`DESIGN.md`'s Inset-Over-Border rule), never a border
token. Reference implementation: the Pocket auth chrome in
`lib/src/remote/pocket-app/App.tsx`.

**Never add `text-muted` inside headers** — header-internal text and buttons
inherit the header foreground; use `hover:bg-current/10` for neutral hover
feedback. Semantic exceptions are the `text-alarm-vs-*` tint for ringing alerts
and error styling for destructive actions.

High-contrast VSCode themes may make bg-only chrome look flatter than normal —
accepted; terminal content still uses the theme's terminal palette.

### Dynamic picks

`lib/src/theme.css` binds most tokens to a fixed VSCode key. Seven are picked at
runtime instead — `--color-door-bg` / `--color-door-fg`, `--color-focus-ring`,
and the four per-surface alarm tints
`--color-alarm-vs-{header-active,header-inactive,door,terminal}`. Source of
truth: `computeDynamicPalette()` in `lib/src/lib/themes/dynamic-palette.ts`,
using the OKLab distance/chroma helpers in `lib/src/lib/color-contrast.ts`;
`useDynamicPalette()` (`lib/src/lib/themes/use-dynamic-palette.ts`, mounted by
Wall and MobileTerminalUi) publishes them on `document.body`. Public theme
helpers are exported from `lib/src/lib/themes/index.ts`.

- **Door bg/fg** takes whichever pair — inactive-header or terminal bg/fg — sits
  further from `--color-app-bg` in OKLab.
- **Focus ring** prefers a chromatic `focusBorder`, then a chromatic
  active-header background, then whichever candidate is furthest from
  `--color-app-bg`. "Chromatic" is OKLab chroma ≥ `FOCUS_RING_SATURATION_FLOOR`.
- **Alarm tints** are plain white or black, picked by the OKLab lightness of the
  background the alert treatment sits on (`pickAlarmColor`) — luminance contrast
  dominates visibility, so a flat black/white pick beats a chroma rotation. The
  terminal variant drives the whole-Pane spoken-alarm overlay. Because
  `--color-alarm-vs-door` derives from `--color-door-bg`, which the same pass
  computes, the first pass after a theme change reads the previous door bg; the
  `MutationObserver` re-fires on the pass's own `body.style` write, so the next
  pass corrects it.

**Never fork the dynamic picks:** runtime UI and diagnostics must use
`pickDoorPair()`, `pickFocusRing()`, and `pickAlarmColor()`.

## Runtime model

Dormouse has two theme layers:

1. `--vscode-*` variables hold imported or host-provided VSCode color data.
2. `--color-*` variables in `lib/src/theme.css` provide semantic Tailwind
   tokens such as `bg-app-bg`, `text-app-fg`, and `bg-header-active-bg`.

`applyTheme()` sets imported `--vscode-*` variables on `document.body`, fills
missing consumed variables through the VSCode resolver, and adds either
`vscode-light` or `vscode-dark` for consumers that need the theme type. It also
sets `body`'s `color-scheme` to that polarity, so native controls (form inputs,
scrollbars, autofill) follow the theme rather than the OS preference. In real
VSCode webviews, `installVscodeThemeVarResolver()` runs before React renders; it
reads host-provided variables, materializes only missing Dormouse-consumed
variables on `body.style`, and removes stale materialized variables when the
host starts providing a real value.

**Selection backgrounds are flattened to opaque.** Theme authors give
`list.activeSelectionBackground` / `list.inactiveSelectionBackground` alpha
because VSCode composites them over the sidebar; Dormouse uses them as solid
header/AppBar fills, so `applyTheme()` composites them over `sideBar.background`
(`flattenSelectionAlpha()` in `lib/src/lib/themes/flatten-alpha.ts`) before
writing them. Without it whatever sits behind the surface bleeds through —
Selenized Dark's `#0096f588` AppBar, for instance. Storybook runs the same pass.

Website routes hydrate as a full React Router document, so React can reconcile
the server `<body>` and drop render-time `body.style` and class side effects.
`applyTheme()` therefore treats a same-theme call as a no-op only when the
expected inline `--vscode-*` variables and `vscode-light` / `vscode-dark` class
are still visible on `document.body`; ThemePicker additionally re-restores in a
layout effect after mount, so hydration cannot leave the picker claiming a theme
is active while xterm.js sees fallback colors.

`theme.css` declares the theme-dependent tokens twice: at document level
(`@theme` so Tailwind generates utility classes, or `:root`) and on `body`,
the runtime source of truth. **Every token whose value contains `var()` —
indirect chains included — must appear at both levels with the same value**,
because CSS resolves `var()` inside a custom-property declaration at the element
where the property is declared: only the `body` copy sees the `--vscode-*`
variables `applyTheme()` writes to `body.style`, so a token declared only at
document level resolves to nothing wherever `applyTheme()` is the sole writer
(standalone, website, Pocket). `lib/src/lib/themes/consumed-keys.test.ts`
enforces this. Dynamic palette tokens (`--color-door-bg`, `--color-door-fg`,
`--color-focus-ring`, and the four `--color-alarm-vs-*` tokens) also have
body-level baseline bindings matching the `@theme` declarations, so direct
CSS-var consumers such as the mobile gesture SVG — and a ringing bell before
the first dynamic pass — render visibly before `useDynamicPalette()` publishes
refined values.

**Never put hardcoded color defaults or `var(..., fallback)` chains in
`theme.css`**; runtime hosts plus the shared resolver provide the consumed
`--vscode-*` variables before Dormouse renders.

VSCode color IDs with `null` registry defaults need component-equivalent
materialization, because Dormouse consumes them through direct CSS variables.
Source of truth: `RESOLUTION_RULES` in
`lib/src/lib/themes/vscode-color-registry.ts`. Their shape:

- `list.inactiveSelectionForeground` resolves to normal foreground
  (`sideBar.foreground`, then base `foreground`), not
  `list.activeSelectionForeground`. This matches VSCode list/tree behavior where
  an inactive selected row does not force active-selection white text.
- Null foregrounds inherit the nearest normal foreground.
- Null backgrounds inherit the relevant surface.
- Null border colors materialize as `transparent` so Dormouse's existing border
  geometry does not accidentally draw in `currentColor`.

## Terminal color contract

Terminal content is orthogonal to the chrome. xterm.js reads terminal colors
directly from `--vscode-*` in `getTerminalTheme()`
(`lib/src/lib/terminal-theme.ts`), which fills the `ITheme` background,
foreground, cursor, selectionBackground, and the 16 ANSI entries. The resolver
materializes the VSCode terminal defaults before those values are read:

- `terminal.background` inherits `editor.background` when unset.
- `terminal.foreground` uses VSCode's terminal foreground registry default.
- `terminalCursor.foreground` inherits `terminal.foreground` when unset.
- `terminal.selectionBackground` inherits `editor.selectionBackground` when
  unset.

The `terminal-theme.ts` `MutationObserver` re-reads these values on class or
style mutations of `body` or `html`, so applying a theme updates existing
terminals. Adapters use the `terminal-theme.ts` API directly — it is not
re-exported through the `terminal-registry` facade. Its `themeColorProvider`
answers OSC 10/11/12 color queries; the escape contract is in
[terminal-escapes.md](./terminal-escapes.md).

## Theme data

Bundled and installed themes are `DormouseTheme` objects in
`lib/src/lib/themes/`. A theme's `vars` map contains only consumed `--vscode-*`
variables plus resolver dependencies: `convertVscodeThemeColors()` filters
imported VSCode theme JSON to `CONSUMED_VSCODE_KEYS`. Themes may omit keys that
VSCode itself would omit, because `completeThemeVars()` fills those from registry
defaults and the inheritance rules above.

Bundled themes are baked at build time by `lib/scripts/bundle-themes.mjs` (fetch
the VSIX from OpenVSX → unzip → resolve `%nls%` labels → filter colors →
`bundled.json` + `bundled-extensions.json`, both checked in so builds need no
network). `lib/src/lib/themes/openvsx.ts` does the same conversion in the
browser for user-installed themes, with `fflate` and `jsonc-parser` dynamically
imported so they stay out of the initial bundle. The build script cannot import
TS, so it restates the consumed-key list; the two are pinned together by
`lib/src/lib/themes/consumed-keys.test.ts`.

`subscribeToActiveTheme()` in `lib/src/lib/themes/apply.ts` notifies when a
*different* theme is applied — compared by id, not object identity, since
installed themes are re-parsed from storage and so are a fresh object on every
read. A same-theme re-apply (the hydration repeat above) is not a change, and
neither is re-selecting the active theme, so the boot-time `restoreActiveTheme()`
cannot be mistaken for a user picking one. It exists for the website tutorial's
theme step ([tutorial.md](./tutorial.md)); **never** reach for
`onTerminalThemeChange()` (`terminal-theme.ts`) instead, which watches resolved
xterm palette JSON through a `MutationObserver` and fires on the first mutation
after it starts.

## Where the user picks a theme

**Every host that lets the user pick a theme does it in the Settings dialog**,
opened from the far right of the baseboard
(`lib/src/components/SettingsDialog.tsx`, alarm sections in
[alert.md](./alert.md)). Host chrome — the standalone titlebar, the website
playground navbar — carries no theme control.

- **VS Code** offers none at all. `VSCodeAdapter` sets the optional
  `hostOwnsTheme` capability on `PlatformAdapter` and the dialog hides its Theme
  row when it is set; VS Code supplies `--vscode-*` itself and its own theme UI
  is the only correct control there. Absent reads as `false`, so every other
  adapter gets the row.
- Because the picker mounts only when the dialog opens, its own render-time
  `restoreActiveTheme()` can no longer theme a page, so **each host restores at
  boot**: `standalone/src/main.tsx` calls `restoreActiveTheme()` directly, while
  the website playground pages and Pocket use `useRestoredTheme()`
  (`lib/src/lib/themes/use-restored-theme.ts`), which applies at render init and
  repeats after commit because React Router document hydration can reconcile the
  render-time `body.style` writes away. Pocket passes `restorePocketTheme` as the
  hook's `restore` argument so its browser-chrome sync rides the same lifecycle
  (`lib/src/remote/pocket-app/pocket-theme.ts`).
- The two `/playground/pocket` marketing mounts keep the free-floating `compact`
  picker: those pages render a mobile prototype with no baseboard, so there is no
  Settings dialog to put it in. The dialog variant's collapsed trigger carries
  the active theme's `ThemeSwatch` and label so it reads as the same control as
  the row it stands in for; `compact` shows the swatch beside the word "Theme".
- **The host's fallback theme is module state, not a prop.**
  `setDefaultThemeId()` in `lib/src/lib/themes/apply.ts` (shaped like
  `shell-defaults.ts`) holds it and `restoreActiveTheme()` takes no argument, so
  every path that re-resolves the active theme gets the same answer — uninstalling
  the active theme is reachable from two depths (the picker row's `X`, the store
  dialog's `Remove`), and a prop-held fallback is missing on one of them, which
  drops to the first bundled theme instead of the host's. `useRestoredTheme()`
  latches it before its first restore and ahead of any child render, because on
  the desktop Pocket page the header's picker mounts before the component that
  calls the hook.
- **Never use `window.confirm`** — no native dialog in app chrome at all
  (`DESIGN.md` → "Don't"): on the desktop app the call returns without ever
  showing a dialog, so an uninstall gated on it silently did nothing.
  Uninstalling is a single click, matching `WatchedCommandList`'s remove control
  in the same dialog. Recovery is not symmetric though — the store dialog's
  `Remove` leaves the extension row on screen to re-install, while the picker
  row's `X` means re-finding the extension through an OpenVSX search — so that
  control keeps a gap from the row's select target rather than sitting flush.
- The dropdown renders `position: fixed`, anchored off the measured trigger rect,
  because the dialog surface is `overflow-y-auto` and would clip an
  absolutely-positioned one; it closes on scroll rather than drifting off its
  trigger. Anchoring and dismissal are shared with the dialog's Shell row —
  source of truth: `useAnchoredMenu` / `useCloseOnOutsideAndEscape` in
  `lib/src/components/use-anchored-menu.ts`. The dialog owns the dropdown's open
  state so `Escape` closes the menu before the dialog; `ModalFrame`'s
  capture-phase Escape handler would otherwise swallow the key first.
- Heights follow the viewport, never a fixed pixel budget: both surfaces take
  their cap from `OVERLAY_MAX_HEIGHT` in `lib/src/components/design.tsx` (dialog
  `.modal`, dropdown `.popover`) rather than a `dvh` value of their own. The
  list's `max-h-80` is a *ceiling* on a tall screen, not a floor — it is `flex-1
  min-h-0`, so the panel cap shrinks it on a short one while the footer actions
  stay put. Pinned by the `OpenOnShortViewport` story rather than a unit test,
  since jsdom runs no layout.

## Storybook simulation

`lib/.storybook/themes.ts` builds the switcher's color maps from `bundled.json`,
and must put them through `completeThemeVars()` and `flattenSelectionAlpha()`
(with the same host typography defaults as `applyTheme()`) so isolated stories
see the materialized `--vscode-*` set the app sees. The preview decorator writes
them to both `html` (simulating VSCode's host globals) and `body` (matching
`applyTheme()`), and publishes the dynamic palette through the shared
`computeDynamicPalette()` helper so stories rendering doors, focus rings, or
ringing bells outside a full Wall still get the runtime picks.
`PREFERRED_STORYBOOK_THEME` in `lib/.storybook/preview.ts` names the default
simulated host theme, falling back to the first bundled theme so a renamed or
removed bundle cannot leave stories without theme vars.

## Theme debugger

A diagnostic-only Theme Debugger shared by VSCode, standalone, and the website
playground. It never mutates theme storage or terminal colors — it snapshots the
DOM-visible theme state via `captureThemeDiagnostics()`
(`lib/src/lib/themes/diagnostics.ts`): active theme metadata, every visible
`--vscode-*` variable tagged host-provided vs Dormouse-materialized and where it
is declared, a per-variable resolver trace (provided value, registry default for
the kind, null-default fallback path, resolved value, origin), the semantic
`--color-*` tokens with their bound `--vscode-*` key, the terminal palette
xterm.js reads, and the dynamic door/focus-ring picks with candidate metrics and
a prose reason. The copied report is a shareable text dump of the same snapshot.
A real VSCode webview shows only the *inferred* theme kind rather than theme
metadata, because VSCode exposes CSS variables and not raw built-in theme JSON.

Every host reaches it as `Debug current theme` in the `ThemePicker` menu — inside
the Settings dialog on standalone and the desktop playground, in the free-floating
`compact` picker on `/playground/pocket` (whose two mounts default to Kimbie
Dark). `/pocket` redirects before rendering a picker. VSCode has no picker, so it
opens the debugger through the `dormouse.debugTheme` command and the
`dormouse:openThemeDebugger` extension-to-webview message.
