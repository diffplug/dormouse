/**
 * @vitest-environment jsdom
 *
 * The Workspace preview slot through a mounted Wall (`docs/specs/dor-tool.md`
 * -> Preview slot): `dor open --preview` creates, retargets, and supersedes the
 * slot; `dor open`, unsaved state, and a header double-click pin it.
 */
import { act } from 'react';
import { type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { Wall } from '../Wall';
import * as browserController from './agent-browser-surface-controller';
import { setPlatform } from '../../lib/platform';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import type { PersistedSession } from '../../lib/session-types';
import * as terminalRegistry from '../../lib/terminal-registry';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
import { pendingShellOpts } from '../../lib/terminal-store';
import { doubleClick, mountWallHarness, reportRunning, waitUntil, type WallHarness } from './wall-test-utils';
import { clearExternalLinkConfirmation, getExternalLinkConfirmationSnapshot } from '../../lib/external-link-confirmation';
import { activateTerminalLink } from '../../lib/terminal-link-activation';
import { applyLiveToolEvents } from '../../lib/tool-events';
import { parseReplay } from '../../lib/platform/replay-parse';
import type { LathNode } from '../../lib/lath/model';
import { recordToolAnnounce, resetToolAnnounces } from '../../lib/tool-announce-store';
import { PREVIEW_READY_FALLBACK_MS, resetPreviewTransitions } from '../../lib/preview-transition-store';
import { PREVIEW_INTERRUPT_GRACE_MS, PREVIEW_OUTPUT_QUIET_MS, PROMPT_RETURN_TIMEOUT_MS } from './use-dor-control';
import { setDevServerResolution } from './agent-browser-ports';
import * as helpers from '../../lib/helper-terminal';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../TerminalPane', () => ({
  TerminalPane: ({ id, isFocused }: { id: string; isFocused?: boolean }) => (
    <div data-testid="terminal-pane" data-session-id={id} data-focused={isFocused ? 'true' : 'false'} />
  ),
}));

let harness: WallHarness;
let container: HTMLDivElement;
let root: Root;
let fake: FakePtyAdapter;
/** Every Session a test touched, released afterwards. */
const sessions = new Set<string>();
/** Cancels every request a test left waiting on the shared launch queue. */
let requests: AbortController;
/** Input each Session received, in order. */
let typed: Record<string, string[]>;

beforeEach(() => {
  fake = new FakePtyAdapter();
  setPlatform(fake);
  harness = mountWallHarness();
  ({ container, root } = harness);
  requests = new AbortController();
  typed = {};
  vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(true);
});

afterEach(async () => {
  await act(async () => { requests.abort(); await new Promise(resolve => setTimeout(resolve, 125)); });
  harness.dispose();
  clearExternalLinkConfirmation();
  for (const id of sessions) {
    fake.clearInputHandler(id);
    pendingShellOpts.delete(id);
    terminalRegistry.removeTerminalPaneState(id);
  }
  sessions.clear();
  resetToolDirty();
  resetToolAnnounces();
  resetPreviewTransitions();
  vi.restoreAllMocks();
});

const flush = (): Promise<void> => harness.flush();

const returnToPrompt = (id: string): void => terminalRegistry.applyTerminalSemanticEvents(id, [
  { type: 'commandFinish', exitCode: 130 }, { type: 'promptStart' },
]);

type ShellOptions = { holdInterrupt?: boolean; holdStart?: boolean };

/** An integrated shell in `/repo`: Ctrl+C returns it to its prompt unless
 *  `holdInterrupt`, and a typed line starts running unless `holdStart`. */
function shell(id: string, line: string | null, options: ShellOptions = {}): void {
  sessions.add(id);
  typed[id] = [];
  fake.spawnPty(id);
  terminalRegistry.seedTerminalManualCwd(id, '/repo');
  if (line) reportRunning(id, line);
  fake.setInputHandler(id, data => {
    typed[id].push(data);
    if (data === '\x03') {
      if (!options.holdInterrupt && terminalRegistry.getTerminalPaneState(id).currentCommand) returnToPrompt(id);
    } else if (data.endsWith('\r') && !options.holdStart) {
      reportRunning(id, data.slice(0, -1));
    }
  });
}

/** The user host's answer for `dor open [--tool other] <file>`; `other`
 *  declares no key. */
function openLookup(file: string, tool = 'viewer') {
  const target = `/repo/${file}`;
  return {
    status: 'ok' as const, scope: 'user' as const, projectRoot: '/repo', path: '/config/dormouse.yml', name: tool,
    run: [tool === 'viewer' ? 'view' : tool, target], key: tool === 'viewer' ? [target] : null, render: 'iframe' as const,
    port: 'announced' as const, warnings: [], target,
  };
}

function installHost() {
  const toolControl = vi.fn(async (request: { op: string; target?: string; tool?: string; name?: string; args?: string[] }) =>
    request.op === 'open'
      ? openLookup(request.target!, request.tool)
      // A named lookup of the same Tool: its key, but no target.
      : { ...openLookup(request.args![0]), target: undefined });
  Object.assign(fake, { toolControl });
  return toolControl;
}

/** Tool params as an `open` of `file` leaves them, marked unless `pinned`. */
function viewerParams(file: string, extra: Record<string, unknown> = {}) {
  const target = `/repo/${file}`;
  return {
    surfaceType: 'tool', command: `view ${target}`, toolArgv: ['view', target], cwd: '/repo', toolName: 'viewer',
    toolScope: 'user', toolRender: 'iframe', toolPort: 'announced', toolKey: ['viewer', target], toolTarget: target,
    toolPreview: true, ...extra,
  };
}

type Leaf = { id: string; params?: Record<string, unknown>; title?: string };

/** A Wall of a plain terminal `pane-a` beside the given Tool leaves. */
async function mountWall(leaves: Leaf[], options: { doors?: Leaf[]; mode?: 'command' | 'passthrough' } = {}) {
  const ids = ['pane-a', ...leaves.map(leaf => leaf.id)];
  await act(async () => root.render(<Wall
    initialMode={options.mode ?? 'passthrough'}
    restoredLathLayout={{
      version: 1,
      tree: { root: ids.length === 1 ? { kind: 'leaf', id: 'pane-a' }
        : { kind: 'split', dir: 'row', children: ids.map(id => ({ node: { kind: 'leaf', id }, weight: 1 / ids.length })) } },
      leafMeta: Object.fromEntries([
        ['pane-a', { component: 'terminal', tabComponent: 'terminal', title: 'shell' }],
        ...leaves.map(leaf => [leaf.id, { component: 'tool', tabComponent: 'tool', title: leaf.title ?? 'viewer', params: leaf.params }]),
      ]),
    }}
    initialDoors={(options.doors ?? []).map(door => ({ id: door.id, title: 'viewer', component: 'tool', tabComponent: 'tool', params: door.params }))}
  />));
  await flush();
}

/** The common prelude: the host installed, and `pane-a` running `caller`
 *  beside a marked `slot` running a.md's viewer — a pane unless `minimized`. */
async function mountSlot(options: { caller?: string; slot?: ShellOptions; title?: string; minimized?: boolean; mode?: 'command' | 'passthrough' } = {}) {
  const toolControl = installHost();
  const slot = { id: 'slot', params: viewerParams('a.md'), title: options.title };
  await mountWall(options.minimized ? [] : [slot], { doors: options.minimized ? [slot] : [], mode: options.mode });
  shell('pane-a', options.caller ?? null);
  shell('slot', 'view /repo/a.md', options.slot);
  return toolControl;
}

type ToolResult = { status: string; surfaceId: string; surfaceRef: string; command: string; minimized: boolean };

/** Dispatch one control request from `caller`; its `respond` mock. */
function dispatch(method: string, params: Record<string, unknown>, caller = 'pane-a') {
  const respond = vi.fn();
  window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
    method, surfaceId: caller, params, signal: requests.signal, respond,
  } }));
  return respond;
}

