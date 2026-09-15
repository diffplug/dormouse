import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { BellIcon, FrameCornersIcon, XIcon } from '@phosphor-icons/react';
import { PANE_HEADER_HEIGHT_PX } from '../components/design';
import { NotepadHeaderButton } from '../components/wall/NotepadHeaderButton';
import { NotepadPanel } from '../components/NotepadPanel';
import { TerminalContextView } from '../components/wall/TerminalContextView';

// Sample terminal output with the shared context presentation and notepad UI.
// Local state switches fixtures and opens visual detail treatments.
type Scenario = 'fresh' | 'noPorts' | 'running' | 'preserved' | 'editor' | 'differentDirectory' | 'multiplePorts' | 'notification' | 'autorunOff' | 'scanFailed';
const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'fresh', label: 'Common case' },
  { id: 'noPorts', label: 'No ports' },
  { id: 'running', label: 'Autorun running' },
  { id: 'preserved', label: 'User input' },
  { id: 'editor', label: 'Editor open' },
  { id: 'differentDirectory', label: 'Different directory' },
  { id: 'multiplePorts', label: 'Multiple ports' },
  { id: 'notification', label: 'Notification' },
  { id: 'autorunOff', label: 'Autorun off' },
  { id: 'scanFailed', label: 'Scan failed' },
];
const PARENT_DIR = '~/projects/dormouse';
const HELPER_DIR = '~/projects/dormouse-fix';

function Prompt({ children, directory = PARENT_DIR }: { children?: ReactNode; directory?: string }) {
  return <div><span className="text-link">{directory}</span> <span className="text-muted">❯</span> {children}</div>;
}

function GitStatus() {
  return <>
    <Prompt>git status</Prompt>
    <div>On branch new-right-click</div>
    <div>Your branch is up to date with 'origin/new-right-click'.</div>
    <br />
    <div>Changes not staged for commit:</div>
    <div className="text-muted">  (use "git add &lt;file&gt;..." to update what will be committed)</div>
    <div className="text-error">        modified:   lib/src/components/Wall.tsx</div>
    <div className="text-error">        modified:   docs/specs/layout.md</div>
    <br />
    <div>no changes added to commit (use "git add" and/or "git commit -a")</div>
  </>;
}

function Cursor() {
  return <span aria-hidden className="inline-block h-4 w-2 translate-y-0.5 bg-terminal-fg" />;
}

function TerminalOutput({ scenario }: { scenario: Scenario }) {
  if (scenario === 'editor') return <div className="flex h-full flex-col">
    <div className="flex justify-between bg-header-inactive-bg px-2 text-header-inactive-fg"><span>GNU nano 8.3</span><span>notes.md</span><span>Modified</span></div>
    <div className="pt-3"># Context menu ideas</div>
    <br />
    <div>Keep the helper big enough for actual work.</div>
    <div>Make the directory mismatch impossible to miss.<Cursor /></div>
    <div className="mt-auto grid grid-cols-4 gap-x-5 pt-4 text-muted">
      <span>^G Help</span><span>^O Write Out</span><span>^W Where Is</span><span>^K Cut</span>
      <span>^X Exit</span><span>^R Read File</span><span>^\ Replace</span><span>^U Paste</span>
    </div>
  </div>;
  if (scenario === 'running') return <>
    <Prompt>git status</Prompt>
    <div className="text-muted">Refreshing index:  68% (816/1200)</div>
  </>;
  if (scenario === 'autorunOff') return <Prompt><Cursor /></Prompt>;
  if (scenario === 'differentDirectory') return <>
    <Prompt>cd ../dormouse-fix</Prompt>
    <Prompt directory={HELPER_DIR}>git log -3 --oneline</Prompt>
    <div><span className="text-link">a8d21f0</span> Fix pane focus after splitting</div>
    <div><span className="text-link">56b302e</span> Keep terminal titles stable</div>
    <div><span className="text-link">3c119a4</span> Update layout spec</div>
    <br />
    <Prompt directory={HELPER_DIR}><Cursor /></Prompt>
  </>;
  return <>
    <GitStatus />
    <br />
    {scenario === 'preserved' && <>
      <Prompt>cat .node-version</Prompt>
      <div>24.18.0</div>
      <Prompt>echo "check focus after split"</Prompt>
      <div>check focus after split</div>
      <br />
    </>}
    <Prompt>{scenario === 'preserved' && 'git diff --'}<Cursor /></Prompt>
  </>;
}

