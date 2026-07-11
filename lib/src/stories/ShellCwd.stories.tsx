import type { Meta, StoryObj } from '@storybook/react';
import { Baseboard } from '../components/Baseboard';
import {
  ModeContext,
  RenamingIdContext,
  SelectedIdContext,
  TerminalPaneHeader,
  WallActionsContext,
  type DooredItem,
  type WallActions,
} from '../components/Wall';
import {
  cwdFromManualPath,
  cwdFromOsc1337,
  cwdFromOsc633,
  cwdFromOsc7,
  cwdFromOsc9_9,
  cwdFromProcessPath,
  deriveHeader,
  groupTerminalPanes,
  UNNAMED_PANEL_TITLE,
  type CommandRun,
  type CwdState,
  type ShellActivity,
  type TerminalPaneState,
  type TerminalTitle,
} from '../lib/terminal-registry';
import { createTerminalPaneState } from '../lib/terminal-state';

const HEADER_WIDTH = 380;
const DOOR_WIDTH = 300;
const BASE_TIME = 1_700_000_000_000;

interface ShellCwdCase {
  id: string;
  label: string;
  state: TerminalPaneState;
  fallbackTitle?: string;
  note?: string;
}

const noopActions: WallActions = {
  onKill: () => {},
  onMinimize: () => {},
  onAlertButton: () => 'noop',
  onToggleTodo: () => {},
  onSplitH: () => {},
  onSplitV: () => {},
  onZoom: () => {},
  onClickPanel: () => {},
  onFocusPane: () => {},
  onStartRename: () => {},
  onFinishRename: () => ({ accepted: true }),
  onCancelRename: () => {},
  onSwapRenderMode: () => {},
  resolveSurfaceRef: (id) => id,
  onConnectPort: () => {},
};

const meta: Meta<typeof ShellCwdMatrix> = {
  title: 'Terminal State/Shell and CWD',
  component: ShellCwdMatrix,
  parameters: {
    controls: { disable: true },
  },
};

export default meta;
type Story = StoryObj<typeof ShellCwdMatrix>;

export const CwdSourcesAndPathKinds: Story = storyFor([
  caseState('cwd-none', 'No CWD', idle({ activity: { kind: 'unknown' } }), 'No shell integration signal yet'),
  caseState('cwd-manual', 'Manual/restored', idle({ cwd: manual('/Users/me/restored-app') }), 'Initial launch or persisted directory'),
  caseState('cwd-process', 'Process fallback', idle({ cwd: processCwd('/Users/me/live-process') }), 'Local PTY process CWD'),
  caseState('cwd-osc7-local', 'OSC 7 local POSIX', idle({ cwd: osc7('file://localhost/Users/me/project') }), 'file://localhost/Users/me/project'),
  caseState('cwd-osc7-remote', 'OSC 7 remote POSIX', idle({ cwd: osc7('file://prod-box/home/me/project') }), 'Preserves remote host identity'),
  caseState('cwd-osc7-encoded', 'OSC 7 encoded', idle({ cwd: osc7('file://localhost/Users/me/My%20Project/ma%C3%B1ana') }), 'Decoded spaces and non-ASCII'),
  caseState('cwd-osc99-drive', 'OSC 9;9 drive', idle({ cwd: osc99('C:\\Users\\me\\repo') }), 'Windows drive-letter path'),
  caseState('cwd-osc99-unc', 'OSC 9;9 UNC', idle({ cwd: osc99('\\\\server\\share\\repo') }), 'Windows UNC path'),
  caseState('cwd-osc99-wsl', 'OSC 9;9 WSL-like', idle({ cwd: osc99('/mnt/c/Users/me/repo') }), 'Unknown path kind by design'),
  caseState('cwd-osc633', 'OSC 633 Cwd', idle({ cwd: osc633('/workspaces/dormouse') }), 'VS Code shell integration CWD'),
  caseState('cwd-osc1337', 'OSC 1337 CurrentDir', idle({ cwd: osc1337('/Users/me/iterm-app') }), 'iTerm2 CurrentDir compatibility'),
]);

