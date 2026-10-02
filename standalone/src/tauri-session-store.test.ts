import { describe, it, expect, vi } from "vitest";
import { TauriSessionStore } from "./tauri-session-store";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TauriSessionStore", () => {
  it("getItem returns the hydrated seed until overwritten", () => {
    const store = new TauriSessionStore(async () => {});
    // Before hydrate: empty slot (fresh install / new window).
    expect(store.getItem("k")).toBeNull();
    store.hydrate('{"seed":1}');
    expect(store.getItem("k")).toBe('{"seed":1}');
  });

  it("setItem updates the cache synchronously and forwards the write", async () => {
    const saved: string[] = [];
    const store = new TauriSessionStore(async (v) => {
      saved.push(v);
    });
    store.setItem("k", "a");
    // Synchronous read reflects the write immediately (restore reads it sync).
    expect(store.getItem("k")).toBe("a");
    await tick();
    expect(saved).toEqual(["a"]);
  });

  it("coalesces a burst into the first write plus the latest value", async () => {
    const saved: string[] = [];
    const resolvers: Array<() => void> = [];
    const store = new TauriSessionStore(
      (v) =>
        new Promise<void>((res) => {
          saved.push(v);
          resolvers.push(res);
        }),
    );

    store.setItem("k", "a"); // starts the in-flight write of 'a'
    store.setItem("k", "b"); // queued
    store.setItem("k", "c"); // supersedes 'b' while still queued
    expect(saved).toEqual(["a"]);
    expect(store.getItem("k")).toBe("c"); // cache always holds the latest

    resolvers[0](); // 'a' settles → flush the latest pending ('c'), not 'b'
    await tick();
    expect(saved).toEqual(["a", "c"]);

    resolvers[1](); // 'c' settles → pipeline idle
    await tick();
    store.setItem("k", "d");
    expect(saved).toEqual(["a", "c", "d"]);
  });

  it("skips the save_session round-trip when the value is unchanged", async () => {
    const saved: string[] = [];
    const store = new TauriSessionStore(async (v) => {
      saved.push(v);
    });
    store.setItem("k", "a");
    await tick();
    expect(saved).toEqual(["a"]);
    // Identical value: the dirty gate should already suppress this, but the
    // store-level short-circuit backstops any miss — no second write.
    store.setItem("k", "a");
    await tick();
    expect(saved).toEqual(["a"]);
  });

  it("writes the first setItem after hydrate(null) (cold start)", async () => {
    // Mirrors tauri-adapter's hydrateSessionStore: hydrate(null) seeds no value, so
    // the first save is a genuine change the short-circuit can't swallow.
    const saved: string[] = [];
    const store = new TauriSessionStore(async (v) => {
      saved.push(v);
    });
    store.hydrate(null);
    store.setItem("k", '{"v":1}');
    // The cache updates synchronously for the cold-restore read that follows.
    expect(store.getItem("k")).toBe('{"v":1}');
    await tick();
    expect(saved).toEqual(['{"v":1}']);
  });

  it("recovers after a rejected write instead of wedging", async () => {
    const saved: string[] = [];
    let first = true;
    const store = new TauriSessionStore(async (v) => {
      saved.push(v);
      if (first) {
        first = false;
        throw new Error("boom");
      }
    });

    store.setItem("k", "a");
    await tick();
    expect(saved).toEqual(["a"]);

    store.setItem("k", "b"); // must still flush despite the prior rejection
    await tick();
    expect(saved).toEqual(["a", "b"]);
  });

  it("drain resolves immediately when the pipeline is idle", async () => {
    const store = new TauriSessionStore(async () => {});
    let resolved = false;
    void store.drain().then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true);
  });

  it("retries an unchanged value after its previous write failed", async () => {
    const saved: string[] = [];
    const store = new TauriSessionStore(async (value) => {
      saved.push(value);
      if (saved.length === 1) throw new Error("transient disk error");
    });
    store.setItem("k", "a");
    await store.drain();
    expect(store.getItem("k")).toBe("a");
    store.setItem("k", "a");
    await store.drain();
    expect(saved).toEqual(["a", "a"]);
    store.setItem("k", "a");
    await store.drain();
    expect(saved).toEqual(["a", "a"]);
  });

  it("persists an unchanged cache after close preparation refused its write and the window stayed open", async () => {
    let closing = true;
    let persisted = "previous";
    const store = new TauriSessionStore(async (value) => {
      // Rust save_open_window_session refuses rather than acknowledging a
      // skipped write while close preparation owns the snapshot.
      if (closing) throw new Error("window close is holding its snapshot; no session was saved");
      persisted = value;
    });
    store.hydrate(persisted);
    store.setItem("k", "newer");
    await store.drain();
    expect(persisted).toBe("previous");
    expect(store.getItem("k")).toBe("newer");
    closing = false;
    store.setItem("k", "newer");
    await store.drain();
    expect(persisted).toBe("newer");
  });

  it("drain resolves only after an in-flight save settles", async () => {
    let release!: () => void;
    const store = new TauriSessionStore(
      () => new Promise<void>((res) => (release = res)),
    );

    store.setItem("k", "a"); // starts the in-flight write of 'a'
    let drained = false;
    void store.drain().then(() => {
      drained = true;
    });
    await tick();
    expect(drained).toBe(false); // still in flight

    release();
    await tick();
    expect(drained).toBe(true);
  });

  it("drain covers a setItem issued while draining (chains as pending)", async () => {
    const saved: string[] = [];
    const resolvers: Array<() => void> = [];
    const store = new TauriSessionStore(
      (v) =>
        new Promise<void>((res) => {
          saved.push(v);
          resolvers.push(res);
        }),
    );

    store.setItem("k", "a"); // in flight
    let drained = false;
    void store.drain().then(() => {
      drained = true;
    });
    // Issued mid-drain while 'a' is still in flight: chains as pending, so the
    // drain must not resolve until this later write also lands.
    store.setItem("k", "b");

    resolvers[0](); // 'a' settles → flush 'b'
    await tick();
    expect(drained).toBe(false);

    resolvers[1](); // 'b' settles → idle
    await tick();
    expect(drained).toBe(true);
    expect(saved).toEqual(["a", "b"]);
  });

  it("drain still resolves after a rejected write", async () => {
    let reject!: (err: unknown) => void;
    const store = new TauriSessionStore(
      () => new Promise<void>((_res, rej) => (reject = rej)),
    );

    store.setItem("k", "a"); // in flight
    let drained = false;
    void store.drain().then(() => {
      drained = true;
    });

    reject(new Error("boom")); // store logs-and-continues; pipeline goes idle
    await tick();
    expect(drained).toBe(true);
  });
  it("remembers only one idle retry and uses the latest queued value", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let rejectFirst!: (error: Error) => void;
      const values: string[] = [];
      const store = new TauriSessionStore(async (value) => {
        values.push(value);
        if (values.length === 1) await new Promise<void>((_, reject) => { rejectFirst = reject; });
        else throw new Error('still unavailable');
      });
      store.hydrate('previous');
      store.setItem('', 'first');
      store.retryLatest();
      store.setItem('', 'newest');
      rejectFirst(new Error('refused'));
      await store.drain();
      expect(values).toEqual(['first', 'newest']);
    } finally { log.mockRestore(); }
  });

  it("does not duplicate an in-flight successful save when retry is remembered", async () => {
    let complete!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const store = new TauriSessionStore(save);
    store.setItem('', 'latest');
    store.retryLatest();
    complete();
    await store.drain();
    expect(save).toHaveBeenCalledOnce();
  });

});
