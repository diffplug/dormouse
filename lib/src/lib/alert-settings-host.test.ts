import { describe, expect, it, vi } from 'vitest';

import { AlertSettingsHost } from './alert-settings-host';
import { DEFAULT_ALERT_SETTINGS } from './alert-settings';

function createHost() {
  const target = {
    setInactivityTimeoutMs: vi.fn(),
    setDeferAlertsUntilQuiet: vi.fn(),
  };
  return { host: new AlertSettingsHost(target), target };
}

describe('AlertSettingsHost', () => {
  it('applies host-owned settings and publishes the normalized snapshot', () => {
    const { host, target } = createHost();
    const listener = vi.fn();
    host.subscribe(listener);

    host.initialize({ inactivityTimeoutMs: 3_000, deferAlertsUntilQuiet: true });

    expect(target.setInactivityTimeoutMs).toHaveBeenCalledWith(3_000);
    expect(target.setDeferAlertsUntilQuiet).toHaveBeenCalledWith(true);
    expect(listener).toHaveBeenCalledWith({
      ...DEFAULT_ALERT_SETTINGS,
      inactivityTimeoutMs: 3_000,
      deferAlertsUntilQuiet: true,
    });
  });

  it('keeps the first startup seed but always applies an explicit update', () => {
    const { host, target } = createHost();
    host.initialize({ deferAlertsUntilQuiet: true });
    host.initialize({ deferAlertsUntilQuiet: false });
    expect(target.setDeferAlertsUntilQuiet).toHaveBeenCalledTimes(1);

    host.update({ deferAlertsUntilQuiet: false });
    expect(target.setDeferAlertsUntilQuiet).toHaveBeenNthCalledWith(2, false);
  });
});
