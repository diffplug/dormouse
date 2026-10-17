// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { FakePtyAdapter } from './fake-adapter';
import { removeTerminalPaneState } from '../terminal-state-store';

const ID = 'helper-reflow';
afterEach(() => { vi.restoreAllMocks(); removeTerminalPaneState(ID); });

it('preserves one command echo when the helper resizes between PTY chunks', async () => {
  const adapter = new FakePtyAdapter();
  const terminal = new Terminal({ cols: 33, rows: 7, allowProposedApi: true });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  adapter.onPtyData(({ data }) => terminal.write(data));
  const drain = () => new Promise<void>(resolve => terminal.write('', resolve));
  try {
    adapter.spawnPty(ID, { helper: { parentId: 'source', command: 'git status' } });
    await Promise.resolve();
    await drain();
    // Make xterm yield after ten small writes: the echo, before its CRLF.
    let clockReads = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => Math.floor(++clockReads / 11) * 20);
    const resized = new Promise<void>(resolve => {
      const listener = terminal.onWriteParsed(() => {
        listener.dispose();
        terminal.resize(26, 7);
        resolve();
      });
    });
    adapter.writePty(ID, 'git status\r');
    await resized;
    clock.mockRestore();
    await drain();
    const text = Array.from({ length: terminal.buffer.active.length }, (_, i) =>
      terminal.buffer.active.getLine(i)?.translateToString(true) ?? '').join('');
    expect(text.match(/git status/g)).toHaveLength(1);
    expect(text.match(/On branch main/g)).toHaveLength(1);
  } finally { terminal.dispose(); adapter.shutdown(); }
});

it.each([false, true])('keeps both narrow helper prompts when startup waits for fit (yield before fit: %s)', async (yieldBeforeFit) => {
  const adapter = new FakePtyAdapter();
  adapter.deferHelperStartup = true;
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  const output = vi.fn(({ data }: { data: string }) => terminal.write(data));
  adapter.onPtyData(output);
  const drain = () => new Promise<void>(resolve => terminal.write('', resolve));
  try {
    adapter.spawnPty(ID, { helper: { parentId: 'source', command: 'git status' } });
    if (yieldBeforeFit) await drain();
    expect(output).not.toHaveBeenCalled();
    terminal.resize(26, 5);
    adapter.resizePty(ID, 26, 5);
    // A size notification alone does not release output before the story is ready.
    expect(output).not.toHaveBeenCalled();
    adapter.resumeHelperStartup(ID);
    adapter.resumeHelperStartup(ID);
    await drain();
    adapter.writePty(ID, 'git status\r');
    await drain();
    const buffer = terminal.buffer.active;
    const lines = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)!.translateToString(true));
    expect(lines).toEqual([
      '/home/demo/projects/dormou',
      'se ❯ git status',
      'On branch main',
      'nothing to commit, working',
      ' tree clean',
      '/home/demo/projects/dormou',
      'se ❯ ',
    ]);
    expect(buffer.viewportY).toBe(buffer.baseY);
    expect(buffer.baseY).toBe(2);
  } finally { terminal.dispose(); adapter.shutdown(); }
});

it.each(['kill', 'reset'] as const)('discards a deferred helper prompt on %s', async (action) => {
  const adapter = new FakePtyAdapter();
  adapter.deferHelperStartup = true;
  const output = vi.fn();
  adapter.onPtyData(output);
  try {
    adapter.spawnPty(ID, { helper: { parentId: 'source', command: 'git status' } });
    if (action === 'kill') adapter.killPty(ID);
    else { adapter.reset(); adapter.onPtyData(output); }
    // Reusing the id must not let the old helper write into the new terminal.
    adapter.spawnPty(ID);
    adapter.resumeHelperStartup(ID);
    await Promise.resolve();
    expect(output).not.toHaveBeenCalled();
  } finally { adapter.shutdown(); }
});

it('does not let a queued prompt release a replacement helper early', async () => {
  const adapter = new FakePtyAdapter();
  const output = vi.fn();
  adapter.onPtyData(output);
  try {
    adapter.spawnPty(ID, { helper: { parentId: 'source', command: 'git status' } });
    adapter.killPty(ID);
    adapter.deferHelperStartup = true;
    adapter.spawnPty(ID, { helper: { parentId: 'source', command: 'git status' } });
    await Promise.resolve();
    expect(output).not.toHaveBeenCalled();
    adapter.resumeHelperStartup(ID);
    expect(output).toHaveBeenCalledTimes(1);
  } finally { adapter.shutdown(); }
});
