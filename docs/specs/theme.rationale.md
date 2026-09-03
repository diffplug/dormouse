# Theme — Rationale

> Informative companion to [theme.md](theme.md): the evidence and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Surface hierarchy

**Why the three pairs are the list colors.** The chrome is anchored on VSCode's file-tree styling, whose colors are authored to read clearly inside the sidebar host area — the same area the chrome sits in. What the accent actually looks like is the theme's business: Kimbie Dark renders it caramel.

## Dynamic picks

**Why the alarm tint is flat black or white.** Luminance contrast dominates visibility, so a plain black/white pick against the surface beats rotating the theme's alarm hue — which can land arbitrarily close to the background it has to shout over.

## Runtime model

**Why selection backgrounds are flattened.** VSCode renders the file-tree selection as an overlay on `sideBar.background`, so theme authors write the token with alpha and never see it as a fill. Dormouse uses it as one: Selenized Dark's `list.activeSelectionBackground` is `#0096f588`, and applied raw to the AppBar it lets whatever sits behind the surface bleed through. Compositing over `sideBar.background` reproduces what the author saw.

**Why the same-theme guard checks visibility rather than trusting its own bookkeeping.** Website routes hydrate as a full React Router document; React reconciles the server `<body>` and can drop the render-time `body.style` writes and the polarity class. A no-op keyed on "I already applied this theme" would then return early against a body that no longer carries the variables, leaving xterm.js initialized against fallback colors while the picker claims the theme is active.

**Why every `var()`-valued token is declared twice.** CSS resolves a `var()` inside a custom-property declaration at the element where the property is declared, not where it is read. Only the `body` copy therefore sees the `--vscode-*` variables `applyTheme()` writes to `body.style`, so a token declared only at document level resolves to nothing wherever `applyTheme()` is the sole writer — standalone, website, and Pocket.

**Why `list.inactiveSelectionForeground` falls back to the normal foreground.** It matches VSCode list/tree behavior, where an inactive selected row does not force the active-selection white text. Materializing it from `list.activeSelectionForeground` instead would.

## Theme data

**Why the active-theme subscription compares ids.** Installed themes are re-parsed from storage on every read, so the same theme is a fresh object each time; an identity comparison would report a change on every re-apply — including the hydration repeat and a boot-time restore.

**Why not `onTerminalThemeChange()`.** It watches the resolved xterm palette JSON through a `MutationObserver` and fires on the first mutation after it starts, so a boot-time restore is indistinguishable from a user picking a theme — exactly the distinction the tutorial's theme step needs.

## Where the user picks a theme

**Why VS Code gets no picker.** VS Code supplies `--vscode-*` from its own active theme, so its built-in theme UI is the only control that can change what Dormouse renders there.

**Why `/playground/pocket` keeps the `compact` picker.** Those two mounts render a mobile prototype, which has no baseboard, so there is no Settings dialog to put the picker in. The dialog variant's collapsed trigger carries the swatch *and* the label so it reads as the same control as the row it stands in for; `compact`, standing alone, needs only the swatch and the word "Theme".

**Why the host fallback is module state.** Uninstalling the active theme is reachable from two depths — the picker row's `X` and the store dialog's `Remove` — and a prop-held fallback is missing on one of them, which drops to the first bundled theme instead of the host's. `setDefaultThemeId()` is the same module-state shape as `lib/src/lib/shell-defaults.ts`.

**Why `useRestoredTheme()` latches the fallback ahead of any child render.** On the desktop Pocket page the header's picker mounts before the component that calls the hook, so a latch deferred to an effect would let the picker re-resolve against no fallback at all.

**Why `window.confirm` cannot gate the uninstall.** It was gated on `confirm`, and on the desktop app the call returned without ever showing a dialog, so uninstalling silently did nothing.

**Why the picker row's `X` keeps a gap from the select target.** Recovery from the two uninstall paths is not symmetric: the store dialog's `Remove` leaves the extension row on screen to re-install, while the picker row's `X` means re-finding the extension through an OpenVSX search. The gap prices in the harder undo.

**Why a story, not a unit test, pins the short-viewport cap.** The behavior is a computed height under real layout, which jsdom cannot see; a unit test asserting the class list would fail on any equivalent restyle and pass on real breakage. `lib/src/components/design.test.ts` pins the cap to its constants, and the Chromatic story covers the rendered result.
