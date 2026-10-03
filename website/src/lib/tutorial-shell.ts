import { BOLD, CLEAR_LINE, PROMPT, RESET, fg } from 'dormouse-lib/lib/ansi';
import { tildePath, type VirtualFs } from './playground-fs/vfs';

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
  onExit: (exitCode?: number) => void,
) => InteractiveProgram | null;

// Report real command boundaries: WATCHING is keyed on the running command.
// See docs/specs/tutorial.md → "Fake shell behavior".
const OSC_PROMPT_START = '\x1b]633;A\x07';
const OSC_PROMPT_END = '\x1b]633;B\x07';
const OSC_COMMAND_START = '\x1b]633;C\x07';
/** A 633 property value: the parser splits on `;` and unescapes `\\` and `\x3b`. */
const osc633Value = (value: string) => value.replace(/\\/g, '\\\\').replace(/;/g, '\\x3b');
const oscCommandLine = (commandLine: string) => `\x1b]633;E;${osc633Value(commandLine)}\x07`;
const oscCommandFinish = (exitCode: number) => `\x1b]633;D;${exitCode}\x07`;
const oscCwd = (cwd: string) => `\x1b]633;P;Cwd=${osc633Value(cwd)}\x07`;

/** `line` split into words as a POSIX shell would, honoring quotes and
 * backslashes; the playground has no expansions. */
export function shellWords(line: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index++) {
    const ch = line[index];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && /["\\$`]/.test(line[index + 1] ?? '')) word += line[++index];
      else word += ch;
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      inWord = true;
      if (ch === "'" || ch === '"') quote = ch;
      else word += ch === '\\' && index + 1 < line.length ? line[++index] : ch;
    }
  }
  if (inWord) words.push(word);
  return words;
}

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
  private readonly fs: VirtualFs | null;
  /** The working directory, reported with each prompt; only with `fs`. */
  cwd: string | null;

  /** With `fs` and `cwd`, the shell has a working directory and the `cd`,
   * `ls`, and `pwd` builtins (docs/specs/tutorial.md -> Playground filesystem). */
  constructor(
    sendOutput: SendOutput,
    startProgram: StartProgram,
    options: { promptShown?: boolean; fs?: VirtualFs; cwd?: string } = {},
  ) {
    this.sendOutput = sendOutput;
    this.startProgram = startProgram;
    this.promptShown = options.promptShown ?? false;
    this.fs = options.fs ?? null;
    this.cwd = this.fs ? options.cwd ?? '/' : null;
  }

  /** Shows the first prompt, unless a program or an earlier prompt already holds the screen. */
  showInitialPrompt(): void {
    if (!this.activeProgram && !this.promptShown) this.showPrompt();
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
    const program = this.startProgram(name, args, (exitCode = 0) => {
      this.activeProgram = null;
      this.finishCommand(exitCode);
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
        const launchedProgram = this.processCommand(command);
        this.lineBuffer = '';
        this.historyIndex = null;
        this.historyDraft = '';
        // `processCommand` may have launched an interactive program. Any bytes
        // left in this chunk (e.g. a paste of `cmd\rinput`) belong to that
        // program, not the shell line editor — forward them and stop parsing.
        if (launchedProgram) {
          const rest = data.slice(index + 1);
          if (rest) launchedProgram.handleInput(rest);
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
    this.sendOutput(`\r${CLEAR_LINE}${this.prompt()}${this.lineBuffer}`);
  }

  private processCommand(cmd: string): InteractiveProgram | null {
    if (cmd === '') {
      this.showPrompt();
      return null;
    }
    const [name = '', ...args] = shellWords(cmd);
    if (this.fs && (name === 'cd' || name === 'ls' || name === 'pwd')) {
      this.sendOutput(oscCommandLine(cmd) + OSC_COMMAND_START);
      this.finishCommand(name === 'cd' ? this.cd(args) : name === 'ls' ? this.ls(args) : this.pwd());
      return null;
    }
    if (!this.launch(name, args, cmd)) {
      const names = this.fs ? ['tut', 'dor open', 'ls', 'cd', 'ascii-splash', 'changelog'] : ['tut', 'ascii-splash', 'changelog'];
      const list = names.map((known) => `${fg(36)}${known}${fg(90)}`);
      this.sendOutput(`${fg(90)}Unknown command. Try ${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}.${RESET}\r\n`);
      this.finishCommand(EXIT_COMMAND_NOT_FOUND);
    }
    return this.activeProgram;
  }

  private prompt(): string {
    return this.cwd === null ? PROMPT : `${fg(32)}user${RESET}@${fg(36)}dormouse${RESET}:${BOLD}${fg(34)}${tildePath(this.cwd)}${RESET}$ `;
  }

  private showPrompt(): void {
    this.sendOutput(OSC_PROMPT_START + (this.cwd === null ? '' : oscCwd(this.cwd)) + this.prompt() + OSC_PROMPT_END);
    this.promptShown = true;
  }

  /** Writes builtin output, which is plain text lines. */
  private print(lines: string[]): void {
    if (lines.length) this.sendOutput(lines.map((line) => `${line}\r\n`).join(''));
  }

  /** `path` resolved against the cwd, or null after reporting why not. */
  private resolve(command: string, path: string): string | null {
    const resolved = this.fs!.resolve(this.cwd!, path);
    if (resolved !== null && this.fs!.kind(resolved)) return resolved;
    this.print([`${command}: no such file or directory: ${path}`]);
    return null;
  }

  private cd(args: string[]): number {
    const target = this.resolve('cd', args[0] ?? '~');
    if (target === null) return 1;
    if (this.fs!.kind(target) !== 'dir') {
      this.print([`cd: not a directory: ${args[0]}`]);
      return 1;
    }
    this.cwd = target;
    return 0;
  }

  private ls(args: string[]): number {
    const paths = args.filter((arg) => !arg.startsWith('-'));
    if (paths.length === 0) paths.push('.');
    let exitCode = 0;
    paths.forEach((path, index) => {
      const target = this.resolve('ls', path);
      if (target === null) { exitCode = 1; return; }
      const entries = this.fs!.list(target);
      if (paths.length > 1) this.print([`${index ? '\r\n' : ''}${path}:`]);
      this.print([entries
        ? entries.map(({ name, kind }) => (kind === 'dir' ? `${BOLD}${fg(34)}${name}/${RESET}` : name)).join('  ')
        : path]);
    });
    return exitCode;
  }

  private pwd(): number {
    this.print([this.cwd!]);
    return 0;
  }
}
