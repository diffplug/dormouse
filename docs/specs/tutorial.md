# Playground Tutorial

> See `docs/specs/glossary.md` for Session / Pane vocabulary. This spec uses it for the playground's pane layout and detection wiring.

The website playground has canonical device-specific routes (`website/src/routes.ts`):

- `/playground` is a client-side dispatcher. It picks Pocket for coarse-pointer devices or narrow viewports and Desktop otherwise, then replaces the history entry (preserving search + hash) with `/playground/desktop` or `/playground/pocket`. The exact media query lives in `website/src/lib/playground-routing.ts`.
- `/playground/desktop` hosts the desktop tiling tutorial. When the dispatcher would have picked Pocket it shows a "screen too small" message linking to `/playground/pocket` instead of mounting `Wall`.
- `/playground/pocket` hosts the mobile Pocket playground. On desktop it shows the temporary Pocket marketing/share page (phone preview + notify signup form).
- `/pocket` temporarily redirects to `/playground/pocket`. The future real tethering surface should stay separate from the playground URL when it exists.

## Profiles

The `tut` TUI has two device profiles, defined in `website/src/lib/tut-items.ts` (`DESKTOP_TUTORIAL_PROFILE`, `POCKET_TUTORIAL_PROFILE`):

- **Desktop** starts directly inside Make it yours (`initialSectionId`); sections: Make it yours, Keyboard navigation, Alerts and attention, Copy paste. Make it yours is one item — change the theme — and is deliberately first *and* auto-opened, so the tutorial's opening ask is a mouse action taken before any keyboard vocabulary has been introduced. The alert section covers all three of the tracks in `docs/specs/alert.md` — the command-keyed WATCHING rule and how it spreads across panes, program-sent terminal reports, and a command exiting while the user was away.
- **Pocket** starts directly inside Gesture navigation (`initialSectionId`); sections: Gesture navigation, Copy paste (the desktop Copy paste section minus `cp-override`).

All section/item titles, hints, and prose live in `tut-items.ts`; the menu, Flappy Term, and star copy live in `tut-runner.ts`. Item ids are stable — they are the localStorage payload entries.

Each item starts pending; the first incomplete item in a section is marked active, and completed items become green checks when the detector observes the corresponding action.

## Architecture

Four browser-side pieces in `website/src/lib/`, mirroring `ascii-splash-runner.ts` (xterm alt-screen + `FakePtyAdapter` boundary, no Node `terminal-kit`):

