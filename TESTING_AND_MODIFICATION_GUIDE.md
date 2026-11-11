# Testing and modification guide

Read `AGENTS.md` first (worktree rules, spec conventions).

## 2. Setup in a worktree

```
pnpm install
pnpm --filter dor build   # dor CLI tests and help snapshots
```

No other package needs building first. Bundlers and check-only type checkers read the internal packages from source (`scripts/workspace-sources.mjs`); a package's own build, and a script that runs Node against an upstream `dist`, builds that `dist` and everything it depends on first (`scripts/build-workspace-deps.mjs`).

For `cargo test`, the build script needs a self-contained Node binary at the root `package.json` `devEngines.runtime.version` pin and rejects Homebrew's. Copy the bundled one from the main checkout and point the env var at that source path, **never at the worktree's own `binaries/` path** (the build script copies source onto destination and truncates the file to 0 bytes):

```
DORMOUSE_MAIN_CHECKOUT=/path/to/main-checkout
mkdir -p standalone/src-tauri/binaries
cp "$DORMOUSE_MAIN_CHECKOUT/standalone/src-tauri/binaries/node-aarch64-apple-darwin" standalone/src-tauri/binaries/
cd standalone/src-tauri
DORMOUSE_NODE_BINARY="$DORMOUSE_MAIN_CHECKOUT/standalone/src-tauri/binaries/node-aarch64-apple-darwin" cargo test
```

## 3. Running the app

- **Tauri (real thing, several windows):** `pnpm dev:standalone` from the repo root of the worktree. Dev builds use a separate state root (`<data dir>/dev`, `dormouse_data_dir` in `standalone/src-tauri/src/lib.rs`), so dev and installed app never share snapshots.
- **Browser harness (one window only):** inside Dormouse, `dor tool innerdogfood`; outside, `pnpm innerdogfood`. It prints the URL and an `agent-browser` command. The skill `.claude/skills/debug-standalone-agent-browser/SKILL.md` covers driving it. The harness simulates **one** window: transfer, tear-out, quit voting, and cross-window `dor` routing only run in Tauri. For a Tool, `docs/testing/dor-tool-qc.md` is a QC recipe against the harness with a real-process fixture.

After changing sidecar, staged CLI, or bundled host sources, re-stage and restart either one; frontend edits hot-reload, and Tauri watches Rust.

Opening a second window: drag a Workspace tab out of the strip and release it outside the window, or from a Dormouse terminal run `dor workspace move <ref> --window new`.

## 4. Automated tests

Per package, from the worktree root:

```
(cd lib && npx tsc -b && npx vitest run)                     # tsconfig.json is a references root (`-p .` checks nothing); tsconfig.test.json carries the tests and .storybook
(cd standalone && npx tsc --noEmit -p . && npx vitest run && node --test scripts/*.test.mjs)
(cd standalone/sidecar && node --test)
(cd dor && node --test)                                        # help snapshots
(cd vscode-ext && pnpm test)                                   # tsc on src/, then on test/ (tsconfig.test.json), then vitest
(cd website && pnpm test)                                      # tsc --noEmit, then vitest: the website's only typecheck
pnpm lint:specs && node scripts/xterm-lint.mjs                  # fast inner loop
pnpm test                                                      # CI's two test jobs; not the smoketests, cargo, or Hosted's database suites
cargo test                                                     # see §2
```

CI splits the root test gate between `Library Tests` (`pnpm test:lib`, including its prerequisites and typecheck) and `Build & Test` (`pnpm test:other`, then the build and Linux installer check). `pnpm test` runs both halves locally. In `test:other`, repository checks finish before `test:audit` and `test:packages` run concurrently through pnpm's script selector; either lane failing fails the command. The lint isolation self-test must finish before that overlap because it snapshots checkout state, including generated files. Package tests retain pnpm's dependency ordering and worker limits; the library suite uses Vitest's defaults.

`scripts/dependency-overrides.test.mjs` runs in `test:packages` and exercises VSCE package filtering, migration discovery, and Testcontainers archive creation through the overridden dependencies without starting Docker or Postgres.

Hosted Vitest runs use a fresh pgstencil root per invocation, shared by its workers and child processes. The global teardown removes that run's Docker containers, network, and volumes, including after test failures; watch mode retains them until the watcher exits. A run killed before teardown leaves a record under `~/.cache/dormouse/test-databases-v1`; the next Hosted invocation retries cleanup after checking that its owner PID is no longer alive. Cleanup failures retain the record and copied Compose file for retry even after the original worktree is deleted. Tests that never allocate a database do not start Docker. No cleanup targets development stacks or another live test run. Lifecycle regressions run with `node --test hosted/scripts/test-databases.test.mjs`.

