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
