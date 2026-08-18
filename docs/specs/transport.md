# Transport and PTY Protocol Spec

> Adapter-agnostic protocol shared by all `PlatformAdapter` implementations — the VS Code extension (`docs/specs/vscode.md`), the standalone Tauri sidecar, and the `fake-adapter.ts` used for tests and the website playground. Covers PTY lifecycle, buffering, the webview ↔ platform message protocol, persisted-session types, and the invariants every adapter must honor. See `docs/specs/glossary.md` for the Process / Link state vocabulary, `docs/specs/alert.md` for `AlertManager` semantics, and `docs/specs/terminal-state.md` for the semantic events delivered over this transport.

## Adapter model

Each platform adapter wraps a PTY-spawning runtime and a transport channel between webview and host process. The webview is a thin view layer; PTYs and `AlertManager` live on the platform side. The frontend `lib/src/lib/platform/` module exposes a `PlatformAdapter` interface that all adapters implement.

| Adapter | Host runtime | Transport |
|---|---|---|
| VS Code extension | extension host (Node.js) | `vscode.Webview.postMessage` ↔ `acquireVsCodeApi().postMessage` |
| Standalone (Tauri) | sidecar process | Tauri command/event bridge |
| Standalone browser-dev | sidecar process + local dev HTTP bridge | fetch commands + Server-Sent Events |
| Fake (tests, playground) | in-process | direct function calls / event emitter |

### Standalone browser-dev harness

Source of truth: `standalone/scripts/dev-agent-browser.mjs`, `standalone/src/browser-sidecar-host.ts`, and `standalone/src/browser-sidecar-adapter.ts`.

`pnpm dev:standalone:ab` starts the standalone sidecar directly, starts a localhost-only HTTP bridge, starts Vite with `VITE_DORMOUSE_BROWSER_DEV_HOST`, and opens the app URL in an `agent-browser` session. The browser build uses `BrowserSidecarAdapter` instead of `TauriAdapter` when that env var is present.

The browser-dev bridge is intentionally a transport shim over the same sidecar protocol, not a second PTY implementation:

- Webview → host fire-and-forget commands use `POST /__dormouse_dev_host/send`.
- Webview → host request/response commands use `POST /__dormouse_dev_host/invoke`.
- Host → webview events use `GET /__dormouse_dev_host/events` as an SSE stream.
- Browser console calls are mirrored to `POST /__dormouse_dev_host/console` so a single `pnpm dev:standalone:ab` terminal shows sidecar logs, Vite logs, and in-browser diagnostics.

The harness may omit native-only desktop chrome such as window controls and update checks, but it must preserve the `PlatformAdapter` PTY, control-request, clipboard, iframe-proxy, and agent-browser contracts used by the app. Tauri APIs must not be required at static module-evaluation time when `VITE_DORMOUSE_BROWSER_DEV_HOST` is set, because the page is loaded by a normal browser rather than the Tauri WebView.

## PTY lifecycle

PTYs are managed by the platform host, not by the webview. The webview is a view layer that **resumes** over live PTYs (host-preserved) or **restores** from a Snapshot (cold start). See `docs/specs/glossary.md` for the Process / Link states.

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
- The webview becoming visible again resumes over still-owned PTYs and reapplies the saved visible-pane layout when the saved session covers the live PTY set and the layout's visible panels match.
- A PTY process that exits naturally can remain mounted as an exited pane; frontend semantic state such as CWD, title candidates, and last command is retained until the Session is actually disposed.
- Each message router tracks which PTYs it owns; PTYs cannot be stolen by another router.
- Explicitly killed PTYs are **tombstoned** in the host (`Process: Tombstoned`) so a late child-process `exit` event cannot recreate their buffer and make them resumable.
- Multiple host instances (e.g., multiple VS Code windows) each get their own pty-host child process.

### PTY buffering

`pty-manager` maintains two buffer types per PTY:

- **replayChunks**: cleared on first consume, used for resume (webview hidden then shown).
- **scrollbackChunks**: never cleared, used for repeat resumes and for recovery capture at teardown. Host-side only — no adapter exposes it to the renderer.

Both are capped at 1M chars per PTY. When the cap is reached, oldest chunks are trimmed.

### Reconnection protocol

