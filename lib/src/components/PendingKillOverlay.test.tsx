/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetPendingKillsForTesting, addPendingKill, getPendingKills } from '../lib/pending-kills';
import { PendingKillOverlay } from './PendingKillOverlay';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PendingKillOverlay />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  _resetPendingKillsForTesting();
});

function pend(id: string) {
  const actions = { restore: vi.fn(), finalize: vi.fn() };
  act(() => addPendingKill({ kind: 'surface', id, workspaceId: 'ws', title: `title ${id}`, label: 'Terminal' }, actions));
  return actions;
}

const entries = () => [...container.querySelectorAll<HTMLElement>('[data-pending-kill]')];

describe('PendingKillOverlay', () => {
  it('shows the newest three on top and collapses the rest to a +N row', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const id of ['a', 'b', 'c', 'd', 'e']) { vi.advanceTimersByTime(5); pend(id); }
    } finally { vi.useRealTimers(); }
    expect(entries().map(entry => entry.dataset.pendingKill)).toEqual(['surface:e', 'surface:d', 'surface:c']);
    expect(container.textContent).toContain('+2');
    expect(entries()[0].textContent).toContain('title e');
    expect(entries()[0].textContent).toContain('Terminal');
  });

  it('restores on a click and kills at once from its own button', () => {
    const a = pend('a');
    const b = pend('b');
    act(() => entries().find(entry => entry.dataset.pendingKill === 'surface:a')!.querySelector<HTMLButtonElement>('button[title="Restore"]')!.click());
    expect(a.restore).toHaveBeenCalledWith(true);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Kill now"]')!.click());
    expect(b.finalize).toHaveBeenCalledTimes(1);
    expect(container.querySelector('ol')).toBeNull();
  });

  it('keeps its top edge put while the pointer is over it, as older entries finalize below', () => {
    pend('a');
    const list = container.querySelector<HTMLElement>('ol')!;
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue({ height: 120 } as DOMRect);
    act(() => list.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, relatedTarget: document.body })));
    expect(list.style.minHeight).toBe('120px');
    act(() => list.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })));
    expect(list.style.minHeight).toBe('');
  });

  it('holds an entry\'s countdown while the pointer rests on it', () => {
    pend('a');
    const entry = entries()[0];
    act(() => entry.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
    expect(getPendingKills()[0].resumedAt).toBeNull();
    act(() => entry.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })));
    expect(getPendingKills()[0].resumedAt).not.toBeNull();
  });
});
