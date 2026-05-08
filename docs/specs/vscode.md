# MouseTerm VS Code Integration Spec

## What's built

MouseTerm has two hosting modes: a `WebviewView` in the bottom panel (alongside Terminal, Problems, Output) and `WebviewPanel` editor tabs (via `mouseterm.open`, supports multiple instances). Both restore across "Developer: Reload Window". PTY lifecycle is fully decoupled from the webview — PTYs live in the extension host via `pty-manager.ts`, survive panel visibility toggling, and replay buffered output on **resume**. Session persistence works across cold **restore**: pane layout, CWD, scrollback, alert state (enabled/disabled + todo), and resume commands are saved and restored on cold start. The view uses `workspaceState` for persistence; editor panels use VS Code's per-panel `vscode.setState()` so multiple panels don't clobber each other. Alert state is merged into every periodic save (not just deactivate) so it survives even if VS Code kills the extension host before deactivate completes. A `WebviewPanelSerializer` handles editor tab restoration; `onWebviewPanel:mouseterm` activation event ensures the extension activates early enough. Theme integration uses VSCode `--vscode-*` tokens plus MouseTerm semantic `--color-*` tokens, with a small resolver that materializes missing consumed VSCode colors from registry defaults. CSP is strict with nonce-gated scripts.

**Architecture:**

```
Extension Host (vscode-ext/src/)
├── extension.ts              — entry point, activate/deactivate, panel setup
├── webview-view-provider.ts  — WebviewView in bottom panel
├── message-router.ts         — webview <-> host IPC, PTY ownership tracking
├── message-types.ts          — bidirectional message type definitions
├── pty-manager.ts            — PTY lifecycle, buffering (1M char cap), CWD queries
├── pty-host.js               — forked child process wrapping pty-core via node-pty
├── session-state.ts          — workspaceState persistence + alert state merging
├── webview-html.ts           — CSP injection, nonce generation, asset URI rewriting
└── log.ts                    — extension logging

Shared PTY Core (standalone/sidecar/)
└── pty-core.js               — node-pty wrapper shared between VS Code and Tauri sidecar

Frontend Library (lib/src/)
├── App.tsx                       — error boundary wrapper
├── main.tsx                      — entry point
├── cfg.ts                        — timing config (marching ants, alert thresholds)
├── theme.css                     — --vscode-* -> semantic --color-* tokens
├── index.css                     — dockview overrides, marching-ants keyframe
├── components/
│   ├── Wall.tsx                  — pane manager shell, mode state, session actions
│   ├── wall/                     — Wall header/panel/overlay/context helpers
│   ├── TerminalPane.tsx          — xterm.js mount point with ResizeObserver
│   ├── Baseboard.tsx             — minimized-pane door carousel
│   └── Door.tsx                  — individual minimized-pane door
└── lib/
    ├── terminal-registry.ts      — public registry facade
    ├── terminal-store.ts         — registry maps and terminal entry shape
    ├── terminal-lifecycle.ts     — xterm lifecycle, PTY wiring, mount/dispose/swap/focus
    ├── terminal-theme.ts         — xterm theme observer and host painting
    ├── terminal-report-filter.ts — replay/synthetic report filtering
    ├── terminal-state.ts       — terminal CWD/command semantic model and derivation helpers
    ├── terminal-state-store.ts — frontend semantic state store keyed by pane/session id
    ├── terminal-mouse-router.ts  — mouse selection routing
    ├── session-activity-store.ts — alert/TODO projection and delegates
    ├── reconnect.ts              — resume (live-PTY) + restore (cold-start) entry point
    ├── alert-manager.ts          — alert state machine (portable, no DOM deps)
    ├── activity-monitor.ts       — silence/output pattern detection for alert
    ├── session-save.ts           — periodic save (debounced 500ms + 30s interval)
    ├── session-restore.ts        — cold-start pane restoration
    ├── session-types.ts          — PersistedSession/PersistedPane/PersistedAlertState types
    ├── resume-patterns.ts        — detect resumable commands from scrollback
    ├── spatial-nav.ts            — arrow-key panel navigation + restore neighbor lookup
    ├── layout-snapshot.ts        — dockview layout cloning + structure signature
    └── platform/
        ├── types.ts              — PlatformAdapter interface
        ├── index.ts              — adapter factory (auto-detects VS Code vs fake)
        ├── vscode-adapter.ts     — VS Code postMessage bridge
        └── fake-adapter.ts       — mock adapter for testing + website playground
```

