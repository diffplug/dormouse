/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { __resetArchiveServiceForTests } from '../lib/notepad/archive-service';
import { clearAllNotepads } from '../lib/notepad/notepad-store';
import { SettingsDialog } from './SettingsDialog';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS, getAlertSettings } from '../lib/alert-settings';
import { setCommandWatched, getWatchedCommands } from '../lib/terminal-registry';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;
const scrollTo = vi.fn();
let sectionOffsets: Record<string, number>;
let resizeCallbacks: Array<() => void>;

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
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function key(target: Element, key: string) {
  await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
}

beforeEach(() => {
  scrollTo.mockClear();
  sectionOffsets = { general: 16, activity: 116, notifications: 516, notepad: 1116 };
  resizeCallbacks = [];
  vi.stubGlobal('PointerEvent', MouseEvent);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    const top = this.dataset.settingsTopic
      ? sectionOffsets[this.dataset.settingsTopic] - (document.getElementById('settings-content')?.scrollTop ?? 0) : 0;
    return { top, bottom: top + 100, left: 0, right: 400, width: 400, height: 100, x: 0, y: top, toJSON() {} };
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallbacks.push(callback); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  __resetArchiveServiceForTests();
  clearAllNotepads();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  for (const command of getWatchedCommands()) setCommandWatched(command, false);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  container.remove();
  __resetArchiveServiceForTests();
  clearAllNotepads();
});

describe('SettingsDialog notepad archive entry', () => {
  it('opens the Archive view in place and comes back', async () => {
    await render();
    expect(text()).toContain('Notepad archive');
    await act(async () => byText('Notepad').click());

    await act(async () => byText('Open archive').click());
    // Same dialog, different view: the archive's own chrome is what proves it.
    expect(byText('Back to Settings')).toBeTruthy();
    expect(text()).toContain('Nothing archived yet');

    await act(async () => byText('Back to Settings').click());
    expect(byText('Open archive')).toBeTruthy();
  });

  it('offers no entry on a host with no archive port', async () => {
    // Pocket's shape: the adapter simply has no `notepadArchive` at all.
    Reflect.deleteProperty(platform, 'notepadArchive');

    await render();

    expect(text()).not.toContain('Notepad archive');
  });
});

