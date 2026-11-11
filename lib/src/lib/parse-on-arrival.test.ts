// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { ImageAddon } from '@xterm/addon-image';

/**
 * `parseOnArrival` on the real xterm: output parses while xterm's timers do
 * not run, and only then.
 */

const slices = vi.hoisted(() => ({ count: 0 }));
vi.mock('./xterm-write-slice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./xterm-write-slice')>();
  return {
    xtermWriteSlice: (terminal: Terminal) => {
      const slice = actual.xtermWriteSlice(terminal);
      return slice && (() => { slices.count++; slice(); });
    },
  };
});

import { PARSE_STARVED_MS, parseOnArrival } from './parse-on-arrival';
import { setHostShown } from './host-shown';

/** A 1x1 PNG, for an iTerm2 inline image the real image addon decodes. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const inlineImage = `\x1b]1337;File=inline=1;size=${atob(PNG).length}:${PNG}\x07`;

let terminal: Terminal;
let hidden: boolean;
/** Chars whose write callback has run. */
let acked: number;
let write: (data: string, parsed?: () => void) => void;

/** Delivers `data` as the PTY does, acknowledging it once parsed, and lets the
 *  microtasks its arrival queued run, as a message event's do. */
async function arrive(data: string): Promise<void> {
  write(data, () => { acked += data.length; });
  await Promise.resolve();
}

/** Runs every microtask queued so far, and those they queue. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const screen = () => Array.from({ length: terminal.buffer.active.length }, (_, i) =>
  terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');

beforeEach(() => {
  // Timers never fire unless a test runs them; Date only moves when set.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  slices.count = 0;
  acked = 0;
  terminal = new Terminal({ cols: 80, rows: 10, scrollback: 1000, allowProposedApi: true });
  write = parseOnArrival(terminal);
});

afterEach(() => {
  setHostShown(true);
  terminal.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('a hidden page', () => {
  it('parses and acknowledges a stream though no timer ever fires', async () => {
    hidden = true;
    let sent = 0;
    for (let i = 0; i < 200; i++) {
      const line = `line ${i}\r\n`;
      sent += line.length;
      await arrive(line);
    }
    expect(acked).toBe(sent);
    expect(slices.count).toBe(200);
    expect(screen()).toContain('line 199');
  });

  it('parses inline images in order, each async handler finishing before the next chunk', async () => {
    hidden = true;
    const error = vi.spyOn(console, 'error');
    // Each decode settles in a later task, as the browser's does, so arrivals
    // meet a paused parser.
    const createImageBitmap = vi.fn(() => new Promise((resolve) => setImmediate(() => resolve({ width: 1, height: 1, close() {} }))));
    vi.stubGlobal('createImageBitmap', createImageBitmap);
    terminal.loadAddon(new ImageAddon());

    let sent = 0;
    for (let i = 0; i < 80; i++) {
      const chunk = `image ${i}${inlineImage}\r\n`;
      sent += chunk.length;
      await arrive(chunk);
    }
    for (let i = 0; i < 200 && acked < sent; i++) await settle();

    expect(createImageBitmap).toHaveBeenCalledTimes(80);
    expect(acked).toBe(sent);
    expect(screen()).toContain('image 79');
    expect(error).not.toHaveBeenCalled();
  });
});

describe('a visible page', () => {
  it('parses and acknowledges a stream while its host says it is not shown', async () => {
    setHostShown(false);
    let sent = 0;
    for (let i = 0; i < 50; i++) {
      const line = `line ${i}\r\n`;
      sent += line.length;
      await arrive(line);
    }
    expect(acked).toBe(sent);
    expect(screen()).toContain('line 49');
  });

  it('takes over from starved timers, and hands back once the queue empties', async () => {
    // One chunk per slice, so the takeover is seen to last.
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 20));
    const start = Date.now();

    await arrive('a');
    vi.setSystemTime(start + PARSE_STARVED_MS - 1);
    await arrive('b');
    expect(slices.count).toBe(0);
    expect(acked).toBe(0);

    vi.setSystemTime(start + PARSE_STARVED_MS);
    await arrive('c');
    expect(slices.count).toBe(1);
    expect(acked).toBe(1);

    // A write just finished, but the timers are still starved: arrivals keep parsing.
    await arrive('d');
    expect(slices.count).toBe(2);
    expect(acked).toBe(2);

    // The timers recover and empty the queue.
    for (let i = 0; i < 10 && acked < 4; i++) vi.runOnlyPendingTimers();
    expect(acked).toBe(4);

    await arrive('e');
    expect(slices.count).toBe(2);
    vi.runOnlyPendingTimers();
    expect(acked).toBe(5);
    expect(screen()).toContain('abcde');
  });

  it('never parses on arrival while its timers keep up', async () => {
    vi.useRealTimers();
    const done = new Promise<void>((resolve) => {
      for (let i = 0; i < 50; i++) write(`line ${i}\r\n`, i === 49 ? resolve : undefined);
    });
    await done;
    expect(screen()).toContain('line 49');
    expect(slices.count).toBe(0);
  });
});

it('parses on timers alone when xterm lacks the members', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  terminal.dispose();
  terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  delete (terminal as unknown as { _core: { _inputHandler: { _parseStack: { paused?: boolean } } } })._core._inputHandler._parseStack.paused;
  write = parseOnArrival(terminal);
  hidden = true;

  await arrive('waiting');
  await settle();
  expect(acked).toBe(0);
  vi.runOnlyPendingTimers();
  expect(acked).toBe(7);
});
