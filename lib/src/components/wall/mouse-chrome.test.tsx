/** @vitest-environment jsdom */
import { act, Profiler } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { MouseOverrideBanner } from './MouseOverrideBanner';
import { ensureResizeObserver, stubWallActions } from './wall-test-utils';
import { WallActionsContext } from './wall-context';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import {
  __resetMouseSelectionForTests,
  beginDrag,
  getMouseSelectionState,
  setHintToken,
  setMouseReporting,
  setOverride,
  updateDrag,
} from '../../lib/mouse-selection';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let platform: FakePtyAdapter;
const commits = vi.fn();

beforeEach(() => {
  __resetMouseSelectionForTests();
  commits.mockClear();
  platform = new FakePtyAdapter();
  setPlatform(platform);
  ensureResizeObserver();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  platform.reset();
  __resetMouseSelectionForTests();
});

function renderChrome() {
  act(() => {
    root.render(
      <WallActionsContext.Provider value={stubWallActions()}>
        {['one', 'two'].map((id) => (
          <div key={id} data-test-pane={id}>
            <Profiler id={`header-${id}`} onRender={commits}>
              <TerminalPaneHeader id={id} title={id} params={undefined} />
            </Profiler>
            <Profiler id={`banner-${id}`} onRender={commits}>
              <MouseOverrideBanner terminalId={id} />
            </Profiler>
          </div>
        ))}
      </WallActionsContext.Provider>,
    );
  });
  commits.mockClear();
}

it('does not rerender pane headers or banners for selection and hover updates', () => {
  setMouseReporting('one', 'vt200');
  setOverride('one', 'temporary');
  renderChrome();

  act(() => beginDrag('one', { row: 0, col: 0, altKey: false, startedInScrollback: false }));
  for (let col = 1; col <= 10; col++) {
    act(() => updateDrag('one', { row: 0, col, altKey: false }));
  }
  act(() => setHintToken('one', { kind: 'url', start: { row: 0, col: 0 }, end: { row: 0, col: 11 }, text: 'https://a.co' }));

  expect(commits.mock.calls.length).toBe(0);
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
});

it('updates only the owning pane for reporting and override transitions', () => {
  vi.useFakeTimers();
  renderChrome();
  const pane = container.querySelector('[data-test-pane="one"]')!;
  const mouseButton = () => pane.querySelector<HTMLButtonElement>('[aria-label$="mouse capture"]');
  const banner = () => pane.querySelector('[role="status"]');
  const click = (button: HTMLButtonElement) => act(() => button.click());

  expect(mouseButton()).toBeNull();
  act(() => setMouseReporting('one', 'vt200'));
  expect(mouseButton()?.getAttribute('aria-label')).toBe('Override mouse capture');
  expect(banner()).toBeNull();
  expect(commits.mock.calls.map(([id]) => id)).toContain('header-one');
  expect(commits.mock.calls.some(([id]) => id.endsWith('-two'))).toBe(false);

  commits.mockClear();
  act(() => setMouseReporting('one', 'drag'));
  expect(commits.mock.calls.length).toBe(0);

  click(mouseButton()!);
  expect(mouseButton()?.getAttribute('aria-label')).toBe('Restore mouse capture');
  expect(banner()?.textContent).toContain('Temporary mouse override until mouse-up.');
  expect(commits.mock.calls.map(([id]) => id)).toContain('banner-one');

  click(banner()!.querySelector<HTMLButtonElement>('button')!);
  act(() => vi.advanceTimersByTime(260));
  expect(banner()).toBeNull();
  expect(mouseButton()?.getAttribute('aria-label')).toBe('Restore mouse capture');

  click(mouseButton()!);
  expect(mouseButton()?.getAttribute('aria-label')).toBe('Override mouse capture');
  expect(banner()).toBeNull();

  click(mouseButton()!);
  act(() => setMouseReporting('one', 'none'));
  expect(mouseButton()).toBeNull();
  expect(banner()).toBeNull();
  expect(commits.mock.calls.some(([id]) => id.endsWith('-two'))).toBe(false);
});

it.each(['restore', 'reporting off'] as const)('does not revive an override after %s during Make sticky confirmation', (ended) => {
  vi.useFakeTimers();
  setMouseReporting('one', 'vt200');
  setOverride('one', 'temporary');
  renderChrome();
  const pane = container.querySelector('[data-test-pane="one"]')!;
  const sticky = pane.querySelector<HTMLButtonElement>('[role="status"] button')!;
  act(() => sticky.click());
  act(() => {
    if (ended === 'restore') setOverride('one', 'off');
    else setMouseReporting('one', 'none');
  });
  // A new reporting program cannot inherit the old button's queued action.
  if (ended === 'reporting off') act(() => setMouseReporting('one', 'vt200'));
  act(() => vi.advanceTimersByTime(260));
  expect(getMouseSelectionState('one').override).toBe('off');
  expect(pane.querySelector('[role="status"]')).toBeNull();
});

it.each(['sticky', 'cancel'] as const)('does not apply a stale %s action to an override restarted in one update', (action) => {
  vi.useFakeTimers();
  setMouseReporting('one', 'vt200');
  setOverride('one', 'temporary');
  renderChrome();
  const pane = container.querySelector('[data-test-pane="one"]')!;
  const buttons = pane.querySelectorAll<HTMLButtonElement>('[role="status"] button');
  act(() => buttons[action === 'sticky' ? 0 : 1]!.click());
  act(() => {
    setOverride('one', 'off');
    setOverride('one', 'temporary');
  });
  act(() => vi.advanceTimersByTime(260));
  expect(getMouseSelectionState('one').override).toBe('temporary');
  expect(pane.querySelector('[role="status"]')).not.toBeNull();
  // The new override must accept its own action after the old flash ended.
  act(() => pane.querySelector<HTMLButtonElement>('[role="status"] button')!.click());
  act(() => vi.advanceTimersByTime(260));
  expect(getMouseSelectionState('one').override).toBe('permanent');
});