const dispatchTool = (params: Record<string, unknown>, caller = 'pane-a') =>
  dispatch(SURFACE_CONTROL_METHODS.tool, { cwd: '/repo', ...params }, caller);

/** Dispatch one `surface.tool` request; its `respond` mock. */
async function request(params: Record<string, unknown>, caller = 'pane-a') {
  let respond!: ReturnType<typeof vi.fn>;
  await act(async () => { respond = dispatchTool(params, caller); });
  return respond;
}

async function answer(respond: ReturnType<typeof vi.fn>): Promise<ToolResult> {
  await waitUntil(() => respond.mock.calls.length > 0);
  const response = respond.mock.calls[0][0];
  expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
  return response.result as ToolResult;
}

/** A visible leaf's stored title, read through a save. */
async function titleOf(id: string): Promise<string | undefined> {
  return ((await saved()).lathLayout.leafMeta[id] as { title?: string } | undefined)?.title;
}

/** The params the store holds for a leaf or Door, read through a save. */
async function saved(): Promise<PersistedSession & { lathLayout: { tree: { root: LathNode }; leafMeta: Record<string, { params?: Record<string, unknown> }> } }> {
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  await flush();
  return fake.getState() as never;
}

async function paramsOf(id: string): Promise<Record<string, unknown> | undefined> {
  const state = await saved();
  return state.lathLayout.leafMeta[id]?.params ?? state.doors?.find(door => door.id === id)?.params;
}

/** Visible leaves in tree order. */
async function leafOrder(): Promise<string[]> {
  const ids: string[] = [];
  const walk = (node: LathNode) => { if (node.kind === 'leaf') ids.push(node.id); else node.children.forEach(child => walk(child.node)); };
  walk((await saved()).lathLayout.tree.root);
  return ids;
}

async function listRow(id: string) {
  let respond!: ReturnType<typeof vi.fn>;
  await act(async () => { respond = dispatch(SURFACE_CONTROL_METHODS.list, {}); });
  return (respond.mock.calls[0][0].result.surfaces as Array<{ id: string; ref: string; focused: boolean; preview?: boolean }>).find(row => row.id === id);
}

/** Double-click the empty area of the slot's Pane header, as a user keeps it. */
const keepByHeader = () => doubleClick(container.querySelector('[data-lath-leaf="slot"] .lath-leaf-header .cursor-grab')!);

const focusOf = (id: string) => container.querySelector(`[data-session-id="${id}"]`)?.getAttribute('data-focused') ?? null;
const leafCount = () => container.querySelectorAll('[data-lath-leaf]').length;
/** The one visible leaf a test created, beside `pane-a` and `slot`. */
const newLeaf = () => Array.from(container.querySelectorAll('[data-lath-leaf]'), leaf => leaf.getAttribute('data-lath-leaf')!)
  .find(id => id !== 'pane-a' && id !== 'slot')!;

/** A created Tool's shell in `/repo` reports `command` running; released afterwards. */
function startTool(id: string, command: string): void {
  sessions.add(id);
  act(() => { terminalRegistry.seedTerminalManualCwd(id, '/repo'); reportRunning(id, command); });
}

