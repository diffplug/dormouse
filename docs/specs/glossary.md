# Glossary

This glossary is the canonical vocabulary for states, entities, and transitions in Dormouse. Every other spec defers to this one when naming a state or a verb. When writing code or prose, pick names from here first.

## The core idea

A **Surface** is the durable occupant of a Pane — what a user thinks of as "the content in this slot." A Surface is one of two kinds:

- a **terminal Surface**, which Dormouse calls a **Session**: a PTY-backed shell with scrollback and semantic terminal state. This is the unit the six-axis model below describes.
- a **browser Surface**: a web view rendered as an `iframe` or an agent-browser screencast / pop-out (`docs/specs/dor-browser.md`). It participates in only a subset of the axes — see [Panes and Surfaces](#panes-and-surfaces).

A **Session**'s state lives on six orthogonal axes — change one without touching the others. A caller holding a `SessionId` can reason about each axis independently. Unless a passage says "Surface" or "browser Surface," it is describing a Session.

The **Liskov contract**: a Session is substitutable across most operations regardless of which states it currently occupies. `kill` and `rename` work universally. State-gated operations (`write`, `focus`) have their preconditions documented in glossary terms (see [Liskov contract](#liskov-contract)).

## Panes and Surfaces

The unit of *layout* is a **Pane**; the unit of *content* is a **Surface**.

| Term | Is | Owner |
|---|---|---|
| **Pane** | A slot in the tiling layout (one Lath leaf). Holds one Surface. | `lib/src/components/Wall.tsx`; the engine per `docs/specs/tiling-engine.md` |
| **Surface** | The content in a Pane: a **terminal** (a Session) or a **browser** Surface. | `Wall.tsx`; browser surfaces per `docs/specs/dor-browser.md` |

Today every Pane holds exactly one Surface, but the model reserves multiple Surfaces per Pane (a future in-pane surface strip). The `dor` CLI therefore exposes Surface refs (`surface:N`) as content handles and keeps Pane refs reserved for future layout-only commands rather than using them for `read` / `send` / `kill` targeting.

**Surface kinds** — the `type` a `dor` handle reports, derived from the Pane's params, never stored on the id:

| Kind | Sub-kinds | Backed by |
|---|---|---|
| `terminal` | — | a PTY + xterm.js instance — i.e. a **Session** |
| `browser` | `iframe`, `ab-screencast`, `ab-popout` | an iframe proxy grant, or an agent-browser daemon session (`docs/specs/dor-browser.md`) |

The persisted surface kind, browser render mode, and `dor` row fields map as
follows:

| Surface | Persisted `surfaceType` (`docs/specs/transport.md`) | `renderMode` (`docs/specs/dor-browser.md`) | CLI `kind` | CLI `render_mode` |
|---|---|---|---|---|
| terminal Session | `'terminal'` (the default, omitted from the row) | — | `terminal` | `null` |
| browser, iframe renderer | `'browser'` | `iframe` | `browser` | `iframe` |
| browser, screencast renderer | `'browser'` | `ab-screencast` | `browser` | `ab-screencast` |
| browser, popped-out renderer | `'browser'` | `ab-popout` | `browser` | `ab-popout` |

For browser Surfaces `renderMode` is canonical; the CLI `render_mode` field is
derived from it for `dor` output and is never stored.

A **Session** runs the full six-axis model below. A **browser Surface** participates only where a web view meaningfully can:

| Axis | Terminal Surface (Session) | Browser Surface |
|---|---|---|
| **View** | full | full — `Paned` / `Zoomed` / `Doored` / `Hidden` all apply |
| **Activity** | full machine (ring + TODO) | **TODO only** — a user may flag it; it never auto-rings (no BEL/OSC source) |
| **Snapshot** | scrollback, cwd, alert | its `surfaceType` + render params (`docs/specs/transport.md`) |
| **Process** | PTY (`Live`/`Exited`/`Tombstoned`/`Absent`) | none — host lifetime is the agent-browser session or proxy grant, keyed outside the Pane id |
| **Registry** | xterm Terminal + persistent DOM element | none — DOM hosted by LathHost's leaf div (never re-parented); focus via a lightweight handle |
| **Link** | resume / replay over the live PTY | none — rebuilt from persisted params, not replayed |

The containment hierarchy the `dor` CLI handle model commits to (`docs/specs/dor-cli.md`):

```
Window ⊃ Workspace ⊃ Pane ⊃ Surface  (terminal = Session | browser)
```

**Surface identity:** a Surface's id is its Lath leaf id. For a terminal Surface that id *is* the `SessionId` and is stable (I1). A browser Surface's id is **not** preserved across a render-mode swap: switching `iframe` ⇄ `ab-screencast` ⇄ `ab-popout` replaces the Surface in the same Pane slot (new id), preserving only the slot and target URL (`docs/specs/dor-browser.md`).

## Containers

A Surface never floats free: it sits in a **Pane**, every Pane belongs to exactly one **Workspace**, and every Workspace belongs to one **Window**. Workspace and Window are containers, not Session layers — they group Surfaces rather than describing one Surface's state, so they sit beside the six axes above, not on them.

| Container | Holds | Owner |
|---|---|---|
| **Window** | One or more Workspaces. The OS frame (the standalone Tauri window) or the host frame (a VS Code window). | host (Tauri / VS Code) |
| **Workspace** | A named set of Panes and their Surfaces, plus the layout that arranges them (Lath layout snapshot + doors). Exactly one **Wall** renders one Workspace. | `lib/src/components/Wall.tsx` at render time; persisted per `docs/specs/transport.md` |

A **Workspace** is the durable grouping a user thinks of as "a window's worth of panes." It has a `WorkspaceId`, a user-facing `name`, the Surfaces it contains, and the layout that arranges them. The model allows several Workspaces per Window, though the app mounts one at a time today.

How many are visible at once is host-specific:

- **Standalone** hosts many Workspaces in one Window but mounts only one at a time — the **active** Workspace. Switching mounts the target Workspace's Surfaces and unmounts the previous one's; PTYs stay `Live` and Activity keeps flowing. Workspaces appear as a tab strip (see `docs/specs/layout.md`).
- **VS Code** maps one Workspace to one webview: the sidebar/panel `WebviewView` is the default Workspace, and each `dormouse.open` editor-tab `WebviewPanel` is an independent Workspace. Several are visible at once. A webview owns its terminal Sessions' PTYs (`ownedPtyIds`, `docs/specs/transport.md`) plus its own browser Surfaces; see `docs/specs/vscode.md`.

### Workspace union status

A Workspace projects a **union status** over its member Surfaces' Activity (transition rules in `docs/specs/alert.md`):

- `ringing` — any member Surface has `status === 'ALERT_RINGING'`. Only terminal Sessions ring.
- `todo` — any member Surface has `todo === true`: a terminal Session, or a browser Surface a user has flagged.
- `count` — number of member Surfaces currently owing attention (ringing or `todo`), for hosts that show a numeric badge.

The union is **display-only**: it is derived from member Activity, never enters the Activity state machine, and never itself fires a ring. Minimized (`Doored`) and unmounted (inactive-Workspace) Surfaces are included, because their Activity (Session) or persisted `alert` blob (browser Surface) survive minimize/unmount (I2, I3).

### Implementation status

This vocabulary is the target model, so parts of it are specified ahead of the code. The Pane / Surface model, surface kinds, and their persistence are live. The Workspace / Window containers are implemented but dormant behind the `dormouse.flags.workspaces` flag (off by default — the app runs one implicit Workspace); the standalone workspace strip and real `switchWorkspace` mounting are not built. The rollout ledger — what remains and in what order — lives in `docs/specs/layout.md` `## Future` (**Scope: workspaces-rollout**); this glossary does not track it.

## Modes

A Wall is always in exactly one input mode. `docs/specs/layout.md` owns the switching gestures and per-mode behavior; these are the canonical names:

| Mode | Meaning |
|---|---|
| **passthrough** | Keyboard input routes to the selected Session's terminal. Only copy/paste and the mode-switch gesture are intercepted. |
| **command** | Keyboard input drives navigation and layout commands; the Session receives nothing. |

Do not introduce aliases — "terminal mode", "normal mode", and "navigation mode" all mean one of the two names above.

## Layers

| Layer | Tracks | Owner |
|---|---|---|
| **Process** | PTY life on the host | `vscode-ext/src/pty-manager.ts` |
| **Registry** | xterm.js Terminal + persistent DOM element + cached Activity state | `lib/src/lib/terminal-registry.ts` facade, backed by `terminal-store.ts`, `terminal-lifecycle.ts`, and `session-activity-store.ts` |
| **View** | Where and how a Surface renders (terminal and browser alike) | `lib/src/components/Wall.tsx` plus `lib/src/components/wall/` |
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
| `Paned` | Rendered as a pane in the content area (a Lath leaf) |
| `Zoomed` | Subset of `Paned` — the selected pane is maximized |
| `Doored` | Rendered as a door on the baseboard |
| `Hidden` | In neither pane nor door — the webview is closed, the Surface belongs to an inactive Workspace (standalone), or the Surface is mid-transition. Process and Activity are unaffected. |

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

Terminal Sessions run this machine. A browser Surface has no machine: it carries only an optional user-set `todo` and never reaches `ALERT_RINGING` (there is no BEL/OSC source to ring it).

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
| `kill` | Terminate a Surface. Terminal: Process Live → Tombstoned, Registry Mounted → Disposed. Browser: closes its agent-browser session or iframe proxy grant. Either way View: any → Hidden. |
| `minimize` | Pane → Door (View: Paned → Doored) |
| `reattach` | Door → Pane (View: Doored → Paned) |
| `rename` | Update title; layer-agnostic |
| `zoom` / `unzoom` | Paned ↔ Zoomed |
| `swap` | Exchange Registry entries across two View slots without touching Processes |
| `switchWorkspace` | Activate a different Workspace: mount its Surfaces, unmount the previously active Workspace's (standalone). View: target's Surfaces Hidden → Paned/Doored, previous active's Paned/Doored → Hidden. Process and Activity unchanged. |
| `createWorkspace` | Add a new Workspace to the Window; standalone makes it active and spawns its first pane |
| `closeWorkspace` | Remove a Workspace, `kill`-ing each member Surface |
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

Every Registry API has layer preconditions, declared here:

| Category | Valid when | Examples |
|---|---|---|
| **Universal** | any state combination | `kill`, `rename`, state queries |
| **View-gated** | `View ≠ Hidden` | `focus` |
| **Process-gated** | `Process = Live` | `write`, `resize` |
| **Registry-gated** | `Registry = Mounted` | `refit` |

A caller holding a `SessionId` can issue universal operations without branching. Gated operations are explicit: the caller checks the relevant layer first. Uniform typed-error enforcement of these preconditions is staged — see [Future](#future).

## Invariants

- I1: `SessionId` is immutable for the life of a Session and stable across `resume` / `restore`.
- I2: Process state is independent of Registry, View, and Link. A `Live` process may be `Doored` or `Hidden`; an `Exited` process may still be `Paned`.
- I3: Activity state survives `minimize` / `reattach`. `ALERT_RINGING` fires only on a *fresh* transition, never on `mount` or `reattach`.
- I4: `Registry: Orphaned` is transient. Steady states are `Mounted` or `Disposed`.
- I5: `kill` is universally valid. It always terminates at (Process: Tombstoned, Registry: Disposed, View: Hidden).
- I6: `rename` is universally valid including when `Process = Exited` and `View = Doored`.
- I7: Every Surface sits in exactly one Pane; every Pane and its Surfaces belong to exactly one Workspace; every Workspace belongs to one Window.
- I8: `switchWorkspace` preserves Process and Activity for both Workspaces. Mounting an inactive Workspace's Surfaces must not fire a fresh ring, the same rule as `mount` / `reattach` in I3.
- I9: A Workspace's union status is a pure projection of its member Surfaces' Activity. It has no independent state and is destroyed with the Workspace.
- I10: A terminal Surface's id is its stable `SessionId` (I1). A browser Surface's id is *not* preserved across a render-mode swap: the swap replaces the Surface in the same Pane slot, preserving only the slot and target URL.

## Retired / overloaded terms

Use glossary names instead of these. The left column retains a meaning only where noted.

| Term | Status |
|---|---|
| **detach** | Retired. Previous meanings: DOM-level op → **unmount**; user-level Pane→Door → **minimize**. |
| **reconnect** | Retired. Live-PTY case → **resume**; cold start → **restore**. |
| **restore** | Keeps its meaning for cold-start rehydrate. Do not use it for Door→Pane (that is **reattach**) or for alert-manager seeding (that is **seed**). |
| **attach** | Retired at the DOM layer (was `attachTerminal`) → **mount**. User-level "reattach" (Door→Pane) keeps the `re-` prefix. |
| **session** | The durable identity of a **terminal Surface**. Do not use it for the Activity projection (that is `ActivityState`, not `SessionUiState`), nor for the agent-browser daemon's lowercase `session` string (`dormouse.1.<key>`), which is not a Dormouse durable unit. |
| **terminal** | Keeps its meaning for the `xterm.Terminal` instance. Prose meaning "the whole thing" is **Session** (a terminal Surface). |
| **surface** | A glossary term, not retired: the durable occupant of a Pane (a terminal Session or a browser Surface). Use **Session** only for the terminal kind; use **Surface** when a statement holds for both. |
| **panel / pane / leaf** | Prefer **pane** for the layout slot; **leaf** is Lath's tree node for the same thing (they map 1:1). "panel" survives only in React component names (`TerminalPanel`, `BrowserPanel`, `IframePanel`). |
| **tether** | Remote-control term only: a display showing "tethering to \<device\>" has ceded terminal size authority to a remote viewer (`docs/specs/remote-api.md`). Not a layout term — do not use it for Pane/Door relationships. |

Remote-only vocabulary (**Viewer**, the wire-level `DirectoryEntry` projection) is defined in `docs/specs/remote-api.md` § Terminology.

## Naming conventions

- Layer names and state names are `PascalCase` nouns (`Paned`, `Tombstoned`).
- Verbs are `camelCase` in code and lowercase in prose (`minimize`, not `Minimize`).
- Event kind strings match the verb: `'minimizeChange'`, not `'detachChange'`.
- A persisted type is `Persisted<Shape>` where `<Shape>` is the glossary noun (`PersistedPane`, `PersistedDoor`, `PersistedWorkspace`, `PersistedWindow`).
- A handle type is `<Layer>State` (`ActivityState`, not `SessionUiState`).
- Surface kinds are lowercase strings; the kind-enum mapping table in [Panes and Surfaces](#panes-and-surfaces) is canonical for how the persisted `surfaceType`, `renderMode`, and CLI `kind` / `render_mode` relate.
- Container names are `PascalCase` nouns (`Workspace`, `Window`); their ids are `WorkspaceId` and `WindowId`. Container verbs keep the container as a suffix (`createWorkspace`, `switchWorkspace`) to stay distinct from the layer-agnostic Session `rename`.

## Future

- **Typed precondition errors.** The Liskov contract's enforcement mechanism: a Registry call against a gated state (e.g. `write` on a non-`Live` Process) fails with a typed error naming the violated precondition, instead of relying on each call site's ad-hoc handling.
