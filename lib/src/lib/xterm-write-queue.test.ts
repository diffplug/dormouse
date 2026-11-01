// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';

/**
 * `flushTerminal` (terminal-lifecycle.ts) and the fake adapter's helper shell
 * rely on `resize()` flushing xterm's write queue without losing or replaying
 * any of it. Builds before xtermjs/xterm.js#6201 did both.
 */

let terminal: Terminal;
afterEach(() => { vi.restoreAllMocks(); terminal?.dispose(); });

const text = () => Array.from({ length: terminal.buffer.active.length }, (_, i) =>
  terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('');

it("resolves a queued write('', callback) when a resize flushes the queue", async () => {
  terminal = new Terminal({ cols: 40, rows: 5 });
  terminal.write('before ');
  const flushed = new Promise<'flushed'>(resolve => terminal.write('', () => resolve('flushed')));
  terminal.write('after');
  terminal.resize(30, 5);
  const timeout = new Promise<'stalled'>(resolve => setTimeout(() => resolve('stalled'), 200));
  expect(await Promise.race([flushed, timeout])).toBe('flushed');
  expect(text()).toContain('before after');
});

it('does not replay already-parsed writes when a resize lands between write slices', async () => {
  terminal = new Terminal({ cols: 40, rows: 5 });
  await new Promise<void>(resolve => terminal.write('', resolve));
  // Make xterm yield after a few small writes, mid-command.
  let clockReads = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => Math.floor(++clockReads / 11) * 20);
  const resized = new Promise<void>(resolve => {
    const listener = terminal.onWriteParsed(() => {
      listener.dispose();
      terminal.resize(30, 5);
      resolve();
    });
  });
  for (const char of 'git status') terminal.write(char);
  terminal.write('\r\nOn branch main\r\n');
  await resized;
  vi.mocked(performance.now).mockRestore();
  await new Promise<void>(resolve => terminal.write('', resolve));
  expect(text().match(/git status/g)).toHaveLength(1);
  expect(text().match(/On branch main/g)).toHaveLength(1);
});
