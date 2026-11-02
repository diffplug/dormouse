/**
 * The half of a {@link BurrowSurfaceProvider} that is the same wherever the Burrow
 * runs: everything it has to *ask* for, because only a webview knows what its
 * panes are called and how big its terminals are.
 *
 * The two installations — the Tauri sidecar (`sidecar-entry.ts`) and the VS Code
 * extension host (`vscode-ext/src/burrow.ts`) — differ in how an ask
 * travels and in who owns the PTYs, and in nothing else. So those two are
 * injected and the protocol-shaped middle lives here once: a Burrow that answered
 * an attach differently in one host than the other would be a protocol-v1
 * divergence nobody would see until a phone attached.
 */

import type {
  DirectoryEntry,
  BurrowSurfaceProvider,
  EmbeddedPage,
  SurfaceHandle,
  SurfaceHold,
} from '../../remote/burrow/burrow-surface-provider';
import type { PeerOps, PeerSurfaceParams, PeerSurfaceResult } from '../../remote/burrow/peer-surfaces';

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

/** How long a close may run: past an editor's own save timeout. */
const CLOSE_DEADLINE_MS = 30_000;
const CLOSE_POLL_MS = 100;

/** A close's answer as a peer gave it, or `null`: a peer window is another build. */
function closeAnswerOf(value: unknown): PeerOps['closeOp']['result'] | null {
  const answer = value as { outcome?: unknown; label?: unknown; message?: unknown } | null | undefined;
  switch (answer?.outcome) {
    case 'closed': case 'confirm': case 'pending':
      return { outcome: answer.outcome };
    case 'unsaved':
      return typeof answer.label === 'string' ? { outcome: 'unsaved', label: answer.label } : null;
    case 'refused':
      return typeof answer.message === 'string' ? { outcome: 'refused', message: answer.message } : null;
    default:
      return null;
  }
}

export function createAskSurfaceProvider(
  ask: SurfaceAsk,
  pty: Pick<BurrowSurfaceProvider, 'writePty' | 'resizePty' | 'streamPty'>,
): AskSurfaceProvider {
  const directoryWatchers = new Set<() => void>();

  /**
   * Give `hold` back at `ownerPtyId`'s owner, or at every answerer when none
   * was selected. Rejections are swallowed: nothing waits on a release, and a
   * Burrow process must never carry an unhandled one.
   */
  const release = (surfaceId: string, hold: SurfaceHold, ownerPtyId?: string): void => {
    void ask(
      'surfaceOp',
      { surfaceId, op: 'release', hold } satisfies PeerSurfaceParams,
      ownerPtyId,
    ).catch(() => {});
  };

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

    async resolveSurface(surfaceId, size, hold): Promise<SurfaceHandle | null> {
      // Attach-is-the-resize: the owner applies the size — and records the
      // hold — inside this round trip, because there is no way to reach into
      // its xterm afterwards without a second one (docs/specs/remote-api.md).
      // One surface has one owner, so the first answer is the answer.
      const [owner] = (await ask('surfaceOp', {
        surfaceId,
        op: 'attach',
        cols: size.cols,
        rows: size.rows,
        hold,
      } satisfies PeerSurfaceParams)) as PeerSurfaceResult[];
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
        // Only an owner response proves the resize happened. A vanished owner
        // must fail the request rather than acknowledge its cached dimensions.
        resize: async (nextCols, nextRows) => {
          const [settled] = (await ask(
            'surfaceOp',
            {
              surfaceId,
              op: 'resize',
              cols: nextCols,
              rows: nextRows,
              hold,
            } satisfies PeerSurfaceParams,
            owner.ptyId,
          )) as PeerSurfaceResult[];
          if (!settled) throw new Error('surface owner unavailable');
          cols = settled.cols;
          rows = settled.rows;
          return { cols, rows };
        },
        // Addressed to the owner that took the hold, like a resize.
        release: () => release(surfaceId, hold, owner.ptyId),
      };
    },

    releaseSurface(surfaceId, hold) {
      release(surfaceId, hold);
    },

    async resolveBrowser(surfaceId): Promise<EmbeddedPage | null> {
      // One surface has one owner, as for an attach. A peer is another build,
      // so only the two fields a page is read for cross.
      const [page] = (await ask('browserOp', { surfaceId } satisfies PeerOps['browserOp']['params'])) as Partial<
        PeerOps['browserOp']['result']
      >[];
      if (typeof page?.url !== 'string') return null;
      return { url: page.url, ...(typeof page.title === 'string' ? { title: page.title } : {}) };
    },

    async closeSurface(surfaceId, consent) {
      const deadline = Date.now() + CLOSE_DEADLINE_MS;
      let answers = await ask('closeOp', { surfaceId, ...consent } satisfies PeerOps['closeOp']['params']).catch(() => []);
      if (answers.length === 0) return { outcome: 'refused', message: 'This is no longer open on the computer.' };
      // Past an answer that went missing, which is no news of the close either way.
      for (;;) {
        const answer = closeAnswerOf(answers[0]);
        if (answer && answer.outcome !== 'pending') return answer;
        if (Date.now() >= deadline) return { outcome: 'refused', message: 'The computer did not finish closing this in time.' };
        await new Promise((resolve) => setTimeout(resolve, CLOSE_POLL_MS));
        answers = await ask('closeOp', { surfaceId, poll: true } satisfies PeerOps['closeOp']['params']).catch(() => []);
      }
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
