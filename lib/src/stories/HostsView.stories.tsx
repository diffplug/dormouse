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
    onRefresh: () => {},
    onPair: () => {},
    onConnect: () => {},
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
