import { describe, expect, it, vi } from 'vitest';
import { PAIRING_DEVICE_LABELS } from 'remote-lib-common';

const install = vi.hoisted(() => ({ installed: false }));
vi.mock('../client/install-state', () => ({ isInstalledWebApp: () => install.installed }));

import { deviceLabel } from './views';

describe('deviceLabel', () => {
  it('names each install mode by its own member of the set the Burrow shows', () => {
    // Anything else reaches the laptop as `Unknown device`
    // (`docs/specs/remote-security-model.md` -> Pairing).
    install.installed = true;
    const homeScreen = deviceLabel();
    install.installed = false;
    const browser = deviceLabel();
    expect([homeScreen, browser]).toEqual([...PAIRING_DEVICE_LABELS]);
  });
});
