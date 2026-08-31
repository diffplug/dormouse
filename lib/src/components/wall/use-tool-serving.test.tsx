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
import { recordToolAnnounce, resetToolAnnounces } from '../../lib/tool-announce-store';
import { useToolServing } from './use-tool-serving';
import type { LathWallEngine } from './lath-wall-engine';
import type { OpenPort } from '../../lib/platform/types';

const POLL_MS = 1500;

function tcp(port: number): OpenPort {
  return { protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port, pid: 1 };
}

/** Minimal Lath stand-in: one tool leaf whose params the hook reads and writes. */
function fakeLath(params: Record<string, unknown>) {
  const state = { params: { ...params } };
  const updateParams = vi.fn((_id: string, patch: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete state.params[key];
      else state.params[key] = value;
    }
  });
  const lath = {
    listPanes: () => [{ id: 'tool-1', params: state.params }],
    getMeta: (id: string) => (id === 'tool-1' ? { params: state.params } : undefined),
    store: { updateParams },
  } as unknown as LathWallEngine;
  return { lath, state, updateParams };
}

let container: HTMLDivElement;
let root: Root;
let currentCommand: string | null = 'pnpm storybook';

vi.mock('../../lib/terminal-registry', () => ({
  getTerminalPaneState: () => ({ currentCommand }),
}));

beforeEach(() => {
  vi.useFakeTimers();
  resetToolAnnounces();
  currentCommand = 'pnpm storybook';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Mount the hook with a scripted sequence of scan results, one per tick. */
async function run(params: Record<string, unknown>, scans: OpenPort[][]) {
  const { lath, state, updateParams } = fakeLath(params);
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
  return { state, updateParams };
}

describe('port: announced', () => {
  const announced = { surfaceType: 'tool', command: 'x', toolPort: 'announced' };

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
    const { lath, state, updateParams } = fakeLath(auto);
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