### Invariants

- **Save before kill.** Deactivate must save session state *before* killing PTYs. CWD and scrollback queries need live processes. See ordering in `extension.ts:deactivate()`.
- **Alert state is global.** A single `AlertManager` instance in `message-router.ts` is shared across all routers and survives router disposal. PTY data feeds into it at module level, regardless of webview visibility.
- **PTY ownership.** Each router tracks its PTYs in `ownedPtyIds`. A module-level `globalOwnedPtyIds` set prevents a resuming router from stealing PTYs owned by another webview.
- **Shell login args are shell-specific.** The shared `pty-core.js` launches POSIX shells with `-l` only for shells that accept it. `csh`/`tcsh` must be spawned without `-l` so both the standalone app and VS Code extension can open a usable terminal for users whose login shell is C shell-derived.
- **mergeAlertStates on every save path.** Both the frontend periodic save (`onSaveState` callback) and the backend deactivate refresh (`refreshSavedSessionStateFromPtys`) must merge current alert states. Missing this causes alert state to revert on restore.
- **Scrollback trailing newline.** Restored scrollback must end with `\n` to avoid zsh printing a `%` artifact at the top of the terminal.
- **Replay drops terminal replies only.** While saved output is being replayed into xterm.js, terminal-generated OSC/CSI/DCS query and focus reports are dropped so they do not enter the resumed/restored shell's input buffer. The replay filter must preserve user keyboard escape sequences, including arrows, function keys, and bracketed paste.
- **retainContextWhenHidden.** Set on both `WebviewPanel` (editor tabs) and `WebviewView` (bottom panel) so that xterm.js DOM, scrollback, and PTY subscriptions survive panel hide/show without going through a resume.
- **Two save sources.** Session state is saved from two places: the frontend (debounced 500ms + 30s interval via `mouseterm:saveState`) and the backend (deactivate flushes webviews then refreshes from live PTYs). Both paths must produce consistent state.

### Extension manifest (current)

```jsonc
{
  "activationEvents": [
    "onView:mouseterm.view",
    "onWebviewPanel:mouseterm"
  ],
  "contributes": {
    "commands": [
      { "command": "mouseterm.focus", "title": "MouseTerm: Focus",
        "icon": { "light": "icon-tiny-light.png", "dark": "icon-tiny-dark.png" } },
      { "command": "mouseterm.open", "title": "MouseTerm: Open in Editor" },
      { "command": "mouseterm.debugTheme", "title": "MouseTerm: Debug Theme" }
    ],
    "viewsContainers": {
      "panel": [
        { "id": "mouseterm-panel", "title": "MouseTerm", "icon": "$(terminal)" }
      ]
    },
    "views": {
      "mouseterm-panel": [
        { "id": "mouseterm.view", "name": "MouseTerm", "type": "webview" }
      ]
    }
  }
}
```

### PTY lifecycle (decoupled from webview)

PTYs are managed by the extension host, not by the webview. The webview is a view layer that **resumes** over live PTYs (host-preserved) or **restores** from a Snapshot (cold start). See `ontology.md` for the Process / Link states.

```
Extension Host (always running while extension is active)
├── pty-manager.ts (forks pty-host.js child process)
│   ├── pty-1 (Process: Live)
│   ├── pty-2 (Process: Live)
│   └── pty-3 (Process: Exited)
│
├── WebviewView "MouseTerm" (bottom panel)
│   └── message-router: owns pty-1, pty-2
│
└── WebviewPanel "MouseTerm" (editor tab, optional)
    └── message-router: owns pty-3
```

