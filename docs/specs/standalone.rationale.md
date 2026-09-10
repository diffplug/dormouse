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

## Persistence

**The WKWebView WAL measurement.** WKWebView stores `localStorage` as SQLite in WAL mode, and WebKit pins that WAL with a long-lived reader that never advances during a running session — so it is never checkpointed, and an external checkpoint is blocked by the same reader. Rewriting the multi-MB scrollback-bearing session blob on every save grew the WAL to ~1 GB within a few hours (recorded 2026-07); a days-long session made it pathological. The Rust file store that replaced it has no WAL and rewrites the same file each time.

**Why the sessions directory is fsynced after the rename.** Fsyncing only the temp file leaves the new name recoverable-but-absent after a power loss; the directory-entry fsync is what makes the rename itself durable. Windows has no equivalent concept, hence unix-only.

**Why the mode is set before the bytes.** Under the bare umask the transcript-bearing blob lands `0644` in a `0755` directory any other local account can read, and tightening after the write would leave a window in which it was readable. Continuing after a permission failure would contradict the owner-only guarantee; aborting before writing preserves the previous snapshot and leaves at most an empty temp file.

**Why the ACE test asserts an already-existing file.** On an upgrade the Burrow enrollment file is already there, so what tightens it is propagation onto an existing entry rather than create-time inheritance. `FileBurrowStateStore`'s own `0700`/`0600` cannot help on Windows: Node has no ACL API.

**What the teardown flush lost.** The pre-Rust path flushed the session on teardown into WebKit `localStorage` and lost the final debounce/heartbeat window; awaiting the write pipeline to disk (`drainSessionSaves`) recovers it, which a last fire-and-forget save would not.

**What a record build costs.** `getCwd` is a synchronous `execFileSync('lsof', …)` in the sidecar on macOS (`getCwdForPid` in `standalone/sidecar/pty-core.js`), one round trip per terminal pane, on every debounced save and every 30 s heartbeat. That price is why the dirty triggers are keyed to the owning Workspace: an unkeyed trigger would make every idle Workspace pay it whenever any Workspace moved.

**Why the aggregator debounces on top of the Wall's own debounce.** Each Wall already coalesces its own record; the second stage coalesces *across* Walls, so one window-wide event (a store change, a theme push, a burst of output in two Workspaces) becomes one host write rather than one per Workspace.

**Why the dev state root is a subtree rather than a separate identifier.** `app_data_dir()` is derived from the Tauri identifier, and changing the identifier for debug builds would move the notepad archive and the Burrow enrollment too — stranding a developer's notes and forcing a re-pair on every switch between the dev and installed app. A subtree splits exactly the state that is a copy of the user's window and shares the rest.

## Quit flow

**Why the teardown ordering survived the transcript removal.** Flush → graceful kill → flush → drain was built to capture the final scrollback of dying terminals into the persisted session. The transcripts are gone, but the shape is still what makes the *structure* correct: the first flush reads cwds while the shells are alive, and the second catches whatever changed as they died, retaining the earlier cwd for a PTY `getCwd` can no longer answer.

**Why the capture goes first and cannot abort the rest.** The resume hint exists only in the window between the interrupt and the kill, so no later step can reconstruct it — but it is also the step most likely to be slow or to fail, and losing an agent's resume is much cheaper than losing the layout, cwds, and notes behind it.
