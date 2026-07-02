# Dormouse VS Code Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary. See `docs/specs/transport.md` for the PTY lifecycle, message protocol, persisted-session types, and adapter-agnostic invariants that VS Code shares with the standalone and fake adapters. This spec covers the VS Code-specific layer: panel/view registration, persistence APIs, theme integration, CSP, build, and dream-architecture commands.

## What's built

Dormouse has two hosting modes: a `WebviewView` in the bottom panel (alongside Terminal, Problems, Output) and `WebviewPanel` editor tabs (via `dormouse.open`, supports multiple instances). Both restore across "Developer: Reload Window". PTY lifecycle is fully decoupled from the webview — PTYs live in the extension host via `pty-manager.ts`, survive panel visibility toggling, and replay buffered output on **resume**. Session persistence works across cold **restore**: pane layout, CWD, scrollback, alert state (enabled/disabled + todo), and resume commands are saved and restored on cold start. The view uses `workspaceState` for persistence; editor panels use VS Code's per-panel `vscode.setState()` so multiple panels don't clobber each other. Alert state is merged into every periodic save (not just deactivate) so it survives even if VS Code kills the extension host before deactivate completes. A `WebviewPanelSerializer` handles editor tab restoration; `onWebviewPanel:dormouse` activation event ensures the extension activates early enough. Theme integration uses VSCode `--vscode-*` tokens plus Dormouse semantic `--color-*` tokens, with a small resolver that materializes missing consumed VSCode colors from registry defaults. CSP is strict with nonce-gated scripts.

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
- **Two save sources.** Session state is saved from two places: the frontend (debounced 500ms + 30s interval via `dormouse:saveState`) and the backend (deactivate flushes webviews then refreshes from live PTYs). Both paths must produce consistent state.
- **Workbench keybindings mirror for selected chords.** `lib/src/lib/vscode-keybindings.ts` is the source of truth for the VS Code-hosted mirror allowlist. For `Ctrl/Cmd+P`, `Ctrl/Cmd+Shift+P`, `Ctrl/Cmd+B`, and `F1`, xterm still processes the key while the webview also posts `dormouse:runWorkbenchCommand`; `message-router.ts` validates that request against the same small command set before calling `vscode.commands.executeCommand`.

### Extension manifest (current)

Source of truth: `vscode-ext/package.json` defines the activation events and `contributes` block (commands with titles/icons, menus, view container, webview view).

### Webview hosting

VS Code-specific layout of the transport model in `docs/specs/transport.md`:

```
Extension Host (always running while extension is active)
├── pty-manager.ts (forks pty-host.js child process)
│   ├── pty-1 (Process: Live)
│   ├── pty-2 (Process: Live)
│   └── pty-3 (Process: Exited)
│
├── WebviewView "Dormouse" (bottom panel)
│   └── message-router: owns pty-1, pty-2
│
└── WebviewPanel "Dormouse" (editor tab, optional)
    └── message-router: owns pty-3
```

VS Code-specific consequences:

- Hiding the Dormouse panel doesn't kill its PTYs.
- VS Code toggling the panel visibility doesn't destroy sessions.
- Multiple VS Code windows each get their own extension host process, and therefore their own pty-host child process.

PTY lifecycle, buffering, the reconnection sequence, and the full message protocol live in `docs/specs/transport.md`.

### Workspaces

> See `docs/specs/glossary.md` for the Workspace / Window containers and `docs/specs/alert.md` for the union status.
>
> **Not yet implemented (VS Code side).** The webview↔Workspace mapping is the conceptual frame; VS Code already partitions PTYs per webview. The union *projection* exists as a shared primitive (`computeWorkspaceUnion`, stage 2b), but VS Code does not yet feed it per webview or reflect the result onto native chrome (see the "Not yet implemented" bullet below). The stage-2b Window persistence container is standalone-only and does not touch VS Code, which keeps one bare `PersistedSession` per webview. Stage 2a (`surfaceType` persistence, browser-surface restore/resume) is implemented and adapter-agnostic.

In VS Code, **one webview is one Workspace**. The bottom-panel `WebviewView` ("Dormouse") is the default Workspace; each `dormouse.open` editor-tab `WebviewPanel` is an independent Workspace. Unlike standalone, several Workspaces are visible at once, and VS Code — not Dormouse — owns their tabs, creation, and closing: opening a Dormouse editor tab creates a Workspace and closing the tab closes it, so Dormouse adds no create/rename/close affordances here. A webview owns the terminal Sessions whose PTYs its router tracks (`ownedPtyIds`, `docs/specs/transport.md`) plus any browser surfaces rendered in it; together those are the Workspace's Surfaces.

#### Surfacing union status on native chrome

