# Theme — Rationale

> Informative companion to [theme.md](theme.md): the evidence and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Surface hierarchy

**Why the three pairs are the list colors.** The chrome anchors on VSCode's file-tree colors, authored to read clearly in the sidebar host area the chrome sits in. What the accent looks like is the theme's business: Kimbie Dark renders it caramel.

## Runtime model

**Why selection backgrounds are flattened.** VSCode renders the file-tree selection as an overlay on `sideBar.background`, so authors pick an alpha they never see as a fill. Selenized Dark's `list.activeSelectionBackground` is `#0096f588`: raw on the AppBar it lets whatever sits behind the surface bleed through, while compositing over `sideBar.background` reproduces what the author saw.

**Why the same-theme guard checks visibility rather than trusting its own bookkeeping.** On website routes React hydrates the whole React Router document, reconciling the server `<body>` and dropping the render-time `body.style` writes and the polarity class. A no-op keyed on "I already applied this theme" would return early against a body that no longer carries them, leaving xterm.js initialized against fallback colors while the picker claims the theme is active.

**Why every `var()`-valued token is declared twice.** CSS resolves a `var()` in a custom-property declaration at the declaring element, not where the property is read. A token declared only at document level therefore resolves to nothing wherever `applyTheme()` is the sole writer — standalone, website, and Pocket.

**Why `list.inactiveSelectionForeground` falls back to the normal foreground.** Matches VSCode list/tree behavior: an inactive selected row does not force the active-selection white text, which materializing from `list.activeSelectionForeground` would.

## First frame

**Why a boot tag.** A theme painted by the bundle lands after the browser can draw: Hosted's shell showed site.css's black canvas and the website's prerendered docs showed the site palette, then each switched to the reader's theme, a flash on every light theme. A blocking classic script first in `<body>` runs before the first paint, which no module script or effect can. Measured in Chrome, 2026-10: with the tag, the first painted frame on Hosted, a website docs page, and Standalone's frontend already carries the reader's theme, remembered or baked.

**Why remember the paint, not the theme id.** Resolving an id needs the bundled and installed theme tables and the resolver, which the tag would have to carry; the paint is one small object (the 44 resolved variables plus the docs tokens) the page already computed.

## Terminal color contract

**Why the color queries are answered rather than passed through.** A TUI that adapts to a light or dark background asks with `OSC 11 ; ?`; with no answer it assumes dark, and on a light theme its adaptive chrome — Codex's composer "pill", for one — renders unreadable. xterm.js does not answer the query itself, so the parse boundary is the only place holding the real theme.

## OSC color queries on Windows require the bundled ConPTY

**Two ConPTY backends, one of which eats the query.** Which backend node-pty spawns with decides whether a program's query reaches the consumer at all: under the in-box `CreatePseudoConsole` it never does, so nothing can answer and the light-theme failure under [Terminal color contract](#terminal-color-contract) is unavoidable on Windows. The bundled OpenConsole path is the same passthrough Windows Terminal itself relies on, which is what makes the extra prebuilds worth their packaging cost on both distributions.

## Theme data

**Why the active-theme subscription compares ids.** Changing the installed-theme JSON replaces cached objects even for unchanged entries, so object identity can report a theme change when the selected id stayed the same.

**Why not `onTerminalThemeChange()`.** It watches the resolved xterm palette JSON through a `MutationObserver` and fires on the first mutation after it starts, so a boot-time restore is indistinguishable from a user picking a theme.

## Where the user picks a theme

**Why VS Code gets no picker.** VS Code supplies `--vscode-*` from its own active theme, so its built-in theme UI is the only control that can change what Dormouse renders there.

**Why `/playground/pocket` keeps the `compact` picker.** Those two mounts render a mobile prototype: no baseboard, so no Settings dialog to put the picker in.

**Why the host fallback is module state.** Uninstalling the active theme is reachable from two depths — the picker row's `X` and the store dialog's `Remove` — and a prop-held fallback goes missing on one, dropping to the first bundled theme instead of the host's.

**Why the colour tokens are their own file.** The website compiles the library from source, so its Tailwind root has to scan `lib/src` or none of the library's utilities are emitted there — which is how the picker once lost its width, cap, and stacking on the docs pages, silently and with no build error. Scanning alone was not enough: the colour utilities resolve against an `@theme` the website did not declare, so the picker, the OpenVSX store, and the theme debugger each rendered with no surface, border, or text colour, and the picker carried a private inline stylesheet to compensate. Importing the whole of `theme.css` was not an option either — its `@theme` retunes `--text-xs`/`--text-sm` for a dense terminal UI, which would shrink type across the marketing site. Splitting the colour half out lets a host take the tokens without the app, and the inline stylesheet was deleted.

**Why the preview shares `applyTheme`'s `resolveThemeVars`.** A preview that resolved on its own could skip the selection flatten and show a candidate's translucent selection fills at an alpha the app never paints, and nothing would catch the divergence. The swatch remains circular while its enclosing entry takes the Settings controls' 4px corners: a 16px circle inset 8px from an entry edge shares no corner with it, so the concentric derivation has nothing to match, and the entry keeps the radius every other Settings control has.