- **`tut-runner.ts`** (`TutRunner`) — profile-aware alt-screen TUI. Subscribes to `TutorialState`, re-renders on progress changes, receives input from `TutorialShell`.
- **`tut-detector.ts`** (`TutDetector`) — wires app events to `TutorialState.markComplete(id)`, and **must never touch the tiling engine**. `start()` seeds its prev-state maps and subscribes to `subscribeToActivity` + `subscribeToWatchedCommands` (`dormouse-lib/lib/terminal-registry`), `subscribeToMouseSelection` (`dormouse-lib/lib/mouse-selection`), and `subscribeToActiveTheme` (`dormouse-lib/lib/themes`); everything else arrives on the `WallEvent` stream (`handleWallEvent`). Keyboard split completion is credited before the split's automatic passthrough transition (`addSplitPanel` fires the `split` event synchronously; `modeChange` only fires from a later effect), and the following kb-arrows hint directs the user to re-enter command mode. `kb-arrows` itself is credited from `selectionChange` (a pane selection change to a distinct pane while in command mode), so a bare arrow key *or* a click counts. The per-item detection contract — which transition credits which id, the Cmd/Ctrl+Arrow `move` consume-first guard, and the guards against falsely crediting restored/spawned state — lives in this file's code and comments.
- **`tutorial-state.ts`** (`TutorialState`) — in-memory progress store; see [Storage](#storage) for keys. Profile totals are computed from the section list handed to the constructor.
- **`tut-items.ts`** — section + item definitions and the two profiles, shared by runner and detector.

## Layout

- `SiteHeader` at top, `themeAware` so `--vscode-*` variables drive its chrome. It carries no controls: theme selection moved into the Wall's Settings dialog (`docs/specs/theme.md` → "Where the user picks a theme"), so the page restores its own theme with `useRestoredTheme(POCKET_THEME_ID)` (`lib/src/lib/themes/use-restored-theme.ts`) rather than relying on the picker mounting. That call is also what declares the host fallback the Settings picker re-resolves through. The `th-theme` item is what walks the user to that dialog; the Pocket surfaces, which have no baseboard, render the `compact` picker instead.
- `<main>` is a flex container so Wall's `flex-1 min-h-0` root gets a real height.
- `/playground/desktop` runs `Wall` (`FakePtyAdapter`, `initialMode="passthrough"`) in a deterministic three-pane L-shape passed as `restoredLathLayout` from `DESKTOP_PLAYGROUND_LAYOUT` in `website/src/lib/playground-desktop-layout.ts`: a 50/50 root row makes one vertical divider, and the right child is a 50/50 column making one horizontal divider. The explicit valid Lath seed avoids the generic synchronous `initialPaneIds` path, whose later leaves have no measured geometry yet and therefore cannot reliably choose alternating axes. Header titles are seeded as pending shell opts (`setPendingShellOpts(id, { title })`) before the Wall mounts; the lib applies each as a user-pin at first spawn, after the pane's state reset, which `deriveHeader` ranks above the engine fallback:
  - **`tut-main`** (left, ~50%) — auto-launches `TutRunner` (`mainShell.runCommand("tut")`), title "tutorial".
  - **`tut-boxed`** (right-top, ~25%, "changelog") — auto-launches `ChangelogRunner`. Doubles as the Copy Rewrapped target and the `cp-override` target; its wrapped detail lines exercise the rewrap path and its TUI captures the mouse.
  - **`tut-splash`** (right-bottom, ~25%, "ascii-splash") — auto-launches `AsciiSplashRunner`.

Every visible pane gets a `TutorialShell` input handler via `PlaygroundShellRegistry`. `ensureShell` **must stay idempotent** — it runs from two directions: the `paneAdded` `WallEvent` covers every pane that becomes visible (the three seed ids included, plus splits and restores), and `FakePtyAdapter.onPtySpawn` covers the seed panes again, which is the hook that auto-launches each seed's command exactly once. The shell dispatches by command name to a page-provided `startProgram` factory (`tut` → `TutRunner`, `ascii-splash`/`splash` → `AsciiSplashRunner`, `changelog` → `ChangelogRunner`). Spawned terminals use `SCENARIO_SHELL_PROMPT` by default; the seed panes get an empty scenario so no delayed `user@dormouse:~$` write lands inside a runner's alt-screen.

`/playground/pocket` runs `MobileWall` with two sessions: **`pocket-tut`** ("tutorial", active, `TutRunner` with `POCKET_TUTORIAL_PROFILE`) and **`pocket-changelog`** ("changelog", `ChangelogRunner` for wrapped text + a mouse-capturing target). It starts a `TutDetector` (`start()`) over the same shared stores. Pocket-specific Gesture detections are wired in `PocketTerminalExperience`: `gn-touch-mode` needs a Select → Gestures round trip (not any mode change), and `MobileTerminalUi.onGestureInput` completes `gn-arrows`/`gn-enter`/`gn-esc` only for radial-menu-generated inputs.

## Menu and navigation behavior

Both runners open inside their profile's `initialSectionId` and Esc returns to the menu. Selecting a section drills into its item list, showing `[N/M complete]` per section. Inside a section, items render `✓` (green, complete), `●` (yellow active marker), or `·` (dim, later). Esc / `q` pop back one screen (section → menu → exit); Ctrl+C exits the runner immediately from any screen; re-running `tut` re-enters. `Reset progress` opens a confirm screen that requires typing `reset`, then clears all three storage keys and returns to the profile's initial screen.

Below the sections the menu lists `Starred on GitHub` (persisted separately, calls `onOpenGithub`), `🐭 FlappyTerm 🐭`, and `Reset progress`. Flappy is `[LOCKED N/M]` until all section checklist items are complete (the star, Flappy, and reset rows don't count toward `N/M`), then shows `[High score: N]` and unlocks a runner-local mini-game. The game-over screen cross-links the other surface: desktop `p` → `onOpenPocket`, Pocket `n` → `onNotifyPocket`. The page wires these callbacks (and their URLs) in `PocketTerminalExperience.tsx` and the desktop playground page.

### Runner-local intercepts

Four keys are intercepted by `TutRunner` while a specific section is open — they are **not** real Dormouse shortcuts. The three alert demos all report their fake commands through `OSC 633 ; E / C / D` written with `FakePtyAdapter.sendOutput`, which the fake adapter runs through the real `TerminalProtocolParser`; the OSCs are stripped from visible output, so a demo never disturbs the TUI its pane is drawing. Each demo's visible run (`BUSY_DEMO_DURATION_MS`) must outlast `cfg.alert.userAttention` so the bell actually rings rather than being suppressed as "user is looking"; see the comments in `tut-runner.ts`.

- **`s`** (Alerts section) — reports a fake `longtask` on *both* alert demo panes (`tut-boxed`, `tut-splash`), overriding the command their shell is really running, and drives `FakePtyAdapter.pumpActivity` on `tut-boxed` while the runner draws an in-place countdown. Two panes running one command is what makes `al-spreads` observable: WATCHING is keyed on the command name, so a single bell click lights both (`docs/specs/alert.md`). The pump always targets `tut-boxed` because it is the quiet pane — `tut-splash` animates forever, so it stays `BUSY` and can never reach `ALERT_RINGING`. The fake exit is reported `WATCH_DEMO_COMMAND_MS` later — the busy duration *plus* the monitor's full silence chain — not when the burst ends: WATCHING rings on *silence from a still-running command*, and reporting the exit early would dispose the monitor before it could ring. Re-pressing `s` after the countdown finishes cancels the prior delayed exit first, so an old completion cannot terminate the new fake command; presses during the countdown are ignored so pumps can't stack. Afterwards each pane's real command line is put back via `TutorialShell.reportRunningCommand()`, so a pane whose TUI is still drawing never looks idle.
- **`n`** (Alerts section) — writes a raw `OSC 777` notification to `tut-boxed`, exercising the terminal-report track, which needs no WATCHING rule.
- **`x`** (Alerts section) — starts a fake `slowbuild` on `tut-splash` and reports its exit `BUSY_DEMO_DURATION_MS` later. Deliberately an *unwatched* command name, so the command-exit track (rather than WATCHING) owns the bell; the user has to attend the pane and leave it for the ring to arm.
- **`p`** (Copy paste section) — toggles the **Place To Paste** scratch modal (`website/src/components/PlaceToPaste.tsx`) via `onTogglePlaceToPaste`. Only wired on desktop; Pocket omits the callback, and the runner hides the prompt line when it is absent.

### Pocket Copy paste specifics

Pocket reuses `cp-select`/`cp-raw`/`cp-rewrap` but drops `cp-override`: in Select mode it auto-overrides mouse capture for every Pocket session whose TUI is capturing the mouse (`docs/specs/mobile-terminal-ui.md` → Touch mode selector owns that recomputation rule), so it never asks the user to click the cursor icon. Pocket also renders a non-counted live prompt above the checklist that reflects the current touch mode (yellow while Select is inactive, green once active); it is not stored or checkmarked.

## Fake shell behavior

The `TutorialShell` every pane gets (see Layout) is all the fake shell the playground needs.

* Typed characters echo into a command-line buffer; Enter submits, Backspace edits.
* Shell integration **must** be reported for every command it runs — `OSC 633 ; A/B` around the prompt, `633 ; E` + `633 ; C` on launch, `633 ; D` on exit (`127` for an unknown command). WATCHING is keyed on the running command's name (`docs/specs/alert.md`), so without it no playground pane could be alerted on at all — every bell would report "nothing is running", including the pane hosting the tutorial itself. It also makes playground panes OSC-driven, so the keystroke fallback in `docs/specs/terminal-state.md` never engages there.
* Up/Down arrows recall command history at the shell prompt; Escape, Tab, and Left/Right are no-ops at the base prompt (full-screen runners like `ascii-splash` give them behavior).
* While a program is running, every input byte goes to it — including `\x03`, which the runners treat as quit. When the program exits, the terminal returns to the fake shell prompt instead of restarting it. Bytes left in a chunk after an Enter that launched a program are forwarded to that program rather than parsed as shell input.
* New panes created from the wall get the same fake shell behavior and prompt as the seed panes.

The only commands are the ones the page's `startProgram` factory knows — `tut`, `ascii-splash` / `splash`, and `changelog`. Anything else prints an "Unknown command" line and exits `127`.

## Storage

`TutorialState` persists to `localStorage`. Unknown ids in a stored payload are filtered on load, so renaming an id is a one-way reset for that item. Both profiles share the completion key; profile totals count only that profile's items, so an id completed under one profile is kept but not counted under the other.

- `dormouse-tut-v3` — JSON array of completed item ids.
- `dormouse-tut-star-v1` — `"true"` after `Starred on GitHub`.
- `dormouse-flappy-high-v1` — high score.

All three are removed on `TutorialState.reset()`. Legacy `dormouse-tutorial-step-N` / `dormouse-tut-v2-*` keys are not read.

## Lib hooks backing the tutorial

These exist in `dormouse-lib` (or `MobileTerminalUi`) so the browser-side tutorial can observe and drive real behavior:

- **`WallEvent.kill` / `WallEvent.move` / `WallEvent.paneAdded`** — discriminants on the `WallEvent` union (`lib/src/components/wall/wall-types.ts`). `kill` fires from `killPaneImmediately`, so every kill path (confirm dialog, tmux `x`, door kill, `dor kill`) credits `kb-kill`. `move` fires from the Cmd/Ctrl-Arrow swap in `handle-pane-shortcuts.ts` *and* from a center-drop swap in `Wall.onProposeMove`, deliberately mirrored so drag and keyboard behave identically for event consumers. `paneAdded` fires once per pane that becomes visible (seed ids, splits, dor surfaces, restores, auto-spawn) via the Lath store-subscription leaf-id diff, with seed ids announced explicitly so they are emitted too — so the page can create a fake shell for each pane without touching the tiling engine.
- **`FakePtyAdapter.pumpActivity(id, durationMs, intervalMs)`** — drives the alert manager for a fixed duration with no data output (used by the `s` busy demo). Returns a cancel handle and stops on its own if the pty dies mid-duration.
- **`FakePtyAdapter.sendOutput(id, data, { skipActivity })`** — pushes data through the real protocol parser as if the PTY produced it, driving `alertManager.onData()` for visible bytes and the notification/semantic-event paths for OSCs. This is what lets the alert demos fake shell integration and a program-sent notification without a real shell. Unlike `writePty`, it is not suppressed while a scenario is playing. `TutRunner` passes `skipActivity: true` for every frame it writes, so redrawing the TUI never tilts the bell on the pane hosting it.
- **`FakePtyAdapter.onPtySpawn`** — fires synchronously inside `spawnPty`, before the scenario plays, so the page can attach a shell and auto-launch without racing `TerminalPane`'s mount effect.
- **`subscribeToWatchedCommands` / `getWatchedCommands`** (`lib/src/lib/watched-commands.ts`, re-exported from `terminal-registry`) — the WATCHING rule set, which `TutDetector` watches to credit `al-watch-cmd`.
- **`MobileTerminalUi.onGestureInput(input, data)`** — optional callback fired only for radial-menu actions, so Pocket credits gesture items without mistaking native keyboard input for gestures.
- **`subscribeToActiveTheme` / `getActiveThemeId`** (`lib/src/lib/themes/`) — the active theme, which `TutDetector` watches to credit `th-theme`. It fires only on a change to a *different* theme, and the detector additionally seeds the id at `start()`, so a page's boot-time theme restore cannot grant the item. The picker has no keyboard shortcut, so any change here is a mouse interaction.

## Mouse and Clipboard Feature Coverage

The Playground is the primary dogfood surface for `docs/specs/mouse-and-clipboard.md`. The layout (`tut-main` runner, `tut-boxed` `changelog`, `tut-splash` `ascii-splash`) covers most of the spec. Legend: ✅ exercisable today, ⚠️ partial, ❌ not exercisable.

| Spec § | Feature | Status | Why |
|---|---|---|---|
| [§1](mouse-and-clipboard.md#1-the-mouse-icon-header-indicator) | Mouse icon visible when program requests reporting | ✅ | `ascii-splash` and `changelog` both emit `MOUSE_ENABLE` (`?1000h` / `?1002h` / `?1003h` / `?1006h`). |
| [§2](mouse-and-clipboard.md#2-override-state) | Temporary/permanent override, banner, Make sticky / Cancel | ✅ | The `cp-override` item walks the user through the `changelog` header's mouse icon. |
| [§3.1–§3.3](mouse-and-clipboard.md#31-initiating-a-selection) | Drag, Alt-block shape, the "Hold Opt/Alt for block selection" hint | ✅ | Works on any visible text. |
| [§3.3](mouse-and-clipboard.md#33-selection-hint-text) | "Press e to select the full URL/path" hint | ❌ | No qualifying tokens in the live scenarios. |
| [§3.4](mouse-and-clipboard.md#34-selection-follows-content) | Pure-scroll follows, cancel-on-change, cancel-on-resize | ⚠️ | `ascii-splash` makes cancel-on-change and resize observable; scenarios too short for pure-scroll. |
| [§3.5](mouse-and-clipboard.md#35-selection-in-the-live-region-vs-scrollback) | Scrollback-origin / cross-boundary drags | ⚠️ | Scrollback too short to exercise. |
| [§3.6](mouse-and-clipboard.md#36-during-a-drag) | Keyboard routing during drag | ✅ | With override active on a mouse-capturing runner, drag-time keyboard consumption is observable. |
| [§3.7](mouse-and-clipboard.md#37-ending-a-selection) | Popup on mouse-up, new-drag-replaces | ✅ | Any selection. |
| [§4.1.1](mouse-and-clipboard.md#411-copy-raw) | Copy Raw | ✅ | `cp-raw`. |
| [§4.1.2](mouse-and-clipboard.md#412-copy-rewrapped) | Copy Rewrapped (paragraph unwrap) | ✅ | `cp-rewrap`; `ChangelogRunner` renders wrapped detail lines that exercise the rewrap path. |
| [§4.2](mouse-and-clipboard.md#42-keyboard-shortcuts) | Cmd+C / Cmd+Shift+C | ✅ | Credits `cp-raw` / `cp-rewrap` the same way the popup buttons do. |
| [§4.3](mouse-and-clipboard.md#43-dismissing-the-popup) | Esc / click-outside dismiss | ✅ | Any selection popup. |
| [§5](mouse-and-clipboard.md#5-smart-extension-url--path-detection) | Smart-extension (URL / abs path / rel path / Windows path / error location) | ❌ | No matching tokens in the scenarios. |
| [§5.3](mouse-and-clipboard.md#53-extension-action) | Press `e` to extend | ❌ | Blocked on §5 coverage. |
| [§8.2](mouse-and-clipboard.md#82-paste-keybindings) | Cmd+V / Cmd+Shift+V / Ctrl+V / Ctrl+Shift+V paste | ⚠️ | Fires and writes to the fake PTY, but `TutorialShell.handleInput` echoes char-by-char and ignores bracketed-paste markers. |
| [§8.5](mouse-and-clipboard.md#85-bracketed-paste) | Bracketed paste wraps `\e[200~ … \e[201~` | ❌ | No scenario emits `\x1b[?2004h`, so `bracketedPaste` stays `false`. |

Auto-scroll during a drag and right-click paste are deferred in the implementation itself ([§9. Future](mouse-and-clipboard.md#9-future)) — not Playground gaps.

## Files

- Routes + pages — `website/src/routes.ts`, `website/src/pages/Playground.tsx`, `website/src/pages/PlaygroundDesktop.tsx`, `website/src/pages/PocketPlayground.tsx`, `website/src/pages/Pocket.tsx`
- Pocket composition + scratch modal — `website/src/components/PocketTerminalExperience.tsx`, `website/src/components/PlaceToPaste.tsx`
- Tutorial engine — `website/src/lib/tut-items.ts`, `website/src/lib/tut-runner.ts`, `website/src/lib/tut-detector.ts`, `website/src/lib/tutorial-state.ts`
- Playground plumbing — `website/src/lib/playground-routing.ts`, `website/src/lib/playground-desktop-layout.ts`, `website/src/lib/playground-shells.ts`, `website/src/lib/tutorial-shell.ts`
- Fake programs — `website/src/lib/ascii-splash-runner.ts`, `website/src/lib/changelog-runner.ts`
- Lib hooks this spec owns the contract for — the `WallEvent` union in `lib/src/components/wall/wall-types.ts`, and `sendOutput` / `pumpActivity` / `onPtySpawn` in `lib/src/lib/platform/fake-adapter.ts`

## Future

Two follow-up scenarios from the previous remediation plan remain useful and can be added without changing the three sections (expanding or replacing the `tut-boxed` neighbor):

1. **`SCENARIO_BRACKETED_PASTE_TUI`** — closes [§8.5](mouse-and-clipboard.md#85-bracketed-paste). Emits `\x1b[?2004h` and an idle ANSI-framed view.
2. **`SCENARIO_SMART_TOKENS`** — closes the [§3.3](mouse-and-clipboard.md#33-selection-hint-text) hint and [§5.1–§5.3](mouse-and-clipboard.md#51-detection). Prints one of each shape from `lib/src/lib/smart-token.ts`'s `PATTERNS`.
