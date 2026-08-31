import type { Meta, StoryObj } from '@storybook/react';
// Importing from App.tsx runs its `index.css` side-effect import, so Tailwind's
// utilities load for these stories. Storybook manages the theme tokens
// (`--vscode-*`) itself.
import { HostsView, type HostPairState, type HostView } from '../remote/pocket-app/App';
import { PhoneFrame } from './PhoneFrame';

// A paired online host (Connect alone), an unpaired online host (Pair alone),
// and an offline host (dimmed row, its one action disabled) — the full row
// matrix in one frame.
const MIXED_HOSTS: HostView[] = [
  { hostId: 'host-studio', label: 'Studio iMac', online: true },
  { hostId: 'host-laptop', label: 'MacBook Pro', online: true },
  { hostId: 'host-nas', label: 'Basement NAS', online: false },
];

const PAIRED = new Set(['host-studio']);
const pairState = (hostId: string): HostPairState =>
  PAIRED.has(hostId) ? 'paired' : 'unpaired';

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
    pairState,
    pushState: 'ready',
    pushConfigStatus: 'ready',
    isPushSubscribed: () => false,
    onRefresh: () => {},
    onPair: () => {},
    onConnect: () => {},
    onEnablePush: () => {},
    onRetryPushConfig: () => {},
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

// Paired+online (Connect only), unpaired+online (Pair only), offline (dimmed).
export const MixedList: Story = {};

// Canonical Pocket default theme, pinned so Chromatic captures the dark rows.
export const MixedListKimbieDark: Story = {
  globals: { theme: 'Kimbie Dark' },
};

// Small-phone stress case: paired+offline, host-id fallback, and long labels.
export const NarrowLongLabels: Story = {
  args: {
    hosts: STRESS_HOSTS,
    pairState: (hostId) => (hostId === 'host-paired-offline' ? 'paired' : 'unpaired'),
  },
  parameters: {
    pocketFrame: { width: 320, height: 568 },
  },
};

// A connect the Host denied for an ACL miss. The row keeps its single action
// and renames it, rather than re-offering the Connect that just failed.
export const PairAgainAfterDenial: Story = {
  args: {
    pairState: (hostId: string) => (hostId === 'host-studio' ? 'stale' : 'unpaired'),
    error: 'Connection denied: device-not-paired',
  },
};

// Pairing in flight → the unpaired online host's Pair button shows "…".
export const Pairing: Story = {
  args: { busy: 'pair' },
};

// Connecting in flight → the paired row's Connect shows "…"; the rest disable.
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

// Every paired Host holds a row → the card collapses to one settled line and
// the rows carry the marker. Driven by the per-Host registrations, not by
// browser availability: a scope-wide PushSubscription says nothing about which
// Hosts hold a server row.
export const PushSubscribed: Story = {
  args: { isPushSubscribed: () => true },
};

// Registered with the one paired Host while an unpaired Host sits below it —
// the card is settled, because an unpaired Host has nothing to register.
export const PushSubscribedOneHost: Story = {
  args: { isPushSubscribed: (hostId: string) => hostId === 'host-studio' },
};

// A Host paired after push was turned on: the card comes back for it, and the
// row markers say which of the two is already covered.
export const PushSubscribedNewHostPaired: Story = {
  args: {
    pairState: () => 'paired' as HostPairState,
    isPushSubscribed: (hostId: string) => hostId === 'host-studio',
  },
};

// The iOS case: Web Push is granted only to a Home Screen web app. The install
// notice is the whole answer, so no push card doubles it with "see above".
export const PushNeedsInstall: Story = {
  args: { pushState: 'needs-install' },
};

// Blocked in browser settings → explained, not silently missing.
export const PushDenied: Story = {
  args: { pushState: 'denied' },
};

// Subscribing in flight → the card's button shows "…".
export const PushEnabling: Story = {
  args: { busy: 'push' },
};

// The service worker never registered — usually an insecure origin.
export const PushNoWorker: Story = {
  args: { pushState: 'no-worker' },
};

// Nothing paired yet → no card at all: pairing is the step that comes first.
export const PushNothingPaired: Story = {
  args: { pairState: () => 'unpaired' as HostPairState },
};

/**
 * iOS, running in a Safari tab. Web Push only reaches an installed app and
 * there is no API to prompt for that, so the notice describes the steps — and
 * allows for someone who already installed it and opened the wrong window,
 * which a tab cannot distinguish. A definitively push-disabled Server hides the
 * notice so it cannot disagree with the push card, which then names the real
 * reason instead.
 */
export const NeedsHomeScreenInstall: Story = {
  args: { pushState: 'needs-install', pushConfigStatus: 'disabled' },
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
