# Dormouse VS Code Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary. See `docs/specs/transport.md` for the PTY lifecycle, message protocol, persisted-session types, and adapter-agnostic invariants that VS Code shares with the standalone and fake adapters. This spec covers the VS Code-specific layer: panel/view registration, persistence APIs, theme integration, CSP, build, and dream-architecture commands.

## What's built

Dormouse has two hosting modes: a `WebviewView` in the bottom panel (alongside Terminal, Problems, Output) and `WebviewPanel` editor tabs (via `dormouse.open`, supports multiple instances). Both restore across "Developer: Reload Window". PTY lifecycle is fully decoupled from the webview — PTYs live in the extension host via `pty-manager.ts`, survive panel visibility toggling, and replay buffered output on **resume**. Session persistence works across cold **restore**: pane layout, CWD, and alert state (enabled/disabled + todo) are saved and restored on cold start. Scrollback is never persisted (`docs/specs/transport.md` → "Persistence policy"); instead `deactivate()` interrupts the live PTYs and records each pane's agent resume invocation, which the next cold restore auto-runs (`docs/specs/layout.md` → "Agent resume on cold restore"). The view uses `workspaceState` for persistence; editor panels use VS Code's per-panel `vscode.setState()` so multiple panels don't clobber each other. Alert state is merged into every periodic save (not just deactivate) so it survives even if VS Code kills the extension host before deactivate completes. A `WebviewPanelSerializer` handles editor tab restoration; `onWebviewPanel:dormouse` activation event ensures the extension activates early enough. Theme integration uses VSCode `--vscode-*` tokens plus Dormouse semantic `--color-*` tokens, with a small resolver that materializes missing consumed VSCode colors from registry defaults. CSP is strict with nonce-gated scripts.

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
├── webview-html.ts           — CSP injection, nonce + message-token generation, asset URI rewriting
├── remote-host.ts            — the remote Host service in this window: provider, command routing, storage
├── remote-host-store.ts      — `VsCodeHostStateStore`: enrollment in SecretStorage, ACL in globalState
├── peer-link.ts              — socket between windows: bind-as-lease arbitration, broker serves, clients report in
│                             (in-window peer-surface brokering lives in message-router.ts)
├── (../scripts/esbuild.mjs)  — outside src/: extension + pty-host bundles; bakes the Host's remote `connect-src`
├── webview-messaging.ts      — serveWebview: pairs a document with its message token, returns the WebviewChannel
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
    ├── quiesce-detector.ts       — silence/output pattern detection for alert
    ├── session-save.ts           — periodic save (debounced 500ms + 30s interval)
    ├── session-restore.ts        — cold-start pane restoration
    ├── session-types.ts          — PersistedSession/PersistedPane/PersistedAlertState types
    ├── resume-patterns.ts        — detect an agent resume invocation in a buffer
    ├── resolve-pane-element.ts   — resolve a pane element to its Lath leaf (overlay measurement)
    ├── vscode-message-token.ts   — host-message token constants + the `isHostMessage` guard
    └── platform/
        ├── types.ts              — PlatformAdapter interface
        ├── index.ts              — adapter factory (auto-detects VS Code vs fake)
        ├── vscode-adapter.ts     — VS Code postMessage bridge
        └── fake-adapter.ts       — mock adapter for testing + website playground
