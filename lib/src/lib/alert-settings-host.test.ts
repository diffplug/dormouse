import { describe, expect, it, vi } from 'vitest';

import { AlertSettingsHost } from './alert-settings-host';
import { DEFAULT_ALERT_SETTINGS } from './alert-settings';

function createHost() {
  const target = { applySettings: vi.fn() };
  return { host: new AlertSettingsHost(target), target };
}

describe('AlertSettingsHost', () => {
  it('applies host-owned settings and publishes the normalized snapshot', () => {
    const { host, target } = createHost();
    const listener = vi.fn();
    host.subscribe(listener);

    host.initialize({ inactivityTimeoutMs: 3_000, deferAlertsUntilQuiet: true });

    const expected = {
      ...DEFAULT_ALERT_SETTINGS,
      inactivityTimeoutMs: 3_000,
      deferAlertsUntilQuiet: true,
    };
    // The manager sees the normalized blob, not the partial the renderer sent.
    expect(target.applySettings).toHaveBeenCalledWith(expected);
    expect(listener).toHaveBeenCalledWith(expected);
  });

  it('keeps the first startup seed but always applies an explicit update', () => {
    const { host, target } = createHost();
    // The seeded value is the non-default one, so a second seed winning would show.
    host.initialize({ deferAlertsUntilQuiet: false });
    host.initialize({ deferAlertsUntilQuiet: true });
    expect(target.applySettings).toHaveBeenCalledTimes(1);
    expect(target.applySettings).toHaveBeenCalledWith(
      expect.objectContaining({ deferAlertsUntilQuiet: false }),
    );

    host.update({ deferAlertsUntilQuiet: true });
    expect(target.applySettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ deferAlertsUntilQuiet: true }),
    );
  });
});
