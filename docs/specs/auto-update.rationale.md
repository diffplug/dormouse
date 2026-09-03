# Auto-Update — Rationale

> Informative companion to [auto-update.md](auto-update.md): evidence and design history keyed by that spec's headings. Nothing here is normative.

## Quit-time install

**Why install runs last.** A Windows NSIS install force-kills the app the moment it starts. Run it before the graceful terminal teardown and the durable final session save, and the kill lands mid-teardown, losing the freshest scrollback — the output the user was looking at when they quit.

**Why Vite dev mode skips `install()`.** The updater resolves its replacement target from the current executable path, which in dev is the dev executable's directory rather than a packaged bundle.

## Sidecar teardown on Windows

NSIS cannot overwrite node-pty's loaded `conpty.node` or `conpty.dll`; each pseudoconsole also has an `OpenConsole.exe` child in the sidecar's job object. The ordinary Rust exit handler is too late because `install()` force-kills the app and NSIS begins copying immediately.

Polling `try_wait` is required because the reaper thread may already have consumed the job object's completion-port message, making `wait()` block forever after an earlier sidecar crash.

## Debug report on failure

**Why search-before-file, and why the modal exists at all.** An update failure is environment-specific, so the odds that someone has already filed it are high and a seeded search costs the user nothing. The log tail is the only evidence that survives the installer's force-kill, so if the search misses, the report has to carry it.