export const HostAndDirectoryDisambiguation: Story = storyFor([
  caseState('host-sibling-app', 'Sibling app', running('/repo/app', 'pnpm test --watch'), 'Same command in sibling directories'),
  caseState('host-sibling-api', 'Sibling api', running('/repo/api', 'pnpm test --watch'), 'Same command in sibling directories'),
  caseState('host-unrelated-work', 'Unrelated app A', running('/work/client/app', 'npm run dev'), 'Same basename in unrelated tree'),
  caseState('host-unrelated-tmp', 'Unrelated app B', running('/tmp/scratch/app', 'npm run dev'), 'Same basename in unrelated tree'),
  caseState('host-local-same-path', 'Local same path', running('/home/me/app', 'cargo watch -x test', { host: 'localhost' }), 'Local host kept distinct'),
  caseState('host-remote-same-path', 'Remote same path', running('/home/me/app', 'cargo watch -x test', { host: 'prod-box' }), 'Remote host kept distinct'),
  caseState('host-long-path', 'Long path', running('/Users/me/src/company/product/apps/customer-facing-dashboard', 'docker compose up'), 'Long directory label truncates'),
  caseState('host-unknown-a', 'Unknown duplicate A', running(null, 'pytest'), 'No CWD available'),
  caseState('host-unknown-b', 'Unknown duplicate B', running(null, 'pytest'), 'No CWD available'),
]);

export const ShellActivityLifecycle: Story = storyFor([
  caseState('activity-unknown', 'Unknown', idle({ activity: { kind: 'unknown' }, title: terminalTitle('shell', 'osc0') }), 'No shell integration signal'),
  caseState('activity-prompt', 'Prompt drawing', idle({ activity: { kind: 'prompt' }, title: terminalTitle('zsh', 'osc0') }), 'Prompt start'),
  caseState('activity-editing', 'Editing', idle({ activity: { kind: 'editing' }, title: terminalTitle('zsh', 'osc0') }), 'At prompt'),
  caseState('activity-running', 'Running', running('/repo/app', 'npm run dev'), 'Foreground command active'),
  caseState('activity-finished-zero', 'Finished 0', finished('/repo/app', 'npm run dev', 0), 'Successful exit'),
  caseState('activity-finished-nonzero', 'Finished nonzero', finished('/repo/app', 'pnpm test', 1), 'Failing exit'),
  caseState('activity-finished-missing', 'Finished missing code', finished('/repo/app', 'cargo test'), 'No exit code reported'),
  caseState('activity-next-prompt', 'Next prompt', idle({ cwd: manual('/repo/app'), activity: { kind: 'editing' }, title: terminalTitle('zsh', 'osc0') }), 'Finished state cleared by prompt'),
]);

export const CommandSnapshotBehavior: Story = storyFor([
  caseState('snapshot-running', 'Running snapshot', running('/repo/app', 'pnpm test --watch'), 'Header disambiguates with command start CWD'),
  caseState('snapshot-cwd-changed', 'CWD changed while running', running('/repo/app', 'pnpm test --watch', { currentCwd: '/repo/other' }), 'Still groups by /repo/app'),
  caseState('snapshot-finished', 'Finished retains start CWD', finished('/repo/app', 'pnpm test --watch', 0, { currentCwd: '/repo/other' }), 'Freshly finished command keeps start CWD'),
  caseState('snapshot-osc633', 'OSC 633 explicit command', running('/repo/app', 'pnpm test --watch', { source: 'osc633_E' }), 'Command line from OSC 633;E'),
  caseState('snapshot-osc133-title', 'OSC 133 title fallback', running('/repo/app', null, { source: 'osc133_boundaries', title: terminalTitle('zsh', 'osc0') }), 'Boundaries without command line'),
]);

