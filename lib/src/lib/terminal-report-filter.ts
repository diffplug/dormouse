import type { TerminalEntry } from './terminal-store';

export function inputContainsEnter(data: string): boolean {
  return data.includes('\r');
}

const REPORT_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/;
const REPORT_SS3 = /\x1bO[@-~]/;
const REPORT_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/;
const REPORT_TOKENS = new RegExp(`${REPORT_CSI.source}|${REPORT_SS3.source}|${REPORT_OSC.source}|.`, 'gs');
const REPORT_VALIDATE = new RegExp(`^(?:${REPORT_CSI.source}|${REPORT_SS3.source}|${REPORT_OSC.source})$`);
const REPLAY_REPORT_CSI = /\x1b\[(?:\??\d+(?:;\d+)*[Rn]|[?>=]?\d*(?:;\d+)*c|\d+(?:;\d+)*[tx]|\??\d+(?:;\d+)*\$y)/;
const REPLAY_REPORT_FOCUS = /\x1b\[[IO]/;
const REPORT_DCS = /\x1bP[\s\S]*?\x1b\\/;
const REPLAY_REPORT_TOKENS = new RegExp(`${REPLAY_REPORT_CSI.source}|${REPLAY_REPORT_FOCUS.source}|${REPORT_OSC.source}|${REPORT_DCS.source}|.`, 'gs');
const REPLAY_REPORT_VALIDATE = new RegExp(`^(?:${REPLAY_REPORT_CSI.source}|${REPLAY_REPORT_FOCUS.source}|${REPORT_OSC.source}|${REPORT_DCS.source})$`);
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
