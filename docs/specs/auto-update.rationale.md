# Auto-Update — Rationale

> Informative companion to [auto-update.md](auto-update.md): evidence and design history keyed by that spec's headings. Nothing here is normative.

## Quit-time install

**Why install runs last.** A Windows NSIS install force-kills the app the moment it starts, so starting it early interrupts teardown. This ordering originally protected persisted scrollback; what it protects now is the window's structure, which standalone does persist. The retained save/drain hooks and their completion semantics are explained in `docs/specs/standalone.rationale.md` → Quit flow.

**Why Vite dev mode skips `install()`.** The updater resolves its replacement target from the current executable path, which in dev is the dev executable's directory, not a packaged bundle.

## Sidecar teardown on Windows

NSIS cannot overwrite node-pty's loaded `conpty.node` or `conpty.dll`; each pseudoconsole also has an `OpenConsole.exe` child in the sidecar's job object. The Rust exit handler runs only after the force-kill, with NSIS already copying.

Polling `try_wait` avoids `wait()`, which blocks forever when the reaper thread has already consumed the job object's completion-port message after an earlier sidecar crash.

## Debug report on failure

**Why two steps.** An update failure is environment-specific, so the odds someone has already filed it are high and a seeded search costs the user nothing. The log tail is the only evidence surviving the installer's force-kill, so the report carries it when the search misses.
