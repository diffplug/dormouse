// @vitest-environment jsdom
/**
 * The serving decision (`docs/specs/dor-tool.md` -> Serving). This logic had no
 * test at all before autobind, which is how "framing the lowest-numbered port"
 * survived as an unstated rule.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import { setToolsEnabled } from '../../lib/feature-flags';
import { recordToolAnnounce, resetToolAnnounces } from '../../lib/tool-announce-store';
import { useToolServing } from './use-tool-serving';
import { captureToolParams } from './tool-transfer';
import { createLathWallEngine, toolLeafMeta } from './lath-wall-engine';
import type { OpenPort } from '../../lib/platform/types';

const controllerMocks = vi.hoisted(() => ({
  disposeAgentBrowserSurfaceController: vi.fn(),
}));

vi.mock('./agent-browser-surface-controller', () => controllerMocks);

const POLL_MS = 1500;

function tcp(port: number): OpenPort {
  return { protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port, pid: 1 };
}

/** A real engine holding one tool leaf, the way the Wall builds one. */
function toolEngine(params: Record<string, unknown>) {
  const lath = createLathWallEngine();
  lath.store.addLeaf('tool-1', toolLeafMeta('Tool', params), null);
  const updateParams = vi.spyOn(lath.store, 'updateParams');
  const state = {
    get params() { return (lath.getMeta('tool-1')?.params ?? {}) as Record<string, unknown>; },
    /** Write params the way anything outside the hook does — a URL-bar
     *  navigation, a restore — since the store owns them. */
    set(patch: Record<string, unknown>) { lath.store.updateParams('tool-1', patch); },
  };
  return { lath, state, updateParams };
}

let container: HTMLDivElement;
let root: Root;
let currentCommand: string | null = 'x';

