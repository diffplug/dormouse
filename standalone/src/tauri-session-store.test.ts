import { describe, it, expect } from "vitest";
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
});
