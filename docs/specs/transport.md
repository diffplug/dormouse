# Transport and PTY Protocol Spec

> - See `docs/specs/glossary.md` for Session / Pane / Door and Process / Link vocabulary.
> - Adapter-agnostic protocol shared by every `PlatformAdapter`: PTY lifecycle, buffering, the webview ↔ platform message protocol, persisted-session types, and the invariants every adapter must honor. A rule both hosts implement identically lives here; host-specific layering lives in `docs/specs/vscode.md` and `docs/specs/standalone.md`, the phone's adapter in `docs/specs/pocket-app.md`.
> - Defers `AlertManager` semantics to `docs/specs/alert.md` and semantic events to `docs/specs/terminal-state.md`.

## Adapter model

**Must expose platform capabilities through `PlatformAdapter`; a host that cannot do something omits the capability, and the UI never branches on host identity.**

| Adapter | Host runtime | Transport |
|---|---|---|
| VS Code extension | extension host (Node.js) | `vscode.Webview.postMessage` ↔ `acquireVsCodeApi().postMessage` |
| Standalone (Tauri) | sidecar process | Tauri command/event bridge |
| Standalone browser-dev | sidecar + local dev HTTP bridge | fetch commands + Server-Sent Events |
| Pocket (`RemotePtyAdapter`) | paired laptop’s Burrow | encrypted protocol-v1 over the selected Relay/direct session (`docs/specs/remote-api.md`); one-time is direct-only (`docs/specs/one-time.md`) |
| Fake (tests, playground) | in-process | direct calls / event emitter |

`RemotePtyAdapter` implements only the PTY core (list/data/write/resize/exit) and no-ops or omits the rest.

**Must treat absent host-ownership capabilities as false.** Their members, defaults, and consumers are canonical comments on `PlatformAdapter`; behavior belongs to `docs/specs/theme.md` → Where the user picks a theme, `docs/specs/vscode.md` → Shell selection, and `docs/specs/remote-network.md` → Settings → Network.

Source of truth: `PlatformAdapter` in `lib/src/lib/platform/types.ts`.

## PTY lifecycle

**Must keep PTYs in their platform runtime across webview hide/recreate and isolate each webview’s ownership.** Local host mechanisms belong to `docs/specs/vscode.md` → Webview hosting and `docs/specs/standalone.md` → Routing. The webview resumes over preserved PTYs or restores from a Snapshot.

- **Hiding a webview does not kill its PTYs**, and becoming visible again resumes over the still-owned ones ("Reconnection protocol").
- **A naturally exited PTY may stay mounted as an exited pane**; frontend semantic state — CWD, title candidates, last command — is retained until the Session is disposed.
- **Must keep explicitly killed PTYs non-resumable**: late output never recreates a killed id's buffer.

### PTY buffering

**Both Node-resident hosts (VS Code's extension host, standalone's sidecar) keep a bounded, in-memory-only scrollback per PTY that survives natural, signal-driven, and graceful exit; only an explicit kill (`kill` / `killAll`), a spawn reusing the id, or host-process exit releases it** (rationale). Each host's bound: `docs/specs/vscode.md` → Webview hosting, `docs/specs/standalone.md` → "Rust ↔ sidecar bridge". Stream positions follow Universal invariants.

### Paced input

`writePty(id, data, { paced: true })` delivers input the way a person types it; every host carries the flag to `pty-core.write`. `surface.send` (`dor send`) is the only paced writer — every other write is one burst.

- **Must write paced text in runs of at most 256 UTF-8 bytes, 10 ms apart** (rationale).
- **Must hold a key until 100 ms after the paced text before it**, even when a later request sends the key (rationale). A key is one escape sequence, DEL, or a C0 control other than tab and line feed; tab and line feed are text.
- **Never split a code point or an escape sequence across writes.**
- **Must queue any write that arrives while paced input is pending**, so input keeps its order.
- **Must discard pending paced input when its PTY exits, is killed, or is respawned, and on any lone `^C`** — typed, `interrupt`, or the `dor send --key ctrl-c` that `dor/skill.md` teaches — which is then written at once.
- **Never pace in the webview**; the PTY owner paces (rationale).

Source of truth: `pacedInputSegments` and `write` in `standalone/sidecar/pty-core.js`, pinned by `standalone/sidecar/pty-core.test.js`.

### iTerm2 identity

