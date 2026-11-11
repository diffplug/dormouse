import { describe, expect, it } from 'vitest';
import { PTY_HIGH_WATERMARK_CHARS, PTY_LOW_WATERMARK_CHARS } from '../lib/pty-flow';
import { createPtyFlowControl } from './pty-flow-host';

function flowWithCalls() {
  const calls: string[] = [];
  const flow = createPtyFlowControl({
    pause: (id) => void calls.push(`pause ${id}`),
    resume: (id) => void calls.push(`resume ${id}`),
  });
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
