import { BOLD, CLEAR_LINE, DIM, RESET, fg } from "dormouse-lib/lib/ansi";

/**
 * The pretend coding agent in the homepage's Pocket demo. It takes one request
 * at its prompt, reads for a moment, asks one multiple-choice question that ▼
 * and Enter answer, then works and finishes. It handles only the input the
 * demo's script sends. Every line stays narrow: a phone-width terminal is about
 * 36 columns.
 */

type Phase = "prompt" | "reading" | "asking" | "working" | "done";

const SPINNER = ["✻", "✳", "✢", "·", "✢", "✳"];
const FRAME_MS = 120;
const ACCENT = fg(33);
const OK = fg(32);
const TOOL = fg(36);
const PROMPT = `${BOLD}>${RESET} `;

const QUESTION = `${BOLD}Where may a README load\r\n  .glb models from?${RESET}`;
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

const DONE = `${OK}Done.${RESET} ${BOLD}![](cheese.glb)${RESET} now\r\nrenders in place, served from\r\nthe README's own folder.`;

const DOWN = /\x1b(?:\[|O)B/;

export class DemoAgent {
  private phase: Phase = "prompt";
  private choice = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private spinner: ReturnType<typeof setInterval> | null = null;
  private waiting: { phase: Phase; resolve: () => void } | null = null;

  constructor(private readonly send: (data: string) => void) {}

  start(): void {
    this.send("\x1b]2;agent\x07");
    this.send(`${ACCENT}✻${RESET} ${BOLD}agent${RESET} ${DIM}~/dormouse${RESET}\r\n\r\n${PROMPT}`);
  }

  /** Resolves once the agent reaches `phase`. */
  waitFor(phase: Phase): Promise<void> {
    if (this.phase === phase) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiting = { phase, resolve };
    });
  }

  handleInput(data: string): void {
    if (this.phase === "asking") {
      if (DOWN.test(data)) this.moveDown();
      else if (data.includes("\r")) this.answer();
    } else if (this.phase === "prompt") {
      if (data.includes("\r")) this.read();
      else this.send(data);
    }
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.stopSpinner();
    this.waiting = null;
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    if (this.waiting?.phase !== phase) return;
    const { resolve } = this.waiting;
    this.waiting = null;
    resolve();
  }

  private read(): void {
    this.setPhase("reading");
    this.send("\r\n\r\n");
    this.steps("Reading", READING, 600, () => {
      this.send(`\r\n${ACCENT}?${RESET} ${QUESTION}\r\n\r\n${this.choices()}\x1b[?25l`);
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

  private moveDown(): void {
    this.choice = Math.min(CHOICES.length - 1, this.choice + 1);
    this.send(`\x1b[${CHOICES.length - 1}A\r${this.choices()}`);
  }

  private answer(): void {
    this.send(`\x1b[${CHOICES.length - 1}A\r\x1b[J${OK}✓${RESET} ${CHOICES[this.choice]}\r\n\x1b[?25h\r\n`);
    this.setPhase("working");
    this.steps("Chugging", WORKING, 1_625, () => {
      this.send(`\r\n${DONE}\r\n\r\n${PROMPT}`);
      this.setPhase("done");
    });
  }

  /** Prints `lines` across `durationMs` under a live spinner, then `then`. */
  private steps(label: string, lines: readonly string[], durationMs: number, then: () => void): void {
    const started = Date.now();
    let frame = 0;
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
