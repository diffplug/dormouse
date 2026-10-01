// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { serializeTransferTerminal, type TerminalGrid } from './terminal-transfer';

const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
async function mode(terminal: Terminal, number: number): Promise<string> {
  let report = '';
  const listener = terminal.onData(data => { report += data; });
  await write(terminal, `\x1b[?${number}$p`);
  listener.dispose();
  return report;
}

const live: Terminal[] = [];
afterEach(() => { for (const terminal of live.splice(0)) terminal.dispose(); });

/** Writes `input` to a fresh source, then its transfer serialization into a fresh target. */
async function transfer(input: string, grid?: TerminalGrid): Promise<{ source: Terminal; target: Terminal }> {
  const source = new Terminal({ ...grid, allowProposedApi: true });
  const target = new Terminal({ ...grid, allowProposedApi: true });
  live.push(source, target);
  const serializer = new SerializeAddon();
  source.loadAddon(serializer);
  await write(source, input);
  await write(target, serializeTransferTerminal(source, serializer));
  return { source, target };
}

describe('terminal transfer serialization', () => {
  it('still transfers the buffer if private mouse state is unavailable', () => {
    expect(serializeTransferTerminal({} as Terminal, { serialize: () => 'screen' } as SerializeAddon)).toBe('screen');
  });

  it.each([1006, 1016])('preserves mouse tracking and encoding %i through real xterm parsing', async encoding => {
    const { target } = await transfer(`\x1b[?1003h\x1b[?${encoding}h`);
    expect(target.modes.mouseTrackingMode).toBe('any');
    expect(await mode(target, encoding)).toBe(`\x1b[?${encoding};1$y`);
  });

  it.each(['\x1b[?1006l', '\x1bc'])('does not resurrect encoding after reset %j', async reset => {
    const { target } = await transfer('\x1b[?1006h' + reset);
    expect(await mode(target, 1006)).toBe('\x1b[?1006;2$y');
  });

  it('rebuilds a full-screen grid larger than xterm defaults without clipping', async () => {
    const { source, target } = await transfer('\x1b[?1049h\x1b[45;100Hbottom-right', { cols: 120, rows: 45 });
    expect(target.buffer.active.type).toBe('alternate');
    expect(target.buffer.active.getLine(44)?.translateToString(true)).toContain('bottom-right');
    expect(target.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
  });
});