The host computes each Workspace's native-chrome attention projection (`ringing` / `todo` / `count`) from the module-level `AlertManager`, scoped to that webview's `ownedPtyIds`. That means VS Code native chrome reflects terminal Session ring + TODO only. Browser-surface TODO remains webview-local Surface state and is not included in `panel.iconPath`, `panel.title`, or `view.badge` unless a future webview→host Surface-state channel is added; the existing `alert:state` channel is keyed by PTY-backed Session ids only.

- **Editor tab (`WebviewPanel`):** reassign `panel.iconPath` between normal / ringing / TODO icon variants, and optionally fold the Workspace name or a status marker into `panel.title`. Both properties are writable after creation (`title: string`, `iconPath?: Uri | { light, dark }`).
- **Sidebar/panel view (`WebviewView`):** set `view.badge = { value: count, tooltip }` for a numeric attention badge on the activity-bar icon, visible even when the view is collapsed; `view.description` may carry status text. `view.title` is writable too but stays "Dormouse". `ViewBadge` is numeric only (no custom color or glyph), so the editor-tab icon swap carries the ringing-vs-TODO distinction the badge cannot.

Reflection updates on every `AlertManager.onStateChange` for an owned PTY and on router attach/detach (a Workspace gaining or losing Sessions). When a Workspace's union is clear, the badge is set to `undefined` and the icon returns to the normal variant. Icon artwork is settled in the Storybook/asset pass.

### Shell selection

The VS Code view title contributes `Dormouse: Select Shell` and `Dormouse: New Terminal`. The selected shell name is mirrored into the `WebviewView.description`, and `dormouse:selectedShell` keeps the webview's default-shell slot current for split/spawn/restore paths.

`dormouse.newTerminal` focuses the Dormouse view and posts `dormouse:newTerminal` with the currently selected shell. `dormouse.selectShell` opens a QuickPick, saves the shell path globally or per workspace, applies the description/default-shell update, and, when the picked shell differs from the previous selection, focuses the view and posts `dormouse:newTerminal` with `replaceUntouched: true` and `announce: true`. The shared `Wall` logic then replaces only a selected untouched terminal in-place; touched terminals cause an additional pane to be spawned instead.

### Serialization and restore

`WebviewPanelSerializer` is registered so VS Code can restore editor panels after restart:

```
activationEvents: ["onWebviewPanel:dormouse"]
```

The persisted-session shape (`PersistedSession` / `PersistedPane` / `PersistedAlertState` / `PersistedDoor`) lives in `docs/specs/transport.md`; it is shared with the standalone and fake adapters.

**VS Code persistence flow:**

1. Frontend saves state periodically (debounced 500ms + 30s interval) via `dormouse:saveState` message.
2. Router's `onSaveState` callback merges in current alert states via `mergeAlertStates()`.
3. WebviewView writes to `workspaceState`; WebviewPanels persist via `vscode.setState()` (per-panel, no clobbering).
4. On deactivate: flush all sessions from webviews (1s timeout), then refresh from live PTYs (queries CWD + scrollback while processes are still alive).
5. Graceful shutdown: save state → SIGTERM → 2s wait → force kill.
6. On activate: saved state loaded and passed to routers for cold-start restore via `readPersistedSession()` (defined in `docs/specs/transport.md`), which tolerates both parsed objects and JSON-stringified blobs returned by VS Code state APIs.

### Theme integration

Two-layer CSS variable system: VS Code injects `--vscode-*` tokens; `lib/src/theme.css` maps them directly to semantic `--color-*` tokens for use in Tailwind utility classes. The webview entry point installs `installVscodeThemeVarResolver()` before React renders. That resolver reads VSCode-provided variables, materializes only missing Dormouse-consumed variables on `body.style`, and watches `body`/`html` class and style mutations so theme changes recompute those materialized values.

Example of the pattern:
```css
/* theme.css: direct semantic binding */
--color-app-bg: var(--vscode-sideBar-background);
--color-app-fg: var(--vscode-sideBar-foreground);
--color-header-inactive-fg: var(--vscode-list-inactiveSelectionForeground);
```

`theme.css` intentionally has no hardcoded color defaults or CSS variable fallback chains. The resolver duplicates VSCode registry defaults for the Dormouse-consumed color IDs, including `null` default behavior where Dormouse needs a concrete CSS variable. In particular, `list.inactiveSelectionForeground` resolves to normal foreground inheritance, not `list.activeSelectionForeground`; this matches VSCode's list/tree selected-row behavior for built-in Light.

A `MutationObserver` in `lib/src/lib/terminal-theme.ts` watches for VS Code theme changes on `body`/`html` (class and style attribute mutations) and live-updates all xterm.js instances. The `terminal-registry.ts` facade still exposes the public lifecycle APIs. The theme resolver has its own observer on the same attributes so derived `--vscode-*` variables stay in sync before xterm rereads the terminal palette.

`dormouse.debugTheme` focuses the Dormouse WebviewView and posts
`dormouse:openThemeDebugger` to the webview. `VSCodeAdapter` converts that
message into the browser event consumed by the shared Theme Debugger. The
debugger traces VSCode-exposed `--vscode-*` variables and Dormouse
materialized fallbacks, but it does not attempt to read raw built-in VSCode
theme files.

