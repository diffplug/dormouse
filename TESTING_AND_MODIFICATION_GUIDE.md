# Workspaces stack: testing and modification guide

For an agent picking up the Workspaces work. Read `AGENTS.md` first (worktree rules,
spec conventions); this guide covers only what is specific to the stack.

## 1. Where the code is

The work is a stack of ten branches, each a draft PR based on the one before it.
Every branch has its own worktree as a sibling of the repo:

| # | PR | Branch | Worktree | What it adds |
|---|---|---|---|---|
| 1 | #614 | `workspaces-window` | `dormouse.workspaces-2/.claude/worktrees/workspaces-window` | Workspace strip, one Wall per Workspace, hidden-Workspace minimize |
| 2 | #615 | `workspaces-persist` | `dormouse.workspaces-2/.claude/worktrees/workspaces-persist` | Per-Workspace persistence, agent recovery |
| 3 | #616 | `workspaces-multiwindow` | `dormouse.workspaces-2/.claude/worktrees/workspaces-multiwindow` | Several windows, routing, quit voting, transfer, drag |
| 4 | #617 | `workspaces-dor` | `dormouse.workspaces-2/.claude/worktrees/workspaces-dor` | `dor workspace` verbs |
| 5 | #618 | `workspaces-harden` | `dormouse.workspaces-harden` | Held events in the transfer gap, drift cleanup |
| 6 | #619 | `workspaces-registry` | `dormouse.workspaces-registry` | Rust registry, stable `workspace:<n>` refs, cross-window routing |
| 7 | #620 | `workspaces-durability` | `dormouse.workspaces-durability` | Transfer moves the snapshot between files on disk |
| 8 | #621 | `workspaces-fidelity` | `dormouse.workspaces-fidelity` | Marks, serialized xterm buffers, pins across a move |
| 9 | #622 | `workspaces-move-verb` | `dormouse.workspaces-move-verb` | `dor workspace move`, `dor list --window`, iframe move gate |
| 10 | #623 | `workspaces-harness` | `dormouse.workspaces-harness` | Harness alert stores through the sidecar |

**Work on the tip** (`dormouse.workspaces-harness`) for testing and for any tweak,
unless the tweak clearly belongs to an earlier stage and you want it reviewed
there. If you commit on an earlier stage, merge it forward through every later
branch (`git merge --no-ff <previous>` in each worktree, in order), or the PRs
diverge. Push with `git push origin <branch>`; the PRs update themselves.

Never `git switch -c` inside an existing worktree. New branches:
`wt switch --create <name> --base @` from the worktree you are stacking on.

## 1a. Changing the stack, and landing it

**Default: put changes in new PRs on top of the tip.** A change to an early
stage has to be merged forward through every later branch; a new PR at the tip
touches nothing behind it, and testing findings usually cut across stages anyway.
Edit an existing PR only when (a) the bug would make that PR wrong to merge on
its own, (b) it answers review feedback on that PR, or (c) the stage's spec text
is untrue. After editing an earlier stage, merge it forward at once, stage by
stage, and run the tip's suites once at the end.

**Land with merge commits, in order, never squash.** The stack is built on merge
commits, so merging PR N with a merge commit leaves PR N+1's diff exactly its own
and GitHub retargets it to `main` when PR N's branch is deleted; nothing else is
needed. If a PR is squash-merged by mistake, PR N+1 will show PR N's changes
again until `main` is merged into its branch (that merge resolves cleanly, since
both sides carry identical content). The repo's default is a merge commit; keep it.

Keep every PR a draft until it is actually up for review (Chromatic bills on
ready-for-review).

## 2. Setup in a worktree

```
pnpm install
pnpm --filter dor-lib-common build      # dor tests import its dist
pnpm --filter remote-lib-common build   # vscode-ext tests import its dist
pnpm --filter dor build                 # dor CLI tests and help snapshots
```

For `cargo test`, the build script needs a self-contained Node 24.18.0 binary and
rejects Homebrew's. Copy the bundled one from the main checkout and point the env
var at that source path, **never at the worktree's own `binaries/` path** (the
build script copies source onto destination and truncates the file to 0 bytes):

```
mkdir -p standalone/src-tauri/binaries
cp /Users/ntwigg/projects/dormouse/standalone/src-tauri/binaries/node-aarch64-apple-darwin standalone/src-tauri/binaries/
cd standalone/src-tauri
DORMOUSE_NODE_BINARY=/Users/ntwigg/projects/dormouse/standalone/src-tauri/binaries/node-aarch64-apple-darwin cargo test
```

