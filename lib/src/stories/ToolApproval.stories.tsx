import { useId } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ToolApproval } from '../components/wall/ToolApproval';

const longPath = `/worktrees/${'long-project-name-'.repeat(8)}/dormouse.yml`;

function ToolApprovalStory({ width, height, error }: { width: number; height: number; error: string }) {
  const id = useId();
  return (
    <div data-approval-story style={{ width, height }} className="overflow-hidden">
      <ToolApproval
        id={id}
        title="Pending Tool"
        params={{ toolPending: {
          name: 'storybook',
          run: `pnpm exec storybook --config-dir ${longPath}`,
          path: longPath,
          projectRoot: longPath.slice(0, -'/dormouse.yml'.length),
          upstreamUrl: `https://example.com/${'long-repository-name-'.repeat(8)}.git`,
          minimized: false,
          error,
        } }}
        onResolve={() => {}}
      />
    </div>
  );
}

const meta: Meta<typeof ToolApprovalStory> = {
  title: 'Components/ToolApproval',
  component: ToolApprovalStory,
  args: { width: 320, height: 800, error: `Could not save permission: ${longPath}` },
};

export default meta;
type Story = StoryObj<typeof ToolApprovalStory>;

/** Long unbroken paths, upstream names, commands, and errors must wrap. */
export const Narrow: Story = {};

/** Keep the start of overflowing content reachable, not centered above the pane. */
export const Short: Story = {
  args: { height: 180 },
  play: ({ canvasElement }) => {
    const pane = canvasElement.querySelector('[data-approval-story]')!.firstElementChild as HTMLElement;
    const content = pane.firstElementChild as HTMLElement;
    if (pane.scrollWidth > pane.clientWidth + 1) throw new Error('Approval overflows horizontally');
    if (content.getBoundingClientRect().top < pane.getBoundingClientRect().top) {
      throw new Error('Approval starts above the scroll origin');
    }
    if (pane.scrollHeight <= pane.clientHeight) throw new Error('Short approval must overflow vertically');
  },
};

/** Capture the controls after scrolling a short pane, and check their reachability. */
export const ShortScrolledToControls: Story = {
  args: { height: 180 },
  play: ({ canvasElement }) => {
    const pane = canvasElement.querySelector('[data-approval-story]')!.firstElementChild as HTMLElement;
    const buttons = [...pane.querySelectorAll('button')];
    for (const button of buttons) {
      button.scrollIntoView({ block: 'nearest' });
      const bounds = button.getBoundingClientRect();
      const viewport = pane.getBoundingClientRect();
      if (bounds.top < viewport.top - 1 || bounds.bottom > viewport.bottom + 1) {
        throw new Error('Approval control cannot be scrolled into view');
      }
    }
  },
};
