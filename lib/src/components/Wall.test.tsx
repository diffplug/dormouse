/**
 * @vitest-environment jsdom
 *
 * Integration smoke for the Wall on the Lath engine: it renders panes through
 * LathHost, splits/kills through the engine, and persists the Lath layout on save.
 * jsdom has no real layout, so this asserts structure (leaf count, save shape), not
 * geometry — the acceptance matrix in tiling-engine.md is the live gate.
 */
import { act } from 'react';
import { type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { sessionForKey } from 'dor-lib-common/agent-browser';
import { Wall } from './Wall';
import * as helpers from '../lib/helper-terminal';
import * as agentBrowserScreen from './wall/agent-browser-screen';
import { getAgentBrowserScreenController } from './wall/agent-browser-screen';
import { getAgentBrowserSurfaceController } from './wall/agent-browser-surface-controller';
import * as browserAutomation from './wall/browser-automation';
import { setDevServerResolution } from './wall/agent-browser-ports';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import type { PlatformAdapter } from '../lib/platform/types';
import type { PersistedSession } from '../lib/session-types';
import * as terminalRegistry from '../lib/terminal-registry';
import { UNNAMED_PANEL_TITLE } from '../lib/terminal-registry';
import { pendingShellOpts } from '../lib/terminal-store';
import { __resetArchiveServiceForTests } from '../lib/notepad/archive-service';
import { addPlainNote, beginClosing, clearAllNotepads, getNotes, setOpenNotepadId } from '../lib/notepad/notepad-store';
import type { NotepadArchiveV1 } from '../lib/notepad/types';
import { createTerminalPaneState, type TerminalPaneState } from '../lib/terminal-state';
import { getWallHandle, listWallHandles } from './wall/wall-handles';
import { mountWallHarness, type WallHarness } from './wall/wall-test-utils';
import { DEFAULT_WORKSPACE_ID } from '../lib/session-types';
import { clearTerminalActivity, setTerminalActivity } from '../lib/session-activity-store';
import { createAlertEpisode } from '../lib/alert-episode';
import { resetTerminalPaneState } from '../lib/terminal-state-store';
import { setWindowLabel } from '../lib/workspace-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The real registry + fake platform are used; only the xterm-heavy TerminalPane is
// stubbed so panes mount cheaply. TerminalPanel still runs usePaneChrome (registering
// the leaf element) and renders this stub inside its animation div.
vi.mock('./TerminalPane', () => ({
  // `isFocused` is the Wall's focus decision for a pane (mode === 'passthrough' &&
  // selected) — the real component turns it into an xterm `.focus()`. Reflect it as
  // a data attribute so focus-transfer tests can assert on it without a live xterm.
  TerminalPane: ({ id, isFocused }: { id: string; isFocused?: boolean }) => (
    <div data-testid="terminal-pane" data-session-id={id} data-focused={isFocused ? 'true' : 'false'} />
  ),
}));

let harness: WallHarness;
let container: HTMLDivElement;
let root: Root;
let fake: FakePtyAdapter;

function leafCount(): number {
  return container.querySelectorAll('[data-lath-leaf]').length;
}

beforeEach(() => {
  __resetArchiveServiceForTests();
  clearAllNotepads();
  fake = new FakePtyAdapter();
  setPlatform(fake);
  harness = mountWallHarness();
  ({ container, root } = harness);
});

afterEach(() => {
  harness.dispose();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  __resetArchiveServiceForTests();
  clearAllNotepads();
  // The activity store is Window-global, so a ring or TODO left on a pane id
  // would wear its alarm overlay in every later test that renders that id.
  clearTerminalActivity();
});

const flush = (): Promise<void> => harness.flush();

/** Wait out the host's own 100ms state polls (a tool taking over a pane, a
 *  split waiting on OSC 633), which no event can flush. Throws on timeout. */
const waitUntil = (ready: () => boolean): Promise<void> => vi.waitFor(async () => {
  await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
  expect(ready()).toBe(true);
}, { timeout: 2_000, interval: 25 });

/** The host's answer for an approved `storybook` tool. */
const okToolLookup = (key: string[] | null) => ({
  status: 'ok' as const,
  projectRoot: '/repo',
  path: '/repo/dormouse.yml',
  name: 'storybook',
  run: 'pnpm storybook',
  render: 'iframe' as const,
  port: 'announced' as const,
  key,
  warnings: [],
});

/** The integrated shell in `id` reports `line` as its running command. */
const reportRunning = (id: string, line: string): void => terminalRegistry.applyTerminalSemanticEvents(id, [
  { type: 'commandLine', commandLine: line },
  { type: 'commandStart', source: 'osc633_boundaries' },
]);

/** The shell in `id` is back at its prompt. */
const promptBack = (id: string): void => terminalRegistry.applyTerminalSemanticEvents(id, [{ type: 'promptStart' }]);

async function flushFrame(): Promise<void> {
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });
}

