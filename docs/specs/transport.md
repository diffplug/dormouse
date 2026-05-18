# Transport and PTY Protocol Spec

> Adapter-agnostic protocol shared by all `PlatformAdapter` implementations — the VS Code extension (`docs/specs/vscode.md`), the standalone Tauri sidecar, and the `fake-adapter.ts` used for tests and the website playground. Covers PTY lifecycle, buffering, the webview ↔ platform message protocol, persisted-session types, and the invariants every adapter must honor. See `docs/specs/glossary.md` for the Process / Link state vocabulary, `docs/specs/alert.md` for `AlertManager` semantics, and `docs/specs/terminal-state.md` for the semantic events delivered over this transport.

## Adapter model

Each platform adapter wraps a PTY-spawning runtime and a transport channel between webview and host process. The webview is a thin view layer; PTYs and `AlertManager` live on the platform side. The frontend `lib/src/lib/platform/` module exposes a `PlatformAdapter` interface that all adapters implement.

| Adapter | Host runtime | Transport |
|---|---|---|
| VS Code extension | extension host (Node.js) | `vscode.Webview.postMessage` ↔ `acquireVsCodeApi().postMessage` |
| Standalone (Tauri) | sidecar process | Tauri command/event bridge |
| Fake (tests, playground) | in-process | direct function calls / event emitter |

## PTY lifecycle

PTYs are managed by the platform host, not by the webview. The webview is a view layer that **resumes** over live PTYs (host-preserved) or **restores** from a Snapshot (cold start). See `docs/specs/glossary.md` for the Process / Link states.

```
Platform host (always running while the adapter is active)
├── pty-manager (forks pty-host child process)
│   ├── pty-1 (Process: Live)
│   ├── pty-2 (Process: Live)
│   └── pty-3 (Process: Exited)
│
├── Webview (e.g. VS Code WebviewView, standalone window)
│   └── message-router: owns pty-1, pty-2
│
└── Optional secondary webview (e.g. VS Code editor-tab WebviewPanel)
    └── message-router: owns pty-3
```

This means:

- Hiding a webview does not kill its PTYs.
- The webview becoming visible again resumes over still-owned PTYs and reapplies the saved visible-pane layout when the saved session covers the live PTY set and the layout's visible panels match.
- A PTY process that exits naturally can remain mounted as an exited pane; frontend semantic state such as CWD, title candidates, and last command is retained until the Session is actually disposed.
- Each message router tracks which PTYs it owns; PTYs cannot be stolen by another router.
- Explicitly killed PTYs are **tombstoned** in the host (`Process: Tombstoned`) so a late child-process `exit` event cannot recreate their buffer and make them resumable.
- Multiple host instances (e.g., multiple VS Code windows) each get their own pty-host child process.

### PTY buffering

`pty-manager` maintains two buffer types per PTY:

- **replayChunks**: cleared on first consume, used for resume (webview hidden then shown).
- **scrollbackChunks**: never cleared, used for repeat resumes and session save.

Both are capped at 1M chars per PTY. When the cap is reached, oldest chunks are trimmed.

### Reconnection protocol

```
1. Webview becomes visible (or panel deserializes).
2. Webview sends: { type: 'dormouse:init' }.
3. Host responds with:
   - { type: 'pty:list', ptys: [{ id, alive, exitCode }] }   // all owned PTYs
   - { type: 'pty:replay', id, data }                         // buffered output per PTY
4. Webview restores terminals from replay data, seeds saved pane and door titles back via `setTerminalUserTitle()` (which rejects titles starting with `<idle>`, the sentinel that prefixes the auto-generated finished-pane header). The seed callers in `terminal-lifecycle.ts` additionally skip `<unnamed>` so the default panel placeholder does not get seeded as a real user pin during cold-restore. (Persistence cannot distinguish a deliberate `<unnamed>` pin from the default placeholder, so a user who explicitly pinned `<unnamed>` will see it revert to the derived header on app reload.)
5. If the saved session covers those live PTYs, the frontend uses the saved dockview layout when its visible panels match and reattaches saved minimized doors; minimized PTYs are registered but remain doors instead of visible panes.
```

For cold restore (no live PTYs), the webview falls back to saved session state: spawns new PTYs in saved CWDs using the currently selected Dormouse shell, injects saved scrollback (with trailing newline to avoid the zsh `%` artifact), and restores dockview layout. The entry module (`reconnect.ts`) uses a 500ms timeout when waiting for the PTY list.

## Message protocol

Message types live in `vscode-ext/src/message-types.ts` (the canonical schema; other adapters import or mirror it). The persisted-session types in the next section live in `lib/src/lib/session-types.ts` because they cross the webview/host boundary and are also consumed by frontend persistence helpers. Webview-side handling lives in adapter modules (e.g., `vscode-adapter.ts`, `fake-adapter.ts`); host-side handling lives in the per-adapter message router.

**Webview → host:**

