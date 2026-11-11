// Browser-safe: read by lib's platform types and the dor CLI's control methods.

/**
 * How long a host waits for the process that inspects the process tree to
 * answer a terminal-context request (`info`, `promote`): VS Code's pty-host
 * child (`vscode-ext/src/pty-manager.ts`) and standalone's sidecar
 * (`pty_context` in `standalone/src-tauri/src/lib.rs`). The webview's own
 * deadline and every `dor` request that waits on one derive from it.
 */
export const TERMINAL_CONTEXT_CHILD_TIMEOUT_MS = 10_000;
