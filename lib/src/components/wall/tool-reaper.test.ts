// @vitest-environment jsdom
/**
 * Reaping (`docs/specs/dor-tool.md` -> Reaping): who may be stopped, what a
 * stop keeps, and how a rehydrate degrades. The hook's timing is pinned by
 * `use-tool-reaper.test.tsx`; a real PTY by
 * `standalone/sidecar/tool-reap.test.js`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePtyAdapter, setPlatform } from '../../lib/platform';
import type { SpawnPtyOptions } from '../../lib/platform/types';
import { disposeSession, getOrCreateTerminal } from '../../lib/terminal-registry';
import { registry } from '../../lib/terminal-store';
import { applyTerminalSemanticEvents, getTerminalPaneState } from '../../lib/terminal-state-store';
import { TerminalProtocolParser } from '../../lib/terminal-protocol';
import { getToolAnnounce, recordToolAnnounce, resetToolAnnounces } from '../../lib/tool-announce-store';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
import { applyLiveToolEvents, recordToolEvents } from '../../lib/tool-events';
import { getToolReap, isToolReaped, isToolStopping, markToolReaped, resetToolReaps } from '../../lib/tool-reap-store';
import { createLathWallEngine, toolLeafMeta } from './lath-wall-engine';
import { rehydrateTool, stopTool, TOOL_STOP_GRACE_MS, toolReapBlocker } from './tool-reaper';

vi.mock('@xterm/xterm', () => import('../../lib/xterm-test-mock'));
vi.mock('@xterm/addon-fit', () => import('../../lib/xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('../../lib/xterm-test-mock'));
vi.mock('@xterm/addon-serialize', () => import('../../lib/xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('../../lib/xterm-test-mock'));
vi.mock('./agent-browser-surface-controller', () => ({ closeBrowserSurface: vi.fn() }));

const ID = 'tool';
const COMMAND = 'viewer --serve';
const PAYLOAD = '{"v":1,"state":{"expanded":["src"]}}';

let fake: FakePtyAdapter;
let writes: string[];
let spawns: Array<SpawnPtyOptions | undefined>;
let kills: string[];

const announce = (patch: Partial<{ dehydrate: boolean; persist: 'never' | 'respawn' | null }> = {}) =>
  recordToolAnnounce(ID, { port: 6006, name: null, key: null, dehydrate: true, persist: null, ...patch });

function startRun(command = COMMAND): void {
  applyTerminalSemanticEvents(ID, [
    { type: 'cwd', cwd: { path: '/repo', source: 'osc633' } as never },
    { type: 'commandLine', commandLine: command },
    { type: 'commandStart', source: 'osc633_boundaries' },
  ]);
}

/** A Tool leaf running its designated command, which declared itself safe to stop. */
function servingTool(params: Record<string, unknown> = {}) {
  const lath = createLathWallEngine();
  lath.store.addLeaf(ID, toolLeafMeta('Viewer', { surfaceType: 'tool', command: COMMAND, toolPort: 'announced', ...params }), null);
  getOrCreateTerminal(ID);
  startRun();
  announce();
  return lath;
}

/** What a live parse of `data` from the Tool's PTY records. */
function emit(data: string): void {
  applyLiveToolEvents(ID, new TerminalProtocolParser().process(data).events);
}

async function finishStop(): Promise<void> {
  await vi.advanceTimersByTimeAsync(TOOL_STOP_GRACE_MS + 500);
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = new FakePtyAdapter();
  writes = [];
  spawns = [];
  kills = [];
  const write = fake.writePty.bind(fake);
  fake.writePty = (id, data, options) => { if (id === ID) writes.push(data); write(id, data, options); };
  const spawn = fake.spawnPty.bind(fake);
  fake.spawnPty = (id, options) => { if (id === ID) spawns.push(options); spawn(id, options); };
  const kill = fake.killPty.bind(fake);
  fake.killPty = (id) => { kills.push(id); kill(id); };
  setPlatform(fake);
});

afterEach(() => {
  disposeSession(ID);
  resetToolAnnounces();
  resetToolDirty();
  resetToolReaps();
  vi.useRealTimers();
});

