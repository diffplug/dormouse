# Dormouse VS Code Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary.
>
> Owns the VS Code-specific layer: panel/view registration, persistence APIs, theme integration, CSP, the peer link between windows, build, and dream-architecture commands.
>
> Defers to `docs/specs/transport.md` for the PTY lifecycle, buffering, the reconnection sequence, the message protocol, persisted-session types, and the adapter-agnostic invariants VS Code shares with the standalone and fake adapters. That deferral holds for every section below and is not repeated per section.

## What's built

Two hosting modes: a `WebviewView` in the bottom panel (alongside Terminal, Problems, Output) and `WebviewPanel` editor tabs (via `dormouse.open`, multiple instances). Both restore across "Developer: Reload Window", via a `WebviewPanelSerializer` plus the `onWebviewPanel:dormouse` activation event. PTY lifecycle is fully decoupled from the webview — PTYs live in the extension host (`pty-manager.ts`), survive panel visibility toggling, and replay buffered output on **resume**. Scrollback is never persisted (`docs/specs/transport.md` → "Persistence policy"); instead `deactivate()` interrupts the live PTYs and records each pane's agent resume invocation, which the next cold restore auto-runs (`docs/specs/layout.md` → "Agent resume on cold restore").

The webview itself is the shared `lib/` frontend, unmodified for this host: see `docs/specs/layout.md` and `docs/specs/transport.md` for its modules. The only VS Code-specific pieces in `lib/` are `lib/src/lib/platform/vscode-adapter.ts` (the postMessage bridge), `lib/src/lib/vscode-message-token.ts`, and `lib/src/lib/vscode-keybindings.ts`.

### Invariants (VS Code-specific)

- **Capture, then save, then kill.** `deactivate()` runs the agent-recovery capture *first* and both kills *last*, with the state flush and the live-PTY refresh in between: the resume hint exists only between the interrupt and the kill, and CWD queries need live processes. Ordering under "Serialization and restore"; mechanics under "Capturing agent recovery". Source of truth: `extension.ts:deactivate()`.
- **Alert state is global.** A single `AlertManager` instance in `message-router.ts` is shared across all routers and survives router disposal. PTY data feeds into it at module level, regardless of webview visibility.
- **WATCHING rules are host-authoritative.** The first webview after extension-host startup seeds the shared host rule set and **no later webview may replace it**; edits are per-key mutations answered with a canonical broadcast. Channel and message names under "Workspaces".
- **Never let a resuming router steal another webview's PTYs.** Each router tracks its PTYs in `ownedPtyIds`; a module-level `globalOwnedPtyIds` set enforces it.
- **Every save path must merge current alert states.** Both the frontend periodic save (`onSaveState` callback) and the backend deactivate refresh (`refreshSavedSessionStateFromPtys`) call `mergeAlertStates` — missing it reverts alert state on restore.
- **retainContextWhenHidden.** Set on both `WebviewPanel` (editor tabs) and `WebviewView` (bottom panel) so xterm.js DOM, scrollback, and PTY subscriptions survive panel hide/show without going through a resume.
- **Two save sources must produce consistent state.** The frontend (debounced 500ms + 30s interval via `dormouse:saveState`) and the backend (deactivate flushes webviews then refreshes from live PTYs).
- **Every host → webview send carries the message token.** The webview's `window` is a shared inbox that framed surfaces can also post to, so the adapter drops any `message` that isn't stamped with the per-boot token, and **never add a `message` listener that skips `isHostMessage`** — that reopens the forgery hole. See "Webview message authentication" below.
- **Workbench keybindings mirror for selected chords.** `lib/src/lib/vscode-keybindings.ts` is the source of truth for the VS Code-hosted mirror allowlist. For `Ctrl/Cmd+P`, `Ctrl/Cmd+Shift+P`, `Ctrl/Cmd+B`, and `F1`, xterm still processes the key while the webview also posts `dormouse:runWorkbenchCommand`; `message-router.ts` validates that request against the same small command set before calling `vscode.commands.executeCommand`.

### Extension manifest

Source of truth: `vscode-ext/package.json`. Activation is limited to the contributed view and restored editor panels, so a window without either stays cold. The manifest contributes the panel container/view, the Focus/Open/Debug Theme/New Terminal/Select Shell commands, and the view-title actions; it owns their exact ids, titles, icons, and ordering.

There is no `configuration`, no `keybindings`, and no context key: Dormouse's settings live in its own in-webview Settings dialog rather than in `settings.json`, its chords are handled inside the webview (see the workbench-mirror invariant above), and nothing in the manifest is `when`-gated on Dormouse state. Context keys are [Future](#context-keys).

### Webview hosting

VS Code-specific layout of the transport model:

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

- Hiding or toggling the Dormouse panel neither kills its PTYs nor destroys sessions.
- **Closing an editor-tab `WebviewPanel` is not hiding it.** `setupPanel` attaches
  its router with `killOnDispose: true`, so disposal kills that panel's owned PTYs
  and VS Code discards the tab's per-panel state. The `WebviewView` router is
  attached without that flag: its `onDidDispose` releases the router and leaves the
  PTYs alive.
- Multiple VS Code windows each get their own extension host process, and therefore their own pty-host child process.

### Workspaces

> See `docs/specs/glossary.md` for the Workspace / Window containers and `docs/specs/alert.md` for the union status.
>
> Each webview's union is computed host-side and reflected onto native chrome (see "Surfacing union status" below). It is always-on: the extension host has no `localStorage` to read the standalone workspaces flag (a host-side gate is an open question — see [Future](#future)). The Window persistence container is standalone-only and does not touch VS Code, which keeps one bare `PersistedSession` per webview.

In VS Code, **one webview is one Workspace**. The bottom-panel `WebviewView` ("Dormouse") is the default Workspace; each `dormouse.open` editor-tab `WebviewPanel` is an independent Workspace. Unlike standalone, several Workspaces are visible at once, and VS Code — not Dormouse — owns their tabs, creation, and closing: opening a Dormouse editor tab creates a Workspace and closing the tab closes it, so Dormouse adds no create/rename/close affordances here. A webview owns the terminal Sessions whose PTYs its router tracks (`ownedPtyIds`, `docs/specs/transport.md`) plus any browser surfaces rendered in it; together those are the Workspace's Surfaces.

#### Surfacing union status on native chrome

The host computes each webview's union (`ringing` / `todo`) from the module-level `AlertManager` scoped to that router's `ownedPtyIds` (`computeWorkspaceUnion`), delivered via the `attachRouter` `onUnion` callback. Because `ownedPtyIds` are PTY-backed terminals, **VS Code chrome reflects terminal Session ring + TODO only**; a browser surface's TODO stays webview-local (the `alert:state` channel is keyed by PTY-backed Session ids; the webview→host Surface-state channel that would lift this is staged — see [Future](#future)).

