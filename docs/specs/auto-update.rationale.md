# Auto-Update — Rationale

> Informative companion to [auto-update.md](auto-update.md): evidence and design history keyed by that spec's headings. Nothing here is normative.

## Update notice in the Baseboard

An empty manual check still awaits the host's app-version lookup before showing its result. While that lookup waits, a later check can find an update and its approved download can finish; the older completion then hid Restart now behind an up-to-date notice. Dismissal was likewise undone. Checking notice identity at the continuation prevents both overwrites without changing the held update (deferred-version regressions in `standalone/src/updater.test.ts`, 2026-11).

## Quit-time install

**Why install runs last.** On Windows `install()` starts NSIS and then calls `std::process::exit` itself (`tauri-plugin-updater-2.11.0/src/updater.rs`, checked 2026-09), so starting it early interrupts teardown. What it protects is the window's persisted structure; the save/drain hooks are `docs/specs/standalone.rationale.md` → Quit flow.

**Why `updater:*` stayed scoped to `main`.** Widening it to every window was meant to cover a session whose `main` was closed. It covers nothing: only `main` runs the periodic check, so only `main` can be holding a download, and a `main`-less session has none to install whichever window the walk ends on. The grant gave up a structural guarantee — the install can only happen in the window torn down last — for a case that cannot arise. What that session needs is to be told before it happens, which is the close confirmation's discard warning.

**Why Vite dev mode skips `install()`.** The updater resolves its replacement target from the current executable path, which in dev is the dev executable's directory, not a packaged bundle.

## Sidecar teardown on Windows

NSIS cannot overwrite node-pty's loaded `conpty.node` or `conpty.dll`; each pseudoconsole also has an `OpenConsole.exe` child in the sidecar's job object. The Rust exit handler never runs: `std::process::exit` skips `RunEvent::Exit`, and NSIS is already copying.
