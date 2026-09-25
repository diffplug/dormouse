import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MOUSE_SELECTION_STATE,
  __resetMouseSelectionForTests,
  beginDrag,
  endDrag,
  flashCopy,
  getMouseSelectionSnapshot,
  getMouseSelectionState,
  isDragging,
  removeMouseSelectionState,
  setBracketedPaste,
  setHintToken,
  setMouseReporting,
  setOverride,
  setSelection,
  subscribeToMouseSelection,
  updateDrag,
  type Selection,
  type TokenHint,
} from './mouse-selection';

afterEach(() => {
  __resetMouseSelectionForTests();
});

describe('mouse-selection: default state', () => {
  it('returns the default state for an unknown id', () => {
    expect(getMouseSelectionState('missing')).toEqual(DEFAULT_MOUSE_SELECTION_STATE);
  });

  it('default state has mouse reporting off, override off, no selection', () => {
    expect(DEFAULT_MOUSE_SELECTION_STATE).toEqual({
      mouseReporting: 'none',
      bracketedPaste: false,
      override: 'off',
      selection: null,
      hintToken: null,
      copyFlash: null,
    });
  });
});

describe('mouse-selection: state setters', () => {
  it('setMouseReporting updates the mode', () => {
    setMouseReporting('a', 'vt200');
    expect(getMouseSelectionState('a').mouseReporting).toBe('vt200');

    setMouseReporting('a', 'any');
    expect(getMouseSelectionState('a').mouseReporting).toBe('any');
  });

  it('setBracketedPaste toggles the flag', () => {
    setBracketedPaste('a', true);
    expect(getMouseSelectionState('a').bracketedPaste).toBe(true);
    setBracketedPaste('a', false);
    expect(getMouseSelectionState('a').bracketedPaste).toBe(false);
  });

  it('setSelection stores a selection', () => {
    const sel: Selection = { startRow: 5, startCol: 3, endRow: 5, endCol: 10, shape: 'linewise', dragging: false, startedInScrollback: false };
    setSelection('a', sel);
    expect(getMouseSelectionState('a').selection).toBe(sel);

    setSelection('a', null);
    expect(getMouseSelectionState('a').selection).toBeNull();
  });

  it('setHintToken stores a hint', () => {
    const hint: TokenHint = { kind: 'url', row: 1, startCol: 0, endCol: 20, text: 'https://example.com' };
    setHintToken('a', hint);
    expect(getMouseSelectionState('a').hintToken).toBe(hint);

    setHintToken('a', null);
    expect(getMouseSelectionState('a').hintToken).toBeNull();
  });

  it('removeMouseSelectionState drops all state for an id', () => {
    setMouseReporting('a', 'vt200');
    setSelection('a', { startRow: 0, startCol: 0, endRow: 0, endCol: 5, shape: 'linewise', dragging: false, startedInScrollback: false });
    removeMouseSelectionState('a');
    expect(getMouseSelectionState('a')).toEqual(DEFAULT_MOUSE_SELECTION_STATE);
  });
});

describe('mouse-selection: override rules', () => {
  it('cannot activate override while mouse reporting is off', () => {
    setOverride('a', 'temporary');
    expect(getMouseSelectionState('a').override).toBe('off');
    setOverride('a', 'permanent');
    expect(getMouseSelectionState('a').override).toBe('off');
  });

  it('can activate override while mouse reporting is on', () => {
    setMouseReporting('a', 'vt200');
    setOverride('a', 'temporary');
    expect(getMouseSelectionState('a').override).toBe('temporary');

    setOverride('a', 'permanent');
    expect(getMouseSelectionState('a').override).toBe('permanent');
  });

  it('can always deactivate an override', () => {
    setMouseReporting('a', 'vt200');
    setOverride('a', 'temporary');
    setOverride('a', 'off');
    expect(getMouseSelectionState('a').override).toBe('off');
  });

  it('mouse reporting going to none auto-ends the override', () => {
    setMouseReporting('a', 'vt200');
    setOverride('a', 'temporary');
    setMouseReporting('a', 'none');
    expect(getMouseSelectionState('a').override).toBe('off');
  });

  it('mouse reporting going to none auto-ends a permanent override too', () => {
    setMouseReporting('a', 'drag');
    setOverride('a', 'permanent');
    setMouseReporting('a', 'none');
    expect(getMouseSelectionState('a').override).toBe('off');
  });
});