**Every email Hosted sends has a story in `hosted/src/stories/Emails.stories.tsx`**, added in the change that adds the email: a new billing notice fails to compile until it has one, and the sign-in email is held to what is sent by `hosted/server/tests/workers.test.ts`.

Hosted's rendering seam is `hosted/src/HostedPage.tsx`: `App.tsx` owns the state and handlers, and passes them through to the page. Hosted stories live in `hosted/src/stories/` and run in lib's shared Storybook, inside a document with Hosted's CSS and production theme. Run these from the worktree root:

```sh
pnpm --filter dormouse-hosted test:dom
pnpm --filter dormouse-hosted typecheck
pnpm --filter dormouse-lib test:argos ../hosted/src/stories
pnpm --filter dormouse-lib build-storybook
dor tool storybook
```

The Hosted walkthroughs in `docs/stories/` join app and account stories. Hosted stories render inline in docs, so one whose pictured state comes from its `play` needs `autoplay`; an `inline: false` story runs `play` in its own frame without it.

Snapshot clock: `lib/.storybook/snapshot-clock.ts` freezes `Date.now` and `new Date()` at 2026-01-15 12:00 UTC for an Argos run, before any story module loads, so a story reads `Date.now()` anywhere, a `parameters` literal included, and never pins its own clock.

Helper placement snapshots: defer the fake helper's first prompt until its terminal is mounted and fitted. Drain queued xterm writes before capture and assert the one complete prompt and a viewport at the bottom. Output emitted at the initial wide grid can lose the current prompt line when xterm shrinks; waiting afterward cannot repair it. `lib/src/stories/HelperPlacement.stories.tsx` owns the gate and `lib/src/lib/platform/fake-adapter-helper.test.ts` covers deferred startup and narrow wrapping.

Real browser CLIs: `lib/src/host/agent-browser-host.real.test.ts` and `lib/src/host/playwright-host.real.test.ts` drive an installed CLI and its Chromium, and skip unless `DORMOUSE_AGENT_BROWSER_TEST_BIN` or `DORMOUSE_PLAYWRIGHT_TEST_BIN` names that CLI's binary. No CI job sets either; run them by hand after changing a provider, e.g. `(cd lib && DORMOUSE_AGENT_BROWSER_TEST_BIN=$(which agent-browser) npx vitest run src/host/agent-browser-host.real.test.ts)`. Likewise `dor/test/wsl.test.mjs` drives a real WSL distro from Windows and skips unless `DORMOUSE_TEST_WSL_DISTRO` names one; after `pnpm --filter dor build`, run `$env:DORMOUSE_TEST_WSL_DISTRO='Ubuntu'; node --test dor/test/wsl.test.mjs` in PowerShell.

Real shells: `standalone/sidecar/shell-conformance.test.js` spawns every shell Dormouse offers on the OS it runs on (`detectAvailableShells`) through `pty-core`'s `create`, the pinned node-pty, and the shipped integration, reads the output with lib's own parser and reducer, and asserts per shell: the user's dotfiles load, the reported command line is the typed one over a hostile table, the reported cwd is local and right, boundaries arrive in order with exit codes, a graceful stop ends the shell and its child, and the pane's environment carries Dormouse's identity and none of the host's planted variables. It runs in the sidecar suite, so locally `(cd standalone/sidecar && node --test shell-conformance.test.js)`; a shell that is not installed skips with its name. A shell is one row of `SHELLS`, a hostile command line one row of `HOSTILE`. CI runs it on Linux (`Build & Test`), macOS, and Windows (`Standalone Platform Check`), each leg setting `DORMOUSE_REQUIRE_SHELLS` to the shells it installs: a named shell that is missing fails the leg instead of skipping, and the suite tests that guard. A case the product gets wrong goes in `KNOWN` and runs as a `todo` until the fix deletes the entry. On Windows the PowerShell profile case writes the real `$PROFILE` (the Documents folder no variable moves), so it runs only with `DORMOUSE_CONFORMANCE_WRITE_PROFILE=1`, which only CI sets.

