# Playground Tutorial

At the `/playground` route on the website. Interactive TUI: each item starts pending, the first incomplete item is marked as active, and completed items become green checks when MouseTerm detects the corresponding action.

## Architecture

Three browser-side pieces in `website/src/lib/`, mirroring the pattern in `website/src/lib/ascii-splash-runner.ts` (xterm alt-screen + `FakePtyAdapter` boundary, no Node `terminal-kit` package):

- **`tut-runner.ts`** (`TutRunner`) — alt-screen TUI. Subscribes to `TutorialState` and re-renders whenever progress changes. Routes input bytes via `FakePtyAdapter.writePty(id, …)`.
- **`tut-detector.ts`** (`TutDetector`) — wires app events to `TutorialState.markComplete(id)`. Subscribes to `DockviewApi.onDidActivePanelChange`, the `WallEvent` stream, the `subscribeToActivity` store from `mouseterm-lib/lib/terminal-registry`, and the `subscribeToMouseSelection` store from `mouseterm-lib/lib/mouse-selection`.
- **`tutorial-state.ts`** (`TutorialState`) — single in-memory progress store, persisted as a JSON array of completed item ids under the `mouseterm-tut-v3` localStorage key.
- **`tut-items.ts`** — section + item definitions (titles, hints) shared by runner and detector. Item ids are stable; they are the localStorage key suffixes.

## Layout

- `SiteHeader` at top with the `Theme:` dropdown control on `/playground` (other routes do not render it). Header is `themeAware` so `--vscode-*` variables drive its background, border, text, and banner colors.
- `<main>` is a flex container so Wall's `flex-1 min-h-0` root gets a real height.
- `Wall` runs `FakePtyAdapter` with `initialMode="passthrough"` and three initial panes:
  - **`tut-main`** (left, ~50%) — auto-launches `TutRunner` on mount via `mainShell.runCommand("tut")`.
  - **`tut-boxed`** (right-top, ~25%) — titled "changelog". `SCENARIO_BOXED_PARAGRAPH`. The boxed paragraph for Copy Rewrapped vs Copy Raw.
  - **`tut-splash`** (right-bottom, ~25%) — titled "ascii-splash". Auto-launches `AsciiSplashRunner` on mount via `splashShell.runCommand("ascii-splash")`.
- The two right-side panes are added in `onApiReady` with `position: { referencePanel, direction }` after Wall creates the initial main pane.

Every playground pane gets a `TutorialShell` input handler through `PlaygroundShellRegistry`. Newly split or spawned fake terminals use `SCENARIO_SHELL_PROMPT` by default. The shell dispatches by command name to a `startProgram` factory provided by the page; the factory wires `tut` → `TutRunner` and `ascii-splash` / `splash` → `AsciiSplashRunner`.

## Tutorial Sections

The runner shows a top-level menu first. Selecting a section drills into its item list. Each section shows `[N/M complete]` next to its title. Inside a section, items render as one of:

- `✓` (green) — complete
- `●` (yellow active marker) — first incomplete item, with hint text shown below. This marker is intentionally static so runner re-renders do not feed the activity monitor.
- `·` (dim) — later incomplete items

Esc / `q` / Ctrl+C pops back one screen (section → menu → exit). Exiting the runner returns the pane to the shell prompt; running `tut` re-enters.

### Section 1 — Keyboard navigation (7 items)

| ID | Title | Detection |
|---|---|---|
| `kb-mode` | Enter command mode | `WallEvent.modeChange` to `'command'` (the modifier dual-tap is in the hint) |
| `kb-split-h` | Add a horizontal divider with `-` (or `"`) | `WallEvent.split { source: 'keyboard', direction: 'vertical' }` |
| `kb-arrows` | Move between panes with arrow keys | `onDidActivePanelChange` ≥ 2 distinct panels while in command mode |
| `kb-split-v` | Add a vertical divider with `\|` (or `%`) | `WallEvent.split { source: 'keyboard', direction: 'horizontal' }` |
| `kb-min` | Minimize a pane | `WallEvent.minimizeChange { count > 0 }` |
| `kb-kill` | Kill a pane | `WallEvent.kill` (added to the `WallEvent` union; emitted from `acceptKill` in `Wall.tsx`) |
| `kb-move` | Move a pane with Cmd/Ctrl + arrow | `WallEvent.move` (added to the `WallEvent` union; emitted from `handle-pane-shortcuts.ts` after `swapTerminals`) |

