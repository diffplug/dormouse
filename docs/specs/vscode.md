# Dormouse VS Code Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary.
>
> Owns the VS Code-specific layer: panel/view registration, persistence APIs, theme integration, CSP, the peer link between windows, build, and dream-architecture commands.
>
> Defers to `docs/specs/transport.md` — PTY lifecycle, buffering, reconnection, the message protocol, persisted-session types, and every adapter-agnostic invariant — for all sections below.

## What's built

Two hosting modes: a `WebviewView` in the bottom panel (alongside Terminal, Problems, Output) and `WebviewPanel` editor tabs (`dormouse.open`, multiple instances). Both restore across "Developer: Reload Window". PTYs live in the extension host (`pty-manager.ts`), survive panel visibility toggling, and replay buffered output on **resume**. Scrollback is never persisted (`docs/specs/transport.md` → "Persistence policy"); `deactivate()` instead interrupts the live PTYs and records each pane's agent resume invocation for the next cold restore to auto-run (`docs/specs/layout.md` → "Agent resume on cold restore").

The webview is the shared `lib/` frontend, unmodified for this host (`docs/specs/layout.md`, `docs/specs/transport.md`). The only VS Code-specific pieces in `lib/`: `lib/src/lib/platform/vscode-adapter.ts` (the postMessage bridge), `lib/src/lib/vscode-message-token.ts`, `lib/src/lib/vscode-keybindings.ts`.

### Invariants (VS Code-specific)

- **Capture, then save, then kill.** `deactivate()` runs the agent-recovery capture *first* and both kills *last*, the state flush and live-PTY refresh in between. Source of truth: `deactivate()` in `vscode-ext/src/extension.ts`.
- **Alert state is global.** One module-level `AlertManager` in `message-router.ts` is shared across all routers, survives router disposal, and is fed by PTY data regardless of webview visibility.
- **WATCHING rules are host-authoritative.** The first webview after extension-host startup seeds the shared host rule set and **no later webview may replace it**.
- **Never let a resuming router steal another webview's PTYs.** Each router tracks its PTYs in `ownedPtyIds`; a module-level `globalOwnedPtyIds` set enforces it.
- **Every save path must merge current alert states through the shared persistence projection.** The frontend periodic save (`onSaveState`) and the backend deactivate refresh (`refreshSavedSessionStateFromPtys`) both narrow alerts with `toPersistedAlertState`; missing the merge reverts alert state on restore, while passing live state through persists transient fields.
- **retainContextWhenHidden.** Set on both `WebviewPanel` and `WebviewView` so xterm.js DOM, scrollback, and PTY subscriptions survive panel hide/show without a resume.
- **Two save sources must produce consistent state**: the frontend's periodic `dormouse:saveState` and the backend's deactivate flush-then-refresh.
- **Every host → webview send carries the message token**, and **never add a `message` listener that skips `isHostMessage`**.
- **Workbench keybindings mirror for selected chords.** `lib/src/lib/vscode-keybindings.ts` owns the mirror allowlist. For `Ctrl/Cmd+P`, `Ctrl/Cmd+Shift+P`, `Ctrl/Cmd+B`, and `F1`, xterm still processes the key while the webview also posts `dormouse:runWorkbenchCommand`; `message-router.ts` revalidates the request against the same command set before `vscode.commands.executeCommand`.

### Extension manifest

**Activation is limited to the contributed view and restored editor panels**, so a window without either stays cold. The manifest contributes the panel container/view, the Focus/Open/Debug Theme/New Terminal/Select Shell commands, and the view-title actions, owning their exact ids, titles, icons, and ordering.

