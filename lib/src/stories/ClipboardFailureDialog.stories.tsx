import type { Meta, StoryObj } from '@storybook/react';
import { ClipboardFailureDialog } from '../components/ClipboardFailureDialog';

const REPORT = [
  'time: 2026-10-09T17:42:03.118Z',
  'userAgent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)',
  'textLength: 9',
  'activation: isActive=false hasBeenActive=true',
  'event: click isTrusted=true',
  'lastPointerdown: 84ms ago',
  'lastKeydown: 12406ms ago',
  'document: hasFocus=true visibility=visible',
  'activeElement: button.rounded',
  '+1ms navigator.clipboard.writeText: NotAllowedError: The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission. (activation now false)',
  "+1ms execCommand('copy'): returned false, copy event did not fire",
  "+2ms textarea execCommand('copy'): false",
].join('\n');

function ClipboardFailureDialogStory({ count }: { count: number }) {
  return (
    <div className="relative h-[560px] w-[720px] overflow-hidden rounded bg-app-bg font-mono text-terminal-fg">
      <ClipboardFailureDialog failure={{ report: REPORT, count }} onClose={() => {}} />
    </div>
  );
}

const meta: Meta<typeof ClipboardFailureDialogStory> = {
  title: 'Modals/ClipboardFailureDialog',
  component: ClipboardFailureDialogStory,
};

export default meta;
type Story = StoryObj<typeof ClipboardFailureDialogStory>;

export const FirstFailure: Story = { args: { count: 1 } };

export const Repeated: Story = { args: { count: 3 } };
