# Dormouse Standalone (Tauri) — Rationale

> Informative companion to [standalone.md](standalone.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "What, not why"). Nothing here is normative.

## Rust ↔ sidecar bridge

**What a sync blocking command cost.** A cold `agent-browser open` froze the webview for ~3 s — long enough to look like a pane that never appeared — and a hung one would have held it for the full 30 s `AGENT_BROWSER_TIMEOUT`; `(async)` moves the same blocking body onto a runtime worker. The incident is recorded at the `request_from_sidecar_timeout` invariant comment in `standalone/src-tauri/src/lib.rs`.

## Windows node subsystem

**The two Windows Node variants.** `CREATE_NO_WINDOW`, `DETACHED_PROCESS`, and `STARTUPINFO` hiding all failed to suppress Windows 11's DefTerm handoff from a GUI parent (verified 2026-08): Windows launches Windows Terminal to host the console-subsystem child, flashing a stray WT window behind Dormouse. Should a current spawn-time option suppress it, both variants collapse back to the stock console-subsystem Node under `DORMOUSE_NODE`. `dor`'s opposite requirement comes from running inside a shell's ConPTY, where its stdout/stderr are console handles rather than pipes.

## Boot sequence

**Why the peer-surface responder must follow `init()`.** Installed first, its seeding `status` command sits unanswered with no retry — nothing carries the answer back until the adapter has registered its listeners.

## Burrow service

**Why one file rather than one per value.** Per-value files leave a window between two writes in which the enrollment can end up describing a different Burrow than the ACL records approved under it.

**Why the correlation field cannot be `requestId`.** A `burrow:*` payload reusing that field has its results consumed by the invoke table, vanishing at random.

**Why the parse moved here rather than staying in the webview.** The webview is one consumer of a PTY the sidecar owns; an attached Client is another. Parsing in the webview meant the sidecar had to strip a second time for the phone, with the duplicate-answer hazards `docs/specs/terminal-escapes.rationale.md` records. Parsing where the PTY lives makes both consumers of one pass, at the price of two messages that used to be in-process calls and a theme this process cannot read for itself.

**Why a failed read must not be memoized.** The read errors that are neither `ENOENT` nor a parse failure — EACCES, EIO, a handle held open on Windows — say nothing about what the file holds; answering them empty, or caching that emptiness, lets the next save overwrite unseen state with nothing, since every change is a read-modify-write of the whole file.

## Routing

Rust routes rather than the webview filtering, because a webview cannot be
trusted to drop another window's bytes: it would still have received them, and
`pty:data` is the hot path.

Tauri delivers an `emit_to` event to **any** listener registered with the default
`Any` target — `match_any_or_filter` in its event listener short-circuits before
the target filter runs — and the JS `listen()` registers exactly that. The first
two-window build therefore had each window taking the other's `pty:list` at boot
and adopting its PTYs as unowned, which corrupted both snapshots; nothing
errored. Measured against tauri 2.11.5, 2026-09.

An unowned id was broadcast at first, on the reasoning that "an id nobody minted
is not a routing decision anyone can make". It is: every PTY in this process is
minted in `pty_spawn`, so an unowned id is one whose window went away, and the
broadcast reached every sibling's AlertManager — which rang, and offered a TODO,
for a pane none of them showed.

The first hold queued both derived streams, on the premise that neither is in
any replay. Semantic events are: the replay is the raw bytes, OSCs included, and
the target's replay listener re-parses them. The flushed queue then re-applied
`commandStart` on top of state the replay had just rebuilt, and `commandStart`
is not idempotent — it mints a fresh id and consumes the pending command line —
so a transfer that split a command's `commandLine` from its `commandStart` left
the arriving window with a derived title for a command whose real line the
replay had already recovered. What the replay path genuinely did not rebuild was
the AlertManager's copy, and that is a listener fix, not a routing one.

## What a window's `Destroyed` settles

Tauri removes a label from `webview_windows()` only when the window is actually
destroyed, not when `destroy()` is called. `finish_window_close` pushed the
sidecar's window list right after `destroy()`, so the list it computed still
named the window that was going away, and the Burrow's ask collector then waited
that window's whole `ASK_BUDGET_MS` on every subsequent ask. The same ordering
made the quit machine's `forget_window` fire before the label was gone.