Prose under the section: "tmux shortcuts also work — `% " d x`."

Note: `-` produces a `direction: 'vertical'` split (panes stack top/bottom = horizontal divider); `|` produces `direction: 'horizontal'` (panes side by side = vertical divider). The detector maps event direction → user-facing item accordingly.

### Section 2 — Alert and TODO (6 items)

The detector subscribes to `subscribeToActivity()` and tracks per-id `(status, todo)` transitions.

| ID | Title | Detection |
|---|---|---|
| `al-enable` | Enable alerts on a pane (click bell or `a`) | status transitions away from `ALERT_DISABLED` |
| `al-busy` | Watch the bell tilt while a task runs | status enters `BUSY` or `MIGHT_BE_BUSY` |
| `al-ring` | Bell rings on completion | status enters `ALERT_RINGING` |
| `al-todo-auto` | TODO appears when you dismiss the ringing alert | `todo` transitions `false → true` while previous status was `ALERT_RINGING` |
| `al-todo-clear` | Press passthrough Enter to clear the TODO | `todo` transitions `true → false` |
| `al-todo-manual` | Manually add a TODO (`t` or right-click) | `todo` transitions `false → true` while previous status was NOT `ALERT_RINGING` |

The detector remembers the most recent pane whose alert was enabled. The Alert section view shows a runner-local instruction: "Press `s` here to start a fake busy task." `s` is **not** a real MouseTerm shortcut; it is intercepted by `TutRunner` only while the Alert section is open. When pressed, the runner does two things:

1. Resolves that pane to its current PTY session id, then calls `adapter.pumpActivity(sessionId, BUSY_DEMO_DURATION_MS, 800)` — drives the alert-manager's activity monitor on the same alert-enabled session with **no text output**, so the bell tilts to BUSY without scrolling any scenario text. The session id is resolved at trigger time so `Cmd/Ctrl+Arrow` swaps do not leave the tutorial pumping an old pane id. If no alert-enabled pane is known, the runner falls back to `PANE_BOXED` (the changelog pane). `BUSY_DEMO_DURATION_MS` is `cfg.alert.userAttention + 250` so silence begins after the attention idle window has expired, with a small scheduler-jitter guard; otherwise the "user is looking at this pane" check inside `ActivityMonitor.startNeedsAttentionConfirmTimer` would suppress the ring rather than let it fire.
2. Animates a countdown in-place where the "Press s…" hint was: `⠋ Fake task will finish in N seconds.` ticking down to 1, then a static `✓ Fake task finished. Press s to start another one.` once the activity stops. Detection is purely timing-based via the existing `ActivityMonitor`, so no shell integration is required.

### Section 3 — Copy paste (4 items)

The detector subscribes to `subscribeToMouseSelection()` and tracks per-id transitions on `selection`, `copyFlash`, and `override`.

| ID | Title | Detection |
|---|---|---|
| `cp-select` | Drag-select text in any pane | `selection` transitions `null → non-null` |
| `cp-raw` | Click Copy Raw | `copyFlash` transitions to `'raw'` (set by `flashCopy()` after the popup button fires) |
| `cp-rewrap` | Click Copy Rewrapped on the boxed paragraph | `copyFlash` transitions to `'rewrapped'` |
| `cp-override` | Run `ascii-splash`, then click its cursor icon | `override` transitions `'off' → 'temporary' \| 'permanent'` |

Prose:
- "Some programs trap the mouse — the cursor icon lets you override."
- "`ascii-splash` redraws every frame, so it cancels selections: looks cool, undragable."

The Copy Rewrapped step uses `SCENARIO_BOXED_PARAGRAPH` (in `lib/src/lib/platform/fake-scenarios.ts`). Frame-only and frame-flanking box-drawing runs are stripped by `lib/src/lib/rewrap.ts` so Rewrapped joins the wrapped paragraph; clipboard contents visibly differ from Raw.

While the Copy paste section is open, pressing `p` toggles the **Place To Paste** modal — a draggable, CSS-`resize:both` scratch box rendered by `website/src/components/PlaceToPaste.tsx` and mounted at the page level. `TutRunner` intercepts `p`/`P` (mirroring the Alert section's `s` busy-demo intercept) and calls `onTogglePlaceToPaste`; `Playground` flips a `placeToPasteOpen` flag so the modal is portal-free and overlays the wall. Users paste copied text into its single textarea and resize the modal to see whether the text reflows (Rewrapped) or stays line-broken (Raw).

## Lib changes added for this tutorial

- **`WallEvent.kill`** and **`WallEvent.move`** — new discriminants on the `WallEvent` union (`lib/src/components/wall/wall-types.ts`). `kill` fires from `acceptKill` in `Wall.tsx`. `move` fires from `handle-pane-shortcuts.ts` after the Cmd/Ctrl-Arrow swap, via a new `fireEvent` callback added to `WallKeyboardCtx`.
- **`FakePtyAdapter.pumpActivity(id, durationMs, intervalMs)`** — drives the alert-manager for a fixed duration with no data output. The runner uses this so the bell on the demo pane tilts/rings while the visible "task running" animation lives entirely inside the tutorial pane.
- **`FakePtyAdapter.sendOutput(id, data)`** — pushes data through the data handlers as if the PTY produced it, also driving `alertManager.onData()`. Used by `TutRunner` and `AsciiSplashRunner` so browser-side echoes still feed the activity monitor.
- **`SCENARIO_BOXED_PARAGRAPH`** — boxed multi-line prose, used by `tut-boxed`.

`SCENARIO_TUTORIAL_MOTD` was removed — the runner now owns the main pane's screen.

## Storage

- Completion: `localStorage["mouseterm-tut-v3"] = JSON.stringify([...completedItemIds])`. Removed on `TutorialState.reset()`. Unknown ids in a stored payload are filtered out on load, so renaming an id is a one-way reset for that item.
- Legacy keys `mouseterm-tutorial-step-N` and `mouseterm-tut-v2-*` from previous designs are not read; new playground sessions get a fresh start.

## Theme Picker

Implemented in `mouseterm-lib/lib/themes` and `mouseterm-lib/components/ThemePicker`.

Bundled themes are provided by `mouseterm-lib/lib/themes` and include only GitHub variants. Users can install additional themes from OpenVSX through the dropdown footer action.

The picker appears only on `/playground`, inside `SiteHeader`, labeled `Theme:`. The trigger opens a dropdown of bundled and installed themes. The dropdown footer is always `Install theme from OpenVSX`, which opens the theme store dialog. Installed theme rows include an `X` delete control; deletion requires browser confirmation before removing the theme from localStorage. If the active installed theme is deleted, the picker falls back to the first bundled theme and applies it immediately.

Each theme is defined as a map of `--vscode-*` CSS variable overrides. `applyTheme()` applies the active theme, which:
1. Cascades into `--color-*` variables (via `var(--vscode-*, fallback)` in `theme.css`)
2. Triggers the `MutationObserver` in `lib/src/lib/terminal-theme.ts` to re-read `getTerminalTheme()` for all xterm.js terminals
3. Updates Dockview/Tailwind token colors

The picker restores the persisted active theme on mount. The playground header is `themeAware`, so the same active theme also affects the site header chrome while the picker remains hidden on non-playground routes.

## Mouse and Clipboard Feature Coverage

The Playground is the primary dogfood surface for the features in `docs/specs/mouse-and-clipboard.md`. The tutorial layout (`tut-main` running the runner, `tut-boxed` changelog/boxed-paragraph pane, `tut-splash` auto-running `ascii-splash`) covers most of the spec; one notable gap remains.

Legend: ✅ exercisable today, ⚠️ partial, ❌ not exercisable.

| Spec § | Feature | Status | Why |
|---|---|---|---|
| §1 | Mouse icon visible when program requests reporting | ✅ | Run `ascii-splash`; the runner emits `\x1b[?1000h` / `?1002h` / `?1003h` / `?1006h`. |
| §2 | Temporary/permanent override, banner, Make-permanent / Cancel | ✅ | Run `ascii-splash`, then use the header mouse icon while the animation is active. |
| §3.1–§3.3 | Drag, Alt-block shape, "Hold Alt" hint | ✅ | Works on any visible text. |
| §3.3 | "Press e to select the full URL/path" hint | ❌ | No qualifying tokens in the live scenarios. |
| §3.4 | Pure-scroll follows, cancel-on-change, cancel-on-resize | ⚠️ | `ascii-splash` makes cancel-on-change and resize cancel observable; scenarios are still too short for pure-scroll coverage. |
| §3.5 | Scrollback-origin / cross-boundary drags | ⚠️ | Scrollback is too short to exercise. |
| §3.6 | Keyboard routing during drag | ✅ | `ascii-splash` reacts to keys and mouse; with override active, drag-time keyboard consumption is observable. |
| §3.7 | Popup on mouse-up, new-drag-replaces | ✅ | Any selection. |
| §4.1.1 | Copy Raw | ✅ | Any selection. |
| §4.1.2 | Copy Rewrapped (box-strip + paragraph unwrap) | ✅ | `SCENARIO_BOXED_PARAGRAPH` provides a boxed paragraph in `tut-boxed`. |
| §4.2 | Cmd+C / Cmd+Shift+C | ✅ | Any selection. |
| §4.3 | Esc / click-outside dismiss | ✅ | Any selection popup. |
| §5 | Smart-extension (URL / abs path / rel path / Windows path / error location) | ❌ | No matching tokens in the scenarios. |
| §5.3 | Press `e` to extend | ❌ | Blocked on §5 coverage. |
| §8.2 | Cmd+V / Cmd+Shift+V / Ctrl+V / Ctrl+Shift+V paste | ⚠️ | The shortcut fires and writes to the fake PTY, but `TutorialShell.handleInput` echoes characters one by one and does not interpret bracketed-paste markers. |
| §8.5 | Bracketed paste wraps `\e[200~ … \e[201~` | ❌ | No scenario emits `\x1b[?2004h`, so `getMouseSelectionState(id).bracketedPaste` stays `false` and `doPaste` sends the raw text. |

`§3.6` auto-scroll and `§8.7` right-click paste are deferred in the implementation itself — not Playground gaps.

### Follow-up scenarios

Two scenarios from the previous spec's remediation plan remain useful:

1. **`SCENARIO_BRACKETED_PASTE_TUI`** — closes §8.5. Emits `\x1b[?2004h` and an idle ANSI-framed view; pastes into it would be wrapped `\x1b[200~ … \x1b[201~`.
2. **`SCENARIO_SMART_TOKENS`** — closes §3.3 extension hint and §5.1–§5.3. Prints one of each detectable shape from `lib/src/lib/smart-token.ts`'s `PATTERNS`.

These can be added without changing the tutorial's three sections — they would expand the `tut-boxed` neighbor or replace it depending on layout decisions at the time.
