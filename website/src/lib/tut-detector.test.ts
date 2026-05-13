import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MOUSE_SELECTION_STATE, type MouseSelectionState } from "mouseterm-lib/lib/mouse-selection";
import type { ActivityState } from "mouseterm-lib/lib/terminal-registry";
import { TutDetector } from "./tut-detector";
import { TutorialState } from "./tutorial-state";

function activity(status: ActivityState["status"], todo = false): ActivityState {
  return { status, watchingEnabled: status !== "WATCHING_DISABLED", todo, notification: null };
}

function makeDetectorHarness() {
  let activePanelListener: ((panel: { id?: string } | undefined) => void) | null = null;
  let activityListener: (() => void) | null = null;
  let mouseListener: (() => void) | null = null;
  let activitySnapshot = new Map<string, ActivityState>();
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
      ["pane-a", { status: "BUSY", todo: false }],
      ["pane-b", { status: "ALERT_RINGING", todo: false }],
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