**Every spawned PTY gets an iTerm2-compatible identity** (rationale), **one compatibility version spanning the environment and the `CSI > q` answer** (`docs/specs/terminal-escapes.md` -> "Supported CSI"):

| Variable | Value |
|---|---|
| `TERM_PROGRAM` | `iTerm.app` |
| `TERM_PROGRAM_VERSION` | the compatibility version, not Dormouse's package version |
| `LC_TERMINAL` | `iTerm2`, unconditionally (rationale) |
| `LC_TERMINAL_VERSION` | the same compatibility version |
| `COLORTERM` | `truecolor` (rationale) |

**Must advertise the lowest iTerm2 version that unlocks every version-gated behavior Dormouse supports, and never a version adding sequences that programs would then send and Dormouse mishandles** (rationale). **Never advertise** feature-specific support before the behavior exists.

**Must strip another terminal's identity from the inherited environment before setting Dormouse's** — its session, version, and multiplexer variables (rationale).

Source of truth: `ITERM2_COMPAT_VERSION` in `standalone/sidecar/pty-core.js` and `lib/src/lib/terminal-protocol.ts`, pinned together by `lib/src/lib/mirrored-constants.test.ts`; `FOREIGN_TERMINAL_ENV` in `standalone/sidecar/pty-core.js`.

### Reconnection protocol

1. The visible or deserialized webview calls `requestInit` (VS Code: `{ type: 'dormouse:init' }`) under a fresh token.
2. The host answers `pty:list` (one `PtyInfo` per owned PTY), then one `pty:replay` for each, empty or not, then `alert:state` for each.
3. Listed PTYs resume with their launch shells (consumer: `docs/specs/mouse-and-clipboard.md` -> "8.6 Paste Content"), saved minimized ones as Doors; an empty list cold-restores.
4. With no answer in time, a collector given `retryTimeoutMs` asks once more (rationale), then reports `timedOut`: an arrival refuses (`docs/specs/standalone.md` → "Arrival queue"), a boot cold-restores.

**A collection finishes only on its own answer**: a host serving several windows echoes the `requestInit` token on the `pty:list` and every `pty:replay` behind it, and the collector ignores a different one (rationale). **An answer carrying no token is taken** — the hosts that echo none (VS Code, Pocket, the website) run one collector per JS realm. **A collection that timed out is not one that found no PTYs** (`LivePtys`): restoring over it starts a second set of shells. **`resumeOrRestore` and `restoreWindow` give `retryTimeoutMs` only when the saved session names a terminal pane.** Source of truth: `collectLivePtys` in `lib/src/lib/reconnect.ts`.

**Seeded titles reject the sentinels.** Saved pane and door titles come back through `setTerminalUserTitle()`, which rejects the reserved `<idle>` prefix (`docs/specs/terminal-state.md` → Supported OSC Inputs); the seed also skips `<unnamed>`, the default panel placeholder (rationale).

#### Report filtering on the input side

xterm.js `onData` includes its *replies* to queries. **A chunk is classified as a report only when every token in it is one**, so a report glued onto real keystrokes is never mistaken for one.

- **Must drop complete terminal replies during replay**, before they reach the PTY, input recording, acknowledgement, or untouched state (rationale).
- **Must suppress only input recording for synthetic control-only reports**, whose broader grammar can include real keys; never drop those chunks.
- **Must strip mouse reports only during mouse-mode override** (`docs/specs/mouse-and-clipboard.md` -> "2. Override State"). Pointer acknowledgement follows `docs/specs/alert.md` → Engagement.

**Never swallow user keyboard escape sequences**: arrows, function keys, bracketed paste, kitty modified-key reports, and win32-input-mode key records.

Source of truth: `lib/src/lib/terminal-report-filter.ts`, pinned by `lib/src/lib/terminal-report-filter.test.ts`.

#### Replay-time mode-reset tail (Dormouse-emitted)

**After a *dead* Session's scrollback replays, Dormouse writes the fixed `REPLAY_MODE_RESET` tail**, returning every mode a dead program could leave latched to its default (rationale). **Never on a live resume**, where the running process owns its modes; a cold `restoreTerminal` replays nothing to reset.

Source of truth: `REPLAY_MODE_RESET` in `lib/src/lib/terminal-report-filter.ts`, written only by `resumeTerminal` in `lib/src/lib/terminal-lifecycle.ts`.