```

### Invariants (VS Code-specific)

Universal PTY/transport invariants live in `docs/specs/transport.md`. The rules below are specific to running inside the VS Code extension host.

- **Save before kill.** `deactivate()` must save session state *before* killing PTYs — CWD queries need live processes, and recovery capture needs an agent still running to interrupt. See ordering in `extension.ts:deactivate()`.
- **Alert state is global.** A single `AlertManager` instance in `message-router.ts` is shared across all routers and survives router disposal. PTY data feeds into it at module level, regardless of webview visibility.
- **WATCHING rules are host-authoritative.** The first webview seeds the shared host rule set after extension-host startup. Later webviews cannot replace it: rule edits arrive as per-command mutations, and `WatchedCommandHost` broadcasts the resulting canonical snapshot to every renderer so their dialogs and persisted mirrors stay synchronized.
- **PTY ownership tracking.** Each router tracks its PTYs in `ownedPtyIds`. A module-level `globalOwnedPtyIds` set prevents a resuming router from stealing PTYs owned by another webview.
- **mergeAlertStates on every save path.** Both the frontend periodic save (`onSaveState` callback) and the backend deactivate refresh (`refreshSavedSessionStateFromPtys`) must merge current alert states. Missing this causes alert state to revert on restore.
- **retainContextWhenHidden.** Set on both `WebviewPanel` (editor tabs) and `WebviewView` (bottom panel) so that xterm.js DOM, scrollback, and PTY subscriptions survive panel hide/show without going through a resume.
- **Two save sources.** Session state is saved from two places: the frontend (debounced 500ms + 30s interval via `dormouse:saveState`) and the backend (deactivate flushes webviews then refreshes from live PTYs). Both paths must produce consistent state.
- **Every host → webview send carries the message token.** The webview's `window` is a shared inbox that framed surfaces can also post to, so the adapter drops any `message` that isn't stamped with the per-boot token. Everything downstream of `serveWebview` holds a `WebviewChannel` rather than a `vscode.Webview`, so bypassing the stamp is a type error there rather than a convention to remember; only the two serve sites (`setupPanel`, `resolveWebviewView`) still hold a raw webview. Adding a `message` listener that skips `isHostMessage` reopens the forgery hole either way. See "Webview message authentication" below.
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
- Closing a Dormouse editor-tab `WebviewPanel` is different from hiding it:
  `setupPanel` attaches its router with `killOnDispose: true`, so disposal kills
  that panel's owned PTYs and VS Code removes the tab's per-panel state.
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

WATCHING rules use a separate host-authoritative synchronization channel because
they are app-global rather than owned by one Workspace. Each webview offers its
persisted rules through `alert:initializeWatchedCommands`; only the first offer
after extension-host startup seeds the shared manager. Subsequent
`alert:setCommandWatched` messages mutate one key, and every attached renderer
receives `alert:watchedCommands` with the canonical full snapshot. Source of
truth: `WatchedCommandHost` in
`lib/src/lib/watched-command-host.ts` and the alert cases in
`vscode-ext/src/message-router.ts`.

The alarm settings (`docs/specs/alert.md` → Alarm settings) ride the same shape
for the same reason, through `alert:initializeSettings` /
`alert:updateSettings` / `alert:settings` and `AlertSettingsHost` in
`lib/src/lib/alert-settings-host.ts`. Two details are specific to it: the host
consumes only `inactivityTimeoutMs` (it installs it on the shared
`AlertManager`) yet relays the whole blob so renderer-only fields stay in sync
across webviews, and it revalidates every inbound blob — these are
renderer-supplied numbers that become host timers.

### Shell selection

The VS Code view title contributes `Dormouse: Select Shell` and `Dormouse: New Terminal`. The selected shell name is mirrored into the `WebviewView.description`, and `dormouse:selectedShell` keeps the webview's default-shell slot current for split/spawn/restore paths.

`dormouse.newTerminal` focuses the Dormouse view and posts `dormouse:newTerminal` with the currently selected shell; the shared Wall selects the new pane and enters passthrough immediately. `dormouse.selectShell` opens a QuickPick, saves the shell path globally or per workspace, applies the description/default-shell update, and, when the picked shell differs from the previous selection, focuses the view and posts `dormouse:newTerminal` with `replaceUntouched: true` and `announce: true`. The shared `Wall` logic then replaces only a selected untouched terminal in-place; touched terminals cause an additional pane to be spawned and focused in passthrough instead.

The QuickPick is the only shell control here: `VSCodeAdapter` sets the optional `hostOwnsShells` capability, so the shared Settings dialog hides its Shell row (mirroring `hostOwnsTheme` for the Theme row, §Theme integration).

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
4. On deactivate: capture agent recovery commands, then flush all sessions from webviews (1s timeout), then refresh from live PTYs (queries CWD while processes are still alive).
5. Graceful shutdown: save state → interrupt + capture → SIGTERM → 2s wait → force kill.
6. On activate: saved state loaded and passed to routers for cold-start restore via `readPersistedSession()` (defined in `docs/specs/transport.md`), which tolerates both parsed objects and JSON-stringified blobs returned by VS Code state APIs. The WebviewView and each deserialized WebviewPanel then claim the recovery commands matching their own pane ids out of the single record written at teardown (`docs/specs/transport.md` → "The recovery command"); neither container owns the record, so resolving first cannot delete the other's commands.

Step 5 is where recovery is captured, and the ordering is the whole feature: the
resume hint exists only between the interrupt and the kill, so the step-4 refresh
(which runs before both) can never contain it. `captureAgentRecoveryCommands`
writes `^C` into every live PTY, waits bounded for what they print, scans those
buffers, and records the invocation — then `killAll()` runs
(`docs/specs/transport.md` → "VS Code teardown ordering").

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

Source of truth: `vscode-ext/src/webview-html.ts` assembles the CSP directives (`randomSecret()` + the directive list).

**The webview CSP carries no relay sources.** Its `connect-src` is `webview.cspSource` plus loopback `ws:` for the agent-browser stream relay — the remote Host holds its `/ws/host` socket from the *extension host*, which no CSP fences, so the origin allowlist is enforced there instead (see "Remote Host: a service in the extension host").

That allowlist is still a build-time constant, not a runtime value: `vscode-ext/scripts/esbuild.mjs` substitutes `__DORMOUSE_REMOTE_CONNECT_SRC__` into `dist/extension.js`, defaulting to the SaaS origin (`https://*.dormouse.sh wss://*.dormouse.sh`), and `assertConnectSrcBaked` fails the build if the define did not reach the bundle — a lost define would otherwise surface only as a Host silently using the shipped default. `lib/src/host/remote/connect-src.ts` reads it through `bakedConnectSrc()`, as a `declare const` rather than an import, so the value is a literal in the bundle and nothing at runtime can move it. A selfhoster widens it for their own build with `DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode` — the same variable and the same per-build opt-in as the standalone binary (`docs/specs/server.md` → "Where a Host may reach a relay server").

`unsafe-inline` for styles is needed because VS Code injects theme CSS variables via inline styles on the body element. Scripts remain nonce-gated, with a fresh per-render nonce of 24 CSPRNG bytes (`node:crypto` `randomBytes`) base64url-encoded to 32 characters — a nonce that is guessable is a nonce that is not there, so `Math.random()` is not acceptable here. The webview HTML is built by Vite from the `lib` package, then at runtime `webview-html.ts` rewrites asset URLs to webview URIs, injects the CSP meta tag, applies nonces to every tag that loads a script, and injects initial state via a nonce-gated inline script.

**A nonce alone does not survive code splitting.** Vite splits the webview bundle, and `script-src` gates each way a chunk loads separately. Two mechanisms cover them, and the split is not negotiable — a nonce is **not** inherited through the module graph, and `'strict-dynamic'` does not vouch for a parser-started fetch:

- **Vite stamps the nonce** onto every tag it emits, via `html.cspNonce` in `vscode-ext/vite.config.ts` (the placeholder is `CSP_NONCE_PLACEHOLDER`, shared by the config and `webview-html.ts` from `vscode-ext/src/csp-nonce-placeholder.ts`). That covers the entry `<script>`, the `<link rel="modulepreload">` tags for its static imports, and the `<meta property="csp-nonce">` that Vite's own runtime preload helper reads before injecting a preload for a lazy chunk. Vite walks its output with a real HTML parser, so coverage follows the bundler's emitted shape rather than a regex's guess at it. `getWebviewHtml` then swaps the placeholder for that document's real nonce, and **throws if the placeholder is absent** — an unmarked build would otherwise serve un-nonced scripts against a nonce-gated policy, which looks exactly like a blank panel.
- **`'strict-dynamic'` covers the fetches no tag represents:** the entry's own static imports and every lazy `import()`. It widens what an already-trusted script may *load*, never what may be *written into* the document, and nothing here grants `script-src 'unsafe-inline'`. It also makes host-source expressions inert, so adding `webview.cspSource` to `script-src` would be dead weight.

