import type { FakePtyAdapter } from "mouseterm-lib/lib/platform/fake-adapter";
import { TutorialShell, type InteractiveProgram } from "./tutorial-shell";

export type StartPlaygroundProgram = (
  terminalId: string,
  args: string[],
  onExit: () => void,
) => InteractiveProgram;

export class PlaygroundShellRegistry {
  private adapter: FakePtyAdapter;
  private startProgram: StartPlaygroundProgram;
  private shells = new Map<string, TutorialShell>();
  private handlePtyExit = (detail: { id: string }) => {
    this.disposeShell(detail.id);
  };

  constructor(adapter: FakePtyAdapter, startProgram: StartPlaygroundProgram) {
    this.adapter = adapter;
    this.startProgram = startProgram;
    this.adapter.onPtyExit(this.handlePtyExit);
  }

  ensureShell(id: string): TutorialShell {
    const existing = this.shells.get(id);
    if (existing) return existing;

    const shell = new TutorialShell(
      (data) => this.adapter.sendOutput(id, data),
      (args, onExit) => this.startProgram(id, args, onExit),
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
    for (const id of this.shells.keys()) {
      this.disposeShell(id);
    }
  }
}
