import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ExternalPreviewPrompt } from '../components/wall/IframePanel';

/** The warning an iframe pane shows before previewing a page off this
 *  machine (docs/specs/dor-browser.md → "Iframe External Origins"). */
function ExternalPreviewStory({ width, height, ...props }: Parameters<typeof ExternalPreviewPrompt>[0] & { width: number; height: number }) {
  return (
    <div data-preview-story style={{ width, height }} className="relative overflow-hidden bg-terminal-bg">
      <ExternalPreviewPrompt {...props} />
    </div>
  );
}

const TAILSCALE = { label: 'Tailscale', prefixes: ['100.64.0.0/10'] };

const meta: Meta<typeof ExternalPreviewStory> = {
  title: 'Components/IframeExternalPreview',
  component: ExternalPreviewStory,
  args: {
    width: 640,
    height: 360,
    origin: 'http://100.101.1.2:5173',
    publicAddress: false,
    offer: TAILSCALE,
    onAllow: fn(async () => {}),
    onOpenInAgentBrowser: fn(),
    onOpenInBrowser: fn(),
    onCancel: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof ExternalPreviewStory>;

/** A page on a network this machine is on: names it, offers to allow it, and each action reaches its own handler. */
export const OnThisMachinesNetwork: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alertdialog', { name: 'Page on another device' })).toBeVisible();
    await expect(canvas.getByText(args.origin)).toBeVisible();
    await expect(canvas.getByText(/can reach services on this computer/)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Allow Tailscale (100.64.0.0/10)' }));
    await expect(args.onAllow).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Open in agent-browser' }));
    await expect(args.onOpenInAgentBrowser).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Open in browser' }));
    await expect(args.onOpenInBrowser).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
  },
};

/** A private network none of this machine's connections is on: no Allow, Settings named instead. */
export const OffThisMachinesNetworks: Story = {
  args: { origin: 'http://192.168.50.7:8080', offer: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/add its range in Settings → Network/)).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /^Allow/ })).toBeNull();
  },
};

/** A public address never previews, whatever is allowed: only the ways out. */
export const PublicAddress: Story = {
  args: { origin: 'http://docs.example.com:8080', publicAddress: true, offer: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alertdialog', { name: 'Website on the internet' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: /^Allow/ })).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Open in agent-browser' })).toBeVisible();
  },
};

/** A refused change shows where it was made. */
export const AllowRefused: Story = {
  args: { onAllow: fn(async () => { throw new Error('At most 32 networks can be allowed. Remove one first.'); }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Allow Tailscale (100.64.0.0/10)' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('At most 32 networks');
  },
};

/** A host that can open neither a system browser nor agent-browser offers only Allow and Cancel. */
export const NoOtherBrowser: Story = {
  args: { onOpenInBrowser: undefined, onOpenInAgentBrowser: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole('button', { name: 'Open in browser' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Open in agent-browser' })).toBeNull();
  },
};

/** A long origin wraps inside a narrow pane rather than overflowing it. */
export const Narrow: Story = {
  args: { width: 240, height: 360, origin: `http://${'very-long-subdomain-'.repeat(4)}example.com:65535` },
  play: async ({ canvasElement }) => {
    const pane = canvasElement.querySelector<HTMLElement>('[data-preview-story]')!;
    await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth + 1);
  },
};
