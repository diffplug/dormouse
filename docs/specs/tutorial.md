# Playground Tutorial

> See `docs/specs/glossary.md` for Session / Pane vocabulary, used here for the playground's pane layout and detection wiring.

Device routes (`website/src/routes.ts`):

- **`/playground`** — dispatcher: Pocket for coarse pointers or narrow viewports, Desktop otherwise, then **replaces** the history entry, preserving search + hash (query in `website/src/lib/playground-routing.ts`).
- **`/playground/desktop`** — desktop tiling tutorial; where the dispatcher would pick Pocket, a "screen too small" link to `/playground/pocket` instead of `Wall`.
- **`/playground/pocket`** — mobile Pocket playground; on desktop, the temporary Pocket marketing/share page (phone preview + notify form).
- **`/pocket`** — temporary redirect to `/playground/pocket`. **Keep the real tethering surface off the playground URL.**

**Must hydrate the desktop prerender, then reconcile browser media.** **Must dispatch using browser media, never the hydration fallback.** **Must skip desktop runtime loading when browser media selects Pocket.** Pinned by `website/src/pages/Playground.test.tsx`.

## Profiles

Both `tut` profiles open inside their `initialSectionId`:

- **`DESKTOP_TUTORIAL_PROFILE`** — Make it yours, Keyboard navigation, Alerts and attention, Copy paste; the first is one item, change the theme, and is auto-opened (rationale). Its alert section covers all three `docs/specs/alert.md` tracks: command-keyed WATCHING and its spread across panes, program-sent reports, and a command exiting while the user was away.
- **`POCKET_TUTORIAL_PROFILE`** — Gesture navigation, Copy paste (desktop's minus `cp-override`).

**Item ids are stable** — they are the localStorage payload entries ([Storage](#storage)). Items start pending; the first incomplete in each section is active, turning green-check when detected.

## Architecture

Browser-side xterm alt-screen behind `FakePtyAdapter`, **never Node `terminal-kit`**:

- **`tut-runner.ts`** (`TutRunner`) — profile-aware alt-screen TUI; subscribes to `TutorialState`, re-renders on progress, takes input from `TutorialShell`.
- **`tut-detector.ts`** (`TutDetector`) — wires app events to `TutorialState.markComplete(id)` and **must never touch the tiling engine**. `start()` seeds its prev-state maps and subscribes to `subscribeToActivity` + `subscribeToWatchedCommands` (`dormouse-lib/lib/terminal-registry`), `subscribeToMouseSelection` (`dormouse-lib/lib/mouse-selection`), `subscribeToActiveTheme` (`dormouse-lib/lib/themes`); everything else arrives on the `WallEvent` stream (`handleWallEvent`). **A keyboard split is credited before the split's automatic passthrough transition** (rationale), and **the `kb-arrows` hint that follows must tell the user to re-enter command mode** — the split left them in passthrough. **`kb-arrows` is credited from `selectionChange`** — to a distinct pane, in command mode — so an arrow key *or* a click counts. **Must credit `al-spreads` only when newly enabled WATCHING shares a command key with another live pane.** Each transition guard is commented where it lives, pinned by `website/src/lib/tut-detector.test.ts`.
- **`tutorial-state.ts`** (`TutorialState`) — in-memory progress store ([Storage](#storage)); profile totals come from the section list handed to the constructor.
- **`tut-items.ts`** — sections, items, and both profiles; read by the runner and by `TutorialState` (the detector reaches ids only through `ItemId`).

## Layout

- Desktop `SiteHeader` at top, `themeAware` so `--vscode-*` variables drive its chrome, **carrying no controls**: **the page must restore its own theme** with `useRestoredTheme(WEBSITE_DEFAULT_THEME_ID)` (`website/src/lib/website-theme.ts`), which also declares the host fallback the Settings picker re-resolves through (rationale). `th-theme` walks the user to the Wall's Settings dialog (`docs/specs/theme.md` → "Where the user picks a theme"); Pocket renders the `compact` picker over the mobile terminal or in the desktop marketing header.
- `<main>` is a flex container so Wall's `flex-1 min-h-0` root gets a real height.
- `/playground/desktop` runs `Wall` (`FakePtyAdapter`, `initialMode="passthrough"`). **Must seed its three-pane L-shape as an explicit Lath snapshot** — `restoredLathLayout` from `DESKTOP_PLAYGROUND_LAYOUT` — never the synchronous `initialPaneIds` path (rationale); `website/src/lib/playground-desktop-layout.test.ts` pins it. `DESKTOP_PANES` in the same file owns each seed's id, command, and title; **`tut-boxed` is the Copy Rewrapped + `cp-override` target** (rationale). **Titles are seeded as pending shell opts** (`setPendingShellOpts(id, { title })`) before the Wall mounts; the lib pins each at first spawn, after the pane's state reset, and a user-pin outranks the engine fallback (`docs/specs/terminal-state.md` → "Header Derivation").

Every visible pane gets a `TutorialShell` via `PlaygroundShellRegistry`. **`ensureShell` must stay idempotent** — `paneAdded` covers every pane that becomes visible, and `FakePtyAdapter.onPtySpawn` covers the seed panes again, auto-launching each seed's command exactly once (rationale). The page’s `startProgram` factory dispatches: `tut` → `TutRunner`, `ascii-splash`/`splash` → `AsciiSplashRunner`, `changelog` → `ChangelogRunner`. **Spawned terminals use `SCENARIO_SHELL_PROMPT`; seed panes get an empty scenario**, so no delayed `user@dormouse:~$` write lands inside a runner's alt-screen.

`/playground/pocket` runs `MobileWall` with **`pocket-tut`** ("tutorial", active, `TutRunner` on `POCKET_TUTORIAL_PROFILE`) and **`pocket-changelog`** ("changelog", `ChangelogRunner`), and starts a `TutDetector` over the same shared stores. Pocket gesture detections are wired in `website/src/components/PocketTerminalExperience.tsx`: `gn-touch-mode` needs a Select → Gestures round trip (not any mode change), and `MobileTerminalUi.onGestureInput` completes `gn-arrows`/`gn-enter`/`gn-esc` only for radial-menu-generated inputs.

## Menu and navigation behavior

Esc pops back one screen (section → menu → exit), and so does `q` everywhere the screen is not consuming typed characters — on the reset screen `q` is confirm-buffer input. Ctrl+C exits the runner from any screen; re-running `tut` re-enters. **Must consume unsupported CSI/SS3 key sequences without treating their prefix as Esc**; arrows accept CSI and application-mode SS3. Pinned by `website/src/lib/tut-runner.test.ts`. The menu shows `[N/M complete]` per section; drilling in lists that section's items, each `✓` complete, `●` active, or `·` later. **`Reset progress` requires the user type `reset`**, then clears all three storage keys and returns to the profile's initial screen.

Extras: `Starred on GitHub` (persisted separately, `onOpenGithub`), `🐭 FlappyTerm 🐭`, `Reset progress` — **none of the three ever counts toward `N/M`**. Flappy stays `[LOCKED N/M]` until every section checklist item is complete, then shows `[High score: N]` and unlocks a runner-local mini-game whose game-over screen cross-links the other surface (desktop `p` → `onOpenPocket`; Pocket `n` → `onNotifyPocket` → `/hosted/#remote-control`, wired by the pages).

### Runner-local intercepts

**`TutRunner` intercepts four keys while a specific section is open; they are not real Dormouse shortcuts.** The three alert demos report fake commands as `OSC 633 ; E / C / D` through `FakePtyAdapter.sendOutput`, which the real `TerminalProtocolParser` strips from visible output (rationale). **Must snapshot the live inactivity timeout at demo launch; the run outlasts it and the BUSY-confirm floor.** Each demo's countdown, page timer, and re-press guard run the same snapshotted duration — longer for `s`, whose fake command must outlive WATCHING's silence chain. Pinned by `website/src/lib/tut-runner.test.ts`.

- **`s`** (Alerts) — reports `longtask` on both alert panes so command-keyed WATCHING demonstrates `al-spreads`, pumping only the quiet `tut-boxed` (rationale), keeping the command alive through WATCHING’s silence chain. **A press while that command is still running is ignored**, so pumps cannot stack and the page needs no cancel of its own; on exit `TutorialShell.reportRunningCommand()` restores each pane's real command.
- **`n`** (Alerts) — writes a raw `OSC 777` notification to `tut-boxed`, exercising the terminal-report track, which needs no WATCHING rule.
- **`x`** (Alerts) — starts a fake `slowbuild` on `tut-splash` and reports its exit after the captured duration. **The command name must stay unwatched**, so the command-exit track rather than WATCHING owns the ring (rationale).
- **`p`** (Copy paste) — toggles the **Place To Paste** scratch modal (`website/src/components/PlaceToPaste.tsx`) via `onTogglePlaceToPaste`. Desktop only — Pocket omits the callback, and the runner hides the prompt line without it.

### Pocket Copy paste specifics

Pocket reuses `cp-select` / `cp-raw` / `cp-rewrap` but drops `cp-override`: Select mode auto-overrides mouse capture for every Pocket session whose TUI captures the mouse (`docs/specs/mobile-terminal-ui.md` → "Touch mode selector" owns that recomputation), so it never asks the user to click the cursor icon. A non-counted live prompt above the checklist reflects the touch mode — yellow while Select is inactive, green once active — neither stored nor checkmarked.

## Fake shell behavior

`TutorialShell` ([Layout](#layout)):

* Typed characters echo into a command-line buffer; Enter submits, Backspace edits.
* **Shell integration must be reported for every command it runs** — `OSC 633 ; A/B` around the prompt, `633 ; E` + `633 ; C` on launch, `633 ; D` on exit (`127` for an unknown command). WATCHING is keyed on the running command's name (`docs/specs/alert.md`), and the OSCs also keep `docs/specs/terminal-state.md`'s keystroke fallback from engaging here (rationale).
* Up/Down recall history at the prompt; Escape, Tab, and Left/Right are no-ops there (full-screen runners give them behavior).
* **While a program runs, every input byte goes to it** — `\x03` included, which the runners treat as quit — as do bytes left in the chunk after the Enter that launched it. On exit the terminal returns to the prompt instead of restarting the program.

**The only commands are the ones `startProgram` knows** ([Layout](#layout)); anything else prints an "Unknown command" line and exits `127`.

## Storage

`TutorialState` persists to `localStorage`. **Unknown ids in a stored payload are filtered on load**, so renaming an id is a one-way reset. **Both profiles share the completion key**, so **`markComplete` must reject an id outside the profile's own sections** — a Pocket detection that names a desktop-only item would otherwise arrive pre-checked. An id completed under one profile loads under the other, kept but uncounted.

**Must keep progress and reset working without storage**, pinned by `website/src/lib/tutorial-state.test.ts`.

- `dormouse-tut-v3` — JSON array of completed item ids.
- `dormouse-tut-star-v1` — `"true"` after `Starred on GitHub`.
- `dormouse-flappy-high-v1` — high score.

**Must remove all three on `TutorialState.reset()`, even when rejected stored values left progress empty.** Legacy `dormouse-tutorial-step-N` / `dormouse-tut-v2-*` keys are never read.

## Lib hooks backing the tutorial

Hooks in `dormouse-lib` / `MobileTerminalUi` that exist for tutorial observability:

- **`WallEvent.kill` / `move` / `paneAdded`** — discriminants on the `WallEvent` union. `kill` fires from `killPaneImmediately`, so every kill path (confirm dialog, tmux `x`, door kill, `dor kill`) credits `kb-kill`. **`move` must fire from both** the Cmd/Ctrl-Arrow swap in `lib/src/components/wall/keyboard/handle-pane-shortcuts.ts` **and** the center-drop swap in `Wall.onProposeMove` (rationale). **`paneAdded` fires once per pane that becomes visible** — seed ids, splits, dor surfaces, restores, auto-spawn — via Lath’s leaf-id diff, with seeds announced explicitly.
- **`FakePtyAdapter.pumpActivity(id, durationMs, intervalMs)`** — drives the alert manager for a fixed duration with no data output (the `s` demo). Returns a cancel handle; stops on its own if the pty dies mid-duration.
- **`FakePtyAdapter.sendOutput(id, data, { skipActivity })`** — pushes data through the real protocol parser as if the PTY produced it (rationale). **Unlike `writePty` it is not suppressed while a scenario is playing.** `TutRunner` passes `skipActivity: true` for every frame.
- **`FakePtyAdapter.onPtySpawn`** — fires synchronously inside `spawnPty`, before the scenario plays, so a page attaches a shell without racing `TerminalPane`'s mount.
- **`subscribeToWatchedCommands` / `getWatchedCommands`** (`lib/src/lib/watched-commands.ts`, re-exported from `terminal-registry`) — the WATCHING rule set, watched to credit `al-watch-cmd`.
- **`MobileTerminalUi.onGestureInput(input, data)`** — optional, fired only for radial-menu actions, so Pocket credits gesture items without mistaking native keyboard input for a gesture.
- **`subscribeToActiveTheme` / `getActiveThemeId`** (`lib/src/lib/themes/`) — the active theme, watched to credit `th-theme`. **Must seed the detector’s previous theme at `start()` and compare consecutive ids**, so boot-time restore cannot grant the item and choosing the startup theme after a reset still can. Pinned by `website/src/lib/tut-detector.test.ts` (rationale).

## Mouse and Clipboard Feature Coverage

Primary dogfood surface for `docs/specs/mouse-and-clipboard.md`. What the three-pane layout exercises, partly exercises, and cannot reach today is audited in the rationale; the two gaps worth closing are the `## Future` scenarios below.

## Files

- Routes + pages — `website/src/routes.ts`, `website/src/pages/Playground.tsx`, `website/src/pages/PlaygroundDesktop.tsx`, `website/src/pages/PocketPlayground.tsx`, `website/src/pages/Pocket.tsx`
- Playground plumbing — `website/src/lib/playground-routing.ts`, `website/src/lib/playground-desktop-layout.ts`, `website/src/lib/playground-shells.ts`, `website/src/lib/tutorial-shell.ts`
- Fake programs — `website/src/lib/ascii-splash-runner.ts`, `website/src/lib/changelog-runner.ts`
- Lib contracts this spec owns — `WallEvent` in `lib/src/components/wall/wall-types.ts`; `sendOutput` / `pumpActivity` / `onPtySpawn` in `lib/src/lib/platform/fake-adapter.ts`

## Future

Two scenarios for `tut-boxed`, needing no section change:

1. **`SCENARIO_BRACKETED_PASTE_TUI`** — closes [§8.5](mouse-and-clipboard.md#85-bracketed-paste). Emits `\x1b[?2004h` and an idle ANSI-framed view.
2. **`SCENARIO_SMART_TOKENS`** — closes the [§3.3](mouse-and-clipboard.md#33-selection-hint-text) hint and [§5.1–§5.3](mouse-and-clipboard.md#51-detection). Prints one of each shape from `lib/src/lib/smart-token.ts`'s `PATTERNS`.
