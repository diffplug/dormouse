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

export const VeryLongUrl: Story = {
  args: {
    uri: 'https://ci.example.com/builds/dormouse/kitty-keyboard/jobs/terminal-osc-8-hyperlink-confirmation/artifacts/reports/playwright/index.html?runId=2026-05-18T23%3A41%3A02.441Z&attempt=7&sha=d96cc07f9f66ff72b7f89433cf571e9a13d4c081680&path=packages%2Flib%2Fsrc%2Fcomponents%2FExternalLinkDialog.tsx&label=the-terminal-output-rendered-this-link-with-a-short-friendly-label-but-the-real-url-is-intentionally-extremely-long-to-verify-wrapping-scrolling-and-full-target-review-before-opening&token=eyJhbGciOiJub25lIiwidHlwIjoiSldUIiwiZGVtb19vbmx5Ijp0cnVlLCJwdXJwb3NlIjoic3Rvcnlib29rLWxvbmdfdXJsLXZpc3VhbC1jYXNlIn0',
  },
};

export const Blocked: Story = {
  args: {
    uri: 'javascript:alert(document.cookie)',
  },
};
