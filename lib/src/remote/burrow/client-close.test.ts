import { describe, expect, it, vi } from 'vitest';
import { answerClientClose, registerClientCloser } from './client-close';

describe('answerClientClose', () => {
  it('claims nothing for a surface another window owns', async () => {
    const close = vi.fn();
    const unregister = registerClientCloser({ owns: (id) => id === 'surface:1', close });
    expect(await answerClientClose({ surfaceId: 'surface:2' })).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    unregister();
  });

  it('answers with the owning Wall\'s outcome, passing on the consent', async () => {
    const close = vi.fn(async () => ({ outcome: 'closed' as const }));
    const unregister = registerClientCloser({ owns: () => true, close });
    expect(await answerClientClose({ surfaceId: 'surface:1', confirmed: true })).toEqual([{ outcome: 'closed' }]);
    expect(close).toHaveBeenCalledWith('surface:1', { confirmed: true, unsaved: undefined });
    unregister();
  });

  it('reports a close that threw as refused', async () => {
    const unregister = registerClientCloser({ owns: () => true, close: () => Promise.reject(new Error('boom')) });
    expect(await answerClientClose({ surfaceId: 'surface:1' })).toEqual([{ outcome: 'refused', message: 'boom' }]);
    unregister();
  });
});
