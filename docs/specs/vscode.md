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
├── workspace-chrome.ts       — reflect Workspace union status (bell/TODO) onto native chrome title
├── shell-selection.ts        — persisted shell picker (workspace/global selectedShellPath)
├── agent-browser-host.ts     — extension-host wiring + stream relay for the agent-browser surface
├── iframe-proxy-host.ts      — VS Code binding for the iframe transparent proxy (injects the logger)
├── webview-html.ts           — CSP injection, nonce generation, asset URI rewriting
└── log.ts                    — extension logging

Shared PTY Core (standalone/sidecar/)
└── pty-core.js               — node-pty wrapper shared between VS Code and Tauri sidecar

Frontend Library (lib/src/)
├── App.tsx                       — error boundary wrapper
├── main.tsx                      — entry point
├── cfg.ts                        — timing config (marching ants, alert thresholds)
├── theme.css                     — --vscode-* -> semantic --color-* tokens
├── index.css                     — Lath host styling, marching-ants keyframe
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
    ├── resolve-pane-element.ts   — resolve a pane element to its Lath leaf (overlay measurement)
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
> Each webview's union is computed host-side and reflected onto native chrome (see "Surfacing union status" below) — implemented. It is currently always-on: the extension host has no `localStorage` to read the standalone workspaces flag (a host-side gate is an open question — see [Future](#future)). The Window persistence container is standalone-only and does not touch VS Code, which keeps one bare `PersistedSession` per webview.

In VS Code, **one webview is one Workspace**. The bottom-panel `WebviewView` ("Dormouse") is the default Workspace; each `dormouse.open` editor-tab `WebviewPanel` is an independent Workspace. Unlike standalone, several Workspaces are visible at once, and VS Code — not Dormouse — owns their tabs, creation, and closing: opening a Dormouse editor tab creates a Workspace and closing the tab closes it, so Dormouse adds no create/rename/close affordances here. A webview owns the terminal Sessions whose PTYs its router tracks (`ownedPtyIds`, `docs/specs/transport.md`) plus any browser surfaces rendered in it; together those are the Workspace's Surfaces.

#### Surfacing union status on native chrome

The host computes each webview's union (`ringing` / `todo`) from the module-level `AlertManager` scoped to that router's `ownedPtyIds` (`computeWorkspaceUnion`), delivered via the `attachRouter` `onUnion` callback. Because `ownedPtyIds` are PTY-backed terminals, **VS Code chrome reflects terminal Session ring + TODO only**; a browser surface's TODO stays webview-local (the `alert:state` channel is keyed by PTY-backed Session ids; the webview→host Surface-state channel that would lift this is staged — see [Future](#future)).

The two hosting primitives expose different chrome, so each uses what it supports, following the in-app `<title> <bell> [TODO]` pattern where possible:

- **Editor tab (`WebviewPanel`):** `panel.title` gains the suffix — `Dormouse` + ` 🔔` (ringing) + ` [TODO]` (todo), both when both apply. The bell is an emoji stand-in for the in-app bell icon (a tab title is plain text); `[TODO]` is the bracketed word. `panel.iconPath` stays the Dormouse mascot. (`workspaceTitle` in `workspace-chrome.ts`.)
- **Panel view (`WebviewView`):** a presence **badge** — `view.badge.value = 1` whenever anything owes attention, `0` to clear it (ring-vs-TODO in the tooltip; `workspaceBadge`). `view.title` is *not* used: on this single-view **bottom-panel** container VS Code shows the static container title (`viewsContainers[].title`), which has no runtime API, so the title can't carry status — the badge is the only runtime indicator that surfaces. **Clear with `0`, not `undefined`:** VS Code hides a 0-value badge but does not clear one set to `undefined` on a panel container. `view.description` stays the shell name.

Reflection updates on every owned-PTY `AlertManager.onStateChange` and on `claim` / `release` (a webview gaining or losing a PTY). Source of truth: `attachRouter` `onUnion` / `notifyUnion` in `message-router.ts`; `extension.ts` (panel title), `webview-view-provider.ts` (view badge), `workspace-chrome.ts` (formatting).

### Shell selection

