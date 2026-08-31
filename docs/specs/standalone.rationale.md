# Dormouse Standalone (Tauri) — Rationale

> Informative companion to [standalone.md](standalone.md): the evidence, measurements, and dead-approach history behind its rules, keyed by that spec's headings (AGENTS.md → "The rationale split"). Nothing here is normative.

## Rust ↔ sidecar bridge

The two Windows Node variants exist only because `CREATE_NO_WINDOW`, `DETACHED_PROCESS`, and `STARTUPINFO` hiding did not suppress Windows 11's DefTerm handoff from a GUI parent (verified 2026-08). If a current spawn-time option suppresses the stray Windows Terminal window, both variants can collapse back to the stock console-subsystem Node under `DORMOUSE_NODE`.

## Persistence

**The WKWebView WAL measurement.** WKWebView stores `localStorage` as SQLite in WAL mode, and WebKit pins that WAL with a long-lived reader which never advances during a running session — so it is never checkpointed, and an external checkpoint is blocked by the same reader. Rewriting the multi-MB scrollback-bearing session blob on every save grew the WAL to ~1 GB within a few hours (recorded 2026-07); a days-long session made it pathological. That is what retired `localStorage` as the blob's backing store in favour of the Rust file store.

**What the teardown flush lost.** The pre-Rust path flushed the session on teardown into WebKit `localStorage` and lost the final debounce/heartbeat window. Awaiting the write pipeline to disk (`drainSessionSaves`) is what recovers it, which is why quit awaits a drain rather than firing a last save.

**"Standalone persists no Session state": what a dropped blob would still cost.** `getCwd` is a synchronous `execFileSync('lsof', …)` in the sidecar on macOS (`getCwdForPid` in `standalone/sidecar/pty-core.js`), one round trip per terminal pane. Without `persistsSession: false` the record build runs anyway, so every debounced save, every 30 s heartbeat, and both quit-time flushes would pay that per pane to produce a blob that is discarded on the next line.

**Why the reload cost is more visible in the harness.** Real standalone has always dropped doors, saved titles, and tab grouping across a WebView reload; a developer just rarely reloads it. In the browser-dev harness, turning on `abDebugLogs` means reloading the page (`.claude/skills/debug-standalone-agent-browser/SKILL.md`), so the same long-standing behavior shows up every session.