#### Transferring a Workspace

A Workspace can move from one webview to another with its Sessions still running (`docs/specs/standalone.md` → Transfer). It is a resume, not a restore:

- **Release, never dispose, and only once the target has adopted the Workspace.** The source detaches its half of each Session and **never kills the PTY**. **Never reachable from a webview unmount** — a reload or a StrictMode double-mount would strand every PTY the window still owns (rationale). A move the target never took leaves the Workspace exactly as it was.
- **Split at a mark stamped in the stream, then suppress until the replay.** The host routes an id's output to the source until its `pty:marked` line — behind every `pty:data` already sent, ahead of every later one — and drops it from there until the target's replay reaches it. The source serializes its buffer at the mark as the arrival's content; the target writes it, then the since-mark replay: no duplicate or lost bytes at the seam, and the source xterm's retained screen and scrollback survive beyond the host's bounded tail (output already trimmed from xterm is not recovered). **An id the host never marked is serialized anyway and replayed whole.** Suppression fails open after a bound (rationale); the message sequence and hand-back are `docs/specs/standalone.md` → "Arrival queue".
- **Must include retained, naturally exited buffers in explicit marked requests**, with `alive: false` and their exit code, replaying their since-mark tail; ordinary discovery stays live-only.
- **Ask for exactly the moving ids, at their marks.** `pty:requestInit` names them, and a marked id replays only its output since the mark. **Omitted ids are not empty ids**: a computed set that came out empty is a no-op, never every PTY in the process.
- **Must replay a transfer at its source grid and drain parsing before mounting the target Wall**, then fit the target pane. **Must preserve mouse encoding as well as tracking**, including the SGR and SGR-pixel encodings xterm's serializer omits.
- What else travels: Tools `docs/specs/dor-tool.md` → Persistence and hosts, alerts `docs/specs/alert.md` → Live Workspace transfer, semantic state `docs/specs/terminal-state.md` → Core Model.

Source of truth: `captureTransferContent` in `lib/src/components/wall/workspace-transfer.ts`; `releaseSession` in `lib/src/lib/terminal-lifecycle.ts`; `mark` / `list` in `standalone/sidecar/pty-core.js`.

**Cold restore** (neither live PTYs nor a browser-only resume) falls back to saved session state: new PTYs in the saved CWDs under the currently selected Dormouse shell, plus the saved Lath layout. No transcript is replayed ("What is persisted"), and any pane carrying a recovery command auto-runs it.

## Message protocol

Source of truth: the message schema in `vscode-ext/src/message-types.ts` (`WebviewMessage`, `ExtensionMessage`; other adapters import or mirror it), persisted-session types in `lib/src/lib/session-types.ts`, webview handlers in the adapter modules (`lib/src/lib/platform/vscode-adapter.ts`, `lib/src/lib/platform/fake-adapter.ts`), host handlers in the per-adapter message router. The schema is exhaustive there; below are only the contracts the types do not carry.

**Sender authenticity is the adapter's job, not the protocol's**, and **an adapter whose transport is reachable by page content must authenticate before it branches on `type`.** Tauri uses private IPC; browser-dev: `docs/specs/standalone.md` → "Standalone browser-dev harness"; VS Code: `docs/specs/vscode.md` → "Webview message authentication".

**Reaching the Burrow is one optional adapter member.** `burrow?: BurrowLink` is present exactly when a PTY-owning process sits behind the webview — standalone's sidecar, VS Code's extension host — and absent on the website. Every adapter uses the shared webview half, `lib/src/host/remote/link-client.ts`, so no host settles a command differently, and **an ask is always answered even when nothing matches**. Both ends compile against `lib/src/host/remote/service-protocol.ts`; `BurrowLink` in `lib/src/lib/platform/types.ts` owns the call shapes. **Nothing crossing this seam carries authority** (`docs/specs/remote-security-model.md`). Each host's carrier: `docs/specs/vscode.md` → "Burrow: a service in the extension host", `docs/specs/standalone.md` → "Burrow service".

**Every webview installs the peer-surface responder, idempotently per link** (rationale), and the Burrow asks it what only a webview knows — a pane's name, its focus, its xterm size. **An ask collects at most one answer per webview, keyed by which webview answered, never by how many have**; `ASK_BUDGET_MS` bounds the fan-out, and whatever answered is the best available snapshot. Directory merging, attach selection, release, and late answers: `docs/specs/remote-api.md` → "Directory" and "Attachment invariants". Source of truth: `installPeerSurfaceResponder` in `lib/src/remote/burrow/peer-surfaces.ts`; `createAskSurfaceProvider` in `lib/src/host/remote/ask-surface-provider.ts`.

