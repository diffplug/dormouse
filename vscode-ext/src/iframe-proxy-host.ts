/**
 * VS Code extension-host binding for the iframe transparent proxy.
 *
 * The proxy itself is host-agnostic and lives in `lib/src/host/iframe-proxy.ts`
 * (shared with the Tauri sidecar — see docs/specs/dor-browser.md → "Iframe
 * Renderer"). This file only injects the VS Code logger; the
 * message-router calls `createIframeProxyUrl` exactly as before.
 */
import { createIframeProxyUrl as createProxy, releaseIframeProxyLease } from '../../lib/src/host/iframe-proxy';
import type { IframeProxyResult } from '../../lib/src/lib/platform/types';
import { log } from './log';

/** `lease` is the view's id, held under `owner`: the router asking. */
export function createIframeProxyUrl(
  targetUrl: string,
  embedderOrigins: unknown,
  lease?: { owner: string; id: unknown },
): Promise<IframeProxyResult> {
  return createProxy(targetUrl, { log: (msg) => log.info(msg), embedderOrigins, ...(lease ? { lease } : {}) });
}

export { releaseIframeProxyLease };