The two hosting primitives expose different chrome, so each uses what it supports, following the in-app `<title> <bell> [TODO]` pattern where possible:

- **Editor tab (`WebviewPanel`):** `panel.title` gains the suffix — `Dormouse` + ` 🔔` (ringing) + ` [TODO]` (todo), both when both apply. The bell is an emoji stand-in for the in-app bell icon (a tab title is plain text); `[TODO]` is the bracketed word. `panel.iconPath` stays the Dormouse mascot. (`workspaceTitle` in `workspace-chrome.ts`.)
- **Panel view (`WebviewView`):** a presence **badge** — `view.badge.value = 1` whenever anything owes attention, `0` to clear it (ring-vs-TODO in the tooltip; `workspaceBadge`). `view.title` is *not* used: on this single-view **bottom-panel** container VS Code shows the static container title (`viewsContainers[].title`), which has no runtime API, so the title can't carry status — the badge is the only runtime indicator that surfaces. **Clear with `0`, not `undefined`:** VS Code hides a 0-value badge but does not clear one set to `undefined` on a panel container. `view.description` stays the shell name.

Reflection updates on every owned-PTY `AlertManager.onStateChange` and on `claim` / `release` (a webview gaining or losing a PTY). Source of truth: `attachRouter` `onUnion` / `notifyUnion` in `message-router.ts`; `extension.ts` (panel title), `webview-view-provider.ts` (view badge), `workspace-chrome.ts` (formatting).

WATCHING rules and the alarm settings (`docs/specs/alert.md` → Alarm settings)
are app-global rather than owned by one Workspace, so both ride a separate
host-authoritative channel of the same shape: each webview offers its persisted
copy (`alert:initializeWatchedCommands` / `alert:initializeSettings`), only the
first offer after extension-host startup seeds the shared host state, later edits
arrive as per-key mutations (`alert:setCommandWatched` / `alert:updateSettings`),
and every attached renderer receives the canonical full snapshot
(`alert:watchedCommands` / `alert:settings`). Two details are specific to the
settings: the host consumes only `inactivityTimeoutMs` (installed on the shared
`AlertManager`) yet relays the whole blob so renderer-only fields stay in sync
across webviews, and it **must revalidate** every inbound blob — these are
renderer-supplied numbers that become host timers.

Source of truth: `WatchedCommandHost` in `lib/src/lib/watched-command-host.ts`,
`AlertSettingsHost` in `lib/src/lib/alert-settings-host.ts`, and the alert cases
in `vscode-ext/src/message-router.ts`.

### Shell selection

The selected shell name is mirrored into the `WebviewView.description`, and `dormouse:selectedShell` keeps the webview's default-shell slot current for split/spawn/restore paths. `shell-selection.ts` reads `workspaceState` before `globalState` for `dormouse.selectedShellPath`, and a global save clears the workspace value so it cannot shadow the new default.

`dormouse.newTerminal` focuses the Dormouse view and posts `dormouse:newTerminal` with the currently selected shell; the shared Wall selects the new pane and enters passthrough immediately. `dormouse.selectShell` opens a QuickPick, saves the shell path globally or per workspace, applies the description/default-shell update, and, when the picked shell differs from the previous selection, focuses the view and posts `dormouse:newTerminal` with `replaceUntouched: true` and `announce: true`. The shared `Wall` logic then replaces only a selected untouched terminal in-place; touched terminals cause an additional pane to be spawned and focused in passthrough instead.

The QuickPick is the only shell control here: `VSCodeAdapter` sets the optional `hostOwnsShells` capability, so the shared Settings dialog hides its Shell row (mirroring `hostOwnsTheme` for the Theme row, §Theme integration).

### Serialization and restore

A `WebviewPanelSerializer` is registered under the `dormouse` view type so VS Code can restore editor panels after a restart; `onWebviewPanel:dormouse` is what activates the extension early enough for it to be there. The persisted shapes it round-trips (`PersistedSession` / `PersistedPane` / `PersistedAlertState` / `PersistedDoor`) are transport.md's.

**While running.** The frontend saves periodically — debounced 500 ms, plus a 30 s
heartbeat that only fires when something marked the session dirty — via
`dormouse:saveState`. The router's `onSaveState` merges in current alert states
(`mergeAlertStates()`), then the **WebviewView** writes `workspaceState`
(`dormouse.session`) while **WebviewPanels** persist through VS Code's per-panel
`vscode.setState()`, so several panels cannot clobber each other. **Alert state
must ride every save, not just teardown** — otherwise it does not survive an
extension host killed before `deactivate()` finishes.

**On deactivate**, in this order (`extension.ts:deactivate()`):

1. Kick off `closePoppedOutSessions()` — started here but joined after step 2, so
   its external-process time overlaps the capture instead of serializing behind it.
   Its rejections are absorbed: throwing out of the join would skip the flush, the
   refresh, and both kills, leaking the pty host.
2. `captureAgentRecoveryCommands(context, 1200)`.
3. `flushAllSessions(1000)` — ask every webview to save now, bounded.
4. `refreshSavedSessionStateFromPtys()` — re-read CWD while the processes are alive.
5. `gracefulKillAll(2000)` (SIGTERM, wait), then `killAll()` (force).

**Recovery must go first.** The resume hint exists only between the interrupt and
the kill, so nothing after step 5 can find it, and the shutdown budget is not ours
(rationale) — the one step whose data cannot be reconstructed afterwards runs
before the steps whose data can (cwd re-reads, alert merges).
`captureAgentRecoveryCommands` writes `^C` into every live PTY, waits bounded for
what they print, scans those buffers, and records the invocation to a file of its
own — `recovery.json` under `context.storageUri`, written synchronously and
replaced temp-then-rename. **Never `workspaceState`**, whose SQLite flush is
already tearing down by then (rationale), and **never
`PersistedPane.resumeCommand`**, which the later step-3 flush would overwrite with
the webview's stale copy. The record is rewritten the moment each command is
found, so being killed mid-poll costs at most a late agent's command; every wait
is bounded, and a timeout loses the recovery command rather than delaying
shutdown.

**On activate**, saved state is loaded and passed to routers for cold-start restore
via `readPersistedSession()` (defined in `docs/specs/transport.md`), which tolerates
both parsed objects and JSON-stringified blobs returned by VS Code state APIs. The
WebviewView and each deserialized WebviewPanel then claim the recovery commands
matching *their own* pane ids out of the single record written at teardown
(`docs/specs/transport.md` → "Consuming it"); neither container owns the record, so
resolving first cannot delete the other's commands. A panel's pane ids come from
the `vscode.setState()` blob VS Code hands back at `deserializeWebviewPanel`, so
recovery needs no host-side per-panel store.