```
1. Webview becomes visible (or panel deserializes).
2. Webview sends: { type: 'dormouse:init' }.
3. Host responds with:
   - { type: 'pty:list', ptys: [{ id, alive, exitCode }] }   // all owned PTYs
   - { type: 'pty:replay', id, data }                         // buffered output per PTY
4. Webview restores terminals from replay data, seeds saved pane and door titles back via `setTerminalUserTitle()` (which rejects titles starting with `<idle>`, the sentinel that prefixes the auto-generated finished-pane header). The seed callers in `terminal-lifecycle.ts` additionally skip `<unnamed>` so the default panel placeholder does not get seeded as a real user pin during cold-restore. (Persistence cannot distinguish a deliberate `<unnamed>` pin from the default placeholder, so a user who explicitly pinned `<unnamed>` will see it revert to the derived header on app reload.)
5. If the saved session covers those live PTYs, the frontend uses the saved Lath layout when its leaf set matches and reattaches saved minimized doors; minimized PTYs are registered but remain doors instead of visible panes.
```

For cold restore (no live PTYs), the webview falls back to saved session state: spawns new PTYs in saved CWDs using the currently selected Dormouse shell and restores the saved Lath layout. No transcript is replayed — scrollback is not persisted ("Persistence policy" below) — and any pane carrying a recovery command auto-runs it. The entry module (`reconnect.ts`) uses a 500ms timeout when waiting for the PTY list.

## Message protocol

Source of truth:

| Scope | Source |
| --- | --- |
| Message schema | `vscode-ext/src/message-types.ts` (`WebviewMessage`, `ExtensionMessage`; other adapters import or mirror it) |
| Persisted-session types | `lib/src/lib/session-types.ts` (shared webview/host boundary types) |
| Webview handlers | Adapter modules such as `vscode-adapter.ts` and `fake-adapter.ts` |
| Host handlers | The per-adapter message router |

Non-obvious message contracts:

**Sender authenticity is the adapter's job, not the protocol's.** The schema below says what a message means, never that it came from the host. Each adapter must establish that on its own transport before dispatching: the Tauri and browser-dev adapters inherit it from a private IPC channel and a host-owned socket, while the VS Code adapter shares its `window` inbox with framed surfaces and so requires a per-boot token on every host message (`docs/specs/vscode.md` → "Webview message authentication"). An adapter whose transport is reachable by page content must authenticate before it branches on `type`.

VS Code-only workbench chord mirroring uses `dormouse:runWorkbenchCommand` from webview to host. The host validates the requested command against the allowlist in `lib/src/lib/vscode-keybindings.ts` (see [the VS Code host spec](vscode.md)) before calling `vscode.commands.executeCommand`; generic command execution over the webview boundary is not allowed.

Host-owned storage and peer coordination are VS Code-only additions to the adapter surface, both optional on `PlatformAdapter`. `hydrateScopedStore(prefix)` (`store:read` → `store:entries`, then fire-and-forget `store:write`) moves every key under one prefix into extension-host storage and installs a synchronous write-through cache over it, because `local-json-store` is synchronous by contract and the remote Host's bearer credential must not sit in webview `localStorage`. `peers` is present only on a host that can show several webviews over one backend, and carries both halves of that condition: `claimSingleton(name, onChange)` (`singleton:claim` → `singleton:lease`) asks the host to arbitrate a role that at most one webview may hold, since only the extension host sees every webview, and a generic `request` / `respond` / `streamPty` seam reaches surfaces the other webviews own (`docs/specs/vscode.md` → "Peer surfaces"). Adapters that omit either are single-instance with local storage, which is correct for standalone and the website. Both are prefix/name gated on the host side — the webview names the key, so the host decides what that name may reach. See `docs/specs/vscode.md` → "Remote Host: store and lease".

Workspace union status (`docs/specs/alert.md`) adds no new message. Standalone computes it in-webview — the app bar's workspace strip and the Walls share one webview, so the strip reads the activity store and browser-surface state directly. VS Code computes only the host-visible native-chrome projection from the module-level `AlertManager` filtered to each router's `ownedPtyIds`, then writes it onto native chrome; the host already receives every PTY's alert state, but it does not receive browser-surface TODO (the webview→host Surface-state message is staged — see `docs/specs/vscode.md` `## Future`).