## Boot and geometry

The flush thread ran `window.scale_factor()` while holding the rect cache. Off
the main thread both that and `is_minimized()` post to the event loop and block
on the reply, and the main thread reaches the same cache from `window_at_cursor`
— which a cross-window drag calls ~16 times a second. `refresh_rect` takes the
scale rather than the window so the shape cannot come back by accident.

The flush also cleared its "a thread is coming" flag after taking the dirty set
rather than with it. A `Moved` landing in that gap was marked dirty and then saw
the flag still set, so it scheduled nothing — and a window whose last move is its
final position simply never had that position written.

`tauri-plugin-window-state` would have been a second store answering "which
windows exist", a new Cargo *and* npm dependency riding the disclosure
regeneration and the cooldown, and it still would not have done the boot
enumeration — which is already Rust's job, beside the snapshots it reads.

The cap is a ceiling on one launch, not a limit on how many windows may exist:
the excess snapshots stay on disk untouched, so raising the cap restores them.

## Transfer

The `adopt_ready` hop exists because the alternative is a race with no safe
side. If Rust listed and replayed as part of the transfer, the target's
collector might not be armed yet and the replay would be lost; if the target
armed first and asked for the whole Window, it would take every sibling's PTY.
Asking for exactly the suppressed set, only once the collector exists, has
neither failure.

