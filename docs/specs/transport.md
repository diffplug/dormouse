# Transport and PTY Protocol Spec

> Adapter-agnostic protocol shared by every `PlatformAdapter`. Covers PTY lifecycle, buffering, the webview ↔ platform message protocol, persisted-session types, and the invariants every adapter must honor. Host-specific layering lives in `docs/specs/vscode.md` and `docs/specs/standalone.md`; the phone's adapter in `docs/specs/pocket-app.md`. See `docs/specs/glossary.md` for the Process / Link state vocabulary, `docs/specs/alert.md` for `AlertManager` semantics, and `docs/specs/terminal-state.md` for the semantic events delivered over this transport.

## Adapter model

Each platform adapter wraps a PTY-spawning runtime and a transport channel between webview and host process. The webview is a thin view layer; PTYs and `AlertManager` live on the platform side. `lib/src/lib/platform/types.ts` defines the `PlatformAdapter` interface every adapter implements.

| Adapter | Host runtime | Transport |
|---|---|---|
| VS Code extension | extension host (Node.js) | `vscode.Webview.postMessage` ↔ `acquireVsCodeApi().postMessage` |
| Standalone (Tauri) | sidecar process | Tauri command/event bridge |
| Standalone browser-dev | sidecar process + local dev HTTP bridge | fetch commands + Server-Sent Events |
| Pocket (`RemotePtyAdapter`) | the paired laptop's Host | remote protocol-v1 over the relay (`docs/specs/remote-api.md`) |
| Fake (tests, playground) | in-process | direct function calls / event emitter |

`RemotePtyAdapter` implements only the PTY core (list/data/write/resize/exit) and no-ops or omits the rest — the interface is built for capability degradation, so a host that cannot do something says so by absence rather than by the UI branching on which host it is.

Three optional members are plain booleans rather than methods:

- `persistsSession?` — absent reads as `true`. `TauriAdapter` sets it `false` (see "The governing rule"), which makes `saveSession` skip the whole record build, not just the write — the per-pane `getCwd` round trips are the expensive part. The browser-dev adapter leaves it absent and still writes to `localStorage`, so the harness restores sessions the real app deliberately does not.
- `hostOwnsTheme?` — absent reads as `false`; `VSCodeAdapter` sets it `true`, so the Settings dialog hides its theme picker there (`docs/specs/theme.md` → "Where the user picks a theme").
- `hostOwnsShells?` — absent reads as `false`; `VSCodeAdapter` sets it `true`, so the Settings dialog hides its Shell row in favor of the native QuickPick (`docs/specs/vscode.md` → "Shell selection").

### Standalone browser-dev harness

Source of truth: `standalone/scripts/dev-agent-browser.mjs`, `standalone/scripts/dev-host-guard.mjs`, `standalone/src/browser-sidecar-host.ts`, `standalone/src/browser-sidecar-adapter.ts`.

`pnpm dev:standalone:ab` starts the standalone sidecar directly, starts a localhost-only HTTP bridge, starts Vite with `VITE_DORMOUSE_BROWSER_DEV_HOST`, and opens the app URL in an `agent-browser` session. The browser build uses `BrowserSidecarAdapter` instead of `TauriAdapter` when that env var is present.

The bridge is a transport shim over the same sidecar protocol, not a second PTY implementation: fire-and-forget commands `POST /__dormouse_dev_host/send`, request/response commands `POST /__dormouse_dev_host/invoke`, host→webview events over `GET /__dormouse_dev_host/events` as SSE, and browser console output mirrored to `POST /__dormouse_dev_host/console` so one terminal shows sidecar, Vite, and in-browser logs together.

**The bridge is authenticated, and loopback is not what makes it safe.** It dispatches `pty_spawn` into the sidecar with caller-supplied `shell`, `args`, `cwd` and `env`, so reaching it is arbitrary command execution as the developer — and the threat is a web page open in that developer's own browser, which loopback does nothing to stop. Four rules, enforced in `standalone/scripts/dev-host-guard.mjs`:

- **Every request carries `?t=<token>`**, a per-run 24-byte credential the harness mints and bakes into the `VITE_DORMOUSE_BROWSER_DEV_HOST` URL, compared with `timingSafeEqual` over SHA-256 digests (equal-length inputs, so a wrong guess is refused rather than throwing). It rides the query rather than an `Authorization` header because `EventSource` cannot set headers and `/events` is gated like the rest; `BrowserSidecarHost.url()` is the only place that attaches it, so no call site can forget it. Distinct from the `dor` control-API `controlToken` handed to every spawned shell — the bridge's circle is smaller.
- **`Host` must be `127.0.0.1:<port>` or `localhost:<port>`**, against DNS rebinding — a hostile domain re-resolved to loopback arrives with its own name in `Host`, and the browser treats it as same-origin so CORS never applies.
- **Non-GET requests must be `application/json`.** Without it the endpoints are CORS-*simple*, so a foreign page can POST `mode: 'no-cors'` and, though it cannot read the reply, the request still executes. A non-simple type forces a preflight it cannot pass. Enforced in the gate rather than the body reader, so a route that never parses a body is covered too.
- **`access-control-allow-origin` names the Vite origin exactly, never `*`**, on every response including the SSE stream — under `*` the clipboard invokes were readable cross-origin. Both loopback spellings of that origin are accepted and echoed back: they are the same dev page, and pinning one would reject a developer who typed the other with symptoms (blank terminal, console CORS errors) that do not point at the cause.

