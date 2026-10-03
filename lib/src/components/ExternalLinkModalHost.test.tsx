/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExternalLinkModalHost } from './ExternalLinkModalHost';
import type { DorControlResult } from 'dor/protocol';
import { clearExternalLinkConfirmation, getExternalLinkConfirmationSnapshot, requestExternalLinkConfirmation } from '../lib/external-link-confirmation';

const mocks = vi.hoisted(() => ({ open: vi.fn(), toolControl: vi.fn(), confirm: () => {} }));
vi.mock('../lib/platform', () => ({ getPlatform: () => ({ openExternal: mocks.open, toolControl: mocks.toolControl }) }));
vi.mock('./wall/wall-handles', () => ({ wallHandleOwning: () => ({}) }));
vi.mock('./ExternalLinkModal', async (original) => {
  const real = await original<typeof import('./ExternalLinkModal')>();
  return {
    ExternalLinkModal: (props: Parameters<typeof real.ExternalLinkModal>[0]) => {
      mocks.confirm = props.onConfirm;
      return <real.ExternalLinkModal {...props} />;
    },
  };
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
type Request = { method: string; params: Record<string, unknown>; surfaceId: string; respond: (result: DorControlResult) => void };
let requests: Request[];
const capture = (event: Event) => requests.push((event as CustomEvent<Request>).detail);
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mocks.open.mockReset();
  requests = [];
  window.addEventListener('dormouse:control-request', capture);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ExternalLinkModalHost />));
});
afterEach(() => {
  window.removeEventListener('dormouse:control-request', capture);
  act(() => root.unmount());
  clearExternalLinkConfirmation();
  container.remove();
});

it('offers no open action for deceptive text, focuses copy, and rejects even a stale confirmation callback', () => {
  act(() => requestExternalLinkConfirmation('https://evil.example/', 'https://trusted.example/'));
  const buttons = [...document.body.querySelectorAll('button')];
  expect(buttons.some((button) => button.textContent?.startsWith('Open '))).toBe(false);
  expect(document.activeElement?.textContent).toBe('Copy deceptive URL to clipboard');
  act(() => mocks.confirm());
  expect(mocks.open).not.toHaveBeenCalled();
});

it('opens an ordinary URL only after the user confirms', () => {
  act(() => requestExternalLinkConfirmation('https://trusted.example/'));
  expect(mocks.open).not.toHaveBeenCalled();
  const open = [...document.body.querySelectorAll('button')].find((button) => button.textContent === 'Open URL');
  expect(open).toBeDefined();
  act(() => open!.click());
  expect(mocks.open).toHaveBeenCalledWith('https://trusted.example/');
});

it('rejects confirmation of a blocked URI', () => {
  act(() => requestExternalLinkConfirmation('javascript:alert(1)'));
  act(() => mocks.confirm());
  expect(mocks.open).not.toHaveBeenCalled();
});

const fileUri = 'file:///work/my%20report.md';
const source = { surfaceId: 'pane-a', cwd: '/work' };
const viewers = { handlers: [
  { tool: 'builtin:file', description: 'Rendered document', reason: 'built-in' },
  { tool: 'builtin:code', description: 'Source code', reason: 'built-in' },
], config: '/home/me/.config/dormouse/dormouse.yml' };
const button = (text: string) => [...document.body.querySelectorAll('button')].find(button => button.textContent === text)!;
const alertText = () => document.body.querySelector('[role="alert"]')?.textContent;
const answer = async (request: Request, result: DorControlResult) => { await act(async () => request.respond(result)); };
const requestFile = async (lookup: DorControlResult = { ok: true, result: viewers }) => {
  act(() => requestExternalLinkConfirmation(fileUri, '[Image #2]', source));
  await answer(requests[0], lookup);
};

it('loads the picker candidates without opening, then opens the default in the originating Session', async () => {
  await requestFile();
  expect(requests).toEqual([expect.objectContaining({ surfaceId: 'pane-a', method: 'tool.openHandlers', params: { target: fileUri, cwd: '/work' } })]);
  expect(document.body.textContent).toContain('Rendered document');
  act(() => button('Open file').click());
  expect(requests[1]).toMatchObject({ surfaceId: 'pane-a', method: 'surface.tool', params: { file: fileUri, surface: 'pane-a', cwd: '/work' } });
  expect(requests[1].params).not.toHaveProperty('tool');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(getExternalLinkConfirmationSnapshot()).not.toBeNull();
  await answer(requests[1], { ok: true });
  expect(getExternalLinkConfirmationSnapshot()).toBeNull();
});

it('opens another candidate explicitly, keeps failures visible, and allows retry', async () => {
  await requestFile();
  const select = document.body.querySelector('select')!;
  act(() => { select.value = '1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document.body.textContent).toContain('Source code');
  act(() => button('Open file').click());
  expect(requests[1].params.tool).toBe('builtin:code');
  act(() => mocks.confirm());
  expect(requests).toHaveLength(2);
  await answer(requests[1], { ok: false, error: 'File no longer exists' });
  expect(alertText()).toBe('File no longer exists');
  expect(getExternalLinkConfirmationSnapshot()).not.toBeNull();
  act(() => button('Open file').click());
  expect(requests).toHaveLength(3);
});

it('shows lookup rejection and never falls back to the external opener', async () => {
  await requestFile({ ok: false, error: 'Not a local file URL' });
  expect(alertText()).toBe('Not a local file URL');
  act(() => button('Open file').click());
  await answer(requests[1], { ok: false, error: 'Not a local file URL' });
  expect(alertText()).toBe('Not a local file URL');
  expect(mocks.open).not.toHaveBeenCalled();
});

it('ignores an old launch result and old callback after a new link replaces the dialog', async () => {
  await requestFile();
  const oldConfirm = mocks.confirm;
  act(() => button('Open file').click());
  act(() => requestExternalLinkConfirmation('https://example.com/'));
  await act(async () => { oldConfirm(); requests[1].respond({ ok: true }); });
  expect(getExternalLinkConfirmationSnapshot()?.uri).toBe('https://example.com/');
  expect(requests).toHaveLength(2);
  expect(mocks.open).not.toHaveBeenCalled();
});

it('ignores a late viewer lookup after cancellation', async () => {
  act(() => requestExternalLinkConfirmation(fileUri, '[Image #2]', source));
  act(() => button('Cancel').click());
  await answer(requests[0], { ok: false, error: 'late error' });
  expect(getExternalLinkConfirmationSnapshot()).toBeNull();
  expect(alertText()).toBeUndefined();
  expect(requests).toHaveLength(1);
});

it('does not inspect or open files hidden behind deceptive link text', () => {
  act(() => requestExternalLinkConfirmation(fileUri, 'https://trusted.example/', source));
  act(() => mocks.confirm());
  expect(mocks.open).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});

it('explains a file link with no originating terminal instead of passing it to the OS', () => {
  act(() => requestExternalLinkConfirmation(fileUri));
  act(() => button('Open file').click());
  expect(alertText()).toContain('originating terminal');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});