#### Capturing agent recovery

**Write `^C` into the pty; never signal it.** The agents print their resume
invocation when interrupted, not when signalled (rationale). The tty line
discipline delivers SIGINT to the foreground process group itself — no
`tcgetpgrp`, no master fd node-pty does not expose, and a path that exists on
ConPTY too — the shell survives, and the hint arrives as ordinary `pty:data`.
**Interrupt every live PTY, not just recognized agents:** a foreground gate would
need per-pane command knowledge the host does not have, `^C` into a non-agent is
inert, `detectResumeCommand` is the real filter, and every one of these processes
is killed seconds later regardless. **Exclude exited PTYs** — they can neither
take a `^C` nor yield a hint, and including them would permanently defeat the
"nothing left to wait for" early exit.

**Press-wait-press, gated per pane.** The two agents want opposite things:
claude prints its hint only on a *second* press (after `Press Ctrl-C again to
exit`), while codex prints after the first — at a latency that is not a
constant — and a second press arriving mid-print destroys its hint entirely.
So: one `^C` to every live PTY, then poll on a 40 ms tick, sending one more
`^C` to a pane that has yielded nothing either the moment it asks
(`Press Ctrl-C again`) or once ~600 ms have passed with ~200 ms of silence —
quiet used as evidence that a print is not in flight, **not** as evidence the
pane is finished. Both clocks start when the first press is *acked*, not at
step entry: they are statements about the agent, and measuring from entry folds
the interrupt's own round trip into the window. The poll's ~1.2 s wall-clock
ceiling is the one timing anchored to entry, being a shutdown budget rather
than an agent timing. **Do not finish early on quiet**: codex says nothing for
~250 ms and then prints its entire shutdown at once, so silence is what it
looks like *before* it speaks, and the only sound early exit is having nothing
left to wait for (rationale). Polling to the ceiling is affordable because the
record is written eagerly. **The ask gate keys on an English UI string on
purpose:** a wording change loses claude's recovery visibly and recoverably,
where a mistimed window destroys codex's every single time.

**Never simplify to a single gesture.** A blanket second press destroys codex's
idle case; an ask-gated one never fires for codex at all, since `Press Ctrl-C
again` is a claude string. Codex is the constraining case — its `^C` is consumed
by the input line first — and the constants are sized against measurements in a
real pty (rationale) so that codex's idle case, which yields at 262 ms, leaves
the retry set before the ~600 ms fallback arrives.

**Only post-interrupt bytes count, and never widen that scan.** Each pane's
received-count mark (`getScrollbackReceived`, `docs/specs/transport.md` →
Universal invariants) is taken before the first `^C`, and detection reads only
what arrived after it. A correctness boundary, not an optimisation: the command
is executed on the next restore, so the only bytes allowed to become executable
state are the ones produced in response to Dormouse's own interrupt — scanning
the whole buffer let a stale hint or an old launch echo win, and widening it
again weakens the provenance argument that lets recovery auto-run without
confirmation (`docs/specs/transport.md` → "Consuming it"). It fails in the safe
direction: buffer eviction can only discard fresh output, never promote stale
output as fresh.

**Clear any previous record before the first early return.** Consumption happens
only when a container actually resolves, so a session where the Dormouse view is
never opened would otherwise carry the record forward and auto-run a week-old
invocation on some much later restore. One environment hazard:
`CLAUDE_CODE_CHILD_SESSION` in a pane's env disables transcript saving in claude,
which then prints no hint at all — a missing hint is ordinary, and a Dormouse
launched from inside a Claude Code session legitimately produces nothing.

Source of truth: `captureAgentRecoveryCommands` in
`vscode-ext/src/session-state.ts`, `interrupt` in
`vscode-ext/src/pty-manager.ts`.

### Theme integration

The two-layer token strategy (`--vscode-*` → semantic `--color-*`), the consumed-token resolver, and its registry defaults belong to `docs/specs/theme.md` (Runtime model). VS Code is the only host that supplies `--vscode-*` itself, so `lib/src/main.tsx` **must install** `installVscodeThemeVarResolver()` before React renders — it materializes only the *missing* Dormouse-consumed variables onto `body.style`, and `lib/src/theme.css` carries no hardcoded defaults or fallback chains to fall back on.

A `MutationObserver` in `lib/src/lib/terminal-theme.ts` watches for VS Code theme changes — class + style mutations on both `body` and `html` — and live-updates all xterm.js instances. The theme resolver has its own observer on the same roots and attributes (`lib/src/lib/themes/vscode-color-observer.ts`) so derived `--vscode-*` variables stay in sync before xterm rereads the terminal palette.

`dormouse.debugTheme` focuses the Dormouse WebviewView and posts
`dormouse:openThemeDebugger` to the webview; `VSCodeAdapter` converts that
message into the browser event the shared Theme Debugger consumes. The debugger
traces VS Code-exposed `--vscode-*` variables and Dormouse materialized
fallbacks, and does not read raw built-in VS Code theme files.

### OSC color query answering

