import { useState, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { expect, within, userEvent } from 'storybook/test';
import { FrameCornersIcon, XIcon } from '@phosphor-icons/react';
import { PANE_HEADER_HEIGHT_PX } from '../components/design';
import { placeTerminalContext, type ContextSide } from '../components/wall/terminal-context-placement';
import { TerminalContextView } from '../components/wall/TerminalContextView';
import { contextHostStyle } from '../components/wall/TerminalContextOverlay';
import type { ContextMode } from '../components/wall/wall-context';

// Sample terminal output with the shared context presentation.
// Local state switches fixtures and opens visual detail treatments.
type Scenario = 'fresh' | 'noPorts' | 'userInput' | 'editor' | 'differentDirectory' | 'multiplePorts' | 'notification' | 'exited' | 'scanFailed' | 'launchPending' | 'launchFailed';
const SCENARIOS: { id: Scenario; label: string }[] = [
  { id: 'fresh', label: 'Common case' },
  { id: 'noPorts', label: 'No ports' },
  { id: 'userInput', label: 'User input' },
  { id: 'editor', label: 'Editor open' },
  { id: 'differentDirectory', label: 'Different directory' },
  { id: 'multiplePorts', label: 'Multiple ports' },
  { id: 'notification', label: 'Notification' },
  { id: 'exited', label: 'Aux exited' },
  { id: 'scanFailed', label: 'Scan failed' },
  { id: 'launchPending', label: 'Opening browser' },
  { id: 'launchFailed', label: 'Browser launch failed' },
];
const PARENT_DIR = '~/projects/dormouse';
const AUX_DIR = '~/projects/dormouse-fix';

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
    <div>Keep the aux terminal big enough for actual work.</div>
    <div>Make the directory mismatch impossible to miss.<Cursor /></div>
    <div className="mt-auto grid grid-cols-4 gap-x-5 pt-4 text-muted">
      <span>^G Help</span><span>^O Write Out</span><span>^W Where Is</span><span>^K Cut</span>
      <span>^X Exit</span><span>^R Read File</span><span>^\ Replace</span><span>^U Paste</span>
    </div>
  </div>;
  if (scenario === 'exited') return <Prompt>exit</Prompt>;
  if (scenario === 'differentDirectory') return <>
    <Prompt>cd ../dormouse-fix</Prompt>
    <Prompt directory={AUX_DIR}>git log -3 --oneline</Prompt>
    <div><span className="text-link">a8d21f0</span> Fix pane focus after splitting</div>
    <div><span className="text-link">56b302e</span> Keep terminal titles stable</div>
    <div><span className="text-link">3c119a4</span> Update layout spec</div>
    <br />
    <Prompt directory={AUX_DIR}><Cursor /></Prompt>
  </>;
  if (scenario === 'userInput') return <>
    <GitStatus />
    <br />
    <Prompt>cat .node-version</Prompt>
    <div>24.18.0</div>
    <Prompt>echo "check focus after split"</Prompt>
    <div>check focus after split</div>
    <br />
    <Prompt>git diff --<Cursor /></Prompt>
  </>;
  return <Prompt><Cursor /></Prompt>;
}

