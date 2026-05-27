# Playground Tutorial

The website playground has canonical device-specific routes:

- `/playground` is a client-side dispatcher. It picks Pocket for coarse-pointer devices or narrow viewports and Desktop otherwise, then replaces the history entry with `/playground/desktop` or `/playground/pocket`. The exact media query lives in `website/src/lib/playground-routing.ts`.
- `/playground/desktop` hosts the desktop tiling tutorial. When the dispatcher would have picked Pocket it shows a "screen too small" message linking to `/playground/pocket` instead of mounting `Wall`.
- `/playground/pocket` hosts the mobile Pocket playground. On desktop it shows the temporary Pocket marketing/share page (phone preview + notify signup form).
- `/pocket` temporarily redirects to `/playground/pocket`. The future real tethering surface should stay separate from the playground URL when it exists.

## Profiles

The `tut` TUI has two device profiles, defined in `website/src/lib/tut-items.ts` (`DESKTOP_TUTORIAL_PROFILE`, `POCKET_TUTORIAL_PROFILE`):

- **Desktop** starts at the top-level menu; sections: Keyboard navigation, Alert and TODO, Copy paste.
- **Pocket** starts directly inside Gesture navigation (`initialSectionId`); sections: Gesture navigation, Copy paste.

All section/item titles, hints, and prose live in `tut-items.ts`; the menu, Flappy Term, and star copy live in `tut-runner.ts`. This spec does not duplicate that text. Item ids are stable — they are the localStorage key suffixes.

Each item starts pending; the first incomplete item is marked active, and completed items become green checks when the detector observes the corresponding action.

## Architecture

Three browser-side pieces in `website/src/lib/`, mirroring `ascii-splash-runner.ts` (xterm alt-screen + `FakePtyAdapter` boundary, no Node `terminal-kit`):