The VS Code view title contributes `Dormouse: Select Shell` and `Dormouse: New Terminal`. The selected shell name is mirrored into the `WebviewView.description`, and `dormouse:selectedShell` keeps the webview's default-shell slot current for split/spawn/restore paths.

`dormouse.newTerminal` focuses the Dormouse view and posts `dormouse:newTerminal` with the currently selected shell; the shared Wall selects the new pane and enters passthrough immediately. `dormouse.selectShell` opens a QuickPick, saves the shell path globally or per workspace, applies the description/default-shell update, and, when the picked shell differs from the previous selection, focuses the view and posts `dormouse:newTerminal` with `replaceUntouched: true` and `announce: true`. The shared `Wall` logic then replaces only a selected untouched terminal in-place; touched terminals cause an additional pane to be spawned and focused in passthrough instead.

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

`theme.css` intentionally has no hardcoded color defaults or CSS variable fallback chains. The resolver duplicates VSCode registry defaults for the Dormouse-consumed color IDs, including `null` default behavior where Dormouse needs a concrete CSS variable; the null-default materialization rules (including the `list.inactiveSelectionForeground` case) are owned by `docs/specs/theme.md` (Runtime model).

A `MutationObserver` in `lib/src/lib/terminal-theme.ts` watches for VS Code theme changes — class + style mutations on both `body` and `html` — and live-updates all xterm.js instances. The `terminal-registry.ts` facade still exposes the public lifecycle APIs. The theme resolver has its own observer on the same roots and attributes (`vscode-color-observer.ts`) so derived `--vscode-*` variables stay in sync before xterm rereads the terminal palette.

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

`unsafe-inline` for styles is needed because VS Code injects theme CSS variables via inline styles on the body element. Scripts remain nonce-gated, with a fresh per-render nonce of 24 CSPRNG bytes (`node:crypto` `randomBytes`) base64url-encoded to 32 characters — a nonce that is guessable is a nonce that is not there, so `Math.random()` is not acceptable here. The webview HTML is built by Vite from the `lib` package, then at runtime `webview-html.ts` rewrites asset URLs to webview URIs, injects the CSP meta tag, applies nonces to all script tags, and injects initial state via a nonce-gated inline script.

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

## Future

### Webview→host Surface-state channel

Today the host receives only PTY-keyed alert state (`alert:state`), so a browser surface's TODO stays webview-local and native chrome reflects terminal ring/TODO only. A webview→host Surface-state message would let the native-chrome union count browser-surface TODOs too (`docs/specs/alert.md`, `docs/specs/transport.md`).

### Host-side workspaces flag gate

The native-chrome union reflection is always-on because the extension host cannot read the standalone `dormouse.flags.workspaces` localStorage flag. Whether to add a host-side gate gets decided when the workspaces rollout reaches VS Code (`docs/specs/layout.md` `## Future`, workspaces-rollout).

### Context keys

Set context keys so menus and extensions can target Dormouse state:

```typescript
// Set when any Dormouse webview has focus
vscode.commands.executeCommand('setContext', 'dormouse.active', true);

// Set when Dormouse is in passthrough mode (keys go to PTY)
vscode.commands.executeCommand('setContext', 'dormouse.mode', 'passthrough');

// Set when Dormouse is in command mode (keys drive Dormouse UI)
vscode.commands.executeCommand('setContext', 'dormouse.mode', 'command');
```

### Commands

| Command | Description |
|---------|-------------|
| `dormouse.focus` | Focus the Dormouse panel view |
| `dormouse.newPane` | Split a new pane in Dormouse |
| `dormouse.closePane` | Close the focused pane |
| `dormouse.nextPane` | Focus next pane |
| `dormouse.prevPane` | Focus previous pane |
| `dormouse.enterPassthroughMode` | Switch to passthrough mode |
| `dormouse.enterCommandMode` | Switch to command mode |
| `dormouse.listSessions` | Show QuickPick of all live PTY sessions |
| `dormouse.reattach` | Reattach a minimized PTY to a pane |

### Other host integrations

- `TerminalProfileProvider` registration, so Dormouse appears in the terminal `+` dropdown
- A status bar item showing active session count
- A QuickPick for listing/reattaching PTY sessions
