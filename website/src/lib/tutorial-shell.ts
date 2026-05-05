const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const fg = (code: number) => `${ESC}${code}m`;

const PROMPT = `${fg(32)}user${RESET}@${fg(36)}mouseterm${RESET}:${BOLD}${fg(34)}~${RESET}$ `;
const CLEAR_LINE = `${ESC}2K`;

const STORAGE_PREFIX = 'mouseterm-tutorial-step-';
const TOTAL_STEPS = 6;

interface TutorialStep {
  phase: string;
  title: string;
  description: string;
  hint: string;
}

const STEPS: TutorialStep[] = [
  {
    phase: 'See Everything at Once',
    title: 'Split a pane',
    description: "You're juggling multiple tasks. Split this terminal so you can watch two things side by side.",
    hint: 'Drag the split button in the tab header, or drag the tab itself to a drop zone.',
  },
  {
    phase: 'See Everything at Once',
    title: 'Resize your panes',
    description: 'One task needs more room. Drag the divider between panes to give it space.',
    hint: 'Drag the gap between two panes.',
  },
  {
    phase: 'Focus and Background',
    title: 'Zoom in, then zoom back out',
    description: "One terminal needs your full attention. Zoom in to focus, then zoom back out when you're done.",
    hint: 'Double-click a tab header to zoom. Double-click again to unzoom.',
  },
  {
    phase: 'Focus and Background',
    title: 'Detach a pane, then bring it back',
    description: "That task is running in the background — you don't need to watch it. Send it to the baseboard, then click its door when you want it back.",
    hint: 'Click the detach button in the tab header. Click the door in the baseboard to reattach.',
  },
  {
    phase: 'Keyboard Power',
    title: 'Enter command mode and navigate',
    description: 'Navigate between panes without touching the mouse.',
    hint: 'Press Escape to enter command mode. Use arrow keys to move between panes.',
  },
  {
    phase: 'Keyboard Power',
    title: 'Split using keyboard shortcuts',
    description: 'Split a pane without leaving the keyboard.',
    hint: 'In command mode, press " to split top/bottom or % to split left/right.',
  },
];

export type SendOutput = (data: string) => void;

export interface InteractiveProgram {
  start(): void;
  handleInput(data: string): void;
  dispose(): void;
}

export type StartInteractiveProgram = (args: string[], onExit: () => void) => InteractiveProgram;

export class TutorialShell {
  private lineBuffer = '';
  private history: string[] = [];
  private historyIndex: number | null = null;
  private historyDraft = '';
  private sendOutput: SendOutput;
  private startAsciiSplash?: StartInteractiveProgram;
  private activeProgram: InteractiveProgram | null = null;

  constructor(sendOutput: SendOutput, startAsciiSplash?: StartInteractiveProgram) {
    this.sendOutput = sendOutput;
    this.startAsciiSplash = startAsciiSplash;
  }

  dispose(): void {
    this.activeProgram?.dispose();
    this.activeProgram = null;
  }

  handleInput(data: string): void {
    if (this.activeProgram) {
      this.activeProgram.handleInput(data);
      return;
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
        // Lone escape byte: drop it so partial sequences don't echo.
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
      this.sendOutput(PROMPT);
      return;
    }

    const [argv0, ...args] = cmd.split(/\s+/);
    if (cmd === 'tut') {
      this.showCurrentStep();
    } else if (cmd === 'tut status') {
      this.showStatus();
    } else if (cmd === 'tut reset') {
      this.resetProgress();
    } else if (argv0 === 'ascii-splash' || argv0 === 'splash') {
      if (this.startAsciiSplash) {
        this.activeProgram = this.startAsciiSplash(args, () => {
          this.activeProgram = null;
          this.sendOutput(PROMPT);
        });
        this.activeProgram.start();
        return;
      }
      this.sendOutput(`${fg(90)}ascii-splash is not available in this environment.${RESET}\r\n`);
    } else {
      this.sendOutput(`${fg(90)}Unknown command. Type ${fg(36)}tut${fg(90)} or ${fg(36)}ascii-splash${fg(90)}.${RESET}\r\n`);
    }

    this.sendOutput(PROMPT);
  }

