import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import { TutorialShell, type InteractiveProgram } from "./tutorial-shell";
import type { VirtualFs } from "./playground-fs/vfs";

export type StartPlaygroundProgram = (
  terminalId: string,
  name: string,
  args: string[],
  onExit: (exitCode?: number) => void,
) => InteractiveProgram | null;

/** A filesystem gives every shell a working directory and its builtins, and
 * a prompt as each terminal spawns: nothing else prints one (docs/specs/tutorial.md
 * -> Playground filesystem). */
export interface PlaygroundFsOptions { fs: VirtualFs; cwd: string }

export class PlaygroundShellRegistry {
  private adapter: FakePtyAdapter;
  private startProgram: StartPlaygroundProgram;
  private shells = new Map<string, TutorialShell>();
  private fsOptions: PlaygroundFsOptions | undefined;
  private stopSpawn: (() => void) | undefined;
  private handlePtyExit = (detail: { id: string }) => {
    this.disposeShell(detail.id);
  };

  constructor(adapter: FakePtyAdapter, startProgram: StartPlaygroundProgram, fsOptions?: PlaygroundFsOptions) {
    this.adapter = adapter;
    this.startProgram = startProgram;
    this.fsOptions = fsOptions;
    this.adapter.onPtyExit(this.handlePtyExit);
    // Every spawn, not only a visible pane's: a Door spawns without `paneAdded`.
    // A microtask, so a page's own spawn handler can launch a program first.
    if (fsOptions) {
      this.stopSpawn = adapter.onPtySpawn(({ id, helper }) => {
        if (helper) return;
        const shell = this.ensureShell(id);
        queueMicrotask(() => shell.showInitialPrompt());
      });
    }
  }

  /** The shell's working directory, when it has a filesystem. */
  cwdOf(id: string): string | null {
    return this.shells.get(id)?.cwd ?? null;
  }

  ensureShell(id: string): TutorialShell {
    const existing = this.shells.get(id);
    if (existing) return existing;

    const shell = new TutorialShell(
      (data) => this.adapter.sendOutput(id, data),
      (name, args, onExit) => this.startProgram(id, name, args, onExit),
      { promptShown: this.adapter.scenarioEndsWithPrompt(id), ...this.fsOptions },
    );
    this.shells.set(id, shell);
    this.adapter.setInputHandler(id, (data) => shell.handleInput(data));
    return shell;
  }

  disposeShell(id: string): void {
    this.shells.get(id)?.dispose();
    this.shells.delete(id);
    this.adapter.clearInputHandler(id);
  }

  disposeAll(): void {
    this.adapter.offPtyExit(this.handlePtyExit);
    this.stopSpawn?.();
    for (const id of [...this.shells.keys()]) {
      this.disposeShell(id);
    }
  }
}
