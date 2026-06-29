# Glossary

This glossary is the canonical vocabulary for states, entities, and transitions in Dormouse. Every other spec defers to this one when naming a state or a verb. When writing code or prose, pick names from here first.

## The core idea

A **Session** is the durable unit. A Session's state lives on six orthogonal axes — change one without touching the others. A caller holding a `SessionId` can reason about each axis independently.

The **Liskov contract**: a Session is substitutable across most operations regardless of which states it currently occupies. `kill` and `rename` work universally. State-gated operations (`write`, `focus`) document their preconditions in glossary terms rather than failing silently.

## Containers

A Session never floats free: it belongs to exactly one **Workspace**, and every Workspace belongs to one **Window**. These are containers, not Session layers — they group Sessions rather than describing a single Session's state, so they sit beside the six axes above, not on them.

| Container | Holds | Owner |
|---|---|---|
| **Window** | One or more Workspaces. The OS frame (the standalone Tauri window) or the host frame (a VS Code window). | host (Tauri / VS Code) |
| **Workspace** | A named set of Sessions plus its View layout (dockview snapshot + doors). Exactly one **Wall** renders one Workspace. | `lib/src/components/Wall.tsx` at render time; persisted per `docs/specs/transport.md` |

A **Workspace** is the durable grouping a user thinks of as "a window's worth of panes." It has a `WorkspaceId`, a user-facing `name`, the Sessions it contains, and the layout that arranges them. The pre-workspace model had exactly one implicit Workspace per Window; the model now allows several.

How many are visible at once is host-specific:

- **Standalone** hosts many Workspaces in one Window but mounts only one at a time — the **active** Workspace. Switching mounts the target Workspace's Sessions and unmounts the previous one's; Process stays `Live` and Activity keeps flowing. Workspaces appear as a tab strip (see `docs/specs/layout.md`).
- **VS Code** maps one Workspace to one webview: the sidebar/panel `WebviewView` is the default Workspace, and each `dormouse.open` editor-tab `WebviewPanel` is an independent Workspace. Several are visible at once. PTY ownership already partitions Sessions per webview (`docs/specs/transport.md`); see `docs/specs/vscode.md`.

### Workspace union status

A Workspace projects a **union status** over its member Sessions' Activity (transition rules in `docs/specs/alert.md`):

- `ringing` — any member Session has `status === 'ALERT_RINGING'`.
- `todo` — any member Session has `todo === true`.
- `count` — number of member Sessions currently owing attention (ringing or `todo`), for hosts that show a numeric badge.

The union is **display-only**: it is derived from member Activity, never enters the Activity state machine, and never itself fires a ring. Minimized (`Doored`) and unmounted (inactive-Workspace) Sessions are included, because their Registry and Activity entries survive minimize/unmount (I2, I3).

## Layers

| Layer | Tracks | Owner |
|---|---|---|
| **Process** | PTY life on the host | `vscode-ext/src/pty-manager.ts` |
| **Registry** | xterm.js Terminal + persistent DOM element + cached Activity state | `lib/src/lib/terminal-registry.ts` facade, backed by `terminal-store.ts`, `terminal-lifecycle.ts`, and `session-activity-store.ts` |
| **View** | Where and how the session renders | `lib/src/components/Wall.tsx` plus `lib/src/components/wall/` |
| **Link** | Webview ↔ host relationship | `lib/src/lib/reconnect.ts` |
| **Activity** | Alert / attention state machine | `lib/src/lib/alert-manager.ts` |
| **Snapshot** | Persisted-to-disk projection | `lib/src/lib/session-save.ts` / `session-restore.ts` |

A **Session** is the tuple of its `SessionId` plus one state per layer. `SessionId` is immutable for the life of the Session and stable across restarts.

## States per layer

### Process

| State | Meaning |
|---|---|
| `Live` | PTY process running, receiving and emitting data |
| `Exited` | Process ended; exit buffer retained so the user can inspect the output |
| `Tombstoned` | User-killed; host refuses to resurrect even if a late `exit` event arrives |
| `Absent` | No host record at all |

### Registry

| State | Meaning |
|---|---|
| `Unregistered` | No entry in `terminal-registry` |
| `Mounted` | Entry present, persistent DOM element is in the document tree |
| `Orphaned` | Entry present, element detached from DOM — transient state during reparent or minimize |
| `Disposed` | Entry removed, xterm disposed |

### View

| State | Meaning |
|---|---|
| `Paned` | Rendered as a pane in the content area (dockview group) |
| `Zoomed` | Subset of `Paned` — the selected pane is maximized |
| `Doored` | Rendered as a door on the baseboard |
| `Hidden` | In neither pane nor door — the webview is closed, the Session belongs to an inactive Workspace (standalone), or the Session is mid-transition. Process and Activity are unaffected. |

### Link

| State | Meaning |
|---|---|
| `Cold` | First load of the webview; no handshake yet |
| `Live` | Handshake complete; events flowing from host to webview |
| `Resuming` | Webview just reopened; replay drain in progress |
| `Severed` | Webview closed while host retains the processes |

### Activity

Keep the existing state machine (see `docs/specs/alert.md` for transition rules):

`WATCHING_DISABLED` · `NOTHING_TO_SHOW` · `MIGHT_BE_BUSY` · `BUSY` · `OSC_NOTIF_BUSY` · `COMMAND_EXIT_ARMED` · `MIGHT_NEED_ATTENTION` · `ALERT_RINGING`

### Snapshot