describe('toolReapBlocker', () => {
  it('admits a running Tool that declared dehydrate, whether its state is clean or unreported', () => {
    const lath = servingTool();
    expect(toolReapBlocker(ID, lath.getMeta(ID)?.params)).toBeNull();
    recordToolDirty(ID, false);
    expect(toolReapBlocker(ID, lath.getMeta(ID)?.params)).toBeNull();
  });

  it('never admits clean or unknown state alone: the Tool must declare itself', () => {
    const lath = servingTool();
    announce({ dehydrate: false });
    recordToolDirty(ID, false);
    expect(toolReapBlocker(ID, lath.getMeta(ID)?.params)).toMatch(/never declared/);
  });

  it('refuses unsaved changes and persist: never even when dehydrate is declared', () => {
    const lath = servingTool();
    recordToolDirty(ID, true);
    expect(toolReapBlocker(ID, lath.getMeta(ID)?.params)).toMatch(/unsaved/);
    recordToolDirty(ID, null);
    announce({ persist: 'never' });
    expect(toolReapBlocker(ID, lath.getMeta(ID)?.params)).toMatch(/persist: never/);
  });

  it('refuses a Tool whose browser is popped out, which is in sight in its own window', () => {
    const lath = servingTool({ renderMode: 'agent-browser-popout' });
    expect(toolReapBlocker(ID, lath.getMeta(ID)?.params)).toMatch(/popped out/);
  });

  it('refuses a preview slot, and a command other than the designated one', () => {
    const slot = servingTool({ toolPreview: true });
    expect(toolReapBlocker(ID, slot.getMeta(ID)?.params)).toMatch(/preview/);
    const lath = servingTool();
    startRun('ls');
    announce();
    expect(toolReapBlocker(ID, lath.getMeta(ID)?.params)).toMatch(/not running/);
  });
});

