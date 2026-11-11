import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PTY_ACK_WATCHDOG_MS,
  PTY_HIGH_WATERMARK_CHARS,
  PTY_INPUT_CEILING_CHARS,
  PTY_INPUT_GRACE_MS,
  PTY_LOW_WATERMARK_CHARS,
  PTY_PAUSED_PEEK_MS,
} from '../lib/pty-flow';
import { createPtyFlowControl } from './pty-flow-host';

function flowWithCalls(platform = 'linux') {
  const calls: string[] = [];
  const flow = createPtyFlowControl({
    pause: (id) => void calls.push(`pause ${id}`),
    resume: (id) => void calls.push(`resume ${id}`),
  }, { platform });
  return { calls, flow };
}

describe('createPtyFlowControl', () => {
  it('pauses once past the high watermark and resumes at the low one', () => {
    const { calls, flow } = flowWithCalls();
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS);
    expect(calls).toEqual([]);
    flow.sent('a', 1);
    flow.sent('a', 1000);
    expect(calls).toEqual(['pause a']);

    flow.acknowledge('a', PTY_HIGH_WATERMARK_CHARS + 1001 - PTY_LOW_WATERMARK_CHARS - 1);
    expect(calls).toEqual(['pause a']);
    flow.acknowledge('a', 1);
    expect(flow.unacknowledged('a')).toBe(PTY_LOW_WATERMARK_CHARS);
    expect(calls).toEqual(['pause a', 'resume a']);
    flow.acknowledge('a', PTY_LOW_WATERMARK_CHARS);
    expect(calls).toEqual(['pause a', 'resume a']);
  });

  it('keeps each PTY’s count apart', () => {
    const { calls, flow } = flowWithCalls();
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.sent('b', PTY_HIGH_WATERMARK_CHARS);
    expect(calls).toEqual(['pause a']);
    expect(flow.unacknowledged('b')).toBe(PTY_HIGH_WATERMARK_CHARS);
  });

  it('ignores a malformed acknowledgement, and one for nothing owed', () => {
    const { calls, flow } = flowWithCalls();
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    for (const bad of [-5, 0, 1.5, Number.NaN, Infinity, '9', null, undefined, 2 ** 60]) flow.acknowledge('a', bad);
    expect(flow.unacknowledged('a')).toBe(PTY_HIGH_WATERMARK_CHARS + 1);
    flow.acknowledge('never-sent', 10);
    expect(flow.unacknowledged('never-sent')).toBe(0);
    expect(calls).toEqual(['pause a']);
  });

  it('never owes less than nothing: an acknowledgement for output sent before a reset is clamped', () => {
    const { flow } = flowWithCalls();
    flow.sent('a', 10);
    flow.acknowledge('a', 50);
    expect(flow.unacknowledged('a')).toBe(0);
  });

  it('forgives and resumes on reset, the named ids or every one', () => {
    const { calls, flow } = flowWithCalls();
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.sent('b', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.sent('c', 7);
    flow.reset(['a']);
    expect(calls).toEqual(['pause a', 'pause b', 'resume a']);
    expect(flow.unacknowledged('a')).toBe(0);
    expect(flow.unacknowledged('b')).toBe(PTY_HIGH_WATERMARK_CHARS + 1);

    flow.reset();
    expect(calls).toEqual(['pause a', 'pause b', 'resume a', 'resume b']);
    expect(flow.unacknowledged('b')).toBe(0);
    expect(flow.unacknowledged('c')).toBe(0);
    // An empty list names nothing: it is not every PTY.
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.reset([]);
    expect(flow.unacknowledged('a')).toBe(PTY_HIGH_WATERMARK_CHARS + 1);
  });

  it('forgets a PTY that is gone without resuming it', () => {
    const { calls, flow } = flowWithCalls();
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.forget('a');
    flow.acknowledge('a', PTY_HIGH_WATERMARK_CHARS);
    flow.reset(['a']);
    expect(calls).toEqual(['pause a']);
    // A later generation under the id starts from nothing.
    flow.sent('a', 1);
    expect(flow.unacknowledged('a')).toBe(1);
  });
});

