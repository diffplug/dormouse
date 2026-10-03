import { BOLD, CLEAR_LINE, PROMPT, RESET, fg, promptFor } from 'dormouse-lib/lib/ansi';
import { shortPath } from 'dor/commands/open-picker';
import { HOME, type DirEntry, type VirtualFs } from './playground-fs/vfs';

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

/** The longest prefix every one of `names` shares. */
function commonPrefix(names: string[]): string {
  let prefix = names[0] ?? '';
  for (const name of names) while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

/** A shell's filesystem and working directory. */
interface Place { fs: VirtualFs; cwd: string }

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
  /** The last key was a Tab that completed nothing, so the next one lists. */
  private tabbed = false;
  /** The filesystem and working directory, when the shell has them. */
  private readonly place: Place | null;

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
    this.place = options.fs ? { fs: options.fs, cwd: options.cwd ?? '/' } : null;
  }

  /** The working directory, reported with each prompt; only with `fs`. */
  get cwd(): string | null {
    return this.place?.cwd ?? null;
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
      if (ch === '\t') {
        this.complete();
        continue;
      }
      this.tabbed = false;
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

  /** With a filesystem, completes the word at the end of the line as bash
   * does: `dor`'s verb, or a path, never the command name. A unique match is
   * finished; several extend to their common prefix, and a second Tab that
   * extends nothing lists them. */
  private complete(): void {
    const place = this.place;
    if (!place) return;
    const raw = /(?:\\.|[^\s\\])*$/.exec(this.lineBuffer)![0];
    const before = shellWords(this.lineBuffer.slice(0, this.lineBuffer.length - raw.length));
    if (before.length === 0) return;
    const word = shellWords(raw)[0] ?? '';
    const slash = word.lastIndexOf('/');
    const stem = word.slice(slash + 1);
    let entries: DirEntry[];
    if (before.length === 1 && before[0] === 'dor') {
      entries = [{ name: 'open', kind: 'file' }];
    } else {
      const dir = place.fs.resolve(place.cwd, word.slice(0, slash + 1) || '.');
      entries = (dir === null ? null : place.fs.list(dir)) ?? [];
      if (before[0] === 'cd') entries = entries.filter((entry) => entry.kind === 'dir');
    }
    const matches = entries.filter(({ name }) => name.startsWith(stem) && (stem.startsWith('.') || !name.startsWith('.')));
    if (matches.length === 0) return;
    const [only] = matches;
    const rest = (matches.length === 1 ? only.name : commonPrefix(matches.map(({ name }) => name))).slice(stem.length);
    // Quoted words keep their text; bare ones escape what the shell would split on.
    const escaped = /['"]/.test(raw) ? rest : rest.replace(/[\s'"\\$`;&|<>()]/g, '\\$&');
    const insert = matches.length === 1 ? escaped + (only.kind === 'dir' ? '/' : ' ') : escaped;
    if (insert) {
      this.lineBuffer += insert;
      this.historyIndex = null;
      this.sendOutput(insert);
    } else if (this.tabbed) {
      const list = matches.map(({ name, kind }) => (kind === 'dir' ? `${name}/` : name)).join('  ');
      this.sendOutput(`\r\n${list}\r\n${this.prompt()}${this.lineBuffer}`);
    }
    this.tabbed = !insert;
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
    const place = this.place;
    if (place && (name === 'cd' || name === 'ls' || name === 'pwd')) {
      this.sendOutput(oscCommandLine(cmd) + OSC_COMMAND_START);
      this.finishCommand(name === 'cd' ? this.cd(place, args) : name === 'ls' ? this.ls(place, args) : this.print(place.cwd));
      return null;
    }
    if (!this.launch(name, args, cmd)) {
      const names = place ? ['tut', 'dor open', 'ls', 'cd', 'ascii-splash', 'changelog'] : ['tut', 'ascii-splash', 'changelog'];
      const list = names.map((known) => `${fg(36)}${known}${fg(90)}`);
      this.sendOutput(`${fg(90)}Unknown command. Try ${list.slice(0, -1).join(', ')}, or ${list[list.length - 1]}.${RESET}\r\n`);
      this.finishCommand(EXIT_COMMAND_NOT_FOUND);
    }
    return this.activeProgram;
  }

  private prompt(): string {
    return this.place ? promptFor(shortPath(this.place.cwd, HOME)) : PROMPT;
  }

  private showPrompt(): void {
    this.sendOutput(OSC_PROMPT_START + (this.place ? oscCwd(this.place.cwd) : '') + this.prompt() + OSC_PROMPT_END);
    this.promptShown = true;
  }

  /** Writes one line of builtin output; answers exit code 0. */
  private print(line: string): number {
    this.sendOutput(`${line}\r\n`);
    return 0;
  }

  /** `path` resolved against the cwd, or null after reporting why not. */
  private resolve({ fs, cwd }: Place, command: string, path: string): string | null {
    const resolved = fs.resolve(cwd, path);
    if (resolved !== null && fs.kind(resolved)) return resolved;
    this.print(`${command}: no such file or directory: ${path}`);
    return null;
  }

  private cd(place: Place, args: string[]): number {
    const target = this.resolve(place, 'cd', args[0] ?? '~');
    if (target === null) return 1;
    if (place.fs.kind(target) !== 'dir') {
      this.print(`cd: not a directory: ${args[0]}`);
      return 1;
    }
    place.cwd = target;
    return 0;
  }

  private ls(place: Place, args: string[]): number {
    const paths = args.filter((arg) => !arg.startsWith('-'));
    if (paths.length === 0) paths.push('.');
    let exitCode = 0;
    paths.forEach((path, index) => {
      const target = this.resolve(place, 'ls', path);
      if (target === null) { exitCode = 1; return; }
      const entries = place.fs.list(target);
      if (paths.length > 1) this.print(`${index ? '\r\n' : ''}${path}:`);
      this.print(entries
        ? entries.map(({ name, kind }) => (kind === 'dir' ? `${BOLD}${fg(34)}${name}/${RESET}` : name)).join('  ')
        : path);
    });
    return exitCode;
  }
}
