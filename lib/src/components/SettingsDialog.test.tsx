/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { AlarmSettingsSection, SettingsDialog, SETTINGS_SCROLL_MS } from './SettingsDialog';
import { enrolledStatus, makeStubBurrowLink, UNENROLLED_STATUS } from '../host/remote/test-burrow-link';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import { makeStubManagedVoicePort } from '../lib/platform/test-ports';
import { networkPolicyResult, nothingPolicy } from '../remote/network-policy';
import { stubResizeObserver } from './wall/wall-test-utils';
import { setNativeFieldValue } from '../lib/dom';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from '../lib/alert-settings';
import { resetPushDevices, setCommandWatched, getWatchedCommands, setPushDevices } from '../lib/terminal-registry';
import { _resetIframeAllowlistForTesting, allowIframeOrigin, getIframeAllowlist } from '../lib/iframe-allowlist';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;
const scrollTo = vi.fn();
let sectionOffsets: Record<string, number>;
let frameTime: number;
let nextFrame: number;
let frames: Map<number, FrameRequestCallback>;
let resize: (width: number) => void;

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
  sectionOffsets = { general: 16, notifications: 516, network: 916, about: 1316 };
  resize = stubResizeObserver(400);
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
    await act(async () => byText('General').click());
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
    expect(byText('General').getAttribute('aria-current')).toBe('location');
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
    await act(async () => byText('General').click());
    await advanceScroll();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: 'instant' });
    expect(visible('[role="region"]')).toHaveLength(3);
  });

  it('finds live command names and edits a setting directly in results', async () => {
    await render();
    await search('my-agent');
    expect(visible('[role="region"]')).toHaveLength(0);
    await act(async () => setCommandWatched('my-agent', true));
    expect(visible('[data-setting]').map((node) => node.dataset.setting)).toEqual(['watcher']);
    await act(async () => visible('button[aria-label="Remove my-agent rule"]')[0].click());
    expect(getWatchedCommands()).not.toContain('my-agent');
  });

  it('lists the external origins iframe previews may show, each removable, and nothing until one is', async () => {
    _resetIframeAllowlistForTesting();
    await render();
    expect(document.querySelector('[data-setting="previews"]')).toBeNull();
    await act(async () => allowIframeOrigin('http://docs.example'));
    await search('docs.example');
    expect(visible('[data-setting]').map((node) => node.dataset.setting)).toEqual(['previews']);
    await act(async () => visible('button[aria-label="Remove http://docs.example"]')[0].click());
    expect(getIframeAllowlist()).toEqual([]);
    expect(document.querySelector('[data-setting="previews"]')).toBeNull();
  });

  it('keeps a topic chosen while the opened-at topic settles', async () => {
    await act(async () => root.render(<SettingsDialog onClose={() => {}} initialTopic="network" />));
    await act(async () => {});
    const content = document.getElementById('settings-content')!;
    Object.defineProperty(content, 'clientHeight', { value: 400 });
    Object.defineProperty(content, 'scrollHeight', { value: 1400 });
    await advanceScroll();
    expect(content.scrollTop).toBe(900);
    await act(async () => byText('Notifications').click());
    await advanceScroll();
    expect(content.scrollTop).toBe(500);
    await act(async () => resize(400));
    await advanceScroll();
    expect(content.scrollTop).toBe(500);
  });

  it('ends with About, which a search for the version finds alone', async () => {
    vi.stubGlobal('__DORMOUSE_BUILD__', { version: '1.2.0', commit: 'd080b4f5', commitsSinceVersion: 14, dirty: false, official: false, host: 'standalone' });
    await render();
    const nav = document.querySelector('nav[aria-label="Settings topics"]')!;
    expect([...nav.querySelectorAll('button')].at(-1)?.textContent).toBe('About');
    await search('version');
    expect(visible('[data-setting]').map((node) => node.dataset.setting)).toEqual(['about']);
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

describe('SettingsDialog under Network → Nothing', () => {
  it('says push and managed voice are off, each linking to the Network topic', async () => {
    platform.burrow = makeStubBurrowLink({
      status: UNENROLLED_STATUS,
      network: networkPolicyResult(nothingPolicy(), 'hosted', []),
    });
    platform.managedVoice = makeStubManagedVoicePort(true);
    await render();
    expect(text()).toContain('Push is off while Network is set to Nowhere.');
    expect(text()).toContain(
      'Natural Voice is off while Network is set to Nowhere, so alerts use your browser or system voice.',
    );
    expect(text()).not.toContain('Connect this machine to a Dormouse Relay');

    scrollTo.mockClear();
    const link = [...document.querySelectorAll<HTMLButtonElement>('[data-setting="push"] button')]
      .find((button) => button.textContent === 'Network')!;
    await act(async () => link.click());
    await advanceScroll();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 900, behavior: 'instant' });
  });

  it('clears a search that hides the Network topic before following the link to it', async () => {
    platform.burrow = makeStubBurrowLink({
      status: UNENROLLED_STATUS,
      network: networkPolicyResult(nothingPolicy(), 'hosted', []),
    });
    await render();
    await search('push is off');
    const network = document.querySelector<HTMLElement>('[data-settings-topic="network"]')!;
    expect(network.hidden).toBe(true);

    const link = visible('[data-setting="push"] button').find((button) => button.textContent === 'Network')!;
    await act(async () => link.click());
    expect(document.querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('');
    expect(network.hidden).toBe(false);
  });
});

describe('SettingsDialog push line', () => {
  /** An enrolled Hosted build whose relay socket is in `connection`. */
  const hosted = (connection: BurrowConsoleStatus['connection']) =>
    ({ ...UNENROLLED_STATUS, enrolled: true, serving: true, burrowId: 'burrow-6f1c2a90', connection });

  const pushLine = () => document.querySelector('[data-setting="push"]')?.textContent ?? '';

  afterEach(() => resetPushDevices());

  it('says an account with no plan sends no push, linking the plans, where the list fetch failed', async () => {
    platform.burrow = makeStubBurrowLink({ status: hosted('not-entitled') });
    setPushDevices({ status: 'error', devices: [] });
    const openExternal = vi.fn();
    Object.assign(platform, { openExternal });
    await render();
    expect(pushLine()).toContain('Your account has no Hosted plan, so no push is sent.');
    expect(pushLine()).not.toContain('Could not reach the Relay');
    const plans = [...document.querySelectorAll<HTMLButtonElement>('[data-setting="push"] button')]
      .find((button) => button.textContent === 'See Hosted plans')!;
    await act(async () => plans.click());
    expect(openExternal).toHaveBeenCalledWith('https://dormouse.sh/hosted/?ref=settings-push#pricing');
  });

  it('points a computer removed from its Hosted account at enrolling again below', async () => {
    platform.burrow = makeStubBurrowLink({ status: hosted('removed') });
    setPushDevices({ status: 'no-burrow', devices: [] });
    await render();
    expect(pushLine()).toContain(
      'This computer was removed from your Hosted account, so no push is sent. Enroll it again under Hosted Relay below.',
    );
    expect(pushLine()).not.toContain('Connect this machine');
  });

  it('names the self-host Relay that refused, and never Hosted', async () => {
    platform.burrow = makeStubBurrowLink({ status: enrolledStatus({ connection: 'removed' }) });
    setPushDevices({ status: 'no-burrow', devices: [] });
    await render();
    expect(pushLine()).toMatch(/no longer accepts this computer, so no push is sent\. Disconnect and enroll it again under Persistent Relay below\./);
    expect(pushLine()).not.toContain('Hosted');
  });

  it('keeps the network failure for a Relay that has not refused', async () => {
    platform.burrow = makeStubBurrowLink({ status: hosted('connected') });
    setPushDevices({ status: 'error', devices: [] });
    await render();
    expect(pushLine()).toContain('Could not reach the Relay to list phones.');
  });

  it('points the brief preview, which has no Remote control below it, at Settings → Network', async () => {
    platform.burrow = makeStubBurrowLink({ status: hosted('removed') });
    await act(async () => root.render(<AlarmSettingsSection sink="push" preview />));
    await act(async () => {});
    expect(text()).toContain('Enroll it again under Hosted Relay in Settings → Network.');
  });
});

describe('SettingsDialog theme row', () => {
  it.each([[true, true], [undefined, false]] as const)(
    'offers the OpenVSX store only on a platform that does (offersThemeStore %s)',
    async (offers, shown) => {
      platform.offersThemeStore = offers;
      await render();
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Theme: "]')!;
      await act(async () => trigger.click());
      const menu = document.querySelector('[role="menu"][aria-label="Select theme"]')!;
      expect(menu.textContent?.includes('Install theme from OpenVSX')).toBe(shown);
    },
  );
});
