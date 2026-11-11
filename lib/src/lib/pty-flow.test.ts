import { describe, expect, it, vi } from 'vitest';
import type { PlatformAdapter, PtyDataHandler } from './platform/types';
import {
  PTY_ACK_BATCH_CHARS,
  PTY_HIGH_WATERMARK_CHARS,
  PTY_LOW_WATERMARK_CHARS,
  PtyDataDispatch,
} from './pty-flow';

// Compile-time: an optional member would let an adapter forget it, and its
// PTYs would pause at the first flood and never resume.
const acknowledgeIsRequired: {} extends Pick<PlatformAdapter, 'acknowledgePtyData'> ? never : true = true;

function dispatchWithAcks() {
  const acks: Array<[string, number]> = [];
  const dispatch = new PtyDataDispatch((id, chars) => void acks.push([id, chars]));
  return { acks, dispatch };
}

describe('the flow constants', () => {
  it('leave a parsed residue below one batch unable to hold a PTY paused', () => {
    expect(acknowledgeIsRequired).toBe(true);
    expect(PTY_ACK_BATCH_CHARS - 1).toBeLessThanOrEqual(PTY_LOW_WATERMARK_CHARS);
    expect(PTY_LOW_WATERMARK_CHARS).toBeLessThan(PTY_HIGH_WATERMARK_CHARS);
  });
});

describe('PtyDataDispatch', () => {
  it('acknowledges a claimed chunk only once its parse completes, in whole batches', () => {
    const { acks, dispatch } = dispatchWithAcks();
    const parsed: Array<() => void> = [];
    dispatch.add((_detail, claim) => void parsed.push(claim!()));

    dispatch.deliver({ id: 'a', data: 'x'.repeat(PTY_ACK_BATCH_CHARS - 1) });
    dispatch.deliver({ id: 'a', data: 'xy' });
    expect(acks).toEqual([]);
    parsed[0]();
    expect(acks).toEqual([]);
    parsed[1]();
    expect(acks).toEqual([['a', PTY_ACK_BATCH_CHARS + 1]]);
    // The callback is idempotent: a second call never pays twice.
    parsed[1]();
    expect(acks).toEqual([['a', PTY_ACK_BATCH_CHARS + 1]]);
  });

  it('keeps each id’s residue apart', () => {
    const { acks, dispatch } = dispatchWithAcks();
    dispatch.add((_detail, claim) => claim!()());
    dispatch.deliver({ id: 'a', data: 'x'.repeat(PTY_ACK_BATCH_CHARS - 1) });
    dispatch.deliver({ id: 'b', data: 'x'.repeat(PTY_ACK_BATCH_CHARS - 1) });
    expect(acks).toEqual([]);
    dispatch.deliver({ id: 'a', data: 'x' });
    expect(acks).toEqual([['a', PTY_ACK_BATCH_CHARS]]);
  });

  it('acknowledges at once a chunk no handler claimed', () => {
    const { acks, dispatch } = dispatchWithAcks();
    const seen = vi.fn();
    dispatch.add(seen);
    dispatch.deliver({ id: 'a', data: 'abc' });
    expect(seen).toHaveBeenCalledOnce();
    expect(acks).toEqual([['a', 3]]);
  });

  it('runs every handler past one that throws, and settles a claim the thrower took', () => {
    const { acks, dispatch } = dispatchWithAcks();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    const thrower: PtyDataHandler = (_detail, claim) => {
      claim!();
      throw new Error('boom');
    };
    dispatch.add(thrower);
    dispatch.add(after);
    expect(() => dispatch.deliver({ id: 'a', data: 'x'.repeat(PTY_ACK_BATCH_CHARS) })).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(acks).toEqual([['a', PTY_ACK_BATCH_CHARS]]);
    error.mockRestore();
  });

  it('never throws into xterm’s write loop when the acknowledgement does', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispatch = new PtyDataDispatch(() => { throw new Error('transport gone'); });
    let parsed: (() => void) | undefined;
    dispatch.add((_detail, claim) => { parsed = claim!(); });
    dispatch.deliver({ id: 'a', data: 'x'.repeat(PTY_ACK_BATCH_CHARS) });
    expect(() => parsed!()).not.toThrow();
    error.mockRestore();
  });
});
