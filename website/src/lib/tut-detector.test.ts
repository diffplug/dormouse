import { describe, expect, it } from "vitest";
import { DEFAULT_MOUSE_SELECTION_STATE, type CopyEditorState, type MouseSelectionState } from "dormouse-lib/lib/mouse-selection";
import type { ActivityState } from "dormouse-lib/lib/terminal-registry";
import { DESKTOP_SECTIONS } from "./tut-items";
import { TutDetector } from "./tut-detector";
import { TutorialState } from "./tutorial-state";

function activity(
  status: ActivityState["status"],
  todo = false,
  watchingEnabled = status !== "WATCHING_DISABLED",
): ActivityState {
  return { episode: null, status, watchingEnabled, todo, notification: null, awaited: false };
}

type Source = NonNullable<ActivityState["notification"]>["source"];

/** A pane ringing with `source`'s detail. */
function ringing(source: Source): ActivityState {
  return { ...activity("ALERT_RINGING"), episode: { id: "episode", startedAt: 0 }, notification: { source, title: "t", body: null } };
}

function makeDetectorHarness(initialActivitySnapshot = new Map<string, ActivityState>(), speechOnAtStart = false) {
  let activityListener: (() => void) | null = null;
  let mouseListener: (() => void) | null = null;
  let activitySnapshot = initialActivitySnapshot;
  let speechListener: (() => void) | null = null;
  let speechOn = speechOnAtStart;
  let mouseSnapshot = new Map<string, MouseSelectionState>();
  let themeListener: (() => void) | null = null;
  let activeThemeId = "vscode.theme-defaults.dark_vs";
  const state = new TutorialState(DESKTOP_SECTIONS);
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
    speechStore: {
      isSpeechOn: () => speechOn,
      subscribe: (listener) => {
        speechListener = listener;
        return () => {
          speechListener = null;
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
    setSpeechOn: (on: boolean) => {
      speechOn = on;
      speechListener?.();
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

  it("credits a confirmed copy by the format its editor shows, never a failed one", () => {
    const { state, setMouseSnapshot } = makeDetectorHarness();
    const editor = (format: CopyEditorState["format"]) => ({ format }) as CopyEditorState;
    const pane = (format: CopyEditorState["format"], copyOutcome: MouseSelectionState["copyOutcome"]) =>
      new Map([["pane-a", { ...DEFAULT_MOUSE_SELECTION_STATE, copyEditor: editor(format), copyOutcome }]]);

    setMouseSnapshot(pane("exact", "failed"));
    expect(state.isComplete("cp-raw")).toBe(false);
    setMouseSnapshot(pane("exact", "copied"));
    expect(state.isComplete("cp-raw")).toBe(true);
    expect(state.isComplete("cp-rewrap")).toBe(false);
    setMouseSnapshot(pane("auto", null));
    setMouseSnapshot(pane("auto", "copied"));
    expect(state.isComplete("cp-rewrap")).toBe(true);
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

  it("credits nothing for a pane already ringing at first observation", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([["pane-b", ringing("OSC 9")]]));

    expect(state.isComplete("al-notif")).toBe(false);
  });

  it.each([
    ["OSC 9", "al-notif"],
    ["BEL", "al-notif"],
    ["COMMAND_EXIT", "al-cmd-exit"],
    ["WATCHING", "al-watch"],
  ] as const)("credits a ring whose detail is %s as %s", (source, item) => {
    const { state, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([["pane-a", activity("NOTHING_TO_SHOW")]]));
    // Deferred behind output: an episode, but not yet ringing.
    setActivitySnapshot(new Map([["pane-a", { ...ringing(source), status: "BUSY" }]]));
    expect(state.isComplete(item)).toBe(false);

    setActivitySnapshot(new Map([["pane-a", ringing(source)]]));
    expect(state.isComplete(item)).toBe(true);
  });

  it("credits al-todo-auto when a look turns a ring into a TODO, never when output defers it", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();
    const ring = { ...ringing("OSC 9"), todo: true };

    setActivitySnapshot(new Map([["pane-a", activity("NOTHING_TO_SHOW")]]));
    setActivitySnapshot(new Map([["pane-a", ring]]));
    setActivitySnapshot(new Map([["pane-a", { ...ring, status: "BUSY" }]]));
    expect(state.isComplete("al-todo-auto")).toBe(false);

    setActivitySnapshot(new Map([["pane-a", ring]]));
    setActivitySnapshot(new Map([["pane-a", { ...ring, status: "NOTHING_TO_SHOW", episode: null }]]));
    expect(state.isComplete("al-todo-auto")).toBe(true);
    expect(state.isComplete("al-held")).toBe(false);
    expect(state.isComplete("al-todo-manual")).toBe(false);
  });

  it("credits al-held for a TODO a completion leaves, and al-todo-manual for one with no detail", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();
    const held = { ...activity("NOTHING_TO_SHOW", true), notification: { source: "OSC 9", title: null, body: "Allow?" } } as const;

    setActivitySnapshot(new Map([["pane-a", activity("NOTHING_TO_SHOW")], ["pane-b", activity("NOTHING_TO_SHOW")]]));
    setActivitySnapshot(new Map([["pane-a", held], ["pane-b", activity("NOTHING_TO_SHOW")]]));
    expect(state.isComplete("al-held")).toBe(true);
    expect(state.isComplete("al-todo-manual")).toBe(false);

    setActivitySnapshot(new Map([["pane-a", held], ["pane-b", activity("NOTHING_TO_SHOW", true)]]));
    expect(state.isComplete("al-todo-manual")).toBe(true);
  });

  it("credits al-todo-clear when a TODO goes", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([["pane-a", activity("NOTHING_TO_SHOW", true)]]));
    setActivitySnapshot(new Map([["pane-a", activity("NOTHING_TO_SHOW", false)]]));
    expect(state.isComplete("al-todo-clear")).toBe(true);
  });

  it("credits al-speak when spoken alarms are turned on, never for a setting already on", () => {
    const already = makeDetectorHarness(new Map(), true);
    already.setSpeechOn(true);
    expect(already.state.isComplete("al-speak")).toBe(false);

    const { state, setSpeechOn } = makeDetectorHarness();
    setSpeechOn(true);
    expect(state.isComplete("al-speak")).toBe(true);
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

  it("credits a return to the startup theme after reset, but ignores duplicate notifications", () => {
    const { state, setActiveThemeId, detector } = makeDetectorHarness();
    setActiveThemeId("vscode.theme-kimbie-dark.kimbie-dark");
    state.reset();
    setActiveThemeId("vscode.theme-kimbie-dark.kimbie-dark");
    expect(state.isComplete("th-theme")).toBe(false);
    setActiveThemeId("vscode.theme-defaults.dark_vs");
    expect(state.isComplete("th-theme")).toBe(true);
    detector.dispose();
  });


});
