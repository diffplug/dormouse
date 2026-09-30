import type { Meta, StoryObj } from '@storybook/react';
import { BellIcon, GearIcon, GlobeIcon, MagnifyingGlassIcon, PulseIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ELEVATED_PANE_SHADOW, MODAL_OVERLAY_INSET, ModalCloseButton, ModalFrame, OVERLAY_MAX_HEIGHT } from '../components/design';
import { NetworkSettings, type NetworkInterfaceInfo, type NetworkSettingsState } from '../components/NetworkSettings';

/**
 * PROTOTYPE of Settings → Network (`docs/specs/remote-network.md`), framed in
 * a copy of the Settings dialog's chrome so it reads at its real width. Every
 * control works against local state; nothing reaches a Burrow service.
 */

const WIFI: NetworkInterfaceInfo = {
  id: 'en0', label: 'Wi-Fi', kind: 'wifi', prefixes: ['192.168.1.0/24', '2601:646:8a00:1d0::/64'],
};
const TAILSCALE: NetworkInterfaceInfo = {
  id: 'utun4', label: 'Tailscale', kind: 'vpn', prefixes: ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'],
};
const DOCKER: NetworkInterfaceInfo = {
  id: 'bridge100', label: 'Docker', kind: 'virtual', prefixes: ['192.168.215.0/24'],
};

const PIXEL = { id: 'p1', label: 'Pixel 8', detail: 'Paired Sep 28 · last connected today' };

const DAY = 86_400_000;

/** What a new install opens on: Nothing, security-maxxed. */
const BASE: NetworkSettingsState = {
  build: { kind: 'hosted' },
  host: 'standalone',
  level: 'nothing',
  allowed: [],
  interfaces: [WIFI, TAILSCALE, DOCKER],
  autoUpdate: false,
  lastUpdateCheck: null,
  phones: [],
  pushEnabled: false,
  managedVoice: false,
};

const TOPICS = [
  { label: 'General', icon: GearIcon },
  { label: 'Activity', icon: PulseIcon },
  { label: 'Notifications', icon: BellIcon },
  { label: 'Network', icon: GlobeIcon },
];

function NetworkSettingsStory(initial: NetworkSettingsState) {
  const [state, setState] = useState(initial);
  const patch = (next: Partial<NetworkSettingsState>) => setState((was) => ({ ...was, ...next }));
  return (
    <ModalFrame
      titleId="network-settings-title"
      layer="app"
      padding="none"
      overlayClassName={MODAL_OVERLAY_INSET}
      className={`${OVERLAY_MAX_HEIGHT.modal} flex h-[36rem] w-full max-w-[48rem] flex-col overflow-hidden`}
      style={{ boxShadow: ELEVATED_PANE_SHADOW }}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <h2 id="network-settings-title" className="shrink-0 text-sm font-semibold text-foreground">Settings</h2>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-input-border bg-input-bg px-2 py-1.5 text-sm text-muted">
          <MagnifyingGlassIcon size={14} className="shrink-0" aria-hidden />
          Search settings
        </div>
        <ModalCloseButton />
      </div>
      <div className="flex min-h-0 flex-1">
        <nav aria-label="Settings topics" className="w-12 shrink-0 border-r border-border bg-app-bg px-1 py-3 sm:w-48 sm:px-3">
          {TOPICS.map(({ label, icon: Icon }) => (
            <div
              key={label}
              className={`mb-1 flex items-center gap-2 rounded px-2 py-2 text-sm ${label === 'Network'
                ? 'bg-header-active-bg text-header-active-fg'
                : 'text-app-fg'}`}
            >
              <Icon size={16} className="shrink-0" aria-hidden />
              <span className="sr-only sm:not-sr-only">{label}</span>
            </div>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-4 break-words sm:px-6">
          <h3 className="text-sm font-semibold text-foreground">Network</h3>
          <NetworkSettings
            state={state}
            actions={{
              onLevel: (level) => patch({
                level,
                // Choosing Local networks the first time allows the network this
                // computer is on now, never a VPN or virtual interface.
                allowed: level === 'local' && state.allowed.length === 0
                  ? state.interfaces.find((item) => item.kind === 'wifi' || item.kind === 'ethernet')?.prefixes ?? []
                  : state.allowed,
              }),
              onAllowed: (allowed) => patch({ allowed }),
              onAutoUpdate: (autoUpdate) => patch({ autoUpdate }),
              onCheckForUpdates: () => patch({ lastUpdateCheck: Date.now() }),
              onPair: () => {},
              onOneTime: () => {},
              onRemovePhone: (id) => patch({ phones: state.phones.filter((phone) => phone.id !== id) }),
            }}
          />
        </div>
      </div>
    </ModalFrame>
  );
}

const meta: Meta<typeof NetworkSettingsStory> = {
  title: 'Prototypes/NetworkSettings',
  component: NetworkSettingsStory,
  args: BASE,
};

export default meta;
type Story = StoryObj<typeof NetworkSettingsStory>;

/** Persona 1, and every new install: nothing leaves this computer unless they click something. */
export const Nothing: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByRole('radio', { name: /^Nothing/ })).toHaveAttribute('aria-checked', 'true');
    await body.findByText(/^Nothing\. Terminals and browser panes/);
  },
};

