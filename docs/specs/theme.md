# Theme Spec

Dormouse's theme contract is intentionally small: render the terminal chrome
with VSCode-appropriate surfaces, and render terminal content with
theme-appropriate xterm.js colors.

VSCode extension mode gets `--vscode-*` variables from VSCode. Standalone and
website mode apply the same shape of variables to `document.body` with
`applyTheme()` from a bundled or installed Dormouse theme. Both paths run the
same consumed-token resolver from `lib/src/lib/themes/vscode-color-resolver.ts`
so omitted theme JSON keys behave like VSCode registry defaults before
Dormouse renders.

## Surface hierarchy

The chrome is anchored on VSCode's file-tree styling because those colors are
designed to read clearly inside the sidebar host area. Use bg-only chrome for
panes and doors; do not add borders to make the hierarchy work.

| Token | VSCode key | Where used |
| --- | --- | --- |
| `--color-terminal-bg` / `-fg` | `terminal.background` / `terminal.foreground` | terminal container and xterm defaults |
| `--color-app-bg` / `--color-app-fg` | `sideBar.background` / `sideBar.foreground` | baseboard, dockview gutters, gaps around panes |
| `--color-header-inactive-bg` / `-fg` | `list.inactiveSelectionBackground` / `list.inactiveSelectionForeground` | unfocused pane headers |
| `--color-header-active-bg` / `-fg` | `list.activeSelectionBackground` / `list.activeSelectionForeground` | focused pane header |
| `--color-door-bg` / `-fg` | runtime pick from inactive header vs terminal bg/fg | baseboard doors |
| `--color-focus-ring` | runtime pick from `focusBorder` and active header background | marching-ants ring and terminal text-selection border |

Door colors and the focus ring are chosen at runtime by
`computeDynamicPalette()` in `lib/src/lib/themes/dynamic-palette.ts`, using
OKLab distance/chroma helpers from `lib/src/lib/color-contrast.ts`.
`useDynamicPalette()` in `lib/src/lib/themes/use-dynamic-palette.ts` publishes
the chosen variables on `document.body`. Public theme helpers are exported
from `lib/src/lib/themes/index.ts`.

- Door bg/fg chooses whichever pair, inactive-header or terminal bg/fg, has
  stronger perceptual separation from
  `--color-app-bg`.
- Focus ring prefers a chromatic `focusBorder`, then a chromatic active-header
  background, then the highest contrast fallback.
- Header-internal text and buttons inherit the header foreground. Do not add
  `text-muted` inside headers; use `hover:bg-current/10` for neutral hover
  feedback. Semantic exceptions are `text-warning` for ringing alerts and
  error styling for destructive actions.

High-contrast VSCode themes may make bg-only chrome look flatter than normal.
That is accepted; terminal content still uses the theme's terminal palette.

## Runtime model

Dormouse has two theme layers:

1. `--vscode-*` variables hold imported or host-provided VSCode color data.
2. `--color-*` variables in `lib/src/theme.css` provide semantic Tailwind
   tokens such as `bg-app-bg`, `text-app-fg`, and `bg-header-active-bg`.

`applyTheme()` sets imported `--vscode-*` variables on `document.body`, fills
missing consumed variables through the VSCode resolver, and adds either
`vscode-light` or `vscode-dark` for consumers that need the theme type. In real
VSCode webviews, `installVscodeThemeVarResolver()` runs before React renders;
it reads host-provided variables, materializes only missing Dormouse-consumed
variables on `body.style`, and removes stale materialized variables when the
host starts providing a real value.

`theme.css` declares the theme-dependent `--color-*` tokens on `body` because
`--vscode-*` variables also live there. Keep the parallel `@theme`
declarations so Tailwind can generate utility classes, but treat the body-level
declarations as the runtime source of truth.

`theme.css` must not contain hardcoded color defaults or `var(..., fallback)`
chains. Runtime hosts plus the shared resolver are responsible for providing
the consumed `--vscode-*` variables before Dormouse renders.

VSCode color IDs with `null` registry defaults need component-equivalent
materialization because Dormouse consumes them through direct CSS variables.
Important cases:

- `list.inactiveSelectionForeground` resolves to normal foreground
  (`sideBar.foreground`, then base `foreground`), not
  `list.activeSelectionForeground`. This matches VSCode list/tree behavior
  where an inactive selected row does not force active-selection white text.
- Null foregrounds inherit the nearest normal foreground.
- Null backgrounds inherit the relevant surface.
- Null border colors materialize as `transparent` so Dormouse's existing
  border geometry does not accidentally draw in `currentColor`.

## Terminal color contract

Terminal content is orthogonal to the chrome. xterm.js reads terminal colors
directly from `--vscode-*` in `getTerminalTheme()`. The resolver materializes
the VSCode terminal defaults before those values are read:

