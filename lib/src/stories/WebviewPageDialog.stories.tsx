import type { Meta, StoryObj } from '@storybook/react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DOWNLOAD_REFUSED, PageDialogPrompt } from '../components/wall/WebviewPanel';

/** What a webview pane asks in place of its page's own `alert`, `confirm`, or
 *  `prompt`, and says of a refused download (docs/specs/webview-pane.md →
 *  "Page boundary"). */
function PageDialogStory({ width, height, ...props }: Parameters<typeof PageDialogPrompt>[0] & { width: number; height: number }) {
  return (
    <div data-dialog-story style={{ width, height }} className="relative overflow-hidden bg-terminal-bg">
      <PageDialogPrompt {...props} />
    </div>
  );
}

const ASKER = 'http://localhost:5173 says:';

const meta: Meta<typeof PageDialogStory> = {
  title: 'Components/WebviewPageDialog',
  component: PageDialogStory,
  args: {
    width: 640,
    height: 360,
    asker: ASKER,
    dialog: { dialog: 'confirm', message: 'Discard your unsaved changes?' },
    // The pane in passthrough hands its prompt the keyboard.
    focusTarget: fn(),
    onAnswer: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof PageDialogStory>;

/** A confirm names its page, and each button gives the page its own answer. */
export const Confirm: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alertdialog', { name: ASKER })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'OK' })).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel' }));
    await expect(args.onAnswer).toHaveBeenLastCalledWith(false);
    await userEvent.click(canvas.getByRole('button', { name: 'OK' }));
    await expect(args.onAnswer).toHaveBeenLastCalledWith(true, undefined);
  },
};

/** An alert has nothing to refuse. */
export const Alert: Story = {
  args: { dialog: { dialog: 'alert', message: 'Your session has expired.' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'OK' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Cancel' })).toBeNull();
  },
};

/** A prompt opens on the page's default text, and Enter answers with what was typed. */
export const Prompt: Story = {
  args: { dialog: { dialog: 'prompt', message: 'Name this branch:', text: 'feature/' } },
  play: async ({ canvasElement, args }) => {
    const input = within(canvasElement).getByRole('textbox', { name: ASKER });
    await expect(input).toHaveFocus();
    await expect(input).toHaveValue('feature/');
    await userEvent.type(input, 'zoom{Enter}');
    await expect(args.onAnswer).toHaveBeenLastCalledWith(true, 'feature/zoom');
  },
};

/** A pane that is not the one in passthrough asks without taking the keyboard. */
export const NotInPassthrough: Story = {
  args: { focusTarget: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('button', { name: 'OK' })).not.toHaveFocus();
  },
};

/** The notice for a download the host refused: Dormouse speaking, not the page. */
export const DownloadRefused: Story = {
  args: DOWNLOAD_REFUSED,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alertdialog', { name: DOWNLOAD_REFUSED.asker })).toBeVisible();
    await expect(canvas.getByText(DOWNLOAD_REFUSED.dialog.message)).toBeVisible();
  },
};

/** A page's text is shown as text, and a long one scrolls inside a narrow pane with the buttons still in reach. */
export const LongTextNarrow: Story = {
  args: {
    width: 240,
    height: 240,
    asker: `http://${'very-long-subdomain-'.repeat(4)}example.com:65535 says:`,
    dialog: { dialog: 'confirm', message: `<b>Not markup</b>\n${'A long line of page text. '.repeat(60)}` },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const pane = canvasElement.querySelector<HTMLElement>('[data-dialog-story]')!;
    await expect(pane.scrollWidth).toBeLessThanOrEqual(pane.clientWidth + 1);
    await expect(canvas.getByText(/<b>Not markup<\/b>/)).toBeInTheDocument();
    const bounds = pane.getBoundingClientRect();
    await expect(canvas.getByRole('button', { name: 'Cancel' }).getBoundingClientRect().bottom).toBeLessThanOrEqual(bounds.bottom);
  },
};