The suppression window is what makes "no duplicate, no loss" true. `pty-core`
appends to its replay buffer synchronously before it emits, and Rust's single
reader thread processes sidecar lines in order — so a chunk emitted between the
ownership move and the replay is dropped once and present in the replay exactly
once (`pty-core.test.js`, "a chunk emitted just before list([id]) appears in the
replay exactly once").

It fails open after 5 s rather than closed: a transfer whose `adopt_ready` never
arrived would otherwise silence its panes for the rest of the session, and
duplicated bytes are recoverable where a dead pane is not. That fail-open is now
scoped to suppressions no arrival record claims, which is the same argument with
the "never arrived" case actually detectable — an arrival that is genuinely stuck
ends at `adopt_failed` or at the target's `Destroyed`, not at a timer.

## Arrival queue

**Why the mark is stamped in the stream rather than asked for.** A mark fetched
by request answers at some instant the sidecar chose, while the source's xterm
stands at whatever `pty:data` had reached it — two clocks nothing aligns, so a
serialization taken against a fetched mark either repeats or loses the bytes
between them. A `marked` line written into the same stdout as the data is
ordered with it by construction: the sidecar's reader is one thread, Rust's
reader is one thread, and the webview's event queue is one queue. The one gap
left is the parser's incomplete-sequence buffer, which can hold bytes older
than the mark past it; that tail is the same class of cut the bounded replay
always made, and the target's parser resynchronizes on the next ground byte
(2026-09).



**Why a hand-back replays since the mark, and only the marked ids.** The first
hand-back returned the ids unsuppressed and silent: the source's xterm stood at
the mark, and every byte from there to the hand-back had gone to a target that
never mounted it — dropped while suppressed, or painted in a webview that then
closed. The since-mark replay is the arrival's own second half aimed back at the
source, which is why it rides the same `pty:requestInit` and the same
suppression-lifting `pty:replay` path rather than a new message. An id the
content did not mark has no such gap: the source either saw every byte live or
serialized the whole buffer it still holds, and the sidecar's only answer for
an unmarked id is that whole buffer again (2026-09).

The first build emitted `workspace-arriving` straight at the target. A window
torn out seconds earlier, or one restoring at launch, has no listener yet and is
a perfectly ordinary drop target — the payload went nowhere, and because the
departure was announced in the same breath, the source dropped its tab too. The
Workspace's Sessions were then alive, owned by a window with no pane for them.

Queueing fixed the delivery but not the bookkeeping, and the follow-up review
found five symptoms of one gap: the arrival was not a single keyed thing. The
suppression map, the departure list, the boot list and the sweep each held a
piece and each inferred the rest, so `adopt_ready` answered with "everything
suppressed for this window" (two arrivals resumed over each other), a departure
announced every Workspace a source had sent to that window (one landing released
them all), the sweep could lift a live arrival's suppression on a slow boot, and
a boot list placed an arriving Workspace's shells as loose panes. The record
keyed by `workspaceId` is the fix for all five at once, which is why it is one
change rather than five.

Two phases rather than one, because the target can genuinely refuse. A release at
the invoke was safe only while nothing could go wrong between the invoke and the
mount; closing the target mid-arrival made the Workspace's Sessions live and
ownerless. Holding the source's state until `workspace-departed` costs a
transferring Workspace being briefly absent from the snapshot — deliberate, since
the alternative is both windows persisting it and a relaunch restoring it twice.

`take_arrivals` stopped consuming for the same reason: consuming made the drain
the point of no return, and a webview that drained and then failed had nothing
left to fall back on. With the record settling at `adopt_done` the drain is
idempotent, and a reload mid-arrival finds its Workspace again instead of losing
it. The webview's `adopting` set is what makes repeated drains safe.

The pending-arrival record is its own file rather than an entry staged into a
snapshot. The first durability attempt wrote the arriving Workspace into the
target's `sessions/<label>.json` at the invoke and it failed two ways. A torn-out
window then had a snapshot before it opened, and `bootFromTearOut` reads "this
window has a snapshot" as "this is an ordinary restore": the new window
cold-restored the staged copy over fresh shells, drained the arrival, and threw
`Duplicate Workspace id` adopting the real one — the tear-out was handed back and
both windows persisted the id. And for a transfer into a live window the staged
entry did not survive to adoption: `getWindowSnapshot` iterates the target's
store, which does not hold the Workspace yet, so the target's next debounced
flush (500 ms after any change, inside the 3 s arrival timeout) rewrote its file
without it. A file neither webview writes has neither problem, and merging it at
boot is the only moment no flush can race it.

## Dragging a Workspace between windows

Spiked before the drag was built, because it was the one unverified platform
assumption and the fallback (a Rust `cursor_position()` polling loop driven by
the source's own pointer events) was a different design.

A WKWebView pointer captured on an element keeps receiving `pointermove` and
`pointerup` far outside the window, with client coordinates that run past the
edges and negative rather than clamping — measured against macOS 26.6 / WKWebView,
2026-09, by synthesizing an AppKit drag whose later points fall outside a
400×300 window and reading the page's own event log: `down` inside the element,
then moves at client x 600 and (900, −152), then the release. So the gesture
stays the webview's throughout and no polling loop is needed; the drag
controller must simply not assume in-range coordinates.

## Persistence

**The WKWebView WAL measurement.** WKWebView stores `localStorage` as SQLite in WAL mode, and WebKit pins that WAL with a long-lived reader that never advances during a running session — so it is never checkpointed, and an external checkpoint is blocked by the same reader. Rewriting the multi-MB scrollback-bearing session blob on every save grew the WAL to ~1 GB within a few hours (recorded 2026-07); a days-long session made it pathological. The Rust file store that replaced it has no WAL and rewrites the same file each time.

**Why the sessions directory is fsynced after the rename.** Fsyncing only the temp file leaves the new name recoverable-but-absent after a power loss; the directory-entry fsync is what makes the rename itself durable. Windows has no equivalent concept, hence unix-only.

**Why the mode is set before the bytes.** Under the bare umask the transcript-bearing blob lands `0644` in a `0755` directory any other local account can read, and tightening after the write would leave a window in which it was readable. Continuing after a permission failure would contradict the owner-only guarantee; aborting before writing preserves the previous snapshot and leaves at most an empty temp file.

**Why the ACE test asserts an already-existing file.** On an upgrade the Burrow enrollment file is already there, so what tightens it is propagation onto an existing entry rather than create-time inheritance. `FileBurrowStateStore`'s own `0700`/`0600` cannot help on Windows: Node has no ACL API.

**What the teardown flush lost.** The pre-Rust path flushed the session on teardown into WebKit `localStorage` and lost the final debounce/heartbeat window; awaiting the write pipeline to disk (`drainSessionSaves`) recovers it, which a last fire-and-forget save would not.

**What a record build costs.** `getCwd` is a synchronous `execFileSync('lsof', …)` in the sidecar on macOS (`getCwdForPid` in `standalone/sidecar/pty-core.js`), one round trip per terminal pane, on every debounced save and every 30 s heartbeat. That price is why the dirty triggers are keyed to the owning Workspace: an unkeyed trigger would make every idle Workspace pay it whenever any Workspace moved.

**Why a timed-out boot list is asked again rather than acted on.** `timedOut` is the whole difference between "the host holds nothing" and "the host never answered", and `resumeOrRestoreFrom` cannot tell them apart — it cold-restores over the second, starting a second set of shells on top of the ones still running. The arrival path already refused rather than restore; the ordinary boot path had no such guard, and a launch slower than the 500 ms budget (a cold sidecar behind an antivirus scan, a laptop waking) is exactly when it bites. A retry is cheap in the case that matters and free in every other: an empty list still resolves the moment it arrives.

**Why the aggregator debounces on top of the Wall's own debounce.** Each Wall already coalesces its own record; the second stage coalesces *across* Walls, so one window-wide event (a store change, a theme push, a burst of output in two Workspaces) becomes one host write rather than one per Workspace.

**Why the dev state root is a subtree rather than a separate identifier.** `app_data_dir()` is derived from the Tauri identifier, and changing the identifier for debug builds would move the notepad archive and the Burrow enrollment too — stranding a developer's notes and forcing a re-pair on every switch between the dev and installed app. A subtree splits exactly the state that is a copy of the user's window and shares the rest.

## Trigger interception

**Why the app menu's Quit item is custom.** Tauri hands
`PredefinedMenuItem::quit` to muda, whose macOS implementation sends
`terminate:` to `NSApp` (`muda-0.19.1/src/platform_impl/macos/mod.rs`); tao's app
delegate implements `applicationWillTerminate:` and nothing else
(`tao-0.35.2/src/platform_impl/macos/app_delegate.rs`), so no
`RunEvent::ExitRequested` is ever raised for it. The same hole swallowed the
Dock's Quit item, `osascript`, logout and restart. Cheap while a quit was only a
confirmation; expensive once quit captures agent recovery and writes the final
snapshot.

`applicationShouldTerminate:` is added to the *live* delegate's class rather than
to a delegate of our own, because replacing `NSApp.delegate` would take tao's
window and application callbacks with it. `class_addMethod` refuses when the
class already implements the selector, which is the signal that a tao upgrade
has started handling this itself.

## Quit flow

**Why the two teardown flows arbitrate.** They are independent machines that
share one single-slot confirm store, and the store simply returned when a second
`openQuitConfirm` arrived. The second flow's context was never settled, so its
`phase` stayed `confirming` for the life of the window: a quit that met an open
close dialog never voted, and Rust's phase-2 wait is unbounded by design because
it waits on a human. The broadcast `quit-cancelled` made it worse by dismissing
whichever dialog was open — including a close's — without telling its flow.

Arbitrating fixed the dialog and left the vote: a quit meeting a *committed*
close acked and stopped, which is the same unbounded wait reached by a different
route. Voting is right because the window really is ending — and the one case
where it is not, a committed close retreating to `archive-failed` and being
declined, is why the intent is kept rather than dropped.

**Why the walk ends on `main`, and why the grant to every window was reverted.**
Widening `updater:*` to every window was meant to cover a session whose `main`
was closed. It covers nothing: only `main` runs the periodic check, so only
`main` can be holding a downloaded update, and a `main`-less session has none to
install whichever window goes last. The grant traded a structural guarantee — the
install can only happen in the window torn down last — for a case that cannot
arise. What that session does need is to be told, which is the close
confirmation's "this throws away the downloaded update" arm. The periodic check
stays in `main` because it is a timer, not a capability, and one per window would
be N checks against the endpoint.

**Why the teardown ordering survived the transcript removal.** Flush → graceful kill → flush → drain was built to capture the final scrollback of dying terminals into the persisted session. The transcripts are gone, but the shape is still what makes the *structure* correct: the first flush reads cwds while the shells are alive, and the second catches whatever changed as they died, retaining the earlier cwd for a PTY `getCwd` can no longer answer.

**Why the capture goes first and cannot abort the rest.** The resume hint exists only in the window between the interrupt and the kill, so no later step can reconstruct it — but it is also the step most likely to be slow or to fail, and losing an agent's resume is much cheaper than losing the layout, cwds, and notes behind it.
