import { describe, expect, it } from 'vitest';
import { parseToolAnnounce } from './tool-announce';
import { TerminalProtocolParser } from './terminal-protocol';
import { getToolAnnounce, resetToolAnnounces } from './tool-announce-store';
import { applyTerminalProtocolEvents } from './terminal-protocol';

const serve = (payload: unknown) => `serve;${JSON.stringify(payload)}`;

describe('parseToolAnnounce', () => {
  it('reads a full serve payload', () => {
    expect(parseToolAnnounce(serve({ port: 6006, name: 'Storybook', key: ['storybook', '/repo'], dehydrate: true, persist: 'never', v: 1 }))).toEqual({
      port: 6006,
      name: 'Storybook',
      key: ['storybook', '/repo'],
      dehydrate: true,
      persist: 'never',
    });
  });

  it('defaults the reserved fields when unstated', () => {
    expect(parseToolAnnounce(serve({ port: 4242 }))).toEqual({
      port: 4242,
      name: null,
      key: null,
      dehydrate: false,
      persist: null,
    });
  });

  it('ignores every verb but serve — dehydrate is D2 and half-honoring it is worse than dropping it', () => {
    expect(parseToolAnnounce('dehydrate;{"v":1}')).toBeNull();
    expect(parseToolAnnounce('progress;{"v":1}')).toBeNull();
  });

  it('never throws on malformed output', () => {
    expect(parseToolAnnounce('serve;not json')).toBeNull();
    expect(parseToolAnnounce('serve;[1,2]')).toBeNull();
    expect(parseToolAnnounce('serve;null')).toBeNull();
    expect(parseToolAnnounce('serve;')).toBeNull();
    expect(parseToolAnnounce('serve')).toBeNull();
    expect(parseToolAnnounce('')).toBeNull();
  });

  it('rejects a payload past the size cap rather than parsing it', () => {
    expect(parseToolAnnounce(serve({ port: 1, name: 'x'.repeat(8000) }))).toBeNull();
  });

  it('rejects ports outside the valid range', () => {
    for (const port of [0, -1, 65536, 1.5, '6006']) {
      expect(parseToolAnnounce(serve({ port, name: 'n' }))?.port ?? null).toBeNull();
    }
  });

  it('sanitizes the name like every other OSC payload', () => {
    expect(parseToolAnnounce(serve({ port: 1, name: 'Storybook\n\nhere' }))?.name).toBe('Story book here');
  });

  it('clamps an over-long name instead of dropping the announcement', () => {
    const announce = parseToolAnnounce(serve({ port: 1, name: 'a'.repeat(500) }));
    expect(announce?.name).toHaveLength(200);
  });

  it('rejects a key that is not a list of strings, and caps its length', () => {
    expect(parseToolAnnounce(serve({ key: 'storybook' }))).toBeNull();
    expect(parseToolAnnounce(serve({ key: [1, 2] }))).toBeNull();
    expect(parseToolAnnounce(serve({ key: [] }))).toBeNull();
    expect(parseToolAnnounce(serve({ key: Array(20).fill('x') }))).toBeNull();
  });

  it('returns null when nothing actionable is stated', () => {
    expect(parseToolAnnounce(serve({ v: 1 }))).toBeNull();
    expect(parseToolAnnounce(serve({ dehydrate: true }))).toBeNull();
  });
});

describe('OSC 367 at the PTY boundary', () => {
  const sink = { notifyFromProtocol: () => {}, updateProtocolProgress: () => {} };

  function feed(id: string, data: string) {
    const parser = new TerminalProtocolParser();
    const result = parser.process(data);
    applyTerminalProtocolEvents(sink, id, result.events);
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
