// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The renderer half of output flow control (`docs/specs/transport.md` ->
 * "Output flow control"), through the real registry and the fake adapter's
 * dispatch: a terminal acknowledges what xterm has parsed, and nothing else.
 */

vi.mock('@xterm/xterm', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-fit', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-serialize', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('./xterm-test-mock'));

vi.mock('./platform', async () => {
  const actual = await vi.importActual<typeof import('./platform')>('./platform');
  const fakePlatform = new actual.FakePtyAdapter();
  return { ...actual, getPlatform: () => fakePlatform, __fakePlatform: fakePlatform };
});

import { Terminal } from '@xterm/xterm';
import * as platformModule from './platform';
import type { FakePtyAdapter } from './platform';
import { PTY_ACK_BATCH_CHARS } from './pty-flow';
import { disposeSession, getOrCreateTerminal, releaseSession, resumeTerminal } from './terminal-registry';

const platform = (platformModule as unknown as { __fakePlatform: FakePtyAdapter }).__fakePlatform;

let acks: Array<[string, number]>;
/** xterm's pending write callbacks, in write order; calling one is xterm finishing that chunk. */
let parsed: Array<() => void>;
let writeImpl: (data: string) => void;

beforeEach(() => {
  acks = [];
  parsed = [];
  writeImpl = () => {};
  // Assigned rather than spied, so the code before this method existed runs
  // these tests too, and fails them on what it does.
  platform.acknowledgePtyData = (id: string, chars: number) => void acks.push([id, chars]);
  vi.spyOn(Terminal.prototype, 'write').mockImplementation(function (this: Terminal, data: string, callback?: () => void) {
    writeImpl(data);
    if (callback) parsed.push(callback);
  } as never);
});

afterEach(() => {
  for (const id of ['flow-batch', 'flow-throw', 'flow-replay']) disposeSession(id);
  platform.killPty('flow-gone');
  delete (platform as Partial<FakePtyAdapter>).acknowledgePtyData;
  vi.restoreAllMocks();
});

describe('a terminal acknowledging its output', () => {
  it('acknowledges from the write callback, a batch at a time', () => {
    getOrCreateTerminal('flow-batch');
    // The parse splits a big read into pieces; each is its own write.
    platform.sendOutput('flow-batch', 'x'.repeat(PTY_ACK_BATCH_CHARS - 1));
    const first = parsed.splice(0);
    platform.sendOutput('flow-batch', 'yz');
    // Written but not parsed: nothing is owed yet.
    expect(acks).toEqual([]);
    expect(first.length).toBeGreaterThan(0);
    expect(parsed).toHaveLength(1);

    for (const done of first) done();
    expect(acks).toEqual([]);
    parsed[0]();
    expect(acks).toEqual([['flow-batch', PTY_ACK_BATCH_CHARS + 1]]);
  });

  it('acknowledges at once what no terminal consumed: an id with none, or one released', () => {
    // A live PTY this webview has no terminal for, as during a resume's collection.
    platform.spawnPty('flow-nobody');
    platform.sendOutput('flow-nobody', 'abc');
    expect(acks).toEqual([['flow-nobody', 3]]);

    getOrCreateTerminal('flow-gone');
    releaseSession('flow-gone');
    platform.sendOutput('flow-gone', 'late');
    expect(acks).toEqual([['flow-nobody', 3], ['flow-gone', 4]]);
    expect(parsed).toEqual([]);
    platform.killPty('flow-nobody');
  });

  it('keeps a write xterm refuses inside the dispatch, and still acknowledges it', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getOrCreateTerminal('flow-throw');
    const later = vi.fn();
    platform.onPtyData(later);
    writeImpl = () => { throw new Error('write data discarded, use flow control to avoid losing data'); };
    try {
      expect(() => platform.sendOutput('flow-throw', 'x'.repeat(PTY_ACK_BATCH_CHARS))).not.toThrow();
      // Every handler behind the terminal's still ran...
      expect(later).toHaveBeenCalled();
      // ...and the discarded chunk was paid for, or the host would hold its PTY paused.
      expect(acks).toEqual([['flow-throw', PTY_ACK_BATCH_CHARS]]);
    } finally {
      platform.offPtyData(later);
      error.mockRestore();
    }
  });

  it('never counts a replay, only the live output after it', () => {
    resumeTerminal('flow-replay', 'r'.repeat(PTY_ACK_BATCH_CHARS * 3), { alive: true });
    platform.spawnPty('flow-replay');
    for (const done of parsed.splice(0)) done();
    expect(acks).toEqual([]);

    platform.sendOutput('flow-replay', 'x'.repeat(PTY_ACK_BATCH_CHARS));
    for (const done of parsed.splice(0)) done();
    expect(acks).toEqual([['flow-replay', PTY_ACK_BATCH_CHARS]]);
  });
});
