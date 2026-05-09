# MouseTerm VS Code Integration Spec

> See `docs/specs/transport.md` for the PTY lifecycle, message protocol, persisted-session types, and adapter-agnostic invariants that VS Code shares with the standalone and fake adapters. This spec covers the VS Code-specific layer: panel/view registration, persistence APIs, theme integration, CSP, build, and dream-architecture commands.

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

### Invariants (VS Code-specific)

Universal PTY/transport invariants live in `docs/specs/transport.md`. The rules below are specific to running inside the VS Code extension host.

- **Save before kill.** `deactivate()` must save session state *before* killing PTYs. CWD and scrollback queries need live processes. See ordering in `extension.ts:deactivate()`.
- **Alert state is global.** A single `AlertManager` instance in `message-router.ts` is shared across all routers and survives router disposal. PTY data feeds into it at module level, regardless of webview visibility.
- **PTY ownership tracking.** Each router tracks its PTYs in `ownedPtyIds`. A module-level `globalOwnedPtyIds` set prevents a resuming router from stealing PTYs owned by another webview.
- **mergeAlertStates on every save path.** Both the frontend periodic save (`onSaveState` callback) and the backend deactivate refresh (`refreshSavedSessionStateFromPtys`) must merge current alert states. Missing this causes alert state to revert on restore.
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

### Webview hosting

VS Code-specific layout of the transport model in `docs/specs/transport.md`:

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

VS Code-specific consequences:

- Hiding the MouseTerm panel doesn't kill its PTYs.
- VS Code toggling the panel visibility doesn't destroy sessions.
- Multiple VS Code windows each get their own extension host process, and therefore their own pty-host child process.

PTY lifecycle, buffering, the reconnection sequence, and the full message protocol live in `docs/specs/transport.md`.

### Serialization and restore

`WebviewPanelSerializer` is registered so VS Code can restore editor panels after restart:

```
activationEvents: ["onWebviewPanel:mouseterm"]
```

The persisted-session shape (`PersistedSession` / `PersistedPane` / `PersistedAlertState` / `PersistedDoor`) lives in `docs/specs/transport.md`; it is shared with the standalone and fake adapters.

**VS Code persistence flow:**

1. Frontend saves state periodically (debounced 500ms + 30s interval) via `mouseterm:saveState` message.
2. Router's `onSaveState` callback merges in current alert states via `mergeAlertStates()`.
3. WebviewView writes to `workspaceState`; WebviewPanels persist via `vscode.setState()` (per-panel, no clobbering).
4. On deactivate: flush all sessions from webviews (1s timeout), then refresh from live PTYs (queries CWD + scrollback while processes are still alive).
5. Graceful shutdown: save state → SIGTERM → 2s wait → force kill.
6. On activate: saved state loaded and passed to routers for cold-start restore via `readPersistedSession()` (defined in `docs/specs/transport.md`), which tolerates both parsed objects and JSON-stringified blobs returned by VS Code state APIs.

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