describe('SettingsDialog navigation and search', () => {
  it('keeps every section visible and smoothly navigates with the contents keyboard', async () => {
    await render();
    expect(document.activeElement).toBe(document.querySelector('input[type="search"]'));
    expect(visible('[role="region"]')).toHaveLength(4);
    byText('General').focus();
    await key(byText('General'), 'ArrowDown');
    expect(document.activeElement).toBe(byText('Activity'));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: 'smooth' });
    expect(visible('[role="region"]')).toHaveLength(4);
    await key(byText('Activity'), 'End');
    expect(document.activeElement).toBe(byText('Notepad'));
    await key(byText('Notepad'), 'ArrowDown');
    expect(document.activeElement).toBe(byText('General'));
    await key(byText('General'), 'ArrowUp');
    expect(document.activeElement).toBe(byText('Notepad'));
    await key(byText('Notepad'), 'Home');
    expect(document.activeElement).toBe(byText('General'));
  });

  it('follows manual scrolling, including a short final section at the bottom', async () => {
    await render();
    const content = document.getElementById('settings-content')!;
    await act(async () => {
      content.scrollTop = 150;
      content.dispatchEvent(new Event('scroll'));
    });
    expect(byText('Activity').getAttribute('aria-current')).toBe('location');
    await act(async () => {
      content.scrollTop = 1000;
      content.dispatchEvent(new Event('scroll'));
    });
    expect(byText('Notepad').getAttribute('aria-current')).toBe('location');
  });

  it('corrects a moving scroll target until the user takes over', async () => {
    await render();
    await act(async () => byText('Notifications').click());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'smooth' });
    sectionOffsets.notifications += 50;
    await act(async () => resizeCallbacks.forEach((callback) => callback()));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 550, behavior: 'smooth' });
    await act(async () => document.getElementById('settings-content')!.dispatchEvent(new Event('wheel', { bubbles: true })));
    scrollTo.mockClear();
    sectionOffsets.notifications += 50;
    await act(async () => resizeCallbacks.forEach((callback) => callback()));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('lets hovering settings override scrolling without moving the page, then resumes scroll tracking on leave', async () => {
    await render();
    const content = document.getElementById('settings-content')!;
    const heading = document.getElementById('settings-heading-notifications')!;
    const enter = (pointerType: string) => {
      const event = new Event('pointerover', { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: pointerType });
      heading.dispatchEvent(event);
    };
    scrollTo.mockClear();
    await act(async () => enter('touch'));
    expect(byText('General').getAttribute('aria-current')).toBe('location');
    await act(async () => enter('mouse'));
    expect(byText('Notifications').getAttribute('aria-current')).toBe('location');
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => {
      content.scrollTop = 150;
      content.dispatchEvent(new Event('scroll'));
    });
    expect(byText('Notifications').getAttribute('aria-current')).toBe('location');
    await act(async () => {
      heading.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: document.body }));
    });
    expect(byText('Activity').getAttribute('aria-current')).toBe('location');
  });

  it('scrolls on mouse hover and click without hiding sections or reacting to touch hover', async () => {
    await render();
    const enter = (pointerType: string) => {
      const event = new Event('pointerover', { bubbles: true });
      Object.defineProperty(event, 'pointerType', { value: pointerType });
      byText('Notifications').dispatchEvent(event);
    };
    scrollTo.mockClear();
    await act(async () => enter('touch'));
    expect(scrollTo).not.toHaveBeenCalled();
    await act(async () => enter('mouse'));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 500, behavior: 'smooth' });
    expect(byText('Notifications').getAttribute('aria-current')).toBe('location');
    await act(async () => byText('Activity').click());
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: 'smooth' });
    expect(visible('[role="region"]')).toHaveLength(4);
  });

  it('omits unavailable topics and searches only settings the host offers', async () => {
    Object.defineProperty(platform, 'hostOwnsTheme', { value: true });
    Object.defineProperty(platform, 'hostOwnsShells', { value: true });
    Reflect.deleteProperty(platform, 'notepadArchive');
    await render();
    expect(visible('nav button').map((node) => node.textContent)).toEqual(['Activity', 'Notifications']);
    expect(visible('[role="region"]')[0].id).toBe('settings-topic-activity');
    await search('theme');
    expect(visible('[role="region"]')).toHaveLength(0);
    expect(text()).toContain('No settings found.');
  });

  it('searches descriptions across topics, normalizes whitespace/case, and restores the full page', async () => {
    await render();
    await act(async () => byText('Notepad').click());
    await search(' TeRMiNaL ');
    expect(visible('[role="region"]').map((node) => node.id)).toEqual(['settings-topic-activity', 'settings-topic-notepad']);
    await search('  WALKED   away ');
    expect(visible('[data-setting]').map((node) => node.dataset.setting)).toEqual(['inactivity']);
    await search('');
    expect(visible('[role="region"]')).toHaveLength(4);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'smooth' });
    await search('unknown setting');
    expect(visible('[role="region"]')).toHaveLength(0);
    expect(visible('nav button')).toHaveLength(0);
    await search('walked away');
    await act(async () => byText('Activity').click());
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('walked away');
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
    const searchInput = document.querySelector('input[type="search"]')!;
    searchInput.dispatchEvent(new Event('focus'));
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
    await act(async () => modal.click());
    expect(close).not.toHaveBeenCalled();
    const theme = document.querySelector<HTMLButtonElement>('button[aria-label^="Theme:"]')!;
    await act(async () => theme.click());
    await key(theme, 'Escape');
    expect(close).not.toHaveBeenCalled();
    await key(theme, 'Escape');
    expect(close).toHaveBeenCalledTimes(1);
    await act(async () => modal.parentElement!.click());
    expect(close).toHaveBeenCalledTimes(2);
  });
});
