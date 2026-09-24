import { afterEach, expect, it, vi } from 'vitest';
import { parseToolState } from './tool-state';
import { clearToolDirty, getToolDirty, recordToolDirty, resetToolDirty, subscribeToToolDirty } from './tool-dirty-store';
import { getToolAnnounce, resetToolAnnounces } from './tool-announce-store';
import { recordToolEvents } from './tool-events';
import { collectTerminalProtocolResponses, collectTerminalSemanticEvents, collectTerminalToolEvents, TerminalProtocolParser } from './terminal-protocol';
import { applyTerminalSemanticEvents, removeTerminalPaneState, seedLaunchedCommand } from './terminal-state-store';

const id = 'dirty-state-test';
const state = (dirty: boolean) => `\x1b]367;state;${JSON.stringify({ v: 1, dirty })}\x07`;
const start = '\x1b]633;C\x07';
const serve = '\x1b]367;serve;{"port":6006}\x07';
afterEach(() => { removeTerminalPaneState(id); resetToolAnnounces(); resetToolDirty(); });

it.each([true, false])('parses strict v1 dirty=%s without a response, including split/ST output', dirty => {
  expect(parseToolState(`state;${JSON.stringify({ v: 1, dirty })}`)).toEqual({ dirty });
  const parser = new TerminalProtocolParser();
  expect(parser.process('before\x1b]367;state;{"v":1,"dirty":').visibleData).toBe('before');
  const parsed = parser.process(`${dirty}}\x1b\\after`);
  expect(parsed.visibleData).toBe('after');
  expect(parsed.events).toEqual([{ kind: 'toolState', state: { dirty } }]);
  expect(collectTerminalProtocolResponses(parsed.events)).toEqual([]);
});

it.each([null, [], {}, { dirty: true }, { v: 2, dirty: true }, { v: '1', dirty: true },
  { v: 1 }, { v: 1, dirty: 'false' }, { v: 1, dirty: 0 }, { v: 1, dirty: null }])('ignores invalid state payload %j without assuming clean', value => {
  recordToolDirty(id, true);
  const parsed = new TerminalProtocolParser().process(`before\x1b]367;state;${JSON.stringify(value)}\x07after`);
  recordToolEvents(id, parsed.events);
  expect(parsed.visibleData).toBe('beforeafter');
  expect(parsed.events).toEqual([]);
  expect(getToolDirty(id)).toBe(true);
});

it('bounds malformed/oversized payloads before JSON parsing', () => {
  for (const value of ['state;{', `state;${' '.repeat(4096)}{"v":1,"dirty":false}`, 'serve;{"v":1,"dirty":true}']) {
    expect(parseToolState(value)).toBeNull();
  }
});

// A live or replayed parse records the whole batch; the sidecar forwards its Tool events.
it.each(['parsed', 'forwarded'] as const)('preserves serve/state/start order and retains exit reports through %s', mode => {
  const feed = (data: string) => {
    const events = new TerminalProtocolParser().process(data).events;
    recordToolEvents(id, mode === 'forwarded' ? collectTerminalToolEvents(events) : events);
    // Adapters deliver semantic batches after protocol reports. This must not
    // erase a state that followed the start inside the same read.
    applyTerminalSemanticEvents(id, collectTerminalSemanticEvents(events));
  };
  feed(state(true) + start + serve + state(false));
  expect(getToolDirty(id)).toBe(false);
  expect(getToolAnnounce(id)?.port).toBe(6006);
  feed(state(true) + serve + '\x1b]633;D;0\x07');
  expect(getToolDirty(id)).toBe(true);
  expect(getToolAnnounce(id)?.port).toBe(6006);
  feed('since-mark bytes with no state');
  expect(getToolDirty(id)).toBe(true);
  feed(start);
  expect(getToolDirty(id)).toBeNull();
});

it('distinguishes clean from unknown, notifies changes only, and resets on synthetic starts/disposal', () => {
  const listener = vi.fn();
  const stop = subscribeToToolDirty(listener);
  expect(getToolDirty(id)).toBeNull();
  recordToolDirty(id, false);
  recordToolDirty(id, false);
  expect(getToolDirty(id)).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  recordToolDirty(id, true);
  seedLaunchedCommand(id, 'pnpm dev');
  expect(getToolDirty(id)).toBeNull();
  recordToolDirty(id, true);
  // A host-parsed semantic batch alone is not a boundary: the ordered protocol event is.
  applyTerminalSemanticEvents(id, [{ type: 'commandStart', source: 'osc633_boundaries' }]);
  expect(getToolDirty(id)).toBe(true);
  recordToolDirty(id, false);
  clearToolDirty(id);
  expect(getToolDirty(id)).toBeNull();
  stop();
  listener.mockClear();
  recordToolDirty(id, true);
  expect(listener).not.toHaveBeenCalled();
});
