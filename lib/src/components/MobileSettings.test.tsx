/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobileSettings } from './MobileSettings';
import { MOBILE_FONT_SIZE_KEY, useMobileFontSize } from '../lib/mobile-font-size';
import { ACTIVE_THEME_KEY, getBundledThemes } from '../lib/themes/store';
import * as registry from '../lib/terminal-registry';
import { ensureResizeObserver } from './wall/wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
ensureResizeObserver();

let root: Root | null = null;

function render(node: React.ReactNode): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<StrictMode>{node}</StrictMode>));
  return container;
}

function pickTheme(container: HTMLElement, label: string) {
  act(() => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
  act(() => container.querySelector<HTMLButtonElement>(`[role="menu"] button[title="${label}"]`)!.click());
}

function FontSizeHost({ persist }: { persist: boolean }) {
  useMobileFontSize(persist);
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('MobileSettings', () => {
  it('saves a font size step and the picked theme when it persists', () => {
    const setFontSize = vi.spyOn(registry, 'setTerminalFontSize');
    const container = render(<MobileSettings persist />);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Larger text"]')!.click());
    expect(setFontSize).toHaveBeenLastCalledWith(13);
    expect(localStorage.getItem(MOBILE_FONT_SIZE_KEY)).toBe('13');
    expect(container.querySelector<HTMLElement>('[data-testid="mobile-font-size-preview"]')!.style.fontSize).toBe('13px');

    const theme = getBundledThemes()[1]!;
    pickTheme(container, theme.label);
    expect(localStorage.getItem(ACTIVE_THEME_KEY)).toBe(theme.id);
    expect(container.querySelector(`button[aria-label="Theme: ${theme.label}"]`)).not.toBeNull();
  });

  it('keeps nothing when it does not persist', () => {
    const container = render(<MobileSettings persist={false} />);
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Smaller text"]')!.click());
    const theme = getBundledThemes()[1]!;
    pickTheme(container, theme.label);
    expect(localStorage.length).toBe(0);
    expect(container.querySelector(`button[aria-label="Theme: ${theme.label}"]`)).not.toBeNull();
  });
});

describe('useMobileFontSize', () => {
  it('restores a saved size before first render and hands it back to the theme on unmount', () => {
    localStorage.setItem(MOBILE_FONT_SIZE_KEY, '40');
    const setFontSize = vi.spyOn(registry, 'setTerminalFontSize');
    render(<FontSizeHost persist />);
    expect(setFontSize).toHaveBeenNthCalledWith(1, 24);
    act(() => root!.unmount());
    root = null;
    expect(setFontSize).toHaveBeenLastCalledWith(null);
  });

  it('reads nothing when it does not persist', () => {
    localStorage.setItem(MOBILE_FONT_SIZE_KEY, '16');
    const setFontSize = vi.spyOn(registry, 'setTerminalFontSize');
    render(<FontSizeHost persist={false} />);
    expect(setFontSize).not.toHaveBeenCalledWith(16);
  });
});
