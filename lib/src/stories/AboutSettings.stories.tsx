import type { Meta, StoryObj } from '@storybook/react';
import { expect, within } from 'storybook/test';
import { AboutPanel, type AboutFacts } from '../components/AboutSettings';
import { ModalSurface } from '../components/design';
import type { BuildStamp } from '../lib/build-info';

/**
 * Settings → About (`docs/specs/deploy.md` → "Build stamp"): one story per
 * install kind, from fixed facts — Storybook's own bundle carries no build
 * stamp. `SettingsDialog`'s `AboutTopic` story shows it in place.
 */
function AboutStory({ facts }: { facts: AboutFacts }) {
  return (
    <div className="flex justify-center p-6">
      <ModalSurface padding="spacious" className="w-full max-w-[36rem]">
        <AboutPanel facts={facts} />
      </ModalSurface>
    </div>
  );
}

const OFFICIAL: BuildStamp = { version: '1.2.0', commit: '4c1e09ab', commitsSinceVersion: 0, dirty: false, official: true };
const DEVELOPMENT: BuildStamp = { version: '1.2.0', commit: 'd080b4f5', commitsSinceVersion: 14, dirty: false, official: false };
const HOSTED = { mode: 'hosted', origin: 'https://relay.dormouse.sh' } as const;
const SELF_HOST = { mode: 'self-host', origin: 'https://relay.example.com' } as const;

const meta: Meta<typeof AboutStory> = {
  title: 'Modals/AboutSettings',
  component: AboutStory,
};

export default meta;
type Story = StoryObj<typeof AboutStory>;

/** What CI's release workflow shipped: source links point at the tag. */
export const Official: Story = {
  args: { facts: { host: 'standalone', stamp: OFFICIAL, relay: HOSTED } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Dormouse 1.2.0')).toBeVisible();
    await expect(canvas.getByText(/Official release/)).toBeVisible();
    await expect(canvas.getByText(/from tag v1\.2\.0/)).toBeVisible();
  },
};

export const OfficialVsCode: Story = {
  args: { facts: { host: 'vscode', stamp: OFFICIAL, relay: HOSTED } },
};

/** A local build — `pnpm dogfood:standalone`, `dev:standalone` — carries the commits past its tag. */
export const Development: Story = {
  args: { facts: { host: 'standalone', stamp: DEVELOPMENT, relay: HOSTED } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Dormouse 1.2.0+14')).toBeVisible();
    await expect(canvas.getByText(/Development build/)).toBeVisible();
  },
};

export const DevelopmentDirty: Story = {
  args: { facts: { host: 'standalone', stamp: { ...DEVELOPMENT, dirty: true }, relay: HOSTED } },
};

/** A shallow clone, where the version tag was not there to count from. */
export const DevelopmentUnknownCount: Story = {
  args: { facts: { host: 'vscode', stamp: { ...DEVELOPMENT, commitsSinceVersion: null }, relay: HOSTED } },
};

/** Self-host outranks official or not: it names the one Relay this build reaches. */
export const SelfHost: Story = {
  args: { facts: { host: 'standalone', stamp: DEVELOPMENT, relay: SELF_HOST } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Self-host build/)).toBeVisible();
    await expect(canvas.getByText(/reach only relay\.example\.com/)).toBeVisible();
  },
};

/** The Burrow has not answered yet, so self-host is still possible. */
export const RelayLoading: Story = {
  args: { facts: { host: 'standalone', stamp: OFFICIAL, relay: 'loading' } },
};

/** A bundle built without the stamp. */
export const Unstamped: Story = {
  args: { facts: { host: undefined, stamp: null, relay: null } },
};

/** The website's desktop playground, which has no Burrow and offers the download. */
export const Playground: Story = {
  args: { facts: { host: 'playground', stamp: DEVELOPMENT, relay: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Web playground/)).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Download Dormouse' })).toBeVisible();
  },
};