| Direction | Message | Source type | Contract |
| --- | --- | --- | --- |
| Webview → host | `alert:initializeWatchedCommands` | `WebviewMessage` | Offer the renderer's persisted WATCHING rules as the startup seed. A multi-webview host accepts only the first seed in its lifetime and replies with its canonical snapshot. |
| Webview → host | `alert:setCommandWatched` | `WebviewMessage` | Add or remove one bare command key without replacing unrelated app-global rules. |
| Host → webview | `alert:watchedCommands` | `ExtensionMessage` | Canonical full WATCHING snapshot broadcast after initialization or mutation; each renderer replaces and persists its local mirror. |
| Webview → host | `alert:initializeSettings` | `WebviewMessage` | Offer the renderer's persisted alarm settings (`docs/specs/alert.md` -> Alarm settings) as the startup seed. Same first-seed-wins rule as `alert:initializeWatchedCommands`. |
| Webview → host | `alert:updateSettings` | `WebviewMessage` | Replace the host's alarm settings after a user edit. The whole blob travels, including the fields only renderers consume, so every webview agrees. |
| Host → webview | `alert:settings` | `ExtensionMessage` | Canonical settings snapshot broadcast after initialization or update; each renderer replaces and persists its local mirror. |

Both settings messages carry renderer-supplied numbers that become host timers, so the host **must** revalidate rather than trust them: `AlertSettingsHost` runs every inbound blob through `normalizeAlertSettings`, which drops unknown keys, defaults missing ones, and clamps each delay into range. A webview cannot install a `NaN` or absurd attention window. The two directions share one adapter method — `alertPublishSettings(settings, { seed })` — because the seed/replace distinction only picks a message type; it is not a different payload.

Note the per-store cost: each app-global store relayed this way spends one `PlatformAdapter` push method plus an on/off listener pair, three message types, and a host coordinator with its own subscribe/unsubscribe. Two stores (WATCHING rules, alarm settings) is worth the directness. A third should instead collapse them into one keyed channel with a host-side key→normalizer registry, rather than paying the tax again.
| Webview → host | `dormouse:openExternal` | `WebviewMessage` | Request the host to open a user-confirmed external URI from an OSC 8 hyperlink. Hosts must revalidate and reject malformed, control-character-bearing, or blocked pseudo-scheme targets (`javascript:`, `data:`, `blob:`, `about:`). |
| Webview → host | `pty:getOpenPorts` | `WebviewMessage` | Request the TCP listening ports opened by a PTY's shell process **and all of its descendant subprocesses**. The host resolves them from the PTY's root pid and replies with `pty:openPorts`. Source of truth: `getOpenPortsForPid()` in `standalone/sidecar/pty-core.js` (the VS Code extension loads it through the `lib/pty-core.cjs` shim). |
| Host → webview | `pty:openPorts` | `ExtensionMessage` | Reply to `pty:getOpenPorts`: `ports: OpenPort[]` (`{ protocol, family, address, port, pid, processName }`), de-duplicated by `(family, address, port)` and sorted by port. Empty array when the PTY is gone or enumeration fails. |
| Host → webview | `pty:data` | `ExtensionMessage` | PTY output after state-driving supported OSC sequences have been parsed/stripped; `OSC 8` hyperlinks are preserved for xterm.js and routed only to the owning router. |
| Host → webview | `pty:replay` | `ExtensionMessage` | Buffered raw output since spawn; the webview parses semantic OSCs during replay reconstruction without triggering alerts. |
| Host → webview | `dormouse:newTerminal` | `ExtensionMessage` | Payload may include `shell`, `args`, display `name`, `replaceUntouched`, and `announce`; the webview replaces the selected untouched terminal in-place only when `replaceUntouched` is true, otherwise it spawns a new pane. |

The OSC parsing/stripping rules that produce `pty:data` and `terminal:semanticEvents` are specified in `docs/specs/terminal-escapes.md`.

## Persisted session types

Source of truth: `lib/src/lib/session-types.ts` defines the persisted-session interfaces (`PersistedSession` v3, `PersistedPane` — now carrying `surfaceType` — `PersistedAlertState`, `PersistedDoor`, and the container types `PersistedWorkspace` / `PersistedWindow`).