vi.mock('../../lib/terminal-registry', () => ({
  getTerminalPaneState: () => ({ currentCommand: currentCommand === null ? null : { id: currentCommand, rawCommandLine: currentCommand } }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  setToolsEnabled(true);
  resetToolAnnounces();
  currentCommand = 'x';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  setToolsEnabled(false);
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Mount the hook with a scripted sequence of scan results, one per tick. */
async function run(params: Record<string, unknown>, scans: OpenPort[][]) {
  const { lath, state, updateParams } = toolEngine(params);
  let call = 0;
  const platform = new FakePtyAdapter() as FakePtyAdapter & { getOpenPorts: () => Promise<OpenPort[]> };
  platform.getOpenPorts = vi.fn(async () => scans[Math.min(call++, scans.length - 1)] ?? []);
  setPlatform(platform);

  const doorsRef = { current: [] };
  function Probe() {
    useToolServing({ lath, doorsRef });
    return null;
  }
  await act(async () => { root.render(<Probe />); });
  // One tick per scripted scan, past the initial immediate tick.
  for (let i = 1; i < scans.length; i += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
  }
  return { lath, state, updateParams, platform };
}

describe('port: announced', () => {
  const announced = { surfaceType: 'tool', command: 'x', toolPort: 'announced' };

  it('defers Workspace transfer until reopening an existing browser has settled', async () => {
    const { lath, state } = toolEngine({
      ...announced, toolRender: 'ab-screencast', renderMode: 'ab-screencast',
      session: 'existing-browser', wsPort: 9222, url: 'http://localhost:6006/', toolAnnouncedPort: 6006,
    });
    const opened = Promise.withResolvers<{ exitCode: number; stdout: string; stderr: string }>();
    const platform = Object.assign(new FakePtyAdapter(), {
      getOpenPorts: vi.fn(async () => [tcp(6007)]),
      agentBrowserCommand: vi.fn(() => opened.promise),
    });
    setPlatform(platform);
    recordToolAnnounce('tool-1', { port: 6007, name: null, key: null, dehydrate: false, persist: null });
    const doorsRef = { current: [] };
    function Probe() { useToolServing({ lath, doorsRef }); return null; }
    await act(async () => root.render(<Probe />));
    expect(state.params.url).toBe('http://localhost:6007/');
    expect(() => captureToolParams(lath, ['tool-1'])).toThrow('Wait for the Tool browser to connect');
    await act(async () => opened.resolve({ exitCode: 0, stdout: '', stderr: '' }));
    expect(captureToolParams(lath, ['tool-1'])['tool-1'].session).toBeTruthy();
  });

  it('frames nothing without an announcement, however many ports bind', async () => {
    const { state } = await run(announced, [[tcp(6006)], [tcp(6006)], [tcp(6006)]]);
    expect(state.params.url).toBeUndefined();
    expect(state.params.toolPortConflict).toBeUndefined();
  });

  it('frames the announced port', async () => {
    recordToolAnnounce('tool-1', { port: 6006, name: null, key: null, dehydrate: false, persist: null });
    const { state } = await run(announced, [[tcp(6006)]]);
    expect(state.params.url).toBe('http://localhost:6006/');
  });

  it('does not undo URL-bar navigation while the announcement is unchanged', async () => {
    recordToolAnnounce('tool-1', { port: 6006, name: null, key: null, dehydrate: false, persist: null });
    const { state, platform } = await run(announced, [[tcp(6006)]]);
    state.set({ url: 'https://example.com/docs' });

    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });

    expect(state.params.url).toBe('https://example.com/docs');
    expect(platform.getOpenPorts).toHaveBeenCalledTimes(1);
  });

  it('re-points a live browser when the announced port changes', async () => {
    recordToolAnnounce('tool-1', { port: 6006, name: null, key: null, dehydrate: false, persist: null });
    const { state, platform } = await run(announced, [[tcp(6006)]]);
    expect(state.params.url).toBe('http://localhost:6006/');

    recordToolAnnounce('tool-1', { port: 6007, name: null, key: null, dehydrate: false, persist: null });
    platform.getOpenPorts = vi.fn(async () => [tcp(6007)]);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });

    expect(state.params.url).toBe('http://localhost:6007/');
  });

  it('frames nothing when the announced port never binds', async () => {
    recordToolAnnounce('tool-1', { port: 9999, name: null, key: null, dehydrate: false, persist: null });
    const { state } = await run(announced, [[tcp(6006)], [tcp(6006)]]);
    expect(state.params.url).toBeUndefined();
  });

  it('lets an announcement override even in auto mode', async () => {
    recordToolAnnounce('tool-1', { port: 1420, name: null, key: null, dehydrate: false, persist: null });
    const { state } = await run({ ...announced, toolPort: 'auto' }, [[tcp(1420), tcp(1422)]]);
    expect(state.params.url).toBe('http://localhost:1420/');
    expect(state.params.toolPortConflict).toBeUndefined();
  });
});

describe('port: auto (autobind)', () => {
  const auto = { surfaceType: 'tool', command: 'x', toolPort: 'auto' };

  it('waits for the port set to settle before framing', async () => {
    const { state } = await run(auto, [[tcp(6006)]]);
    // First sighting only — not committed yet.
    expect(state.params.url).toBeUndefined();
  });

  it('frames a sole port once the set is unchanged', async () => {
    const { state } = await run(auto, [[tcp(6006)], [tcp(6006)]]);
    expect(state.params.url).toBe('http://localhost:6006/');
    expect(state.params.renderMode).toBe('iframe');
  });

  it('refuses two ports rather than tie-breaking', async () => {
    const { state } = await run(auto, [[tcp(6006), tcp(6007)], [tcp(6006), tcp(6007)]]);
    expect(state.params.url).toBeUndefined();
    expect(state.params.toolPortConflict).toEqual([6006, 6007]);
  });

  it('does not frame the bridge when vite binds a tick later', async () => {
    // The standalone harness: the dev bridge (1422) binds before vite (1420).
    // Committing on first sighting would frame the JSON bridge permanently,
    // since a framed leaf is never scanned again. This is the regression that
    // motivates the settle window.
    const { state } = await run(auto, [[tcp(1422)], [tcp(1420), tcp(1422)], [tcp(1420), tcp(1422)]]);
    expect(state.params.url).toBeUndefined();
    expect(state.params.toolPortConflict).toEqual([1420, 1422]);
  });

  it('retires the conflict when the command exits, so a re-run re-decides', async () => {
    const { state, updateParams } = await run(auto, [[tcp(6006), tcp(6007)], [tcp(6006), tcp(6007)]]);
    expect(state.params.toolPortConflict).toEqual([6006, 6007]);
    currentCommand = null;
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(state.params.toolPortConflict).toBeUndefined();
    expect(updateParams).toHaveBeenCalledWith('tool-1', expect.objectContaining({ toolPortConflict: undefined }));
  });
});

