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

**Why the mode is set before the bytes.** Under the bare umask the transcript-bearing blob lands `0644` in a `0755` directory any other local account can read, and tightening after the write would leave a window in which it was readable. Failing the save over a filesystem that has no such permission model would cost more than the exposure the mode prevents.

**Why the ACE test asserts an already-existing file.** On an upgrade the Burrow enrollment file is already there, so what tightens it is propagation onto an existing entry rather than create-time inheritance. `FileBurrowStateStore`'s own `0700`/`0600` cannot help on Windows: Node has no ACL API.

**What the teardown flush lost.** The pre-Rust path flushed the session on teardown into WebKit `localStorage` and lost the final debounce/heartbeat window; awaiting the write pipeline to disk (`drainSessionSaves`) recovers it, which a last fire-and-forget save would not.

**What a dropped blob would still cost.** `getCwd` is a synchronous `execFileSync('lsof', …)` in the sidecar on macOS (`getCwdForPid` in `standalone/sidecar/pty-core.js`), one round trip per terminal pane. Without `persistsSession: false` the record build runs anyway, so every debounced save, every 30 s heartbeat, and both quit-time flushes pay that per pane to produce a blob discarded on the next line.

**Why the pre-upgrade snapshot is deleted, not blanked.** A `''` write leaves the old bytes on disk until some later save that may never come, and forces every reader to treat empty as a third state alongside present and absent.

**Why the harness deletes its `localStorage` key.** Its snapshots carry transcripts, and `localStorage` is keyed by browser profile rather than by the per-run temp state directory the harness gives every other slot, so a blob written before the gate existed outlives every run.

**Why the reload cost is more visible in the harness.** A developer rarely reloads real standalone; in the browser-dev harness, turning on `abDebugLogs` means reloading the page (`.claude/skills/debug-standalone-agent-browser/SKILL.md`), so long-standing behavior shows up every session.

## Quit flow

**Why the teardown ordering outlived its original purpose.** Flush → graceful kill → flush → drain was built to capture the final scrollback of dying terminals into the persisted session. Standalone now persists nothing, so both flushes return immediately on `persistsSession: false`; the shape is kept for the workspaces-rollout scope's Session persistence. The flushes no longer read transcripts; final PTY output is forwarded to the webview during the grace tick without a sidecar scrollback buffer.