This means:
- Hiding the MouseTerm panel doesn't kill its PTYs.
- VS Code toggling the panel visibility doesn't destroy sessions.
- When the view becomes visible again, the webview **resumes** over still-owned PTYs and reapplies the saved visible-pane layout when the saved session covers the live PTY set and the layout's visible panels match.
- Each message router tracks which PTYs it owns; PTYs cannot be stolen by another router.
- Explicitly killed PTYs are **tombstoned** in the extension host (`Process: Tombstoned`) so a late child-process `exit` event cannot recreate their buffer and make them resumable.
- Multiple VS Code windows each get their own extension host process, and therefore their own pty-host child process.

#### PTY buffering

`pty-manager.ts` maintains two buffer types per PTY:

- **replayChunks**: cleared on first consume, used for resume (webview hidden then shown)
- **scrollbackChunks**: never cleared, used for repeat resumes and session save

Both are capped at 1M chars per PTY. When the cap is reached, oldest chunks are trimmed.

#### Reconnection protocol

```
1. Webview becomes visible (or panel deserializes)
2. Webview sends: { type: 'mouseterm:init' }
3. Extension responds with:
   - { type: 'pty:list', ptys: [{ id, alive, exitCode }] }   // all owned PTYs
   - { type: 'pty:replay', id, data }                         // buffered output per PTY
4. Webview restores terminals from replay data, resumes live stream
5. If the saved session covers those live PTYs, the frontend uses the saved dockview layout when its visible panels match and reattaches saved minimized doors; minimized PTYs are registered but remain doors instead of visible panes
```

For cold restore (no live PTYs), the webview falls back to saved session state: spawns new PTYs in saved CWDs using the currently selected MouseTerm shell, injects saved scrollback (with trailing newline to avoid zsh `%` artifact), and restores dockview layout. The entry module (`reconnect.ts`) uses a 500ms timeout when waiting for the PTY list.

### Message protocol

All types defined in `message-types.ts`. Webview-side handling in `vscode-adapter.ts`; host-side handling in `message-router.ts`.

**Webview -> Extension Host:**

| Message | Purpose |
|---------|---------|
| `pty:spawn` | Create new PTY (id, optional cols/rows/cwd/shell/args) |
| `pty:input` | Write data to PTY |
| `pty:resize` | Resize PTY dimensions |
| `pty:kill` | Kill PTY and release ownership |
| `pty:getCwd` | Query PTY working directory (request-response via requestId) |
| `pty:getScrollback` | Query PTY scrollback buffer (request-response via requestId) |
| `pty:getShells` | Query available shells (request-response via requestId) |
| `mouseterm:init` | Trigger resume: get PTY list + replay data |
| `mouseterm:saveState` | Frontend persisting session state |
| `mouseterm:flushSessionSaveDone` | Ack for deactivate-triggered flush (matched by requestId) |
| `alert:toggle` | Toggle alert enabled/disabled for a PTY |
| `alert:disable` | Disable alert for a PTY |
| `alert:dismiss` | Dismiss ringing alert |
| `alert:dismissOrToggle` | Context-dependent: dismiss if ringing, else toggle |
| `alert:attend` | Mark user as attending to a PTY |
| `alert:remove` | Remove alert state entirely |
| `alert:resize` | Notify alert of terminal resize (debounce noise) |
| `alert:clearAttention` | Clear attention timer |
| `alert:toggleTodo` | Toggle TODO (false <-> hard) |
| `alert:markTodo` | Set hard TODO |
| `alert:clearTodo` | Remove TODO |

**Extension Host -> Webview:**

| Message | Purpose |
|---------|---------|
| `pty:data` | PTY output after supported OSC sequences have been parsed/stripped (routed only to owning router) |
| `pty:exit` | PTY process exited (with exitCode) |
| `terminal:semanticEvents` | Normalized CWD/title/prompt/command events parsed in the extension host from live PTY data |
| `pty:list` | List of all resumable PTYs (response to `mouseterm:init`) |
| `pty:replay` | Buffered raw output since spawn (response to `mouseterm:init`); the webview parses semantic OSCs during replay reconstruction without triggering alerts |
| `pty:cwd` | CWD query response (matched by requestId) |
| `pty:scrollback` | Scrollback query response (matched by requestId) |
| `pty:shells` | Available shells list response (matched by requestId) |
| `mouseterm:flushSessionSave` | Request webview to save state now (deactivate trigger, matched by requestId) |
| `mouseterm:openThemeDebugger` | Command-triggered request to open the shared theme debugger dialog |
| `alert:state` | Alert state change (projected status, todo, notification, attentionDismissedRing) |

