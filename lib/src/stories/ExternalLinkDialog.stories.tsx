import type { Meta, StoryObj } from '@storybook/react';
import { ExternalLinkDialog } from '../components/ExternalLinkDialog';
import { inspectExternalUri } from '../lib/external-links';

function DialogStory({ uri }: { uri: string }) {
  return (
    <div className="relative h-[360px] w-[680px] overflow-hidden rounded bg-app-bg font-mono text-terminal-fg">
      <div className="p-4 text-sm">
        <div>dev@dormouse:~/repo$ pnpm test</div>
        <div className="text-muted">See the linked report for details.</div>
      </div>
      <ExternalLinkDialog
        request={{ uri, decision: inspectExternalUri(uri) }}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </div>
  );
}

const meta: Meta<typeof DialogStory> = {
  title: 'Components/ExternalLinkDialog',
  component: DialogStory,
  argTypes: {
    uri: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof DialogStory>;

export const Https: Story = {
  args: {
    uri: 'https://github.com/diffplug/dormouse/pull/72?tab=files',
  },
};

export const CustomScheme: Story = {
  args: {
    uri: 'vscode://file/Users/dev/project/src/App.tsx:42:7',
  },
};

export const FileUrl: Story = {
  args: {
    uri: 'file:///Users/dev/project/tmp/report.html',
  },
};

export const Blocked: Story = {
  args: {
    uri: 'javascript:alert(document.cookie)',
  },
};