TUIs query the terminal's foreground/background/cursor colors with `OSC 10/11/12 ; ?` to adapt their UI (see [terminal-escapes.md](terminal-escapes.md#supported-oscs)). Dormouse answers these from the active theme, but PTY parsing happens in the **extension host**, which has no DOM to read the theme from. So the webview pushes its resolved colors up: `VSCodeAdapter.pushThemeColors()` reads `getTerminalTheme()` and posts `dormouse:themeColors { foreground, background, cursor }` on `requestInit` and again whenever `onTerminalThemeChange` fires (the shared `terminal-theme.ts` observer). `message-router.ts` caches the latest colors and feeds them to every PTY's parser via a `TerminalColorProvider`, so the parser replies and consumes the query exactly like the standalone frontend adapter. Before the first push (or if a color is unparseable) the provider returns `null` and the query falls through to xterm.js. On Windows this also depends on `useConptyDll: true` so the query reaches the extension host at all — see [terminal-escapes.md](terminal-escapes.md#osc-color-queries-on-windows-require-the-bundled-conpty).

### CSP policy

Source of truth: `vscode-ext/src/webview-html.ts` assembles the CSP directives (`randomSecret()` + the directive list):

```
default-src 'none'
style-src   <cspSource> 'unsafe-inline'
script-src  'nonce-…' 'strict-dynamic'
font-src    <cspSource>
img-src     <cspSource> data: blob:
connect-src <cspSource> ws://127.0.0.1:* ws://localhost:*
frame-src   http://127.0.0.1:* http://localhost:*
```

`frame-src` exists because `dor iframe` frames its target through the loopback transparent proxy the extension host stands up, so the only origin ever embedded is loopback on an OS-assigned port; without the override the `default-src 'none'` fallback blocks the frame and leaves a blank white pane (`docs/specs/dor-browser.md`).

**The webview CSP carries no relay sources.** Its `connect-src` loopback `ws:` entries are for the agent-browser stream relay only — the remote Host holds its `/ws/host` socket from the *extension host*, which no CSP fences, so the origin allowlist is enforced there instead (see "Remote Host: a service in the extension host").

That allowlist is still a build-time constant, not a runtime value: `vscode-ext/scripts/esbuild.mjs` substitutes `__DORMOUSE_REMOTE_CONNECT_SRC__` into `dist/extension.js`, defaulting to the SaaS origin (`https://*.dormouse.sh wss://*.dormouse.sh`), and `assertConnectSrcBaked` fails the build if the define did not reach the bundle — a lost define would otherwise surface only as a Host silently using the shipped default. `lib/src/host/remote/connect-src.ts` reads it through `bakedConnectSrc()`, as a `declare const` rather than an import, so the value is a literal in the bundle and nothing at runtime can move it. A selfhoster widens it for their own build with `DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode` — the same variable and the same per-build opt-in as the standalone binary (`docs/specs/server.md` → "Where a Host may reach a relay server").

`unsafe-inline` for styles is needed because VS Code injects theme CSS variables via inline styles on the body element. Scripts remain nonce-gated, with a fresh per-render nonce of 24 CSPRNG bytes (`node:crypto` `randomBytes`) base64url-encoded to 32 characters — **never `Math.random()`**, since a guessable nonce is no nonce. The webview HTML is built by Vite from the `lib` package; at runtime `webview-html.ts` rewrites asset URLs to webview URIs, injects the CSP meta tag, swaps Vite's nonce placeholder for the real one, and appends a nonce-gated inline script carrying the boot globals (message token, initial state, selected shell, recovery commands).

**A nonce alone does not survive code splitting.** Vite splits the webview bundle, and `script-src` gates each way a chunk loads separately. Two mechanisms cover them, and the split is not negotiable — a nonce is **not** inherited through the module graph, and `'strict-dynamic'` does not vouch for a parser-started fetch:

- **Vite stamps the nonce** onto every tag it emits, via `html.cspNonce` in `vscode-ext/vite.config.ts` (the placeholder is `CSP_NONCE_PLACEHOLDER`, shared by the config and `webview-html.ts` from `vscode-ext/src/csp-nonce-placeholder.ts`). That covers the entry `<script>`, the `<link rel="modulepreload">` tags for its static imports, and the `<meta property="csp-nonce">` that Vite's own runtime preload helper reads before injecting a preload for a lazy chunk. Vite walks its output with a real HTML parser, so coverage follows the emitted shape rather than a regex's guess at it. `getWebviewHtml` then swaps the placeholder for that document's real nonce and **throws if the placeholder is absent** — an unmarked build would otherwise serve un-nonced scripts against a nonce-gated policy, which looks exactly like a blank panel.
- **`'strict-dynamic'` covers the fetches no tag represents:** the entry's own static imports and every lazy `import()`. It widens what an already-trusted script may *load*, never what may be *written into* the document, and nothing here grants `script-src 'unsafe-inline'`. It also makes host-source expressions inert, so adding `webview.cspSource` to `script-src` would be dead weight.

Get any of it wrong and the failure is remote from its cause: a blank panel, or a render error naming a chunk that is sitting on disk. The only direct evidence either way is a CSP violation in the webview console (**Developer: Open Webview Developer Tools**) — nothing reaches an extension-host log, and the extension itself activates normally.

CSP is enforced by Chromium, so none of this is observable from string inspection (rationale). Two checks cover it and **neither replaces the other** (rationale): `vscode-ext/test/webview-boot.smoketest.ts` loads the real bundle under the real policy in a real engine, and `vscode-ext/test/webview-html.test.ts` pins the transform against a fixture of real Vite output (assertions listed under "Testing the extension host").

**Keep `'strict-dynamic'`** even though no experiment shows it load-bearing (rationale): it is the mechanism CSP specifies for "a script the nonce vouched for may load more", and the alternative that happens to work would make the policy correct by accident.

### Webview message authentication

The CSP governs what the webview document may *load*. It says nothing about who may *message* it — and in VS Code the webview's `window` is a shared inbox. The extension host posts to it, and so can any framed surface (`dor iframe`, agent-browser; `docs/specs/dor-browser.md`) via `parent.postMessage`, which crosses origin and sandbox boundaries by design. Several inbound message types are consequential: `dor:controlRequest` becomes a `dormouse:control-request` event that `use-dor-control.ts` can turn into a `writePty` call, and the `pty:*` family drives what the user sees in a terminal. `event.data.type` is attacker-chosen, so it cannot be the thing that decides trust.

So host-originated messages are authenticated by a **per-boot message token**:

- `getWebviewHtml` mints one token per webview document — 24 CSPRNG bytes, base64url, from the same `randomSecret()` as the CSP nonce — injects it as `globalThis.__DORMOUSE_MESSAGE_TOKEN__` in the same nonce-gated inline script that seeds the other `__DORMOUSE_*` globals, and returns it alongside the HTML because the two are only meaningful together.
- `serveWebview` is the only way to put a document on a webview: it mints, assigns `webview.html`, and returns a `WebviewChannel` whose `post()` closes over that document's token. Minting and serving are therefore one step — a token cannot drift from the document carrying it, and re-serving yields a new token and a new channel. Nothing holds a token keyed by webview identity, so there is no cleanup.
- **Every** host → webview send goes through a channel, so bypassing the stamp is a type error rather than a convention to remember; only the two serve sites (`setupPanel`, `resolveWebviewView`) still hold a raw webview. `attachRouter` takes a `WebviewChannel` (not a `vscode.Webview`) and exposes `post()` as a local; `DormouseViewProvider` stores its channel and `postMessage` forwards to it, returning `false` before the view is served or after it disposes — the same undelivered signal the VS Code API gives for a dead webview, which the `dormouse:newTerminal` retry loop and `forwardDorControlRequest`'s rejection path already handle.
- `VSCodeAdapter` captures the token **once, at construction**, and both of its `message` listeners — the main dispatcher and the per-request reply listener inside `requestResponse` — call `isHostMessage(event.data, token)` before reading anything else, including `type`.

**Never swap the token for an `event.source` / `event.origin` check, and never reuse the CSP nonce as the token** — that nonce authorizes script execution, this token authenticates a message sender (rationale). Both live in the same injected markup and are equally readable by the top document; neither is reachable from a cross-origin frame.

The guard fails closed in both directions: a webview served without the global accepts nothing, and a host send without a token delivers nothing. Framed content cannot read the parent's globals cross-origin, so it cannot produce the token.

This is the same shape as the origin check the Wall already applies to messages from proxied iframes (`isProxyOrigin` in `lib/src/lib/iframe-proxy-registry.ts`, used by `use-wall-keyboard.ts`; `IframePanel.tsx` compares against its own resolved proxy origin) — the trust criterion lives next to the registry so each listener stays a one-line guard. Those listeners validate their own senders and are unaffected by the token; the token covers only the adapter's host channel.

Scope is VS Code. The standalone adapters receive the equivalent events over Tauri's `listen()` IPC and the dev harness's host WebSocket (`docs/specs/standalone.md`, `docs/specs/transport.md`), never `window.postMessage`, so they have no forgeable inbox to guard.

Source of truth: `lib/src/lib/vscode-message-token.ts` (constants + `isHostMessage`), `vscode-ext/src/webview-messaging.ts` (`WebviewChannel` + `serveWebview`), `vscode-ext/src/webview-html.ts` (mint + injection), `lib/src/lib/platform/vscode-adapter.ts` (both guards). Tests: the `host message authentication` block in `lib/src/lib/platform/vscode-adapter.test.ts`.

### Remote Host: a service in the extension host

VS Code is a first-class remote Host, and the Host is not a webview thing: the shared `RemoteHostService` (`lib/src/host/remote/`, specified in `docs/specs/remote-api.md`) runs in the extension host, the process that already owns the PTYs. This section covers what is VS Code's: where its state lives, which window runs it, and what the webviews still do.

A webview is a **surface responder plus UI**: it answers what its own panes are called and how big its terminals are, renders the pairing modal, and carries the `window.dormouseRemoteHost` console hook. Nothing a webview says can widen access — the ACL and the access decision never leave the extension host (`docs/specs/remote-security-model.md`).

**The store.** The Host's enrollment (`{ serverUrl, hostId, hostToken, origin, rpId }`) and its ACL are split by sensitivity: `hostToken` is a bearer credential that grants the `/ws/host` socket, so the enrollment goes to `SecretStorage` (OS keychain), while the ACL is public-key records with no secret in them and goes to `globalState`. Both are global rather than workspace-scoped, because a Host identity belongs to the machine and not to a folder.

The service reads both **in-process**, and the store interface (`HostStateStore`) is async because the places state lives are. The enrollment is read once and kept, since `SecretStorage` is a keychain round trip and both the activation probe and the service want the same answer.

**That memo must be invalidated across windows.** `SecretStorage` is shared by every window of an extension and `secrets.onDidChange` fires in all of them, so the store drops the memo whenever the enrollment key changes anywhere — without it a promoted broker could resurrect an enrollment another window cleared, or never see one another window created. The ACL is **not** memoized: it is read from `globalState` on every load, which is in-process and free. All mutations ride the shared serial queue under the store contract (`docs/specs/server.md` → "Host side"); a failed write rejects its caller but does not wedge later mutations. The same subscription lets a window that was un-enrolled at activation join a Host a sibling just created: `initRemoteHost` re-checks on the event and contends then, with no reload.

**Import the key names, never mirror them** — a key that drifted between the two sides would strand an enrollment that is still on disk. The keys and JSON values are the ones the webview-resident Host wrote before the service existed (`ENROLLMENT_KEY` in `lib/src/remote/host/store.ts`, `ACL_KEY_PREFIX` in `lib/src/remote/host/acl.ts`, one entry per `hostId` so a re-enrollment cannot inherit a stale ACL), so an already-enrolled installation is picked up with no migration step.

Source of truth: `VsCodeHostStateStore` in `vscode-ext/src/remote-host-store.ts` against the `HostStateStore` interface in `lib/src/host/remote/host-state-store.ts`.

**Which window: bind-as-lease.** One extension host runs per window, so left alone every enrolled window would start a Host against the same enrollment, all of them would connect `/ws/host`, and the server would close the displaced socket (`server/src/relay.ts`) whose `close` handler reconnects and displaces the next one — an endless fight, with each window arming its own alarm push.

Arbitration is therefore the socket itself: **the bind is the lease**. Every contending window tries to bind one fixed path — `<hash>.sock` inside a per-user `dormouse-peer-<uid>` directory in the temp dir, or `\\.\pipe\dormouse-peer-<hash>` on Windows — where the hash is derived from `context.globalStorageUri.fsPath`. Derived rather than random because it must be *the same* in every window; hashed rather than joined because macOS caps a unix socket path near 104 bytes and the globalStorage path is most of that alone. The winner is the broker and runs the service; everyone else connects to it as a client.

The invariants:

- **Roles never flip downward.** A broker is the broker for the rest of the process's life; there is no `onRole(false)` after a `true`, so the whole class of mid-transition races a TTL lease had — start serving, lose the lease, tear down, win it back while tearing down — is unrepresentable rather than handled. A client only ever changes role *upward*.
- **Contend on broker death, not on a timer.** When the broker exits, every client's socket closes and they all race to bind; exactly one wins, because `bind` is the arbiter. No TTL, no heartbeat file, no filesystem watcher.
- **A corpse is cleared, then the bind is re-checked.** `EADDRINUSE` → dial it → `ECONNREFUSED`/`ENOENT` means the path exists but nothing listens (a broker that died without unlinking). **Never unlink on the first refusal:** every client of that broker reaches the point at the same instant, so the unlink is jittered by up to `RECLAIM_JITTER_MS` and the path dialled **again** afterwards — one of them may have rebound it while we waited, and unlinking a live broker's socket would strand every window dialling it. Two windows can still find the same corpse, both unlink, and the second bind silently displaces the first, leaving the loser serving a socket no client can reach; nothing on the bind path detects that, so `stillOurs` re-stats the path after `RECLAIM_VERIFY_MS` and compares full filesystem identity — device, inode, and nanosecond change timestamp, **never inode alone**. A window whose socket identity was replaced, **or whose path has gone entirely**, stands down and the loop re-runs (per-platform reasoning at `stillOurs`).
- **A bind is not a role until it is believed.** Everything that answers "is this window the broker" — `ensurePeerNet`'s shortcut, `isPeerBroker`, `isPeerLinkSettled`, `remoteNotifyPeerChange` — reads `brokerConfirmed`, set only where `settle(true)` runs and cleared by `closeServer`. During the `RECLAIM_VERIFY_MS` window above the socket is bound but may still be given up, and a command landing inside it (an `enroll`, a `secrets.onDidChange`) that was told "broker" would start a service the stand-down path never tears down: two Hosts under one hostId, displacing each other on the relay forever. Unverified reads as unsettled, so such a command is held for the verdict instead.
- **Attempts are spaced.** A refused hello would otherwise turn reconnection into a spin, so the loop waits `RETRY_MS` between rounds, and a bind or connect that lands after disposal is undone rather than left to outlive its window.
- **Errors after `listen` are logged, not thrown.** A listening `net.Server` emits `'error'` for accept-time failures (EMFILE, a broken pipe), and an `EventEmitter` with no `'error'` listener rethrows out of a libuv callback — which would take the whole extension host down. `listenServer` installs a permanent logging listener the moment the bind succeeds; the sockets already accepted are unaffected, and a listener that has genuinely died is noticed by the windows that can no longer reach it.

**Trust.** The socket path is derived, not secret — it has to be the same in every window, so anything running as any user on the machine can compute it. Two layers stand between that and this installation's terminals.

*The directory.* On unix the sockets live in a `dormouse-peer-<uid>` directory created 0700, and before every bind and every connect it is `lstat`-ed and required to be a directory, owned by this uid, at exactly mode 0700, and not a symlink. A loose directory we own is tightened; anything else is somebody else's, no retry makes it ours, and the peer link stands down for good rather than spinning against it (callers waiting on the contention are released rather than left hanging). Windows named pipes carry their own ACL and skip this layer.

*The handshake.* The shared secret is a mode-0600 `remote-host.peer-token` in `globalStorageUri`, created once with an exclusive `wx` write rather than a rename so two windows starting together agree — the loser reads the winner's token instead of overwriting it under a client that already read the old one. `wx` creates the file before it writes the bytes, so the loser's read can land on a zero-length file. **Treat an empty read as *not yet written*, never as the token**: it is waited out (`TOKEN_WRITE_ATTEMPTS` × `TOKEN_WRITE_POLL_MS`), because an empty `serverToken` fails the hello check below for every peer and a broker never re-reads the token, so a window that adopted `''` would refuse the whole installation for its lifetime while every other window retried at `RETRY_MS` forever. Exhausting the wait means either a crash-left zero-length file or a `globalStorageUri` this process cannot read — the exclusive create answers `EEXIST` for a token path that is a *directory* or unreadable as much as for one another window owns — and neither is fixed by retrying, so it latches the same permanent stand-down as an unsafe socket directory rather than making every command wait out its queue budget on every attempt. The throw re-derives which case it was, because the caller's log line is the only diagnosis any of them gets. The token itself **never crosses the socket**; instead three frames prove mutual knowledge of it:

1. `challenge { nonce }` — the *server* speaks first, on accept. A client that has not yet seen proof of the token must not volunteer one into whatever bound the path.
2. `hello { nonce, proof }` — the client answers with `HMAC-SHA256(token, "client:" + serverNonce)` and a fresh nonce of its own.
3. `welcome { proof }` — the server verifies in constant time, then answers `HMAC-SHA256(token, "server:" + clientNonce)`.

**Domain-separate the two proofs (`client:` / `server:`)**: without it they are the same function of the same key, and a fake server could reflect the client's own proof back as its welcome. The client verifies the welcome **before** it sends or answers anything else — until then it forwards no notifies (they queue), answers no requests, streams no PTY, and forwards no commands, and a welcome it cannot verify closes the socket. So squatting the path buys nothing: the squatter gets one HMAC over a nonce it chose, which is not the token, and is served nothing. Fresh nonces per connection make a captured proof worthless on the next one. Parseable JSON values that are not frame objects are rejected on both ends, a first frame that is not a valid hello drops the socket, and each side bounds the opening handshake to `HANDSHAKE_BUDGET_MS` so a silent connection cannot live forever.

**Nothing starts until there is a Host to run.** Contention begins when activation finds an enrollment in `SecretStorage`, when `secrets.onDidChange` reports that another window created one, or on the first `enroll` command from any webview — the bootstrap for an un-enrolled machine. A user who never enrolls never sees a socket. The service also runs independently of webview lifetime: a broker window with zero Dormouse webviews still relays, contributing an empty directory of its own.

**A command that arrives mid-contention is held, not refused.** While the contention runs this window is neither a broker nor a client, and a bind plus a handshake is not instant. Refusing there would tell an enrolled machine's webview it has no Host seconds before it gets one, and the gates that arm on that answer would stay down. So commands queue (bounded at a dozen, oldest refused on overflow) and drain when a role settles — to the service if this window brokered, over the link if it did not. Each carries its own deadline, under the adapter's own 15 s timeout, so a contention that never settles still produces a reason rather than a timeout. `enroll` is the one command that may *start* the contention; everything else refuses only where there is genuinely nothing to reach.

Source of truth: `vscode-ext/src/remote-host.ts` (the service glue, provider, and command routing) and `ensurePeerNet` / `attempt` / `stillOurs` in `vscode-ext/src/peer-link.ts`, tested in `vscode-ext/test/remote-host.test.ts` and `vscode-ext/test/peer-link.test.ts`.

**The webview bridge.** A webview reaches the service over `RemoteHostLink` (`lib/src/lib/platform/types.ts`), implemented in `vscode-adapter.ts` on three messages: `remoteHost:command { rhId, cmd, params }` out, `remoteHost:result { rhId, result | error }` and `remoteHost:event { name, … }` back. Everything but those three `postMessage` shapes is the shared client in `lib/src/host/remote/link-client.ts`, so VS Code, Tauri, and the browser dev harness cannot settle a command differently.

Results are **broadcast to every webview in the window** rather than replied to one. That is safe because an `rhId` is minted with a per-adapter random tag and is therefore globally unique — only the adapter that asked holds a pending command for it — and it is what lets one correlation id serve both the in-window fan-out and the cross-window forward below.

Two events are pushed rather than answered: `pairing-queue` (the complete queue snapshot; the service is authoritative, so the mirror replaces rather than merges) and `status { enrolled }`. Because the queue is pushed only when it *changes*, the webview also asks for it once on every transition to enrolled — joining a Host that is already mid-pairing would otherwise show no modal at all until that pairing was answered somewhere else.

**Volunteering is enrollment-gated; answering is not.** Answering an ask is free — a webview replies and goes back to sleep — but *announcing* costs a crossing per pane-state change, activity change, and focus move, plus an activity-store subscription for ring watching, on a machine whose owner may never enroll. So the service announces `{ name: 'status', enrolled }` whenever its lifecycle changes that, and `armWhileEnrolled` (`lib/src/remote/host/enrolled-gate.ts`) arms the outbound half only while a Host exists, seeded by one `status` command at install time for a webview that opens after the enrollment. The seed cannot lose a race with the event: both travel the same ordered channel.

**The relay socket.** The supported `engines.vscode` range (`^1.85.0`) spans the Node boundary where `globalThis.WebSocket` appeared (rationale), so the service **must be constructed with a factory**: prefer `globalThis.WebSocket`, fall back to the bundled `ws`, whose socket satisfies exactly the surface `RemoteHost` reads (`send`, `close`, `readyState`, `addEventListener`, `message` events with `.data`, `close` events with `.code`). esbuild inlines `ws` lazily; its optional native accelerators `bufferutil` / `utf-8-validate` are marked external and are neither installed nor shipped — a `.node` addon cannot be bundled — so `ws` falls through its own `try`/`catch` to the JS paths. Source of truth: `createRelaySocket` in `vscode-ext/src/remote-host.ts`, the `external` list in `vscode-ext/scripts/esbuild.mjs`.

**Lifetime.** Hiding a panel keeps its terminals answerable (`retainContextWhenHidden`, above), and closing every Dormouse view does not take the Host offline — the service outlives them all.

### Peer surfaces

The service owns the PTYs but not the *view* of them: a window's terminals are spread across however many webviews are open, and each webview is its own JS realm with its own xterm registry (`lib/src/lib/terminal-store.ts`). Only a webview knows what a pane is called, whether it is focused, and how big its xterm is. So the service asks, and every webview answers for its own.

| Contract | In-window tier | Cross-window tier |
|---|---|---|
| Query | `brokerRequest` posts `peer:ask` to every live webview and collects `peer:answer`. | Broker sends `request` to every peer; each peer runs its own `brokerRequest`, never `askBothTiers`, and returns `result`. |
| Operation schema | `(op, params) → zero or more results`; transport treats `op` as opaque. The typed operation map lives only in `peer-surfaces.ts`. | Same generic seam; only a reserved `ptyId` is interpreted for routing. |
| Ownership / miss | Presence is ownership; every webview answers, including with no results. | Every peer answers; disconnect settles its pending asks empty. |
| Fan-out order | All webviews run in parallel. | `askBothTiers` runs local and all peer windows in parallel, concatenating local first. |
| Budget | `ASK_BUDGET_MS` (1s); disposal removes that webview from the outstanding set. | `PEER_REPLY_BUDGET_MS` includes the inner ask plus socket hops and **must remain larger** (guarded by `peer-link-protocol.test.ts`). |
| Invalidation | `peer:notify` carries no subject; pane/activity/focus bursts coalesce before crossing. | `notify`, webview membership, and peer membership trigger the same fresh directory collect. |
| PTY stream | One window-wide keyed registry distributes already-processed data/exit. | Opaque routed handles select one peer; `subscribe` is reference-counted and streams the same processed data/exit. |
| Host command | This window calls its service and broadcasts the uniquely correlated result to its webviews. | `command` goes to the broker, `commandResult` returns only to its origin window, and `uiEvent` broadcasts. |

Every webview installs the responder (`installPeerSurfaceResponder` in `lib/src/remote/host/peer-surfaces.ts`, wired from `lib/src/main.tsx`) whether or not its window is the broker. It carries none of the relay, enrollment, or pairing machinery — a registry lookup, the directory collector, a read-only surface resolve, and a resize. Installing is idempotent *per link*: answering already is (a responder replaces the one before it), but the announcing half is not — each install adds a `status` subscription, and each arming under it adds pane-state, activity, and focus listeners with no handle left to remove them, so a second call would cross into the Host's process twice per change forever. Keyed by the link rather than a flag, because the platform adapter is what owns one.

**Each webview counts once, and a late answer repairs the snapshot.** The router removes a webview from the outstanding set *before* taking its results, so a duplicate answer cannot contribute the same panes twice. An answer for a request that has already settled — the budget expired while that webview was busy — arrives after the Host rendered a directory missing whatever it owns, and nothing can re-open a settled request; so it triggers a directory invalidation instead, and the next collect asks again and repairs it. Without that an idle machine has no other reason to re-collect and the phone's picker stays wrong indefinitely. The sidecar's ask bridge does the same on an answer for an ask it no longer holds (`docs/specs/standalone.md`).

**A peer answer belongs to the authenticated broker socket that asked for it.**
If that broker disappears while a webview fan-out is pending, the answer is
dropped even when this window has already connected to a replacement: request
ids restart per broker, so forwarding the old result through the new socket
could satisfy unrelated work that reused the same id. A rejected fan-out is
contained in the peer handler and contributes an empty answer rather than an
unhandled extension-host rejection.

The one field the transport itself reads out of an answer is a reserved `ptyId` (`routedPtyId`): an answer naming a PTY is claiming it, which is how the cross-window broker learns which window that PTY lives in. Nothing else about an answer is interpreted below the Host.

Directory answers are snapshots, so `notifyDirectoryChanged` coalesces a fresh
collect rather than retaining the old one. The webview also coalesces its source
bursts on one microtask; a focus move alone emits `focusout` plus `focusin` but
is worth one crossing.

**Attach-is-the-resize goes through the live xterm.** `attach` and `resize` are the same mutating operation on the owner (`docs/specs/remote-api.md`), and both drive the owner's xterm rather than the PTY directly, so the owning pane's own view stays consistent with the size the phone asked for. Cross-window attach first fans out a read-only `resolve`, selects its first answer, then sends the mutating `attach` only to that answer's tier and peer; duplicated cold-restored windows therefore do not both resize before one is selected. The owner replies with the size it settled at plus the `ptyId`; the service then streams that PTY. There is no `detach` op — the service stops streaming on its side and the pane keeps whatever size it was left at, which is what last-attach-wins means.

**Which webview owns a pane never reaches the protocol layer.** `resolveSurface`/`SurfaceHandle` are defined in `docs/specs/remote-api.md`, and the ask-backed half of the provider is shared with standalone (`createAskSurfaceProvider`). What is VS Code's: one surface normally has one owner, so the first read-only resolve answer is the answer; when duplicated cold-restored windows temporarily answer for the same ids, the mutating attach and every later handle resize are addressed only to that selected tier/window. A resize nobody answered leaves the last known size standing.

**No second strip parser.** The extension host already runs the terminal-protocol parser once per PTY chunk and answers its queries (`message-router.ts`); webviews receive the stripped `visibleData` via `onProcessedPtyData` / `onProcessedPtyExit`, and that is exactly what the service's `streamPty` taps. A second parser here would answer every query twice and corrupt the PTY. (The sidecar, which hands raw bytes to its webview's own parser, does strip — `docs/specs/standalone.md`.)