| State | Meaning |
|---|---|
| `Clean` | In-memory state matches disk |
| `Dirty` | Changes pending |
| `Flushing` | Debounced write in flight |

## Transitions

### User verbs

A user verb is an intentional action that produces a single observable change.

| Verb | Effect |
|---|---|
| `spawn` | Create a new Session (Process: Absent → Live) |
| `kill` | Request termination (Process: Live → Tombstoned, Registry: Mounted → Disposed, View: any → Hidden) |
| `minimize` | Pane → Door (View: Paned → Doored) |
| `reattach` | Door → Pane (View: Doored → Paned) |
| `rename` | Update title; layer-agnostic |
| `zoom` / `unzoom` | Paned ↔ Zoomed |
| `swap` | Exchange Registry entries across two View slots without touching Processes |
| `switchWorkspace` | Activate a different Workspace: mount its Sessions, unmount the previously active Workspace's (standalone). View: target's Sessions Hidden → Paned/Doored, previous active's Paned/Doored → Hidden. Process and Activity unchanged. |
| `createWorkspace` | Add a new Workspace to the Window; standalone makes it active and spawns its first pane |
| `closeWorkspace` | Remove a Workspace, `kill`-ing each member Session |
| `renameWorkspace` | Update a Workspace's `name`; touches no Session |

### System verbs

A system verb is a lifecycle transition driven by the runtime.

| Verb | Effect |
|---|---|
| `register` / `dispose` | Create / destroy a Registry entry |
| `mount` / `unmount` | Attach / detach the persistent DOM element from a container (low-level op; the Registry entry survives `unmount`) |
| `exit` | Host observes process death (Process: Live → Exited) |
| `resume` | Webview reopens over live PTYs (Link: Severed → Resuming → Live; Registry rebuilt from replay data; Process stays Live) |
| `restore` | Cold start from Snapshot (Link: Cold → Live; Process: Absent → Live with saved cwd; Registry rebuilt from saved scrollback) |
| `tombstone` | Host marks a Session non-recoverable |

## Liskov contract

Every Registry API declares its layer preconditions. Calls against a gated state fail with a typed error rather than silently no-op.

| Category | Valid when | Examples |
|---|---|---|
| **Universal** | any state combination | `kill`, `rename`, state queries |
| **View-gated** | `View ≠ Hidden` | `focus` |
| **Process-gated** | `Process = Live` | `write`, `resize` |
| **Registry-gated** | `Registry = Mounted` | `refit` |

A caller holding a `SessionId` can issue universal operations without branching. Gated operations are explicit: the caller checks the relevant layer first or catches the typed error.

## Invariants

- I1: `SessionId` is immutable for the life of a Session and stable across `resume` / `restore`.
- I2: Process state is independent of Registry, View, and Link. A `Live` process may be `Doored` or `Hidden`; an `Exited` process may still be `Paned`.
- I3: Activity state survives `minimize` / `reattach`. `ALERT_RINGING` fires only on a *fresh* transition, never on `mount` or `reattach`.
- I4: `Registry: Orphaned` is transient. Steady states are `Mounted` or `Disposed`.
- I5: `kill` is universally valid. It always terminates at (Process: Tombstoned, Registry: Disposed, View: Hidden).
- I6: `rename` is universally valid including when `Process = Exited` and `View = Doored`.
- I7: Every Session belongs to exactly one Workspace; every Workspace belongs to one Window.
- I8: `switchWorkspace` preserves Process and Activity for both Workspaces. Mounting an inactive Workspace's Sessions must not fire a fresh ring, the same rule as `mount` / `reattach` in I3.
- I9: A Workspace's union status is a pure projection of its members' Activity. It has no independent state and is destroyed with the Workspace.

## Retired / overloaded terms

Use glossary names instead of these. The left column retains a meaning only where noted.

| Term | Status |
|---|---|
| **detach** | Retired. Previous meanings: DOM-level op → **unmount**; user-level Pane→Door → **minimize**. |
| **reconnect** | Retired. Live-PTY case → **resume**; cold start → **restore**. |
| **restore** | Keeps its meaning for cold-start rehydrate. Do not use it for Door→Pane (that is **reattach**) or for alert-manager seeding (that is **seed**). |
| **attach** | Retired at the DOM layer (was `attachTerminal`) → **mount**. User-level "reattach" (Door→Pane) keeps the `re-` prefix. |
| **session** | Keeps its meaning as the durable identity. Do not use it for the Activity projection (that is `ActivityState`, not `SessionUiState`). |
| **terminal** | Keeps its meaning for the `xterm.Terminal` instance. Prose meaning "the whole thing" is **Session**. |
| **panel / pane** | Prefer **pane**. Use "panel" only when quoting dockview's own API (`api.panels`, `addPanel`). |

## Naming conventions

- Layer names and state names are `PascalCase` nouns (`Paned`, `Tombstoned`).
- Verbs are `camelCase` in code and lowercase in prose (`minimize`, not `Minimize`).
- Event kind strings match the verb: `'minimizeChange'`, not `'detachChange'`.
- A persisted type is `Persisted<Shape>` where `<Shape>` is the glossary noun (`PersistedPane`, `PersistedDoor`, `PersistedWorkspace`, `PersistedWindow`).
- A handle type is `<Layer>State` (`ActivityState`, not `SessionUiState`).
- Container names are `PascalCase` nouns (`Workspace`, `Window`); their ids are `WorkspaceId` and `WindowId`. Container verbs keep the container as a suffix (`createWorkspace`, `switchWorkspace`) to stay distinct from the layer-agnostic Session `rename`.
