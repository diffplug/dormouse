/**
 * The half of a {@link BurrowSurfaceProvider} that is the same wherever the Burrow
 * runs: everything it has to *ask* for, because only a webview knows what its
 * panes are called and how big its terminals are.
 *
 * The two installations — the Tauri sidecar (`sidecar-entry.ts`) and the VS Code
 * extension host (`vscode-ext/src/burrow.ts`) — differ in how an ask
 * travels and in who owns the PTYs, and in nothing else. So those two are
 * injected and the protocol-shaped middle lives here once: a Burrow that answered
 * an attach differently in one burrow than the other would be a protocol-v1
 * divergence nobody would see until a phone attached.
 */

import type {
  DirectoryEntry,
  BurrowSurfaceProvider,
  SurfaceHandle,
} from '../../remote/burrow/burrow-surface-provider';
import type { PeerSurfaceResult } from '../../remote/burrow/peer-surfaces';

/**
 * Fan one operation out to whoever can answer it and collect the answers. Who
 * that is — one webview over a JSON line, every webview of every window over a
 * broker and a socket — is the installation's business. Follow-up operations
 * carry the selected handle's provider-local PTY key so an installation with
 * multiple answerers can address only that owner.
 */
export type SurfaceAsk = (
  op: string,
  params: unknown,
  ownerPtyId?: string,
) => Promise<unknown[]>;

export interface AskSurfaceProvider {
  provider: BurrowSurfaceProvider;
  /**
   * Something a future {@link BurrowSurfaceProvider.collectDirectory} could depend
   * on changed — a pane, an alert, a focus move, a peer joining. The directory
   * is the only thing a peer answers, so there is nothing to name: the cheap
   * direction is always to re-collect.
   */
  notifyDirectoryChanged(): void;
}

export function createAskSurfaceProvider(
  ask: SurfaceAsk,
  pty: Pick<BurrowSurfaceProvider, 'writePty' | 'resizePty' | 'streamPty'>,
): AskSurfaceProvider {
  const directoryWatchers = new Set<() => void>();

  const provider: BurrowSurfaceProvider = {
    async collectDirectory(): Promise<DirectoryEntry[]> {
      // Each answerer replies with its whole snapshot, so the results *are* the
      // entries — with one exception: duplicated cold-restored windows can hold
      // panes with identical ids, and two identical rows would make the phone's
      // picker (keyed by surfaceId) a lottery over which window an attach
      // reaches. Keep the first — answerers arrive local-tier-first, which is
      // the same owner the mutating attach's read-only resolve probe selects,
      // so the row shown is the surface attached.
      const entries = (await ask('directory', {})) as DirectoryEntry[];
      const seen = new Set<string>();
      return entries.filter((entry) => {
        if (seen.has(entry.surfaceId)) return false;
        seen.add(entry.surfaceId);
        return true;
      });
    },

    watchDirectory(onChange) {
      directoryWatchers.add(onChange);
      return () => {
        directoryWatchers.delete(onChange);
      };
    },

    async resolveSurface(surfaceId, size): Promise<SurfaceHandle | null> {
      // Attach-is-the-resize: the owner applies the size inside this round trip,
      // because there is no way to reach into its xterm afterwards without a
      // second one (docs/specs/remote-api.md). One surface has one owner, so the
      // first answer is the answer.
      const [owner] = (await ask('surfaceOp', {
        surfaceId,
        op: 'attach',
        cols: size.cols,
        rows: size.rows,
      })) as PeerSurfaceResult[];
      if (!owner) return null;

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
        // The owner is the only one that can read the pane back, so remember
        // what it reported; a resize nobody answered leaves the last known size
        // standing.
        resize: async (nextCols, nextRows) => {
          const [settled] = (await ask(
            'surfaceOp',
            {
              surfaceId,
              op: 'resize',
              cols: nextCols,
              rows: nextRows,
            },
            owner.ptyId,
          )) as PeerSurfaceResult[];
          if (settled) {
            cols = settled.cols;
            rows = settled.rows;
          }
          return { cols, rows };
        },
        // Nothing to unwind: the stream is owned by the `streamPty`
        // subscription, not by holding the surface.
        release: () => {},
      };
    },

    writePty: pty.writePty,
    resizePty: pty.resizePty,
    streamPty: pty.streamPty,
  };

  return {
    provider,

    notifyDirectoryChanged() {
      // Iterated live: a watcher may unsubscribe itself here, which a Set
      // tolerates mid-iteration, and this runs on every pane-state change.
      for (const watcher of directoryWatchers) watcher();
    },
  };
}
