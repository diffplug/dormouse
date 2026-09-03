# Glossary

> Canonical vocabulary for Dormouse's states, entities, and transitions. Every other spec defers here when naming a state, a surface kind, or a verb; pick names from here first.

## The core idea

A **Surface** is the durable occupant of a Pane — the content in a slot. Two kinds:

- a **terminal Surface**, which Dormouse calls a **Session**: a PTY-backed shell with scrollback and semantic terminal state. The six-axis model below describes this kind.
- a **browser Surface**: a web view (`docs/specs/dor-browser.md`), taking only a subset of the axes ([Panes and Surfaces](#panes-and-surfaces)).

**Unless a passage says "Surface" or "browser Surface," it describes a Session.** A Session's state lives on six orthogonal axes, each changing without touching the others — which is what the **[Liskov contract](#liskov-contract)** rests on.

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

**Kinds are capability sets, not exclusive categories** — the two above carry one capability each, the staged `tool` (`docs/specs/dor-tool.md`) both. **Operations gate on the capability they need, never on the kind enum** ([Liskov contract](#liskov-contract)): `read` / `send` / `await` / port scans need the terminal, nav / render-mode / agent-browser verbs the browser. **`dor list --json` rows always emit `has_terminal` and `has_browser`** (rationale). **A new kind is declared in one place**: the `hasTerminal` / `hasBrowser` capability table. Persistence keeps its own `PersistedSurfaceType` discriminant (`docs/specs/transport.md`).

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

**Surface identity:** a Surface's id is its Lath leaf id. A terminal Surface's *is* its `SessionId`, stable (I1); a browser Surface's does not survive a render-mode swap (I10).

## Containers

Workspace and Window are containers, not Session layers — they group Surfaces rather than describing one Surface's state (containment is I7).

| Container | Holds | Owner |
|---|---|---|
| **Window** | One or more Workspaces; the OS frame (the standalone Tauri window) or the host frame (a VS Code window). | host (Tauri / VS Code) |
| **Workspace** | "A window's worth of panes": a `WorkspaceId`, a user-facing `name`, its Panes and Surfaces, and the layout arranging them (Lath snapshot + doors). Exactly one **Wall** renders one Workspace. | `lib/src/lib/workspace-store.ts` (the model), `lib/src/components/Wall.tsx` at render time; persisted per `docs/specs/transport.md` |

How many Workspaces a Window shows at once is host-specific:

- **Standalone** holds many Workspaces in one Window, mounting only the **active** one; switching mounts the target's Surfaces and unmounts the previous one's, PTYs staying `Live` with Activity flowing. Tab strip and mounting are staged (`docs/specs/layout.md` `## Future`, workspaces-rollout).
- **VS Code** maps one Workspace to one webview, several visible at once: the sidebar/panel `WebviewView` is the default Workspace, each `dormouse.open` editor-tab `WebviewPanel` an independent one owning its Sessions' PTYs and browser Surfaces (`docs/specs/vscode.md`).

### Wall chrome

| Term | Meaning |
|---|---|
| **Wall** | The component rendering one Workspace: its Panes plus the Baseboard (`lib/src/components/Wall.tsx`) |
| **Baseboard** | The always-visible strip along the bottom of a Wall, holding Doors, the update notice, and the shortcut hint |
| **Door** | A minimized Surface's tile on the Baseboard — the `Doored` View state |

`docs/specs/layout.md` owns their placement, sizing, and interaction.

### Workspace union status

A Workspace projects a **union status** over its member Surfaces' Activity:

- `ringing` — any member has `status === 'ALERT_RINGING'`.
- `todo` — any member has `todo === true`: a terminal Session, or a browser Surface a user has flagged.
- `count` — members currently owing attention, for hosts that show a numeric badge. A Surface both ringing and `todo` counts once.

`docs/specs/alert.md` owns the projection rules — which Surfaces participate, and the display-only constraint.

### Implementation status

The Pane / Surface model, surface kinds, and their persistence are live; the Workspace / Window containers are dormant behind `dormouse.flags.workspaces` (`docs/specs/layout.md` → Workspaces), so the app runs one implicit Workspace. Ledger: `docs/specs/layout.md` `## Future` (**Scope: workspaces-rollout**); this glossary does not track it.

## Modes

A Wall is always in exactly one input mode; `docs/specs/layout.md` owns the switching gestures and per-mode behavior. Canonical names:

| Mode | Meaning |
|---|---|
| **passthrough** | Keyboard input routes to the selected Session's terminal. Only copy/paste and the mode-switch gesture are intercepted. |
| **command** | Keyboard input drives navigation and layout commands; the Session receives nothing. |

**Never introduce aliases** — "terminal mode", "normal mode", and "navigation mode" all mean one of the two names above.

## Layers

| Layer | Tracks | Owner |
|---|---|---|
| **Process** | PTY life on the host | `vscode-ext/src/pty-manager.ts` (VS Code) / `standalone/sidecar/pty-core.js` (standalone) |
| **Registry** | xterm.js Terminal + persistent DOM element + cached Activity state | `lib/src/lib/terminal-registry.ts` facade over `terminal-store.ts`, `terminal-lifecycle.ts`, `session-activity-store.ts` |
| **View** | Where and how a Surface renders | `lib/src/components/Wall.tsx` plus `lib/src/components/wall/` |
| **Link** | Webview ↔ host relationship | `lib/src/lib/reconnect.ts` |
| **Activity** | Alert / attention state machine | `lib/src/lib/alert-manager.ts` |
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
| `Orphaned` | Entry present, element detached. Not transient — a `Doored` terminal Surface sits here as long as it stays minimized (I4) |
| `Disposed` | Entry removed, xterm disposed |

### View

| State | Meaning |
|---|---|
| `Paned` | Rendered as a pane in the content area (a Lath leaf) |
| `Zoomed` | Subset of `Paned` — the passthrough-focused pane is maximized; acquiring zoom gives focus, losing focus returns it to `Paned` |
| `Doored` | Rendered as a door on the baseboard. DOM survival is a rendering decision, not part of this state: a browser Surface stays **parked** (`docs/specs/tiling-engine.md` → "Parked leaves"); a terminal Surface unmounts its element (Registry: `Orphaned`) and remounts the same xterm on reattach — nothing replays |
| `Hidden` | In neither pane nor door — webview closed, the Surface in an inactive Workspace (standalone), or mid-transition. Process and Activity unaffected. |

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
| `Flushing` | Debounced write in flight |

A monotonic generation counter, not a literal enum: `Dirty` means `gen > savedGen`, and **a `markDirty` racing a `Flushing` write leaves the tracker dirty** rather than losing the change. Source of truth: `lib/src/lib/session-dirty.ts`, driven by `lib/src/components/wall/use-session-persistence.ts`.

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
| `swap` | Exchange two Surfaces' layout slots; ids travel with them, so Registry entries, Processes, and titles are untouched |
| `switchWorkspace` | Activate a different Workspace (standalone): mount its Surfaces, unmount the previous active one's. View: target's Hidden → Paned/Doored, previous active's Paned/Doored → Hidden. Process and Activity unchanged. |
| `createWorkspace` | Add a new Workspace to the Window; standalone makes it active and spawns its first pane |
| `closeWorkspace` | Remove a Workspace, `kill`-ing each member Surface. The last remaining Workspace cannot be closed |
| `renameWorkspace` | Update a Workspace's `name`; touches no Session |

`lib/src/lib/workspace-store.ts` holds the Workspace verbs and today mutates only the model: `switchWorkspace` is spelled `setActiveWorkspace` and moves nothing, `closeWorkspace` kills no Surfaces — both staged with the rollout.

### System verbs

A system verb is a lifecycle transition driven by the runtime.

| Verb | Effect |
|---|---|
| `register` / `dispose` | Create / destroy a Registry entry |
| `mount` / `unmount` | Attach / detach the persistent DOM element (low-level op; the Registry entry survives `unmount`). A **parked** leaf stays mounted while `Doored` or `Hidden` (`docs/specs/tiling-engine.md` → "Parked leaves") |
| `exit` | Host observes process death (Process: Live → Exited) |
| `resume` | Webview reopens over live PTYs (Link: Severed → Resuming → Live; Registry rebuilt from replay data; Process stays Live) |
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

**A gated caller checks the relevant layer first**; a universal one branches on nothing. A gated call against the wrong state silently no-ops today (a missing Registry entry returns early); typed-error enforcement is staged ([Future](#future)).

## Invariants

- I1: `SessionId` is immutable for the life of a Session and stable across `resume` / `restore`.
- I2: Process state is independent of Registry, View, and Link. A `Live` process may be `Doored` or `Hidden`; an `Exited` process may still be `Paned`.
- I3: Activity state survives `minimize` / `reattach`. `ALERT_RINGING` fires only on a *fresh* transition, never on `mount` or `reattach`.
- I4: `Registry: Orphaned` outlives no Session state except `View: Doored` — at rest every other entry is `Mounted` or `Disposed`, so an `Orphaned` entry that is not `Doored` is a leak.
- I5: `kill` is universally valid and always ends at `View: Hidden`; its per-kind effects are the [User verbs](#user-verbs) row.
- I6: `rename` is universally valid including when `Process = Exited` and `View = Doored`.
- I7: Every Surface sits in exactly one Pane; every Pane and its Surfaces belong to exactly one Workspace; every Workspace belongs to one Window.
- I8: `switchWorkspace` preserves Process and Activity for both Workspaces. Mounting an inactive Workspace's Surfaces must not fire a fresh ring — I3's rule.
- I9: A Workspace's union status is a pure projection of its members' Activity: no independent state, destroyed with the Workspace.
- I10: A terminal Surface's id is its stable `SessionId` (I1). A browser Surface's is *not* preserved across a render-mode swap (`iframe` ⇄ `ab-screencast` ⇄ `ab-popout`): the swap mints a new id in the same Pane slot, carrying over the slot, the target URL, and the `surface:N` CLI ref (rationale; `docs/specs/dor-browser.md`).

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