Adapter contract: `lib/src/lib/platform/adapter-contract-test-utils.ts` holds one case per rule `docs/specs/transport.md` states about adapters in general, and every `PlatformAdapter` runs all of them from a harness beside its own tests: `fake-adapter.contract.test.ts` and `vscode-adapter.contract.test.ts` in `lib/src/lib/platform/`, `remote-adapter.contract.test.ts` in `lib/src/remote/client/`, `tauri-adapter.contract.test.ts` and `browser-sidecar-adapter.contract.test.ts` in `standalone/src/`. A harness builds a fresh adapter, plays its host in that adapter's own transport (output, an exit, a list, a replay, a failing request), and reports what reached the host as `SentRecord`s; the two standalone harnesses share their command names through `standalone/src/sidecar-contract-test-utils.ts`. Each test's title states the outcome and ends with the spec heading it pins.

- A new implementation adds its letter to `Impl` and to every `MEMBERS` row, then a harness file calling `adapterContract(name, open)`. Keep the harness to faking the transport; past about 80 lines the seam is in the wrong place.
- A new member of `PlatformAdapter` does not compile until its `MEMBERS` row exists: one letter per implementation (upper case present, `-` absent, lower case present only in some builds or on some platforms), then the cases that pin it or the test that pins it elsewhere. The `members` case checks every row against every adapter.
- A new case goes in `CASES` with the outcome as its title and the heading as its `rule`, observing one value every implementation is compared on. It names the host hooks it plays (`needs`) and the optional members it calls (`members`); where `MEMBERS` marks one absent, the test checks the absence instead.
- `DIFFERENCES` is for an implementation that legitimately differs: what it does instead and why, in one line, or `na` where it cannot be played at all, which the test proves by finding the hook missing. Never a skip, and never a branch on the implementation inside a case.
- `KNOWN` is for an implementation that breaks a rule: the case runs as `it.fails` with the evidence until the fix deletes the entry, and a fix that lands without deleting it turns the test red.

PTY lifecycle: `standalone/src/pty-lifecycle-contract-test-utils.ts` holds the fake to the real path it stands in for, the same lifecycle cases (output, exits, kills, the generation rule, a failed spawn) run against `FakePtyAdapter` (`fake-pty-lifecycle.contract.test.ts`) and against the sidecar as `sidecar/main.js` composes it over the pinned node-pty (`sidecar-pty-lifecycle.contract.test.ts`, `node` programs so it runs on Windows), with the same `DIFFERENCES` and `KNOWN` tables.

Help snapshots: after changing any `dor` help text, rebuild and refresh with `cd dor && pnpm build && UPDATE_SNAPSHOTS=1 node --test`, then run `node --test` again and commit `dor/test/snapshots/`.

Tests that pin the Workspace model's non-obvious rules, by concern:

| Concern | Tests |
|---|---|
| Hidden-Workspace minimize | `lib/src/components/TerminalPane.test.tsx` ("a hidden Workspace minimizes its terminals") |
| Composition, switching, close race | `lib/src/components/WorkspaceWindow.test.tsx`, `Wall.test.tsx` |
| Strip | `lib/src/components/WorkspaceStrip.test.tsx`, `workspace-strip-drag.test.ts` |
| Quit / close arbitration and shared confirmation | `standalone/src/quit.test.ts`, `teardown-arbiter.test.ts`, `window-close.test.ts`, `WorkspaceTeardownModal.test.ts`, `lib/src/components/WorkspaceStrip.test.tsx`; Rust `quit_state` |
| Routing table, arrivals, marking, replay suppression | Rust `routing::tests` |
| Transfer, content, tear-out boot | `standalone/src/workspace-move.test.ts` |
| Cross-window drag and iframe gate | `standalone/src/workspace-drag.test.ts` |
| Registry, stable refs | Rust `workspaces::tests`, `standalone/src/workspace-registry.test.ts`, `lib/src/lib/workspace-store.test.ts` |
| Sidecar marks and since-mark replay | `standalone/sidecar/pty-core.test.js` |
| Workspace transfer preparation | `lib/src/components/wall/workspace-transfer.test.ts` |
| `dor workspace` verbs, move gate | `lib/src/components/wall/workspace-control.test.ts`, `dor-control-router.test.ts` |
| Crash durability of a transfer | Rust `tests::an_arrival_record_round_trips_until_it_is_forgotten` and the `a_leftover_arrival_*` boot-merge tests |

## 5. Manual test checklist

User-run results are recorded under "Transfer findings" below. Items marked **WKWebView** need native testing beyond their Chromium coverage.

