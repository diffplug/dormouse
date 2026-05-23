import {
  BOLD,
  CLEAR_SCREEN,
  CURSOR_HOME,
  DIM,
  ENTER_ALT_SCREEN,
  FG_DEFAULT,
  ITALIC,
  LEAVE_ALT_SCREEN,
  RESET,
  fg,
} from "dormouse-lib/lib/ansi";
import { cfg } from "dormouse-lib/cfg";
import type { FakePtyAdapter } from "dormouse-lib/lib/platform/fake-adapter";
import type { InteractiveProgram } from "./tutorial-shell";
import {
  DESKTOP_TUTORIAL_PROFILE,
  type Item,
  type TutorialProfile,
} from "./tut-items";
import type { TutorialState } from "./tutorial-state";

/**
 * The fake busy task must outlast the user-attention idle window so that,
 * by the time the activity monitor's silence threshold fires, attention
 * has expired and the bell rings instead of being suppressed by the
 * "user is looking at this pane" check. The 250ms margin is a safety
 * guard against scheduler jitter — the exact value doesn't matter as
 * long as it's larger than realistic clock skew.
 */
export const BUSY_DEMO_DURATION_MS = cfg.alert.userAttention + 250;

/**
 * Interval between fake-busy ticks. Must stay safely below
 * cfg.alert.busyCandidateGap so consecutive onData calls register as
 * continuous activity rather than separate bursts. Half the gap gives
 * comfortable margin against scheduler jitter; deriving from cfg means
 * tuning the gap won't silently break the demo.
 */
export const BUSY_DEMO_INTERVAL_MS = Math.floor(cfg.alert.busyCandidateGap / 2);

