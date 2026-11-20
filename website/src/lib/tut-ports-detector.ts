import type { CommandStoreModule } from "./tut-dor-open-detector";
import type { TutorialState } from "./tutorial-state";
import { shellWords } from "./tutorial-shell";

type TerminalPaneState = import("dormouse-lib/lib/terminal-state").TerminalPaneState;
type ContextMode = Extract<import("dormouse-lib/components/Wall").WallEvent, { type: "contextOpen" }>["mode"];

/** Two dev servers listening at once, and their properties opened on each. */
const SERVERS_NEEDED = 2;

function runsDevServer(pane: TerminalPaneState | undefined): boolean {
  const words = pane?.currentCommand ? shellWords(pane.currentCommand.rawCommandLine ?? "") : [];
  return words.join(" ") === "npm run dev";
}

/**
 * Credits the Ports and browsers section (`tut-items.ts`) from the command
 * lines the playground's shells report and the terminal contexts the Wall
 * opens. `TutDetector` owns its lifecycle and forwards `contextOpen`.
 */
export class PortsWatcher {
  /** Panes whose properties were opened while they ran a dev server. */
  private inspected = new Set<string>();

  constructor(private readonly state: TutorialState, private readonly store: CommandStoreModule) {}

  start(): () => void {
    return this.store.subscribeToTerminalPaneState(() => {
      const running = [...this.store.getTerminalPaneStateSnapshot().values()].filter(runsDevServer);
      if (running.length >= SERVERS_NEEDED) this.state.markComplete("pb-dev");
    });
  }

  contextOpened(id: string, mode: ContextMode): void {
    // Only properties list the ports; `!` opens on the aux terminal.
    if (mode !== "properties") return;
    this.state.markComplete("pb-context");
    const panes = this.store.getTerminalPaneStateSnapshot();
    if (!runsDevServer(panes.get(id))) return;
    this.inspected.add(id);
    // Only servers still running count, so one server stopped and rerun in
    // another pane is never two.
    for (const seen of this.inspected) if (!runsDevServer(panes.get(seen))) this.inspected.delete(seen);
    if (this.inspected.size >= SERVERS_NEEDED) this.state.markComplete("pb-ports");
  }
}
