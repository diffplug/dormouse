// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { serializeTransferTerminal } from './terminal-transfer';

const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
async function mode(terminal: Terminal, number: number): Promise<string> {
  let report = '';
  const listener = terminal.onData(data => { report += data; });
  await write(terminal, `\x1b[?${number}$p`);
  listener.dispose();
  return report;
}

describe('terminal transfer serialization', () => {
  it.each([1006, 1016])('preserves mouse tracking and encoding %i through real xterm parsing', async encoding => {
    const source = new Terminal({ allowProposedApi: true });
    const target = new Terminal({ allowProposedApi: true });
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    try {
      await write(source, `\x1b[?1003h\x1b[?${encoding}h`);
      await write(target, serializeTransferTerminal(source, serializer));
      expect(target.modes.mouseTrackingMode).toBe('any');
      expect(await mode(target, encoding)).toBe(`\x1b[?${encoding};1$y`);
    } finally { source.dispose(); target.dispose(); }
  });

  it.each(['\x1b[?1006l', '\x1bc'])('does not resurrect encoding after reset %j', async reset => {
    const source = new Terminal({ allowProposedApi: true });
    const target = new Terminal({ allowProposedApi: true });
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    try {
      await write(source, '\x1b[?1006h' + reset);
      await write(target, serializeTransferTerminal(source, serializer));
      expect(await mode(target, 1006)).toBe('\x1b[?1006;2$y');
    } finally { source.dispose(); target.dispose(); }
  });

  it('rebuilds a full-screen grid larger than xterm defaults without clipping', async () => {
    const grid = { cols: 120, rows: 45 };
    const source = new Terminal({ ...grid, allowProposedApi: true });
    const target = new Terminal({ ...grid, allowProposedApi: true });
    const serializer = new SerializeAddon();
    source.loadAddon(serializer);
    try {
      await write(source, '\x1b[?1049h\x1b[45;100Hbottom-right');
      await write(target, serializeTransferTerminal(source, serializer));
      expect(target.buffer.active.type).toBe('alternate');
      expect(target.buffer.active.getLine(44)?.translateToString(true)).toContain('bottom-right');
      expect(target.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
    } finally { source.dispose(); target.dispose(); }
  });
});
