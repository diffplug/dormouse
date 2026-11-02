// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { attachKeyboardProtocolArbiter } from './keyboard-protocol-arbiter';
import { serializeTransferTerminal, type TerminalGrid } from './terminal-transfer';
import { xtermVtExtensions } from './xterm-options';

const write = (terminal: Terminal, data: string) => new Promise<void>(resolve => terminal.write(data, resolve));
async function reply(terminal: Terminal, query: string): Promise<string> {
  let report = '';
  const listener = terminal.onData(data => { report += data; });
  await write(terminal, query);
  listener.dispose();
  return report;
}
const mode = (terminal: Terminal, number: number) => reply(terminal, `\x1b[?${number}$p`);
const kittyFlags = (terminal: Terminal) => reply(terminal, '\x1b[?u');

const vtExtensions = xtermVtExtensions();
const live: Terminal[] = [];
afterEach(() => { for (const terminal of live.splice(0)) terminal.dispose(); });

async function writtenSource(input: string, options: ITerminalOptions = {}): Promise<{ source: Terminal; serializer: SerializeAddon }> {
  const source = new Terminal({ allowProposedApi: true, vtExtensions, ...options });
  live.push(source);
  const serializer = new SerializeAddon();
  source.loadAddon(serializer);
  await write(source, input);
  return { source, serializer };
}

/** Writes `input` to a fresh source, then its transfer serialization into a fresh target. */
async function transfer(input: string, grid?: TerminalGrid): Promise<{ source: Terminal; target: Terminal }> {
  const { source, serializer } = await writtenSource(input, grid);
  const target = new Terminal({ ...grid, allowProposedApi: true, vtExtensions });
  live.push(target);
  await write(target, serializeTransferTerminal(source, serializer));
  return { source, target };
}

/** xterm answers no public query for color-scheme reports or cursor style. */
const decModes = (terminal: Terminal) => (terminal as unknown as {
  _core: { coreService: { decPrivateModes: { colorSchemeUpdates: boolean; cursorStyle?: string; cursorBlink?: boolean } } };
})._core.coreService.decPrivateModes;

const win32Extensions = { ...vtExtensions, win32InputMode: true };