Get any of it wrong and the failure is remote from its cause: a blank panel, or a render error naming a chunk that is sitting on disk. In both cases the only direct evidence is a CSP violation in the webview console (**Developer: Open Webview Developer Tools**) — nothing reaches an extension-host log, and the extension itself activates normally.

The class arrived with a build-tool upgrade (rolldown began splitting out its shared runtime) and can return the same way, so `vscode-ext/test/webview-html.test.ts` pins it against a fixture of real Vite output: `'strict-dynamic'` is present, `script-src` never gains `'unsafe-inline'`, each named script-loading tag carries the real nonce, no placeholder survives, no tag carries two nonces, and an unmarked document is refused.

### Webview message authentication

The CSP governs what the webview document may *load*. It says nothing about who may *message* it — and in VS Code the webview's `window` is a shared inbox. The extension host posts to it, and so can any framed surface (`dor iframe`, agent-browser; `docs/specs/dor-browser.md`) via `parent.postMessage`, which crosses origin and sandbox boundaries by design. Several inbound message types are consequential: `dor:controlRequest` becomes a `dormouse:control-request` event that `use-dor-control.ts` can turn into a `writePty` call, and the `pty:*` family drives what the user sees in a terminal. `event.data.type` is attacker-chosen, so it cannot be the thing that decides trust.

So host-originated messages are authenticated by a **per-boot message token**:

- `getWebviewHtml` mints one token per webview document — 24 CSPRNG bytes, base64url, from the same `randomSecret()` as the CSP nonce — injects it as `globalThis.__DORMOUSE_MESSAGE_TOKEN__` in the same nonce-gated inline script that seeds the other `__DORMOUSE_*` globals, and returns it alongside the HTML because the two are only meaningful together.
- `serveWebview` is the only way to put a document on a webview: it mints, assigns `webview.html`, and returns a `WebviewChannel` whose `post()` closes over that document's token. Minting and serving are therefore one step — a token cannot drift from the document carrying it, and re-serving yields a new token and a new channel. Nothing holds a token keyed by webview identity, so there is no cleanup.
- **Every** host → webview send goes through a channel. `attachRouter` takes a `WebviewChannel` (not a `vscode.Webview`) and exposes `post()` as a local; `DormouseViewProvider` stores its channel and `postMessage` forwards to it, returning `false` before the view is served or after it disposes — the same undelivered signal the VS Code API gives for a dead webview, which the `dormouse:newTerminal` retry loop and `forwardDorControlRequest`'s rejection path already handle.
- `VSCodeAdapter` captures the token **once, at construction**, and both of its `message` listeners — the main dispatcher and the per-request reply listener inside `requestResponse` — call `isHostMessage(event.data, token)` before reading anything else, including `type`.

Why a token rather than checking `event.source`/`event.origin`: a source check would have to assert something about VS Code's internal webview frame topology, which is undocumented and can change between releases. A token depends on nothing but itself. It is deliberately **not** the CSP nonce — that nonce authorizes script execution, this token authenticates a message sender; conflating them makes both harder to reason about. Both live in the same injected markup and are equally readable by the top document; neither is reachable from a cross-origin frame.

The guard fails closed in both directions: a webview served without the global accepts nothing, and a host send without a token delivers nothing. Framed content cannot read the parent's globals cross-origin, so it cannot produce the token.

This is the same shape as the origin check the Wall already applies to messages from proxied iframes (`isProxyOrigin` in `lib/src/lib/iframe-proxy-registry.ts`, used by `use-wall-keyboard.ts` and `IframePanel.tsx`) — a small module holding the trust criterion so each listener stays a one-line guard. Those two listeners validate their own senders and are unaffected by the token; the token covers only the adapter's host channel.

Scope is VS Code. The standalone adapters receive the equivalent events over Tauri's `listen()` IPC and the dev harness's host WebSocket (`docs/specs/standalone.md`, `docs/specs/transport.md`), never `window.postMessage`, so they have no forgeable inbox to guard.

Source of truth: `lib/src/lib/vscode-message-token.ts` (constants + `isHostMessage`), `vscode-ext/src/webview-messaging.ts` (`WebviewChannel` + `serveWebview`), `vscode-ext/src/webview-html.ts` (mint + injection), `lib/src/lib/platform/vscode-adapter.ts` (both guards). Tests: the `host message authentication` block in `lib/src/lib/platform/vscode-adapter.test.ts`.

### Remote Host: a service in the extension host

VS Code is a first-class remote Host, and the Host is not a webview thing. It is `RemoteHostService` — the relay socket, the enrollment, the ACL, the pairing ceremony, and remote-api v1 served through a `HostSurfaceProvider` — running in the extension host, the process that already owns the PTYs. The service itself is shared with the Tauri sidecar and specified elsewhere: `lib/src/host/remote/` for the service, `docs/specs/remote-api.md` for what it speaks. This section covers what is VS Code's: where its state lives, which window runs it, and what the webviews still do.

A webview is a **surface responder plus UI**: it answers what its own panes are called and how big its terminals are, renders the pairing modal, and carries the `window.dormouseRemoteHost` console hook. Nothing a webview says can widen access — the ACL and the access decision never leave the extension host (`docs/specs/remote-security-model.md`).

**The store.** The Host's enrollment (`{ serverUrl, hostId, hostToken, origin, rpId }`) and its ACL are split by sensitivity: `hostToken` is a bearer credential that grants the `/ws/host` socket, so the enrollment goes to `SecretStorage` (OS keychain), while the ACL is public-key records with no secret in them and goes to `globalState`. Both are global rather than workspace-scoped, because a Host identity belongs to the machine and not to a folder.

The service reads both **in-process** — no hydration tier, no synchronous write-through cache, no prefix claim, no cross-webview snapshot broadcast. Those existed only because a webview needed a synchronous `local-json-store` view of extension-host state; the store interface (`HostStateStore`) is async because the places state lives are. The enrollment is read once and kept, since `SecretStorage` is a keychain round trip and both the activation probe and the service want the same answer.

