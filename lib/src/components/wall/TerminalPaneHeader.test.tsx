/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { RenamingIdContext, WallActionsContext, type WallActions } from './wall-context';
import { ensureResizeObserver, stubResizeObserver, stubWallActions as stubActions } from './wall-test-utils';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import { setNativeFieldValue } from '../../lib/dom';
import { removeTerminalPaneState } from '../../lib/terminal-registry';
import { removeMouseSelectionState, setMouseReporting } from '../../lib/mouse-selection';
import {
  addPlainNote,
  clearAllNotepads,
  getOpenNotepadId,
  setOpenNotepadId,
} from '../../lib/notepad/notepad-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  ensureResizeObserver();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  platform.reset();
  removeTerminalPaneState('term-1');
});

function renderHeader(actions: WallActions, renamingId: string | null): void {
  const props: PaneProps = { id: 'term-1', title: 'my-title', params: undefined };
  act(() => {
    root.render(
      <StrictMode>
        <RenamingIdContext.Provider value={renamingId}>
          <WallActionsContext.Provider value={actions}>
            <TerminalPaneHeader {...props} />
          </WallActionsContext.Provider>
        </RenamingIdContext.Provider>
      </StrictMode>,
    );
  });
}

function renameInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('[data-renaming-input-for="term-1"]');
  expect(input).not.toBeNull();
  return input!;
}

describe('TerminalPaneHeader — inline rename', () => {
  it('clicking the title starts a rename', () => {
    const onStartRename = vi.fn();
    renderHeader(stubActions({ onStartRename }), null);

    const title = container.querySelector('[data-pane-title-for="term-1"]') as HTMLElement;
    act(() => { title.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onStartRename).toHaveBeenCalledWith('term-1');
  });

  it('opens pre-selected on the current title', () => {
    renderHeader(stubActions(), 'term-1');

    // No terminal state for this pane yet, so the derived header is the
    // `<idle>` placeholder — whatever the header shows is what the field seeds
    // from (`docs/specs/terminal-state.md`).
    const input = renameInput();
    expect(input.value).toBe('<idle>');
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, '<idle>'.length]);
  });

  it('keeps what the user typed when the header re-renders mid-edit', () => {
    // The header re-renders constantly (activity, terminal state, palette
    // crossfade). It used to re-select the whole field on every one of those,
    // so the next keystroke replaced everything: typing "word" left "d".
    renderHeader(stubActions(), 'term-1');

    const input = renameInput();
    act(() => { setNativeFieldValue(input, 'wo'); });
    renderHeader(stubActions(), 'term-1');

    expect(renameInput()).toBe(input);
    expect(input.value).toBe('wo');
    expect(input.selectionStart).toBe(2);

    act(() => { setNativeFieldValue(input, 'word'); });
    expect(input.value).toBe('word');
  });

  it('submits the typed value on Enter', () => {
    const onFinishRename = vi.fn(() => ({ accepted: true as const }));
    renderHeader(stubActions({ onFinishRename }), 'term-1');

    const input = renameInput();
    act(() => { setNativeFieldValue(input, 'word'); });
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

    expect(onFinishRename).toHaveBeenCalledWith('term-1', 'word');
  });

  it('submits the typed value on blur', () => {
    const onFinishRename = vi.fn(() => ({ accepted: true as const }));
    renderHeader(stubActions({ onFinishRename }), 'term-1');

    const input = renameInput();
    act(() => { setNativeFieldValue(input, 'blurred'); });
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });

    expect(onFinishRename).toHaveBeenCalledWith('term-1', 'blurred');
  });

  it('cancels on Escape, and the blur that follows does not resurrect the edit', () => {
    const onCancelRename = vi.fn();
    const onFinishRename = vi.fn(() => ({ accepted: true as const }));
    renderHeader(stubActions({ onCancelRename, onFinishRename }), 'term-1');

    const input = renameInput();
    act(() => { setNativeFieldValue(input, 'discard-me'); });
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });

    expect(onCancelRename).toHaveBeenCalled();
    expect(onFinishRename).not.toHaveBeenCalled();
  });

  it('warns in place when the submitted title is rejected', () => {
    const onFinishRename = vi.fn(() => ({ accepted: false as const, reason: 'reserved' as const }));
    renderHeader(stubActions({ onFinishRename }), 'term-1');

    const input = renameInput();
    act(() => { setNativeFieldValue(input, '<idle> nope'); });
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });

    expect(document.body.textContent).toContain('<idle> nope');
  });
});

