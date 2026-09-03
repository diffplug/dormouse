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

  /** Open the compact picker and return its menu panel. */
  function openCompact(props: Partial<Parameters<typeof ThemePicker>[0]> = {}) {
    act(() => root.render(<ThemePicker variant="compact" {...props} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => trigger.click());
    return container.querySelector<HTMLDivElement>('[role="menu"]')!;
  }

  it('offsets the compact menu with style, not a utility class', () => {
    // The website renders this against the lib's prebuilt stylesheet, where a
    // never-emitted utility simply does not exist and the menu would fall back
    // to its static position (docs/specs/theme.md).
    expect(openCompact({ menuSide: 'above' }).style.bottom).toBe('100%');
    act(() => root.render(<></>));
    expect(openCompact().style.top).toBe('100%');
  });

  it('reports a pick even when it does not change the active theme', () => {
    // `subscribeToActiveTheme` reports a changed id and would stay silent here,
    // but re-picking the active theme is still an answer to "have you chosen?".
    const onPick = vi.fn();
    const menu = openCompact({ onPick });
    const active = menu.querySelector<HTMLButtonElement>('button[aria-checked="true"]')
      ?? menu.querySelector<HTMLButtonElement>('button')!;

    act(() => active.click());
    expect(onPick).toHaveBeenCalledTimes(1);

    act(() => (container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!).click());
    const again = container.querySelector<HTMLDivElement>('[role="menu"]')!;
    act(() => again.querySelector<HTMLButtonElement>('button')!.click());
    expect(onPick).toHaveBeenCalledTimes(2);
  });
});