describe('dor open --preview', () => {
  it('creates a missing slot as a focus-neutral split, never taking over a caller that would qualify', async () => {
    installHost();
    await mountWall([]);
    shell('pane-a', 'dor open --preview a.md');
    const result = await answer(await request({ file: 'a.md', preview: true }));
    expect(result.status).toBe('created');
    expect(result.surfaceId).not.toBe('pane-a');
    expect(leafCount()).toBe(2);
    expect(focusOf('pane-a')).toBe('true');
    startTool(result.surfaceId, result.command);
    expect(await listRow(result.surfaceId)).toMatchObject({ preview: true });
    expect(await listRow('pane-a')).not.toHaveProperty('preview');
    const state = await saved();
    expect(state.lathLayout.leafMeta[result.surfaceId].params).toMatchObject({ toolPreview: true, toolTarget: '/repo/a.md' });
    expect(state.panes.find(pane => pane.id === result.surfaceId)?.tool).toMatchObject({ preview: true, target: '/repo/a.md' });
  });

  it('retargets the slot in place, keeping its Session, ref, and a default title up to date', async () => {
    await mountSlot();
    const ref = (await listRow('slot'))!.ref;
    // Asked from another directory, the slot's shell still runs it where it is.
    const result = await answer(await request({ file: 'b.md', preview: true, cwd: '/repo/docs' }));
    expect(result).toMatchObject({ status: 'retargeted', surfaceId: 'slot', surfaceRef: ref, command: 'view /repo/b.md', cwd: '/repo', minimized: false });
    expect(typed.slot).toEqual(['\x03', 'view /repo/b.md\r']);
    expect(typed['pane-a']).toEqual([]);
    expect(leafCount()).toBe(2);
    expect(focusOf('pane-a')).toBe('true');
    await waitUntil(() => terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine === 'view /repo/b.md');
    expect(await paramsOf('slot')).toMatchObject({
      command: 'view /repo/b.md', toolArgv: ['view', '/repo/b.md'], toolKey: ['viewer', '/repo/b.md'],
      toolTarget: '/repo/b.md', toolPreview: true, cwd: '/repo',
    });
    expect((await listRow('slot'))?.ref).toBe(ref);
  });

  it('reattaches a minimized slot without focus when it is retargeted', async () => {
    await mountSlot({ minimized: true });
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'retargeted', surfaceId: 'slot', minimized: false });
    expect(container.querySelector('[data-door-id="slot"]')).toBeNull();
    expect(container.querySelector('[data-lath-leaf="slot"]')).not.toBeNull();
    expect(focusOf('pane-a')).toBe('true');
  });

  it('reports a superseded preview against the slot as it stands, still minimized', async () => {
    await mountSlot({ minimized: true, slot: { holdInterrupt: true } });
    const first = await request({ file: 'b.md', preview: true });
    await waitUntil(() => typed.slot.length === 1);
    const second = await request({ file: 'c.md', preview: true });
    expect(await answer(first)).toMatchObject({ status: 'superseded', surfaceId: 'slot', minimized: true, command: 'view /repo/a.md' });
    await waitUntil(() => typed.slot.length === 2);
    act(() => returnToPrompt('slot'));
    expect(await answer(second)).toMatchObject({ status: 'retargeted', minimized: false });
  });

  it('carries a selection on the minimized slot onto its pane', async () => {
    await mountSlot({ minimized: true, mode: 'command' });
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    expect(await listRow('pane-a')).toMatchObject({ focused: false });
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'retargeted', minimized: false });
    expect(await listRow('slot')).toMatchObject({ focused: true });
  });

  it('never leaves a new slot minimized beside a minimized caller', async () => {
    installHost();
    await mountWall([], { doors: [{ id: 'viewer', params: viewerParams('a.md', { toolPreview: undefined }) }] });
    shell('pane-a', null);
    shell('viewer', 'view /repo/a.md');
    const result = await answer(await request({ file: 'b.md', preview: true }, 'viewer'));
    expect(result).toMatchObject({ status: 'created', minimized: false });
    expect(container.querySelector(`[data-door-id="${result.surfaceId}"]`)).toBeNull();
    expect(container.querySelector(`[data-lath-leaf="${result.surfaceId}"]`)).not.toBeNull();
    expect(container.querySelector('[data-door-id="viewer"]')).not.toBeNull();
    expect(focusOf('pane-a')).toBe('true');
    startTool(result.surfaceId, result.command);
  });

  it.each([{ fresh: true }, { minimized: true }, {}])('refuses a preview that is not one file in the slot: %j', async (extra) => {
    const toolControl = installHost();
    await mountWall([]);
    const params = Object.keys(extra).length ? { file: 'a.md', preview: true, ...extra } : { name: 'viewer', args: ['a.md'], preview: true };
    expect((await request(params)).mock.calls[0][0]).toEqual({ ok: false, error: 'preview takes one file, without fresh or minimized' });
    expect(toolControl).not.toHaveBeenCalled();
  });

  it('leaves the slot running when it already shows the file', async () => {
    await mountSlot();
    expect(await answer(await request({ file: 'a.md', preview: true }))).toMatchObject({ status: 'existing', surfaceId: 'slot' });
    expect(typed.slot).toEqual([]);
  });

  it('re-runs the slot in place when it shows the file but its command exited', async () => {
    await mountSlot();
    act(() => returnToPrompt('slot'));
    expect(await answer(await request({ file: 'a.md', preview: true }))).toMatchObject({ status: 'adopted', surfaceId: 'slot', command: 'view /repo/a.md', minimized: false });
    expect(typed.slot).toEqual(['\x03', 'view /repo/a.md\r']);
    expect(focusOf('pane-a')).toBe('true');
    expect(await paramsOf('slot')).toMatchObject({ toolTarget: '/repo/a.md', toolPreview: true });
  });

  it('re-runs the slot for its own file when that preview supersedes one still interrupting it', async () => {
    await mountSlot({ slot: { holdInterrupt: true } });
    const first = await request({ file: 'b.md', preview: true });
    await waitUntil(() => typed.slot.length === 1);
    // The shell still reports a.md's viewer running: the interrupt has not landed.
    const second = await request({ file: 'a.md', preview: true });
    expect(await answer(first)).toMatchObject({ status: 'superseded', surfaceId: 'slot' });
    await waitUntil(() => typed.slot.length === 2);
    act(() => returnToPrompt('slot'));
    expect(await answer(second)).toMatchObject({ status: 'adopted', surfaceId: 'slot', command: 'view /repo/a.md' });
    expect(typed.slot).toEqual(['\x03', '\x03', 'view /repo/a.md\r']);
  });

  it('reveals a pinned keyed match without focus instead of retargeting the slot', async () => {
    installHost();
    await mountWall([{ id: 'slot', params: viewerParams('a.md') }], { doors: [{ id: 'kept', params: viewerParams('b.md', { toolPreview: undefined }) }] });
    shell('pane-a', null);
    shell('slot', 'view /repo/a.md');
    shell('kept', 'view /repo/b.md');
    expect(container.querySelector('[data-door-id="kept"]')).not.toBeNull();
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'existing', surfaceId: 'kept', minimized: false });
    expect(container.querySelector('[data-door-id="kept"]')).toBeNull();
    expect(container.querySelector('[data-lath-leaf="kept"]')).not.toBeNull();
    expect(focusOf('pane-a')).toBe('true');
    expect(typed.slot).toEqual([]);
    expect(typed.kept).toEqual([]);
    expect(await paramsOf('slot')).toMatchObject({ toolTarget: '/repo/a.md', toolPreview: true });
  });

  it.each([
    ['answers from a pinned Tool', 'b.md'],
    ['fails its lookup', 'missing.md'],
  ])('runs the slot\'s own command again when the preview superseding its retarget %s', async (_, file) => {
    const toolControl = installHost();
    const answerLookup = toolControl.getMockImplementation()!;
    toolControl.mockImplementation(async call => call.target === 'missing.md' ? { status: 'error', message: 'no rule matches' } as never : answerLookup(call));
    await mountWall([{ id: 'slot', params: viewerParams('a.md') }], { doors: [{ id: 'kept', params: viewerParams('b.md', { toolPreview: undefined }) }] });
    shell('pane-a', null);
    shell('slot', 'view /repo/a.md', { holdInterrupt: true });
    shell('kept', 'view /repo/b.md');
    const first = await request({ file: 'c.md', preview: true });
    await waitUntil(() => typed.slot.length === 1);
    const second = await request({ file, preview: true });
    expect(await answer(first)).toMatchObject({ status: 'superseded', surfaceId: 'slot' });
    await waitUntil(() => second.mock.calls.length > 0);
    expect(second.mock.calls[0][0]).toMatchObject(file === 'b.md'
      ? { ok: true, result: { status: 'existing', surfaceId: 'kept' } } : { ok: false, error: 'no rule matches' });
    expect(typed.slot).toEqual(['\x03']);
    // The viewer exits on its interrupt; nothing replaced it, so it runs again.
    act(() => returnToPrompt('slot'));
    await waitUntil(() => typed.slot.length === 2);
    expect(typed.slot).toEqual(['\x03', 'view /repo/a.md\r']);
    expect(await paramsOf('slot')).toMatchObject({ toolTarget: '/repo/a.md', toolPreview: true });
  });

  it('lets the latest preview win: a queued one and one interrupting the slot report superseded', async () => {
    const toolControl = await mountSlot({ slot: { holdInterrupt: true } });
    const first = await request({ file: 'b.md', preview: true });
    await waitUntil(() => typed.slot.length === 1);
    // The second is still queued behind the first when the third arrives.
    let second!: ReturnType<typeof vi.fn>;
    let third!: ReturnType<typeof vi.fn>;
    await act(async () => {
      second = dispatchTool({ file: 'c.md', preview: true });
      third = dispatchTool({ file: 'd.md', preview: true });
    });
    for (const superseded of [first, second]) {
      expect(await answer(superseded)).toMatchObject({ status: 'superseded', surfaceId: 'slot', command: 'view /repo/a.md' });
    }
    await waitUntil(() => typed.slot.length === 2);
    act(() => returnToPrompt('slot'));
    expect(await answer(third)).toMatchObject({ status: 'retargeted', surfaceId: 'slot', command: 'view /repo/d.md' });
    expect(typed.slot).toEqual(['\x03', '\x03', 'view /repo/d.md\r']);
    // The queued one never reached its lookup.
    expect(toolControl.mock.calls.map(([call]) => call.target)).toEqual(['b.md', 'd.md']);
    await waitUntil(() => terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine === 'view /repo/d.md');
    expect(await paramsOf('slot')).toMatchObject({ toolTarget: '/repo/d.md', toolPreview: true });
  });

  it('creates no slot for a preview superseded during its lookup', async () => {
    const toolControl = installHost();
    const lookup = Promise.withResolvers<void>();
    const answerLookup = toolControl.getMockImplementation()!;
    toolControl.mockImplementationOnce(async (call) => { await lookup.promise; return answerLookup(call); });
    await mountWall([]);
    shell('pane-a', 'claude');
    const first = await request({ file: 'a.md', preview: true });
    const second = await request({ file: 'b.md', preview: true });
    await act(async () => lookup.resolve());
    await waitUntil(() => first.mock.calls.length > 0);
    expect(first).toHaveBeenCalledWith({ ok: false, error: 'superseded by a newer preview' });
    await waitUntil(() => leafCount() === 2);
    const created = newLeaf();
    startTool(created, 'view /repo/b.md');
    expect(await answer(second)).toMatchObject({ status: 'created', surfaceId: created, command: 'view /repo/b.md' });
  });

  it('holds a typed retarget until its command reports, whatever preview arrives next', async () => {
    await mountSlot({ slot: { holdStart: true } });
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'retargeted', command: 'view /repo/b.md' });
    const next = await request({ file: 'c.md', preview: true });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)); });
    expect(typed.slot).toEqual(['\x03', 'view /repo/b.md\r']);
    act(() => reportRunning('slot', 'view /repo/b.md'));
    await waitUntil(() => typed.slot.length === 4);
    act(() => reportRunning('slot', 'view /repo/c.md'));
    expect(await answer(next)).toMatchObject({ status: 'retargeted', command: 'view /repo/c.md' });
    expect(typed.slot).toEqual(['\x03', 'view /repo/b.md\r', '\x03', 'view /repo/c.md\r']);
  });

  it('never aborts a slot creation: the newer preview retargets the new slot', async () => {
    installHost();
    let integrated = false;
    vi.mocked(terminalRegistry.isPaneOscDriven).mockImplementation(id => id === 'pane-a' || integrated);
    await mountWall([]);
    shell('pane-a', 'claude');
    const first = await request({ file: 'a.md', preview: true });
    await waitUntil(() => leafCount() === 2);
    const created = newLeaf();
    const second = await request({ file: 'b.md', preview: true });
    act(() => shell(created, null));
    integrated = true;
    expect(await answer(first)).toMatchObject({ status: 'created', surfaceId: created });
    act(() => reportRunning(created, 'view /repo/a.md'));
    expect(await answer(second)).toMatchObject({ status: 'retargeted', surfaceId: created, command: 'view /repo/b.md' });
    expect(typed[created]).toEqual(['\x03', 'view /repo/b.md\r']);
    expect(leafCount()).toBe(2);
  });

  it('pins a slot on its unsaved-changes report at once, and splits the next slot from it', async () => {
    await mountSlot();
    act(() => recordToolDirty('slot', false));
    act(() => recordToolDirty('slot', null));
    expect(await paramsOf('slot')).toMatchObject({ toolPreview: true });
    act(() => recordToolDirty('slot', true));
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    const result = await answer(await request({ file: 'b.md', preview: true }));
    expect(result.status).toBe('created');
    expect(typed.slot).toEqual([]);
    expect(await leafOrder()).toEqual(['pane-a', 'slot', result.surfaceId]);
    startTool(result.surfaceId, result.command);
  });

  it.each([
    ['its header', keepByHeader],
    ['unsaved changes', () => act(() => recordToolDirty('slot', true))],
  ])('restores a slot kept by %s while a preview interrupts it, and previews in a new slot', async (_, keep) => {
    await mountSlot({ slot: { holdInterrupt: true } });
    const respond = await request({ file: 'b.md', preview: true });
    await waitUntil(() => typed.slot.length === 1);
    keep();
    act(() => returnToPrompt('slot'));
    const result = await answer(respond);
    expect(result).toMatchObject({ status: 'created', command: 'view /repo/b.md' });
    expect(result.surfaceId).not.toBe('slot');
    expect(typed.slot).toEqual(['\x03', 'view /repo/a.md\r']);
    expect(terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine).toBe('view /repo/a.md');
    const kept = await paramsOf('slot');
    expect(kept).toMatchObject({ toolTarget: '/repo/a.md' });
    expect(kept).not.toHaveProperty('toolPreview');
    expect(await leafOrder()).toEqual(['pane-a', 'slot', result.surfaceId]);
    startTool(result.surfaceId, result.command);
  });

  it('restores a slot kept while a preview interrupts it, even once that preview is cancelled', async () => {
    await mountSlot({ slot: { holdInterrupt: true } });
    const respond = await request({ file: 'b.md', preview: true });
    await waitUntil(() => typed.slot.length === 1);
    keepByHeader();
    act(() => requests.abort());
    act(() => returnToPrompt('slot'));
    await waitUntil(() => respond.mock.calls.length > 0);
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'tool launch cancelled' });
    expect(typed.slot).toEqual(['\x03', 'view /repo/a.md\r']);
    expect(terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine).toBe('view /repo/a.md');
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    expect(leafCount()).toBe(2);
  });

  it('keeps a slot whose command outlives its interrupt\'s grace, previewing beside it without holding the queue', async () => {
    await mountSlot({ slot: { holdInterrupt: true } });
    // Only the host's state polls run on the test's clock.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const respond = await request({ file: 'b.md', preview: true });
      await waitUntil(() => typed.slot.length === 1);
      await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_INTERRUPT_GRACE_MS - 100); });
      expect(respond).not.toHaveBeenCalled();
      expect(leafCount()).toBe(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      const result = await answer(respond);
      expect(result).toMatchObject({ status: 'created', command: 'view /repo/b.md' });
      expect(result.surfaceId).not.toBe('slot');
      // Kept as it stands: its command still runs, and was never typed again.
      expect(typed.slot).toEqual(['\x03']);
      expect(terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine).toBe('view /repo/a.md');
      expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
      expect(await paramsOf(result.surfaceId)).toMatchObject({ toolPreview: true, toolTarget: '/repo/b.md' });
      expect(await leafOrder()).toEqual(['pane-a', 'slot', result.surfaceId]);
      // The launch queue is free once the new slot's command reports.
      startTool(result.surfaceId, result.command);
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'existing', surfaceId: result.surfaceId });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves one marked slot when a preview arrives during the slot\'s close and the close is refused', async () => {
    await mountSlot();
    // Running helper work refuses the close, once the held inspection answers.
    const helper: helpers.HelperTerminal = { id: 'helper-slot', parentId: 'slot', command: '', status: 'off' };
    vi.spyOn(helpers, 'getHelper').mockImplementation(id => id === 'slot' ? helper : undefined);
    const inspection = Promise.withResolvers<boolean>();
    vi.spyOn(helpers, 'helperHasWork').mockReturnValue(inspection.promise);
    const ref = (await listRow('slot'))!.ref;
    let kill!: ReturnType<typeof vi.fn>;
    await act(async () => { kill = dispatch(SURFACE_CONTROL_METHODS.kill, { surface: ref, confirmation: { mode: 'dangerously' } }); });
    const result = await answer(await request({ file: 'b.md', preview: true }));
    expect(result.status).toBe('created');
    startTool(result.surfaceId, result.command);
    await act(async () => inspection.resolve(true));
    await waitUntil(() => kill.mock.calls.length > 0);
    expect(kill.mock.calls[0][0]).toMatchObject({ ok: false });
    expect(container.querySelector('[data-lath-leaf="slot"]')).not.toBeNull();
    const { leafMeta } = (await saved()).lathLayout;
    expect(Object.keys(leafMeta).filter(id => leafMeta[id].params?.toolPreview === true)).toEqual([result.surfaceId]);
  });

  it('pins the slot for a request from its own Session and splits the new slot from it', async () => {
    await mountSlot();
    const result = await answer(await request({ file: 'b.md', preview: true }, 'slot'));
    expect(result.status).toBe('created');
    expect(typed.slot).toEqual([]);
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    expect(await leafOrder()).toEqual(['pane-a', 'slot', result.surfaceId]);
    startTool(result.surfaceId, result.command);
  });
});