describe('stopTool', () => {
  it('interrupts, keeps the payload emitted on the way out, then kills the PTY', async () => {
    const lath = servingTool();
    // Emitted before the stop: not the run's word on how to restore it.
    emit(`\x1b]367;dehydrate;{"v":1,"state":"early"}\x07`);
    const silenced = vi.spyOn(fake, 'alertSilenceRun');
    const stopped = stopTool(lath, ID);
    // Before the interrupt: the stop's own exit is no news, never a ring or a push.
    expect(silenced).toHaveBeenCalledWith(ID);
    expect(writes).toEqual(['\x03']);
    expect(isToolStopping(ID)).toBe(true);
    emit(`\x1b]367;dehydrate;${PAYLOAD}\x07`);
    applyTerminalSemanticEvents(ID, [{ type: 'commandFinish', exitCode: 130 }]);
    await vi.advanceTimersByTimeAsync(200);
    expect(await stopped).toBe(true);
    expect(kills).toEqual([ID]);
    expect(getToolReap(ID)).toEqual({ payload: PAYLOAD, cwd: '/repo', alert: expect.anything() });
    expect(registry.get(ID)).toMatchObject({ exited: true, dormant: true });
    // The run is over: its announcement no longer speaks for the Session.
    expect(getToolAnnounce(ID)).toBeNull();
  });

  it('kills a Tool that ignores the interrupt after the grace, keeping no payload', async () => {
    const lath = servingTool();
    const stopped = stopTool(lath, ID);
    await vi.advanceTimersByTimeAsync(TOOL_STOP_GRACE_MS - 200);
    expect(kills).toEqual([]);
    await finishStop();
    expect(await stopped).toBe(true);
    expect(kills).toEqual([ID]);
    expect(getToolReap(ID)?.payload).toBeNull();
  });

  it('never reconstructs a payload from replay', async () => {
    const lath = servingTool();
    const stopped = stopTool(lath, ID);
    recordToolEvents(ID, new TerminalProtocolParser().process(`\x1b]367;dehydrate;${PAYLOAD}\x07`).events);
    await finishStop();
    await stopped;
    expect(getToolReap(ID)?.payload).toBeNull();
  });

  it('leaves a Tool closed mid-stop to its closure', async () => {
    const lath = servingTool();
    const stopped = stopTool(lath, ID);
    disposeSession(ID);
    await finishStop();
    expect(await stopped).toBe(false);
    expect(isToolReaped(ID)).toBe(false);
  });

  it('stops nothing that is not eligible', async () => {
    const lath = servingTool();
    announce({ dehydrate: false });
    expect(await stopTool(lath, ID)).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('rehydrateTool', () => {
  async function reaped(params: Record<string, unknown> = {}, payload: string | null = PAYLOAD) {
    const lath = servingTool(params);
    const stopped = stopTool(lath, ID);
    if (payload) emit(`\x1b]367;dehydrate;${payload}\x07`);
    applyTerminalSemanticEvents(ID, [{ type: 'commandFinish', exitCode: 130 }]);
    await finishStop();
    await stopped;
    writes = [];
    return lath;
  }

  /** The fresh shell's first integrated prompt, which the command waits for. */
  async function prompt(): Promise<void> {
    applyTerminalSemanticEvents(ID, [{ type: 'promptStart' }]);
    await vi.advanceTimersByTimeAsync(200);
  }

  it('spawns a fresh shell with the payload, in the run directory, and types the command at its prompt', async () => {
    const lath = await reaped();
    expect(rehydrateTool(lath, ID)).toBe(true);
    expect(spawns.at(-1)).toMatchObject({ dehydrate: PAYLOAD, cwd: '/repo' });
    expect(registry.get(ID)).toMatchObject({ exited: false, dormant: false });
    await prompt();
    expect(writes).toEqual([`${COMMAND}\r`]);
    // One rehydrate per reap: the payload goes to one run alone.
    expect(isToolReaped(ID)).toBe(false);
    expect(rehydrateTool(lath, ID)).toBe(false);
  });

  it('starts from bare args when no payload was captured', async () => {
    const lath = await reaped({}, null);
    rehydrateTool(lath, ID);
    expect(spawns.at(-1)?.dehydrate).toBeUndefined();
  });

  it('re-quotes an argument-list command for the shell it gets', async () => {
    const lath = await reaped({ toolArgv: ['viewer', 'a b.md'] });
    // A Tool saved with another shell's quoting.
    lath.store.updateParams(ID, { command: 'viewer "a b.md"' });
    rehydrateTool(lath, ID);
    expect(lath.getMeta(ID)?.params?.command).toBe("viewer 'a b.md'");
  });

  describe('the bare-args tier', () => {
    async function rehydratedRun(exitCode: number, announced: boolean) {
      const lath = await reaped();
      rehydrateTool(lath, ID);
      await prompt();
      writes = [];
      startRun();
      if (announced) announce();
      applyTerminalSemanticEvents(ID, [{ type: 'commandFinish', exitCode }]);
      return lath;
    }

    it('types the command once more when the dehydrated run fails before announcing', async () => {
      await rehydratedRun(1, false);
      expect(writes).toEqual([`${COMMAND}\r`]);
      // Once: the bare run failing too is the error tier.
      startRun();
      applyTerminalSemanticEvents(ID, [{ type: 'commandFinish', exitCode: 1 }]);
      expect(writes).toEqual([`${COMMAND}\r`]);
    });

    it('leaves a run that announced, or exited cleanly, alone', async () => {
      await rehydratedRun(1, true);
      expect(writes).toEqual([]);
      disposeSession(ID);
      resetToolReaps();
      await rehydratedRun(0, false);
      expect(writes).toEqual([]);
    });
  });
});

it('keeps the Session state a reap does not end: the rename and the cwd', async () => {
  const lath = servingTool();
  applyTerminalSemanticEvents(ID, [{ type: 'title', title: { title: 'Docs', source: 'user', updatedAt: 1 } }]);
  markToolReaped(ID, { payload: null, cwd: '/repo', alert: null });
  rehydrateTool(lath, ID);
  expect(getTerminalPaneState(ID).titleCandidates.user?.title).toBe('Docs');
  expect(getTerminalPaneState(ID).cwd?.path).toBe('/repo');
});
