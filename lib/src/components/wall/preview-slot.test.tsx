/**
 * @vitest-environment jsdom
 *
 * The Workspace preview slot through a mounted Wall (`docs/specs/dor-tool.md`
 * -> Preview slot): `dor open --preview` creates, retargets, and supersedes the
 * slot; `dor open`, unsaved state, and the header pill pin it.
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
import { mountWallHarness, reportRunning, waitUntil, type WallHarness } from './wall-test-utils';
import { getExternalLinkConfirmationSnapshot } from '../../lib/external-link-confirmation';
import { activateTerminalLink } from '../../lib/terminal-link-activation';
import type { LathNode } from '../../lib/lath/model';

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
  for (const id of sessions) {
    fake.clearInputHandler(id);
    pendingShellOpts.delete(id);
    terminalRegistry.removeTerminalPaneState(id);
  }
  sessions.clear();
  resetToolDirty();
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

describe('pinning the slot', () => {
  it('pins by open without restarting when the slot shows the file', async () => {
    await mountSlot();
    expect(await answer(await request({ file: 'a.md' }))).toMatchObject({ status: 'existing', surfaceId: 'slot' });
    expect(typed.slot).toEqual([]);
    expect(await paramsOf('slot')).toMatchObject({ toolTarget: '/repo/a.md', toolKey: ['viewer', '/repo/a.md'] });
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    expect(await listRow('slot')).not.toHaveProperty('preview');
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

  it('pins from the header pill', async () => {
    await mountSlot();
    const pill = container.querySelector<HTMLButtonElement>('[data-preview-pill-for="slot"]');
    expect(pill).not.toBeNull();
    await act(async () => pill!.click());
    expect(await paramsOf('slot')).not.toHaveProperty('toolPreview');
    expect(container.querySelector('[data-preview-pill-for="slot"]')).toBeNull();
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

describe('a terminal link', () => {
  it('previews a local file link on a click and pins it on a double-click', async () => {
    const toolControl = await mountSlot();
    // The host resolves a link's URL to the file it names.
    toolControl.mockImplementation(async request => openLookup(new URL(request.target!).pathname.slice('/repo/'.length)));
    const click = (detail: number) => act(async () => activateTerminalLink('pane-a', { detail }, 'file:///repo/a.md', 'a.md'));
    await click(1);
    await click(2);
    await waitUntil(() => container.querySelector('[data-preview-pill-for="slot"]') === null);
    expect(toolControl.mock.calls.map(([request]) => request)).toEqual([
      { op: 'open', target: 'file:///repo/a.md', cwd: '/repo', tool: undefined, preview: true },
      { op: 'open', target: 'file:///repo/a.md', cwd: '/repo', tool: undefined },
    ]);
    expect(typed.slot).toEqual([]);
    expect(getExternalLinkConfirmationSnapshot()).toBeNull();
  });
});