export const TitleFallbacksAndPinnedTitles: Story = storyFor([
  caseState('title-user', 'User-pinned title', running('/repo/app', 'npm run dev', { title: terminalTitle('Production API', 'user') }), 'Pinned title overrides command and CWD'),
  caseState('title-app-over-command', 'App title over command', running('/repo/app', 'npm run dev', { title: terminalTitle('dev server: ready', 'osc0') }), 'Fresh app title beats command'),
  caseState('title-stale-shell', 'Stale shell title', running('/repo/app', 'npm run dev', { title: terminalTitleAt('zsh', 'osc0', BASE_TIME - 1) }), 'Pre-command shell title does not beat command'),
  caseState('title-osc0', 'OSC 0 unknown command', running('/repo/app', null, { title: terminalTitle('zsh', 'osc0') }), 'Terminal title fallback for unknown active command'),
  caseState('title-osc2', 'OSC 2 unknown command', running('/repo/app', null, { title: terminalTitle('vim', 'osc2') }), 'Terminal title fallback for unknown active command'),
  caseState('title-idle-fallback', 'Idle fallback', idle({ activity: { kind: 'editing' } }), 'No foreground command'),
  caseState('title-long-user', 'Long user title', idle({ cwd: manual('/repo/app'), title: terminalTitle('my-extremely-long-running-background-process-with-a-very-descriptive-name', 'user') }), 'Truncates before controls'),
]);

export const TitleCandidatePopup: Story = {
  ...storyFor([
    caseState(
      'title-candidates-popup',
      'Title candidates popup',
      titleCandidateState(),
      'Right-click popup lists each latest title channel',
    ),
  ]),
  play: openTitleCandidatesPopup,
};

export const GroupingKeys: Story = storyFor([
  caseState('group-app-dev', 'App dev server', running('/repo/app', 'npm run dev'), 'Directory: app, command: npm run dev, status: running'),
  caseState('group-api-dev', 'API dev server', running('/repo/api', 'npm run dev'), 'Directory: api, command: npm run dev, status: running'),
  caseState('group-app-test', 'App test', running('/repo/app', 'pnpm test --watch'), 'Shares directory with app dev'),
  caseState('group-api-idle', 'API idle', idle({ cwd: manual('/repo/api'), activity: { kind: 'editing' } }), 'Idle directory grouping uses pane CWD'),
  caseState('group-docs-finished', 'Docs finished', finished('/repo/docs', 'cargo test', 0), 'Finished status group'),
  caseState('group-unknown', 'Unknown', idle({ activity: { kind: 'unknown' } }), 'Unknown status group'),
], { showGroups: true });

function ShellCwdMatrix({
  cases,
  showGroups = false,
}: {
  cases: ShellCwdCase[];
  showGroups?: boolean;
}) {
  const states = cases.map((item) => item.state);

  return (
    <div className="min-h-screen bg-app-bg p-4 font-mono text-app-fg">
      <div className="grid gap-2">
        {cases.map((item) => {
          const header = deriveHeader(item.state, states);
          return (
            <section
              key={item.id}
              className="grid items-center gap-3 border-b border-border/60 pb-2"
              style={{ gridTemplateColumns: '220px 120px 1fr 320px' }}
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{item.label}</div>
                {item.note && <div className="truncate text-xs text-muted">{item.note}</div>}
              </div>
              <DerivedBadge state={item.state} header={header} />
              <div style={{ width: HEADER_WIDTH }}>
                <HeaderPreview id={item.id} title={item.fallbackTitle ?? UNNAMED_PANEL_TITLE} />
              </div>
              <div style={{ width: DOOR_WIDTH }}>
                <BaseboardPreview id={item.id} title={item.fallbackTitle ?? UNNAMED_PANEL_TITLE} />
              </div>
            </section>
          );
        })}
      </div>
      {showGroups && <GroupingPreview cases={cases} />}
    </div>
  );
}

