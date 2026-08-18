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
├── remote-host-store.ts      — SecretStorage/globalState backing for the webview's remote-Host keys
├── window-lease.ts           — cross-window Host lease: heartbeat record in globalStorageUri
├── peer-link.ts              — socket between windows: broker serves, other windows report in
│                             (peer-surface brokering lives in message-router.ts)
├── watch-dir-file.ts         — fs.watch on one file, degrading to no watcher instead of an uncaught error
├── (../scripts/esbuild.mjs)  — outside src/: extension + pty-host bundles; bakes the webview's remote `connect-src`
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
    ├── activity-monitor.ts       — silence/output pattern detection for alert
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

The remote-server `connect-src` sources are a build-time constant, not a runtime value: `vscode-ext/scripts/esbuild.mjs` substitutes `__DORMOUSE_REMOTE_CONNECT_SRC__` into the bundle, defaulting to the SaaS origin (`https://*.dormouse.sh wss://*.dormouse.sh`). Without them a VS Code Host cannot hold its `/ws/host` socket at all. A selfhoster widens it for their own build with `DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode` — the same variable and the same per-build opt-in as the standalone binary (`docs/specs/server.md` → "Host webview CSP"). It is a `declare const` rather than an import so the value is a literal in the bundle and nothing at runtime can move it.

`unsafe-inline` for styles is needed because VS Code injects theme CSS variables via inline styles on the body element. Scripts remain nonce-gated, with a fresh per-render nonce of 24 CSPRNG bytes (`node:crypto` `randomBytes`) base64url-encoded to 32 characters — a nonce that is guessable is a nonce that is not there, so `Math.random()` is not acceptable here. The webview HTML is built by Vite from the `lib` package, then at runtime `webview-html.ts` rewrites asset URLs to webview URIs, injects the CSP meta tag, applies nonces to all script tags, and injects initial state via a nonce-gated inline script.

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

### Remote Host: store and lease

VS Code is a first-class remote Host. Two things have to be true that standalone gets for free, because standalone is one webview per app and VS Code is many webviews over one extension host.

**The store.** The Host's enrollment (`{ serverUrl, hostId, hostToken, origin, rpId }`) and its ACL persist through `local-json-store`, which defaults to `localStorage`. That is wrong here twice over: webview `localStorage` is not VS Code's persistence story, and `hostToken` is a bearer credential that grants the `/ws/host` socket. So the webview claims the `dormouse.remote-host.` prefix and backs it with the extension host — enrollment in `SecretStorage` (OS keychain), ACL in `globalState`, both global because a Host identity belongs to the machine and not to a folder.

`local-json-store` is synchronous by contract, so the store is pulled across at boot and installed as an in-memory, write-through backend. First paint deliberately does not wait on it: the read is gated on an OS keychain unlock, and a blank terminal for that long reads as a hang. The real constraint is narrower — hydrated before anything reads a `dormouse.remote-host.` key — so `lib/src/main.tsx` starts the read and publishes it with `setHostStoreReady`, and the lazily-mounted `RemotePairingModalHost` awaits `hostStoreReady()` before calling `installRemoteHostConsoleHook`. A read that never answers installs an empty cache and warns: the Host reads as un-enrolled, which is fail-safe for the data but would otherwise be silent.

A broadcast that lands while a webview is still hydrating is buffered and applied on top of the snapshot, because the host reads `globalState` before it waits on the keychain — so the snapshot in flight can be older than a write that has already committed.

Both sides gate on the prefix. The webview names the keys, so `remote-host-store.ts` refuses any key outside the Host namespace and caps values at 64 KiB; a compromised webview can neither read nor write unrelated extension state.

A boot-time snapshot alone would be wrong, because the lease hands the Host between webviews and windows: a webview that hydrated before another approved a pairing could later take the lease, read its stale ACL, and write that back — dropping the pairing permanently. A committed write is therefore broadcast to every webview in its window (`store:changed`) and applied to each cache. Before a newly elected window grants the webview-level Host role, it also rereads the whole prefix and sends every webview a replacement `store:snapshot`; the snapshot is ordered before the `singleton:lease { held: true }` grant and clears keys deleted by the previous holder. The per-write broadcast goes to the writer too; re-applying your own write is a no-op, and skipping self would mean identifying it. Only writes that actually happened are announced, which is why `writeStore` returns whether it wrote.