describe('TerminalPaneHeader — notepad icon', () => {
  // The tier is ResizeObserver-driven, so the suite's inert stub can only ever
  // show `full`. This one reports a width the test picks.
  let resizeHeader: (width: number) => void;

  beforeEach(() => {
    resizeHeader = stubResizeObserver(400);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    // Still mounted at this point (the outer hook unmounts), so both stores
    // notify a live header.
    act(() => {
      clearAllNotepads();
      removeMouseSelectionState('term-1');
    });
  });

  function notepadButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('[aria-label^="Notepad"]');
  }

  it('sits after the mouse-override icon and before the split controls', () => {
    setMouseReporting('term-1', 'any');
    renderHeader(stubActions(), null);

    const labels = Array.from(container.querySelectorAll<HTMLElement>('button[aria-label]'))
      .map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Alerts are per command',
      'Override mouse capture',
      'Notepad',
      'Split left/right',
      'Split top/bottom',
      'Zoom',
      'Minimize',
      'Kill',
    ]);
  });

  it('fills the icon and names the count once the Surface has notes', () => {
    renderHeader(stubActions(), null);
    const empty = notepadButton()!.innerHTML;
    expect(notepadButton()!.getAttribute('aria-label')).toBe('Notepad');

    act(() => { addPlainNote('term-1', 'a note'); });

    expect(notepadButton()!.getAttribute('aria-label')).toBe('Notepad · 1 note');
    expect(notepadButton()!.innerHTML).not.toBe(empty);

    act(() => { addPlainNote('term-1', 'another'); });
    expect(notepadButton()!.getAttribute('aria-label')).toBe('Notepad · 2 notes');
  });

  it('keeps its place at the compact tier and yields it at minimal only when empty', () => {
    renderHeader(stubActions(), null);
    act(() => resizeHeader(200));
    expect(notepadButton()).not.toBeNull();

    act(() => resizeHeader(100));
    expect(notepadButton()).toBeNull();

    // Notes are never invisible: the icon comes back to carry them.
    act(() => { addPlainNote('term-1', 'a note'); });
    expect(notepadButton()).not.toBeNull();
  });

  it('preserves visual breakpoints and the previous tier while hidden', () => {
    renderHeader(stubActions(), null);
    const split = () => container.querySelector('[aria-label="Split left/right"]');
    act(() => resizeHeader(293));
    expect(split()).toBeNull();
    expect(notepadButton()).not.toBeNull();
    act(() => resizeHeader(0));
    expect(split()).toBeNull();
    expect(notepadButton()).not.toBeNull();
    act(() => resizeHeader(294));
    expect(split()).not.toBeNull();
    act(() => resizeHeader(173));
    expect(notepadButton()).toBeNull();
    act(() => resizeHeader(174));
    expect(notepadButton()).not.toBeNull();
  });

  it('measures the initial border width before ResizeObserver delivers', () => {
    stubResizeObserver(0);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 293, 30));
    renderHeader(stubActions(), null);
    expect(container.querySelector('[aria-label="Split left/right"]')).toBeNull();
    expect(notepadButton()).not.toBeNull();
  });

  it.each([true, false])('handles zero content width with borderBoxSize available=%s', (hasBorderBox) => {
    let resize: (width: number) => void;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 30));
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        resize = (width) => this.callback([{
          target,
          borderBoxSize: hasBorderBox ? [{ inlineSize: width, blockSize: 30 }] : undefined,
          contentRect: { width: Math.max(0, width - 13) },
        } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    });
    renderHeader(stubActions(), null);
    expect(container.querySelector('[aria-label="Split left/right"]')).not.toBeNull();
    rect.mockReturnValue(new DOMRect(0, 0, 8, 30));
    act(() => resize(8));
    expect(container.querySelector('[aria-label="Split left/right"]')).toBeNull();
    expect(notepadButton()).toBeNull();
  });

  it('toggles the one open notepad', () => {
    renderHeader(stubActions(), null);

    act(() => { notepadButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(getOpenNotepadId()).toBe('term-1');

    act(() => { notepadButton()!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(getOpenNotepadId()).toBeNull();

    setOpenNotepadId(null);
  });
});