**The layout field.** A `PersistedSession` records the layout as `lathLayout` — the native Lath tree (`docs/specs/tiling-engine.md` → "Persistence"). Each `PersistedDoor` carries a Lath restore `token` as its sole restore payload.

**Workspace-scoped dor refs.** A `PersistedSession` may record `surfaceRefs`,
a map from stable Surface id to the Workspace-local `dor` short ref
(`surface:N`). The map belongs to the Workspace session, not to the layout:
reordering, minimizing, reattaching, zooming, and browser render swaps preserve
the ref, and closed Surface ids remain in the map so a stale short ref is never
reused for a different Surface. Old snapshots without the field allocate refs
from the restored Surfaces on first mount. Source of truth:
`Wall.tsx` owns the runtime registry and `session-save.ts` writes it.

**Surface kinds in the snapshot.** Each `PersistedPane` records a `surfaceType` (`docs/specs/glossary.md`): `'terminal'` (the default, omitted from the row to keep terminal snapshots byte-identical) or `'browser'`. This is the discriminator that routes restore/resume. `restoreSession` skips terminal restoration for a browser pane, so it no longer mints a stray PTY + xterm for each browser pane id (`session-restore.ts`); the resume plan keeps browser panes (and minimized browser doors) even though they have no live PTY, so the saved layout's pane set still matches and is not discarded (`reconnect.ts` gates the session's Lath layout on its leaf set). A browser pane rebuilds from the persisted layout (visible) or `PersistedDoor.params` (minimized); its render params (`renderMode`, `url`, agent-browser `session`) live there, not in `PersistedPane` — `surfaceType` alone is enough to route restore. A pane lacking `surfaceType` reads as `'terminal'`.

**Workspace/Window containers (implemented, dormant behind the `dormouse.flags.workspaces` flag; rollout ledger in `docs/specs/layout.md` `## Future`).** A **Workspace** persists as a `PersistedWorkspace`: a `WorkspaceId`, a user-facing `name`, and the Workspace's `PersistedSession` (its panes, doors, and Lath layout). The standalone Window persists as a `PersistedWindow`: the ordered list of `PersistedWorkspace` plus the active `WorkspaceId`. Source of truth: `PersistedWorkspace` / `PersistedWindow` / `readPersistedWindow` / `replaceActiveSession` in `session-types.ts`. VS Code does **not** use `PersistedWindow`; each webview persists exactly one `PersistedSession` — its single Workspace — through the same per-surface state API as today (`workspaceState` for the view, `vscode.setState()` per editor panel; see `docs/specs/vscode.md`).

The wrapping lives at the **standalone adapter boundary**, not in the shared save/restore code: `lib/src/lib/window-persistence.ts` (`activeSessionFromStored` / `storedValueForSession`) translates between the host's stored top-level blob and the bare `PersistedSession` that `reconnect.ts` / `session-save.ts` operate on, and `tauri-adapter.ts` / `browser-sidecar-adapter.ts` route `getState` / `saveState` through it. The blob round-trips through a `SessionKeyValueStore` — a single synchronous key/value slot the host persists natively: the browser-dev sidecar uses `localStorage`, while the real standalone adapter uses a Rust-backed per-window file store (`docs/specs/standalone.md` §Persistence), never WebKit `localStorage`. With the flag **off** (the default) these are identity passthroughs — the stored blob stays a bare `PersistedSession`. With the flag **on**, load returns the active Workspace's session and save merges it back into the active slot, preserving the other Workspaces.

Versioning: the standalone top-level snapshot is a `PersistedWindow` (its own `version: 1`) wrapping v3 sessions. `readPersistedWindow` drops Workspaces whose inner session is unreadable and repairs a dangling `activeWorkspaceId` to the first Workspace; an unreadable or corrupt blob is logged and discarded so startup continues fresh rather than blocking on a bad save. VS Code hands back a bare `PersistedSession` — its single Workspace.

**The recovery command.** One agent resume invocation per surface (`claude --resume <id>`, `claude --continue`, `codex resume <id>`). It is the only thing that survives a teardown — scrollback is never persisted (see "What is persisted" below).