Source of truth: `vscode-ext/src/remote-host-store.ts`, `lib/src/lib/platform/vscode-adapter.ts` (`hydrateScopedStore`), `lib/src/lib/local-json-store.ts` (prefix claims), `lib/src/remote/host/store.ts` (the shared prefix).

**The lease.** A window can show a `WebviewView` and any number of `WebviewPanel`s at once. Each mounts the same Wall, so each would start its own `RemoteHost` against the same enrollment — they would displace each other on the single `/ws/host` socket (`server/test/relay-displaced.test.mjs`) and each would arm its own alarm push. The extension host arbitrates instead, because it is the only party that sees every webview and outlives each one: `message-router.ts` grants the named role `remote-host` to the first claimant and re-offers it when the holder is disposed, so closing the Dormouse view hands the Host to another open one rather than dropping it until a reload.

On the webview side `activation.ts` starts un-owned whenever the adapter offers `peers`, so two webviews racing to mount cannot both activate before the first answer arrives. Adapters without it (standalone, the website) are single-instance and stay owned from the start. Having peers at all is exactly the condition that needs arbitrating, which is why the role lease and the sibling RPC hang off one optional member (`PeerBridge`) rather than two that a host could implement half of.

**Across windows.** The election above is per-window, because the extension host is — but the enrollment it guards is machine-wide, so window-local arbitration alone is not enough. Left there, every window would elect its own Host, all of them would connect `/ws/host` with the same enrollment, and the server would close the displaced socket (`server/src/relay.ts`) whose `close` handler reconnects and displaces the next one: an endless fight, with each window arming its own alarm push.

So there is a second tier. A window may grant the role only while it holds a lease recorded in the extension's `globalStorageUri` — per-extension, shared by every window, and (unlike `globalState`) with no cross-window change event to depend on, so ownership is a heartbeat with a TTL rather than a flag. The holder re-stamps every 5s; a record unstamped for 15s is free. That TTL is what recovers the role from a window that died without running its disposables; a clean dispose deletes the record so the handoff is prompt, and a filesystem watcher makes the next window notice without waiting for its poll. Both watchers in the extension — this one and the rendezvous — go through `watch-dir-file.ts`, which turns either kind of `fs.watch` failure (refused up front, or an `'error'` event later, which an unheard `EventEmitter` rethrows and would kill the extension host) into no watcher at all; that is safe precisely because each caller's timer converges on its own.
The watcher is only an accelerator: construction failures and later asynchronous
`error` events close and clear it, while the interval continues to arbitrate.

A fresh claim is confirmed by re-reading: two windows can judge the same record stale in the same instant and both write, and the loser must not believe it won. Renewing skips that round trip, since the record already named the renewer. A heartbeat stamped far in the *future* counts as stale too — otherwise a clock jump would lock every window out of the role until the skew elapsed.

Losing the window lease is not merely losing the right to be re-offered the role: any webview holding it is told `held: false` and stops its Host. That is the one path that sends a revocation, and it is why the lease is a boolean rather than a one-way grant.

Nothing here starts until a hydrated webview finds a persisted enrollment, or
a first enrollment succeeds and initiates the claim. A user who never enrolls
a Host therefore gets no heartbeat file, timer, or peer socket merely by
opening Dormouse.

Source of truth: the rules and the cycle in `lib/src/lib/vscode-window-lease.ts` (tested in `lib/src/lib/vscode-window-lease.test.ts`), the filesystem and timers around them in `vscode-ext/src/window-lease.ts`, and `windowLeaseHeld` gating `electSingleton` in `vscode-ext/src/message-router.ts`.

Source of truth: the `SingletonClaimant` arbiter in `vscode-ext/src/message-router.ts`, `PeerBridge.claimSingleton` in `lib/src/lib/platform/types.ts`, `setRemoteHostOwnership` in `lib/src/remote/host/activation.ts`, tested in `lib/src/remote/host/activation.test.ts`.

**Lifetime.** The Host lives as long as a Dormouse webview exists in the window. `retainContextWhenHidden: true` is set on both hosting modes, so hiding the panel keeps it connected; only disposing every Dormouse view, or closing the window, takes it offline.

### Peer surfaces

The Host runs in one webview, but a window's terminals are spread across all of them: each webview is its own JS realm with its own xterm registry (`lib/src/lib/terminal-store.ts`). Left alone the phone would see one webview's panes — not the window's — because `collectDirectorySnapshot` iterates the local registry and `surface.attach` resolves against it.

The extension host brokers, since it is the only party that can see every webview. Three things make it work, and two of them were already true:

- **PTY input and resize are not ownership-gated.** `pty:input` and `pty:resize` go straight to `ptyManager`, so the Host webview can already drive a sibling's PTY.
- **Pane ids are unique across webviews.** They are minted `pane-<counter>-<random>` (`lib/src/components/Wall.tsx`), so surface ids need no namespacing to be routed.
- **Streaming needed one change.** `pty:data` and `pty:exit` were delivered only to the owning webview; a webview may now also `pty:subscribe` to a PTY it does not own. Subscriptions are tracked separately from `ownedPtyIds`, so they never affect Workspace union status, `killOnDispose`, or who the host considers the owner. Semantic events stay owner-only — they drive the owner's pane state, and a subscriber is streaming bytes plus process lifetime, not keeping a second copy of that state.

Every webview installs a responder (`lib/src/remote/host/peer-surfaces.ts`) whether or not it is the Host, so its terminals are reachable from whichever one is. It carries none of the relay, enrollment, or pairing machinery — a registry lookup, the directory collector, and a resize.

**One generic seam, one fan-out rule.** A peer request is `(op, params)` and an answer is *zero or more results*; that is the whole contract the adapter, the extension-host broker, and the cross-window socket implement. `op` is opaque to all three, because *what* a peer may be asked belongs to the remote Host and not to the transport: the operation map — `directory` and `surfaceOp`, with their real parameter and result types — lives in `lib/src/remote/host/peer-surfaces.ts` alongside the responder that answers them, so adding an operation is one entry there plus its caller, not a parallel ladder of types at every layer.

Absence *is* the miss: a webview that owns nothing the request named answers with no results, so there is no `ok` flag anywhere and every field of a result that does come back is required. Every webview answers regardless, which is what lets the broker settle a fan-out as fast on a miss as on a hit; it settles when all of them have replied or a 1s budget expires, so a webview with no live content cannot hang the picker.

The one field the transport itself reads out of an answer is a reserved `ptyId` (`routedPtyId`): an answer naming a PTY is claiming it, which is how the cross-window broker learns which window that PTY lives in. Nothing else about an answer is interpreted below the Host.

Peer query results are snapshots, so the same bridge carries generic topic
invalidations. Every webview announces `directory` when local pane state,
activity, or focus changes; webview/window membership changes invalidate all
topics. The Host subscribes to that topic and coalesces a fresh fan-out rather
than retaining the old directory indefinitely.

`attach` and `resize` on a foreign surface go to the owner rather than to the PTY, because attach-is-the-resize has to drive the live xterm or the owning pane's own view drifts from the size the phone set. The owner replies with the size it settled at and the `ptyId`; the Host then subscribes and streams. `detach` has nothing to undo on the owner — the Host stops streaming and the pane keeps its size, which is what last-attach-wins means.

**Which webview owns a pane never reaches the protocol layer.** `resolveSurface(surfaceId, size)` answers with a `SurfaceHandle` — `ptyId`, the size it stands at, `resize`, `release` — or `null` if nobody owns it, and `remote-api.ts` holds one of those per attachment. That is the same trick the rest of the feature already plays: foreign `pty:data` is injected into the ordinary data path and `pty:input` / `pty:resize` route by table before falling back to the local manager, so `terminal.write` has no branch either. It makes local attach asynchronous too, which is the honest shape — a pane in another window *is* a round trip away, and the alternative was one path that answered synchronously and one that did not.

Resolving a peer's surface *is* the attach: the requested size travels with it, because the owner has to apply it inside that round trip — there is no reaching into its xterm afterwards without a second one. A local pane is left alone at resolve and resized by the caller, which subscribes to the PTY first so a synchronous repaint is not lost. Either way the handle reports the size as it stands and the caller reconciles, which is why the same-size repaint bounce fires for a peer attach (its owner already applied the size) and the resize path fires for a local one.

Subscribing is a subscription, not a pair of calls: `peers.streamPty(ptyId)` returns its own unsubscribe, so a caller cannot leak a stream by losing track of the id it opened it with.
The router reference-counts those handles per PTY: only zero-to-one starts
cross-window forwarding and only one-to-zero stops it, so detaching one of two
concurrent viewers cannot silence the other.
Router disposal releases every still-counted cross-window PTY once before
clearing the counts, so document teardown cannot leave an owner forwarding to
a webview that no longer exists.

The directory emits **twice**: the local entries immediately, then a merged snapshot once the peers answer. The phone should not wait on a round trip to see the panes that are already here.