describe('a prompt after the interrupt\'s grace', () => {
  afterEach(() => { vi.useRealTimers(); });

  /** Advance the faked timers inside `act`. */
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  /** Preview b.md into a slot whose viewer is still running when the grace
   *  runs out: the slot is kept and b.md created beside it, whose command has
   *  reported, freeing the launch queue. Only the host's state polls run on
   *  the test's clock unless `clock` fakes more. */
  async function outliveGrace(clock: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setInterval', 'clearInterval'] }) {
    await mountSlot({ slot: { holdInterrupt: true } });
    vi.useFakeTimers(clock);
    const respond = await request({ file: 'b.md', preview: true });
    expect(typed.slot).toEqual(['\x03']);
    await advance(PREVIEW_INTERRUPT_GRACE_MS);
    const created = respond.mock.calls[0]?.[0]?.result as ToolResult;
    expect(created).toMatchObject({ status: 'created', command: 'view /repo/b.md' });
    startTool(created.surfaceId, created.command);
    await advance(100);
    return created.surfaceId;
  }

  /** Let a queued retype run, on the real clock. */
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });

  it('types a kept slot\'s command again once its late prompt comes, with the queue free meanwhile', async () => {
    const created = await outliveGrace();
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'existing', surfaceId: created });
    await advance(500);
    expect(typed.slot).toEqual(['\x03']);
    act(() => returnToPrompt('slot'));
    await waitUntil(() => typed.slot.length === 2);
    expect(typed.slot).toEqual(['\x03', 'view /repo/a.md\r']);
    expect(terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine).toBe('view /repo/a.md');
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
  });

  it('leaves a kept slot at its prompt when the user typed into it before the prompt came', async () => {
    let input = 0;
    vi.spyOn(terminalRegistry, 'getSessionInputVersion').mockImplementation(() => input);
    await outliveGrace();
    input += 1;
    act(() => returnToPrompt('slot'));
    await settle();
    expect(typed.slot).toEqual(['\x03']);
  });

  it('types a superseded slot\'s viewer again once its late prompt comes', async () => {
    installHost();
    await mountWall([{ id: 'slot', params: viewerParams('a.md') }], { doors: [{ id: 'kept', params: viewerParams('b.md', { toolPreview: undefined }) }] });
    shell('pane-a', null);
    shell('slot', 'view /repo/a.md', { holdInterrupt: true });
    shell('kept', 'view /repo/b.md');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const first = await request({ file: 'c.md', preview: true });
    const second = await request({ file: 'b.md', preview: true });
    expect(await answer(first)).toMatchObject({ status: 'superseded', surfaceId: 'slot' });
    expect(await answer(second)).toMatchObject({ status: 'existing', surfaceId: 'kept' });
    // The last request's own wait for the prompt runs out; the queue is free.
    await advance(PREVIEW_INTERRUPT_GRACE_MS);
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'existing', surfaceId: 'kept' });
    expect(typed.slot).toEqual(['\x03']);
    act(() => returnToPrompt('slot'));
    await waitUntil(() => typed.slot.length === 2);
    expect(typed.slot).toEqual(['\x03', 'view /repo/a.md\r']);
    expect(await paramsOf('slot')).toMatchObject({ toolTarget: '/repo/a.md', toolPreview: true });
  });

  it('gives up on a prompt later than its window', async () => {
    await outliveGrace({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    await advance(PROMPT_RETURN_TIMEOUT_MS - PREVIEW_INTERRUPT_GRACE_MS);
    act(() => returnToPrompt('slot'));
    await advance(1_000);
    vi.useRealTimers();
    await settle();
    expect(typed.slot).toEqual(['\x03']);
  });
});

