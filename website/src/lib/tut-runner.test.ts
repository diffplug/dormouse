import { describe, expect, it, vi } from "vitest";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import {
  POCKET_TUTORIAL_PROFILE,
  SECTIONS,
  type ItemId,
  type TutorialProfile,
} from "./tut-items";
import { TutRunner } from "./tut-runner";
import { TutorialState } from "./tutorial-state";

const FRAME_RESET = "\x1b[H\x1b[2J";

function mountRunner(
  completedIds: ItemId[] = [],
  options: {
    onOpenGithub?: () => void;
    onOpenPocket?: () => void;
    onNotifyPocket?: () => void;
    pocketTouchMode?: "gestures" | "selection" | "cursor";
    profile?: TutorialProfile;
  } = {},
) {
  const adapter = new FakePtyAdapter();
  const id = "test-pane";
  adapter.spawnPty(id);

  const frames: string[] = [];
  let exitCount = 0;
  adapter.onPtyData(({ data }) => frames.push(data));

  const profile = options.profile;
  const state = new TutorialState(profile?.sections);
  for (const itemId of completedIds) state.markComplete(itemId);
  let pocketTouchMode = options.pocketTouchMode ?? "gestures";
  const pocketTouchModeListeners = new Set<() => void>();

  const runner = new TutRunner({
    adapter,
    terminalId: id,
    state,
    profile,
    onExit: () => {
      exitCount += 1;
    },
    onTogglePlaceToPaste: profile?.id === "pocket" ? undefined : () => {},
    onOpenGithub: options.onOpenGithub,
    onOpenPocket: options.onOpenPocket,
    onNotifyPocket: options.onNotifyPocket,
    getPocketTouchMode: () => pocketTouchMode,
    subscribeToPocketTouchMode: (listener) => {
      pocketTouchModeListeners.add(listener);
      return () => {
        pocketTouchModeListeners.delete(listener);
      };
    },
  });
  adapter.setInputHandler(id, (data) => runner.handleInput(data));
  runner.start();

  return {
    state,
    sendKeys: (data: string) => adapter.writePty(id, data),
    lastFrame: () => {
      const all = frames.join("");
      const i = all.lastIndexOf(FRAME_RESET);
      return i >= 0 ? all.slice(i) : all;
    },
    setPocketTouchMode: (mode: "gestures" | "selection" | "cursor") => {
      pocketTouchMode = mode;
      for (const listener of pocketTouchModeListeners) listener();
    },
    exitCount: () => exitCount,
    dispose: () => runner.dispose(),
  };
}

