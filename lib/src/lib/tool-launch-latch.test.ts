import { describe, expect, it } from 'vitest';
import { TerminalProtocolParser } from './terminal-protocol';
import { ToolLaunchLatch } from './tool-launch-latch';

const osc = (body: string) => `\x1b]${body}\x07`;
const open = (path: string) => osc(`367;open;${JSON.stringify({ v: 1, path, preview: false })}`);
const start = (line: string) => osc(`633;E;${line}`) + osc('633;C');
const finish = osc('633;D;0') + osc('633;A') + osc('633;B');

/** A PTY whose output the owner parses, chunk by chunk: the paths of the
 *  `open` requests the latch admits. */
function pty() {
  const parser = new TerminalProtocolParser();
  const latch = new ToolLaunchLatch();
  return {
    latch,
    admitted(...chunks: string[]): string[] {
      return chunks.flatMap(chunk => latch.admit(parser.process(chunk).events)
        .flatMap(event => event.kind === 'toolOpen' ? [event.open.path] : []));
    },
  };
}

describe('ToolLaunchLatch', () => {
  it('admits the launched run\'s opens, including one in the chunk that reports its start', () => {
    const { latch, admitted } = pty();
    latch.arm();
    expect(admitted(start('view /a') + open('/a'), open('/b'))).toEqual(['/a', '/b']);
  });

  it('keeps a launch armed across the prompt the typed line waits on, admitting nothing before its start', () => {
    const { latch, admitted } = pty();
    latch.arm();
    expect(admitted(osc('633;A') + open('/x') + osc('633;B'), start('view /a'), open('/a'))).toEqual(['/a']);
  });

  it('admits nothing from a start the host never launched, whatever command line it reports', () => {
    const { admitted } = pty();
    expect(admitted(finish + start('view /a'), open('/a'))).toEqual([]);
    expect(admitted(start('view /a') + open('/b'))).toEqual([]);
  });

  it('admits nothing once the launched run is over, though a later start reports the same command', () => {
    const { latch, admitted } = pty();
    latch.arm();
    expect(admitted(start('view /a'), finish + start('view /a') + open('/a'), open('/b'))).toEqual([]);
  });

  it('ends the launched run at a second start or a prompt, never resuming it', () => {
    for (const ending of [start('view /a'), osc('133;C'), osc('633;A'), osc('133;D;0')]) {
      const { latch, admitted } = pty();
      latch.arm();
      expect(admitted(start('view /a'), ending + open('/a'), open('/b')), JSON.stringify(ending)).toEqual([]);
    }
  });

  it('passes every other event through in order', () => {
    const { latch } = pty();
    const parser = new TerminalProtocolParser();
    const events = parser.process(osc('367;state;{"v":1,"dirty":true}') + open('/a') + start('x')).events;
    expect(latch.admit(events).map(event => event.kind)).toEqual(['toolState', 'semantic', 'semantic']);
  });
});
