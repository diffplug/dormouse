/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { xtermVtExtensions } from './terminal-lifecycle';
import { inputIsReplayTerminalReport } from './terminal-report-filter';

/**
 * The advertised iTerm2 version promises dark-mode reporting
 * (`docs/specs/terminal-escapes.md` -> iTerm2 identity). A real xterm.js with
 * Dormouse's extensions answers the query, and the answer is a terminal reply
 * on the input side, never a keystroke.
 */
async function colorSchemeReply(theme: { background: string; foreground: string }): Promise<string[]> {
  const terminal = new Terminal({ allowProposedApi: true, theme, vtExtensions: xtermVtExtensions() });
  // xterm.js answers from its theme service, which exists only once opened.
  terminal.open(document.body.appendChild(document.createElement('div')));
  const replies: string[] = [];
  terminal.onData((data) => replies.push(data));
  await new Promise<void>((resolve) => terminal.write('\x1b[?996n', resolve));
  terminal.dispose();
  return replies;
}

describe('color-scheme query (DSR 996)', () => {
  // `open()` needs a media query and a 2D canvas, which jsdom lacks.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    const context = new Proxy({}, { get: (_target, key) => (key === 'measureText' ? () => ({ width: 8 }) : () => {}) });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as CanvasRenderingContext2D);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['dark', { background: '#1e1e1e', foreground: '#d4d4d4' }, '\x1b[?997;1n'],
    ['light', { background: '#ffffff', foreground: '#333333' }, '\x1b[?997;2n'],
  ] as const)('answers a %s theme with a reply the input filter treats as a terminal report', async (_scheme, theme, expected) => {
    const replies = await colorSchemeReply(theme);
    expect(replies).toEqual([expected]);
    expect(inputIsReplayTerminalReport(expected)).toBe(true);
  });
});
