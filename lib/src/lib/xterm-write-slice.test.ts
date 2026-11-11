// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { ImageAddon } from '@xterm/addon-image';
import { xtermWriteSlice } from './xterm-write-slice';

/**
 * Pins the private members `xtermWriteSlice` reaches for on the pinned xterm:
 * an xterm bump that renames or reshapes them fails here, not silently in a
 * hidden window.
 */

/** A 1x1 PNG, for an iTerm2 inline image the real image addon decodes. */
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const inlineImage = `\x1b]1337;File=inline=1;size=${atob(PNG).length}:${PNG}\x07`;

let terminal: Terminal;

beforeEach(() => {
  // xterm's timers never fire, and its 12 ms slice never runs out.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  // jsdom has no canvas; xterm and the image addon cope with none.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
});

afterEach(() => {
  terminal.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Runs every microtask queued so far, and those they queue. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const screen = () => Array.from({ length: terminal.buffer.active.length }, (_, i) =>
  terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('\n');

it('parses queued writes and calls their callbacks with no timer', () => {
  const slice = xtermWriteSlice(terminal);
  expect(slice).not.toBeNull();
  const parsed = vi.fn();
  terminal.write('hello', parsed);
  expect(parsed).not.toHaveBeenCalled();

  slice!();
  expect(parsed).toHaveBeenCalledTimes(1);
  expect(screen()).toContain('hello');

  // The timer xterm armed for the write finds nothing left to parse.
  slice!();
  vi.runOnlyPendingTimers();
  expect(parsed).toHaveBeenCalledTimes(1);
  expect(screen().match(/hello/g)).toHaveLength(1);
});

it('never resumes an async handler before it settles', async () => {
  let decoded: () => void = () => {};
  const createImageBitmap = vi.fn(() => new Promise((resolve) => {
    decoded = () => resolve({ width: 1, height: 1, close() {} });
  }));
  vi.stubGlobal('createImageBitmap', createImageBitmap);
  terminal.loadAddon(new ImageAddon());
  const error = vi.spyOn(console, 'error');
  const slice = xtermWriteSlice(terminal)!;
  const parsed = vi.fn();
  terminal.write(`before${inlineImage}after`, parsed);

  slice();
  expect(createImageBitmap).toHaveBeenCalledTimes(1);
  // The image's handler is still decoding: a slice now would continue past it.
  slice();
  slice();
  expect(screen()).toContain('before');
  expect(screen()).not.toContain('after');
  expect(parsed).not.toHaveBeenCalled();

  decoded();
  await settle();
  expect(parsed).toHaveBeenCalledTimes(1);
  expect(screen()).toContain('after');
  expect(error).not.toHaveBeenCalled();
});

it('falls back to timers, logging once, when a member is missing', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const missingLoop = { _core: { _inputHandler: { _parseStack: { paused: false } } } };
  const missingStack = { _core: { _writeBuffer: { _innerWrite: () => {} }, _inputHandler: {} } };
  expect(xtermWriteSlice(missingLoop as unknown as Terminal)).toBeNull();
  expect(xtermWriteSlice(missingStack as unknown as Terminal)).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
});
