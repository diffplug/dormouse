import { describe, expect, it, vi } from 'vitest';

import { AlertSettingsHost } from './alert-settings-host';
import { DEFAULT_ALERT_SETTINGS } from './alert-settings';

describe('AlertSettingsHost', () => {
  it('publishes the normalized snapshot', () => {
    const host = new AlertSettingsHost();
    const listener = vi.fn();
    host.subscribe(listener);

    host.initialize({ inactivityTimeoutMs: 3_000, unknown: true });

    // Subscribers see the normalized blob, not the partial the renderer sent.
    expect(listener).toHaveBeenCalledWith({ ...DEFAULT_ALERT_SETTINGS, inactivityTimeoutMs: 3_000 });
  });

  it('keeps the first startup seed but always applies an explicit update', () => {
    const host = new AlertSettingsHost();
    const listener = vi.fn();
    host.subscribe(listener);
    // The seeded value is the non-default one, so a second seed winning would show.
    host.initialize({ speakEnabled: true });
    host.initialize({ speakEnabled: false });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ speakEnabled: true }));

    host.update({ speakEnabled: false });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ speakEnabled: false }));
  });
});
