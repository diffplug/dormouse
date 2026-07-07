import { describe, expect, it, vi } from "vitest";

// The in-process session-flush handshake and drain wrappers on TauriAdapter are
// pure webview-side logic — they never invoke Tauri — so we only need to stub the
// Tauri modules so the adapter module imports and constructs. Mirrors the mocking
// pattern in updater.test.ts; not a full IPC harness.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(async () => {}),
}));

import { TauriAdapter } from "./tauri-adapter";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("TauriAdapter session-flush handshake", () => {
  it("resolves immediately when no flush handler is registered", async () => {
    const adapter = new TauriAdapter();
    let resolved = false;
    void adapter.requestSessionFlush(50).then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true);
  });

  it("fans a requestId out to handlers and resolves on completion", async () => {
    const adapter = new TauriAdapter();
    let seenRequestId: string | null = null;
    const handler = (detail: { requestId: string }) => {
      seenRequestId = detail.requestId;
    };
    adapter.onRequestSessionFlush(handler);

    let resolved = false;
    void adapter.requestSessionFlush(1000).then(() => {
      resolved = true;
    });
    await tick();
    expect(seenRequestId).not.toBeNull();
    expect(resolved).toBe(false); // waits for completion

    adapter.notifySessionFlushComplete(seenRequestId!);
    await tick();
    expect(resolved).toBe(true);
  });

  it("resolves on timeout when a handler never completes", async () => {
    const adapter = new TauriAdapter();
    adapter.onRequestSessionFlush(() => {
      /* never calls notifySessionFlushComplete */
    });

    let resolved = false;
    void adapter.requestSessionFlush(10).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(true);
  });

  it("stops fanning out to a removed handler", async () => {
    const adapter = new TauriAdapter();
    const handler = vi.fn();
    adapter.onRequestSessionFlush(handler);
    adapter.offRequestSessionFlush(handler);

    // No handlers left ⇒ immediate resolve, handler never invoked.
    await adapter.requestSessionFlush(1000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores a stale/duplicate completion for an already-settled request", async () => {
    const adapter = new TauriAdapter();
    let seenRequestId: string | null = null;
    adapter.onRequestSessionFlush((detail) => {
      seenRequestId = detail.requestId;
    });
    const done = adapter.requestSessionFlush(1000);
    await tick();
    adapter.notifySessionFlushComplete(seenRequestId!);
    await done;
    // A second notify (or an unknown requestId) is a harmless no-op.
    expect(() => adapter.notifySessionFlushComplete(seenRequestId!)).not.toThrow();
    expect(() => adapter.notifySessionFlushComplete("bogus")).not.toThrow();
  });

  it("drainSessionSaves resolves immediately when the store pipeline is idle", async () => {
    const adapter = new TauriAdapter();
    let resolved = false;
    void adapter.drainSessionSaves(1000).then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true);
  });
});
