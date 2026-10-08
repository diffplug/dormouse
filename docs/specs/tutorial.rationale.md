# Playground Tutorial — Rationale

> Informative companion to [tutorial.md](tutorial.md): the evidence behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Profiles

**Why Make it yours is both first and auto-opened.** One mouse action — change the theme — completable before any keyboard vocabulary has been introduced, so the opening ask needs no menu screen ahead of it.

## Architecture

**How the split credit beats the mode change.** `addSplitPanel` fires the `split` `WallEvent` synchronously, while the split's automatic passthrough transition emits `modeChange` from a later effect; the detector therefore sees the split before the transition that would disqualify it.

## Layout

**Why the page restores its own theme.** Theme selection moved out of `SiteHeader` into the Wall's Settings dialog, so nothing on the page guarantees a picker ever mounts. `useRestoredTheme(WEBSITE_DEFAULT_THEME_ID)` makes the restore unconditional, and declares the host fallback the Settings picker later re-resolves through.

**Why the desktop layout is an explicit Lath seed.** The synchronous `initialPaneIds` path creates its leaves before the later ones have measured geometry, so it cannot reliably choose alternating split axes — the L-shape comes out however the measurements land. A valid Lath snapshot fixes the shape, and with it the one vertical and one horizontal divider.

**Why `tut-boxed` is the copy target.** Its wrapped detail lines exercise the copy editor's Auto format, and its TUI captures the mouse, the state `cp-override` exists to demonstrate. Pocket's `pocket-changelog` session is there for the same two reasons.

**Why `ensureShell` runs from two directions.** `paneAdded` covers splits, restores, dor surfaces and the seed ids alike, but cannot auto-launch the seed commands: that has to happen at spawn, exactly once. `FakePtyAdapter.onPtySpawn` is the spawn-time hook that does, and it necessarily overlaps the seed ids `paneAdded` already announced — hence idempotence rather than a split of responsibilities.

**What supplies the mouse-capturing text.** Both neighbor panes, `ascii-splash` and `changelog`.

**Coverage audit, against `mouse-and-clipboard.md`'s section numbers as of 2026-09.** Exercisable: §§1–2 (mouse reporting + override), §§3.1–3.3 (drag, block shape, block hint), §§3.6–3.7 (drag keys + popup), §§4.1–4.3 (Raw / Rewrapped copy, shortcuts, dismissal; since replaced by the copy editor). Partial: §3.4 exposes change/resize cancellation but not pure scroll; §3.5 lacks enough scrollback; §8.2 writes paste chords to the fake PTY, whose shell ignores bracket markers. Missing: §§3.3 and 5 lack smart tokens and therefore `e` extension; §8.5 lacks a scenario that enables bracketed paste. Auto-scroll during a drag and right-click paste are deferred in the implementation ([§9. Future](mouse-and-clipboard.md#9-future)), not Playground gaps.

## Playground filesystem

**Why the registry prints the first prompt.** The desktop used to play `SCENARIO_SHELL_PROMPT` on every spawned terminal; it prints a prompt without `OSC 633 ; A/B`, so a split Tool (`requireIntegration`) never saw integration and closed after its wait. Adding the OSCs to the scenario does not help: `writePty` is dropped while a scenario's timers hold the id, and the integration poll can type the Tool's command into that window.

**Why `/bin/fake` is the default shell.** With no shell named, `shellCommandKind` reads a Windows platform string as `cmd`, which refuses every split Tool and quotes for `cmd` (measured 2026-10).

**Why a service worker.** A built-in viewer is a server its page reaches by relative `fetch`; a browser page has no loopback listener, and a `srcdoc` or `blob:` frame breaks the pages' relative URLs and the Monaco worker, which would mean patching the editors. Scoping a worker to `/playground-fs/` serves the unchanged pages at real http(s) URLs. It keeps no token map because an idle worker is stopped and restarted at will; asking the windows costs one `MessageChannel` round trip per request.

## Fake shell behavior

**Why the Alerts section runs real commands.** It used to teach tutorial-only keys: `s`, `n`, and `x` reported fake commands onto the changelog and `ascii-splash` panes. A `Build finished` notification rang the changelog viewer, the `longtask` reported on `ascii-splash` could never go quiet because that pane animates forever, and one ring ticked unrelated items (2026-10-08). Running `agent` and `build` in a pane the user split teaches the real habit — start work, look elsewhere, get summoned — and each ring has the cause its item names.

**Why `build` stays unwatched and `agent --quiet` leans on the default rule.** WATCHING and a command exit both raise the ring, so a watched `build` would blur which one rang. `agent` is a default rule (Cursor's CLI), so the quiet agent shows WATCHING with no setup, which is how a user first meets it.

**Why shell integration is mandatory rather than nice-to-have.** A playground pane emitting no `OSC 633` would report "No command running" for every alert — including the pane hosting the tutorial itself, leaving the alert section with nothing to demonstrate. Reporting them also makes every playground pane OSC-driven, which is what keeps `docs/specs/terminal-state.md`'s keystroke fallback from engaging there.

## Lib hooks backing the tutorial

**Why `move` is emitted from two call sites.** The Cmd/Ctrl-Arrow swap and the center-drop swap are separate code paths producing the same user-visible result; emitting from only one would make an event consumer — the tutorial detector first among them — credit the item for a keyboard swap but not a drag.

**What `sendOutput` is for.** It is the playground shells' output path: bytes go through the real parser, so the alert programs' `OSC 633` and `OSC 9` reach the Activity layer as a real PTY's would.

**Why the theme subscription backs the opening ask.** Picking a theme needs no command-mode vocabulary ([Profiles](#profiles)); the picker remains operable through ordinary keyboard focus. Comparing consecutive theme ids also keeps the achievement repeatable after progress is reset.
