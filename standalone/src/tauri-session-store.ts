import { invoke as rawInvoke } from "@tauri-apps/api/core";
import type { SessionKeyValueStore } from "dormouse-lib/lib/window-persistence";

/** Persist the blob to the host; the default routes to the Rust `save_session`
 *  command (keyed implicitly by the invoking Tauri window). Injectable for tests. */
type SessionSaveFn = (value: string) => Promise<void>;

const invokeSave: SessionSaveFn = (value) => rawInvoke("save_session", { state: value });

/**
 * Standalone-native backing for the session seam (`docs/specs/standalone.md`
 * §Persistence). `window-persistence.ts` reads/writes the `PersistedWindow`
 * blob through a synchronous {@link SessionKeyValueStore}; on WKWebView that
 * used to be `localStorage`, whose SQLite WAL grew unbounded. This replaces it
 * with an in-memory cache seeded once at boot from the Rust file store, with
 * writes forwarded asynchronously to Rust.
 *
 * `getState()` stays synchronous (cold-start restore reads it before React
 * mounts): reads hit the cache, and the cache is hydrated in `init()` — which
 * `bootstrap()` awaits before restore — mirroring how the VS Code adapter reads
 * a host-injected seed.
 *
 * Writes coalesce: at most one `save_session` is in flight; if `setItem` fires
 * again mid-save, only the latest value is written when the current one settles,
 * so a burst of saves collapses to two Rust round-trips, not N.
 */
export class TauriSessionStore implements SessionKeyValueStore {
  private cache: string | null = null;
  private saveInFlight = false;
  // Latest value queued behind an in-flight save, or null when nothing is
  // queued. A queued `value` is always a JSON string (never JS null), so null is
  // a safe "nothing pending" sentinel — even an empty-string blob is distinct.
  private pending: string | null = null;
  // Resolvers for pending drain() calls, fired when the pipeline next goes idle.
  private drainWaiters: Array<() => void> = [];

  constructor(private readonly save: SessionSaveFn = invokeSave) {}

  /**
   * Resolve when the write pipeline is idle — no save in flight and nothing
   * queued. Idle at call time resolves immediately; otherwise resolves after the
   * LAST chained flush settles (a `setItem` issued while draining chains as the
   * pending value and pushes the idle point out, so it is covered). Rejected
   * writes still drain — the store logs-and-continues in `flush`. Semantics:
   * pipeline-idle at call time forward. A `setItem` that starts a fresh pipeline
   * after this drain has already resolved is not covered by that resolved call.
   */
  drain(): Promise<void> {
    if (!this.saveInFlight) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /** Seed the cache from the host's persisted blob (or null) at boot. */
  hydrate(seed: string | null): void {
    this.cache = seed;
  }

  // One blob per window ⇒ one slot, so the key is ignored: the axis that
  // separates windows is the Tauri window label, applied in Rust (save_session /
  // load_session), not this key. localStorage-backed callers still pass the
  // adapter's STATE_KEY, which this store simply doesn't need.
  getItem(_key: string): string | null {
    return this.cache;
  }

  setItem(_key: string, value: string): void {
    // Backstop under the frontend dirty gate: a byte-identical blob issues no
    // round-trip. Valid from the first write — `hydrate` boot-seeds the cache.
    if (value === this.cache) return;
    this.cache = value;
    if (this.saveInFlight) {
      this.pending = value;
      return;
    }
    this.saveInFlight = true;
    this.flush(value);
  }

  private flush(value: string): void {
    this.save(value)
      .catch((err) => console.error("[tauri-session-store] save_session failed:", err))
      .finally(() => {
        if (this.pending !== null) {
          const next = this.pending;
          this.pending = null;
          this.flush(next);
        } else {
          this.saveInFlight = false;
          // Pipeline idle: release everyone awaiting drain(). Snapshot first so a
          // waiter that re-enters (e.g. schedules another save) can't mutate the
          // array mid-iteration.
          const waiters = this.drainWaiters;
          this.drainWaiters = [];
          for (const resolve of waiters) resolve();
        }
      });
  }
}
