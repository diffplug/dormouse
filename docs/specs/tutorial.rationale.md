# Playground Tutorial — Rationale

> Informative companion to [tutorial.md](tutorial.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Profiles

**Why Make it yours is both first and auto-opened.** It is a single mouse action — change the theme — and jumping straight into it makes the tutorial's opening ask something the user can complete before any keyboard vocabulary has been introduced.

## Architecture

**How the split credit beats the mode change.** `addSplitPanel` fires the `split` `WallEvent` synchronously, while the split's automatic passthrough transition emits `modeChange` from a later effect. The detector therefore observes the split before the transition that would otherwise disqualify it, which is why the kb-arrows hint that follows has to tell the user to re-enter command mode.

## Layout

**Why the page restores its own theme.** Theme selection moved out of `SiteHeader` and into the Wall's Settings dialog, so nothing on the page guarantees that a picker ever mounts. `useRestoredTheme(POCKET_THEME_ID)` makes the restore unconditional, and it is also the call that declares the host fallback the Settings picker later re-resolves through.

**Why the desktop layout is an explicit Lath seed.** The generic synchronous `initialPaneIds` path creates its leaves before the later ones have any measured geometry, so it cannot reliably choose alternating split axes — the L-shape comes out however the measurements land. A valid Lath snapshot fixes the shape, and with it the one vertical and one horizontal divider the layout is supposed to present.

**Why `tut-boxed` is the copy target.** Its wrapped detail lines exercise the Copy Rewrapped path, and its TUI captures the mouse, which is the state `cp-override` exists to demonstrate. Pocket's `pocket-changelog` session is there for the same two reasons.

**Why `ensureShell` runs from two directions.** `paneAdded` is the general hook and covers splits, restores, dor surfaces and the seed ids alike, but it cannot auto-launch the seed commands: that has to happen at spawn, exactly once. `FakePtyAdapter.onPtySpawn` is the synchronous spawn-time hook that does it, and it necessarily overlaps the seed ids `paneAdded` has already announced — hence the idempotence requirement rather than a split of responsibilities.

## Runner-local intercepts

**Why the demos' OSCs are invisible.** `FakePtyAdapter.sendOutput` runs its bytes through the real `TerminalProtocolParser`, which consumes the `OSC 633` sequences instead of printing them. A demo can therefore report shell integration into a pane whose alt-screen TUI is mid-draw without corrupting the frame.

**Why `s` pumps only `tut-boxed`.** `tut-splash` animates continuously and so is never silent; only the quiet pane needs pumping for WATCHING's silence chain to be worth watching.

**Why the `x` demo uses an unwatched command name.** WATCHING and the command-exit track both end at a ring, so a demo on a watched name would leave the user unable to tell which track fired. `slowbuild` sits outside the WATCHING rule set, leaving the command-exit track as the only possible source — which is also why this demo needs the user to attend the pane and then leave it, the precondition that track arms on.

## Fake shell behavior

**Why shell integration is mandatory rather than nice-to-have.** WATCHING is keyed on the running command's name, so a playground pane emitting no `OSC 633` would report "nothing is running" for every bell — including the pane hosting the tutorial itself, which would leave the alert section with nothing to demonstrate. Reporting them also makes every playground pane OSC-driven, which is what keeps `docs/specs/terminal-state.md`'s keystroke fallback from engaging there.

## Lib hooks backing the tutorial

**Why `move` is emitted from two call sites.** The Cmd/Ctrl-Arrow swap and the center-drop swap are separate code paths producing the same user-visible result. Emitting from only one would make an event consumer — the tutorial detector first among them — treat drag and keyboard as different actions and credit the item for one but not the other.

**What `sendOutput` is for.** It is the only way the alert demos can fake shell integration and a program-sent notification with no real shell behind the pane.

**Why the theme subscription is the tutorial's mouse-only signal.** The theme picker has no keyboard shortcut, so a change observed through `subscribeToActiveTheme` is necessarily a mouse interaction — which is what makes `th-theme` usable as the opening ask, before any keyboard vocabulary exists.

## Mouse and Clipboard Feature Coverage

**What supplies the coverage.** `ascii-splash` and `changelog` are the panes that provide mouse-capturing text; the tutorial's own checklist items are what drive the user through the named copy and selection actions.
