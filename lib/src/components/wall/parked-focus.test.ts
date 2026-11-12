// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PARKED_FOCUS_POLL_MS, parkedFocusHolder, watchParkedFocus } from './parked-focus';

/** A leaf as LathHost renders it, holding one framed page. */
function leaf(id: string, parked: boolean): HTMLIFrameElement {
  const el = document.body.appendChild(document.createElement('div'));
  el.dataset.lathLeaf = id;
  if (parked) el.dataset.lathParked = '';
  return el.appendChild(document.createElement('iframe'));
}

describe('parked focus', () => {
  const parked = new Set<string>();
  const isParked = (id: string) => parked.has(id);
  let parkedFrame: HTMLIFrameElement;
  let visibleFrame: HTMLIFrameElement;

  beforeEach(() => {
    vi.useFakeTimers();
    parked.clear();
    parked.add('surface:p');
    parkedFrame = leaf('surface:p', true);
    visibleFrame = leaf('surface:v', false);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it('names only a focused element inside a leaf the store still holds parked', () => {
    parkedFrame.focus();
    expect(parkedFocusHolder(isParked)).toBe(parkedFrame);
    visibleFrame.focus();
    expect(parkedFocusHolder(isParked)).toBeNull();
    // A restore unparks in the store before its own focus call reaches the page.
    parkedFrame.focus();
    parked.clear();
    expect(parkedFocusHolder(isParked)).toBeNull();
  });

  it('names a focused element inside a hidden Workspace, parked or not', () => {
    const hidden = document.body.appendChild(document.createElement('div'));
    hidden.dataset.workspaceActive = 'false';
    const frame = hidden.appendChild(document.createElement('iframe'));
    frame.focus();
    expect(parkedFocusHolder(isParked)).toBe(frame);
    hidden.dataset.workspaceActive = 'true';
    expect(parkedFocusHolder(isParked)).toBeNull();
  });

  it('takes focus out of a frame in a hidden Workspace on its poll', () => {
    const refocus = vi.fn();
    const hidden = document.body.appendChild(document.createElement('div'));
    hidden.dataset.workspaceActive = 'false';
    const frame = hidden.appendChild(document.createElement('iframe'));
    const stop = watchParkedFocus(isParked, refocus);
    try {
      frame.focus();
      vi.advanceTimersByTime(PARKED_FOCUS_POLL_MS);
      expect(document.activeElement).toBe(document.body);
      expect(refocus).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it('takes focus out of a parked frame one task after the window blurs, never inside the handler', () => {
    const refocus = vi.fn();
    const stop = watchParkedFocus(isParked, refocus);
    try {
      parkedFrame.focus();
      window.dispatchEvent(new FocusEvent('blur'));
      expect(document.activeElement).toBe(parkedFrame);
      expect(refocus).not.toHaveBeenCalled();
      vi.advanceTimersByTime(0);
      expect(document.activeElement).toBe(document.body);
      expect(refocus).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it('leaves a frame that is not parked, and any element outside a parked leaf, alone', () => {
    const refocus = vi.fn();
    const field = document.body.appendChild(document.createElement('input'));
    const stop = watchParkedFocus(isParked, refocus);
    try {
      for (const el of [visibleFrame, field]) {
        el.focus();
        window.dispatchEvent(new FocusEvent('blur'));
        vi.advanceTimersByTime(PARKED_FOCUS_POLL_MS);
        expect(document.activeElement).toBe(el);
      }
      expect(refocus).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('finds a frame-to-frame move, which blurs nothing here, on its poll', () => {
    const refocus = vi.fn();
    const stop = watchParkedFocus(isParked, refocus);
    try {
      visibleFrame.focus();
      parkedFrame.focus();
      vi.advanceTimersByTime(PARKED_FOCUS_POLL_MS);
      expect(document.activeElement).toBe(document.body);
      expect(refocus).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it('stops watching and removes its focus sink when torn down', () => {
    const refocus = vi.fn();
    const before = document.body.childElementCount;
    const stop = watchParkedFocus(isParked, refocus);
    expect(document.body.childElementCount).toBe(before + 1);
    stop();
    expect(document.body.childElementCount).toBe(before);
    parkedFrame.focus();
    window.dispatchEvent(new FocusEvent('blur'));
    vi.advanceTimersByTime(PARKED_FOCUS_POLL_MS);
    expect(document.activeElement).toBe(parkedFrame);
    expect(refocus).not.toHaveBeenCalled();
  });
});