**Hidden-Workspace minimize (WKWebView)**
- Two Workspaces, three terminals each. Switch away; in Safari Web Inspector the hidden Workspace's canvases should have lost their WebGL contexts and the visible one's should be live.
- Switch back: zero PTY resizes at an unchanged grid (watch `pty:resize` in the sidecar log). Resize the window while hidden: exactly one resize on return.
- 30+ switches with more than 16 terminals total: every pane still shows `data-renderer="webgl"`, no "too many active WebGL contexts" in the console.
- A full-screen TUI (`btop`) on switch-back: look for a one-frame blank. If seen, keep the outgoing Wall painted one extra frame; do not abandon detaching.
- Switch into an 8-pane Workspace: watch for jank from N context creations.

**Transfer and tear-out**
- Move a Workspace with a long-running TUI and 10k+ lines of scrollback to a second window: scrollback, cursor, and colors intact; output continues with nothing repeated or lost at the seam.
- Kill the app mid-drag (after the drop, before the target finishes): on relaunch the Workspace is in the target window with fresh shells, and not in the source.
- Tear out a Workspace whose terminals are idle (no output): the new window appears within a second (the mark round trip is the only wait).
- Drop onto a target and close that target before it adopts: the Workspace stays in the source, its terminals keep receiving output.

**Iframe gate**
- A Workspace holding a `dor iframe` Surface: dragging it to another window raises the typed-letter dialog naming the count; Escape leaves everything as it was; the letter moves it and the iframe reloads at its URL.
- Same Workspace with only agent-browser Surfaces: no dialog.
- `dor workspace move workspace:<n> --window <label>` refuses and names the Surfaces; `--dangerously-destroy-iframe-page-state` moves it.

**Registry and refs**
- `dor list --workspaces` in two windows: refs never collide and never renumber after a reorder or a move.
- From window A, `dor list --workspace <ref in B>` and `dor list --window ws-2` answer from B.
- `dor workspace move --index 0` reorders without changing the ref.

**Quit (shared confirmation UI still needs native retesting)**
- Workspace close, window close, and app quit should all show "Confirm kill workspace" with the affected Workspace names. Escape must leave the app usable.
- Two windows, one with a running command. Cmd+Q, then Cmd+Q again while the dialog is up, then confirm: the app quits (this was the wedge).
- Relaunch: both windows and their Workspaces come back; the interrupted agent resumes on its own.
- `dor app restart` (packaged build) asks what Cmd+Q asks — the requesting pane aside — then relaunches into whatever bundle is installed.

**Wall on Lath (live acceptance, standalone agent-browser harness)**
- Type into the selected terminal: keystrokes echo, `dor list` marks it `*`. `dor iframe <url>` / `dor ensure` from a touched terminal creates in the background; the caller keeps DOM focus, selection, and typing.
- Click between panes (body and header) both ways: selection and focus follow, passthrough entered. `dor kill` of a background Surface leaves the caller's selection, focus, and typing intact; killing the selected pane adopts a survivor.
- Minimize the last pane: the Door is created and selected, auto-spawn fills the Wall, the Door keeps selection. Click a Door: it reattaches at its original position where structure allows.
- An iframe that focuses itself moves selection onto its pane, as a click would (in VS Code, a background `dor` command never yanks focus out of the editor).
- Zoom: the pane rises to the inset wall rect and returns with the layout identical. Restart: layout, Doors, titles, and params restored.
- Kill with animation: fade in place, survivors tween; a second kill mid-tween retargets cleanly; reduced motion is instant. Frame-sample the shrink-to-corner of a last-pane kill and its top-left refill.
- Drag a pane to a leaf edge, an ancestor edge, and a center: preview matches the commit pixel-exactly at leaf, column, and root depth; dragging while a Door is selected selects the dragged pane. Drag a pane onto the baseboard (minimize with token) and a Door out (restore at the hit-tested position).

**Harness alert stores**
- In `innerdogfood`, toggle a watched command and change alarm settings: they survive a page reload (they now live in the sidecar).

## 6. Where to change what

Each row names the code and the spec section that must change with it. Spec lint enforces word budgets: after editing a spec, run `pnpm lint:specs`; if it reports a budget, `node scripts/spec-lint.mjs --ratchet docs/specs/<name>.md` in the same commit. The "why" of a rule goes in `<name>.rationale.md`, keyed by the heading, and the rule gets a `(rationale)` marker.