describe('Wall on the Lath engine', () => {
  /** The alarm treatment is the leaf overlay, so it must reach a ringing terminal
   *  through the engine's overlay slot and leave a quiet neighbour alone. */
  it('mounts the alarm overlay on a ringing terminal leaf', async () => {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} />));
    await flush();
    expect(container.querySelector('[data-alert-ring-state]')).toBeNull();

    await act(async () => { setTerminalActivity('pane-a', { status: 'ALERT_RINGING', episode: createAlertEpisode() }); });

    const overlays = container.querySelectorAll('[data-alert-ring-state="ringing"]');
    expect(overlays).toHaveLength(1);
    const leaf = overlays[0].closest('[data-lath-leaf]');
    expect(leaf?.querySelector('[data-session-id]')?.getAttribute('data-session-id')).toBe('pane-a');
  });

  it('releases input during context exit, cancels stale removal on reopen, and skips exit for reduced motion', async () => {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" />));
    await flush();
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = query => ({ ...originalMatchMedia(query), matches: false });
    vi.useFakeTimers();
    try {
      const header = container.querySelector<HTMLElement>('[data-pane-header-for="pane-a"]')!;
      const open = () => act(async () => { header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 })); });
      const close = () => act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Close terminal context"]')!.click(); });
      await open();
      const menu = container.querySelector<HTMLElement>('[data-terminal-context]')!;
      await close();
      expect(menu.isConnected).toBe(true);
      expect(menu.hasAttribute('inert')).toBe(true);
      expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('true');
      await act(async () => vi.advanceTimersByTime(100));
      await open();
      expect(menu.hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(menu);
      await act(async () => vi.advanceTimersByTime(200));
      expect(menu.isConnected).toBe(true);
      await close();
      await act(async () => vi.advanceTimersByTime(180));
      expect(menu.isConnected).toBe(false);
      window.matchMedia = originalMatchMedia;
      await open();
      await close();
      expect(container.querySelector('[data-terminal-context]')).toBeNull();
    } finally {
      window.matchMedia = originalMatchMedia;
      vi.useRealTimers();
    }
  });

  it('cancels an ensure restart before a late prompt can relaunch its command', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    const cwd = { path: '/repo', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } as const;
    let state: TerminalPaneState = createTerminalPaneState({
      cwd,
      currentCommand: {
        id: 'run-1', rawCommandLine: 'pnpm dev', displayCommand: 'pnpm dev',
        cwdAtStart: cwd, startedAt: 0, source: 'osc633_E',
      },
    });
    const stateSpy = vi.spyOn(terminalRegistry, 'getTerminalPaneState').mockImplementation(() => state);
    const integratedSpy = vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(true);
    const writeSpy = vi.spyOn(fake, 'writePty');
    const controller = new AbortController();
    const respond = vi.fn();
    vi.useFakeTimers();
    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.ensure,
            params: { command: ['pnpm', 'dev'], cwd: '/repo', restart: true },
            signal: controller.signal,
            respond,
          },
        }));
      });
      expect(writeSpy).toHaveBeenCalledWith('pane-a', '\x03');
      expect(respond).not.toHaveBeenCalled();
      await act(async () => { controller.abort(); });
      expect(respond).toHaveBeenCalledWith({ ok: false, error: "surface 'surface:1' restart was cancelled" });
      state = createTerminalPaneState({ cwd });
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(writeSpy.mock.calls).toEqual([['pane-a', '\x03']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels an ensure restart even when the prompt is already back before the wait', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    const cwd = { path: '/repo', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } as const;
    let state: TerminalPaneState = createTerminalPaneState({
      cwd,
      currentCommand: {
        id: 'run-1', rawCommandLine: 'pnpm dev', displayCommand: 'pnpm dev',
        cwdAtStart: cwd, startedAt: 0, source: 'osc633_E',
      },
    });
    vi.spyOn(terminalRegistry, 'getTerminalPaneState').mockImplementation(() => state);
    vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(true);
    const controller = new AbortController();
    // The interrupt lands on a prompt synchronously, so the wait resolves without
    // polling; the cancel is queued ahead of that resolution's continuation.
    const writeSpy = vi.spyOn(fake, 'writePty').mockImplementation((_id, data) => {
      if (data !== '\x03') return;
      state = createTerminalPaneState({ cwd });
      queueMicrotask(() => controller.abort());
    });
    const respond = vi.fn();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.ensure,
          params: { command: ['pnpm', 'dev'], cwd: '/repo', restart: true },
          signal: controller.signal,
          respond,
        },
      }));
    });
    expect(respond).toHaveBeenCalledWith({ ok: false, error: "surface 'surface:1' restart was cancelled" });
    expect(writeSpy.mock.calls).toEqual([['pane-a', '\x03']]);
  });

  it('removes an unintegrated ensure split as soon as its client cancels', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(false);
    vi.spyOn(terminalRegistry, 'getDefaultShellOpts').mockReturnValue({ shell: '/bin/bash' });
    const controller = new AbortController();
    const respond = vi.fn();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.ensure,
          params: { command: ['pnpm', 'dev'], cwd: '/repo', surface: 'surface:1' },
          signal: controller.signal,
          respond,
        },
      }));
    });
    expect(leafCount()).toBe(2);
    expect(respond).not.toHaveBeenCalled();
    await act(async () => { controller.abort(); });
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'ensure was cancelled' });
    await flush();
    expect(leafCount()).toBe(1);
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
  });

  it('reuses a running Surface while another archive caller holds its notes freeze', async () => {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
    await flush();
    const cwd = { path: '/repo', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } as const;
    vi.spyOn(terminalRegistry, 'getTerminalPaneState').mockReturnValue(createTerminalPaneState({
      cwd,
      currentCommand: { id: 'run', rawCommandLine: 'pnpm dev', displayCommand: 'pnpm dev', cwdAtStart: cwd, startedAt: 0, source: 'osc633_E' },
    }));
    const release = beginClosing(['pane-a']);
    const respond = vi.fn();
    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
          method: SURFACE_CONTROL_METHODS.ensure, params: { command: ['pnpm', 'dev'], cwd: '/repo' }, respond,
        } }));
      });
      expect(respond).toHaveBeenCalledWith({ ok: true, result: expect.objectContaining({ status: 'existing', surfaceId: 'pane-a' }) });
      expect(leafCount()).toBe(1);
    } finally { release(); }
  });

  it('does not reuse a running Surface while its own close is archiving', async () => {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
    await flush();
    const cwd = { path: '/repo', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } as const;
    vi.spyOn(terminalRegistry, 'getTerminalPaneState').mockReturnValue(createTerminalPaneState({
      cwd,
      currentCommand: { id: 'run', rawCommandLine: 'pnpm dev', displayCommand: 'pnpm dev', cwdAtStart: cwd, startedAt: 0, source: 'osc633_E' },
    }));
    vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(true);
    act(() => { addPlainNote('pane-a', 'keep this note'); });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saveOriginal = fake.notepadArchive.save.bind(fake.notepadArchive);
    const save = vi.spyOn(fake.notepadArchive, 'save').mockImplementation(async (...args) => { await gate; return saveOriginal(...args); });
    const killed = vi.fn();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.kill, params: { surface: 'surface:1', confirmation: { mode: 'dangerously' } }, respond: killed,
      } }));
    });
    await flush();
    expect(save).toHaveBeenCalled();
    const respond = vi.fn();
    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
          method: SURFACE_CONTROL_METHODS.ensure, params: { command: ['pnpm', 'dev'], cwd: '/repo' }, respond,
        } }));
      });
      expect(respond).toHaveBeenCalledWith({ ok: true, result: expect.objectContaining({ status: 'created' }) });
      expect(killed).not.toHaveBeenCalled();
    } finally { release(); await flush(); }
    expect(killed).toHaveBeenCalledWith({ ok: true, result: expect.objectContaining({ status: 'killed', surfaceId: 'pane-a' }) });
  });

  it.each([false, true])('preserves notes entered in a cancelled ensure pane (archive fails: %s)', async fails => {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
    await flush();
    vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(false);
    vi.spyOn(terminalRegistry, 'getDefaultShellOpts').mockReturnValue({ shell: '/bin/bash' });
    const controller = new AbortController();
    const respond = vi.fn();
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.ensure, params: { command: ['pnpm', 'dev'], cwd: '/repo', surface: 'surface:1' }, signal: controller.signal, respond,
      } }));
    });
    const temporaryId = Array.from(container.querySelectorAll('[data-lath-leaf]')).map(el => el.getAttribute('data-lath-leaf')!).find(id => id !== 'pane-a')!;
    expect(temporaryId).toBeTruthy();
    act(() => { addPlainNote(temporaryId, 'written while integration is pending'); });
    if (fails) vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk full'));
    await act(async () => controller.abort());
    await flush();
    if (fails) {
      expect(respond).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining('temporary surface kept open: notepad archive failed: disk full') });
      expect(getNotes(temporaryId)).toHaveLength(1);
      expect(container.querySelector(`[data-lath-leaf="${temporaryId}"]`)).not.toBeNull();
    } else {
      expect(respond).toHaveBeenCalledWith({ ok: false, error: 'ensure was cancelled' });
      expect(container.querySelector(`[data-lath-leaf="${temporaryId}"]`)).toBeNull();
      const archive = (await fake.notepadArchive.load())?.raw as NotepadArchiveV1;
      expect(archive.batches.flatMap(batch => batch.notes)).toEqual([expect.objectContaining({ content: { kind: 'plain', text: 'written while integration is pending' } })]);
      expect(getNotes(temporaryId)).toEqual([]);
    }
  });

  it('renders a pane through LathHost, splits via wallActions, kills, and persists the Lath layout on save', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    // 1. A pane renders through LathHost (the stable Lath leaf div).
    expect(container.querySelector('.lath-host')).not.toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(leafCount()).toBe(1);

    // 2. A split via wallActions (keyboard `|` → onSplitH → addSplitPanel) adds a leaf.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true }));
    });
    await flush();
    expect(leafCount()).toBe(2);
    const focusedAfterSplit = Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]'))
      .filter((el) => el.dataset.focused === 'true');
    expect(focusedAfterSplit).toHaveLength(1);
    expect(focusedAfterSplit[0].dataset.sessionId).not.toBe('pane-a');

    // 3. Kill the second surface (dor kill, dangerously) → back to one leaf.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface: 'surface:2', confirmation: { mode: 'dangerously' } },
          respond: () => {},
        },
      }));
    });
    await flush();
    expect(leafCount()).toBe(1);

    // 4. A save (flushed via pagehide) writes the Lath layout only (no legacy
    //    dockview `layout` key).
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await flush();
    await flush();

    const saved = fake.getState() as { version?: number; lathLayout?: { version?: number; leafMeta?: Record<string, unknown> } } | null;
    expect(saved).not.toBeNull();
    expect(saved!.version).toBe(3);
    expect(saved!.lathLayout).toBeDefined();
    expect(saved!.lathLayout!.version).toBe(1);
    // The surviving pane is present in the Lath layout's leaf meta.
    expect(Object.keys(saved!.lathLayout!.leafMeta ?? {})).toContain('pane-a');
  });

  it('manual keyboard splits enter passthrough on the new pane immediately', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" onEvent={onEvent} />);
    });
    await flush();
    onEvent.mockClear();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true }));
    });
    await flush();

    const panes = Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]'));
    const newPane = panes.find((pane) => pane.dataset.sessionId !== 'pane-a');
    expect(newPane?.dataset.focused).toBe('true');
    expect(panes.find((pane) => pane.dataset.sessionId === 'pane-a')?.dataset.focused).toBe('false');
    expect(onEvent).toHaveBeenCalledWith({ type: 'modeChange', mode: 'passthrough' });
    expect(onEvent).toHaveBeenCalledWith({ type: 'selectionChange', id: newPane?.dataset.sessionId, kind: 'pane' });
  });

  it('host New Terminal actions enter passthrough on the spawned pane', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
        detail: { shell: '/bin/zsh', name: 'zsh' },
      }));
    });
    await flush();

    const panes = Array.from(container.querySelectorAll<HTMLElement>('[data-session-id]'));
    const newPane = panes.find((pane) => pane.dataset.sessionId !== 'pane-a');
    expect(newPane?.dataset.focused).toBe('true');
    expect(panes.find((pane) => pane.dataset.sessionId === 'pane-a')?.dataset.focused).toBe('false');
  });

  it('retires a killed surface ref instead of reusing its number, and persists the counter', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    // Split → the new pane gets surface:2.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true }));
    });
    await flush();

    // Kill surface:2 → its ref is retired, not recycled.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface: 'surface:2', confirmation: { mode: 'dangerously' } },
          respond: () => {},
        },
      }));
    });
    await flush();

    // Manual split entered passthrough; return to command mode before splitting
    // again. The fresh pane must be surface:3, never a reused surface:2.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 1, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 2, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true }));
    });
    await flush();

    let listed: { result?: { surfaces: Array<{ ref: string }> } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.list,
          params: {},
          respond: (r: { result?: { surfaces: Array<{ ref: string }> } }) => { listed = r; },
        },
      }));
    });
    await flush();
    expect(listed?.result?.surfaces.map((s) => s.ref)).toEqual(['surface:1', 'surface:3']);

    // The save drops the killed surface:2 entry but keeps the counter past it, so a
    // later restore still can't hand surface:2 to a different Surface.
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await flush();
    await flush();

    const saved = fake.getState() as { surfaceRefs?: Record<string, string>; surfaceRefsNext?: number } | null;
    expect(Object.values(saved!.surfaceRefs ?? {})).toEqual(['surface:1', 'surface:3']);
    expect(saved!.surfaceRefsNext).toBe(4);
  });

  // The gate on `binaryPath` drops rather than refuses, like every other one in
  // this class: the host resolves its own candidate, and it can accept a path
  // this realm cannot (`DORMOUSE_AGENT_BROWSER_BIN` matches by exact value, and
  // only the host reads its own environment).
  it('drops a binaryPath that is not an agent-browser without failing the request', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    let response: { ok: boolean; error?: string; result?: { surfaceId: string } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.agentBrowser,
          params: { session: 'dormouse.1.gate', binaryPath: '/usr/bin/curl' },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();

    // The surface opens; the path simply does not travel with it.
    expect(response?.ok).toBe(true);
    expect(response?.error).toBeUndefined();
    expect(response?.result?.surfaceId).toBeTruthy();
  });

  // The control socket is a wire protocol, not the CLI: `dor iframe` validates
  // its argument, but anything holding the control token reaches this method
  // directly — and on a host with no iframe proxy the value becomes a raw
  // `<iframe src>`, where `javascript:` runs in the app's own origin.
  it('refuses a surface.iframe url that is not http(s)', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'vscode-webview://x/']) {
      let response: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.iframe,
            params: { url },
            respond: (r: typeof response) => { response = r; },
          },
        }));
      });
      await flush();
      expect(response).toEqual({ ok: false, error: 'url must be an http:// or https:// URL' });
    }
  });

  it('preserves the surface ref when an iframe replaces an untouched terminal', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      let response: {
        ok: boolean;
        error?: string;
        result?: { status: string; surfaceId: string; surfaceRef: string };
      } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.iframe,
            params: { url: 'http://localhost:5173/' },
            respond: (r: typeof response) => { response = r; },
          },
        }));
      });
      await flush();

      expect(response?.ok).toBe(true);
      expect(response?.error).toBeUndefined();
      expect(response?.result?.status).toBe('replaced');
      expect(response?.result?.surfaceRef).toBe('surface:1');
      const newId = response!.result!.surfaceId;
      expect(newId).not.toBe('pane-a');

      let listed: { result?: { surfaces: Array<{ id: string; ref: string }> } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.list,
            params: {},
            respond: (r: typeof listed) => { listed = r; },
          },
        }));
      });
      await flush();
      expect(listed?.result?.surfaces.map((surface) => [surface.id, surface.ref])).toEqual([[newId, 'surface:1']]);

      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flush();
      await flush();

      const saved = fake.getState() as { surfaceRefs?: Record<string, string>; surfaceRefsNext?: number } | null;
      expect(saved!.surfaceRefs).toEqual({ [newId]: 'surface:1' });
      expect(saved!.surfaceRefsNext).toBe(2);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('validates a dor await and parks it on the host alert manager', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    // These hand-built events carry no `signal`, like every other control request
    // in this file — the await handler has to tolerate that.
    type AwaitResult = { ok: boolean; error?: string; result?: Record<string, unknown> };
    const request = (params: Record<string, unknown>): Promise<AwaitResult> => new Promise((resolve) => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.await,
          params,
          respond: (r: AwaitResult) => resolve(r),
        },
      }));
    });

    // The wake condition and the ceiling are both rejected before anything parks.
    let invalidUntil: AwaitResult | undefined;
    await act(async () => { invalidUntil = await request({ surface: 'surface:1', until: 'soon', timeoutMs: 5 }); });
    expect(invalidUntil).toEqual({ ok: false, error: "invalid await condition 'soon'" });

    const ceilingError = 'timeoutMs must be a positive number no greater than 86400000';

    let noCeiling: AwaitResult | undefined;
    await act(async () => { noCeiling = await request({ surface: 'surface:1', until: 'quiet' }); });
    expect(noCeiling).toEqual({ ok: false, error: ceilingError });

    // Above the 24h cap the ceiling would overflow `setTimeout`'s signed 32-bit
    // delay and fire at once, so it is refused rather than silently instant.
    let hugeCeiling: AwaitResult | undefined;
    await act(async () => { hugeCeiling = await request({ surface: 'surface:1', until: 'quiet', timeoutMs: 3_000_000_000 }); });
    expect(hugeCeiling).toEqual({ ok: false, error: ceilingError });

    // A real park against the fake adapter's AlertManager. Nothing is running, so
    // the 5ms ceiling beats the 2s grace window and the host reports `timeout` —
    // with its own measurement of the wait, which the handler passes through.
    let timedOut: AwaitResult | undefined;
    await act(async () => { timedOut = await request({ surface: 'surface:1', until: 'quiet', timeoutMs: 5 }); });
    expect(timedOut?.ok).toBe(true);
    expect(timedOut?.result).toMatchObject({
      workspaceRef: 'workspace:1',
      surfaceRef: 'surface:1',
      outcome: 'timeout',
    });
    expect(timedOut?.result?.cause).toBeUndefined();
    expect(typeof timedOut?.result?.waitedMs).toBe('number');
  });

  it('parks a minimized browser surface so its DOM survives, and unparks it on kill', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      const surfaceId = (await dispatchIframe('http://localhost:5173/')).id;
      const leaf0 = container.querySelector(`[data-lath-leaf="${surfaceId}"]`);
      expect(leaf0).toBeTruthy();

      const minimize = leaf0!.querySelector<HTMLElement>('[aria-label="Minimize"]');
      expect(minimize).toBeTruthy();
      await act(async () => { minimize!.click(); });
      await flush();

      // Minimized, but NOT unmounted: the same node stays in place with its document
      // (an <iframe>'s state) intact, which is the whole reason browser Surfaces park
      // instead of being removed (docs/specs/tiling-engine.md → "Parked leaves").
      const parked = container.querySelector(`[data-lath-leaf="${surfaceId}"]`);
      expect(parked).toBe(leaf0);
      expect((parked as HTMLElement).dataset.lathParked).toBe('');
      // It is a door now, so it is not a visible pane.
      expect(container.querySelectorAll('[data-lath-leaf]:not([data-lath-parked])').length).toBe(1);
      const door = container.querySelector<HTMLElement>(`[data-door-id="${surfaceId}"]`);
      expect(door?.textContent).toContain('localhost:5173');
      expect(door?.textContent).not.toContain('<idle>');
      expect(door?.querySelector('[data-browser-display-mode="iframe"]')).not.toBeNull();

      // Killing the door releases the Surface for real — the parked DOM goes with it.
      expect((await dispatchKill(surfaceId))?.ok).toBe(true);
      expect(container.querySelector(`[data-lath-leaf="${surfaceId}"]`)).toBeNull();
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('keeps a Playwright key on its session when no viewer can attach to the browser it opened', async () => {
    const playwright = vi.fn(async () => ({ ok: false, error: 'Dormouse currently views Chromium Playwright sessions only. The native CLI command still ran.' }));
    Object.assign(fake, { playwright });
    await act(async () => { root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />); });
    await flush();
    const control = async (method: string, params: Record<string, unknown>) => {
      let response: { ok: boolean; result?: { binding?: { session: string; cwd?: string } | null } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: { method, params, surfaceId: 'pane-a', respond: (r: typeof response) => { response = r; } },
        }));
      });
      await flush();
      return response;
    };
    // `dor pw --key app open --browser=firefox :5173`: resolve, run natively, bind.
    const first = (await control(SURFACE_CONTROL_METHODS.resolveBrowser, { provider: 'playwright', key: 'app', proposed: { cwd: '/project' } }))?.result?.binding;
    expect(first).toMatchObject({ cwd: '/project' });
    expect((await control(SURFACE_CONTROL_METHODS.browser, { provider: 'playwright', key: 'app', session: first!.session, cwd: '/project' }))?.ok).toBe(false);

    // Past the two minutes an unbound first launch is held for.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000);
    try {
      const later = (await control(SURFACE_CONTROL_METHODS.resolveBrowser, { provider: 'playwright', key: 'app', proposed: { cwd: '/elsewhere' } }))?.result?.binding;
      expect(later).toEqual(first);
    } finally {
      clock.mockRestore();
    }
  });

  it('reveals a restored context-port browser instead of opening a second', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    const helperSpy = vi.spyOn(helpers, 'openHelper').mockResolvedValue({ id: 'context-helper', parentId: 'pane-a', command: '', status: 'preserved' });
    const open = vi.fn(async () => ({ ok: true, session: 'second', wsPort: 1 }));
    Object.assign(fake, {
      agentBrowserOpen: open,
      agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    try {
      // The key a pre-Playwright build persisted for this port's agent-browser pane.
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" initialDoors={[{
          id: 'restored-ab', title: 'localhost:5173', component: 'browser', tabComponent: 'surface',
          params: { surfaceType: 'browser', renderMode: 'ab-screencast', session: 'restored', url: 'http://localhost:5173/', contextPortKey: 'pane-a:5173:agent' },
        }]} />);
      });
      await flush();
      if (!fake.hasPty('pane-a')) fake.spawnPty('pane-a');
      fake.setOpenPorts('pane-a', [{ protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port: 5173, pid: 100, processName: 'vite' }]);
      await act(async () => {
        container.querySelector<HTMLElement>('[data-pane-header-for="pane-a"]')!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 10, clientY: 10,
        }));
      });
      await flush();
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-terminal-context] button[aria-label="Open in agent-browser screencast"]')!.click();
      });
      await flush();

      expect(open).not.toHaveBeenCalled();
      expect(container.querySelector('[data-lath-leaf="restored-ab"]')).not.toBeNull();
      expect(leafCount()).toBe(2);
    } finally {
      helperSpy.mockRestore();
      untouchedSpy.mockRestore();
    }
  });

  it('names Playwright when a context-menu Playwright launch fails', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    // The mocked TerminalPane registers no terminal, so the helper would report
    // its parent closed — the one alert the context shows ahead of a port error.
    const helperSpy = vi.spyOn(helpers, 'openHelper').mockResolvedValue({ id: 'context-helper', parentId: 'pane-a', command: '', status: 'preserved' });
    // A launch the host answers without a session or a reason of its own.
    const playwright = vi.fn(async () => ({ ok: false }));
    Object.assign(fake, { playwright, agentBrowserOpen: vi.fn(async () => ({ ok: true, session: 'ab', wsPort: 1 })) });
    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      if (!fake.hasPty('pane-a')) fake.spawnPty('pane-a');
      fake.setOpenPorts('pane-a', [{ protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port: 5173, pid: 100, processName: 'vite' }]);
      await act(async () => {
        container.querySelector<HTMLElement>('[data-pane-header-for="pane-a"]')!.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, clientX: 10, clientY: 10,
        }));
      });
      await flush();
      await act(async () => {
        document.querySelector<HTMLButtonElement>('[data-terminal-context] button[aria-label="Open in Playwright screencast"]')!.click();
      });
      await flush();

      expect(playwright).toHaveBeenCalledWith(expect.objectContaining({ op: 'open', url: 'http://localhost:5173/' }));
      expect(document.querySelector('[data-terminal-context] [role="alert"]')?.textContent).toBe('Could not open Playwright');
    } finally {
      helperSpy.mockRestore();
      untouchedSpy.mockRestore();
    }
  });

  it('reuses and closes a parked browser that gains its session after minimization', async () => {
    const defaultSession = sessionForKey('default');
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    let resolveOpen!: (result: { ok: boolean; session: string; wsPort: number }) => void;
    const openResult = new Promise<{ ok: boolean; session: string; wsPort: number }>((resolve) => {
      resolveOpen = resolve;
    });
    const agentBrowserCommand = vi.fn(async (_session: string, args: string[]) => {
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    (fake as PlatformAdapter).agentBrowserCommand = agentBrowserCommand;
    (fake as PlatformAdapter).agentBrowserOpen = vi.fn(() => openResult);
    (fake as PlatformAdapter).agentBrowserStreamStatus = vi.fn(async () => ({ ok: true, wsPort: 4321 }));

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      if (!fake.hasPty('pane-a')) fake.spawnPty('pane-a');
      fake.setOpenPorts('pane-a', [{
        protocol: 'tcp',
        family: 'IPv4',
        address: '127.0.0.1',
        port: 5173,
        pid: 100,
        processName: 'vite',
      }]);

      // The context-menu path creates an eager, session-less browser before its
      // asynchronous daemon boot completes.
      const header = container.querySelector<HTMLElement>('[data-pane-header-for="pane-a"]')!;
      await act(async () => {
        header.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }));
      });
      await flush();
      const portRow = document.querySelector<HTMLButtonElement>(
        '[data-terminal-context] button[aria-label="Open in agent-browser screencast"]',
      )!;
      await act(async () => { portRow.click(); });
      await flush();

      const browserLeaf = Array.from(container.querySelectorAll<HTMLElement>('[data-lath-leaf]'))
        .find((leaf) => leaf.dataset.lathLeaf !== 'pane-a')!;
      const browserId = browserLeaf.dataset.lathLeaf!;
      await act(async () => {
        browserLeaf.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click();
      });
      await flush();
      expect(container.querySelector(`[data-lath-leaf="${browserId}"]`)?.hasAttribute('data-lath-parked')).toBe(true);

      // Until the boot names it, `dor ab --surface` has nothing to drive.
      expect(await dispatchResolveAgentBrowser(browserId)).toEqual({
        ok: false,
        error: `surface 'surface:2' has no agent-browser session yet`,
      });

      // Boot completion writes `session` only to live parked metadata. The Door
      // record is intentionally still the session-less minimize-time snapshot.
      await act(async () => {
        resolveOpen({ ok: true, session: defaultSession, wsPort: 4321 });
        await openResult;
      });
      await flush();

      let reused: { ok: boolean; result?: { status: string; surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.agentBrowser,
            params: { session: defaultSession, surface: 'surface:1' },
            respond: (r: typeof reused) => { reused = r; },
          },
        }));
      });
      await flush();
      expect(reused).toMatchObject({ ok: true, result: { status: 'existing', surfaceId: browserId } });
      expect(container.querySelectorAll('[data-door-id]')).toHaveLength(1);

      expect((await dispatchKill(browserId))?.ok).toBe(true);
      expect(agentBrowserCommand).toHaveBeenCalledWith(defaultSession, ['close'], undefined);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('binds a minimized pane restored after a failed provider swap to a live controller', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    const pwOpen = Promise.withResolvers<{ ok: boolean; error?: string }>();
    const relaunch = vi.fn(async () => ({ ok: true, session: 'relaunched', wsPort: 4321 }));
    Object.assign(fake, {
      playwright: vi.fn((request: { op: string }) => request.op === 'open' ? pwOpen.promise : Promise.resolve({ ok: true })),
      agentBrowserOpen: relaunch,
      agentBrowserCommand: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    });
    try {
      await act(async () => {
        root.render(<Wall
          restoredLathLayout={{ version: 1, tree: { root: { kind: 'leaf', id: 'ab-pane' } }, leafMeta: {
            'ab-pane': { component: 'browser', tabComponent: 'surface', title: 'localhost:5173', params: {
              surfaceType: 'browser', renderMode: 'ab-screencast', session: 'ab-live', url: 'http://localhost:5173/',
            } },
          } }}
          initialMode="command"
        />);
      });
      await flush();
      await act(async () => { getAgentBrowserScreenController('ab-pane')?.actions.setRenderMode?.('pw-screencast'); });
      await flush();
      const eagerLeaf = container.querySelector<HTMLElement>('[data-lath-leaf]')!;
      const eagerId = eagerLeaf.dataset.lathLeaf!;
      expect(eagerId).not.toBe('ab-pane');
      await act(async () => { eagerLeaf.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click(); });
      await flush();

      // Playwright is not installed: the Door comes back as agent-browser.
      await act(async () => { pwOpen.resolve({ ok: false, error: 'playwright-cli is not installed' }); });
      await flush();
      expect(relaunch).toHaveBeenCalledWith('http://localhost:5173/', { headed: false }, undefined);
      expect(getAgentBrowserSurfaceController(eagerId)?.provider).toBe('agent-browser');
      expect(getAgentBrowserScreenController(eagerId)?.snapshot().renderMode).toBe('ab-screencast');
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('hands an eager render-swap session to a Surface minimized during launch', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    let resolveOpen!: (result: { ok: boolean; session?: string; wsPort?: number; binaryPath?: string }) => void;
    const openResult = new Promise<{ ok: boolean; session?: string; wsPort?: number; binaryPath?: string }>((resolve) => {
      resolveOpen = resolve;
    });
    (fake as PlatformAdapter).agentBrowserOpen = vi.fn(() => openResult);
    const agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    (fake as PlatformAdapter).agentBrowserCommand = agentBrowserCommand;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      const iframeId = (await dispatchIframe('http://localhost:5173/')).id;

      await act(async () => {
        getAgentBrowserScreenController(iframeId)?.actions.setRenderMode?.('ab-screencast');
      });
      await flush();
      const eagerLeaf = container.querySelector<HTMLElement>('[data-lath-leaf]')!;
      const eagerId = eagerLeaf.dataset.lathLeaf!;
      expect(eagerId).not.toBe(iframeId);

      await act(async () => {
        eagerLeaf.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click();
      });
      await flush();
      expect(container.querySelector(`[data-door-id="${eagerId}"]`)).not.toBeNull();

      await act(async () => {
        resolveOpen({ ok: true, session: 'dormouse.1.gui-minimized', wsPort: 4321, binaryPath: '/usr/bin/agent-browser' });
        await openResult;
      });
      await flush();

      expect(await dispatchResolveAgentBrowser(eagerId)).toEqual({
        ok: true,
        result: { surfaceId: eagerId, surfaceRef: 'surface:1', session: 'dormouse.1.gui-minimized' },
      });
      expect(agentBrowserCommand).not.toHaveBeenCalledWith(
        'dormouse.1.gui-minimized',
        ['close'],
        '/usr/bin/agent-browser',
      );
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('restores a minimized eager render swap to iframe when launch returns no session', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    let resolveOpen!: (result: { ok: boolean; error?: string }) => void;
    const openResult = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      resolveOpen = resolve;
    });
    (fake as PlatformAdapter).agentBrowserOpen = vi.fn(() => openResult);

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      const iframeId = (await dispatchIframe('http://localhost:5173/')).id;

      await act(async () => {
        getAgentBrowserScreenController(iframeId)?.actions.setRenderMode?.('ab-screencast');
      });
      await flush();
      const eagerLeaf = container.querySelector<HTMLElement>('[data-lath-leaf]')!;
      const eagerId = eagerLeaf.dataset.lathLeaf!;
      await act(async () => {
        eagerLeaf.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click();
      });
      await flush();

      await act(async () => {
        resolveOpen({ ok: false, error: 'launch failed' });
        await openResult;
      });
      await flush();

      expect(container.querySelector(`[data-door-id="${eagerId}"]`)).not.toBeNull();
      expect(await dispatchResolveAgentBrowser(eagerId)).toEqual({
        ok: false,
        error: "surface 'surface:1' is not agent-browser rendered (render_mode: iframe) — an iframe cannot be driven; open its page with dor ab open http://localhost:5173/",
      });
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('restores an eager render swap to iframe when launch rejects', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    (fake as PlatformAdapter).agentBrowserOpen = vi.fn(async () => {
      throw new Error('transport failed');
    });

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      const iframeId = (await dispatchIframe('http://localhost:5173/')).id;

      await act(async () => {
        getAgentBrowserScreenController(iframeId)?.actions.setRenderMode?.('ab-screencast');
      });
      await flush();

      const restoredId = container.querySelector<HTMLElement>('[data-lath-leaf]')!.dataset.lathLeaf!;
      expect(restoredId).not.toBe(iframeId);
      expect(getAgentBrowserScreenController(restoredId)?.snapshot().renderMode).toBe('iframe');
      expect(await dispatchResolveAgentBrowser('surface:1')).toEqual({
        ok: false,
        error: "surface 'surface:1' is not agent-browser rendered (render_mode: iframe) — an iframe cannot be driven; open its page with dor ab open http://localhost:5173/",
      });
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('never swaps a Tool to a render it cannot declare, even when one is offered', async () => {
    // The Display modal and both registration sites offer a Tool only `iframe`
    // and `ab-screencast`; offer everything here so the Wall's own guard is
    // what refuses. Written as `toolRender`, a Playwright mode launched nothing
    // and stranded the pane.
    const offered = vi.spyOn(browserAutomation, 'offeredRenderModes')
      .mockReturnValue(['ab-screencast', 'ab-popout', 'pw-screencast', 'pw-popout', 'iframe']);
    const playwright = vi.fn(async () => ({ ok: true, session: 'gui-pw', wsPort: 4321 }));
    const open = vi.fn(async () => ({ ok: true, session: 'gui-ab', wsPort: 4322 }));
    Object.assign(fake, { playwright, agentBrowserOpen: open, agentBrowserPopOut: vi.fn(async () => ({ ok: true })) });
    // Serving: a Tool whose command is not running retires its browser.
    terminalRegistry.applyTerminalSemanticEvents('tool-a', [
      { type: 'commandLine', commandLine: 'pnpm storybook' },
      { type: 'commandStart' },
    ]);
    try {
      await act(async () => {
        root.render(<Wall
          restoredLathLayout={{
            version: 1,
            tree: { root: { kind: 'leaf', id: 'tool-a' } },
            leafMeta: {
              'tool-a': {
                component: 'tool',
                tabComponent: 'tool',
                title: 'storybook',
                params: {
                  surfaceType: 'tool',
                  command: 'pnpm storybook',
                  cwd: '/repo',
                  toolName: 'storybook',
                  toolRender: 'iframe',
                  toolPort: 'announced',
                  renderMode: 'iframe',
                  url: 'http://localhost:6006/',
                },
              },
            },
          }}
          initialMode="command"
        />);
      });
      await flush();
      const controller = () => getAgentBrowserScreenController('tool-a');
      expect(controller()?.snapshot().renderMode).toBe('iframe');

      for (const mode of ['pw-screencast', 'pw-popout', 'ab-popout'] as const) {
        await act(async () => { controller()?.actions.setRenderMode?.(mode); });
        await flush();
      }
      expect(playwright).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(controller()?.snapshot().renderMode).toBe('iframe');

      await act(async () => { controller()?.actions.setRenderMode?.('ab-screencast'); });
      await flush();
      expect(open).toHaveBeenCalledWith('http://localhost:6006/', {}, undefined);
    } finally {
      offered.mockRestore();
      act(() => terminalRegistry.removeTerminalPaneState('tool-a'));
    }
  });

  it.each([
    ['ab-screencast', 'agent-browser'],
    ['pw-screencast', 'Playwright'],
  ] as const)('refuses a render swap to %s away from an iframe surface holding a non-http(s) URL', async (mode, provider) => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    const open = vi.fn(async () => ({ ok: true, session: 'dormouse.1.gui-a1b2c3', wsPort: 4321 }));
    const playwright = vi.fn(async () => ({ ok: true, session: 'gui-pw', wsPort: 4322 }));
    Object.assign(fake, { agentBrowserOpen: open, playwright });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      const iframeId = (await dispatchIframe('http://localhost:5173/')).id;

      // The header's URL editor is the writer the control socket never sees:
      // `normalizeNavUrl` keeps a typed `data:` scheme on purpose, so `params.url`
      // (and the chrome URL this swap reads first) can hold one. IframePanel
      // refuses to frame it; the swap must refuse to spawn it too, rather than
      // opening it in a real Chromium tab.
      await act(async () => {
        getAgentBrowserScreenController(iframeId)?.chromeActions.navigate('data:text/html,<script>alert(1)</script>');
      });
      await flush();

      await act(async () => {
        getAgentBrowserScreenController(iframeId)?.actions.setRenderMode?.(mode);
      });
      await flush();

      expect(open).not.toHaveBeenCalled();
      expect(playwright).not.toHaveBeenCalled();
      expect(getAgentBrowserScreenController(iframeId)?.snapshot().renderMode).toBe('iframe');
      // The Display modal closes itself on Apply, so the console is the only
      // channel this refusal has of its own.
      expect(warn).toHaveBeenCalledWith(
        `[dormouse] cannot swap surface '${iframeId}' to ${provider}: `
        + "'data:text/html,<script>alert(1)</script>' is not an http(s) URL",
      );
    } finally {
      warn.mockRestore();
      untouchedSpy.mockRestore();
    }
  });

  it('resolves a browser surface handle to its agent-browser session, and gates the rest', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    (fake as PlatformAdapter).agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();

      // An ab-rendered surface bound to a GUI-minted session — the name no
      // `--key` can produce, which is the point of addressing by handle.
      const abId = await dispatchAgentBrowser({ session: 'dormouse.1.gui-a1b2c3', surface: 'surface:1' });
      const iframeRef = (await dispatchIframe('http://localhost:5173/')).ref;

      expect(await dispatchResolveAgentBrowser(abId)).toEqual({
        ok: true,
        result: { surfaceId: abId, surfaceRef: 'surface:2', session: 'dormouse.1.gui-a1b2c3' },
      });
      // A parked ab surface keeps its daemon session, so a minimized target resolves.
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-lath-leaf="${abId}"] [aria-label="Minimize"]`)!.click();
      });
      await flush();
      expect(await dispatchResolveAgentBrowser(abId)).toMatchObject({ ok: true });

      // Gate 1: a terminal has no browser at all.
      expect(await dispatchResolveAgentBrowser('surface:1')).toEqual({
        ok: false,
        error: "surface 'surface:1' has no browser (kind: terminal)",
      });
      // Gate 2: an iframe renderer has a browser but no agent-browser session.
      expect(await dispatchResolveAgentBrowser(iframeRef)).toEqual({
        ok: false,
        error: `surface '${iframeRef}' is not agent-browser rendered (render_mode: iframe) — an iframe cannot be driven; open its page with dor ab open http://localhost:5173/`,
      });

      // A managed `--key` names no Surface, and a bare Wall — VS Code, the
      // website — keeps the unscoped session names it always had.
      expect(await dispatchResolveAgentBrowserKey('storybook')).toEqual({
        ok: true,
        result: { session: sessionForKey('storybook') },
      });
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('drags a parked browser out with its current metadata', async () => {
    const originalRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON() {},
    }) as DOMRect;
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    const agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    (fake as PlatformAdapter).agentBrowserCommand = agentBrowserCommand;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      const browserId = await dispatchAgentBrowser({
        session: 'browser-session',
        binaryPath: '/old/agent-browser',
        surface: 'surface:1',
      });
      const browserLeaf = container.querySelector<HTMLElement>(`[data-lath-leaf="${browserId}"]`)!;
      await act(async () => {
        browserLeaf.querySelector<HTMLButtonElement>('[aria-label="Minimize"]')!.click();
      });
      await flush();

      // Refresh only the live parked metadata; the Door snapshot retains the old
      // binary path, making teardown after drag-out expose which copy was restored.
      expect(await dispatchAgentBrowser({
        session: 'browser-session',
        binaryPath: '/new/agent-browser',
        surface: 'surface:1',
      })).toBe(browserId);

      const door = container.querySelector<HTMLElement>(`[data-door-id="${browserId}"]`)!;
      await act(async () => {
        door.dispatchEvent(new MouseEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 100,
          clientY: 650,
        }));
      });
      act(() => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 300 }));
      });
      await flushFrame();
      act(() => {
        window.dispatchEvent(new MouseEvent('pointerup'));
      });
      await flush();
      expect(container.querySelector(`[data-door-id="${browserId}"]`)).toBeNull();
      expect(container.querySelector(`[data-lath-leaf="${browserId}"]`)?.hasAttribute('data-lath-parked')).toBe(false);

      await dispatchKill(browserId);
      expect(agentBrowserCommand).toHaveBeenCalledWith(
        'browser-session',
        ['close'],
        '/new/agent-browser',
      );
    } finally {
      untouchedSpy.mockRestore();
      HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });

  it('removes a minimized terminal outright — only DOM-resident surfaces park', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />);
    });
    await flush();
    expect(leafCount()).toBe(2);

    const leafA = container.querySelector('[data-lath-leaf="pane-a"]')!;
    const minimize = leafA.querySelector<HTMLElement>('[aria-label="Minimize"]');
    expect(minimize).toBeTruthy();
    await act(async () => { minimize!.click(); });
    await flush();

    // A terminal's state lives in the PTY and replays on reattach, so parking it
    // would only cost memory.
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).toBeNull();
    expect(leafCount()).toBe(1);
  });

  it.each(['Minimize', 'Kill'] as const)('starts the refill after %s of the last pane in that pane\'s cwd', async (control) => {
    // The stubbed pane has no registry entry to tear down, so disposal is made to
    // drop the pane state as the real teardown does.
    vi.spyOn(terminalRegistry, 'disposeSession').mockImplementation((id) => terminalRegistry.removeTerminalPaneState(id));
    terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();

    await clickHeaderControl('pane-a', control);

    const refillId = container.querySelector('[data-lath-leaf]')?.getAttribute('data-lath-leaf');
    try {
      expect(refillId).toBeTruthy();
      expect(refillId).not.toBe('pane-a');
      expect(pendingShellOpts.get(refillId!)?.cwd).toBe('/repo');
    } finally {
      if (refillId) pendingShellOpts.delete(refillId);
      act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
    }
  });

  it('retires the old ref when shell selection replaces an untouched pane', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
          detail: {
            shell: '/bin/zsh',
            name: 'zsh',
            replaceUntouched: true,
          },
        }));
      });
      await flush();

      let listed: { result?: { surfaces: Array<{ id: string; ref: string }> } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.list,
            params: {},
            respond: (r: typeof listed) => { listed = r; },
          },
        }));
      });
      await flush();

      expect(listed?.result?.surfaces).toHaveLength(1);
      const replacement = listed!.result!.surfaces[0];
      expect(replacement.id).not.toBe('pane-a');
      expect(replacement.ref).toBe('surface:2');

      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flush();
      await flush();

      const saved = fake.getState() as { surfaceRefs?: Record<string, string>; surfaceRefsNext?: number } | null;
      expect(saved!.surfaceRefs).toEqual({ [replacement.id]: 'surface:2' });
      expect(saved!.surfaceRefsNext).toBe(3);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('retires the old ref when shell selection replaces an untouched selected door', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      });
      await flush();
      expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
          detail: {
            shell: '/bin/zsh',
            name: 'zsh',
            replaceUntouched: true,
          },
        }));
      });
      await flush();
      await flushFrame();
      await flush();

      let listed: { result?: { surfaces: Array<{ id: string; ref: string }> } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.list,
            params: {},
            respond: (r: typeof listed) => { listed = r; },
          },
        }));
      });
      await flush();

      expect(listed?.result?.surfaces).toHaveLength(2);
      expect(listed!.result!.surfaces.map((surface) => surface.ref)).toEqual(['surface:2', 'surface:3']);
      expect(listed!.result!.surfaces.some((surface) => surface.id === 'pane-a')).toBe(false);
      expect(container.querySelector('[data-door-id="pane-a"]')).toBeNull();

      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flush();
      await flush();

      const saved = fake.getState() as { surfaceRefs?: Record<string, string>; surfaceRefsNext?: number } | null;
      expect(saved!.surfaceRefs).not.toHaveProperty('pane-a');
      expect(Object.values(saved!.surfaceRefs ?? {})).toEqual(['surface:2', 'surface:3']);
      expect(saved!.surfaceRefsNext).toBe(4);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('requires confirmation before killing an untouched tool', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'tool-a');
    try {
      await act(async () => {
        root.render(<Wall
          restoredLathLayout={{
            version: 1,
            tree: { root: { kind: 'leaf', id: 'tool-a' } },
            leafMeta: {
              'tool-a': {
                component: 'tool',
                tabComponent: 'tool',
                title: 'storybook',
                params: {
                  surfaceType: 'tool',
                  command: 'pnpm storybook',
                  cwd: '/repo',
                  toolName: 'storybook',
                  toolRender: 'iframe',
                  toolPort: 'announced',
                },
              },
            },
          }}
          initialMode="command"
        />);
      });
      await flush();

      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-lath-leaf="tool-a"] [aria-label="Kill"]')!.click();
      });
      await flush();

      expect(document.body.textContent).toContain('Confirm kill');
      expect(container.querySelector('[data-lath-leaf="tool-a"]')).not.toBeNull();
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('does not shell-replace an untouched tool', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'tool-a');
    try {
      await act(async () => {
        root.render(<Wall
          restoredLathLayout={{
            version: 1,
            tree: { root: { kind: 'leaf', id: 'tool-a' } },
            leafMeta: {
              'tool-a': {
                component: 'tool',
                tabComponent: 'tool',
                title: 'storybook',
                params: {
                  surfaceType: 'tool',
                  command: 'pnpm storybook',
                  cwd: '/repo',
                  toolName: 'storybook',
                  toolRender: 'iframe',
                  toolPort: 'announced',
                },
              },
            },
          }}
          initialMode="command"
        />);
      });
      await flush();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:new-terminal', {
          detail: { name: 'zsh', replaceUntouched: true },
        }));
      });
      await flush();

      expect(container.querySelector('[data-lath-leaf="tool-a"]')).not.toBeNull();
      expect(leafCount()).toBe(2);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('ignores zoom keyboard requests while a door is selected', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" onEvent={onEvent} />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();

    onEvent.mockClear();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await flush();

    expect(onEvent).not.toHaveBeenCalledWith({ type: 'zoomChange', zoomed: true });
  });

  it('gives passthrough focus to a pane when it gains zoom, and unzooms when passthrough focus ends', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" onEvent={onEvent} />);
    });
    await flush();
    onEvent.mockClear();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await flush();

    expect(onEvent).toHaveBeenCalledWith({ type: 'zoomChange', zoomed: true });
    expect(onEvent).toHaveBeenCalledWith({ type: 'modeChange', mode: 'passthrough' });
    expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('true');
    const unzoom = container.querySelector<HTMLButtonElement>('button[aria-label="Unzoom"]');
    expect(unzoom).not.toBeNull();
    // jsdom's document is not window-focused, so Wall renders the inactive
    // header palette here; the surface-header unit test covers the active pair.
    expect(unzoom?.className).toContain('bg-header-inactive-fg');
    expect(unzoom?.className).toContain('text-header-inactive-bg');

    // The normal passthrough-exit gesture gives focus back to command mode; zoom
    // follows focus and begins its return to the tiled layout in the same action.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 1, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 2, bubbles: true }));
    });
    await flush();

    expect(onEvent).toHaveBeenCalledWith({ type: 'zoomChange', zoomed: false });
    expect(onEvent).toHaveBeenCalledWith({ type: 'modeChange', mode: 'command' });
    expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('false');
  });

  it('unzooms the focused pane when another pane gains focus', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" onEvent={onEvent} />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('true');
    expect(container.querySelectorAll('button[aria-label="Unzoom"]')).toHaveLength(1);
    expect(container.querySelector('[data-lath-leaf="pane-a"] button[aria-label="Unzoom"]')).not.toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-b"] button[aria-label="Zoom"]')).not.toBeNull();

    onEvent.mockClear();
    const paneBHeader = container.querySelector<HTMLElement>('[data-lath-leaf="pane-b"] .lath-leaf-header > div');
    expect(paneBHeader).not.toBeNull();
    await act(async () => {
      paneBHeader!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    await flush();

    expect(onEvent).toHaveBeenCalledWith({ type: 'zoomChange', zoomed: false });
    expect(onEvent).toHaveBeenCalledWith({ type: 'selectionChange', id: 'pane-b', kind: 'pane' });
    expect(container.querySelector('[data-session-id="pane-a"]')?.getAttribute('data-focused')).toBe('false');
    expect(container.querySelector('[data-session-id="pane-b"]')?.getAttribute('data-focused')).toBe('true');
  });

  it('hands zoom over when a partially exposed pane\'s Zoom control is clicked', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-lath-leaf="pane-a"] button[aria-label="Unzoom"]')).not.toBeNull();

    // The elevated pane exposes a perimeter, so pane-b's Zoom control is reachable
    // while pane-a is zoomed. HeaderActionButton stops mousedown, so no selection
    // runs first: onZoom itself must hand zoom over rather than only unzoom pane-a.
    const zoomB = container.querySelector<HTMLButtonElement>('[data-lath-leaf="pane-b"] button[aria-label="Zoom"]');
    expect(zoomB).not.toBeNull();
    await act(async () => {
      zoomB!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(container.querySelector('[data-lath-leaf="pane-b"] button[aria-label="Unzoom"]')).not.toBeNull();
    expect(container.querySelectorAll('button[aria-label="Unzoom"]')).toHaveLength(1);
    expect(container.querySelector('[data-session-id="pane-b"]')?.getAttribute('data-focused')).toBe('true');
  });

  it('dor kill can target a minimized surface ref', async () => {
    let response: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    });
    await flush();
    expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface: 'surface:1', confirmation: { mode: 'dangerously' } },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();

    expect(response?.ok).toBe(true);
    expect(response?.error).toBeUndefined();
    expect(container.querySelector('[data-door-id="pane-a"]')).toBeNull();
  });

  it('dor split can target a minimized surface and creates a sibling door', async () => {
    let response: {
      ok: boolean;
      error?: string;
      result?: { surfaceId: string; surfaceRef: string; direction: string; minimized: boolean };
    } | undefined;
    const getTerminalSpy = vi
      .spyOn(terminalRegistry, 'getOrCreateTerminal')
      .mockImplementation(() => ({}) as ReturnType<typeof terminalRegistry.getOrCreateTerminal>);
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />);
    });
    await flush();

    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      });
      await flush();
      expect(Array.from(container.querySelectorAll('[data-door-id]')).map((el) => el.getAttribute('data-door-id'))).toEqual(['pane-a']);
      expect(leafCount()).toBe(1);

      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.split,
            params: { surface: 'surface:1' },
            respond: (r: typeof response) => { response = r; },
          },
        }));
      });
      await flush();

      expect(response?.ok).toBe(true);
      expect(response?.error).toBeUndefined();
      expect(response?.result?.surfaceRef).toBe('surface:3');
      expect(response?.result?.direction).toBe('right');
      expect(response?.result?.minimized).toBe(true);
      expect(getTerminalSpy).toHaveBeenCalledWith(response!.result!.surfaceId);
      expect(leafCount()).toBe(1);
      await act(async () => {
        window.dispatchEvent(new Event('pagehide'));
      });
      await flush();
      await flush();
      const saved = fake.getState() as { doors?: Array<{ id: string }> } | null;
      expect(saved?.doors?.map((door) => door.id)).toEqual(['pane-a', response!.result!.surfaceId]);
    } finally {
      getTerminalSpy.mockRestore();
    }
  });

  it.each([
    { line: 'dor open a.md', explicitSurface: false, status: 'takeover' },
    { line: 'claude', explicitSurface: false, status: 'created' },
    { line: 'dor open --surface surface:self a.md', explicitSurface: true, status: 'created' },
  ])('dispatches open through the user host with $status placement for $line', async ({ line, explicitSurface, status }) => {
    const controller = new AbortController();
    let toolId: string | undefined;
    const typed: string[] = [];
    vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(true);
    const toolControl = vi.fn(async () => ({ status: 'ok' as const, scope: 'user' as const,
      projectRoot: '/config', path: '/config/dormouse.yml', name: 'viewer', run: ['view', '/repo/a.md'],
      key: ['/repo/a.md'], render: 'iframe' as const, port: 'auto' as const, warnings: [] }));
    Object.assign(fake, { toolControl });
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
      await flush();
      act(() => fake.spawnPty('pane-a'));
      fake.setInputHandler('pane-a', data => typed.push(data));
      terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
      terminalRegistry.applyTerminalSemanticEvents('pane-a', [
        { type: 'commandLine', commandLine: line },
        { type: 'commandStart', source: 'osc633_boundaries' },
      ]);
      const respond = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a', params: { file: 'a.md', cwd: '/repo', ...(explicitSurface ? { surface: 'pane-a' } : {}) }, signal: controller.signal, respond,
      } })));
      await waitUntil(() => respond.mock.calls.length > 0);
      expect(toolControl).toHaveBeenCalledWith({ op: 'open', target: 'a.md', cwd: '/repo', tool: undefined });
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, result: expect.objectContaining({ status }) }));
      toolId = respond.mock.calls[0][0].result.surfaceId;
      expect(typed).toEqual([]);
      if (status === 'takeover') {
        expect(toolId).toBe('pane-a');
        expect(leafCount()).toBe(1);
        act(() => promptBack('pane-a'));
        await waitUntil(() => typed.length > 0);
        expect(typed).toEqual(['view /repo/a.md\r']);
      } else {
        expect(toolId).not.toBe('pane-a');
        expect(leafCount()).toBe(2);
      }
      // This fixture stubs TerminalPane, so report the staged command's startup
      // explicitly before disposing the Wall and its shared launch queue wait.
      act(() => {
        terminalRegistry.seedTerminalManualCwd(toolId!, '/repo');
        reportRunning(toolId!, 'view /repo/a.md');
      });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    } finally {
      await act(async () => controller.abort());
      fake.clearInputHandler('pane-a');
      if (toolId) {
        pendingShellOpts.delete(toolId);
        act(() => terminalRegistry.removeTerminalPaneState(toolId!));
      }
      act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
    }
  });

  it('reuses a builtin viewer by canonical target without matching same-named project or user Tools', async () => {
    vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(true);
    const target = '/repo/docs/readme.md';
    const command = `dor __view-file ${target}`;
    const toolControl = vi.fn(async (request: { op: string; global?: boolean }) => ({
      status: 'ok' as const,
      scope: request.op === 'open' ? 'builtin' as const : request.global ? 'user' as const : undefined,
      projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'file',
      run: ['dor', '__view-file', target], key: [target],
      render: 'iframe' as const, port: 'announced' as const, warnings: [],
    }));
    Object.assign(fake, { toolControl });
    const ids: string[] = [];
    const requestTool = async (params: Record<string, unknown>) => {
      const respond = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a', params: { cwd: '/repo', ...params }, respond,
      } })));
      await waitUntil(() => respond.mock.calls.length > 0);
      const response = respond.mock.calls[0][0];
      expect(response.ok).toBe(true);
      return response.result as { status: string; surfaceId: string };
    };
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
      await flush();
      for (const params of [{ name: 'file' }, { name: 'file', global: true }, { file: 'docs/readme.md' }]) {
        const result = await requestTool(params);
        expect(result.status).toBe('created');
        ids.push(result.surfaceId);
        act(() => {
          terminalRegistry.seedTerminalManualCwd(result.surfaceId, '/repo');
          reportRunning(result.surfaceId, command);
        });
      }
      expect(new Set(ids).size).toBe(3);
      expect(leafCount()).toBe(4);

      // Host resolution gives both spellings the same canonical document key.
      const reused = await requestTool({ file: './docs/../docs/readme.md' });
      expect(toolControl).toHaveBeenLastCalledWith({ op: 'open', target: './docs/../docs/readme.md', cwd: '/repo', tool: undefined });
      expect(reused).toMatchObject({ status: 'existing', surfaceId: ids[2] });
      expect(leafCount()).toBe(4);
    } finally {
      act(() => ids.forEach(id => terminalRegistry.removeTerminalPaneState(id)));
    }
  });

  it('retries failed post-grant lookup without recording permission again', async () => {
    let calls = 0;
    const toolControl = vi.fn(async (request: { op: string }) => {
      if (request.op === 'trust') return { status: 'trust-recorded' };
      const common = { projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'viewer', run: ['view', '/repo/file.md'] };
      if (calls++ === 0) return { ...common, status: 'untrusted', upstreamUrl: null, warnings: [] };
      if (calls === 2) return { status: 'error', message: 'The selected file is missing' };
      return { ...common, status: 'ok', render: 'iframe', port: 'auto', key: null, warnings: [] };
    });
    Object.assign(fake, { toolControl });
    let id: string | undefined;
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
      await flush();
      const respond = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, params: { name: 'viewer', cwd: '/repo', args: ['file.md'] }, respond,
      } })));
      id = respond.mock.calls[0][0].result.surfaceId;
      const allow = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Always allow for folder'))!;
      await act(async () => allow.click());
      await flush();
      expect(container.querySelector('[role="alert"]')?.textContent).toBe('The selected file is missing');
      expect(container.querySelector(`[data-lath-leaf="${id}"]`)).not.toBeNull();
      expect(container.querySelector(`[data-session-id="${id}"]`)).toBeNull();
      const pane = container.querySelector(`[data-lath-leaf="${id}"]`)!;
      expect(pane.textContent).toContain('Permission is saved');
      expect(pane.textContent).not.toContain('Always allow');
      expect(pane.textContent).not.toContain('Declining records nothing');
      expect([...pane.querySelectorAll('button')].some(button => button.textContent === 'Close')).toBe(true);
      const retry = [...pane.querySelectorAll('button')].find(button => button.textContent === 'Retry')!;
      await act(async () => retry.click());
      await flush();
      expect(toolControl.mock.calls.filter(([request]) => request.op === 'trust')).toHaveLength(1);
      expect(toolControl.mock.calls.filter(([request]) => request.op === 'lookup')).toHaveLength(3);
      expect(container.querySelector(`[data-session-id="${id}"]`)).not.toBeNull();
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(pendingShellOpts.get(id!)?.command).toBe('view /repo/file.md');
      act(() => {
        terminalRegistry.seedTerminalManualCwd(id!, '/repo');
        reportRunning(id!, 'view /repo/file.md');
      });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    } finally {
      if (id) { pendingShellOpts.delete(id); act(() => terminalRegistry.removeTerminalPaneState(id!)); }
    }
  });

  it.each(['error', 'missing', 'throws'] as const)('keeps approval choices and stops before lookup when recording trust %s', async failure => {
    const toolControl = vi.fn(async (request: { op: string }) => {
      if (request.op === 'trust') {
        if (failure === 'throws') throw new Error('Permission storage is unavailable');
        return failure === 'missing' ? undefined : { status: 'error', message: 'Permission storage is unavailable' };
      }
      return { status: 'untrusted', projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'viewer', run: 'view', upstreamUrl: 'https://example.com/repo.git', warnings: [] };
    });
    Object.assign(fake, { toolControl });
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
    await flush();
    const respond = vi.fn();
    await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
      method: SURFACE_CONTROL_METHODS.tool, params: { name: 'viewer', cwd: '/repo' }, respond,
    } })));
    const id = respond.mock.calls[0][0].result.surfaceId;
    const allow = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Always allow for folder'))!;
    await act(async () => allow.click());
    await flush();
    expect(toolControl.mock.calls.filter(([request]) => request.op === 'lookup')).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(failure === 'missing' ? 'could not be saved' : 'Permission storage is unavailable');
    expect(container.textContent).toContain('Always allow for upstream');
    expect(container.textContent).toContain('Always allow for folder');
    expect(container.textContent).not.toContain('Permission is saved');
    expect(container.querySelector(`[data-session-id="${id}"]`)).toBeNull();
    expect(pendingShellOpts.has(id)).toBe(false);
  });

  it('keeps pending file inputs distinct and quotes argv after approval', async () => {
    let trusted = false;
    const toolControl = vi.fn(async (request: { op: string; args?: string[] }) => {
      if (request.op === 'trust') { trusted = true; return { status: 'trust-recorded' as const }; }
      const common = { projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'viewer', run: ['view', ...(request.args ?? [])] };
      return trusted ? { ...common, status: 'ok' as const, render: 'iframe' as const, port: 'auto' as const, key: request.args ?? [], warnings: [] }
        : { ...common, status: 'untrusted' as const, upstreamUrl: null, warnings: [] };
    });
    Object.assign(fake, { toolControl });
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
    await flush();
    const ids: string[] = [];
    for (const [cwd, target] of [['/repo', 'a b;$(bad).md'], ['/repo', 'second.md'], ['/repo', 'a b;$(bad).md'], ['/repo/subdir', 'a b;$(bad).md']]) {
      const respond = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, params: { name: 'viewer', cwd, args: [target] }, respond,
      } })));
      ids.push(respond.mock.calls[0][0].result.surfaceId);
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).not.toBe(ids[0]);
    const allow = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Always allow for folder'))!;
    await act(async () => allow.click());
    await flush();
    expect(toolControl).toHaveBeenLastCalledWith({ op: 'lookup', name: 'viewer', cwd: '/repo', args: ['a b;$(bad).md'] });
    expect(pendingShellOpts.get(ids[0])?.command).toBe("view 'a b;$(bad).md'");
    act(() => {
      terminalRegistry.seedTerminalManualCwd(ids[0], '/repo');
      reportRunning(ids[0], "view 'a b;$(bad).md'");
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    await flush();
    expect((fake.getState() as PersistedSession).panes.find(pane => pane.id === ids[0])?.tool?.argv).toEqual(['view', 'a b;$(bad).md']);
    ids.forEach(id => pendingShellOpts.delete(id));
    act(() => ids.forEach(id => terminalRegistry.removeTerminalPaneState(id)));
  });

  it.each([false, true])('serializes a newly created Tool until startup, including completion before waiting (%s)', async finishesBeforeWait => {
    const controller = new AbortController();
    const command = 'pnpm storybook';
    let id: string | undefined;
    const toolControl = vi.fn(async (request: { name?: string }) => request.name === 'probe'
      ? { status: 'error', message: 'probe reached lookup' }
      : { status: 'ok', name: 'storybook', projectRoot: '/repo', path: '/repo/dormouse.yml', run: command, render: 'iframe', port: 'announced', key: ['/repo'], warnings: [] });
    Object.assign(fake, { toolControl });
    vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(true);
    const write = vi.spyOn(fake, 'writePty');
    const reportStart = (toolId: string) => {
      terminalRegistry.seedTerminalManualCwd(toolId, '/repo');
      terminalRegistry.applyTerminalSemanticEvents(toolId, [{ type: 'commandLine', commandLine: command }, { type: 'commandStart', source: 'osc633_boundaries' }]);
    };
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
      await flush();
      const first = vi.fn((response: { result?: { surfaceId: string } }) => {
        id = response.result?.surfaceId;
        if (finishesBeforeWait && id) {
          reportStart(id);
          terminalRegistry.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }, { type: 'promptStart' }]);
        }
      });
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a', params: { name: 'storybook', cwd: '/repo' }, signal: controller.signal, respond: first,
      } })));
      await flush();
      expect(first).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'created' }) }));
      const second = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a', params: { name: finishesBeforeWait ? 'probe' : 'storybook', cwd: '/repo' }, signal: controller.signal, respond: second,
      } })));
      if (!finishesBeforeWait) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(toolControl).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
        act(() => reportStart(id!));
      }
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
      expect(second).toHaveBeenCalledWith(finishesBeforeWait ? { ok: false, error: 'probe reached lookup' }
        : expect.objectContaining({ result: expect.objectContaining({ status: 'existing', surfaceId: id }) }));
      expect(toolControl).toHaveBeenCalledTimes(2);
      expect(write).not.toHaveBeenCalled();
      expect(leafCount()).toBe(2);
    } finally {
      await act(async () => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 125)); });
      if (id) {
        pendingShellOpts.delete(id);
        act(() => terminalRegistry.removeTerminalPaneState(id!));
      }
    }
  });

  it.each([
    { fresh: false, archiveFails: false, idle: false },
    { fresh: true, archiveFails: false, idle: false },
    { fresh: false, archiveFails: false, idle: true },
    { fresh: false, archiveFails: true, idle: true },
  ])('serializes approval key reuse and preserves fresh/notes: %j', async ({ fresh, archiveFails, idle }) => {
    const ids: string[] = [];
    const cwd = { path: '/repo', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } as const;
    const idleState = createTerminalPaneState({ cwd });
    const runningState = createTerminalPaneState({ cwd, currentCommand: {
      id: 'run-tool', rawCommandLine: 'pnpm storybook', displayCommand: 'pnpm storybook',
      cwdAtStart: cwd, startedAt: 0, source: 'osc633_E',
    } });
    let firstState = idleState;
    vi.spyOn(terminalRegistry, 'getTerminalPaneState').mockImplementation(id =>
      id === ids[0] ? firstState : ids.includes(id) ? runningState : idleState);
    vi.spyOn(terminalRegistry, 'isPaneOscDriven').mockReturnValue(true);
    const write = vi.spyOn(fake, 'writePty').mockImplementation((id, data) => {
      if (id === ids[0] && data === 'pnpm storybook\r') firstState = runningState;
    });
    let trusted = false;
    const toolControl = vi.fn(async (request: { op: 'lookup' | 'trust' }) => {
      const config = { projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'storybook', run: 'pnpm storybook' };
      if (request.op === 'trust') { trusted = true; return { status: 'trust-recorded' as const }; }
      return trusted
        ? { ...config, status: 'ok' as const, render: 'iframe' as const, port: 'announced' as const, key: ['/repo'], warnings: [] }
        : { ...config, status: 'untrusted' as const, upstreamUrl: null, warnings: [] };
    });
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = toolControl;
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
      await flush();
      for (const launchCwd of ['/repo', fresh ? '/repo' : '/repo/subdir']) {
        const respond = vi.fn();
        await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
          method: SURFACE_CONTROL_METHODS.tool, params: { name: 'storybook', cwd: launchCwd, fresh }, respond,
        } })));
        ids.push(respond.mock.calls[0][0].result.surfaceId);
      }
      expect(ids[0]).not.toBe(ids[1]);
      act(() => addPlainNote(ids[1], 'keep this approval note'));
      if (archiveFails) vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk full'));
      const approvals = Array.from(container.querySelectorAll('button')).filter(button => button.textContent?.includes('Always allow for folder'));
      vi.useFakeTimers();
      await act(async () => {
        approvals[0].click();
        if (!idle) approvals[1].click();
      });
      expect(toolControl.mock.calls.filter(([request]) => request.op === 'trust')).toHaveLength(1);
      expect(pendingShellOpts.has(ids[0])).toBe(true);
      expect(pendingShellOpts.has(ids[1])).toBe(false);
      const queuedLaunch = vi.fn();
      if (!fresh && !idle) {
        await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
          method: SURFACE_CONTROL_METHODS.tool, params: { name: 'storybook', cwd: '/repo' }, respond: queuedLaunch,
        } })));
        expect(queuedLaunch).not.toHaveBeenCalled();
      }
      firstState = runningState;
      await act(async () => vi.advanceTimersByTimeAsync(100));
      if (idle) {
        firstState = idleState;
        await act(async () => approvals[1].click());
      }
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(toolControl.mock.calls.filter(([request]) => request.op === 'trust')).toHaveLength(2);
      if (!fresh && !idle) expect(queuedLaunch).toHaveBeenCalledWith(expect.objectContaining({
        ok: true, result: expect.objectContaining({ status: 'existing', surfaceId: ids[0] }),
      }));
      expect(pendingShellOpts.has(ids[1])).toBe(fresh);
      expect(write.mock.calls.filter(([, data]) => data === 'pnpm storybook\r')).toHaveLength(idle && !archiveFails ? 1 : 0);
      if (fresh || archiveFails) {
        expect(container.querySelector(`[data-lath-leaf="${ids[1]}"]`)).not.toBeNull();
        expect(getNotes(ids[1])).toHaveLength(1);
        if (archiveFails) expect(document.body.querySelector('[aria-labelledby="notepad-archive-failure-title"]')).not.toBeNull();
      } else {
        expect(container.querySelector(`[data-lath-leaf="${ids[1]}"]`)).toBeNull();
        const archive = (await fake.notepadArchive.load())?.raw as NotepadArchiveV1;
        expect(archive.batches.flatMap(batch => batch.notes)).toEqual([expect.objectContaining({ content: { kind: 'plain', text: 'keep this approval note' } })]);
      }
    } finally {
      vi.useRealTimers();
      ids.forEach(id => pendingShellOpts.delete(id));
    }
  });

  it('moves the selection ring from a terminal to a pending Tool approval', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const left = this.dataset.lathLeaf === 'pane-a' ? 100 : 500;
      return { x: left, y: 40, left, top: 40, right: left + 300, bottom: 240, width: 300, height: 200, toJSON() {} };
    });
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => ({
      status: 'untrusted' as const, projectRoot: '/repo', path: '/repo/dormouse.yml',
      name: 'storybook', run: 'pnpm storybook', upstreamUrl: null,
      warnings: [],
    }));
    const ring = () => container.querySelector('[data-ring="outline"]')?.closest('svg')?.parentElement;
    await act(async () => { root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />); });
    await flush();
    expect(ring()?.style.left).toBe('96px');
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.tool,
          params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
          respond: vi.fn(),
        },
      }));
    });
    await flush();
    expect(container.textContent).toContain('Always allow for folder');
    const approvalHeader = container.querySelector<HTMLElement>('[data-lath-leaf]:not([data-lath-leaf="pane-a"]) .lath-leaf-header > div');
    expect(approvalHeader).not.toBeNull();
    await act(async () => { approvalHeader!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await flush();
    expect(ring()?.style.left).toBe('496px');
  });

  it.each(['', ' \t\n'])('shows a useful fallback for a blank grant failure (%j)', async message => {
    const toolControl = vi.fn(async (request: { op: string }) => request.op === 'trust'
      ? { status: 'error', message }
      : { status: 'untrusted', projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'storybook', run: 'pnpm storybook', upstreamUrl: null, warnings: [] });
    Object.assign(fake, { toolControl });
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
    await flush();
    const respond = vi.fn();
    await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
      method: SURFACE_CONTROL_METHODS.tool, params: { name: 'storybook', cwd: '/repo' }, respond,
    } })));
    const id = respond.mock.calls[0][0].result.surfaceId;
    const allow = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Always allow for folder'))!;
    await act(async () => allow.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('The Tool permission could not be saved. Try allowing it again.');
    expect(container.querySelector(`[data-session-id="${id}"]`)).toBeNull();
    expect(toolControl.mock.calls.filter(([request]) => request.op === 'lookup')).toHaveLength(1);
  });

  it.each(['read error', 'unknown tool'])('retains a failed post-grant lookup with retry and quiet stale completion (%s)', async failure => {
    const untrusted = { status: 'untrusted', projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'storybook', run: 'pnpm storybook', upstreamUrl: null, warnings: [] };
    const failed = failure === 'read error'
    ? { status: 'error', message: 'configuration temporarily unreadable' }
    : { status: 'unknown-tool', projectRoot: '/repo', path: '/repo/dormouse.yml', names: [] };
    const toolControl = vi.fn(async (request: { op: string }) => request.op === 'trust'
    ? { status: 'trust-recorded' } : toolControl.mock.calls.length === 1 ? untrusted : failed);
    Object.assign(fake, { toolControl });
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
    await flush();
    const respond = vi.fn();
    await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
      method: SURFACE_CONTROL_METHODS.tool, params: { name: 'storybook', cwd: '/repo' }, respond,
    } })));
    const id = respond.mock.calls[0][0].result.surfaceId;
    const allow = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Always allow for folder'))!;
    await act(async () => allow.click());
    await flush();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(failure === 'read error'
      ? 'configuration temporarily unreadable' : 'The Tool is no longer available. Check its configuration and try again.');
    expect(container.querySelector(`[data-lath-leaf="${id}"]`)).not.toBeNull();
    expect(container.querySelector(`[data-session-id="${id}"]`)).toBeNull();
    expect(pendingShellOpts.has(id)).toBe(false);

    const retry = Promise.withResolvers<typeof failed>();
    toolControl.mockImplementation(async request => request.op === 'trust' ? { status: 'trust-recorded' } : retry.promise);
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Retry')!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(toolControl.mock.calls.filter(([request]) => request.op === 'lookup')).toHaveLength(3);
    expect(toolControl.mock.calls.filter(([request]) => request.op === 'trust')).toHaveLength(1);
    const decline = [...container.querySelectorAll('button')].find(button => button.textContent === 'Close')!;
    await act(async () => decline.click());
    await flush();
    await act(async () => retry.resolve(failed));
    await flush();
    expect(container.querySelector(`[data-lath-leaf="${id}"]`)).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pendingShellOpts.has(id)).toBe(false);
  });

  it.each([true, false])('keeps a tool deferred until trust succeeds (%s), lookup and shell staging finish', async grantSucceeds => {
    let toolId: string | undefined;
    vi.spyOn(terminalRegistry, 'getTerminalPaneState').mockImplementation(id => {
      const cwd = { path: '/repo', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } as const;
      return createTerminalPaneState({ cwd, currentCommand: id === toolId ? {
        id: 'approved-run', rawCommandLine: 'pnpm storybook', displayCommand: 'pnpm storybook',
        cwdAtStart: cwd, startedAt: 0, source: 'osc633_E',
      } : null });
    });
    const trustGate = Promise.withResolvers<{ status: 'trust-recorded' } | { status: 'error'; message: string }>();
    const resolvedGate = Promise.withResolvers<{
      status: 'ok';
      projectRoot: string;
      path: string;
      name: string;
      run: string;
      render: 'iframe';
      port: 'announced';
      key: null;
      warnings: string[];
    }>();
    const toolControl = vi.fn((request: { op: 'lookup' | 'trust' }) => {
      if (request.op === 'trust') return trustGate.promise;
      if (toolControl.mock.calls.length === 1) {
        return Promise.resolve({
          status: 'untrusted' as const,
          projectRoot: '/repo',
          path: '/repo/dormouse.yml',
          name: 'storybook',
          run: 'pnpm storybook',
          upstreamUrl: null,
          warnings: [],
        });
      }
      return resolvedGate.promise;
    });
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = toolControl;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();

      let response: { ok: boolean; result?: { surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();
      expect(response?.ok).toBe(true);
      toolId = response!.result!.surfaceId;
      expect(container.querySelector(`[data-session-id="${toolId}"]`)).toBeNull();

      const allow = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Always allow for folder'));
      expect(allow).toBeDefined();
      await act(async () => {
        allow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        allow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(toolControl.mock.calls.filter(([request]) => request.op === 'trust')).toHaveLength(1);
      expect(container.querySelector(`[data-session-id="${toolId}"]`)).toBeNull();

      await act(async () => { trustGate.resolve(grantSucceeds ? { status: 'trust-recorded' } : { status: 'error', message: 'grant could not be saved' }); });
      await flush();
      expect(container.querySelector(`[data-session-id="${toolId}"]`)).toBeNull();
      if (!grantSucceeds) {
        expect(toolControl.mock.calls.filter(([request]) => request.op === 'lookup')).toHaveLength(1);
        expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)).not.toBeNull();
        expect(pendingShellOpts.has(toolId)).toBe(false);
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('grant could not be saved');
        // A hidden Workspace can miss a transient notice. Its approval error
        // remains when shown again, well past the old notice interval.
        container.hidden = true;
        vi.useFakeTimers();
        await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
        vi.useRealTimers();
        container.hidden = false;
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('grant could not be saved');

        const retryGate = Promise.withResolvers<{ status: 'error'; message: string }>();
        toolControl.mockImplementation(() => retryGate.promise);
        await act(async () => { allow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(toolControl.mock.calls.filter(([request]) => request.op === 'trust')).toHaveLength(2);
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.querySelector(`[data-session-id="${toolId}"]`)).toBeNull();

        await act(async () => { retryGate.resolve({ status: 'error', message: 'retry grant failed' }); });
        expect(container.querySelector('[role="alert"]')?.textContent).toBe('retry grant failed');

        const staleGate = Promise.withResolvers<{ status: 'error'; message: string }>();
        toolControl.mockImplementation(() => staleGate.promise);
        await act(async () => { allow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        expect(container.querySelector('[role="alert"]')).toBeNull();
        const decline = Array.from(container.querySelectorAll('button'))
          .find(button => button.textContent === 'Disallow and close');
        await act(async () => { decline!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
        await flush();
        await act(async () => { staleGate.resolve({ status: 'error', message: 'late rejected grant' }); });
        await flush();
        expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)).toBeNull();
        expect(container.textContent).not.toContain('late rejected grant');
        expect(pendingShellOpts.has(toolId)).toBe(false);
        return;
      }

      await act(async () => {
        resolvedGate.resolve({
          status: 'ok',
          projectRoot: '/repo',
          path: '/repo/dormouse.yml',
          name: 'storybook',
          run: 'pnpm storybook',
          render: 'iframe',
          port: 'announced',
          key: null,
          warnings: [],
        });
      });
      await flush();
      expect(container.querySelector(`[data-session-id="${toolId}"]`)).not.toBeNull();
      expect(pendingShellOpts.get(toolId)?.untouched).toBe(false);
    } finally {
      vi.useRealTimers();
      if (toolId) pendingShellOpts.delete(toolId);
    }
  });

  it.each([false, true])('starts an approved tool before deferred minimize and never resurrects approval after a PTY creation error (%s)', async failAfterSpawn => {
    let toolId: string | undefined;
    vi.spyOn(terminalRegistry, 'getTerminalPaneState').mockImplementation(id => {
      const cwd = { path: '/repo', pathKind: 'posix', isRemote: false, source: 'osc633', updatedAt: 0 } as const;
      return createTerminalPaneState({ cwd, currentCommand: id === toolId ? {
        id: 'approved-run', rawCommandLine: 'pnpm storybook', displayCommand: 'pnpm storybook',
        cwdAtStart: cwd, startedAt: 0, source: 'osc633_E',
      } : null });
    });
    let consumedOpts: (typeof pendingShellOpts extends Map<string, infer T> ? T : never) | undefined;
    const getTerminalSpy = vi.spyOn(terminalRegistry, 'getOrCreateTerminal').mockImplementation((id) => {
      consumedOpts = pendingShellOpts.get(id);
      pendingShellOpts.delete(id);
      fake.spawnPty(id);
      if (failAfterSpawn) throw new Error('PTY setup failed after spawning');
      return {} as ReturnType<typeof terminalRegistry.getOrCreateTerminal>;
    });
    let lookupCount = 0;
    const toolControl = vi.fn(async (request: { op: 'lookup' | 'trust' }) => {
      if (request.op === 'trust') return { status: 'trust-recorded' as const };
      lookupCount += 1;
      if (lookupCount === 1) {
        return {
          status: 'untrusted' as const,
          projectRoot: '/repo',
          path: '/repo/dormouse.yml',
          name: 'storybook',
          run: 'pnpm storybook',
          upstreamUrl: null,
          warnings: [],
        };
      }
      return okToolLookup(null);
    });
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = toolControl;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();

      let response: { ok: boolean; result?: { surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: '/repo', minimized: true, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();
      toolId = response!.result!.surfaceId;
      expect(fake.hasPty(toolId)).toBe(false);

      const allow = Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Always allow for folder'))!;
      await act(async () => { allow.click(); });
      await flush();

      expect(fake.hasPty(toolId)).toBe(true);
      expect(getTerminalSpy).toHaveBeenCalledWith(toolId);
      expect(consumedOpts).toMatchObject({ cwd: '/repo', command: 'pnpm storybook', untouched: false });
      expect(pendingShellOpts.has(toolId)).toBe(false);
      expect(container.textContent).not.toContain('Always allow');
      expect(container.querySelector('[role="alert"]')).toBeNull();
      if (failAfterSpawn) {
        expect(container.querySelector(`[data-session-id="${toolId}"]`)).not.toBeNull();
        expect(container.querySelector(`[data-door-id="${toolId}"]`)).toBeNull();
      } else {
        expect(container.querySelector(`[data-door-id="${toolId}"]`)).not.toBeNull();
        expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)?.hasAttribute('data-lath-parked')).toBe(true);
      }
    } finally {
      if (toolId && fake.hasPty(toolId)) act(() => fake.killPty(toolId));
      getTerminalSpy.mockRestore();
    }
  });

  it('reveals a pending approval created against a minimized reference', async () => {
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => ({
      status: 'untrusted' as const,
      projectRoot: '/repo',
      path: '/repo/dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      upstreamUrl: null,
      warnings: [],
    }));

    await act(async () => {
      root.render(
        <Wall
          initialPaneIds={['pane-a']}
          initialDoors={[{ id: 'reference-door', title: 'Reference' }]}
          initialMode="command"
        />,
      );
    });
    await flush();

    let response: { ok: boolean; result?: { surfaceId: string; minimized: boolean } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.tool,
          params: {
            name: 'storybook',
            cwd: '/repo',
            surface: 'surface:2',
            minimized: false,
            fresh: false,
          },
          respond: (result: typeof response) => { response = result; },
        },
      }));
    });
    await flush();

    expect(response).toMatchObject({ ok: true, result: { minimized: false } });
    const toolId = response!.result!.surfaceId;
    expect(container.querySelector(`[data-door-id="${toolId}"]`)).toBeNull();
    expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)?.hasAttribute('data-lath-parked')).toBe(false);
    expect(container.textContent).toContain('Always allow for folder');
  });

  it('reports a reused pending tool as visible after reattaching it', async () => {
    const toolId = 'pending-tool-door';
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => ({
      status: 'untrusted' as const,
      projectRoot: '/repo',
      path: '/repo/dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      upstreamUrl: null,
      warnings: [],
    }));

    await act(async () => {
      root.render(
        <Wall
          initialPaneIds={['pane-a']}
          initialDoors={[{
            id: toolId,
            title: 'storybook',
            component: 'tool',
            tabComponent: 'tool',
            params: {
              surfaceType: 'tool',
              command: 'pnpm storybook',
              cwd: '/repo',
              toolName: 'storybook',
              toolPending: {
                name: 'storybook',
                run: 'pnpm storybook',
                path: '/repo/dormouse.yml',
                projectRoot: '/repo',
                cwd: '/repo',
                minimized: false,
                upstreamUrl: null,
              },
            },
          }]}
          initialMode="command"
        />,
      );
    });
    await flush();
    expect(container.querySelector(`[data-door-id="${toolId}"]`)).not.toBeNull();

    let response: { ok: boolean; result?: { status: string; surfaceId: string; minimized: boolean } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.tool,
          params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
          respond: (result: typeof response) => { response = result; },
        },
      }));
    });
    await flush();

    expect(response).toMatchObject({
      ok: true,
      result: { status: 'pending', surfaceId: toolId, minimized: false },
    });
    expect(container.querySelector(`[data-door-id="${toolId}"]`)).toBeNull();
    expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)).not.toBeNull();
  });

  it.each([true, false])('accepts a newly completed keyed Tool restart without mistaking old or unrelated completions (%s)', async completesDuringWrite => {
    const id = 'short-tool';
    const command = 'pnpm storybook';
    const controller = new AbortController();
    const typed: string[] = [];
    Object.assign(fake, { toolControl: vi.fn(async () => okToolLookup(['/repo'])) });
    const finish = (line: string) => {
      reportRunning(id, line);
      terminalRegistry.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }, { type: 'promptStart' }]);
    };
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialDoors={[{
        id, title: 'storybook', component: 'tool', tabComponent: 'tool',
        params: { surfaceType: 'tool', command, cwd: '/repo', toolName: 'storybook', toolKey: ['storybook', '/repo'], toolRender: 'iframe', toolPort: 'announced' },
      }]} />));
      await flush();
      act(() => {
        fake.spawnPty(id);
        terminalRegistry.seedTerminalManualCwd(id, '/repo');
        finish(command);
      });
      const oldRun = terminalRegistry.getTerminalPaneState(id).lastCommand!.id;
      fake.setInputHandler(id, data => {
        typed.push(data);
        if (completesDuringWrite && data === `${command}\r`) finish(command);
      });
      const respond = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a', params: { name: 'storybook', cwd: '/repo' }, signal: controller.signal, respond,
      } })));
      if (!completesDuringWrite) {
        await waitUntil(() => typed.includes(`${command}\r`));
        expect(terminalRegistry.getTerminalPaneState(id).lastCommand!.id).toBe(oldRun);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(respond).not.toHaveBeenCalled();
        act(() => finish('echo unrelated'));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(respond).not.toHaveBeenCalled();
        act(() => finish(command));
      }
      await waitUntil(() => respond.mock.calls.length > 0);
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, result: expect.objectContaining({ status: 'adopted', surfaceId: id }) }));
      expect(typed).toEqual(['\x03', `${command}\r`]);
      expect(terminalRegistry.getTerminalPaneState(id).currentCommand).toBeNull();
      expect(terminalRegistry.getTerminalPaneState(id).lastCommand!.id).not.toBe(oldRun);
    } finally {
      await act(async () => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 125)); });
      fake.clearInputHandler(id);
      act(() => terminalRegistry.removeTerminalPaneState(id));
    }
  });

  it('reports a reused minimized tool as visible after reattaching it', async () => {
    const toolId = 'tool-door';
    terminalRegistry.applyTerminalSemanticEvents(toolId, [
      // The match runs in its own directory, not the caller's: the response has
      // to name that one (docs/specs/dor-tool.md -> Identity and dedupe).
      { type: 'cwd', cwd: terminalRegistry.cwdFromOsc633('/repo/packages/ui')! },
      { type: 'commandLine', commandLine: 'pnpm storybook' },
      { type: 'commandStart' },
    ]);
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => okToolLookup(['/repo']));

    try {
      await act(async () => {
        root.render(
          <Wall
            initialPaneIds={['pane-a']}
            initialDoors={[{
              id: toolId,
              title: 'storybook',
              component: 'tool',
              tabComponent: 'tool',
              params: {
                surfaceType: 'tool',
                command: 'pnpm storybook',
                cwd: '/repo',
                toolName: 'storybook',
                toolRender: 'iframe',
                toolPort: 'announced',
                toolKey: ['storybook', '/repo'],
              },
            }]}
            initialMode="command"
          />,
        );
      });
      await flush();
      expect(container.querySelector(`[data-door-id="${toolId}"]`)).not.toBeNull();

      let response: { ok: boolean; result?: { status: string; surfaceId: string; minimized: boolean; cwd: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();

      expect(response).toMatchObject({
        ok: true,
        result: { status: 'existing', surfaceId: toolId, minimized: false, cwd: '/repo/packages/ui' },
      });
      expect(container.querySelector(`[data-door-id="${toolId}"]`)).toBeNull();
      expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)).not.toBeNull();
    } finally {
      act(() => terminalRegistry.removeTerminalPaneState(toolId));
    }
  });

  // Pane take-over: `dor tool` typed alone at a prompt runs in that pane rather
  // than splitting (docs/specs/dor-tool.md -> Take-over). The handshake is the
  // point — `dor` is the pane's foreground process when the host answers, so the
  // command may only be typed once its own shell is back at a prompt.
  it.each(['cancelled', 'helper opened', 'cwd changed', 'closing'] as const)('abandons takeover if the caller becomes %s while returning to its prompt', async (change) => {
    const controller = new AbortController();
    const typed: string[] = [];
    let releaseClosing: (() => void) | undefined;
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
      await flush();
      act(() => { fake.spawnPty('pane-a'); addPlainNote('pane-a', 'Preserve me'); });
      fake.setInputHandler('pane-a', data => typed.push(data));
      terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
      reportRunning('pane-a', 'dor tool -- pnpm dev');
      const respond = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a',
        params: { command: ['pnpm', 'dev'], cwd: '/repo' }, signal: controller.signal, respond,
      } })));
      await waitUntil(() => respond.mock.calls.length > 0);
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'takeover' }) }));
      if (change === 'cancelled') controller.abort();
      if (change === 'helper opened') vi.spyOn(helpers, 'getHelper').mockImplementation(id => id === 'pane-a' ? { id: 'helper-a', parentId: 'pane-a', command: '', status: 'off' } : undefined);
      if (change === 'cwd changed') terminalRegistry.applyTerminalSemanticEvents('pane-a', [{ type: 'cwd', cwd: terminalRegistry.cwdFromOsc633('/elsewhere')! }]);
      if (change === 'closing') releaseClosing = beginClosing(['pane-a']);
      act(() => promptBack('pane-a'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
      expect(typed).toEqual([]);
      expect(leafCount()).toBe(1);
      expect(getNotes('pane-a')).toHaveLength(1);
      await act(async () => window.dispatchEvent(new Event('pagehide')));
      await flush();
      expect((fake.getState() as { panes: Array<{ surfaceType?: string }> }).panes[0]?.surfaceType).not.toBe('tool');
    } finally {
      controller.abort(); releaseClosing?.(); fake.clearInputHandler('pane-a');
      act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
    }
  });

  it('writes dor send input paced', async () => {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
    await flush();
    const write = vi.spyOn(fake, 'writePty');
    const respond = vi.fn();
    await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
      method: SURFACE_CONTROL_METHODS.send, params: { surface: 'surface:1', input: '/simplify\r', inputCount: 2 }, respond,
    } })));
    expect(write.mock.calls).toEqual([['pane-a', '/simplify\r', { paced: true }]]);
    expect(respond).toHaveBeenCalledWith({
      ok: true, result: { status: 'sent', surfaceId: 'pane-a', surfaceRef: 'surface:1', inputCount: 2 },
    });
  });

  it('rejects anonymous Tool argv containing terminal editing controls before launching', async () => {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
    await flush();
    const write = vi.spyOn(fake, 'writePty');
    const respond = vi.fn();
    await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
      method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a',
      params: { command: ['view', '/tmp/\x15printf unwanted\n#'], cwd: '/repo' }, respond,
    } })));
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'tool arguments cannot contain terminal control characters' });
    expect(write).not.toHaveBeenCalled();
    expect(leafCount()).toBe(1);
  });

  it.each([
    { kind: 'powershell' as const, defaultShell: '/bin/bash', command: "& 'program path' 'it''s.txt'" },
    { kind: 'posix' as const, defaultShell: 'pwsh.exe', command: "'program path' 'it'\\''s.txt'" },
  ])('quotes takeover and keyed rerun for the existing $kind Session after changing defaults', async ({ kind, defaultShell, command }) => {
    const controller = new AbortController();
    const typed: string[] = [];
    vi.spyOn(terminalRegistry, 'getTerminalShellKind').mockImplementation(id => id === 'pane-a' ? kind : null);
    vi.spyOn(terminalRegistry, 'getDefaultShellOpts').mockReturnValue({ shell: defaultShell });
    Object.assign(fake, { toolControl: vi.fn(async () => ({ ...okToolLookup(['/repo']), run: ['program path', "it's.txt"] })) });
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
      await flush();
      act(() => fake.spawnPty('pane-a'));
      fake.setInputHandler('pane-a', data => typed.push(data));
      terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
      for (const status of ['takeover', 'adopted']) {
        act(() => reportRunning('pane-a', 'dor tool storybook'));
        const respond = vi.fn();
        await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
          method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a',
          params: { name: 'storybook', cwd: '/repo' }, signal: controller.signal, respond,
        } })));
        await waitUntil(() => respond.mock.calls.length > 0);
        expect(respond).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status, command }) }));
        const before = typed.length;
        act(() => promptBack('pane-a'));
        await waitUntil(() => typed.length > before);
        expect(typed.at(-1)).toBe(`${command}\r`);
        act(() => {
          reportRunning('pane-a', command);
          terminalRegistry.applyTerminalSemanticEvents('pane-a', [{ type: 'commandFinish', exitCode: 0 }, { type: 'promptStart' }]);
        });
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
      }
      expect(leafCount()).toBe(1);
      await act(async () => window.dispatchEvent(new Event('pagehide')));
      await flush();
      expect((fake.getState() as PersistedSession).panes.find(pane => pane.id === 'pane-a')).toMatchObject({
        command, tool: { argv: ['program path', "it's.txt"] },
      });
    } finally {
      await act(async () => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 125)); });
      fake.clearInputHandler('pane-a');
      act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
    }
  });

  it('holds the takeover queue through unrelated completions until the typed Tool completes', async () => {
    const id = 'pane-a';
    const command = 'pnpm storybook';
    const controller = new AbortController();
    const typed: string[] = [];
    const toolControl = vi.fn(async (request: { name?: string }) => request.name === 'probe'
      ? { status: 'error', message: 'probe reached lookup' }
      : okToolLookup(['/repo']));
    Object.assign(fake, { toolControl });
    const finish = (line: string, cwd = '/repo') => {
      terminalRegistry.applyTerminalSemanticEvents(id, [{ type: 'cwd', cwd: terminalRegistry.cwdFromOsc633(cwd)! }]);
      reportRunning(id, line);
      terminalRegistry.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }, { type: 'promptStart' }]);
    };
    try {
      await act(async () => root.render(<Wall initialPaneIds={[id]} />));
      await flush();
      act(() => {
        fake.spawnPty(id);
        terminalRegistry.seedTerminalManualCwd(id, '/repo');
        reportRunning(id, 'dor tool storybook');
      });
      fake.setInputHandler(id, data => typed.push(data));
      const first = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, surfaceId: id, params: { name: 'storybook', cwd: '/repo' }, signal: controller.signal, respond: first,
      } })));
      await waitUntil(() => first.mock.calls.length > 0);
      expect(first).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'takeover' }) }));
      act(() => terminalRegistry.applyTerminalSemanticEvents(id, [{ type: 'commandFinish', exitCode: 0 }, { type: 'promptStart' }]));
      await waitUntil(() => typed.length > 0);
      const previousRun = terminalRegistry.getTerminalPaneState(id).lastCommand!.id;
      const probe = vi.fn();
      await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.tool, surfaceId: id, params: { name: 'probe', cwd: '/repo' }, signal: controller.signal, respond: probe,
      } })));
      // Neither another command nor this command in another directory is the
      // Tool launch. Each completion remains observable for a full poll tick.
      for (const [line, cwd] of [['echo unrelated', '/repo'], [command, '/elsewhere']] as const) {
        act(() => finish(line, cwd));
        expect(terminalRegistry.getTerminalPaneState(id).lastCommand!.id).not.toBe(previousRun);
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
        expect(toolControl).toHaveBeenCalledTimes(1);
        expect(probe).not.toHaveBeenCalled();
      }
      act(() => finish(command));
      expect(terminalRegistry.getTerminalPaneState(id).currentCommand).toBeNull();
      await waitUntil(() => probe.mock.calls.length > 0);
      expect(probe).toHaveBeenCalledWith({ ok: false, error: 'probe reached lookup' });
      expect(toolControl).toHaveBeenCalledTimes(2);
      expect(typed).toEqual([`${command}\r`]);
      expect(leafCount()).toBe(1);
    } finally {
      await act(async () => { controller.abort(); await new Promise(resolve => setTimeout(resolve, 125)); });
      fake.clearInputHandler(id);
      act(() => terminalRegistry.removeTerminalPaneState(id));
    }
  });

  it('takes over the calling pane when `dor tool` is typed alone at a prompt', async () => {
    const typed: string[] = [];
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => okToolLookup(['/repo']));

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      act(() => { fake.spawnPty('pane-a'); addPlainNote('pane-a', 'Keep my takeover notes'); });
      fake.setInputHandler('pane-a', (data) => typed.push(data));
      terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
      reportRunning('pane-a', 'dor tool storybook');

      let response: { ok: boolean; result?: { status: string; surfaceId: string; minimized: boolean } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            surfaceId: 'pane-a',
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();

      // Answered before the tool starts, and nothing typed while `dor` still owns
      // the shell: waiting for the prompt first would deadlock.
      expect(response).toMatchObject({
        ok: true,
        result: { status: 'takeover', surfaceId: 'pane-a', minimized: false },
      });
      expect(leafCount()).toBe(1);
      expect(typed).toEqual([]);

      // `dor` exits; the shell reports its prompt back and the command lands.
      act(() => promptBack('pane-a'));
      await waitUntil(() => typed.length > 0);
      expect(typed).toEqual(['pnpm storybook\r']);
      expect(leafCount()).toBe(1);
      expect(getNotes('pane-a').some(note => note.content.kind === 'plain' && note.content.text === 'Keep my takeover notes')).toBe(true);

      // The tool goes live, which releases the spawn lock, and then exits. The
      // host learns that from its own 100ms state poll, so the live state has to
      // outlast one tick.
      act(() => reportRunning('pane-a', 'pnpm storybook'));
      await act(async () => { await new Promise((r) => setTimeout(r, 150)); });
      act(() => promptBack('pane-a'));

      // Retyped in the tool's own pane: a key match on the caller re-runs there
      // through the same handshake, never an interrupt — Ctrl+C would kill the
      // `dor` still waiting for the answer.
      act(() => reportRunning('pane-a', 'dor tool storybook'));
      let rerun: { ok: boolean; result?: { status: string; surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            surfaceId: 'pane-a',
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof rerun) => { rerun = result; },
          },
        }));
      });
      await waitUntil(() => rerun !== undefined);
      expect(rerun).toMatchObject({ ok: true, result: { status: 'adopted', surfaceId: 'pane-a' } });
      act(() => promptBack('pane-a'));
      await waitUntil(() => typed.length > 1);
      expect(typed).toEqual(['pnpm storybook\r', 'pnpm storybook\r']);
      expect(leafCount()).toBe(1);

      // The re-run starts and dies inside one 100ms sample, so no poll ever sees
      // it live: the lock has to release on the finished run instead. Without
      // that, the request below waits out the 15s timeout and `settle` gives up.
      act(() => {
        terminalRegistry.applyTerminalSemanticEvents('pane-a', [
          { type: 'commandLine', commandLine: 'pnpm storybook' },
          { type: 'commandStart', source: 'osc633_boundaries' },
          { type: 'commandFinish', exitCode: 1 },
          { type: 'promptStart' },
        ]);
      });

      // A line the host cannot type behind says so, rather than reporting a tool
      // that is not running as `existing` back into the pane it is sitting in.
      act(() => reportRunning('pane-a', 'dor tool storybook && open http://localhost:6006'));
      let compound: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            surfaceId: 'pane-a',
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: (result: typeof compound) => { compound = result; },
          },
        }));
      });
      await waitUntil(() => compound !== undefined);
      expect(compound?.ok).toBe(false);
      expect(compound?.error).toContain("is this tool's own pane");
      expect(typed).toHaveLength(2);
      act(() => promptBack('pane-a'));

      // Same Surface throughout: the leaf changed kind without changing id, so
      // the session persists as one.
      await act(async () => { window.dispatchEvent(new Event('pagehide')); });
      await flush();
      await flush();
      const saved = fake.getState() as {
        panes?: Array<{ id: string; surfaceType?: string; command?: string }>;
      } | null;
      expect(saved?.panes?.find((pane) => pane.id === 'pane-a')).toMatchObject({
        surfaceType: 'tool',
        command: 'pnpm storybook',
      });
    } finally {
      fake.clearInputHandler('pane-a');
      act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
    }
  });

  it.each(['agent', 'helper'] as const)('splits instead of taking over a caller with an existing %s', async (reason) => {
    if (reason === 'helper') vi.spyOn(helpers, 'getHelper').mockImplementation(id => id === 'pane-a' ? { id: 'helper-a', parentId: 'pane-a', command: '', status: 'off' } : undefined);
    const typed: string[] = [];
    const controller = new AbortController();
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => okToolLookup(null));
    let splitId: string | undefined;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();
      act(() => fake.spawnPty('pane-a'));
      fake.setInputHandler('pane-a', (data) => typed.push(data));
      terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
      // An agent's `dor tool` runs under the agent, so the pane reports that line.
      reportRunning('pane-a', reason === 'agent' ? 'claude' : 'dor tool storybook');

      let response: { ok: boolean; result?: { status: string; surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            surfaceId: 'pane-a',
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            signal: controller.signal,
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();
      // The split exists before its handle is reported: a created tool answers
      // only once the new shell reports OSC 633.
      expect(leafCount()).toBe(2);
      splitId = Array.from(container.querySelectorAll('[data-lath-leaf]'))
        .map((leaf) => leaf.getAttribute('data-lath-leaf')!)
        .find((id) => id !== 'pane-a');
      act(() => promptBack(splitId!));
      await waitUntil(() => response !== undefined);

      expect(response?.result).toMatchObject({ status: 'created', surfaceId: splitId });
      expect(typed).toEqual([]);
      // The launch queue outlives the created response until the staged command
      // actually starts. This stubbed TerminalPane must report that startup.
      act(() => {
        terminalRegistry.seedTerminalManualCwd(splitId!, '/repo');
        reportRunning(splitId!, 'pnpm storybook');
      });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    } finally {
      await act(async () => controller.abort());
      if (splitId) {
        pendingShellOpts.delete(splitId);
        act(() => terminalRegistry.removeTerminalPaneState(splitId!));
      }
      fake.clearInputHandler('pane-a');
      act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
    }
  });

  it('rejects a non-integrated shell before offering tool approval', async () => {
    terminalRegistry.setDefaultShellOpts({ shell: 'C:\\Windows\\System32\\cmd.exe' });
    const toolControl = vi.fn(async () => ({
      status: 'untrusted' as const,
      projectRoot: 'C:\\repo',
      path: 'C:\\repo\\dormouse.yml',
      name: 'storybook',
      run: 'pnpm storybook',
      upstreamUrl: null,
      warnings: [],
    }));
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = toolControl;

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();

      let response: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: 'C:\\repo', minimized: false, fresh: false },
            respond: (result: typeof response) => { response = result; },
          },
        }));
      });
      await flush();

      expect(response?.ok).toBe(false);
      expect(response?.error).toContain('requires OSC 633 shell integration');
      expect(container.textContent).not.toContain('Always allow for folder');
      expect(leafCount()).toBe(1);
    } finally {
      terminalRegistry.setDefaultShellOpts(null);
    }
  });

  // A Door created by `dor split` against another Door is the one Surface that never
  // was a pane, so it exercises the store's `addDoor` registration rather than the
  // meta a minimize retains. Every Door reader goes through `lath.getMeta`, so a
  // missing entry shows up as a Door with no metadata.
  it('a Door born from `dor split` against another Door still has store metadata', async () => {
    const getTerminalSpy = vi
      .spyOn(terminalRegistry, 'getOrCreateTerminal')
      .mockImplementation(() => ({}) as ReturnType<typeof terminalRegistry.getOrCreateTerminal>);
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />);
    });
    await flush();

    try {
      // Minimize pane-a, then split against that Door — the new Surface goes straight
      // into the baseboard without ever being laid out.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
      });
      await flush();
      const bornId = await dispatchSplit({ surface: 'surface:1' });
      expect(leafCount()).toBe(1);

      // The persisted Door row is materialized from the store's meta, so a Door with
      // no store entry writes `component: undefined` — which `reconnect.ts` keys off
      // to decide what survives a restart.
      await act(async () => { window.dispatchEvent(new Event('pagehide')); });
      await flush();
      await flush();
      const saved = fake.getState() as {
        doors?: Array<{ id: string; title?: string; component?: string; tabComponent?: string }>;
      } | null;
      const bornDoor = saved?.doors?.find((door) => door.id === bornId);
      expect(bornDoor).toBeDefined();
      expect(bornDoor?.component).toBe('terminal');
      expect(bornDoor?.tabComponent).toBe('terminal');
      expect(bornDoor?.title).toBe(UNNAMED_PANEL_TITLE);
    } finally {
      getTerminalSpy.mockRestore();
    }
  });

  it('dor action targets reject bare numeric refs', async () => {
    let response: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface: '1', confirmation: { mode: 'dangerously' } },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();

    expect(response?.ok).toBe(false);
    expect(response?.error).toContain("surface '1' was not found");
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
  });

  it('dor action targets can resolve surface:self from the caller id', async () => {
    let response: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          surfaceId: 'pane-a',
          params: { surface: 'surface:self', confirmation: { mode: 'dangerously' } },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();

    expect(response?.ok).toBe(true);
    expect(response?.error).toBeUndefined();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).toBeNull();
  });

  it('keeps visible terminal sessions mounted until the kill fade completes', async () => {
    globalThis.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    })) as unknown as typeof matchMedia;
    const disposeSpy = vi.spyOn(terminalRegistry, 'disposeSession');

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
      });
      await flush();

      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.kill,
            params: { surface: 'surface:1', confirmation: { mode: 'dangerously' } },
            respond: () => {},
          },
        }));
      });

      expect(disposeSpy).not.toHaveBeenCalledWith('pane-a');

      await act(async () => {
        await new Promise((r) => setTimeout(r, 500));
      });

      expect(disposeSpy).toHaveBeenCalledWith('pane-a');
    } finally {
      disposeSpy.mockRestore();
    }
  });

  // The focus decision the Wall makes for a pane: `data-focused` on the mocked
  // TerminalPane mirrors `mode === 'passthrough' && selected`.
  const focusOf = (id: string): string | null =>
    container.querySelector(`[data-session-id="${id}"]`)?.getAttribute('data-focused') ?? null;

  async function dispatchSplit(params: Record<string, unknown>): Promise<string> {
    let response: { ok: boolean; result?: { surfaceId?: string } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.split,
          params,
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();
    expect(response?.ok).toBe(true);
    return response!.result!.surfaceId!;
  }

  /** `dor kill --dangerously` on one surface; returns the control response. */
  async function dispatchKill(surface: string): Promise<{ ok: boolean } | undefined> {
    let response: { ok: boolean } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.kill,
          params: { surface, confirmation: { mode: 'dangerously' } },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();
    return response;
  }

  async function dispatchAgentBrowser(params: Record<string, unknown>): Promise<string> {
    let response: { ok: boolean; result?: { surfaceId?: string } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.agentBrowser,
          params,
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();
    expect(response?.ok).toBe(true);
    return response!.result!.surfaceId!;
  }

  /** `dor iframe <url>`; returns the new surface's `{ id, ref }`. */
  async function dispatchIframe(url: string): Promise<{ id: string; ref: string }> {
    let response: { ok: boolean; result?: { surfaceId: string; surfaceRef: string } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.iframe,
          params: { url },
          respond: (r: typeof response) => { response = r; },
        },
      }));
    });
    await flush();
    expect(response?.ok).toBe(true);
    return { id: response!.result!.surfaceId, ref: response!.result!.surfaceRef };
  }

  /** `dor ab --surface <handle>`'s host half; returns the raw control response. */
  /** `dor ab --key <name>` asking this Wall what that key's session is called. */
  async function dispatchResolveAgentBrowserKey(key: string): Promise<unknown> {
    let response: unknown;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.resolveAgentBrowser,
          params: { key },
          respond: (r: unknown) => { response = r; },
        },
      }));
    });
    await flush();
    return response;
  }

  async function dispatchResolveAgentBrowser(surface: string): Promise<unknown> {
    let response: unknown;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', {
        detail: {
          method: SURFACE_CONTROL_METHODS.resolveAgentBrowser,
          params: { surface },
          respond: (r: unknown) => { response = r; },
        },
      }));
    });
    await flush();
    return response;
  }

  it('dor split transfers focus to the new surface (passthrough)', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" />);
    });
    await flush();
    // The seeded pane starts focused (passthrough + selected).
    expect(focusOf('pane-a')).toBe('true');

    const newId = await dispatchSplit({ direction: 'right' });

    // Focus moves to the freshly split surface; the caller is no longer focused.
    expect(focusOf(newId)).toBe('true');
    expect(focusOf('pane-a')).toBe('false');
  });

  it('dor split -- <command> keeps focus on the calling surface (passthrough)', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" />);
    });
    await flush();
    expect(focusOf('pane-a')).toBe('true');

    // The CLI marks a `-- <command>` split focus-neutral (it always sends
    // focusNeutral when `--` or a command is present).
    const newId = await dispatchSplit({ direction: 'right', command: ['echo', 'hi'], focusNeutral: true });

    // The initial command runs in the background: the caller keeps focus and the
    // new surface is not focused.
    expect(focusOf('pane-a')).toBe('true');
    expect(focusOf(newId)).toBe('false');
  });

  it('keeps dor agent-browser focus-neutral but enters passthrough for a user port activation', async () => {
    const defaultSession = sessionForKey('default');
    const onEvent = vi.fn();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);

    try {
      // The CLI arm creates Browser B without moving selection or keyboard input
      // away from the passthrough terminal.
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" onEvent={onEvent} />);
      });
      await flush();
      expect(focusOf('pane-a')).toBe('true');

      await dispatchAgentBrowser({
        session: defaultSession,
        surface: 'surface:1',
      });
      expect(focusOf('pane-a')).toBe('true');

      // Return to command mode, then invoke the human right-click path. Even
      // from command mode, activating a port is an explicit focus request:
      // Browser B becomes selected in passthrough.
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 1, bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 2, bubbles: true }));
      });
      await flush();

      (fake as PlatformAdapter).agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      (fake as PlatformAdapter).agentBrowserOpen = vi.fn(async () => ({ ok: true, session: 'context-browser', wsPort: 4321 }));
      if (!fake.hasPty('pane-a')) fake.spawnPty('pane-a');
      fake.setOpenPorts('pane-a', [{
        protocol: 'tcp',
        family: 'IPv4',
        address: '127.0.0.1',
        port: 5173,
        pid: 100,
        processName: 'vite',
      }]);
      onEvent.mockClear();

      const header = container.querySelector<HTMLElement>('[data-pane-header-for="pane-a"]')!;
      await act(async () => {
        header.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 10,
          clientY: 10,
        }));
      });
      await flush();

      const portRow = document.querySelector<HTMLButtonElement>(
        '[data-terminal-context] button[aria-label="Open in agent-browser screencast"]',
      );
      expect(portRow).not.toBeNull();
      const contextMenu = portRow!.closest('[data-terminal-context]')!;
      expect(contextMenu.closest('[data-lath-leaf]')).toBeNull();
      expect(contextMenu.closest('.lath-host')).toBe(header.closest('.lath-host'));
      expect(contextMenu.closest('.lath-leaf-body')).toBeNull();
      await act(async () => {
        portRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();

      expect(onEvent).toHaveBeenCalledWith({ type: 'selectionChange', id: expect.any(String), kind: 'pane' });
      expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
      expect(onEvent).toHaveBeenCalledWith({ type: 'modeChange', mode: 'passthrough' });
      expect((fake as PlatformAdapter).agentBrowserOpen).toHaveBeenCalledWith('http://localhost:5173/', { headed: false }, undefined);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('dor split -- (empty tail) opens a blank surface without stealing focus', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" />);
    });
    await flush();
    expect(focusOf('pane-a')).toBe('true');

    // No command, but focusNeutral marks the `--` tail: a blank terminal that
    // does not grab the user's keystrokes (unlike a bare `dor split`).
    const newId = await dispatchSplit({ direction: 'right', focusNeutral: true });

    expect(focusOf('pane-a')).toBe('true');
    expect(focusOf(newId)).toBe('false');
  });

  // --- Notepad closure (docs/specs/notepad.md → "Closure") ---

  /** What the host actually stored. */
  async function storedArchive(): Promise<NotepadArchiveV1> {
    const loaded = await fake.notepadArchive.load();
    return (loaded?.raw ?? { version: 1, batches: [] }) as NotepadArchiveV1;
  }

  /** The Keep open / Close anyway prompt, when it is up. */
  function archiveFailureModal(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[aria-labelledby="notepad-archive-failure-title"]');
  }

  /** Answer the prompt and settle the closure it starts. `Close anyway` runs an async
   *  chain that ends on the two-phase kill's deferred removal timer, so the click's
   *  own async work is awaited BEFORE `flush()` registers the timer that has to fire
   *  after it. A bare `act(click)` leaves the two `setTimeout(0)`s racing: the
   *  removal is registered while the test awaits `flush()`, so it lands second and
   *  the leaf is still mid-fade when the assertion runs. (`Keep open` only shifts the
   *  prompt queue, so it needs no ordering — one helper still covers both.) */
  async function clickButton(label: string): Promise<void> {
    const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
      .find((candidate) => candidate.textContent?.trim() === label);
    expect(button, `no "${label}" button`).toBeDefined();
    await act(async () => { button!.click(); });
    await flush();
  }

  /** A pane header control; Kill is a user-visible closure, which does prompt.
   *  `isUntouched` short-circuits the kill confirmation so a kill is one click. */
  async function clickHeaderControl(paneId: string, label: 'Kill' | 'Minimize'): Promise<void> {
    const untouched = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    try {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-lath-leaf="${paneId}"] button[aria-label="${label}"]`,
      );
      expect(button, `no ${label} button on ${paneId}`).not.toBeNull();
      await act(async () => {
        button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();
    } finally {
      untouched.mockRestore();
    }
  }

  /** A Helper on pane-a whose host work inspection answers `busy`, switchable mid-test. */
  function spyOnHelper(): { dispose: ReturnType<typeof vi.spyOn>; setBusy: (value: boolean) => void } {
    let helper: helpers.HelperTerminal | undefined = { id: 'helper-a', parentId: 'pane-a', command: '', status: 'off' };
    let busy = false;
    vi.spyOn(helpers, 'getHelper').mockImplementation(id => id === 'pane-a' ? helper : undefined);
    vi.spyOn(helpers, 'helperHasWork').mockImplementation(async () => busy);
    vi.spyOn(helpers, 'openHelper').mockImplementation(async () => helper!);
    const dispose = vi.spyOn(helpers, 'closeHelperParent').mockImplementation(() => { helper = undefined; });
    return { dispose, setBusy: (value) => { busy = value; } };
  }

  async function renderNotedPane(): Promise<void> {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
    await flush();
    act(() => { addPlainNote('pane-a', 'shared helper note'); });
  }

  it('closes an idle Helper with its source and archives the shared notes once', async () => {
    const { dispose } = spyOnHelper();
    await renderNotedPane();
    expect((await dispatchKill('surface:1'))?.ok).toBe(true);
    await flush();
    expect(getNotes('pane-a')).toEqual([]);
    expect(dispose).toHaveBeenCalledWith('pane-a');
    expect((await storedArchive()).batches).toHaveLength(1);
  });

  it('refuses a source whose Helper has running work before touching the archive', async () => {
    const { dispose, setBusy } = spyOnHelper();
    const save = vi.spyOn(fake.notepadArchive, 'save');
    setBusy(true);
    await renderNotedPane();
    expect((await dispatchKill('surface:1'))?.ok).toBe(false);
    await flush();
    expect(getNotes('pane-a')).toHaveLength(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  // The kill gesture (`requestKill`): docs/specs/layout.md → "Kill confirmation".
  const confirmKillOverlay = () => Array.from(document.body.querySelectorAll('h2')).find(h => h.textContent === 'Confirm kill') ?? null;

  it('closes an untouched pane at once and stages the confirm overlay for a touched one', async () => {
    const untouched = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />));
    await flush();
    const kill = (id: string) => act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-lath-leaf="${id}"] button[aria-label="Kill"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await kill('pane-b');
    await flush();
    expect(confirmKillOverlay()).toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-b"]')).toBeNull();
    untouched.mockReturnValue(false);
    await kill('pane-a');
    expect(confirmKillOverlay()).not.toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
  });

  /** Minimize pane-a beside pane-b (the Door stays selected) and press the kill key on it. */
  async function killSelectedDoor(): Promise<void> {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />));
    await flush();
    await act(async () => { container.querySelector<HTMLElement>('[data-lath-leaf="pane-a"] [aria-label="Minimize"]')!.click(); });
    await flush();
    expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })); });
    await flushFrame();
    await flush();
  }

  it('reattaches an untouched Door only far enough to close it, with no overlay', async () => {
    vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    await killSelectedDoor();
    expect(container.querySelector('[data-door-id="pane-a"]')).toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).toBeNull();
    expect(confirmKillOverlay()).toBeNull();
  });

  it('reattaches a touched Door into the confirm overlay', async () => {
    vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    await killSelectedDoor();
    expect(container.querySelector('[data-door-id="pane-a"]')).toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(confirmKillOverlay()).not.toBeNull();
  });

  it.each([
    ['pane-a', 'pane-b', true],
    ['pane-b', 'pane-c', true],
    ['pane-c', 'pane-b', true],
    ['pane-b', 'pane-c', false],
  ] as const)('returns keyboard focus from deleted Door %s to %s (confirm: %s)', async (target, next, confirm) => {
    vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(!confirm);
    const onEvent = vi.fn();
    await act(async () => root.render(<Wall initialPaneIds={['pane-live', 'pane-a', 'pane-b', 'pane-c']} initialMode="command" onEvent={onEvent} />));
    await flush();
    for (const id of ['pane-a', 'pane-b', 'pane-c']) {
      await act(async () => { container.querySelector<HTMLElement>(`[data-lath-leaf="${id}"] [aria-label="Minimize"]`)!.click(); });
      await flush();
    }
    const press = async (key: string) => {
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
      await flush();
    };
    for (let i = ['pane-a', 'pane-b', 'pane-c'].indexOf(target); i < 2; i++) await press('ArrowLeft');
    await press('x');
    await flushFrame();
    await flush();
    if (confirm) {
      expect(confirmKillOverlay()).not.toBeNull();
      expect(container.querySelector(`[data-lath-leaf="${target}"]`)).not.toBeNull();
      await press(document.body.querySelector('.text-xl')!.textContent!);
      await flush();
    }
    expect(container.querySelector(`[data-lath-leaf="${target}"]`)).toBeNull();
    expect(onEvent.mock.calls.filter(([event]) => event.type === 'selectionChange').at(-1)?.[0])
      .toEqual({ type: 'selectionChange', id: next, kind: 'door' });
    expect(container.querySelector('[data-focused="true"]')).toBeNull();
  });

  it('drops a kill gesture whose Helper inspection outlives the pane', async () => {
    vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    const helper: helpers.HelperTerminal = { id: 'helper-a', parentId: 'pane-a', command: '', status: 'off' };
    vi.spyOn(helpers, 'getHelper').mockImplementation(id => id === 'pane-a' ? helper : undefined);
    vi.spyOn(helpers, 'closeHelperParent').mockImplementation(() => {});
    const inspections: Array<(busy: boolean) => void> = [];
    vi.spyOn(helpers, 'helperHasWork').mockImplementation(() => new Promise<boolean>(resolve => { inspections.push(resolve); }));
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />));
    await flush();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-lath-leaf="pane-a"] button[aria-label="Kill"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(inspections).toHaveLength(1);
    // A `dor kill` lands while the gesture's inspection is still pending and
    // closes the pane first (its own two inspections answered idle).
    let killed: { ok: boolean } | undefined;
    window.dispatchEvent(new CustomEvent('dormouse:control-request', {
      detail: { method: SURFACE_CONTROL_METHODS.kill, params: { surface: 'surface:1', confirmation: { mode: 'dangerously' } }, respond: (r: typeof killed) => { killed = r; } },
    }));
    for (const index of [1, 2]) {
      await act(async () => { while (inspections.length <= index) await new Promise(r => setTimeout(r, 0)); });
      await act(async () => { inspections[index](false); });
    }
    await flush();
    expect(killed?.ok).toBe(true);
    await act(async () => { inspections[0](false); });
    await flush();
    expect(confirmKillOverlay()).toBeNull();
  });

  it('keeps the notes and pending batch when Helper work starts during the write, replacing the batch on retry', async () => {
    const { dispose, setBusy } = spyOnHelper();
    const saveOriginal = fake.notepadArchive.save.bind(fake.notepadArchive);
    const save = vi.spyOn(fake.notepadArchive, 'save').mockImplementation(async (...args) => {
      const result = await saveOriginal(...args);
      setBusy(true);
      return result;
    });
    await renderNotedPane();
    expect((await dispatchKill('surface:1'))?.ok).toBe(false);
    await flush();
    expect(getNotes('pane-a')).toHaveLength(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect((await storedArchive()).batches).toHaveLength(1);
    setBusy(false);
    save.mockImplementation(saveOriginal);
    expect((await dispatchKill('surface:1'))?.ok).toBe(true);
    expect((await storedArchive()).batches).toHaveLength(1);
    expect(getNotes('pane-a')).toEqual([]);
  });

  it('runs the Helper guard again before Close anyway discards the notes', async () => {
    const { dispose, setBusy } = spyOnHelper();
    vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk full'));
    await renderNotedPane();
    await clickHeaderControl('pane-a', 'Kill');
    expect(archiveFailureModal()).not.toBeNull();
    setBusy(true);
    await clickButton('Close anyway');
    expect(getNotes('pane-a')).toHaveLength(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
  });

  it('archives a closing Surface\'s notes before tearing it down', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    act(() => { addPlainNote('pane-a', 'ssh key is in 1password'); });

    expect((await dispatchKill('surface:1'))?.ok).toBe(true);
    await flush();

    const archive = await storedArchive();
    expect(archive.batches).toHaveLength(1);
    expect(archive.batches[0].notes[0].content).toEqual({ kind: 'plain', text: 'ssh key is in 1password' });
    // The metadata resolver the Wall installs supplies the derived pane label.
    expect(archive.batches[0].surfaceKind).toBe('terminal');
    expect(getNotes('pane-a')).toEqual([]);
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).toBeNull();
  });

  it('keeps the Surface and asks when the archive refuses the write', async () => {
    vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    act(() => { addPlainNote('pane-a', 'keep me'); });

    await clickHeaderControl('pane-a', 'Kill');

    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(getNotes('pane-a')).toHaveLength(1);
    expect(archiveFailureModal()).not.toBeNull();
  });

  it('answers a refused `dor kill` with the error and raises no prompt', async () => {
    // The caller is a command, not someone looking at the Wall: a modal here
    // would block a Wall nobody is watching (docs/specs/notepad.md → "Closure").
    vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    act(() => { addPlainNote('pane-a', 'keep me'); });

    const response = await dispatchKill('surface:1');
    await flush();

    expect(response?.ok).toBe(false);
    expect((response as { error?: string }).error).toContain('notepad archive failed');
    expect((response as { error?: string }).error).toContain('disk is full');
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(getNotes('pane-a')).toHaveLength(1);
    expect(archiveFailureModal()).toBeNull();
  });

  it('Keep open dismisses the prompt and leaves everything alone', async () => {
    vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    act(() => { addPlainNote('pane-a', 'keep me'); });
    await clickHeaderControl('pane-a', 'Kill');

    await clickButton('Keep open');

    expect(archiveFailureModal()).toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(getNotes('pane-a')).toHaveLength(1);
  });

  it('Close anyway discards the notes and removes the Surface without a batch', async () => {
    vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    act(() => { addPlainNote('pane-a', 'expendable'); });
    await clickHeaderControl('pane-a', 'Kill');

    await clickButton('Close anyway');

    expect(archiveFailureModal()).toBeNull();
    await vi.waitFor(async () => {
      await flush();
      expect(container.querySelector('[data-lath-leaf="pane-a"]')).toBeNull();
    });
    expect(getNotes('pane-a')).toEqual([]);
    expect((await storedArchive()).batches).toEqual([]);
  });

  it('queues a second refused closure behind the first prompt', async () => {
    // One slot would leave pane-a waiting forever: its prompt is replaced, and
    // nothing is left to answer for it.
    // Distinct messages are how the prompt on screen names its Surface.
    vi.spyOn(fake.notepadArchive, 'save')
      .mockRejectedValueOnce(new Error('a could not be written'))
      .mockRejectedValueOnce(new Error('b could not be written'));
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />);
    });
    await flush();
    act(() => {
      addPlainNote('pane-a', 'from a');
      addPlainNote('pane-b', 'from b');
    });

    await clickHeaderControl('pane-a', 'Kill');
    await clickHeaderControl('pane-b', 'Kill');

    // A's prompt is the one on screen; B's is behind it.
    expect(archiveFailureModal()?.textContent).toContain('a could not be written');
    await clickButton('Keep open');

    expect(archiveFailureModal()?.textContent).toContain('b could not be written');
    await clickButton('Close anyway');

    expect(archiveFailureModal()).toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(getNotes('pane-a')).toHaveLength(1);
    await vi.waitFor(async () => {
      await flush();
      expect(container.querySelector('[data-lath-leaf="pane-b"]')).toBeNull();
    });
  });

  it('migrates a notepad to the new id when a replacement mints one', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />);
    });
    await flush();
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation((id) => id === 'pane-a');

    try {
      act(() => { addPlainNote('pane-a', 'survives the swap'); });

      let response: { ok: boolean; result?: { surfaceId: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.iframe,
            params: { url: 'http://localhost:5173/' },
            respond: (r: typeof response) => { response = r; },
          },
        }));
      });
      await flush();

      const newId = response!.result!.surfaceId;
      expect(newId).not.toBe('pane-a');
      expect(getNotes('pane-a')).toEqual([]);
      expect(getNotes(newId).map((note) => note.content)).toEqual([{ kind: 'plain', text: 'survives the swap' }]);
      // A replacement is not a closure, so nothing was archived.
      expect((await storedArchive()).batches).toEqual([]);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('seeds multiple initial panes with the aspect-aware layout (geometry is measured before the seed)', async () => {
    // jsdom has no layout, so stub the container measurement wide. The seed reads the
    // store's geometry via `autoEdge`; if that geometry lags behind the measurement
    // (the old passive-effect report left it at the initial 0×0 on mount), the aspect
    // heuristic sees a square and stacks every pane vertically. A wide container must
    // instead produce `row[A, col[B,C]]`: A is the full-height left column.
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 740, width: 1200, height: 740, toJSON() {} } as DOMRect;
    };
    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a', 'pane-b', 'pane-c']} initialMode="command" />);
      });
      await flush();

      const leafOf = (id: string) => container.querySelector<HTMLElement>(`[data-lath-leaf="${id}"]`);
      const heightOf = (id: string) => parseFloat(leafOf(id)!.style.height);
      const leftOf = (id: string) => parseFloat(leafOf(id)!.style.left);

      expect(leafCount()).toBe(3);
      // A is the left column: full container height and flush to the left edge.
      expect(heightOf('pane-a')).toBeGreaterThan(700);
      expect(leftOf('pane-a')).toBe(0);
      // B and C share the right column: offset right and each roughly half-height —
      // i.e. NOT a pure vertical stack (which would leave all three at left:0).
      expect(leftOf('pane-b')).toBeGreaterThan(0);
      expect(leftOf('pane-c')).toBeGreaterThan(0);
      expect(heightOf('pane-b')).toBeLessThan(500);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origRect;
    }
  });

  it('registers exactly one handle, under the default Workspace, for a bare Wall', async () => {
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
    await flush();
    // The compatibility rule: a Wall with no `workspaceId` still registers, so
    // the `dor` router always finds one (docs/specs/layout.md → "Workspaces").
    expect(listWallHandles()).toHaveLength(1);
    const handle = getWallHandle(DEFAULT_WORKSPACE_ID)!;
    expect(handle.surfaceIds()).toEqual(['pane-a']);
    expect(handle.ownsSurface('pane-a')).toBe(true);
    expect(handle.ownsSurface('pane-elsewhere')).toBe(false);
  });

  it('unmounting leaves every PTY alive and every registry entry intact', async () => {
    // The two teardown verbs are explicit handle methods, never unmount
    // effects: a Wall unmounts on a reload, a StrictMode double-mount, and a
    // Workspace switch, and killing or releasing there would cost the user
    // every Session (`releaseSession` in `lib/src/lib/terminal-lifecycle.ts`).
    const killPty = vi.spyOn(fake, 'killPty');
    const dispose = vi.spyOn(terminalRegistry, 'disposeSession');
    const release = vi.spyOn(terminalRegistry, 'releaseSession');
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} />));
    await flush();
    const handle = getWallHandle(DEFAULT_WORKSPACE_ID)!;
    expect(handle.surfaceIds()).toEqual(['pane-a', 'pane-b']);

    await act(async () => root.render(<></>));
    await flush();

    expect(dispose).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(killPty).not.toHaveBeenCalled();
    // The handle deregisters, so nothing addresses the gone Wall — but the
    // Sessions it held are untouched.
    expect(getWallHandle(DEFAULT_WORKSPACE_ID)).toBeNull();
  });

  it('names the command that drives a browser run by the other provider', async () => {
    (fake as PlatformAdapter).playwright = vi.fn(async (request: { op: string }) => (
      request.op === 'streamStatus' ? { ok: true, wsPort: 4555 } : { ok: true }
    ));
    (fake as PlatformAdapter).agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
      await flush();
      let created: { ok: boolean; result?: { surfaceRef: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.browser,
            params: { provider: 'playwright', session: 'dormouse.pw.abc', cwd: '/tmp/project' },
            respond: (r: typeof created) => { created = r; },
          },
        }));
      });
      await flush();
      const pwRef = created!.result!.surfaceRef;
      expect(await dispatchResolveAgentBrowser(pwRef)).toEqual({
        ok: false,
        error: `surface '${pwRef}' is not agent-browser rendered (render_mode: pw-screencast) — drive it with dor pw --surface ${pwRef}`,
      });

      const abId = await dispatchAgentBrowser({ session: 'dormouse.1.default', wsPort: 4321 });
      let resolved: unknown;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.resolveBrowser,
            params: { provider: 'playwright', surface: abId },
            respond: (r: unknown) => { resolved = r; },
          },
        }));
      });
      await flush();
      expect(resolved).toEqual({
        ok: false,
        error: expect.stringMatching(/^surface '(surface:\d+)' is not playwright rendered \(render_mode: ab-screencast\) — drive it with dor ab --surface \1$/),
      });
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('refuses an https:// surface.iframe on a host that proxies, naming dor ab open', async () => {
    const respond = async (url: string) => {
      let response: { ok: boolean; error?: string } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: { method: SURFACE_CONTROL_METHODS.iframe, params: { url }, respond: (r: typeof response) => { response = r; } },
        }));
      });
      await flush();
      return response;
    };
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
    await flush();

    // Without the proxy the raw frame shows it, so only a proxying host refuses.
    expect((await respond('https://example.com/'))?.ok).toBe(true);
    (fake as PlatformAdapter).createIframeProxyUrl = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:61234/' }));
    expect(await respond('https://example.com/')).toEqual({
      ok: false,
      error: 'the embedded view frames http:// pages only — open it with dor ab open https://example.com/',
    });
    expect((await respond('http://localhost:5173/'))?.ok).toBe(true);
  });

  it('opens a new https:// tab from an iframe as an agent-browser pane bound to its launch', async () => {
    const launches: Array<(result: { ok: boolean; session?: string; wsPort?: number; error?: string }) => void> = [];
    (fake as PlatformAdapter).createIframeProxyUrl = vi.fn(async () => ({ ok: true as const, url: 'http://127.0.0.1:61234/' }));
    (fake as PlatformAdapter).agentBrowserOpen = vi.fn(() => new Promise((resolve) => { launches.push(resolve); }));
    (fake as PlatformAdapter).agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    try {
      await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
      await flush();
      const iframe = await dispatchIframe('http://localhost:5173/');
      const leafIds = () => Array.from(container.querySelectorAll<HTMLElement>('[data-lath-leaf]')).map((leaf) => leaf.dataset.lathLeaf!);
      const openTab = async (url: string) => {
        await act(async () => {
          window.dispatchEvent(new MessageEvent('message', { origin: 'http://127.0.0.1:61234', data: { __dormouse: 'open-window', url } }));
        });
        const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Open in agent-browser')!;
        await act(async () => { button.click(); });
        await flush();
      };

      const before = leafIds();
      await openTab('https://accounts.example/login');
      const [tab] = leafIds().filter((id) => !before.includes(id));
      expect(tab).toBeTruthy();
      expect(fake.agentBrowserOpen).toHaveBeenCalledWith('https://accounts.example/login', { headed: false }, undefined);
      // The pane is there at once; `dor ab --surface` has nothing to drive until the launch names it.
      expect(await dispatchResolveAgentBrowser(tab)).toMatchObject({ ok: false });
      await act(async () => { launches[0]({ ok: true, session: 'dormouse.1.gui-abc', wsPort: 4321 }); });
      await flush();
      expect(await dispatchResolveAgentBrowser(tab)).toMatchObject({ ok: true, result: { session: 'dormouse.1.gui-abc' } });

      // Nor can it be swapped back into an iframe that would refuse it.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await act(async () => { getAgentBrowserScreenController(tab)?.actions.setRenderMode?.('iframe'); });
      await flush();
      expect(leafIds()).toContain(tab);
      expect(getAgentBrowserScreenController(tab)?.snapshot().renderMode).toBe('ab-screencast');
      expect(warn).toHaveBeenCalledWith(`[dormouse] cannot swap surface '${tab}' to iframe: the embedded view frames http:// pages only`);

      // The swap judges the page on screen, as the Display modal does — here a
      // local http:// page, though params.url still names the https login.
      const real = getAgentBrowserScreenController(tab)!;
      const lookup = agentBrowserScreen.getAgentBrowserScreenController;
      // Stable objects, as the ScreenController contract requires.
      const shownChrome = { ...real.chrome(), url: 'http://localhost:5173/report' };
      const shownController = { ...real, chrome: () => shownChrome };
      const shown = vi.spyOn(agentBrowserScreen, 'getAgentBrowserScreenController').mockImplementation((id) => (
        id === tab ? shownController : lookup(id)));
      const beforeSwap = leafIds();
      await act(async () => { real.actions.setRenderMode?.('iframe'); });
      await flush();
      shown.mockRestore();
      const [framed] = leafIds().filter((id) => !beforeSwap.includes(id));
      expect(getAgentBrowserScreenController(framed)?.chrome().url).toBe('http://localhost:5173/report');

      // A launch that fails takes its pane with it.
      const beforeFailure = leafIds();
      await openTab('https://other.example/');
      const [failed] = leafIds().filter((id) => !beforeFailure.includes(id));
      await act(async () => { launches[1]({ ok: false, error: 'agent-browser binary not found' }); });
      await flush();
      expect(leafIds()).not.toContain(failed);
      expect(leafIds()).toContain(iframe.id);
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('names the Window that answered `dor list`, once the host has named it', async () => {
    // A caller needs a ref it can hand back, and with several Windows open
    // `window:1` names none of them (docs/specs/dor-cli.md -> "Handle Model").
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} />));
    await flush();

    const list = async (): Promise<{ workspaceRef: string; windowRef: string }> => {
      let listed: { result?: { workspaceRef: string; windowRef: string } } | undefined;
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.list,
            params: {},
            respond: (r: typeof listed) => { listed = r; },
          },
        }));
      });
      await flush();
      return listed!.result!;
    };

    // A Window that never names itself, which is every host but standalone.
    expect(await list()).toMatchObject({ workspaceRef: 'workspace:1', windowRef: 'window:1' });

    setWindowLabel('ws-3');
    expect(await list()).toMatchObject({ workspaceRef: 'workspace:1', windowRef: 'window:ws-3' });
  });
});

