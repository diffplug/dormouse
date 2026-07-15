# Playground Tutorial

> See `docs/specs/glossary.md` for Session / Pane vocabulary. This spec uses it for the playground's pane layout and detection wiring.

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
- **`tut-detector.ts`** (`TutDetector`) — wires app events to `TutorialState.markComplete(id)`. It is engine-neutral: `start()` seeds its prev-state maps and subscribes to `subscribeToActivity` (`dormouse-lib/lib/terminal-registry`) and `subscribeToMouseSelection` (`dormouse-lib/lib/mouse-selection`); everything else arrives on the `WallEvent` stream (`handleWallEvent`). It never touches the tiling engine — keyboard split completion is credited before the split's automatic passthrough transition, and the following kb-arrows hint directs the user to re-enter command mode; kb-arrows itself is credited from `selectionChange` (a pane selection change to a distinct pane while in command mode), which `Wall.selectPane` fires. The per-item detection contract — which transition credits which id, the Cmd/Ctrl+Arrow `move` consume-first guard, and the guards against falsely crediting restored/spawned state — lives in this file's code and comments.
- **`tutorial-state.ts`** (`TutorialState`) — in-memory progress store; see [Storage](#storage) for keys. Profile totals are computed from the active profile's section list.
- **`tut-items.ts`** — section + item definitions and the two profiles, shared by runner and detector.

## Layout

- `SiteHeader` at top with the `Theme:` dropdown on `/playground/desktop`. Header is `themeAware` so `--vscode-*` variables drive its chrome.
- `<main>` is a flex container so Wall's `flex-1 min-h-0` root gets a real height.
- `/playground/desktop` runs `Wall` (`FakePtyAdapter`, `initialMode="passthrough"`) in a deterministic three-pane L-shape from `DESKTOP_PLAYGROUND_LAYOUT` in `website/src/lib/playground-desktop-layout.ts`: a 50/50 root row makes one vertical divider, and the right child is a 50/50 column making one horizontal divider. The explicit valid Lath seed avoids the generic synchronous `initialPaneIds` path, whose later leaves have no measured geometry yet and therefore cannot reliably choose alternating axes. Header titles are seeded as pending shell opts (`setPendingShellOpts(id, { title })`) before the Wall mounts; the lib applies each as a user-pin at first spawn, which `deriveHeader` ranks above the engine fallback:
  - **`tut-main`** (left, ~50%) — auto-launches `TutRunner` (`mainShell.runCommand("tut")`), title "tutorial".
  - **`tut-boxed`** (right-top, ~25%, "changelog") — auto-launches `ChangelogRunner`. Doubles as the Copy Rewrapped target; its wrapped lines exercise the rewrap path.
  - **`tut-splash`** (right-bottom, ~25%, "ascii-splash") — auto-launches `AsciiSplashRunner`.

Every visible pane gets a `TutorialShell` input handler via `PlaygroundShellRegistry`: the three seed panes are ensured eagerly, and any pane the user splits off is ensured from the `paneAdded` `WallEvent` (`ensureShell` is idempotent). The shell dispatches by command name to a page-provided `startProgram` factory (`tut` → `TutRunner`, `ascii-splash`/`splash` → `AsciiSplashRunner`). Spawned terminals use `SCENARIO_SHELL_PROMPT` by default.

`/playground/pocket` runs `MobileWall` with two sessions: **`pocket-tut`** ("tutorial", active, `TutRunner` with `POCKET_TUTORIAL_PROFILE`) and **`pocket-changelog`** ("changelog", `ChangelogRunner` for wrapped text + a mouse-capturing target). It starts a `TutDetector` (`start()`) over the shared activity/mouse stores. Pocket-specific Gesture detections are wired in `PocketTerminalExperience`: touch-mode changes complete `gn-touch-mode`, and `MobileTerminalUi.onGestureInput` completes `gn-arrows`/`gn-enter`/`gn-esc` only for radial-menu-generated inputs.

## Menu and navigation behavior

The desktop runner opens at a top-level menu; Pocket starts inside Gesture navigation and Esc returns to its menu. Selecting a section drills into its item list, showing `[N/M complete]` per section. Inside a section, items render `✓` (green, complete), `●` (yellow active marker — intentionally static so runner re-renders don't feed the activity monitor), or `·` (dim, later). Esc / `q` pop back one screen (section → menu → exit); Ctrl+C exits the runner immediately from any screen; re-running `tut` re-enters. `Reset progress` returns to the profile's initial screen.

Below the sections the menu lists `Starred on GitHub` (persisted separately, calls `onOpenGithub`) and `🐭 FlappyTerm 🐭`. Flappy is `[LOCKED N/M]` until all section checklist items are complete (the star and Flappy rows don't count toward `N/M`), then shows `[High score: N]` and unlocks a runner-local mini-game. The game-over screen cross-links the other surface: desktop `p` → `onOpenPocket`, Pocket `n` → `onNotifyPocket`. The page wires these callbacks (and their URLs) in `PocketTerminalExperience.tsx` and the desktop playground page.

### Runner-local intercepts

Two keys are intercepted by `TutRunner` while a specific section is open — they are **not** real Dormouse shortcuts:

- **`s`** (Alert section) — drives a fake busy task on the WATCHING-enabled pane via `FakePtyAdapter.pumpActivity` (no text output) and animates an in-place countdown. The duration must outlast `cfg.alert.userAttention` so the bell actually rings rather than being suppressed as "user is looking"; see the comment in `tut-runner.ts`. Falls back to `PANE_BOXED` if no WATCHING pane is known.
- **`p`** (Copy paste section) — toggles the **Place To Paste** scratch modal (`website/src/components/PlaceToPaste.tsx`) via `onTogglePlaceToPaste`. Only wired on desktop; Pocket omits the callback.

### Pocket Copy paste specifics

Pocket reuses `cp-select`/`cp-raw`/`cp-rewrap` but drops `cp-override`: in Select mode it auto-overrides mouse capture for every mounted pane whose TUI is capturing the mouse, so it never asks the user to click the cursor icon. It also renders a non-counted live prompt above the checklist that reflects the current touch mode (yellow while Select is inactive, green once active); it is not stored or checkmarked.

## Fake shell behavior

Every playground pane gets a `TutorialShell` (see Architecture); a fake shell
is all the playground needs. Minimum useful behavior:

* Echo typed characters and maintain a command-line buffer; Enter submits,
  Backspace edits.
* Up/Down arrows recall command history at the shell prompt; Escape, Tab, and Left/Right are no-ops at the base prompt (full-screen runners like `ascii-splash` give them behavior).
* When a fake full-screen app such as `ascii-splash`, `splash`, `changelog`, or
  `tut` is running, `Ctrl+C` sends `\x03` to that app; if the app exits, the
  terminal returns to the fake shell prompt instead of restarting the app.
* New panes created from the wall get the same fake shell behavior and prompt
  as regular `/playground/desktop` panes.

Example commands: `help`, `clear`, `echo hello`, `ascii-splash`, `changelog`,
`tut`. The shell only needs enough behavior to exercise the tutorial and the
mobile controls.

## Storage

`TutorialState` persists to `localStorage`. Unknown ids in a stored payload are filtered on load, so renaming an id is a one-way reset for that item. Both profiles share the completion key; profile totals count only that profile's items.

- `dormouse-tut-v3` — JSON array of completed item ids.
- `dormouse-tut-star-v1` — `"true"` after `Starred on GitHub`.
- `dormouse-flappy-high-v1` — high score.

All three are removed on `TutorialState.reset()`. Legacy `dormouse-tutorial-step-N` / `dormouse-tut-v2-*` keys are not read.

## Lib changes backing the tutorial

These exist in `dormouse-lib` (or `MobileTerminalUi`) specifically so the browser-side tutorial can observe and drive real behavior:

- **`WallEvent.kill` / `WallEvent.move` / `WallEvent.paneAdded`** — discriminants on the `WallEvent` union (`lib/src/components/wall/wall-types.ts`); `kill` fires from `acceptKill`, `move` from `handle-pane-shortcuts.ts` after the Cmd/Ctrl-Arrow swap. `paneAdded` fires once per pane that becomes visible (seed ids, splits, dor surfaces, restores, auto-spawn) via the Lath store-subscription leaf-id diff (seed ids announced explicitly so they are emitted too) — so the page can create a fake shell for each pane without touching the tiling engine.
- **`FakePtyAdapter.pumpActivity(id, durationMs, intervalMs)`** — drives the alert manager for a fixed duration with no data output (used by the `s` busy demo).
- **`FakePtyAdapter.sendOutput(id, data)`** — pushes data through the data handlers as if the PTY produced it, also driving `alertManager.onData()`.
- **`MobileTerminalUi.onGestureInput(input, data)`** — optional callback fired only for radial-menu actions, so Pocket credits gesture items without mistaking native keyboard input for gestures.

`SCENARIO_TUTORIAL_MOTD` was removed — the runner owns the main pane's screen.

## Theme Picker

Implemented in `dormouse-lib/lib/themes` and `dormouse-lib/components/ThemePicker`. Bundled themes are a small built-in VS Code set (`bundled.json`: Dark/Light Visual Studio, Monokai, Quiet Light, Red, Kimbie Dark, Abyss, and Selenized variants); users can install more from OpenVSX via the dropdown footer (`Install theme from OpenVSX`). Installed rows have an `X` delete control (requires browser confirmation); deleting the active installed theme falls back to the page's `defaultThemeId` (Kimbie Dark on the playground/Pocket pages), with the first bundled theme as last resort.

The picker is labeled `Theme:` and appears on `/playground/desktop` (inside the theme-aware `SiteHeader`), `/playground/pocket` mobile (floating over the terminal), and the desktop Pocket page (standalone appbar variant). `/pocket` redirects before rendering one.

Each theme is a map of `--vscode-*` overrides. `applyTheme()` cascades them into `--color-*` (via `theme.css` fallbacks), triggers the `MutationObserver` in `lib/src/lib/terminal-theme.ts` to re-read `getTerminalTheme()` for xterm.js terminals, and updates Tailwind tokens. The active theme is restored on mount.

## Mouse and Clipboard Feature Coverage

The Playground is the primary dogfood surface for `docs/specs/mouse-and-clipboard.md`. The layout (`tut-main` runner, `tut-boxed` `changelog`, `tut-splash` `ascii-splash`) covers most of the spec. Legend: ✅ exercisable today, ⚠️ partial, ❌ not exercisable.

| Spec § | Feature | Status | Why |
|---|---|---|---|
| [§1](mouse-and-clipboard.md#1-the-mouse-icon-header-indicator) | Mouse icon visible when program requests reporting | ✅ | `ascii-splash` emits `\x1b[?1000h` / `?1002h` / `?1003h` / `?1006h`. |
| [§2](mouse-and-clipboard.md#2-override-state) | Temporary/permanent override, banner, Make-permanent / Cancel | ✅ | Use the header mouse icon while `ascii-splash` is active. |
| [§3.1–§3.3](mouse-and-clipboard.md#31-initiating-a-selection) | Drag, Alt-block shape, "Hold Alt" hint | ✅ | Works on any visible text. |
| [§3.3](mouse-and-clipboard.md#33-selection-hint-text) | "Press e to select the full URL/path" hint | ❌ | No qualifying tokens in the live scenarios. |
| [§3.4](mouse-and-clipboard.md#34-selection-follows-content) | Pure-scroll follows, cancel-on-change, cancel-on-resize | ⚠️ | `ascii-splash` makes cancel-on-change and resize observable; scenarios too short for pure-scroll. |
| [§3.5](mouse-and-clipboard.md#35-selection-in-the-live-region-vs-scrollback) | Scrollback-origin / cross-boundary drags | ⚠️ | Scrollback too short to exercise. |
| [§3.6](mouse-and-clipboard.md#36-during-a-drag) | Keyboard routing during drag | ✅ | With override active on `ascii-splash`, drag-time keyboard consumption is observable. |
| [§3.7](mouse-and-clipboard.md#37-ending-a-selection) | Popup on mouse-up, new-drag-replaces | ✅ | Any selection. |
| [§4.1.1](mouse-and-clipboard.md#411-copy-raw) | Copy Raw | ✅ | Any selection. |
| [§4.1.2](mouse-and-clipboard.md#412-copy-rewrapped) | Copy Rewrapped (paragraph unwrap) | ✅ | `ChangelogRunner` renders wrapped item lines that exercise the rewrap path. |
| [§4.2](mouse-and-clipboard.md#42-keyboard-shortcuts) | Cmd+C / Cmd+Shift+C | ✅ | Any selection. |
| [§4.3](mouse-and-clipboard.md#43-dismissing-the-popup) | Esc / click-outside dismiss | ✅ | Any selection popup. |
| [§5](mouse-and-clipboard.md#5-smart-extension-url--path-detection) | Smart-extension (URL / abs path / rel path / Windows path / error location) | ❌ | No matching tokens in the scenarios. |
| [§5.3](mouse-and-clipboard.md#53-extension-action) | Press `e` to extend | ❌ | Blocked on §5 coverage. |
| [§8.2](mouse-and-clipboard.md#82-paste-keybindings) | Cmd+V / Cmd+Shift+V / Ctrl+V / Ctrl+Shift+V paste | ⚠️ | Fires and writes to the fake PTY, but `TutorialShell.handleInput` echoes char-by-char and ignores bracketed-paste markers. |
| [§8.5](mouse-and-clipboard.md#85-bracketed-paste) | Bracketed paste wraps `\e[200~ … \e[201~` | ❌ | No scenario emits `\x1b[?2004h`, so `bracketedPaste` stays `false`. |

Auto-scroll during a drag and right-click paste are deferred in the implementation itself ([§9. Future](mouse-and-clipboard.md#9-future)) — not Playground gaps.

## Future

Two follow-up scenarios from the previous remediation plan remain useful and can be added without changing the three sections (expanding or replacing the `tut-boxed` neighbor):

1. **`SCENARIO_BRACKETED_PASTE_TUI`** — closes [§8.5](mouse-and-clipboard.md#85-bracketed-paste). Emits `\x1b[?2004h` and an idle ANSI-framed view.
2. **`SCENARIO_SMART_TOKENS`** — closes the [§3.3](mouse-and-clipboard.md#33-selection-hint-text) hint and [§5.1–§5.3](mouse-and-clipboard.md#51-detection). Prints one of each shape from `lib/src/lib/smart-token.ts`'s `PATTERNS`.
