import type { ItemId } from "./tut-items";
import type { TutorialState } from "./tutorial-state";
import { shellWords } from "./tutorial-shell";

type TerminalPaneState = import("dormouse-lib/lib/terminal-state").TerminalPaneState;

export interface CommandStoreModule {
  subscribeToTerminalPaneState: (listener: () => void) => () => void;
  getTerminalPaneStateSnapshot: () => Map<string, TerminalPaneState>;
}

/** The `dor` invocation a command line is, or null. */
function dorWords(commandLine: string | null): string[] | null {
  const words = commandLine ? shellWords(commandLine) : [];
  return words[0] === "dor" ? words.slice(1) : null;
}

/**
 * Credits the `dor open` section (`tut-items.ts`) from the command lines the
 * playground's shells report, so neither `dor` nor its viewers trace anything:
 * a built-in Tool shows up as the `dor __view-*` entry it runs, and `dor o`
 * as a picker run that opened something.
 */
export class DorOpenDetector {
  private readonly seen = new Set<string>();
  private stop: (() => void) | null = null;

  constructor(private readonly state: TutorialState, private readonly store: CommandStoreModule) {}

  start(): void {
    // Runs already under way count as seen: only what happens from now on is credit.
    for (const pane of this.store.getTerminalPaneStateSnapshot().values()) {
      for (const run of [pane.currentCommand, pane.lastCommand]) if (run) this.seen.add(run.id);
    }
    this.stop = this.store.subscribeToTerminalPaneState(() => this.process());
  }

  dispose(): void {
    this.stop?.();
    this.stop = null;
  }

  private process(): void {
    const panes = [...this.store.getTerminalPaneStateSnapshot().values()];
    const folderOpen = panes.some((pane) => dorWords(pane.currentCommand?.rawCommandLine ?? null)?.[0] === "__view-folder");
    for (const pane of panes) {
      const started = pane.currentCommand;
      if (started && !this.seen.has(started.id)) {
        this.seen.add(started.id);
        for (const id of startCredits(dorWords(started.rawCommandLine), !pane.lastCommand && folderOpen)) this.state.markComplete(id);
      }
      const finished = pane.lastCommand;
      if (finished && !this.seen.has(`${finished.id}:done`) && finished.exitCode !== undefined) {
        this.seen.add(`${finished.id}:done`);
        // A picker that opened something exits 0; a cancel exits 1.
        const words = dorWords(finished.rawCommandLine);
        if (finished.exitCode === 0 && (words?.[0] === "o" || words?.[0] === "open") && words.slice(1).every((word) => word.startsWith("-"))) {
          this.state.markComplete("op-pick");
        }
      }
    }
  }
}

/** What a newly started `dor` run credits. `fromFolder`: the run is a new
 * pane's first command while a folder viewer is open, which is how a file
 * clicked in the folder arrives in the preview pane. */
function startCredits(words: string[] | null, fromFolder: boolean): ItemId[] {
  if (!words) return [];
  const [verb, target = ""] = words;
  const credits: ItemId[] = [];
  if (verb === "__view-folder") credits.push("op-folder");
  if (verb === "__view-file" && target.endsWith("/.config/dormouse/dormouse.yml")) credits.push("op-config");
  if (verb === "__view-file" && target.endsWith(".md")) credits.push("op-markdown");
  if (verb === "__view-code" && target.endsWith(".md")) credits.push("op-handler");
  if ((verb === "__view-file" || verb === "__view-code") && fromFolder) credits.push("op-preview");
  return credits;
}
