import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MOUSE_SELECTION_STATE, type MouseSelectionState } from "dormouse-lib/lib/mouse-selection";
import type { ActivityState } from "dormouse-lib/lib/terminal-registry";
import { TutDetector } from "./tut-detector";
import { TutorialState } from "./tutorial-state";

function activity(
  status: ActivityState["status"],
  todo = false,
  watchingEnabled = status !== "WATCHING_DISABLED",
): ActivityState {
  return { status, watchingEnabled, todo, notification: null };
}

function makeDetectorHarness(initialActivitySnapshot = new Map<string, ActivityState>()) {
  let activityListener: (() => void) | null = null;
  let watchedListener: (() => void) | null = null;
  let mouseListener: (() => void) | null = null;
  let activitySnapshot = initialActivitySnapshot;
  let watchedCommands: string[] = [];
  let mouseSnapshot = new Map<string, MouseSelectionState>();
  let themeListener: (() => void) | null = null;
  let activeThemeId = "vscode.theme-defaults.dark_vs";
  const state = new TutorialState();
  const detector = new TutDetector({
    state,
    activityStore: {
      getActivitySnapshot: () => activitySnapshot,
      subscribeToActivity: (listener) => {
        activityListener = listener;
        return () => {
          activityListener = null;
        };
      },
      getWatchedCommands: () => watchedCommands,
      subscribeToWatchedCommands: (listener) => {
        watchedListener = listener;
        return () => {
          watchedListener = null;
        };
      },
    },
    mouseStore: {
      getMouseSelectionSnapshot: () => mouseSnapshot,
      subscribeToMouseSelection: (listener) => {
        mouseListener = listener;
        return () => {
          mouseListener = null;
        };
      },
    },
    themeStore: {
      getActiveThemeId: () => activeThemeId,
      subscribeToActiveTheme: (listener) => {
        themeListener = listener;
        return () => {
          themeListener = null;
        };
      },
    },
  });

  detector.start();

  return {
    state,
    detector,
    setActivitySnapshot: (snapshot: Map<string, ActivityState>) => {
      activitySnapshot = snapshot;
      activityListener?.();
    },
    setWatchedCommands: (names: string[]) => {
      watchedCommands = names;
      watchedListener?.();
    },
    setMouseSnapshot: (snapshot: Map<string, MouseSelectionState>) => {
      mouseSnapshot = snapshot;
      mouseListener?.();
    },
    setActiveThemeId: (id: string) => {
      activeThemeId = id;
      themeListener?.();
    },
    // Arrow navigation / clicks surface as a pane `selectionChange` WallEvent (what
    // Wall.selectPane fires on both engines); the detector reads kb-arrows from it.
    selectPane: (id: string) =>
      detector.handleWallEvent({ type: "selectionChange", id, kind: "pane" }),
  };
}