**Workspace union status adds no message** (`docs/specs/alert.md` → Workspace union).

**The PTY owner has no DOM, so the webview pushes its resolved terminal colours and the owner's parser answers `OSC 10/11/12 ; ?` from the latest push; until the first push the query falls through to xterm.js.** The query rules: `docs/specs/theme.md` → "Terminal color contract".

| Direction | Message | Contract |
| --- | --- | --- |
| Webview → host | `dormouse:openExternal` | Open a user-confirmed external URI from an OSC 8 hyperlink; revalidation: `docs/specs/mouse-and-clipboard.md` -> "OSC 8 hyperlinks". |
| Webview → host | `pty:getOpenPorts` | TCP listening ports of a PTY's shell **and all of its descendant subprocesses**, answered with `pty:openPorts`. |
| Host → webview | `pty:openPorts` | De-duplicated by `(family, address, port)`, sorted by port then address; empty when the PTY is gone or enumeration fails. |
| Webview → host | `pty:getOpenPortsMany` | `ids`, answered by `pty:openPortsMany` from one scan. |
| Host → webview | `pty:openPortsMany` | `[]` for an id with no live PTY. |
| Host → webview | `pty:data` | PTY output after state-driving supported OSCs are parsed/stripped; `OSC 8` and ImageAddon's inline-image `OSC 1337` forms are preserved for xterm.js, routed only to the owning router. |
| Host → webview | `terminal:semanticEvents` | Normalized CWD / prompt-command / title events the owner's parser derived, in stream order. |
| Host → webview | `terminal:toolEvents` | Ordered Tool announcements, state, and command-start resets (`docs/specs/dor-tool.md` → OSC 367). |
| Host → webview | `terminal:clipboardOffer` | One decoded `OSC 52` write, offered to the copy editor (`docs/specs/mouse-and-clipboard.md` §4.6). |
| Host → webview | `terminal:clientInput` | A remote Client wrote to this Session, which is no longer untouched (`docs/specs/layout.md` → "Kill confirmation"). |
| Webview → host | `pty:spawn` | `options.alert`: a cold-restored pane's persisted alert state (`docs/specs/alert.md` → Public State). |
| Webview → host | `dormouse:themeColors` (VS Code) / `pty_theme_colors` (standalone) | Resolved foreground / background / cursor, at `requestInit` and on every terminal-theme change. |
| Host → webview | `pty:replay` | Buffered raw output; the webview's one-shot parse of it is the only re-parse there is. |

**Each PTY owner runs one alert host** (`createAlertHost`) beside its parse, fed regardless of webview visibility and outliving every webview (rationale). **Each webview is a realm of it, ended when the webview re-initializes or goes away**; what an ended realm settles: `docs/specs/alert.md` → Await.

**Every `alert*` verb is one `alert:command { command }` to the host** — in standalone the `alert_command` invoke, stamped with its window (`docs/specs/standalone.md` → "Alerts") — and **every answer one of the `alert:*` events, named and shaped alike in both hosts** (`AlertCommand` / `AlertEvents` in `lib/src/host/alert-protocol.ts`). **The host revalidates every command**, the settings blob that becomes its timers included (`normalizeAlertSettings`). An await's messages are `docs/specs/alert.md` → Await. **`sync` re-sends only the realm its named Sessions' `alert:state` and both stores' snapshots, ending nothing.**

**Two app-global stores relay on one pattern**: WATCHING rules (`initializeWatchedCommands`, `setCommandWatched` → host; `alert:watchedCommands` → webview) and alarm settings (`initializeSettings`, `updateSettings` → host; `alert:settings` → webview; `docs/specs/alert.md` → Alarm settings).

- **A host accepts only the first `initialize*` seed of its lifetime**, the renderer's persisted copy.
- A mutation replaces the host's copy: `setCommandWatched` adds or removes one bare command key without touching unrelated rules; `updateSettings` sends the whole blob, renderer-only fields included.
- **The host broadcasts a canonical snapshot, and every renderer replaces and persists its local mirror from it.** **A host sends no snapshot before the first seed**, so a `sync` never pushes defaults over a renderer's persisted copy.
- **Never add a third app-global store on this pattern** — a third collapses them into one keyed channel with a host-side key→normalizer registry (rationale).

