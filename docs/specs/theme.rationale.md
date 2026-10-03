# Theme — Rationale

> Informative companion to [theme.md](theme.md): the evidence and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Surface hierarchy

**Why the three pairs are the list colors.** The chrome anchors on VSCode's file-tree colors, authored to read clearly in the sidebar host area the chrome sits in. What the accent looks like is the theme's business: Kimbie Dark renders it caramel.

## Dynamic picks

**Why the alarm tint is flat black or white.** Luminance contrast dominates visibility: a plain black/white pick against the surface beats rotating the theme's alarm hue, which can land arbitrarily close to the background it has to shout over.

## Runtime model

**Why selection backgrounds are flattened.** VSCode renders the file-tree selection as an overlay on `sideBar.background`, so authors pick an alpha they never see as a fill. Selenized Dark's `list.activeSelectionBackground` is `#0096f588`: raw on the AppBar it lets whatever sits behind the surface bleed through, while compositing over `sideBar.background` reproduces what the author saw.

**Why the same-theme guard checks visibility rather than trusting its own bookkeeping.** On website routes React hydrates the whole React Router document, reconciling the server `<body>` and dropping the render-time `body.style` writes and the polarity class. A no-op keyed on "I already applied this theme" would return early against a body that no longer carries them, leaving xterm.js initialized against fallback colors while the picker claims the theme is active.

**Why every `var()`-valued token is declared twice.** CSS resolves a `var()` in a custom-property declaration at the declaring element, not where the property is read. A token declared only at document level therefore resolves to nothing wherever `applyTheme()` is the sole writer — standalone, website, and Pocket.

**Why `list.inactiveSelectionForeground` falls back to the normal foreground.** Matches VSCode list/tree behavior: an inactive selected row does not force the active-selection white text, which materializing from `list.activeSelectionForeground` would.

## Terminal color contract

**Why the color queries are answered rather than passed through.** A TUI that adapts to a light or dark background asks with `OSC 11 ; ?`; with no answer it assumes dark, and on a light theme its adaptive chrome — Codex's composer "pill", for one — renders unreadable. xterm.js does not answer the query itself, so the parse boundary is the only place holding the real theme.

## OSC color queries on Windows require the bundled ConPTY

**Two ConPTY backends, one of which eats the query.** Which backend node-pty spawns with decides whether a program's query reaches the consumer at all: under the in-box `CreatePseudoConsole` it never does, so nothing can answer and the light-theme failure under [Terminal color contract](#terminal-color-contract) is unavoidable on Windows. The bundled OpenConsole path is the same passthrough Windows Terminal itself relies on, which is what makes the extra prebuilds worth their packaging cost on both distributions.

## Theme data

**Why the active-theme subscription compares ids.** Changing the installed-theme JSON replaces cached objects even for unchanged entries, so object identity can report a theme change when the selected id stayed the same.

**Why not `onTerminalThemeChange()`.** It watches the resolved xterm palette JSON through a `MutationObserver` and fires on the first mutation after it starts, so a boot-time restore is indistinguishable from a user picking a theme.

## Where the user picks a theme

**Why VS Code gets no picker.** VS Code supplies `--vscode-*` from its own active theme, so its built-in theme UI is the only control that can change what Dormouse renders there.

**Why `/playground/pocket` keeps the `compact` picker.** Those two mounts render a mobile prototype: no baseboard, so no Settings dialog to put the picker in. The dialog trigger keeps its label so it reads as the same control as the row it stands in for; `compact` stands alone and needs only the swatch.

**Why the picker reconciles storage after hydration.** The server cannot read
installed themes or the stored active id. Reading them during the first client
render made its label and swatch differ from the prerendered markup; React
reported the mismatch and kept the stale server attributes even while the body
showed the stored theme.

**Why the host fallback is module state.** Uninstalling the active theme is reachable from two depths — the picker row's `X` and the store dialog's `Remove` — and a prop-held fallback goes missing on one, dropping to the first bundled theme instead of the host's. `setDefaultThemeId()` is the same module-state shape as `lib/src/lib/shell-defaults.ts`.

**Why `useRestoredTheme()` latches the fallback ahead of any child render.** On the desktop Pocket page the header's picker mounts before the component that calls the hook, so a latch deferred to an effect would let the picker re-resolve against no fallback at all.

**Why the colour tokens are their own file.** The website compiles the library from source, so its Tailwind root has to scan `lib/src` or none of the library's utilities are emitted there — which is how the picker once lost its width, cap, and stacking on the docs pages, silently and with no build error. Scanning alone was not enough: the colour utilities resolve against an `@theme` the website did not declare, so the picker, the OpenVSX store, and the theme debugger each rendered with no surface, border, or text colour, and the picker carried a private inline stylesheet to compensate. Importing the whole of `theme.css` was not an option either — its `@theme` retunes `--text-xs`/`--text-sm` for a dense terminal UI, which would shrink type across the marketing site. Splitting the colour half out lets a host take the tokens without the app, and the inline stylesheet was deleted.

**Why `compact` anchors absolutely.** Chromium offsets a fixed descendant of the docs' sticky mobile bar by that containing block; the dialog variants need fixed positioning to escape the dialog's `overflow-y-auto` surface, which would clip an absolute menu, while the compact mounts sit in no such scroller. Anchoring absolutely leaves the menu unmeasured; the trigger is still measured for side selection and the height cap.

**Why the swatch previews chrome instead of repeating the terminal background.**
The row already supplies the terminal foreground/background. The active header
fill and runtime focus-ring pick show the chrome's two accent roles.
Quiet Light uses green header fills and a purple focus border, so
a background circle plus a focus dot hid the green. Resolving and flattening the
candidate first also avoids showing translucent selection fills at an opacity the
app never uses — which is also why the preview shares `applyTheme`'s
`resolveThemeVars` rather than resolving on its own: a preview that skipped the
selection flatten would show a candidate at an alpha the app never paints, and
nothing would catch the divergence. The swatch remains circular while its
enclosing entry takes the Settings controls' 4px corners: a 16px circle inset
8px from an entry edge shares no corner with it, so the concentric derivation
has nothing to match, and the entry keeps the radius every other Settings
control has.

## Storybook simulation

In Linux Chromium 153 (measured 2026-09), upgrading Vitest 4.1.11 to 5.0.2
changed the implicit fallback for `❯` from DejaVu Sans (10.90625px at 13px)
to DejaVu Sans Mono (7.828125px). The computed font stack was unchanged.
Storybook 11 with Vitest 4 retained the baseline glyph; Vitest 5 with the
same Vite version reproduced the change. Argos reported 25 Chromium changes
across terminal-context prompts and mobile gesture labels; WebKit stayed clean.
Naming the same fallback in both snapshot browsers restores all 295 Chromium
baseline images and intentionally changes 27 WebKit images. Sharing symbol
shapes and metrics across browsers is preferable to preserving different
implicit fallbacks. Application and interactive Storybook fonts remain native.