That memo is only safe because it is invalidated across windows: `SecretStorage` is shared by every window of an extension and `secrets.onDidChange` fires in all of them, so the store drops the memo whenever the enrollment key changes anywhere. Without it a promoted broker could resurrect an enrollment another window cleared, or never see one another window created. The ACL is deliberately **not** memoized — it is read from `globalState` on every load, which is in-process and free. All mutations are serialized in call order; in particular, two rapid pairing approvals write successively larger ACL snapshots, and the older snapshot must not finish last and erase the newer approval on restart. A failed write rejects its caller but does not wedge later mutations. That rule holds for every Host store, so it is one helper (`createSerialQueue` in `lib/src/host/remote/serial-queue.ts`) shared by this store, the sidecar's file store, and the service's own start/stop chain. The same subscription is what lets a window that was un-enrolled at activation join a Host a sibling just created: `initRemoteHost` re-checks on the event and contends then, with no reload.

The keys and JSON values are the ones the webview-resident Host wrote before the service existed (`ENROLLMENT_KEY` in `lib/src/remote/host/store.ts`, `ACL_KEY_PREFIX` in `lib/src/remote/host/acl.ts`, one entry per `hostId` so a re-enrollment cannot inherit a stale ACL), so an already-enrolled installation is picked up with no migration step. Both names are imported rather than mirrored: a key that drifted between the two sides would strand an enrollment that is still on disk.

Source of truth: `VsCodeHostStateStore` in `vscode-ext/src/remote-host-store.ts` against the `HostStateStore` interface in `lib/src/host/remote/host-state-store.ts`.

**Which window: bind-as-lease.** One extension host runs per window, so left alone every enrolled window would start a Host against the same enrollment, all of them would connect `/ws/host`, and the server would close the displaced socket (`server/src/relay.ts`) whose `close` handler reconnects and displaces the next one — an endless fight, with each window arming its own alarm push.

Arbitration is therefore the socket itself: **the bind is the lease**. Every contending window tries to bind one fixed path — `<hash>.sock` inside a per-user `dormouse-peer-<uid>` directory in the temp dir, or `\\.\pipe\dormouse-peer-<hash>` on Windows — where the hash is derived from `context.globalStorageUri.fsPath`. Derived rather than random because it must be *the same* in every window; hashed rather than joined because macOS caps a unix socket path near 104 bytes and the globalStorage path is most of that alone. The winner is the broker and runs the service; everyone else connects to it as a client.

The invariants are what make this simpler than the heartbeat lease it replaced:

- **Roles never flip downward.** A broker is the broker for the rest of the process's life. There is deliberately no `onRole(false)` after a `true`, so the whole class of mid-transition races a TTL lease had — start serving, lose the lease, tear down, win it back while tearing down — is unrepresentable rather than handled. A client only ever changes role *upward*.
- **Contend on broker death, not on a timer.** When the broker exits, every client's socket closes and they all race to bind; exactly one wins, because `bind` is the arbiter. No TTL, no heartbeat file, no filesystem watcher.
- **A corpse is cleared, then the bind is re-checked.** `EADDRINUSE` → dial it → `ECONNREFUSED`/`ENOENT` means the path exists but nothing listens (a broker that died without unlinking). Every client of a broker that just died reaches that point at the same instant, so the unlink is jittered by up to `RECLAIM_JITTER_MS` and the path is dialled **again** afterwards — one of them may have rebound it while we waited, and unlinking a live broker's socket would strand every window dialling it. A second refusal is what makes the unlink safe. Two windows can still find the same corpse, both unlink, and the second bind silently displaces the first, leaving the loser serving a socket no client can reach; nothing on the bind path detects that, so `stillOurs` re-stats the path after `RECLAIM_VERIFY_MS` and compares its filesystem identity (device, inode, and nanosecond change timestamp). Inode alone is insufficient because Linux may immediately recycle a removed socket's inode for its replacement. A window whose socket identity was replaced — **or whose path has gone entirely**, which on unix means somebody unlinked it after our bind — stands down and the loop re-runs. Only Windows reads an unreadable path as ours: named pipes are not filesystem objects, cannot be stat-ed, and die with the process that made them.
- **A bind is not a role until it is believed.** Everything that answers "is this window the broker" — `ensurePeerNet`'s shortcut, `isPeerBroker`, `isPeerLinkSettled`, `remoteNotifyPeerChange` — reads `brokerConfirmed`, set only where `settle(true)` runs and cleared by `closeServer`. During the `RECLAIM_VERIFY_MS` window above the socket is bound but may still be given up, and a command landing inside it (an `enroll`, a `secrets.onDidChange`) that was told "broker" would start a service the stand-down path never tears down: two Hosts under one hostId, displacing each other on the relay forever. Unverified reads as unsettled, so such a command is held for the verdict instead.
- **Attempts are spaced.** A refused hello would otherwise turn reconnection into a spin, so the loop waits `RETRY_MS` between rounds, and a bind or connect that lands after disposal is undone rather than left to outlive its window.
- **Errors after `listen` are logged, not thrown.** A listening `net.Server` emits `'error'` for accept-time failures (EMFILE, a broken pipe), and an `EventEmitter` with no `'error'` listener rethrows out of a libuv callback — which would take the whole extension host down. `listenServer` installs a permanent logging listener the moment the bind succeeds; the sockets already accepted are unaffected, and a listener that has genuinely died is noticed by the windows that can no longer reach it.

**Trust.** The socket path is derived, not secret — it has to be the same in every window, so anything running as any user on the machine can compute it. Two layers stand between that and this installation's terminals.

*The directory.* On unix the sockets live in a `dormouse-peer-<uid>` directory created 0700, and before every bind and every connect it is `lstat`-ed and required to be a directory, owned by this uid, at exactly mode 0700, and not a symlink. A loose directory we own is tightened; anything else is somebody else's, no retry makes it ours, and the peer link stands down for good rather than spinning against it (callers waiting on the contention are released rather than left hanging). Windows named pipes carry their own ACL and skip this layer.

