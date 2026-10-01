/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { subscribePaneMotion } from './pane-motion';
import { createWorkspaceMotion } from '../workspace-motion';

let observed: Set<() => void>;
let scroller: HTMLDivElement;
let pane: HTMLDivElement;
let sibling: HTMLDivElement;

beforeEach(() => {
  observed = new Set();
  vi.stubGlobal('ResizeObserver', class {
    private readonly fire: () => void;
    constructor(callback: ResizeObserverCallback) {
      this.fire = () => callback([], this as unknown as ResizeObserver);
    }
    observe(): void { observed.add(this.fire); }
    unobserve(): void {}
    disconnect(): void { observed.delete(this.fire); }
  });
  scroller = document.createElement('div');
  pane = document.createElement('div');
  sibling = document.createElement('div');
  scroller.append(pane);
  document.body.append(scroller, sibling);
});

afterEach(() => {
  scroller.remove();
  sibling.remove();
  vi.unstubAllGlobals();
});

it('reports every source that can move the pane, until unsubscribed', () => {
  const onChange = vi.fn();
  const frames = new Set<(settled: boolean) => void>();
  const unsubscribe = subscribePaneMotion(pane, onChange, (cb) => {
    frames.add(cb);
    return () => { frames.delete(cb); };
  });
  const workspace = createWorkspaceMotion(document.createElement('div'), 'pane-motion-test');
  const fire = () => {
    observed.forEach((f) => f());
    window.dispatchEvent(new Event('resize'));
    scroller.dispatchEvent(new Event('scroll'));
    document.dispatchEvent(new Event('scroll'));
    frames.forEach((cb) => cb(false));
    workspace.hide();
  };
  fire();
  expect(onChange).toHaveBeenCalledTimes(6);
  onChange.mockClear();
  unsubscribe();
  fire();
  expect(onChange).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  workspace.dispose();
});

it('ignores a scroll that cannot move the pane: inside it, or beside it', () => {
  const onChange = vi.fn();
  const unsubscribe = subscribePaneMotion(pane, onChange);
  const viewport = document.createElement('div');
  pane.append(viewport);
  viewport.dispatchEvent(new Event('scroll'));
  sibling.dispatchEvent(new Event('scroll'));
  expect(onChange).not.toHaveBeenCalled();
  unsubscribe();
});
