# Playground Tutorial

At the `/playground` route on the website. **Status: Implemented** (Epics 14, 15, 16).

## Layout

- `SiteHeader` at top (with Playground as active nav item). On `/playground`, the header renders the **Theme:** dropdown as an optional header control; other routes do not render it.
- Below the header: MouseTerm `Wall` embedded fullscreen using `FakePtyAdapter`. The page-level `<main>` is a flex container so Wall's `flex-1 min-h-0` root receives a real height.
- The playground header uses the active `--vscode-*` theme variables for its background, border, text, and banner colors so theme changes affect the header as well as Wall.

### Implementation

- `website/src/pages/Playground.tsx` — Page component. Dynamically imports Wall (SSR-safe). Initializes `FakePtyAdapter`, per-terminal `TutorialShell` instances through `PlaygroundShellRegistry`, `AsciiSplashRunner`, and `TutorialDetector`. Passes `onApiReady` to set up the 3-pane layout and `onEvent` for step detection.
- `website/src/components/SiteHeader.tsx` — Shared header. Accepts an optional playground-only `controls` slot and a `themeAware` mode that reads the active VSCode theme variables.
- `mouseterm-lib/components/ThemePicker` — Shared header dropdown for bundled and installed themes. The playground passes `variant="playground-header"` and the footer action opens the OpenVSX installer.
- `website/vite.config.ts` — Vite alias `mouseterm-lib` → `../lib/src` for workspace imports.

## Initial State

The sandbox starts pre-populated — not empty. Scenarios assigned via `FakePtyAdapter.setScenario()` before Wall mounts:

- **Pane 1** (`tut-main`, left, ~60%): `SCENARIO_TUTORIAL_MOTD` — MOTD welcome message + shell prompt.
- **Pane 2** (`tut-npm`, right-top, ~40%): `SCENARIO_LONG_RUNNING` — `npm install` with progress dots, then returns to the shell prompt.
- **Pane 3** (`tut-ls`, right-bottom): `SCENARIO_LS_OUTPUT` — `ls -la` output with a prompt.

The two right-side panes are added in `onApiReady` with `position: { referencePanel, direction }` after Wall creates the initial main pane.

Every playground pane gets its own `TutorialShell` input handler through `PlaygroundShellRegistry`. Initial demo scenarios own their output while they are playing, then the shell handles Enter, line editing, `tut`, and `ascii-splash` / `splash`. Newly split or spawned fake terminals use `SCENARIO_SHELL_PROMPT` by default so they start at `user@mouseterm:~$` instead of a blank terminal.

## Playground Shell Commands

Implemented in `website/src/lib/tutorial-shell.ts` (`TutorialShell` class).

The fake terminal accepts these inputs:

- **`tut`** — Shows the current tutorial step (or the next incomplete one). Does NOT show the full checklist upfront.
- **`tut status`** — Shows all 6 steps with `[x]`/`[ ]` completion markers, grouped by phase.
- **`tut reset`** — Clears localStorage progress and confirms.
- **`ascii-splash` / `splash`** — Launches the browser playground runner for `ascii-splash@0.3.0`.
- **Anything else** — `Unknown command. Type tut or ascii-splash.`

`TutorialShell` provides line editing (character echo, backspace), command history (`Up` / `Down` over xterm cursor-key escape sequences), and parses commands on Enter. Output goes through `FakePtyAdapter.sendOutput()`.

### `ascii-splash`

Implemented in `website/src/lib/ascii-splash-runner.ts` (`AsciiSplashRunner` class). That file's top comment is the source note for the browser adapter: it lists the upstream `ascii-splash@0.3.0` internals being reused and the local modifications made for MouseTerm/xterm/FakePty integration.

The runner uses the real upstream `ascii-splash` engine, buffer, themes, UI overlays, command parser/executor, transitions, and pattern classes. It does **not** import the upstream CLI entrypoint or `terminal-kit` renderer. Instead, it provides a browser terminal boundary:

- Renderer output is ANSI bytes sent through `FakePtyAdapter.sendOutput()`.
- Keyboard and SGR mouse bytes from `FakePtyAdapter.writePty()` are decoded and routed to the upstream command/pattern controls.
- Resize events come from `FakePtyAdapter.onPtyResize()`.
- Start/cleanup uses xterm alt-screen, cursor visibility, and mouse-reporting control sequences.

Supported CLI options in the playground runner:

- `--pattern` / `-p`
- `--quality` / `-q`
- `--fps` / `-f`
- `--theme` / `-t`
- `--no-mouse`
- `--help` / `-h`
- `--version` / `-V`

Exit with `q`, Escape, or Ctrl+C. Config persistence is disabled in the playground; upstream save/favorite commands report that no config loader is available.

### Cold Start

`SCENARIO_TUTORIAL_MOTD` (in `lib/src/lib/platform/fake-scenarios.ts`) shows a styled MOTD above the prompt:

```
  Welcome to MouseTerm.
  Type tut to start the interactive tutorial.
```

## Tutorial Steps

Steps are revealed **one at a time** — completing one reveals the next. Each step has a brief contextual prompt explaining *why* you'd do this, not just the mechanic.

Progress is stored in localStorage so the user can leave and return. Show progress as `Step N/6` when displaying each step.

### Detection

Implemented in `website/src/lib/tutorial-detection.ts` (`TutorialDetector` class). Two event sources:

1. **DockviewApi events** — `onDidAddPanel`, `onDidLayoutChange`, `onDidActivePanelChange`. Subscribed in `TutorialDetector.attach(api)`.
2. **WallEvent callbacks** — `modeChange`, `zoomChange`, `minimizeChange`, `split`. Routed via `Wall`'s `onEvent` prop (added in `lib/src/components/Wall.tsx`).

### Phase 1: See Everything at Once

**Step 1 — Split a pane**
> You're juggling multiple tasks. Split this terminal so you can watch two things side by side.
>
> *Drag the split button in the tab header, or drag the tab itself to a drop zone.*

Detection: `onDidAddPanel` fires on DockviewApi (panel count increases beyond initial count).

**Step 2 — Resize your panes**
> One task needs more room. Drag the divider between panes to give it space.
>
> *Drag the gap between two panes.*

Detection: Captures a `ResizeSnapshot` (serialized grid structure with branch ratios from `api.toJSON()`). On `onDidLayoutChange`, compares current ratios against baseline — triggers when any branch ratio shifts by >= `RESIZE_RATIO_DELTA` (0.08). Baseline resets after splits to avoid false positives.

### Phase 2: Focus and Background

**Step 3 — Zoom in, then zoom back out**
> One terminal needs your full attention. Zoom in to focus, then zoom back out when you're done.
>
> *Double-click a tab header to zoom. Double-click again to unzoom.*

Detection: Watches `WallEvent.zoomChange` — requires both a `zoomed: true` then `zoomed: false` event (unzoom after zoom).

**Step 4 — Minimize a pane, then bring it back**
> That task is running in the background — you don't need to watch it. Send it to the baseboard, then click its door when you want it back.
>
> *Click the minimize button in the tab header. Click the door in the baseboard to reattach.*

Detection: Watches `WallEvent.minimizeChange` — requires `count > 0` (minimize) then `count === 0` (reattach back to zero).

### Phase 3: Keyboard Power

**Step 5 — Enter command mode and navigate**
> Navigate between panes without touching the mouse.
>
> *Press Escape to enter command mode. Use arrow keys to move between panes.*

Detection: Watches `WallEvent.modeChange` for transition to `'command'`, then tracks `onDidActivePanelChange` — requires focus on >= 2 different panels while in command mode.

**Step 6 — Split using keyboard shortcuts**
> Split a pane without leaving the keyboard.
>
> *In command mode, press " to split top/bottom or % to split left/right.*

Detection: Watches `WallEvent.split` with `source: 'keyboard'` while in command mode.

## Completion

When all 6 steps are done, `TutorialShell.announceCompletion()` prints the completion message:

```
You've got it. MouseTerm keeps everything visible and nothing in your way.

Ready to try the real thing?
  → Download MouseTerm: mouseterm.com/#download

Or keep exploring — this sandbox is yours.
```

