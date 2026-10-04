/**
 * @vitest-environment jsdom
 *
 * A Tool is designated for one run of its command (`docs/specs/dor-tool.md` ->
 * Run end), through a mounted Wall: an ended run leaves a plain terminal in
 * place, and a host hold keeps the Tool through its own replacements.
 */
import { act } from 'react';
import { type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { Wall } from '../Wall';
import { setPlatform } from '../../lib/platform';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import type { PersistedSession } from '../../lib/session-types';
import * as terminalRegistry from '../../lib/terminal-registry';
import { _resetRunHoldsForTesting, holdForHostInterrupt, releaseRunHold } from '../../lib/tool-run-hold';
import { mountWallHarness, reportRunning, type WallHarness } from './wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../TerminalPane', () => ({
  TerminalPane: ({ id }: { id: string }) => <div data-testid="terminal-pane" data-session-id={id} />,
}));

const ID = 'tool';
const COMMAND = 'view /repo/a.md';
const PARAMS = {
  surfaceType: 'tool', command: COMMAND, toolArgv: ['view', '/repo/a.md'], cwd: '/repo', toolName: 'viewer',
  toolScope: 'user', toolRender: 'iframe', toolPort: 'announced', toolKey: ['viewer', '/repo/a.md'], toolTarget: '/repo/a.md',
};

let harness: WallHarness;
let root: Root;
let fake: FakePtyAdapter;

beforeEach(() => {
  fake = new FakePtyAdapter();
  setPlatform(fake);
  harness = mountWallHarness();
  ({ root } = harness);
});

afterEach(() => {
  harness.dispose();
  terminalRegistry.removeTerminalPaneState(ID);
  _resetRunHoldsForTesting();
  vi.restoreAllMocks();
});

async function mountTool(params: Record<string, unknown> = PARAMS, title = 'viewer'): Promise<void> {
  await act(async () => root.render(<Wall
    initialMode="passthrough"
    restoredLathLayout={{
      version: 1,
      tree: { root: { kind: 'leaf', id: ID } },
      leafMeta: { [ID]: { component: 'tool', tabComponent: 'tool', title, params } },
    }}
  />));
  await harness.flush();
  fake.spawnPty(ID);
}

const events = async (list: Parameters<typeof terminalRegistry.applyTerminalSemanticEvents>[1]) => {
  await act(async () => terminalRegistry.applyTerminalSemanticEvents(ID, list));
  await harness.flush();
};
const finish = () => events([{ type: 'commandFinish', exitCode: 130 }, { type: 'promptStart' }]);
const run = async (line: string) => { await act(async () => reportRunning(ID, line)); await harness.flush(); };

async function leaf(): Promise<{ component: string; title: string; params?: Record<string, unknown> }> {
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  await harness.flush();
  return (fake.getState() as PersistedSession & { lathLayout: { leafMeta: Record<string, never> } }).lathLayout.leafMeta[ID];
}

describe('Run end', () => {
  it('turns a Tool whose designated run ended into a plain terminal in place', async () => {
    await mountTool();
    await run(COMMAND);
    expect((await leaf()).component).toBe('tool');
    await finish();
    const after = await leaf();
    expect(after).toMatchObject({ component: 'terminal', title: '<unnamed>' });
    expect(after.params).toBeUndefined();
    // The same Session carries on.
    expect(terminalRegistry.getTerminalPaneState(ID).lastCommand?.rawCommandLine).toBe(COMMAND);
  });

  it('keeps a user rename through the end, and drops a preview mark with the Tool', async () => {
    await mountTool({ ...PARAMS, toolPreview: true }, 'notes');
    act(() => { terminalRegistry.setTerminalUserTitle(ID, 'notes'); });
    await run(COMMAND);
    await finish();
    expect(await leaf()).toMatchObject({ component: 'terminal', title: 'notes' });
  });

  it('ends nothing before the first designated run: a takeover still at the dor line', async () => {
    await mountTool();
    await run('dor open a.md');
    await finish();
    expect((await leaf()).component).toBe('tool');
  });

  it('ends a run that starts and finishes in one chunk, a failed boot', async () => {
    await mountTool();
    await events([
      { type: 'commandLine', commandLine: COMMAND },
      { type: 'commandStart', source: 'osc633_boundaries' },
      { type: 'commandFinish', exitCode: 127 },
      { type: 'promptStart' },
    ]);
    expect((await leaf()).component).toBe('terminal');
  });

  it('keeps the Tool through a host replacement, then ends the successor run like any other', async () => {
    await mountTool();
    await run(COMMAND);
    holdForHostInterrupt(ID);
    await finish();
    expect((await leaf()).component).toBe('tool');
    await run(COMMAND);
    expect((await leaf()).component).toBe('tool');
    await finish();
    expect((await leaf()).component).toBe('terminal');
  });

  it('silences the interrupted run as it holds it', async () => {
    await mountTool();
    await run(COMMAND);
    const silenced = vi.spyOn(fake, 'alertSilenceRun');
    holdForHostInterrupt(ID);
    expect(silenced).toHaveBeenCalledWith(ID);
  });

  it('refuses its own pane a keyed invocation mid-replacement, ending only if the host then gives up', async () => {
    const storybook = { surfaceType: 'tool', command: 'pnpm storybook', cwd: '/repo', toolName: 'storybook', toolKey: ['storybook', '/repo'], toolRender: 'iframe', toolPort: 'announced' };
    Object.assign(fake, { toolControl: vi.fn(async () => ({
      status: 'ok', projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'storybook', run: 'pnpm storybook', render: 'iframe', port: 'announced', key: ['/repo'], warnings: [],
    })) });
    await mountTool(storybook);
    act(() => terminalRegistry.seedTerminalManualCwd(ID, '/repo'));
    await run('pnpm storybook');
    holdForHostInterrupt(ID);
    await finish();
    // Typed into the pane before the host's retype: `dor` is what its shell runs.
    await run('dor tool storybook');
    const respond = vi.fn();
    await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
      method: SURFACE_CONTROL_METHODS.tool, surfaceId: ID, params: { name: 'storybook', cwd: '/repo' }, signal: new AbortController().signal, respond,
    } })));
    await vi.waitFor(() => expect(respond).toHaveBeenCalled());
    expect(respond.mock.calls[0][0]).toMatchObject({ ok: false, error: expect.stringContaining("is this tool's own pane") });
    expect((await leaf()).component).toBe('tool');
    // The host's retype, queued behind `dor`, would run next: still a Tool.
    await finish();
    expect((await leaf()).component).toBe('tool');
    // No successor came: the host gives up, and the run has ended.
    await act(async () => releaseRunHold(ID));
    await harness.flush();
    expect((await leaf()).component).toBe('terminal');
  });

  it('ends the Tool at a command the user typed behind a replacement the host then gave up on', async () => {
    await mountTool();
    await run(COMMAND);
    holdForHostInterrupt(ID);
    await finish();
    // Typed into the pane, so the host skips its retype (docs/specs/dor-tool.md -> Preview slot).
    await run('ls');
    await act(async () => releaseRunHold(ID));
    await harness.flush();
    expect((await leaf()).component).toBe('tool');
    await finish();
    expect((await leaf()).component).toBe('terminal');
  });

  it('ends the run once the host gives up on a successor', async () => {
    await mountTool();
    await run(COMMAND);
    holdForHostInterrupt(ID);
    await finish();
    expect((await leaf()).component).toBe('tool');
    await act(async () => releaseRunHold(ID));
    await harness.flush();
    expect((await leaf()).component).toBe('terminal');
  });
});
