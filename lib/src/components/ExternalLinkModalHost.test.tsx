/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExternalLinkModalHost } from './ExternalLinkModalHost';
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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  mocks.open.mockReset();
  mocks.toolControl.mockReset().mockResolvedValue({ status: 'open-handlers', handlers: { handlers: [
    { tool: 'builtin:file', description: 'Rendered document', reason: 'built-in' },
    { tool: 'builtin:code', description: 'Source code', reason: 'built-in' },
  ], config: '/home/me/.config/dormouse/dormouse.yml' } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ExternalLinkModalHost />));
});
afterEach(() => {
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
const button = (text: string) => [...document.body.querySelectorAll('button')].find(button => button.textContent === text)!;
type Request = { params: Record<string, unknown>; surfaceId: string; respond: (result: { ok: boolean; error?: string }) => void };
let requests: Request[];
const capture = (event: Event) => requests.push((event as CustomEvent<Request>).detail);
beforeEach(() => { requests = []; window.addEventListener('dormouse:control-request', capture); });
afterEach(() => window.removeEventListener('dormouse:control-request', capture));
const requestFile = async () => { await act(async () => requestExternalLinkConfirmation(fileUri, '[Image #2]', source)); };

it('loads the picker candidates without opening, then opens the default in the originating Session', async () => {
  await requestFile();
  expect(mocks.toolControl).toHaveBeenCalledWith({ op: 'open-handlers', target: fileUri, cwd: '/work' });
  expect(requests).toEqual([]);
  expect(document.body.textContent).toContain('Rendered document');
  act(() => button('Open file').click());
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ surfaceId: 'pane-a', params: { file: fileUri, surface: 'pane-a', cwd: '/work' } });
  expect(requests[0].params).not.toHaveProperty('tool');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(getExternalLinkConfirmationSnapshot()).not.toBeNull();
  act(() => requests[0].respond({ ok: true }));
  expect(getExternalLinkConfirmationSnapshot()).toBeNull();
});

it('opens another candidate explicitly, keeps failures visible, and allows retry', async () => {
  await requestFile();
  const select = document.body.querySelector('select')!;
  act(() => { select.value = 'builtin:code'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(document.body.textContent).toContain('Source code');
  act(() => button('Open file').click());
  expect(requests[0].params.tool).toBe('builtin:code');
  act(() => mocks.confirm());
  expect(requests).toHaveLength(1);
  act(() => requests[0].respond({ ok: false, error: 'File no longer exists' }));
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('File no longer exists');
  expect(getExternalLinkConfirmationSnapshot()).not.toBeNull();
  act(() => button('Open file').click());
  expect(requests).toHaveLength(2);
});

it('shows lookup rejection and never falls back to the external opener', async () => {
  mocks.toolControl.mockResolvedValue({ status: 'error', message: 'Not a local file URL' });
  await requestFile();
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Not a local file URL');
  act(() => button('Open file').click());
  act(() => requests[0].respond({ ok: false, error: 'Not a local file URL' }));
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('Not a local file URL');
  expect(mocks.open).not.toHaveBeenCalled();
});

it('ignores an old launch result and old callback after a new link replaces the dialog', async () => {
  await requestFile();
  const oldConfirm = mocks.confirm;
  act(() => button('Open file').click());
  act(() => requestExternalLinkConfirmation('https://example.com/'));
  act(() => { oldConfirm(); requests[0].respond({ ok: true }); });
  expect(getExternalLinkConfirmationSnapshot()?.uri).toBe('https://example.com/');
  expect(requests).toHaveLength(1);
  expect(mocks.open).not.toHaveBeenCalled();
});

it('ignores a late viewer lookup after cancellation', async () => {
  let finish!: (value: unknown) => void;
  mocks.toolControl.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await requestFile();
  act(() => button('Cancel').click());
  await act(async () => finish({ status: 'error', message: 'late error' }));
  expect(getExternalLinkConfirmationSnapshot()).toBeNull();
  expect(document.body.querySelector('[role="alert"]')).toBeNull();
  expect(requests).toHaveLength(0);
});

it('does not inspect or open files hidden behind deceptive link text', async () => {
  await act(async () => requestExternalLinkConfirmation(fileUri, 'https://trusted.example/', source));
  act(() => mocks.confirm());
  expect(mocks.toolControl).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});

it('explains a file link with no originating terminal instead of passing it to the OS', async () => {
  await act(async () => requestExternalLinkConfirmation(fileUri));
  act(() => button('Open file').click());
  expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('originating terminal');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(requests).toHaveLength(0);
});