Local streams go through **one keyed registry and one listener pair for the whole window**, shared by the Host provider and the peer-link forwarder and dispatching by id to registered sinks. These listeners run on every chunk of every terminal, so separate or per-attachment pairs would tax every keystroke of every PTY once per consumer. The pair is installed on the first attachment and removed when the last one goes, so a window with no remote viewer pays nothing. Source of truth: `vscode-ext/src/processed-pty-streams.ts`.

### Peer surfaces across windows

VS Code runs one extension host per window, so the broker window listens on the
authenticated local socket and every other window connects. Local results
precede remote results; the directory deduplicates by `surfaceId` and attach
selects the first answer in that same order, so a duplicated cold-restored id is
shown from the owner attach will reach (`createAskSurfaceProvider`).

**Cross-window streams are reference-counted per routed PTY.** Two attachments to the same foreign surface share one `subscribe` frame; only zero-to-one starts the owner forwarding and only one-to-zero stops it, so a second viewer never restarts a live stream and one viewer detaching cannot silence the other. The owner answers the first `subscribe` with `subscribed` only after its sink and atomic liveness check are installed. A recorded exit is sent first on the same ordered socket, and the remote API waits for `subscribed`, so an exit that landed during surface resolution cannot be overtaken by a successful attach response. The last unsubscribe stops the forwarding but **keeps the route**: "nobody is watching it" is not "it moved". Re-attaching an already-attached surface resolves the new route first and only then tears the old attachment down, so dropping the route on unsubscribe would delete the fresh one and strand every later write. Routes are refreshed by every resolve and dropped by the two events that really mean the terminal is gone — an `exit` frame, and the owning window disconnecting (`forgetPeerRoutes`).

