import { ESC, RESET } from './ansi';
import type { TerminalEntry } from './terminal-store';

export function inputContainsEnter(data: string): boolean {
  return data.includes('\r');
}

const REPORT_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/;
const REPORT_SS3 = /\x1bO[@-~]/;
const REPORT_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/;
const REPORT_APC = /\x1b_[\s\S]*?\x1b\\/;
// Each classifier needs a tokenizer and a validator over the same alternation;
// building both from one list keeps them from drifting as families are added.
const tokenizer = (...parts: RegExp[]) => new RegExp(`${parts.map((p) => p.source).join('|')}|.`, 'gs');
const validator = (...parts: RegExp[]) => new RegExp(`^(?:${parts.map((p) => p.source).join('|')})$`);
const REPORT_PARTS = [REPORT_CSI, REPORT_SS3, REPORT_OSC, REPORT_APC];
const REPORT_TOKENS = tokenizer(...REPORT_PARTS);
const REPORT_VALIDATE = validator(...REPORT_PARTS);
const REPLAY_REPORT_CSI = /\x1b\[(?:\??\d+(?:;\d+)*[Rn]|[?>=]?\d*(?:;\d+)*c|\d+(?:;\d+)*[tx]|\??\d+(?:;\d+)*\$y|\?\d+(?:;\d+)*S)/;
const REPLAY_REPORT_FOCUS = /\x1b\[[IO]/;
const REPORT_DCS = /\x1bP[\s\S]*?\x1b\\/;
const REPLAY_REPORT_PARTS = [REPLAY_REPORT_CSI, REPLAY_REPORT_FOCUS, REPORT_OSC, REPORT_DCS, REPORT_APC];
const REPLAY_REPORT_TOKENS = tokenizer(...REPLAY_REPORT_PARTS);
const REPLAY_REPORT_VALIDATE = validator(...REPLAY_REPORT_PARTS);
const MOUSE_REPORT_X10 = /\x1b\[M[\s\S]{3}/;
const MOUSE_REPORT_SGR = /\x1b\[<\d+;\d+;\d+[mM]/;
const MOUSE_REPORT_URXVT = /\x1b\[\d+;\d+;\d+M/;
const MOUSE_REPORT_TOKENS = new RegExp(`${MOUSE_REPORT_X10.source}|${MOUSE_REPORT_SGR.source}|${MOUSE_REPORT_URXVT.source}`, 'g');

export function inputIsSyntheticTerminalReport(data: string): boolean {
  if (data.length === 0) return false;
  const chunks = data.match(REPORT_TOKENS) ?? [];
  if (chunks.length === 0) return false;
  return chunks.every((chunk) => REPORT_VALIDATE.test(chunk));
}

export function inputIsReplayTerminalReport(data: string): boolean {
  if (data.length === 0) return false;
  const chunks = data.match(REPLAY_REPORT_TOKENS) ?? [];
  if (chunks.length === 0) return false;
  return chunks.every((chunk) => REPLAY_REPORT_VALIDATE.test(chunk));
}

export function stripMouseReportsFromInput(data: string): string {
  return data.replace(MOUSE_REPORT_TOKENS, '');
}

// Baseline for a dead replay only; a live process still owns its modes. The
// mouse-encoding resets are parser-only (`terminal.modes` does not expose them).
// See docs/specs/terminal-escapes.md §Replay-time mode-reset tail.
export const REPLAY_MODE_RESET =
  `${ESC}?1049l${ESC}?47l${ESC}?1047l` + // exit alt-screen (current + legacy variants)
  `${ESC}?9l${ESC}?1000l${ESC}?1002l${ESC}?1003l` + // disable mouse tracking
  `${ESC}?1005l${ESC}?1006l${ESC}?1015l` + // disable mouse encodings (utf8/SGR/urxvt)
  `${ESC}?1004l` + // focus reporting off
  `${ESC}?2004l` + // bracketed paste off (the new shell re-enables it at its prompt)
  `${ESC}?25h` + // show cursor
  `${ESC}?1l` + // application cursor keys off
  RESET; // SGR reset

export function writeReplay(entry: TerminalEntry, ...chunks: string[]): void {
  if (chunks.length === 0) return;
  entry.isReplaying = true;
  for (let i = 0; i < chunks.length - 1; i++) {
    entry.terminal.write(chunks[i]);
  }
  entry.terminal.write(chunks[chunks.length - 1], () => {
    entry.isReplaying = false;
  });
}