describe("TutRunner snapshots", () => {
  it("renders the top-level menu", () => {
    const { lastFrame, dispose } = mountRunner();
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Keyboard navigation with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys("\r");
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Alert and TODO with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys("\x1b[B\r");
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Copy paste with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys("\x1b[B\x1b[B\r");
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("starts the Pocket tutorial inside Gesture navigation", () => {
    const { lastFrame, dispose } = mountRunner([], {
      profile: POCKET_TUTORIAL_PROFILE,
    });

    expect(lastFrame()).toContain("Gesture navigation");
    expect(lastFrame()).toContain("Switch between Select and Gestures");
    expect(lastFrame()).not.toContain("Dormouse Pocket Tutorial");
    dispose();
  });

  it("shows the Pocket title and section list after backing out", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner([], {
      profile: POCKET_TUTORIAL_PROFILE,
    });

    sendKeys("\x1b");

    expect(lastFrame()).toContain("Dormouse Pocket Tutorial");
    expect(lastFrame()).toContain("Gesture navigation");
    expect(lastFrame()).toContain("Copy paste");
    expect(lastFrame()).toContain("🐭 FlappyTerm 🐭");
    expect(lastFrame()).not.toContain("Keyboard navigation");
    expect(lastFrame()).not.toContain("Alert and TODO");
    expect(lastFrame()).toContain("[LOCKED 0/7]");
    dispose();
  });

  it("renders Pocket copy paste with a live Select mode prompt", () => {
    const { sendKeys, setPocketTouchMode, lastFrame, dispose } = mountRunner([], {
      profile: POCKET_TUTORIAL_PROFILE,
    });

    sendKeys("\x1b\x1b[B\r");
    expect(lastFrame()).toContain("Copy paste");
    expect(lastFrame()).toContain("0/3 complete");
    expect(lastFrame()).toContain('Tap "Select" to enable drag-to-copy');
    expect(lastFrame()).toContain("\x1b[33m●");
    expect(lastFrame()).not.toContain("Click the cursor icon");

    setPocketTouchMode("selection");
    expect(lastFrame()).toContain("Select is active");
    expect(lastFrame()).toContain("\x1b[32m●");
    expect(lastFrame()).not.toContain("\x1b[36m●");
    expect(lastFrame()).not.toContain("✓");
    dispose();
  });

  it("renders Keyboard navigation with all items complete", () => {
    const allKeyboardIds = SECTIONS[0].items.map((i) => i.id);
    const { sendKeys, lastFrame, dispose } = mountRunner(allKeyboardIds);
    sendKeys("\r");
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("backs out of a section with q before exiting from the menu", () => {
    const { sendKeys, lastFrame, exitCount, dispose } = mountRunner();
    sendKeys("\r");

    sendKeys("q");
    expect(lastFrame()).toContain("Dormouse Playground Tutorial");
    expect(exitCount()).toBe(0);

    sendKeys("q");
    expect(exitCount()).toBe(1);
    dispose();
  });

  it("opens GitHub and resolves the star prompt from the menu", () => {
    const onOpenGithub = vi.fn();
    const { state, sendKeys, lastFrame, dispose } = mountRunner([], { onOpenGithub });

    sendKeys("\x1b[B\x1b[B\x1b[B\r");

    expect(onOpenGithub).toHaveBeenCalledTimes(1);
    expect(state.isStarPromptResolved()).toBe(true);
    expect(lastFrame()).toContain("[thanks ⭐]");
    expect(lastFrame()).not.toContain("[not yet]");
    dispose();
  });

  it("clears the star prompt when reset progress is confirmed", () => {
    const { state, sendKeys, dispose } = mountRunner(["kb-mode"]);
    state.resolveStarPrompt();

    sendKeys("\x1b[B\x1b[B\x1b[B\x1b[B\x1b[B\rreset\r");

    expect(state.isComplete("kb-mode")).toBe(false);
    expect(state.isStarPromptResolved()).toBe(false);
    dispose();
  });

  it("returns the Pocket tutorial to Gesture navigation after reset progress", () => {
    const { state, sendKeys, lastFrame, dispose } = mountRunner(["gn-arrows"], {
      profile: POCKET_TUTORIAL_PROFILE,
    });
    state.resolveStarPrompt();

    sendKeys("\x1b\x1b[B\x1b[B\x1b[B\x1b[B\rreset\r");

    expect(state.isComplete("gn-arrows")).toBe(false);
    expect(state.isStarPromptResolved()).toBe(false);
    expect(lastFrame()).toContain("Gesture navigation");
    expect(lastFrame()).toContain("Switch between Select and Gestures");
    expect(lastFrame()).not.toContain("Dormouse Pocket Tutorial");
    dispose();
  });

  it("keeps Flappy Term locked until every tutorial task is complete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();

    sendKeys("\x1b[B\x1b[B\x1b[B\x1b[B\r");

    expect(lastFrame()).toContain("🐭 FlappyTerm 🐭");
    expect(lastFrame()).not.toContain("???");
    expect(lastFrame()).toContain("[LOCKED 0/17]");
    expect(lastFrame()).toContain("Dormouse Playground Tutorial");
    dispose();
  });

  it("shows the unlocked Flappy Term entry with a high-score readout", () => {
    const allItemIds = SECTIONS.flatMap((section) => section.items.map((i) => i.id));
    const { state, sendKeys, lastFrame, dispose } = mountRunner(allItemIds);
    state.recordFlappyScore(7);

    // Navigate to (but don't enter) the Flappy Term row.
    sendKeys("\x1b[B\x1b[B\x1b[B\x1b[B");
    expect(lastFrame()).toContain("🐭 FlappyTerm 🐭");
    expect(lastFrame()).toContain("[High score: 7]");
    dispose();
  });

  it("opens Flappy Term, shows the start hint, and exits back to the menu", () => {
    const allItemIds = SECTIONS.flatMap((section) => section.items.map((i) => i.id));
    const { sendKeys, lastFrame, dispose } = mountRunner(allItemIds);

    sendKeys("\x1b[B\x1b[B\x1b[B\x1b[B\r");
    const frame = lastFrame();
    expect(frame).toContain("Score: 0");
    expect(frame).toContain("Best:");
    expect(frame).toContain("Space / Up to flap");

    sendKeys("\x1b");
    expect(lastFrame()).toContain("Dormouse Playground Tutorial");
    dispose();
  });

  it("keeps the desktop Flappy game-over prompt on p", () => {
    vi.useFakeTimers();
    const allItemIds = SECTIONS.flatMap((section) => section.items.map((i) => i.id));
    const onOpenPocket = vi.fn();
    const { sendKeys, lastFrame, dispose } = mountRunner(allItemIds, { onOpenPocket });

    try {
      sendKeys("\x1b[B\x1b[B\x1b[B\x1b[B\r ");
      vi.advanceTimersByTime(3000);

      expect(lastFrame()).toContain("GAME OVER");
      expect(lastFrame()).toContain("Read about Dormouse Pocket  [p]");
      expect(lastFrame()).not.toContain("Notify me when Pocket ships");

      sendKeys("p");
      expect(onOpenPocket).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });

  it("uses the Pocket Flappy game-over prompt and opens notify on n", () => {
    vi.useFakeTimers();
    const allPocketItemIds = POCKET_TUTORIAL_PROFILE.sections.flatMap((section) => (
      section.items.map((i) => i.id)
    ));
    const onNotifyPocket = vi.fn();
    const { sendKeys, lastFrame, dispose } = mountRunner(allPocketItemIds, {
      profile: POCKET_TUTORIAL_PROFILE,
      onNotifyPocket,
    });

    try {
      sendKeys("\x1b\x1b[B\x1b[B\x1b[B\r ");
      vi.advanceTimersByTime(3000);

      expect(lastFrame()).toContain("GAME OVER");
      expect(lastFrame()).toContain("Notify me when Pocket ships [n]");
      expect(lastFrame()).not.toContain("Read about Dormouse Pocket");

      sendKeys("n");
      expect(onNotifyPocket).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});