| Concern | Code | Spec |
|---|---|---|
| Strip look, tabs, menus, rename, indicators | `lib/src/components/WorkspaceStrip.tsx`, `workspace-strip-drag.ts`, stories in `lib/src/stories/` | look: `lib/src/components/design.tsx`; behavior: `docs/specs/layout.md` → Workspaces; `standalone.md` → AppBar; `alert.md` → Workspace union |
| Shared Workspace kill confirmation and iframe move gate | `lib/src/components/WorkspaceKillConfirm.tsx` ("Confirm kill workspace"), `lib/src/components/WorkspaceStrip.tsx` (`confirmation`), `standalone/src/WorkspaceTeardownModal.tsx` (window close / app quit), `lib/src/lib/workspace-ui-store.ts` | `layout.md` → Workspaces; `standalone.md` → Quit protocol |
| Command-mode Workspace keys (`1`–`9`, `Enter`, `,`, `x`/`k` on a tab) | `lib/src/components/wall/keyboard/handle-workspace-shortcuts.ts` | `layout.md` → Keyboard shortcuts (command mode), `shortcuts.md` |
| Composition, active/hidden Wall, input gating | `lib/src/components/WorkspaceWindow.tsx`, `Wall.tsx` (`WorkspaceActiveContext`) | `layout.md` → Workspaces |
| Hidden-Workspace terminal minimize | `lib/src/components/TerminalPane.tsx` mount effect (gated on `workspaceVisible`, which falls back to `workspaceActive`), `lib/src/lib/terminal-lifecycle.ts` (`mountElement`/`unmountElement`), `terminal-webgl.ts` | `layout.md` → Workspaces, Renderer; `layout.rationale.md` → Workspaces |
| Workspace store and ids | `lib/src/lib/workspace-store.ts` (`installWorkspaceIdPool`, `resolveWorkspaceRef`) | `dor-cli.md` → Handle Model; `standalone.md` → Workspace registry |
| Registry (Rust) | `standalone/src-tauri/src/workspaces.rs`; commands `boot_reserve_ids` / `workspace_reserve_ids` / `workspace_report` in `lib.rs`; `standalone/src/workspace-registry.ts` (`installWorkspaceRegistry`: id pools and the Workspace report) | `standalone.md` → Workspace registry |
| Sidecar event routing | `standalone/src-tauri/src/routing.rs` (`route`, pure) and `dispatch_sidecar_event` in `lib.rs` | `standalone.md` → Routing (the table) |
| Transfer protocol | Source and target halves in `standalone/src/workspace-move.ts`; lib half in `lib/src/components/wall/workspace-transfer.ts` (`prepareWorkspaceTransfer`, `captureTransferContent`); Rust `begin_arrival` / `transfer_workspace_content` / `adopt_ready` / `adopt_done` / `hand_back_arrival` in `lib.rs`, `Arrival` in `routing.rs` | `standalone.md` → Transfer, Tear-out, Arrival queue; `transport.md` → Transferring a Workspace |
| Marks and since-mark replay | `mark` / `list` in `standalone/sidecar/pty-core.js`; `pty:marked` routing and bookkeeping in `routing.rs` / `lib.rs`; `serializeTerminal` / `flushTerminal` in `terminal-lifecycle.ts` | `transport.md` → Transferring a Workspace; `standalone.rationale.md` → Arrival queue |
| Crash durability of a transfer | `record_arrival_on_disk` / `forget_arrival_on_disk` / `restore_arrivals` in `standalone/src-tauri/src/lib.rs` (`sessions/arrivals.json`, merged at boot) | `standalone.md` → Arrival queue |
| Arrival deadline, replay suppression, hand-back replay | `ARRIVAL_MAX`, `expire_arrival`, `sweep_awaiting`, `hand_back_ids` in `standalone/src-tauri/src/routing.rs`; `begin_transfer` / `clear_suppression`, `spawn_arrival_watchdog`, `hand_back_arrival` in `standalone/src-tauri/src/lib.rs`; `acceptHandBackReplay` in `standalone/src/workspace-move.ts` | `standalone.md` → Arrival queue, Routing |
| Cross-window drag | `standalone/src/workspace-drag.ts` (release gate in `onDropOnOtherWindow`), `window_at_cursor` in Rust | `standalone.md` → Dragging a Workspace between windows |
| Quit and per-window close | `standalone/src/quit.ts`, `teardown-flow.ts`, `window-close.ts`; Rust `quit_state.rs`, `macos_terminate.rs` | `standalone.md` → Quit flow, Per-window close |
| Persistence and restore | `lib/src/lib/window-session-aggregator.ts`, `standalone/src/window-restore.ts`, Rust `save_session` etc. | `standalone.md` → Persistence; `transport.md` |
| `dor workspace` verbs, `dor list` | `dor/src/commands/workspace.ts`, `list.ts`, `dor/src/protocol.ts`, `dor/src/control-client.ts`, `dor/src/commands/types.ts`; window handler `lib/src/components/wall/workspace-control.ts`; router `dor-control-router.ts` | `dor-cli.md` → dor workspace, Standalone, Handle Model |
| Platform hooks Workspaces added | `onPtyMarked`, `transferWorkspace` on `PlatformAdapter` (`lib/src/lib/platform/types.ts`): both in `standalone/src/tauri-adapter.ts`, `onPtyMarked` alone in `browser-sidecar-adapter.ts` | `transport.md` |
| Browser harness | `standalone/scripts/dev-agent-browser.mjs` (`invokeMap`, `fireAndForget`), `browser-sidecar-adapter.ts` | `standalone.md` → Standalone browser-dev harness |

