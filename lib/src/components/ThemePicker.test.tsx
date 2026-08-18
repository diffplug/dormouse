/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemePicker } from './ThemePicker';
import { installLocalStorageStub } from '../lib/test-local-storage';
import { ensureResizeObserver } from './wall/wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  ensureResizeObserver();
  installLocalStorageStub();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('ThemePicker', () => {
  // The panel's height contract — list shrinks, footer survives — is geometry,
  // which jsdom cannot see (no layout, no CSS). Asserting the class list here
  // would fail on any equivalent restyle and pass on real breakage, so it lives
  // in `Modals/…`/`Components/ThemePicker` Chromatic stories instead
  // (`OpenOnShortViewport`). `design.test.ts` pins the cap to its constants.
  it('shows the active theme swatch on the collapsed trigger', () => {
    act(() => root.render(<ThemePicker variant="settings-dialog" />));

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    // The collapsed trigger has to carry the same swatch as the row it stands
    // in for, so collapsed and expanded read as one control.
    expect(trigger?.querySelector('span[class*="rounded-full"]')).not.toBeNull();
  });
});
