import { canonicalDorVerb } from "dor/protocol";
import { builtinHandler, fileViewerFormat } from "dor-tools-builtin/file-viewer-format";
import { USER_CONFIG } from "./playground-fs/vfs";
import type { ItemId } from "./tut-items";
import type { TutorialState } from "./tutorial-state";
import { shellWords } from "./tutorial-shell";

type TerminalPaneState = import("dormouse-lib/lib/terminal-state").TerminalPaneState;

export interface CommandStoreModule {
  subscribeToTerminalPaneState: (listener: () => void) => () => void;
  getTerminalPaneStateSnapshot: () => Map<string, TerminalPaneState>;
}

/** The `dor` invocation a command line is, split as the playground shell ran it, or null. */
function dorWords(commandLine: string | null | undefined): string[] | null {
  const words = commandLine ? shellWords(commandLine) : [];
  return words[0] === "dor" ? words.slice(1) : null;
}

/** The built-in a `dor __view-*` run serves, and its target. */
function viewer(commandLine: string | null | undefined) {
  const [verb, target = ""] = dorWords(commandLine) ?? [];
  const kind = builtinHandler("argv", verb)?.kind;
  return kind ? { kind, target } : null;
}

/**
 * Credits the `dor open` section (`tut-items.ts`) from the command lines the
 * playground's shells report, so neither `dor` nor its viewers trace anything:
 * a built-in Tool shows up as the `dor __view-*` entry it runs, and `dor o`
 * as a picker run that opened something. `TutDetector` owns its lifecycle.
 */
export function watchDorOpen(state: TutorialState, store: CommandStoreModule): () => void {
  const started = new Set<string>();
  const finished = new Set<string>();
  // Runs already under way count as seen: only what happens from now on is credit.
  for (const pane of store.getTerminalPaneStateSnapshot().values()) {
    if (pane.currentCommand) started.add(pane.currentCommand.id);
    if (pane.lastCommand) finished.add(pane.lastCommand.id);
  }
  return store.subscribeToTerminalPaneState(() => {
    const panes = [...store.getTerminalPaneStateSnapshot().values()];
    const folderOpen = panes.some((pane) => viewer(pane.currentCommand?.rawCommandLine)?.kind === "folder");
    for (const pane of panes) {
      const run = pane.currentCommand;
      if (run && !started.has(run.id)) {
        started.add(run.id);
        const opened = viewer(run.rawCommandLine);
        // A file clicked in the folder arrives as a new pane's first command.
        if (opened) for (const id of credits(opened, !pane.lastCommand && folderOpen)) state.markComplete(id);
      }
      const last = pane.lastCommand;
      if (last && !finished.has(last.id) && last.exitCode !== undefined) {
        finished.add(last.id);
        // A picker that opened something exits 0; a cancel exits 1.
        const [verb, ...flags] = dorWords(last.rawCommandLine) ?? [];
        if (last.exitCode === 0 && canonicalDorVerb(verb ?? "") === "open" && flags.every((flag) => flag.startsWith("-"))) {
          state.markComplete("op-pick");
        }
      }
    }
  });
}

function credits({ kind, target }: { kind: string; target: string }, fromFolder: boolean): ItemId[] {
  const markdown = !!fileViewerFormat(target)?.markdown;
  const ids: ItemId[] = [];
  if (kind === "folder") ids.push("op-folder");
  if (kind === "file" && target === USER_CONFIG) ids.push("op-config");
  if (kind === "file" && markdown) ids.push("op-markdown");
  if (kind === "code" && markdown) ids.push("op-handler");
  if (kind !== "folder" && fromFolder) ids.push("op-preview");
  return ids;
}
