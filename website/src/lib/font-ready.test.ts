import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FONT_READY_SCRIPT } from "./font-ready";

function boot(fontsAvailable = true) {
  vi.useFakeTimers();
  const attributes = new Map<string, string>();
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  const ready = { promise, resolve, reject };
  const onReady = vi.fn();
  const layout = vi.fn();
  const document = {
    documentElement: {
      setAttribute: (key: string, value: string) => attributes.set(key, value),
      removeAttribute: (key: string) => attributes.delete(key),
    },
    body: { get offsetHeight() { layout(); return 100; } },
    fonts: fontsAvailable ? {
      get ready() {
        onReady();
        expect(layout).toHaveBeenCalledOnce();
        return ready.promise;
      },
    } : undefined,
    addEventListener: vi.fn(),
  };
  runInNewContext(FONT_READY_SCRIPT, { document, setTimeout, clearTimeout });
  return {
    hidden: () => attributes.has("data-fonts-pending"),
    parsed: () => document.addEventListener.mock.calls[0][1](),
    ready,
    onReady,
  };
}

afterEach(() => vi.useRealTimers());

describe("initial font paint", () => {
  it("hides before parsing and reveals only after the page's font layout is ready", async () => {
    const page = boot();
    expect(page.hidden()).toBe(true);
    expect(page.onReady).not.toHaveBeenCalled();
    page.parsed();
    expect(page.hidden()).toBe(true);
    page.ready.resolve();
    await page.ready.promise;
    expect(page.hidden()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reveals when fonts fail", async () => {
    const page = boot();
    page.parsed();
    page.ready.reject(new Error("font unavailable"));
    await Promise.resolve();
    expect(page.hidden()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("bounds the wait even if parsing completed: %s", async (parsed) => {
    const page = boot();
    if (parsed) page.parsed();
    vi.advanceTimersByTime(3000);
    expect(page.hidden()).toBe(false);
    // Late completion must not hide the page again.
    if (!parsed) page.parsed();
    page.ready.resolve();
    await page.ready.promise;
    expect(page.hidden()).toBe(false);
  });

  it("leaves content visible without the Font Loading API", () => {
    const page = boot(false);
    expect(page.hidden()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
