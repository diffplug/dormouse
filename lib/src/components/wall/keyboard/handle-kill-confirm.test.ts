// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { handleKillConfirm } from './handle-kill-confirm';
import type { WallKeyboardCtx } from './types';

function context() {
  return { confirmKillRef: { current: { char: 'q' } }, acceptKill: vi.fn(), rejectKill: vi.fn() } as unknown as WallKeyboardCtx;
}

describe('pane kill answers', () => {
  it.each([
    { key: 'q', metaKey: true }, { key: 'q', ctrlKey: true }, { key: 'q', altKey: true },
    { key: 'Meta' }, { key: 'Control' }, { key: 'Alt' }, { key: 'Shift' },
  ])('leaves modifier/chord %j unanswered and available to the host', init => {
    const ctx = context();
    const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
    expect(handleKillConfirm(event, ctx)).toBe(true);
    expect(ctx.acceptKill).not.toHaveBeenCalled();
    expect(ctx.rejectKill).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it.each([{ key: 'q' }, { key: 'Q' }, { key: 'Q', shiftKey: true }])('accepts the typed letter %j', init => {
    const ctx = context();
    const event = new KeyboardEvent('keydown', { ...init, cancelable: true });
    expect(handleKillConfirm(event, ctx)).toBe(true);
    expect(ctx.acceptKill).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('cancels on another ordinary key', () => {
    const ctx = context();
    handleKillConfirm(new KeyboardEvent('keydown', { key: 'Escape' }), ctx);
    expect(ctx.rejectKill).toHaveBeenCalledOnce();
  });
});