| Message | Purpose |
|---------|---------|
| `pty:spawn` | Create new PTY (id, optional cols/rows/cwd/shell/args) |
| `pty:input` | Write data to PTY |
| `pty:resize` | Resize PTY dimensions |
| `pty:kill` | Kill PTY and release ownership |
| `pty:getCwd` | Query PTY working directory (request-response via requestId) |
| `pty:getScrollback` | Query PTY scrollback buffer (request-response via requestId) |
| `pty:getShells` | Query available shells (request-response via requestId) |
| `dormouse:openExternal` | Request the host to open an already-sanitized external URI from an OSC 8 hyperlink. Hosts must revalidate and only allow `http:`, `https:`, and `mailto:`. |
| `dormouse:init` | Trigger resume: get PTY list + replay data |
| `dormouse:saveState` | Frontend persisting session state |
| `dormouse:flushSessionSaveDone` | Ack for host-triggered flush (matched by requestId) |
| `alert:toggle` | Toggle alert enabled/disabled for a PTY |
| `alert:disable` | Disable alert for a PTY |
| `alert:dismiss` | Dismiss ringing alert |
| `alert:dismissOrToggle` | Context-dependent: dismiss if ringing, else toggle |
| `alert:attend` | Mark user as attending to a PTY |
| `alert:remove` | Remove alert state entirely |
| `alert:resize` | Notify alert of terminal resize (debounce noise) |
| `alert:clearAttention` | Clear attention timer |
| `alert:toggleTodo` | Toggle TODO (`false` ↔ `true`) |
| `alert:markTodo` | Set TODO to `true` |
| `alert:clearTodo` | Remove TODO |

**Host → webview:**

| Message | Purpose |
|---------|---------|
| `pty:data` | PTY output after state-driving supported OSC sequences have been parsed/stripped; `OSC 8` hyperlinks are preserved for xterm.js (routed only to owning router) |
| `pty:exit` | PTY process exited (with exitCode) |
| `terminal:semanticEvents` | Normalized CWD/title/prompt/command events parsed in the host from live PTY data |
| `pty:list` | List of all resumable PTYs (response to `dormouse:init`) |
| `pty:replay` | Buffered raw output since spawn (response to `dormouse:init`); the webview parses semantic OSCs during replay reconstruction without triggering alerts |
| `pty:cwd` | CWD query response (matched by requestId) |
| `pty:scrollback` | Scrollback query response (matched by requestId) |
| `pty:shells` | Available shells list response (matched by requestId) |
| `dormouse:newTerminal` | Host/UI request to spawn a terminal. Payload may include `shell`, `args`, display `name`, `replaceUntouched`, and `announce`; the webview replaces the selected untouched terminal in-place only when `replaceUntouched` is true, otherwise it spawns a new pane. |
| `dormouse:selectedShell` | Update the webview's default shell options for later split/spawn/restore paths. |
| `dormouse:flushSessionSave` | Request webview to save state now (host shutdown trigger, matched by requestId) |
| `dormouse:openThemeDebugger` | Command-triggered request to open the shared theme debugger dialog |
| `alert:state` | Alert state change (projected status, watchingEnabled, todo, notification, attentionDismissedRing) |

The OSC parsing/stripping rules that produce `pty:data` and `terminal:semanticEvents` are specified in `docs/specs/terminal-escapes.md`.

## Persisted session types

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
  untouched: boolean;
  alert?: PersistedAlertState | null;
}

interface PersistedAlertState {
  status: SessionStatus;
  watchingEnabled?: boolean;
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

Every saved-session entry point must pass through `readPersistedSession()`. That reader accepts both the canonical parsed object and a JSON-stringified session blob before validating/migrating; this covers host state APIs that may hand back the inner serialized JSON string.

## Universal invariants

These rules apply to every adapter. Adapter-specific layering (deactivate ordering, save APIs, panel retention) lives in the adapter spec, e.g. `docs/specs/vscode.md`.

- **Shell login args are shell-specific.** The shared `pty-core.js` launches POSIX shells with `-l` only for shells that accept it. `csh`/`tcsh` must be spawned without `-l` so users whose login shell is C-shell-derived can open a usable terminal in any adapter.
- **Scrollback trailing newline.** Restored scrollback must end with `\n` to avoid zsh printing a `%` artifact at the top of the terminal.
- **Replay drops terminal replies only.** While saved output is being replayed into xterm.js, terminal-generated OSC/CSI/DCS query and focus reports are dropped so they do not enter the resumed/restored shell's input buffer. The replay filter must preserve user keyboard escape sequences, including arrows, function keys, and bracketed paste.
- **Untouched defaults conservatively.** New saved panes include `untouched`. Older saved panes without the field are read as `untouched: false`, so legacy sessions still require kill confirmation.
- **PTY ownership.** Each message router tracks the PTY ids it owns. A PTY routed to one webview must not be stolen by another router; new routers attaching to a host must respect existing ownership.
- **Replay filtering does not re-fire alerts.** `pty:replay` re-injects buffered output into xterm.js but must not re-trigger `AlertManager`, activity-monitor events, or protocol notifications.
