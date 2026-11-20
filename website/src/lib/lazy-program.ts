import type { InteractiveProgram } from "./tutorial-shell";

/**
 * A program whose module loads when it first runs, so a heavy one never holds
 * up the page that offers it. Input typed while it loads is replayed to it; if
 * the module fails to load, the program exits with status 1.
 */
export function lazyProgram(load: () => Promise<InteractiveProgram>, onExit: (exitCode?: number) => void): InteractiveProgram {
  let program: InteractiveProgram | null = null;
  let disposed = false;
  const queued: string[] = [];
  return {
    start() {
      load().then((loaded) => {
        if (disposed) return loaded.dispose();
        program = loaded;
        loaded.start();
        for (const data of queued.splice(0)) loaded.handleInput(data);
      }, () => {
        if (!disposed) onExit(1);
      });
    },
    handleInput(data) {
      if (program) program.handleInput(data);
      else queued.push(data);
    },
    dispose() {
      disposed = true;
      program?.dispose();
    },
  };
}