**No `configuration`, no `keybindings`, no context key**: settings live in the in-webview Settings dialog rather than `settings.json`, chords are handled inside the webview, and nothing is `when`-gated on Dormouse state. Context keys are [Future](#context-keys). Source of truth: `vscode-ext/package.json`.

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

Consequences:

- Hiding or toggling the Dormouse panel neither kills its PTYs nor destroys sessions.
- **Closing an editor-tab `WebviewPanel` is not hiding it.** `setupPanel` attaches
  its router with `killOnDispose: true`, so disposal kills that panel's owned PTYs
  and VS Code discards the tab's per-panel state. **The `WebviewView` router is
  attached without that flag**: its `onDidDispose` releases the router and leaves
  the PTYs alive.
- Each VS Code window gets its own extension host, and therefore its own pty-host child process.

### Workspaces

> See `docs/specs/glossary.md` for the Workspace / Window containers and `docs/specs/alert.md` for the union status.
>
> Union reflection onto native chrome is always-on — the extension host has no `localStorage` for the standalone workspaces flag ([Future](#future)). The Window persistence container is standalone-only; VS Code keeps one bare `PersistedSession` per webview.

**One webview is one Workspace.** The bottom-panel `WebviewView` ("Dormouse") is the default Workspace; each `dormouse.open` editor-tab `WebviewPanel` is an independent Workspace. Several are visible at once, and VS Code — not Dormouse — owns their tabs, creation, and closing, so **Dormouse adds no create/rename/close affordances here**. A Workspace's Surfaces are the terminal Sessions whose PTYs its router tracks (`ownedPtyIds`, `docs/specs/transport.md`) plus the browser Surfaces rendered in it.

#### Surfacing union status on native chrome

The host computes each webview's union (`ringing` / `todo`) from the module-level `AlertManager` scoped to that router's `ownedPtyIds`, delivered via `attachRouter`'s `onUnion` callback. `ownedPtyIds` are PTY-backed, so **VS Code chrome reflects terminal Session ring + TODO only** — a browser Surface's TODO stays webview-local, `alert:state` being keyed by PTY-backed Session ids (see [Future](#future)).

Each hosting primitive uses the chrome it has, following the in-app `<title> <bell> [TODO]` pattern where possible:

- **Editor tab (`WebviewPanel`):** `panel.title` takes the suffix — `Dormouse` + ` 🔔` (ringing) + ` [TODO]` (todo), both when both apply; the bell is an emoji stand-in because a tab title is plain text. `panel.iconPath` stays the Dormouse mascot.
- **Panel view (`WebviewView`):** a presence **badge** — `view.badge.value = 1` whenever anything owes attention, ring-vs-TODO in the tooltip. **Never use `view.title`** — this single-view bottom-panel container shows the static `viewsContainers[].title`, which has no runtime API (rationale). **Clear with `0`, never `undefined`** — VS Code hides a 0-value badge but does not clear an `undefined` one on a panel container. `view.description` stays the shell name.

Reflection updates on every owned-PTY `AlertManager.onStateChange` and on `claim` / `release`. Source of truth: `computeWorkspaceUnion` in `lib/src/lib/workspace-union.ts`, `notifyUnion` in `vscode-ext/src/message-router.ts`, `workspaceTitle` / `workspaceBadge` in `vscode-ext/src/workspace-chrome.ts`, `setupPanel` in `vscode-ext/src/extension.ts`, `DormouseViewProvider` in `vscode-ext/src/webview-view-provider.ts`.

WATCHING rules and the alarm settings (`docs/specs/alert.md` → Alarm settings)
are app-global rather than per-Workspace, so both ride the host-authoritative
seed / mutate / broadcast channel `docs/specs/transport.md` → Message protocol
specifies. Two things are this host's: **the seeding offer is the first one
after extension-host startup**, and the host installs only
`inactivityTimeoutMs` on the shared `AlertManager` while relaying the whole
settings blob.

Source of truth: `WatchedCommandHost` in `lib/src/lib/watched-command-host.ts`,
`AlertSettingsHost` in `lib/src/lib/alert-settings-host.ts`, the alert cases in
`vscode-ext/src/message-router.ts`.

### Shell selection

The selected shell name is mirrored into `WebviewView.description`, and `dormouse:selectedShell` keeps the webview's default-shell slot current for split/spawn/restore paths. `shell-selection.ts` reads `workspaceState` before `globalState` for `dormouse.selectedShellPath`, and **a global save clears the workspace value** so it cannot shadow the new default.

`dormouse.newTerminal` focuses the view and posts `dormouse:newTerminal` with the selected shell; Wall selects the new pane and enters passthrough. `dormouse.selectShell` opens a QuickPick, saves the shell path globally or per workspace, applies the description/default-shell update, and — **only when the pick differs from the previous selection** — focuses the view and posts `dormouse:newTerminal` with `replaceUntouched: true` and `announce: true` (`docs/specs/layout.md` → "Session lifecycle and terminal registry" owns what Wall does with it).

The QuickPick is the only shell control here: `VSCodeAdapter` sets the optional `hostOwnsShells` capability, so the shared Settings dialog hides its Shell row (as `hostOwnsTheme` does for the Theme row).

### Serialization and restore

A `WebviewPanelSerializer` registered under the `dormouse` view type restores editor panels after a restart; `onWebviewPanel:dormouse` activates the extension early enough for it to be there. The persisted shapes it round-trips (`PersistedSession` / `PersistedPane` / `PersistedAlertState` / `PersistedDoor`) are transport.md's.

**While running.** The frontend saves via `dormouse:saveState` on the shared
cadence (`docs/specs/layout.md` → Session persistence). The
router's `onSaveState` merges in current alert states (`mergeAlertStates()`), then
the **WebviewView** writes `workspaceState` (`dormouse.session`) while
**WebviewPanels** persist through VS Code's per-panel `vscode.setState()`, so
several panels cannot clobber each other. **Alert state must ride every save, not
just teardown** — otherwise it does not survive an extension host killed before
`deactivate()` returns.

**On deactivate**, in this order (`extension.ts:deactivate()`):

1. Kick off `closePoppedOutSessions()` — started here, joined after step 2, so its
   external-process time overlaps the capture. **Its rejections are absorbed:** a
   throw out of the join would skip the flush, the refresh, and both kills.
2. `captureAgentRecoveryCommands(context, 1200)`.
3. `flushAllSessions(1000)` — ask every webview to save now, bounded.
4. `refreshSavedSessionStateFromPtys()` — re-read CWD while the processes are alive.
5. `gracefulKillAll(2000)` (SIGTERM, wait), then `killAll()` (force).

**Recovery must go first** — the resume hint exists only between the interrupt and
the kill, and the shutdown budget is not ours (rationale), so the one step whose
data cannot be reconstructed afterwards runs before the ones that can (cwd
re-reads, alert merges). `captureAgentRecoveryCommands` writes `^C` into every
live PTY, waits bounded, scans those buffers, and records the invocation to
`recovery.json` under `context.storageUri`, **written synchronously and replaced
temp-then-rename**. **Never `workspaceState`**, whose SQLite flush is already
tearing down (rationale), and **never `PersistedPane.resumeCommand`**, which the
step-3 flush would overwrite with the webview's stale copy. **The record is
rewritten the moment each command is found and every wait is bounded**, so being
killed mid-poll costs at most a late agent's command and a timeout loses a
recovery command rather than delaying shutdown.

**On activate**, saved state loads through `readPersistedSession()`
(`docs/specs/transport.md` → "Persisted session types") and is passed to routers
for cold-start restore. The WebviewView and each deserialized WebviewPanel then
claim their own pane ids' recovery commands out of the single record, under
`docs/specs/transport.md` → "Consuming it". **A panel's pane ids come from the
`vscode.setState()` blob returned at `deserializeWebviewPanel`**, so recovery
needs no host-side per-panel store.

#### Capturing agent recovery

**Write `^C` into the pty; never signal it** — the agents print their resume
invocation when interrupted, not when signalled, and the tty line discipline
delivers the SIGINT to the foreground process group, so the hint comes back as
ordinary `pty:data` (rationale).
**Interrupt every live PTY, not just recognized agents** — `detectResumeCommand`
is the real filter and `^C` into a non-agent is inert (rationale) — but
**exclude exited PTYs**, which can yield no hint and would permanently defeat the
"nothing left to wait for" early exit.

**Press-wait-press, gated per pane.** claude prints its hint only on a *second*
press (after `Press Ctrl-C again to exit`); codex prints after the first, at a
latency that is not a constant, and a second press arriving mid-print destroys
its hint entirely. So: one `^C` to every live PTY, then poll on a 40 ms tick,
sending one more `^C` to a pane that has yielded nothing either the moment it
asks (`Press Ctrl-C again`) or once ~600 ms have passed with ~200 ms of silence
— quiet is evidence that a print is not in flight, **not** that the pane is
finished. **Both clocks start when the first press is *acked***, not at step
entry (rationale); the poll's ~1.2 s wall-clock ceiling is the one timing
anchored to entry, being a shutdown budget rather than an agent timing. **Never
finish early on quiet** — the only sound early exit is having nothing left to
wait for (rationale). **The ask gate keys on an English UI string on purpose**
(rationale).

**Never simplify to a single gesture**: a blanket second press destroys codex's
idle case, an ask-gated one never fires for codex at all, and the constants are
sized against real-pty measurements so codex's idle case leaves the retry set
before the ~600 ms fallback (rationale).

**Only post-interrupt bytes count, and never widen that scan.** Each pane's
received-count mark (`getScrollbackReceived`, `docs/specs/transport.md` →
Universal invariants) is taken before the first `^C`, and detection reads only
what arrived after it — a correctness boundary, since the command auto-runs on
the next restore without confirmation (`docs/specs/transport.md` → "Consuming
it") and only bytes produced in response to Dormouse's own interrupt may become
executable state (rationale).

**Clear any previous record before the first early return** — consumption happens
only when a container actually resolves, so a session where the Dormouse view is
never opened would otherwise auto-run a week-old invocation on some much later
restore. A missing hint is ordinary: `CLAUDE_CODE_CHILD_SESSION` in a pane's env
disables transcript saving in claude, which then prints none (rationale).

Source of truth: `captureAgentRecoveryCommands` in
`vscode-ext/src/session-state.ts`, `interrupt` in
`vscode-ext/src/pty-manager.ts`.

### Theme integration

The two-layer token strategy (`--vscode-*` → semantic `--color-*`), the consumed-token resolver, and its registry defaults are `docs/specs/theme.md`'s (Runtime model). VS Code is the only host that supplies `--vscode-*` itself, so `lib/src/main.tsx` **must install** `installVscodeThemeVarResolver()` before React renders — it materializes only the *missing* Dormouse-consumed variables onto `body.style`, and `lib/src/theme.css` carries no hardcoded defaults or fallback chains to fall back on.

Two `MutationObserver`s watch class + style mutations on both `body` and `html`:
one in `lib/src/lib/terminal-theme.ts` live-updates every xterm.js instance, and
the resolver's own (`lib/src/lib/themes/vscode-color-observer.ts`) keeps derived
`--vscode-*` variables in sync before xterm rereads the terminal palette.

`dormouse.debugTheme` focuses the Dormouse WebviewView and posts
`dormouse:openThemeDebugger`; `VSCodeAdapter` converts that into the browser event
the shared Theme Debugger consumes, which traces VS Code-exposed `--vscode-*`
variables and Dormouse materialized fallbacks, **never raw built-in VS Code theme
files**.

### OSC color query answering

PTY parsing happens in the **extension host**, which has no DOM to read the theme from, so **the webview pushes its resolved colors up**: `VSCodeAdapter.pushThemeColors()` reads `getTerminalTheme()` and posts `dormouse:themeColors { foreground, background, cursor }` on `requestInit` and again whenever `onTerminalThemeChange` fires. `message-router.ts` caches the latest colors and feeds them to every PTY's parser via a `TerminalColorProvider`, so the parser answers and consumes `OSC 10/11/12 ; ?` exactly like the standalone frontend adapter ([terminal-escapes.md](terminal-escapes.md#supported-oscs)). Before the first push, or for an unparseable color, the provider returns `null` and the query falls through to xterm.js. Windows additionally needs `useConptyDll: true` for the query to reach the extension host ([terminal-escapes.md](terminal-escapes.md#osc-color-queries-on-windows-require-the-bundled-conpty)).

### CSP policy

The directives, with `randomSecret()` supplying the nonce:

```
default-src 'none'
style-src   <cspSource> 'unsafe-inline'
script-src  'nonce-…' 'strict-dynamic'
font-src    <cspSource>
img-src     <cspSource> data: blob:
connect-src <cspSource> ws://127.0.0.1:* ws://localhost:*
frame-src   http://127.0.0.1:* http://localhost:*
```

**`frame-src` is loopback-only** — `dor iframe` frames its target through the transparent proxy the extension host stands up, so the only origin ever embedded is loopback on an OS-assigned port; without the override `default-src 'none'` blocks the frame and leaves a blank white pane (`docs/specs/dor-browser.md`).

**The webview CSP carries no relay sources.** Its `connect-src` loopback `ws:` entries are for the agent-browser stream relay only — the remote Host holds its `/ws/host` socket from the *extension host*, which no CSP fences, so the origin allowlist is enforced there instead (see "Remote Host: a service in the extension host").

**That allowlist is a build-time constant, never a runtime value**: `vscode-ext/scripts/esbuild.mjs` substitutes `__DORMOUSE_REMOTE_CONNECT_SRC__` into `dist/extension.js`. The default, the replace-not-add override rule, and the two build-time guards are `docs/specs/server.md` → "Where a Host may reach a relay server".

`unsafe-inline` for styles covers the theme CSS variables VS Code injects as inline styles on the body element. Scripts stay nonce-gated on a fresh per-render nonce of 24 CSPRNG bytes (`node:crypto` `randomBytes`) base64url-encoded to 32 characters — **never `Math.random()`**. Vite builds the webview HTML from the `lib` package; at runtime `webview-html.ts` rewrites asset URLs to webview URIs, injects the CSP meta tag, swaps Vite's nonce placeholder for the real one, and appends a nonce-gated inline script carrying the boot globals (message token, initial state, selected shell, recovery commands).

**A nonce alone does not survive code splitting.** Vite splits the webview bundle and `script-src` gates each way a chunk loads separately; both mechanisms below are required, since a nonce is **not** inherited through the module graph and `'strict-dynamic'` does not vouch for a parser-started fetch:

- **Vite stamps the nonce** onto every tag it emits, via `html.cspNonce` in `vscode-ext/vite.config.ts` (placeholder `CSP_NONCE_PLACEHOLDER`, shared with `webview-html.ts`) — the entry `<script>`, the `<link rel="modulepreload">` tags for its static imports, and the `<meta property="csp-nonce">` its runtime preload helper reads before injecting a preload for a lazy chunk (rationale). `getWebviewHtml` swaps the placeholder for the document's real nonce and **throws if it is absent**, an unmarked build otherwise serving un-nonced scripts against a nonce-gated policy.
- **`'strict-dynamic'` covers the fetches no tag represents:** the entry's own static imports and every lazy `import()`. It widens what an already-trusted script may *load*, never what may be *written into* the document, and nothing here grants `script-src 'unsafe-inline'`. It also makes host-source expressions inert, so **adding `webview.cspSource` to `script-src` would be dead weight**.

**Keep `'strict-dynamic'`** even though no experiment shows it load-bearing (rationale): it is the mechanism CSP specifies for "a script the nonce vouched for may load more", and the alternative that happens to work would make the policy correct by accident.

Chromium enforces CSP and a failure presents remote from its cause, so **string inspection proves nothing** (rationale) and two checks cover it, **neither replacing the other**: `vscode-ext/test/webview-boot.smoketest.ts` loads the real bundle under the real policy in a real engine, and `vscode-ext/test/webview-html.test.ts` pins the transform against a fixture of real Vite output.

Source of truth: `getWebviewHtml` in `vscode-ext/src/webview-html.ts`, `CSP_NONCE_PLACEHOLDER` in `vscode-ext/src/csp-nonce-placeholder.ts`, `assertConnectSrcBaked` in `scripts/csp-defaults.mjs`, `bakedConnectSrc` in `lib/src/host/remote/connect-src.ts`.

### Webview message authentication

**The webview's `window` is a shared inbox, so `event.data.type` cannot decide trust** — it is attacker-chosen. The extension host posts there, and so can any framed surface (`dor iframe`, agent-browser; `docs/specs/dor-browser.md`) via `parent.postMessage`, which crosses origin and sandbox boundaries by design; the CSP governs what the document may *load*, never who may *message* it. A forgery is consequential: `dor:controlRequest` becomes a `dormouse:control-request` event `use-dor-control.ts` can turn into a `writePty`, and the `pty:*` family drives what the user sees (rationale). Host-originated messages are therefore authenticated by a **per-boot message token**:

- `getWebviewHtml` mints one token per webview document — 24 CSPRNG bytes, base64url, from the same `randomSecret()` as the CSP nonce — injects it as `globalThis.__DORMOUSE_MESSAGE_TOKEN__` in the same nonce-gated inline script that seeds the other `__DORMOUSE_*` globals, and returns it alongside the HTML.
- **`serveWebview` is the only way to put a document on a webview**: it mints, assigns `webview.html`, and returns a `WebviewChannel` whose `post()` closes over that document's token. **Minting and serving are one step**, so a token cannot drift from its document; re-serving yields a new token and channel, and nothing keys a token by webview identity, so there is no cleanup.
- **Every host → webview send goes through a channel**, making a bypass a type error rather than a convention to remember; only the two serve sites (`setupPanel`, `resolveWebviewView`) still hold a raw webview, and `attachRouter` takes a `WebviewChannel`, not a `vscode.Webview`. `DormouseViewProvider.postMessage` forwards to its stored channel, **returning `false` before the view is served or after it disposes** — the VS Code API's own undelivered signal, already handled by the `dormouse:newTerminal` retry loop and `forwardDorControlRequest`'s rejection path.
- `VSCodeAdapter` captures the token **once, at construction**, and both of its `message` listeners — the main dispatcher and the per-request reply listener inside `requestResponse` — call `isHostMessage(event.data, token)` before reading anything else, `type` included.

**Never swap the token for an `event.source` / `event.origin` check, and never reuse the CSP nonce as the token** (rationale). **The guard fails closed both ways**: a webview served without the global accepts nothing, a host send without a token delivers nothing, and framed content cannot read the parent's globals cross-origin.

Messages from proxied iframes are guarded by origin instead (`docs/specs/dor-browser.md`) and are unaffected by the token, which covers only the adapter's host channel. **Scope is VS Code**: the standalone adapters receive the equivalent events over Tauri's `listen()` IPC and the dev harness's host WebSocket (`docs/specs/standalone.md`), never `window.postMessage`, so they have no forgeable inbox to guard.

Source of truth: `isHostMessage` in `lib/src/lib/vscode-message-token.ts`, `WebviewChannel` / `serveWebview` in `vscode-ext/src/webview-messaging.ts`, `getWebviewHtml` in `vscode-ext/src/webview-html.ts`, `VSCodeAdapter` in `lib/src/lib/platform/vscode-adapter.ts`; pinned by the `host message authentication` block in `lib/src/lib/platform/vscode-adapter.test.ts`.

### Remote Host: a service in the extension host

The shared `RemoteHostService` (`lib/src/host/remote/`, specified in `docs/specs/remote-api.md`) runs in the extension host; VS Code's part is where its state lives, which window runs it, and what the webviews still do.

A webview is a **surface responder plus UI** (`docs/specs/server.md` → "Host side" owns that split). **Nothing a webview says can widen access** — the ACL and the access decision never leave the extension host (`docs/specs/remote-security-model.md`).

**The store.** Enrollment (`{ serverUrl, hostId, hostToken, origin, rpId, label }` plus this machine's Noise static) and ACL split by sensitivity: `hostToken` and the static's private half grant the `/ws/host` socket and this Host's identity, so **the enrollment goes to `SecretStorage`** (OS keychain) and **the ACL — public keys plus each Client's push `deliveryId` — to `globalState`**. Both are global rather than workspace-scoped: a Host identity belongs to the machine, not a folder.

The service reads both **in-process**, through the async `HostStateStore`. **The enrollment is memoized, and that memo must be invalidated across windows** — the store drops it on any `secrets.onDidChange` for the enrollment key, an event every window receives (rationale). **The ACL is not memoized**, `globalState` being in-process and free. All mutations ride the shared serial queue under the store contract (`docs/specs/server.md` → "Host side"); a failed write rejects its caller without wedging later mutations. **That same subscription lets a window un-enrolled at activation join a Host a sibling just created** — `initRemoteHost` re-checks and contends then, with no reload.

**Import `ENROLLMENT_KEY`, never mirror it** (`lib/src/remote/host/store.ts`) — a key that drifted between the two sides would strand an enrollment still on disk. The ACL prefix is this store's own, one entry per `hostId` so a re-enrollment inherits no stale ACL. **A record written before the end-to-end cutover is dropped by `isHostAclRecord`**, which is the whole of the Host-state version: the window offers enrollment again and every phone pairs once more.

Source of truth: `VsCodeHostStateStore` in `vscode-ext/src/remote-host-store.ts`, `HostStateStore` in `lib/src/host/remote/host-state-store.ts`.

**Which window: bind-as-lease.** One extension host runs per window, so unarbitrated they would all start a Host against the same enrollment and fight endlessly over the one `/ws/host` socket (rationale). Arbitration is the socket itself: **the bind is the lease**. Every contending window tries to bind one fixed path — `<hash>.sock` inside a per-user `dormouse-peer-<uid>` directory in the temp dir, or `\\.\pipe\dormouse-peer-<hash>` on Windows — the hash derived from `context.globalStorageUri.fsPath`: **derived rather than random** because it must be *the same* in every window, **hashed rather than joined** because of the platform path cap (rationale). The winner is the broker and runs the service; everyone else connects to it as a client.

The invariants:

- **Roles never flip downward.** There is no `onRole(false)` after a `true`, and a client only ever changes role *upward*, which makes a TTL lease's mid-transition races unrepresentable rather than handled (rationale).
- **Contend on broker death, not on a timer.** When the broker exits, every client's socket closes and they all race to bind; exactly one wins, because `bind` is the arbiter. No TTL, no heartbeat file, no filesystem watcher.
- **A corpse is cleared, then the bind is re-checked.** `EADDRINUSE` → dial it → `ECONNREFUSED`/`ENOENT` means the path exists but nothing listens. **Never unlink on the first refusal:** the unlink is jittered by up to `RECLAIM_JITTER_MS` and the path dialled **again** afterwards (rationale). **`stillOurs` then re-stats the path after `RECLAIM_VERIFY_MS` and compares full filesystem identity — device, inode, and nanosecond change timestamp, never inode alone** (rationale). A window whose socket identity was replaced, **or whose path has gone entirely**, stands down and the loop re-runs (per-platform reasoning at `stillOurs`).
- **A bind is not a role until it is believed.** Everything that answers "is this window the broker" — `ensurePeerNet`'s shortcut, `isPeerBroker`, `isPeerLinkSettled`, `remoteNotifyPeerChange` — reads `brokerConfirmed`, set only where `settle(true)` runs and cleared by `closeServer`. **Unverified reads as unsettled**, so a command landing in the `RECLAIM_VERIFY_MS` window (an `enroll`, a `secrets.onDidChange`) is held for the verdict rather than told "broker" (rationale).
- **Attempts are spaced.** The loop waits `RETRY_MS` between rounds so a refused hello cannot spin, and a bind or connect landing after disposal is undone rather than left to outlive its window.
- **Errors after `listen` are logged, not thrown** — a listening `net.Server` emits `'error'` for accept-time failures (EMFILE, a broken pipe), and an `EventEmitter` with no `'error'` listener rethrows out of a libuv callback and takes the extension host down, so `listenServer` installs a permanent logging listener the moment the bind succeeds (rationale).

**Trust.** The socket path is derived, not secret — any user on the machine can compute it — so two layers stand between it and this installation's terminals.

*The directory.* On unix the sockets live in a `dormouse-peer-<uid>` directory created 0700 and held before every bind and every connect to `peerDirIsSafe()`, the same predicate the `dor` control socket uses (`docs/specs/dor-cli.md` → Control-channel security, which states its four checks). A loose directory we own is tightened; anything else is somebody else's and **the peer link stands down for good** rather than spinning against it, releasing the callers waiting on the contention. Windows named pipes carry their own ACL and skip this layer.

*The handshake.* The shared secret is a mode-0600 `remote-host.peer-token` in `globalStorageUri`, **created once with an exclusive `wx` write rather than a rename** so two windows starting together agree on one token. `wx` creates the file before it writes the bytes, so the loser's read can land on a zero-length file: **treat an empty read as *not yet written*, never as the token**, waiting it out (`TOKEN_WRITE_ATTEMPTS` × `TOKEN_WRITE_POLL_MS`) (rationale). **Exhausting the wait latches the same permanent stand-down as an unsafe socket directory**, neither remaining case being fixed by retrying; the throw re-derives which it was, that log line being the only diagnosis (rationale). The token itself **never crosses the socket**; instead three frames prove mutual knowledge of it:

1. `challenge { nonce }` — the *server* speaks first, on accept. A client that has not yet seen proof of the token must not volunteer one into whatever bound the path.
2. `hello { nonce, proof }` — the client answers with `HMAC-SHA256(token, "client:" + serverNonce)` and a fresh nonce of its own.
3. `welcome { proof }` — the server verifies in constant time, then answers `HMAC-SHA256(token, "server:" + clientNonce)`.

**Domain-separate the two proofs (`client:` / `server:`)** — without it a fake server could reflect the client's own proof back as its welcome. **The client verifies the welcome before it sends or answers anything else** (until then it forwards no notifies — they queue — answers no requests, streams no PTY, forwards no commands), and a welcome it cannot verify closes the socket, so squatting the path buys nothing (rationale). **Fresh nonces per connection** make a captured proof worthless on the next one. **Parseable JSON values that are not frame objects are rejected on both ends**, a first frame that is not a valid hello drops the socket, and **each side bounds the opening handshake to `HANDSHAKE_BUDGET_MS`**.

**Nothing starts until there is a Host to run.** Contention begins when activation finds an enrollment in `SecretStorage`, when `secrets.onDidChange` reports that another window created one, or on the first `enroll` / `enrollOffer` command from any webview — the bootstrap for an un-enrolled machine, so a user who never enrolls never sees a socket. **The service runs independently of webview lifetime**: a broker window with zero Dormouse webviews still relays, contributing an empty directory.

**A command that arrives mid-contention is held, not refused** (rationale). Commands queue (bounded at a dozen, oldest refused on overflow) and drain when a role settles — to the service if this window brokered, over the link if it did not. **Each carries its own deadline, under the adapter's 15 s timeout**, so a contention that never settles produces a reason rather than a timeout. `enroll` and `enrollOffer` are the only two that may *start* the contention; everything else refuses only where there is genuinely nothing to reach.

Source of truth: `vscode-ext/src/remote-host.ts` (service glue, provider, command routing), `ensurePeerNet` / `attempt` / `stillOurs` in `vscode-ext/src/peer-link.ts`; pinned by `vscode-ext/test/remote-host.test.ts` and `vscode-ext/test/peer-link.test.ts`.

**The webview bridge.** A webview reaches the service over `RemoteHostLink` (`lib/src/lib/platform/types.ts`), implemented in `vscode-adapter.ts` on three messages: `remoteHost:command { rhId, cmd, params }` out, `remoteHost:result { rhId, result | error }` and `remoteHost:event { name, … }` back. **Everything but those three `postMessage` shapes is the shared client** in `lib/src/host/remote/link-client.ts` (`docs/specs/transport.md` → Message protocol).

Results are **broadcast to every webview in the window** rather than replied to one (`docs/specs/transport.md`), and one correlation id serves both the in-window fan-out and the cross-window forward below.

Two events are pushed rather than answered: `pairing-queue` (the complete snapshot; the service is authoritative, so **the mirror replaces rather than merges**) and `status { enrolled }`. The queue is pushed only when it *changes*, so **the webview asks for it once on every transition to enrolled** — joining a Host already mid-pairing would otherwise show no modal until that pairing was answered somewhere else.

**Volunteering is enrollment-gated; answering is not.** Announcing costs a crossing per pane-state, activity, and focus change plus an activity-store subscription, on a machine whose owner may never enroll, so `armWhileEnrolled` (`lib/src/remote/host/enrolled-gate.ts`) arms the outbound half only while a Host exists, driven by the `{ name: 'status', enrolled }` the service announces on every lifecycle change and seeded by one `status` command at install time. **The seed cannot lose a race with the event**: both travel the same ordered channel.

**The relay socket.** The supported `engines.vscode` range (`^1.85.0`) spans the Node boundary where `globalThis.WebSocket` appeared (rationale), so the service **must be constructed with a factory**: prefer `globalThis.WebSocket`, fall back to the bundled `ws`, whose socket satisfies exactly the surface `RemoteHost` reads (`send`, `close`, `readyState`, `addEventListener`, `message` events with `.data`, `close` events with `.code`). esbuild inlines `ws` lazily; **its optional native accelerators `bufferutil` / `utf-8-validate` are marked external and neither installed nor shipped** — a `.node` addon cannot be bundled — so `ws` falls through its own `try`/`catch` to the JS paths. Source of truth: `createRelaySocket` in `vscode-ext/src/remote-host.ts`, the `external` list in `vscode-ext/scripts/esbuild.mjs`.

**Lifetime.** Hiding a panel keeps its terminals answerable (`retainContextWhenHidden`), and closing every Dormouse view does not take the Host offline.

### Peer surfaces

The service owns the PTYs but not the *view* of them: each webview is its own JS realm with its own xterm registry (`lib/src/lib/terminal-store.ts`), and only a webview knows what a pane is called, whether it is focused, and how big its xterm is. So the service asks, and every webview answers for its own.

| Contract | In-window tier | Cross-window tier |
|---|---|---|
| Query | `brokerRequest` posts `peer:ask` to every live webview, collects `peer:answer`. | Broker sends `request` to every peer; each peer runs its own `brokerRequest`, never `askBothTiers`, returns `result`. |
| Operation schema | `(op, params) → zero or more results`; `op` opaque to the transport, the typed map only in `peer-surfaces.ts`. | Same seam; only a reserved `ptyId` is interpreted, for routing. |
| Ownership / miss | Presence is ownership; every webview answers, including with no results. | Every peer answers; disconnect settles its pending asks empty. |
| Fan-out order | All webviews in parallel. | `askBothTiers` runs local and all peers in parallel, local concatenated first. |
| Budget | `ASK_BUDGET_MS` (1s); disposal removes that webview from the outstanding set. | `PEER_REPLY_BUDGET_MS` covers the inner ask plus socket hops and **must remain larger** (pinned by `peer-link-protocol.test.ts`). |
| Invalidation | `peer:notify` carries no subject; pane/activity/focus bursts coalesce before crossing. | `notify`, webview membership, and peer membership each trigger a fresh directory collect. |
| PTY stream | One window-wide keyed registry distributes already-processed data/exit. | Opaque routed handles select one peer; `subscribe` is reference-counted, streaming the same processed data/exit. |
| Host command | This window calls its service, broadcasting the uniquely correlated result to its webviews. | `command` goes to the broker, `commandResult` returns only to its origin window, `uiEvent` broadcasts. |

**Every webview installs the responder**, broker or not; it carries none of the relay, enrollment, or pairing machinery — a registry lookup, the directory collector, a read-only surface resolve, and a resize. **Installing must be idempotent per link, not per flag** — answering already is, the announcing half is not, so a second call would cross into the Host's process twice per change forever (rationale).

**Each webview counts once, and a late answer repairs the snapshot.** The router removes a webview from the outstanding set *before* taking its results, so a duplicate answer cannot contribute the same panes twice; an answer for an already-settled request **triggers a directory invalidation instead** (`docs/specs/remote-api.md` → Directory).

**A peer answer belongs to the authenticated broker socket that asked for it** —
if that broker disappears mid-fan-out the answer is dropped even when this window
has already connected to a replacement, since **request ids restart per broker**
and forwarding an old result through the new socket could satisfy unrelated work
that reused the id. A rejected fan-out is contained in the peer handler and
contributes an empty answer rather than an unhandled extension-host rejection.

The one field the transport itself reads out of an answer is a reserved `ptyId` (`routedPtyId`): an answer naming a PTY is claiming it, which is how the cross-window broker learns which window that PTY lives in. **Nothing else about an answer is interpreted below the Host.**

Directory answers are snapshots, so `notifyDirectoryChanged` coalesces a fresh
collect rather than retaining the old one, and the webview coalesces its source
bursts on one microtask (a focus move alone emits `focusout` plus `focusin`).

**Attach-is-the-resize is answered by the owning webview's live xterm, never the PTY directly**, under `docs/specs/remote-api.md` → "Size authority: last-attach-wins". **Cross-window attach fans out a read-only `resolve` first**, selects its first answer, then sends the mutating `attach` only to that answer's tier and peer, so duplicated cold-restored windows do not both resize. The owner replies with the size it settled at plus the `ptyId`; the service then streams that PTY. **There is no `detach` op** — the service stops streaming on its side and the pane keeps its last size.

**Which webview owns a pane never reaches the protocol layer.** `resolveSurface` / `SurfaceHandle` are `docs/specs/remote-api.md`'s and the ask-backed half of the provider is shared with standalone (`createAskSurfaceProvider`); VS Code's part is that **the first read-only resolve answer is the answer**, and the mutating attach plus every later handle resize are addressed only to that selected tier/window. A resize nobody answered leaves the last known size standing.

**No second strip parser.** The extension host already parses each PTY chunk and answers its queries (`message-router.ts`); webviews receive that parser's projection pair, and the service's `streamPty` subscribes to the very same parse. **A second parser would answer every query twice and corrupt the PTY** (`docs/specs/terminal-escapes.md`, which owns the rule for both hosts).

**Local streams go through one keyed registry**, shared by the Host provider and the peer-link forwarder, holding each sink's own subscription to the owning PTY's parse plus one window-wide exit listener. **A sink subscribes to the PTY it watches and to no other**, so a terminal nobody is attached to costs nothing, and each sink gets its own mid-string hold (`docs/specs/terminal-escapes.md`). **The exit listener is installed on the first attachment and removed when the last goes**, so a window with no remote viewer pays nothing.

Source of truth: `installPeerSurfaceResponder` and the operation map in `lib/src/remote/host/peer-surfaces.ts`, wired from `lib/src/main.tsx` (pinned by `lib/src/remote/host/peer-surfaces.test.ts`), `vscode-ext/src/processed-pty-streams.ts`.

### Peer surfaces across windows

The broker window listens on the authenticated local socket and every other
window connects. **The directory deduplicates by `surfaceId` and attach selects
the first answer in the same local-first order**, so a duplicated cold-restored
id is shown from the owner attach will reach (`createAskSurfaceProvider`).

**Cross-window streams are reference-counted per routed PTY.** Two attachments to the same foreign surface share one `subscribe` frame; only zero-to-one starts the owner forwarding and only one-to-zero stops it, so a second viewer never restarts a live stream and one viewer detaching cannot silence the other. **The owner answers the first `subscribe` with `subscribed` only after its sink and atomic liveness check are installed**; a recorded exit is sent first on the same ordered socket and the remote API waits for `subscribed`, so an exit that landed during surface resolution cannot be overtaken by a successful attach response. **The last unsubscribe stops the forwarding but keeps the route** — "nobody is watching it" is not "it moved" (rationale). **Routes are refreshed by every resolve and dropped only by an `exit` frame or the owning window disconnecting** (`forgetPeerRoutes`).

Once an answer names a `ptyId`, the broker replaces that owner-local id with a stable opaque route handle for the `(peer socket, ptyId)` pair before returning the result. **Never key routes by a raw `ptyId`** — pane and PTY ids are unique only within a window, and cold restore can duplicate them across windows (rationale). The selected `SurfaceHandle` retains its peer-specific routing key; follow-up surface asks address that peer alone, while `subscribe`, `write`, and PTY-only `resize` translate it back to the owner's real id on that socket only. **The generated key is checked against this window's PTYs and stays in the peer namespace after its route closes**, so a stale handle fails closed rather than colliding with a later local PTY. **When a peer disconnects, every handle routed to it is dropped and reported as exited** (`forgetPeerRoutes`) — a later write must not be posted into a dead socket.

**Never send a result both ways.** The broker keeps a `commandRoutes` table of which window is owed each in-flight `rhId`; an answer with an entry goes to that socket alone, one without goes to this window's webviews (rationale). A window that disconnects has its outstanding routes dropped and its commands left unanswered — the asking adapter's own timeout is the backstop — and **whatever the broker was still asking it is settled empty on the spot**, rather than stalling every surviving window's directory or attach for the full `PEER_REPLY_BUDGET_MS`. **A `result` frame is taken only from the window the request was put to**, ids being per-broker.

**Pairing UI events are the opposite: unaddressed and broadcast to every window's webviews**, because the approval modal must appear wherever the user happens to be looking.

**A window with no Host at all still answers the read-only commands** — reaching the terminal refusal is the ordinary un-enrolled state, not a failure. `status`, `pushDevices`, and `pairingQueue` answer exactly what an idle service returns (`unenrolledStatus`, the service's own exported builder, then `null`, `[]`), each caller reading the difference: `pushDevices` answers `null` for "nowhere to push" and rejects only when the server could not be asked (rationale), and `enrolled-gate.ts` seeds itself from `status`. That `status` reads the installer's offer file from this same process — a file read, not a socket — so the one-click card renders on a machine no window has a Host for, and its `enrollOffer` bootstraps the contention. **Everything else refuses with an error rather than dropping it**, so the console hook fails fast instead of hanging for its whole timeout.

One UI event *is* addressed: **when a window completes the handshake the broker sends it the current `{ name: 'status', enrolled }`** — `status` is emitted only when the Host's lifecycle changes it, so a window opened after the enrollment would otherwise sit disarmed until reloaded.

**Socket bind errors reject startup** and are handled as an unavailable peer link; they never leave the listen promise pending or surface as an uncaught extension host error.

Source of truth: `vscode-ext/src/peer-link.ts` (sockets, arbitration); `vscode-ext/src/peer-link-protocol.ts` (frame shapes, framing, handshake, budget, PTY routing table), pinned by `vscode-ext/test/peer-link-protocol.test.ts`; `askBothTiers` in `vscode-ext/src/remote-host.ts`; `brokerRequest` and the `peer:*` / `remoteHost:command` cases in `vscode-ext/src/message-router.ts`; `lib/src/remote/host/remote-api.ts`.

### Testing the extension host

`pnpm --filter dormouse test` typechecks and runs the suites under `vscode-ext/test/`; the socket tests use real local sockets, and `vitest.config.mts` supplies only the minimal `vscode` stub required outside an editor. **Never widen that stub to make an editor-dependent test pass** — command registration, webview hosting, and the theme observer require a real Extension Development Host.

`webview-boot.smoketest.ts` is separate: `pnpm --filter dormouse test:smoke` runs the shipped webview under Chromium against a prebuilt `media/`, in its own CI job. **It must stub `acquireVsCodeApi`** so the VS Code-only lazy import executes.

### Build and development

Source of truth:

| Scope | Source | Covers |
| --- | --- | --- |
| Root commands | `package.json` | `pnpm build:vscode`, `pnpm dogfood:vscode` orchestration |
| Extension scripts | `vscode-ext/package.json` | `build:frontend`, `build`, `typecheck`, `test`, `dogfood` package-local steps |
| Typecheck config | `vscode-ext/tsconfig.json` | check-only program; `tsc` never emits here |
| F5 launch | `.vscode/launch.json` + `.vscode/tasks.json` | Extension Development Host debugging chain |

**The build does not typecheck.** `pnpm build` bundles with esbuild, which strips
types without checking them, so `tsc` runs separately as `pnpm typecheck`, **wired
into the package's `test` script** so the root `pnpm test` covers it — that wiring
is what protects `deactivate()`, which has no `try`/`catch` (rationale).

The checked program spans two runtimes — `src/` is extension-host Node code but
imports webview modules from `../lib/src/` — so its config carries both DOM and
Node libs, looser than either alone, each side checked precisely by its own
project (`lib/tsconfig.app.json` for the webview). What it reliably catches is
vscode-ext's own code referring to something that no longer exists.

`pnpm dogfood:vscode` uninstalls the legacy `diffplug.mouseterm` extension before
packaging and installing the current Dormouse VSIX; the VS Code window must then
be reloaded. Day-to-day development uses it, since it runs against your real
settings, extensions, and workspaces. Use the F5 Extension Development Host for
**breakpoint debugging** of extension-host code (`extension.ts`,
`message-router.ts`, `pty-manager.ts`) — it launches a separate window the
debugger can attach to.

`vscode-ext/vite.config.ts` sets `root: ../lib` and `outDir: ./media`, building the shared React frontend directly into the extension's media folder.

## Future

### Webview→host Surface-state channel

A webview→host Surface-state message would let the native-chrome union count browser-Surface TODOs, which the PTY-keyed `alert:state` cannot carry (`docs/specs/alert.md`, `docs/specs/transport.md`).

### Host-side workspaces flag gate

Whether to gate the always-on union reflection on a host-side equivalent of the standalone `dormouse.flags.workspaces` localStorage flag is decided when the workspaces rollout reaches VS Code (`docs/specs/layout.md` `## Future`, workspaces-rollout).

### Context keys

Context keys so menus and extensions can target Dormouse state:

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
