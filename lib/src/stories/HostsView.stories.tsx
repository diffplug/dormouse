import type { Meta, StoryObj } from '@storybook/react';
import type { ReactNode } from 'react';
// Importing from App.tsx runs its `index.css` side-effect import, loading the
// shared --color-* theme tokens. The auth chrome is built from the three VSCode
// list pairs (docs/specs/theme.md); switch themes with the Storybook toolbar.
import { HostsView, type HostView } from '../remote/pocket-app/App';

// A paired online host, an unpaired online host (shows Pair + Connect), and an
// offline host (both actions disabled) — the full row matrix in one frame.
const MIXED_HOSTS: HostView[] = [
  { hostId: 'host-studio', label: 'Studio iMac', online: true },
  { hostId: 'host-laptop', label: 'MacBook Pro', online: true },
  { hostId: 'host-nas', label: 'Basement NAS', online: false },
];

const PAIRED = new Set(['host-studio']);
const isPaired = (hostId: string) => PAIRED.has(hostId);

// Phone-sized frame on the app-bg surface, matching the real app shell. Uses a
// faint app-fg outline for definition since panel-border is often transparent.
function PhoneFrame({ children }: { children: ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-xl shadow-2xl outline outline-1 outline-app-fg/15"
      style={{ width: 390, height: 760, background: 'var(--color-app-bg)' }}
    >
      {children}
    </div>
  );
}

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
    (Story) => (
      <PhoneFrame>
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

// Paired+online (Connect only), unpaired+online (Pair + Connect), offline (disabled).
export const MixedList: Story = {};

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

// Host dropped → the red error banner above the list.
export const Error: Story = {
  args: { error: 'The host disconnected.' },
};