describe('an announcement overrides a committed conflict', () => {
  const auto = { surfaceType: 'tool', command: 'x', toolPort: 'auto' };

  it('frames the announced port after autobind has already refused', async () => {
    // The spec says the announcement always wins. A tool that names its port
    // *after* the set settled would otherwise be stuck on the conflict face for
    // the life of the command — told to announce a port it had just announced.
    const { lath, state, updateParams } = toolEngine(auto);
    let call = 0;
    const scans = [[tcp(1420), tcp(1422)], [tcp(1420), tcp(1422)], [tcp(1420), tcp(1422)]];
    const platform = new FakePtyAdapter() as FakePtyAdapter & { getOpenPorts: () => Promise<OpenPort[]> };
    platform.getOpenPorts = vi.fn(async () => scans[Math.min(call++, scans.length - 1)]);
    setPlatform(platform);

    const doorsRef = { current: [] };
    function Probe() {
      useToolServing({ lath, doorsRef });
      return null;
    }
    await act(async () => { root.render(<Probe />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(state.params.toolPortConflict).toEqual([1420, 1422]);

    // The tool announces late.
    recordToolAnnounce('tool-1', { port: 1420, name: null, key: null, dehydrate: false, persist: null });
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });

    expect(state.params.url).toBe('http://localhost:1420/');
    // The stale verdict must be cleared too: `toolFace` tests the conflict
    // before the url, so leaving it would keep the conflict card forward.
    expect(state.params.toolPortConflict).toBeUndefined();
    expect(updateParams).toHaveBeenCalledWith('tool-1', expect.objectContaining({ toolPortConflict: undefined }));
  });
});

describe('the settle memory resets on any exit (regression: PR #493 review)', () => {
  const auto = { surfaceType: 'tool', command: 'x', toolPort: 'auto' };

  it('does not commit the first port seen after a run that died mid-settle', async () => {
    // Run 1 sees only the bridge and dies before committing anything. Keeping
    // that port list would make run 2's first tick compare equal and frame the
    // bridge — the exact regression the settle window exists to prevent.
    const { lath, state } = toolEngine(auto);
    let call = 0;
    const scans = [[tcp(1422)], [tcp(1422)], [tcp(1422)]];
    const platform = new FakePtyAdapter() as FakePtyAdapter & { getOpenPorts: () => Promise<OpenPort[]> };
    platform.getOpenPorts = vi.fn(async () => scans[Math.min(call++, scans.length - 1)]);
    setPlatform(platform);

    const doorsRef = { current: [] };
    function Probe() {
      useToolServing({ lath, doorsRef });
      return null;
    }
    await act(async () => { root.render(<Probe />); });   // tick 1: [1422] recorded
    currentCommand = null;                                 // the command dies
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    currentCommand = 'x';                                  // re-run
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });

    // First tick of run 2 is a first sighting again, so nothing is framed yet.
    expect(state.params.url).toBeUndefined();
  });
});