function ContextPrototype({ scenario, initialMode, initialDetail = null, paneWidth, paneHeight, bothProviders = false }: { bothProviders?: boolean; scenario: Scenario; initialMode: ContextMode; initialDetail?: 'title' | 'reset' | null; paneWidth: number; paneHeight: number }) {
  const [side, setSide] = useState<ContextSide | undefined>();
  const [mode, setMode] = useState(initialMode);
  const bounds = { x: 0, y: 0, width: paneWidth, height: paneHeight };
  const placement = placeTerminalContext(bounds, bounds, false, side);
  const [watching, setWatching] = useState(false);
  const [todo, setTodo] = useState(scenario === 'notification');
  const ports = (scenario === 'multiplePorts' ? [5173, 6006, 9229] : [5173]).map(port => ({ port, host: 'localhost', url: `http://localhost:${port}/`, processName: port === 5173 ? 'vite' : port === 6006 ? 'storybook' : 'node inspector' }));
  return <div className="relative overflow-hidden rounded-lg bg-terminal-bg font-mono text-sm text-terminal-fg" style={{ width: paneWidth, height: paneHeight }}>
    <div className="flex items-center gap-2 bg-header-active-bg px-2.5 text-header-active-fg" style={{ height: PANE_HEADER_HEIGHT_PX }}><span>pnpm dev</span><span className="ml-auto flex items-center gap-3"><FrameCornersIcon size={13} /><XIcon size={13} /></span></div>
    <pre className="m-0 p-3 leading-6 text-muted">{'~/projects/dormouse ❯ pnpm dev\n\n  VITE ready\n  ➜  Local: http://localhost:5173/'}</pre>
    <div className="absolute flex flex-col" style={contextHostStyle(placement, mode)}>
      <TerminalContextView mode={mode} onModeChange={setMode} placement={{ ...placement, onChange: setSide }} surfaceId="surface:3" cwd={PARENT_DIR} auxCwd={AUX_DIR} mismatch={scenario === 'differentDirectory'}
        titleSources={[{ source: 'User override', value: 'Not set' }, { source: 'OSC 2', value: 'pnpm dev', note: 'Used' }, { source: 'OSC 0', value: 'zsh', note: 'Not used' }, { source: 'Command', value: 'pnpm dev', note: 'Fallback' }]}
        scan={scenario === 'scanFailed' ? { status: 'failed' } : { status: 'loaded', entries: scenario === 'noPorts' ? [] : ports }}
        watchRule="pnpm" watching={watching} todo={todo} notification={scenario === 'notification' ? { title: 'Tests complete', body: '341 passed, 0 failed' } : null}
        exited={scenario === 'exited'}
        explorerLabel="Reveal in Finder" canExplore browserProviders={bothProviders ? ['agent-browser', 'playwright'] : ['agent-browser']} canIframe initialDetail={initialDetail}
        onClose={() => {}} onCopyId={() => {}} onCopyPath={() => {}} onExplore={() => {}} onPort={() => {
          if (scenario === 'launchPending') return new Promise<void>(() => {});
          if (scenario === 'launchFailed') throw new Error("agent-browser binary not found ('agent-browser' was not found)");
        }}
        onWatch={() => setWatching(!watching)} onTodo={() => setTodo(!todo)} onReset={async () => {}} onPromote={async () => {}}>
        <div className="h-full overflow-auto px-3 py-2" style={{ fontSize: 13, lineHeight: '20px', whiteSpace: 'pre-wrap' }}><TerminalOutput scenario={scenario} /></div>
      </TerminalContextView>
    </div>
  </div>;
}

function TerminalContextStory({ initialScenario = 'fresh', initialMode = 'properties', initialDetail = null, paneWidth = 900, paneHeight = 680, bothProviders = false }: { bothProviders?: boolean; initialScenario?: Scenario; initialMode?: ContextMode; initialDetail?: 'title' | 'reset' | null; paneWidth?: number; paneHeight?: number }) {
  const [scenario, setScenario] = useState(initialScenario);
  return <main className="min-h-screen bg-app-bg p-5 font-mono text-sm text-foreground">
    <div className="mb-3 w-[900px]">
      <div className="mb-2 flex items-center justify-between"><span className="font-semibold">Terminal context / state gallery</span><span className="text-muted">Production layout · sample terminal output</span></div>
      <div className="flex flex-wrap gap-1" aria-label="Preview states">
        {SCENARIOS.map(item => <button key={item.id} type="button" aria-pressed={scenario === item.id} onClick={() => setScenario(item.id)} className={`rounded px-2 py-1 ${scenario === item.id ? 'bg-header-active-bg text-header-active-fg' : 'text-muted hover:bg-foreground/10'}`}>{item.label}</button>)}
      </div>
    </div>
    <ContextPrototype key={scenario} bothProviders={bothProviders} scenario={scenario} initialMode={initialMode} initialDetail={initialDetail} paneWidth={paneWidth} paneHeight={paneHeight} />
  </main>;
}

