import { describe, expect, it } from 'vitest';
import { IframeLeaseOrder } from './iframe-lease-order';

describe('IframeLeaseOrder', () => {
  it('sends a release only once every create of its lease has been answered', async () => {
    const order = new IframeLeaseOrder();
    const sent: string[] = [];
    let answer!: () => void;
    const created = order.create('a', () => new Promise<void>((resolve) => { sent.push('create a'); answer = resolve; }));
    order.release('a', () => sent.push('release a'));
    order.release('b', () => sent.push('release b'));
    await Promise.resolve();
    expect(sent).toEqual(['release b', 'create a']);
    answer();
    await created;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual(['release b', 'create a', 'release a']);
  });

  it('holds every create until the boot reset is sent', async () => {
    const order = new IframeLeaseOrder();
    const sent: string[] = [];
    let resetDone!: () => void;
    order.reset = new Promise<void>((resolve) => { resetDone = () => { sent.push('reset'); resolve(); }; });
    const created = order.create('a', async () => { sent.push('create a'); });
    await Promise.resolve();
    expect(sent).toEqual([]);
    resetDone();
    await created;
    expect(sent).toEqual(['reset', 'create a']);
  });
});