Once an answer names a `ptyId`, the broker replaces that owner-local id with a stable opaque route handle for the `(peer socket, ptyId)` pair before returning the result. **Never key routes by a raw `ptyId`:** pane and PTY ids are unique only within a window, and "Duplicate Workspace in New Window" can cold-restore identical surface and PTY ids into several of them, so a `ptyId → latest answering peer` table would acknowledge the first surface answer while streaming and writing to the last. The selected `SurfaceHandle` instead retains its peer-specific routing key; follow-up surface asks address that peer alone, while `subscribe`, `write`, and PTY-only `resize` translate it back to the owner's real id only on that socket. The generated key is checked against this window's PTYs and remains in the peer namespace after its route closes, so a stale handle fails closed rather than falling through to a later local PTY collision. When a peer disconnects, every handle routed to it is dropped and reported as exited (`forgetPeerRoutes`) — a terminal in a closed window is gone, and a later write must not be posted into a dead socket.

**Never send a result both ways.** The broker keeps a `commandRoutes` table of which window is owed each in-flight `rhId`; an answer with an entry goes to that socket alone, and one without goes to this window's webviews. Broadcasting another window's answer would settle nothing anywhere (ids are globally unique) and would put that window's Host state in front of webviews that never asked. A window that disconnects has its outstanding routes dropped and its commands left unanswered — the socket that would carry the answer is the one that closed, and the asking adapter's own timeout is the backstop. It also has whatever the broker was still *asking* it settled empty on the spot, rather than left to spend the full `PEER_REPLY_BUDGET_MS`: a directory or an attach every surviving window already answered must not stall behind a window that is already gone, and "gone" and "owns nothing" look the same to the caller. A `result` frame is taken only from the window the request was put to, since ids are per-broker.