const meta = {
  title: 'Prototypes/Terminal context',
  component: TerminalContextStory,
  parameters: { layout: 'fullscreen' },
  args: { initialScenario: 'fresh' },
  play: async ({ args, canvasElement }) => {
    if (args.initialScenario === 'launchPending' || args.initialScenario === 'launchFailed') {
      const canvas = within(canvasElement);
      // Narrow stories reach the screencast through the overflow dropdown.
      const launch = canvas.queryByRole('button', { name: 'Open in agent-browser screencast' }) ?? canvas.getByRole('combobox', { name: 'More browser actions' });
      if (launch instanceof HTMLSelectElement) await userEvent.selectOptions(launch, 'agent-browser-screencast');
      else await userEvent.click(launch);
      if (args.initialScenario === 'launchPending') {
        await expect(launch).toHaveAttribute('aria-busy', 'true');
      } else {
        const diagnostic = canvas.getByRole('alert');
        await expect(diagnostic).toHaveTextContent('agent-browser binary not found');
        expect(getComputedStyle(diagnostic).userSelect).toBe('text');
        await userEvent.pointer([
          { keys: '[MouseLeft>]', target: diagnostic, offset: 0 },
          { target: diagnostic, offset: 13 },
          { keys: '[/MouseLeft]' },
        ]);
        await expect(diagnostic).toHaveFocus();
        expect(window.getSelection()?.toString()).toBe('agent-browser');
      }
    }
    // These snapshots must actually expose the state named in the story.
    if (['noPorts', 'multiplePorts', 'notification', 'scanFailed'].includes(args.initialScenario ?? 'fresh')) {
      const target = args.initialScenario === 'notification' ? within(canvasElement).getByText('Tests complete', { exact: true }) : canvasElement.querySelector<HTMLElement>('[data-context-ports]')!;
      target.scrollIntoView({ block: 'nearest' });
      await expect(target).toBeVisible();
    }
    const panel = canvasElement.querySelector<HTMLElement>('[data-terminal-context]')!;
    const bounds = panel.getBoundingClientRect();
    // The header, Dir, Ports, notification, and aux header rows each stay on one line at every width.
    for (const row of panel.querySelectorAll<HTMLElement>('[data-context-title], [data-context-dir], [data-context-ports], [data-context-notification], [data-context-aux-bar]')) {
      expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(28);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    }
    // DOM visibility matchers do not catch overflow clipping; check actual bounds.
    for (const element of panel.querySelectorAll('button')) {
      const box = element.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.left).toBeGreaterThanOrEqual(bounds.left);
      expect(box.right).toBeLessThanOrEqual(bounds.right);
    }
    // A button that fits must not do it by spilling or wrapping its label past its own box.
    for (const button of panel.querySelectorAll('button')) {
      expect(button.scrollWidth, button.getAttribute('aria-label') ?? '').toBeLessThanOrEqual(button.clientWidth);
      expect(button.scrollHeight, button.getAttribute('aria-label') ?? '').toBeLessThanOrEqual(button.clientHeight);
    }
    if (panel.dataset.contextMode === 'aux') {
      const terminal = panel.querySelector<HTMLElement>('.min-h-16.bg-terminal-bg')!;
      expect(terminal.getBoundingClientRect().height).toBeGreaterThanOrEqual(64);
    } else {
      // Properties take only their rows' height, never the whole space aux would.
      const properties = panel.querySelector<HTMLElement>('[data-context-properties]')!;
      expect(properties.scrollHeight).toBeLessThanOrEqual(properties.clientHeight + 1);
      expect(bounds.height).toBeLessThan(args.paneHeight ?? 680);
    }
  },
} satisfies Meta<typeof TerminalContextStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CommonCase: Story = {};
export const AuxTerminal: Story = { args: { initialMode: 'aux' } };
export const NarrowAuxHeader: Story = { args: { initialScenario: 'userInput', initialMode: 'aux', paneWidth: 660 } };
export const NoPorts: Story = { args: { initialScenario: 'noPorts' } };
export const DifferentDirectory: Story = { args: { initialScenario: 'differentDirectory', initialMode: 'aux' } };
export const MultiplePorts: Story = { args: { initialScenario: 'multiplePorts' } };
export const Notification: Story = { args: { initialScenario: 'notification' } };
export const AuxExited: Story = { args: { initialScenario: 'exited', initialMode: 'aux' } };
export const PortScanFailed: Story = { args: { initialScenario: 'scanFailed' } };
export const TitleSources: Story = { args: { initialDetail: 'title' } };
export const ResetConfirmation: Story = { args: { initialScenario: 'editor', initialMode: 'aux', initialDetail: 'reset' } };

export const MinimumWidth: Story = { args: { paneWidth: 280, paneHeight: 620 } };
export const MinimumWidthAux: Story = { args: { initialMode: 'aux', paneWidth: 280, paneHeight: 620 } };
export const ShortWindow: Story = { args: { initialMode: 'aux', paneWidth: 480, paneHeight: 280 } };
export const NarrowDetails: Story = { args: { initialScenario: 'multiplePorts', paneWidth: 380, paneHeight: 520 } };
export const NarrowDirectoryWarning: Story = { args: { initialScenario: 'differentDirectory', initialMode: 'aux', paneWidth: 380, paneHeight: 520 } };
export const NarrowResetConfirmation: Story = { args: { initialScenario: 'editor', initialMode: 'aux', initialDetail: 'reset', paneWidth: 380, paneHeight: 520 } };

export const OpeningBrowser: Story = { args: { initialScenario: 'launchPending', paneWidth: 380, paneHeight: 520 } };
export const BrowserLaunchFailed: Story = { args: { initialScenario: 'launchFailed', paneWidth: 480, paneHeight: 520 } };

export const BrowserProviders: Story = { args: { bothProviders: true, paneWidth: 900, paneHeight: 900 } };

/** The switch in each header leads to the other mode, and back. */
export const SwitchModes: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = () => canvasElement.querySelector<HTMLElement>('[data-terminal-context]')!;
    const propertiesHeight = panel().getBoundingClientRect().height;
    await userEvent.click(canvas.getByRole('button', { name: 'Show aux terminal' }));
    await expect(panel()).toHaveAttribute('data-context-mode', 'aux');
    expect(panel().getBoundingClientRect().height).toBeGreaterThan(propertiesHeight);
    await expect(panel()).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: 'Show properties' }));
    await expect(panel()).toHaveAttribute('data-context-mode', 'properties');
    expect(panel().getBoundingClientRect().height).toBeCloseTo(propertiesHeight);
  },
};
