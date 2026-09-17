/**
 * VS Code extension-host binding for Dor Tools.
 *
 * The registry, the closed substitution set, and the trust record are
 * host-agnostic and live in `lib/src/host/tool-host.ts` — the same module the
 * Tauri sidecar bundles, so the two hosts cannot drift
 * (`docs/specs/dor-tool.md`). This file only supplies the state directory.
 */
import { createToolHost } from '../../lib/src/host/tool-host';
import type { ToolControlResult, ToolHostRequest } from '../../lib/src/lib/platform/types';

let host: ReturnType<typeof createToolHost> | null = null;

/** `stateDir` is the extension's own global storage; without it, trust is
 *  in-memory and the user re-approves once per window. */
export function initToolHost(stateDir: string | undefined): void {
  host = createToolHost({ stateDir });
}

export function toolControl(request: ToolHostRequest): Promise<ToolControlResult> {
  if (!host) return Promise.resolve({ status: 'error', message: 'tool host not initialized' });
  return host.handle(request);
}
