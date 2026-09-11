# Glossary

> Canonical vocabulary for Dormouse's states, entities, and transitions. Every other spec defers here when naming a state, a surface kind, or a verb; pick names from here first.

## The core idea

A **Surface** is the durable occupant of a Pane — the content in a slot. Two kinds:

- a **terminal Surface**, which Dormouse calls a **Session**: a PTY-backed shell with scrollback and semantic terminal state. The six-axis model below describes this kind.
- a **browser Surface**: a web view (`docs/specs/dor-browser.md`), taking only a subset of the axes ([Panes and Surfaces](#panes-and-surfaces)).

**Unless a passage says "Surface" or "browser Surface," it describes a Session.** A Session's state lives on six distinct axes; an operation can change several together. Their separate preconditions define the **[Liskov contract](#liskov-contract)**.

## Panes and Surfaces

A **Pane** is one Lath leaf, a slot in the tiling layout (`docs/specs/tiling-engine.md`); `lib/src/components/Wall.tsx` owns Panes and Surfaces both.

A Pane holds exactly one Surface today, but the model reserves several (a future in-pane surface strip), so **`dor` targets content — `read` / `send` / `await` / `kill` — by Surface ref (`surface:N`)**, holding Pane refs back for layout-only commands (rationale).

**Surface kinds** — the `kind` a `dor` handle reports, derived from the Pane's params, never stored on the id:

| Kind | Sub-kinds | Backed by |
|---|---|---|
| `terminal` | — | a PTY + xterm.js instance — a **Session** |
| `browser` | `iframe`, `ab-screencast`, `ab-popout` | an iframe proxy grant, or an agent-browser daemon session (`docs/specs/dor-browser.md`) |

**For a browser Surface `renderMode` is canonical**; the CLI `render_mode` is derived from it and never stored.

| Surface | Persisted `surfaceType` (`docs/specs/transport.md`) | `renderMode` (`docs/specs/dor-browser.md`) | CLI `kind` | CLI `render_mode` |
|---|---|---|---|---|
| terminal Session | `'terminal'` (default, omitted) | — | `terminal` | `null` |
| browser · iframe | `'browser'` | `iframe` | `browser` | `iframe` |
| browser · screencast | `'browser'` | `ab-screencast` | `browser` | `ab-screencast` |
| browser · popped out | `'browser'` | `ab-popout` | `browser` | `ab-popout` |

**Kinds are capability sets, not exclusive categories** — the two above carry one capability each, the staged `tool` (`docs/specs/dor-tool.md`) both. **Operations gate on the capability they need, never on the kind enum** ([Liskov contract](#liskov-contract)): `read` / `send` / `await` / port scans need the terminal, nav / render-mode / agent-browser verbs the browser. **`dor list --json` rows always emit `has_terminal` and `has_browser`** (rationale). **Must declare each kind's capabilities in the `hasTerminal` / `hasBrowser` table.** Persistence keeps its own `PersistedSurfaceType` discriminant (`docs/specs/transport.md`).

Source of truth: `hasTerminal` / `hasBrowser` in `dor/src/commands/types.ts`; `surfaceKindFromParams` in `lib/src/components/wall/browser-surface.ts`.

A Session runs all six axes ([Layers](#layers)); a browser Surface participates only where a web view meaningfully can:

| Axis | Browser Surface |
|---|---|
| **View** | full — all four states apply |
| **Activity** | **TODO only** — user-flagged; never reaches `ALERT_RINGING` (no BEL/OSC source) |
| **Snapshot** | `surfaceType` + render params, plus the alert blob's `todo` |
| **Process** | none — lifetime is the agent-browser session or proxy grant, keyed outside the Pane id |
| **Registry** | none — DOM is LathHost's leaf div (never re-parented); focus via a lightweight handle |
| **Link** | none — rebuilt from persisted params, not replayed |

The containment hierarchy `dor` handles commit to (`docs/specs/dor-cli.md`):

```
Window ⊃ Workspace ⊃ Pane ⊃ Surface  (terminal = Session | browser)
```

**Surface identity:** a primary Surface's id is its Lath leaf id; a helper receives its Lath leaf only on promotion. A terminal Surface's *is* its `SessionId`, stable (I1); browser replacement and relaunch have different identity effects (I10).

## Containers

**Must keep a helper as an auxiliary terminal Surface in its source's Pane**, with a stable Session id and explicit parent association. It has no independent Lath leaf, public ref, or alerting until promotion; `docs/specs/terminal-context.md` owns its lifetime. A shown helper is `Paned` within the source body; a closed context leaves it `Hidden` and DOM-parked (`Mounted`).

Workspace and Window are containers, not Session layers — they group Surfaces rather than describing one Surface's state (containment is I7).

| Container | Holds | Owner |
|---|---|---|
| **Window** | One or more Workspaces; the OS frame (a standalone Tauri window) or the host frame (a VS Code window). A host may hold several, and a Workspace may move between them. Its **Tauri label is its persistence identity** — one snapshot per label (`docs/specs/standalone.md` → Windows). | host (Tauri / VS Code) |
| **Workspace** | "A window's worth of panes": a `WorkspaceId`, a user-facing `name`, its Panes and Surfaces, and the layout arranging them (Lath snapshot + doors). Exactly one **Wall** renders one Workspace. | `lib/src/lib/workspace-store.ts` (the model), `lib/src/components/Wall.tsx` at render time; persisted per `docs/specs/transport.md` |

How many Workspaces a Window shows at once is host-specific:

- **Standalone** mounts every Workspace's Wall at once and shows one, switching between them (`docs/specs/layout.md` → Workspaces); a Window may be one of several.
- **VS Code** maps one Workspace to one webview, several visible at once: the sidebar/panel `WebviewView` is the default Workspace, each `dormouse.open` editor-tab `WebviewPanel` an independent one owning its Sessions' PTYs and browser Surfaces (`docs/specs/vscode.md`).

### Wall chrome

| Term | Meaning |
|---|---|
| **Wall** | The component rendering one Workspace: its Panes plus the Baseboard (`lib/src/components/Wall.tsx`) |
| **Baseboard** | The always-visible strip along the bottom of a Wall, holding Doors, the update notice, and the shortcut hint |
| **Door** | A minimized Surface's tile on the Baseboard — the `Doored` View state |

`docs/specs/layout.md` owns their placement, sizing, and interaction.

### Workspace union status

A Workspace's **union status** is its display projection of member Surfaces' Activity; `docs/specs/alert.md` → Workspace union owns its fields and rules.

### Implementation status

The Pane / Surface model, surface kinds, the Workspace model, per-Workspace persistence, and several Windows each holding several Workspaces are live (`docs/specs/layout.md` → Workspaces). Ledger: `docs/specs/layout.md` `## Future` (**Scope: workspaces-rollout**); this glossary does not track it.

## Roles

Remote control has exactly three roles. `docs/specs/remote-security-model.md` owns the trust between them; these are the names.

| Role | What it is | What it decides |
|---|---|---|
| **Burrow** | The app that owns terminal Surfaces and the processes behind them: the Standalone app, or the VS Code extension. **Two on one machine are two Burrows**, enrolled and paired separately, and Pocket lists them as two rows. | Every remote-access grant. Pairing approval and the ACL live here and nowhere else. |
| **Client** | What controls a Burrow from somewhere else. **Pocket** is the phone Client (`docs/specs/pocket-app.md`); Canopy is a future one (`## Future`). | Nothing on its own — a Client asks. |
| **Relay** | The coordinating server: accounts, presence, push fan-out, and an encrypted byte pipe between Client and Burrow (`docs/specs/relay.md`). **Dormouse Hosted** is the managed Relay; `SELF_HOST.md` runs your own. | Routing. It holds no terminal and no authorization. |

**A Burrow *is* a platform host** — the process behind the webview that owns the PTYs — seen from the side a Client pairs with. *Host* stays the implementation word for that side (`lib/src/host/`, webview↔host messages, `pty-host`, VS Code's extension host) and keeps its `Host`-header, hostname, and self-host senses; **never use *Host* for the remote-control role, or *Server* for the Relay.**

## Modes

A Wall is always in exactly one input mode; `docs/specs/layout.md` owns the switching gestures and per-mode behavior. Canonical names:

| Mode | Meaning |
|---|---|
| **passthrough** | Keyboard input routes to the selected Surface; `docs/specs/layout.md` → Modes owns interception. |
| **command** | Keyboard input drives navigation and layout commands; the Session receives nothing. |

**Never introduce aliases** — "terminal mode", "normal mode", and "navigation mode" all mean one of the two names above.

## Layers

| Layer | Tracks | Owner |
|---|---|---|
| **Process** | PTY life on the host | `vscode-ext/src/pty-manager.ts` (VS Code) / `standalone/sidecar/pty-core.js` (standalone) |
| **Registry** | xterm.js Terminal + persistent DOM element | `lib/src/lib/terminal-registry.ts` facade over `terminal-store.ts`, `terminal-lifecycle.ts` |
| **View** | Where and how a Surface renders | `lib/src/components/Wall.tsx` plus `lib/src/components/wall/` |
| **Link** | Webview ↔ host relationship | `lib/src/lib/reconnect.ts` |
| **Activity** | Alert / attention state machine + renderer cache | `lib/src/lib/alert-manager.ts`, `lib/src/lib/session-activity-store.ts` |
| **Snapshot** | Persisted-to-disk projection: cwd, title, `untouched`, alert — never scrollback (`docs/specs/transport.md`) | `lib/src/lib/session-save.ts` / `session-restore.ts` |

A **Session** is the tuple of its `SessionId` plus one state per layer (I1).

## States per layer

### Process

| State | Meaning |
|---|---|
| `Live` | Running, receiving and emitting data |
| `Exited` | Process ended; exit buffer retained for inspection |
| `Tombstoned` | User-killed; the host refuses to recreate a buffer even for a late `data` / `exit` (`killedPtyIds` in `vscode-ext/src/pty-manager.ts`). The standalone sidecar drops the record on kill, so `Tombstoned` and `Absent` are indistinguishable there |
| `Absent` | No host record at all |

### Registry

| State | Meaning |
|---|---|
| `Unregistered` | No entry in `terminal-registry` |
| `Mounted` | Entry present, DOM element in the document tree |
| `Orphaned` | Entry present, element detached. Not transient — a `Doored` terminal Surface sits here as long as it stays minimized, and so does a `Paned` one in a hidden Workspace (I4) |
| `Disposed` | Entry removed, xterm disposed |

### View

| State | Meaning |
|---|---|
| `Paned` | Rendered in the content area: a primary Lath leaf or its shown auxiliary helper |
| `Zoomed` | Subset of `Paned` — the passthrough-focused pane is maximized; acquiring zoom gives focus, losing focus returns it to `Paned` |
| `Doored` | Rendered as a door on the baseboard. DOM survival is a rendering decision, not part of this state: browser DOM retention follows **parking** (`docs/specs/tiling-engine.md` → "Parked leaves"); a terminal Surface unmounts its element (Registry: `Orphaned`) and remounts the same xterm on reattach — nothing replays |
| `Hidden` | In neither pane nor door — webview closed or mid-transition. A Surface in a hidden Workspace is **not** `Hidden`: it stays `Paned` or `Doored`, mounted and live. Process and Activity unaffected. |

### Link

| State | Meaning |
|---|---|
| `Cold` | First load of the webview; no handshake yet |
| `Live` | Handshake complete; events flowing from host to webview |
| `Resuming` | Webview just reopened; replay drain in progress |
| `Severed` | Webview closed while host retains the processes |

### Activity

Transition rules in `docs/specs/alert.md`; the union is `SessionStatus` in `lib/src/lib/alert-manager.ts` (its quiesce half in `quiesce-detector.ts`):

`WATCHING_DISABLED` · `NOTHING_TO_SHOW` · `MIGHT_BE_BUSY` · `BUSY` · `OSC_NOTIF_BUSY` · `COMMAND_EXIT_ARMED` · `MIGHT_NEED_ATTENTION` · `ALERT_RINGING`

**Only terminal Sessions run this machine** ([Panes and Surfaces](#panes-and-surfaces)).

### Snapshot

| State | Meaning |
|---|---|
| `Clean` | In-memory state matches disk |
| `Dirty` | Changes pending |
| `Flushing` | Persistence write in flight |

A monotonic generation counter, not a literal enum: `Dirty` means `gen > savedGen`, and **a `markDirty` racing a `Flushing` write leaves the tracker dirty** rather than losing the change. Source of truth: `lib/src/lib/session-dirty.ts`, driven by `lib/src/components/wall/use-session-persistence.ts`.

## Transitions

### User verbs

A user verb is an intentional action that produces a single observable change.

| Verb | Effect |
|---|---|
| `spawn` | Create a new Session (Process: Absent → Live) |
| `kill` | Terminate a Surface. Terminal: Process Live/Exited → Tombstoned (Absent on standalone), Registry Mounted/Orphaned → Disposed. Browser: resource cleanup follows `docs/specs/dor-browser.md` → Placement And Lifetime. Either way View: any → Hidden. |
| `minimize` | Pane → Door (View: Paned → Doored) |
| `reattach` | Door → Pane (View: Doored → Paned) |
| `rename` | Update title; layer-agnostic |
| `zoom` / `unzoom` | Paned ↔ Zoomed |
| `swap` | Exchange two Surfaces' layout slots; ids travel with them, so Registry entries, Processes, and titles are untouched |
| `switchWorkspace` | Set the active Workspace (`setActiveWorkspace`), revealing its Wall and hiding the outgoing one. Terminal elements reattach; nothing resumes or restores; I8 holds by construction. |
| `createWorkspace` | Add a Workspace and mount its Wall, which spawns one pane; activate by default, unless `activate: false`. |
| `closeWorkspace` | `kill` each member Surface, then remove the Workspace; the last remaining Workspace cannot be closed. |
| `renameWorkspace` | Update a Workspace's `name`; touches no Session |
| `moveWorkspace` | Reorder a Workspace within its Window; renumbers the positional `workspace:<n>` refs and touches no Session |
| `transferWorkspace` | Move a Workspace to another Window, Surfaces and Sessions intact: `release` each member Session (detached, Process still Live) and resume it there. Kills nothing and archives nothing — not a `closeWorkspace`. |
| `tearOut` | `transferWorkspace` into a Window created for it. A Window whose last Workspace leaves closes itself. |

Source of truth: `setActiveWorkspace` / `createWorkspace` / `closeWorkspace` / `renameWorkspace` / `moveWorkspace` in `lib/src/lib/workspace-store.ts`; `closeAll` in `lib/src/components/Wall.tsx`; `prepareWorkspaceTransfer` in `lib/src/components/wall/workspace-transfer.ts`.

### System verbs

A system verb is a lifecycle transition driven by the runtime.

| Verb | Effect |
|---|---|
| `register` / `dispose` | Create / destroy a Registry entry |
| `release` | Destroy a Registry entry **without** killing its Process (Registry: Mounted → Disposed, Process: Live → Live). The one verb a `transferWorkspace` runs, and never reachable from an unmount. |
| `mount` / `unmount` | Attach / detach the persistent DOM element (low-level op; the Registry entry survives `unmount`). A **parked** leaf stays mounted while `Doored` or `Hidden` (`docs/specs/tiling-engine.md` → "Parked leaves") |
| `exit` | Host observes process death (Process: Live → Exited) |
| `resume` | Webview reopens over retained PTYs (Link: Severed → Resuming → Live; Registry rebuilt from replay data; Process stays Live/Exited) |
| `restore` | Cold start from Snapshot (Link: Cold → Live; Process: Absent → Live with saved cwd; Registry rebuilt empty — scrollback is never persisted, so nothing replays; `docs/specs/transport.md`) |
| `tombstone` | Host marks a Session non-recoverable |

## Liskov contract

**A Session is substitutable across most operations regardless of which states it occupies** — every Session-facing API, Registry ops and `PlatformAdapter` PTY ops alike, declares its layer preconditions here:

| Category | Valid when | Examples |
|---|---|---|
| **Universal** | any state combination | `kill`, `rename`, state queries |
| **View-gated** | `View ≠ Hidden` | `focusSession` |
| **Process-gated** | `Process = Live` | `writePty`, `resizePty` |
| **Registry-gated** | `Registry = Mounted` | `refitSession` |
| **Terminal-gated** | Surface has a terminal ([Panes and Surfaces](#panes-and-surfaces)) | `dor read` / `send` / `await`, port scans |
| **Browser-gated** | Surface has a browser | browser nav / render-mode ops |

**Must check the relevant precondition for gated operations; universal operations accept every layer state.** Missing Registry entries silently no-op, while `dor` capability gates return an error. Uniform typed precondition errors are staged ([Future](#future)).

Source of truth: `focusSession` / `refitSession` in `lib/src/lib/terminal-lifecycle.ts`; `requireTerminalSurface` / `requireBrowserSurface` in `lib/src/components/wall/use-dor-control.ts`.

## Invariants

- I1: `SessionId` is immutable for the life of a Session and stable across `resume` / `restore`.
- I2: Process state is independent of Registry, View, and Link. A `Live` process may be `Doored` or `Hidden`; an `Exited` process may still be `Paned`.
- I3: Activity state survives `minimize` / `reattach`. `ALERT_RINGING` fires only on a *fresh* transition, never on `mount` or `reattach`.
- I4: `Registry: Orphaned` outlives no Session state except `View: Doored` or a Surface in a hidden Workspace — at rest every other entry is `Mounted` or `Disposed`, so an `Orphaned` entry that is neither is a leak.
- I5: `kill` is universally valid and always ends at `View: Hidden`; its per-kind effects are the [User verbs](#user-verbs) row.
- I6: `rename` is universally valid including when `Process = Exited` and `View = Doored`.
- I7: Every Surface sits in exactly one Pane; every Pane and its Surfaces belong to exactly one Workspace; every Workspace belongs to one Window.
- I8: **Must preserve Process and Activity during `switchWorkspace`, without firing a fresh ring** (I3). A switch reattaches terminal elements but resumes and restores nothing, so no ring can fire (`docs/specs/layout.md` → Workspaces).
- I9: A Workspace's union status is a pure projection of its members' Activity: no independent state, destroyed with the Workspace.
- I10: **Must preserve a terminal Surface's `SessionId`** (I1). **Must transfer the `surface:N` CLI ref when replacing a browser Surface**, minting a new id in the same layout slot with its target URL. An `ab-screencast` ⇄ `ab-popout` relaunch keeps the Surface id; render-mode changes do not universally imply replacement (rationale; `docs/specs/dor-browser.md` → Display Modal And Render Swaps).

## Retired / overloaded terms

Use glossary names instead. A left-column term retains meaning only where noted.

| Term | Status |
|---|---|
| **detach** | Retired: DOM-level op → **unmount**; user-level Pane→Door → **minimize**. |
| **reconnect** | Retired: live-PTY case → **resume**; cold start → **restore**. |
| **restore** | Keeps its cold-start rehydrate meaning. Never for Door→Pane (**reattach**) or alert-manager seeding (**seed**). |
| **attach** | Retired at the DOM layer (`attachTerminal`) → **mount**; user-level **reattach** (Door→Pane) keeps the `re-` prefix. |
| **session** | The durable identity of a **terminal Surface**. Never for the Activity projection (`ActivityState`, not `SessionUiState`), nor for the agent-browser daemon's lowercase `session` string (`dormouse.1.<key>`) — not a Dormouse durable unit. |
| **terminal** | Keeps its meaning for the `xterm.Terminal` instance; prose meaning "the whole thing" is **Session**. |
| **surface** | Not retired. **Session** names only the terminal kind; **Surface** covers both. |
| **panel / pane / leaf** | Prefer **pane** for the layout slot; **leaf** is Lath's tree node for it (1:1). "panel" survives only in React component names (`TerminalPanel`, `BrowserPanel`, `IframePanel`, `AgentBrowserPanel`). |
| **face** | Retired — capabilities are named by the kinds: "console face" → **terminal**, "web face" → **browser**. Gate with `hasTerminal` / `hasBrowser`, never a face-set. |
| **Host** | Retired as the remote-control role → **Burrow** ([Roles](#roles)). Keeps the platform sense — the process behind the webview — plus the `Host` header, hostnames, and "self-host". |
| **Server** | Retired for the coordinating server → **Relay**. Keeps HTTP servers, `net.Server`, dev servers, and "self-host". |
| **tether** | Remote-control only (`docs/specs/remote-api.md`): a display showing "tethering to \<device\>" has ceded terminal size authority to a remote viewer — the semantics hold today, the display is staged. Never a layout term, never for Pane/Door relationships. |

Remote-only vocabulary (**Viewer**, and the wire-level `DirectoryEntry` projection of a pane) is defined in `docs/specs/remote-api.md`.

## Naming conventions

- Layer names and state names are `PascalCase` nouns (`Paned`, `Tombstoned`).
- Verbs are `camelCase` in code and lowercase in prose (`minimize`, not `Minimize`).
- Event kind strings match the verb: `'minimizeChange'`, not `'detachChange'`.
- A persisted type is `Persisted<Shape>` where `<Shape>` is the glossary noun (`PersistedPane`, `PersistedDoor`, `PersistedWorkspace`, `PersistedWindow`).
- A handle type is `<Layer>State` (`ActivityState`, not `SessionUiState`).
- Surface kinds are lowercase strings; [Panes and Surfaces](#panes-and-surfaces) is canonical for how persisted `surfaceType`, `renderMode`, and CLI `kind` / `render_mode` relate.
- Container names are `PascalCase` nouns (`Workspace`, `Window`); a Workspace's id type is `WorkspaceId`. A Window carries no id today — `dor` addresses it only through the reserved `window:<n>` ref (`docs/specs/dor-cli.md`), with `WindowId` reserved for when it needs one. Container verbs suffix the container (`createWorkspace`, `switchWorkspace`), distinct from the layer-agnostic Session `rename`.

## Future

- **Typed precondition errors.** The Liskov contract's enforcement: a gated call against the wrong state (e.g. `writePty` on a non-`Live` Process) fails with a typed error naming the violated precondition, replacing today's silent early return.
- **Canopy — a VR Client.** The 3D/WebXR rendering lab (`docs/specs/webgl-text.md`) becomes a second [Client](#roles) beside Pocket, controlling a Burrow over the same protocol. Nothing of the Client half is built; canopy is Storybook-only.
- **Dormouse Burrow — a headless Burrow.** A Burrow with no local UI, so a machine nobody sits at can still be paired with. It changes no role: the same enrollment, ACL, and pairing approval, with the approval surfaced somewhere other than a Wall.
