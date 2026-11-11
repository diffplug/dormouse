import { useLayoutEffect } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { PendingKillOverlay } from '../components/PendingKillOverlay';
import { addPendingKill, holdPendingKill, pendingKillKey, restorePendingKill } from '../lib/pending-kills';
import { requireElement } from './settle-terminals';

const KILLS = [
  { title: 'npm run dev', label: 'Terminal' },
  { title: 'claude', label: 'Terminal' },
  { title: 'localhost:5173', label: 'Browser' },
  { title: 'README.md', label: 'Tool' },
  { title: 'cargo watch', label: 'Terminal' },
];

/**
 * The Window's pending kills, primed through the store a delayed kill uses.
 * Every countdown is held, as the pointer holds it, so the stack stays still
 * instead of finalizing.
 */
function PendingKills({ count }: { count: number }) {
  useLayoutEffect(() => {
    // One clock reading for every add: entries that start together keep the
    // order they were added in, so the stack never reorders between snapshots.
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    let keys: string[];
    try {
      keys = KILLS.slice(0, count).map(({ title, label }, index) => {
        const id = `story-pending-${index}`;
        addPendingKill({ kind: 'surface', id, workspaceId: 'workspace:1', title, label }, { restore: () => {}, finalize: () => {} });
        return pendingKillKey('surface', id);
      });
    } finally {
      Date.now = realNow;
    }
    for (const key of keys) holdPendingKill(key, true);
    return () => { for (const key of keys) restorePendingKill(key, false); };
  }, [count]);
  return <PendingKillOverlay />;
}

const meta: Meta<typeof PendingKills> = {
  title: 'Components/PendingKillOverlay',
  component: PendingKills,
  args: { count: 1 },
  play: async () => { await requireElement('[data-pending-kill]', 'pending kill'); },
};

export default meta;
type Story = StoryObj<typeof PendingKills>;

export const One: Story = {};

/** Past three, the oldest collapse to a `+N` row. */
export const Overflow: Story = { args: { count: 5 } };
