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

**Why the picker reconciles storage after hydration.** The server cannot read
installed themes or the stored active id. Reading them during the first client
render made its label and swatch differ from the prerendered markup; React
reported the mismatch and kept the stale server attributes even while the body
showed the stored theme.

**Why the host fallback is module state.** Uninstalling the active theme is reachable from two depths — the picker row's `X` and the store dialog's `Remove` — and a prop-held fallback goes missing on one, dropping to the first bundled theme instead of the host's. `setDefaultThemeId()` is the same module-state shape as `lib/src/lib/shell-defaults.ts`.

**Why `useRestoredTheme()` latches the fallback ahead of any child render.** On the desktop Pocket page the header's picker mounts before the component that calls the hook, so a latch deferred to an effect would let the picker re-resolve against no fallback at all.

**Why `window.confirm` cannot gate the uninstall.** Uninstall was gated on `confirm`; on the desktop app the call returned without ever showing a dialog, so uninstalling silently did nothing.

**Why the picker row's `X` keeps a gap from the select target.** The two paths above do not recover symmetrically: `Remove` leaves the extension row on screen to re-install, while the `X` means re-finding the extension through an OpenVSX search. The gap prices in the harder undo.

**Why a story, not only a unit test, pins the short-viewport cap.** A unit test can stub the trigger and menu rectangles to pin side selection and resize recomputation, including a visual viewport shrinking while the layout viewport stays fixed, but it cannot prove that the real list yields height while the footer survives. `lib/src/components/design.test.ts` pins the viewport inset, `lib/src/components/use-anchored-menu.test.tsx` the geometry, and the Chromatic story the rendered result.

**Why the colour tokens are their own file.** The website compiles the library from source, so its Tailwind root has to scan `lib/src` or none of the library's utilities are emitted there — which is how the picker once lost its width, cap, and stacking on the docs pages, silently and with no build error. Scanning alone was not enough: the colour utilities resolve against an `@theme` the website did not declare, so the picker, the OpenVSX store, and the theme debugger each rendered with no surface, border, or text colour, and the picker carried a private inline stylesheet to compensate. Importing the whole of `theme.css` was not an option either — its `@theme` retunes `--text-xs`/`--text-sm` for a dense terminal UI, which would shrink type across the marketing site. Splitting the colour half out lets a host take the tokens without the app, and the inline stylesheet was deleted.

**Why `compact` anchors absolutely.** Chromium offsets a fixed descendant of the docs' sticky mobile bar by that containing block; the dialog variants need fixed positioning to escape the dialog's `overflow-y-auto` surface, which would clip an absolute menu, while the compact mounts sit in no such scroller. Anchoring absolutely also means nothing measures the menu, so the panel's ref is inert there.
