/**
 * The provider the sidecar hands the service: PTYs answered locally, everything
 * about the webview's *view* of them asked over the bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProcessedPtyChunk, PtySink } from '../../remote/burrow/burrow-surface-provider';
import {
  createSidecarHost,
  createSidecarSurfaceBridge,
  type SidecarHost,
  type SidecarSurfaceBridge,
} from './sidecar-entry';
import { ASK_BUDGET_MS, type BurrowAsk } from './service-protocol';
import { AlertManager, type AlertState } from '../../lib/alert-manager';
import { REPORT } from '../../lib/alert-manager-test-utils';
import { createAlertClient } from '../alert-client';
import type { AlertStateDetail } from '../../lib/platform/types';

let sent: Array<{ event: string; data: unknown }>;
let written: Array<{ id: string; data: string }>;
let resized: Array<{ id: string; cols: number; rows: number; repaint?: boolean }>;
let livePtys: Set<string>;
/** A PTY that died between the read and a reply write. */
let writeThrows: boolean;
let bridge: SidecarSurfaceBridge;
/** The app's one manager, which the parse feeds. */
let alerts: AlertManager;
/** Called as each PTY write lands, to observe what preceded it. */
let onWrite: ((id: string) => void) | null;

/** The ask the bridge is waiting on, most recent last. */
function asks(): BurrowAsk[] {
  return sent
    .filter((message) => message.event === 'burrow:ask')
    .map((message) => message.data as BurrowAsk);
}

/** What the bridge told the webview under one event name, most recent last. */
function emitted<T>(event: string): T[] {
  return sent.filter((message) => message.event === event).map((message) => message.data as T);
}

/** One window's reply. `from` is the label the host stamps on it. */
function answer(ask: BurrowAsk, results: unknown[], from?: string): void {
  bridge.onAnswer({ burrowRequestId: ask.burrowRequestId, results }, from);
}

function sink(): PtySink & { chunks: ProcessedPtyChunk[]; data: string[]; exits: number[] } {
  const record = {
    chunks: [] as ProcessedPtyChunk[],
    exits: [] as number[],
    /** The renderer projection alone, for the assertions that only care about it. */
    get data(): string[] {
      return record.chunks.map((chunk) => chunk.data);
    },
    onData: (chunk: ProcessedPtyChunk) => void record.chunks.push(chunk),
    onExit: (code: number) => void record.exits.push(code),
  };
  return record;
}

beforeEach(() => {
  sent = [];
  written = [];
  resized = [];
  livePtys = new Set(['pty-1', 'pty-2']);
  writeThrows = false;
  alerts = new AlertManager();
  onWrite = null;
  bridge = createSidecarSurfaceBridge({
    alerts,
    send: (event, data) => sent.push({ event, data }),
    mgr: {
      write: (id, data) => {
        if (writeThrows) throw new Error('write EIO');
        onWrite?.(id);
        written.push({ id, data });
      },
      resize: (id, cols, rows, repaint) => void resized.push({
        id, cols, rows, ...(repaint === undefined ? {} : { repaint }),
      }),
      hasPty: (id) => livePtys.has(id),
    },
  });
});

afterEach(() => {
  bridge.dispose();
  alerts.dispose();
  vi.useRealTimers();
});

