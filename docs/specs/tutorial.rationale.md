# Playground Tutorial — Rationale

> Informative companion to [tutorial.md](tutorial.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Profiles

**Why Make it yours is both first and auto-opened.** One mouse action — change the theme — completable before any keyboard vocabulary has been introduced, so the opening ask needs no menu screen ahead of it.

## Architecture

**How the split credit beats the mode change.** `addSplitPanel` fires the `split` `WallEvent` synchronously, while the split's automatic passthrough transition emits `modeChange` from a later effect; the detector therefore sees the split before the transition that would disqualify it.

## Layout

**Why the page restores its own theme.** Theme selection moved out of `SiteHeader` into the Wall's Settings dialog, so nothing on the page guarantees a picker ever mounts. `useRestoredTheme(WEBSITE_DEFAULT_THEME_ID)` makes the restore unconditional, and declares the host fallback the Settings picker later re-resolves through.

**Why the desktop layout is an explicit Lath seed.** The synchronous `initialPaneIds` path creates its leaves before the later ones have measured geometry, so it cannot reliably choose alternating split axes — the L-shape comes out however the measurements land. A valid Lath snapshot fixes the shape, and with it the one vertical and one horizontal divider.

**Why `tut-boxed` is the copy target.** Its wrapped detail lines exercise the Copy Rewrapped path, and its TUI captures the mouse, the state `cp-override` exists to demonstrate. Pocket's `pocket-changelog` session is there for the same two reasons.

**Why `ensureShell` runs from two directions.** `paneAdded` covers splits, restores, dor surfaces and the seed ids alike, but cannot auto-launch the seed commands: that has to happen at spawn, exactly once. `FakePtyAdapter.onPtySpawn` is the spawn-time hook that does, and it necessarily overlaps the seed ids `paneAdded` already announced — hence idempotence rather than a split of responsibilities.

## Runner-local intercepts

**Why the demos' OSCs are invisible.** `FakePtyAdapter.sendOutput` runs its bytes through the real `TerminalProtocolParser`, which consumes the `OSC 633` sequences instead of printing them, so a demo can report shell integration into a pane whose alt-screen TUI is mid-draw without corrupting the frame.

**Why `s` pumps only `tut-boxed`.** `tut-splash` animates continuously and so is never silent; only the quiet pane needs pumping for WATCHING's silence chain to be worth watching.

**Why the `x` demo uses an unwatched command name.** WATCHING and a command exit both raise the ring, so a watched name would leave the user unable to tell which fired. `slowbuild` sits outside the WATCHING rule set, leaving the command exit as the only source — and command-exit alerting arms only once the user has clicked into the pane and left it, which is what the demo asks for.

## Fake shell behavior

**Why shell integration is mandatory rather than nice-to-have.** A playground pane emitting no `OSC 633` would report "No command running" for every alert — including the pane hosting the tutorial itself, leaving the alert section with nothing to demonstrate. Reporting them also makes every playground pane OSC-driven, which is what keeps `docs/specs/terminal-state.md`'s keystroke fallback from engaging there.

## Lib hooks backing the tutorial

**Why `move` is emitted from two call sites.** The Cmd/Ctrl-Arrow swap and the center-drop swap are separate code paths producing the same user-visible result; emitting from only one would make an event consumer — the tutorial detector first among them — credit the item for a keyboard swap but not a drag.

**What `sendOutput` is for.** The only way the alert demos can fake shell integration and a program-sent notification with no real shell behind the pane.

**Why the theme subscription backs the opening ask.** Picking a theme needs no command-mode vocabulary ([Profiles](#profiles)); the picker remains operable through ordinary keyboard focus. Comparing consecutive theme ids also keeps the achievement repeatable after progress is reset.

## Mouse and Clipboard Feature Coverage

**What supplies the mouse-capturing text.** Both neighbor panes, `ascii-splash` and `changelog`; why `changelog` is also the copy target: [Layout](#layout).

**Coverage audit, against `mouse-and-clipboard.md`'s section numbers as of 2026-09.** Exercisable: §§1–2 (mouse reporting + override), §§3.1–3.3 (drag, block shape, block hint), §§3.6–3.7 (drag keys + popup), §§4.1–4.3 (raw/rewrapped copy, shortcuts, dismissal). Partial: §3.4 exposes change/resize cancellation but not pure scroll; §3.5 lacks enough scrollback; §8.2 writes paste chords to the fake PTY, whose shell ignores bracket markers. Missing: §§3.3 and 5 lack smart tokens and therefore `e` extension; §8.5 lacks a scenario that enables bracketed paste. Auto-scroll during a drag and right-click paste are deferred in the implementation ([§9. Future](mouse-and-clipboard.md#9-future)), not Playground gaps.