describe('Wall session persistence: ownership filtering', () => {
  /** The pty-data handlers the Wall and the registry registered, invoked
   *  directly. Going through `FakePtyAdapter.writePty` would also move the alert
   *  manager, whose activity change marks the session dirty on its own — this
   *  isolates the ownership filter under test. */
  function capturePtyHandlers(): Array<(detail: { id: string; data: string; textData: string }) => void> {
    const handlers: Array<(detail: { id: string; data: string; textData: string }) => void> = [];
    const subscribe = fake.onPtyData.bind(fake);
    vi.spyOn(fake, 'onPtyData').mockImplementation((handler) => {
      handlers.push(handler as (detail: { id: string; data: string; textData: string }) => void);
      subscribe(handler);
    });
    return handlers;
  }

  it('marks a minimized Session\'s pty echo dirty, and ignores a foreign Session\'s', async () => {
    vi.useFakeTimers();
    try {
      const ptyHandlers = capturePtyHandlers();
      const saveState = vi.spyOn(fake, 'saveState');
      const settle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
      const echo = (id: string) => act(() => {
        ptyHandlers.forEach((handler) => handler({ id, data: '', textData: '' }));
      });

      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />);
      });
      await settle(0);
      await act(async () => {
        container.querySelector<HTMLElement>('[data-lath-leaf="pane-a"] [aria-label="Minimize"]')!.click();
      });
      // Past the debounce, so the commit's own save has landed and the tracker
      // is clean again.
      await settle(1_000);
      expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();
      saveState.mockClear();

      // The heartbeat writes only when something marked dirty.
      await settle(31_000);
      expect(saveState).not.toHaveBeenCalled();

      // Another Workspace's Session, fanned to this Wall by the adapter.
      await echo('pane-elsewhere');
      await settle(31_000);
      expect(saveState).not.toHaveBeenCalled();

      // The Door's own Session: its `untouched` flip rides this echo and nothing
      // else reports it, so the Wall has to hear it.
      await echo('pane-a');
      await settle(31_000);
      expect(saveState).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an activity or pane-state change belonging to another Workspace', async () => {
    vi.useFakeTimers();
    try {
      const saveState = vi.spyOn(fake, 'saveState');
      const settle = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} />);
      });
      // Past a heartbeat, so the mount's own dirty state has been written off.
      await settle(31_000);
      saveState.mockClear();

      // Both stores are Window-global. A change keyed to a foreign Surface must
      // not make this Wall rebuild its record — that is a `getCwd` per pane, on
      // every idle Workspace, every heartbeat.
      await act(async () => { setTerminalActivity('pane-elsewhere', { todo: true }); });
      await act(async () => { resetTerminalPaneState('pane-elsewhere'); });
      await settle(31_000);
      expect(saveState, 'foreign Surface').not.toHaveBeenCalled();

      await act(async () => { setTerminalActivity('pane-a', { todo: true }); });
      await settle(31_000);
      expect(saveState, 'own Surface').toHaveBeenCalled();
      saveState.mockClear();

      // An unkeyed notification is a store-wide reset, which every Wall takes.
      await act(async () => { clearTerminalActivity(); });
      await settle(31_000);
      expect(saveState, 'store-wide reset').toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});


