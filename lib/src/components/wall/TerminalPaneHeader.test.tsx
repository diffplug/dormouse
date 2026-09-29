/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { RenamingIdContext, WallActionsContext, type WallActions } from './wall-context';
import { doubleClick, ensureResizeObserver, stubResizeObserver, stubWallActions as stubActions } from './wall-test-utils';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import { setNativeFieldValue } from '../../lib/dom';
import { clearTerminalActivity, removeTerminalPaneState, setTerminalActivity } from '../../lib/terminal-registry';
import { createAlertEpisode } from '../../lib/alert-episode';
import { removeMouseSelectionState, setMouseReporting } from '../../lib/mouse-selection';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
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
  clearTerminalActivity('term-1');
  removeTerminalPaneState('term-1');
});

function renderHeader(actions: WallActions, renamingId: string | null, override?: Partial<PaneProps>): void {
  const props: PaneProps = { id: 'term-1', title: 'my-title', params: undefined, ...override };
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

describe('TerminalPaneHeader — alert state', () => {
  /** The header is untinted whatever the Session's status: the Pane overlay's
   *  perimeter ring is the whole treatment (`docs/specs/alert.md` -> Pane
   *  Header), and a second tinted surface would double-report it. */
  it('never tints for a ringing Session, and offers it no control of its own', () => {
    renderHeader(stubActions(), null);
    const quiet = container.querySelector<HTMLElement>('[data-pane-header-for="term-1"]')!.className;

    act(() => { setTerminalActivity('term-1', { status: 'ALERT_RINGING', episode: createAlertEpisode() }); });

    const header = container.querySelector<HTMLElement>('[data-pane-header-for="term-1"]')!;
    expect(header.className).toBe(quiet);
    expect(header.innerHTML).not.toContain('alarm-vs');
    expect(container.querySelector('[data-alert-ring-inset]')).toBeNull();
  });
});

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

describe('TerminalPaneHeader — preview slot', () => {
  afterEach(() => vi.unstubAllGlobals());
  const PREVIEW: Partial<PaneProps> = { params: { surfaceType: 'tool', toolPreview: true } };
  const header = () => container.querySelector<HTMLElement>('[data-pane-header-for="term-1"]')!;
  const label = () => container.querySelector<HTMLElement>('[data-pane-title-for="term-1"]')!;

  it('marks the slot with its italic label alone, named Preview, at every width', () => {
    const resize = stubResizeObserver(400);
    renderHeader(stubActions(), null, PREVIEW);
    for (const width of [400, 250, 150]) {
      act(() => resize(width));
      expect(label().title).toBe('Preview');
      expect(label().querySelector('.italic')).not.toBeNull();
      expect(header().textContent).not.toContain('Preview');
    }
  });

  it('keeps the slot on a double-click of its label or empty header, never of a button or the rename field', () => {
    stubResizeObserver(400);
    const onPinPreview = vi.fn();
    renderHeader(stubActions({ onPinPreview }), null, PREVIEW);
    const buttons = header().querySelectorAll('button');
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) doubleClick(button);
    expect(onPinPreview).not.toHaveBeenCalled();
    doubleClick(label().querySelector('.italic')!);
    doubleClick(header());
    expect(onPinPreview.mock.calls).toEqual([['term-1'], ['term-1']]);
    // Command-mode rename still opens on a preview; a double-click in it selects a word.
    renderHeader(stubActions({ onPinPreview }), 'term-1', PREVIEW);
    doubleClick(renameInput());
    expect(onPinPreview).toHaveBeenCalledTimes(2);
  });

  it('starts no rename from a preview\'s label click, selecting the pane instead; kept, the label renames', () => {
    const onStartRename = vi.fn();
    const onClickPanel = vi.fn();
    renderHeader(stubActions({ onStartRename, onClickPanel }), null, PREVIEW);
    act(() => { label().dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); label().click(); });
    expect(onStartRename).not.toHaveBeenCalled();
    expect(onClickPanel).toHaveBeenCalledExactlyOnceWith('term-1');
    renderHeader(stubActions({ onStartRename, onClickPanel }), null, { params: { surfaceType: 'tool' } });
    act(() => { label().dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); label().click(); });
    expect(onStartRename).toHaveBeenCalledExactlyOnceWith('term-1');
    expect(onClickPanel).toHaveBeenCalledOnce();
  });

  it('marks nothing once the Tool is pinned, and a double-click keeps nothing', () => {
    const onPinPreview = vi.fn();
    renderHeader(stubActions({ onPinPreview }), null, { params: { surfaceType: 'tool', toolTarget: '/repo/a.md' } });
    expect(container.querySelector('[data-pane-title-for="term-1"] .italic')).toBeNull();
    expect(label().title).toBe('');
    doubleClick(header());
    expect(onPinPreview).not.toHaveBeenCalled();
  });
});

describe('TerminalPaneHeader — unsaved changes', () => {
  afterEach(() => resetToolDirty());

  it('ignores dirty reports on an ordinary terminal', () => {
    act(() => recordToolDirty('term-1', true));
    renderHeader(stubActions(), null);
    expect(container.querySelector('[aria-label="Unsaved changes"]')).toBeNull();
  });
});
