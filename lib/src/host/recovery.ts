/**
 * The sidecar's entry into agent recovery: the capture machine plus the record
 * store, bundled together as `sidecar/recovery.cjs` by
 * `standalone/scripts/build-sidecar-proxy.mjs`. `detectResumeCommand` and
 * `stripTerminalControls` come along transitively.
 *
 * The VS Code extension host imports `recovery-capture.ts` directly and keeps its
 * own record in extension storage (docs/specs/vscode.md -> "Capturing agent
 * recovery").
 */

export { captureAgentRecovery } from './recovery-capture';
export { createRecoveryStore } from './recovery-store';
// Not recovery's own, but the sidecar's only route to a lib module: `pty-core.js`
// takes it as an injected option so its `node --test` suite needs no bundle.
export { sliceSince } from './replay-buffer';
