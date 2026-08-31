import { CLEAR_LINE, PROMPT, RESET, fg } from 'dormouse-lib/lib/ansi';

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

// Report real command boundaries: WATCHING is keyed on the running command.
// See docs/specs/tutorial.md → "Fake shell behavior".
const OSC_PROMPT_START = '\x1b]633;A\x07';
const OSC_PROMPT_END = '\x1b]633;B\x07';
const OSC_COMMAND_START = '\x1b]633;C\x07';
const oscCommandLine = (commandLine: string) => `\x1b]633;E;${commandLine}\x07`;
const oscCommandFinish = (exitCode: number) => `\x1b]633;D;${exitCode}\x07`;

/** Exit code a POSIX shell uses for an unrecognized command. */
const EXIT_COMMAND_NOT_FOUND = 127;

/**
 * Minimal browser shell for playground panes. Provides line editing,
 * command history, dispatch to interactive programs (`tut`, `ascii-splash`,
 * ...) supplied by the host, and shell-integration reporting for all of it.
 * Output goes through `sendOutput`; input bytes arrive via `handleInput`.
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
  private runningCommandLine: string | null = null;

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
    this.runningCommandLine = null;
  }

  /** Programmatically run a command. Used to auto-launch `tut` on mount. */
  runCommand(name: string, args: string[] = []): void {
    if (this.activeProgram) return;
    if (!this.launch(name, args, [name, ...args].join(' '))) {
      this.sendOutput(`${fg(90)}Unknown command: ${name}${RESET}\r\n`);
      this.finishCommand(EXIT_COMMAND_NOT_FOUND);
    }
  }

  /**
   * Re-announce the running program's command line. The alert tutorial
   * temporarily reports a different command on a pane to demo a WATCHING rule
   * (`docs/specs/tutorial.md`); this restores the truth afterwards without
   * disturbing the program's screen. No-op at a prompt.
   */
  reportRunningCommand(): void {
    if (this.runningCommandLine === null) return;
    this.sendOutput(oscCommandLine(this.runningCommandLine) + OSC_COMMAND_START);
  }

  /**
   * Announce and start `name`. Returns false when the command is unknown, in
   * which case the caller prints its own message and closes the run out.
   */
  private launch(name: string, args: string[], commandLine: string): boolean {
    this.runningCommandLine = commandLine;
    this.sendOutput(oscCommandLine(commandLine) + OSC_COMMAND_START);
    const program = this.startProgram(name, args, () => {
      this.activeProgram = null;
      this.finishCommand(0);
    });
    if (!program) return false;
    this.activeProgram = program;
    this.activeProgram.start();
    return true;
  }

  private finishCommand(exitCode: number): void {
    this.runningCommandLine = null;
    this.sendOutput(oscCommandFinish(exitCode));
    this.showPrompt();
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
        // `processCommand` may have launched an interactive program. Any bytes
        // left in this chunk (e.g. a paste of `cmd\rinput`) belong to that
        // program, not the shell line editor — forward them and stop parsing.
        if (this.activeProgram) {
          const rest = data.slice(index + 1);
          if (rest) this.activeProgram.handleInput(rest);
          return;
        }
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
    if (!this.launch(name, args, cmd)) {
      this.sendOutput(
        `${fg(90)}Unknown command. Try ${fg(36)}tut${fg(90)}, ${fg(36)}ascii-splash${fg(90)}, or ${fg(36)}changelog${fg(90)}.${RESET}\r\n`,
      );
      this.finishCommand(EXIT_COMMAND_NOT_FOUND);
    }
  }

  private showPrompt(): void {
    this.sendOutput(OSC_PROMPT_START + PROMPT + OSC_PROMPT_END);
    this.promptShown = true;
  }
}
