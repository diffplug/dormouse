/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/platform', () => ({
  IS_MAC: false,
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import { Baseboard } from './Baseboard';
import { installLocalStorageStub } from '../lib/test-local-storage';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from '../lib/alert-settings';
import {
  addInstalledTheme,
  getActiveThemeId,
  setActiveThemeId,
  setDefaultThemeId,
  type DormouseTheme,
} from '../lib/themes';
import { resetShellStore, seedShellStore } from '../lib/shell-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const KIMBIE_DARK = 'vscode.theme-kimbie-dark.kimbie-dark';
const INSTALLED_THEME: DormouseTheme = {
  id: 'review.installed-theme',
  label: 'Review Installed',
  type: 'dark',
  swatch: '#111111',
  accent: '#eeeeee',
  vars: {},
  origin: {
    kind: 'installed',
    extensionId: 'review/installed-theme',
    installedAt: '2026-08-17T00:00:00.000Z',
  },
};

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  installLocalStorageStub();
  window.localStorage.clear();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  // Module state, so it outlives the component under test.
  setDefaultThemeId(null);
  resetShellStore();
  act(() => root.unmount());
  container.remove();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Baseboard settings controls', () => {
  it('keeps separate speech, push, and general settings buttons', () => {
    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));

    expect(container.querySelectorAll('[data-alarm-setting]')).toHaveLength(2);
    expect(container.querySelector('[data-alarm-setting="speech"]')?.getAttribute('aria-label'))
      .toContain('disabled');
    expect(container.querySelector('[data-alarm-setting="push"]')?.getAttribute('aria-label'))
      .toContain('disabled');
    expect(container.querySelector('[data-open-settings]')).not.toBeNull();
  });

  it('reflects enabled states and opens the shared dialog from a status button', () => {
    applyAlertSettingsFromHost({
      ...DEFAULT_ALERT_SETTINGS,
      speakEnabled: true,
      pushEnabled: true,
    });
    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));

    const speech = container.querySelector<HTMLButtonElement>('[data-alarm-setting="speech"]');
    const push = container.querySelector<HTMLButtonElement>('[data-alarm-setting="push"]');
    expect(speech?.getAttribute('aria-label')).toContain('enabled');
    expect(push?.getAttribute('aria-label')).toContain('enabled');

    act(() => speech?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Settings');
    // Not a VS Code host, so the Theme row is offered (`hostOwnsTheme` absent).
    expect(dialog?.textContent).toContain('Theme:');
  });

  it('hides the Theme row when the host owns the theme', async () => {
    const platform = await import('../lib/platform');
    vi.spyOn(platform, 'getPlatform').mockReturnValue({
      alertPublishSettings: vi.fn(),
      hostOwnsTheme: true,
    } as unknown as ReturnType<typeof platform.getPlatform>);

    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));
    const button = container.querySelector<HTMLButtonElement>('[data-open-settings]');
    act(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Settings');
    expect(dialog?.textContent).not.toContain('Theme:');
  });

  it('offers the Shell row once the host has detected more than one shell', () => {
    seedShellStore([
      { name: 'zsh', path: '/bin/zsh' },
      { name: 'bash', path: '/bin/bash' },
    ]);

    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-open-settings]')?.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Shell:');
    // The picker itself, not just the label: it renders nothing without shells.
    expect(dialog?.querySelector('[aria-label="Shell: zsh"]')).not.toBeNull();
  });

  it('closes Settings when a shell is selected', () => {
    seedShellStore([
      { name: 'zsh', path: '/bin/zsh' },
      { name: 'bash', path: '/bin/bash' },
    ]);

    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-open-settings]')?.click());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Shell: zsh"]')?.click());
    act(() => {
      const bash = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
        .find((item) => item.textContent?.includes('bash'));
      bash?.click();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('distinguishes shell rows that share an executable path', () => {
    const wslPath = 'C:\\Windows\\System32\\wsl.exe';
    seedShellStore([
      { name: 'Ubuntu', path: wslPath, args: ['-d', 'Ubuntu'] },
      { name: 'Debian', path: wslPath, args: ['-d', 'Debian'] },
    ]);

    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-open-settings]')?.click());
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="Shell: Ubuntu"]')?.click());

    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(rows.map((row) => row.textContent)).toEqual(['Ubuntu', 'Debian']);
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  it('hides the Shell row when the host owns shell selection', async () => {
    const platform = await import('../lib/platform');
    vi.spyOn(platform, 'getPlatform').mockReturnValue({
      alertPublishSettings: vi.fn(),
      hostOwnsShells: true,
    } as unknown as ReturnType<typeof platform.getPlatform>);
    seedShellStore([
      { name: 'zsh', path: '/bin/zsh' },
      { name: 'bash', path: '/bin/bash' },
    ]);

    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-open-settings]')?.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Settings');
    expect(dialog?.textContent).not.toContain('Shell:');
  });

  it('hides the Shell row on a host that never seeded the shell store', () => {
    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-open-settings]')?.click());

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Settings');
    expect(dialog?.textContent).not.toContain('Shell:');
  });

  // No `window.confirm` stub on purpose. Mocking it to `true` is what let this
  // test pass while the shipped standalone app silently uninstalled nothing:
  // there, the `confirm` call returned without ever showing a dialog.
  // Uninstall is a plain click now, exactly as exercised here.
  it('uses the host fallback after uninstalling the active installed theme', () => {
    addInstalledTheme(INSTALLED_THEME);
    setActiveThemeId(INSTALLED_THEME.id);
    // The host declares its fallback once at boot; nothing is threaded through
    // Wall/Baseboard to reach the picker.
    setDefaultThemeId(KIMBIE_DARK);

    act(() => root.render(<Baseboard items={[]} onReattach={() => {}} />));
    act(() => container.querySelector<HTMLButtonElement>('[data-open-settings]')?.click());

    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Theme: Review Installed"]');
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());
    const uninstall = document.querySelector<HTMLButtonElement>(
      '[aria-label="Uninstall Review Installed"]',
    );
    expect(uninstall).not.toBeNull();
    act(() => uninstall?.click());

    expect(getActiveThemeId()).toBe(KIMBIE_DARK);
    expect(document.querySelector('[aria-label="Theme: Kimbie Dark"]')).not.toBeNull();
  });
});

describe('Baseboard browser Doors', () => {
  it('keeps the browser display icon and page label instead of deriving a terminal idle title', () => {
    act(() => root.render(
      <Baseboard
        items={[{ id: 'browser-1', kind: 'browser', title: 'localhost:5173/app', browserDisplay: 'ab-fixed' }]}
        onReattach={() => {}}
      />,
    ));

    const door = container.querySelector<HTMLButtonElement>('[data-door-id="browser-1"]');
    expect(door?.textContent).toContain('localhost:5173/app');
    expect(door?.textContent).not.toContain('<idle>');
    expect(door?.querySelector('[data-browser-display-mode="ab-fixed"] svg')).not.toBeNull();
    expect(door?.querySelectorAll('[data-browser-display-mode="ab-fixed"] svg')).toHaveLength(2);
    expect(door?.getAttribute('aria-label')).toBe(
      'localhost:5173/app, agent-browser fixed size',
    );
  });
});