The sandbox stays fully functional after completion. Running `tut` shows "Tutorial complete" instead of a step. `tut reset` restarts from step 1.

## Theme Picker

Implemented in `mouseterm-lib/lib/themes` and `mouseterm-lib/components/ThemePicker`.

Bundled themes are provided by `mouseterm-lib/lib/themes` and include only GitHub variants. Users can install additional themes from OpenVSX through the dropdown footer action.

The picker appears only on `/playground`, inside `SiteHeader`, labeled `Theme:`. The trigger opens a dropdown of bundled and installed themes. The dropdown footer is always `Install theme from OpenVSX`, which opens the theme store dialog. Installed theme rows include an `X` delete control; deletion requires browser confirmation before removing the theme from localStorage. If the active installed theme is deleted, the picker falls back to the first bundled theme and applies it immediately.

Each theme is defined as a map of `--vscode-*` CSS variable overrides. `applyTheme()` applies the active theme, which:
1. Cascades into `--color-*` variables (via `var(--vscode-*, fallback)` in `theme.css`)
2. Triggers the `MutationObserver` in `lib/src/lib/terminal-theme.ts` to re-read `getTerminalTheme()` for all xterm.js terminals
3. Updates Dockview/Tailwind token colors

The picker restores the persisted active theme on mount. The playground header is `themeAware`, so the same active theme also affects the site header chrome while the picker remains hidden on non-playground routes.

## Technical Notes

- All progress keyed as `mouseterm-tutorial-step-N` in localStorage (values: `'true'`).
- `FakePtyAdapter` extensions: `setInputHandler(id, fn)` routes `writePty` calls to a custom handler; `sendOutput(id, data)` writes to a terminal's output stream.
- `PlaygroundShellRegistry` creates one `TutorialShell` per pane id, clears input handlers on disposal, and starts `AsciiSplashRunner` against the pane that launched it.
- `FakePtyAdapter` also tracks fake PTY dimensions from `spawnPty()` / `resizePty()`, exposes `getPtySize(id)`, and provides `onPtyResize(fn)` for browser-side fake programs such as `AsciiSplashRunner`.
- `Wall` extensions: `initialPaneIds` prop seeds the first pane(s); `onApiReady` callback prop exposes `DockviewApi`; `onEvent` callback prop fires `WallEvent` for mode/zoom/minimize/selection/split changes (types: `modeChange`, `zoomChange`, `minimizeChange`, `split`, `selectionChange`).
- `SCENARIO_TUTORIAL_MOTD` scenario added to `lib/src/lib/platform/fake-scenarios.ts`.

## Mouse and Clipboard Feature Coverage

The Playground is the primary dogfood surface for the features in `docs/specs/mouse-and-clipboard.md`. The initial three-pane layout (tutorial MOTD, `npm install`, `ls -la`) still has limited coverage, but the main pane can now launch `ascii-splash`, which exercises mouse reporting and animated redraw behavior.

### Current state

Legend: ✅ exercisable today, ⚠️ partial, ❌ not exercisable.

