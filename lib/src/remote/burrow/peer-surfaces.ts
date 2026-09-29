/**
 * Typed webview surface responder; `docs/specs/vscode.md` → "Peer surfaces"
 * owns the cross-window contract. {@link PeerOps} is the sole operation map;
 * transport layers keep `op` opaque.
 */

import { clampTerminalDimension, type DirectoryEntry } from 'remote-lib-common';
import { serviceIdOf, type BurrowStatusEvent } from '../../host/remote/service-protocol';
import { getPlatform } from '../../lib/platform';
import type { BurrowLink } from '../../lib/platform/types';
import { subscribeToActivity } from '../../lib/session-activity-store';
import {
  dropSizeHoldsFromOtherServices,
  holdSize,
  releaseSizeHold,
  type SizeHold,
} from '../../lib/size-hold-store';
import { isHelperSession, registry } from '../../lib/terminal-store';
import { subscribeToTerminalPaneState } from '../../lib/terminal-state-store';
import type { SurfaceHold } from './burrow-surface-provider';
import { collectDirectorySnapshot } from './directory-collect';
import { armWhile } from './enrolled-gate';

/**
 * What the Burrow can ask the owner of a surface to do with it
 * (`docs/specs/remote-api.md` → "Size authority"). `release` is the one way a
 * remote session gives a pane's size back; the Burrow's stream stops on its
 * own side.
 */
export type PeerSurfaceOp = 'resolve' | 'attach' | 'resize' | 'release';

export interface PeerSurfaceParams {
  surfaceId: string;
  op: PeerSurfaceOp;
  cols?: number;
  rows?: number;
  /**
   * Who takes the size (`attach`, `resize`), or which hold to give back
   * (`release`). Absent from a Burrow older than holds, whose attach then sizes
   * the pane without holding it.
   */
  hold?: SurfaceHold;
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

/** A hold as the wire carries it, or `null` for anything else — a peer window is another build. */
function holdOf(value: unknown): SizeHold | null {
  const hold = value as Partial<Record<keyof SizeHold, unknown>> | null | undefined;
  if (typeof hold?.holder !== 'string' || typeof hold.label !== 'string') return null;
  if (typeof hold.lease !== 'string') return null;
  const { holder, label, lease, serviceId } = hold;
  // A malformed instance id is read as none: such a hold is kept, never dropped.
  return typeof serviceId === 'string' ? { holder, label, lease, serviceId } : { holder, label, lease };
}

/**
 * Resolve or drive one of this webview's own surfaces on the Burrow's behalf.
 *
 * `resolve` is the read-only ownership probe that lets a multi-window Burrow pick
 * one duplicate claimant before mutating it. `attach` and `resize` are the same
 * operation — attach-is-the-resize
 * (docs/specs/remote-api.md) — and both go through the live xterm rather than
 * the PTY directly, so the owning pane's own view stays consistent with the
 * size the phone asked for; each records its hold first, so the pane stops
 * fitting itself before the size moves. `release` clears the hold it names,
 * and the pane re-fits when that empties it (`TerminalPane`). An op this build
 * does not know — a newer Burrow's — changes nothing and claims nothing.
 */
function driveOwnSurface({
  surfaceId,
  op,
  cols,
  rows,
  hold,
}: PeerSurfaceParams): PeerSurfaceResult[] {
  const entry = isHelperSession(surfaceId) ? undefined : registry.get(surfaceId);
  if (!entry) return [];

  const term = entry.terminal;
  switch (op) {
    case 'resolve':
      break;
    case 'attach':
    case 'resize': {
      const taken = holdOf(hold);
      if (taken) holdSize(surfaceId, taken);
      const nextCols = clampTerminalDimension(cols, term.cols);
      const nextRows = clampTerminalDimension(rows, term.rows);
      if (term.cols !== nextCols || term.rows !== nextRows) term.resize(nextCols, nextRows);
      break;
    }
    case 'release': {
      // Answers nothing either way: a release is fire and forget, and a PTY id
      // in the answer would re-route a handle the Burrow is dropping.
      const given = holdOf(hold);
      if (given) releaseSizeHold(surfaceId, given);
      return [];
    }
    default:
      return [];
  }
  return [{ ptyId: surfaceId, cols: term.cols, rows: term.rows }];
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
 * that owns the PTYs. Idempotent, and a no-op on a host with no service behind
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
  // Unconditional too: a hold outlives the gate that armed it. A `status`
  // naming another service instance means the one whose sessions took holds
  // here — a broker window that closed, a sidecar that restarted — is gone, and
  // its releases with it (`docs/specs/remote-api.md` → "Size authority").
  link.on('status', (data) => {
    const serviceId = serviceIdOf(data as Partial<BurrowStatusEvent> | null);
    if (serviceId) dropSizeHoldsFromOtherServices(serviceId);
  });
  // Announcing is not free — one crossing per pane-state change, activity
  // change, and focus move — so it is armed only while something can reach
  // these terminals: an enrolled Burrow, or a one-time phone (`enrolled-gate.ts`).
  armWhile(link, { serving: () => {
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
  } });
}
