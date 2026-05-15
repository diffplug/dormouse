import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MOUSE_SELECTION_STATE, type MouseSelectionState } from "mouseterm-lib/lib/mouse-selection";
import type { ActivityState } from "mouseterm-lib/lib/terminal-registry";
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
  let activePanelListener: ((panel: { id?: string } | undefined) => void) | null = null;
  let activityListener: (() => void) | null = null;
  let mouseListener: (() => void) | null = null;
  let activitySnapshot = initialActivitySnapshot;
  let mouseSnapshot = new Map<string, MouseSelectionState>();
  const onWatchingDemoPaneChange = vi.fn();

  const state = new TutorialState();
  const detector = new TutDetector(
    state,
    {
      getActivitySnapshot: () => activitySnapshot,
      subscribeToActivity: (listener) => {
        activityListener = listener;
        return () => {
          activityListener = null;
        };
      },
    },
    {
      getMouseSelectionSnapshot: () => mouseSnapshot,
      subscribeToMouseSelection: (listener) => {
        mouseListener = listener;
        return () => {
          mouseListener = null;
        };
      },
    },
    { onWatchingDemoPaneChange },
  );

  detector.attach({
    onDidActivePanelChange: (listener: (panel: { id?: string } | undefined) => void) => {
      activePanelListener = listener;
      return { dispose: vi.fn() };
    },
  });

  return {
    state,
    detector,
    setActivitySnapshot: (snapshot: Map<string, ActivityState>) => {
      activitySnapshot = snapshot;
      activityListener?.();
    },
    setMouseSnapshot: (snapshot: Map<string, MouseSelectionState>) => {
      mouseSnapshot = snapshot;
      mouseListener?.();
    },
    activePanelChange: (id: string) => activePanelListener?.({ id }),
    onWatchingDemoPaneChange,
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
    const { state, detector, activePanelChange } = makeDetectorHarness();

    detector.handleWallEvent({ type: "selectionChange", id: "pane-a", kind: "pane" });
    detector.handleWallEvent({ type: "modeChange", mode: "passthrough" });
    detector.handleWallEvent({ type: "modeChange", mode: "command" });
    activePanelChange("pane-b");

    expect(state.isComplete("kb-arrows")).toBe(true);
  });

  it("does not credit kb-arrows for the focus change that follows a Cmd/Ctrl+Arrow swap", () => {
    const { state, detector, activePanelChange } = makeDetectorHarness();

    detector.handleWallEvent({ type: "selectionChange", id: "pane-a", kind: "pane" });
    detector.handleWallEvent({ type: "modeChange", mode: "passthrough" });
    detector.handleWallEvent({ type: "modeChange", mode: "command" });
    detector.handleWallEvent({ type: "move", fromId: "pane-a", toId: "pane-b" });
    activePanelChange("pane-b");

    expect(state.isComplete("kb-move")).toBe(true);
    expect(state.isComplete("kb-arrows")).toBe(false);

    // A subsequent plain arrow nav to a third pane should still credit kb-arrows.
    activePanelChange("pane-c");
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

  it("credits al-enable after a newly-created pane is first observed disabled", () => {
    const { state, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([
      ["pane-a", activity("WATCHING_DISABLED")],
    ]));
    setActivitySnapshot(new Map([
      ["pane-a", activity("NOTHING_TO_SHOW")],
    ]));

    expect(state.isComplete("al-enable")).toBe(true);
  });

  it("does not credit al-enable for projected command-exit status while WATCHING is off", () => {
    const { state, onWatchingDemoPaneChange, setActivitySnapshot } = makeDetectorHarness();

    onWatchingDemoPaneChange.mockClear();
    setActivitySnapshot(new Map([
      ["pane-a", activity("WATCHING_DISABLED", false, false)],
    ]));
    setActivitySnapshot(new Map([
      ["pane-a", activity("COMMAND_EXIT_ARMED", false, false)],
    ]));

    expect(state.isComplete("al-enable")).toBe(false);
    expect(onWatchingDemoPaneChange).not.toHaveBeenCalled();
  });

  it("credits al-enable when WATCHING turns on under an existing projected status", () => {
    const { state, onWatchingDemoPaneChange, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([
      ["pane-a", activity("COMMAND_EXIT_ARMED", false, false)],
    ]));
    setActivitySnapshot(new Map([
      ["pane-a", activity("COMMAND_EXIT_ARMED", false, true)],
    ]));

    expect(state.isComplete("al-enable")).toBe(true);
    expect(onWatchingDemoPaneChange).toHaveBeenLastCalledWith("pane-a");
  });

  it("does not seed the WATCHING demo pane from projected alert status", () => {
    const { onWatchingDemoPaneChange } = makeDetectorHarness(new Map([
      ["pane-a", activity("ALERT_RINGING", false, false)],
    ]));

    expect(onWatchingDemoPaneChange).toHaveBeenLastCalledWith(null);
  });

  it("tracks the pane whose WATCHING was enabled for the busy demo", () => {
    const { onWatchingDemoPaneChange, setActivitySnapshot } = makeDetectorHarness();

    setActivitySnapshot(new Map([
      ["pane-a", activity("WATCHING_DISABLED")],
      ["pane-b", activity("WATCHING_DISABLED")],
    ]));
    setActivitySnapshot(new Map([
      ["pane-a", activity("WATCHING_DISABLED")],
      ["pane-b", activity("NOTHING_TO_SHOW")],
    ]));

    expect(onWatchingDemoPaneChange).toHaveBeenLastCalledWith("pane-b");

    setActivitySnapshot(new Map([
      ["pane-a", activity("WATCHING_DISABLED")],
      ["pane-b", activity("WATCHING_DISABLED")],
    ]));

    expect(onWatchingDemoPaneChange).toHaveBeenLastCalledWith(null);
  });
});
