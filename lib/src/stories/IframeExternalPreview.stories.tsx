import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ExternalPreviewPrompt } from '../components/wall/IframePanel';

/** The warning an iframe pane shows before previewing an origin off this
 *  machine (docs/specs/dor-browser.md → "Iframe External Origins"). */
function ExternalPreviewStory({ width, height, ...props }: Parameters<typeof ExternalPreviewPrompt>[0] & { width: number; height: number }) {
  return (
    <div style={{ width, height }} className="relative overflow-hidden bg-terminal-bg">
      <ExternalPreviewPrompt {...props} />
    </div>
  );
}

const meta: Meta<typeof ExternalPreviewStory> = {
  title: 'Components/IframeExternalPreview',
  component: ExternalPreviewStory,
  args: {
    width: 640,
    height: 360,
    origin: 'http://docs.example.com:8080',
    onOpenInBrowser: fn(),
    onAllow: fn(),
    onCancel: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof ExternalPreviewStory>;

/** Names the origin and offers each action, each reaching its own handler. */
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alertdialog', { name: 'External website preview' })).toBeVisible();
    await expect(canvas.getByText(args.origin)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Allow this origin' }));
    await expect(args.onAllow).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Open in browser' }));
    await expect(args.onOpenInBrowser).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(args.onCancel).toHaveBeenCalledOnce();
  },
};

/** A host that cannot open a system browser offers only the other two. */
export const NoSystemBrowser: Story = {
  args: { onOpenInBrowser: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('button', { name: 'Open in browser' })).toBeNull();
  },
};

/** A long origin wraps inside a narrow pane rather than overflowing it. */
export const Narrow: Story = {
  args: { width: 240, height: 320, origin: `http://${'very-long-subdomain-'.repeat(4)}example.com:65535` },
  play: async ({ canvasElement }) => {
    const pane = canvasElement.firstElementChild as HTMLElement;
    await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth + 1);
  },
};