## 3. Running the app

- **Tauri (real thing, several windows):** `pnpm dev:standalone` from the repo
  root of the worktree. Dev builds use a separate state root
  (`<app_data_dir>/dev`), so dev and installed app never share snapshots.
- **Browser harness (one window only):** inside Dormouse,
  `dor ensure -- pnpm innerdogfood`; outside, `pnpm innerdogfood`. It prints the
  URL and an `agent-browser` command. The skill
  `.claude/skills/debug-standalone-agent-browser/SKILL.md` covers driving it.
  The harness simulates **one** window: transfer, tear-out, quit voting, and
  cross-window `dor` routing only run in Tauri.

Opening a second window: drag a Workspace tab out of the strip and release it
outside the window, or from a Dormouse terminal run
`dor workspace move <ref> --window new`.

## 4. Automated tests

Per package, from the worktree root:

```
(cd lib && npx tsc --noEmit -p . && npx vitest run)          # ~3000 tests
(cd standalone && npx tsc --noEmit -p . && npx vitest run && node --test scripts/*.test.mjs)
(cd standalone/sidecar && node --test)
(cd dor && node --test)                                        # help snapshots
(cd vscode-ext && npx vitest run)
pnpm lint:specs && node scripts/xterm-lint.mjs
cargo test                                                     # see §2
```

Help snapshots: after changing any `dor` help text, rebuild and refresh with
`cd dor && pnpm build && UPDATE_SNAPSHOTS=1 node --test`, then run `node --test`
again and commit `dor/test/snapshots/`.

Tests that pin the stack's non-obvious rules, by concern:

| Concern | Tests |
|---|---|
| Hidden-Workspace minimize | `lib/src/components/TerminalPane.test.tsx` ("a hidden Workspace minimizes its terminals") |
| Composition, switching, close race | `lib/src/components/WorkspaceWindow.test.tsx`, `Wall.test.tsx` |
| Strip | `lib/src/components/WorkspaceStrip.test.tsx`, `workspace-strip-drag.test.ts` |
| Quit / close arbitration | `standalone/src/quit.test.ts`, `teardown-arbiter.test.ts`, `window-close.test.ts`; Rust `quit_state` |
| Routing table, arrivals, marking, held events | Rust `routing::tests` |
| Transfer, content, tear-out boot | `standalone/src/workspace-move.test.ts` |
| Cross-window drag and iframe gate | `standalone/src/workspace-drag.test.ts` |
| Registry, stable refs | Rust `workspaces::tests`, `standalone/src/workspace-registry.test.ts`, `lib/src/lib/workspace-store.test.ts` |
| Sidecar marks and since-mark replay | `standalone/sidecar/pty-core.test.js` |
| Pins across a move | `lib/src/lib/notepad/source-link.test.ts`, `notepad-store.test.ts` |
| `dor workspace` verbs, move gate | `lib/src/components/wall/workspace-control.test.ts`, `dor-control-router.test.ts` |
| Disk staging of a transfer | Rust `tests::a_staged_arrival_is_in_the_target_snapshot_until_it_is_handed_back` |

## 5. Manual test checklist

Nothing below has been run in the Tauri app yet. Items marked **WKWebView** are
the ones the design depends on and that were validated only in Chromium.

**Hidden-Workspace minimize (WKWebView)**
- Two Workspaces, three terminals each. Switch away; in Safari Web Inspector the
  hidden Workspace's canvases should have lost their WebGL contexts and the
  visible one's should be live.
- Switch back: zero PTY resizes at an unchanged grid (watch `pty:resize` in the
  sidecar log). Resize the window while hidden: exactly one resize on return.
- 30+ switches with more than 16 terminals total: every pane still shows
  `data-renderer="webgl"`, no "too many active WebGL contexts" in the console.
- A full-screen TUI (`btop`) on switch-back: look for a one-frame blank. If seen,
  keep the outgoing Wall painted one extra frame; do not abandon detaching.
- Switch into an 8-pane Workspace: watch for jank from N context creations.

**Transfer and tear-out**
- Move a Workspace with a long-running TUI and 10k+ lines of scrollback to a
  second window: scrollback, cursor, and colors intact; output continues with
  nothing repeated or lost at the seam.
- A note pinned to scrollback survives the move (click the pin in the target).
- Kill the app mid-drag (after the drop, before the target finishes): on
  relaunch the Workspace is in the target window with fresh shells, and not in
  the source.