*The handshake.* The shared secret is a mode-0600 `remote-host.peer-token` in `globalStorageUri`, created once with an exclusive `wx` write rather than a rename so two windows starting together agree — the loser reads the winner's token instead of overwriting it under a client that already read the old one. `wx` creates the file before it writes the bytes, so the loser's read can land on a zero-length file; an empty read is therefore treated as *not yet written* and waited out (`TOKEN_WRITE_ATTEMPTS` × `TOKEN_WRITE_POLL_MS`) rather than taken as the token. That distinction is load-bearing rather than cosmetic: an empty `serverToken` fails the hello check below for every peer, and a broker never re-reads the token, so a window that adopted `''` would refuse the whole installation for its lifetime while every other window retried at `RETRY_MS` forever. A file still unreadable past the wait takes the stand-down path instead, and latches it: the exclusive create fails with `EEXIST` for a token path that is a *directory* as much as for one another window owns, so exhausting the wait means either a crash-left zero-length file or a `globalStorageUri` this process cannot read — neither of which a retry fixes. The throw re-derives which it was, because the caller's log line is the only diagnosis any of them gets. A `globalStorageUri` where the token can be neither read nor created latches the same permanent stand-down as an unsafe socket directory, for the same reason: it is not a transient failure, and retrying at `RETRY_MS` forever would make every command wait out its whole queue budget on every attempt instead of being told there is nothing to reach. It **never crosses the socket**. Instead three frames prove mutual knowledge of it:

1. `challenge { nonce }` — the *server* speaks first, on accept. A client that has not yet seen proof of the token must not volunteer one into whatever bound the path.
2. `hello { nonce, proof }` — the client answers with `HMAC-SHA256(token, "client:" + serverNonce)` and a fresh nonce of its own.
3. `welcome { proof }` — the server verifies in constant time, then answers `HMAC-SHA256(token, "server:" + clientNonce)`.

The `client:` / `server:` domain separation is load-bearing: without it the two proofs are the same function of the same key, and a fake server could reflect the client's own proof back as its welcome. The client verifies the welcome **before** it sends or answers anything else — until then it forwards no notifies (they queue), answers no requests, streams no PTY, and forwards no commands, and a welcome it cannot verify closes the socket. So squatting the path buys nothing: the squatter gets one HMAC over a nonce it chose, which is not the token, and is served nothing. Fresh nonces per connection make a captured proof worthless on the next one. Parseable JSON values that are not frame objects are rejected on both ends, a first frame that is not a valid hello drops the socket, and each side bounds the opening handshake to `HANDSHAKE_BUDGET_MS` so a silent connection cannot live forever.

**Nothing starts until there is a Host to run.** Contention begins when activation finds an enrollment in `SecretStorage`, when `secrets.onDidChange` reports that another window created one, or on the first `enroll` command from any webview — the bootstrap for an un-enrolled machine. A user who never enrolls never sees a socket. The service also runs independently of webview lifetime: a broker window with zero Dormouse webviews still relays, contributing an empty directory of its own.

**A command that arrives mid-contention is held, not refused.** While the contention runs this window is neither a broker nor a client, and a bind plus a handshake is not instant. Refusing there would tell an enrolled machine's webview it has no Host seconds before it gets one, and the gates that arm on that answer would stay down. So commands queue (bounded at a dozen, oldest refused on overflow) and drain when a role settles — to the service if this window brokered, over the link if it did not. Each carries its own deadline, under the adapter's own 15 s timeout, so a contention that never settles still produces a reason rather than a timeout. `enroll` is the one command that may *start* the contention; everything else refuses only where there is genuinely nothing to reach.

Source of truth: `vscode-ext/src/remote-host.ts` (the service glue, provider, and command routing) and `ensurePeerNet` / `attempt` / `stillOurs` in `vscode-ext/src/peer-link.ts`, tested in `vscode-ext/test/remote-host.test.ts` and `vscode-ext/test/peer-link.test.ts`.

**The webview bridge.** A webview reaches the service over `RemoteHostLink` (`lib/src/lib/platform/types.ts`), implemented in `vscode-adapter.ts` on three messages: `remoteHost:command { rhId, cmd, params }` out, `remoteHost:result { rhId, result | error }` and `remoteHost:event { name, … }` back. Everything but those three `postMessage` shapes is the shared client in `lib/src/host/remote/link-client.ts`, so VS Code, Tauri, and the browser dev harness cannot settle a command differently.

Results are **broadcast to every webview in the window** rather than replied to one. That is safe because an `rhId` is minted with a per-adapter random tag and is therefore globally unique — only the adapter that asked holds a pending command for it — and it is what lets one correlation id serve both the in-window fan-out and the cross-window forward below.

Two events are pushed rather than answered: `pairing-queue` (the complete queue snapshot; the service is authoritative, so the mirror replaces rather than merges) and `status { enrolled }`. Because the queue is pushed only when it *changes*, the webview also asks for it once on every transition to enrolled — joining a Host that is already mid-pairing would otherwise show no modal at all until that pairing was answered somewhere else.

**Volunteering is enrollment-gated; answering is not.** Answering an ask is free — a webview replies and goes back to sleep — but *announcing* costs a crossing per pane-state change, activity change, and focus move, plus an activity-store subscription for ring watching, on a machine whose owner may never enroll. So the service announces `{ name: 'status', enrolled }` whenever its lifecycle changes that, and `armWhileEnrolled` (`lib/src/remote/host/enrolled-gate.ts`) arms the outbound half only while a Host exists, seeded by one `status` command at install time for a webview that opens after the enrollment. The seed cannot lose a race with the event: both travel the same ordered channel.

**The relay socket.** `globalThis.WebSocket` arrived in Node 22, and `engines.vscode` here is `^1.85.0` — VS Code 1.85 shipped Node 18, so the supported range spans that boundary and an older extension host has no global to use. The service is therefore constructed with a factory that prefers `globalThis.WebSocket` and falls back to the bundled `ws`, whose socket satisfies exactly the surface `RemoteHost` reads (`send`, `close`, `readyState`, `addEventListener`, `message` events with `.data`, `close` events with `.code`). esbuild inlines `ws` lazily; its optional native accelerators `bufferutil` / `utf-8-validate` are marked external and are neither installed nor shipped — a `.node` addon cannot be bundled — so `ws` falls through its own `try`/`catch` to the JS paths. Source of truth: `createRelaySocket` in `vscode-ext/src/remote-host.ts`, the `external` list in `vscode-ext/scripts/esbuild.mjs`.

