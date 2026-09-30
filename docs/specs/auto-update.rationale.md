# Auto-Update — Rationale

> Informative companion to [auto-update.md](auto-update.md): evidence and design history keyed by that spec's headings. Nothing here is normative.

## Quit-time install

**Why install runs last.** On Windows `install()` starts NSIS and then calls `std::process::exit` itself (`tauri-plugin-updater-2.11.0/src/updater.rs`, checked 2026-09), so starting it early interrupts teardown. This ordering originally protected persisted scrollback; what it protects now is the window's structure, which standalone does persist. The retained save/drain hooks and their completion semantics are explained in `docs/specs/standalone.rationale.md` → Quit flow.

**Why `updater:*` stayed scoped to `main`.** Widening it to every window was meant to cover a session whose `main` was closed. It covers nothing: only `main` runs the periodic check, so only `main` can be holding a download, and a `main`-less session has none to install whichever window the walk ends on. The grant gave up a structural guarantee — the install can only happen in the window torn down last — for a case that cannot arise. What that session needs is to be told before it happens, which is the close confirmation's discard warning.

**Why Vite dev mode skips `install()`.** The updater resolves its replacement target from the current executable path, which in dev is the dev executable's directory, not a packaged bundle.

## Sidecar teardown on Windows

NSIS cannot overwrite node-pty's loaded `conpty.node` or `conpty.dll`; each pseudoconsole also has an `OpenConsole.exe` child in the sidecar's job object. The Rust exit handler never runs: `std::process::exit` skips `RunEvent::Exit`, and NSIS is already copying.

Polling `try_wait` avoids `wait()`, which blocks forever when the reaper thread has already consumed the job object's completion-port message after an earlier sidecar crash.

## Debug report on failure

**Why two steps.** An update failure is environment-specific, so the odds someone has already filed it are high and a seeded search costs the user nothing. The log tail is the only evidence surviving the installer's exit, so the report carries it when the search misses.
