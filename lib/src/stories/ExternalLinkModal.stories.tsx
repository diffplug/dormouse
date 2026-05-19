import type { Meta, StoryObj } from '@storybook/react';
import { ExternalLinkModal } from '../components/ExternalLinkModal';
import { classifyDisplayMatch, inspectExternalUri } from '../lib/external-links';

function ExternalLinkModalStory({ uri, displayText }: { uri: string; displayText: string }) {
  return (
    <div className="relative h-[360px] w-[680px] overflow-hidden rounded bg-app-bg font-mono text-terminal-fg">
      <div className="p-4 text-sm">
        <div>dev@dormouse:~/repo$ pnpm test</div>
        <div className="text-muted">See the linked report for details.</div>
      </div>
      <ExternalLinkModal
        request={{
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

// Deceptive: link text looks like a URL but resolves to a different host.
export const DeceptiveDomain: Story = {
  args: {
    uri: 'https://evil.example.com/phish',
    displayText: 'goog1e.com',
  },
};

// Deceptive variant where the label is a full URL pretending to be the target.
export const DeceptiveFullUrl: Story = {
  args: {
    uri: 'https://evil.example.com/phish',
    displayText: 'https://github.com/diffplug/dormouse',
  },
};

// Custom scheme + match (no separate link text).
export const CustomScheme: Story = {
  args: {
    uri: 'vscode://file/Users/dev/project/src/App.tsx:42:7',
    displayText: '',
  },
};

// Custom scheme with a plain label.
export const CustomSchemePlain: Story = {
  args: {
    uri: 'vscode://file/Users/dev/project/src/App.tsx:42:7',
    displayText: 'open in editor',
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

// Blocked URL hidden behind a plain label.
export const BlockedWithLabel: Story = {
  args: {
    uri: 'javascript:alert(document.cookie)',
    displayText: 'click for free shipping',
  },
};
