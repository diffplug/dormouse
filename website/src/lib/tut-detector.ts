import { DEFAULT_MOUSE_SELECTION_STATE } from "dormouse-lib/lib/mouse-selection";
import type { TutorialState } from "./tutorial-state";

type WallEvent = import("dormouse-lib/components/Wall").WallEvent;
type WallMode = import("dormouse-lib/components/Wall").WallMode;
type ActivityState = import("dormouse-lib/lib/terminal-registry").ActivityState;
type MouseSelectionState = import("dormouse-lib/lib/mouse-selection").MouseSelectionState;

interface ActivityStoreModule {
  subscribeToActivity: (listener: () => void) => () => void;
  getActivitySnapshot: () => Map<string, ActivityState>;
  subscribeToWatchedCommands: (listener: () => void) => () => void;
  getWatchedCommands: () => string[];
}

/** Notification sources a program emits for itself, as opposed to the ones
 *  Dormouse synthesizes for a command exit (`docs/specs/alert.md`). */
const TERMINAL_REPORT_SOURCES = new Set(["BEL", "OSC 9", "OSC 9;4", "OSC 99", "OSC 777"]);

interface MouseSelectionModule {
  subscribeToMouseSelection: (listener: () => void) => () => void;
  getMouseSelectionSnapshot: () => Map<string, MouseSelectionState>;
}

interface ThemeStoreModule {
  subscribeToActiveTheme: (listener: () => void) => () => void;
  getActiveThemeId: () => string;
}

/** One options object rather than a growing positional list, matching the
 *  sibling runners (`TutRunner`, `ChangelogRunner`, `AsciiSplashRunner`). Each
 *  store is passed in so the detector stays engine-neutral and testable. */
export interface TutDetectorOptions {
  state: TutorialState;
  activityStore: ActivityStoreModule;
  mouseStore: MouseSelectionModule;
  themeStore: ThemeStoreModule;
}

export class TutDetector {
  private state: TutorialState;
  private activityStore: ActivityStoreModule;
  private mouseStore: MouseSelectionModule;
  private themeStore: ThemeStoreModule;
  private started = false;
  private currentMode: WallMode = "command";
  private currentPaneId: string | null = null;
  private commandModePanels = new Set<string>();
  private watchingEnabledPaneIds = new Set<string>();
  private pendingMoveTargetId: string | null = null;
  private pendingMoveClearTimer: ReturnType<typeof setTimeout> | null = null;
  private prevActivity = new Map<string, ActivityState>();
  private prevMouse = new Map<string, MouseSelectionState>();
  private startThemeId = '';
  private disposables: (() => void)[] = [];

  constructor({ state, activityStore, mouseStore, themeStore }: TutDetectorOptions) {
    this.state = state;
    this.activityStore = activityStore;
    this.mouseStore = mouseStore;
    this.themeStore = themeStore;
  }

  /** Seed the prev-state maps and subscribe to the activity/mouse/theme stores. The
   *  detector is otherwise driven by the `WallEvent` stream (`handleWallEvent`), so
   *  it is engine-neutral — it never touches the tiling api. */
  start(): void {
    if (this.started) {
      throw new Error("TutDetector.start called twice");
    }
    this.started = true;
    // Seed previous-state maps so the very first listener fire isn't
    // mis-read as a transition from "nothing".
    for (const [id, s] of this.activityStore.getActivitySnapshot()) {
      this.prevActivity.set(id, { ...s });
      if (s.watchingEnabled) this.watchingEnabledPaneIds.add(id);
    }
    for (const [id, s] of this.mouseStore.getMouseSelectionSnapshot()) {
      this.prevMouse.set(id, { ...s });
    }
    // Same guard, one value wide: the page restores a persisted theme at boot,
    // which must not read as the user having picked one.
    this.startThemeId = this.themeStore.getActiveThemeId();

    this.disposables.push(
      this.activityStore.subscribeToActivity(() => this.processActivity()),
    );
    this.disposables.push(
      this.activityStore.subscribeToWatchedCommands(() => this.processWatchedCommands()),
    );
    this.disposables.push(
      this.mouseStore.subscribeToMouseSelection(() => this.processMouse()),
    );
    this.disposables.push(
      this.themeStore.subscribeToActiveTheme(() => this.processTheme()),
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
          // Seed with the currently-selected pane (tracked from selectionChange).
          // It is the pane arrow-nav navigates *from*, so it must already be in
          // the set for the first arrow to a neighbor to reach size 2.
          if (this.currentPaneId) this.commandModePanels.add(this.currentPaneId);
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
        this.armPendingMoveTarget(event.toId);
        break;
      case "selectionChange":
        if (event.kind === "pane") {
          this.currentPaneId = event.id;
          // kb-arrows: in command mode, selecting a different pane (a bare arrow
          // key, or a click) grows the set; two distinct panes credits it. Events
          // in passthrough must NOT grow the set. selectionChange is the
          // engine-neutral selection signal (selectPane fires it).
          if (this.currentMode === "command" && event.id) {
            // Cmd/Ctrl+Arrow can produce an immediate synthetic selection change
            // to the swap target, which would otherwise credit `kb-arrows` even
            // though the user never pressed a bare arrow key. The guard expires
            // after the current turn so a later real arrow to that neighbor counts.
            const pendingMoveTargetId = this.pendingMoveTargetId;
            if (pendingMoveTargetId) this.clearPendingMoveTarget();
            if (pendingMoveTargetId === event.id) {
              // Consume the synthetic post-move selection.
            } else {
              this.commandModePanels.add(event.id);
              if (this.commandModePanels.size >= 2) {
                this.state.markComplete("kb-arrows");
              }
            }
          }
        }
        break;
    }
  }

