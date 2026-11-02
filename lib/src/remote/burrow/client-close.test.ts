import { describe, expect, it } from 'vitest';
import type { SurfaceCloseResult } from 'remote-lib-common';
import { answerClientClose, registerClientCloser } from './client-close';

const flush = () => new Promise((resolve) => setTimeout(resolve));

function closer(owned: string) {
  let settle: (result: SurfaceCloseResult) => void = () => {};
  const asked: unknown[] = [];
  const unregister = registerClientCloser({
    owns: (id) => id === owned,
    close: (_id, consent) => {
      asked.push(consent);
      return new Promise((resolve) => { settle = resolve; });
    },
  });
  return { asked, unregister, settle: (result: SurfaceCloseResult) => settle(result) };
}

describe('answerClientClose', () => {
  it('claims nothing for a surface another window owns, or a poll of no close', () => {
    const c = closer('surface:1');
    expect(answerClientClose({ surfaceId: 'surface:2' })).toEqual([]);
    expect(answerClientClose({ surfaceId: 'surface:1', poll: true })).toEqual([]);
    c.unregister();
  });

  it('starts one close, answers pending, then gives its outcome once', async () => {
    const c = closer('surface:1');
    expect(answerClientClose({ surfaceId: 'surface:1', confirmed: true })).toEqual([{ outcome: 'pending' }]);
    expect(answerClientClose({ surfaceId: 'surface:1', confirmed: true })).toEqual([{ outcome: 'pending' }]);
    expect(c.asked).toEqual([{ confirmed: true, unsaved: undefined }]);
    c.settle({ outcome: 'closed' });
    await flush();
    expect(answerClientClose({ surfaceId: 'surface:1', poll: true })).toEqual([{ outcome: 'closed' }]);
    expect(answerClientClose({ surfaceId: 'surface:1', poll: true })).toEqual([]);
    c.unregister();
  });

  it('never answers a new close with one nobody polled for', async () => {
    const c = closer('surface:1');
    answerClientClose({ surfaceId: 'surface:1' });
    c.settle({ outcome: 'confirm' });
    await flush();
    expect(answerClientClose({ surfaceId: 'surface:1', confirmed: true })).toEqual([{ outcome: 'pending' }]);
    expect(c.asked).toHaveLength(2);
    c.settle({ outcome: 'closed' });
    await flush();
    answerClientClose({ surfaceId: 'surface:1', poll: true });
    c.unregister();
  });

  it('reports a close that threw as refused', async () => {
    const unregister = registerClientCloser({ owns: () => true, close: () => Promise.reject(new Error('boom')) });
    answerClientClose({ surfaceId: 'surface:9' });
    await flush();
    expect(answerClientClose({ surfaceId: 'surface:9', poll: true })).toEqual([{ outcome: 'refused', message: 'boom' }]);
    unregister();
  });
});
