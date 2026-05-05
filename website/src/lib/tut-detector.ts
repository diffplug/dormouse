/**
 * Watches DockviewApi, WallEvents, the alert/activity store, and the
 * mouse-selection store, and marks the matching tutorial item complete in
 * `TutorialState` whenever the user performs the corresponding action.
 */

import type { TutorialState } from "./tutorial-state";

type DockviewApi = any;
type WallEvent = import("mouseterm-lib/components/Wall").WallEvent;
type WallMode = import("mouseterm-lib/components/Wall").WallMode;
type ActivityState = import("mouseterm-lib/lib/terminal-registry").ActivityState;
type MouseSelectionState = import("mouseterm-lib/lib/mouse-selection").MouseSelectionState;

interface ActivityStoreModule {
  subscribeToActivity: (listener: () => void) => () => void;
  getActivitySnapshot: () => Map<string, ActivityState>;
}

interface MouseSelectionModule {
  subscribeToMouseSelection: (listener: () => void) => () => void;
  getMouseSelectionSnapshot: () => Map<string, MouseSelectionState>;
}

export class TutDetector {
  private state: TutorialState;
  private currentMode: WallMode = "command";
  private commandModePanels = new Set<string>();
  private prevActivity = new Map<string, ActivityState>();
  private prevMouse = new Map<string, MouseSelectionState>();
  private disposables: (() => void)[] = [];
  private attached = false;

  constructor(state: TutorialState) {
    this.state = state;
  }

  attach(
    api: DockviewApi,
    activityStore: ActivityStoreModule,
    mouseStore: MouseSelectionModule,
  ): void {
    if (this.attached) return;
    this.attached = true;

    // Seed previous-state maps so the very first listener fire isn't
    // mis-read as a transition from "nothing".
    for (const [id, s] of activityStore.getActivitySnapshot()) {
      this.prevActivity.set(id, { ...s });
    }
    for (const [id, s] of mouseStore.getMouseSelectionSnapshot()) {
      this.prevMouse.set(id, { ...s });
    }

    const activeUnsub = api.onDidActivePanelChange((panel: { id?: string } | undefined) => {
      if (!panel?.id) return;
      if (this.currentMode !== "command") return;
      this.commandModePanels.add(panel.id);
      if (this.commandModePanels.size >= 2) {
        this.state.markComplete("kb-arrows");
      }
    });
    this.disposables.push(() => activeUnsub.dispose());

    this.disposables.push(
      activityStore.subscribeToActivity(() => this.processActivity(activityStore)),
    );
    this.disposables.push(
      mouseStore.subscribeToMouseSelection(() => this.processMouse(mouseStore)),
    );
  }

  handleWallEvent(event: WallEvent): void {
    switch (event.type) {
      case "modeChange":
        // The achievement is *re-entering* command mode via dual-tap, not
        // the initial mount default. Only mark complete on a true
        // passthrough → command transition.
        if (event.mode === "command" && this.currentMode === "passthrough") {
          this.state.markComplete("kb-mode");
          this.commandModePanels.clear();
        }
        this.currentMode = event.mode;
        break;
      case "split":
        if (event.source !== "keyboard") break;
        // `-` / `"` produces a "vertical" split (panes stack top/bottom),
        // i.e. a horizontal divider. `|` / `%` produces "horizontal" (panes
        // side by side), i.e. a vertical divider.
        if (event.direction === "vertical") this.state.markComplete("kb-split-h");
        if (event.direction === "horizontal") this.state.markComplete("kb-split-v");
        break;
      case "minimizeChange":
        if (event.count > 0) this.state.markComplete("kb-min");
        break;
      case "kill":
        this.state.markComplete("kb-kill");
        break;
      case "move":
        this.state.markComplete("kb-move");
        break;
    }
  }

  private processActivity(store: ActivityStoreModule): void {
    const snapshot = store.getActivitySnapshot();
    for (const [id, current] of snapshot) {
      const prev = this.prevActivity.get(id);

      const wasEnabled = prev && prev.status !== "ALERT_DISABLED";
      const nowEnabled = current.status !== "ALERT_DISABLED";
      if (!wasEnabled && nowEnabled) {
        this.state.markComplete("al-enable");
      }

      if (current.status === "BUSY" || current.status === "MIGHT_BE_BUSY") {
        this.state.markComplete("al-busy");
      }
      if (current.status === "ALERT_RINGING") {
        this.state.markComplete("al-ring");
      }

      const prevTodo = prev?.todo ?? false;
      if (!prevTodo && current.todo) {
        if (prev?.status === "ALERT_RINGING") {
          this.state.markComplete("al-todo-auto");
        } else {
          this.state.markComplete("al-todo-manual");
        }
      }
      if (prevTodo && !current.todo) {
        this.state.markComplete("al-todo-clear");
      }

      this.prevActivity.set(id, { ...current });
    }
  }

  private processMouse(store: MouseSelectionModule): void {
    const snapshot = store.getMouseSelectionSnapshot();
    for (const [id, current] of snapshot) {
      const prev = this.prevMouse.get(id);

      if (current.copyFlash && current.copyFlash !== prev?.copyFlash) {
        if (current.copyFlash === "raw") this.state.markComplete("cp-raw");
        if (current.copyFlash === "rewrapped") this.state.markComplete("cp-rewrap");
      }

      if (!prev?.selection && current.selection) {
        this.state.markComplete("cp-select");
      }

      const prevOverride = prev?.override ?? "off";
      if (prevOverride === "off" && current.override !== "off") {
        this.state.markComplete("cp-override");
      }

      this.prevMouse.set(id, { ...current });
    }
  }

  dispose(): void {
    for (const fn of this.disposables) fn();
    this.disposables = [];
    this.attached = false;
  }
}
