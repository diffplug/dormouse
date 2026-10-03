# Reopen and delayed kill

> See `docs/specs/glossary.md` for Surface / Session / Pane / Door vocabulary.
> This spec owns which user closes confirm, reopening closed Surfaces, Workspaces, and windows, and the Labs delayed-kill mode (`## Future`). `docs/specs/layout.md` → "Kill confirmation" owns the confirmation's interaction; `docs/specs/dor-tool.md` → "Unsaved changes" owns Tool dirty state.

## The rule

- **Must confirm a user close unless Reopen restores it losslessly.** Lossless is defined per kind by the [Reopenable kinds](#reopenable-kinds) table, nowhere else; a kind absent from the table confirms.
- **Must decide at the close, from state already in memory.** Pending or unknown state (an unreported Tool dirty flag, a helper whose host inspection has not answered) confirms, so the user can always tell in advance whether a close will ask.
- **Never confirm on `dor` command closes**; they keep their explicit flags (`docs/specs/dor-cli.md`) and push a record exactly like a gesture close.
- **A trivial close leaves no trace.** It is closing an untouched shell (`docs/specs/layout.md` → "Kill confirmation") that is not running and owns no helper with user input, or replacing one in place (`dor iframe`, the shell picker). **Never push a record for it**, so reopen reaches past it to the last close that mattered. Inside a Workspace or window record its Pane is kept as layout.

Source of truth: `closeKind` in `lib/src/components/wall/close-kind.ts`; `requestKill` and `closeSurface` in `lib/src/components/Wall.tsx`.

## Reopenable kinds

A reopened Surface is rebuilt from its record: a new Session and process. "Lost" lists what the user cannot get back. (rationale)

| Surface at close | Reopen rebuilds | Lost | Confirms? |
|---|---|---|---|
| Trivial close ([The rule](#the-rule)) | Nothing: no record | Nothing | No |
| `builtin:file` (viewer or editor) running and reporting clean | Same path, same position | Cursor and scroll position | No |
| `builtin:folder` running | Same path | Expanded subfolders | No |
| `iframe` browser | Same URL, reloaded | Live page state | No |
| Touched or running shell, any other Tool (`builtin:code` included), a built-in whose command has ended, agent-browser / playwright, a dirty or unreported Tool | — | — | Yes |

A read-only `builtin:file` view reports clean as it starts (`docs/specs/dor-tools-builtin.md`). Repo Tools join the table only through `docs/specs/dor-tool.md` → "Reaping", which supplies the safe-to-stop contract args alone do not.

## The reopen record

- **Must capture at the close**: `persistableLeafMeta`, the `PersistedPane` projection with the cwd the Session last reported, the Workspace id, and a Pane's restore token or a Door's index.
- **Must keep records in memory, per Window, newest first, capped at 20.** **Never persist them**; `docs/specs/transport.md` → "What is persisted" stands, and cold restore already covers quit.
- **Must reopen through the cold-restore per-pane path**: a Pane from its token, with the selected pane as fallback; a Door at its index. A Surface whose Workspace has closed reopens in the active Workspace.
- **Must mint a new Surface id and `surface:N` ref**; refs are never reused (`docs/specs/dor-cli.md` → "Handle Model").

Source of truth: `lib/src/lib/reopen-stack.ts`; `reopenSurface` in `lib/src/components/Wall.tsx`; `reopenPane` in `lib/src/lib/session-restore.ts`.

## Reopen verb

**Reopen** takes the newest record across this Window's stack and the host's closed windows ([Workspaces and windows](#workspaces-and-windows)). A gesture brings what it reopened into view; an empty stack does nothing and says so briefly.

- **Must bind `⌘⇧T` as a native menu item (File → "Reopen Closed") on macOS**, so it fires in passthrough with no interception in the window keydown dispatcher.
- **Must bind command-mode `u` on every platform**, whatever is selected. **Never bind `Ctrl+Shift+T` on Windows or Linux**: in legacy encoding it reaches programs as `Ctrl+T` (readline, fzf, emacs).
- **Must answer `dor reopen` (`window.reopen`) in the Window**, focus-neutral, refusing an empty stack (`docs/specs/dor-cli.md` → "dor reopen").

Every host takes `u` and `dor reopen`; window records and the menu item are Standalone's.

Source of truth: `reopenClosed` in `lib/src/components/wall/reopen.ts`; the `.menu(...)` builder in `standalone/src-tauri/src/lib.rs`.

## Workspaces and windows

- **Workspace close records the Workspace whole, and its members push no records**; reopening it creates a new Workspace at its strip slot through cold restore, every Surface with a fresh id and its refs starting over. **Reopenability is all-or-nothing**: one member whose own close would confirm makes the Workspace close confirm and leaves no record.
- **Closing one window of several confirms when any of its Workspaces' closes would.** **One that asks nothing must hand the host its snapshot before removing it from disk**, every Workspace and Surface with a fresh id; the host keeps up to 20 in memory, since the closing webview dies. **Reopen asks the host first**: the newest window that closed after the asking Window's newest record opens in a new window, its snapshot written under a fresh label so it boots as any window restores, at its last geometry.

Source of truth: `closeWorkspaceWithSurfaces` in `lib/src/components/wall/workspace-lifecycle.ts`; `lib/src/components/wall/window-reopen.ts`; `push_closed_window` / `reopen_closed_window` in `standalone/src-tauri/src/lib.rs`.

## Future

**Scope: delayed-kill** — behind a Labs toggle: [Labs: No-confirm delayed kill](#labs-no-confirm-delayed-kill).

### Labs: No-confirm delayed kill

**Settings gains a Labs section** (`lib/src/components/SettingsDialog.tsx`), Standalone only and app-wide (every window reads one setting), holding one toggle, **No-confirm delayed kill**, off by default. With it on, a close that would confirm instead becomes a **pending kill**: the Surface leaves the layout at once but its process lives until a countdown finalizes it.

| Confirmation | With the toggle on |
|---|---|
| Pane kill (letter prompt) | Pending kill |
| Unsaved Tool close (Save / Discard / Cancel) | Pending kill; the parked DOM keeps the edits until finalize |
| Workspace close | Pending kill of the whole Workspace |
| Helper Reset | Pending kill of the old helper; the fresh one starts at once |
| Reopenable close | Unchanged: immediate, onto the reopen stack |
| Quit, window close | Unchanged: confirm; nothing can outlive them |
| iframe moves, render swap to fewer tabs | Unchanged: confirm; a reload has no delayed form |
| Links, Tool trust, remote control | Unchanged: outward, not local state |
| `dor` command closes | Unchanged: immediate |

- **Must detach a pending Surface the way minimize does** (keep the token, park its DOM, keep the PTY Live) without creating a Door. A pending Workspace is a hidden Workspace tab whose Wall stays mounted and inactive.
- **Must finalize through today's kill path** when the countdown completes or the user finalizes the entry early.
- **Restoring a pending kill reattaches the same Surface**, ref and process intact; it is not a rebuild. `⌘⇧T` / `u` / `dor reopen` take the newest entry across pending kills and reopen records.
- **Must suppress alerts from pending Surfaces and omit them from `dor` listings and Clients**; a `dor` command addressing one fails as pending kill.
- **Must count pending running work in the quit and window-close gates**, then finalize every pending kill on quit. Nothing pending survives a restart.

**The overlay** stacks pending kills in the window's bottom-right corner, above the Baseboard, newest on top. Each entry shows the Surface's title and kind, a bar filling toward the kill, restore on click, and finalize now. **The countdown is 10 s and pauses while the pointer is over its entry**; past 3 entries the rest collapse to a `+N` row. (rationale)

**Promotion amends `docs/specs/transport.md` → "The governing rule"** ("deliberately ending something ends it") for the toggle's duration, and `docs/specs/layout.md` → "Kill confirmation" for the pending kill. **Labs settings are app-wide**, like every other Standalone setting.