// ConPTY takes no input while its output is blocked, so on Windows input
// resumes a paused PTY for a grace, within a ceiling (docs/specs/transport.md
// -> "Output flow control").
describe('input to a paused PTY', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resumes it on Windows, and pauses it again a grace after the last input', () => {
    vi.useFakeTimers();
    const { calls, flow } = flowWithCalls('win32');
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.input('a');
    expect(calls).toEqual(['pause a', 'resume a']);
    // Read during the grace, counted like any other, and not paused at the high mark.
    flow.sent('a', 300_000);
    vi.advanceTimersByTime(PTY_INPUT_GRACE_MS - 1);
    // More input extends the grace.
    flow.input('a');
    vi.advanceTimersByTime(PTY_INPUT_GRACE_MS - 1);
    expect(calls).toEqual(['pause a', 'resume a']);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a']);
    expect(flow.unacknowledged('a')).toBe(PTY_HIGH_WATERMARK_CHARS + 300_001);
  });

  it('stays resumed after the grace when the renderer caught up meanwhile', () => {
    vi.useFakeTimers();
    const { calls, flow } = flowWithCalls('win32');
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.input('a');
    flow.acknowledge('a', PTY_HIGH_WATERMARK_CHARS);
    vi.advanceTimersByTime(PTY_INPUT_GRACE_MS);
    expect(calls).toEqual(['pause a', 'resume a']);
  });

  it('never holds the PTY open past the ceiling, and resumes nothing at it', () => {
    vi.useFakeTimers();
    const { calls, flow } = flowWithCalls('win32');
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.input('a');
    flow.sent('a', PTY_INPUT_CEILING_CHARS - PTY_HIGH_WATERMARK_CHARS - 2);
    expect(calls).toEqual(['pause a', 'resume a']);
    flow.sent('a', 1);
    expect(flow.unacknowledged('a')).toBe(PTY_INPUT_CEILING_CHARS);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a']);
    flow.input('a');
    vi.advanceTimersByTime(PTY_INPUT_GRACE_MS * 4);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a']);
    // Once the renderer catches up it resumes as ever.
    flow.acknowledge('a', PTY_INPUT_CEILING_CHARS - PTY_LOW_WATERMARK_CHARS);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a', 'resume a']);
  });

  it('does nothing on POSIX, where the line discipline delivers it to the blocked program', () => {
    vi.useFakeTimers();
    for (const platform of ['darwin', 'linux']) {
      const typed = flowWithCalls(platform);
      const untyped = flowWithCalls(platform);
      for (const { flow } of [typed, untyped]) flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
      typed.flow.input('a');
      vi.advanceTimersByTime(PTY_INPUT_GRACE_MS * 2);
      expect(typed.calls).toEqual(untyped.calls);
      for (const { flow } of [typed, untyped]) flow.reset();
    }
  });

  it('does nothing to a PTY that is flowing, and a reset or kill ends a grace', () => {
    vi.useFakeTimers();
    const { calls, flow } = flowWithCalls('win32');
    flow.sent('a', 10);
    flow.input('a');
    flow.sent('b', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.input('b');
    flow.forget('b');
    flow.sent('c', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.input('c');
    flow.reset(['c']);
    flow.sent('c', 1);
    vi.advanceTimersByTime(PTY_INPUT_GRACE_MS * 2);
    expect(calls).toEqual(['pause b', 'resume b', 'pause c', 'resume c']);
  });
});

// macOS discards an exiting program's unread output past about 1 KB, so a
// paused PTY there is read once every peek (docs/specs/transport.md ->
// "Output flow control").
describe('a paused PTY on macOS', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is resumed for one read every peek, which counts like any other', () => {
    vi.useFakeTimers();
    const { calls, flow } = flowWithCalls('darwin');
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    vi.advanceTimersByTime(PTY_PAUSED_PEEK_MS - 1);
    expect(calls).toEqual(['pause a']);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['pause a', 'resume a']);
    // Nothing to read yet: it stays open until the read comes.
    vi.advanceTimersByTime(PTY_PAUSED_PEEK_MS * 3);
    expect(calls).toEqual(['pause a', 'resume a']);
    flow.sent('a', 1024);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a']);
    expect(flow.unacknowledged('a')).toBe(PTY_HIGH_WATERMARK_CHARS + 1025);
    vi.advanceTimersByTime(PTY_PAUSED_PEEK_MS);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a', 'resume a']);
  });

  it('stops peeking at the ceiling, and once the renderer catches up', () => {
    vi.useFakeTimers();
    const { calls, flow } = flowWithCalls('darwin');
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    vi.advanceTimersByTime(PTY_PAUSED_PEEK_MS);
    flow.sent('a', PTY_INPUT_CEILING_CHARS - PTY_HIGH_WATERMARK_CHARS - 1);
    vi.advanceTimersByTime(PTY_PAUSED_PEEK_MS * 4);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a']);
    flow.acknowledge('a', PTY_INPUT_CEILING_CHARS - PTY_LOW_WATERMARK_CHARS);
    vi.advanceTimersByTime(PTY_PAUSED_PEEK_MS * 4);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a', 'resume a']);
  });

  it('peeks on no other platform, and a reset or kill ends the peeks', () => {
    vi.useFakeTimers();
    const linux = flowWithCalls('linux');
    linux.flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    vi.advanceTimersByTime(PTY_PAUSED_PEEK_MS * 4);
    expect(linux.calls).toEqual(['pause a']);
    const mac = flowWithCalls('darwin');
    mac.flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    mac.flow.sent('b', PTY_HIGH_WATERMARK_CHARS + 1);
    mac.flow.reset(['a']);
    mac.flow.forget('b');
    vi.advanceTimersByTime(PTY_PAUSED_PEEK_MS * 4);
    expect(mac.calls).toEqual(['pause a', 'pause b', 'resume a']);
  });
});