Pairing UI events are the opposite: unaddressed and broadcast to every window's webviews, because the approval modal must appear wherever the user happens to be looking.

**A window with no Host at all still answers the read-only commands.** Reaching the terminal refusal means this window sees no enrollment — it contends when one exists and again the moment another window writes one — so that is the ordinary un-enrolled state, not a failure. `status`, `pushDevices`, and `pairingQueue` are therefore answered with exactly what an idle service returns (the un-enrolled `RemoteHostConsoleStatus`, `null`, `[]`), because each caller reads the difference: `pushDevices` answers `null` for "nowhere to push" and rejects only when the server could not be asked — refusing instead misreports an unreachable server on a machine that simply never enrolled (rationale) — and `enrolled-gate.ts` seeds itself from `status`. Everything else refuses with an error rather than dropping it, so the console hook fails fast instead of hanging for its whole timeout.

One UI event *is* addressed: when a window completes the handshake the broker sends it the current `{ name: 'status', enrolled }`. `status` is emitted when the Host's lifecycle changes it, and a window connecting changes nothing — so a window opened after the enrollment would otherwise sit disarmed, announcing no directory changes and watching for no rings, until the user reloaded it.

Socket bind errors reject startup and are handled as an unavailable peer link; they never leave the listen promise pending or surface as an uncaught extension host error.

