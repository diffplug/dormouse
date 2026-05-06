import {
  BOLD,
  CLEAR_SCREEN,
  CURSOR_HOME,
  DIM,
  ENTER_ALT_SCREEN,
  FG_DEFAULT,
  LEAVE_ALT_SCREEN,
  MOUSE_DISABLE,
  MOUSE_ENABLE,
  RESET,
  fg,
} from "mouseterm-lib/lib/ansi";
import type { FakePtyAdapter } from "mouseterm-lib/lib/platform/fake-adapter";
import type { InteractiveProgram } from "./tutorial-shell";
import changelogData from "../data/changelog.json";

const LIST_WIDTH = 12;
const SEPARATOR = "│";
const HEADER_ROWS = 2; // title + blank
const FOOTER_ROWS = 1; // hint line

// SGR mouse button codes for wheel events.
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;

interface Item {
  text: string;
  children: Item[];
}

interface Section {
  title: string;
  items: Item[];
}

interface Release {
  version: string;
  tag: string;
  date: string;
  sections: Section[];
}

const RELEASES = (changelogData as { releases: Release[] }).releases;

function stripLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function wrap(text: string, width: number): string[] {
  if (width <= 1) return [text];
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
}

interface ChangelogRunnerOptions {
  adapter: FakePtyAdapter;
  terminalId: string;
  onExit: () => void;
}

export class ChangelogRunner implements InteractiveProgram {
  private adapter: FakePtyAdapter;
  private terminalId: string;
  private onExit: () => void;
  private selectedIndex = 0;
  private listOffset = 0;
  private detailOffset = 0;
  private hoverIndex: number | null = null;
  private lastMousePos: { col: number; row: number } | null = null;
  private resizeUnsub: (() => void) | null = null;
  private disposed = false;
  private detailCache: { index: number; width: number; lines: string[] } | null = null;
  private lastSize = { cols: 0, rows: 0 };

  constructor(options: ChangelogRunnerOptions) {
    this.adapter = options.adapter;
    this.terminalId = options.terminalId;
    this.onExit = options.onExit;
  }

  start(): void {
    this.write(ENTER_ALT_SCREEN);
    this.write(MOUSE_ENABLE);
    this.resizeUnsub = this.adapter.onPtyResize((d) => {
      if (d.id !== this.terminalId) return;
      const { cols, rows } = this.size;
      if (cols === this.lastSize.cols && rows === this.lastSize.rows) return;
      this.render();
    });
    this.render();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === "\x03") { this.exit(); return; }
      if (ch === "\x1b") {
        const tail = data.slice(i);
        const mouse = tail.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
        if (mouse) {
          this.handleMouse(Number(mouse[1]), Number(mouse[2]) - 1, Number(mouse[3]) - 1, mouse[4]);
          i += mouse[0].length;
          continue;
        }
        const csi = tail.match(/^\x1b\[(\d*)([A-Z~])/);
        if (csi) {
          this.handleCsi(csi[1], csi[2]);
          i += csi[0].length;
          continue;
        }
        // Bare Escape — exit.
        this.exit();
        return;
      }
      if (ch === "q" || ch === "Q") { this.exit(); return; }
      if (ch === "j") this.moveSelection(1);
      else if (ch === "k") this.moveSelection(-1);
      else if (ch === "g") this.jumpFirst();
      else if (ch === "G") this.jumpLast();
      i++;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeUnsub?.();
    this.resizeUnsub = null;
    this.write(MOUSE_DISABLE);
    this.write(LEAVE_ALT_SCREEN);
  }

  // --- input ---

  private exit(): void {
    if (this.disposed) return;
    this.dispose();
    this.onExit();
  }

  private handleCsi(num: string, code: string): void {
    if (code === "A") this.moveSelection(-1);
    else if (code === "B") this.moveSelection(1);
    else if (code === "H") this.jumpFirst();
    else if (code === "F") this.jumpLast();
    else if (code === "~" && num === "5") this.scrollDetail(-Math.max(1, this.bodyHeight() - 1));
    else if (code === "~" && num === "6") this.scrollDetail(Math.max(1, this.bodyHeight() - 1));
  }

  private handleMouse(button: number, col: number, row: number, finalByte: string): void {
    this.lastMousePos = { col, row };
    // Wheel scroll routes to whichever column the cursor is over so each
    // side scrolls independently.
    if (button === WHEEL_UP) {
      if (col < LIST_WIDTH) this.scrollList(-1);
      else this.scrollDetail(-1);
      return;
    }
    if (button === WHEEL_DOWN) {
      if (col < LIST_WIDTH) this.scrollList(1);
      else this.scrollDetail(1);
      return;
    }
    // Motion (no button held). 1003h reports these as button code 35:
    // bit 5 (motion) | code 3 (no button). Highlight the list row under
    // the cursor so the user can see where a click would land.
    if (button === 35 && finalByte === "M") {
      if (this.listIndexAt(col, row) !== this.hoverIndex) this.render();
      return;
    }
    // Left-button press on the version list selects that release.
    if (button === 0 && finalByte === "M") {
      const idx = this.listIndexAt(col, row);
      if (idx !== null) {
        this.selectedIndex = idx;
        this.detailOffset = 0;
        this.ensureSelectionVisible();
        this.render();
      }
    }
  }

