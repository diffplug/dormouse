import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ExternalLinkModal } from '../components/ExternalLinkModal';
import { classifyDisplayMatch, inspectExternalUri } from '../lib/external-links';
import { documentLinkRequest } from '../lib/external-link-confirmation';

function ExternalLinkModalStory({ uri, displayText, documentLink = false, ...dialog }: { uri: string; displayText: string; documentLink?: boolean } & Pick<ComponentProps<typeof ExternalLinkModal>, 'handlers' | 'error' | 'busy'>) {
  const [selected, setSelected] = useState(0);
  return (
    <div className="relative h-[360px] w-[680px] overflow-hidden rounded bg-app-bg font-mono text-terminal-fg">
      <div className="p-4 text-sm">
        <div>dev@dormouse:~/repo$ pnpm test</div>
        <div className="text-muted">See the linked report for details.</div>
      </div>
      <ExternalLinkModal
        {...dialog}
        selected={selected}
        onSelect={setSelected}
        request={documentLink ? documentLinkRequest(uri) : {
          uri,
          displayText,
          verdict: classifyDisplayMatch(uri, displayText),
          decision: inspectExternalUri(uri),
        }}
        onCancel={() => {}}
        onConfirm={() => {}}
      />
    </div>
  );
}

const meta: Meta<typeof ExternalLinkModalStory> = {
  title: 'Modals/ExternalLinkModal',
  component: ExternalLinkModalStory,
  argTypes: {
    uri: { control: 'text' },
    displayText: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof ExternalLinkModalStory>;

// Match: terminal auto-detected the URL (no separate link text).
export const Https: Story = {
  args: {
    uri: 'https://github.com/diffplug/dormouse/pull/72?tab=files',
    displayText: '',
  },
};

// Plain label: OSC 8 link with a human-readable label. Normal case.
export const PlainLabel: Story = {
  args: {
    uri: 'https://ci.example.com/builds/dormouse/jobs/test/report.html',
    displayText: 'see the test report',
  },
};

// Deceptive: the label is a full URL pretending to be the target.
export const DeceptiveFullUrl: Story = {
  args: {
    uri: 'https://evil.example.com/phish',
    displayText: 'https://github.com/diffplug/dormouse',
  },
};

// Any scheme but http, https, mailto, and file opens another app: the title
// names the scheme, and Cancel holds the initial focus.
export const OtherApp: Story = {
  args: {
    uri: 'vscode://file/Users/dev/project/src/App.tsx:42:7',
    displayText: 'open in editor',
  },
};

// A Windows handler with a record of running code from a link: no open action.
export const RefusedHandler: Story = {
  args: {
    uri: 'search-ms:query=report',
    displayText: 'see the report',
  },
};

// file:// URL — match case.
export const FileUrl: Story = {
  args: {
    uri: 'file:///Users/dev/project/tmp/report.html',
    displayText: '',
  },
};

// mailto: with a label.
export const MailtoPlain: Story = {
  args: {
    uri: 'mailto:support@example.com',
    displayText: 'contact the team',
  },
};

// Long URL stress test (match).
export const VeryLongUrl: Story = {
  args: {
    uri: 'https://ci.example.com/builds/dormouse/kitty-keyboard/jobs/terminal-osc-8-hyperlink-confirmation/artifacts/reports/playwright/index.html?runId=2026-05-18T23%3A41%3A02.441Z&attempt=7&sha=d96cc07f9f66ff72b7f89433cf571e9a13d4c081680&path=packages%2Flib%2Fsrc%2Fcomponents%2FExternalLinkModal.tsx&label=the-terminal-output-rendered-this-link-with-a-short-friendly-label-but-the-real-url-is-intentionally-extremely-long-to-verify-wrapping-scrolling-and-full-target-review-before-opening&token=eyJhbGciOiJub25lIiwidHlwIjoiSldUIiwiZGVtb19vbmx5Ijp0cnVlLCJwdXJwb3NlIjoic3Rvcnlib29rLWxvbmdfdXJsLXZpc3VhbC1jYXNlIn0',
    displayText: '',
  },
};

// Blocked URL (javascript: scheme) — match between displayed text and URL.
export const Blocked: Story = {
  args: {
    uri: 'javascript:alert(document.cookie)',
    displayText: '',
  },
};

export const FileViewers: Story = {
  args: {
    uri: 'file:///Users/dev/project/report.md',
    displayText: '[Report]',
    handlers: [
      { tool: 'builtin:file', description: 'Markdown editor', reason: 'built-in; no open rule matches' },
      { tool: 'builtin:code', description: 'code editor (source)', reason: 'built-in' },
    ],
  },
};

export const FileOpenFailed: Story = {
  args: {
    uri: 'file:///Users/dev/project/image.png',
    displayText: '[Image #2]',
    error: 'no such file or folder: file:///Users/dev/project/image.png',
  },
};

// A Markdown link whose target runs its own scripts: the Tool's page named it,
// so the host asks with the full resolved path before it opens.
export const DocumentLinkToActivePage: Story = {
  args: {
    uri: '/Users/dev/Downloads/report/index.html',
    displayText: '',
    documentLink: true,
  },
};
