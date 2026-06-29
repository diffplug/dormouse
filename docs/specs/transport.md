# Transport and PTY Protocol Spec

> Adapter-agnostic protocol shared by all `PlatformAdapter` implementations — the VS Code extension (`docs/specs/vscode.md`), the standalone Tauri sidecar, and the `fake-adapter.ts` used for tests and the website playground. Covers PTY lifecycle, buffering, the webview ↔ platform message protocol, persisted-session types, and the invariants every adapter must honor. See `docs/specs/glossary.md` for the Process / Link state vocabulary, `docs/specs/alert.md` for `AlertManager` semantics, and `docs/specs/terminal-state.md` for the semantic events delivered over this transport.

## Adapter model

Each platform adapter wraps a PTY-spawning runtime and a transport channel between webview and host process. The webview is a thin view layer; PTYs and `AlertManager` live on the platform side. The frontend `lib/src/lib/platform/` module exposes a `PlatformAdapter` interface that all adapters implement.

| Adapter | Host runtime | Transport |
|---|---|---|
| VS Code extension | extension host (Node.js) | `vscode.Webview.postMessage` ↔ `acquireVsCodeApi().postMessage` |
| Standalone (Tauri) | sidecar process | Tauri command/event bridge |
| Standalone browser-dev | sidecar process + local dev HTTP bridge | fetch commands + Server-Sent Events |
| Fake (tests, playground) | in-process | direct function calls / event emitter |

### Standalone browser-dev harness

Source of truth: `standalone/scripts/dev-agent-browser.mjs`, `standalone/src/browser-sidecar-host.ts`, and `standalone/src/browser-sidecar-adapter.ts`.

`pnpm dev:standalone:ab` starts the standalone sidecar directly, starts a localhost-only HTTP bridge, starts Vite with `VITE_DORMOUSE_BROWSER_DEV_HOST`, and opens the app URL in an `agent-browser` session. The browser build uses `BrowserSidecarAdapter` instead of `TauriAdapter` when that env var is present.

The browser-dev bridge is intentionally a transport shim over the same sidecar protocol, not a second PTY implementation:

- Webview → host fire-and-forget commands use `POST /__dormouse_dev_host/send`.
- Webview → host request/response commands use `POST /__dormouse_dev_host/invoke`.
- Host → webview events use `GET /__dormouse_dev_host/events` as an SSE stream.
- Browser console calls are mirrored to `POST /__dormouse_dev_host/console` so a single `pnpm dev:standalone:ab` terminal shows sidecar logs, Vite logs, and in-browser diagnostics.

The harness may omit native-only desktop chrome such as window controls and update checks, but it must preserve the `PlatformAdapter` PTY, control-request, clipboard, iframe-proxy, and agent-browser contracts used by the app. Tauri APIs must not be required at static module-evaluation time when `VITE_DORMOUSE_BROWSER_DEV_HOST` is set, because the page is loaded by a normal browser rather than the Tauri WebView.

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

Source of truth:

| Scope | Source |
| --- | --- |
| Message schema | `vscode-ext/src/message-types.ts` (`WebviewMessage`, `ExtensionMessage`; other adapters import or mirror it) |
| Persisted-session types | `lib/src/lib/session-types.ts` (shared webview/host boundary types) |
| Webview handlers | Adapter modules such as `vscode-adapter.ts` and `fake-adapter.ts` |
| Host handlers | The per-adapter message router |

Non-obvious message contracts:

VS Code-only workbench chord mirroring uses `dormouse:runWorkbenchCommand` from webview to host. The host validates the requested command against the allowlist in `lib/src/lib/vscode-keybindings.ts` (see [the VS Code host spec](vscode.md)) before calling `vscode.commands.executeCommand`; generic command execution over the webview boundary is not allowed.

Workspace union status (`docs/specs/alert.md`) adds no new message. Standalone computes it in-webview — the app bar's workspace strip and the Walls share one webview, so the strip reads the activity store and browser-surface state directly. VS Code computes only the host-visible native-chrome projection from the module-level `AlertManager` filtered to each router's `ownedPtyIds`, then writes it onto native chrome; the host already receives every PTY's alert state, but it does not receive browser-surface TODO without a future webview→host Surface-state message (`docs/specs/vscode.md`).

