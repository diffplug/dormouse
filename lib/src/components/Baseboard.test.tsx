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
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from '../lib/alert-settings';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  });
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
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
});