*It is not part of the persisted session.* `PersistedPane` carries no `resumeCommand`, and `normalizeSessionV3` strips one out of a pre-upgrade blob the same way it strips a transcript. The command is host-owned and single-use, so it travels out of band: the host puts `surfaceId -> invocation` on the webview's boot payload, and the renderer reads it through `PlatformAdapter.getRecoveryCommands()`. Keeping it off the session shape is what makes the one-shot guarantee structural rather than procedural — the webview has nothing to write back, so no save/restore cycle can carry a stale invocation past the destructive read below. An adapter whose host captures nothing simply omits the method.

*Who writes it.* Exactly one writer: a host teardown that interrupted a running agent, reading the live in-memory buffer (`captureAgentRecoveryCommands` in `vscode-ext/src/session-state.ts`). The renderer save path never derives it and never guesses. Standalone writes it never, because standalone persists no Session state at all.

*Who reads it.* Cold restore, which auto-runs it (`docs/specs/layout.md` → "Agent resume on cold restore"); nothing reads it on resume, where the agent is still Live. Exactly-once holds on two levels, because the capture interrupts every live PTY and those panes are spread across the Dormouse view and any number of editor panels. `takeRecoveryCommands` reads and unlinks the file on the first call of an activation, so the durable copy is gone before any webview is served and a failed activation cannot replay it; within the activation each webview claims only the entries matching *its own* saved pane ids, and a claimed entry leaves the map. So no container can delete another's commands by resolving first, and a view that is disposed and re-resolved (moving the panel container, say) restores without re-running the agent. Source of truth: `takeRecoveryCommands` in `vscode-ext/src/session-state.ts`, `getRecoveryCommands` in `vscode-adapter.ts`, `restoreSession` in `session-restore.ts`.

*Detection.* `detectResumeCommand` strips terminal presentation controls and accepts only the agents' opaque ASCII id grammar (alphanumeric, hyphen, underscore); shell punctuation is never captured into executable state, because this string is executed. Text *around* the invocation is not part of that judgement — codex's real hint is prose on the same line (`To continue this session, run codex resume <id>`), so the prose-tolerant match is load-bearing rather than hypothetical; the command is rebuilt as invocation + captured id and anything trailing the id is dropped. The one thing that must follow the invocation is a word break, so `claude --continuex` is not an offer to continue. The scan window is stripped as a whole, in one pass, so a string control whose payload spans an LF is removed as a unit, and an *unterminated* string control (OSC, DCS, SOS, PM, APC) swallows the rest of the window rather than surrendering its payload — a window title cut mid-sequence does not read as terminal output. "Terminated" tracks what the renderer honours rather than ECMA-48 alone: ST in both forms (`\x1b\\`, `\x9c`), BEL for OSC, and — because xterm's parser aborts a string control on CAN/SUB and ends one on a bare ESC — those three as well, so a prompt printed behind an aborted sequence stays visible instead of being swallowed. A payload whose *introducer* fell off the front of the window (the sidecar's chunk-evicting buffer can strand one) is not recoverable at this layer, since nothing left in view marks it as payload; it grants no more than ordinary output already does. A CSI the window was cut off *inside* is swallowed for the same reason a string control is: a tail ending `\x1b[38;5` must not surrender `38;5` as text for the greedy id pattern to absorb. Every escape sequence is matched by its full ECMA-48 shape — ESC, intermediates, one final byte — rather than by the Fe range alone, because `ESC 7`/`ESC 8` (DECSC/DECRC) and `ESC c` (RIS) have finals outside it and stripping only their introducer leaks the final byte into the text as a digit or a letter. Stripping is the shared `stripTerminalControls` in `lib/src/lib/terminal-controls.ts` — one implementation, so a hardening step cannot reach detection while missing the prompt detector that reads the same kind of tail slice (`docs/specs/terminal-state.md`). Detection strips in **boundary mode**, whose rule is inverted: *every* control becomes a newline rather than vanishing, except the two classes that neither move the cursor nor erase — SGR and charset designators, where the text either side really is contiguous. Deleting the rest welds text that was never adjacent on screen. Cursor moves are the obvious case, and not only CSI ones: `ESC M` (RI) is how a TUI scrolls up, `ESC 7`/`ESC 8` bracket a redraw, `ESC c` resets outright, and VT/FF move the cursor down. Erasures count too — `\x1b[2K` means the text before it on that line is gone, so what follows is a new region. Backspace gets the same treatment for the same reason. Observed in the wild as a stored `claude --resume <uuid>codex` — a redraw had put `\x1b[K\x1b[1;1H` between the tail of a stale echoed command and the start of the next, and the greedy id pattern ate across the seam. Because no pattern can span the newline a boundary leaves, the stripped window is then scanned **whole** and the rightmost match wins: that is the newest hint by position, so carriage-return-only redraws still select the newest visible one and pattern order never outranks recency. Restore revalidates through `normalizeResumeCommand` before typing, as defense against a snapshot written by an older detector. Source of truth: `lib/src/lib/resume-patterns.ts`.