| Spec § | Feature | Status | Why |
|---|---|---|---|
| §1 | Mouse icon visible when program requests reporting | ✅ | Run `ascii-splash`; the runner emits `\x1b[?1000h` / `?1002h` / `?1003h` / `?1006h` unless `--no-mouse` is used. |
| §2 | Temporary/permanent override, banner, Make-permanent / Cancel | ✅ | Run `ascii-splash`, then use the header mouse icon while the animation is active. |
| §3.1–§3.3 | Drag, Alt-block shape, "Hold Alt" hint | ✅ | Works on any visible text. |
| §3.3 | "Press e to select the full URL/path" hint | ❌ | No qualifying tokens; bare filenames like `package.json` don't match the patterns in `lib/src/lib/smart-token.ts`. |
| §3.4 | Pure-scroll follows, cancel-on-change, cancel-on-resize | ⚠️ | `ascii-splash` makes cancel-on-change and resize cancel observable; scenarios are still too short for pure-scroll coverage. |
| §3.5 | Scrollback-origin / cross-boundary drags | ⚠️ | Scrollback is too short to exercise. |
| §3.6 | Keyboard routing during drag | ✅ | `ascii-splash` reacts to keys and mouse; with override active, drag-time keyboard consumption is observable. |
| §3.7 | Popup on mouse-up, new-drag-replaces | ✅ | Any selection. |
| §4.1.1 | Copy Raw | ✅ | Any selection. |
| §4.1.2 | Copy Rewrapped (box-strip + paragraph unwrap) | ❌ | No box-drawing characters anywhere; no multi-line prose. Rewrapped output is identical to Raw. |
| §4.2 | Cmd+C / Cmd+Shift+C | ✅ | Any selection. |
| §4.3 | Esc / click-outside dismiss | ✅ | Any selection popup. |
| §5 | Smart-extension (URL / abs path / rel path / Windows path / error location) | ❌ | No matching tokens in the scenarios. |
| §5.3 | Press `e` to extend | ❌ | Blocked on §5 coverage. |
| §8.2 | Cmd+V / Cmd+Shift+V / Ctrl+V / Ctrl+Shift+V paste | ⚠️ | The shortcut fires and writes to the fake PTY, but `TutorialShell.handleInput` (`website/src/lib/tutorial-shell.ts:77-96`) echoes characters one by one and does not interpret bracketed-paste markers. |
| §8.5 | Bracketed paste wraps `\e[200~ … \e[201~` | ❌ | No scenario emits `\x1b[?2004h`, so `getMouseSelectionState(id).bracketedPaste` stays `false` and `doPaste` sends the raw text. |

`§3.6` auto-scroll and `§8.7` right-click paste are deferred in the implementation itself — not Playground gaps.

### Remediation plan

Add three new scenarios in `lib/src/lib/platform/fake-scenarios.ts` and expand the Playground layout in `website/src/pages/Playground.tsx` to surface them alongside the existing tutorial pane. Together with `ascii-splash`, these close the remaining content-shape gaps.

1. **`SCENARIO_BRACKETED_PASTE_TUI`** — closes §8.5.
   Emits `\x1b[?2004h` and then draws an idle ANSI-framed view. A minimal input handler for this pane discards input. With this pane present, pastes into it are wrapped in `\x1b[200~ … \x1b[201~`.

2. **`SCENARIO_SMART_TOKENS`** — closes §3.3 extension hint, §5.1–§5.3.
   Prints one of each detectable shape so every branch in `lib/src/lib/smart-token.ts`'s `PATTERNS` list has a live example:

   ```
   ✗ src/components/wall/TerminalPaneHeader.tsx:157:7 — unused import
   ✗ ../sibling/util.rs:42 — panic here
     see https://en.wikipedia.org/wiki/Foo_(bar)
     docs: /usr/local/share/doc/mouseterm/README
     cwd: ~/projects/mouseterm
     windows: C:\Users\me\work.log
   ```

   Dragging across any of them shows "Press e to select the full URL/path" and `e` extends.

3. **`SCENARIO_BOXED_OUTPUT`** — closes §4.1.2.
   A short release-notes-shaped message framed in `┌─│└` so Copy Rewrapped (via `lib/src/lib/rewrap.ts`) strips the frame and joins the wrapped lines — clipboard contents visibly differ from Copy Raw. A slowly-updating ticker line at the bottom gives cancel-on-change something concrete to react to.

**Playground layout:** keep `PANE_MAIN` as the tutorial entry; replace `PANE_NPM` / `PANE_LS` with `PANE_BRACKETED` / `PANE_TOKENS` / `PANE_BOXED` (three `api.addPanel` calls in `handleApiReady`, same pattern as the existing ones at `website/src/pages/Playground.tsx:62-75`). A 2×2 grid fits on load.

**Optional:** teach `TutorialShell.handleInput` to recognize `\x1b[200~ … \x1b[201~` and print `[pasted: …]` so bracketed-paste wrapping is visually distinct for users who paste into `PANE_MAIN`.