The gate runs before routing and before any body read, and an unauthorized caller gets the same `404 not found` as an unknown path, so the port does not identify itself. Agent workflows are unaffected: the token reaches the page through the env var the harness already sets, and `agent-browser` drives the Vite origin, never the bridge. The harness prints the token and a ready-made `curl` on startup.

The remote Host rides the same shim: `remote_host_command` is one more fire-and-forget send that writes `remoteHost:command` to the sidecar, and the sidecar's `remoteHost:*` events arrive on the SSE stream, so the harness runs a real Host against a per-run temp state directory (`docs/specs/standalone.md` → "Remote Host service").

The harness may omit native-only desktop chrome such as window controls and update checks, but it must preserve the `PlatformAdapter` PTY, control-request, clipboard, iframe-proxy, remote-Host, and agent-browser contracts used by the app. It also mirrors standalone's Session-persistence answer rather than choosing its own: `BrowserSidecarAdapter` carries the same `PERSIST_SESSION = false` gate as `TauriAdapter`, reports `persistsSession: false`, and deletes any pre-gate `localStorage` blob on `init()` (`docs/specs/standalone.md` → "Standalone persists no Session state"). Persisting here would restore panes across a reload that the real app drops, and would run the record build and its per-pane `getCwd` round trip on a path production never takes. Tauri APIs must not be required at static module-evaluation time when `VITE_DORMOUSE_BROWSER_DEV_HOST` is set, because the page is loaded by a normal browser rather than the Tauri WebView.

## PTY lifecycle

PTYs are managed by the platform host, not by the webview. The webview **resumes** over live PTYs (host-preserved) or **restores** from a Snapshot (cold start). See `docs/specs/glossary.md` for the Process / Link states.

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
- The webview becoming visible again resumes over still-owned PTYs and reapplies the saved visible-pane layout when the saved session covers the live PTY set and the layout's leaf set matches.
- A PTY process that exits naturally can remain mounted as an exited pane; frontend semantic state such as CWD, title candidates, and last command is retained until the Session is actually disposed.
- Each message router tracks which PTYs it owns; PTYs cannot be stolen by another router.
- Explicitly killed PTYs are **tombstoned** in the host (`Process: Tombstoned`) so a late child-process `exit` event cannot recreate their buffer and make them resumable. In `pty-manager.ts` that is an explicit killed-id set; in `pty-core.js` it falls out of `bufferScrollback` never creating an entry `spawn` did not.
- Multiple host instances (e.g. multiple VS Code windows) each get their own pty-host child process.

### PTY buffering

`pty-manager` keeps two buffers plus one counter per PTY:

- **replayChunks** — cleared on first consume, used for resume (webview hidden then shown).
- **scrollbackChunks** — never cleared short of `kill`/`killAll`, used for repeat resumes (a re-serving router's replay buffer is already spent) and for recovery capture at teardown. Host-side only — no adapter exposes it to the renderer.
- **receivedChars** — every char ever buffered, never decremented by a trim. See "A position in a pane's output is a received count" below.

Both buffers are capped at 1M chars per PTY; at the cap the oldest chunks are trimmed.

### Reconnection protocol

```
1. Webview becomes visible (or panel deserializes).
2. Webview sends: { type: 'dormouse:init' }.
3. Host responds with:
   - { type: 'pty:list', ptys: [{ id, alive, exitCode, shell }] } // all owned PTYs
   - { type: 'pty:replay', id, data }                             // buffered output per PTY
   - { type: 'alert:state', id, … }                               // current alert state per PTY
4. Webview restores terminals from replay data, including each PTY's launch-shell path so the
   rebuilt terminal registry retains its Session-specific parser family for clipboard/drop escaping.
5. If the saved session covers those live PTYs, the frontend uses the saved Lath layout when its
   leaf set matches and reattaches saved minimized doors; minimized PTYs are registered but remain
   doors instead of visible panes.
```

Saved pane and door titles are seeded back via `setTerminalUserTitle()`, which rejects titles starting with `<idle>` — the sentinel that prefixes the auto-generated finished-pane header. The seed callers in `terminal-lifecycle.ts` additionally skip `<unnamed>` so the default panel placeholder is not seeded as a real user pin. (Persistence cannot tell a deliberate `<unnamed>` pin from the default placeholder, so a user who explicitly pinned `<unnamed>` sees it revert to the derived header on reload.)

For cold restore (no live PTYs), the webview falls back to saved session state: it spawns new PTYs in saved CWDs using the currently selected Dormouse shell and restores the saved Lath layout. No transcript is replayed ("What is persisted" below), and any pane carrying a recovery command auto-runs it. The entry module (`reconnect.ts`) uses a 500 ms timeout when waiting for the PTY list.

## Message protocol

Source of truth:

| Scope | Source |
| --- | --- |
| Message schema | `vscode-ext/src/message-types.ts` (`WebviewMessage`, `ExtensionMessage`; other adapters import or mirror it) |
| Persisted-session types | `lib/src/lib/session-types.ts` (shared webview/host boundary types) |
| Webview handlers | Adapter modules such as `lib/src/lib/platform/vscode-adapter.ts` and `lib/src/lib/platform/fake-adapter.ts` |
| Host handlers | The per-adapter message router |

The schema is exhaustive there; what follows is only the contracts that are not obvious from the type.

**Sender authenticity is the adapter's job, not the protocol's.** The schema says what a message means, never that it came from the host. Each adapter must establish that on its own transport before dispatching: the Tauri and browser-dev adapters inherit it from a private IPC channel and a host-owned socket, while the VS Code adapter shares its `window` inbox with framed surfaces and so requires a per-boot token on every host message (`docs/specs/vscode.md` → "Webview message authentication"). An adapter whose transport is reachable by page content must authenticate before it branches on `type`.

VS Code-only workbench chord mirroring uses `dormouse:runWorkbenchCommand` from webview to host. The host validates the requested command against the allowlist in `lib/src/lib/vscode-keybindings.ts` before calling `vscode.commands.executeCommand`; generic command execution over the webview boundary is not allowed.

**Reaching the remote Host is one optional adapter member.** The Host is a service in the process that owns the PTYs, so `remoteHost?: RemoteHostLink` is present exactly when there is such a process behind the webview — standalone's sidecar, VS Code's extension host — and absent on the website, where the remote modules stay inert. Its four calls are `command`, `respond`, `notify` (argless — the directory is the only thing a peer answers), and `on`. The webview half — command correlation, the 15 s timeout, and the rule that an ask is *always* answered even when nothing matches — is `lib/src/host/remote/link-client.ts`, shared by all three adapters so no host settles a command differently; the wire contract both ends compile against is `lib/src/host/remote/service-protocol.ts`. Nothing crossing this seam carries authority: the service asks a webview only what its own panes are called and how big its terminals are (`docs/specs/remote-security-model.md`).

Each host maps those calls onto its own transport, and the message names differ:

| Host | command out | result / event in | ask in | answer / notify out |
| --- | --- | --- | --- | --- |
| VS Code | `remoteHost:command { payload }` | `remoteHost:result { payload }`, `remoteHost:event { payload }` (both broadcast to every webview in the window) | `peer:ask { requestId, op, params }` | `peer:answer { requestId, results }`, `peer:notify` |
| Standalone (Tauri, and the browser-dev harness) | `remote_host_command(payload)` → sidecar stdin `remoteHost:command` | sidecar stdout `remoteHost:result` / `remoteHost:event` | sidecar stdout `remoteHost:ask { rhId, op, params }` | the same command channel, as `cmd: 'answer' \| 'notify'` |

Two rules the table encodes. VS Code broadcasts results because an `rhId` is minted with a per-adapter random tag and is therefore globally unique, so only the adapter that asked can settle one — which is also what lets a losing window forward a command to the broker window and get its answer back (`docs/specs/vscode.md` → "Peer surfaces across windows"). Standalone's correlation field is `rhId` and **never** `requestId`, because Rust swallows any sidecar line whose `data.requestId` matches a pending invoke (`docs/specs/standalone.md` → "Remote Host service").

Workspace union status (`docs/specs/alert.md`) adds no new message. Standalone computes it in-webview — the app bar's workspace strip and the Walls share one webview, so the strip reads the activity store and browser-surface state directly. VS Code computes only the host-visible native-chrome projection, from the module-level `AlertManager` filtered to each router's `ownedPtyIds`; the host already receives every PTY's alert state, but it does not receive browser-surface TODO (the webview→host Surface-state message is staged — see `docs/specs/vscode.md` `## Future`).

| Direction | Message | Contract |
| --- | --- | --- |
| Webview → host | `alert:initializeWatchedCommands` | Offer the renderer's persisted WATCHING rules as the startup seed. A multi-webview host accepts only the first seed in its lifetime and replies with its canonical snapshot. |
| Webview → host | `alert:setCommandWatched` | Add or remove one bare command key without replacing unrelated app-global rules. |
| Host → webview | `alert:watchedCommands` | Canonical full WATCHING snapshot broadcast after initialization or mutation; each renderer replaces and persists its local mirror. |
| Webview → host | `alert:initializeSettings` | Offer the renderer's persisted alarm settings (`docs/specs/alert.md` → Alarm settings) as the startup seed. Same first-seed-wins rule. |
| Webview → host | `alert:updateSettings` | Replace the host's alarm settings after a user edit. The whole blob travels, including the fields only renderers consume, so every webview agrees. |
| Host → webview | `alert:settings` | Canonical settings snapshot broadcast after initialization or update; each renderer replaces and persists its local mirror. |
| Webview → host | `dormouse:openExternal` | Open a user-confirmed external URI from an OSC 8 hyperlink. Hosts must revalidate and reject malformed, control-character-bearing, or blocked pseudo-scheme targets (`javascript:`, `data:`, `blob:`, `about:` — `lib/src/lib/external-links.ts`). |
| Webview → host | `pty:getOpenPorts` | Request the TCP listening ports opened by a PTY's shell process **and all of its descendant subprocesses**. The host resolves them from the PTY's root pid and replies with `pty:openPorts`. Source of truth: `getOpenPortsForPid()` in `standalone/sidecar/pty-core.js` (the VS Code extension loads it through the `lib/pty-core.cjs` shim). |
| Host → webview | `pty:openPorts` | Reply to `pty:getOpenPorts`: `ports: OpenPort[]` (`{ protocol, family, address, port, pid, processName }`), de-duplicated by `(family, address, port)` and sorted by port then address. Empty array when the PTY is gone or enumeration fails. |
| Host → webview | `pty:data` | PTY output after state-driving supported OSC sequences have been parsed/stripped; `OSC 8` hyperlinks are preserved for xterm.js and routed only to the owning router. |
| Host → webview | `pty:replay` | Buffered raw output since spawn; the webview parses semantic OSCs during replay reconstruction without triggering alerts. |
| Host → webview | `dormouse:newTerminal` | Payload may include `shell`, `args`, display `name`, `replaceUntouched`, and `announce`; the webview replaces the selected untouched terminal in-place only when `replaceUntouched` is true, otherwise it spawns a new pane. |

Both settings messages carry renderer-supplied numbers that become host timers, so the host **must** revalidate rather than trust them: `AlertSettingsHost` runs every inbound blob through `normalizeAlertSettings`, which drops unknown keys, defaults missing ones, and clamps each delay into range. A webview cannot install a `NaN` or absurd attention window. The two directions share one adapter method — `alertPublishSettings(settings, { seed })` — because the seed/replace distinction only picks a message type; it is not a different payload.

Note the per-store cost: each app-global store relayed this way spends one `PlatformAdapter` push method plus an on/off listener pair, three message types, and a host coordinator with its own subscribe/unsubscribe. Two stores (WATCHING rules, alarm settings) is worth the directness. A third should instead collapse them into one keyed channel with a host-side key→normalizer registry, rather than paying the tax again.

The OSC parsing/stripping rules that produce `pty:data` and `terminal:semanticEvents` are specified in `docs/specs/terminal-escapes.md`.

## Persisted session types

Source of truth: `lib/src/lib/session-types.ts` defines the persisted-session interfaces (`PersistedSession` v3, `PersistedPane` — carrying `surfaceType` — `PersistedAlertState`, `PersistedDoor`, `PersistedSurfaceRefs`, and the container types `PersistedWorkspace` / `PersistedWindow`).

**The layout field.** A `PersistedSession` records the layout as `lathLayout` — the native Lath tree (`docs/specs/tiling-engine.md` → "Persistence"). Each `PersistedDoor` carries a Lath restore `token` as its sole restore payload.

**Workspace-scoped dor refs.** A `PersistedSession` may record `surfaceRefs`, a map from stable Surface id to the Workspace-local `dor` short ref (`surface:N`), plus `surfaceRefsNext`, the next number to hand out. The map belongs to the Workspace session, not to the layout: reordering, minimizing, reattaching, zooming, and browser render swaps preserve the ref. A killed Surface's entry is *dropped* from the map, and `surfaceRefsNext` is persisted independently rather than derived from it, so a retired `surface:N` is never reused for a different Surface — a target naming it fails instead of resolving to the wrong pane (`docs/specs/dor-cli.md` → Handle Model). On load the counter is clamped above the highest ref in the map, so a stale or absent counter cannot hand out a live ref's number. Old snapshots without the fields allocate refs from the restored Surfaces on first mount. Source of truth: `Wall.tsx` owns the runtime registry and `session-save.ts` writes it.

**Surface kinds in the snapshot.** Each `PersistedPane` records a `surfaceType` (`docs/specs/glossary.md`): `'terminal'` (the default, omitted from the row to keep terminal snapshots byte-identical) or `'browser'`. This is the discriminator that routes restore/resume. `restoreSession` skips terminal restoration for a browser pane, so it does not mint a stray PTY + xterm for each browser pane id (`session-restore.ts`); the resume plan keeps browser panes (and minimized browser doors) even though they have no live PTY, so the saved layout's pane set still matches and is not discarded (`reconnect.ts` gates the session's Lath layout on its leaf set). A browser pane rebuilds from the persisted layout (visible) or `PersistedDoor.params` (minimized); its render params (`renderMode`, `url`, agent-browser `session`) live there, not in `PersistedPane` — `surfaceType` alone is enough to route restore. A pane lacking `surfaceType` reads as `'terminal'`.