describe('pinning the slot', () => {
  it('pins by open without restarting when the slot shows the file', async () => {
    await mountSlot();
    expect(await answer(await request({ file: 'a.md' }))).toMatchObject({ status: 'existing', surfaceId: 'slot' });
    expect(typed.slot).toEqual([]);
    expect(await paramsOf('slot')).toMatchObject({ toolTarget: '/repo/a.md', toolKey: ['viewer', '/repo/a.md'] });
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    expect(await listRow('slot')).not.toHaveProperty('preview');
  });

  it('re-runs and pins by open when the slot shows the file but its command exited', async () => {
    await mountSlot();
    act(() => returnToPrompt('slot'));
    expect(await answer(await request({ file: 'a.md' }))).toMatchObject({ status: 'adopted', surfaceId: 'slot', command: 'view /repo/a.md' });
    expect(typed.slot).toEqual(['\x03', 'view /repo/a.md\r']);
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
  });

  it('reveals a pinned Tool with the resolved key, leaving a slot showing the file under another Tool alone', async () => {
    installHost();
    const other = viewerParams('a.md', { command: 'other /repo/a.md', toolArgv: ['other', '/repo/a.md'], toolName: 'other', toolKey: undefined });
    await mountWall([{ id: 'slot', params: other }], { doors: [{ id: 'kept', params: viewerParams('a.md', { toolPreview: undefined }) }] });
    shell('pane-a', null);
    shell('slot', 'other /repo/a.md');
    shell('kept', 'view /repo/a.md');
    expect(await answer(await request({ file: 'a.md' }))).toMatchObject({ status: 'existing', surfaceId: 'kept', minimized: false });
    expect(typed.slot).toEqual([]);
    expect(typed.kept).toEqual([]);
    expect(await paramsOf('slot')).toMatchObject({ toolName: 'other', toolTarget: '/repo/a.md', toolPreview: true });
  });

  it('restores a slot kept while an open with another Tool interrupts it, and opens beside it', async () => {
    await mountSlot({ caller: 'claude', slot: { holdInterrupt: true } });
    const respond = await request({ file: 'a.md', tool: 'other' });
    await waitUntil(() => typed.slot.length === 1);
    keepByHeader();
    act(() => returnToPrompt('slot'));
    await waitUntil(() => leafCount() === 3);
    const created = newLeaf();
    startTool(created, 'other /repo/a.md');
    expect(await answer(respond)).toMatchObject({ status: 'created', surfaceId: created });
    expect(typed.slot).toEqual(['\x03', 'view /repo/a.md\r']);
    expect(await paramsOf('slot')).toMatchObject({ toolName: 'viewer', toolTarget: '/repo/a.md' });
  });

  it('retargets then pins when open names another Tool for the file the slot shows', async () => {
    await mountSlot();
    expect(await answer(await request({ file: 'a.md', tool: 'other' }))).toMatchObject({ status: 'retargeted', surfaceId: 'slot', command: 'other /repo/a.md' });
    expect(typed.slot).toEqual(['\x03', 'other /repo/a.md\r']);
    await waitUntil(() => terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine === 'other /repo/a.md');
    const params = await paramsOf('slot');
    expect(params).toMatchObject({ toolName: 'other', toolArgv: ['other', '/repo/a.md'], toolTarget: '/repo/a.md' });
    expect(params).not.toHaveProperty('toolPreview');
    // The new Tool declares no key; the old one's does not linger.
    expect(params?.toolKey).toBeUndefined();
    // The previous Tool's default title follows the Tool.
    expect(await titleOf('slot')).toBe('other');
  });

  it('keeps a renamed slot\'s title across a retarget to another Tool', async () => {
    await mountSlot({ title: 'notes' });
    expect(await answer(await request({ file: 'a.md', tool: 'other' }))).toMatchObject({ status: 'retargeted', surfaceId: 'slot' });
    await waitUntil(() => terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine === 'other /repo/a.md');
    expect(await titleOf('slot')).toBe('notes');
  });

  it('pins without interrupting when the slot\'s own Session opens its file with another Tool', async () => {
    await mountSlot();
    const respond = await request({ file: 'a.md', tool: 'other' }, 'slot');
    await waitUntil(() => leafCount() === 3);
    const created = newLeaf();
    startTool(created, 'other /repo/a.md');
    expect(await answer(respond)).toMatchObject({ status: 'created', surfaceId: created });
    expect(typed.slot).toEqual([]);
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
  });

  it('leaves the slot alone for a fresh open of its file', async () => {
    await mountSlot({ caller: 'claude' });
    const respond = await request({ file: 'a.md', fresh: true });
    await waitUntil(() => leafCount() === 3);
    const created = newLeaf();
    startTool(created, 'view /repo/a.md');
    expect(await answer(respond)).toMatchObject({ status: 'created', surfaceId: created });
    expect(await paramsOf('slot')).toMatchObject({ toolPreview: true });
  });

  it('pins on a double-click of its header, and a press past the threshold drags it instead', async () => {
    await mountSlot();
    const label = container.querySelector<HTMLElement>('[data-pane-title-for="slot"]')!;
    const leaf = container.querySelector<HTMLElement>('[data-lath-leaf="slot"]')!;
    act(() => label.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 15, button: 0 })));
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 104, clientY: 15 })));
    expect(leaf.style.opacity).toBe('');
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { clientX: 120, clientY: 15 })));
    expect(leaf.style.opacity).toBe('0.6');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(leaf.style.opacity).toBe('');
    expect(await paramsOf('slot')).toMatchObject({ toolPreview: true });
    keepByHeader();
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    expect(container.querySelector('[data-lath-leaf="slot"] .italic')).toBeNull();
  });

  it('pins from Keep open in its terminal context, which only a slot offers', async () => {
    await mountSlot();
    const keepOpen = () => container.querySelector<HTMLButtonElement>('[data-terminal-context] button[aria-label="Keep open"]');
    await act(async () => {
      container.querySelector('[data-pane-header-for="slot"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 15 }));
    });
    expect(document.activeElement?.closest('[data-terminal-context]')).not.toBeNull();
    const keep = keepOpen()!;
    expect(keep.tabIndex).toBe(0);
    act(() => keep.focus());
    await act(async () => keep.click());
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    // Pinned, it is an ordinary Tool, whose open context offers nothing to keep.
    expect(container.querySelector('[data-terminal-context]')).not.toBeNull();
    expect(keepOpen()).toBeNull();
    expect(document.activeElement?.closest('[data-terminal-context]')).not.toBeNull();
  });

  it('never lets a marked slot answer a keyed launch of its Tool', async () => {
    await mountSlot({ caller: 'claude' });
    const respond = await request({ name: 'viewer', args: ['a.md'] });
    await waitUntil(() => leafCount() === 3);
    const created = newLeaf();
    startTool(created, 'view /repo/a.md');
    expect(await answer(respond)).toMatchObject({ status: 'created', surfaceId: created });
    expect(typed.slot).toEqual([]);
  });
});

