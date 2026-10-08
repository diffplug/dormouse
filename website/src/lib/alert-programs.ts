import { BOLD, CLEAR_LINE, DIM, RESET, fg } from "dormouse-lib/lib/ansi";
import type { InteractiveProgram, SendOutput } from "./tutorial-shell";

/**
 * The pretend programs the Alerts section has the user run in an ordinary
 * playground shell (docs/specs/tutorial.md -> Fake shell behavior), so a pane
 * rings for the reasons a real one would: a program asking for the user, a
 * watched command going quiet, a command finishing.
 */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 100;
/** One `agent` turn: past the detector's BUSY confirmation, which a WATCHING
 *  settle needs, and short enough to wait through. */
export const AGENT_TURN_MS = 4_000;
/** How long `build` runs before it exits. */
export const BUILD_MS = 8_000;
/** What a terminal sends for `Ctrl-C`; both programs quit on it. */
const INTERRUPT = "\x03";
const EXIT_INTERRUPTED = 130;
const AGENT_PROMPT = `${fg(36)}>${RESET} `;
/** The question `agent` stops to ask, and the notification it sends with it. */
const AGENT_QUESTION = "Allow edit to README.md?";
const FIRST_TASK = "tidy up README.md";

/** Key sequences are not text, so neither program types them. */
const KEY_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|.)?/g;

type AgentPhase = "working" | "asking" | "idle";

/**
 * `agent` — a pretend coding agent. It works on a task for one turn, then asks
 * permission and sends an `OSC 9` notification, as a real agent does when it
 * needs the user; `agent --quiet` just stops when done, sending nothing, and
 * rings only because `agent` is watched by default (Cursor's CLI). Typing a
 * request at its `>` prompt starts another turn.
 */
export class AgentProgram implements InteractiveProgram {
  private phase: AgentPhase = "idle";
  private line = "";
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly send: SendOutput,
    private readonly quiet: boolean,
    private readonly onExit: (exitCode?: number) => void,
  ) {}

  start(): void {
    const mode = this.quiet ? "never asks, just stops" : "asks when it needs you";
    this.send(`${BOLD}agent${RESET} ${DIM}— a pretend coding agent that ${mode}. Ctrl-C quits.${RESET}\r\n\r\n`);
    this.work(FIRST_TASK);
  }

  handleInput(data: string): void {
    for (const ch of data.replace(KEY_SEQUENCE, "")) {
      if (ch === INTERRUPT) {
        this.send("^C\r\n");
        this.dispose();
        this.onExit(EXIT_INTERRUPTED);
        return;
      }
      if (this.phase === "asking") this.answer(ch);
      else if (this.phase === "idle") this.edit(ch);
    }
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private work(task: string): void {
    this.phase = "working";
    // Its question titled the pane, as a real agent's does; working retitles it.
    this.send("\x1b]2;agent\x07");
    const startedAt = Date.now();
    let frame = 0;
    this.timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed < AGENT_TURN_MS) {
        const spinner = `${fg(33)}${SPINNER[frame++ % SPINNER.length]}${RESET}`;
        this.send(`\r${CLEAR_LINE}${spinner} Working on ${task}… ${DIM}${Math.floor(elapsed / 1_000)}s${RESET}`);
        return;
      }
      this.dispose();
      this.send(`\r${CLEAR_LINE}`);
      if (this.quiet) {
        this.send(`${fg(32)}✓${RESET} Done: ${task}.\r\n\r\n`);
        this.idle();
      } else {
        this.phase = "asking";
        this.send(`I'd like to edit README.md.\r\n${BOLD}${AGENT_QUESTION}${RESET} [y/n] \x1b]9;agent: ${AGENT_QUESTION}\x07`);
      }
    }, FRAME_MS);
  }

  private answer(ch: string): void {
    const key = ch.toLowerCase();
    if (key === "y") this.send(`y\r\n${fg(32)}✓${RESET} Edited README.md.\r\n\r\n`);
    else if (key === "n") this.send("n\r\nOK, I left README.md alone.\r\n\r\n");
    else return;
    this.idle();
  }

  private idle(): void {
    this.phase = "idle";
    this.send(`${DIM}Ask for something else and press Enter.${RESET}\r\n${AGENT_PROMPT}`);
  }

  private edit(ch: string): void {
    if (ch === "\r" || ch === "\n") {
      const task = this.line.trim();
      this.line = "";
      this.send("\r\n");
      if (task) this.work(task);
      else this.send(AGENT_PROMPT);
    } else if (ch === "\x7f" || ch === "\b") {
      if (!this.line) return;
      this.line = this.line.slice(0, -1);
      this.send("\b \b");
    } else if (ch >= " ") {
      this.line += ch;
      this.send(ch);
    }
  }
}

const BUILD_STEPS = ["Resolving packages", "Compiling lib", "Compiling website", "Bundling", "Writing dist/"];

/** `build` — prints its steps for `BUILD_MS`, then exits 0. It sends no
 *  notification: a command finishing is reason enough to ring. */
export class BuildProgram implements InteractiveProgram {
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly send: SendOutput,
    private readonly onExit: (exitCode?: number) => void,
  ) {}

  start(): void {
    const stepMs = BUILD_MS / BUILD_STEPS.length;
    BUILD_STEPS.forEach((step, index) => {
      this.timers.push(setTimeout(() => {
        this.send(`${DIM}[${index + 1}/${BUILD_STEPS.length}]${RESET} ${step}…\r\n`);
      }, index * stepMs));
    });
    this.timers.push(setTimeout(() => {
      this.timers = [];
      this.send(`${fg(32)}✓${RESET} Build finished in ${(BUILD_MS / 1_000).toFixed(1)}s.\r\n`);
      this.onExit(0);
    }, BUILD_MS));
  }

  handleInput(data: string): void {
    if (!data.includes(INTERRUPT)) return;
    this.send("^C\r\n");
    this.dispose();
    this.onExit(EXIT_INTERRUPTED);
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

/** The Alerts section's programs by name, or null for any other command. */
export function startAlertProgram(
  name: string,
  args: string[],
  send: SendOutput,
  onExit: (exitCode?: number) => void,
): InteractiveProgram | null {
  if (name === "agent") return new AgentProgram(send, args.includes("--quiet"), onExit);
  if (name === "build") return new BuildProgram(send, onExit);
  return null;
}