Every saved-session entry point must pass through `readPersistedSession()`. That reader accepts both the canonical parsed object and a JSON-stringified session blob before validating it (covering host state APIs that may hand back the inner serialized JSON string); a present-but-unreadable blob is logged and discarded so the caller starts fresh — a corrupt save can never block startup.

## Persistence policy

### Retiring the transcripts already on disk

Every existing installation has a transcript-bearing snapshot sitting in
`workspaceState` or the standalone file store right now. Ignoring the field is not
enough — the bytes have to go.

- `readPersistedSession` stops **requiring** `scrollback` on a pane (it is required
  today, so a snapshot written without it would be rejected wholesale) and **drops**
  it when present. A transcript can be read out of a legacy blob but never survives
  into a parsed Session, so nothing downstream can persist it forward.
- The first save after upgrade therefore rewrites each store without transcripts.
  Standalone, which stops reading its store entirely, clears the slot outright at
  boot rather than waiting for a save that may never come, including an orphaned
  sibling temp file left by a crash before atomic rename.
- No writer accepts a transcript-bearing Session shape afterward.

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
Live resume within a running app is unaffected — it reads the sidecar's live PTY
list, not disk. A legacy blob found at boot is deleted, not read.

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
entirely, leaving `Shutting down...^C` and nothing else.

A timing window is not sufficient, and trying one is instructive: codex's latency
is not a constant (~255 ms for a bare session, over 400 ms in a real project inside
a pane), so any fixed window eventually double-presses it and destroys its hint.
The trigger is therefore the **explicit ask**, not the clock:

1. one `^C` to every live PTY;
2. poll, and send one more `^C` to a pane that has yielded nothing — either the
   moment it shows `Press Ctrl-C again`, or once ~600 ms have passed and the pane
   has been silent for ~200 ms. Both clocks start when the first press is *acked*,
   not when the teardown step is entered: they are statements about the agent, and
   the agent's clock starts when the `^C` lands. Measuring from entry folds the
   interrupt's own round trip (up to its 400 ms timeout) into the window and can
   fire the blind press while codex is still inside its first ~255 ms of silence.
   The poll's wall-clock ceiling is the one timing anchored to entry instead,
   because that one is a shutdown budget rather than an agent timing.

   Both agents' reaction to `^C` is state-dependent, which is why neither a phrase
   gate nor a timer alone is enough. Observed in a real pane: codex answered the
   first press by *repainting its TUI* — 256 bytes of cursor positioning ending on
   its footer hint — and carried on running, never printing a hint and never
   asking for another press. An ask-only gate leaves that pane stuck for the whole
   poll. The silence requirement is the guard on the other side: a second press
   landing mid-shutdown destroys the hint, so the pane must have stopped emitting
   first. Note that quiet is used here as evidence that pressing again cannot
   interrupt a print already in flight — *not* as evidence that the pane is
   finished, which is the mistake that killed two earlier heuristics;
3. keep polling to a fixed ceiling, storing each command the moment it appears.

**Do not try to finish early on quiet.** Codex says nothing for ~250 ms after the
interrupt and then prints its entire shutdown at once, so silence is what it looks
like *before* it speaks, not after. Two heuristics died on exactly that: settling
when detections stopped arriving (exited at +219 ms, capturing only the faster
agent) and settling when output stopped arriving (exited at +160 ms, capturing
nothing at all). The only early exit that is sound is having nothing left to wait
for — every live pane has already yielded.

Polling to the ceiling is affordable precisely because the record is written
eagerly: the cost is budget taken from the later teardown steps, and those are the
ones whose data can be reconstructed.

A pane that never asks is never pressed twice, whatever its latency, so codex is
safe by construction rather than by margin. The coupling to an English UI string is
deliberate: if the wording changes, claude's recovery is lost — visibly and
recoverably — whereas a mistimed window destroys codex's every single time. Only
the host can make this call, because only the host sees what came back.

