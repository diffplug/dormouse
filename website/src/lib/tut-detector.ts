import { DEFAULT_MOUSE_SELECTION_STATE } from "dormouse-lib/lib/mouse-selection";
import type { TutorialState } from "./tutorial-state";
import { watchDorOpen, type CommandStoreModule } from "./tut-dor-open-detector";

type WallEvent = import("dormouse-lib/components/Wall").WallEvent;
type WallMode = import("dormouse-lib/components/Wall").WallMode;
type ActivityState = import("dormouse-lib/lib/terminal-registry").ActivityState;
type MouseSelectionState = import("dormouse-lib/lib/mouse-selection").MouseSelectionState;

interface ActivityStoreModule {
  subscribeToActivity: (listener: () => void) => () => void;
  getActivitySnapshot: () => Map<string, ActivityState>;
}

/** Whether spoken alarms are on in the active Workspace, app default or
 *  Workspace override alike. */
interface SpeechStoreModule {
  subscribe: (listener: () => void) => () => void;
  isSpeechOn: () => boolean;
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
  /** The desktop's shells' command lines, which credit the `dor open` section. */
  commandStore?: CommandStoreModule;
  /** Credits `al-speak`; the desktop's alone. */
  speechStore?: SpeechStoreModule;
}

export class TutDetector {
  private state: TutorialState;
  private activityStore: ActivityStoreModule;
  private mouseStore: MouseSelectionModule;
  private themeStore: ThemeStoreModule;
  private commandStore: CommandStoreModule | undefined;
  private started = false;
  private currentMode: WallMode = "command";
  private currentPaneId: string | null = null;
  private commandModePanels = new Set<string>();
  private pendingMoveTargetId: string | null = null;
  private pendingMoveClearTimer: ReturnType<typeof setTimeout> | null = null;
  private prevActivity = new Map<string, ActivityState>();
  private prevMouse = new Map<string, MouseSelectionState>();
  private previousThemeId = '';
  private speechStore: SpeechStoreModule | undefined;
  private disposables: (() => void)[] = [];

  constructor({ state, activityStore, mouseStore, themeStore, commandStore, speechStore }: TutDetectorOptions) {
    this.state = state;
    this.commandStore = commandStore;
    this.speechStore = speechStore;
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
    }
    for (const [id, s] of this.mouseStore.getMouseSelectionSnapshot()) {
      this.prevMouse.set(id, { ...s });
    }
    // Same guard, one value wide: the page restores a persisted theme at boot,
    // which must not read as the user having picked one.
    this.previousThemeId = this.themeStore.getActiveThemeId();

    this.disposables.push(
      this.activityStore.subscribeToActivity(() => this.processActivity()),
    );
    const speech = this.speechStore;
    if (speech) {
      // Turned on, not found on: a setting saved on an earlier visit is no act.
      let wasOn = speech.isSpeechOn();
      this.disposables.push(speech.subscribe(() => {
        const on = speech.isSpeechOn();
        if (on && !wasOn) this.state.markComplete("al-speak");
        wasOn = on;
      }));
    }
    this.disposables.push(
      this.mouseStore.subscribeToMouseSelection(() => this.processMouse()),
    );
    this.disposables.push(
      this.themeStore.subscribeToActiveTheme(() => this.processTheme()),
    );
    if (this.commandStore) this.disposables.push(watchDorOpen(this.state, this.commandStore));
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

  /** Compare consecutive themes so choosing the startup theme after a progress
   *  reset still counts, while duplicate notifications never do. */
  private processTheme(): void {
    const current = this.themeStore.getActiveThemeId();
    const changed = current !== this.previousThemeId;
    this.previousThemeId = current;
    if (changed) this.state.markComplete("th-theme");
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

      const ringing = current.status === "ALERT_RINGING";
      const wasRinging = prev.status === "ALERT_RINGING";
      const source = current.notification?.source;
      // Credit a ring by the source its detail names. A true transition, so a
      // pane already ringing when first seen (a restore) credits nothing.
      if (ringing && !wasRinging && source) {
        if (source === "COMMAND_EXIT") this.state.markComplete("al-cmd-exit");
        else if (source === "WATCHING") this.state.markComplete("al-watch");
        else if (TERMINAL_REPORT_SOURCES.has(source)) this.state.markComplete("al-notif");
      }
      // A look turns a ring into a TODO: the ring gone, not merely deferred.
      if (wasRinging && !ringing && current.todo && current.episode === null) {
        this.state.markComplete("al-todo-auto");
      }
      if (!prev.todo && current.todo && !ringing && !wasRinging) {
        // A completion on the pane the user is looking at is held as a TODO
        // carrying its detail; one added by hand carries none.
        this.state.markComplete(source ? "al-held" : "al-todo-manual");
      }
      if (prev.todo && !current.todo) {
        this.state.markComplete("al-todo-clear");
      }

      this.prevActivity.set(id, { ...current });
    }
    for (const id of this.prevActivity.keys()) {
      if (!snapshot.has(id)) this.prevActivity.delete(id);
    }
  }

  private processMouse(): void {
    const snapshot = this.mouseStore.getMouseSelectionSnapshot();
    for (const [id, current] of snapshot) {
      const prev = this.prevMouse.get(id) ?? DEFAULT_MOUSE_SELECTION_STATE;

      // A confirmed copy, in the format its editor shows.
      if (current.copyOutcome === "copied" && prev.copyOutcome !== "copied") {
        const format = current.copyEditor?.format;
        if (format === "exact") this.state.markComplete("cp-raw");
        if (format === "auto") this.state.markComplete("cp-rewrap");
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