// A PTY never stays paused because its renderer stopped acknowledging
// (docs/specs/transport.md -> "Output flow control").
describe('a paused PTY nobody acknowledges', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const silence = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

  it('is forgiven and resumed once the watchdog period passes, logged once per episode', () => {
    vi.useFakeTimers();
    const warn = silence();
    const { calls, flow } = flowWithCalls();
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    vi.advanceTimersByTime(PTY_ACK_WATCHDOG_MS - 1);
    expect(calls).toEqual(['pause a']);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(['pause a', 'resume a']);
    expect(flow.unacknowledged('a')).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);

    // It runs to the high watermark again, and the watchdog re-arms for that pause.
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    vi.advanceTimersByTime(PTY_ACK_WATCHDOG_MS);
    expect(calls).toEqual(['pause a', 'resume a', 'pause a', 'resume a']);
    expect(warn).toHaveBeenCalledTimes(1);

    // An acknowledgement ends the episode: the next firing is logged again.
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 2);
    flow.acknowledge('a', 1);
    vi.advanceTimersByTime(PTY_ACK_WATCHDOG_MS);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('restarts its clock at any acknowledgement, so a slow renderer never trips it', () => {
    vi.useFakeTimers();
    silence();
    const { calls, flow } = flowWithCalls();
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(PTY_ACK_WATCHDOG_MS - 1);
      flow.acknowledge('a', 1);
    }
    expect(calls).toEqual(['pause a']);
    vi.advanceTimersByTime(PTY_ACK_WATCHDOG_MS);
    expect(calls).toEqual(['pause a', 'resume a']);
  });

  it('is cancelled by a kill, and by every reset', () => {
    vi.useFakeTimers();
    const warn = silence();
    const { calls, flow } = flowWithCalls();
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.sent('b', PTY_HIGH_WATERMARK_CHARS + 1);
    flow.forget('a');
    flow.reset(['b']);
    flow.sent('b', PTY_HIGH_WATERMARK_CHARS);
    // A spawn over the killed id, paused halfway through the old period.
    vi.advanceTimersByTime(PTY_ACK_WATCHDOG_MS / 2);
    flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    vi.advanceTimersByTime(PTY_ACK_WATCHDOG_MS - 1);
    expect(calls).toEqual(['pause a', 'pause b', 'resume b', 'pause a']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('is held off by neither the macOS peeks nor the Windows input grace', () => {
    vi.useFakeTimers();
    silence();
    const mac = flowWithCalls('darwin');
    const win = flowWithCalls('win32');
    for (const { flow } of [mac, win]) flow.sent('a', PTY_HIGH_WATERMARK_CHARS + 1);
    let elapsed = 0;
    while (elapsed + PTY_INPUT_GRACE_MS * 2 < PTY_ACK_WATCHDOG_MS) {
      // Each peek reads a little and re-pauses; each input resumes for a grace
      // that ends paused again, past the high watermark.
      win.flow.input('a');
      for (const { flow } of [mac, win]) flow.sent('a', 1024);
      vi.advanceTimersByTime(PTY_INPUT_GRACE_MS * 2);
      elapsed += PTY_INPUT_GRACE_MS * 2;
    }
    for (const { flow } of [mac, win]) expect(flow.unacknowledged('a')).toBeGreaterThan(PTY_HIGH_WATERMARK_CHARS);
    vi.advanceTimersByTime(PTY_ACK_WATCHDOG_MS - elapsed);
    for (const { calls, flow } of [mac, win]) {
      expect(flow.unacknowledged('a')).toBe(0);
      expect(calls.at(-1)).toBe('resume a');
    }
  });
});
