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
- **scrollbackChunks**: never cleared, used for repeat resumes and session save.

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

For cold restore (no live PTYs), the webview falls back to saved session state: spawns new PTYs in saved CWDs using the currently selected Dormouse shell, injects saved scrollback (with trailing newline to avoid the zsh `%` artifact), and restores the saved Lath layout. The entry module (`reconnect.ts`) uses a 500ms timeout when waiting for the PTY list.

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

**The resume command.** Each terminal `PersistedPane` records `resumeCommand`: the agent resume invocation detected at the tail of the scrollback being saved (`claude --resume <id>`, `claude --continue`, `codex resume <id>`), or `null`. Detection strips terminal presentation controls and accepts only the agents' opaque ASCII id grammar (alphanumeric, hyphen, underscore); shell punctuation is never captured into executable state. Text *around* the invocation is not part of that judgement — a hint printed mid-sentence (`` Resume with `claude --resume <id>`. ``) is read, because the persisted command is rebuilt as invocation + captured id and anything trailing the id is dropped rather than carried. The one thing that must follow the invocation is a word break, so `claude --continuex` is not an offer to continue. The scan window is stripped as a whole *before* it is split into segments, so a string control whose payload spans an LF is removed as a unit, and an *unterminated* string control (OSC, DCS, SOS, PM, APC) swallows the rest of the window rather than surrendering its payload — a window title cut mid-sequence does not read as terminal output. "Terminated" tracks what the renderer honours rather than ECMA-48 alone: ST in both forms (`\x1b\\`, `\x9c`), BEL for OSC, and — because xterm's parser aborts a string control on CAN/SUB and ends one on a bare ESC — those three as well, so a prompt printed behind an aborted sequence stays visible instead of being swallowed. A payload whose *introducer* fell off the front of the window (the scrollback trim, or the sidecar's chunk-evicting buffer, can strand one) is not recoverable at this layer, since nothing left in view marks it as payload; it grants no more than ordinary output already does, which is a source of offers by design. Stripping is the shared `stripTerminalControls` in `lib/src/lib/terminal-controls.ts` — one implementation, so a hardening step cannot reach detection while missing the prompt detector that reads the same kind of tail slice (`docs/specs/terminal-state.md`). Restore seeding and Run revalidate the canonical command as defense against snapshots written by an older detector. Detection scans the last 50 LF-delimited raw segments **newest first** and chooses the rightmost match within a segment, so carriage-return-only redraws still select the newest visible hint and pattern order never outranks recency. A pane that resumed more than once therefore persists the command for its *current* session rather than a stale id. The field is derived with the trim, never carried forward from the previous save — a pane that resumed again has a newer hint at the tail, and a stale id would make restore offer the wrong session. Both writers go through one helper for that reason: the frontend save path (`session-save.ts`) and the VS Code host-side PTY refresh at deactivate (`vscode-ext/src/session-state.ts`), which rewrites `scrollback` from the live PTYs. Cold restore turns this field into the pane's resume offer (`docs/specs/layout.md` → "Resume offer"); nothing reads it on resume. Source of truth: `detectResumeCommand` / `normalizeResumeCommand` in `lib/src/lib/resume-patterns.ts`, paired with the trim by `terminalPersistedContent` in `lib/src/lib/session-types.ts`.

**Persisted scrollback cap.** Each terminal pane's persisted scrollback is capped at 100,000 chars, keeping the tail cut at a line boundary (with the trailing `\n` preserved, per "Scrollback trailing newline" below) so N busy panes can't rewrite N MB on every save. The trim happens where scrollback is resolved for persistence — both save paths apply it through `terminalPersistedContent` (`session-types.ts`), which also derives the resume command from the trimmed text; detection is unaffected by the cut because resume patterns live at the tail. The sidecar's larger in-memory live-buffer cap (`standalone/sidecar/pty-core.js`) is unchanged. Source of truth: `lib/src/lib/scrollback-trim.ts`.

Every saved-session entry point must pass through `readPersistedSession()`. That reader accepts both the canonical parsed object and a JSON-stringified session blob before validating it (covering host state APIs that may hand back the inner serialized JSON string); a present-but-unreadable blob is logged and discarded so the caller starts fresh — a corrupt save can never block startup.

## Universal invariants

These rules apply to every adapter. Adapter-specific layering (deactivate ordering, save APIs, panel retention) lives in the adapter spec, e.g. `docs/specs/vscode.md` (deactivate ordering) and `docs/specs/standalone.md` §Quit flow (quit teardown ordering).

- **Scrollback buffers survive PTY exit.** In the shared `pty-core.js`, only the hard `kill`/`killAll` (or host-process exit) clears a PTY's scrollback buffer; natural exit, signal-driven exit, and `gracefulKillAll` leave it readable via `getScrollback`. Both hosts' teardown orderings rest on this contract — capture-after-graceful-kill is only correct because the buffer outlives the process.
- **Shell login args are shell-specific.** The shared `pty-core.js` launches POSIX shells with `-l` only for shells that accept it. `csh`/`tcsh` must be spawned without `-l` so users whose login shell is C-shell-derived can open a usable terminal in any adapter.
- **Scrollback trailing newline.** Restored scrollback must end with `\n` to avoid zsh printing a `%` artifact at the top of the terminal.
- **Replay drops terminal replies only.** While saved output is being replayed into xterm.js, terminal-generated OSC/CSI/DCS query and focus reports are dropped so they do not enter the resumed/restored shell's input buffer. The replay filter must preserve user keyboard escape sequences, including arrows, function keys, and bracketed paste.
- **Untouched defaults conservatively.** New saved panes include `untouched`; a pane read without the field defaults to `untouched: false`, so it still requires kill confirmation.
- **PTY ownership.** Each message router tracks the PTY ids it owns. A PTY routed to one webview must not be stolen by another router; new routers attaching to a host must respect existing ownership.
- **Replay filtering does not re-fire alerts.** `pty:replay` re-injects buffered output into xterm.js but must not re-trigger `AlertManager`, activity-monitor events, or protocol notifications.

## Future

**Scope: recovery-retention** — stop treating terminal scrollback as ordinary
persisted application state. Keep it in bounded host memory for live consumers,
and write only the smallest recovery record needed at a lifecycle boundary where
the host is about to destroy a resumable agent without a Dormouse confirmation.
The remaining work, in order, is:

1. split runtime snapshots, durable structural state, and minimal recovery
   records into separate types and storage paths;
2. remove scrollback from every periodic and page-lifecycle disk save;
3. make standalone clean quit discard all restorable Session state and make VS
   Code shutdown persist only newly detected agent recovery records; and
4. gate cold recovery on an explicit user decision and enforce the storage rules
   below with cross-adapter tests.

### Three storage classes

Dormouse separates state by why it exists:

| Class | Contains | Lifetime | May contain scrollback? |
| --- | --- | --- | --- |
| **Runtime Session** | Live PTYs, xterm state, semantic state, layout, browser params, host replay/scrollback buffers | Process lifetime | Yes, in memory only |
| **Durable structure** | The minimum non-transcript state a host needs to reconnect a surviving PTY/webview or deserialize its container | Host-defined; overwritten as structure changes | No |
| **Recovery record** | One or more canonical agent resume commands plus the CWD needed to run each in a fresh shell, creation time, and owning Workspace identity | One cold-start attempt, at most seven days | No |

Terminal scrollback commonly contains source, pasted secrets, access tokens,
commands, and program output. The 100,000 character persisted cap bounds size,
not disclosure. No normal save path writes scrollback to disk, including the 500
ms structural debounce, 30 s heartbeat, PTY exit, `pagehide`, webview unmount,
or standalone quit flush. `resumeCommand` is likewise absent from durable
structure: it is derived from scrollback and is itself a sensitive pointer into
an agent's stored conversation.

The existing 1M-character host buffers remain in memory. They continue to serve
live resume, repeat webview reconstruction, Pocket/mobile snapshots, and remote
clients while the Host and PTY exist. Removing disk persistence must not reduce
those live capabilities or their current memory caps.

Durable structure is deliberately narrow. It may carry container identity,
Surface ids and kinds, layout topology, Door placement, and untouched state. It
does not carry scrollback, resume commands, command lines, CWDs, user-derived
titles, notification text, or browser URLs. If a consumer cannot reconstruct a
feature without one of those fields, that feature remains runtime-only until it
has a separately justified storage design; it does not widen the structural
format by convenience.

### Recovery record

A recovery record is not a saved terminal. It is the minimum needed to offer a
fresh shell that can resume an interrupted agent:

```typescript
interface PersistedRecoveryRecord {
  version: 1;
  createdAt: number;
  workspaceId: string;
  offers: Array<{
    cwd: string;
    resumeCommand: string;
  }>;
}
```

The exact type name may change during implementation; the data boundary may not.
It contains no scrollback, terminal title, notification, browser state, or layout
snapshot. CWD and the allowlisted command are retained because they are required
to resume the intended agent context; both are still private and receive the
short lifetime below.

Only a host-controlled shutdown that gives Dormouse no confirmation opportunity
may create this record. The host remembers which terminal Sessions had a known
running foreground command before shutdown, sends the graceful signal, inspects
their final in-memory scrollback for a canonical resume command, and immediately
discards the transcript after detection. Output from an idle or unknown Session
never becomes a recovery record. If no previously-running Session yields a valid
command, nothing is written and next launch starts fresh.

Terminal output is untrusted. Detection and canonical revalidation keep shell
punctuation out of the stored command, but do not prove which program printed
the text. Recovery therefore never executes automatically: the user first accepts
the Workspace-level recovery prompt, then the existing per-pane Run action is the
sole execution authority. Because no transcript is replayed, recovery UI cannot
rely on "the id is in the scrollback above": the prompt identifies each offer by
invocation and CWD, and the pane action makes the full command inspectable without
executing it. A hover-only tooltip is insufficient for Pocket/touch clients.

### Lifecycle policy

| Boundary | Process outcome | Durable outcome | Next presentation |
| --- | --- | --- | --- |
| Webview hide/show or reconstruction while host PTYs remain | PTYs stay Live | Structural state only | Resume live PTYs; no prompt |
| Pocket/mobile attach | Host PTYs stay Live | No new disk write | Serve the bounded in-memory snapshot |
| Explicit Pane kill or Workspace/editor-tab close | Target Surfaces are killed | Remove their structural rows and any pending recovery offer | No recovery prompt for the disposed target |
| Standalone clean quit, all-idle or confirmed | All PTYs are terminated | Clear structural state and any legacy transcript-bearing snapshot; write no recovery record | Next launch starts fresh |
| Standalone crash/force-kill | PTYs and in-memory history are lost | No transcript checkpoint exists | Next launch starts fresh |
| VS Code extension-host shutdown, reload, or application restart | PTYs are terminated without Dormouse confirmation | Persist only valid recovery records derived from previously-running Sessions | Ask once on next cold activation when at least one offer exists |
| Fresh install/new panel/no valid recovery record | No PTYs | Structural state at most | Start fresh without prompting |

The loss of transcript recovery after a crash is intentional. Avoiding continuous
secret-bearing writes takes precedence over reconstructing output after a process
dies without a shutdown boundary.

### Cold-start decision and retention

`resumeOrRestore` keeps live resume as its first priority. With no live PTY, it
does not interpret durable structure as a saved terminal and never replays
scrollback from it. A valid, unexpired recovery record produces one
Workspace-level choice before any fresh shells are spawned:

- **Resume agents** consumes the record into memory, creates one fresh terminal
  per offer in its recorded CWD, and seeds the validated per-pane Run actions.
  It does not reconstruct old output or run a command automatically.
- **Start fresh** consumes and drops the record, then creates the default terminal.

Consumption is a destructive read: the host removes the durable record before
handing its contents to the webview. If removal fails, it starts fresh rather
than copying a sensitive record into another layer while leaving the durable copy
behind. A record is offered only on the next cold activation of its Workspace and
expires after seven days, whichever happens first. Canceling or closing the host
without choosing does not rewrite it; because it was already consumed from disk,
that recovery opportunity is intentionally one-shot.

Legacy `PersistedSession` blobs may already contain scrollback. The rollout treats
each as a one-time legacy recovery input: read it into memory, clear the durable
blob before rendering, and offer Restore/Start fresh once. After that migration,
no durable writer accepts a transcript-bearing Session shape.

### Host shutdown ordering

Standalone keeps its current confirmation and graceful PTY teardown, but removes
both transcript-bearing quit saves. A confirmed quit and an all-idle quit
converge on the same tail: terminate processes, durably clear Session storage and
its write-through cache, install any pending update, and exit. Cancel leaves
processes untouched. The browser-dev harness remains non-durable and outside this
native quit guarantee.

VS Code cannot add a Dormouse-specific confirmation to window shutdown, reload,
extension restart, or extension-host failure. Ordinary panel visibility changes
remain live resumes, and explicitly closing a `WebviewPanel` remains disposal.
At `deactivate()`, it snapshots the ids known to be running, sends SIGTERM, waits
for final output while the in-memory host buffers still exist, derives minimal
recovery records for those ids, persists them through the owning view/panel, and
only then calls `killAll()`. Each wait is bounded; a timeout loses recovery rather
than falling back to an earlier transcript-bearing checkpoint.