  private armPendingMoveTarget(id: string): void {
    this.clearPendingMoveTarget();
    this.pendingMoveTargetId = id;
    this.pendingMoveClearTimer = setTimeout(() => {
      if (this.pendingMoveTargetId === id) {
        this.pendingMoveTargetId = null;
      }
      this.pendingMoveClearTimer = null;
    }, 0);
  }

  private clearPendingMoveTarget(): void {
    this.pendingMoveTargetId = null;
    if (this.pendingMoveClearTimer !== null) {
      clearTimeout(this.pendingMoveClearTimer);
      this.pendingMoveClearTimer = null;
    }
  }

  /** The active theme moved off whatever was restored at start. The picker
   *  lives in the Settings dialog and has no keyboard shortcut, so any change
   *  here is a mouse interaction. */
  private processTheme(): void {
    const current = this.themeStore.getActiveThemeId();
    if (current !== this.startThemeId) this.state.markComplete("th-theme");
  }

  /** A rule exists at all — the user turned alerts on for a command name. */
  private processWatchedCommands(): void {
    if (this.activityStore.getWatchedCommands().length > 0) {
      this.state.markComplete("al-watch-cmd");
    }
  }

  private processActivity(): void {
    const snapshot = this.activityStore.getActivitySnapshot();
    for (const [id, current] of snapshot) {
      const prev = this.prevActivity.get(id);
      // First time we see an id (e.g. a pane added after start()), record
      // its state without firing any transitions — we have no "before" to
      // compare against, so treating undefined as a transition from
      // WATCHING_DISABLED / todo=false would falsely credit work the user
      // didn't do (e.g. al-todo-manual when restored state has todo=true).
      if (!prev) {
        this.prevActivity.set(id, { ...current });
        continue;
      }

      if (!prev.watchingEnabled && current.watchingEnabled) {
        this.watchingEnabledPaneIds.add(id);
        // One rule, many panes: the second pane to light up never had its own
        // bell clicked, which is the whole point of command-keyed WATCHING.
        if (this.watchingEnabledPaneIds.size > 1) {
          this.state.markComplete("al-spreads");
        }
      } else if (prev.watchingEnabled && !current.watchingEnabled) {
        this.watchingEnabledPaneIds.delete(id);
      }

      // Gate al-busy / al-ring on a true status transition. Without the
      // prev.status check, a pane already in BUSY or ALERT_RINGING at the
      // moment its first activity event fires (e.g. restored state, or a
      // pane spawned after start() that arrives mid-task) would credit
      // the user for work they did not do this session.
      if (
        prev.status !== current.status &&
        (current.status === "BUSY" || current.status === "MIGHT_BE_BUSY")
      ) {
        this.state.markComplete("al-busy");
      }
      if (prev.status !== "ALERT_RINGING" && current.status === "ALERT_RINGING") {
        this.state.markComplete("al-ring");
      }

      // Credit the two rule-free alarm paths off the notification that landed,
      // not off the status: both project to plain ALERT_RINGING.
      const source = current.notification?.source;
      if (source && source !== prev.notification?.source) {
        if (source === "COMMAND_EXIT") this.state.markComplete("al-cmd-exit");
        else if (TERMINAL_REPORT_SOURCES.has(source)) this.state.markComplete("al-notif");
      }

      if (!prev.todo && current.todo) {
        if (prev.status === "ALERT_RINGING") {
          this.state.markComplete("al-todo-auto");
        } else if (!source) {
          // A protocol or command-exit ring sets TODO itself; only a bare
          // TODO with no notification behind it was added by hand.
          this.state.markComplete("al-todo-manual");
        }
      }
      if (prev.todo && !current.todo) {
        this.state.markComplete("al-todo-clear");
      }

      this.prevActivity.set(id, { ...current });
    }
    for (const id of this.prevActivity.keys()) {
      if (!snapshot.has(id)) {
        this.prevActivity.delete(id);
        this.watchingEnabledPaneIds.delete(id);
      }
    }
  }

  private processMouse(): void {
    const snapshot = this.mouseStore.getMouseSelectionSnapshot();
    for (const [id, current] of snapshot) {
      const prev = this.prevMouse.get(id) ?? DEFAULT_MOUSE_SELECTION_STATE;

      if (current.copyFlash && current.copyFlash !== prev.copyFlash) {
        if (current.copyFlash === "raw") this.state.markComplete("cp-raw");
        if (current.copyFlash === "rewrapped") this.state.markComplete("cp-rewrap");
      }

      if (!prev.selection && current.selection) {
        this.state.markComplete("cp-select");
      }

      if (prev.override === "off" && current.override !== "off") {
        this.state.markComplete("cp-override");
      }

      this.prevMouse.set(id, { ...current });
    }
    for (const id of this.prevMouse.keys()) {
      if (!snapshot.has(id)) this.prevMouse.delete(id);
    }
  }

  dispose(): void {
    for (const fn of this.disposables) fn();
    this.disposables = [];
    this.clearPendingMoveTarget();
  }

}
