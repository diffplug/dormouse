/**
 * VS Code extension-host binding for the iframe transparent proxy.
 *
 * The proxy itself is host-agnostic and lives in `lib/src/host/iframe-proxy.ts`
 * (shared with the Tauri sidecar — see docs/specs/dor-browser.md → "The
 * transparent proxy"). This file only injects the VS Code logger; the
 * message-router calls `createIframeProxyUrl` exactly as before.
 */
import { createIframeProxyUrl as createProxy } from '../../lib/src/host/iframe-proxy';
import type { IframeProxyResult } from '../../lib/src/lib/platform/types';
import { log } from './log';

export function createIframeProxyUrl(targetUrl: string): Promise<IframeProxyResult> {
  return createProxy(targetUrl, { log: (msg) => log.info(msg) });
}