**Lifetime.** `retainContextWhenHidden: true` is set on both hosting modes, so hiding the panel keeps a webview's terminals answerable. Closing every Dormouse view no longer takes the Host offline — the service outlives them.

### Peer surfaces

The service owns the PTYs but not the *view* of them: a window's terminals are spread across however many webviews are open, and each webview is its own JS realm with its own xterm registry (`lib/src/lib/terminal-store.ts`). Only a webview knows what a pane is called, whether it is focused, and how big its xterm is. So the service asks, and every webview answers for its own.

`message-router.ts` is the in-window fan-out: `brokerRequest(op, params)` posts `peer:ask { requestId, op, params }` to every live webview and settles with everything they answered. Webviews reply `peer:answer { requestId, results }` and announce `peer:notify`, which carries no subject: the directory is the only thing a peer answers, so the announcement is the whole message. The asker is always the extension-host service (its own, or the broker window's over the link) and never a webview, which is why it is a plain promise rather than message plumbing.

Every webview installs the responder (`installPeerSurfaceResponder` in `lib/src/remote/host/peer-surfaces.ts`, wired from `lib/src/main.tsx`) whether or not its window is the broker. It carries none of the relay, enrollment, or pairing machinery — a registry lookup, the directory collector, a read-only surface resolve, and a resize. Installing is idempotent *per link*: answering already is (a responder replaces the one before it), but the announcing half is not — each install adds a `status` subscription, and each arming under it adds pane-state, activity, and focus listeners with no handle left to remove them, so a second call would cross into the Host's process twice per change forever. Keyed by the link rather than a flag, because the platform adapter is what owns one.

**One generic seam, one fan-out rule.** A peer request is `(op, params)` and an answer is *zero or more results*; that is the whole contract the adapter, the extension-host broker, and the cross-window socket implement. `op` is opaque to all three, because *what* a peer may be asked belongs to the remote Host and not to the transport: the operation map — `directory` and `surfaceOp`, with their real parameter and result types — lives in `lib/src/remote/host/peer-surfaces.ts` alongside the responder that answers them, so adding an operation is one entry there plus its caller, not a parallel ladder of types at every layer.

**Presence is ownership.** A webview that owns nothing the request named answers with no results, so there is no `ok` flag anywhere and every field of a result that does come back is required. Every webview answers regardless — even with no responder installed, even to say nothing — which is what lets a fan-out settle as fast on a miss as on a hit; silence would instead wait out the full budget on what is usually a miss. It settles when all of them have replied or the service's `ASK_BUDGET_MS` (1 s) expires, so a webview mid-reload cannot hang an attach or the phone's picker. That is the *inner* budget, and `PEER_REPLY_BUDGET_MS` — what the broker allows a peer *window* — must stay strictly larger, because it contains a whole run of this plus two socket hops. Equal budgets make a slow sibling look like a timeout on the broker's side and discard results that were on their way, so unifying the two constants is a regression rather than a simplification (a guard test in `vscode-ext/test/peer-link-protocol.test.ts` says so). A webview disposed mid-fan-out is removed from the outstanding set, which can settle the request immediately.

**Each webview counts once, and a late answer repairs the snapshot.** The router removes a webview from the outstanding set *before* taking its results, so a duplicate answer cannot contribute the same panes twice. An answer for a request that has already settled — the budget expired while that webview was busy — arrives after the Host rendered a directory missing whatever it owns, and nothing can re-open a settled request; so it triggers a directory invalidation instead, and the next collect asks again and repairs it. Without that an idle machine has no other reason to re-collect and the phone's picker stays wrong indefinitely. The sidecar's ask bridge does the same on an answer for an ask it no longer holds (`docs/specs/standalone.md`).

An asynchronous peer answer is bound to the authenticated broker socket that
issued it. If that broker disappears while a webview fan-out is pending, the
answer is dropped even when this window has already connected to a replacement;
request ids restart per broker, so forwarding the old result through the new
socket could satisfy unrelated work that reused the same id. A rejected fan-out
is contained in the peer handler and contributes an empty answer rather than an
unhandled extension-host rejection.

The one field the transport itself reads out of an answer is a reserved `ptyId` (`routedPtyId`): an answer naming a PTY is claiming it, which is how the cross-window broker learns which window that PTY lives in. Nothing else about an answer is interpreted below the Host.

Directory answers are snapshots, so the same seam carries invalidation. A webview announces a change when its pane state, activity, or focus changes; membership changes (a webview attaching or disposing, a peer window joining or dropping) announce one too. `notifyDirectoryChanged` fans that to the service's watchers, which coalesce a fresh collect rather than retaining the old directory. The webview coalesces on its own side too — one pending flag drained on a microtask — because those sources fire in bursts (a focus move alone is a `focusout` and a `focusin`) and a burst is worth exactly one crossing.

**Attach-is-the-resize goes through the live xterm.** `attach` and `resize` are the same mutating operation on the owner (`docs/specs/remote-api.md`), and both drive the owner's xterm rather than the PTY directly, so the owning pane's own view stays consistent with the size the phone asked for. Cross-window attach first fans out a read-only `resolve`, selects its first answer, then sends the mutating `attach` only to that answer's tier and peer; duplicated cold-restored windows therefore do not both resize before one is selected. The owner replies with the size it settled at plus the `ptyId`; the service then streams that PTY. There is no `detach` op — the service stops streaming on its side and the pane keeps whatever size it was left at, which is what last-attach-wins means.

**Which webview owns a pane never reaches the protocol layer.** `resolveSurface(surfaceId, size)` answers with a `SurfaceHandle` — provider-local `ptyId` routing key, the size it stands at, `resize`, `release` — or `null` if nobody owns it, and `remote-api.ts` holds one of those per attachment. One surface normally has one owner, so the first read-only resolve answer is the answer; when duplicated cold-restored windows temporarily answer for the same ids, the mutating attach and every later handle resize are addressed only to that selected tier/window. A resize nobody answered leaves the last known size standing. The shared half of that provider — the ask-backed directory and the handle construction — is `createAskSurfaceProvider` in `lib/src/host/remote/ask-surface-provider.ts`, so a Host cannot answer an attach differently in VS Code than in standalone.

**No second strip parser.** The extension host already runs the terminal-protocol parser once per PTY chunk and answers its queries (`message-router.ts`); webviews receive the stripped `visibleData` via `onProcessedPtyData` / `onProcessedPtyExit`, and that is exactly what the service's `streamPty` taps. A second parser here would answer every query twice and corrupt the PTY. (The sidecar, which hands raw bytes to its webview's own parser, does strip — `docs/specs/standalone.md`.)

