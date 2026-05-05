/**
 * Browser TUI for the playground tutorial. Follows the same pattern as
 * `ascii-splash-runner.ts`: alt-screen on, render an ANSI-driven view from
 * `TutorialState`, accept input via `FakePtyAdapter.writePty`, restore on
 * exit. No `terminal-kit` package dependency.
 */

import type { FakePtyAdapter } from "mouseterm-lib/lib/platform/fake-adapter";
import type { InteractiveProgram } from "./tutorial-shell";
import { SECTIONS, type Item } from "./tut-items";
import type { TutorialState } from "./tutorial-state";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const fg = (code: number) => `${ESC}${code}m`;

const ENTER_ALT = "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l";
const LEAVE_ALT = "\x1b[2J\x1b[H\x1b[?25h\x1b[?1049l";
const HOME = "\x1b[H";
const CLEAR = "\x1b[2J";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

interface TutRunnerOptions {
  adapter: FakePtyAdapter;
  terminalId: string;
  state: TutorialState;
  onExit: () => void;
  /** Called when the user presses `s` inside the Alert section. */
  onTriggerBusyDemo?: () => void;
}

type Screen = "menu" | "section";

export class TutRunner implements InteractiveProgram {
  private adapter: FakePtyAdapter;
  private terminalId: string;
  private state: TutorialState;
  private onExit: () => void;
  private onTriggerBusyDemo?: () => void;

  private screen: Screen = "menu";
  private menuIndex = 0;
  private sectionId: string | null = null;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private stateUnsub: (() => void) | null = null;
  private resizeUnsub: (() => void) | null = null;
  private disposed = false;

  constructor(options: TutRunnerOptions) {
    this.adapter = options.adapter;
    this.terminalId = options.terminalId;
    this.state = options.state;
    this.onExit = options.onExit;
    this.onTriggerBusyDemo = options.onTriggerBusyDemo;
  }

  start(): void {
    this.write(ENTER_ALT);
    this.stateUnsub = this.state.subscribe(() => this.render());
    this.resizeUnsub = this.adapter.onPtyResize((d) => {
      if (d.id === this.terminalId) this.render();
    });
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.render();
    }, SPINNER_INTERVAL_MS);
    this.render();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x03") {
        this.exit();
        return;
      }
      if (ch === "\x1b") {
        const tail = data.slice(i);
        const csi = tail.match(/^\x1b\[([ABCD])/);
        if (csi) {
          this.handleArrow(csi[1]);
          i += csi[0].length;
          continue;
        }
        // Bare Esc — back / exit
        this.handleEscape();
        i += 1;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        this.handleEnter();
        i += 1;
        continue;
      }
      if (ch === "q" || ch === "Q") {
        this.exit();
        return;
      }
      if (
        this.screen === "section" &&
        this.sectionId === "alert" &&
        (ch === "s" || ch === "S")
      ) {
        this.onTriggerBusyDemo?.();
        i += 1;
        continue;
      }
      i += 1;
    }
  }

  dispose(): void {
    this.cleanup(false);
  }

  // --- Input ---

  private handleArrow(letter: string): void {
    if (this.screen !== "menu") return;
    if (letter === "A") {
      this.menuIndex = (this.menuIndex - 1 + SECTIONS.length) % SECTIONS.length;
    } else if (letter === "B") {
      this.menuIndex = (this.menuIndex + 1) % SECTIONS.length;
    } else {
      return;
    }
    this.render();
  }

  private handleEnter(): void {
    if (this.screen === "menu") {
      const section = SECTIONS[this.menuIndex];
      if (!section) return;
      this.sectionId = section.id;
      this.screen = "section";
      this.render();
    }
  }

  private handleEscape(): void {
    if (this.screen === "section") {
      this.sectionId = null;
      this.screen = "menu";
      this.render();
      return;
    }
    this.exit();
  }

  private exit(): void {
    if (this.disposed) return;
    this.cleanup(true);
  }

  // --- Render ---

  private render(): void {
    if (this.disposed) return;
    const lines = this.screen === "menu" ? this.renderMenu() : this.renderSection();
    let out = `${HOME}${CLEAR}`;
    for (const line of lines) {
      out += `${line}\r\n`;
    }
    this.write(out);
  }

  private renderMenu(): string[] {
    const total = this.state.totalProgress();
    const lines: string[] = [];
    lines.push("");
    lines.push(`  ${BOLD}MouseTerm Playground Tutorial${RESET}`);
    lines.push(
      `  ${DIM}${total.done}/${total.total} complete · Esc/q to exit · Enter to open · ↑↓ to navigate${RESET}`,
    );
    lines.push("");
    SECTIONS.forEach((section, index) => {
      const { done, total: t } = this.state.sectionProgress(section.id);
      const marker = index === this.menuIndex ? `${fg(36)}❯${RESET}` : " ";
      const label = index === this.menuIndex
        ? `${BOLD}${section.title}${RESET}`
        : section.title;
      const progress =
        done === t
          ? `${fg(32)}[${done}/${t} complete]${RESET}`
          : `${DIM}[${done}/${t} complete]${RESET}`;
      lines.push(`  ${marker} ${label}  ${progress}`);
    });
    lines.push("");
    return lines;
  }

  private renderSection(): string[] {
    const section = SECTIONS.find((s) => s.id === this.sectionId);
    if (!section) {
      this.screen = "menu";
      return this.renderMenu();
    }
    const { done, total } = this.state.sectionProgress(section.id);
    const lines: string[] = [];
    lines.push("");
    lines.push(`  ${BOLD}${section.title}${RESET}  ${DIM}${done}/${total} complete${RESET}`);
    lines.push(`  ${DIM}Esc to go back${RESET}`);
    lines.push("");

    const activeIndex = section.items.findIndex((i) => !this.state.isComplete(i.id));
    section.items.forEach((item, index) => {
      lines.push(...this.renderItem(item, index, activeIndex));
    });

    if (section.prose && section.prose.length > 0) {
      lines.push("");
      for (const p of section.prose) lines.push(`  ${DIM}${p}${RESET}`);
    }

    if (section.id === "alert") {
      lines.push("");
      lines.push(`  ${DIM}Press ${fg(36)}s${RESET}${DIM} here to start a fake busy task.${RESET}`);
    }

    if (done === total) {
      lines.push("");
      lines.push(`  ${fg(32)}Section complete.${RESET}`);
    }

    return lines;
  }

  private renderItem(item: Item, index: number, activeIndex: number): string[] {
    const complete = this.state.isComplete(item.id);
    const isActive = !complete && index === activeIndex;
    let mark: string;
    if (complete) {
      mark = `${fg(32)}✓${RESET}`;
    } else if (isActive) {
      mark = `${fg(33)}${SPINNER_FRAMES[this.spinnerFrame]}${RESET}`;
    } else {
      mark = `${DIM}·${RESET}`;
    }
    const title = complete
      ? `${DIM}${item.title}${RESET}`
      : isActive
      ? `${BOLD}${item.title}${RESET}`
      : item.title;
    const lines = [`   ${mark}  ${title}`];
    if (isActive && item.hint) {
      lines.push(`      ${DIM}${item.hint}${RESET}`);
    }
    return lines;
  }

  // --- Internals ---

  private cleanup(notifyExit: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    this.stateUnsub?.();
    this.stateUnsub = null;
    this.resizeUnsub?.();
    this.resizeUnsub = null;
    this.write(LEAVE_ALT);
    if (notifyExit) this.onExit();
  }

  private write(data: string): void {
    this.adapter.sendOutput(this.terminalId, data);
  }
}