it('shares one primary terminal and notepad between a Tool pane and Terminal Context', async () => {
  const openHelper = vi.spyOn(helpers, 'openHelper');
  const params = { surfaceType: 'tool', command: 'pnpm storybook', toolRender: 'iframe', toolPort: 'announced' };
  await act(async () => root.render(<Wall restoredLathLayout={{ version: 1, tree: { root: { kind: 'leaf', id: 'tool-context' } }, leafMeta: {
    'tool-context': { component: 'tool', tabComponent: 'tool', title: 'Storybook', params },
  } }} initialMode="command" />));
  await flush();
  act(() => { addPlainNote('tool-context', 'Keep this note'); setOpenNotepadId('tool-context'); });
  expect(container.querySelectorAll('[data-notepad-panel-for="tool-context"]')).toHaveLength(1);
  act(() => setOpenNotepadId(null));
  act(() => container.querySelector('[data-lath-leaf="tool-context"] .lath-leaf-header')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  // The header's terminal label is the context entry point.
  if (!container.querySelector('[data-terminal-context]')) {
    act(() => container.querySelector('[data-session-id="tool-context"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  }
  await flush();
  expect(openHelper).not.toHaveBeenCalled();
  expect(container.querySelector('[data-context-terminal="tool-context"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-session-id="tool-context"]')).toHaveLength(1);
  act(() => setOpenNotepadId('tool-context'));
  expect(container.querySelectorAll('[data-notepad-panel-for="tool-context"]')).toHaveLength(1);
  act(() => setOpenNotepadId(null));
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Close terminal context"]')!.click());
  await flush();
  expect(container.querySelectorAll('[data-session-id="tool-context"]')).toHaveLength(1);
  expect(getNotes('tool-context').map(note => note.content)).toEqual([{ kind: 'plain', text: 'Keep this note' }]);
  let mountedDuringRefit = false;
  const refit = vi.spyOn(terminalRegistry, 'refitSession').mockImplementation(() => {
    mountedDuringRefit = container.querySelector('[data-context-terminal="tool-context"] [data-session-id="tool-context"]') !== null;
  });
  act(() => {
    window.dispatchEvent(new CustomEvent('dormouse:reveal-note-source', { detail: { surfaceId: 'tool-context' } }));
    // Pin resolution follows synchronously, before the React event returns.
    expect(refit).toHaveBeenCalledExactlyOnceWith('tool-context');
    expect(mountedDuringRefit).toBe(true);
  });

});

it('leaves a reveal for a hidden Workspace unanswered', async () => {
  // A hidden Wall consumes no window input (docs/specs/layout.md →
  // "Workspaces"): opening the context here would mount chrome nobody can see
  // and refit a terminal whose element is detached.
  const params = { surfaceType: 'tool', command: 'pnpm storybook', toolRender: 'iframe', toolPort: 'announced' };
  await act(async () => root.render(<Wall active={false} restoredLathLayout={{ version: 1, tree: { root: { kind: 'leaf', id: 'tool-hidden' } }, leafMeta: {
    'tool-hidden': { component: 'tool', tabComponent: 'tool', title: 'Storybook', params },
  } }} initialMode="command" />));
  await flush();
  const refit = vi.spyOn(terminalRegistry, 'refitSession');
  act(() => {
    window.dispatchEvent(new CustomEvent('dormouse:reveal-note-source', { detail: { surfaceId: 'tool-hidden' } }));
  });
  expect(refit).not.toHaveBeenCalled();
  expect(container.querySelector('[data-terminal-context]')).toBeNull();
});

/**
 * Engagement (`docs/specs/alert.md` -> Engagement): the Wall reports which
 * terminal Session it points the realm at, and which gestures acknowledge.
 */
describe('engagement', () => {
  function reportedFocus(report: ReturnType<typeof vi.spyOn>): string | null | undefined {
    return (report.mock.calls.at(-1)?.[0] as { focusId: string | null } | undefined)?.focusId;
  }

  /** A human at the window: the reporter sends focus only while present. */
  async function present(): Promise<void> {
    await act(async () => { window.dispatchEvent(new Event('pointermove')); });
  }

  async function key(name: string): Promise<void> {
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })); });
  }

  async function commandMode(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 1, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', location: 2, bubbles: true }));
    });
  }

  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  });

  it('points at the passthrough pane, and at nothing from command mode or a Door', async () => {
    const report = vi.spyOn(fake, 'alertEngagement');
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="passthrough" />));
    await flush();
    await present();
    expect(reportedFocus(report)).toBe('pane-a');

    await commandMode();
    expect(reportedFocus(report)).toBeNull();

    await act(async () => {
      container.querySelector('[data-lath-leaf="pane-b"] [data-session-id="pane-b"]')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(reportedFocus(report)).toBe('pane-b');

    await key('m');
    await commandMode();
    await key('m');
    await flush();
    expect(container.querySelector('[data-door-id="pane-b"]')).not.toBeNull();
    expect(reportedFocus(report)).toBeNull();
  });

  it('points at the source while its terminal context is open, even from command mode', async () => {
    const report = vi.spyOn(fake, 'alertEngagement');
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" />));
    await flush();
    await present();
    expect(reportedFocus(report)).toBeNull();

    const header = container.querySelector<HTMLElement>('[data-pane-header-for="pane-a"]')!;
    await act(async () => { header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 })); });
    expect(reportedFocus(report)).toBe('pane-a');
  });

  it('points at nothing from a browser Surface in passthrough', async () => {
    const report = vi.spyOn(fake, 'alertEngagement');
    await act(async () => root.render(<Wall
      restoredLathLayout={{
        version: 1,
        tree: { root: { kind: 'leaf', id: 'browser-a' } },
        leafMeta: {
          'browser-a': {
            component: 'browser',
            tabComponent: 'surface',
            title: 'example.com',
            params: { surfaceType: 'browser', renderMode: 'iframe', url: 'https://example.com' },
          },
        },
      }}
      initialMode="passthrough"
    />));
    await flush();
    await present();
    expect(reportedFocus(report)).toBeNull();
  });

  it('points at nothing from a hidden Workspace', async () => {
    const report = vi.spyOn(fake, 'alertEngagement');
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" active={false} />));
    await flush();
    await present();
    expect(reportedFocus(report)).toBeNull();
  });

  it('acknowledges a click on a pane and a Door, but not a `d` reattach', async () => {
    const acknowledge = vi.spyOn(terminalRegistry, 'acknowledgeSession');
    await act(async () => root.render(
      <Wall initialPaneIds={['pane-a']} initialDoors={[{ id: 'door-a', title: 'A' }]} initialMode="command" />,
    ));
    await flush();

    await act(async () => {
      container.querySelector('[data-session-id="pane-a"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(acknowledge.mock.calls).toEqual([['pane-a']]);

    await act(async () => { container.querySelector<HTMLElement>('[data-door-id="door-a"] button')!.click(); });
    await flush();
    expect(container.querySelector('[data-lath-leaf="door-a"]')).not.toBeNull();
    expect(acknowledge.mock.calls.at(-1)).toEqual(['door-a']);

    // `m` leaves the new Door selected in command mode; `d` brings it back there.
    await commandMode();
    await key('m');
    await flush();
    expect(container.querySelector('[data-door-id="door-a"]')).not.toBeNull();
    acknowledge.mockClear();
    await key('d');
    await flush();
    expect(container.querySelector('[data-door-id="door-a"]')).toBeNull();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('acknowledges Enter into a pane or through its Door, and zoom', async () => {
    const acknowledge = vi.spyOn(terminalRegistry, 'acknowledgeSession');
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" />));
    await flush();

    await key('Enter');
    expect(acknowledge.mock.calls).toEqual([['pane-a']]);

    // `m` leaves the new Door selected; `Enter` reattaches it into passthrough.
    await commandMode();
    await key('m');
    await flush();
    expect(container.querySelector('[data-door-id="pane-a"]')).not.toBeNull();
    acknowledge.mockClear();
    await key('Enter');
    await flush();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(acknowledge.mock.calls).toEqual([['pane-a']]);

    await commandMode();
    acknowledge.mockClear();
    await key('z');
    await flush();
    expect(container.querySelector('[data-lath-leaf="pane-a"] button[aria-label="Unzoom"]')).not.toBeNull();
    expect(acknowledge.mock.calls).toEqual([['pane-a']]);
  });

  it('acknowledges a zoom and an unzoom from the pane already in passthrough', async () => {
    const acknowledge = vi.spyOn(terminalRegistry, 'acknowledgeSession');
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="passthrough" />));
    await flush();

    await act(async () => { container.querySelector<HTMLElement>('[data-lath-leaf="pane-a"] button[aria-label="Zoom"]')!.click(); });
    await flush();
    expect(container.querySelector('[data-lath-leaf="pane-a"] button[aria-label="Unzoom"]')).not.toBeNull();
    expect(acknowledge.mock.calls).toEqual([['pane-a']]);

    await act(async () => { container.querySelector<HTMLElement>('[data-lath-leaf="pane-a"] button[aria-label="Unzoom"]')!.click(); });
    await flush();
    expect(container.querySelector('[data-lath-leaf="pane-a"] button[aria-label="Zoom"]')).not.toBeNull();
    expect(acknowledge.mock.calls).toEqual([['pane-a'], ['pane-a']]);
  });

  it('acknowledges the dev-server chip jumping to the terminal it names', async () => {
    const acknowledge = vi.spyOn(terminalRegistry, 'acknowledgeSession');
    await act(async () => root.render(<Wall
      restoredLathLayout={{
        version: 1,
        tree: { root: { kind: 'split', dir: 'row', children: [
          { node: { kind: 'leaf', id: 'pane-a' }, weight: 0.5 },
          { node: { kind: 'leaf', id: 'browser-a' }, weight: 0.5 },
        ] } },
        leafMeta: {
          'pane-a': { component: 'terminal', tabComponent: 'terminal', title: 'pnpm dev' },
          'browser-a': {
            component: 'browser',
            tabComponent: 'surface',
            title: 'localhost:5173',
            params: { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173/' },
          },
        },
      }}
      initialMode="command"
    />));
    await flush();
    await act(async () => { setDevServerResolution(5173, { paneId: 'pane-a', label: 'pnpm dev' }); });
    try {
      const chip = container.querySelector<HTMLButtonElement>('button[aria-label^="Focus pnpm dev"]');
      expect(chip).not.toBeNull();

      await act(async () => { chip!.click(); });
      expect(acknowledge.mock.calls).toEqual([['pane-a']]);
    } finally {
      setDevServerResolution(5173, null);
    }
  });

  it('acknowledges no spawn, no split, and no raw frame taking focus', async () => {
    const acknowledge = vi.spyOn(terminalRegistry, 'acknowledgeSession');
    await act(async () => root.render(<Wall
      restoredLathLayout={{
        version: 1,
        tree: { root: { kind: 'leaf', id: 'browser-a' } },
        leafMeta: {
          'browser-a': {
            component: 'browser',
            tabComponent: 'surface',
            title: 'example.com',
            params: { surfaceType: 'browser', renderMode: 'iframe', url: 'https://example.com' },
          },
        },
      }}
      initialMode="command"
    />));
    await flush();

    // Focus alone reaching a frame with no shim enters it, and is no gesture.
    const frame = container.querySelector('iframe')!;
    const activeElement = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    await act(async () => { window.dispatchEvent(new Event('blur')); });
    activeElement.mockRestore();
    expect(container.querySelector('[data-lath-leaf="browser-a"]')).not.toBeNull();
    await commandMode();

    await key('|');
    await flush();
    await act(async () => { window.dispatchEvent(new CustomEvent('dormouse:new-terminal', { detail: {} })); });
    await flush();
    expect(container.querySelectorAll('[data-lath-leaf]')).toHaveLength(3);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('moves focus to a Surface `dor` reveals without acknowledging it', async () => {
    const toolId = 'tool-revealed';
    terminalRegistry.applyTerminalSemanticEvents(toolId, [
      { type: 'commandLine', commandLine: 'pnpm storybook' },
      { type: 'commandStart' },
    ]);
    (fake as FakePtyAdapter & Pick<PlatformAdapter, 'toolControl'>).toolControl = vi.fn(async () => okToolLookup(['/repo']));
    const acknowledge = vi.spyOn(terminalRegistry, 'acknowledgeSession');
    const report = vi.spyOn(fake, 'alertEngagement');
    try {
      await act(async () => root.render(
        <Wall
          initialPaneIds={['pane-a']}
          initialDoors={[{
            id: toolId,
            title: 'storybook',
            component: 'tool',
            tabComponent: 'tool',
            params: {
              surfaceType: 'tool', command: 'pnpm storybook', cwd: '/repo', toolName: 'storybook',
              toolRender: 'iframe', toolPort: 'announced', toolKey: ['storybook', '/repo'],
            },
          }]}
          initialMode="command"
        />,
      ));
      await flush();
      await present();
      await act(async () => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', {
          detail: {
            method: SURFACE_CONTROL_METHODS.tool,
            params: { name: 'storybook', cwd: '/repo', minimized: false, fresh: false },
            respond: () => {},
          },
        }));
      });
      await flush();

      expect(container.querySelector(`[data-lath-leaf="${toolId}"]`)).not.toBeNull();
      expect(reportedFocus(report)).toBe(toolId);
      expect(acknowledge).not.toHaveBeenCalled();
    } finally {
      act(() => terminalRegistry.removeTerminalPaneState(toolId));
    }
  });
});

