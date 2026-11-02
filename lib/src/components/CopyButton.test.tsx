/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../lib/clipboard-write', () => ({ writeTextToClipboard: vi.fn(async () => true) }));
import { CopyButton } from './CopyButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<CopyButton text={() => 'x'} label="Copy" className="" />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const button = () => host.querySelector('button')!;
const click = () => act(async () => { button().click(); });

it('holds the copied label for its full time after a repeat click', async () => {
  await click();
  expect(button().textContent).toBe('Copied');
  await act(async () => { vi.advanceTimersByTime(1000); });
  await click();
  await act(async () => { vi.advanceTimersByTime(1000); });
  expect(button().textContent).toBe('Copied');
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(button().textContent).toBe('Copy');
});