describe('mouse-selection: subscription', () => {
  it('subscribe + setMouseReporting notifies listeners', () => {
    const listener = vi.fn();
    subscribeToMouseSelection(listener);
    setMouseReporting('a', 'vt200');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('setting the same value does not notify', () => {
    setMouseReporting('a', 'vt200');
    const listener = vi.fn();
    subscribeToMouseSelection(listener);
    setMouseReporting('a', 'vt200');
    expect(listener).not.toHaveBeenCalled();
  });

  it('setBracketedPaste, setOverride, setSelection, setHintToken all notify', () => {
    setMouseReporting('a', 'vt200'); // prerequisite for override activation
    const listener = vi.fn();
    subscribeToMouseSelection(listener);

    setBracketedPaste('a', true);
    setOverride('a', 'temporary');
    setSelection('a', { startRow: 0, startCol: 0, endRow: 0, endCol: 1, shape: 'linewise', dragging: true, startedInScrollback: false });
    setHintToken('a', { kind: 'path', row: 0, startCol: 0, endCol: 5, text: '/tmp' });

    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const unsub = subscribeToMouseSelection(listener);
    unsub();
    setMouseReporting('a', 'vt200');
    expect(listener).not.toHaveBeenCalled();
  });

  it('removeMouseSelectionState notifies', () => {
    setMouseReporting('a', 'vt200');
    const listener = vi.fn();
    subscribeToMouseSelection(listener);
    removeMouseSelectionState('a');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('removing a state that was never set does not notify', () => {
    const listener = vi.fn();
    subscribeToMouseSelection(listener);
    removeMouseSelectionState('never-existed');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('mouse-selection: drag lifecycle', () => {
  it('beginDrag creates a selection anchored at the starting cell', () => {
    beginDrag('a', { row: 5, col: 10, altKey: false, startedInScrollback: false });
    const sel = getMouseSelectionState('a').selection;
    expect(sel).not.toBeNull();
    expect(sel).toMatchObject({
      startRow: 5,
      startCol: 10,
      endRow: 5,
      endCol: 10,
      shape: 'linewise',
      dragging: true,
      startedInScrollback: false,
    });
  });

  it('beginDrag with altKey starts in block shape', () => {
    beginDrag('a', { row: 0, col: 0, altKey: true, startedInScrollback: false });
    expect(getMouseSelectionState('a').selection?.shape).toBe('block');
  });

  it('beginDrag replaces an existing selection (spec §3.7)', () => {
    beginDrag('a', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    updateDrag('a', { row: 2, col: 5, altKey: false });
    endDrag('a');

    beginDrag('a', { row: 8, col: 3, altKey: false, startedInScrollback: false });
    const sel = getMouseSelectionState('a').selection;
    expect(sel?.startRow).toBe(8);
    expect(sel?.dragging).toBe(true);
  });

  it('updateDrag moves the end of an active drag', () => {
    beginDrag('a', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    updateDrag('a', { row: 4, col: 12, altKey: false });
    const sel = getMouseSelectionState('a').selection;
    expect(sel?.endRow).toBe(4);
    expect(sel?.endCol).toBe(12);
  });

  it('updateDrag flips shape live as Alt is pressed / released (spec §3.2)', () => {
    beginDrag('a', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    updateDrag('a', { row: 4, col: 12, altKey: true });
    expect(getMouseSelectionState('a').selection?.shape).toBe('block');
    updateDrag('a', { row: 4, col: 12, altKey: false });
    expect(getMouseSelectionState('a').selection?.shape).toBe('linewise');
  });

  it('updateDrag is a no-op after endDrag', () => {
    beginDrag('a', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    endDrag('a');
    updateDrag('a', { row: 9, col: 9, altKey: false });
    const sel = getMouseSelectionState('a').selection;
    expect(sel?.endRow).toBe(0);
    expect(sel?.endCol).toBe(0);
    expect(sel?.dragging).toBe(false);
  });

  it('updateDrag with no change does not notify', () => {
    beginDrag('a', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    updateDrag('a', { row: 3, col: 5, altKey: false });
    const listener = vi.fn();
    subscribeToMouseSelection(listener);
    updateDrag('a', { row: 3, col: 5, altKey: false });
    expect(listener).not.toHaveBeenCalled();
  });

  it('endDrag freezes the selection but does not clear it', () => {
    beginDrag('a', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    updateDrag('a', { row: 3, col: 5, altKey: false });
    endDrag('a');
    const sel = getMouseSelectionState('a').selection;
    expect(sel?.dragging).toBe(false);
    expect(sel?.endRow).toBe(3);
    expect(sel?.endCol).toBe(5);
  });

  it('endDrag is a no-op when no drag is active', () => {
    const listener = vi.fn();
    subscribeToMouseSelection(listener);
    endDrag('a');
    expect(listener).not.toHaveBeenCalled();
  });

  it('isDragging reflects the drag state', () => {
    expect(isDragging('a')).toBe(false);
    beginDrag('a', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    expect(isDragging('a')).toBe(true);
    endDrag('a');
    expect(isDragging('a')).toBe(false);
  });

  it('beginDrag with startedInScrollback=true preserves the flag', () => {
    beginDrag('a', { row: 2, col: 0, altKey: false, startedInScrollback: true });
    expect(getMouseSelectionState('a').selection?.startedInScrollback).toBe(true);
  });
});

describe('mouse-selection: flashCopy race', () => {
  it('beginDrag during a flash clears copyFlash so the timer does not nuke the new selection', () => {
    beginDrag('a', { row: 0, col: 0, altKey: false, startedInScrollback: false });
    updateDrag('a', { row: 3, col: 5, altKey: false });
    endDrag('a');

    // Simulate flashCopy — but we call beginDrag before the timer fires.
    flashCopy('a', 'raw', 500);
    expect(getMouseSelectionState('a').copyFlash).toBe('raw');

    // New drag starts before the 500ms timer.
    beginDrag('a', { row: 10, col: 2, altKey: false, startedInScrollback: false });
    expect(getMouseSelectionState('a').copyFlash).toBeNull();
    expect(getMouseSelectionState('a').selection?.startRow).toBe(10);
  });
});

describe('mouse-selection: snapshot caching', () => {
  it('returns the same snapshot reference between changes', () => {
    setMouseReporting('a', 'vt200');
    const s1 = getMouseSelectionSnapshot();
    const s2 = getMouseSelectionSnapshot();
    expect(s1).toBe(s2);
  });

  it('invalidates the snapshot after a change', () => {
    setMouseReporting('a', 'vt200');
    const s1 = getMouseSelectionSnapshot();
    setMouseReporting('a', 'any');
    const s2 = getMouseSelectionSnapshot();
    expect(s1).not.toBe(s2);
  });

  it('snapshot contains state for every known id', () => {
    setMouseReporting('a', 'vt200');
    setMouseReporting('b', 'any');
    const snap = getMouseSelectionSnapshot();
    expect(snap.get('a')?.mouseReporting).toBe('vt200');
    expect(snap.get('b')?.mouseReporting).toBe('any');
  });
});