function HeaderPreview({ id, title }: { id: string; title: string }) {
  return (
    <ModeContext.Provider value="command">
      <SelectedIdContext.Provider value={id}>
        <WallActionsContext.Provider value={noopActions}>
          <RenamingIdContext.Provider value={null}>
            <div className="h-[26px] bg-app-bg">
              <TerminalPaneHeader id={id} title={title} params={undefined} />
            </div>
          </RenamingIdContext.Provider>
        </WallActionsContext.Provider>
      </SelectedIdContext.Provider>
    </ModeContext.Provider>
  );
}

function BaseboardPreview({ id, title }: { id: string; title: string }) {
  return (
    <Baseboard
      items={[makeDoorItem(id, title)]}
      onReattach={() => {}}
    />
  );
}

function DerivedBadge({
  state,
  header,
}: {
  state: TerminalPaneState;
  header: ReturnType<typeof deriveHeader>;
}) {
  const exit = state.activity.kind === 'finished' ? state.activity.exitCode : undefined;
  const status = state.activity.kind;
  return (
    <div className="min-w-0 text-xs text-muted">
      <div className="truncate">{status}{exit !== undefined ? ` ${exit}` : ''}</div>
      <div className="truncate">{header.secondary ?? 'no secondary'}</div>
    </div>
  );
}

