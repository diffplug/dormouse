# Dormouse VS Code Integration Spec

> See `docs/specs/glossary.md` for Session / Surface / Pane / Door vocabulary.
>
> Owns the VS Code-specific layer: panel/view registration, persistence APIs, theme integration, CSP, the peer link between windows, build, and dream-architecture commands.
>
> Defers to `docs/specs/transport.md` — PTY lifecycle, buffering, reconnection, the message protocol, persisted-session types, and every adapter-agnostic invariant — for all sections below.

## What's built

The shared frontend runs in the bottom-panel `WebviewView` and independent editor-tab `WebviewPanel`s.

### Invariants (VS Code-specific)

- **Alert state is global**: one module-level alert host (`createAlertHost` in `message-router.ts`) is shared by every router, survives router disposal, and is fed by PTY data whatever the webview's visibility.
- **Each router is one realm of it**, under its `routerId` (`docs/specs/alert.md` → Engagement). **Must end the realm on router disposal and on a `dormouse:init` re-init** (`endRealm`): recreated content is a new realm.
- **Never let a resuming router steal another webview's PTYs**: each router's `ownedPtyIds` is enforced by the module-level `globalOwnedPtyIds`.
- **Every save path must merge current alert states through `toPersistedAlertState`** — the frontend's periodic `dormouse:saveState` and the backend's deactivate refresh (`refreshSavedSessionStateFromPtys`) alike, so the two produce consistent state: missing the merge reverts alert state on restore, passing live state persists transient fields.
- **A Session's alert state follows its PTY**: `pty:spawn` claims the id before starting its alert state over from `options.alert`, so the seeded state reaches the claiming webview, and **every kill removes the entry**. **Must reserve a closing router's PTYs until its deferred kills finish**, so another router cannot claim them during CWD work.
- **Every webview and Client write and resize goes through `alertedPty`**, a remote Client's from either Burrow tier included (`writeClientInput`), so input is acknowledged and a resize's grace opened first (`docs/specs/alert.md` → Engagement).
- **`retainContextWhenHidden` is set on both `WebviewPanel` and `WebviewView`**, so xterm.js DOM, scrollback, and PTY subscriptions survive hide/show without a resume.
- **Workbench chords in the `lib/src/lib/vscode-keybindings.ts` allowlist are mirrored**: xterm still processes the key while the webview posts `dormouse:runWorkbenchCommand`, and `message-router.ts` revalidates it against the same set before `vscode.commands.executeCommand`.

Source of truth: `attachRouter` in `vscode-ext/src/message-router.ts`, pinned by `vscode-ext/test/message-router.test.ts`.

### Extension manifest