describe('asking the webview', () => {
  it('carries the op and its params, and settles on the answer', async () => {
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    expect(ask.op).toBe('directory');
    expect(typeof ask.burrowRequestId).toBe('string');

    answer(ask, [{ surfaceId: 's1' }]);
    expect(await pending).toEqual([{ surfaceId: 's1' }]);
  });

  it('settles on the one answer while one window is open', async () => {
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    answer(ask, [{ surfaceId: 'first' }]);
    // Settled: a later reply is stale and cannot reopen it.
    answer(ask, [{ surfaceId: 'second' }]);
    expect(await pending).toEqual([{ surfaceId: 'first' }]);
  });

  it('collects one answer per window and concatenates them', async () => {
    // Each window sees only its own Workspaces, so a directory built from the
    // first answer would list one window's panes and omit the rest.
    bridge.setWindows(['main', 'ws-2']);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    answer(ask, [{ surfaceId: 'in-main' }], 'main');
    answer(ask, [{ surfaceId: 'in-ws-2' }], 'ws-2');
    expect(await pending).toEqual([{ surfaceId: 'in-main' }, { surfaceId: 'in-ws-2' }]);
  });

  it('a second answer from one window cannot settle the ask', async () => {
    vi.useFakeTimers();
    bridge.setWindows(['main', 'ws-2']);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    answer(ask, [{ surfaceId: 'in-main' }], 'main');
    // A reload racing its own reply. Counting answers would settle here, on a
    // directory that has never heard from ws-2 — and duplicate main's panes.
    answer(ask, [{ surfaceId: 'in-main-again' }], 'main');
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    answer(ask, [{ surfaceId: 'in-ws-2' }], 'ws-2');
    expect(await pending).toEqual([{ surfaceId: 'in-main' }, { surfaceId: 'in-ws-2' }]);
  });

  it('answers with what it has when a window never replies', async () => {
    vi.useFakeTimers();
    bridge.setWindows(['main', 'ws-2', 'ws-3']);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    answer(ask, [{ surfaceId: 'in-main' }], 'main');
    await vi.advanceTimersByTimeAsync(ASK_BUDGET_MS);
    // A partial directory beats an empty one; the next change re-collects.
    expect(await pending).toEqual([{ surfaceId: 'in-main' }]);
  });

  it('a window closing mid-fan-out settles the ask instead of holding it open', async () => {
    bridge.setWindows(['main', 'ws-2']);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    answer(ask, [{ surfaceId: 'in-main' }], 'main');
    // The second window went away without answering.
    bridge.setWindows(['main']);
    expect(await pending).toEqual([{ surfaceId: 'in-main' }]);
  });

  it('a window opening mid-fan-out never received the ask, so it is not waited on', async () => {
    bridge.setWindows(['main']);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    bridge.setWindows(['main', 'ws-2']);
    // ws-2's own answer is not part of a snapshot it was never asked for.
    answer(ask, [{ surfaceId: 'in-ws-2' }], 'ws-2');
    answer(ask, [{ surfaceId: 'in-main' }], 'main');
    expect(await pending).toEqual([{ surfaceId: 'in-main' }]);
  });

  it('settles a Surface op on its owner alone, without waiting out the others', async () => {
    // The host routes an ask naming a Surface to the window that owns its PTY —
    // `attach` and `resize` MUTATE that pane — and tells the collector where it
    // went. Waiting on the rest would spend the whole budget on every attach.
    vi.useFakeTimers();
    bridge.setWindows(['main', 'ws-2', 'ws-3']);
    const pending = bridge.provider.resolveSurface('s1', { cols: 80, rows: 24 });
    const ask = asks()[0]!;
    bridge.setAskDelivery({ burrowRequestId: ask.burrowRequestId, windows: ['ws-2'] });
    answer(ask, [{ ptyId: 'p1', cols: 80, rows: 24 }], 'ws-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toMatchObject({ ptyId: 'p1' });
  });

  it('takes a delivery line that arrives after the answer', async () => {
    bridge.setWindows(['main', 'ws-2']);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    answer(ask, [{ surfaceId: 'in-ws-2' }], 'ws-2');
    bridge.setAskDelivery({ burrowRequestId: ask.burrowRequestId, windows: ['ws-2'] });
    expect(await pending).toEqual([{ surfaceId: 'in-ws-2' }]);
  });

  it('never widens an ask, whatever the delivery names', async () => {
    vi.useFakeTimers();
    bridge.setWindows(['main']);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    // A window that never received this ask cannot be put back into it.
    bridge.setAskDelivery({ burrowRequestId: ask.burrowRequestId, windows: ['main', 'ws-9'] });
    answer(ask, [{ surfaceId: 'in-main' }], 'main');
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toEqual([{ surfaceId: 'in-main' }]);
  });

  it('ignores a delivery line that is not a usable one', async () => {
    bridge.setWindows(['main', 'ws-2']);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    for (const bad of [undefined, null, 2, { burrowRequestId: 7, windows: ['main'] },
      { burrowRequestId: ask.burrowRequestId }, { burrowRequestId: 'ask-nope', windows: ['main'] }]) {
      bridge.setAskDelivery(bad);
    }
    answer(ask, [{ surfaceId: 'in-main' }], 'main');
    answer(ask, [{ surfaceId: 'in-ws-2' }], 'ws-2');
    expect(await pending).toEqual([{ surfaceId: 'in-main' }, { surfaceId: 'in-ws-2' }]);
  });

  it('ignores a window list that is not a usable one', async () => {
    for (const bad of [[], 2, 'main', undefined, null]) bridge.setWindows(bad);
    const pending = bridge.provider.collectDirectory();
    answer(asks()[0]!, [{ surfaceId: 's1' }]);
    expect(await pending).toEqual([{ surfaceId: 's1' }]);
  });

  it('gives up at the budget rather than hanging', async () => {
    vi.useFakeTimers();
    const pending = bridge.provider.collectDirectory();
    await vi.advanceTimersByTimeAsync(ASK_BUDGET_MS);
    expect(await pending).toEqual([]);
  });

  it('ignores an answer for an ask that is not outstanding', async () => {
    expect(() => bridge.onAnswer({ burrowRequestId: 'nope', results: [] })).not.toThrow();
    expect(() => bridge.onAnswer(undefined)).not.toThrow();
  });

  it('marks the directory stale when an answer lands after the budget', async () => {
    // The snapshot the Burrow already rendered is missing whatever this answer
    // names — an empty picker on a machine that does have terminals. Nothing
    // re-opens a settled ask, so the next collect is the only repair, and an
    // idle machine has no other reason to run one.
    vi.useFakeTimers();
    const changes = vi.fn();
    bridge.provider.watchDirectory(changes);
    const pending = bridge.provider.collectDirectory();
    const ask = asks()[0]!;
    await vi.advanceTimersByTimeAsync(ASK_BUDGET_MS);
    expect(await pending).toEqual([]);

    answer(ask, [{ surfaceId: 's1' }]);
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('resolves everything outstanding when disposed', async () => {
    const pending = bridge.provider.collectDirectory();
    bridge.dispose();
    expect(await pending).toEqual([]);
  });
});

describe('directory invalidation', () => {
  it('fires watchers on a notify, and stops after unsubscribe', () => {
    const changes = vi.fn();
    const unsubscribe = bridge.provider.watchDirectory(changes);

    bridge.onNotify();
    expect(changes).toHaveBeenCalledTimes(1);

    unsubscribe();
    bridge.onNotify();
    expect(changes).toHaveBeenCalledTimes(1);
  });
});

describe('resolveSurface', () => {
  it('attaches at the requested size and reports what the owner settled at', async () => {
    const pending = bridge.provider.resolveSurface('s1', { cols: 80, rows: 24 });
    const ask = asks()[0]!;
    expect(ask.op).toBe('surfaceOp');
    expect(ask.params).toEqual({ surfaceId: 's1', op: 'attach', cols: 80, rows: 24 });

    answer(ask, [{ ptyId: 'pty-1', cols: 80, rows: 24 }]);
    const handle = (await pending)!;
    expect(handle.ptyId).toBe('pty-1');
    expect([handle.cols, handle.rows]).toEqual([80, 24]);
  });

  it('is null when nobody owns the surface', async () => {
    const pending = bridge.provider.resolveSurface('gone', {});
    answer(asks()[0]!, []);
    expect(await pending).toBeNull();
  });

  it('resizes through the owner and remembers what it reported', async () => {
    const attach = bridge.provider.resolveSurface('s1', { cols: 80, rows: 24 });
    answer(asks()[0]!, [{ ptyId: 'pty-1', cols: 80, rows: 24 }]);
    const handle = (await attach)!;

    const pending = handle.resize(100, 30);
    const ask = asks()[1]!;
    expect(ask.params).toEqual({ surfaceId: 's1', op: 'resize', cols: 100, rows: 30 });
    // The owner clamped it.
    answer(ask, [{ ptyId: 'pty-1', cols: 100, rows: 28 }]);

    expect(await pending).toEqual({ cols: 100, rows: 28 });
    expect([handle.cols, handle.rows]).toEqual([100, 28]);
  });

  it('fails when nobody answers a resize and retains only the cached dimensions', async () => {
    const attach = bridge.provider.resolveSurface('s1', {});
    answer(asks()[0]!, [{ ptyId: 'pty-1', cols: 80, rows: 24 }]);
    const handle = (await attach)!;

    const pending = handle.resize(100, 30);
    answer(asks()[1]!, []);
    await expect(pending).rejects.toThrow('surface owner unavailable');
    expect([handle.cols, handle.rows]).toEqual([80, 24]);
  });
});

describe('PTYs', () => {
  // A Client's keystrokes are a human's input like a local one's, and the host
  // acknowledges them before the write, echo window included
  // (docs/specs/alert.md → Engagement).
  it('acknowledges a Client\'s input before writing it', () => {
    alerts.notifyFromProtocol('pty-1', REPORT);
    const atWrite: unknown[] = [];
    onWrite = (id) => {
      const { status, todo } = alerts.getState(id);
      atWrite.push({ status, todo });
    };
    bridge.provider.writePty('pty-1', 'y');
    expect(atWrite).toEqual([{ status: 'WATCHING_DISABLED', todo: false }]);
  });

  it('gives a Client\'s repaint bounce the resize grace', () => {
    const onResize = vi.spyOn(alerts, 'onResize');
    bridge.provider.resizePty('pty-1', 80, 24, true);
    expect(onResize).toHaveBeenCalledWith('pty-1');
    expect(resized).toEqual([{ id: 'pty-1', cols: 80, rows: 24, repaint: true }]);
  });

  it('writes and resizes straight through to the manager', () => {
    bridge.provider.writePty('pty-1', 'ls\r');
    bridge.provider.resizePty('pty-1', 80, 24);
    expect(written).toEqual([{ id: 'pty-1', data: 'ls\r' }]);
    expect(resized).toEqual([{ id: 'pty-1', cols: 80, rows: 24 }]);
    bridge.provider.resizePty('pty-1', 80, 24, true);
    expect(resized[1]).toEqual({ id: 'pty-1', cols: 80, rows: 24, repaint: true });
  });

  it('routes output by id, parsed', () => {
    const one = sink();
    const two = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.provider.streamPty('pty-2', two);

    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]133;A\x07$ ` });
    expect(one.data).toEqual(['$ ']);
    expect(two.data).toEqual([]);
  });

  it('carries the text projection only when it differs from the renderer one', () => {
    const one = sink();
    bridge.provider.streamPty('pty-1', one);

    bridge.onPtyEvent('data', { id: 'pty-1', data: 'plain' });
    bridge.onPtyEvent('data', { id: 'pty-1', data: `pre\x1b]1337;File=inline=1:AAAA\x07post` });

    expect(one.chunks).toEqual([
      { data: 'plain' },
      { data: `pre\x1b]1337;File=inline=1:AAAA\x07post`, textData: 'prepost' },
    ]);
  });

  it('drops a chunk that was nothing but protocol', () => {
    const one = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]7;file:///tmp\x07' });
    expect(one.data).toEqual([]);
  });

  it('parses each PTY once, so a late joiner inherits the byte boundaries', () => {
    const one = sink();
    const two = sink();
    bridge.provider.streamPty('pty-1', one);
    // A second attachment starts mid-stream, after the OSC introducer. It
    // inherits the parser rather than starting a fresh one mid-sequence, so it
    // sees the same stripped output as the attachment that was there first.
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]133;' });
    bridge.provider.streamPty('pty-1', two);
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'A\x07hi' });

    expect(one.data).toEqual(['hi']);
    expect(two.data).toEqual(['hi']);
  });

  it('holds a sink that attached inside a forwarded image to the next ground byte', () => {
    const one = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]1337;File=inline=1:AAAA' });

    const late = sink();
    bridge.provider.streamPty('pty-1', late);
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'BBBB\x07after' });

    // The attachment that was there for the introducer renders the whole image;
    // the one that arrived mid-payload would have painted the base64 as text.
    expect(one.data).toEqual(['\x1b]1337;File=inline=1:AAAA', 'BBBB\x07after']);
    expect(late.data).toEqual(['after']);
  });

  it('keeps one PTY’s half-read sequence out of another’s', () => {
    const one = sink();
    const two = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.provider.streamPty('pty-2', two);

    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]133;' });
    bridge.onPtyEvent('data', { id: 'pty-2', data: 'plain' });
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'A\x07hi' });

    expect(one.data).toEqual(['hi']);
    expect(two.data).toEqual(['plain']);
  });

  it('reports an exit, defaulting a missing code to 0', () => {
    const one = sink();
    bridge.provider.streamPty('pty-1', one);
    bridge.onPtyEvent('exit', { id: 'pty-1', exitCode: 3 });
    bridge.provider.streamPty('pty-1', one);
    bridge.onPtyEvent('exit', { id: 'pty-1', signal: 'SIGTERM' });
    expect(one.exits).toEqual([3, 0]);
  });

  it('replays an exit that landed before the stream was installed', () => {
    // pty-core emits before removing the generation from its live map.
    bridge.onPtyEvent('exit', { id: 'pty-1', exitCode: 23 });
    livePtys.delete('pty-1');

    const late = sink();
    const subscription = bridge.provider.streamPty('pty-1', late);

    expect(late.exits).toEqual([23]);
    expect(() => subscription.stop()).not.toThrow();
  });

  it('does not replay an old exit after the PTY id is reused', () => {
    bridge.onPtyEvent('exit', { id: 'pty-1', exitCode: 23 });
    // The manager has already installed a fresh generation under the id.
    expect(livePtys.has('pty-1')).toBe(true);

    const replacement = sink();
    bridge.provider.streamPty('pty-1', replacement);
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'new generation' });

    expect(replacement.exits).toEqual([]);
    expect(replacement.data).toEqual(['new generation']);
  });

  it('stops delivering after unsubscribe', () => {
    const one = sink();
    const subscription = bridge.provider.streamPty('pty-1', one);
    subscription.stop();
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'x' });
    expect(one.data).toEqual([]);
  });

  it('does not let a spent unsubscribe silence the attachment that replaced it', () => {
    const first = sink();
    const subscription = bridge.provider.streamPty('pty-1', first);
    subscription.stop();

    const second = sink();
    bridge.provider.streamPty('pty-1', second);
    subscription.stop();

    bridge.onPtyEvent('data', { id: 'pty-1', data: 'still flowing' });
    expect(second.data).toEqual(['still flowing']);
    expect(first.data).toEqual([]);
  });

  it('ignores events with no id', () => {
    expect(() => bridge.onPtyEvent('data', { data: 'x' })).not.toThrow();
    expect(() => bridge.onPtyEvent('data', null)).not.toThrow();
  });
});

describe('the webview’s half of the parse', () => {
  it('sends the projection pair as pty:data, and nothing for an empty chunk', () => {
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'plain' });
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]1337;File=inline=1:AAAA\x07x` });
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]7;file:///tmp\x07' });

    expect(emitted('pty:data')).toEqual([
      { id: 'pty-1', data: 'plain' },
      { id: 'pty-1', data: `\x1b]1337;File=inline=1:AAAA\x07x`, textData: 'x' },
    ]);
  });

  it('parses a PTY nothing is attached to, because the webview is a consumer too', () => {
    bridge.onPtyEvent('data', { id: 'pty-9', data: `\x1b]0;title\x07hello` });
    expect(emitted('pty:data')).toEqual([{ id: 'pty-9', data: 'hello' }]);
    expect(emitted<{ id: string; events: unknown[] }>('terminal:semanticEvents')).toHaveLength(1);
  });

  it('keeps a report for the manager, forwarding only the semantic state it carries', () => {
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]9;Build finished\x07` });

    // The notification's title candidate is pane state; the report itself
    // rang the sidecar's manager and reaches no webview as an event.
    expect(sent.map((message) => message.event)).toEqual(['terminal:semanticEvents']);
    expect(alerts.getState('pty-1')).toMatchObject({
      status: 'ALERT_RINGING',
      notification: { source: 'OSC 9', title: null, body: 'Build finished' },
    });
  });

  it('feeds reports to the manager in stream order with the boundaries around them', async () => {
    // A precmd hook reports after the shell's finish, in the same read: judged
    // after the finish, the await resolves on the exit rather than the bell.
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]633;E;./build.sh\x07\x1b]633;C\x07' });
    const parked = alerts.awaitCompletion('pty-1', { until: 'quiet', timeoutMs: 600_000 });
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]633;D;0\x07\x1b]777;notify;Command completed;./build.sh\x1b\\' });
    await expect(parked.promise).resolves.toMatchObject({ kind: 'resolved', cause: 'exit' });
  });

  it('counts visible output as the Session working, and protocol alone as nothing', () => {
    const onData = vi.spyOn(alerts, 'onData');
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]7;file:///tmp\x07' });
    expect(onData).not.toHaveBeenCalled();
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'compiling…' });
    expect(onData).toHaveBeenCalledWith('pty-1');
  });

  it('tells the manager a PTY exited, stream or none', () => {
    const onExit = vi.spyOn(alerts, 'onExit');
    bridge.onPtyEvent('exit', { id: 'pty-9', exitCode: 3 });
    expect(onExit).toHaveBeenCalledWith('pty-9', 3);
  });

  it('forwards dirty state and command resets separately from serve metadata', () => {
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]367;state;{"v":1,"dirty":true}\x07\x1b]633;C\x07\x1b]367;state;{"v":1,"dirty":false}\x07' });
    expect(emitted<{ events: unknown[] }>('terminal:toolEvents')[0]?.events).toEqual([
      { kind: 'toolState', state: { dirty: true } },
      { kind: 'semantic', event: { type: 'commandStart', source: 'osc633_boundaries' } },
      { kind: 'toolState', state: { dirty: false } },
    ]);
  });

  it('preserves command-start resets between forwarded Tool announcements', () => {
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]367;serve;{"port":6006}\x07\x1b]633;C\x07\x1b]367;serve;{"port":6007}\x07' });
    expect(emitted<{ events: unknown[] }>('terminal:toolEvents')[0]?.events).toEqual([
      { kind: 'toolAnnounce', announce: { port: 6006, name: null, key: null, dehydrate: false, persist: null } },
      { kind: 'semantic', event: { type: 'commandStart', source: 'osc633_boundaries' } },
      { kind: 'toolAnnounce', announce: { port: 6007, name: null, key: null, dehydrate: false, persist: null } },
    ]);
  });

  it('still sends the chunk when the reply write throws', () => {
    // A PTY that died between the read and the reply write throws out of
    // `mgr.write`; the webview must still get what the parse produced.
    const noise = vi.spyOn(console, 'error').mockImplementation(() => {});
    bridge.setThemeColors({ foreground: '#ffffff', background: '#102030', cursor: '#abcdef' });
    writeThrows = true;

    expect(() =>
      bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]11;?\x07visible` }),
    ).not.toThrow();
    expect(emitted('pty:data')).toEqual([{ id: 'pty-1', data: 'visible' }]);
    noise.mockRestore();
  });

  it('never forwards a response — the owner writes it to the PTY itself', () => {
    bridge.setThemeColors({ foreground: '#ffffff', background: '#102030', cursor: '#abcdef' });
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]11;?\x07` });

    expect(written).toEqual([{ id: 'pty-1', data: `\x1b]11;rgb:1010/2020/3030\x1b\\` }]);
    expect(sent).toEqual([]);
  });

  it('leaves a colour query for xterm.js until the webview has pushed a theme', () => {
    // Null before the first push, exactly as the VS Code burrow documents.
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]11;?\x07` });
    expect(written).toEqual([]);
    expect(emitted('pty:data')).toEqual([
      // Declined, so the query stays in the renderer projection — and out of
      // the text one, like every other string control.
      { id: 'pty-1', data: `\x1b]11;?\x07`, textData: '' },
    ]);
  });

  it('ignores a malformed theme push rather than half-applying it', () => {
    bridge.setThemeColors({ foreground: '#ffffff' });
    bridge.setThemeColors(null);
    bridge.onPtyEvent('data', { id: 'pty-1', data: `\x1b]11;?\x07` });
    expect(written).toEqual([]);
  });

  it('gives a reused id a parser of its own at spawn', () => {
    // Half of an OSC the previous generation never finished must not be spliced
    // onto the new PTY's first bytes.
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]133;' });
    bridge.onPtySpawn('pty-1');
    // The stale `pending` would have swallowed this whole chunk instead.
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'plain' });

    expect(emitted('pty:data')).toEqual([{ id: 'pty-1', data: 'plain' }]);
  });

  it('closes the sinks a respawn strands, rather than leaving them waiting', () => {
    // `pty-core` lets a spawn displace a live generation without killing it, and
    // the exit it eventually reports belongs to the stream that replaced this
    // one — so nothing else would ever tell this attachment its pane is gone.
    const attached = sink();
    bridge.provider.streamPty('pty-1', attached);
    bridge.onPtySpawn('pty-1');

    expect(attached.exits).toEqual([0]);
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'new generation' });
    expect(attached.data).toEqual([]);
  });

  it('starts a fresh parser after an exit', () => {
    bridge.onPtyEvent('data', { id: 'pty-1', data: '\x1b]133;' });
    bridge.onPtyEvent('exit', { id: 'pty-1', exitCode: 0 });
    bridge.onPtyEvent('data', { id: 'pty-1', data: 'plain' });

    expect(emitted('pty:data')).toEqual([{ id: 'pty-1', data: 'plain' }]);
  });
});

