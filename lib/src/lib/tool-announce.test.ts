import { describe, expect, it } from 'vitest';
import { collectTerminalToolEvents, collectTerminalProtocolResponses, TerminalProtocolParser } from './terminal-protocol';
import { getToolAnnounce, resetToolAnnounces } from './tool-announce-store';
import { recordToolEvents } from './tool-events';

const serve = (payload: unknown) => `serve;${JSON.stringify(payload)}`;

describe('OSC 367 at the PTY boundary', () => {
  // A live or replayed parse records the whole batch; the sidecar forwards its Tool events.
  it.each(['parsed', 'forwarded'] as const)('isolates successive commands without losing same-chunk serves (%s)', mode => {
    const record = (data: string) => {
      const events = new TerminalProtocolParser().process(data).events;
      recordToolEvents('epoch', mode === 'forwarded' ? collectTerminalToolEvents(events) : events);
    };
    const oldServe = '\x1b]367;serve;{"port":6006,"key":["old"]}\x07';
    const start = '\x1b]633;C\x07';
    record(oldServe + start);
    expect(getToolAnnounce('epoch')).toBeNull();
    record(oldServe + start + '\x1b]367;serve;{"port":6007}\x07');
    expect(getToolAnnounce('epoch')?.port).toBe(6007);
    record('since-mark replay without a command boundary');
    expect(getToolAnnounce('epoch')?.port).toBe(6007);
    record(start);
    expect(getToolAnnounce('epoch')).toBeNull();
  });

  function feed(id: string, data: string) {
    const parser = new TerminalProtocolParser();
    const result = parser.process(data);
    recordToolEvents(id, result.events);
    return result;
  }

  it('strips the sequence from what the terminal renders', () => {
    resetToolAnnounces();
    const result = feed('s1', `before\x1b]367;${serve({ port: 6006 })}\x1b\\after`);
    expect(result.visibleData).toBe('beforeafter');
  });

  it('strips a malformed announcement too, so it cannot print itself', () => {
    resetToolAnnounces();
    expect(feed('s2', 'a\x1b]367;serve;garbage\x1b\\b').visibleData).toBe('ab');
    expect(getToolAnnounce('s2')).toBeNull();
  });

  it('accepts BEL as the terminator, as the other OSC readers do', () => {
    resetToolAnnounces();
    feed('s3', `\x1b]367;${serve({ port: 1234 })}\x07`);
    expect(getToolAnnounce('s3')?.port).toBe(1234);
  });

  it('records last-write-wins, because the announcement is re-emittable', () => {
    resetToolAnnounces();
    feed('s4', `\x1b]367;${serve({ port: 1 })}\x1b\\`);
    feed('s4', `\x1b]367;${serve({ port: 2 })}\x1b\\`);
    expect(getToolAnnounce('s4')?.port).toBe(2);
  });

  it('records an announcement from any Session — recording is not acting', () => {
    // An ordinary terminal that prints this gets an entry here and nothing
    // else: only a tool-designated Session ever reads it.
    resetToolAnnounces();
    feed('plain-terminal', `\x1b]367;${serve({ port: 8080 })}\x1b\\`);
    expect(getToolAnnounce('plain-terminal')?.port).toBe(8080);
  });
});


it('consumes chunked OSC 367 and forwards the announcement without a terminal reply', () => {
  const parser = new TerminalProtocolParser();
  expect(parser.process('before\x1b]367;serve;{"port":').visibleData).toBe('before');
  const parsed = parser.process('6006}\x1b\\after');
  expect(parsed.visibleData).toBe('after');
  expect(collectTerminalToolEvents(parsed.events)).toEqual([
    { kind: 'toolAnnounce', announce: { port: 6006, name: null, key: null, dehydrate: false, persist: null } },
  ]);
  expect(collectTerminalProtocolResponses(parsed.events)).toEqual([]);
});

it('parses an OSC 367 open as a request the host forwards, which recording ignores', () => {
  const parsed = new TerminalProtocolParser().process(`before\x1b]367;open;${JSON.stringify({ v: 1, path: '/repo/a.md', preview: true })}\x1b\\after`);
  expect(parsed.visibleData).toBe('beforeafter');
  expect(parsed.events).toEqual([{ kind: 'toolOpen', open: { path: '/repo/a.md', preview: true } }]);
  expect(collectTerminalToolEvents(parsed.events)).toEqual(parsed.events);
  expect(collectTerminalProtocolResponses(parsed.events)).toEqual([]);
  recordToolEvents('open-only', parsed.events);
  expect(getToolAnnounce('open-only')).toBeNull();
});

it('parses an OSC 367 dehydrate as an event the host forwards whole, which recording ignores', () => {
  const payload = JSON.stringify({ v: 1, state: { expanded: ['src'] } });
  const parsed = new TerminalProtocolParser().process(`before\x1b]367;dehydrate;${payload}\x07after`);
  expect(parsed.visibleData).toBe('beforeafter');
  expect(parsed.events).toEqual([{ kind: 'toolDehydrate', dehydrate: { payload } }]);
  expect(collectTerminalToolEvents(parsed.events)).toEqual(parsed.events);
  recordToolEvents('dehydrate-only', parsed.events);
  expect(getToolAnnounce('dehydrate-only')).toBeNull();
});