describe('a serving slot', () => {
  it('retires its browser when retargeted', async () => {
    installHost();
    const close = vi.spyOn(browserController, 'closeBrowserSurface');
    const serving = { url: 'http://localhost:6006/', renderMode: 'iframe', toolAnnouncedPort: 6006, toolAnnouncedPath: '/' };
    // Running before mount, so the serving poll finds its command current.
    shell('pane-a', null);
    shell('slot', 'view /repo/a.md');
    await mountWall([{ id: 'slot', params: viewerParams('a.md', serving) }]);
    expect(close).not.toHaveBeenCalled();
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'retargeted', surfaceId: 'slot' });
    expect(close).toHaveBeenCalledWith('slot', expect.objectContaining({ url: 'http://localhost:6006/', toolTarget: '/repo/a.md' }));
    await waitUntil(() => terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine === 'view /repo/b.md');
    const params = await paramsOf('slot');
    expect(params).toMatchObject({ toolTarget: '/repo/b.md' });
    for (const field of ['url', 'renderMode', 'toolAnnouncedPort', 'toolAnnouncedPath']) expect(params?.[field]).toBeUndefined();
  });
});

describe('a folder in the slot', () => {
  /** The host's built-in folder viewer answer for a directory, else a file's. */
  function installFolderHost() {
    const toolControl = vi.fn(async (request: { op: string; target?: string; tool?: string; preview?: boolean }) => {
      if (request.target !== 'docs') return openLookup(request.target!, request.tool);
      const target = '/repo/docs';
      return { status: 'ok' as const, scope: 'builtin' as const, projectRoot: '/repo', path: '<built-in>', name: 'folder',
        run: ['dor', '__view-folder', target], key: [target], render: 'iframe' as const, port: 'announced' as const, warnings: [], target };
    });
    Object.assign(fake, { toolControl });
    return toolControl;
  }

  it('shows a previewed folder in the slot through the folder viewer', async () => {
    const toolControl = installFolderHost();
    await mountWall([{ id: 'slot', params: viewerParams('a.md') }]);
    shell('pane-a', null);
    shell('slot', 'view /repo/a.md');
    const result = await answer(await request({ file: 'docs', preview: true }));
    expect(toolControl).toHaveBeenCalledWith({ op: 'open', target: 'docs', cwd: '/repo', tool: undefined, preview: true });
    expect(result).toMatchObject({ status: 'retargeted', surfaceId: 'slot', command: 'dor __view-folder /repo/docs' });
    await waitUntil(() => terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine === 'dor __view-folder /repo/docs');
    expect(await paramsOf('slot')).toMatchObject({
      toolScope: 'builtin', toolName: 'folder', toolTarget: '/repo/docs', toolKey: ['folder', '/repo/docs'], toolPreview: true,
    });
  });

  it('pins a folder viewer in the slot when it selects a file, previewing that file in a new slot beside it', async () => {
    installFolderHost();
    const folder = {
      surfaceType: 'tool', command: 'dor __view-folder /repo/docs', toolArgv: ['dor', '__view-folder', '/repo/docs'], cwd: '/repo',
      toolName: 'folder', toolScope: 'builtin', toolRender: 'iframe', toolPort: 'announced', toolKey: ['folder', '/repo/docs'],
      toolTarget: '/repo/docs', toolPreview: true,
    };
    await mountWall([{ id: 'slot', params: folder }]);
    shell('pane-a', null);
    shell('slot', 'dor __view-folder /repo/docs');
    const result = await answer(await request({ file: 'docs/a.md', preview: true, cwd: '/repo/docs' }, 'slot'));
    expect(result).toMatchObject({ status: 'created', command: 'view /repo/docs/a.md' });
    expect(typed.slot).toEqual([]);
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    expect(await paramsOf(result.surfaceId)).toMatchObject({ toolPreview: true, toolTarget: '/repo/docs/a.md' });
    expect(await leafOrder()).toEqual(['pane-a', 'slot', result.surfaceId]);
    startTool(result.surfaceId, result.command);
  });
});

describe('an OSC 367 open', () => {
  const folder = {
    surfaceType: 'tool', command: 'dor __view-folder /repo/docs', toolArgv: ['dor', '__view-folder', '/repo/docs'], cwd: '/repo',
    toolName: 'folder', toolScope: 'builtin', toolRender: 'iframe', toolPort: 'announced', toolKey: ['folder', '/repo/docs'],
    toolTarget: '/repo/docs',
  };
  const failure = "no Tool matches '/repo/docs/x.pdf'; add an open rule";
  const open = (path: string, preview: boolean) => ({ kind: 'toolOpen' as const, open: { path, preview } });
  /** Live output from Session `id`, as its host forwards it. */
  const emit = (id: string, ...events: ReturnType<typeof open>[]) => act(async () => applyLiveToolEvents(id, events));

  /** The host: `x.pdf` has no Tool; anything else opens in the viewer. */
  async function mountFolder(running = folder.command) {
    const toolControl = vi.fn(async (request: { op: string; target?: string }) => request.target === '/repo/docs/x.pdf'
      ? { status: 'error' as const, message: failure }
      : openLookup(request.target!.slice('/repo/'.length)));
    Object.assign(fake, { toolControl });
    await mountWall([{ id: 'folder', params: folder }]);
    shell('pane-a', null);
    shell('folder', running);
    return toolControl;
  }
  /** The slot the requests created beside the folder viewer, its command
   *  then observed running, which releases the launch lock. */
  async function createdSlot(): Promise<Record<string, unknown> | undefined> {
    await waitUntil(() => container.querySelectorAll('[data-lath-leaf]').length === 3);
    const id = (await leafOrder())[2];
    const params = await paramsOf(id);
    startTool(id, String(params?.command));
    return params;
  }

  it('previews a running Tool\'s select as its Session\'s dor open, and replay never opens again', async () => {
    const toolControl = await mountFolder();
    await emit('folder', open('/repo/docs/a.md', true));
    expect(await createdSlot()).toMatchObject({ toolPreview: true, toolTarget: '/repo/docs/a.md' });
    expect(toolControl.mock.calls.map(([request]) => request)).toEqual([
      { op: 'open', target: '/repo/docs/a.md', cwd: '/repo', tool: undefined, preview: true },
    ]);
    act(() => { parseReplay('folder', `\x1b]367;open;${JSON.stringify({ v: 1, path: '/repo/docs/b.md', preview: true })}\x07`); });
    await flush();
    expect(toolControl).toHaveBeenCalledTimes(1);
  });

  it('shows a failed select in the slot through the error viewer', async () => {
    await mountFolder();
    await emit('folder', open('/repo/docs/x.pdf', true));
    expect(await createdSlot()).toMatchObject({
      toolPreview: true, toolScope: 'builtin', toolName: 'error', toolTarget: '/repo/docs/x.pdf',
      toolArgv: ['dor', '__view-error', '/repo/docs/x.pdf', failure],
    });
  });

  it('shows a failed activate in the slot too, unless a newer open from that Tool followed', async () => {
    const toolControl = await mountFolder();
    await emit('folder', open('/repo/docs/x.pdf', false));
    expect(await createdSlot()).toMatchObject({ toolPreview: true, toolName: 'error', toolTarget: '/repo/docs/x.pdf' });
    expect(toolControl.mock.calls.map(([request]) => (request as { preview?: boolean }).preview)).toEqual([undefined, true]);
  });

  it('drops a failed activate\'s retry once a newer open follows it', async () => {
    const toolControl = await mountFolder();
    await emit('folder', open('/repo/docs/x.pdf', false), open('/repo/docs/a.md', true));
    expect(await createdSlot()).toMatchObject({ toolPreview: true, toolTarget: '/repo/docs/a.md' });
    await flush();
    expect(toolControl.mock.calls.map(([request]) => request.target)).toEqual(['/repo/docs/x.pdf', '/repo/docs/a.md']);
  });

  it('ignores an ordinary terminal and a later command in a Tool\'s pane', async () => {
    const toolControl = await mountFolder('cat notes.txt');
    await emit('folder', open('/repo/docs/a.md', true));
    await emit('pane-a', open('/repo/docs/a.md', true));
    await flush();
    expect(toolControl).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[data-lath-leaf]')).toHaveLength(2);
  });
});

