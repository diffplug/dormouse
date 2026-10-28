/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"url": "https://dormouse.sh/hosted/"}
 */
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POCKET_TUTORIAL_PROFILE } from "./tut-items";
import { TutorialState } from "./tutorial-state";

const POSTHOG = "posthog-js/dist/module.slim.no-external.js";

/** A fresh copy of the module, so its one client is unmade. */
const fresh = async () => {
  vi.resetModules();
  return import("./site-analytics");
};

/** A posthog stand-in that records whether it was ever loaded, and what it captured. */
function fakePosthog() {
  const loaded = vi.fn();
  const capture = vi.fn();
  vi.doMock(POSTHOG, () => {
    loaded();
    return { default: { init: vi.fn(), capture } };
  });
  return { loaded, capture };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setSignals(signals: { globalPrivacyControl?: boolean; doNotTrack?: string | null }) {
  for (const [key, value] of Object.entries(signals)) {
    Object.defineProperty(navigator, key, { value, configurable: true });
  }
}

afterEach(() => {
  setSignals({ globalPrivacyControl: undefined, doNotTrack: null });
  vi.doUnmock(POSTHOG);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("analyticsAllowed", () => {
  it("is false under Global Privacy Control or Do Not Track, and true with neither", async () => {
    const { analyticsAllowed } = await fresh();
    expect(analyticsAllowed({ globalPrivacyControl: true })).toBe(false);
    expect(analyticsAllowed({ doNotTrack: "1" })).toBe(false);
    expect(analyticsAllowed({ globalPrivacyControl: false, doNotTrack: "0" })).toBe(true);
    expect(analyticsAllowed({})).toBe(true);
  });
});

describe("the loader", () => {
  it.each([
    ["Global Privacy Control", { globalPrivacyControl: true }],
    ["Do Not Track", { doNotTrack: "1" }],
  ])("never downloads PostHog under %s", async (_name, signals) => {
    setSignals(signals);
    const ph = fakePosthog();
    const { trackPageview, trackEvent } = await fresh();
    trackPageview("readme");
    trackEvent({ name: "hosted plan clicked", plan: "yearly" });
    await settle();
    expect(ph.loaded).not.toHaveBeenCalled();
  });

  it("loads PostHog once, on the first event, with neither signal", async () => {
    const ph = fakePosthog();
    const { trackPageview, trackEvent } = await fresh();
    expect(ph.loaded).not.toHaveBeenCalled();
    trackPageview(null);
    trackEvent({ name: "hosted plan clicked", plan: "yearly" });
    await settle();
    expect(ph.loaded).toHaveBeenCalledTimes(1);
    expect(ph.capture.mock.calls).toEqual([
      ["$pageview", undefined],
      ["hosted plan clicked", { plan: "yearly" }],
    ]);
  });
});

describe("what the real client sends and stores", () => {
  it("posts the ref to /ingest, cookieless, and leaves nothing on the device", { timeout: 10_000 }, async () => {
    const requests: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const raw = init?.body instanceof ArrayBuffer ? Buffer.from(init.body) : Buffer.from(String(init?.body ?? ""));
      requests.push({ url: String(url), body: JSON.parse((raw[0] === 0x1f ? gunzipSync(raw) : raw).toString()) });
      return new Response("{}", { status: 200 });
    }));
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    const cookieWrites = vi.fn();
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => cookie.get!.call(document),
      set: (value: string) => {
        cookieWrites(value);
        cookie.set!.call(document, value);
      },
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    const { trackPageview } = await fresh();
    trackPageview("readme");
    // posthog-js batches, flushing every few seconds; its timers are its own.
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 8000, interval: 100 });
    delete (document as { cookie?: string }).cookie;

    for (const { url } of requests) expect(url.startsWith("/ingest/")).toBe(true);
    const events = requests.flatMap(({ body }) => (body as { batch: { event: string; properties: Record<string, unknown> }[] }).batch);
    expect(events.map((e) => e.event)).toEqual(["$pageview"]);
    expect(events[0].properties).toMatchObject({
      ref: "readme",
      $cookieless_mode: true,
      distinct_id: "$posthog_cookieless",
      $process_person_profile: false,
    });

    expect(cookieWrites).not.toHaveBeenCalled();
    // posthog-js probes whether localStorage works by writing and removing one
    // key; that probe is the only write, and nothing is left behind.
    expect(new Set(setItem.mock.calls.map(([key]) => key))).toEqual(new Set(["__mplssupport__"]));
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });
});

describe("trackTutorialCompletion", () => {
  const items = POCKET_TUTORIAL_PROFILE.sections.flatMap((s) => s.items.map((i) => i.id));

  it("sends one event when this visit checks the last item, and again after a reset", async () => {
    const ph = fakePosthog();
    const { trackTutorialCompletion } = await fresh();
    const state = new TutorialState(POCKET_TUTORIAL_PROFILE.sections);
    const stop = trackTutorialCompletion(state, "pocket");
    for (const id of items.slice(0, -1)) state.markComplete(id);
    await settle();
    expect(ph.capture).not.toHaveBeenCalled();
    state.markComplete(items[items.length - 1]);
    state.resolveStarPrompt();
    await settle();
    expect(ph.capture.mock.calls).toEqual([["tutorial completed", { tutorial: "pocket" }]]);
    state.reset();
    for (const id of items) state.markComplete(id);
    await settle();
    expect(ph.capture).toHaveBeenCalledTimes(2);
    stop();
  });

  it("sends nothing for a tutorial finished on an earlier visit", async () => {
    const ph = fakePosthog();
    const { trackTutorialCompletion } = await fresh();
    const earlier = new TutorialState(POCKET_TUTORIAL_PROFILE.sections);
    for (const id of items) earlier.markComplete(id);
    const restored = new TutorialState(POCKET_TUTORIAL_PROFILE.sections);
    trackTutorialCompletion(restored, "pocket");
    restored.resolveStarPrompt();
    await settle();
    expect(ph.loaded).not.toHaveBeenCalled();
  });
});

describe("off dormouse.sh", () => {
  beforeEach(() => {
    vi.stubGlobal("location", new URL("http://localhost:5173/hosted/"));
  });

  it("downloads nothing, so a dev server or a preview counts no visits", async () => {
    const ph = fakePosthog();
    const { trackPageview } = await fresh();
    trackPageview(null);
    await settle();
    expect(ph.loaded).not.toHaveBeenCalled();
  });
});