Local streams go through **one keyed registry and one listener pair for the whole window**, shared by the Host provider and the peer-link forwarder and dispatching by id to registered sinks. These listeners run on every chunk of every terminal, so separate or per-attachment pairs would tax every keystroke of every PTY once per consumer. The pair is installed on the first attachment and removed when the last one goes, so a window with no remote viewer pays nothing. Source of truth: `vscode-ext/src/processed-pty-streams.ts`.

### Peer surfaces across windows

The same problem one level out, and it cannot be solved the same way: VS Code runs one extension host per window, so there is no shared process to broker through. The broker window — the one that won the bind — listens on that socket and every other window connects to it.

Traffic runs both ways over it, and each direction is the half its end alone can do. The broker asks client windows for their directory and their surfaces and streams their PTYs; client windows forward their webviews' Host commands to the broker, which is the only process running a service, and take back its results and UI events.

**Both tiers are asked at once.** `askBothTiers` runs `brokerRequest` (this window's webviews) and `remoteRequest` (every peer window) in parallel and concatenates, this window's first. Whatever is asked about normally lives in exactly one webview of one window, so asking in series would spend a whole tier's budget — or a hung window's — before the owner is asked at all. The results carry no tier marker because nothing downstream needs one: a directory is a concatenation deduplicated by `surfaceId`, and the first surface answer is selected. The dedup and the selection keep the same first-from-the-concatenation order on purpose — duplicated cold-restored windows can hold panes with identical ids, and the row the phone's picker shows must be the owner an attach would reach (`createAskSurfaceProvider` in `lib/src/host/remote/ask-surface-provider.ts`). Within the remote tier, all peers are asked at once for the same reason.

A client window answers a `request` frame by running its **own in-window** fan-out — never the cross-window one, or a request would loop back out. That is why the fan-out `configurePeerLink` hands the link is `brokerRequest` and never `askBothTiers`, and why the link is injected with what it needs rather than importing the router (which imports the link).

**Routed PTYs arrive pre-stripped.** A client window forwards `onProcessedPtyData` / `onProcessedPtyExit`, so what crosses the link is what that window's own xterm renders — the same stream shape as the local branch, and the reason the provider's two branches are interchangeable.

**Cross-window streams are reference-counted per routed PTY.** Two attachments to the same foreign surface share one `subscribe` frame; only zero-to-one starts the owner forwarding and only one-to-zero stops it, so a second viewer never restarts a live stream and one viewer detaching cannot silence the other. The owner answers the first `subscribe` with `subscribed` only after its sink and atomic liveness check are installed. A recorded exit is sent first on the same ordered socket, and the remote API waits for `subscribed`, so an exit that landed during surface resolution cannot be overtaken by a successful attach response. The last unsubscribe stops the forwarding but **keeps the route**: "nobody is watching it" is not "it moved". Re-attaching an already-attached surface resolves the new route first and only then tears the old attachment down, so dropping the route on unsubscribe would delete the fresh one and strand every later write. Routes are refreshed by every resolve and dropped by the two events that really mean the terminal is gone — an `exit` frame, and the owning window disconnecting (`forgetPeerRoutes`).

Once an answer names a `ptyId`, the broker replaces that owner-local id with a stable opaque route handle for the `(peer socket, ptyId)` pair before returning the result. Pane and PTY ids are unique only within a window: "Duplicate Workspace in New Window" can cold-restore identical surface and PTY ids into several windows, so a raw `ptyId → latest answering peer` table would acknowledge the first surface answer while streaming and writing to the last. The selected `SurfaceHandle` instead retains its peer-specific routing key; follow-up surface asks address that peer alone, while `subscribe`, `write`, and PTY-only `resize` translate it back to the owner's real id only on that socket. The generated key is checked against this window's PTYs and remains in the peer namespace after its route closes, so a stale handle fails closed rather than falling through to a later local PTY collision. When a peer disconnects, every handle routed to it is dropped and reported as exited (`forgetPeerRoutes`) — a terminal in a closed window is gone, and a later write must not be posted into a dead socket.

**Command forwarding.** Three frames carry the Host to windows that do not run it: a client sends `{ kind: 'command', payload }`, the broker answers that one window with `{ kind: 'commandResult', payload }`, and service UI events go out as `{ kind: 'uiEvent', payload }` to every authenticated window. `commandResult` needs no frame id of its own because `rhId` already is one.

A result is never sent both ways. The broker keeps a `commandRoutes` table of which window is owed each in-flight `rhId`; an answer with an entry goes to that socket alone, and one without goes to this window's webviews. Broadcasting another window's answer would settle nothing anywhere (ids are globally unique) and would put that window's Host state in front of webviews that never asked. A window that disconnects has its outstanding routes dropped and its commands left deliberately unanswered — the socket that would carry the answer is the one that closed, and the asking adapter's own timeout is the backstop. It also has whatever the broker was still *asking* it settled empty on the spot, rather than left to spend the full `PEER_REPLY_BUDGET_MS`: a directory or an attach every surviving window already answered must not stall behind a window that is already gone, and "gone" and "owns nothing" look the same to the caller. A `result` frame is taken only from the window the request was put to, since ids are per-broker.

Pairing UI events are the opposite: unaddressed and broadcast to every window's webviews, because the approval modal must appear wherever the user happens to be looking.

**A window with no Host at all still answers the read-only commands.** Reaching the terminal refusal means this window sees no enrollment — it contends when one exists and again the moment another window writes one — so that is the ordinary un-enrolled state, not a failure. `status`, `pushDevices`, and `pairingQueue` are therefore answered with exactly what an idle service returns (the un-enrolled `RemoteHostConsoleStatus`, `null`, `[]`), because each caller reads the difference: `pushDevices` answers `null` for "nowhere to push" and rejects only when the server could not be asked, so an error there had the Settings dialog reporting an unreachable server on a machine that had simply never enrolled, and `enrolled-gate.ts` seeds itself from `status`. Everything else refuses with an error rather than dropping it, so the console hook fails fast instead of hanging for its whole timeout.

One UI event *is* addressed: when a window completes the handshake the broker sends it the current `{ name: 'status', enrolled }`. `status` is emitted when the Host's lifecycle changes it, and a window connecting changes nothing — so a window opened after the enrollment would otherwise sit disarmed, announcing no directory changes and watching for no rings, until the user reloaded it.

Socket bind errors reject startup and are handled as an unavailable peer link; they never leave the listen promise pending or surface as an uncaught extension host error.

Source of truth: `vscode-ext/src/peer-link.ts` for the sockets and arbitration; `vscode-ext/src/peer-link-protocol.ts` for the frame shapes, framing, handshake, budget, and PTY routing table (tested in `vscode-ext/test/peer-link-protocol.test.ts`); `vscode-ext/src/processed-pty-streams.ts` for the window-wide processed stream registry; `vscode-ext/src/remote-host.ts` for `askBothTiers`, the provider, and command routing; `brokerRequest` and the `peer:*` / `remoteHost:command` cases in `vscode-ext/src/message-router.ts`; the operation map and responder in `lib/src/remote/host/peer-surfaces.ts` (tested in `lib/src/remote/host/peer-surfaces.test.ts`); and the attachment it backs in `lib/src/remote/host/remote-api.ts`.

### Testing the extension host

`vscode-ext` runs vitest (`pnpm --filter dormouse test`, which typechecks first). The `vscode` module only exists inside a running editor, so `vitest.config.mts` aliases it to a stub providing just the output channel `log.ts` opens — most modules worth testing import `vscode` as `import type`, which erases.

The tests that matter here are the ones that need real I/O, since the pure halves already live in `lib`. Six files, all under `vscode-ext/test/`:

- **`peer-link.test.ts`** stands up a broker and a client over a real socket: bind-as-lease (first binder wins, idempotent re-announce, taking over a socket whose broker died without unlinking, re-binding when the reclaimed socket is unlinked out from under it, a reclaimed bind answering no role until it is verified, two windows racing for one corpse settling into a broker and a client, handing the Host to a surviving window when the broker dies, an accept-time server error logged rather than thrown, and the permanent stand-down when the shared token can be neither read nor created), the handshake (the three frames over a raw socket with the token never on the wire, a wrong-token proof dropped, a proof replayed from another connection rejected, and a squatter that took the path being served nothing), the socket directory being kept private, cross-window directory and surface ops, provider-local handles for colliding PTY ids, PTY routing and streaming with two viewers, route survival across unsubscribe and re-attach, what a disconnect does to in-flight terminals, forwarded commands, and requests still outstanding against it, and that a client whose socket died reports *unsettled* before its `close` lands, so it agrees with `forwardCommand`.
- **`peer-link-protocol.test.ts`** is that link's socket-free half: frame shapes and framing (splits, oversized frames, malformed lines), the PTY routing table, the handshake proof primitives, and the guard that keeps `PEER_REPLY_BUDGET_MS` strictly larger than the `ASK_BUDGET_MS` fan-out it contains.
- **`remote-host.test.ts`** covers the VS Code half of the service: `VsCodeHostStateStore` round-tripping through the stubbed `SecretStorage`/`globalState` (including reading what the webview-resident Host left behind, re-reading after a cross-window change, and serializing ACL snapshots), the enroll bootstrap, commands held while the contention settles and refused at once when it can never settle, the read-only commands answered exactly as a real un-enrolled `RemoteHostService` answers them, contending when another window enrolls, command forwarding and answering, the status event a joining window is greeted with, the relay-socket factory's `ws` fallback, and the provider's streaming, duplicate restored-id owner binding, asking, and directory invalidation.
- **`message-router.test.ts`** covers the in-window fan-out with the link and the service stubbed out: one answer counted per webview however many it sends, and a late answer for a settled request marking the directory stale instead of being dropped.
- **`processed-pty-streams.test.ts`** covers the window's one keyed registry: exactly one listener pair however many attachments exist, none at all with none, per-PTY fan-out, and teardown on exit.
- **`helpers.ts`** holds what the socket suites need — a throwaway `globalStorageUri`, the mirrored socket-path derivation, a poll-with-deadline, `freshModule`, and `fakeWindow`, one window as the link sees it.

Separate module instances come from `vi.resetModules()` plus a dynamic import, which is what makes one process able to play two windows.

Not covered: anything needing the real editor — command registration, webview hosting, the theme observer. Those would need `@vscode/test-electron`.

### Build and development

Source of truth:

| Scope | Source | Covers |
| --- | --- | --- |
| Root commands | `package.json` | `pnpm build:vscode`, `pnpm dogfood:vscode` orchestration |
| Extension scripts | `vscode-ext/package.json` | `build:frontend`, `build`, `typecheck`, `test`, `dogfood` package-local steps |
| Typecheck config | `vscode-ext/tsconfig.json` | check-only program; `tsc` never emits here |
| F5 launch | `.vscode/launch.json` + `.vscode/tasks.json` | Extension Development Host debugging chain |

**The build does not typecheck.** `pnpm build` bundles with esbuild, which strips
types without checking them, so `tsc` runs separately as `pnpm typecheck` — wired
into the package's `test` script so the root `pnpm test` covers it. This is the
package's only automated check; it exists because a reference to a deleted function
once reached a commit and surfaced as a runtime throw during `deactivate()`, which
has no `try`/`catch` and would have skipped every teardown step behind it.

The checked program deliberately spans two runtimes: `src/` is extension-host Node
code, but it imports shared modules from `../lib/src/`, some of which are webview
code. The config therefore carries both DOM and Node libs — looser than either
environment alone, with each side checked precisely by its own project
(`lib/tsconfig.app.json` for the webview). What it reliably catches is vscode-ext's
own code referring to something that no longer exists.

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
