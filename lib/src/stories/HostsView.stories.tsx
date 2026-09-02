import type { Meta, StoryObj } from '@storybook/react';
// Importing from App.tsx runs `pocket-chrome`'s `index.css` side-effect import,
// so Tailwind's utilities load for these stories. Storybook manages the theme
// tokens (`--vscode-*`) itself.
import { HostsView, type HostView } from '../remote/pocket-app/App';
import { PhoneFrame } from './PhoneFrame';

// A paired online host (Connect), a host whose authorization the laptop revoked
// (Pair again), and an offline host (dimmed row, its Connect disabled) — the
// full row matrix in one frame. Every row is a record this phone holds; a Host
// it has never paired with is not listed at all.
const MIXED_HOSTS: HostView[] = [
  { hostId: 'host-studio', label: 'Studio iMac', online: true, needsPairing: false },
  { hostId: 'host-laptop', label: 'MacBook Pro', online: true, needsPairing: true },
  { hostId: 'host-nas', label: 'Basement NAS', online: false, needsPairing: false },
];

const STRESS_HOSTS: HostView[] = [
  {
    hostId: 'host-paired-offline',
    label: 'Offline production workstation with an unusually long display name',
    online: false,
    needsPairing: false,
  },
  {
    hostId: 'host-without-a-label-and-a-deliberately-long-identifier',
    label: '',
    online: true,
    needsPairing: false,
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
    pushState: 'ready',
    pushConfigStatus: 'ready',
    isPushSubscribed: () => false,
    onRefresh: () => {},
    onScan: () => {},
    onConnect: () => {},
    onForget: () => {},
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

// Nothing paired yet → the empty state, with the scan action below it.
export const Empty: Story = {
  args: { hosts: [] },
};

// Paired+online (Connect), pairing-required (Pair again), offline (dimmed).
export const MixedList: Story = {};

// Canonical Pocket default theme, pinned so Chromatic captures the dark rows.
export const MixedListKimbieDark: Story = {
  globals: { theme: 'Kimbie Dark' },
};

// Small-phone stress case: paired+offline, host-id fallback, and long labels.
export const NarrowLongLabels: Story = {
  args: { hosts: STRESS_HOSTS },
  parameters: {
    pocketFrame: { width: 320, height: 568 },
  },
};

// A connect the Host denied for an ACL miss. The record kept its pin and lost
// its authorization, so the row offers Pair again rather than re-offering the
// Connect that just failed — and stays tappable while the Host is offline,
// because pairing starts at the scanner rather than at the relay.
export const PairAgainAfterDenial: Story = {
  args: {
    hosts: MIXED_HOSTS.map((host) => ({ ...host, needsPairing: true })),
    error: 'This computer no longer recognizes this phone. Scan a new code to pair again.',
  },
};

// Pairing in flight → every action is locked and the Pair again row shows "…".
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

// Removing a record → the row's Remove shows "…" while the tombstone is written.
export const Forgetting: Story = {
  args: { busy: 'forget' },
};

// Host dropped → the red error text above the list, in the words `setOnHostGone`
// puts there (`App.tsx`).
export const Error: Story = {
  args: { error: 'The connection to the computer ended.' },
};

// Every paired Host holds a row → the card collapses to one settled line and
// the paired row carries the marker, while a row still needing a pairing stays
// bare — it has nothing to register. Driven by the per-Host registrations, not
// by browser availability: a scope-wide PushSubscription says nothing about
// which Hosts hold a server row.
export const PushSubscribed: Story = {
  args: { isPushSubscribed: () => true },
};

// A Host paired after push was turned on: the card comes back for it, and the
// row markers say which of the two is already covered.
export const PushSubscribedNewHostPaired: Story = {
  args: {
    hosts: MIXED_HOSTS.map((host) => ({ ...host, needsPairing: false })),
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
  args: { hosts: MIXED_HOSTS.map((host) => ({ ...host, needsPairing: true })) },
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