describe("TutDetector", () => {
  it("credits the first user text selection even when the pane has no prior mouse state", () => {
    const { state, setMouseSnapshot } = makeDetectorHarness();

    setMouseSnapshot(new Map([
      ["pane-a", {
        ...DEFAULT_MOUSE_SELECTION_STATE,
        selection: {
          startRow: 0,
          startCol: 0,
          endRow: 0,
          endCol: 4,
          shape: "linewise",
          dragging: true,
          startedInScrollback: false,
        },
      }],
    ]));

    expect(state.isComplete("cp-select")).toBe(true);
  });

  it("credits arrow navigation after the first move away from the command-mode origin pane", () => {
    const { state, detector, selectPane } = makeDetectorHarness();

    selectPane("pane-a");
    detector.handleWallEvent({ type: "modeChange", mode: "passthrough" });
    detector.handleWallEvent({ type: "modeChange", mode: "command" });
    selectPane("pane-b");

    expect(state.isComplete("kb-arrows")).toBe(true);
  });

  it("does not credit kb-arrows for the focus change that follows a Cmd/Ctrl+Arrow swap", () => {
    const { state, detector, selectPane } = makeDetectorHarness();

    selectPane("pane-a");
    detector.handleWallEvent({ type: "modeChange", mode: "passthrough" });
    detector.handleWallEvent({ type: "modeChange", mode: "command" });
    detector.handleWallEvent({ type: "move", fromId: "pane-a", toId: "pane-b" });
    selectPane("pane-b");

    expect(state.isComplete("kb-move")).toBe(true);
    expect(state.isComplete("kb-arrows")).toBe(false);

    // A subsequent plain arrow nav to a third pane should still credit kb-arrows.
    selectPane("pane-c");
    expect(state.isComplete("kb-arrows")).toBe(true);
  });

  it("credits a later plain arrow to the swap target after a Lath swap kept selection on the origin", async () => {
    const { state, detector, selectPane } = makeDetectorHarness();

    selectPane("pane-a");
    detector.handleWallEvent({ type: "modeChange", mode: "passthrough" });
    detector.handleWallEvent({ type: "modeChange", mode: "command" });
    detector.handleWallEvent({ type: "move", fromId: "pane-a", toId: "pane-b" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    selectPane("pane-b");

    expect(state.isComplete("kb-move")).toBe(true);
    expect(state.isComplete("kb-arrows")).toBe(true);
  });

  it("does not credit al-busy or al-ring when a pane is already in that status at first observation", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([
      ["pane-a", activity("BUSY")],
      ["pane-b", activity("ALERT_RINGING")],
    ]));

    expect(state.isComplete("al-busy")).toBe(false);
    expect(state.isComplete("al-ring")).toBe(false);
  });

  it("credits al-busy and al-ring on a true status transition", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([
      ["pane-a", activity("NOTHING_TO_SHOW")],
    ]));
    setActivitySnapshot(new Map([
      ["pane-a", activity("BUSY")],
    ]));
    expect(state.isComplete("al-busy")).toBe(true);

    setActivitySnapshot(new Map([
      ["pane-a", activity("ALERT_RINGING")],
    ]));
    expect(state.isComplete("al-ring")).toBe(true);
  });

  it("credits al-watch-cmd once a rule exists", () => {
    const { state, setWatchedCommands } = makeDetectorHarness();

    expect(state.isComplete("al-watch-cmd")).toBe(false);
    setWatchedCommands(["longtask"]);
    expect(state.isComplete("al-watch-cmd")).toBe(true);
  });

  it("credits al-spreads only when a second pane lights up from the same rule", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([
      ["pane-a", activity("WATCHING_DISABLED", false, false)],
      ["pane-b", activity("WATCHING_DISABLED", false, false)],
    ]));
    setActivitySnapshot(new Map([
      ["pane-a", activity("NOTHING_TO_SHOW", false, true)],
      ["pane-b", activity("WATCHING_DISABLED", false, false)],
    ]));
    expect(state.isComplete("al-spreads")).toBe(false);

    setActivitySnapshot(new Map([
      ["pane-a", activity("NOTHING_TO_SHOW", false, true)],
      ["pane-b", activity("NOTHING_TO_SHOW", false, true)],
    ]));
    expect(state.isComplete("al-spreads")).toBe(true);
  });


  it("credits al-notif for a program-sent notification and al-cmd-exit for a command exit", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([["pane-a", activity("WATCHING_DISABLED", false, false)]]));
    setActivitySnapshot(new Map([
      ["pane-a", {
        ...activity("ALERT_RINGING", true, false),
        notification: { source: "OSC 777", title: "Build finished", body: "3 packages" },
      }],
    ]));
    expect(state.isComplete("al-notif")).toBe(true);
    expect(state.isComplete("al-cmd-exit")).toBe(false);
    // The ring set TODO itself, so this is not a hand-added one.
    expect(state.isComplete("al-todo-manual")).toBe(false);

    setActivitySnapshot(new Map([
      ["pane-a", {
        ...activity("ALERT_RINGING", true, false),
        notification: { source: "COMMAND_EXIT", title: "Command finished", body: "slowbuild exited 0" },
      }],
    ]));
    expect(state.isComplete("al-cmd-exit")).toBe(true);
  });


  it("does not credit th-theme for the boot-time theme restore", () => {
    const { state, setActiveThemeId } = makeDetectorHarness();

    // A restore of the already-active theme still notifies in some paths; the
    // seed read in start() is what keeps it from granting the item.
    setActiveThemeId("vscode.theme-defaults.dark_vs");
    expect(state.isComplete("th-theme")).toBe(false);
  });

  it("credits th-theme when the user picks a different theme", () => {
    const { state, setActiveThemeId } = makeDetectorHarness();

    setActiveThemeId("vscode.theme-kimbie-dark.kimbie-dark");
    expect(state.isComplete("th-theme")).toBe(true);
  });


});
