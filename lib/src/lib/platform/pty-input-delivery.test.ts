import { describe, it, expect, vi } from 'vitest';
import { deliverPtyInput } from './pty-input-delivery';

describe('input delivery cancellation', () => {
  it('cancels exactly the submitted batch and settles before its eventual receipt', async () => {
    const controller = new AbortController();
    let finish!: (value: { delivered: true }) => void;
    const send = vi.fn((_inputId: string) => new Promise<{ delivered: true }>(resolve => { finish = resolve; }));
    const cancel = vi.fn();
    const pending = deliverPtyInput(send, cancel, controller.signal);
    const rejected = expect(pending).rejects.toThrow(/some input may have been delivered/);
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledExactlyOnceWith(send.mock.calls[0][0]);
    finish({ delivered: true });
  });
  it('does not submit an already-cancelled request', async () => {
    const send = vi.fn();
    const cancel = vi.fn();
    await expect(deliverPtyInput(send, cancel, AbortSignal.abort())).rejects.toThrow(/cancelled/);
    expect(send).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });
  it('removes the cancellation listener after delivery', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    await deliverPtyInput(async () => ({ delivered: true }), cancel, controller.signal);
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  });
});