### Peer surfaces across windows

The same problem one level out, and it cannot be solved the same way: VS Code runs one extension host per window, so there is no shared process to broker through. The window holding the Host lease therefore listens on a local socket and every other window connects to it.

The lease makes this one-directional. Because the webview lease is gated on the window lease, the broker window *is* the Host window — so the broker never has to relay a request back out to a remote Host, and a peer window only ever answers.

Roles follow the lease: acquire it and the window starts serving and publishes a rendezvous file (`remote-host.peer.json`, mode 0600, in `globalStorageUri`) naming the socket path and a token; lose it and the window tears the server down and connects as a client instead. Clients watch that file, so a handover does not wait out the reconnect backoff. Neither transition is instant — serving binds a socket and then writes and renames the rendezvous, standing down tears that back down — so a flip can land inside one, and each direction re-checks the role it is transitioning into before its last step: the broker claims the server slot in the same tick it decides to serve and abandons a half-started server rather than publishing a rendezvous naming a socket the teardown already unlinked (peers would dial it, fail, and back off until a later broker rewrote the file), and the client side skips installing the rendezvous watcher if it is the broker again by the time its teardown finishes (a broker watching would wake on its own writes). The socket lives in the temp dir rather than beside the rendezvous file because macOS caps a unix socket path near 104 bytes and the extension's `globalStorage` path is most of that on its own.

The first arbitration result is a role transition even when it is `false`: a
window that starts while another owns the lease immediately enters the client
role and watches/connects to that broker.

A peer window answers a `request` frame by running its **own in-window** fan-out — never the cross-window one, or a request would loop back out. That is why `configurePeerLink` is handed only `brokerRequest`, and why the link is injected with what it needs rather than importing the router (which imports the link).

Both tiers are asked at once rather than one after the other: what is asked about lives in exactly one webview of one window, and asking in series would pay a whole tier's budget — or a hung window's — before reaching the tier that owns it.

Once an answer names a `ptyId` the broker records which window it came from, because a PTY id says nothing about where it lives and input and resizes have to reach that window. `pty:input` and `pty:resize` consult that table first and fall back to the local `ptyManager`; `pty:subscribe` asks the owning window to start streaming, and its bytes are injected into the subscriber's normal `pty:data` path, so the Host webview cannot tell a remote terminal from a local one. When a peer disconnects, every PTY routed to it is dropped and reported as exited — a terminal in a closed window is gone, and a later write must not be posted into a dead socket.

Trust: the socket is user-owned, its path is published only in a mode-0600 file, and a client's first frame must carry the token from that file — the same bar as the `dor` control socket.

Socket bind errors reject startup and are handled as an unavailable peer link;
they never leave the listen promise pending or surface as an uncaught extension
host error.

Source of truth: `vscode-ext/src/peer-link.ts` for the sockets and roles, `lib/src/lib/vscode-peer-link-protocol.ts` for the frames, framing, and PTY routing table (tested in `lib/src/lib/vscode-peer-link-protocol.test.ts`), and the `remote*` calls in `vscode-ext/src/message-router.ts`.

Source of truth: the broker in `vscode-ext/src/message-router.ts` (`brokerRequest`, the `peer:*` cases, `subscribedPtyIds`), `PeerBridge` in `lib/src/lib/platform/types.ts` with its VS Code implementation in `vscode-adapter.ts`, the operation map and responder in `lib/src/remote/host/peer-surfaces.ts`, the resolver in `lib/src/remote/host/surface-resolve.ts`, and the attachment it backs in `lib/src/remote/host/remote-api.ts`, tested in `lib/src/remote/host/peer-surfaces.test.ts`.

### Testing the extension host

`vscode-ext` runs vitest (`pnpm --filter dormouse test`, which typechecks first). The `vscode` module only exists inside a running editor, so `vitest.config.mts` aliases it to a stub providing just the output channel `log.ts` opens — most modules worth testing import `vscode` as `import type`, which erases.

The tests that matter here are the ones that need real I/O, since the pure halves already live in `lib`: `test/window-lease.test.ts` drives two module instances against a real directory (two windows contending, and a handover on dispose), and `test/peer-link.test.ts` stands up a broker and a peer over a real socket to cover the rendezvous handshake, a lease that flips back mid-startup, PTY routing, streaming, token rejection, and what a disconnect does to in-flight terminals. Separate module instances come from `vi.resetModules()` plus a dynamic import, which is what makes one process able to play two windows.

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
