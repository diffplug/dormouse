/**
 * Typed webview surface responder; `docs/specs/vscode.md` → "Peer surfaces"
 * owns the cross-window contract. {@link PeerOps} is the sole operation map;
 * transport layers keep `op` opaque.
 */

import { clampTerminalDimension, type DirectoryEntry } from 'remote-lib-common';
import { getPlatform } from '../../lib/platform';
import type { BurrowLink } from '../../lib/platform/types';
import { subscribeToActivity } from '../../lib/session-activity-store';
import { registry } from '../../lib/terminal-store';
import { subscribeToTerminalPaneState } from '../../lib/terminal-state-store';
import { collectDirectorySnapshot } from './directory-collect';
import { armWhileEnrolled } from './enrolled-gate';

/**
 * What the Burrow can ask the owner of a surface to do with it. There is no
 * detach: the Burrow stops streaming on its side, and the pane keeps whatever
 * size it was left at — which is what last-attach-wins means.
 */
export type PeerSurfaceOp = 'resolve' | 'attach' | 'resize';

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
 * window this PTY lives in (`routedPtyId` in `vscode-ext/src/peer-link-protocol.ts`).
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
  getPlatform().burrow?.respond(op, (params) => handler(params as PeerOps[K]['params']));
}

/**
 * Resolve or drive one of this webview's own surfaces on the Burrow's behalf.
 *
 * `resolve` is the read-only ownership probe that lets a multi-window Burrow pick
 * one duplicate claimant before mutating it. `attach` and `resize` are the same
 * operation — attach-is-the-resize
 * (docs/specs/remote-api.md) — and both go through the live xterm rather than
 * the PTY directly, so the owning pane's own view stays consistent with the
 * size the phone asked for.
 */
function driveOwnSurface({
  surfaceId,
  op,
  cols,
  rows,
}: PeerSurfaceParams): PeerSurfaceResult[] {
  const entry = registry.get(surfaceId);
  if (!entry) return [];

  const term = entry.terminal;
  const nextCols = clampTerminalDimension(cols, term.cols);
  const nextRows = clampTerminalDimension(rows, term.rows);
  if (op !== 'resolve' && (term.cols !== nextCols || term.rows !== nextRows)) {
    term.resize(nextCols, nextRows);
  }
  return [{ ptyId: entry.ptyId, cols: term.cols, rows: term.rows }];
}

/**
 * The link the announcing half is already installed against.
 *
 * Answering is idempotent on its own — a responder replaces the one before it —
 * but the announcing half is not: every call adds a `status` subscription, and
 * every arming under it adds pane-state, activity, and focus listeners with no
 * handle left to remove them. A second install would then cross into the Burrow's
 * process twice per change, forever. Keyed by link rather than a bare flag
 * because the platform is what owns one: a different adapter is a different
 * Burrow to announce to.
 */
let announcingFor: BurrowLink | null = null;

/**
 * Make this webview's terminals reachable from the Burrow service in the process
 * that owns the PTYs. Idempotent, and a no-op on a burrow with no service behind
 * it (the website).
 */
export function installPeerSurfaceResponder(): void {
  // Registered unconditionally: answering is stateless, costs nothing until
  // asked, and must work the moment a Burrow starts.
  answerPeers('directory', () => collectDirectorySnapshot());
  answerPeers('surfaceOp', driveOwnSurface);

  const link = getPlatform().burrow;
  if (!link || link === announcingFor) return;
  announcingFor = link;
  // Announcing is not free — one crossing per pane-state change, activity
  // change, and focus move — so it is armed only while a Burrow exists to hear it
  // (`enrolled-gate.ts`).
  armWhileEnrolled(link, () => {
    let armed = true;
    let queued = false;
    // Trailing-edge coalesce: these sources fire in bursts — a focus move is a
    // focusout and a focusin, and a pane-state change usually lands with an
    // activity change — and the Burrow re-collects the whole directory either way,
    // so one crossing per burst is the whole message.
    const notifyDirectory = (): void => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        // A disarm can land inside the coalesce window, and a Burrow that is gone
        // must not be told anything.
        if (armed) link.notify();
      });
    };
    const unsubscribePaneState = subscribeToTerminalPaneState(notifyDirectory);
    const unsubscribeActivity = subscribeToActivity(notifyDirectory);
    const hasDocument = typeof document !== 'undefined';
    if (hasDocument) {
      document.addEventListener('focusin', notifyDirectory);
      document.addEventListener('focusout', notifyDirectory);
    }
    return () => {
      armed = false;
      unsubscribePaneState();
      unsubscribeActivity();
      if (!hasDocument) return;
      document.removeEventListener('focusin', notifyDirectory);
      document.removeEventListener('focusout', notifyDirectory);
    };
  });
}