describe('a terminal link', () => {
  const openFileButton = () => [...document.body.querySelectorAll('button')].find(button => button.textContent === 'Open file')!;

  it('confirms a labelled link through the real Wall and pins its existing preview', async () => {
    await mountSlot();
    fake.toolControl = vi.fn(async request => request.op === 'open-handlers'
      ? { status: 'open-handlers' as const, handlers: { handlers: [{ tool: 'viewer', description: 'view', reason: 'open rule' }], config: '/config/dormouse.yml' } }
      : openLookup('a.md'));
    await act(async () => activateTerminalLink('pane-a', { detail: 1 }, 'file:///repo/a.md', '[Report]'));
    expect(getExternalLinkConfirmationSnapshot()).not.toBeNull();
    expect(fake.toolControl).toHaveBeenCalledTimes(1);
    await act(async () => openFileButton().click());
    await waitUntil(() => getExternalLinkConfirmationSnapshot() === null);
    expect(fake.toolControl).toHaveBeenLastCalledWith({ op: 'open', target: 'file:///repo/a.md', cwd: '/repo', tool: undefined });
    expect(container.querySelector('[data-lath-leaf="slot"] .italic')).toBeNull();
    expect(container.querySelectorAll('[data-lath-leaf]')).toHaveLength(2);
  });

  it('reports a closed source instead of opening next to an unrelated terminal', async () => {
    await mountSlot();
    fake.toolControl = vi.fn(async () => ({ status: 'open-handlers' as const, handlers: { handlers: [], config: '/config/dormouse.yml' } }));
    await act(async () => activateTerminalLink('closed-pane', { detail: 1 }, 'file:///repo/a.md', '[Report]'));
    await act(async () => openFileButton().click());
    await waitUntil(() => document.body.querySelector('[role="alert"]') !== null);
    expect(getExternalLinkConfirmationSnapshot()).not.toBeNull();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('The originating terminal is no longer available.');
    expect(fake.toolControl).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll('[data-lath-leaf]')).toHaveLength(2);
  });

  it('previews a local file link on a click and pins it on a double-click', async () => {
    const toolControl = await mountSlot();
    // The host resolves a link's URL to the file it names.
    toolControl.mockImplementation(async request => openLookup(new URL(request.target!).pathname.slice('/repo/'.length)));
    const click = (detail: number) => act(async () => activateTerminalLink('pane-a', { detail }, 'file:///repo/a.md', 'a.md'));
    await click(1);
    await click(2);
    await waitUntil(() => container.querySelector('[data-lath-leaf="slot"] .italic') === null);
    expect(toolControl.mock.calls.map(([request]) => request)).toEqual([
      { op: 'open', target: 'file:///repo/a.md', cwd: '/repo', tool: undefined, preview: true },
      { op: 'open', target: 'file:///repo/a.md', cwd: '/repo', tool: undefined },
    ]);
    expect(typed.slot).toEqual([]);
    expect(getExternalLinkConfirmationSnapshot()).toBeNull();
  });
});

