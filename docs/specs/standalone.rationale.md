# Dormouse Standalone (Tauri) — Rationale

> Informative companion to [standalone.md](standalone.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Rust ↔ sidecar bridge

**What a sync blocking command cost.** `recv_timeout` on the main thread stops the webview painting for the whole round trip: a visible ~3 s freeze on a cold `agent-browser open` — long enough to look like a pane that never appeared — and up to the 30 s `AGENT_BROWSER_TIMEOUT` for a hung one. `(async)` moves the same blocking body onto a runtime worker, so the UI keeps rendering while the sidecar works. The incident is recorded at the `request_from_sidecar_timeout` invariant comment in `standalone/src-tauri/src/lib.rs`.

## Windows node subsystem

**The two Windows Node variants.** They exist only because `CREATE_NO_WINDOW`, `DETACHED_PROCESS`, and `STARTUPINFO` hiding did not suppress Windows 11's DefTerm handoff from a GUI parent (verified 2026-08) — Windows launches Windows Terminal to host the console-subsystem child, flashing a stray WT window behind Dormouse. If a current spawn-time option suppresses it, both variants can collapse back to the stock console-subsystem Node under `DORMOUSE_NODE`. The opposite requirement is `dor`'s: it runs inside a shell's ConPTY where stdout/stderr are console handles rather than pipes, and a GUI-subsystem node does not attach to an inherited console, so its output goes nowhere.

## Boot sequence

**Why the peer-surface responder must follow `init()`.** The responder seeds itself with a `status` command, and nothing carries the answer back until the adapter has registered its listeners — installed first, it would sit unanswered with no retry.

## Remote Host service

**Why one file rather than one per value.** A single `remote-host.json` makes every write one atomic rename, so the enrollment can never end up describing a different Host than the ACL records approved under it — which per-value files would allow if a write landed between them.

**Why the correlation field cannot be `requestId`.** Rust swallows any sidecar line whose `data.requestId` matches a pending invoke, so a `remoteHost:*` payload reusing that field would have its results consumed by the invoke table and vanish at random.

**Why the sidecar strips at all.** Unlike VS Code's extension host, which parses once and forwards `visibleData`, the sidecar hands the webview raw PTY bytes and the webview's own parser strips them for its xterm — so without a strip pass in the service the phone would see a stream the laptop's xterm never renders.

**Why a failed read must not be memoized.** The read errors that are neither `ENOENT` nor a parse failure — EACCES, EIO, a handle held open on Windows — say nothing about what the file holds. Answering them empty, or caching that emptiness, would let the next save overwrite unseen state with nothing, since every change is a read-modify-write of the whole file.

**What a dropped late answer would cost.** The Host has already rendered a directory missing whatever the late answer names — an empty picker on a machine that does have terminals — and nothing re-opens a settled ask, so an idle machine has no other reason to run the collect that would repair it.

**Why the strip parser is per PTY.** What an incomplete escape sequence leaves behind belongs to that PTY's byte boundaries, not to any one attachment. A late joiner inheriting that partial state beats a fresh parser starting mid-sequence, which would emit the tail of a sequence it never saw the head of.

## Persistence

**The WKWebView WAL measurement.** WKWebView stores `localStorage` as SQLite in WAL mode, and WebKit pins that WAL with a long-lived reader which never advances during a running session — so it is never checkpointed, and an external checkpoint is blocked by the same reader. Rewriting the multi-MB scrollback-bearing session blob on every save grew the WAL to ~1 GB within a few hours (recorded 2026-07); a days-long session made it pathological. That is what retired `localStorage` as the blob's backing store in favour of the Rust file store, which has no WAL at all and rewrites the same file each time.

**Why the sessions directory is fsynced after the rename.** A directory-entry fsync is what makes the rename itself durable; fsyncing only the temp file leaves the new name recoverable-but-absent after a power loss. Windows has no equivalent concept, so the step is unix-only.

**Why the mode is set before the bytes.** The blob carries terminal transcripts, and under the bare umask it lands `0644` in a `0755` directory that any other local account can read; a rename preserves the temp file's mode, so tightening after the write would leave a window where it was readable. Failing the save over a filesystem that has no such permission model would be worse than the exposure, which is why neither call is fatal.

**Why the ACE test asserts an already-existing file.** `remote_host_state_dir` locks the sidecar's state directory with the same `restrict_to_owner` call, and on an upgrade the Host enrollment file is already there — so it is propagation onto an existing entry, not create-time inheritance, that tightens it. `FileHostStateStore`'s own `0700`/`0600` cannot help on Windows: Node has no ACL API.

**What the teardown flush lost.** The pre-Rust path flushed the session on teardown into WebKit `localStorage` and lost the final debounce/heartbeat window. Awaiting the write pipeline to disk (`drainSessionSaves`) is what recovers it, which is why quit awaits a drain rather than firing a last save.

**"Standalone persists no Session state": what a dropped blob would still cost.** `getCwd` is a synchronous `execFileSync('lsof', …)` in the sidecar on macOS (`getCwdForPid` in `standalone/sidecar/pty-core.js`), one round trip per terminal pane. Without `persistsSession: false` the record build runs anyway, so every debounced save, every 30 s heartbeat, and both quit-time flushes would pay that per pane to produce a blob that is discarded on the next line.

**Why the pre-upgrade snapshot is deleted, not blanked.** A `''` write leaves the old bytes on disk until some later save that may never come, and forces every reader to treat empty as a third state alongside present and absent.

**Why the harness deletes its `localStorage` key.** Its snapshots carry transcripts, and `localStorage` is keyed by browser profile rather than by the per-run temp state directory the harness gives every other slot — so a blob written before the gate existed outlives every run.

**Why the reload cost is more visible in the harness.** Real standalone has always dropped doors, saved titles, and tab grouping across a WebView reload; a developer just rarely reloads it. In the browser-dev harness, turning on `abDebugLogs` means reloading the page (`.claude/skills/debug-standalone-agent-browser/SKILL.md`), so the same long-standing behavior shows up every session.

## Quit flow

**Why the teardown ordering outlived its original purpose.** Flush → graceful kill → flush → drain was built to capture the final scrollback of dying terminals into the persisted session. Standalone now persists nothing, so both flushes return immediately on `persistsSession: false` and cost nothing; the shape is kept because the ordering is the load-bearing part and the workspaces-rollout scope turns persistence back on.