- Tear out a Workspace whose terminals are idle (no output): the new window
  appears within a second (the mark round trip is the only wait).
- Drop onto a target and close that target before it adopts: the Workspace
  stays in the source, its terminals keep receiving output.

**Iframe gate**
- A Workspace holding a `dor iframe` Surface: dragging it to another window
  raises the typed-letter dialog naming the count; Escape leaves everything as
  it was; the letter moves it and the iframe reloads at its URL.
- Same Workspace with only agent-browser Surfaces: no dialog.
- `dor workspace move workspace:<n> --window <label>` refuses and names the
  Surfaces; `--dangerously-destroy-iframe-page-state` moves it.

**Registry and refs**
- `dor list --workspaces` in two windows: refs never collide and never renumber
  after a reorder or a move.
- From window A, `dor list --workspace <ref in B>` and
  `dor list --window ws-2` answer from B.
- `dor workspace move --index 0` reorders without changing the ref.

**Quit**
- Two windows, one with a running command. Cmd+Q, then Cmd+Q again while the
  dialog is up, then confirm: the app quits (this was the wedge).
- Relaunch: both windows and their Workspaces come back; the interrupted agent
  is offered its resume command.

**Harness alert stores**
- In `innerdogfood`, toggle a watched command and change alarm settings: they
  survive a page reload (they now live in the sidecar).

## 6. Where to change what

Each row names the code and the spec section that must change with it. Spec
lint enforces word budgets: after editing a spec, run `pnpm lint:specs`; if it
reports a budget, `node scripts/spec-lint.mjs --ratchet docs/specs/<name>.md`
in the same commit. The "why" of a rule goes in `<name>.rationale.md`, keyed by
the heading, and the rule gets a `(rationale)` marker.

