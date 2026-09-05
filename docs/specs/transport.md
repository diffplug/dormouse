# Transport and PTY Protocol Spec

> Adapter-agnostic protocol shared by every `PlatformAdapter`: PTY lifecycle, buffering, the webview ↔ platform message protocol, persisted-session types, and the invariants every adapter must honor. Host-specific layering lives in `docs/specs/vscode.md` and `docs/specs/standalone.md`; the phone's adapter in `docs/specs/pocket-app.md`. See `docs/specs/glossary.md` for the Process / Link state vocabulary, `docs/specs/alert.md` for `AlertManager` semantics, and `docs/specs/terminal-state.md` for the semantic events delivered over this transport.

## Adapter model

Each adapter wraps a PTY-spawning runtime and a transport channel between webview and host process. The webview is a thin view layer; PTYs and `AlertManager` live on the platform side. Source of truth: `PlatformAdapter` in `lib/src/lib/platform/types.ts`.

| Adapter | Host runtime | Transport |
|---|---|---|
| VS Code extension | extension host (Node.js) | `vscode.Webview.postMessage` ↔ `acquireVsCodeApi().postMessage` |
| Standalone (Tauri) | sidecar process | Tauri command/event bridge |
| Standalone browser-dev | sidecar + local dev HTTP bridge | fetch commands + Server-Sent Events |
| Pocket (`RemotePtyAdapter`) | the paired laptop's Host | remote protocol-v1 over the relay (`docs/specs/remote-api.md`) |
| Fake (tests, playground) | in-process | direct calls / event emitter |

**A host that cannot do something must say so by absence, never by the UI branching on host identity.** `RemotePtyAdapter` implements only the PTY core (list/data/write/resize/exit) and no-ops or omits the rest.

Three optional members are plain booleans, not methods:

| Member | Absent reads | Set by | Effect when set |
|---|---|---|---|
| `persistsSession?` | `true` | `TauriAdapter`, `BrowserSidecarAdapter` → `false` | `saveSession` skips the whole record build, not just the write ("The governing rule"; rationale) |
| `hostOwnsTheme?` | `false` | `VSCodeAdapter` → `true` | Settings hides its theme picker (`docs/specs/theme.md` → "Where the user picks a theme") |
| `hostOwnsShells?` | `false` | `VSCodeAdapter` → `true` | Settings hides its Shell row for the native QuickPick (`docs/specs/vscode.md` → "Shell selection") |

### Standalone browser-dev harness

`pnpm dev:standalone:ab` starts the standalone sidecar directly, a localhost-only HTTP bridge, and Vite with `VITE_DORMOUSE_BROWSER_DEV_HOST`, then opens the app URL in an `agent-browser` session. The browser build uses `BrowserSidecarAdapter` instead of `TauriAdapter` whenever that env var is present.

The bridge is a transport shim over the same sidecar protocol, not a second PTY implementation: fire-and-forget commands `POST /__dormouse_dev_host/send`, request/response commands `POST /__dormouse_dev_host/invoke`, host→webview events as SSE on `GET /__dormouse_dev_host/events`, and browser console output mirrored to `POST /__dormouse_dev_host/console` so one terminal shows sidecar, Vite, and in-browser logs together. The Burrow rides it too, on the message names below ("Message protocol"), so the harness runs a real Burrow against a per-run temp state directory (`docs/specs/standalone.md` → "Burrow service").

**The harness must keep logging the Burrow state directory in a form the pairing walkthrough parses**, which is how the walkthrough records that path before enrollment; pinned by `lib/src/lib/mirrored-constants.test.ts`.

**The bridge is authenticated, and loopback is not what makes it safe** — it dispatches `pty_spawn` with caller-supplied `shell`, `args`, `cwd` and `env`, so reaching it is arbitrary command execution as the developer (rationale). Four rules, enforced in `dev-host-guard.mjs` **before routing and before any body read**:

- **Every request carries `?t=<token>`**, a per-run 24-byte credential baked into the `VITE_DORMOUSE_BROWSER_DEV_HOST` URL and compared with `timingSafeEqual` over SHA-256 digests (rationale). It rides the query rather than an `Authorization` header because `EventSource` cannot set headers and `/events` is gated like the rest; `BrowserSidecarHost.url()` is the only place that attaches it. Not the `dor` control-API `controlToken` (rationale).
- **`Host` must be `127.0.0.1:<port>` or `localhost:<port>`**, against DNS rebinding (rationale).
- **Non-GET requests must be `application/json`**, which keeps the endpoints out of CORS-*simple* (rationale). Enforced in the gate rather than the body reader, so a route that never parses a body is covered too.
- **`access-control-allow-origin` names the Vite origin exactly, never `*`**, on every response including the SSE stream; both loopback spellings of that origin are accepted and echoed back (rationale).

**An unauthorized caller gets the same `404 not found` as an unknown path**, so the port does not identify itself. The harness prints the token and a ready-made `curl` on startup.

The harness **may omit** native-only desktop chrome (window controls, update checks) but **must preserve** every `PlatformAdapter` contract the app uses — PTY, control-request, clipboard, iframe-proxy, Burrow, agent-browser. It **must mirror** standalone's Session-persistence answer ("The governing rule"): the same `PERSIST_SESSION = false` gate as `TauriAdapter`, `persistsSession: false`, and any pre-gate `localStorage` blob deleted on `init()` (rationale). **Tauri APIs must not be required at static module-evaluation time** when `VITE_DORMOUSE_BROWSER_DEV_HOST` is set — a normal browser loads the page, not the Tauri WebView.

Source of truth: `standalone/scripts/dev-agent-browser.mjs`, `standalone/scripts/dev-host-guard.mjs`, `standalone/src/browser-sidecar-host.ts`, `standalone/src/browser-sidecar-adapter.ts`; `stepBurrow` in `scripts/pairing-walkthrough/steps.mjs`.

## PTY lifecycle

PTYs are managed by the platform host, not by the webview. The webview **resumes** over live PTYs (host-preserved) or **restores** from a Snapshot (cold start).

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

- **Hiding a webview does not kill its PTYs**, and becoming visible again resumes over the still-owned ones ("Reconnection protocol").
- **A naturally exited PTY may stay mounted as an exited pane**; frontend semantic state — CWD, title candidates, last command — is retained until the Session is disposed.
- **Explicitly killed PTYs are tombstoned** (`Process: Tombstoned`) so a late child-process `exit` cannot recreate their buffer and make them resumable: an explicit killed-id set in `pty-manager.ts`, and in `pty-core.js` a consequence of `bufferScrollback` never creating an entry `spawn` did not.
- **Each host instance gets its own pty-host child process** (e.g. one per VS Code window).

### PTY buffering

`pty-manager` keeps two buffers plus one counter per PTY. Both buffers are capped at 1M chars, trimming the oldest chunks at the cap.

