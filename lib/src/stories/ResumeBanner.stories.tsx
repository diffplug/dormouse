import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { ResumeBannerView } from '../components/wall/ResumeBanner';
import { TerminalPane } from '../components/TerminalPane';
import { clearResumeOffer, offerResumeCommand } from '../lib/resume-offers';
import { BOLD, DIM, PROMPT, RESET, fg } from '../lib/ansi';
import type { FakeScenario } from '../lib/platform';
import { settleTerminals } from './settle-terminals';

// Scrollback as a cold restore replays it: the agent's parting resume hint is
// the last thing the old process wrote, and below it sits the prompt of the
// FRESH shell the restore spawned. The offer exists to close that gap.
const RESTORED_AGENT_SCROLLBACK = [
  `${fg(35)}✻${RESET} Compacting conversation…`,
  ``,
  `  Wrote ${BOLD}lib/src/lib/resume-patterns.ts${RESET}`,
  `  Wrote ${BOLD}lib/src/lib/resume-patterns.test.ts${RESET}`,
  ``,
  `${fg(32)}✔${RESET} 9 tests passed`,
  ``,
  `${DIM}Session ended. Resume it with:${RESET}`,
  `${DIM}  claude --resume 4f2c9b1e-6a03-4d5e-9c17-0b8ad2e15f44${RESET}`,
  ``,
].join('\r\n');

function restoredScenario(): FakeScenario {
  return {
    name: 'restored-agent-pane',
    chunks: [{ delay: 0, data: `${RESTORED_AGENT_SCROLLBACK}\r\n${PROMPT}` }],
    endsWithPrompt: true,
  };
}

const CLAUDE_RESUME = 'claude --resume 4f2c9b1e-6a03-4d5e-9c17-0b8ad2e15f44';

/**
 * The offer in the only place it ever appears: over a cold-restored terminal.
 * Seeds the store exactly as `restoreSession` does and renders a bare
 * `TerminalPane` — the offer shows up because the pane mounts the connected
 * `ResumeBanner` itself, so this is the shipping path, not a mock of it. Run
 * writes to the fake PTY, which has no shell behind it, so nothing echoes back.
 */
function RestoredPane({ id, command }: { id: string; command: string }) {
  useEffect(() => {
    offerResumeCommand(id, command);
    return () => clearResumeOffer(id);
  }, [id, command]);

  return (
    <div className="relative h-full min-h-[220px] w-full bg-terminal-bg">
      <TerminalPane id={id} isFocused={true} />
    </div>
  );
}

const meta: Meta<typeof RestoredPane> = {
  title: 'Terminal/ResumeBanner',
  component: RestoredPane,
  parameters: { fakePty: { scenario: restoredScenario() } },
  play: () => settleTerminals(),
};

export default meta;
type Story = StoryObj<typeof RestoredPane>;

/** The shipping case: a `claude --resume <uuid>` offer over restored scrollback. */
export const InRestoredPane: Story = {
  args: { id: 'resume-claude', command: CLAUDE_RESUME },
};

/** Every pattern `detectResumeCommand` knows, on the terminal surface the offer
 *  floats over. No terminal — this is the chrome. The run label is the
 *  invocation, so a long session id never changes the button's width. */
export const CommandVariants: StoryObj = {
  parameters: { fakePty: { scenario: undefined } },
  // No terminal in this one, so meta's settleTerminals gate would just burn its
  // whole timeout waiting for content that never comes.
  play: async () => {},
  render: () => (
    <div className="flex flex-col gap-2 bg-app-bg p-2">
      {[
        { label: 'claude --resume (long uuid)', command: CLAUDE_RESUME },
        { label: 'claude --continue', command: 'claude --continue' },
        { label: 'codex resume', command: 'codex resume 01JCX8ZK5Q7M3N' },
      ].map(({ label, command }) => (
        <div key={label} className="relative h-16 w-full rounded-lg bg-terminal-bg">
          <span className="absolute top-1 left-2 text-xs text-muted">{label}</span>
          <ResumeBannerView command={command} onResume={() => {}} onDismiss={() => {}} />
        </div>
      ))}
      {/* Narrow pane: both buttons must still fit inside the pane. */}
      <div className="relative h-16 w-[320px] rounded-lg bg-terminal-bg">
        <span className="absolute top-1 left-2 text-xs text-muted">narrow pane</span>
        <ResumeBannerView command={CLAUDE_RESUME} onResume={() => {}} onDismiss={() => {}} />
      </div>
    </div>
  ),
};