**Must activate on the contributed view, restored editor panels, or an invoked contributed command** (command activation is implicit on the supported VS Code versions). **No `configuration`, no `keybindings`, no context key**: settings live in the in-webview Settings dialog, chords are handled inside the webview, and nothing is `when`-gated on Dormouse state ([Future](#context-keys)). Source of truth: `vscode-ext/package.json`.

### Webview hosting

The extension host is the platform host of `docs/specs/transport.md` → "PTY lifecycle": `pty-manager.ts` forks the pty-host child, the `WebviewView` and each `WebviewPanel` are the webviews, and each router owns its own PTY ids.

- Hiding or toggling the Dormouse panel neither kills its PTYs nor destroys sessions.
- **Closing an editor-tab `WebviewPanel` kills that panel's owned PTYs** (`killOnDispose`), and VS Code discards the tab's per-panel state. **Disposing the `WebviewView` releases its router and leaves the PTYs alive.**
- Each VS Code window gets its own extension host, and therefore its own pty-host child.

### Workspaces

> See `docs/specs/glossary.md` for the Workspace / Window containers and `docs/specs/alert.md` for the union status.
>
> Union reflection onto native chrome is always-on. The Window persistence container is standalone-only; VS Code keeps one bare `PersistedSession` per webview.

**One webview is one Workspace.** The bottom-panel `WebviewView` ("Dormouse") is the default Workspace; each `dormouse.open` editor-tab `WebviewPanel` is an independent Workspace. VS Code — not Dormouse — owns their tabs, creation, and closing, so **Dormouse adds no create/rename/close affordances here**: the webview mounts a bare `<Wall>` (`docs/specs/layout.md` → Workspaces). A Workspace's Surfaces are the terminal Sessions its router's `ownedPtyIds` hold plus the browser Surfaces rendered in it.

**The extension host refuses every Workspace-spanning `dor` request** — the container verbs, `dor list --workspaces` / `--all`, and any `--workspace` but this webview's own — before routing it, since no webview can answer for its siblings (`docs/specs/dor-cli.md` → "dor workspace"). **Its own Workspace is accepted by position *and* by name** (`DEFAULT_WORKSPACE_NAME`), so a ref read out of `dor list` can be handed straight back. Source of truth: `dorWorkspaceRefusal` in `vscode-ext/src/dor-workspace-guard.ts`.

#### Surfacing union status on native chrome

Each webview's union (`ringing` / `todo`) is computed over its router's `ownedPtyIds`, so **VS Code chrome reflects terminal Session ring + TODO only** — a browser Surface's TODO stays webview-local, `alert:state` being keyed by PTY-backed Session ids ([Future](#future)).

- **Editor tab (`WebviewPanel`):** the title carries the status as plain text; `panel.iconPath` stays the Dormouse mascot.
- **Panel view (`WebviewView`):** a presence **badge**, ring-vs-TODO in the tooltip. **Never use `view.title`** — a single-view bottom-panel container shows only its static title (rationale). `view.description` stays the shell name.

Reflection updates on every owned-PTY state change and on `claim` / `release`. Source of truth: `notifyUnion` in `vscode-ext/src/message-router.ts`; `vscode-ext/src/workspace-chrome.ts`.

WATCHING rules and the alarm settings (`docs/specs/alert.md` → Alarm settings) are app-global rather than per-Workspace, riding the seed / mutate / broadcast channel of `docs/specs/transport.md` → Message protocol.

**`alert:speak` goes only to a connected router whose `ownedPtyIds` hold its Session**; a due push goes to `pushAlert`: this window's service, else the broker's as an unanswered `push` peer frame, else dropped, never held. **This window is one more alert viewer, with no focus, present while `WindowState` reports it `focused` and `active`**; one that never reports `active` adds none (rationale).

Source of truth: `connectWebview` / `reportWindowPresence` in `vscode-ext/src/message-router.ts`; `pushAlert` in `vscode-ext/src/burrow.ts`.

### Shell selection

The selected shell is `dormouse.selectedShellPath`, read from `workspaceState` before `globalState`; **a global save clears the workspace value** so it cannot shadow the new default. Its name is mirrored into `WebviewView.description`, and `dormouse:selectedShell` keeps the webview's default-shell slot current.

`dormouse.newTerminal` focuses the view and posts `dormouse:newTerminal` with the selected shell. `dormouse.selectShell` opens a QuickPick and — **only when the pick differs from the previous selection** — focuses the view and posts `dormouse:newTerminal` with `replaceUntouched: true` and `announce: true` (`docs/specs/layout.md` → "Session lifecycle and terminal registry" owns what Wall does with it).

**The QuickPick is the only shell control here**: `VSCodeAdapter` sets `hostOwnsShells`, so the shared Settings dialog hides its Shell row. Source of truth: `vscode-ext/src/shell-selection.ts`.

### Serialization and restore

A `WebviewPanelSerializer` under the `dormouse` view type restores editor panels after a restart (`onWebviewPanel:dormouse` activates the extension early enough). The shapes it round-trips are transport.md's.

**Must persist every periodic save with current alerts** (`docs/specs/layout.md` → Session persistence). The WebviewView's `onSaveState` merges host alerts into `workspaceState` (`dormouse.session`); WebviewPanels use per-panel `vscode.setState()` from the frontend.

**Must serialize host saves and await them after the webview's flush acknowledgement, within the existing flush deadline**, before the deactivate refresh reads the snapshot. A failed write is logged without blocking later saves.

**On deactivate**, in this order, each step bounded:

1. Start closing browser sessions, joined after step 2 so it overlaps the capture. **Its rejection is absorbed** — a throw out of the join would skip the flush, the refresh, and both kills.
2. Capture agent recovery commands.
3. Flush every webview's session.
4. Refresh saved state from the still-live PTYs (CWD).
5. Graceful kill, then force kill.

**Must capture before the session flush and PTY kills** (rationale). Shared capture and durability follow `docs/compatible-agents.md`. Source of truth: `deactivate` in `vscode-ext/src/extension.ts`.

**On activate**, saved state loads through `readPersistedSession()` and is injected into the webview for cold-start restore. The WebviewView and each deserialized WebviewPanel then claim their own pane ids' recovery commands from the single record (`docs/compatible-agents.md` → "Recovery record"); **a panel's pane ids come from the `vscode.setState()` blob returned at `deserializeWebviewPanel`**, so recovery needs no host-side per-panel store.

#### Capturing agent recovery

**Must offer every live extension-host PTY to shared capture**, across the view and editor panels. **Must store the record under `storageUri`, falling back to `globalStorageUri`; never `workspaceState`** (rationale). If neither directory exists, skip capture.

Source of truth: `captureAgentRecoveryCommands` / `takeRecoveryCommands` in `vscode-ext/src/session-state.ts`.

### Theme integration

VS Code is the only host that supplies `--vscode-*` itself, so `lib/src/main.tsx` **must install** `installVscodeThemeVarResolver()` before React renders; the resolver, its observers, and the `dormouse.debugTheme` entry are `docs/specs/theme.md` → "Runtime model" and "Theme debugger".

### OSC color query answering

PTY parsing happens in the **extension host**, which has no DOM, so **the webview pushes its resolved colors up**: `dormouse:themeColors { foreground, background, cursor }` on `requestInit` and on every terminal-theme change. `message-router.ts` caches the latest push and feeds every PTY's parser through a `TerminalColorProvider`, answering `OSC 10/11/12 ; ?` exactly as the standalone sidecar does ([theme.md](theme.md#terminal-color-contract)). **Before the first push, or for an unparseable color, the query falls through to xterm.js.** Windows also needs `useConptyDll: true` ([theme.md](theme.md#osc-color-queries-on-windows-require-the-bundled-conpty)). Source of truth: `pushThemeColors` in `lib/src/lib/platform/vscode-adapter.ts`.

### CSP policy

The directives, with `randomSecret()` supplying the nonce:

```
default-src 'none'
style-src   <cspSource> 'unsafe-inline'
script-src  'nonce-…' 'strict-dynamic' 'wasm-unsafe-eval'
font-src    <cspSource>
img-src     <cspSource> data: blob:
connect-src <cspSource> ws://127.0.0.1:* ws://localhost:*
frame-src   http://127.0.0.1:* http://localhost:*
```

**`frame-src` is loopback-only** — `dor iframe` frames its target through the transparent proxy the extension host stands up, so the only origin ever embedded is loopback on an OS-assigned port; without it `default-src 'none'` blocks the frame and leaves a blank pane (`docs/specs/dor-browser.md`).

**The webview CSP carries no relay sources.** Its loopback `ws:` entries are for the host's guarded browser viewer sockets (`docs/specs/dor-browser.md` → Viewer Socket); the Burrow holds `/ws/burrow` from the *extension host*, which no CSP fences. **That relay origin is a build-time constant, never a runtime value**, baked into `dist/extension.js` by `vscode-ext/scripts/esbuild.mjs` (`docs/specs/relay.md` → "Relay origin").

`'unsafe-inline'` for styles covers the theme variables VS Code injects inline on `body`. **Must mint a fresh per-render nonce from 24 CSPRNG bytes, never `Math.random()`**, and nonce-gate the boot globals.

**`lib/index.html` keeps `<head>` and `</head>` bare**: both splices match a literal and **throw when it is absent**, an attribute otherwise yielding an unpoliced document.

**A nonce alone does not survive code splitting**; both mechanisms below are required, since a nonce is **not** inherited through the module graph and `'strict-dynamic'` does not vouch for a parser-started fetch:

- **Vite stamps the nonce** onto every tag it emits (`html.cspNonce` in `vscode-ext/vite.config.ts`, placeholder `CSP_NONCE_PLACEHOLDER`): the entry `<script>`, its `<link rel="modulepreload">` tags, and the `<meta property="csp-nonce">` its runtime preload helper reads (rationale). `getWebviewHtml` swaps the placeholder for the real nonce and **throws if it is absent**.
- **`'strict-dynamic'` covers the fetches no tag represents** — the entry's static imports and every lazy `import()`. It widens what a trusted script may *load*, never what may be *written into* the document; nothing grants `script-src 'unsafe-inline'`, and **adding `webview.cspSource` to `script-src` would be dead weight**.

**Keep `'strict-dynamic'`** even though no experiment shows it load-bearing (rationale): it is the mechanism CSP specifies for "a script the nonce vouched for may load more".

**`'wasm-unsafe-eval'` permits WebAssembly compilation and nothing else** — `eval` stays blocked. What needs it is [layout.md](layout.md#inline-graphics). (rationale)

**String inspection proves nothing** (rationale), so two checks cover the policy, **neither replacing the other**: `vscode-ext/test/webview-boot.smoketest.ts` loads the real bundle under the real policy in Chromium, and `vscode-ext/test/webview-html.test.ts` pins the transform against a fixture of real Vite output.

Source of truth: `getWebviewHtml` in `vscode-ext/src/webview-html.ts`, `assertRelayOriginBaked` in `scripts/relay-origin.mjs`, `bakedRelay` in `lib/src/host/relay-origin.ts`.

### Webview message authentication

**The webview's `window` is a shared inbox, so `event.data.type` cannot decide trust**: any framed surface (`dor iframe`, agent-browser; `docs/specs/dor-browser.md`) can `parent.postMessage` into it across origin and sandbox boundaries, and the CSP governs only what the document may *load*. A forgery could drive a `writePty` (rationale). Host-originated messages are therefore authenticated by a **per-boot message token**:

- **Must mint a fresh message token per document from 24 CSPRNG bytes**, distinct from its CSP nonce, and inject it only through the nonce-gated boot script.
- **`serveWebview` is the only way to put a document on a webview**: minting, assigning `webview.html`, and returning a `WebviewChannel` whose `post()` closes over that token are one step, so a token cannot drift from its document; re-serving yields a new token and channel.
- **Every host → webview send goes through a channel**, making a bypass a type error.
- **Never add a `message` listener that skips `isHostMessage`**: `VSCodeAdapter` captures the token once, at construction, and each of its listeners checks `isHostMessage(event.data, token)` before reading anything else, `type` included.

**Never swap the token for an `event.source` / `event.origin` check, and never reuse the CSP nonce as the token** (rationale). **The guard fails closed both ways**: a webview served without the global accepts nothing, a host send without a token delivers nothing, and framed content cannot read the parent's globals cross-origin.

Proxied-iframe messages are guarded by origin instead (`docs/specs/dor-browser.md`); the token covers only the adapter's host channel. **Scope is VS Code**: standalone receives host events over Tauri IPC or the browser-dev HTTP/SSE bridge, never `window.postMessage`.

Source of truth: `serveWebview` in `vscode-ext/src/webview-messaging.ts`, `VSCodeAdapter` in `lib/src/lib/platform/vscode-adapter.ts`; pinned by `lib/src/lib/platform/vscode-adapter.test.ts`.

### Burrow: a service in the extension host

The shared `BurrowService` (`docs/specs/relay.md` → "Burrow side", which owns the webview's responder-plus-UI split and the store contract) runs in the extension host; VS Code's part is where its state lives, which window runs it, and what the webviews still do. **Nothing a webview says can widen access** (`docs/specs/remote-security-model.md`).

**The store.** **The enrollment** (`{ relayUrl, burrowId, burrowToken, origin, rpId, label }` plus this machine's Noise static) **goes to `SecretStorage`** (OS keychain), since `burrowToken` and the static's private half grant `/ws/burrow` and this Burrow's identity; **the ACL — public keys plus each Client's push `deliveryId` — and the network policy go to `globalState`** (`docs/specs/remote-network.md` → "Policy"). All are global rather than workspace-scoped: a Burrow identity belongs to the machine, not a folder.

**The enrollment is memoized, and the memo must be invalidated across windows**: the store drops it on any `secrets.onDidChange` for the enrollment key, which every window receives (rationale). **Neither the ACL nor the policy is memoized.** **That subscription also lets a window un-enrolled at activation join a Burrow a sibling just created**, with no reload.

**The one-time serving marker is the one `SecretStorage` entry that is not a credential.** While the broker's one-time connection is serving (`docs/specs/one-time.md` -> "Service and hosts") it keeps `dormouse.burrow.one-time-serving` present, and a window that reads it — at activation or on `secrets.onDidChange` — contends as an enrolled one would, so an un-enrolled sibling joins the peer net and its terminals reach the phone. **The broker writes it only on a flip, and clears it when serving stops, when its window deactivates holding it, and whenever a service starts** (retiring a crashed broker's); **a window that never set it never clears it**.

Source of truth: `VsCodeBurrowStateStore` in `vscode-ext/src/burrow-store.ts`, `markOneTimeServing` and `contendIfServing` in `vscode-ext/src/burrow.ts`.

**Which window: bind-as-lease.** Unarbitrated, every window's extension host would start a Burrow against the same enrollment and fight over the one `/ws/burrow` socket (rationale), so **the bind is the lease**. Every contending window binds one fixed path — `<hash>.sock` in a per-user `dormouse-peer-<uid>` directory in the temp dir, or `\\.\pipe\dormouse-peer-<hash>` on Windows — **the hash is the first 12 hex characters of SHA-256 over `context.globalStorageUri.fsPath`**, so every window, whatever its build, computes the same path (hashed for the platform path cap; rationale). The winner is the broker and runs the service; everyone else connects to it as a client.

- **Roles never flip downward**: no `onRole(false)` after a `true` (rationale).
- **Contend on broker death, not on a timer**: when the broker exits every client's socket closes and they race to bind; `bind` picks exactly one. No TTL, heartbeat file, or watcher.
- **A corpse is cleared, then the bind is re-checked**: **never unlink on the first refusal**, and a window whose bound socket was replaced or removed stands down (`stillOurs`; rationale).
- **A bind is not a role until it is believed**: every "is this window the broker" answer reads `brokerConfirmed`, so **unverified reads as unsettled** and a command landing mid-verification is held for the verdict (rationale).
- **Errors after `listen` are logged, not thrown**, so a late server error cannot take the extension host down (rationale).

**Trust.** The socket path is derived, not secret, so two layers stand between it and this installation's terminals.

*The directory.* On unix every bind and connect is held to `peerDirIsSafe()`, the predicate the `dor` control socket uses (`docs/specs/dor-cli.md` → Control-channel security). A loose directory we own is tightened; anything else is somebody else's and **the peer link stands down for good**, releasing the callers waiting on the contention. Windows named pipes carry their own ACL and skip this layer.

*The handshake.* The shared secret is a mode-0600 `burrow.peer-token` in `globalStorageUri`, **created once with an exclusive `wx` write rather than a rename** so two windows starting together agree on one token. **Treat an empty read as *not yet written*, never as the token** (rationale); **exhausting that bounded wait latches the same permanent stand-down** as an unsafe directory. The token **never crosses the socket**; three frames prove mutual knowledge of it:

1. `challenge { nonce }` — the *server* speaks first, on accept, so a client never volunteers a proof into whatever bound the path.
2. `hello { nonce, proof }` — the client answers `HMAC-SHA256(token, "client:" + relayNonce)` with a fresh nonce of its own.
3. `welcome { proof }` — the server verifies in constant time, then answers `HMAC-SHA256(token, "server:" + clientNonce)`.

**Domain-separate the two proofs (`client:` / `server:`)**, or a fake server could reflect the client's proof back as its welcome. **The client verifies the welcome before it sends or answers anything else** — it forwards no notifies (they queue), answers no requests, streams no PTY, forwards no commands — and an unverifiable welcome closes the socket (rationale). **Fresh nonces per connection** make a captured proof worthless on the next. **Parseable JSON that is not a frame object is rejected on both ends**, a first frame that is not a valid hello drops the socket, and **each side bounds the handshake to `HANDSHAKE_BUDGET_MS`**.

**Nothing starts until there is a Burrow to run.** Contention begins when activation finds an enrollment for the baked origin or the serving marker, when `secrets.onDidChange` reports another window wrote one, or on the first `enroll` / `enrollOffer` / `beginHostedEnrollment` / `oneTimeOpen` / `setNetworkPolicy` from any webview — **the only commands that may start it**, the last **so the service stays the policy's only writer**. A user who never enrolls, opens a link, or changes the policy never sees a socket. **The service runs independently of webview lifetime**: a broker window with zero Dormouse webviews still relays, contributing an empty directory.

**A command that arrives mid-contention is held, not refused** (rationale): commands queue, bounded with the oldest refused on overflow, and drain when a role settles — to the service if this window brokered, over the link if not. **Each carries its own deadline, under the adapter's command timeout**, so a contention that never settles produces a reason rather than a timeout.

**A window with no Burrow at all still answers the read-only commands** — `status`, `pushDevices`, `pairingQueue`, `oneTimeStatus`, `networkPolicy`, `dismissPathRefusal`, `oneTimeEnd`, `cancelHostedEnrollment`, `takeBack` — **exactly as an idle service would**, from builders shared with the service; the policy is read and never saved. `pushDevices` answers `null` for "nowhere to push" and rejects only when the Relay could not be asked (rationale). The idle `status` reads the installer's offer file, so the one-click card renders on a machine no window has a Burrow for. **Everything else refuses with an error**, so the console hook fails fast.

Source of truth: `vscode-ext/src/burrow.ts`, `ensurePeerNet` in `vscode-ext/src/peer-link.ts`; pinned by `vscode-ext/test/burrow.test.ts` and `vscode-ext/test/peer-link.test.ts`.

**The webview bridge.** A webview reaches the service over `BurrowLink`, implemented in `vscode-adapter.ts` on three messages, each wrapping the shared client's shape in a `payload`: `burrow:command { payload: BurrowCommand }` out, `burrow:result { payload: BurrowResult }` and `burrow:event { payload }` back. **Everything else is the shared client** in `lib/src/host/remote/link-client.ts` (`docs/specs/transport.md` → Message protocol). Results are **broadcast to every webview in the window**, and one correlation id serves both the in-window fan-out and the cross-window forward.

Events are pushed: `pairing-queue` (a complete snapshot — **the mirror replaces rather than merges**), `status { enrolled, serving, serviceId }`, `one-time` (`docs/specs/one-time.md`), and `network-policy`. The queue is pushed only when it changes, so **the webview asks for it once on every transition to serving**.

**Volunteering is serving-gated; answering is not.** `armWhile` (`lib/src/remote/burrow/enrolled-gate.ts`) arms the outbound announcing only while `serving` — which a one-time connection sets without an enrollment — and the push device list only while `enrolled`, driven by the `status` event and seeded by one `status` command at install time. **The seed cannot lose a race with the event**: both travel the same ordered channel.

**The relay socket.** The supported `engines.vscode` range spans the Node version that added `globalThis.WebSocket` (rationale), so the service **must be constructed with a factory** that prefers the global and falls back to the bundled `ws`. **`ws`'s optional native accelerators `bufferutil` / `utf-8-validate` are `external` and never shipped**. **The same factory opens the one-time rendezvous, which must carry no `Origin` header** — neither implementation sends one. Source of truth: `createRelaySocket` in `vscode-ext/src/burrow.ts`.

#### The direct path

**The broker's extension host answers a `direct-offer`** (`docs/specs/remote-api.md` → Transport → "Direct path") over the same lazily loaded `node-datachannel` polyfill as the sidecar, in-process (rationale), so a native crash there takes down that window's extension host. **Tear the addon down only at deactivation**: the teardown is terminal for the process, and a window that later wins the lease again still needs a factory that loads.

**One universal VSIX carries every platform's addon**: the build `pnpm deploy`s the extension's production closure for every os and cpu, verified against `pnpm-lock.yaml` (rationale), and stages the addon, its dependencies, and the platform packages `vscode-ext/package.json` declares under `optionalDependencies` into `dist/node_modules`. `node-pty`'s one package carries every prebuild. **Keep the addon `external` to `dist/extension.js`**, which the build asserts.

Source of truth: `vscode-ext/scripts/stage-native-direct.mjs`; `initBurrow` in `vscode-ext/src/burrow.ts`; `createNativeDirectPeerFactory` in `lib/src/host/remote/native-direct-peer.ts`; `assertNothingInlined` in `scripts/assert-not-inlined.mjs`.

### Peer surfaces

The service owns the PTYs but not the *view* of them: each webview is its own JS realm with its own xterm registry, and only a webview knows what a pane is called, whether it is focused, and how big its xterm is. So the service asks, and every webview answers for its own. **Peers on both tiers may run different builds** — VS Code windows of one installation keep their build until reloaded, and `status.hostedEnrollment` is the one field a newer broker may extend.

| Contract | In-window tier | Cross-window tier |
|---|---|---|
| Query | `brokerRequest` posts `peer:ask` to every live webview, collects `peer:answer`. | Broker sends `request` to every peer; each peer runs its own `brokerRequest`, never `askBothTiers`, returns `result`. |
| Operation schema | `(op, params) → zero or more results`; `op` opaque to the transport, the typed map only in `peer-surfaces.ts`. | Same seam; only a reserved `ptyId` is interpreted, for routing. |
| Ownership / miss | Presence is ownership; every webview answers, including with no results. | Every peer answers; disconnect settles its pending asks empty. |
| Fan-out order | All webviews in parallel. | `askBothTiers` runs local and all peers in parallel, local concatenated first. |
| Budget | `ASK_BUDGET_MS` (1 s; another build's peer runs its inner ask inside this window's 3 s `PEER_REPLY_BUDGET_MS`, so never raise it to 3 s or more); disposal removes that webview from the outstanding set. | `PEER_REPLY_BUDGET_MS` covers the inner ask plus socket hops, and **is defined as `ASK_BUDGET_MS + 2_000`** so it cannot fall under it. |
| Invalidation | `peer:notify` carries no subject; pane/activity/focus bursts coalesce before crossing. | `notify`, webview membership, and peer membership each trigger a fresh directory collect. |
| PTY stream | One window-wide keyed registry distributes already-processed data/exit. | Opaque routed handles select one peer; `subscribe` is reference-counted, streaming the same processed data/exit. |
| Burrow command | This window calls its service, broadcasting the uniquely correlated result to its webviews. | `command` goes to the broker, `commandResult` returns only to its origin window, `uiEvent` broadcasts. |

**Every webview installs the responder**, broker or not; it carries none of the relay, enrollment, or pairing machinery. **Installing must be idempotent per link** (rationale).

**Each webview counts once, and a late answer repairs the snapshot**: a duplicate answer cannot contribute the same panes twice, and an answer for an already-settled request **triggers a directory invalidation instead** (`docs/specs/remote-api.md` → Directory).

**A peer answer belongs to the authenticated broker socket that asked for it**: if that broker disappears mid-fan-out the answer is dropped even when this window has already connected to a replacement, since **request ids restart per broker**. A rejected fan-out contributes an empty answer. **Nothing in an answer but its `ptyId` (`routedPtyId`) is interpreted below the Burrow.**

**Attach-is-the-resize is answered by the owning webview's live xterm, never the PTY directly** (`docs/specs/remote-api.md` → "Size authority: last-attach-wins"). **Cross-window attach fans out a read-only `resolve` first and the first answer is the answer**: the mutating `attach` and every later handle resize go only to that answer's tier and peer, so duplicated cold-restored windows do not both resize. The owner replies with the size it settled at plus the `ptyId`; the service then streams that PTY. **`release` goes where the attach went** — to both tiers and every window when no answer selected one — and is answered with nothing. Take back is an ordinary command, forwarded to the broker. The ask-backed provider is shared with standalone (`createAskSurfaceProvider`); missing resize answers follow `docs/specs/remote-api.md` → "Attachment invariants".

**No second strip parser**: the service's `streamPty` subscribes to the extension host's own per-PTY parse (`docs/specs/terminal-escapes.md` → "Parsing location"). **A sink subscribes to the PTY it watches and to no other**, so an unattached terminal costs nothing and each sink gets its own mid-string hold.

Source of truth: `installPeerSurfaceResponder` in `lib/src/remote/burrow/peer-surfaces.ts`, wired from `lib/src/main.tsx`; `vscode-ext/src/processed-pty-streams.ts`.

### Peer surfaces across windows

The broker window listens on the authenticated local socket and every other window connects. **The directory deduplicates by `surfaceId` and attach selects the first answer in the same local-first order**, so a duplicated cold-restored id is shown from the owner attach will reach.

**Cross-window streams are reference-counted per routed PTY**: two attachments to one foreign surface share one `subscribe`, only zero-to-one starts the owner forwarding and only one-to-zero stops it. **The owner answers the first `subscribe` with `subscribed` only after its sink and atomic liveness check are installed**, a recorded exit going first on the same ordered socket, so an exit cannot be overtaken by a successful attach. **The last unsubscribe stops the forwarding but keeps the route** (rationale). **Routes are refreshed by every resolve and dropped only by an `exit` frame or the owning window disconnecting** (`forgetPeerRoutes`).

**Never key routes by a raw `ptyId`** — pane and PTY ids are unique only within a window, and cold restore can duplicate them across windows (rationale). The broker replaces an answer's owner-local `ptyId` with an opaque route handle for the `(peer socket, ptyId)` pair; follow-up surface asks address that peer alone, and `subscribe`, `write`, and PTY-only `resize` translate it back to the owner's id on that socket only. **The handle is checked against this window's PTYs and stays in the peer namespace after its route closes**, so a stale handle fails closed. **When a peer disconnects, every handle routed to it is dropped and reported as exited.**

**Never send a result both ways**: the broker's `commandRoutes` records which window is owed each in-flight `burrowRequestId`; an answer with an entry goes to that socket alone, one without to this window's webviews (rationale). A disconnecting window's routes are dropped, its commands left to the asking adapter's timeout, and **whatever the broker was still asking it is settled empty on the spot**. **A `result` frame is taken only from the window the request was put to.**

**Pairing UI events are unaddressed and broadcast to every window's webviews**, so the approval modal appears wherever the user is looking. **When a window completes the handshake the broker sends it the current `status` and `one-time` events**, which are otherwise emitted only on change.

**Must bound every peer frame at 4 MiB of UTF-8 (`FrameDecoder`'s default; never lower it, since another build's windows send up to it) before parsing**, complete frames and partial tails included; an oversized frame is discarded through its newline without losing adjacent valid frames. **Socket bind errors reject startup** and are handled as an unavailable peer link, never a pending promise or an uncaught extension-host error.

Source of truth: `vscode-ext/src/peer-link.ts`; `vscode-ext/src/peer-link-protocol.ts`, pinned by `vscode-ext/test/peer-link-protocol.test.ts`; `askBothTiers` in `vscode-ext/src/burrow.ts`; `brokerRequest` in `vscode-ext/src/message-router.ts`.

### Build and development

**The build does not typecheck**: esbuild strips types, so `tsc` runs as `pnpm typecheck`, **wired into the package's `test` script** so the root `pnpm test` covers it — the only check protecting `deactivate()`, which has no `try`/`catch` (rationale). Source of truth: `vscode-ext/package.json`.

**The extension makes no update check of its own**: VS Code updates it from the Marketplace, and never auto-updates one installed from a VSIX (rationale). **`engines.vscode` must stay at `^1.92.0` or later**, the first VS Code that pins a VSIX install, so a self-host VSIX keeps the Marketplace identity and is never replaced unasked.

## Future

### Webview→host Surface-state channel

A webview→host Surface-state message would let the native-chrome union count browser-Surface TODOs, which the PTY-keyed `alert:state` cannot carry (`docs/specs/alert.md`, `docs/specs/transport.md`).

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

Palette/keybinding entry points for what today is webview-only; the shipped set is in "Extension manifest".

| Command | Description |
|---------|-------------|
| `dormouse.newPane` | Split a new pane in Dormouse |
| `dormouse.closePane` | Close the focused pane |
| `dormouse.nextPane` | Focus next pane |
| `dormouse.prevPane` | Focus previous pane |
| `dormouse.enterPassthroughMode` | Switch to passthrough mode |
| `dormouse.enterCommandMode` | Switch to command mode |
| `dormouse.listSessions` | QuickPick of all live PTY sessions |
| `dormouse.reattach` | Reattach a minimized PTY to a pane |

### Other host integrations

- `TerminalProfileProvider` registration, so Dormouse appears in the terminal `+` dropdown
- A status bar item showing active session count
