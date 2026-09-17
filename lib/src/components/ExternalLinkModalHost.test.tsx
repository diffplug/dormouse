/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ExternalLinkModalHost } from './ExternalLinkModalHost';
import { clearExternalLinkConfirmation, requestExternalLinkConfirmation } from '../lib/external-link-confirmation';

const mocks = vi.hoisted(() => ({ open: vi.fn(), confirm: () => {} }));
vi.mock('../lib/platform', () => ({ getPlatform: () => ({ openExternal: mocks.open }) }));
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
  mocks.open.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<ExternalLinkModalHost onKeyboardActiveChange={() => {}} />));
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