### Serialization and restore

`WebviewPanelSerializer` is registered so VS Code can restore editor panels after restart:

```
activationEvents: ["onWebviewPanel:mouseterm"]
```

**Session structure** (from `session-types.ts`):

```typescript
interface PersistedSession {
  version: 3;
  panes: PersistedPane[];
  doors?: PersistedDoor[];
  layout: unknown; // SerializedDockview
}

interface PersistedPane {
  id: string;
  cwd: string | null;
  title: string;
  scrollback: string | null;
  resumeCommand: string | null;
  alert?: PersistedAlertState | null;
}

interface PersistedAlertState {
  status: SessionStatus;
  todo: boolean;
  notification?: ActivityNotification | null;
}

interface PersistedDoor {
  id: string;
  title: string;
  neighborId: string | null;
  direction: DoorDirection;
  remainingPaneIds: string[];
  layoutAtMinimize: unknown;
  layoutAtMinimizeSignature: string;
}
```

**Persistence flow:**

1. Frontend saves state periodically (debounced 500ms + 30s interval) via `mouseterm:saveState` message
2. Router's `onSaveState` callback merges in current alert states via `mergeAlertStates()`
3. WebviewView writes to `workspaceState`; WebviewPanels persist via `vscode.setState()` (per-panel, no clobbering)
4. On deactivate: flush all sessions from webviews (1s timeout), then refresh from live PTYs (queries CWD + scrollback while processes are still alive)
5. Graceful shutdown: save state -> SIGTERM -> 2s wait -> force kill
6. On activate: saved state loaded and passed to routers for cold-start restore

Every saved-session entry point must pass through `readPersistedSession()`. That reader accepts both the canonical parsed object and a JSON-stringified session blob before validating/migrating, which covers VS Code state APIs that may hand back the inner serialized JSON string.

### Theme integration

Two-layer CSS variable system: VS Code injects `--vscode-*` tokens; `lib/src/theme.css` maps them directly to semantic `--color-*` tokens for use in Tailwind utility classes. The webview entry point installs `installVscodeThemeVarResolver()` before React renders. That resolver reads VSCode-provided variables, materializes only missing MouseTerm-consumed variables on `body.style`, and watches `body`/`html` class and style mutations so theme changes recompute those materialized values.

Example of the pattern:
```css
/* theme.css: direct semantic binding */
--color-app-bg: var(--vscode-sideBar-background);
--color-app-fg: var(--vscode-sideBar-foreground);
--color-header-inactive-fg: var(--vscode-list-inactiveSelectionForeground);
```

`theme.css` intentionally has no hardcoded color defaults or CSS variable fallback chains. The resolver duplicates VSCode registry defaults for the MouseTerm-consumed color IDs, including `null` default behavior where MouseTerm needs a concrete CSS variable. In particular, `list.inactiveSelectionForeground` resolves to normal foreground inheritance, not `list.activeSelectionForeground`; this matches VSCode's list/tree selected-row behavior for built-in Light.

A `MutationObserver` in `lib/src/lib/terminal-theme.ts` watches for VS Code theme changes on `body`/`html` (class and style attribute mutations) and live-updates all xterm.js instances. The `terminal-registry.ts` facade still exposes the public lifecycle APIs. The theme resolver has its own observer on the same attributes so derived `--vscode-*` variables stay in sync before xterm rereads the terminal palette.