/**
 * Every PTY, alert and Burrow command the sidecar's bundle owns, as `main.js`
 * hands them over: the alerts see each PTY change in the order a host must
 * make it (`docs/specs/standalone.md` → "Alerts").
 */
describe('the sidecar host', () => {
  let host: SidecarHost;
  let out: Array<{ event: string; data: unknown }>;
  /** Each PTY-manager call, with the Session's alert state as the call landed. */
  let calls: Array<{ op: string; args: unknown[]; state?: Pick<AlertState, 'status' | 'todo'> }>;
  /** Run inside `mgr.spawn`, as `pty-core` reports a helper decision there. */
  let duringSpawn: ((id: string) => void) | null;

  const stateOf = (id: unknown) => {
    const { status, todo } = host.alerts.getState(id as string);
    return { status, todo };
  };
  const record = (op: string, id?: unknown) => (...args: unknown[]) =>
    void calls.push({ op, args, ...(id === undefined ? {} : { state: stateOf(args[0]) }) });
  const states = (id: string) => out
    .filter((line) => line.event === 'alert:state' && (line.data as { id: string }).id === id)
    .map((line) => line.data as AlertStateDetail);
  const command = (window: string | undefined, body: Record<string, unknown>) =>
    host.handleCommand('alert:command', window === undefined ? body : { ...body, window });

  beforeEach(() => {
    out = [];
    calls = [];
    duringSpawn = null;
    // The Burrow's memory-only store says so once.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    host = createSidecarHost({
      send: (event, data) => void out.push({ event, data }),
      mgr: {
        spawn: (id, options) => {
          calls.push({ op: 'spawn', args: [id, options], state: stateOf(id) });
          duringSpawn?.(id);
        },
        write: record('write', true),
        resize: record('resize', true),
        kill: record('kill'),
        gracefulKill: record('gracefulKill'),
        list: record('list'),
        hasPty: () => true,
      },
    });
  });

  afterEach(() => {
    host.dispose();
    vi.restoreAllMocks();
  });

  it('starts a spawned Session over from its persisted TODO, before the PTY spawns', () => {
    host.alerts.notifyFromProtocol('pty-1', REPORT);
    host.handleCommand('pty:spawn', {
      id: 'pty-1',
      options: { cols: 80, alert: { status: 'ALERT_RINGING', todo: true, notification: REPORT } },
    });
    // The reminder, never the ring; and `pty-core` never sees the alert.
    expect(calls).toEqual([{ op: 'spawn', args: ['pty-1', { cols: 80 }], state: { status: 'WATCHING_DISABLED', todo: true } }]);
    // The window learns it the way it learns every change.
    expect(states('pty-1').at(-1)).toMatchObject({ todo: true, notification: REPORT });
  });

  it('keeps a helper `pty-core` reports at its spawn inert', () => {
    duringSpawn = (id) => host.alerts.setHelper(id, true);
    host.handleCommand('pty:spawn', { id: 'helper-1', options: { helper: { parentId: 'pty-1', command: 'git status' } } });
    host.alerts.notifyFromProtocol('helper-1', REPORT);
    expect(states('helper-1')).toEqual([]);
  });

  it('acknowledges human input before its write, and nothing else that is written', () => {
    host.alerts.notifyFromProtocol('pty-1', REPORT);
    host.handleCommand('pty:input', { id: 'pty-1', data: '\x1b[I', paced: true });
    host.handleCommand('pty:input', { id: 'pty-1', data: 'y', userInput: true });
    expect(calls).toEqual([
      { op: 'write', args: ['pty-1', '\x1b[I', { paced: true }], state: { status: 'ALERT_RINGING', todo: true } },
      { op: 'write', args: ['pty-1', 'y', undefined], state: { status: 'WATCHING_DISABLED', todo: false } },
    ]);
  });

  it('opens the resize grace before the PTY resizes', () => {
    const graced: string[] = [];
    vi.spyOn(host.alerts, 'onResize').mockImplementation((id) => void graced.push(`grace ${id} after ${calls.length} calls`));
    host.handleCommand('pty:resize', { id: 'pty-1', cols: 100, rows: 30 });
    expect(graced).toEqual(['grace pty-1 after 0 calls']);
    expect(calls.map((call) => [call.op, call.args])).toEqual([['resize', ['pty-1', 100, 30, undefined]]]);
  });

  it('removes a killed Session\'s alert state', () => {
    host.alerts.notifyFromProtocol('pty-1', REPORT);
    host.handleCommand('pty:kill', { id: 'pty-1' });
    expect(host.alerts.has('pty-1')).toBe(false);
    expect(calls.map((call) => [call.op, call.args])).toEqual([['kill', ['pty-1']]]);
  });

  // Rust reaps what a closed window left behind. Its alert state goes with it,
  // and all that goes out for those Sessions is the empty state, which no
  // window can persist as a TODO — Rust drops it anyway, owner gone.
  it('leaves no alert state for the PTYs a closed window left, and kills them gracefully', () => {
    host.alerts.notifyFromProtocol('left-1', REPORT);
    host.alerts.toggleTodo('left-2');
    host.alerts.notifyFromProtocol('kept', REPORT);
    out = [];

    host.handleCommand('pty:reap', { ids: ['left-1', 'left-2', 7], timeout: 2000 });
    expect(host.alerts.has('left-1')).toBe(false);
    expect(host.alerts.has('left-2')).toBe(false);
    expect(host.alerts.has('kept')).toBe(true);
    expect(calls.map((call) => [call.op, call.args])).toEqual([['gracefulKill', [['left-1', 'left-2'], 2000]]]);
    for (const line of out) expect(line.data).toMatchObject({ todo: false, notification: null, status: 'WATCHING_DISABLED' });

    // The quit flush's kill is not a reap: its windows still own their PTYs.
    expect(host.handleCommand('pty:gracefulKill', { ids: ['kept'] })).toBe(false);
  });

  it('answers a window collecting its PTYs with their state, behind the list', () => {
    host.alerts.notifyFromProtocol('pty-1', REPORT);
    host.alerts.toggleTodo('pty-2');
    host.alerts.setHelper('helper-1', true);
    host.alerts.onData('helper-1');
    out = [];

    host.handleCommand('pty:requestInit', { ids: ['pty-1', 'never-seen', 'helper-1'], forWindow: 'main', requestId: 'r1' });
    expect(calls.map((call) => [call.op, call.args])).toEqual([['list', [['pty-1', 'never-seen', 'helper-1'], 'main', 'r1', undefined]]]);
    expect(out.map((line) => (line.data as { id: string }).id)).toEqual(['pty-1']);

    out = [];
    host.handleCommand('pty:requestInit', {});
    expect(out.map((line) => (line.data as { id: string }).id).sort()).toEqual(['pty-1', 'pty-2']);
  });

  it('answers an await to the window that parked it, by name', async () => {
    command('ws-2', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'quiet', timeoutMs: 600_000 });
    host.alerts.notifyFromProtocol('pty-1', REPORT);
    await Promise.resolve();
    const [result] = out.filter((line) => line.event === 'alert:awaitResult').map((line) => line.data);
    // Routed like `pty:list`: never by a Session `id`, never a `requestId`.
    expect(result).toEqual({ awaitId: 'await-1', forWindow: 'ws-2', outcome: expect.objectContaining({ cause: 'bell' }) });
  });

  it('ignores an alert command no host stamped', () => {
    command(undefined, { op: 'engagement', state: { present: true, focusId: 'pty-1' } });
    expect(host.alerts.viewerIds()).toEqual([]);
  });

  it('ends the realms of windows that went away', () => {
    command('main', { op: 'engagement', state: { present: true, focusId: 'pty-a' } });
    command('ws-2', { op: 'await', awaitId: 'await-ws2', id: 'pty-c', until: 'quiet', timeoutMs: 600_000 });
    host.handleCommand('burrow:windows', { labels: ['main'] });
    expect(out.filter((line) => line.event === 'alert:awaitResult').map((line) => line.data)).toEqual([
      { awaitId: 'await-ws2', forWindow: 'ws-2', outcome: expect.objectContaining({ kind: 'cancelled' }) },
    ]);
    expect(host.alerts.viewerIds()).toEqual(['main']);
  });

  it('re-sends every Session\'s state and both stores to a window that asks to sync', () => {
    command('main', { op: 'initializeWatchedCommands', names: ['npm test'] });
    command('main', { op: 'initializeSettings', settings: {} });
    host.alerts.notifyFromProtocol('pty-1', REPORT);
    out = [];
    command('main', { op: 'sync' });
    expect(out.map((line) => line.event).sort()).toEqual(['alert:settings', 'alert:state', 'alert:watchedCommands']);
  });

  /**
   * The whole path a reload takes, with a real client: the manager never lived
   * in the webview, so a reloaded window gets its rings and TODOs back from the
   * answer to its collection, without seeding.
   */
  it('gives a reloaded window its rings and TODOs back', () => {
    const open = () => {
      const realm = createAlertClient((body) => command('main', body as Record<string, unknown>));
      const seen = new Map<string, AlertStateDetail>();
      realm.methods.onAlertState((detail) => void seen.set(detail.id, detail));
      return { realm, seen };
    };
    const before = open();
    before.realm.methods.alertEngagement({ present: true, focusId: 'watched' });
    host.alerts.notifyFromProtocol('ringing', REPORT);
    before.realm.methods.alertToggleTodo('flagged');

    const after = open();
    after.realm.hello();
    out = [];
    host.handleCommand('pty:requestInit', { ids: ['ringing', 'flagged'], forWindow: 'main' });
    for (const line of out) after.realm.onEvent(line.event, line.data);

    expect(after.seen.get('ringing')).toMatchObject({ status: 'ALERT_RINGING', todo: true });
    expect(after.seen.get('flagged')).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });
  });

  it('leaves every other command to main.js', () => {
    expect(host.handleCommand('pty:getCwd', { id: 'pty-1' })).toBe(false);
    expect(calls).toEqual([]);
  });
});
