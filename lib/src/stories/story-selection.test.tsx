/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useStorySelection } from './story-selection';

const fixture = vi.hoisted(() => ({ text: '', clear: vi.fn(), hint: vi.fn() }));
vi.mock('../lib/mouse-selection', () => ({ setSelection: fixture.clear, setHintToken: fixture.hint }));
vi.mock('../lib/terminal-registry', () => ({
  getTerminalOverlayDims: () => ({ cellHeight: 16 }),
  getTerminalInstance: () => ({ buffer: { active: {
    cursorX: 0, cursorY: 0, getLine: () => ({ translateToString: () => fixture.text }),
  } } }),
  getActivitySnapshot: () => new Map(),
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const apply = vi.fn();
function Story() { useStorySelection('story-terminal', apply, []); return null; }

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fixture.text = '';
  document.documentElement.dataset.storyPrimed = 'true';
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<Story />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete document.documentElement.dataset.storyPrimed;
  vi.useRealTimers();
});

it('waits for terminal text even when its grid is already measured', () => {
  act(() => vi.advanceTimersByTime(100));
  expect(apply).not.toHaveBeenCalled();
  fixture.text = 'the output to select';
  act(() => vi.advanceTimersByTime(50));
  expect(apply).toHaveBeenCalledOnce();
});

it('waits for the preview priming before applying the selection', () => {
  fixture.text = 'ready';
  delete document.documentElement.dataset.storyPrimed;
  act(() => vi.advanceTimersByTime(100));
  expect(apply).not.toHaveBeenCalled();
  document.documentElement.dataset.storyPrimed = 'true';
  act(() => vi.advanceTimersByTime(50));
  expect(apply).toHaveBeenCalledOnce();
});

it('stops waiting and clears the selection when the story leaves', () => {
  act(() => root.render(null));
  fixture.text = 'late output';
  act(() => vi.advanceTimersByTime(1000));
  expect(apply).not.toHaveBeenCalled();
  expect(fixture.clear).toHaveBeenCalledWith('story-terminal', null);
  expect(fixture.hint).toHaveBeenCalledWith('story-terminal', null);
});