/** Persona 1 nine days after their last check: the Baseboard is reminding them (`UpdateBanner` → CheckDue). */
export const NothingCheckDue: Story = {
  args: { ...BASE, lastUpdateCheck: Date.now() - 9 * DAY },
  play: async ({ canvasElement }) => {
    await within(canvasElement.ownerDocument.body).findByText(/Last checked 9 days ago\./);
  },
};

/** The Phones hint names the choices that enable phones, and each is a shortcut to it. */
export const NothingChooseFromPhones: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('button', { name: 'Anywhere' }));
    await expect(body.getByRole('radio', { name: /^Anywhere/ })).toHaveAttribute('aria-checked', 'true');
    await body.findByRole('button', { name: 'Pair a phone' });
  },
};

/** Persona 1 who had paired a phone before switching everything off. */
export const NothingWithPairedPhone: Story = {
  args: { ...BASE, phones: [PIXEL], pushEnabled: true },
};

/** Persona 2: Pocket, but terminal traffic stays on the home Wi-Fi and the tailnet. */
export const LocalNetworks: Story = {
  args: {
    ...BASE,
    level: 'local',
    allowed: [...WIFI.prefixes, ...TAILSCALE.prefixes],
    phones: [PIXEL],
    pushEnabled: true,
    autoUpdate: true,
    lastUpdateCheck: Date.now(),
  },
};

/** Persona 2 before pairing: Hosted is contacted only while a one-time link is open. */
export const LocalNetworksFirstRun: Story = {
  args: { ...BASE, level: 'local', allowed: WIFI.prefixes },
};

/** A range the user typed, for a network this computer is not on right now. */
export const LocalNetworksTypedRange: Story = {
  args: { ...BASE, level: 'local', allowed: [...WIFI.prefixes, '10.8.0.0/24'], phones: [PIXEL] },
};

/** Every network switched off: say so, and disable pairing rather than fail later. */
export const LocalNetworksNoneAllowed: Story = {
  args: { ...BASE, level: 'local', allowed: [] },
};

/** Persona 3: it just works, from anywhere. */
export const Anywhere: Story = {
  args: { ...BASE, level: 'anywhere', phones: [PIXEL], pushEnabled: true, managedVoice: true, autoUpdate: true, lastUpdateCheck: Date.now() },
};

/** Persona 3 on first run, before any phone is paired. */
export const AnywhereFirstRun: Story = {
  args: { ...BASE, level: 'anywhere', autoUpdate: true },
};

/** Walks the three choices and checks that the connection list follows. */
export const SwitchingLevels: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(body.getByRole('radio', { name: /^Local networks/ }));
    await body.findByText('Allowed networks');
    await body.findByText('Your phone, on an allowed network');
    await expect(body.getByRole('switch', { name: 'Allow Wi-Fi on' })).toBeVisible();
    await userEvent.click(body.getByRole('radio', { name: /^Anywhere/ }));
    await body.findByText('stun.cloudflare.com');
    await expect(body.queryByText('Allowed networks')).toBeNull();
  },
};

/** A self-host build: its own Relay or nothing, and no updater. */
export const SelfHost: Story = {
  args: {
    ...BASE,
    build: { kind: 'self-host', relayOrigin: 'relay.tail1234.ts.net' },
    level: 'anywhere',
    phones: [PIXEL],
    pushEnabled: true,
  },
};

/** VS Code: the Marketplace, not Dormouse, updates the extension. */
export const VsCode: Story = {
  args: { ...BASE, host: 'vscode', level: 'local', allowed: WIFI.prefixes },
};