**Why press-wait-press.** Both agents' reaction to `^C` is state-dependent, and
codex's is the constraining case: its `^C` is consumed by the input line first.
Measured against real sessions in a pty:

| State when interrupted | Gesture | Hint | At |
| --- | --- | --- | --- |
| idle after a pause | one `^C` | yes | 262 ms |
| idle after a pause | two `^C`, 150 ms apart | **no** | — |
| idle after a pause | `^C`, 800 ms, `^C` | yes | 855 ms |
| unsent text in the input | one `^C` | **no** | — |
| unsent text in the input | two `^C`, 150 ms apart | yes | 464 ms |
| unsent text in the input | `^C`, 800 ms, `^C` | yes | 1061 ms |
| freshly launched, no conversation | one `^C` | no — correctly, nothing to resume | — |

With text typed, the first press only clears the line and codex keeps running,
which on screen looks like a TUI repaint rather than a shutdown. With an empty
input the first press exits and prints at ~262 ms, and a second press inside that
window aborts the print. So a blanket second press destroys the idle case and an
ask-gated one never fires at all — `Press Ctrl-C again` was absent from every
codex cell, meaning the phrase gate can only ever serve claude. Press-wait-press
is the only gesture covering both, and the loop's constants are sized against
these numbers: the idle case yields at 262 ms and so leaves the retry set before
the ~600 ms fallback arrives.

Confirmed end to end in a real pane: fallback press at +625 ms, hint detected at
+789 ms, applied on the next activation.

Every live terminal PTY is interrupted, not just recognized agents. A foreground
gate would need the host to learn each pane's running command — it receives only
`alert:state` today — and it buys nothing at this boundary, because every one of
these processes is killed seconds later regardless. `^C` into a non-agent is inert
(a shell clears its line; an editor ignores it), and `detectResumeCommand` is the
real filter: a pane that prints no canonical hint records nothing.

Detection runs over the **live in-memory buffer**, not over persisted scrollback —
`detectResumeCommand` is unchanged, but its input moves. The transcript is
discarded immediately after detection and never reaches a writer.

**Only post-interrupt bytes count.** Each pane's buffer length is recorded before
the first `^C`, and detection reads only what arrived after it. This is a
correctness boundary, not an optimisation: a recovery command is executed on the
next restore, so the only bytes allowed to become executable state are the ones
produced *in response to Dormouse's own interrupt*. Scanning the whole buffer let
an old launch echo or a previous agent's hint win — observed as a codex pane
capturing a stale `claude --resume` id, and as an id welded to text from an
earlier screen region. It also fails in the safe direction: if the bounded buffer
evicted bytes in the meantime, slicing at the old length can only discard fresh
output, never promote stale output as fresh. Widening this scan would quietly
weaken the provenance argument that lets recovery run without confirmation
("Consuming it" below).

Both real-world hints are covered by the existing patterns, and both shapes matter:

```
Resume this session with:
claude --resume 4464d32c-a5c8-41a6-a320-a0fd07893096      ← own line

To continue this session, run codex resume 01a00dfd-...   ← prose, same line
```

The prose-tolerant match is therefore load-bearing for codex, not a hypothetical.

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
  directory, so an id cannot be planted to be resumed into, and `RESUME_ID` keeps
  shell punctuation out of what is executed.

It also restores *more* context than the scrollback it replaces: the resumed agent
renders the real conversation, which a transcript replay only approximated.

The pane shows a passive one-line notice that its session was resumed. It is not a
dialog and has no retirement rules — it exists so the discontinuity stays legible
(the interrupted turn did **not** continue) and so a failed resume explains itself.

Auto-launched agents seed `commandLine` + `commandStart` like any programmatic
launch (`docs/specs/terminal-state.md`), so a restored Workspace immediately counts
its agents in `countRunningSessions` — and the following quit-confirmation dialog
counts sessions the user did not start by hand.

Known cost: every cold activation spawns every agent that was running, and cold
start is not free (claude ≈ 5 s, codex ≈ 25 s with MCP servers). This is
proportional to how many agents were actually running, and Reload Window is a
frequent operation. If it becomes a complaint, the mitigation is a setting, not a
prompt.

