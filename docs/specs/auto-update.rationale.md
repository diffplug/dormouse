# Auto-Update — Rationale

> Informative companion to [auto-update.md](auto-update.md): evidence and design history keyed by that spec's headings. Nothing here is normative.

## Sidecar teardown on Windows

NSIS cannot overwrite node-pty's loaded `conpty.node` or `conpty.dll`; each pseudoconsole also has an `OpenConsole.exe` child in the sidecar's job object. The ordinary Rust exit handler is too late because `install()` force-kills the app and NSIS begins copying immediately.

Polling `try_wait` is required because the reaper thread may already have consumed the job object's completion-port message, making `wait()` block forever after an earlier sidecar crash.
