import { describe, expect, it, vi } from "vitest";
import { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import * as alertSettings from "dormouse-lib/lib/alert-settings";
import type { AlertStateDetail } from "dormouse-lib/lib/platform/types";
import {
  POCKET_TUTORIAL_PROFILE,
  SECTIONS,
  type ItemId,
  type TutorialProfile,
} from "./tut-items";
import { BUSY_DEMO_INTERVAL_MS, TutRunner } from "./tut-runner";
import { TutorialState } from "./tutorial-state";

type TutRunnerOptions = ConstructorParameters<typeof TutRunner>[0];

const FRAME_RESET = "\x1b[H\x1b[2J";

// Both profiles open inside a section (`initialSectionId`), so menu-driven
// tests pop out with Esc first. Menu rows are addressed by name rather than
// ordinal, so inserting a section does not rewrite every test below.
const ESC = "\x1b";
const DOWN = "\x1b[B";
const ENTER = "\r";
const toMenu = ESC;
const menuRow = (index: number) => toMenu + DOWN.repeat(index);
type Sections = readonly { id: string }[];
const sectionRow = (id: string, sections: Sections = SECTIONS) =>
  menuRow(sections.findIndex((section) => section.id === id));
/** The fixed rows the menu renders after the section list, in order. */
const extraRow = (name: "star" | "flappy" | "reset", sections: Sections = SECTIONS) =>
  menuRow(sections.length + { star: 0, flappy: 1, reset: 2 }[name]);

function mountRunner(
  completedIds: ItemId[] = [],
  options: {
    onOpenGithub?: () => void;
    onOpenPocket?: () => void;
    onNotifyPocket?: () => void;
    pocketTouchMode?: "gestures" | "selection" | "cursor";
    profile?: TutorialProfile;
    getInactivityTimeoutMs?: () => number;
    onTriggerBusyDemo?: TutRunnerOptions["onTriggerBusyDemo"];
    onTriggerCommandExitDemo?: TutRunnerOptions["onTriggerCommandExitDemo"];
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
    getInactivityTimeoutMs: options.getInactivityTimeoutMs,
    onTriggerBusyDemo: options.onTriggerBusyDemo,
    onTriggerCommandExitDemo: options.onTriggerCommandExitDemo,
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
    adapter,
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
  it.each([1_000, 60_000])("uses the configured %i ms timeout for demo timers and countdowns", (inactivityTimeoutMs) => {
    vi.useFakeTimers();
    // Semantic timestamps are monotonic across parsers, so later cases must
    // not move their wall clock behind the preceding case’s simulated exit.
    vi.setSystemTime(2_000_000_000_000 + inactivityTimeoutMs * 1_000);
    const settings = { ...alertSettings.DEFAULT_ALERT_SETTINGS, inactivityTimeoutMs };
    const events: AlertStateDetail[] = [];
    const demoId = "demo-target";
    let currentTimeoutMs = alertSettings.DEFAULT_ALERT_SETTINGS.inactivityTimeoutMs;
    let durationMs = 0;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelPump: (() => void) | undefined;
    const { adapter, sendKeys, lastFrame, dispose } = mountRunner([], {
      getInactivityTimeoutMs: () => currentTimeoutMs,
      onTriggerBusyDemo: (duration, commandDuration) => {
        durationMs = duration;
        adapter.sendOutput(demoId, "\x1b]633;E;longtask\x07\x1b]633;C\x07");
        cancelPump = adapter.pumpActivity(demoId, duration, BUSY_DEMO_INTERVAL_MS);
        finishTimer = setTimeout(() => adapter.sendOutput(demoId, "\x1b]633;D;0\x07"), commandDuration);
      },
      onTriggerCommandExitDemo: (duration) => {
        durationMs = duration;
        adapter.sendOutput(demoId, "\x1b]633;E;slowbuild\x07\x1b]633;C\x07");
        adapter.alertAttend(demoId);
        adapter.alertClearAttention(demoId);
        finishTimer = setTimeout(() => adapter.sendOutput(demoId, "\x1b]633;D;0\x07"), duration);
      },
    });
    try {
      adapter.setScenario(demoId, { name: "none", chunks: [] });
      adapter.spawnPty(demoId);
      currentTimeoutMs = inactivityTimeoutMs;
      adapter.alertPublishSettings(settings);
      adapter.onAlertState((event) => { if (event.id === demoId) events.push(event); });
      sendKeys(sectionRow("alert") + ENTER + "x");
      expect(durationMs).toBeGreaterThan(inactivityTimeoutMs);
      expect(lastFrame()).toContain(`${Math.ceil(durationMs / 1000)}\x1b[0m seconds`);
      vi.advanceTimersByTime(durationMs - 1);
      expect(events.some((event) => event.notification?.source === "COMMAND_EXIT")).toBe(false);
      vi.advanceTimersByTime(1);
      expect(events.some((event) => event.notification?.source === "COMMAND_EXIT")).toBe(true);

      adapter.alertDismiss(demoId);
      adapter.alertSetCommandWatched("longtask", true);
      events.length = 0;
      sendKeys("s");
      vi.advanceTimersByTime(durationMs + 7_000);
      expect(events.some((event) => event.status === "BUSY")).toBe(true);
      expect(events.some((event) => event.status === "ALERT_RINGING")).toBe(true);
    } finally {
      clearTimeout(finishTimer);
      cancelPump?.();
      dispose();
      adapter.reset();
      vi.useRealTimers();
    }
  });

  it("ignores unsupported terminal keys without navigating back or corrupting reset input", () => {
    const { sendKeys, lastFrame, exitCount, dispose } = mountRunner();
    const unsupportedKeys = "\x1b[H\x1b[3~\x1b[1;5A";
    sendKeys(unsupportedKeys);
    expect(lastFrame()).toContain("Make it yours");
    expect(exitCount()).toBe(0);
    sendKeys(extraRow("reset") + ENTER + "re" + unsupportedKeys + "set" + ENTER);
    expect(lastFrame()).toContain("Make it yours");
    expect(lastFrame()).not.toContain("didn't match");
    dispose();
  });

  it("accepts application-mode arrow keys in the menu", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys(ESC + "\x1bOB" + ENTER);
    expect(lastFrame()).toContain("Keyboard navigation");
    dispose();
  });

  // The desktop profile opens inside its first section (`initialSectionId`), so
  // every menu-driven test below pops out with a leading Esc first.
  it("starts the desktop tutorial inside Make it yours", () => {
    const { lastFrame, dispose } = mountRunner();
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders the top-level menu", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys(toMenu);
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Keyboard navigation with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys(sectionRow("keyboard") + ENTER);
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders the alert section with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys(sectionRow("alert") + ENTER);
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("renders Copy paste with all items incomplete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();
    sendKeys(sectionRow("copy") + ENTER);
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

    sendKeys(toMenu);

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

    sendKeys(sectionRow("copy", POCKET_TUTORIAL_PROFILE.sections) + ENTER);
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
    const allKeyboardIds = SECTIONS.find((s) => s.id === "keyboard")!.items.map((i) => i.id);
    const { sendKeys, lastFrame, dispose } = mountRunner(allKeyboardIds);
    sendKeys(sectionRow("keyboard") + ENTER);
    expect(lastFrame()).toMatchSnapshot();
    dispose();
  });

  it("backs out of a section with q before exiting from the menu", () => {
    const { sendKeys, lastFrame, exitCount, dispose } = mountRunner();

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

    sendKeys(extraRow("star") + ENTER);

    expect(onOpenGithub).toHaveBeenCalledTimes(1);
    expect(state.isStarPromptResolved()).toBe(true);
    expect(lastFrame()).toContain("[thanks ⭐]");
    expect(lastFrame()).not.toContain("[not yet]");
    dispose();
  });

  it("clears the star prompt when reset progress is confirmed", () => {
    const { state, sendKeys, dispose } = mountRunner(["kb-mode"]);
    state.resolveStarPrompt();

    sendKeys(extraRow("reset") + ENTER + "reset" + ENTER);

    expect(state.isComplete("kb-mode")).toBe(false);
    expect(state.isStarPromptResolved()).toBe(false);
    dispose();
  });

  it("returns the Pocket tutorial to Gesture navigation after reset progress", () => {
    const { state, sendKeys, lastFrame, dispose } = mountRunner(["gn-arrows"], {
      profile: POCKET_TUTORIAL_PROFILE,
    });
    state.resolveStarPrompt();

    sendKeys(extraRow("reset", POCKET_TUTORIAL_PROFILE.sections) + ENTER + "reset" + ENTER);

    expect(state.isComplete("gn-arrows")).toBe(false);
    expect(state.isStarPromptResolved()).toBe(false);
    expect(lastFrame()).toContain("Gesture navigation");
    expect(lastFrame()).toContain("Switch between Select and Gestures");
    expect(lastFrame()).not.toContain("Dormouse Pocket Tutorial");
    dispose();
  });

  it("keeps Flappy Term locked until every tutorial task is complete", () => {
    const { sendKeys, lastFrame, dispose } = mountRunner();

    sendKeys(extraRow("flappy") + ENTER);

    expect(lastFrame()).toContain("🐭 FlappyTerm 🐭");
    expect(lastFrame()).not.toContain("???");
    expect(lastFrame()).toContain("[LOCKED 0/20]");
    expect(lastFrame()).toContain("Dormouse Playground Tutorial");
    dispose();
  });

  it("shows the unlocked Flappy Term entry with a high-score readout", () => {
    const allItemIds = SECTIONS.flatMap((section) => section.items.map((i) => i.id));
    const { state, sendKeys, lastFrame, dispose } = mountRunner(allItemIds);
    state.recordFlappyScore(7);

    // Navigate to (but don't enter) the Flappy Term row.
    sendKeys(extraRow("flappy"));
    expect(lastFrame()).toContain("🐭 FlappyTerm 🐭");
    expect(lastFrame()).toContain("[High score: 7]");
    dispose();
  });

  it("opens Flappy Term, shows the start hint, and exits back to the menu", () => {
    const allItemIds = SECTIONS.flatMap((section) => section.items.map((i) => i.id));
    const { sendKeys, lastFrame, dispose } = mountRunner(allItemIds);

    sendKeys(extraRow("flappy") + ENTER);
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
      sendKeys(extraRow("flappy") + ENTER + " ");
      vi.advanceTimersByTime(3000);

      expect(lastFrame()).toContain("GAME OVER");
      expect(lastFrame()).toContain("Read about Dormouse Pocket  [p]");
      expect(lastFrame()).not.toContain("Dormouse Hosted updates");

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
      sendKeys(extraRow("flappy", POCKET_TUTORIAL_PROFILE.sections) + ENTER + " ");
      vi.advanceTimersByTime(3000);

      expect(lastFrame()).toContain("GAME OVER");
      expect(lastFrame()).toContain("Dormouse Hosted updates [n]");
      expect(lastFrame()).not.toContain("Read about Dormouse Pocket");

      sendKeys("n");
      expect(onNotifyPocket).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
      vi.useRealTimers();
    }
  });
});
