/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ToolApproval } from './ToolApproval';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PENDING = {
  name: 'dev', run: 'pnpm dev', path: '/repo/dormouse.yml', projectRoot: '/repo',
  upstreamUrl: 'https://example.com/repo', minimized: false,
};

let root: Root;
let container: HTMLDivElement;
const onResolve = vi.fn();
beforeEach(() => {
  onResolve.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (pending: Record<string, unknown>) =>
  act(() => root.render(<ToolApproval id="t" title="Pending Tool" params={{ toolPending: pending }} onResolve={onResolve} />));
const buttons = () => [...container.querySelectorAll('button')].map(button => button.textContent);

it('offers both grants for a Tool it can show as it is', () => {
  render(PENDING);
  expect(container.textContent).toContain('pnpm dev');
  expect(buttons()).toEqual(['Always allow for upstream https://example.com/repo', 'Always allow for folder /repo', 'Disallow and close']);
});

// The prompt must never show what the host would refuse: a hidden character
// makes the text read differ from the command run.
it.each([
  ['run', 'echo "\u007fhi; touch pwned #"'],
  ['run', 'echo safe ‮'],
  ['name', 'd​ev'],
  ['projectRoot', '/re⁧po'],
  ['path', '/repo/‏dormouse.yml'],
  ['upstreamUrl', 'https://example.com/﻿repo'],
])('offers no grant when its %s carries a hidden character', (field, value) => {
  render({ ...PENDING, [field]: value });
  expect(buttons()).toEqual(['Close']);
  expect(container.textContent).not.toContain(value);
  act(() => container.querySelector('button')!.click());
  expect(onResolve).toHaveBeenCalledWith('t', 'decline');
});

it('shows a relayed error with its hidden characters escaped', () => {
  render({ ...PENDING, error: 'tools.x‮yz: failed' });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('tools.x\\u202eyz: failed');
});
