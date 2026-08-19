/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { RenamingIdContext, WallActionsContext, type WallActions } from './wall-context';
import { ensureResizeObserver, stubWallActions as stubActions } from './wall-test-utils';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import { setNativeFieldValue } from '../../lib/dom';
import { removeTerminalPaneState } from '../../lib/terminal-registry';

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
