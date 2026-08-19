/**
 * What the Host may ask a webview, and the answers it gives back
 * (docs/specs/vscode.md → "Peer surfaces").
 *
 * The Host runs in the process that owns the PTYs, but a window's terminals are
 * spread across its webviews and each webview has its own xterm registry. So
 * *every* webview installs the responder here: it answers what the panes this
 * webview owns are called, and drives them when the Host asks.
 *
 * This is also the one place the operations have real types. The platform
 * adapter, the extension-host broker, and the cross-window socket all treat
 * `op` as opaque, because *what* a webview can be asked belongs to the remote
 * Host and not to any of them — {@link PeerOps} is the whole vocabulary, and
 * adding an operation means one entry here plus its caller, not a parallel
 * ladder of message types at every layer.
 *
 * Deliberately light — the registry, the directory collector, and a resize. It
 * carries none of the relay, enrollment, or pairing machinery, so a webview
 * pays almost nothing to make its terminals reachable from the Host.
 */

import { clampTerminalDimension, type DirectoryEntry } from 'server-lib-common';
import { getPlatform } from '../../lib/platform';
import { subscribeToActivity } from '../../lib/session-activity-store';
import { registry } from '../../lib/terminal-store';
import { subscribeToTerminalPaneState } from '../../lib/terminal-state-store';
import { collectDirectorySnapshot } from './directory-collect';

/** What the Host can ask the owner of a surface to do with it. */
export type PeerSurfaceOp = 'attach' | 'detach' | 'resize';

export interface PeerSurfaceParams {
  surfaceId: string;
  op: PeerSurfaceOp;
  cols?: number;
  rows?: number;
}

/**
 * What the owner reports back. There is no `ok` flag: an owner answers with one
 * of these and everyone else answers with nothing, so presence *is* ownership —
 * which is also what lets every field be required.
 *
 * `ptyId` is read by the cross-window link as the routing hint that says which
 * window this PTY lives in (`routedPtyId` in `lib/src/lib/vscode-peer-link-protocol.ts`).
 */
export interface PeerSurfaceResult {
  ptyId: string;
  cols: number;
  rows: number;
}

/**
 * Every peer operation, keyed by the name that goes on the wire. `result` is
 * the type of *one* answer: a peer contributes zero or more of them, so the
 * directory returns its entries and a surface op returns one result or none.
 */
export interface PeerOps {
  directory: { params: Record<string, never>; result: DirectoryEntry };
  surfaceOp: { params: PeerSurfaceParams; result: PeerSurfaceResult };
}

/** Answer `op` for this webview's own surfaces. No-op where nobody can ask. */
function answerPeers<K extends keyof PeerOps>(
  op: K,
  handler: (params: PeerOps[K]['params']) => PeerOps[K]['result'][],
): void {
  getPlatform().remoteHost?.respond(op, (params) => handler(params as PeerOps[K]['params']));
}

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
function driveOwnSurface({ surfaceId, op, cols, rows }: PeerSurfaceParams): PeerSurfaceResult[] {
  const entry = registry.get(surfaceId);
  if (!entry) return [];

  const term = entry.terminal;
  if (op === 'detach') {
    return [{ ptyId: entry.ptyId, cols: term.cols, rows: term.rows }];
  }

  const nextCols = clampTerminalDimension(cols, term.cols);
  const nextRows = clampTerminalDimension(rows, term.rows);
  if (term.cols !== nextCols || term.rows !== nextRows) {
    term.resize(nextCols, nextRows);
  }
  return [{ ptyId: entry.ptyId, cols: term.cols, rows: term.rows }];
}

/**
 * Make this webview's terminals reachable from the Host service in the process
 * that owns the PTYs. Idempotent, and a no-op on a host with no service behind
 * it (the website).
 */
export function installPeerSurfaceResponder(): void {
  answerPeers('directory', () => collectDirectorySnapshot());
  answerPeers('surfaceOp', driveOwnSurface);

  const link = getPlatform().remoteHost;
  if (!link) return;
  const notifyDirectory = () => link.notify('directory');
  subscribeToTerminalPaneState(notifyDirectory);
  subscribeToActivity(notifyDirectory);
  if (typeof document !== 'undefined') {
    document.addEventListener('focusin', notifyDirectory);
    document.addEventListener('focusout', notifyDirectory);
  }
}