Source of truth: `vscode-ext/src/peer-link.ts` for the sockets and arbitration; `vscode-ext/src/peer-link-protocol.ts` for the frame shapes, framing, handshake, budget, and PTY routing table (tested in `vscode-ext/test/peer-link-protocol.test.ts`); `vscode-ext/src/processed-pty-streams.ts` for the window-wide processed stream registry; `vscode-ext/src/remote-host.ts` for `askBothTiers`, the provider, and command routing; `brokerRequest` and the `peer:*` / `remoteHost:command` cases in `vscode-ext/src/message-router.ts`; the operation map and responder in `lib/src/remote/host/peer-surfaces.ts` (tested in `lib/src/remote/host/peer-surfaces.test.ts`); and the attachment it backs in `lib/src/remote/host/remote-api.ts`.

### Testing the extension host

`pnpm --filter dormouse test` typechecks and runs the suites under `vscode-ext/test/`; the socket tests use real local sockets, while `vitest.config.mts` supplies only the minimal `vscode` stub required outside an editor. **Never widen that stub to make an editor-dependent test pass.** Command registration, webview hosting, and the theme observer require a real Extension Development Host.

`webview-boot.smoketest.ts` is separate: `pnpm --filter dormouse test:smoke` builds and executes the shipped webview under Chromium, and CI runs it in its own job. It must stub `acquireVsCodeApi` so the VS Code-only lazy import executes; the smoke assertions pin that path.

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
into the package's `test` script so the root `pnpm test` covers it. Keeping it
wired there is what protects `deactivate()`, which has no `try`/`catch`: a
runtime throw inside it skips every teardown step behind it (rationale).

The checked program spans two runtimes: `src/` is extension-host Node code, but it
imports shared modules from `../lib/src/`, some of which are webview code. The
config therefore carries both DOM and Node libs — looser than either environment
alone, with each side checked precisely by its own project
(`lib/tsconfig.app.json` for the webview). What it reliably catches is vscode-ext's
own code referring to something that no longer exists.

`pnpm dogfood:vscode` uninstalls the legacy `diffplug.mouseterm` extension
before packaging and installing the current Dormouse VSIX, then the VS Code
window must be reloaded to pick up changes.

**Dogfooding vs Extension Development Host:** day-to-day development uses `pnpm dogfood:vscode`, which installs into your real VS Code and so runs against your actual settings, extensions, and workspaces. Use the F5 Extension Development Host when you need **breakpoint debugging** of extension-host code (`extension.ts`, `message-router.ts`, `pty-manager.ts`) — it launches a separate window the debugger can attach to.

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

Palette/keybinding entry points for what today is webview-only. Shipped commands are in the manifest table above.

| Command | Description |
|---------|-------------|
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