| Direction | Message | Source type | Contract |
| --- | --- | --- | --- |
| Webview → host | `dormouse:openExternal` | `WebviewMessage` | Request the host to open a user-confirmed external URI from an OSC 8 hyperlink. Hosts must revalidate and reject malformed, control-character-bearing, or blocked pseudo-scheme targets (`javascript:`, `data:`, `blob:`, `about:`). |
| Webview → host | `pty:getOpenPorts` | `WebviewMessage` | Request the TCP listening ports opened by a PTY's shell process **and all of its descendant subprocesses**. The host resolves them from the PTY's root pid and replies with `pty:openPorts`. Source of truth: `getOpenPortsForPid()` in `standalone/sidecar/pty-core.js` (the VS Code extension loads it through the `lib/pty-core.cjs` shim). |
| Host → webview | `pty:openPorts` | `ExtensionMessage` | Reply to `pty:getOpenPorts`: `ports: OpenPort[]` (`{ protocol, family, address, port, pid, processName }`), de-duplicated by `(family, address, port)` and sorted by port. Empty array when the PTY is gone or enumeration fails. |
| Host → webview | `pty:data` | `ExtensionMessage` | PTY output after state-driving supported OSC sequences have been parsed/stripped; `OSC 8` hyperlinks are preserved for xterm.js and routed only to the owning router. |
| Host → webview | `pty:replay` | `ExtensionMessage` | Buffered raw output since spawn; the webview parses semantic OSCs during replay reconstruction without triggering alerts. |
| Host → webview | `dormouse:newTerminal` | `ExtensionMessage` | Payload may include `shell`, `args`, display `name`, `replaceUntouched`, and `announce`; the webview replaces the selected untouched terminal in-place only when `replaceUntouched` is true, otherwise it spawns a new pane. |

The OSC parsing/stripping rules that produce `pty:data` and `terminal:semanticEvents` are specified in `docs/specs/terminal-escapes.md`.

## Persisted session types

Source of truth: `lib/src/lib/session-types.ts` defines the persisted-session interfaces (`PersistedSession`, `PersistedPane`, `PersistedAlertState`, `PersistedDoor`, `PersistedWorkspace`, `PersistedWindow`) and their migrations.

A **Workspace** persists as a `PersistedWorkspace`: a `WorkspaceId`, a user-facing `name`, and the Workspace's `PersistedSession` (its panes, doors, and dockview layout). The standalone Window persists as a `PersistedWindow`: the ordered list of `PersistedWorkspace` plus the active `WorkspaceId`. VS Code does not use `PersistedWindow`; each webview persists exactly one `PersistedSession` — its single Workspace — through the same per-surface state API as today (`workspaceState` for the view, `vscode.setState()` per editor panel; see `docs/specs/vscode.md`).

**Surface kinds in the snapshot.** Each `PersistedPane` carries a `surfaceType` (`docs/specs/glossary.md`): `'terminal'` by default, or `'browser'` with its render params (`renderMode`, `url`, the agent-browser `session`) for a browser Surface. This lets a Surface restore as the right kind. Without it, `restoreSession` cannot tell a browser pane from a terminal and calls `restoreTerminal(pane.id)` for every saved pane — spawning a stray PTY + xterm for each browser pane id (`session-restore.ts`) — and a `resume` over live PTYs drops visible browser panes, because the saved `layout`'s panel set no longer matches the PTY-only pane set and is discarded (`reconnect.ts`). Recording the kind closes both: terminal panes resume/restore from their PTY + scrollback as today; browser Surfaces rebuild from their persisted params alone and never mint a PTY. *(Carrying `surfaceType` on `PersistedPane` is the agreed target shape; today a browser pane's real params survive only in the dockview `layout` blob and `PersistedDoor.params`, while its `PersistedPane` row is an empty husk.)*

Versioning and migration: introducing the Window container advances the standalone top-level snapshot version. A pre-workspace `PersistedSession` (v3) migrates to a single `PersistedWorkspace` named `Workspace 1`, marked active, inside a `PersistedWindow`. The standalone reader applies this migration; a host that hands back a bare `PersistedSession` (VS Code, or legacy standalone storage) is read as one Workspace. Migrations stay additive — older shapes keep flowing v1→v2→v3→(window) without losing panes, doors, alert state, or surface kind (a pane lacking `surfaceType` reads as `'terminal'`).

Every saved-session entry point must pass through `readPersistedSession()`. That reader accepts both the canonical parsed object and a JSON-stringified session blob before validating/migrating; this covers host state APIs that may hand back the inner serialized JSON string.

## Universal invariants

These rules apply to every adapter. Adapter-specific layering (deactivate ordering, save APIs, panel retention) lives in the adapter spec, e.g. `docs/specs/vscode.md`.

- **Shell login args are shell-specific.** The shared `pty-core.js` launches POSIX shells with `-l` only for shells that accept it. `csh`/`tcsh` must be spawned without `-l` so users whose login shell is C-shell-derived can open a usable terminal in any adapter.
- **Scrollback trailing newline.** Restored scrollback must end with `\n` to avoid zsh printing a `%` artifact at the top of the terminal.
- **Replay drops terminal replies only.** While saved output is being replayed into xterm.js, terminal-generated OSC/CSI/DCS query and focus reports are dropped so they do not enter the resumed/restored shell's input buffer. The replay filter must preserve user keyboard escape sequences, including arrows, function keys, and bracketed paste.
- **Untouched defaults conservatively.** New saved panes include `untouched`. Older saved panes without the field are read as `untouched: false`, so legacy sessions still require kill confirmation.
- **PTY ownership.** Each message router tracks the PTY ids it owns. A PTY routed to one webview must not be stolen by another router; new routers attaching to a host must respect existing ownership.
- **Replay filtering does not re-fire alerts.** `pty:replay` re-injects buffered output into xterm.js but must not re-trigger `AlertManager`, activity-monitor events, or protocol notifications.