  private showCurrentStep(): void {
    const nextStep = this.getNextIncompleteStep();

    if (nextStep === null) {
      this.showCompletion();
      return;
    }

    const step = STEPS[nextStep];
    const stepNum = nextStep + 1;

    this.sendOutput(
      `\r\n` +
      `${DIM}Step ${stepNum}/${TOTAL_STEPS} — ${step.phase}${RESET}\r\n` +
      `${BOLD}${step.title}${RESET}\r\n\r\n` +
      `${step.description}\r\n\r\n` +
      `${DIM}${step.hint}${RESET}\r\n\r\n`
    );
  }

  private showStatus(): void {
    this.sendOutput(`\r\n${BOLD}Tutorial Progress${RESET}\r\n\r\n`);

    let currentPhase = '';
    for (let i = 0; i < TOTAL_STEPS; i++) {
      const step = STEPS[i];
      const done = this.isStepComplete(i);

      if (step.phase !== currentPhase) {
        currentPhase = step.phase;
        this.sendOutput(`${DIM}${currentPhase}${RESET}\r\n`);
      }

      const marker = done ? `${fg(32)}[x]${RESET}` : `${fg(90)}[ ]${RESET}`;
      const label = done ? `${fg(90)}${step.title}${RESET}` : step.title;
      this.sendOutput(`  ${marker} ${label}\r\n`);
    }
    this.sendOutput('\r\n');
  }

  private resetProgress(): void {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      localStorage.removeItem(`${STORAGE_PREFIX}${i + 1}`);
    }
    this.sendOutput(`${fg(32)}Tutorial progress reset.${RESET} Type ${fg(36)}tut${RESET} to start from the beginning.\r\n`);
  }

  private showCompletion(): void {
    this.sendOutput(
      `\r\n` +
      `${fg(32)}${BOLD}You've got it.${RESET} MouseTerm keeps everything visible and nothing in your way.\r\n\r\n` +
      `Ready to try the real thing?\r\n` +
      `  ${fg(36)}→${RESET} Download MouseTerm: ${BOLD}mouseterm.com/#download${RESET}\r\n` +
      `Or keep exploring — this sandbox is yours.\r\n\r\n`
    );
  }

  // --- Progress tracking ---

  isStepComplete(stepIndex: number): boolean {
    return localStorage.getItem(`${STORAGE_PREFIX}${stepIndex + 1}`) === 'true';
  }

  markStepComplete(stepIndex: number): void {
    if (this.isStepComplete(stepIndex)) return;
    localStorage.setItem(`${STORAGE_PREFIX}${stepIndex + 1}`, 'true');
    this.announceCompletion(stepIndex);
  }

  private getNextIncompleteStep(): number | null {
    for (let i = 0; i < TOTAL_STEPS; i++) {
      if (!this.isStepComplete(i)) return i;
    }
    return null;
  }

  private announceCompletion(stepIndex: number): void {
    const step = STEPS[stepIndex];
    const stepNum = stepIndex + 1;

    this.sendOutput(
      `\r\n${fg(32)}✓ Step ${stepNum}/${TOTAL_STEPS}: ${step.title}${RESET}\r\n`
    );

    const nextStep = this.getNextIncompleteStep();
    if (nextStep === null) {
      this.showCompletion();
    } else {
      const next = STEPS[nextStep];
      this.sendOutput(
        `\r\n${DIM}Next — ${next.title}${RESET}\r\n` +
        `${next.description}\r\n` +
        `${DIM}${next.hint}${RESET}\r\n`
      );
    }
    this.sendOutput('\r\n' + PROMPT);
  }
}
