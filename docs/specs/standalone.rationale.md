# Dormouse Standalone (Tauri) — Rationale

> Informative companion to [standalone.md](standalone.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Rust ↔ sidecar bridge

**Why managed-voice audio may ride the pipe when screenshots may not.** A screenshot streams on every settled frame; an utterance is at most one per window at a time, alarms are rare, and a 120-code-point label is well under 300 KB of base64 even at Hosted's 200-character cap. The temp-file path would leave spoken-label audio on disk between the sidecar's write and Rust's read, and an orphan whenever the invoke timed out first.

**What a sync blocking command cost.** A cold `agent-browser open` froze the webview for ~3 s — long enough to look like a pane that never appeared — and a hung one would have held it for the full 30 s `AGENT_BROWSER_TIMEOUT`; `(async)` moves the same blocking body onto a runtime worker. The incident is recorded at the `request_from_sidecar_timeout` invariant comment in `standalone/src-tauri/src/lib.rs`.

## Alerts

**Why an await's answer names its window.** Routed by the Session's `id` it would reach the Session's owner, not the window that parked it, and a `requestId` is what Rust's invoke matcher swallows. It was broadcast at first, each adapter matching its own random `awaitId`; `forWindow` routes it the way `pty:list` is routed, so no other window sees it (2026-09).

## Windows node subsystem

**The two Windows Node variants.** `CREATE_NO_WINDOW`, `DETACHED_PROCESS`, and `STARTUPINFO` hiding all failed to suppress Windows 11's DefTerm handoff from a GUI parent (verified 2026-08): Windows launches Windows Terminal to host the console-subsystem child, flashing a stray WT window behind Dormouse. Should a current spawn-time option suppress it, both variants collapse back to the stock console-subsystem Node under `DORMOUSE_NODE`. `dor`'s opposite requirement comes from running inside a shell's ConPTY, where its stdout/stderr are console handles rather than pipes.

**What the GUI node's directory on PATH cost, and why only dev builds.** Measured in a dev pane (Windows 11 25H2, 2026-09): `node` resolved to the patched `node.exe` in the dev app's `target/debug` at PATH position 4 — `isTTY` undefined, no `setRawMode`, PE subsystem 2 — ahead of pnpm's console-subsystem `node.EXE` at position 8 and the developer's own at 35, both reporting `isTTY` true. "Silent in both directions" is literal: stdin is at EOF so a reader dies at startup, and stdout is unattached so it cannot report why — writing the values to a file was the only way to observe them. The installed app was ruled out rather than assumed: Dormouse Terminal 0.11.0 ships the same GUI-subsystem `node.exe`, but neither its install directory nor any `target/debug` is in the persistent user or machine PATH a shortcut-launched app inherits, and panes add only `DORMOUSE_CLI_BIN` — so `node` there was already the developer's own, and the strip makes a dev pane match an installed one.

**Why the host names the directory instead of the sidecar deriving it.** `path.dirname(process.execPath)` was the first attempt and is wrong twice over: `standalone/scripts/dev-agent-browser.mjs` runs the sidecar under the developer's own node, so the strip would have removed the node it exists to protect, and the same module is the VS Code pty host (`vscode-ext/src/pty-host.js`), where that directory can be `/usr/bin` — dropping it from a pane's PATH would be destructive. Hence an explicit `DORMOUSE_GUI_NODE_DIR` from the side that patched the binary, and a win32-only strip.

## Boot sequence

**Why the peer-surface responder must follow `init()`.** Installed first, its seeding `status` command sits unanswered with no retry — nothing carries the answer back until the adapter has registered its listeners.

## Burrow service

**Why one file rather than one per value.** Per-value files leave a window between two writes in which the enrollment can end up describing a different Burrow than the ACL records approved under it.

**Why the correlation field cannot be `requestId`.** A `burrow:*` payload reusing that field has its results consumed by the invoke table, vanishing at random.

**Why the parse moved here rather than staying in the webview.** The webview is one consumer of a PTY the sidecar owns; an attached Client is another. Parsing in the webview meant the sidecar had to strip a second time for the phone, with the duplicate-answer hazards `docs/specs/terminal-escapes.rationale.md` records. Parsing where the PTY lives makes both consumers of one pass, at the price of two messages that used to be in-process calls and a theme this process cannot read for itself.

**Why a failed read must not be memoized.** The read errors that are neither `ENOENT` nor a parse failure — EACCES, EIO, a handle held open on Windows — say nothing about what the file holds; answering them empty, or caching that emptiness, lets the next save overwrite unseen state with nothing, since every change is a read-modify-write of the whole file.

## Application menu

WKWebView performs native edits (cut, copy, paste, select all) only through the application's Edit menu; with none, Cmd+C/X/V did nothing inside Tool iframes, whose keys Dormouse's own JS never sees. Tested in the dev build on macOS (2026-10): a chord whose keydown the page cancels never reaches the menu item, so the terminal and Dormouse's fields keep their JS handling without a double paste. WebView2 and WebKitGTK edit natively without a menu, and on those platforms menu accelerators would take Ctrl+C from the terminal before the page saw it.

## Siri affordance

**What it cost.** On 2026-09-28 the unified log showed Dormouse dwelling 707 times and building the affordance's host window 478 times in one day; no other app did either more than once. The same `NSCampoLightweightUIController` raised the assertion behind that week's macOS 27.0 crashes: a mouse-entered event reaching a tracking area it had just torn down.

**Why a per-view override.** Eligibility is process-wide: `+[NSCampoLightweightUIController isEligible]` is the `WritingTools/LightweightUI_macOS` feature flag, `isEnhancedSiriAvailable`, and a bundle identifier outside Apple's own services, so no Info.plist or bundle setting opts out. Its "zero-to-one" mode targets a caret with no selection, which is all xterm's textarea ever holds. The per-view gate is `allowsWritingToolsAffordance`, which WebKit answers YES for any editable focus. Measured with a `WKWebView` probe holding an xterm-shaped textarea through 20 s of synthetic typing (macOS 27.0, 2026-09-28):

| Variant | Affordance built |
|---|---|
| Baseline | 11 |
| `writingsuggestions="false"` on the textarea | 11 |
| `WKWebViewConfiguration.writingToolsBehavior = none` | 12 |
| `allowsWritingToolsAffordance` answering NO on a `WKWebView` subclass | 0 |

In a real build the same day, with the xterm textarea focused and typed into, a build without the override built the affordance, and a build with it answered NO and built none. The live webview's `object_getClass` there is KVO's `NSKVONotifying_` subclass, which is why the override asks the object for `class`.

## Windows

**Why no window is throttled in the background.** The alert host moved into the sidecar (§Alerts), but a due spoken alarm still plays in the renderer of the window showing its Session (`docs/specs/alert.md` → Spoken alarms), on that window's timers and Web Speech engine. Tauri's default leaves WebKit's policy in force: a minimized or hidden window's timers are throttled and the view may be suspended after roughly five minutes, pausing everything until it is visible again (tauri-utils 2.9.3, `BackgroundThrottlingPolicy`). That delayed the speech for exactly the window a spoken alarm exists to reach — the one the user minimized. The policy cannot be set per state, so every window pays a hidden window's timer cost for it (2026-09).

## Workspace registry

**Why a persisted high-water mark, not the disk scan alone.** The scan sees only what is still saved: closing the highest-numbered Workspace or window deletes it from disk, so the next launch minted its number again, and a `dor` ref an agent cached named a stranger. The file holds a ceiling (hi/lo): a raise writes it once per slack's worth of numbers rather than on every create, keeping a create clear of the atomic write's fsyncs, and a relaunch starts at the ceiling, leaving a gap of at most the slack. Running in memory when the state root or the write fails keeps every create working; only a later launch may then reuse a number.

**Why `ids.json` sits in the state root, not `sessions/`.** `sessions/` is enumerated as window snapshots and swept at boot, and a per-window close removes what it owns there; the counters belong to no window.

## Routing

Rust routes rather than the webview filtering, because a webview cannot be trusted to drop another window's bytes: it would still have received them, and `pty:data` is the hot path.

Tauri delivers an `emit_to` event to **any** listener registered with the default `Any` target — `match_any_or_filter` in its event listener short-circuits before the target filter runs — and the JS `listen()` registers exactly that. The first two-window build therefore had each window taking the other's `pty:list` at boot and adopting its PTYs as unowned, which corrupted both snapshots; nothing errored. Measured against tauri 2.11.5, 2026-09.

An unowned id was broadcast at first, on the reasoning that "an id nobody minted is not a routing decision anyone can make". It is: every PTY in this process is minted in `pty_spawn`, so an unowned id is one whose window went away, and the broadcast reached every sibling's AlertManager — which rang, and offered a TODO, for a pane none of them showed.

**Why an exited PTY stays owned.** Ownership used to end at the exit, since nothing more was emitted for a dead PTY. The sidecar's manager publishes `alert:state` for it whenever the user acts on the exited pane — a dismiss, a TODO cleared — and a line for an unowned id is dropped, so the pane would ring until it was closed. An exit before a transfer's mark used to end the marking phase and go to the target, so the `pty:marked` behind it went there too, and the source — which serializes the pane at that line — never saw its mark (2026-09).

**Why the derived streams are dropped, never held.** The first hold queued both, on the premise that neither is in any replay. They are: the replay is the raw bytes, OSCs included, and the receiving window re-parses them. The flushed queue re-applied `commandStart` on top of state the replay had just rebuilt, and `commandStart` is not idempotent — it mints a fresh id and consumes the pending command line — so a transfer that split a command's `commandLine` from its `commandStart` left the arriving window with a derived title for a command whose real line the replay had already recovered. A hold kept for the Tool events alone served only the fail-open sweep, which fires only for suppressions no arrival claims (§Arrival queue), and it went (2026-09).

## What a window's `Destroyed` settles

Tauri removes a label from `webview_windows()` only when the window is actually destroyed, not when `destroy()` is called. `finish_window_close` pushed the sidecar's window list right after `destroy()`, so the list it computed still named the window that was going away, and the Burrow's ask collector then waited that window's whole `ASK_BUDGET_MS` on every subsequent ask. The same ordering made the quit machine's `forget_window` fire before the label was gone.

## Boot and geometry

`tauri-plugin-window-state` would have been a second store answering "which windows exist", a new Cargo *and* npm dependency riding the disclosure regeneration and the cooldown, and it still would not have done the boot enumeration — which is already Rust's job, beside the snapshots it reads.

The cap is a ceiling on one launch, not a limit on how many windows may exist: the excess snapshots stay on disk untouched, so raising the cap restores them.

The minimum exists because macOS edge tiling could leave a window with no minimum zero-thick, and the restore floor because that box was then saved and reopened just as thin (2026-10). The overlap test catches a box saved on a display unplugged since, which would otherwise reopen where nobody can see it.

## Transfer

The `adopt_ready` hop exists because the alternative is a race with no safe side. If Rust listed and replayed as part of the transfer, the target's collector might not be armed yet and the replay would be lost; if the target armed first and asked for the whole Window, it would take every sibling's PTY. Asking for exactly the suppressed set, only once the collector exists, has neither failure.

The suppression window is what makes "no duplicate, no loss" true. `pty-core` appends to its replay buffer synchronously before it emits, and Rust's single reader thread processes sidecar lines in order — so a chunk emitted between the ownership move and the replay is dropped once and present in the replay exactly once (`pty-core.test.js`, "a chunk emitted just before list([id]) appears in the replay exactly once").

It fails open after 5 s rather than closed: a transfer whose `adopt_ready` never arrived would otherwise silence its panes for the rest of the session, and duplicated bytes are recoverable where a dead pane is not. That fail-open is now scoped to suppressions no arrival record claims, which is the same argument with the "never arrived" case actually detectable — an arrival that is genuinely stuck ends at `adopt_failed` or at the target's `Destroyed`, not at a timer.

## Arrival queue

A target whose `adopt_done` is refused already has the arrival payload needed to release its Sessions. Preparing a new transfer first re-entered Tool startup checks and could throw while ownership was already back at the source; unwinding directly also avoids sending `adopt_failed` for that retired arrival.

**Why the mark is stamped in the stream rather than asked for.** A mark fetched by request answers at some instant the sidecar chose, while the source's xterm stands at whatever `pty:data` had reached it — two clocks nothing aligns, so a serialization taken against a fetched mark either repeats or loses the bytes between them. A `marked` line written into the same stdout as the data is ordered with it by construction: the sidecar's reader is one thread, Rust's reader is one thread, and the webview's event queue is one queue. The one gap left is the parser's incomplete-sequence buffer, which can hold bytes older than the mark past it; that tail is the same class of cut the bounded replay always made, and the target's parser resynchronizes on the next ground byte (2026-09).

**Why a hand-back replays since the mark, and only the marked ids.** The first hand-back returned the ids unsuppressed and silent: the source's xterm stood at the mark, and every byte from there to the hand-back had gone to a target that never mounted it — dropped while suppressed, or painted in a webview that then closed. The since-mark replay is the arrival's own second half aimed back at the source, which is why it rides the same `pty:requestInit` and the same suppression-lifting `pty:replay` path rather than a new message. An id the content did not mark has no such gap: the source either saw every byte live or serialized the whole buffer it still holds, and the sidecar's only answer for an unmarked id is that whole buffer again (2026-09).

**Why one keyed record.** The first build emitted `workspace-arriving` straight at the target; a window torn out seconds earlier, or one restoring at launch, had no listener yet, so the payload went nowhere while the source dropped its tab, leaving live Sessions owned by a window with no pane for them. Queueing fixed delivery but not bookkeeping: the suppression map, the departure list, the boot list and the sweep each held a piece of the arrival and inferred the rest, so `adopt_ready` resumed two arrivals over each other, one landing released every Workspace a source had sent, the sweep lifted a live arrival's suppression on a slow boot, and a boot list placed arriving shells as loose panes. The record keyed by `workspaceId` fixed all five at once.

Two phases rather than one, because the target can genuinely refuse. A release at the invoke was safe only while nothing could go wrong between the invoke and the mount; closing the target mid-arrival made the Workspace's Sessions live and ownerless. Holding the source's state until `workspace-departed` costs a transferring Workspace being briefly absent from the snapshot — deliberate, since the alternative is both windows persisting it and a relaunch restoring it twice.

`take_arrivals` stopped consuming for the same reason: consuming made the drain the point of no return, and a webview that drained and then failed had nothing left to fall back on. With the record settling at `adopt_done` the drain is idempotent, and a reload mid-arrival finds its Workspace again instead of losing it. The webview's `adopting` set is what makes repeated drains safe.

The pending-arrival record is its own file rather than an entry staged into a snapshot. The first durability attempt wrote the arriving Workspace into the target's `sessions/<label>.json` at the invoke and it failed two ways. A torn-out window then had a snapshot before it opened, and `bootFromTearOut` reads "this window has a snapshot" as "this is an ordinary restore": the new window cold-restored the staged copy over fresh shells, drained the arrival, and threw `Duplicate Workspace id` adopting the real one — the tear-out was handed back and both windows persisted the id. And for a transfer into a live window the staged entry did not survive to adoption: `getWindowSnapshot` iterates the target's store, which does not hold the Workspace yet, so the target's next debounced flush (500 ms after any change, inside the 3 s arrival timeout) rewrote its file without it. A file neither webview writes has neither problem, and merging it at boot is the only moment no flush can race it.

## Dragging a Workspace between windows

Spiked before the drag was built, because it was the one unverified platform assumption and the fallback (a Rust `cursor_position()` polling loop driven by the source's own pointer events) was a different design.

A WKWebView pointer captured on an element keeps receiving `pointermove` and `pointerup` far outside the window, with client coordinates that run past the edges and negative rather than clamping — measured against macOS 26.6 / WKWebView, 2026-09, by synthesizing an AppKit drag whose later points fall outside a 400×300 window and reading the page's own event log: `down` inside the element, then moves at client x 600 and (900, −152), then the release. So the gesture stays the webview's throughout and no polling loop is needed.

## Persistence

**The WKWebView WAL measurement.** WKWebView stores `localStorage` as SQLite in WAL mode, and WebKit pins that WAL with a long-lived reader that never advances during a running session — so it is never checkpointed, and an external checkpoint is blocked by the same reader. Rewriting the multi-MB scrollback-bearing session blob on every save grew the WAL to ~1 GB within a few hours (recorded 2026-07); a days-long session made it pathological. The Rust file store that replaced it has no WAL and rewrites the same file each time.

**Why the sessions directory is fsynced after the rename.** Fsyncing only the temp file leaves the new name recoverable-but-absent after a power loss; a successful directory-entry fsync makes the rename durable. Its failure is ignored, so this step is best-effort. Windows has no equivalent concept, hence unix-only.

**Why the mode is set before the bytes.** Under the bare umask the transcript-bearing blob lands `0644` in a `0755` directory any other local account can read, and tightening after the write would leave a window in which it was readable. Continuing after a permission failure would contradict the owner-only guarantee; aborting before writing preserves the previous snapshot and leaves at most an empty temp file.

**Why the ACE test asserts an already-existing file.** On an upgrade the Burrow enrollment file is already there, so what tightens it is propagation onto an existing entry rather than create-time inheritance. `FileBurrowStateStore`'s own `0700`/`0600` cannot help on Windows: Node has no ACL API.

**What the teardown flush lost.** The pre-Rust path flushed the session on teardown into WebKit `localStorage` and lost the final debounce/heartbeat window; awaiting the write pipeline to disk (`drainSessionSaves`) recovers it, which a last fire-and-forget save would not.

**Why debug keeps a state subtree as well as the wrapper identifier.** The native dev wrapper already selects a stable per-worktree Tauri identifier, including a separate Burrow store. Raw Tauri dev bypasses that wrapper and can use the installed identifier; the subtree protects its session and recovery files without changing where that identifier’s enrollment lives. Older debug builds used the identifier root directly, so their snapshots need targeted transcript migration after the split. Deleting those snapshots could remove installed layouts for a raw-dev launch.

## Trigger interception

**Why the app menu's Quit item is custom.** Tauri hands `PredefinedMenuItem::quit` to muda, whose macOS implementation sends `terminate:` to `NSApp` (`muda-0.19.1/src/platform_impl/macos/mod.rs`); tao's app delegate implements `applicationWillTerminate:` and nothing else (`tao-0.35.2/src/platform_impl/macos/app_delegate.rs`), so no `RunEvent::ExitRequested` is ever raised for it. The same hole swallowed the Dock's Quit item, `osascript`, logout and restart. Cheap while a quit was only a confirmation; expensive once quit captures agent recovery and writes the final snapshot.

`applicationShouldTerminate:` is added to the *live* delegate's class rather than to a delegate of our own, because replacing `NSApp.delegate` would take tao's window and application callbacks with it. `class_addMethod` refuses when the class already implements the selector, which is the signal that a tao upgrade has started handling this itself.

**Why hold, never refuse.** `NSTerminateCancel` reaches loginwindow as `userCanceledErr`, which aborts a logout or restart outright: on 2026-10-03 a restart reached Dormouse after loginwindow had begun quitting the other apps, Dormouse answered Cancel to start its own flow, and the session sat half logged out — no Dock, no Mission Control, apps launching without windows — until the restart was cancelled by hand half an hour later (loginwindow: `kAEAnswer event with a userCanceledErr`, `Got a valid appname : Dormouse Terminal`). `NSTerminateLater` is AppKit's documented way to finish work first, and loginwindow waits for it. Measured with a probe app on macOS 27.0.1, 2026-10: while held, AppKit runs a nested loop in `NSModalPanelRunLoopMode` until `replyToApplicationShouldTerminate:`; a second terminate never reaches the delegate; the reply only records the answer and AppKit acts once the nested loop regains control; No returns the app to the default mode; and `[NSApp stop:]` with tao's dummy event does **not** end the nested loop — the app hangs, which is why every exit while held must reply instead. tao's observers, timer and wake source are in `kCFRunLoopCommonModes` (`tao` fork `observer.rs`, `event_loop.rs`), so the flow keeps running inside the nested loop; Yes ends in `applicationWillTerminate:`, which tao turns into `LoopDestroyed` and tauri-runtime-wry into `RunEvent::Exit`, so the sidecar shutdown still runs.

## Quit flow

**Why the two teardown flows arbitrate.** They are independent machines that share one single-slot confirm store, and the store simply returned when a second `openQuitConfirm` arrived. The second flow's context was never settled, so its `phase` stayed `confirming` for the life of the window: a quit that met an open close dialog never voted, and Rust's phase-2 wait is unbounded by design because it waits on a human. The broadcast `quit-cancelled` made it worse by dismissing whichever dialog was open — including a close's — without telling its flow.

Arbitrating fixed the dialog and left the vote: a quit meeting a *committed* close acked and stopped, which is the same unbounded wait reached by a different route. Voting is right because the window really is ending.

**Why the walk ends on `main`, and why the grant to every window was reverted.** Widening `updater:*` to every window was meant to cover a session whose `main` was closed. It covers nothing: only `main` runs the periodic check, so only `main` can be holding a downloaded update, and a `main`-less session has none to install whichever window goes last. The grant traded a structural guarantee — the install can only happen in the window torn down last — for a case that cannot arise. What that session does need is to be told, which is the close confirmation's "this throws away the downloaded update" arm. The periodic check stays in `main` because it is a timer, not a capability, and one per window would be N checks against the endpoint.

**Why the teardown ordering survived the transcript removal.** Flush → graceful kill → flush → drain was built to capture the final scrollback of dying terminals into the persisted session. The transcripts are gone, but the shape is still what makes the *structure* correct: the first flush reads cwds while the shells are alive, and the second catches whatever changed as they died, retaining the earlier cwd for a PTY `getCwd` can no longer answer.

**Why the capture goes first and cannot abort the rest.** The resume hint exists only in the window between the interrupt and the kill, so no later step can reconstruct it — but it is also the step most likely to be slow or to fail, and losing an agent's resume is much cheaper than losing the layout, cwds, and notes behind it.

## Restart

**Why not `AppHandle::request_restart`.** It raises `ExitRequested` with `RESTART_EXIT_CODE`, and `ExitRequestApi::prevent_exit` ignores that code (`tauri-2.11.5/src/app.rs`). A restart would slip past the unapproved-exit guard and the hand-back cleanup gate, and the watchdog and `Destroyed` exits, which call `app.exit(0)`, would drop the relaunch. Relaunching from `RunEvent::Exit` keeps one exit path. That exit stops tao's run loop with `[NSApp stop:]`, never `terminate:` (`tao-0.35.2/src/platform_impl/macos/app_state.rs`), so the spliced `applicationShouldTerminate:` sees only OS-initiated terminates. Checked 2026-09.

**Why the refusals.** Under `tauri dev` the relaunched binary outlives the CLI and the Vite server it loads from. `tauri::process::restart` just calls `exit(0)` when `current_binary` fails — on macOS, for a path through a symlink (`tauri-utils-2.9.3/src/platform/starting_binary.rs`) — so the check turns a silent quit into an answer.

## UI watchdog

**The hang.** 2026-10-03, a dogfood build: WebContent at 100% CPU with the sidecar and every PTY idle. `sample` showed one `DOMTimer` firing into a `performMicrotaskCheckpoint` that never returned: the Tool reaper re-asking a Tool that declined to stop (fixed in #992). Nothing could name the JavaScript: the frames are unsymbolicated JIT, SIP blocks a debugger on the Apple-signed XPC service, and release webviews are not inspectable. `kill` (SIGTERM) left the process running; `kill -9` brought the window back on its live shells, with no work lost.

**Why sample, then kill.** The sample is the only evidence a release hang leaves, and only while the process lives. `_webProcessIdentifier` is private WKWebView API (present on macOS 27, checked with `respondsToSelector:` before use); no public API names the process.

**Why a script evaluation.** A page-side timer is throttled when a window is hidden, and a host-side `evaluateJavaScript` is not; its completion handler is one round trip, where an event plus an `invoke` answer was two. The probe's clock starts on the host main thread, because a native modal there delays delivery, not the page. A window minimized for three minutes was never restarted (2026-10-03).

**Why 5 s.** Chosen 2026-10-03 over 30 s, accepting that a restart loses state that lives in the webview alone, unsaved Tool edits included. The restore, first render, and a reload happen before the page arms. Stalls after arming still can: cross-origin Tool and `dor iframe` pages run in the page's WebContent process (one process served three Tool iframes during the 2026-10-03 hang), so a page blocking for 5 s, or a large file a viewer parses synchronously, restarts the whole UI. The 30 s repeat threshold keeps a stall that recurs on every boot from becoming a restart loop.

## Objective-C exceptions

**The crash.** Six aborts of installed 1.1.0 builds, 2026-09-21 to 2026-09-28 on macOS 27.0 (26A428), all `EXC_CRASH (SIGABRT)` on the main thread with one stack shape. The binary is stripped, so the frame was matched by disassembly: tao's `sendEvent:` override (the `NSKeyUp` + Command test), whose LSDA maps the landing pad taken to its `objc_msgSendSuper(sendEvent:)` call, the pad calling `panic_cannot_unwind`. For each crash still in log retention (three), the unified log shows `[com.apple.AppKit:CampoLightweightUI] Mouse entered.` then `*** Assertion failure in NSCampoLightweightUIController.m:1429` about 1 ms before the abort: an AppKit race in the Siri affordance for selected text, raised beneath `[super sendEvent:]`. An abort in the landing pad, rather than an uncaught-exception report, means the unwinder's search phase had found a handler above the frame, so AppKit would have caught it.

**Why both halves.** Measured 2026-09-28 (rustc 1.96, tao 0.35.2) with an `NSException` raised beneath `[super sendEvent:]`: stock tao aborts under both strategies; patched tao aborts under `abort` and survives under `unwind`; with the abort hook the exception is survived and a Rust panic still exits by SIGABRT. The rustc rule is `fn_can_unwind`: under `panic=abort` every Rust-defined function is non-unwinding, whatever its ABI. The hook keeps today's fail-fast, so no Rust panic unwinds past a lock. End to end on the same day: a release build of the change, with a dylib swizzling `-[NSApplication sendEvent:]` to raise on an injected application-defined event, logged the raise beneath `TaoApp`'s override and was still running 3 s later. Cost: the arm64 release binary grew from 8.4 MB (the installed 1.1.0 `abort` build) to 10.4 MB.

**Handler path.** Measured the same day, under the fork and `unwind`: an `NSException` raised inside the tao event handler aborts with "Rust cannot catch foreign exceptions" at `stop_app_on_panic`'s `catch_unwind`. Calling the handler without `catch_unwind` kept the process alive but wedged the loop, so the handler never ran again: tao's loop state is not exception-safe, and a clean abort beats a hung window.

**Dead approach.** `objc2::exception::catch` around the super call: the closure it runs is a Rust frame, so under `abort` the unwind dies before reaching its `@catch`.

**Not patched.** wry's `define_class!` callbacks are already `C-unwind`. Its URL-scheme `start_task` / `stop_task` are `extern "C"`, but they are outside the AppKit event path and nothing catches above them.

## Standalone browser-dev harness

**Why the bridge token is not the `dor` control token.** The `dor` control-API `controlToken` is handed to every shell Dormouse spawns; the bridge's circle is smaller than "every terminal on the machine", so it mints its own per-run credential.

**Why the CORS origin is never `*`.** It was `*` once: the bridge's clipboard invokes were readable cross-origin under it — a foreign page could POST an invoke and read the reply.

**Agent workflows were unaffected by the gate.** The token reaches the page through the `VITE_DORMOUSE_BROWSER_DEV_HOST` env var the harness already sets, and `agent-browser` drives the Vite origin, never the bridge.
