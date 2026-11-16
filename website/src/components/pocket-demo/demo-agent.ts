import { BOLD, CLEAR_LINE, DIM, RESET, fg } from "dormouse-lib/lib/ansi";

/**
 * The pretend coding agent in the homepage's Pocket demo. It takes one request
 * at its prompt, reads for a moment, asks one multiple-choice question that an
 * arrow and Enter answer, then works and finishes. Every line stays narrow: a
 * phone-width terminal is about 36 columns.
 */

export type DemoAgentPhase = "prompt" | "reading" | "asking" | "working" | "done";

const SPINNER = ["✻", "✳", "✢", "·", "✢", "✳"];
const FRAME_MS = 120;
const ACCENT = fg(33);
const OK = fg(32);
const TOOL = fg(36);
const PROMPT = `${BOLD}>${RESET} `;

const QUESTION = ["Where may a README load", ".glb models from?"];
const CHOICES = ["Anywhere, http(s) too", "Its folder, like images", "Something else…"];

const READING: readonly string[] = [
  `${TOOL}●${RESET} Read ${DIM}viewer/markdown.tsx${RESET}`,
  `${TOOL}●${RESET} Read ${DIM}src/markdown-images.ts${RESET}`,
  `${TOOL}●${RESET} Search ${DIM}"imagePlugin" · 6 hits${RESET}`,
];

const WORKING: readonly string[] = [
  `${TOOL}●${RESET} Write ${DIM}viewer/glb-view.ts${RESET} ${OK}+164${RESET}`,
  `${TOOL}●${RESET} Update ${DIM}viewer/markdown.tsx${RESET} ${OK}+38${RESET} ${fg(31)}−2${RESET}`,
  `${TOOL}●${RESET} Update ${DIM}src/markdown-images.ts${RESET} ${OK}+9${RESET}`,
  `${TOOL}●${RESET} Bash ${DIM}pnpm test${RESET}`,
  `  ${OK}✓${RESET} ${DIM}213 passed${RESET}`,
  `${TOOL}●${RESET} Bash ${DIM}dor open README.md${RESET}`,
];

const DONE = [
  `${OK}Done.${RESET} ${BOLD}![](cheese.glb)${RESET} now`,
  "renders in place, served from",
  "the README's own folder.",
];

/** Key sequences the question answers to; everything else it ignores. */
const DOWN = /\x1b(?:\[|O)B/;
const UP = /\x1b(?:\[|O)A/;

export class DemoAgent {
  private phase: DemoAgentPhase = "prompt";
  private line = "";
  private choice = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private spinner: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(phase: DemoAgentPhase) => void>();

  constructor(private readonly send: (data: string) => void) {}

  start(): void {
    this.send("\x1b]2;agent\x07");
    this.send(`${ACCENT}✻${RESET} ${BOLD}agent${RESET} ${DIM}~/dormouse${RESET}\r\n\r\n`);
    this.prompt();
  }

  /** Resolves once the agent reaches `phase`, at once if it is already there. */
  waitFor(phase: DemoAgentPhase): Promise<void> {
    if (this.phase === phase) return Promise.resolve();
    return new Promise((resolve) => {
      const listener = (next: DemoAgentPhase) => {
        if (next !== phase) return;
        this.listeners.delete(listener);
        resolve();
      };
      this.listeners.add(listener);
    });
  }

  handleInput(data: string): void {
    if (this.phase === "asking") {
      if (DOWN.test(data)) this.moveChoice(1);
      else if (UP.test(data)) this.moveChoice(-1);
      else if (data.includes("\r")) this.answer();
      return;
    }
    if (this.phase !== "prompt" && this.phase !== "done") return;
    for (const ch of data) {
      if (ch === "\r") {
        const request = this.line.trim();
        this.line = "";
        this.send("\r\n");
        if (request) this.read();
        else this.send(PROMPT);
        return;
      }
      if (ch === "\x7f") {
        if (!this.line) continue;
        this.line = this.line.slice(0, -1);
        this.send("\b \b");
      } else if (ch >= " ") {
        this.line += ch;
        this.send(ch);
      }
    }
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.stopSpinner();
    this.listeners.clear();
  }

  private setPhase(phase: DemoAgentPhase): void {
    this.phase = phase;
    for (const listener of [...this.listeners]) listener(phase);
  }

  private prompt(): void {
    this.send(PROMPT);
    this.setPhase(this.phase === "working" ? "done" : "prompt");
  }

  private read(): void {
    this.setPhase("reading");
    this.send("\r\n");
    this.steps(READING, 2_400, () => {
      this.send(`\r\n${ACCENT}?${RESET} ${BOLD}${QUESTION[0]}${RESET}\r\n  ${BOLD}${QUESTION[1]}${RESET}\r\n\r\n`);
      this.send(this.choices());
      this.send("\x1b[?25l");
      this.setPhase("asking");
    });
  }

  private choices(): string {
    return CHOICES.map((label, index) => (
      index === this.choice
        ? `${CLEAR_LINE}${ACCENT}❯ ${index + 1}. ${label}${RESET}`
        : `${CLEAR_LINE}  ${DIM}${index + 1}.${RESET} ${label}`
    )).join("\r\n");
  }

  private moveChoice(delta: number): void {
    this.choice = Math.max(0, Math.min(CHOICES.length - 1, this.choice + delta));
    this.send(`\x1b[${CHOICES.length - 1}A\r${this.choices()}`);
  }

  private answer(): void {
    this.send(`\x1b[${CHOICES.length - 1}A\r\x1b[J${OK}✓${RESET} ${CHOICES[this.choice]}\r\n\x1b[?25h\r\n`);
    this.setPhase("working");
    this.steps(WORKING, 6_500, () => {
      this.send(`\r\n${DONE.join("\r\n")}\r\n\r\n`);
      this.prompt();
    });
  }

  /** Prints `lines` across `durationMs` under a live spinner, then `then`. */
  private steps(lines: readonly string[], durationMs: number, then: () => void): void {
    const started = Date.now();
    let frame = 0;
    const label = this.phase === "reading" ? "Reading" : "Chugging";
    const spin = () => {
      const seconds = Math.floor((Date.now() - started) / 1_000);
      this.send(`\r${CLEAR_LINE}${ACCENT}${SPINNER[frame++ % SPINNER.length]} ${label}…${RESET} ${DIM}${seconds}s${RESET}`);
    };
    this.send("\x1b[?25l");
    spin();
    this.spinner = setInterval(spin, FRAME_MS);
    const gap = durationMs / (lines.length + 1);
    lines.forEach((line, index) => {
      this.timers.push(setTimeout(() => {
        this.send(`\r${CLEAR_LINE}${line}\r\n`);
        spin();
      }, gap * (index + 1)));
    });
    this.timers.push(setTimeout(() => {
      this.stopSpinner();
      this.send(`\r${CLEAR_LINE}\x1b[?25h`);
      then();
    }, durationMs));
  }

  private stopSpinner(): void {
    if (this.spinner !== null) clearInterval(this.spinner);
    this.spinner = null;
  }
}
