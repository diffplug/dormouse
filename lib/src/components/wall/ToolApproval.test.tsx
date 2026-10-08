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

// What the host refuses, the prompt never offers to grant: a control would act
// as an editing key once typed.
it.each([
  ['run', 'echo "\u007fhi; touch pwned #"'],
  ['name', 'd\u0015ev'],
  ['projectRoot', '/re\u009bpo'],
  ['path', '/repo/\ndormouse.yml'],
  ['upstreamUrl', 'https://example.com/\u001brepo'],
])('offers no grant when its %s carries a control', (field, value) => {
  render({ ...PENDING, [field]: value });
  expect(buttons()).toEqual(['Disallow and close']);
  expect(container.textContent).not.toContain(value);
  act(() => container.querySelector('button')!.click());
  expect(onResolve).toHaveBeenCalledWith('t', 'decline');
});

// A format character a path or argument carries is shown as its escape, so the
// text read is the text there, and the grant is still offered.
it('shows every format character escaped, grants included', () => {
  render({ ...PENDING, run: 'view /\u0631\u200cx/a\u202eb', projectRoot: '/\u0631\u200cx', path: '/\u0631\u200cx/dormouse.yml', upstreamUrl: 'https://example.com/\u2067r' });
  expect(container.textContent).not.toMatch(/[\u200c\u202e\u2067]/);
  expect(container.textContent).toContain('view /\u0631\\u200cx/a\\u202eb');
  expect(buttons()).toEqual(['Always allow for upstream https://example.com/\\u2067r', 'Always allow for folder /\u0631\\u200cx', 'Disallow and close']);
});

it('shows a relayed error with its hidden characters escaped', () => {
  render({ ...PENDING, error: 'tools.x\u202eyz: failed' });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('tools.x\\u202eyz: failed');
});
