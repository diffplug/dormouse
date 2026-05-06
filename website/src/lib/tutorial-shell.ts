import { CLEAR_LINE, PROMPT, RESET, fg } from 'mouseterm-lib/lib/ansi';

export type SendOutput = (data: string) => void;

export interface InteractiveProgram {
  start(): void;
  handleInput(data: string): void;
  dispose(): void;
}

/**
 * Factory for the program identified by `name`. Return null if the command
 * is not recognized; the shell will print an "Unknown command" message.
 */
export type StartProgram = (
  name: string,
  args: string[],
  onExit: () => void,
) => InteractiveProgram | null;

/**
 * Minimal browser shell for playground panes. Provides line editing,
 * command history, and dispatch to interactive programs (`tut`,
 * `ascii-splash`, ...) supplied by the host. Output goes through
 * `sendOutput`; input bytes arrive via `handleInput`.
 */
export class TutorialShell {
  private lineBuffer = '';
  private history: string[] = [];
  private historyIndex: number | null = null;
  private historyDraft = '';
  private sendOutput: SendOutput;
  private startProgram: StartProgram;
  private activeProgram: InteractiveProgram | null = null;
  private promptShown = false;

  constructor(
    sendOutput: SendOutput,
    startProgram: StartProgram,
    options: { promptShown?: boolean } = {},
  ) {
    this.sendOutput = sendOutput;
    this.startProgram = startProgram;
    this.promptShown = options.promptShown ?? false;
  }

  dispose(): void {
    this.activeProgram?.dispose();
    this.activeProgram = null;
  }

  /** Programmatically run a command. Used to auto-launch `tut` on mount. */
  runCommand(name: string, args: string[] = []): void {
    if (this.activeProgram) return;
    const program = this.startProgram(name, args, () => {
      this.activeProgram = null;
      this.showPrompt();
    });
    if (!program) {
      this.sendOutput(`${fg(90)}Unknown command: ${name}${RESET}\r\n`);
      this.showPrompt();
      return;
    }
    this.activeProgram = program;
    this.activeProgram.start();
  }

  handleInput(data: string): void {
    if (this.activeProgram) {
      this.activeProgram.handleInput(data);
      return;
    }
    if (!this.promptShown) {
      this.showPrompt();
    }

    for (let index = 0; index < data.length; index++) {
      const ch = data[index];
      if (ch === '\x1b') {
        const remaining = data.slice(index);
        const csi = remaining.match(/^\x1b\[([0-?]*)([ -/]*)([@-~])/);
        if (csi) {
          this.handleControlSequence(csi[3]);
          index += csi[0].length - 1;
          continue;
        }
        const ss3 = remaining.match(/^\x1bO(.)/);
        if (ss3) {
          this.handleControlSequence(ss3[1]);
          index += ss3[0].length - 1;
          continue;
        }
        continue;
      }

      if (ch === '\r' || ch === '\n') {
        this.sendOutput('\r\n');
        const command = this.lineBuffer.trim();
        this.pushHistory(command);
        this.processCommand(command);
        this.lineBuffer = '';
        this.historyIndex = null;
        this.historyDraft = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.lineBuffer.length > 0) {
          this.lineBuffer = this.lineBuffer.slice(0, -1);
          this.historyIndex = null;
          this.sendOutput('\b \b');
        }
      } else if (ch >= ' ') {
        this.lineBuffer += ch;
        this.historyIndex = null;
        this.sendOutput(ch);
      }
    }
  }

  private handleControlSequence(finalByte: string): void {
    if (finalByte === 'A') {
      this.recallHistory(-1);
    } else if (finalByte === 'B') {
      this.recallHistory(1);
    }
  }

  private pushHistory(command: string): void {
    if (!command) return;
    if (this.history[this.history.length - 1] === command) return;
    this.history.push(command);
  }

  private recallHistory(direction: -1 | 1): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      if (direction === 1) return;
      this.historyDraft = this.lineBuffer;
      this.historyIndex = this.history.length - 1;
    } else {
      this.historyIndex += direction;
      if (this.historyIndex < 0) {
        this.historyIndex = 0;
      } else if (this.historyIndex >= this.history.length) {
        this.historyIndex = null;
        this.lineBuffer = this.historyDraft;
        this.redrawPromptLine();
        return;
      }
    }
    this.lineBuffer = this.history[this.historyIndex];
    this.redrawPromptLine();
  }

  private redrawPromptLine(): void {
    this.sendOutput(`\r${CLEAR_LINE}${PROMPT}${this.lineBuffer}`);
  }

  private processCommand(cmd: string): void {
    if (cmd === '') {
      this.showPrompt();
      return;
    }
    const [name, ...args] = cmd.split(/\s+/);
    const program = this.startProgram(name, args, () => {
      this.activeProgram = null;
      this.showPrompt();
    });
    if (!program) {
      this.sendOutput(
        `${fg(90)}Unknown command. Try ${fg(36)}tut${fg(90)} or ${fg(36)}ascii-splash${fg(90)}.${RESET}\r\n`,
      );
      this.showPrompt();
      return;
    }
    this.activeProgram = program;
    this.activeProgram.start();
  }

  private showPrompt(): void {
    this.sendOutput(PROMPT);
    this.promptShown = true;
  }
}