| Concern | Code | Spec |
|---|---|---|
| Strip look, tabs, menus, rename, indicators | `lib/src/components/WorkspaceStrip.tsx`, `workspace-strip-drag.ts`, stories in `lib/src/stories/` | `docs/specs/layout.md` → Workspaces; `standalone.md` → AppBar; `alert.md` → Workspace union |
| Close confirmation, move confirmation dialogs | `WorkspaceStrip.tsx` (renders `KillConfirmModal` for `pendingClose` / `pendingMove`), `lib/src/lib/workspace-ui-store.ts`, `lib/src/components/KillConfirm.tsx` (`title`, `detail` props) | `layout.md` → Workspaces |
| Command-mode keys (`c n p l 1-9 W & !` etc.) | `lib/src/components/wall/keyboard/handle-workspace-shortcuts.ts` | `layout.md` → Workspaces, `shortcuts.md` |
| Composition, active/hidden Wall, input gating | `lib/src/components/WorkspaceWindow.tsx`, `Wall.tsx` (`WorkspaceActiveContext`) | `layout.md` → Workspaces |
| Hidden-Workspace terminal minimize | `lib/src/components/TerminalPane.tsx` mount effect (gated on `workspaceActive`), `lib/src/lib/terminal-lifecycle.ts` (`mountElement`/`unmountElement`), `terminal-webgl.ts` | `layout.md` → Workspaces, Renderer; `layout.rationale.md` → Workspaces |
| Workspace store, ids, refs | `lib/src/lib/workspace-store.ts` (`installWorkspaceIdPool`, `workspaceRefFor`, `resolveWorkspaceRef`) | `dor-cli.md` → Handle Model; `standalone.md` → Workspace registry |
| Registry (Rust) | `standalone/src-tauri/src/workspaces.rs`; commands `workspace_reserve_ids` / `workspace_report` / `workspace_registry` in `lib.rs`; `standalone/src/workspace-registry.ts` (`useWorkspaceRegistry` for UI that needs other windows' Workspaces) | `standalone.md` → Workspace registry |
| Sidecar event routing | `standalone/src-tauri/src/routing.rs` (`route`, pure) and `dispatch_sidecar_event` in `lib.rs` | `standalone.md` → Routing (the table) |
| Transfer protocol | Source and target halves in `standalone/src/workspace-move.ts`; lib half in `lib/src/components/wall/workspace-transfer.ts` (`prepareWorkspaceTransfer`, `captureTransferContent`); Rust `begin_arrival` / `transfer_workspace_content` / `adopt_ready` / `adopt_done` / `hand_back_arrival` in `lib.rs`, `Arrival` in `routing.rs` | `standalone.md` → Transfer, Tear-out, Arrival queue; `transport.md` → Transferring a Workspace |
| Marks and since-mark replay | `mark` / `list` in `standalone/sidecar/pty-core.js`; `pty:marked` routing and bookkeeping in `routing.rs` / `lib.rs`; `serializeTerminal` / `flushTerminal` in `terminal-lifecycle.ts` | `transport.md` → Transferring a Workspace; `standalone.rationale.md` → Arrival queue |
| Pins across a move | `lib/src/lib/notepad/source-link.ts` (`transferredPinOf`, `registerTerminalSourceAtLines`), `notepad-store.ts` (`snapshotTerminalPins`, `restoreTerminalPins`) | `transport.md`, `notepad.md` |
| Disk staging of a transfer | `stage_arrival_on_disk` / `unstage_arrival_on_disk` in `lib.rs` | `standalone.md` → Arrival queue |
| Arrival deadline, held events | `ARRIVAL_MAX`, `expire_arrival`, `hold_event` / `take_held` in `routing.rs`; `spawn_arrival_watchdog` in `lib.rs` | `standalone.md` → Arrival queue, Routing |
| Cross-window drag | `standalone/src/workspace-drag.ts` (release gate in `onDropOnOtherWindow`), `window_at_cursor` in Rust | `standalone.md` → Dragging a Workspace between windows |
| Quit and per-window close | `standalone/src/quit.ts`, `teardown-flow.ts`, `window-close.ts`; Rust `quit_state.rs`, `macos_terminate.rs` | `standalone.md` → Quit flow, Per-window close |
| Persistence and restore | `lib/src/lib/window-session-aggregator.ts`, `standalone/src/window-restore.ts`, Rust `save_session` etc. | `standalone.md` → Persistence; `transport.md` |
| `dor workspace` verbs, `dor list` | `dor/src/commands/workspace.ts`, `list.ts`, `dor/src/protocol.ts`, `dor/src/control-client.ts`, `dor/src/commands/types.ts`; window handler `lib/src/components/wall/workspace-control.ts`; router `dor-control-router.ts` | `dor-cli.md` → dor workspace, Standalone, Handle Model |
| Platform hooks the stack added | `onPtyMarked`, `transferWorkspace` on `PlatformAdapter` (`lib/src/lib/platform/types.ts`), implemented in `standalone/src/tauri-adapter.ts` and `browser-sidecar-adapter.ts` | `transport.md` |
| Browser harness | `standalone/scripts/dev-agent-browser.mjs` (`invokeMap`, `fireAndForget`), `browser-sidecar-adapter.ts` | `transport.md` → Standalone browser-dev harness |

## 7. Rules that bite

- **Every Tauri `listen` must be `listenToWindow`** (`standalone/src/window-label.ts`).
  A bare `listen` receives every window's traffic; `scripts/window-listeners.test.mjs`
  fails the build otherwise. Broadcasts (`app.emit`) still reach scoped listeners.
- **Ids are minted only by Rust** in standalone. `createWorkspace()` draws from the
  pool `installWorkspaceIdPool` fills at adapter init; do not hand-roll ids.
- **Never release a Session from an unmount.** `releaseSession` is reachable only
  from a transfer's `commit`; `Wall.test.tsx` pins it.
- **`take_arrivals` does not consume**, and an arrival without content is not
  drainable. If you change the transfer sequence, keep: source invokes → Rust marks
  → source serializes → `transfer_workspace_content` → target nudged/built.
- **The routing lock is never held across an emit**, and the registry lock is taken
  only for `dor:controlRequest`. Read the comment above `dispatch_sidecar_event`.
- **Spec lint** rejects a bare file name in a `Source of truth:` line; use full
  repo paths. Each rationale `## Heading` must exist in the spec.
- **`DORMOUSE_NODE_BINARY`** must not point at the worktree's own `binaries/` file
  (see §2).

## 8. Known gaps

- The browser harness simulates one window; multi-window behavior is Tauri-only.
- `dor list --all` still lists the answering window only (`dor-cli.md` → Future).
- A mark can fall inside an escape sequence the sidecar's parser is holding; the
  target's parser resynchronizes on the next ground byte, the same class of cut
  the old bounded replay made. Documented in `standalone.rationale.md` → Arrival queue.
- The alert stores in the sidecar are memory-only; a sidecar respawn loses them
  until a window re-seeds.
- The one-frame blank on switch-back and WKWebView context release are unverified
  (§5).
