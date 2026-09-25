/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { SettingsDialog, SETTINGS_SCROLL_MS } from './SettingsDialog';
import { makeStubBurrowLink, UNENROLLED_STATUS } from '../host/remote/test-burrow-link';
import { stubResizeObserver } from './wall/wall-test-utils';
import { setNativeFieldValue } from '../lib/dom';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS, getAlertSettings } from '../lib/alert-settings';
import { setCommandWatched, getWatchedCommands } from '../lib/terminal-registry';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;
const scrollTo = vi.fn();
let sectionOffsets: Record<string, number>;
let frameTime: number;
let nextFrame: number;
let frames: Map<number, FrameRequestCallback>;

async function advanceScroll(ms = SETTINGS_SCROLL_MS) {
  frameTime += ms;
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => pending.forEach((callback) => callback(frameTime)));
}

function text(): string {
  return document.body.textContent ?? '';
}

function byText(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    (button) => (button.textContent ?? '').trim() === label,
  );
  if (!found) throw new Error(`no button reading ${label}`);
  return found;
}

async function render(onClose = () => {}) {
  await act(async () => root.render(<SettingsDialog onClose={onClose} />));
  await act(async () => {});
  const content = document.getElementById('settings-content');
  if (content) {
    Object.defineProperty(content, 'clientHeight', { value: 400 });
    Object.defineProperty(content, 'scrollHeight', { value: 1400 });
  }
}

function visible(selector: string): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>(selector)].filter((node) => !node.closest('[hidden]'));
}

async function search(value: string) {
  await act(async () => setNativeFieldValue(document.querySelector<HTMLInputElement>('input[type="search"]')!, value));
}

async function scrollContent(top: number) {
  const content = document.getElementById('settings-content')!;
  await act(async () => {
    content.scrollTop = top;
    content.dispatchEvent(new Event('scroll'));
  });
}

async function pointerOver(target: Element, pointerType: string) {
  await act(async () => target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType })));
}

async function key(target: Element, key: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
}

beforeEach(() => {
  scrollTo.mockClear();
  scrollTo.mockImplementation(function (this: HTMLElement, { top }: ScrollToOptions) {
    this.scrollTop = top!;
  });
  frameTime = 0;
  nextFrame = 0;
  frames = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => frameTime);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  sectionOffsets = { general: 16, activity: 116, notifications: 516, relay: 916 };
  stubResizeObserver(400);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const top = this.dataset.settingsTopic
      ? sectionOffsets[this.dataset.settingsTopic] - (document.getElementById('settings-content')?.scrollTop ?? 0) : 0;
    return { top, bottom: top + 100, left: 0, right: 400, width: 400, height: 100, x: 0, y: top, toJSON() {} };
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  for (const command of getWatchedCommands()) setCommandWatched(command, false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  container.remove();
});

describe('SettingsDialog navigation and search', () => {

  it('corrects a moving scroll target until the user takes over', async () => {
    await render();
    await act(async () => byText('Notifications').click());
    await advanceScroll(SETTINGS_SCROLL_MS / 2);
    expect(document.getElementById('settings-content')!.scrollTop).toBeCloseTo(250);
    sectionOffsets.notifications += 50;
    await advanceScroll(SETTINGS_SCROLL_MS / 2);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 550, behavior: 'instant' });
    await act(async () => byText('Activity').click());
    await advanceScroll(SETTINGS_SCROLL_MS / 2);
    await act(async () => document.getElementById('settings-content')!.dispatchEvent(new Event('wheel', { bubbles: true })));
    scrollTo.mockClear();
    sectionOffsets.notifications += 50;
    await advanceScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('lets hovering settings override scrolling without moving the page, then resumes scroll tracking on leave', async () => {
    await render();
    const heading = document.getElementById('settings-heading-notifications')!;
    scrollTo.mockClear();
    await pointerOver(heading, 'touch');
    expect(byText('General').getAttribute('aria-current')).toBe('location');
    await pointerOver(heading, 'mouse');
    expect(byText('Notifications').getAttribute('aria-current')).toBe('location');
    expect(scrollTo).not.toHaveBeenCalled();
    await scrollContent(150);
    expect(byText('Notifications').getAttribute('aria-current')).toBe('location');
    await act(async () => {
      heading.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(byText('Activity').getAttribute('aria-current')).toBe('location');
  });

  it('scrolls on mouse hover and click without hiding sections or reacting to touch hover', async () => {
    await render();
    scrollTo.mockClear();
    await pointerOver(byText('Notifications'), 'touch');
    await advanceScroll();
    expect(scrollTo).not.toHaveBeenCalled();
    await pointerOver(byText('Notifications'), 'mouse');
    await advanceScroll();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'instant' });
    expect(byText('Notifications').getAttribute('aria-current')).toBe('location');
    await act(async () => byText('Activity').click());
    await advanceScroll();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: 'instant' });
    expect(visible('[role="region"]')).toHaveLength(4);
  });

  it('finds live command names and edits a setting directly in results', async () => {
    await render();
    await search('my-agent');
    expect(visible('[role="region"]')).toHaveLength(0);
    await act(async () => setCommandWatched('my-agent', true));
    expect(visible('[data-setting]').map((node) => node.dataset.setting)).toEqual(['watcher']);
    const before = getAlertSettings().deferAlertsUntilQuiet;
    await act(async () => visible('[role="switch"]')[0].click());
    expect(getAlertSettings().deferAlertsUntilQuiet).toBe(!before);
  });

  it('keeps Tab focus out of search-filtered settings', async () => {
    await render();
    await search('walked away');
    expect(document.activeElement).toBe(document.querySelector('input[type="search"]'));
    for (let i = 0; i < 8; i++) {
      await key(document.activeElement!, 'Tab');
      expect(document.activeElement?.closest('[hidden]')).toBeNull();
      expect((document.activeElement as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('closes on backdrop clicks but not settings clicks, and closes pickers before Escape dismisses', async () => {
    const close = vi.fn();
    await render(close);
    const modal = document.querySelector<HTMLElement>('[role="dialog"]')!;
    const backdrop = modal.parentElement!;
    await act(async () => modal.click());
    expect(close).not.toHaveBeenCalled();
    await act(async () => {
      modal.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      backdrop.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      backdrop.click();
    });
    expect(close).not.toHaveBeenCalled();
    const theme = document.querySelector<HTMLButtonElement>('button[aria-label^="Theme:"]')!;
    await act(async () => theme.click());
    await key(theme, 'Escape');
    expect(close).not.toHaveBeenCalled();
    await key(theme, 'Escape');
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => {
      backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      backdrop.click();
    });
    expect(close).toHaveBeenCalledTimes(2);
  });
});