- **replayChunks** — cleared on first consume; used for resume (webview hidden then shown).
- **scrollbackChunks** — never cleared short of `kill`/`killAll`; used for repeat resumes (a re-serving router's replay buffer is already spent) and for recovery capture at teardown. Host-side only — no adapter exposes it to the renderer.
- **receivedChars** — every char ever buffered, never decremented by a trim ("A position in a pane's output is a received count", below).

### Reconnection protocol

```
1. Webview becomes visible (or panel deserializes) and sends { type: 'dormouse:init' }.
2. Host answers { type: 'pty:list', ptys: [{ id, alive, exitCode, shell }] } for all owned PTYs,
   then per PTY { type: 'pty:replay', id, data } and { type: 'alert:state', id, … }.
3. Webview restores terminals from replay data, including each PTY's launch-shell path, which
   the rebuilt registry needs for Session-specific clipboard/drop escaping.
4. If the saved session covers those live PTYs, the frontend uses the saved Lath layout when its
   leaf set matches and reattaches saved minimized doors; minimized PTYs are registered but stay
   doors, not visible panes.
```

**Seeded titles reject the sentinels.** Saved pane and door titles come back through `setTerminalUserTitle()`, which rejects the reserved `<idle>` prefix (`docs/specs/terminal-state.md` → Supported OSC Inputs), and the seed callers in `terminal-lifecycle.ts` additionally skip `<unnamed>`, the default panel placeholder (rationale).

**Cold restore** (no live PTYs) falls back to saved session state: new PTYs in the saved CWDs under the currently selected Dormouse shell, plus the saved Lath layout. No transcript is replayed ("What is persisted"), and any pane carrying a recovery command auto-runs it. `reconnect.ts` waits 500 ms for the PTY list.

## Message protocol

Source of truth: the message schema in `vscode-ext/src/message-types.ts` (`WebviewMessage`, `ExtensionMessage`; other adapters import or mirror it), persisted-session types in `lib/src/lib/session-types.ts`, webview handlers in the adapter modules (`lib/src/lib/platform/vscode-adapter.ts`, `lib/src/lib/platform/fake-adapter.ts`), host handlers in the per-adapter message router. The schema is exhaustive there; below are only the contracts the types do not carry.

**Sender authenticity is the adapter's job, not the protocol's**, and **an adapter whose transport is reachable by page content must authenticate before it branches on `type`.** Tauri and browser-dev inherit it from a private IPC channel and a host-owned socket; VS Code shares its `window` inbox with framed surfaces and so requires a per-boot token on every host message (`docs/specs/vscode.md` → "Webview message authentication").

**`dormouse:runWorkbenchCommand` (webview → host) is allowlisted** against `lib/src/lib/vscode-keybindings.ts` before `vscode.commands.executeCommand`; generic command execution over the webview boundary is not allowed.

**Reaching the Burrow is one optional adapter member.** `burrow?: BurrowLink` is present exactly when a PTY-owning process sits behind the webview — standalone's sidecar, VS Code's extension host — and absent on the website. Its four calls are `command`, `respond`, `notify` (argless — the directory is the only thing a peer answers), and `on`. The webview half is `lib/src/host/remote/link-client.ts`, shared by all three adapters so no host settles a command differently: command correlation, a 15 s timeout, and the rule that **an ask is always answered even when nothing matches**. Both ends compile against `lib/src/host/remote/service-protocol.ts`. **Nothing crossing this seam carries authority** (`docs/specs/remote-security-model.md`).

Each host maps those calls onto its own transport:

| Host | command out | result / event in | ask in | answer / notify out |
| --- | --- | --- | --- | --- |
| VS Code | `burrow:command { payload }` | `burrow:result { payload }`, `burrow:event { payload }` (both broadcast to every webview in the window) | `peer:ask { requestId, op, params }` | `peer:answer { requestId, results }`, `peer:notify` |
| Standalone (Tauri + browser-dev harness) | `burrow_command(payload)` → sidecar stdin `burrow:command` | sidecar stdout `burrow:result` / `burrow:event` | sidecar stdout `burrow:ask { burrowRequestId, op, params }` | the same command channel, as `cmd: 'answer' \| 'notify'` |

Two rules the table encodes:

- **VS Code broadcasts results**, safe because a `burrowRequestId` carries a per-adapter random tag and is globally unique, so only the adapter that asked can settle one (rationale; `docs/specs/vscode.md` → "Peer surfaces across windows").
- **Standalone's correlation field is `burrowRequestId`, never `requestId`** — Rust swallows any sidecar line whose `data.requestId` matches a pending invoke (`docs/specs/standalone.md` → "Burrow service").

**Workspace union status adds no message** (`docs/specs/alert.md`): standalone computes it in-webview, VS Code from the module-level `AlertManager` filtered to each router's `ownedPtyIds` — so the host sees every PTY's alert state but no browser-surface TODO (that webview→host Surface-state message is staged, `docs/specs/vscode.md` `## Future`).

| Direction | Message | Contract |
| --- | --- | --- |
| Webview → host | `dormouse:openExternal` | Open a user-confirmed external URI from an OSC 8 hyperlink. **Hosts must revalidate**, rejecting malformed, control-character-bearing, or blocked pseudo-scheme targets (`javascript:`, `data:`, `blob:`, `about:` — `lib/src/lib/external-links.ts`). |
| Webview → host | `pty:getOpenPorts` | TCP listening ports of a PTY's shell **and all of its descendant subprocesses**, resolved from the root pid, answered with `pty:openPorts`. `getOpenPortsForPid()` in `standalone/sidecar/pty-core.js` (VS Code loads it through the `lib/pty-core.cjs` shim). |
| Host → webview | `pty:openPorts` | `ports: OpenPort[]` (`{ protocol, family, address, port, pid, processName }`), de-duplicated by `(family, address, port)`, sorted by port then address. Empty when the PTY is gone or enumeration fails. |
| Host → webview | `pty:data` | PTY output after state-driving supported OSCs are parsed/stripped; `OSC 8` and ImageAddon's inline-image `OSC 1337` forms are preserved for xterm.js, routed only to the owning router. **Carries an optional `textData`** (string-control payloads removed, for the prompt heuristic), **omitted when it would equal `data`**. |
| Host → webview | `terminal:semanticEvents` | Normalized CWD / prompt-command / title events the owner's parser derived, in stream order. |
| Host → webview | `terminal:protocolEvents` | Standalone only: notification and progress events for the webview's `AlertManager`. VS Code holds its own in the extension host, so it needs no message. |
| Webview → host | `dormouse:themeColors` (VS Code) / `pty_theme_colors` (standalone) | Resolved foreground / background / cursor, so the owner's parser can answer OSC 10/11/12. |
| Host → webview | `pty:replay` | Buffered raw output since spawn; the webview runs a one-shot parser over it, the only re-parse there is. |
| Host → webview | `dormouse:newTerminal` | May carry `shell`, `args`, display `name`, `replaceUntouched`, `announce`. The webview replaces the selected untouched terminal in place only when `replaceUntouched` is true, otherwise spawns a new pane. |

**Two app-global stores relay on one pattern**: WATCHING rules (`alert:initializeWatchedCommands`, `alert:setCommandWatched` → host; `alert:watchedCommands` → webview) and alarm settings (`alert:initializeSettings`, `alert:updateSettings` → host; `alert:settings` → webview; `docs/specs/alert.md` → Alarm settings). An `initialize*` offers the renderer's persisted copy as a startup seed, and **a multi-webview host accepts only the first seed of its lifetime**. A mutation replaces the host's copy — `setCommandWatched` adds or removes one bare command key without touching unrelated rules, `updateSettings` sends the whole blob, renderer-only fields included, so every webview agrees. Either way the host broadcasts a canonical snapshot, and **every renderer replaces and persists its local mirror from it**.

**The host must revalidate renderer-supplied settings, never trust them** — they become host timers. `AlertSettingsHost` runs every inbound blob through `normalizeAlertSettings`, which drops unknown keys, defaults missing ones, and clamps each delay into range. Both directions share one adapter method, `alertPublishSettings(settings, { seed })`: seed vs replace picks a message type, not a payload.

**Never add a third app-global store on this pattern** — a third collapses them into one keyed channel with a host-side key→normalizer registry (rationale).

OSC parsing/stripping rules for those rows, and the rule that **only the process owning a PTY parses it**: `docs/specs/terminal-escapes.md` → "Parsing location".

## Persisted session types

**The layout field.** A `PersistedSession` records the layout as `lathLayout` — the native Lath tree (`docs/specs/tiling-engine.md` → "Persistence"). Each `PersistedDoor` carries a Lath restore `token` as its sole restore payload.

**Workspace-scoped dor refs.** A `PersistedSession` may record `surfaceRefs` — stable Surface id → Workspace-local `dor` short ref (`surface:N`) — plus `surfaceRefsNext`, the next number to hand out. The map belongs to the Workspace session, not the layout: every layout move and every browser render swap preserves the ref. **A retired `surface:N` is never reused for a different Surface** — a killed Surface's entry is dropped, `surfaceRefsNext` is persisted independently rather than derived from the map, and on load the counter is clamped above the map's highest ref, so a target naming a retired ref fails instead of resolving to the wrong pane (`docs/specs/dor-cli.md` → Handle Model). Old snapshots without the fields allocate refs from the restored Surfaces on first mount.

**Surface kinds in the snapshot.** Each `PersistedPane` records a `surfaceType` (`docs/specs/glossary.md`): `'terminal'` — the default, **omitted from the row** so terminal snapshots stay byte-identical — or `'browser'`. It routes restore/resume, and **a pane lacking it reads as `'terminal'`**. `restoreSession` skips terminal restoration for a browser pane rather than minting a stray PTY + xterm per browser pane id, and the resume plan keeps browser panes and minimized browser doors despite their having no live PTY, so the saved layout's leaf set still matches and is not discarded. A browser pane rebuilds from the persisted layout (visible) or `PersistedDoor.params` (minimized) — its render params (`renderMode`, `url`, agent-browser `session`) live there, not in `PersistedPane`.

**Workspace/Window containers (implemented, dormant behind the `dormouse.flags.workspaces` flag; rollout ledger in `docs/specs/layout.md` `## Future`).** A `PersistedWorkspace` is a `WorkspaceId`, a user-facing `name`, and that Workspace's `PersistedSession`. The standalone Window's top-level snapshot is a `PersistedWindow` (its own `version: 1`) wrapping v3 sessions: the ordered `PersistedWorkspace` list plus the active `WorkspaceId`. **VS Code does not use it** — each webview persists one bare `PersistedSession`, its single Workspace, through its own per-surface state API (`docs/specs/vscode.md`).

**The wrapping lives at the standalone adapter boundary, never in the shared save/restore code.** `window-persistence.ts` translates between the host's stored top-level blob and the bare `PersistedSession` that `reconnect.ts` / `session-save.ts` operate on; `tauri-adapter.ts` / `browser-sidecar-adapter.ts` route `getState` / `saveState` through its `loadSessionState` / `saveSessionState`. The blob round-trips through a `SessionKeyValueStore` — one synchronous slot the host persists natively (`localStorage` in the browser-dev harness, a Rust-backed per-window file store in the real adapter; `docs/specs/standalone.md` → Persistence), **never WebKit `localStorage`**. Flag **off** (the default): identity passthroughs. Flag **on**: load returns the active Workspace's session, save merges it back and preserves the others.

**A corrupt save must never block startup.** Every read goes through `readPersistedSession()` / `readPersistedWindow()`, which accept the canonical parsed object *or* a JSON-stringified blob (host state APIs may hand back the inner serialized string) and log-and-discard anything present but unreadable. `readPersistedWindow` additionally drops Workspaces whose inner session is unreadable and repairs a dangling `activeWorkspaceId` to the first Workspace.

**The recovery command.** One agent resume invocation per surface (`claude --resume <id>`, `claude --continue`, `codex resume <id>`) — the only thing that survives a teardown.

*It is not part of the persisted session.* `PersistedPane` carries no `resumeCommand`, and `normalizeSessionV3` strips one out of a pre-upgrade blob as it strips a transcript. **Host-owned and single-use, it travels out of band**: the host puts `surfaceId -> invocation` on the webview's boot payload, the renderer reads it through `PlatformAdapter.getRecoveryCommands()`, and an adapter whose host captures nothing omits the method. Keeping it off the session shape is what makes the one-shot guarantee structural (rationale).

*Exactly one writer, exactly one read.* The writer is the VS Code host's teardown (`docs/specs/vscode.md` → "Capturing agent recovery"); the renderer save path never derives it and standalone writes it never. **Cold restore is the one reader — resume never reads it**, the agent there still being Live. `takeRecoveryCommands` reads and unlinks on the first call of an activation, **destructively even on a parse failure**, so the durable copy is gone before any webview is served; within that activation **each webview claims only the entries matching its own saved pane ids** (rationale). **A record older than 7 days is discarded unread.**

*Detection.* Because this string is executed, four rules are load-bearing:

- **Only a known invocation plus an opaque id.** The command is *rebuilt* as label + captured id, never sliced from the buffer; the id grammar is alphanumeric/hyphen/underscore only, so shell punctuation cannot enter executable state. Anything trailing the id is dropped. The invocation must be followed by a word break (`claude --continuex` is not an offer to continue) but nothing stronger (rationale).
- **The scan window is stripped as a whole, in one pass, and an unterminated control swallows the rest of it** — the string controls (OSC, DCS, SOS, PM, APC) **in either introducer form, `ESC` or bare C1**, and equally a CSI the window was cut off *inside* (rationale). "Terminated" tracks what the renderer honours rather than ECMA-48 alone: ST in both forms (`\x1b\\`, `\x9c`), BEL for OSC, plus CAN/SUB and a bare ESC. **Match every escape by its full ECMA-48 shape** — ESC, intermediates, one final byte — never by the Fe range (rationale). **One implementation**: `stripTerminalControls` removes string controls by running `TerminalControlStreamFilter`, so the batch and streaming readers cannot disagree.
- **Stripping runs in boundary mode, whose rule is inverted**: *every* control becomes a newline rather than vanishing, except SGR and charset designators, the two classes that neither move the cursor nor erase. Cursor moves outside CSI count — `ESC M`, `ESC 7`/`ESC 8`, `ESC c`, VT/FF/backspace (rationale).
- **Rightmost match in the last 50 lines wins.** No pattern spans the newline a boundary leaves, so the stripped window is scanned whole; rightmost is newest *by position*, never by pattern order (rationale). **Restore revalidates through `normalizeResumeCommand` before typing**, against a snapshot written by an older detector.

Source of truth: `PersistedSession` in `lib/src/lib/session-types.ts`; `surfaceRefs` in `lib/src/components/Wall.tsx`; `saveSession` in `lib/src/lib/session-save.ts`; `restoreSession` in `lib/src/lib/session-restore.ts`; the resume plan in `lib/src/lib/reconnect.ts`; `loadSessionState` / `saveSessionState` in `lib/src/lib/window-persistence.ts`; `takeRecoveryCommands` in `vscode-ext/src/session-state.ts`; `getRecoveryCommands` in `lib/src/lib/platform/vscode-adapter.ts`; `detectResumeCommand` / `normalizeResumeCommand` in `lib/src/lib/resume-patterns.ts`; `stripTerminalControls` in `lib/src/lib/terminal-controls.ts`.

## Persistence policy

### What is persisted

Structure only: panes (id, cwd, title, `untouched`, `surfaceType`, TODO/alert blob), doors and their Lath restore tokens, the Lath layout, and the Workspace's `dor` surface refs. **Scrollback is never persisted by any writer**, and neither is the recovery command (above).

### Retiring the transcripts already on disk

Ignoring the field is not enough — the bytes have to go (rationale). Three rules:

- **`readPersistedSession` drops `scrollback` when present**, along with any `resumeCommand`, and does not *require* it, so a snapshot written without it stays readable. A transcript can be read out of a legacy blob but never survives into a parsed Session, so nothing downstream can persist it forward.
- **The first save after upgrade rewrites each store without transcripts.** Standalone, which stops reading its store entirely, **clears the slot outright at boot** rather than waiting for a save that may never come — including an orphaned sibling temp file from a crash before atomic rename, invisible to `load_session` but still holding the bytes.
- **No writer accepts a transcript-bearing Session shape.**

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

**Standalone therefore persists no Session state at all**, and the write path itself
is removed rather than written-then-ignored (rationale). Sessions still survive a
reload — resume reads the sidecar's live PTY list, not disk — but the layout does
not: `reconnect.ts` reads `getState()` for the saved resume plan, so every live PTY
lands in one tab group, doors and saved titles dropped. **A legacy blob found at boot
is deleted, not read.**

> Reserved: the workspaces-rollout scope (`docs/specs/layout.md` → `## Future`)
> assumes a persisted `PersistedWindow` in standalone. Reconciling multi-Workspace
> persistence with this rule is part of that scope, not this one.

### Consuming it

**A pane carrying a recovery command runs it automatically on the next cold
activation** — no prompt, no button. **Auto-run holds only while both guarantees
above do**: a rebuilt label plus a fail-closed id (*Detection*), and provenance that
is structural — only the bytes a pane emitted after Dormouse's own interrupt, never a
scan of arbitrary saved history (`docs/specs/vscode.md` → "Capturing agent
recovery"). Weaken either and the confirmation gate has to come back (rationale).

Two consumption rules, shared with `dor split` launches. **Type the command only
once the fresh shell reaches a prompt** — the platform write bypasses xterm's
keystroke fallback, and shell startup swallows keystrokes. **Seed `commandLine` +
`commandStart(user_input)` synchronously first** (`docs/specs/terminal-state.md`), so
a restored Workspace immediately counts its agents in `countRunningSessions` — and
the quit-confirmation dialog counts sessions the user did not start by hand. The pane
shows a passive resumed-session notice (`docs/specs/layout.md` → "Agent resume on
cold restore").

Known cost: every cold activation spawns every agent that was running, and Reload
Window is frequent. **If it becomes a complaint, the mitigation is a setting, not a
prompt** (rationale).

## Universal invariants

- **Scrollback buffers survive PTY exit.** In the shared `pty-core.js` only a hard `kill`/`killAll` (or host-process exit) clears one; natural exit, signal-driven exit, and `gracefulKillAll` leave it readable via `getScrollback` (rationale).
- **A position in a pane's output is a received count, not a buffer length.** The capped host-side buffer evicts from the front, so `scrollbackChars` goes flat while output keeps flowing (rationale). Anything marking a point in the stream, or watching a pane for growth, reads the monotonic `getScrollbackReceived` and slices with `getScrollbackSince`, which joins only the chunks spanning the mark and clamps to what the buffer still holds.
- **A spawn that fails still reports an exit.** `pty-core.spawn` answers a node-pty failure with `error` *and* `exit`; `error` reaches no webview (rationale).
- **Whole-host acks are correlated by request id, never by message type alone.** For `interrupt` and `gracefulKillAll` the pty-host echoes `requestId` on `interruptDone` / `gracefulKillDone` and the caller compares it — a timed-out teardown call's ack still arrives afterwards (rationale).
- **An omitted interrupt target list is not an empty one.** `pty-core.interrupt(ids)` broadcasts to every live PTY only when `ids` is *omitted*; an empty array is a no-op. A caller whose computed set comes out empty must get silence, not the blanket second press that destroys codex's hint.
- **Shell login args are shell-specific.** `pty-core.js` launches POSIX shells with `-l` only where the shell accepts it; `csh`/`tcsh` must be spawned without it, so a C-shell-derived login shell still opens a usable terminal in any adapter.
- **Replay drops terminal replies only** — never a user keyboard escape sequence (`docs/specs/terminal-escapes.md` → "Report filtering on the input side").
- **Replaying a dead pane resets its modes; replaying a live one does not** — the `REPLAY_MODE_RESET` tail (`docs/specs/terminal-escapes.md` → Replay-time mode-reset tail).
- **Untouched defaults conservatively.** New saved panes include `untouched`; a pane read without the field defaults to `untouched: false`, so it still requires kill confirmation.
- **PTY ownership.** Each message router tracks the PTY ids it owns. A PTY routed to one webview must not be stolen by another router; new routers attaching to a host must respect existing ownership.
- **Replay filtering does not re-fire alerts**, quiesce-detector events, or protocol notifications (`docs/specs/terminal-escapes.md` → "`pty:data` strip semantics").

Source of truth: `getScrollbackReceived` / `getScrollbackSince` in `vscode-ext/src/pty-manager.ts`; the replay filter in `lib/src/lib/terminal-report-filter.ts`.
