/**
 * Sync-to-pane, owned by the host (docs/specs/dor-browser.md → "Display Modal
 * And Render Swaps"). A pane's viewer socket names the pane's size; the host
 * writes it to that browser one write at a time and judges the browser's own
 * viewport against the size it wrote. Only the host knows when its writes
 * began and landed, so only it can tell a report taken before a write from
 * another writer — an agent's `set viewport` — which ends the sync.
 *
 * Both providers size each page alone, and a page shown anew — a popup, the
 * tab left when the active one closes — keeps whatever size it had: the pane's
 * size, or else the last Fixed one this host wrote, is written to it too.
 */
import { messageOf } from '../lib/errors';
import type { BrowserResult, ViewerState, ViewerSyncIntent, ViewerSyncState } from '../lib/platform/browser-automation';
import type { BrowserViewDeps, ViewportSize } from './browser-viewer';

type SyncSize = ViewportSize & { dpr: number };
/** A Fixed viewport as asked for: without a ratio, the page keeps its own. */
export type FixedSize = ViewportSize & { dpr?: number };

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
  browser: B;
  /** The stream of the browser it sizes. */
  stream: number;
  /** The choice of Resize with pane it serves, by the webview's id for it. */
  engagement: string;
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
  landedAt: number;
  /** Running while the viewport differs from the size written. */
  mismatch: ReturnType<typeof setTimeout> | undefined;
  /** `off` once another writer took the viewport, until a new engagement. */
  state: ViewerSyncState;
}

export interface ViewportSyncDeps<B> {
  /** Size the browser, unless `isCurrent` no longer holds when the write's
   *  turn comes; answers once it has landed or failed. `keepDpr`: a Fixed
   *  size's ratio, as asked, rather than the pane's display ratio, which
   *  only a provider that can apply it writes. */
  write(browser: B, size: FixedSize, opts: { isCurrent: () => boolean; keepDpr?: boolean }): Promise<BrowserResult>;
  /** Send `message` to every pane viewing browser `id`. */
  report(id: string, message: Extract<ViewerState, { type: 'sync' }>): void;
  /** Whether nothing may reach browser `id` now: a launch or close of it
   *  runs, or the host is shutting down. */
  blocked(id: string): boolean;
  log(message: string): void;
}

