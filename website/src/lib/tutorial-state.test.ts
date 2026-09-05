import { afterEach, describe, expect, it, vi } from "vitest";
import { TutorialState } from "./tutorial-state";

afterEach(() => vi.unstubAllGlobals());

function installStorage(values = new Map<string, string>()) {
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("localStorage", storage);
  return { storage, values };
}

function completeAndReset(state: TutorialState) {
  const changed = vi.fn();
  state.subscribe(changed);
  expect(state.markComplete("th-theme")).toBe(true);
  expect(state.resolveStarPrompt()).toBe(true);
  expect(state.recordFlappyScore(12)).toBe(true);
  expect(state.isComplete("th-theme")).toBe(true);
  state.reset();
  expect(state.isComplete("th-theme")).toBe(false);
  expect(state.isStarPromptResolved()).toBe(false);
  expect(state.getFlappyHighScore()).toBe(0);
  expect(changed).toHaveBeenCalledTimes(4);
}

describe("tutorial persistence", () => {
  it("restores existing formats, filters unknown items, and clears every key", () => {
    const { values } = installStorage(new Map([
      ["dormouse-tut-v3", '["th-theme","retired-item",17]'],
      ["dormouse-tut-star-v1", "true"],
      ["dormouse-flappy-high-v1", "12"],
    ]));
    const state = new TutorialState();
    expect(state.totalProgress().done).toBe(1);
    expect(state.isComplete("th-theme")).toBe(true);
    expect(state.isStarPromptResolved()).toBe(true);
    expect(state.getFlappyHighScore()).toBe(12);
    state.recordFlappyScore(13);
    expect(values.get("dormouse-flappy-high-v1")).toBe("13");
    state.reset();
    expect(values.size).toBe(0);
  });

  it("works when the localStorage getter is denied", () => {
    vi.stubGlobal("localStorage", undefined);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => { throw new Error("storage denied"); },
    });
    completeAndReset(new TutorialState());
  });

  it("works when storage methods are denied", () => {
    const { storage } = installStorage();
    for (const method of ["getItem", "setItem", "removeItem"] as const) {
      vi.spyOn(storage, method).mockImplementation(() => { throw new Error("storage denied"); });
    }
    completeAndReset(new TutorialState());
  });

  it("starts fresh after malformed stored values", () => {
    installStorage(new Map([
      ["dormouse-tut-v3", "{"],
      ["dormouse-tut-star-v1", '"true"'],
      ["dormouse-flappy-high-v1", "-12"],
    ]));
    completeAndReset(new TutorialState());
  });
});