**Workspace/Window containers (implemented, dormant behind the `dormouse.flags.workspaces` flag; rollout ledger in `docs/specs/layout.md` `## Future`).** A `PersistedWorkspace` is a `WorkspaceId`, a user-facing `name`, and that Workspace's `PersistedSession`. The standalone Window's top-level snapshot is a `PersistedWindow` (its own `version: 1`) wrapping v3 sessions: the ordered `PersistedWorkspace` list plus the active `WorkspaceId`. VS Code does **not** use it; each webview persists exactly one bare `PersistedSession` — its single Workspace — through the same per-surface state API as today (`workspaceState` for the view, `vscode.setState()` per editor panel; see `docs/specs/vscode.md`).

The wrapping lives at the **standalone adapter boundary**, not in the shared save/restore code: `lib/src/lib/window-persistence.ts` translates between the host's stored top-level blob and the bare `PersistedSession` that `reconnect.ts` / `session-save.ts` operate on, and `tauri-adapter.ts` / `browser-sidecar-adapter.ts` route `getState` / `saveState` through its `loadSessionState` / `saveSessionState`. The blob round-trips through a `SessionKeyValueStore` — one synchronous key/value slot the host persists natively: `localStorage` in the browser-dev harness, a Rust-backed per-window file store in the real standalone adapter (`docs/specs/standalone.md` → Persistence), never WebKit `localStorage`. With the flag **off** (the default) these are identity passthroughs. With it **on**, load returns the active Workspace's session and save merges it back into the active slot, preserving the others.

Every read goes through `readPersistedSession()` / `readPersistedWindow()`. Both accept the canonical parsed object *or* a JSON-stringified blob (host state APIs may hand back the inner serialized string); both log and discard a present-but-unreadable blob so a corrupt save can never block startup. `readPersistedWindow` additionally drops Workspaces whose inner session is unreadable and repairs a dangling `activeWorkspaceId` to the first Workspace.

**The recovery command.** One agent resume invocation per surface (`claude --resume <id>`, `claude --continue`, `codex resume <id>`). It is the only thing that survives a teardown.