export function createViewportSync<B extends { id: string }>(deps: ViewportSyncDeps<B>) {
  const syncs = new Map<string, Sync<B>>();
  // A Fixed choice and its earlier sync intents use different transports.
  // Remember every ended engagement for this browser's lifetime, including
  // ones whose first intent has not arrived. A later engagement cannot revive
  // an older one still arriving on another viewer socket.
  const ended = new Map<string, Set<string>>();
  // The page each browser shows, by its provider's key, whether or not a pane
  // syncs it.
  const shown = new Map<string, string>();
  // The Fixed viewport this host last wrote to each browser not syncing — a
  // launch's initial one included — until a pane engages sync, and the
  // pages it has been written to since.
  const fixedSizes = new Map<string, { size: FixedSize; pages: Set<string> }>();

  function report(s: Sync<B>): void {
    deps.report(s.browser.id, { type: 'sync', state: s.state, engagement: s.engagement });
  }

  function setState(s: Sync<B>, state: ViewerSyncState): void {
    if (s.state === state) return;
    s.state = state;
    report(s);
  }

  function clearMismatch(s: Sync<B>): void {
    clearTimeout(s.mismatch);
    s.mismatch = undefined;
  }

  function forget(id: string): void {
    const s = syncs.get(id);
    if (s) clearMismatch(s);
    syncs.delete(id);
    ended.delete(id);
    shown.delete(id);
    fixedSizes.delete(id);
  }

  /** Stop syncing: another writer set the browser's viewport. */
  function release(s: Sync<B>): void {
    clearMismatch(s);
    end(s.browser.id, s.engagement);
    setState(s, 'off');
  }

  function end(id: string, engagement: string): void {
    let engagements = ended.get(id);
    if (!engagements) ended.set(id, engagements = new Set());
    engagements.add(engagement);
  }

  /** Write the pane's latest size, unless a write runs — it writes the
   *  latest once it lands, so a drag coalesces — or that size holds. */
  function pump(s: Sync<B>): void {
    const size = s.target;
    const { id } = s.browser;
    if (syncs.get(id) !== s || s.state === 'off' || s.writing) return;
    if (!s.stale && s.applied && sameIntent(s.applied, size)) return;
    // A launch or close under way forgets this browser's sync.
    if (deps.blocked(id)) return;
    s.stale = false;
    clearMismatch(s);
    setState(s, 'applying');
    const engagement = s.engagement;
    s.writing = deps.write(s.browser, size, { isCurrent: () => syncs.get(id) === s && s.state !== 'off' && s.engagement === engagement })
      .catch((error: unknown): BrowserResult => ({ ok: false, error: messageOf(error) }))
      .then((result) => {
        s.writing = undefined;
        s.landedAt = performance.now();
        s.applied = result.ok ? size : undefined;
        if (!result.ok) deps.log(`[browser-sync] sizing ${id} failed: ${result.error ?? 'no reason given'}`);
        // A failed write is retried by the pane's next size, never at once.
        if (result.ok || s.target !== size) pump(s);
      });
  }

  /** The pane's size from a pane's socket on the browser at `stream`. A new
   *  engagement reclaims the viewport even at the size last written; one the
   *  host stopped answers `off` and writes nothing. */
  function intent(browser: B, stream: number, message: ViewerSyncIntent): void {
    const { id } = browser;
    if (ended.get(id)?.has(message.engagement)) {
      deps.report(id, { type: 'sync', state: 'off', engagement: message.engagement });
      return;
    }
    fixedSizes.delete(id);
    let s = syncs.get(id);
    // Another browser streams under this identity now (a `dor agent-browser` re-run).
    if (s && s.stream !== stream) {
      forget(id);
      s = undefined;
    }
    const size = { width: message.width, height: message.height, dpr: message.dpr };
    if (!s) {
      s = {
        browser, stream, engagement: message.engagement, target: size, applied: undefined, stale: false,
        writing: undefined, landedAt: -Infinity, mismatch: undefined, state: 'applying',
      };
      syncs.set(id, s);
    } else if (message.engagement !== s.engagement) {
      s.engagement = message.engagement;
      s.stale = true;
      s.state = 'applying';
    }
    s.browser = browser;
    if (s.state !== 'off') {
      s.target = size;
      pump(s);
    }
    report(s);
  }

  /** The browser's viewport as its provider vouches for it, taken at
   *  `takenAt`. Only one taken after the latest write landed counts: one that
   *  differs from it for `SYNC_SETTLE_MS`, with no write since, is another
   *  writer's. */
  function viewport(id: string, stream: number, size: ViewportSize, takenAt: number): void {
    const s = syncs.get(id);
    if (!s || s.stream !== stream || s.state === 'off' || s.writing || !s.applied || takenAt < s.landedAt) return;
    if (sameSize(size, s.applied)) {
      clearMismatch(s);
      setState(s, 'synced');
    } else {
      s.mismatch ??= setTimeout(() => release(s), SYNC_SETTLE_MS);
    }
  }

  /** The browser shows `page`: another page is sized, never judged. */
  function pageShown(browser: B, stream: number, page: string): void {
    const { id } = browser;
    const before = shown.get(id);
    shown.set(id, page);
    if (before === undefined || before === page) return;
    const s = syncs.get(id);
    if (s && s.stream === stream && s.state !== 'off') {
      s.stale = true;
      pump(s);
      return;
    }
    // A page shown again already has the size.
    const fixed = fixedSizes.get(id);
    if (!fixed || fixed.pages.has(page) || deps.blocked(id)) return;
    fixed.pages.add(page);
    void deps.write(browser, fixed.size, { isCurrent: () => fixedSizes.get(id) === fixed, keepDpr: true })
      .catch((error: unknown): BrowserResult => ({ ok: false, error: messageOf(error) }))
      .then((result) => {
        if (result.ok) return;
        fixed.pages.delete(page);
        deps.log(`[browser-sync] sizing ${id}'s page shown anew failed: ${result.error ?? 'no reason given'}`);
      });
  }

  return {
    /** Sync-to-pane's side of one pane's viewer socket on `browser` at
     *  `stream`. */
    view(browser: B, stream: number): NonNullable<BrowserViewDeps['sync']> {
      return {
        intent: (message) => intent(browser, stream, message),
        viewport: (size, takenAt) => viewport(browser.id, stream, size, takenAt),
        pageShown: (page) => pageShown(browser, stream, page),
      };
    },

    /** Commit a successful Fixed viewport, which a page shown anew is given
     *  too. An engagement chosen after the Fixed request arrived owns the
     *  browser's next size. */
    fixed(id: string, engagement: string | undefined, size: FixedSize): void {
      const page = shown.get(id);
      fixedSizes.set(id, { size, pages: new Set(page === undefined ? [] : [page]) });
      if (engagement === undefined) return;
      end(id, engagement);
      const s = syncs.get(id);
      if (!s || s.engagement !== engagement) return;
      release(s);
    },

    current(id: string): string | undefined { return syncs.get(id)?.engagement; },

    /** Browser `id`'s sizing as it stands, for `dor`'s diagnostics. */
    diagnostics(id: string): Record<string, unknown> {
      const s = syncs.get(id);
      return {
        shownPage: shown.get(id) ?? null,
        fixed: fixedSizes.get(id)?.size ?? null,
        sync: s ? { stream: s.stream, engagement: s.engagement, state: s.state, target: s.target, applied: s.applied ?? null, writing: !!s.writing, stale: s.stale } : null,
      };
    },

    /** A launch or close replaces or ends browser `id`. */
    forget,

    /** Shutdown. */
    close(): void {
      for (const s of syncs.values()) clearMismatch(s);
      syncs.clear();
      ended.clear();
      shown.clear();
      fixedSizes.clear();
    },
  };
}