// Replace `` `KEY` `` markers with a cyan span. Uses default-foreground
// (39m) to close the span so the highlight composes cleanly with
// surrounding bold/italic/dim — only the color is touched.
function highlightKeys(line: string): string {
  return line.replace(/`([^`]+)`/g, `${fg(36)}$1${FG_DEFAULT}`);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 100;

/**
 * Static "your turn" pointer for the active section item. Animating this
 * would feed the activity monitor on whichever pane the runner lives on,
 * so the bell on a pane that hosts the runner could never reach the
 * RINGING state — the activity-monitor only rings after a stretch of
 * silence. A static glyph keeps the pane quiet between user actions.
 */
const ACTIVE_ITEM_GLYPH = "●";
const STAR_PROMPT_TITLE = "Starred on GitHub";
const FLAPPY_LOCKED_TITLE = "🐭 ??? 🐭";
const FLAPPY_UNLOCKED_TITLE = "🐭 Flappy Term 🐭";

// --- Flappy Term game constants (ported from flappy-term.html) ---
const FLAPPY_TICK_MS = 60;
const FLAPPY_GRAVITY = 0.18;
const FLAPPY_FLAP_V = -1.1;
const FLAPPY_MAX_VY = 1.3;
const FLAPPY_PIPE_SPACING_MIN = 18;
const FLAPPY_PIPE_GAP = 8;
const FLAPPY_MAX_GAP_DELTA = 8;
const FLAPPY_PIPE_W = 4;
const FLAPPY_GROUND_H = 2;

const fg256 = (n: number) => `\x1b[38;5;${n}m`;
const bg256 = (n: number) => `\x1b[48;5;${n}m`;
const moveTo = (row: number, col: number) => `\x1b[${row};${col}H`;

const FLAPPY_COLORS = {
  bird: 226,
  birdO: 208,
  pipe: 34,
  pipeD: 22,
  ground: 94,
  grass: 40,
  text: 231,
  dim: 245,
  red: 196,
};

interface FlappyPipe {
  x: number;
  gapY: number;
  gapH: number;
  scored: boolean;
}

interface FlappyGameState {
  birdX: number;
  birdY: number;
  birdVY: number;
  pipes: FlappyPipe[];
  score: number;
  alive: boolean;
  started: boolean;
  frame: number;
  nextPipeIn: number;
}

interface TutRunnerOptions {
  adapter: FakePtyAdapter;
  terminalId: string;
  state: TutorialState;
  profile?: TutorialProfile;
  onExit: () => void;
  /** Called when the user presses `s` inside the Alert section. */
  onTriggerBusyDemo?: () => void;
  /** Called when the user presses `p` inside the Copy paste section. */
  onTogglePlaceToPaste?: () => void;
  /** Called when the user presses `Enter` on the GitHub star prompt. */
  onOpenGithub?: () => void;
  /** Called when the user presses `p` on the Flappy Term game-over screen. */
  onOpenPocket?: () => void;
}

type Screen = "menu" | "section" | "reset" | "flappy";

const RESET_CONFIRM_WORD = "reset";

export class TutRunner implements InteractiveProgram {
  private adapter: FakePtyAdapter;
  private terminalId: string;
  private state: TutorialState;
  private profile: TutorialProfile;
  private onExit: () => void;
  private onTriggerBusyDemo?: () => void;
  private onTogglePlaceToPaste?: () => void;
  private onOpenGithub?: () => void;
  private onOpenPocket?: () => void;

  private screen: Screen = "menu";
  private menuIndex = 0;
  private sectionId: string | null = null;
  private resetBuffer = "";
  private resetMismatch = false;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private flappyTimer: ReturnType<typeof setInterval> | null = null;
  private flappy: FlappyGameState | null = null;
  private stateUnsub: (() => void) | null = null;
  private resizeUnsub: (() => void) | null = null;
  private busyDemoStart: number | null = null;
  private disposed = false;

  constructor(options: TutRunnerOptions) {
    this.adapter = options.adapter;
    this.terminalId = options.terminalId;
    this.state = options.state;
    this.profile = options.profile ?? DESKTOP_TUTORIAL_PROFILE;
    this.onExit = options.onExit;
    this.onTriggerBusyDemo = options.onTriggerBusyDemo;
    this.onTogglePlaceToPaste = options.onTogglePlaceToPaste;
    this.onOpenGithub = options.onOpenGithub;
    this.onOpenPocket = options.onOpenPocket;
    if (this.profile.initialSectionId) {
      this.sectionId = this.profile.initialSectionId;
      this.screen = "section";
    }
  }

  start(): void {
    this.write(ENTER_ALT_SCREEN);
    this.stateUnsub = this.state.subscribe(() => this.render());
    this.resizeUnsub = this.adapter.onPtyResize((d) => {
      if (d.id === this.terminalId) this.render();
    });
    this.render();
  }

  private startSpinnerTicks(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      this.render();
      if (
        this.busyDemoStart === null ||
        Date.now() - this.busyDemoStart >= BUSY_DEMO_DURATION_MS
      ) {
        this.stopSpinnerTicks();
      }
    }, SPINNER_INTERVAL_MS);
  }

  private stopSpinnerTicks(): void {
    if (!this.spinnerTimer) return;
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  private startFlappyTicks(): void {
    if (this.flappyTimer) return;
    this.flappyTimer = setInterval(() => {
      this.stepFlappy();
      this.render();
    }, FLAPPY_TICK_MS);
  }

  private stopFlappyTicks(): void {
    if (!this.flappyTimer) return;
    clearInterval(this.flappyTimer);
    this.flappyTimer = null;
  }

  private resetFlappyGame(): void {
    const { cols, rows } = this.adapter.getPtySize(this.terminalId);
    const playH = Math.max(6, rows - FLAPPY_GROUND_H);
    this.flappy = {
      birdX: Math.max(2, Math.floor(cols * 0.25)),
      birdY: Math.floor(playH / 2),
      birdVY: 0,
      pipes: [],
      score: 0,
      alive: true,
      started: false,
      frame: 0,
      nextPipeIn: 10,
    };
  }

  private flap(): void {
    const g = this.flappy;
    if (!g || !g.alive) return;
    g.started = true;
    g.birdVY = FLAPPY_FLAP_V;
  }

  private spawnFlappyPipe(cols: number, playH: number): void {
    const g = this.flappy;
    if (!g) return;
    const minGapY = 3;
    const maxGapY = playH - FLAPPY_PIPE_GAP - 3;
    let lo = minGapY;
    let hi = maxGapY;
    const last = g.pipes[g.pipes.length - 1];
    if (last) {
      lo = Math.max(lo, last.gapY - FLAPPY_MAX_GAP_DELTA);
      hi = Math.min(hi, last.gapY + FLAPPY_MAX_GAP_DELTA);
    }
    if (hi < lo) hi = lo;
    const gapY = Math.floor(lo + Math.random() * (hi - lo + 1));
    g.pipes.push({
      x: cols + 1,
      gapY,
      gapH: FLAPPY_PIPE_GAP,
      scored: false,
    });
  }

  private stepFlappy(): void {
    const g = this.flappy;
    if (!g || !g.alive) return;
    const { cols, rows } = this.adapter.getPtySize(this.terminalId);
    const playH = Math.max(6, rows - FLAPPY_GROUND_H);

    g.frame++;
    if (!g.started) return;

    g.birdVY += FLAPPY_GRAVITY;
    if (g.birdVY > FLAPPY_MAX_VY) g.birdVY = FLAPPY_MAX_VY;
    g.birdY += g.birdVY;

    for (const p of g.pipes) p.x -= 1;
    g.pipes = g.pipes.filter((p) => p.x + FLAPPY_PIPE_W > 0);

    g.nextPipeIn--;
    if (g.nextPipeIn <= 0) {
      this.spawnFlappyPipe(cols, playH);
      g.nextPipeIn = FLAPPY_PIPE_SPACING_MIN;
    }

    const bx = Math.round(g.birdX);
    for (const p of g.pipes) {
      if (!p.scored && p.x + FLAPPY_PIPE_W - 1 < bx) {
        p.scored = true;
        g.score++;
        this.state.recordFlappyScore(g.score);
      }
    }

    const by = Math.round(g.birdY);
    if (by >= playH) {
      g.birdY = playH - 1;
      g.alive = false;
    } else if (by < 0) {
      // Bonk the ceiling but don't die — feels better than instant death.
      g.birdY = 0;
      g.birdVY = 0.2;
    }

    for (const p of g.pipes) {
      if (bx >= p.x && bx < p.x + FLAPPY_PIPE_W) {
        if (by < p.gapY || by >= p.gapY + p.gapH) {
          g.alive = false;
        }
      }
    }
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
      if (this.screen === "reset") {
        if (ch === "\x7f" || ch === "\b") {
          if (this.resetBuffer.length > 0) {
            this.resetBuffer = this.resetBuffer.slice(0, -1);
            this.resetMismatch = false;
            this.render();
          }
        } else if (ch >= " " && this.resetBuffer.length < 32) {
          this.resetBuffer += ch;
          this.resetMismatch = false;
          this.render();
        }
        i += 1;
        continue;
      }
      if (this.screen === "flappy" && ch === " ") {
        this.flap();
        i += 1;
        continue;
      }
      if (
        this.screen === "flappy" &&
        this.flappy &&
        !this.flappy.alive &&
        (ch === "p" || ch === "P")
      ) {
        this.onOpenPocket?.();
        i += 1;
        continue;
      }
      if (ch === "q" || ch === "Q") {
        this.handleEscape();
        return;
      }
      if (
        this.screen === "section" &&
        this.sectionId === "alert" &&
        (ch === "s" || ch === "S")
      ) {
        // Ignore presses while the demo is still running — otherwise each
        // press starts a fresh pumpActivity interval that stacks on top of
        // the previous one until they all expire.
        if (!this.busyDemoInProgress()) this.startBusyDemo();
        i += 1;
        continue;
      }
      if (
        this.screen === "section" &&
        this.sectionId === "copy" &&
        (ch === "p" || ch === "P")
      ) {
        this.onTogglePlaceToPaste?.();
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

  private menuLength(): number {
    // Sections + GitHub star + Flappy Term + the trailing "Reset progress" entry
    return this.profile.sections.length + 3;
  }

  private starPromptIndex(): number {
    return this.profile.sections.length;
  }

  private flappyIndex(): number {
    return this.profile.sections.length + 1;
  }

  private resetIndex(): number {
    return this.profile.sections.length + 2;
  }

  private handleArrow(letter: string): void {
    if (this.screen === "flappy") {
      if (letter === "A") this.flap();
      return;
    }
    if (this.screen !== "menu") return;
    const len = this.menuLength();
    if (letter === "A") {
      this.menuIndex = (this.menuIndex - 1 + len) % len;
    } else if (letter === "B") {
      this.menuIndex = (this.menuIndex + 1) % len;
    } else {
      return;
    }
    this.render();
  }

  private handleEnter(): void {
    if (this.screen === "flappy") {
      if (this.flappy && !this.flappy.alive) {
        this.resetFlappyGame();
        this.render();
      } else {
        this.flap();
      }
      return;
    }
    if (this.screen === "menu") {
      if (this.menuIndex === this.resetIndex()) {
        this.screen = "reset";
        this.resetBuffer = "";
        this.resetMismatch = false;
        this.render();
        return;
      }
      if (this.menuIndex === this.starPromptIndex()) {
        const changed = this.state.resolveStarPrompt();
        this.onOpenGithub?.();
        if (!changed) this.render();
        return;
      }
      if (this.menuIndex === this.flappyIndex()) {
        const { done, total } = this.state.totalProgress();
        if (done !== total) {
          this.render();
          return;
        }
        this.screen = "flappy";
        this.resetFlappyGame();
        // One full clear when entering the game so leftover menu chrome
        // doesn't peek through the diff-style game frames (which only
        // CURSOR_HOME between ticks to avoid flicker).
        this.write(CLEAR_SCREEN + CURSOR_HOME);
        this.startFlappyTicks();
        this.render();
        return;
      }
      const section = this.profile.sections[this.menuIndex];
      if (!section) return;
      this.sectionId = section.id;
      this.screen = "section";
      // Resume the spinner if we're entering Alert while a demo started
      // earlier is still running. Otherwise the countdown line would
      // render with a frozen spinner glyph (timer was stopped on Esc out).
      if (section.id === "alert" && this.busyDemoInProgress()) {
        this.startSpinnerTicks();
      }
      this.render();
      return;
    }
    if (this.screen === "reset") {
      if (this.resetBuffer.trim().toLowerCase() === RESET_CONFIRM_WORD) {
        this.state.reset();
        this.resetBuffer = "";
        this.resetMismatch = false;
        this.screen = "menu";
        this.render();
      } else {
        this.resetBuffer = "";
        this.resetMismatch = true;
        this.render();
      }
    }
  }

  private handleEscape(): void {
    if (this.screen === "section") {
      // The spinner only animates the Alert section's "fake task running"
      // line, so it has nothing to draw outside that section — stop it
      // here rather than letting it re-render the menu every 100ms until
      // the demo's natural duration elapses.
      this.stopSpinnerTicks();
      this.sectionId = null;
      this.screen = "menu";
      this.render();
      return;
    }
    if (this.screen === "reset") {
      this.resetBuffer = "";
      this.resetMismatch = false;
      this.screen = "menu";
      this.render();
      return;
    }
    if (this.screen === "flappy") {
      this.stopFlappyTicks();
      this.flappy = null;
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

  private busyDemoInProgress(): boolean {
    if (this.busyDemoStart === null) return false;
    return Date.now() - this.busyDemoStart < BUSY_DEMO_DURATION_MS;
  }

  private startBusyDemo(): void {
    this.busyDemoStart = Date.now();
    this.onTriggerBusyDemo?.();
    this.startSpinnerTicks();
    this.render();
  }

  // --- Render ---

  private render(): void {
    if (this.disposed) return;
    if (this.screen === "flappy") {
      this.renderFlappy();
      return;
    }
    const lines =
      this.screen === "menu"
        ? this.renderMenu()
        : this.screen === "reset"
        ? this.renderReset()
        : this.renderSection();
    let out = `${CURSOR_HOME}${CLEAR_SCREEN}`;
    for (const line of lines) {
      out += `${highlightKeys(line)}\r\n`;
    }
    this.write(out);
  }

  private renderMenu(): string[] {
    const total = this.state.totalProgress();
    const lines: string[] = [];
    lines.push("");
    lines.push(`  ${BOLD}${this.profile.title}${RESET}`);
    lines.push(
      `  ${DIM}\`Esc\`/\`q\` to exit · \`Enter\` to open · \`↑↓\` to navigate${RESET}`,
    );
    lines.push("");
    this.profile.sections.forEach((section, index) => {
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

    const starIndex = this.starPromptIndex();
    const starResolved = this.state.isStarPromptResolved();
    const starMarker = this.menuIndex === starIndex ? `${fg(36)}❯${RESET}` : " ";
    const starLabel =
      this.menuIndex === starIndex
        ? `${BOLD}${STAR_PROMPT_TITLE}${RESET}`
        : STAR_PROMPT_TITLE;
    const starStatus = starResolved
      ? `${fg(32)}[thanks ⭐]${RESET}`
      : `${DIM}[not yet]${RESET}`;
    lines.push(`  ${starMarker} ${starLabel}  ${starStatus}`);

    const flappyIndex = this.flappyIndex();
    const flappyUnlocked = total.done === total.total;
    const flappyMarker = this.menuIndex === flappyIndex ? `${fg(36)}❯${RESET}` : " ";
    const flappyTitle = flappyUnlocked ? FLAPPY_UNLOCKED_TITLE : FLAPPY_LOCKED_TITLE;
    const flappyLabel =
      this.menuIndex === flappyIndex
        ? `${BOLD}${flappyTitle}${RESET}`
        : flappyTitle;
    const flappyStatus = flappyUnlocked
      ? `  ${fg(32)}[High score: ${this.state.getFlappyHighScore()}]${RESET}`
      : `  ${DIM}[LOCKED ${total.done}/${total.total}]${RESET}`;
    lines.push(`  ${flappyMarker} ${flappyLabel}${flappyStatus}`);

    const resetIndex = this.resetIndex();
    const resetMarker = this.menuIndex === resetIndex ? `${fg(36)}❯${RESET}` : " ";
    const resetLabel =
      this.menuIndex === resetIndex
        ? `${BOLD}Reset progress${RESET}`
        : `${DIM}Reset progress${RESET}`;
    lines.push("");
    lines.push(`  ${resetMarker} ${resetLabel}`);
    lines.push("");
    return lines;
  }

  private renderFlappy(): void {
    const g = this.flappy;
    if (!g) return;
    const { cols, rows } = this.adapter.getPtySize(this.terminalId);
    const COLS = cols;
    const ROWS = rows;
    const playH = Math.max(6, ROWS - FLAPPY_GROUND_H);
    const C = FLAPPY_COLORS;

    // Use CURSOR_HOME (no CLEAR_SCREEN) per-frame to avoid the blank
    // flash xterm would otherwise paint between frames; the full grid
    // overwrites every cell so leftover content can't show through.
    let out = CURSOR_HOME;

    for (let r = 0; r < ROWS; r++) {
      let row = "";
      let currentColor = "";
      const setColor = (color: string) => {
        if (color !== currentColor) {
          row += color;
          currentColor = color;
        }
      };

      for (let c = 0; c < COLS; c++) {
        // Ground area
        if (r >= playH) {
          if (r === playH) {
            setColor(RESET + fg256(C.grass));
            row += "^";
          } else {
            setColor(RESET + fg256(C.ground));
            row += "~";
          }
          continue;
        }

        // Pipes
        let drewPipe = false;
        for (const p of g.pipes) {
          if (c >= p.x && c < p.x + FLAPPY_PIPE_W) {
            const inGap = r >= p.gapY && r < p.gapY + p.gapH;
            if (!inGap) {
              const isEdge = c === p.x || c === p.x + FLAPPY_PIPE_W - 1;
              const isCapTop = r === p.gapY - 1;
              const isCapBot = r === p.gapY + p.gapH;
              if (isCapTop || isCapBot) {
                setColor(fg256(C.pipeD) + bg256(C.pipe));
                row += "=";
              } else if (isEdge) {
                setColor(fg256(C.pipeD) + bg256(C.pipe));
                row += "|";
              } else {
                setColor(bg256(C.pipe) + fg256(C.pipeD));
                row += " ";
              }
              drewPipe = true;
              break;
            }
          }
        }
        if (drewPipe) continue;

        // Bird
        const bx = Math.round(g.birdX);
        const by = Math.round(g.birdY);
        if (r === by && c === bx) {
          setColor(RESET + fg256(C.bird) + BOLD);
          let glyph = ">";
          if (g.birdVY < -0.3) glyph = "^";
          else if (g.birdVY > 0.4) glyph = "v";
          row += glyph;
          continue;
        }
        if (r === by && c === bx + 1) {
          setColor(RESET + fg256(C.birdO) + BOLD);
          row += ">";
          continue;
        }

        setColor(RESET);
        row += " ";
      }

      out += row + RESET;
      if (r < ROWS - 1) out += "\r\n";
    }

    // Overlays (absolute-positioned over the grid)
    const scoreStr = `Score: ${g.score}`;
    const bestStr = `Best: ${this.state.getFlappyHighScore()}`;
    out += moveTo(1, 2) + RESET + fg256(C.text) + BOLD + scoreStr + RESET;
    out += moveTo(1, Math.max(2, COLS - bestStr.length - 1)) + fg256(C.dim) + bestStr + RESET;

    if (!g.alive) {
      const r = Math.max(1, Math.floor(ROWS / 2) - 3);
      out += this.flappyCenteredAt(COLS, r,     "+--------------------+", fg256(C.red) + BOLD);
      out += this.flappyCenteredAt(COLS, r + 1, "|     GAME OVER      |", fg256(C.red) + BOLD);
      out += this.flappyCenteredAt(COLS, r + 2, "+--------------------+", fg256(C.red) + BOLD);
      out += this.flappyCenteredAt(
        COLS,
        r + 4,
        `Score: ${g.score}   Best: ${this.state.getFlappyHighScore()}`,
        fg256(C.text),
      );
      out += this.flappyCenteredAt(COLS, r + 6, "[ Enter to restart · Esc to exit ]", fg256(C.dim));
      out += this.flappyCenteredAt(
        COLS,
        r + 8,
        "Read about Dormouse Pocket  [p]",
        fg256(C.text),
      );
    } else if (!g.started) {
      const r = Math.min(ROWS, Math.floor(ROWS / 2) + 2);
      out += this.flappyCenteredAt(COLS, r, "[ Space / Up to flap · Esc to exit ]", fg256(C.dim));
    }

    this.write(out);
  }

  private flappyCenteredAt(cols: number, row: number, text: string, color: string): string {
    const c = Math.max(1, Math.floor((cols - text.length) / 2) + 1);
    return moveTo(row, c) + color + text + RESET;
  }

  private renderReset(): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push(`  ${BOLD}Reset progress${RESET}`);
    lines.push(`  ${DIM}\`Esc\` to cancel${RESET}`);
    lines.push("");
    lines.push(
      `  This will clear all checkmarks and the GitHub star prompt.`,
    );
    lines.push(
      `  ${DIM}Type \`reset\` and press \`Enter\` to confirm.${RESET}`,
    );
    lines.push("");
    lines.push(`   ${fg(36)}>${RESET} ${this.resetBuffer}${fg(33)}_${RESET}`);
    if (this.resetMismatch) {
      lines.push("");
      lines.push(`  ${fg(31)}That didn't match. Type "reset" exactly.${RESET}`);
    }
    return lines;
  }

  private renderSection(): string[] {
    const section = this.profile.sections.find((s) => s.id === this.sectionId);
    if (!section) {
      throw new Error(`renderSection: unknown sectionId ${this.sectionId}`);
    }
    const { done, total } = this.state.sectionProgress(section.id);
    const lines: string[] = [];
    lines.push("");
    lines.push(`  ${BOLD}${section.title}${RESET}  ${DIM}${done}/${total} complete${RESET}`);
    lines.push(`  ${DIM}\`Esc\` to go back${RESET}`);
    lines.push("");

    const activeIndex = section.items.findIndex((i) => !this.state.isComplete(i.id));
    section.items.forEach((item, index) => {
      lines.push(...this.renderItem(item, index, activeIndex));
    });

    if (section.id === "copy" && this.onTogglePlaceToPaste) {
      lines.push("");
      const indent = "  ";
      const text = "Press `p` to toggle the Place To Paste.";
      for (const wrapped of this.wrapText(text, indent.length)) {
        lines.push(`${indent}${DIM}${wrapped}${RESET}`);
      }
    }

    if (section.prose && section.prose.length > 0) {
      lines.push("");
      const indent = "  ";
      for (const p of section.prose) {
        for (const wrapped of this.wrapText(p, indent.length)) {
          lines.push(`${indent}${DIM}${wrapped}${RESET}`);
        }
      }
    }

    if (section.id === "alert") {
      lines.push("");
      lines.push(...this.renderBusyDemoLines());
    }

    if (done === total) {
      lines.push("");
      lines.push(
        `  ${fg(32)}Section complete.${RESET} ${DIM}Press \`Esc\` to go back.${RESET}`,
      );
    }

    return lines;
  }

  private renderBusyDemoLines(): string[] {
    const idleHint = `  ${DIM}Press \`s\` here to start a fake busy task.${RESET}`;
    if (this.busyDemoStart === null) return [idleHint];
    const elapsed = Date.now() - this.busyDemoStart;
    if (elapsed < BUSY_DEMO_DURATION_MS) {
      const spinner = SPINNER_FRAMES[this.spinnerFrame];
      const secsLeft = Math.max(1, Math.ceil((BUSY_DEMO_DURATION_MS - elapsed) / 1_000));
      return [
        `  ${fg(33)}${spinner}${RESET} Fake task will finish in ${BOLD}${secsLeft}${RESET} seconds.`,
      ];
    }
    return [
      `  ${fg(32)}✓${RESET} Fake task finished. ${DIM}Press \`s\` to start another one.${RESET}`,
    ];
  }

  private renderItem(item: Item, index: number, activeIndex: number): string[] {
    const complete = this.state.isComplete(item.id);
    const isActive = !complete && index === activeIndex;
    let mark: string;
    if (complete) {
      mark = `${fg(32)}✓${RESET}`;
    } else if (isActive) {
      mark = `${fg(33)}${ACTIVE_ITEM_GLYPH}${RESET}`;
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
      const indent = "        ";
      for (const wrapped of this.wrapText(item.hint, indent.length)) {
        lines.push(`${indent}${ITALIC}${wrapped}${RESET}`);
      }
    }
    return lines;
  }

  /**
   * Word-wrap text to fit the current pty width, leaving `indentCols`
   * columns for the leading indent the caller will prefix. Backtick
   * markers expand into zero-width ANSI at frame time via
   * `highlightKeys`, so they don't count against the visible width.
   */
  private wrapText(text: string, indentCols: number): string[] {
    const { cols } = this.adapter.getPtySize(this.terminalId);
    const max = Math.max(20, cols - indentCols);
    const visibleLen = (s: string) => {
      let n = 0;
      for (const ch of s) if (ch !== "`") n++;
      return n;
    };
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = "";
    let lineVis = 0;
    for (const word of words) {
      const wv = visibleLen(word);
      if (line === "") {
        line = word;
        lineVis = wv;
      } else if (lineVis + 1 + wv <= max) {
        line += " " + word;
        lineVis += 1 + wv;
      } else {
        lines.push(line);
        line = word;
        lineVis = wv;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  // --- Internals ---

  private cleanup(notifyExit: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopSpinnerTicks();
    this.stopFlappyTicks();
    this.flappy = null;
    this.busyDemoStart = null;
    this.stateUnsub?.();
    this.stateUnsub = null;
    this.resizeUnsub?.();
    this.resizeUnsub = null;
    this.write(LEAVE_ALT_SCREEN);
    if (notifyExit) this.onExit();
  }

  private write(data: string): void {
    // Runner frames are UI chrome, not task output — skip the activity
    // tick so enabling WATCHING on the runner pane doesn't tilt the bell
    // every time the menu re-renders.
    this.adapter.sendOutput(this.terminalId, data, { skipActivity: true });
  }
}