  private listIndexAt(col: number, row: number): number | null {
    if (col >= LIST_WIDTH) return null;
    const r = row - HEADER_ROWS;
    if (r < 0 || r >= this.bodyHeight()) return null;
    const idx = this.listOffset + r;
    return idx >= 0 && idx < RELEASES.length ? idx : null;
  }

  private moveSelection(delta: number): void {
    const next = Math.max(0, Math.min(RELEASES.length - 1, this.selectedIndex + delta));
    if (next === this.selectedIndex) return;
    this.selectedIndex = next;
    this.detailOffset = 0;
    this.ensureSelectionVisible();
    this.render();
  }

  private jumpFirst(): void {
    this.selectedIndex = 0;
    this.detailOffset = 0;
    this.listOffset = 0;
    this.render();
  }

  private jumpLast(): void {
    this.selectedIndex = RELEASES.length - 1;
    this.detailOffset = 0;
    this.ensureSelectionVisible();
    this.render();
  }

  private ensureSelectionVisible(): void {
    const h = this.bodyHeight();
    if (this.selectedIndex < this.listOffset) this.listOffset = this.selectedIndex;
    else if (this.selectedIndex >= this.listOffset + h) this.listOffset = this.selectedIndex - h + 1;
    const maxOffset = Math.max(0, RELEASES.length - h);
    if (this.listOffset > maxOffset) this.listOffset = maxOffset;
  }

  private scrollList(delta: number): void {
    const max = Math.max(0, RELEASES.length - this.bodyHeight());
    const next = Math.max(0, Math.min(max, this.listOffset + delta));
    if (next === this.listOffset) return;
    this.listOffset = next;
    this.render();
  }

  private scrollDetail(delta: number): void {
    const lines = this.getDetailLines();
    const max = Math.max(0, lines.length - this.bodyHeight());
    const next = Math.max(0, Math.min(max, this.detailOffset + delta));
    if (next === this.detailOffset) return;
    this.detailOffset = next;
    this.render();
  }

  // --- layout ---

  private get size() { return this.adapter.getPtySize(this.terminalId); }

  private bodyHeight(): number {
    return Math.max(1, this.size.rows - HEADER_ROWS - FOOTER_ROWS);
  }

  private detailWidth(): number {
    return Math.max(10, this.size.cols - LIST_WIDTH - SEPARATOR.length);
  }

  private getDetailLines(): string[] {
    const w = this.detailWidth();
    const cached = this.detailCache;
    if (cached && cached.index === this.selectedIndex && cached.width === w) {
      return cached.lines;
    }
    const release = RELEASES[this.selectedIndex];
    const lines = release ? this.buildDetailLines(release, w) : ["No releases."];
    this.detailCache = { index: this.selectedIndex, width: w, lines };
    return lines;
  }

  private buildDetailLines(release: Release, w: number): string[] {
    const out: string[] = [];
    out.push(`${BOLD}${release.version}${RESET} ${DIM}— ${release.date}${RESET}`);
    out.push("");
    for (const section of release.sections) {
      out.push(`${fg(33)}${section.title}${FG_DEFAULT}`);
      for (const item of section.items) {
        const wrapped = wrap(stripLinks(item.text), Math.max(10, w - 4));
        wrapped.forEach((line, idx) => {
          out.push(`${idx === 0 ? "  • " : "    "}${line}`);
        });
      }
      out.push("");
    }
    return out;
  }

  // --- render ---

  private render(): void {
    if (this.disposed) return;
    this.lastSize = { ...this.size };
    // Re-sync hover from the cursor's last position so wheel-scrolls and
    // keyboard jumps move the highlight to whatever release is now under
    // the mouse.
    this.hoverIndex = this.lastMousePos
      ? this.listIndexAt(this.lastMousePos.col, this.lastMousePos.row)
      : null;
    const bodyH = this.bodyHeight();
    const detailLines = this.getDetailLines();

    let frame = `${CURSOR_HOME}${CLEAR_SCREEN}`;
    frame += `${BOLD}MouseTerm changelog${RESET}  ${DIM}${RELEASES.length} releases · \`q\` to quit · ↑↓ select · wheel scrolls${RESET}\r\n`;
    frame += "\r\n";

    for (let r = 0; r < bodyH; r++) {
      const idx = this.listOffset + r;
      const release = RELEASES[idx];
      let leftCell: string;
      if (release) {
        const label = `v${release.version}`;
        const padded = label.length > LIST_WIDTH - 2 ? label.slice(0, LIST_WIDTH - 2) : label.padEnd(LIST_WIDTH - 2);
        if (idx === this.selectedIndex) {
          leftCell = `${fg(36)}❯${RESET} ${BOLD}${padded}${RESET}`;
        } else if (idx === this.hoverIndex) {
          leftCell = `${fg(36)}›${RESET} ${padded}`;
        } else {
          leftCell = `  ${padded}`;
        }
      } else {
        leftCell = " ".repeat(LIST_WIDTH);
      }
      const detailLine = detailLines[this.detailOffset + r] ?? "";
      frame += `${leftCell}${DIM}${SEPARATOR}${RESET}${detailLine}\r\n`;
    }

    const more = this.detailOffset + bodyH < detailLines.length ? "↓ more" : "";
    frame += `${DIM}${more}${RESET}`;
    this.write(frame);
  }

  private write(data: string): void {
    this.adapter.sendOutput(this.terminalId, data);
  }
}