## 7. Rules that bite

- **Every Tauri `listen` must be `listenToWindow`** (`standalone/src/window-label.ts`). A bare `listen` receives every window's traffic; `standalone/scripts/window-listeners.test.mjs` fails the build otherwise. Broadcasts (`app.emit`) still reach scoped listeners.
- Workspace id allocation and reservation-failure fallback follow `docs/specs/standalone.md` → Workspace registry; use `createWorkspace()`.
- Session release boundaries follow `docs/specs/transport.md` → Transferring a Workspace and the `releaseSession` comment in `lib/src/lib/terminal-lifecycle.ts`.
- **`take_arrivals` does not consume**, and an arrival without content is not drainable. If you change the transfer sequence, keep: source invokes → Rust marks → source serializes → `transfer_workspace_content` → target nudged/built.
- **The routing lock is never held across an emit**, and the registry lock is taken only for `dor:controlRequest`. Read the comment above `dispatch_sidecar_event`.
- **Spec lint** rejects a bare file name in a `Source of truth:` line; use full repo paths. Each rationale `## Heading` must exist in the spec.
- **`DORMOUSE_NODE_BINARY`** must not point at the worktree's own `binaries/` file (see §2).

## 8. Known gaps

- The browser harness simulates one window; multi-window behavior is Tauri-only.
- The browser harness starts the sidecar directly behind an HTTP bridge, so the Rust ↔ sidecar stdio bridge runs only under Tauri, and a Mac run exercises no Windows ConPTY behavior.
- `dor list --all` still lists the answering window only (`dor-cli.md` → Future).
- A mark can fall inside an escape sequence the sidecar's parser is holding; the target's parser resynchronizes on the next ground byte, the same class of cut the old bounded replay made. Documented in `standalone.rationale.md` → Arrival queue.
- The alert stores in the sidecar are memory-only; a sidecar respawn loses them until a window re-seeds (the harness re-seeds on stream reconnect).
- `dor workspace move` reports `moved` only once the target adopted the Workspace; a hand-back is an error with its reason. `dor agent-browser` fails fast when no Wall answers; there is no CLI-side key fallback.
- The one-frame blank on switch-back and WKWebView context release are unverified (§5).

## Transfer findings (user-run Tauri, 2026-09-11 through 2026-09-14)

- `ascii-splash` mouse interaction failed after both tear-out and transfer into an existing window; resizing did not repair it, restarting the TUI did. Ordinary Workspace switching and window focus changes preserved mouse input.
- Moving a window's last Workspace into another window left stale TUI drawing until a resize. Tear-out drawing appeared correct.
- Earlier checks passed: switching, idle tear-out, stable cross-window refs, continuous numbered output without observed gaps, and identical retained scrollback before and after transfer.

Native follow-up checks passed:
- `ascii-splash` mouse interaction survives transfer after the mouse-mode fix.
- A transferred running command prompts before window close after preserving semantic state across the move.
- With a Workspace kill confirmation open, tearing out dismisses the source confirmation without killing the process; closing the destination asks again.
- Retained scrollback after 12,000 numbered lines had the same topmost line (10953) before and after transfer.

The shared "Confirm kill workspace" component now also handles app quit and window close, and renders the iframe move gate, whose modifier keys no longer answer it. Its automated tests pass; the replacement app-quit UI and the move gate's new key rule have not yet been manually tested. The last-Workspace merge redraw needs a specific native retest; the successful mouse retest does not establish that drawing result.