describe('agent-browser retirement on command exit', () => {
  it.each([true, false])('retires the daemon and browser params with Tools enabled=%s', async (enabled) => {
    currentCommand = null;
    const params = {
      surfaceType: 'tool',
      command: 'pnpm storybook',
      url: 'http://localhost:6006/',
      renderMode: 'ab-screencast',
      session: 'dormouse.1.tool-1',
      wsPort: 43123,
      syncEngaged: true,
      binaryPath: '/opt/agent-browser',
    };
    const { state, platform } = await run(params, [[]]);
    const close = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    platform.agentBrowserCommand = close;

    // The first tick ran during mount before the close stub was installed; put
    // the browser state back, then let the next poll exercise retirement.
    state.set(params);
    setToolsEnabled(enabled);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });

    expect(close).toHaveBeenCalledWith('dormouse.1.tool-1', ['close'], '/opt/agent-browser');
    expect(controllerMocks.disposeAgentBrowserSurfaceController).toHaveBeenCalledWith('tool-1');
    expect(state.params.url).toBeUndefined();
    expect(state.params.session).toBeUndefined();
    expect(state.params.wsPort).toBeUndefined();
    expect(state.params.renderMode).toBeUndefined();
    expect(state.params.syncEngaged).toBeUndefined();
  });
});


it('does not frame or re-key a different command running in a Tool Session', async () => {
  currentCommand = 'cat untrusted.log';
  recordToolAnnounce('tool-1', { port: 6006, name: null, key: ['spoof'], dehydrate: false, persist: null });
  const { state, platform } = await run({ surfaceType: 'tool', command: 'x', toolPort: 'auto' }, [[tcp(6006)], [tcp(6006)]]);
  expect(platform.getOpenPorts).not.toHaveBeenCalled();
  expect(state.params.url).toBeUndefined();
  expect(state.params.toolKey).toBeUndefined();
});

it('ignores a scan that finishes after the command has changed', async () => {
  const { lath, state } = toolEngine({ surfaceType: 'tool', command: 'x', toolPort: 'announced' });
  recordToolAnnounce('tool-1', { port: 6006, name: null, key: null, dehydrate: false, persist: null });
  let resolve!: (ports: OpenPort[]) => void;
  const platform = new FakePtyAdapter();
  platform.getOpenPorts = vi.fn(() => new Promise<OpenPort[]>(r => { resolve = r; }));
  setPlatform(platform);
  function Probe() { useToolServing({ lath, doorsRef: { current: [] } }); return null; }
  await act(async () => { root.render(<Probe />); });
  currentCommand = 'cat other.log';
  await act(async () => { resolve([tcp(6006)]); });
  expect(state.params.url).toBeUndefined();
});

it('keeps the destination and browser binding after a Workspace transfer', async () => {
  recordToolAnnounce('tool-1', { port: 6006, name: null, key: null, dehydrate: false, persist: null });
  const { state, platform } = await run({
    surfaceType: 'tool', command: 'x', toolRender: 'ab-screencast',
    renderMode: 'ab-screencast', session: 'existing-browser',
    url: 'http://localhost:6006/edited', toolAnnouncedPort: 6006,
  }, [[tcp(6006)], [tcp(6006)]]);
  expect(platform.getOpenPorts).not.toHaveBeenCalled();
  expect(state.params.url).toBe('http://localhost:6006/edited');
  expect(state.params.session).toBe('existing-browser');
});

it('does not commit an in-flight scan once its Workspace begins transferring', async () => {
  const { lath, state } = toolEngine({ surfaceType: 'tool', command: 'x', toolPort: 'announced' });
  recordToolAnnounce('tool-1', { port: 6006, name: null, key: null, dehydrate: false, persist: null });
  const gate = Promise.withResolvers<OpenPort[]>();
  const platform = new FakePtyAdapter();
  platform.getOpenPorts = vi.fn(() => gate.promise);
  setPlatform(platform);
  let moving = false;
  const doorsRef = { current: [] };
  function Probe() { useToolServing({ lath, doorsRef, paused: () => moving }); return null; }
  await act(async () => root.render(<Probe />));
  moving = true;
  await act(async () => gate.resolve([tcp(6006)]));
  expect(state.params.url).toBeUndefined();
});
