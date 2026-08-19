/**
 * Take hold of a surface by id, wherever it lives.
 *
 * A window's terminals are spread across its webviews and only one of them is
 * the Host, so a pane the phone names is either in this webview's registry or
 * in a sibling's (docs/specs/vscode.md → "Peer surfaces"). Which one is a fact
 * about VS Code webview hosting; it is not a protocol-v1 concept
 * (docs/specs/remote-api.md), so it is answered here and never seen above.
 *
 * The rest of the feature already works this way — `pty:data` from another
 * window is injected into the ordinary data path, and `pty:input` / `pty:resize`
 * route by table before falling back to the local manager — so `terminal.write`
 * has no idea either. This closes the last gap.
 */

import { getPlatform } from '../../lib/platform';
import { registry } from '../../lib/terminal-store';
import type { SurfaceHandle } from './host-surface-provider';
import { peerSurfaceOp } from './peer-surfaces';

/**
 * Resolve `surfaceId` at the size the client asked for, or `null` if nobody
 * owns it.
 *
 * The size is part of resolving because attach-is-the-resize
 * (docs/specs/remote-api.md): a sibling has to apply it inside the attach round
 * trip, since there is no way to reach into its xterm afterwards without a
 * second one. A local pane is left alone here and resized by the caller, which
 * subscribes to the PTY first so a synchronous repaint is not lost — the
 * resolved handle reports the size as it stands, and the caller reconciles.
 */
export async function resolveSurface(
  surfaceId: string,
  size: { cols?: number; rows?: number },
): Promise<SurfaceHandle | null> {
  const entry = registry.get(surfaceId);
  if (entry) {
    const term = entry.terminal;
    return {
      ptyId: entry.ptyId,
      get cols() {
        return term.cols;
      },
      get rows() {
        return term.rows;
      },
      // Pinned to the terminal resolved here, not re-read from the registry: a
      // pane swap must not move an attachment onto a different terminal.
      resize: async (cols, rows) => {
        if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
        return { cols: term.cols, rows: term.rows };
      },
      release: () => {},
    };
  }

  // Not ours: ask the other webviews of this window, and the other windows.
  // The owner resizes its own xterm — attach-is-the-resize has to go through
  // the live terminal, not the PTY, or the owning pane's view drifts from the
  // size the phone set.
  const peers = getPlatform().peers;
  if (!peers) return null;
  const owner = await peerSurfaceOp({ surfaceId, op: 'attach', cols: size.cols, rows: size.rows });
  if (!owner) return null;

  const stopStream = peers.streamPty(owner.ptyId);
  let cols = owner.cols;
  let rows = owner.rows;
  return {
    ptyId: owner.ptyId,
    get cols() {
      return cols;
    },
    get rows() {
      return rows;
    },
    // The owner is the only one that can read the pane back, so remember what
    // it reported; a resize nobody answered leaves the last known size standing.
    resize: async (nextCols, nextRows) => {
      const settled = await peerSurfaceOp({
        surfaceId,
        op: 'resize',
        cols: nextCols,
        rows: nextRows,
      });
      if (settled) {
        cols = settled.cols;
        rows = settled.rows;
      }
      return { cols, rows };
    },
    release: stopStream,
  };
}
