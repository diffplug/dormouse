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

## Theme data

**Why the active-theme subscription compares ids.** Installed themes are re-parsed from storage on every read, so an identity comparison would report a change on every re-apply — including the hydration repeat and a boot-time restore.

**Why not `onTerminalThemeChange()`.** It watches the resolved xterm palette JSON through a `MutationObserver` and fires on the first mutation after it starts, so a boot-time restore is indistinguishable from a user picking a theme.

## Where the user picks a theme

**Why VS Code gets no picker.** VS Code supplies `--vscode-*` from its own active theme, so its built-in theme UI is the only control that can change what Dormouse renders there.

**Why `/playground/pocket` keeps the `compact` picker.** Those two mounts render a mobile prototype: no baseboard, so no Settings dialog to put the picker in. The dialog trigger keeps its label so it reads as the same control as the row it stands in for; `compact` stands alone and needs only the swatch.

**Why the host fallback is module state.** Uninstalling the active theme is reachable from two depths — the picker row's `X` and the store dialog's `Remove` — and a prop-held fallback goes missing on one, dropping to the first bundled theme instead of the host's. `setDefaultThemeId()` is the same module-state shape as `lib/src/lib/shell-defaults.ts`.

**Why `useRestoredTheme()` latches the fallback ahead of any child render.** On the desktop Pocket page the header's picker mounts before the component that calls the hook, so a latch deferred to an effect would let the picker re-resolve against no fallback at all.

**Why `window.confirm` cannot gate the uninstall.** Uninstall was gated on `confirm`; on the desktop app the call returned without ever showing a dialog, so uninstalling silently did nothing.

**Why the picker row's `X` keeps a gap from the select target.** The two paths above do not recover symmetrically: `Remove` leaves the extension row on screen to re-install, while the `X` means re-finding the extension through an OpenVSX search. The gap prices in the harder undo.

**Why a story, not a unit test, pins the short-viewport cap.** The cap is a computed height under real layout, invisible to jsdom; a unit test asserting the class list would fail on any equivalent restyle and pass on real breakage. `lib/src/components/design.test.ts` pins the cap to its constants, the Chromatic story the rendered result.
