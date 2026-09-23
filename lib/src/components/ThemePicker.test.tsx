/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemePicker } from './ThemePicker';
import { installLocalStorageStub } from '../lib/test-local-storage';
import { setNativeFieldValue } from '../lib/dom';
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ThemePicker', () => {
  // The panel's height contract — list shrinks, footer survives — is geometry,
  // which jsdom cannot see (no layout, no CSS). Asserting the class list here
  // would fail on any equivalent restyle and pass on real breakage, so it lives
  // in `Modals/…`/`Components/ThemePicker` Chromatic stories instead
  // (`OpenOnShortViewport`). `design.test.ts` pins the cap to its constants.
  it('shares the active theme preview between the closed trigger and its list entry', () => {
    act(() => root.render(<ThemePicker variant="settings-dialog" />));

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => trigger.click());
    const selected = container.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]')!;
    // The collapsed trigger has to carry the same palette and the same swatch —
    // both circles — as the row it stands in for, so collapsed and expanded read
    // as one control. Non-null on both sides: a missing swatch must fail here.
    expect(selected.parentElement!.style.color).toBe(trigger.style.color);
    expect(selected.parentElement!.style.backgroundColor).toBe(trigger.style.backgroundColor);
    expect(selected.querySelector('[data-theme-swatch]')!.outerHTML)
      .toBe(trigger.querySelector('[data-theme-swatch]')!.outerHTML);
  });

  /** Open the compact picker and return its menu panel. */
  function openCompact(props: Partial<Parameters<typeof ThemePicker>[0]> = {}) {
    act(() => root.render(<ThemePicker variant="compact" {...props} />));
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    act(() => trigger.click());
    return container.querySelector<HTMLDivElement>('[role="menu"]')!;
  }

  // Only the geometry `useAnchoredMenu` computes — the rest of the panel is
  // Tailwind, and asserting a class list would fail on any equivalent restyle
  // while passing on real breakage (docs/specs/theme.rationale.md).
  it('offsets the compact menu off its trigger, capped to the viewport', () => {
    const menu = openCompact();
    expect(menu.style.position).toBe('absolute');
    expect(menu.style.right).toBe('0px');
    expect(menu.style.top).toBe('calc(100% + 4px)');
    expect(menu.style.width).toBe('280px');
    expect(menu.style.maxHeight).toContain('min(');
    expect(menu.style.maxHeight).toContain('100dvh - 24px');
  });

  it('opens the compact menu upward when asked, off the same edge', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 700,
      y: 700,
      top: 700,
      left: 700,
      width: 60,
      height: 20,
      right: 760,
      bottom: 720,
      toJSON: () => ({}),
    });
    const menu = openCompact({ menuSide: 'above' });
    expect(menu.style.bottom).toBe('calc(100% + 4px)');
    expect(menu.style.top).toBe('');
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
  // The store dialog is mounted only while open, so no request that settles
  // after a close can reach the next open. Driven through the picker because
  // that conditional mount is what holds it.
  it('reopens the theme store on a clean slate after a close with work in flight', async () => {
    HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
    let failInstall!: () => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url.includes('/-/search')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            extensions: [{
              namespace: 'test', name: 'dracula', displayName: 'Dracula Official',
              description: '', version: '1.0.0', downloadCount: 1,
            }],
          }),
        });
      }
      return new Promise((resolve) => { failInstall = () => resolve({ ok: false, status: 503 }); });
    }));
    const button = (text: string) => [...container.querySelectorAll('button')]
      .find((candidate) => candidate.textContent === text || candidate.getAttribute('aria-label') === text)!;
    const openStore = () => {
      act(() => (container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!).click());
      act(() => button('Install theme from OpenVSX').click());
    };

    vi.useFakeTimers();
    try {
      act(() => root.render(<ThemePicker variant="settings-dialog" />));
      openStore();
      act(() => setNativeFieldValue(container.querySelector('input')!, 'dracula'));
      await act(async () => { vi.advanceTimersByTime(300); });
      act(() => button('Install').click());

      act(() => button('Close theme store').click());
      await act(async () => { failInstall(); });
      openStore();

      expect(container.querySelector('input')!.value).toBe('');
      expect(container.textContent).not.toContain('Dracula Official');
      expect(container.textContent).not.toContain('503');
    } finally {
      vi.useRealTimers();
    }
  });
});