*It is not part of the persisted session.* `PersistedPane` carries no `resumeCommand`, and `normalizeSessionV3` strips one out of a pre-upgrade blob the same way it strips a transcript. The command is host-owned and single-use, so it travels out of band: the host puts `surfaceId -> invocation` on the webview's boot payload, and the renderer reads it through `PlatformAdapter.getRecoveryCommands()`. Keeping it off the session shape is what makes the one-shot guarantee structural rather than procedural — the webview has nothing to write back, so no save/restore cycle can carry a stale invocation past the destructive read below. An adapter whose host captures nothing simply omits the method.

*Who writes it.* Exactly one writer: a host teardown that interrupted a running agent, reading the live in-memory buffer (`captureAgentRecoveryCommands` in `vscode-ext/src/session-state.ts`). The renderer save path never derives it and never guesses. Standalone writes it never, because standalone persists no Session state at all.

*Who reads it.* Cold restore, which auto-runs it (`docs/specs/layout.md` → "Agent resume on cold restore"); nothing reads it on resume, where the agent is still Live. Exactly-once holds on two levels, because the capture interrupts every live PTY and those panes are spread across the Dormouse view and any number of editor panels. `takeRecoveryCommands` reads and unlinks the file on the first call of an activation — destructively even on a parse failure — so the durable copy is gone before any webview is served and a failed activation cannot replay it; within the activation each webview claims only the entries matching *its own* saved pane ids, and a claimed entry leaves the map. So no container can delete another's commands by resolving first, and a view that is disposed and re-resolved (moving the panel container, say) restores without re-running the agent. A record older than 7 days is discarded unread, bounding a host that never came back. Source of truth: `takeRecoveryCommands` in `vscode-ext/src/session-state.ts`, `getRecoveryCommands` in `vscode-adapter.ts`, `restoreSession` in `session-restore.ts`.

*Detection.* Source of truth: `lib/src/lib/resume-patterns.ts` (`detectResumeCommand`, `normalizeResumeCommand`) over the shared `stripTerminalControls` in `lib/src/lib/terminal-controls.ts`. Because this string is executed, four rules are load-bearing:

- **Only a known invocation plus an opaque id.** The command is *rebuilt* as label + captured id, never sliced out of the buffer, and the id grammar is alphanumeric/hyphen/underscore only — shell punctuation can never enter executable state. Anything trailing the id is dropped. The one thing that must follow the invocation is a word break, so `claude --continuex` is not an offer to continue; nothing stronger, because agents wrap hints in prose punctuation. Text *around* the invocation is not part of the judgement: codex's real hint is prose on the same line (`To continue this session, run codex resume <id>`), so the prose-tolerant match is load-bearing rather than hypothetical.
- **The scan window is stripped as a whole, in one pass**, so a string control whose payload spans an LF is removed as a unit. An *unterminated* string control (OSC, DCS, SOS, PM, APC) swallows the rest of the window rather than surrendering its payload — a window title cut mid-sequence must not read as terminal output. "Terminated" tracks what the renderer honours rather than ECMA-48 alone: ST in both forms (`\x1b\\`, `\x9c`), BEL for OSC, and — because xterm aborts a string control on CAN/SUB and ends one on a bare ESC — those three too, so a prompt printed behind an aborted sequence stays visible. A CSI the window was cut off *inside* is swallowed for the same reason: a tail ending `\x1b[38;5` must not surrender `38;5` to the greedy id pattern. Every escape sequence is matched by its full ECMA-48 shape (ESC, intermediates, one final byte) rather than by the Fe range, because `ESC 7`/`ESC 8` and `ESC c` have finals outside it and stripping only the introducer leaks the final byte into the text as a digit or letter. A payload whose *introducer* fell off the front of the window (chunk eviction can strand one) is unrecoverable here and grants no more than ordinary output already does.
- **Stripping runs in boundary mode, whose rule is inverted.** *Every* control becomes a newline rather than vanishing, except the two classes that neither move the cursor nor erase — SGR and charset designators, where the text either side really is contiguous. Deleting the rest welds text that was never adjacent on screen: cursor moves obviously (not only CSI ones — `ESC M` scrolls up, `ESC 7`/`ESC 8` bracket a redraw, `ESC c` resets, VT/FF/backspace move), but erasures too, since `\x1b[2K` means the text before it on that line is gone. Observed in the wild as a stored `claude --resume <uuid>codex`, where a redraw had put `\x1b[K\x1b[1;1H` between two screen regions and the greedy id pattern ate across the seam.
- **Rightmost match in the last 50 lines wins.** No pattern can span the newline a boundary leaves, so the stripped window is scanned whole; the rightmost match is the newest hint *by position*, so carriage-return-only redraws still select the newest visible one and pattern order never outranks recency. Restore revalidates through `normalizeResumeCommand` before typing, as defense against a snapshot written by an older detector.

## Persistence policy

### What is persisted

Structure only: panes (id, cwd, title, `untouched`, `surfaceType`, TODO/alert blob), doors and their Lath restore tokens, the Lath layout, and the Workspace's `dor` surface refs. **Scrollback is never persisted by any writer**, and neither is the recovery command (see above).

### Retiring the transcripts already on disk

Every pre-upgrade installation had a transcript-bearing snapshot in `workspaceState` or the standalone file store. Ignoring the field was not enough — the bytes had to go, and three rules keep them gone:

- `readPersistedSession` does not *require* `scrollback` on a pane (so a snapshot written without it is still readable) and **drops** it when present, along with any `resumeCommand`. A transcript can be read out of a legacy blob but never survives into a parsed Session, so nothing downstream can persist it forward.
- The first save after upgrade therefore rewrites each store without transcripts. Standalone, which stops reading its store entirely, clears the slot outright at boot rather than waiting for a save that may never come — including an orphaned sibling temp file left by a crash before atomic rename, which `load_session` cannot see but which still holds the legacy bytes.
- No writer accepts a transcript-bearing Session shape.

### The governing rule

**Dormouse restores only what it destroyed without asking.** Deliberately ending
something ends it:

| Boundary | Deliberate? | Outcome |
| --- | --- | --- |
| Standalone quit — idle, confirmed, or update-install | Yes | Fresh: one default terminal |
| Standalone crash / force-kill | No, but nothing was captured | Fresh |
| VS Code panel hide/show | No | Live resume over host PTYs, unchanged |
| VS Code Reload Window | No — an editor operation, not an ending | Restore structure + auto-resume agents |
| VS Code window close / application quit | No — window state is the host's contract | Restore structure + auto-resume agents |
| VS Code editor-tab close (`killOnDispose: true`) | Yes | Fresh for that panel |
| VS Code extension-host crash | No, but `deactivate()` never ran | Fresh |

Standalone therefore **persists no Session state at all.** A clean quit has nothing
to clear and a crash has nothing to recover; the write path itself is removed rather
than written-then-ignored, since the blob it wrote was the transcript-bearing one.
The *Sessions* survive a reload within a running app — resume reads the sidecar's
live PTY list, not disk — but the layout does not: `lib/src/lib/reconnect.ts` reads
`getState()` for the saved resume plan, so with nothing persisted every live PTY
lands in one tab group with doors and saved titles dropped. A legacy blob found at
boot is deleted, not read.

> Reserved: the workspaces-rollout scope (`docs/specs/layout.md` → `## Future`)
> assumes a persisted `PersistedWindow` in standalone. Reconciling multi-Workspace
> persistence with this rule is part of that scope, not this one.

### Capturing the recovery command

The agents print their resume invocation when **interrupted**, not when signalled:

| Mechanism | claude | codex |
| --- | --- | --- |
| SIGTERM to the pty leader | inert — an interactive shell ignores it | inert |
| SIGTERM to the foreground process group | prints | silent |
| **`^C` written to the pty** | prints, but only on a second press | prints, and a second press destroys it |

So capture writes `\x03` to the pty rather than signalling a pid. The tty line
discipline delivers SIGINT to the foreground process group itself, which means no
`tcgetpgrp`, no master fd that node-pty does not expose, and a path that exists on
ConPTY as well. The shell survives the interrupt, so the hint arrives as ordinary
`pty:data` into the live buffer.

**The second press is per-pane, and only on request.** The two agents want opposite
things: claude prints `Press Ctrl-C again to exit` on the first press and its hint
only on the second, while codex exits on the first press and prints its hint a
little later — and a second press arriving before that print finishes aborts it
entirely, leaving `Shutting down...^C` and nothing else. A timing window is not
sufficient: codex's latency is not a constant (~255 ms for a bare session, over
400 ms in a real project inside a pane), so any fixed window eventually
double-presses it. The loop is therefore:

1. one `^C` to every live PTY;
2. poll on a 40 ms tick, and send one more `^C` to a pane that has yielded nothing —
   either the moment it shows `Press Ctrl-C again`, or once ~600 ms have passed and
   the pane has been silent for ~200 ms. Both clocks start when the first press is
   *acked*, not when the teardown step is entered: they are statements about the
   agent, and the agent's clock starts when the `^C` lands. Measuring from entry
   folds the interrupt's own round trip (up to its 400 ms timeout) into the window
   and can fire the blind press while codex is still inside its first ~255 ms of
   silence. The poll's wall-clock ceiling (~1.2 s) is the one timing anchored to
   entry instead, because that one is a shutdown budget rather than an agent timing;
3. keep polling to that ceiling, storing each command the moment it appears.

Both halves of the gate are load-bearing. An ask-only gate is not enough: observed
in a real pane, codex answered the first press by *repainting its TUI* — 256 bytes
of cursor positioning ending on its footer hint — and carried on running, never
printing a hint and never asking. The silence requirement guards the other side,
since a second press landing mid-shutdown destroys the hint. Note that quiet is
used here as evidence that pressing again cannot interrupt a print already in
flight — *not* as evidence that the pane is finished.

**Do not try to finish early on quiet.** Codex says nothing for ~250 ms after the
interrupt and then prints its entire shutdown at once, so silence is what it looks
like *before* it speaks, not after. Two heuristics died on exactly that: settling
when detections stopped arriving (exited at +219 ms, capturing only the faster
agent) and settling when output stopped arriving (exited at +160 ms, capturing
nothing at all). The only sound early exit is having nothing left to wait for.
Polling to the ceiling is affordable precisely because the record is written
eagerly: the cost is budget taken from the later teardown steps, and those are the
ones whose data can be reconstructed.

Coupling the ask gate to an English UI string is deliberate: if the wording
changes, claude's recovery is lost — visibly and recoverably — whereas a mistimed
window destroys codex's every single time. Only the host can make this call,
because only the host sees what came back.

**Why press-wait-press.** Codex is the constraining case, because its `^C` is
consumed by the input line first. Measured against real sessions in a pty:

| State when interrupted | Gesture | Hint | At |
| --- | --- | --- | --- |
| idle after a pause | one `^C` | yes | 262 ms |
| idle after a pause | two `^C`, 150 ms apart | **no** | — |
| idle after a pause | `^C`, 800 ms, `^C` | yes | 855 ms |
| unsent text in the input | one `^C` | **no** | — |
| unsent text in the input | two `^C`, 150 ms apart | yes | 464 ms |
| unsent text in the input | `^C`, 800 ms, `^C` | yes | 1061 ms |
| freshly launched, no conversation | one `^C` | no — correctly, nothing to resume | — |

A blanket second press destroys the idle case, and an ask-gated one never fires
at all — `Press Ctrl-C again` was absent from every codex cell, so the phrase gate
can only ever serve claude. Press-wait-press is the only gesture covering both,
and the constants are sized against these numbers: the idle case yields at 262 ms
and so leaves the retry set before the ~600 ms fallback arrives. Confirmed end to
end in a real pane: fallback press at +625 ms, hint at +789 ms, applied on the
next activation.

Every live terminal PTY is interrupted, not just recognized agents. A foreground
gate would need the host to learn each pane's running command — it receives only
`alert:state` today — and it buys nothing here, because every one of these
processes is killed seconds later regardless. `^C` into a non-agent is inert (a
shell clears its line; an editor ignores it), and `detectResumeCommand` is the
real filter. Exited PTYs *are* excluded: one can neither take a `^C` nor yield a
hint, and including them would permanently defeat the "nothing left to wait for"
early exit.

Detection runs over the **live in-memory buffer**; the transcript is discarded
immediately after, so only the detected invocation is stored — never a writer,
never a log line.

**Only post-interrupt bytes count.** Each pane's received-count mark is taken
before the first `^C`, and detection reads only what arrived after it. This is a
correctness boundary, not an optimisation: a recovery command is executed on the
next restore, so the only bytes allowed to become executable state are the ones
produced *in response to Dormouse's own interrupt*. Scanning the whole buffer let
an old launch echo or a previous agent's hint win — observed as a codex pane
capturing a stale `claude --resume` id, and as an id welded to text from an
earlier screen region. It also fails in the safe direction: if the bounded buffer
evicted bytes meanwhile, slicing at the old mark can only discard fresh output,
never promote stale output as fresh. Widening this scan would quietly weaken the
provenance argument that lets recovery run without confirmation ("Consuming it").

Both real-world hint shapes matter, and both are covered:

```
Resume this session with:
claude --resume 4464d32c-a5c8-41a6-a320-a0fd07893096      ← own line

To continue this session, run codex resume 01a00dfd-...   ← prose, same line
```

**Environment hazard.** `CLAUDE_CODE_CHILD_SESSION` in a pane's environment disables
transcript saving in claude, which then prints no hint at all. Capture must treat a
missing hint as ordinary, and a Dormouse launched from inside a Claude Code session
will legitimately produce nothing.

### Consuming it

On the next cold activation, a pane carrying a recovery command **runs it
automatically** — no prompt, no button. The command is consumed destructively: the
host clears the field before handing state to the webview, so a resume is offered
once and a failed activation does not replay it.

Auto-run is safe to do without a confirmation:

- `claude --resume <id>` restores the conversation, lands at an idle prompt, and
  makes no request until the user types. It does not resume interrupted work.