### VS Code teardown ordering

Capture runs **first**, and that is load-bearing rather than tidy: `[deactivate]
done` has never once been reached in a real shutdown, because VS Code kills the
extension host on a budget we do not control. The one step whose data cannot be
reconstructed afterwards therefore goes before the steps whose data can. The order
is:

1. start closing popped-out browser windows — kicked off here but joined at step 3,
   so it overlaps the poll instead of spending budget of its own. It shares no
   state with the interrupt and spends its time in external processes;
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
session blob. Two reasons, and both are the sort that only show up in a real
shutdown. `workspaceState.update()` hands its value to VS Code's storage service,
which batches the SQLite flush on its own schedule; by `deactivate()` that service
is already tearing down, so the write never lands however early it is issued
(measured: detection complete at +276 ms, record never written). And a later
`flushAllSessions` would overwrite the session blob with the webview's copy, which
knows nothing of what was just captured — a separate record makes the write order
stop mattering. The record is written the moment each command is found, so being
killed mid-poll costs at most a late agent's command rather than everything
detected so far.

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

These rules apply to every adapter. Adapter-specific layering (deactivate ordering, save APIs, panel retention) lives in the adapter spec, e.g. `docs/specs/vscode.md` (deactivate ordering) and `docs/specs/standalone.md` §Quit flow (quit teardown ordering).

- **Scrollback buffers survive PTY exit.** In the shared `pty-core.js`, only the hard `kill`/`killAll` (or host-process exit) clears a PTY's scrollback buffer; natural exit, signal-driven exit, and `gracefulKillAll` leave it readable via `getScrollback`. Recovery capture no longer depends on this (it runs *before* any kill — see "VS Code teardown ordering"), but a final flush that reads a pane whose shell has just exited still does.
- **A position in a pane's output is a received count, not a buffer length.** The host-side buffer is capped (1 MB) and evicts from the front, so `scrollbackChars` goes flat while output keeps flowing — on exactly the long-running agent pane recovery exists for. Anything marking a point in the stream, or watching a pane for growth, reads the monotonic `getScrollbackReceived` and slices with `getScrollbackSince`, which joins only the chunks spanning the mark. Source of truth: `vscode-ext/src/pty-manager.ts`.
- **A spawn that fails still reports an exit.** `pty-core.spawn` answers a node-pty failure with `error` *and* `exit`. `error` is a host-side log line that reaches no webview, so without the exit a pane keeps any command seeded for it as permanently running — a phantom running header, a `countRunningSessions` that never returns to zero, and a quit confirmation on every attempt to close. Reachable whenever a persisted or selected shell binary is gone.
- **Whole-host acks are correlated by request id.** `interrupt` and `gracefulKillAll` both run on a teardown path with a timeout, so a timed-out call's ack still arrives afterwards. Matching on message type alone let that stale reply resolve the *next* call the instant it was issued. The pty-host echoes `requestId` on `interruptDone` / `gracefulKillDone` and the caller compares it.
- **Shell login args are shell-specific.** The shared `pty-core.js` launches POSIX shells with `-l` only for shells that accept it. `csh`/`tcsh` must be spawned without `-l` so users whose login shell is C-shell-derived can open a usable terminal in any adapter.
- **Replayed scrollback ends with a newline.** Output replayed into xterm.js on **resume** must end with `\n`, or zsh prints a `%` artifact at the top of the terminal. (Cold **restore** replays nothing — scrollback is not persisted.)
- **Replay drops terminal replies only.** While saved output is being replayed into xterm.js, terminal-generated OSC/CSI/DCS query and focus reports are dropped so they do not enter the resumed/restored shell's input buffer. The replay filter must preserve user keyboard escape sequences, including arrows, function keys, and bracketed paste.
- **Untouched defaults conservatively.** New saved panes include `untouched`; a pane read without the field defaults to `untouched: false`, so it still requires kill confirmation.
- **PTY ownership.** Each message router tracks the PTY ids it owns. A PTY routed to one webview must not be stolen by another router; new routers attaching to a host must respect existing ownership.
- **Replay filtering does not re-fire alerts.** `pty:replay` re-injects buffered output into xterm.js but must not re-trigger `AlertManager`, activity-monitor events, or protocol notifications.