`mouseterm.debugTheme` focuses the MouseTerm WebviewView and posts
`mouseterm:openThemeDebugger` to the webview. `VSCodeAdapter` converts that
message into the browser event consumed by the shared Theme Debugger. The
debugger traces VSCode-exposed `--vscode-*` variables and MouseTerm
materialized fallbacks, but it does not attempt to read raw built-in VSCode
theme files.

### CSP policy

```
default-src 'none';
style-src ${webview.cspSource} 'unsafe-inline';
script-src 'nonce-${nonce}';
font-src ${webview.cspSource};
img-src ${webview.cspSource} data: blob:;
connect-src ${webview.cspSource};
```

`unsafe-inline` for styles is needed because VS Code injects theme CSS variables via inline styles on the body element. Scripts remain nonce-gated (32-char random alphanumeric nonce). The webview HTML is built by Vite from the `lib` package, then at runtime `webview-html.ts` rewrites asset URLs to webview URIs, injects the CSP meta tag, applies nonces to all script tags, and injects initial state via a nonce-gated inline script.

### Build and development

```
pnpm build:vscode =
  1. pnpm --filter mouseterm-lib build    (TypeScript compile)
  2. pnpm --filter mouseterm build:frontend (Vite: lib -> vscode-ext/media/)
  3. pnpm --filter mouseterm build          (esbuild: extension.ts + pty-host.js -> dist/,
                                             copy node-pty prebuilds -> dist/node-pty)

pnpm dogfood:vscode = build + package VSIX + install locally
  (then: Cmd+Shift+P -> "Developer: Reload Window" to pick up changes)

F5 in VS Code = launch Extension Development Host (see .vscode/launch.json)
  (runs preLaunchTask "build-mouseterm-vscode" from .vscode/tasks.json,
   which just calls `pnpm build:vscode`, then opens a new VS Code window
   with the extension loaded)
```

**Dogfooding vs Extension Development Host:** Day-to-day development uses `pnpm dogfood:vscode` to install the extension into your real VS Code instance. This catches real-world issues since you're running with your actual settings, extensions, and workspaces. The F5 Extension Development Host workflow exists for when you need **breakpoint debugging** of extension host code (`extension.ts`, `message-router.ts`, `pty-manager.ts`, etc.) — it launches a separate VS Code window where the debugger can attach to the extension host process.

The Vite config for the extension (`vscode-ext/vite.config.ts`) sets `root: ../lib` and `outDir: ./media`, building the shared React frontend directly into the extension's media folder.

## Dream architecture

### Context keys

Set context keys so menus and extensions can target MouseTerm state:

```typescript
// Set when any MouseTerm webview has focus
vscode.commands.executeCommand('setContext', 'mouseterm.active', true);

// Set when MouseTerm is in passthrough/terminal mode (keys go to PTY)
vscode.commands.executeCommand('setContext', 'mouseterm.mode', 'terminal');

// Set when MouseTerm is in normal/navigation mode (keys go to MouseTerm UI)
vscode.commands.executeCommand('setContext', 'mouseterm.mode', 'normal');
```

### Commands

| Command | Description |
|---------|-------------|
| `mouseterm.focus` | Focus the MouseTerm panel view |
| `mouseterm.newPane` | Split a new pane in MouseTerm |
| `mouseterm.closePane` | Close the focused pane |
| `mouseterm.nextPane` | Focus next pane |
| `mouseterm.prevPane` | Focus previous pane |
| `mouseterm.enterTerminalMode` | Switch to passthrough mode |
| `mouseterm.enterNormalMode` | Switch to navigation mode |
| `mouseterm.listSessions` | Show QuickPick of all live PTY sessions |
| `mouseterm.reattach` | Reattach a minimized PTY to a pane |

### Not yet implemented

- `TerminalProfileProvider` not registered — MouseTerm doesn't appear in the terminal `+` dropdown
- Context keys not set (`mouseterm.active`, `mouseterm.mode`) — needed for conditional keybindings
- Commands not registered: `mouseterm.newPane`, `closePane`, `nextPane`, `prevPane`, `enterTerminalMode`, `enterNormalMode`, `listSessions`, `reattach`
- No status bar item showing active session count
- No QuickPick for listing/reattaching PTY sessions
