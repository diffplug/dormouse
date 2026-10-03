# Reopen and delayed kill

> Status: design — nothing here is implemented yet.
> See `docs/specs/glossary.md` for Surface / Session / Pane / Door vocabulary.
> This spec owns reopening closed Surfaces, Workspaces, and windows, and the Labs delayed-kill mode. Until promotion, `docs/specs/layout.md` → "Kill confirmation" and "Workspace lifecycle" own today's confirmations; `docs/specs/dor-tool.md` → "Unsaved changes" owns Tool dirty state.

## Future

**Scope: reopen** — Standalone only, in implementation order.

1. [Prerequisites](#prerequisites): close the gaps that let a running shell close unconfirmed today.
2. [The reopen record](#the-reopen-record) and the [Reopen verb](#reopen-verb) for Surfaces.
3. [Reopenable kinds](#reopenable-kinds): drop the confirmation for clean built-in Tools.
4. Workspace close joins the stack ([Workspaces and windows](#workspaces-and-windows)).
5. Closing one window of several joins the stack.

**Scope: delayed-kill** — after **reopen**, behind a Labs toggle: [Labs: No-confirm delayed kill](#labs-no-confirm-delayed-kill).

### The rule

- **Must confirm a user close unless Reopen restores it losslessly.** Lossless is defined per kind by the [Reopenable kinds](#reopenable-kinds) table, nowhere else; a kind absent from the table confirms.
- **Must decide at the close, from state already in memory.** Pending or unknown state (an unreported Tool dirty flag, an unresolved process inspection) confirms. Predictability is the feature: the user can always tell in advance whether a close will ask.
- **Never confirm on `dor` command closes**; they keep their explicit flags (`docs/specs/dor-cli.md`) and push a record exactly like a gesture close.
- **A trivial close leaves no trace.** It is closing an untouched shell that is not running and owns no helper with user work, or replacing one in place (`dor iframe`, the shell picker). **Never push a record for it**, so reopen reaches past it to the last close that mattered; a new terminal recreates it exactly. Inside a Workspace or window record its Pane is kept as layout.

### Prerequisites

Each closes a path where a close skips confirmation without being reopenable:

- **Must clear `untouched` on every user-originated input path**, adding `dor send` / `writePty` and Client input arriving through the host, which today skip `markSessionTouched`.
- **Must confirm an untouched shell whose activity is `running`**; `untouched` alone is not evidence of idleness.
- **Must confirm an untouched shell that owns a preserved helper**; today it closes unconfirmed and the helper's work is lost.
- **Must replace the Workspace close predicate** (`hasTouchedSurfaces() || runningCount() > 0`, where every Tool counts as touched) with "any member is not reopenable".

Starting points: `isUntouchedShell` / `requestKill` in `lib/src/components/Wall.tsx`; `markSessionTouched` in `lib/src/lib/terminal-lifecycle.ts`; the `dor send` handler in `lib/src/components/wall/use-dor-control.ts`; `writeClientInput` in `lib/src/host/owner-pty.ts`; `workspaceNeedsCloseConfirmation` in `lib/src/components/wall/workspace-lifecycle.ts`.

### Reopenable kinds

A reopened Surface is rebuilt from its record: a new Session and process. "Lost" lists what the user cannot get back.

| Surface at close | Reopen rebuilds | Lost | Confirms? |
|---|---|---|---|
| Trivial close ([The rule](#the-rule)) | Nothing: no record | Nothing | No (as today) |
| `builtin:file` (viewer or editor) reporting clean | Same path, same Lath position | Cursor and scroll position | No (today: yes) |
| `builtin:folder` | Same path | Expanded subfolders | No (today: yes) |
| `iframe` browser | Same URL, reloaded | Live page state | No (the browser convention: a closed tab reopens at its URL) |
| Touched shell, repo Tool, agent-browser / playwright, dirty or unreported Tool, running work | — | — | Yes |

Repo Tools join the table only through `docs/specs/dor-tool.md` → "Dehydrate and rehydrate" (D2), which supplies the safe-to-stop contract args alone do not.

### The reopen record

- **Must capture at the close**: the Lath `RestoreToken` (today discarded at kill), `persistableLeafMeta`, the `PersistedPane`-shaped projection (cwd, title, command, Tool metadata), the Workspace id, and Pane vs Door with the Door's index.
- **Must keep records in memory, per Window, newest first, capped at 20.** **Never persist them**; `docs/specs/transport.md` → "What is persisted" stands, and cold restore already covers quit.
- **Must reopen through the cold-restore per-pane path** (extract the loop body of `restoreSession`) plus `restoreLeaf` with the selected pane as fallback. A Surface whose Workspace has closed reopens in the active Workspace.
- **Must mint a new `surface:N` ref**; glossary I10 (refs are never reused) stands.

Starting points: `RestoreToken` / `restore` in `lib/src/lib/lath/ops.ts`; `killPaneImmediately` in `lib/src/components/Wall.tsx`; `persistableLeafMeta` in `lib/src/components/wall/lath-wall-engine.ts`; `restoreSession` in `lib/src/lib/session-restore.ts`; `restoreTerminal` in `lib/src/lib/terminal-lifecycle.ts`.

### Reopen verb

- **Reopen** joins the glossary's user verbs, distinct from **restore** (cold start) and **reattach** (Door → Pane).
- **Must bind `⌘⇧T` as a native menu item ("Reopen Closed") on macOS**, so it works in passthrough without a new interception in the window keydown dispatcher; verify the accelerator fires while a terminal has focus.
- **Must bind command-mode `u` on every platform.** **Never bind `Ctrl+Shift+T` on Windows or Linux**: in legacy encoding it reaches programs as `Ctrl+T` (readline, fzf, emacs).
- **Must add `dor reopen`**, the verb's `dor` counterpart (`docs/specs/layout.md` → "Workspace lifecycle" requires one).
- An empty stack does nothing and says so briefly.

### Workspaces and windows

- **Workspace close collapses its members' records into one Workspace record**; reopening it restores the Workspace tab, its layout, and every member. Reopenability is all-or-nothing: one non-reopenable member makes the close confirm.
- **Closing one window of several** today deletes its snapshot (`remove_window_session`, called from `standalone/src/window-close.ts`) and usually asks nothing. The record for a closed window must live host-side, since the closing webview dies; reopen opens a new window from it. Its members follow the same table: a window holding a touched idle shell confirms.

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

**The overlay** stacks pending kills in the window's bottom-right corner, above the Baseboard, newest on top. Each entry shows the Surface's title and kind, a bar filling toward the kill, restore on click, and finalize now. Past a few entries the stack collapses to a count. **The countdown is 10 s and pauses while the pointer is over its entry**; past 3 entries the rest collapse to a `+N` row.

**Promotion amends `docs/specs/transport.md` → "The governing rule"** ("deliberately ending something ends it") for the toggle's duration.

### Promotion checklist

Promoting either scope rewrites, in the same PR: `docs/specs/layout.md` → "Kill confirmation" and "Workspace lifecycle"; `docs/specs/shortcuts.md`; the glossary verb table; `docs/specs/dor-cli.md` for `dor reopen`; `docs/specs/standalone.md` → "Per-window close"; and this spec, moving the built part above the fold.

### Decisions

- **`iframe` browsers are reopenable** at their URL, reloaded: a closed browser tab is universally understood to lose its live page, so the table, not losslessness of page state, decides.
- **A touched idle shell is never reopenable**, even at lower fidelity: replaying scrollback into a fresh shell looks like the old one while its exports, history, and jobs are gone.
- **The delayed-kill countdown is 10 s, pausing on hover, collapsing past 3 entries**: long enough to notice a wrong kill, short enough that a pending process does not linger.
- **Labs settings are app-wide**, like every other Standalone setting.