OSC parsing and stripping for those rows: `docs/specs/terminal-escapes.md` → "Parsing location".

### Managed voice

**Managed voice is one optional adapter member**, `managedVoice?: ManagedVoicePort`, present only in a Hosted standalone build (Tauri and the browser-dev harness); VS Code, Pocket, the website, and a self-host build omit it. Behavior: `docs/specs/alert.md` → "Managed voice".

| Direction | Standalone carrier | Payload |
| --- | --- | --- |
| Webview → host | `managed_voice { payload }` → sidecar `voice:command` | op `status`, `configure`, or `speak` |
| Host → webview | sidecar `voice:result` → invoke result | that op's answer |
| Host → every webview | sidecar `voice:status` | the status after each saved `configure` |

**Every window caches the status**: it asks `status` once its `voice:status` listener is live, and again when the harness's event stream reconnects, then takes each broadcast; **an answer never overrides a broadcast that arrived after its request**.

Source of truth: `ManagedVoicePort` in `lib/src/lib/platform/managed-voice-types.ts`; `createManagedVoicePort` in `standalone/src/managed-voice-port.ts`; `createManagedVoiceHost` in `lib/src/host/managed-voice-host.ts`.

## Persisted session types

**The layout field.** A `PersistedSession` records the layout as `lathLayout` — the native Lath tree (`docs/specs/tiling-engine.md` → "Persistence"). Each `PersistedDoor` carries a Lath restore `token` as its sole restore payload.

**Must carry Workspace delivery overrides in `PersistedSession.alertDelivery`**, across hosts; inheritance and validation follow `docs/specs/alert.md` → Alarm settings.

**Workspace-scoped dor refs.** A `PersistedSession` may record `surfaceRefs` — stable Surface id → Workspace-local `dor` short ref (`surface:N`) — plus `surfaceRefsNext`, the next number to hand out. Ref-preserving layout moves and replacement transfers follow `docs/specs/dor-cli.md` → Handle Model. **Must drop a killed Surface's entry without reusing its retired ref**: persist `surfaceRefsNext` independently rather than deriving it from the map, and clamp it above the map's highest ref on load. Old snapshots without the fields allocate refs from the restored Surfaces on first mount.

**Surface kinds in the snapshot.** Each `PersistedPane` records a `surfaceType` (`docs/specs/glossary.md`): `'terminal'` — the default, **omitted from the row** so terminal snapshots stay byte-identical — `'browser'`, or `'tool'`, whose extra `command` and `tool` fields are `docs/specs/dor-tool.md` → Persistence and hosts. **A pane lacking it reads as `'terminal'`.** A browser pane mints no PTY on restore and survives resume without one, rebuilding from the persisted layout (visible) or `PersistedDoor.params` (minimized). **Must reject a layout whose leaves differ from the visible pane set during restore or resume, and omit visible browser ids from the terminal fallback.**

**Each mounted Workspace publishes its `PersistedSession` to a Window collector**, which orders them by the Workspace store and writes the whole Window through one debounced writer the host installs at boot (rationale).

- **A Workspace with neither a published nor a boot-seeded session is dropped rather than written empty**, so a mid-boot snapshot cannot blank a restored Workspace.
- **A Workspace's save compares against its own previous record** — seeded from disk until its Wall publishes — never the Window's active one, or a dead PTY's retained cwd and alert would come from the wrong Workspace.
- **Reordering, renaming, or switching the active Workspace writes too.** **Always write `nameIsAuto`**; lacking it, only a `Workspace <n>` name is auto.
- **Must publish both Workspace records in one synchronous step with a Surface move's ownership change**, unprobed and behind one Window write (`pagehide` included), fencing saves collected before or during the change and retaining a departed Session's previous cwd/alert in the destination.
- **VS Code does not use the collector** — each webview persists one bare `PersistedSession`, its single Workspace, through its own per-surface state API (`docs/specs/vscode.md`).

**The Window wrapping lives at the standalone adapter boundary, never in the shared save/restore code**, which still operates on a bare `PersistedSession` per Workspace (`docs/specs/standalone.md` → Persistence). **A Window-persisting adapter answers through `getWindowState` / `saveWindowState`, and answers nothing on the bare-Session `getState` / `saveState` pair** — its blob is a Window and every shared reader of `getState` wants a Session. **A blob written before standalone persisted Windows is wrapped as the window's one Workspace**; that is the only migration.

