/**
 * Sync-to-pane, owned by the host (docs/specs/dor-browser.md → "Display Modal
 * And Render Swaps"). A pane's viewer socket names the pane's size; the host
 * writes it to that browser one write at a time and judges the browser's own
 * viewport against the size it wrote. Only the host knows when its writes
 * began and landed, so only it can tell a report taken before a write from
 * another writer — an agent's `set viewport` — which ends the sync.
 */
import { messageOf } from '../lib/errors';
import type { BrowserResult, ViewerState, ViewerSyncIntent, ViewerSyncState } from '../lib/platform/browser-automation';
import type { ViewportSize } from './browser-viewer';

type SyncSize = ViewportSize & { dpr: number };

/** How long the browser's viewport must differ from the size last written,
 *  with no write since, before it is another writer's: a frame already in
 *  flight when a write landed is replaced well inside it (rationale). */
export const SYNC_SETTLE_MS = 250;

// Only the CSS size is judged — a screencast frame never shows the ratio — and
// rounding can leave a dimension a pixel off.
const DIM_TOLERANCE = 1;
const sameSize = (a: ViewportSize, b: ViewportSize) =>
  Math.abs(a.width - b.width) <= DIM_TOLERANCE && Math.abs(a.height - b.height) <= DIM_TOLERANCE;
const sameIntent = (a: SyncSize, b: SyncSize) => sameSize(a, b) && Math.abs(a.dpr - b.dpr) <= 0.001;

/** One browser's sync. */
interface Sync<B> {
  readonly id: string;
  browser: B;
  /** The stream of the browser it sizes. */
  stream: number;
  /** The choice of Resize with pane it serves, by the webview's id for it. */
  engagement: string;
  engaged: boolean;
  /** The pane's latest size. */
  target: SyncSize;
  /** What the last write that landed set. */
  applied: SyncSize | undefined;
  /** The size written no longer holds: another page is shown, or a new
   *  engagement reclaims the viewport. */
  stale: boolean;
  /** The write in flight. */
  writing: Promise<void> | undefined;
  /** When the latest write landed (`performance.now()`): a viewport taken
   *  before then may show the size before it. */
  settledAt: number;
  /** Running while the viewport differs from the size written. */
  mismatch: ReturnType<typeof setTimeout> | undefined;
  state: ViewerSyncState;
}

export interface ViewportSyncDeps<B> {
  /** Size the browser; answers once the write has landed or failed. */
  write(browser: B, size: SyncSize): Promise<BrowserResult>;
  /** Send `message` to every pane viewing browser `id`. */
  report(id: string, message: Extract<ViewerState, { type: 'sync' }>): void;
  /** Whether nothing may reach browser `id` now: a launch or close of it
   *  runs, or the host is shutting down. */
  blocked(id: string): boolean;
  log(message: string): void;
}

export function createViewportSync<B>(deps: ViewportSyncDeps<B>) {
  const syncs = new Map<string, Sync<B>>();
  // The page each browser shows, by its tab id, whether or not a pane syncs it.
  const shown = new Map<string, string>();

  function report(s: Sync<B>): void {
    deps.report(s.id, { type: 'sync', state: s.engaged ? s.state : 'off', engagement: s.engagement });
  }

  function setState(s: Sync<B>, state: ViewerSyncState): void {
    if (s.state === state) return;
    s.state = state;
    report(s);
  }

  function settle(s: Sync<B>): void {
    clearTimeout(s.mismatch);
    s.mismatch = undefined;
  }

  function forget(id: string): void {
    const s = syncs.get(id);
    if (s) settle(s);
    syncs.delete(id);
    shown.delete(id);
  }

  /** Stop syncing: another writer set the browser's viewport. */
  function release(s: Sync<B>): void {
    settle(s);
    if (!s.engaged) return;
    s.engaged = false;
    report(s);
  }

  /** Write the pane's latest size, unless a write runs — it writes the
   *  latest once it lands, so a drag coalesces — or that size holds. */
  function pump(s: Sync<B>): void {
    const size = s.target;
    if (syncs.get(s.id) !== s || !s.engaged || s.writing) return;
    if (!s.stale && s.applied && sameIntent(s.applied, size)) return;
    // A launch or close under way forgets this browser's sync.
    if (deps.blocked(s.id)) return;
    s.stale = false;
    settle(s);
    setState(s, 'applying');
    s.writing = deps.write(s.browser, size).catch((error: unknown): BrowserResult => ({ ok: false, error: messageOf(error) })).then((result) => {
      s.writing = undefined;
      s.settledAt = performance.now();
      s.applied = result.ok ? size : undefined;
      if (!result.ok) deps.log(`[browser-sync] sizing ${s.id} failed: ${result.error ?? 'no reason given'}`);
      // A failed write is retried by the pane's next size, never at once.
      if (result.ok || s.target !== size) pump(s);
    });
  }

  return {
    /** The pane's size from a pane's socket on the browser at `stream`. A new
     *  engagement reclaims the viewport even at the size last written; one
     *  the host stopped answers `off` and writes nothing. */
    intent(browser: B, id: string, stream: number, intent: ViewerSyncIntent): void {
      let s = syncs.get(id);
      // Another browser streams under this identity now (a `dor ab` re-run).
      if (s && s.stream !== stream) {
        forget(id);
        s = undefined;
      }
      const size = { width: intent.width, height: intent.height, dpr: intent.dpr };
      if (!s) {
        s = {
          id, browser, stream, engagement: intent.engagement, engaged: true, target: size, applied: undefined, stale: false,
          writing: undefined, settledAt: -Infinity, mismatch: undefined, state: 'applying',
        };
        syncs.set(id, s);
      } else if (intent.engagement !== s.engagement) {
        s.engagement = intent.engagement;
        s.engaged = true;
        s.stale = true;
        s.state = 'applying';
      }
      s.browser = browser;
      if (s.engaged) {
        s.target = size;
        pump(s);
      }
      report(s);
    },

    /** The browser's viewport as its provider vouches for it, taken at
     *  `takenAt`. Only one taken after the latest write landed counts: one
     *  that differs from it for `SYNC_SETTLE_MS`, with no write since, is
     *  another writer's. */
    viewport(id: string, stream: number, size: ViewportSize, takenAt: number): void {
      const s = syncs.get(id);
      if (!s || s.stream !== stream || !s.engaged || s.writing || !s.applied || takenAt < s.settledAt) return;
      if (sameSize(size, s.applied)) {
        settle(s);
        setState(s, 'synced');
      } else {
        s.mismatch ??= setTimeout(() => release(s), SYNC_SETTLE_MS);
      }
    },

    /** The browser shows page `tabId`: another page is sized, never judged. */
    pageShown(id: string, stream: number, tabId: string): void {
      const before = shown.get(id);
      shown.set(id, tabId);
      const s = syncs.get(id);
      if (before === undefined || before === tabId || !s || s.stream !== stream) return;
      s.stale = true;
      pump(s);
    },

    /** A Fixed viewport or device for browser `id`: it ends the sync, and
     *  runs once the write in flight has landed. */
    fixed(id: string): Promise<void> | undefined {
      const s = syncs.get(id);
      if (!s) return undefined;
      release(s);
      return s.writing;
    },

    /** A launch or close replaces or ends browser `id`. */
    forget,

    /** Shutdown. */
    close(): void {
      for (const s of syncs.values()) settle(s);
      syncs.clear();
      shown.clear();
    },
  };
}