- **`tut-runner.ts`** (`TutRunner`) — profile-aware alt-screen TUI. Subscribes to `TutorialState`, re-renders on progress changes, routes input via `FakePtyAdapter.writePty`.
- **`tut-detector.ts`** (`TutDetector`) — wires app events to `TutorialState.markComplete(id)`. Subscribes to `DockviewApi.onDidActivePanelChange`, the `WallEvent` stream, `subscribeToActivity` (`dormouse-lib/lib/terminal-registry`), and `subscribeToMouseSelection` (`dormouse-lib/lib/mouse-selection`). The per-item detection contract — which transition credits which id, and the guards against falsely crediting restored/spawned state — lives in this file's code and comments.
- **`tutorial-state.ts`** (`TutorialState`) — in-memory progress store; see [Storage](#storage) for keys. Profile totals are computed from the active profile's section list.
- **`tut-items.ts`** — section + item definitions and the two profiles, shared by runner and detector.

## Layout

- `SiteHeader` at top with the `Theme:` dropdown on `/playground/desktop`. Header is `themeAware` so `--vscode-*` variables drive its chrome.
- `<main>` is a flex container so Wall's `flex-1 min-h-0` root gets a real height.
- `/playground/desktop` runs `Wall` (`FakePtyAdapter`, `initialMode="passthrough"`) in a three-pane layout, panes added in `onApiReady` via `position: { referencePanel, direction }`:
  - **`tut-main`** (left, ~50%) — auto-launches `TutRunner` (`mainShell.runCommand("tut")`).
  - **`tut-boxed`** (right-top, ~25%, "changelog") — auto-launches `ChangelogRunner`. Doubles as the Copy Rewrapped target; its wrapped lines exercise the rewrap path.
  - **`tut-splash`** (right-bottom, ~25%, "ascii-splash") — auto-launches `AsciiSplashRunner`.

Every pane gets a `TutorialShell` input handler via `PlaygroundShellRegistry`; the shell dispatches by command name to a page-provided `startProgram` factory (`tut` → `TutRunner`, `ascii-splash`/`splash` → `AsciiSplashRunner`). Spawned terminals use `SCENARIO_SHELL_PROMPT` by default.

`/playground/pocket` runs `MobileWall` with two sessions: **`pocket-tut`** ("tutorial", active, `TutRunner` with `POCKET_TUTORIAL_PROFILE`) and **`pocket-changelog`** ("changelog", `ChangelogRunner` for wrapped text + a mouse-capturing target). It attaches `TutDetector` with the shared activity/mouse stores. Pocket-specific Gesture detections are wired in `PocketTerminalExperience`: touch-mode changes complete `gn-touch-mode`, and `MobileTerminalUi.onGestureInput` completes `gn-arrows`/`gn-enter`/`gn-esc` only for radial-menu-generated inputs.

## Menu and navigation behavior

The desktop runner opens at a top-level menu; Pocket starts inside Gesture navigation and Esc returns to its menu. Selecting a section drills into its item list, showing `[N/M complete]` per section. Inside a section, items render `✓` (green, complete), `●` (yellow active marker — intentionally static so runner re-renders don't feed the activity monitor), or `·` (dim, later). Esc / `q` / Ctrl+C pops back one screen (section → menu → exit); re-running `tut` re-enters. `Reset progress` returns to the profile's initial screen.

Below the sections the menu lists `Starred on GitHub` (persisted separately, calls `onOpenGithub`) and `🐭 FlappyTerm 🐭`. Flappy is `[LOCKED N/M]` until all section checklist items are complete (the star and Flappy rows don't count toward `N/M`), then shows `[High score: N]` and unlocks a runner-local mini-game. The game-over screen cross-links the other surface: desktop `p` → `onOpenPocket`, Pocket `n` → `onNotifyPocket`. The page wires these callbacks (and their URLs) in `PocketTerminalExperience.tsx` and the desktop playground page.

### Runner-local intercepts

Two keys are intercepted by `TutRunner` while a specific section is open — they are **not** real Dormouse shortcuts:

- **`s`** (Alert section) — drives a fake busy task on the WATCHING-enabled pane via `FakePtyAdapter.pumpActivity` (no text output) and animates an in-place countdown. The duration must outlast `cfg.alert.userAttention` so the bell actually rings rather than being suppressed as "user is looking"; see the comment in `tut-runner.ts`. Falls back to `PANE_BOXED` if no WATCHING pane is known.
- **`p`** (Copy paste section) — toggles the **Place To Paste** scratch modal (`website/src/components/PlaceToPaste.tsx`) via `onTogglePlaceToPaste`. Only wired on desktop; Pocket omits the callback.

### Pocket Copy paste specifics

Pocket reuses `cp-select`/`cp-raw`/`cp-rewrap` but drops `cp-override`: in Select mode it auto-overrides mouse capture for every mounted pane whose TUI is capturing the mouse, so it never asks the user to click the cursor icon. It also renders a non-counted live prompt above the checklist that reflects the current touch mode (yellow while Select is inactive, green once active); it is not stored or checkmarked.

## Storage

`TutorialState` persists to `localStorage`. Unknown ids in a stored payload are filtered on load, so renaming an id is a one-way reset for that item. Both profiles share the completion key; profile totals count only that profile's items.

- `dormouse-tut-v3` — JSON array of completed item ids.
- `dormouse-tut-star-v1` — `"true"` after `Starred on GitHub`.
- `dormouse-flappy-high-v1` — high score.

All three are removed on `TutorialState.reset()`. Legacy `dormouse-tutorial-step-N` / `dormouse-tut-v2-*` keys are not read.

## Lib changes backing the tutorial

These exist in `dormouse-lib` (or `MobileTerminalUi`) specifically so the browser-side tutorial can observe and drive real behavior:

- **`WallEvent.kill` / `WallEvent.move`** — discriminants on the `WallEvent` union (`lib/src/components/wall/wall-types.ts`); `kill` fires from `acceptKill`, `move` from `handle-pane-shortcuts.ts` after the Cmd/Ctrl-Arrow swap.
- **`FakePtyAdapter.pumpActivity(id, durationMs, intervalMs)`** — drives the alert manager for a fixed duration with no data output (used by the `s` busy demo).
- **`FakePtyAdapter.sendOutput(id, data)`** — pushes data through the data handlers as if the PTY produced it, also driving `alertManager.onData()`.
- **`MobileTerminalUi.onGestureInput(input, data)`** — optional callback fired only for radial-menu actions, so Pocket credits gesture items without mistaking native keyboard input for gestures.

`SCENARIO_TUTORIAL_MOTD` was removed — the runner owns the main pane's screen.

## Theme Picker

Implemented in `dormouse-lib/lib/themes` and `dormouse-lib/components/ThemePicker`. Bundled themes are GitHub variants only; users can install more from OpenVSX via the dropdown footer (`Install theme from OpenVSX`). Installed rows have an `X` delete control (requires browser confirmation); deleting the active installed theme falls back to the first bundled theme.

The picker is labeled `Theme:` and appears on `/playground/desktop` (inside the theme-aware `SiteHeader`), `/playground/pocket` mobile (floating over the terminal), and the desktop Pocket page (standalone appbar variant). `/pocket` redirects before rendering one.

Each theme is a map of `--vscode-*` overrides. `applyTheme()` cascades them into `--color-*` (via `theme.css` fallbacks), triggers the `MutationObserver` in `lib/src/lib/terminal-theme.ts` to re-read `getTerminalTheme()` for xterm.js terminals, and updates Dockview/Tailwind tokens. The active theme is restored on mount.

## Mouse and Clipboard Feature Coverage

The Playground is the primary dogfood surface for `docs/specs/mouse-and-clipboard.md`. The layout (`tut-main` runner, `tut-boxed` `changelog`, `tut-splash` `ascii-splash`) covers most of the spec. Legend: ✅ exercisable today, ⚠️ partial, ❌ not exercisable.

| Spec § | Feature | Status | Why |
|---|---|---|---|
| §1 | Mouse icon visible when program requests reporting | ✅ | `ascii-splash` emits `\x1b[?1000h` / `?1002h` / `?1003h` / `?1006h`. |
| §2 | Temporary/permanent override, banner, Make-permanent / Cancel | ✅ | Use the header mouse icon while `ascii-splash` is active. |
| §3.1–§3.3 | Drag, Alt-block shape, "Hold Alt" hint | ✅ | Works on any visible text. |
| §3.3 | "Press e to select the full URL/path" hint | ❌ | No qualifying tokens in the live scenarios. |
| §3.4 | Pure-scroll follows, cancel-on-change, cancel-on-resize | ⚠️ | `ascii-splash` makes cancel-on-change and resize observable; scenarios too short for pure-scroll. |
| §3.5 | Scrollback-origin / cross-boundary drags | ⚠️ | Scrollback too short to exercise. |
| §3.6 | Keyboard routing during drag | ✅ | With override active on `ascii-splash`, drag-time keyboard consumption is observable. |
| §3.7 | Popup on mouse-up, new-drag-replaces | ✅ | Any selection. |
| §4.1.1 | Copy Raw | ✅ | Any selection. |
| §4.1.2 | Copy Rewrapped (paragraph unwrap) | ✅ | `ChangelogRunner` renders wrapped item lines that exercise the rewrap path. |
| §4.2 | Cmd+C / Cmd+Shift+C | ✅ | Any selection. |
| §4.3 | Esc / click-outside dismiss | ✅ | Any selection popup. |
| §5 | Smart-extension (URL / abs path / rel path / Windows path / error location) | ❌ | No matching tokens in the scenarios. |
| §5.3 | Press `e` to extend | ❌ | Blocked on §5 coverage. |
| §8.2 | Cmd+V / Cmd+Shift+V / Ctrl+V / Ctrl+Shift+V paste | ⚠️ | Fires and writes to the fake PTY, but `TutorialShell.handleInput` echoes char-by-char and ignores bracketed-paste markers. |
| §8.5 | Bracketed paste wraps `\e[200~ … \e[201~` | ❌ | No scenario emits `\x1b[?2004h`, so `bracketedPaste` stays `false`. |

`§3.6` auto-scroll and `§8.7` right-click paste are deferred in the implementation itself — not Playground gaps.

Two follow-up scenarios from the previous remediation plan remain useful and can be added without changing the three sections (expanding or replacing the `tut-boxed` neighbor):

1. **`SCENARIO_BRACKETED_PASTE_TUI`** — closes §8.5. Emits `\x1b[?2004h` and an idle ANSI-framed view.
2. **`SCENARIO_SMART_TOKENS`** — closes the §3.3 hint and §5.1–§5.3. Prints one of each shape from `lib/src/lib/smart-token.ts`'s `PATTERNS`.
