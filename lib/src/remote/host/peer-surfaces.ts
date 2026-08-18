/**
 * The responder half of peer surfaces (docs/specs/vscode.md → "Peer surfaces").
 *
 * The remote Host runs in one webview, but a window's terminals are spread
 * across all of them and each webview has its own xterm registry. So *every*
 * webview installs this, not just the Host's: it answers the broker's questions
 * about the panes this webview owns, and drives them when the Host asks.
 *
 * Deliberately light — the registry, the directory collector, and a resize. It
 * carries none of the relay, enrollment, or pairing machinery, so a webview
 * that will never be the Host pays almost nothing to make its terminals
 * reachable from one that is.
 */

import { clampTerminalDimension } from 'server-lib-common';
import { getPlatform } from '../../lib/platform';
import type { PeerSurfaceResult } from '../../lib/platform/types';
import { registry } from '../../lib/terminal-store';
import { collectDirectorySnapshot } from './directory-collect';

/**
 * Drive one of this webview's own surfaces on the Host's behalf.
 *
 * `attach` and `resize` are the same operation — attach-is-the-resize
 * (docs/specs/remote-api.md) — and both go through the live xterm rather than
 * the PTY directly, so the owning pane's own view stays consistent with the
 * size the phone asked for. `detach` has nothing to undo here: the Host stops
 * streaming on its side, and the pane keeps whatever size it was left at, which
 * is what last-attach-wins means.
 */
function surfaceOp(
  surfaceId: string,
  op: 'attach' | 'detach' | 'resize',
  cols?: number,
  rows?: number,
): PeerSurfaceResult {
  const entry = registry.get(surfaceId);
  if (!entry) return { ok: false };

  const term = entry.terminal;
  if (op === 'detach') {
    return { ok: true, ptyId: entry.ptyId, cols: term.cols, rows: term.rows };
  }

  const nextCols = clampTerminalDimension(cols, term.cols);
  const nextRows = clampTerminalDimension(rows, term.rows);
  if (term.cols !== nextCols || term.rows !== nextRows) {
    term.resize(nextCols, nextRows);
  }
  return { ok: true, ptyId: entry.ptyId, cols: term.cols, rows: term.rows };
}

/**
 * Make this webview's terminals reachable from whichever webview is the Host.
 * Idempotent, and a no-op on hosts with no peers (standalone, the website).
 */
export function installPeerSurfaceResponder(): void {
  getPlatform().peers?.serve({
    directory: () => collectDirectorySnapshot(),
    surfaceOp,
  });
}