describe('terminal transfer serialization', () => {
  it('still transfers the buffer if private mouse state is unavailable', () => {
    expect(serializeTransferTerminal({} as Terminal, { serialize: () => 'screen' } as SerializeAddon)).toBe('screen');
  });

  // Fails once a bump ships xtermjs/xterm.js#6174 (`IModes.mouseEncoding`): then
  // delete the private read in serializeTransferTerminal, this test, and the
  // `_core` mock in standalone/src/workspace-move.test.ts (#651).
  it.each([1006, 1016])('the pinned serializer still omits mouse encoding %i', async encoding => {
    const { serializer } = await writtenSource(`\x1b[?${encoding}h`);
    expect(serializer.serialize()).not.toContain(`\x1b[?${encoding}h`);
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

  // Fails once a bump teaches the serializer kitty flags: then delete the replay
  // in serializeTransferTerminal rather than apply them twice.
  it('the pinned serializer still omits kitty keyboard flags', async () => {
    const { source, serializer } = await writtenSource('\x1b[>1u');
    expect(await kittyFlags(source)).toBe('\x1b[?1u');
    expect(serializer.serialize()).not.toMatch(/\x1b\[[=>]/);
  });

  it('preserves pushed kitty flags, which keep Shift+Enter distinct from Enter', async () => {
    const { target } = await transfer('\x1b[>1u');
    expect(await kittyFlags(target)).toBe('\x1b[?1u');
  });

  it('preserves kitty flags set without a push', async () => {
    const { target } = await transfer('\x1b[=5;1u');
    expect(await kittyFlags(target)).toBe('\x1b[?5u');
  });

  it('preserves the kitty stack, so each later pop lands where it would have', async () => {
    const { target } = await transfer('\x1b[>1u\x1b[>3u');
    expect(await kittyFlags(target)).toBe('\x1b[?3u');
    await write(target, '\x1b[<u');
    expect(await kittyFlags(target)).toBe('\x1b[?1u');
    await write(target, '\x1b[<u');
    expect(await kittyFlags(target)).toBe('\x1b[?0u');
  });

  it('keeps each screen its own kitty state when moved on the alternate screen', async () => {
    const { target } = await transfer('\x1b[>1u\x1b[?1049h\x1b[>3ualt-content');
    expect(target.buffer.active.type).toBe('alternate');
    expect(target.buffer.active.getLine(0)?.translateToString(true)).toContain('alt-content');
    expect(await kittyFlags(target)).toBe('\x1b[?3u');
    await write(target, '\x1b[<u\x1b[?1049l');
    expect(await kittyFlags(target)).toBe('\x1b[?1u');
    await write(target, '\x1b[<u');
    expect(await kittyFlags(target)).toBe('\x1b[?0u');
  });

  it.each(['\x1b[<u', '\x1bc'])('does not resurrect kitty flags after %j', async reset => {
    const { target } = await transfer('\x1b[>1u' + reset);
    expect(await kittyFlags(target)).toBe('\x1b[?0u');
  });

  // Fails once a bump teaches the serializer one of these: then delete its replay.
  it.each(['\x1b[?2031h', '\x1b[?9001h', '\x1b[5 q'])('the pinned serializer still omits %j', async sequence => {
    const { serializer } = await writtenSource(sequence, { vtExtensions: win32Extensions });
    expect(serializer.serialize()).not.toContain(sequence);
  });

  it('preserves color-scheme change reports', async () => {
    const { target } = await transfer('\x1b[?2031h');
    expect(decModes(target).colorSchemeUpdates).toBe(true);
  });

  it('does not resurrect color-scheme change reports after a reset', async () => {
    const { target } = await transfer('\x1b[?2031h\x1b[?2031l');
    expect(decModes(target).colorSchemeUpdates).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, 6])('preserves cursor style %i', async style => {
    const { source, target } = await transfer(`\x1b[${style} q`);
    expect(decModes(source).cursorStyle).toBeDefined();
    expect(decModes(target).cursorStyle).toBe(decModes(source).cursorStyle);
    expect(decModes(target).cursorBlink).toBe(decModes(source).cursorBlink);
  });

  it('does not resurrect a cursor style after a reset', async () => {
    const { target } = await transfer('\x1b[5 q\x1b[0 q');
    expect(decModes(target).cursorStyle).toBeUndefined();
  });

  async function win32Target(input: string): Promise<Terminal> {
    const { source, serializer } = await writtenSource(input, { vtExtensions: win32Extensions });
    const target = new Terminal({ allowProposedApi: true, vtExtensions: win32Extensions });
    live.push(target);
    attachKeyboardProtocolArbiter(target);
    await write(target, serializeTransferTerminal(source, serializer));
    return target;
  }

  it('turns win32-input-mode off and back on through the arriving arbiter', async () => {
    const target = await win32Target('\x1b[>1u');
    expect(target.options.vtExtensions?.win32InputMode).toBe(false);
    await write(target, '\x1b[<u');
    expect(target.options.vtExtensions?.win32InputMode).toBe(true);
  });

  it('preserves win32-input-mode', async () => {
    expect(await mode(await win32Target('\x1b[?9001h'), 9001)).toBe('\x1b[?9001;1$y');
  });

  it('does not resurrect win32-input-mode after a reset', async () => {
    expect(await mode(await win32Target('\x1b[?9001h\x1b[?9001l'), 9001)).toBe('\x1b[?9001;2$y');
  });

  it('keeps win32-input-mode set beneath a kitty consumer, for when it pops', async () => {
    const target = await win32Target('\x1b[?9001h\x1b[>1u');
    await write(target, '\x1b[<u');
    expect(await mode(target, 9001)).toBe('\x1b[?9001;1$y');
  });

  it('rebuilds a full-screen grid larger than xterm defaults without clipping', async () => {
    const { source, target } = await transfer('\x1b[?1049h\x1b[45;100Hbottom-right', { cols: 120, rows: 45 });
    expect(target.buffer.active.type).toBe('alternate');
    expect(target.buffer.active.getLine(44)?.translateToString(true)).toContain('bottom-right');
    expect(target.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
  });
});