function ContextPrototype({ scenario, initialDetail = null, paneWidth }: { scenario: Scenario; initialDetail?: 'title' | 'modify' | 'reset' | null; paneWidth: number }) {
  const [watching, setWatching] = useState(false);
  const [todo, setTodo] = useState(scenario === 'notification');
  const [command, setCommand] = useState(scenario === 'autorunOff' ? '' : 'git status');
  const preserved = ['preserved', 'editor', 'differentDirectory'].includes(scenario);
  const ports = (scenario === 'multiplePorts' ? [5173, 6006, 9229] : [5173]).map(port => ({ port, host: 'localhost', url: `http://localhost:${port}/`, processName: port === 5173 ? 'vite' : port === 6006 ? 'storybook' : 'node inspector' }));
  return <div className="relative h-[680px] overflow-hidden rounded-lg bg-terminal-bg font-mono text-sm text-terminal-fg" style={{ width: paneWidth }}>
    <div className="flex items-center gap-2 bg-header-active-bg px-2.5 text-header-active-fg" style={{ height: PANE_HEADER_HEIGHT_PX }}><span>pnpm dev</span><BellIcon size={13} /><span className="ml-auto flex items-center gap-3"><FrameCornersIcon size={13} /><XIcon size={13} /></span></div>
    <pre className="m-0 p-3 leading-6 text-muted">{'~/projects/dormouse ❯ pnpm dev\n\n  VITE ready\n  ➜  Local: http://localhost:5173/'}</pre>
    <div className="absolute inset-0">
      <TerminalContextView title="pnpm dev" surfaceRef="surface:3" cwd={PARENT_DIR} helperCwd={HELPER_DIR} mismatch={scenario === 'differentDirectory'}
        titleSources={[{ source: 'User override', value: 'Not set' }, { source: 'OSC 2', value: 'pnpm dev', note: 'Used' }, { source: 'OSC 0', value: 'zsh', note: 'Not used' }, { source: 'Command', value: 'pnpm dev', note: 'Fallback' }]}
        scan={scenario === 'scanFailed' ? { status: 'failed' } : { status: 'loaded', entries: scenario === 'noPorts' ? [] : ports }}
        argv0="pnpm" watching={watching} todo={todo} notification={scenario === 'notification' ? { title: 'Tests complete', body: '341 passed, 0 failed' } : null}
        status={preserved ? 'preserved' : scenario === 'running' ? 'running' : scenario === 'autorunOff' ? 'off' : 'completed'} command={command}
        explorerLabel="Open in Finder" canExplore canAgent canIframe initialDetail={initialDetail}
        notepadAction={<NotepadHeaderButton surfaceId="context-gallery" />} notepadPanel={<NotepadPanel surfaceId="context-gallery" pins={false} />}
        onClose={() => {}} onCopyRef={() => {}} onCopyPath={() => {}} onExplore={() => {}} onPort={() => {}}
        onWatch={() => setWatching(!watching)} onTodo={() => setTodo(!todo)} onModify={async value => setCommand(value)} onReset={async () => {}} onPromote={async () => {}}>
        <div className="h-full overflow-auto px-3 py-2" style={{ fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap' }}><TerminalOutput scenario={scenario} /></div>
      </TerminalContextView>
    </div>
  </div>;
}

function TerminalContextStory({ initialScenario = 'fresh', initialDetail = null, paneWidth = 900 }: { initialScenario?: Scenario; initialDetail?: 'title' | 'modify' | 'reset' | null; paneWidth?: number }) {
  const [scenario, setScenario] = useState(initialScenario);
  return <main className="min-h-screen bg-app-bg p-5 font-mono text-sm text-foreground">
    <div className="mb-3 w-[900px]">
      <div className="mb-2 flex items-center justify-between"><span className="font-semibold">Terminal context / state gallery</span><span className="text-muted">Production layout · sample terminal output</span></div>
      <div className="flex flex-wrap gap-1" aria-label="Preview states">
        {SCENARIOS.map(item => <button key={item.id} type="button" aria-pressed={scenario === item.id} onClick={() => setScenario(item.id)} className={`rounded px-2 py-1 ${scenario === item.id ? 'bg-header-active-bg text-header-active-fg' : 'text-muted hover:bg-foreground/10'}`}>{item.label}</button>)}
      </div>
    </div>
    <ContextPrototype key={scenario} scenario={scenario} initialDetail={initialDetail} paneWidth={paneWidth} />
  </main>;
}

const meta = {
  title: 'Prototypes/Terminal context',
  component: TerminalContextStory,
  parameters: { layout: 'fullscreen' },
  args: { initialScenario: 'fresh' },
} satisfies Meta<typeof TerminalContextStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CommonCase: Story = {};
export const NarrowHelperHeader: Story = { args: { initialScenario: 'preserved', paneWidth: 660 } };
export const NoPorts: Story = { args: { initialScenario: 'noPorts' } };
export const AutorunRunning: Story = { args: { initialScenario: 'running' } };
export const DifferentDirectory: Story = { args: { initialScenario: 'differentDirectory' } };
export const MultiplePorts: Story = { args: { initialScenario: 'multiplePorts' } };
export const Notification: Story = { args: { initialScenario: 'notification' } };
export const AutorunOff: Story = { args: { initialScenario: 'autorunOff' } };
export const PortScanFailed: Story = { args: { initialScenario: 'scanFailed' } };
export const TitleSources: Story = { args: { initialDetail: 'title' } };
export const ModifyAutorun: Story = { args: { initialDetail: 'modify' } };
export const ResetConfirmation: Story = { args: { initialScenario: 'editor', initialDetail: 'reset' } };
