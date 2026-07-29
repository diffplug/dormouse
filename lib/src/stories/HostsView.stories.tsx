import type { Meta, StoryObj } from '@storybook/react';
// Importing from App.tsx runs its `index.css` side-effect import, so Tailwind's
// utilities load for these stories. Storybook manages the theme tokens
// (`--vscode-*`) itself.
import { HostsView, type HostView } from '../remote/pocket-app/App';
import { PhoneFrame } from './PhoneFrame';

// A paired online host, an unpaired online host (shows Pair + Connect), and an
// offline host (dimmed row, Pair hidden, Connect disabled) — the full row
// matrix in one frame.
const MIXED_HOSTS: HostView[] = [
  { hostId: 'host-studio', label: 'Studio iMac', online: true },
  { hostId: 'host-laptop', label: 'MacBook Pro', online: true },
  { hostId: 'host-nas', label: 'Basement NAS', online: false },
];

const PAIRED = new Set(['host-studio']);
const isPaired = (hostId: string) => PAIRED.has(hostId);

const STRESS_HOSTS: HostView[] = [
  {
    hostId: 'host-paired-offline',
    label: 'Offline production workstation with an unusually long display name',
    online: false,
  },
  {
    hostId: 'host-without-a-label-and-a-deliberately-long-identifier',
    label: '',
    online: true,
  },
];
const meta: Meta<typeof HostsView> = {
  title: 'Pocket/HostsView',
  component: HostsView,
  parameters: { layout: 'centered' },
  args: {
    hosts: MIXED_HOSTS,
    busy: null,
    error: null,
    isPaired,
    pushState: 'ready',
    pushConfigStatus: 'ready',
    isPushSubscribed: () => false,
    needsLocalPasskey: false,
    onRefresh: () => {},
    onPair: () => {},
    onConnect: () => {},
    onEnablePush: () => {},
    onRetryPushConfig: () => {},
    onSetup: () => {},
  },
  decorators: [
    (Story, context) => (
      <PhoneFrame
        width={context.parameters.pocketFrame?.width}
        height={context.parameters.pocketFrame?.height}
      >
        <Story />
      </PhoneFrame>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof HostsView>;

// No hosts enrolled yet → the empty-state message.
export const Empty: Story = {
  args: { hosts: [] },
};

// Paired+online (Connect only), unpaired+online (Pair + Connect), offline (dimmed).
export const MixedList: Story = {};

// Canonical Pocket default theme, pinned so Chromatic captures the dark rows.
export const MixedListKimbieDark: Story = {
  globals: { theme: 'Kimbie Dark' },
};

// Small-phone stress case: paired+offline, host-id fallback, and long labels.
export const NarrowLongLabels: Story = {
  args: {
    hosts: STRESS_HOSTS,
    isPaired: (hostId) => hostId === 'host-paired-offline',
  },
  parameters: {
    pocketFrame: { width: 320, height: 568 },
  },
};

// Pairing in flight → the unpaired online host's Pair button shows "…".
export const Pairing: Story = {
  args: { busy: 'pair' },
};

// Connecting in flight → Connect buttons show "…" and disable.
export const Connecting: Story = {
  args: { busy: 'connect' },
};

// Refreshing the list → the header Refresh button shows "…".
export const Refreshing: Story = {
  args: { busy: 'refresh' },
};

// Host dropped → the red error text above the list.
export const Error: Story = {
  args: { error: 'The host disconnected.' },
};

// Registered with this Host → its row states it, with no action. Driven by the
// per-Host marker, not by browser availability: a scope-wide PushSubscription
// says nothing about which Hosts hold a server row.
export const PushSubscribed: Story = {
  args: { isPushSubscribed: () => true },
};

// One Host registered, one not — the case a scope-wide check got wrong.
export const PushSubscribedOneHost: Story = {
  args: { isPushSubscribed: (hostId: string) => hostId === 'host-studio' },
};

// The iOS case: Web Push is granted only to a Home Screen web app, so the row
// asks for the one step the user must take outside the app.
export const PushNeedsInstall: Story = {
  args: { pushState: 'needs-install' },
};

// Blocked in browser settings → explained, not silently missing.
export const PushDenied: Story = {
  args: { pushState: 'denied' },
};

// Subscribing in flight → the push button shows "…".
export const PushEnabling: Story = {
  args: { busy: 'push' },
};

// The service worker never registered — usually an insecure origin.
export const PushNoWorker: Story = {
  args: { pushState: 'no-worker' },
};

/**
 * iOS, running in a Safari tab. Web Push only reaches an installed app and
 * there is no API to prompt for that, so the notice describes the steps — and
 * allows for someone who already installed it and opened the wrong window,
 * which a tab cannot distinguish. A definitively push-disabled Server hides the
 * notice so it cannot disagree with the push row beneath it.
 */
export const NeedsHomeScreenInstall: Story = {
  args: { pushState: 'needs-install' },
};

/**
 * Signed in on a profile that holds no passkey public key — the Home Screen
 * install's partitioned storage. Pair and Connect would both fail, so the
 * notice offers the fix inline rather than waiting for a failed tap.
 */
export const NeedsLocalPasskey: Story = {
  args: { needsLocalPasskey: true },
};

// Both at once: a first run in a Safari tab on iOS after setup happened elsewhere.
export const NeedsInstallAndPasskey: Story = {
  args: { pushState: 'needs-install', needsLocalPasskey: true },
};

// The server was started without VAPID keys, so there is nothing to enable.
export const PushUnconfigured: Story = {
  args: { pushConfigStatus: 'disabled' },
};

// The config prefetch must finish before a permission-triggering tap is offered.
export const PushConfigLoading: Story = {
  args: { pushConfigStatus: 'loading' },
};

// A failed prefetch retries separately; Enable appears only after it succeeds.
export const PushConfigError: Story = {
  args: { pushConfigStatus: 'error' },
};
