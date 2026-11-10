/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClipboardFailureGlobal } from './ClipboardFailureDialog';
import { beginClipboardAttempt, dismissClipboardFailure, reportClipboardFailure } from '../lib/clipboard-failure';
import { chromeKeyboardHeld, resetChromeKeyboardLeases } from './wall/chrome-keyboard-lease';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  dismissClipboardFailure();
  resetChromeKeyboardLeases();
});

describe('ClipboardFailureGlobal', () => {
  // Its Enter must reach the focused button, not the Wall behind it.
  it('holds the chrome keyboard lease while the dialog is open', () => {
    act(() => root.render(<ClipboardFailureGlobal />));
    expect(chromeKeyboardHeld()).toBe(false);
    act(() => reportClipboardFailure(beginClipboardAttempt(5)));
    expect(document.querySelector('#clipboard-failure-title')).not.toBeNull();
    expect(chromeKeyboardHeld()).toBe(true);
    act(() => dismissClipboardFailure());
    expect(chromeKeyboardHeld()).toBe(false);
  });
});