- Provenance is tight, and structurally so: detection reads *only* the bytes a
  pane emitted after Dormouse interrupted it (see "Only post-interrupt bytes
  count" above), within one bounded wait — never a scan of arbitrary saved
  history, and never output that predates the teardown.
- A wrong id fails closed. Agent session files are per-user and per-project
  directory, so an id cannot be planted to be resumed into, and the id grammar
  keeps shell punctuation out of what is executed.

It also restores *more* context than the scrollback it replaces: the resumed agent
renders the real conversation, which a transcript replay only approximated.

The pane shows a passive one-line notice that its session was resumed — not a
dialog, with no retirement rules — so the discontinuity stays legible (the
interrupted turn did **not** continue) and a failed resume explains itself. The
command is typed only once the fresh shell reaches a prompt, because the platform
write bypasses xterm's keystroke fallback and spawn-then-type is exactly the window
shell startup swallows keystrokes in. Like any programmatic launch it seeds
`commandLine` + `commandStart` (`docs/specs/terminal-state.md`), so a restored
Workspace immediately counts its agents in `countRunningSessions` — and the
following quit-confirmation dialog counts sessions the user did not start by hand.

Known cost: every cold activation spawns every agent that was running, and cold
start is not free (claude ≈ 5 s, codex ≈ 25 s with MCP servers). It is proportional
to how many agents were actually running, and Reload Window is frequent. If it
becomes a complaint, the mitigation is a setting, not a prompt.

### VS Code teardown ordering

Capture runs **first**, and that is load-bearing rather than tidy: `[deactivate]
done` has never once been reached in a real shutdown, because VS Code kills the
extension host on a budget we do not control. The one step whose data cannot be
reconstructed afterwards therefore goes before the steps whose data can. The order
is:

1. start closing popped-out browser windows — kicked off here but joined at step 3,
   so it overlaps the poll instead of spending budget of its own. It shares no
   state with the interrupt and spends its time in external processes. Its failure
   is absorbed, never propagated: thrown out of the join it would skip the flush,
   the CWD refresh, and both kills, leaking the pty host;
2. `captureAgentRecoveryCommands` — one `^C` to every live PTY, then poll to a
   ~1.2 s ceiling, second-pressing only the panes that ask (above);
3. join the pop-out close;
4. flush structural state from the webview (no scrollback);
5. re-read CWD from the live PTYs and merge alert state;
6. `gracefulKillAll` then `killAll()`.

Each wait is bounded, and a timeout loses the recovery command rather than delaying
shutdown.

Step 2 writes its own record — `recovery.json` under `context.storageUri`, written
synchronously and replaced temp-then-rename — rather than `workspaceState` or the
session blob. Two reasons, both of the sort that only show up in a real shutdown.
`workspaceState.update()` hands its value to VS Code's storage service, which
batches the SQLite flush on its own schedule; by `deactivate()` that service is
already tearing down, so the write never lands however early it is issued
(measured: detection complete at +276 ms, record never written). And a later
`flushAllSessions` would overwrite the session blob with the webview's copy, which
knows nothing of what was just captured. The record is rewritten the moment each
command is found, so being killed mid-poll costs at most a late agent's command.

Recovery covers editor `WebviewPanel`s as well as the `WebviewView`, and it has to:
the capture interrupts every live PTY, so a panel's agent pays the same interrupted
turn whether or not it can recover. It needs no host-side per-panel store, because
the record is keyed by *surface id* rather than owned by a container — a panel gets
its pane ids from the `vscode.setState()` blob VS Code hands back at
`deserializeWebviewPanel`, and claims exactly those entries.

Step 2 also clears any previous record before its first early return. Consumption
only happens when a container actually resolves, so a session where the Dormouse
view is never opened would otherwise carry the record forward and auto-run a
week-old invocation on some much later restore.

Source of truth: `captureAgentRecoveryCommands` / `takeRecoveryCommands` in
`vscode-ext/src/session-state.ts`, `deactivate()` + `setupPanel` in
`vscode-ext/src/extension.ts`, `resolveWebviewView` in
`vscode-ext/src/webview-view-provider.ts`, `interrupt` in
`vscode-ext/src/pty-manager.ts`.

## Universal invariants

These rules bind every host that manages PTYs, and every adapter that sits in front
of one. Adapter-specific layering (deactivate ordering, save APIs, panel retention)
lives in the adapter spec, e.g. `docs/specs/vscode.md` and `docs/specs/standalone.md`
→ Quit flow.

- **Scrollback buffers survive PTY exit.** In the shared `pty-core.js`, only the hard `kill`/`killAll` (or host-process exit) clears a PTY's scrollback buffer; natural exit, signal-driven exit, and `gracefulKillAll` leave it readable via `getScrollback`. Recovery capture no longer depends on this (it runs *before* any kill — see "VS Code teardown ordering"), but a final flush that reads a pane whose shell has just exited still does.
- **A position in a pane's output is a received count, not a buffer length.** The host-side buffer is capped (1 MB) and evicts from the front, so `scrollbackChars` goes flat while output keeps flowing — on exactly the long-running agent pane recovery exists for. Anything marking a point in the stream, or watching a pane for growth, reads the monotonic `getScrollbackReceived` and slices with `getScrollbackSince`, which joins only the chunks spanning the mark and clamps to what the buffer still holds. Source of truth: `vscode-ext/src/pty-manager.ts`.
- **A spawn that fails still reports an exit.** `pty-core.spawn` answers a node-pty failure with `error` *and* `exit`. `error` is a host-side log line that reaches no webview, so without the exit a pane keeps any command seeded for it as permanently running — a phantom running header, a `countRunningSessions` that never returns to zero, and a quit confirmation on every attempt to close. Reachable whenever a persisted or selected shell binary is gone.
- **Whole-host acks are correlated by request id.** `interrupt` and `gracefulKillAll` both run on a teardown path with a timeout, so a timed-out call's ack still arrives afterwards. Matching on message type alone let that stale reply resolve the *next* call the instant it was issued. The pty-host echoes `requestId` on `interruptDone` / `gracefulKillDone` and the caller compares it.
- **An omitted interrupt target list is not an empty one.** `pty-core.interrupt(ids)` broadcasts to every live PTY only when `ids` is *omitted*; an empty array is a no-op. A caller that computes a set which happens to come out empty must get silence, not the blanket second press that destroys codex's hint.
- **Shell login args are shell-specific.** The shared `pty-core.js` launches POSIX shells with `-l` only for shells that accept it. `csh`/`tcsh` must be spawned without `-l` so users whose login shell is C-shell-derived can open a usable terminal in any adapter.
- **Replay drops terminal replies only.** While saved output is being replayed into xterm.js, terminal-generated OSC/CSI/DCS query and focus reports are dropped so they do not enter the resumed/restored shell's input buffer. The replay filter must preserve user keyboard escape sequences, including arrows, function keys, and bracketed paste. Source of truth: `lib/src/lib/terminal-report-filter.ts`.
- **Replaying a dead pane resets its modes; replaying a live one does not.** A dead Session's buffer can end mid-TUI with private modes still latched (mouse tracking, alt-screen, hidden cursor, application cursor keys) and nothing alive to unset them, so `REPLAY_MODE_RESET` is appended. A live resume must leave those modes to the process that still owns them (`docs/specs/terminal-escapes.md` → Replay-time mode-reset tail).
- **Untouched defaults conservatively.** New saved panes include `untouched`; a pane read without the field defaults to `untouched: false`, so it still requires kill confirmation.
- **PTY ownership.** Each message router tracks the PTY ids it owns. A PTY routed to one webview must not be stolen by another router; new routers attaching to a host must respect existing ownership.
- **Replay filtering does not re-fire alerts.** `pty:replay` re-injects buffered output into xterm.js but must not re-trigger `AlertManager`, quiesce-detector events, or protocol notifications.