it('moves a retained helper without resizing or replacing its source, and remembers the manual side', async () => {
  const retained: helpers.HelperTerminal = { id: 'placement-helper', parentId: 'placement-source', command: '', status: 'preserved' };
  vi.spyOn(helpers, 'getHelper').mockImplementation(id => id === 'placement-source' ? retained : undefined);
  const openHelper = vi.spyOn(helpers, 'openHelper').mockResolvedValue(retained);
  await act(async () => root.render(<Wall initialPaneIds={['placement-source']} />));
  await flush();
  const source = container.querySelector<HTMLElement>('[data-lath-leaf="placement-source"]')!;
  const sourceStyle = source.getAttribute('style');
  const open = async () => {
    act(() => container.querySelector('[data-pane-header-for="placement-source"]')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
    await flush();
  };
  await open();
  const menu = container.querySelector<HTMLElement>('[data-terminal-context]')!;
  const terminal = menu.querySelector('[data-helper-terminal]');
  expect(terminal).not.toBeNull();
  act(() => menu.querySelector<HTMLButtonElement>('[aria-label="Place helper at bottom"]')!.click());
  expect(menu.dataset.contextSide).toBe('bottom');
  expect(menu.querySelector('[data-helper-terminal]')).toBe(terminal);
  expect(openHelper).toHaveBeenCalledTimes(1);
  expect(source.getAttribute('style')).toBe(sourceStyle);
  expect(container.querySelector('[data-lath-leaf="placement-source"]')).toBe(source);
  act(() => menu.querySelector<HTMLButtonElement>('[aria-label="Close terminal context"]')!.click());
  await flush();
  await open();
  expect(container.querySelector<HTMLElement>('[data-terminal-context]')!.dataset.contextSide).toBe('bottom');
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Place helper at top"]')!.click());
  expect(container.querySelector<HTMLElement>('[data-terminal-context]')!.dataset.contextSide).toBe('top');
});