- `terminal.background` inherits `editor.background` when the terminal color is
  unset.
- `terminal.foreground` uses VSCode's terminal foreground registry default when
  unset.
- `terminalCursor.foreground` inherits `terminal.foreground` when unset.
- `terminal.selectionBackground` inherits `editor.selectionBackground` when
  unset.
- The 16 ANSI colors from `terminal.ansiBlack` through
  `terminal.ansiBrightWhite`.

The `terminal-theme.ts` body/html `MutationObserver` re-reads these values
when the body class or style changes, so applying a theme updates existing
terminals. `terminal-registry.ts` remains the public facade for callers.

## Theme data

Bundled and installed themes are represented by `DormouseTheme` objects in
`lib/src/lib/themes/`. A theme's `vars` map contains only consumed
`--vscode-*` variables plus resolver dependencies. `convertVscodeThemeColors()`
filters imported VSCode theme JSON to `CONSUMED_VSCODE_KEYS`; themes used
outside VSCode can omit keys that VSCode itself would omit because
`completeThemeVars()` fills those from registry defaults and the component
inheritance rules above.

Theme discovery, OpenVSX download/extraction, picker UI, and localStorage
persistence are implementation details of `lib/src/lib/themes/` and
`ThemePicker.tsx`. They must preserve the rendering contract above but do not
need separate spec rules here.

Storybook simulates VSCode themes through `lib/.storybook/themes.ts`. It must
also run bundled theme vars through `completeThemeVars()` (with the same host
typography defaults as `applyTheme()`) before injecting them, so isolated
component stories see the same materialized `--vscode-*` token set as the app.
Storybook's default simulated host theme is `Light (Visual Studio)`, with a
first-bundled-theme fallback so a renamed or removed bundle cannot leave stories
without theme vars.
The Storybook preview decorator also computes and publishes the dynamic palette
vars (`--color-door-bg`, `--color-door-fg`, `--color-focus-ring`) through the
shared `computeDynamicPalette()` helper, matching the runtime
`useDynamicPalette()` hook for stories that render doors, baseboards, or focus
rings outside a full Wall instance.

## Theme debugger

Dormouse includes a diagnostic-only Theme Debugger shared by VSCode,
standalone, and the website playground. It never mutates theme storage or
terminal colors. It captures the current DOM-visible theme state and shows:

- active Dormouse theme metadata when `applyTheme()` is the source
  (standalone/playground); real VSCode webviews show only the inferred VSCode
  theme kind because VSCode exposes CSS variables, not raw built-in theme JSON.
- visible `--vscode-*` variables, marked as host/theme-provided or
  Dormouse-materialized.
- resolver traces for every resolvable consumed variable: provided value,
  registry default for the current kind, null-default fallback path, final
  resolved value, and origin.
- semantic `--color-*` mappings for app, terminal, header, status, input, door,
  and focus-ring tokens, including `--color-app-bg` and `--color-app-fg`.
- terminal palette variables read by xterm.js.
- dynamic door/focus-ring picks from the same `pickDoorPair()` and
  `pickFocusRing()` helpers used by Wall's `computeDynamicPalette()`.

Standalone, playground, `/pocket`, and the website `/playground/pocket`
prototype expose the debugger as `Debug current theme` in the `ThemePicker`
menu. `/playground/pocket` uses the same picker in the desktop share page header
and as a floating control above the mobile terminal prototype, both with the
Kimbie Dark default theme fallback. VSCode opens it through the
`dormouse.debugTheme` command and the
`dormouse:openThemeDebugger` extension-to-webview message. The debugger's
copied report is a shareable text dump of the same snapshot.

## Maintainer checklist

When changing theme behavior:

- Update `lib/src/theme.css` and `lib/src/components/design.tsx` together for
  any chrome token change.
- Update `CONSUMED_VSCODE_KEYS` and the matching list in
  `lib/scripts/bundle-themes.mjs` when adding or removing any `--vscode-*`
  dependency used by chrome, terminal rendering, selection UI, theme-picker
  inline styles, or resolver fallback paths.
- Keep xterm.js terminal colors sourced from `--vscode-terminal-*` variables,
  not from Dormouse chrome tokens.
- Keep debugger dynamic-pick reporting and runtime dynamic-palette picks sharing
  `pickDoorPair()` and `pickFocusRing()`; do not fork those rules in UI code.
- Do not add hardcoded color defaults or CSS variable fallback chains to
  `lib/src/theme.css`; fix the theme data or runtime host instead.
- Avoid reintroducing a pass-through `--mt-*` layer or one-off tokens for tabs,
  badges, accents, or button hovers unless there is a new rendered surface that
  cannot be expressed by the hierarchy above.