function GroupingPreview({ cases }: { cases: ShellCwdCase[] }) {
  const panes = cases.map((item) => item.state);
  return (
    <div className="mt-5 grid grid-cols-3 gap-3 text-sm">
      {(['directory', 'command', 'status'] as const).map((mode) => (
        <section key={mode} className="border border-border bg-surface-raised/40 p-3">
          <h3 className="mb-2 text-sm font-semibold capitalize">{mode}</h3>
          <div className="grid gap-1">
            {groupTerminalPanes(panes, mode).map((group) => (
              <div key={`${mode}-${group.key}`} className="min-w-0">
                <span className="font-semibold">{group.label}</span>
                <span className="text-muted">: {casesForGroup(cases, group.panes).join(', ')}</span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function casesForGroup(cases: ShellCwdCase[], panes: TerminalPaneState[]): string[] {
  return cases.filter((item) => panes.includes(item.state)).map((item) => item.label);
}

function storyFor(cases: ShellCwdCase[], extraArgs: { showGroups?: boolean } = {}): Story {
  return {
    args: {
      cases,
      ...extraArgs,
    },
    parameters: {
      primedTerminalState: {
        byId: Object.fromEntries(cases.map((item) => [item.id, item.state])),
      },
    },
  };
}

function caseState(id: string, label: string, state: TerminalPaneState, note?: string): ShellCwdCase {
  return { id, label, state, note };
}

function idle({
  cwd = null,
  activity = { kind: 'unknown' },
  title = null,
}: {
  cwd?: CwdState | null;
  activity?: ShellActivity;
  title?: TerminalTitle | null;
} = {}): TerminalPaneState {
  return createTerminalPaneState({ cwd, activity, title });
}

function running(
  startCwdPath: string | null,
  rawCommandLine: string | null,
  options: {
    currentCwd?: string;
    host?: string;
    source?: CommandRun['source'];
    title?: TerminalTitle | null;
  } = {},
): TerminalPaneState {
  const cwdAtStart = startCwdPath ? cwd(startCwdPath, options.host) : null;
  const currentCwd = options.currentCwd ? manual(options.currentCwd) : cwdAtStart;
  const displayCommand = rawCommandLine ?? options.title?.title ?? 'shell';
  return createTerminalPaneState({
    cwd: currentCwd,
    activity: { kind: 'running' },
    title: options.title ?? null,
    currentCommand: commandRun({
      id: `cmd-${displayCommand}-${startCwdPath ?? 'unknown'}`,
      rawCommandLine,
      displayCommand,
      cwdAtStart,
      source: options.source ?? (rawCommandLine ? 'osc633_E' : 'osc133_boundaries'),
    }),
  });
}

function finished(
  startCwdPath: string,
  rawCommandLine: string,
  exitCode?: number,
  options: { currentCwd?: string } = {},
): TerminalPaneState {
  const cwdAtStart = manual(startCwdPath);
  const currentCwd = options.currentCwd ? manual(options.currentCwd) : cwdAtStart;
  return createTerminalPaneState({
    cwd: currentCwd,
    activity: exitCode === undefined ? { kind: 'finished' } : { kind: 'finished', exitCode },
    lastCommand: commandRun({
      id: `cmd-finished-${rawCommandLine}-${startCwdPath}`,
      rawCommandLine,
      displayCommand: rawCommandLine,
      cwdAtStart,
      source: 'osc633_E',
      finishedAt: BASE_TIME + 5_000,
      exitCode,
    }),
  });
}

function commandRun({
  id,
  rawCommandLine,
  displayCommand,
  cwdAtStart,
  source,
  finishedAt,
  exitCode,
}: {
  id: string;
  rawCommandLine: string | null;
  displayCommand: string;
  cwdAtStart: CwdState | null;
  source: CommandRun['source'];
  finishedAt?: number;
  exitCode?: number;
}): CommandRun {
  return {
    id,
    rawCommandLine,
    displayCommand,
    cwdAtStart,
    startedAt: BASE_TIME,
    source,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(exitCode === undefined ? {} : { exitCode }),
  };
}

function terminalTitle(title: string, source: TerminalTitle['source']): TerminalTitle {
  return terminalTitleAt(title, source, BASE_TIME);
}

function terminalTitleAt(title: string, source: TerminalTitle['source'], updatedAt: number): TerminalTitle {
  return { title, source, updatedAt };
}

function titleCandidateState(): TerminalPaneState {
  const pane = running('/repo/app', 'npm run dev');
  const candidates = {
    user: terminalTitleAt('Pinned production API', 'user', BASE_TIME + 6_000),
    osc0: terminalTitleAt('dormouse', 'osc0', BASE_TIME + 1_000),
    osc2: terminalTitleAt('zsh', 'osc2', BASE_TIME + 2_000),
    osc9: terminalTitleAt('Build finished', 'osc9', BASE_TIME + 5_000),
    osc99: terminalTitleAt('Codex waiting', 'osc99', BASE_TIME + 4_000),
    osc777: terminalTitleAt('Tests complete', 'osc777', BASE_TIME + 3_000),
  } satisfies TerminalPaneState['titleCandidates'];
  return createTerminalPaneState({
    ...pane,
    title: candidates.user,
    titleCandidates: candidates,
  });
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openTitleCandidatesPopup() {
  await wait(100);
  const title = document.querySelector<HTMLElement>('[data-title-candidates-for="title-candidates-popup"]');
  if (!title) return;

  const rect = title.getBoundingClientRect();
  title.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    button: 2,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }));
  await wait(100);
}

function makeDoorItem(id: string, title: string): DooredItem {
  return {
    id,
    title,
  };
}

function cwd(path: string, host?: string): CwdState {
  return {
    path,
    host,
    scheme: 'file',
    pathKind: path.includes(':') ? 'windows' : 'posix',
    isRemote: !!host && host !== 'localhost',
    source: 'manual',
    updatedAt: BASE_TIME,
  };
}

function manual(path: string): CwdState {
  return cwdFromManualPath(path, BASE_TIME)!;
}

function processCwd(path: string): CwdState {
  return cwdFromProcessPath(path, BASE_TIME)!;
}

function osc7(uri: string): CwdState {
  return cwdFromOsc7(uri, BASE_TIME)!;
}

function osc99(path: string): CwdState {
  return cwdFromOsc9_9(path, BASE_TIME)!;
}

function osc633(path: string): CwdState {
  return cwdFromOsc633(path, BASE_TIME)!;
}

function osc1337(path: string): CwdState {
  return cwdFromOsc1337(path, BASE_TIME)!;
}