**A save probes every non-browser pane's cwd in one host round trip where the adapter offers `getCwds`, and every save landing in one microtask shares that round trip**, falling back to one `getCwd` per id (rationale). **A flush may say `probeCwd: false`** and keep each pane's previously persisted cwd — the post-kill quit flush (`docs/specs/standalone.md` → "Quit flow").

**A corrupt save must never block startup.** Every read goes through `readPersistedSession()` / `readPersistedWindow()`, which accept the canonical parsed object *or* a JSON-stringified blob and log-and-discard anything present but unreadable. `readPersistedWindow` also drops Workspaces whose inner session is unreadable and repairs a dangling `activeWorkspaceId` to the first Workspace.

**Must keep recovery commands outside `PersistedPane`.** `normalizeSessionV3` strips legacy `resumeCommand` fields. Capture, records, and execution follow `docs/compatible-agents.md`.

Source of truth: `PersistedSession` in `lib/src/lib/session-types.ts`; `lib/src/lib/window-session-aggregator.ts`; `saveSession` in `lib/src/lib/session-save.ts`; `restoreSession` in `lib/src/lib/session-restore.ts`; `lib/src/lib/window-persistence.ts`; `standalone/src/coalesce-cwds.ts`.

## Persistence policy

### What is persisted

**Must persist structure only, never scrollback or recovery commands.** The accepted shapes are `PersistedSession` / `PersistedWindow` in `lib/src/lib/session-types.ts`; their behavioral contracts are in Persisted session types.

### Retiring the transcripts already on disk

**Must remove legacy transcript bytes from disk** (rationale). **No writer accepts a transcript-bearing Session shape.**

- **`readPersistedSession` drops `scrollback` and `resumeCommand` when present** and requires neither, so a transcript never survives into a parsed Session and the first save after upgrade rewrites each store without one.
- **Standalone sweeps orphaned session temp files at boot**, the only path that can retire a transcript a crash left in one, and **never touches a live snapshot**. `sweep_orphan_session_temps` in `standalone/src-tauri/src/lib.rs`.
- **Debug standalone must atomically remove obsolete pane `scrollback` from recognized legacy-root snapshots**, preserving other fields and leaving malformed snapshots untouched. `scrub_legacy_session_transcripts` in `standalone/src-tauri/src/lib.rs`.

### The governing rule

**Dormouse restores only what it destroyed without asking** (rationale). Deliberately ending something ends it:

| Boundary | Deliberate? | Outcome |
| --- | --- | --- |
| Standalone quit or restart — idle, confirmed, or update-install | No — window state is the app's contract | Restore structure + auto-resume agents |
| Standalone window reload | No | Live resume over sidecar PTYs, per Workspace |
| Standalone per-window close, one of several | Yes | Fresh: its PTYs killed, its snapshot removed |
| Standalone Workspace transfer between windows | Neither — nothing ended | The same Sessions, resumed in the other window |
| Standalone crash / force-kill | No, and the last save stands | Restore structure, no agent resume |
| VS Code panel hide/show | No | Live resume over host PTYs, unchanged |
| VS Code Reload Window | No — an editor operation, not an ending | Restore structure + auto-resume agents |
| VS Code window close / application quit | No — window state is the host's contract | Restore structure + auto-resume agents |
| VS Code editor-tab close (`killOnDispose: true`) | Yes | Fresh for that panel |
| VS Code extension-host crash | No, and the last periodic save stands | Restore structure, no agent resume — `deactivate()` never ran |

**Under Labs → No-confirm delayed kill, a close that would ask ends nothing until its countdown does**, and a restore resumes nothing — the Session never left (`docs/specs/reopen.md` → "Labs: No-confirm delayed kill"); nothing pending survives a quit, window close, or restart.

Standalone's per-window record: `docs/specs/standalone.md` -> "Persistence". "Restore structure" brings back the layout, cwds, titles, doors, and TODO/alert blobs; "auto-resume agents" is `docs/compatible-agents.md` → "Cold restore".

## Universal invariants