### OSC color query answering

TUIs query the terminal's foreground/background/cursor colors with `OSC 10/11/12 ; ?` to adapt their UI (see [terminal-escapes.md](terminal-escapes.md#supported-oscs)). Dormouse answers these from the active theme, but PTY parsing happens in the **extension host**, which has no DOM to read the theme from. So the webview pushes its resolved colors up: `VSCodeAdapter.pushThemeColors()` reads `getTerminalTheme()` and posts `dormouse:themeColors { foreground, background, cursor }` on `requestInit` and again whenever `onTerminalThemeChange` fires (the shared `terminal-theme.ts` observer). `message-router.ts` caches the latest colors and feeds them to every PTY's parser via a `TerminalColorProvider`, so the parser replies and consumes the query exactly like the standalone frontend adapter. Before the first push (or if a color is unparseable) the provider returns `null` and the query falls through to xterm.js. On Windows this also depends on `useConptyDll: true` so the query reaches the extension host at all — see [terminal-escapes.md](terminal-escapes.md#osc-color-queries-on-windows-require-the-bundled-conpty).

### CSP policy

Source of truth: `vscode-ext/src/webview-html.ts` assembles the CSP directives (`getNonce()` + the directive list).

`unsafe-inline` for styles is needed because VS Code injects theme CSS variables via inline styles on the body element. Scripts remain nonce-gated (32-char random alphanumeric nonce). The webview HTML is built by Vite from the `lib` package, then at runtime `webview-html.ts` rewrites asset URLs to webview URIs, injects the CSP meta tag, applies nonces to all script tags, and injects initial state via a nonce-gated inline script.

### Build and development

Source of truth:

| Scope | Source | Covers |
| --- | --- | --- |
| Root commands | `package.json` | `pnpm build:vscode`, `pnpm dogfood:vscode` orchestration |
| Extension scripts | `vscode-ext/package.json` | `build:frontend`, `build`, `dogfood` package-local steps |
| F5 launch | `.vscode/launch.json` + `.vscode/tasks.json` | Extension Development Host debugging chain |

`pnpm dogfood:vscode` uninstalls the legacy `diffplug.mouseterm` extension
before packaging and installing the current Dormouse VSIX, then the VS Code
window must be reloaded to pick up changes.

**Dogfooding vs Extension Development Host:** Day-to-day development uses `pnpm dogfood:vscode` to install the extension into your real VS Code instance. This catches real-world issues since you're running with your actual settings, extensions, and workspaces. The F5 Extension Development Host workflow exists for when you need **breakpoint debugging** of extension host code (`extension.ts`, `message-router.ts`, `pty-manager.ts`, etc.) — it launches a separate VS Code window where the debugger can attach to the extension host process.

The Vite config for the extension (`vscode-ext/vite.config.ts`) sets `root: ../lib` and `outDir: ./media`, building the shared React frontend directly into the extension's media folder.

## Dream architecture

### Context keys

Set context keys so menus and extensions can target Dormouse state:

```typescript
// Set when any Dormouse webview has focus
vscode.commands.executeCommand('setContext', 'dormouse.active', true);

// Set when Dormouse is in passthrough/terminal mode (keys go to PTY)
vscode.commands.executeCommand('setContext', 'dormouse.mode', 'terminal');

// Set when Dormouse is in normal/navigation mode (keys go to Dormouse UI)
vscode.commands.executeCommand('setContext', 'dormouse.mode', 'normal');
```

### Commands

| Command | Description |
|---------|-------------|
| `dormouse.focus` | Focus the Dormouse panel view |
| `dormouse.newPane` | Split a new pane in Dormouse |
| `dormouse.closePane` | Close the focused pane |
| `dormouse.nextPane` | Focus next pane |
| `dormouse.prevPane` | Focus previous pane |
| `dormouse.enterTerminalMode` | Switch to passthrough mode |
| `dormouse.enterNormalMode` | Switch to navigation mode |
| `dormouse.listSessions` | Show QuickPick of all live PTY sessions |
| `dormouse.reattach` | Reattach a minimized PTY to a pane |

### Not yet implemented

- `TerminalProfileProvider` not registered — Dormouse doesn't appear in the terminal `+` dropdown
- Context keys not set (`dormouse.active`, `dormouse.mode`) — needed for conditional keybindings
- Commands not registered: `dormouse.newPane`, `closePane`, `nextPane`, `prevPane`, `enterTerminalMode`, `enterNormalMode`, `listSessions`, `reattach`
- No status bar item showing active session count
- No QuickPick for listing/reattaching PTY sessions
- Workspace union status not yet reflected onto `panel.iconPath` / `panel.title` (editor tabs) or `view.badge` / `view.description` (bottom-panel view) — the model and chrome contract are in the Workspaces section above