describe('a switching slot', () => {
  /** a.md's viewer serving at 6006, framed before mount so the serving poll
   *  finds its command current. */
  async function mountServingSlot(options: ShellOptions = {}) {
    const toolControl = installHost();
    shell('pane-a', null);
    shell('slot', 'view /repo/a.md', options);
    await mountWall([{ id: 'slot', params: viewerParams('a.md', {
      url: 'http://localhost:6006/', renderMode: 'iframe', toolAnnouncedPort: 6006, toolAnnouncedPath: '/',
    }) }]);
    return toolControl;
  }

  const inSlot = <T extends Element>(selector: string) => Array.from(container.querySelectorAll<T>(`[data-lath-leaf="slot"] ${selector}`));
  const frames = () => inSlot<HTMLIFrameElement>('iframe');
  const layerOf = (element: Element) => element.closest<HTMLElement>('[data-browser-layer]')!;
  const terminalHalf = () => inSlot<HTMLElement>('[data-tool-half="terminal"]')[0];
  const browserHalf = () => inSlot<HTMLElement>('[data-tool-half="browser"]')[0];
  const ghosted = (element: Element) => /\bpreview-ghost(-static)?\b/.test(element.className);
  /** The slot's new command serves at `port`, as a viewer announces it. */
  const serve = (port: number) => {
    fake.setOpenPorts('slot', [{ protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port, pid: 1 }]);
    act(() => recordToolAnnounce('slot', { port, path: '/', name: null, key: null, dehydrate: false, persist: null }));
  };
  const runs = (line: string) => () => terminalRegistry.getTerminalPaneState('slot').currentCommand?.rawCommandLine === line;
  const sleep = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

  it('holds the old frame as a blurred ghost until the new one loads, remounting neither', async () => {
    await mountServingSlot();
    const [old] = frames();
    expect(ghosted(layerOf(old))).toBe(false);
    const respond = await request({ file: 'b.md', preview: true });
    // The same frame, blurred and inert; reduced motion holds a static blur.
    expect(layerOf(old).className).toContain('preview-ghost-static');
    expect(layerOf(old).hasAttribute('inert')).toBe(true);
    expect(await answer(respond)).toMatchObject({ status: 'retargeted' });
    await waitUntil(runs('view /repo/b.md'));
    // Retired, the Tool has no URL, yet its terminal face never shows.
    expect((await paramsOf('slot'))?.url).toBeUndefined();
    expect(terminalHalf().style.visibility).toBe('hidden');
    expect(browserHalf().style.visibility).toBe('');
    expect(container.querySelector('[data-lath-leaf="slot"] [data-browser-display-trigger]')).not.toBeNull();
    expect(frames()).toEqual([old]);

    serve(7007);
    await waitUntil(() => frames().length === 2);
    const [ghost, next] = frames();
    expect(ghost).toBe(old);
    expect(layerOf(next).getAttribute('data-browser-layer')).toBe('incoming');
    expect(layerOf(next).className).toContain('opacity-0');
    await act(async () => { next.dispatchEvent(new Event('load')); });
    await harness.flushFrame();
    // Reduced motion swaps at once: the ghost goes, the new frame is kept.
    expect(frames()).toEqual([next]);
    expect(old.isConnected).toBe(false);
    expect(layerOf(next).getAttribute('data-browser-layer')).toBe('live');
    expect(layerOf(next).className).not.toContain('opacity-0');
    expect(layerOf(next).hasAttribute('inert')).toBe(false);
  });

  it('blurs the slot as the preview arrives, before its lookup answers', async () => {
    const toolControl = await mountServingSlot();
    const lookup = Promise.withResolvers<void>();
    const answerLookup = toolControl.getMockImplementation()!;
    toolControl.mockImplementationOnce(async (call) => { await lookup.promise; return answerLookup(call); });
    const respond = await request({ file: 'b.md', preview: true });
    // Read before the lookup is released, which a failed expect would never do.
    const early = { answered: respond.mock.calls.length > 0, blurred: ghosted(layerOf(frames()[0])) };
    await act(async () => lookup.resolve());
    expect(early).toEqual({ answered: false, blurred: true });
    expect(await answer(respond)).toMatchObject({ status: 'retargeted' });
  });

  it('unblurs at once for a preview that does not retarget the slot', async () => {
    await mountServingSlot();
    const [old] = frames();
    expect(await answer(await request({ file: 'a.md', preview: true }))).toMatchObject({ status: 'existing' });
    expect(ghosted(layerOf(old))).toBe(false);
    expect(layerOf(old).hasAttribute('inert')).toBe(false);
    expect(frames()).toEqual([old]);
  });

  it('keeps the ghost through a superseded preview, never capturing the half-switched pane', async () => {
    await mountServingSlot({ holdInterrupt: true });
    const [old] = frames();
    const first = await request({ file: 'b.md', preview: true });
    await waitUntil(() => typed.slot.length === 1);
    const second = await request({ file: 'c.md', preview: true });
    expect(await answer(first)).toMatchObject({ status: 'superseded' });
    expect(ghosted(layerOf(old))).toBe(true);
    await waitUntil(() => typed.slot.length === 2);
    act(() => returnToPrompt('slot'));
    expect(await answer(second)).toMatchObject({ status: 'retargeted', command: 'view /repo/c.md' });
    expect(frames()[0]).toBe(old);
    expect(ghosted(layerOf(old))).toBe(true);
  });

  it('holds nothing for a preview from the slot\'s own Session, which it never retargets', async () => {
    const toolControl = await mountServingSlot();
    const lookup = Promise.withResolvers<void>();
    const answerLookup = toolControl.getMockImplementation()!;
    toolControl.mockImplementationOnce(async (call) => { await lookup.promise; return answerLookup(call); });
    const respond = await request({ file: 'b.md', preview: true }, 'slot');
    const blurred = ghosted(layerOf(frames()[0]));
    await act(async () => lookup.resolve());
    expect(blurred).toBe(false);
    const result = await answer(respond);
    expect(result.status).toBe('created');
    startTool(result.surfaceId, result.command);
  });

  it('keeps the first ghost when a preview takes over a committed switch', async () => {
    await mountServingSlot();
    const [old] = frames();
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'retargeted' });
    await waitUntil(runs('view /repo/b.md'));
    // b.md's viewer has not served: the pane itself now holds only a terminal.
    expect(await answer(await request({ file: 'c.md', preview: true }))).toMatchObject({ status: 'retargeted' });
    await waitUntil(runs('view /repo/c.md'));
    expect(frames()[0]).toBe(old);
    expect(ghosted(layerOf(old))).toBe(true);
    expect(terminalHalf().style.visibility).toBe('hidden');
  });

  it('ends the hold once the slot is kept during its interrupt, before the new slot answers', async () => {
    let integrated = false;
    vi.mocked(terminalRegistry.isPaneOscDriven).mockImplementation(id => id === 'pane-a' || id === 'slot' || integrated);
    await mountServingSlot({ holdInterrupt: true });
    const respond = await request({ file: 'b.md', preview: true });
    await waitUntil(() => typed.slot.length === 1);
    keepByHeader();
    act(() => returnToPrompt('slot'));
    await waitUntil(() => leafCount() === 3);
    const ghostsWhileWaiting = inSlot('.preview-ghost-static').length;
    integrated = true;
    const created = newLeaf();
    startTool(created, 'view /repo/b.md');
    expect(await answer(respond)).toMatchObject({ status: 'created', surfaceId: created });
    expect(ghostsWhileWaiting).toBe(0);
  });

  it('ends the hold once the slot is kept during its lookup, before the new slot answers', async () => {
    let integrated = false;
    vi.mocked(terminalRegistry.isPaneOscDriven).mockImplementation(id => id === 'pane-a' || id === 'slot' || integrated);
    const toolControl = await mountServingSlot();
    const lookup = Promise.withResolvers<void>();
    const answerLookup = toolControl.getMockImplementation()!;
    toolControl.mockImplementationOnce(async (call) => { await lookup.promise; return answerLookup(call); });
    const respond = await request({ file: 'b.md', preview: true });
    keepByHeader();
    await act(async () => lookup.resolve());
    await waitUntil(() => leafCount() === 3);
    const ghostsWhileWaiting = inSlot('.preview-ghost').length;
    integrated = true;
    const created = newLeaf();
    startTool(created, 'view /repo/b.md');
    expect(await answer(respond)).toMatchObject({ status: 'created', surfaceId: created });
    expect(ghostsWhileWaiting).toBe(0);
  });

  it('shows a terminal-only Tool once its output goes quiet, not on its echo', async () => {
    await mountSlot();
    const respond = await request({ file: 'b.md', preview: true });
    expect(terminalHalf().className).toContain('preview-ghost-static');
    expect(terminalHalf().hasAttribute('inert')).toBe(true);
    expect(await answer(respond)).toMatchObject({ status: 'retargeted' });
    await waitUntil(runs('view /repo/b.md'));
    act(() => fake.sendOutput('slot', 'view /repo/b.md\r\n\x1b]2;b.md\x07'));
    await sleep(PREVIEW_OUTPUT_QUIET_MS + 50);
    expect(ghosted(terminalHalf())).toBe(true);
    act(() => fake.sendOutput('slot', '# b\r\n'));
    await sleep(PREVIEW_OUTPUT_QUIET_MS / 2);
    expect(ghosted(terminalHalf())).toBe(true);
    await sleep(PREVIEW_OUTPUT_QUIET_MS);
    expect(ghosted(terminalHalf())).toBe(false);
    expect(terminalHalf().hasAttribute('inert')).toBe(false);
  });

  it('shows the terminal when the new command finishes before serving, so a failure stays visible', async () => {
    await mountServingSlot();
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'retargeted' });
    await waitUntil(runs('view /repo/b.md'));
    act(() => terminalRegistry.applyTerminalSemanticEvents('slot', [{ type: 'commandFinish', exitCode: 1 }]));
    expect(frames()).toHaveLength(0);
    expect(terminalHalf().style.visibility).toBe('');
  });

  it.each([
    ['names the new target at once', null, ['a.md', 'b.md']],
    ['keeps the name a user gave the slot', 'notes', ['notes']],
  ])('%s in its header, one element in one type from start to end', async (_, rename, expected) => {
    // The name once came from the dev-server chip, which the port scan
    // resolves for each new viewer's port only after the switch has ended.
    await mountServingSlot();
    act(() => setDevServerResolution(6006, { paneId: 'slot', fallbackTitle: null }));
    try {
      if (rename) act(() => { terminalRegistry.setTerminalUserTitle('slot', rename); });
      const name = () => inSlot<HTMLElement>('[data-pane-title-for="slot"]')[0];
      const shown = name();
      const typography = shown.className;
      const seen: (string | null)[] = [];
      const sample = () => {
        expect(name()).toBe(shown);
        expect(name().className).toBe(typography);
        if (name().textContent !== seen.at(-1)) seen.push(name().textContent);
      };
      sample();
      const respond = await request({ file: 'b.md', preview: true });
      sample();
      expect(await answer(respond)).toMatchObject({ status: 'retargeted' });
      await waitUntil(runs('view /repo/b.md'));
      sample();
      serve(7007);
      await waitUntil(() => frames().length === 2);
      sample();
      await act(async () => { frames()[1].dispatchEvent(new Event('load')); });
      await harness.flushFrame();
      expect(frames()).toHaveLength(1);
      sample();
      act(() => setDevServerResolution(7007, { paneId: 'slot', fallbackTitle: null }));
      sample();
      expect(seen).toEqual(expected);
    } finally {
      setDevServerResolution(6006, null);
      setDevServerResolution(7007, null);
    }
  });

  it('ends the switch after its fallback when the new view never reports ready', async () => {
    await mountServingSlot();
    const [old] = frames();
    expect(await answer(await request({ file: 'b.md', preview: true }))).toMatchObject({ status: 'retargeted' });
    await sleep(PREVIEW_READY_FALLBACK_MS - 500);
    expect(old.isConnected).toBe(true);
    await sleep(600);
    expect(old.isConnected).toBe(false);
    expect(terminalHalf().style.visibility).toBe('');
  }, 10_000);
});