- **A position in a pane's output is a received count, not a buffer length.** The bounded buffer evicts from the front, so its length goes flat while output keeps flowing (rationale). Anything marking a point in the stream, or watching a pane for growth, reads the monotonic received count and slices since it, clamped to what the buffer still holds.
- **Never report the exit of a PTY replaced under its id**; a killed one still reports.
- **A spawn that fails still reports an exit.** `pty-core.spawn` answers a node-pty failure with `error` *and* `exit`; `error` reaches no webview (rationale).
- **Teardown acks are correlated by request id, never by message type alone.** For `interrupt` and the graceful kill the pty-host echoes `requestId` on `interruptDone` / `gracefulKillDone` and the caller compares it — a timed-out call's ack still arrives afterwards (rationale).
- **An omitted interrupt target list is not an empty one.** `pty-core.interrupt(ids)` broadcasts to every live PTY only when `ids` is *omitted*; an empty array is a no-op, so a caller whose computed set comes out empty never sends the blanket second press that destroys codex's hint.
- **Untouched defaults conservatively.** New saved panes include `untouched`; a pane read without the field defaults to `untouched: false`, so it still requires kill confirmation.
- **Replay filtering does not re-fire alerts**, quiesce-detector events, or protocol notifications (`docs/specs/terminal-escapes.md` → "`pty:data` strip semantics").
- **Never run a synchronous subprocess on a PTY host's event loop** (the Tauri sidecar, VS Code's pty-host); `/proc` reads and small state files are exempt (rationale). Pinned by `standalone/sidecar/no-sync-subprocess.test.js`.
- **Must discard a probe's answer for a PTY replaced or exited mid-probe.**

Source of truth: `sliceSince` in `lib/src/host/replay-buffer.ts`; `answerForIds` in `standalone/sidecar/pty-core.js`.

## Port scan deadlines

**Never queue a port request behind another scan**, so each request's own budget holds (rationale).

**Must budget port requests for both serial scans and an IPC margin per hop**: `2 × OPEN_PORT_TIMEOUT_MS + count × OPEN_PORT_TIMEOUT_PER_ID_MS + hops × OPEN_PORT_ROUND_TRIP_MARGIN_MS`. VS Code's child request uses one hop; its webview request uses two. Tauri's sidecar request uses one. **Must share the Windows socket-scan allowance across `Get-NetTCPConnection` and its `netstat` fallback**, starting none after exhaustion. The constants are mirrored across TypeScript, the sidecar, and Rust, pinned by `lib/src/lib/mirrored-constants.test.ts`.

Source of truth: `openPortRequestTimeoutMs` in `lib/src/lib/platform/types.ts`; `open_ports_many_timeout` in `standalone/src-tauri/src/lib.rs`; `createPortScanner` in `standalone/sidecar/port-scanner.js`.

## Auxiliary helper metadata

**Must carry helper parent identity and captured autorun command in live PTY metadata**, validating that the parent is owned and is not itself a helper. Promotion clears that association without restarting the PTY. Reconnect restores helper entries before reconciling the primary layout, excluding them from ordinary orphan-pane recovery; a missing parent recovers its helper as an ordinary Pane, and recovered helpers disable automatic refresh. Helper scrollback and editor buffers are never written to a Session snapshot.

**Must expose terminal context operations through correlated host requests**, reporting errors and timeouts: each adapter forwards every `TerminalContextRequest` to its PTY host and answers on the same correlation. The VS Code router checks Workspace ownership for per-terminal operations and helper parent metadata. Directory opening follows `docs/specs/security-local.md` → Terminal context directory actions, and inspection failure `docs/specs/terminal-context.md` → Helper lifecycle.

Source of truth: `TerminalContextRequest` in `lib/src/lib/terminal-context-types.ts`; `PtyInfo` in `lib/src/lib/platform/types.ts`; `resumeOrRestore` in `lib/src/lib/reconnect.ts`; `context` in `standalone/sidecar/pty-core.js`; `attachRouter` in `vscode-ext/src/message-router.ts`.

## Tool transport

**Must forward parsed OSC 367 announcements and state from the PTY owner to its renderer**, without reparsing live display bytes or answering from a viewer (`docs/specs/dor-tool.md` → OSC 367). Tool persistence follows `docs/specs/dor-tool.md` → Persistence and hosts.

Source of truth: `ExtensionMessage` in `vscode-ext/src/message-types.ts`; `ownerStream` in `lib/src/host/remote/sidecar-entry.ts`.
