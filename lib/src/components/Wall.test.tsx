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
import { getAgentBrowserScreenController } from './wall/agent-browser-screen';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import type { PlatformAdapter } from '../lib/platform/types';
import * as terminalRegistry from '../lib/terminal-registry';
import { UNNAMED_PANEL_TITLE } from '../lib/terminal-registry';
import { __resetArchiveServiceForTests } from '../lib/notepad/archive-service';
import { addPlainNote, beginClosing, clearAllNotepads, getNotes } from '../lib/notepad/notepad-store';
import type { NotepadArchiveV1 } from '../lib/notepad/types';
import { createTerminalPaneState, type TerminalPaneState } from '../lib/terminal-state';
import { getWallHandle, listWallHandles } from './wall/wall-handles';
import { mountWallHarness, type WallHarness } from './wall/wall-test-utils';
import { DEFAULT_WORKSPACE_ID } from '../lib/session-types';
import { clearTerminalActivity, setTerminalActivity } from '../lib/session-activity-store';
import { resetTerminalPaneState } from '../lib/terminal-state-store';

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
});

const flush = (): Promise<void> => harness.flush();

async function flushFrame(): Promise<void> {
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(undefined))); });
}

describe('Wall on the Lath engine', () => {
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard onEvent={onEvent} />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
        error: "surface 'surface:1' is not agent-browser rendered (render_mode: iframe)",
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
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
        error: "surface 'surface:1' is not agent-browser rendered (render_mode: iframe)",
      });
    } finally {
      untouchedSpy.mockRestore();
    }
  });

  it('resolves a browser surface handle to its agent-browser session, and gates the rest', async () => {
    const untouchedSpy = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    (fake as PlatformAdapter).agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    try {
      await act(async () => {
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
        error: `surface '${iframeRef}' is not agent-browser rendered (render_mode: iframe)`,
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
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
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

  it('retires the old ref when shell selection replaces an untouched pane', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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

  it('ignores zoom keyboard requests while a door is selected', async () => {
    const onEvent = vi.fn();
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard onEvent={onEvent} />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard onEvent={onEvent} />);
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
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard onEvent={onEvent} />);
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
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
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

  // A Door created by `dor split` against another Door is the one Surface that never
  // was a pane, so it exercises the store's `addDoor` registration rather than the
  // meta a minimize retains. Every Door reader goes through `lath.getMeta`, so a
  // missing entry shows up as a Door with no metadata.
  it('a Door born from `dor split` against another Door still has store metadata', async () => {
    const getTerminalSpy = vi
      .spyOn(terminalRegistry, 'getOrCreateTerminal')
      .mockImplementation(() => ({}) as ReturnType<typeof terminalRegistry.getOrCreateTerminal>);
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" showBaseboard />);
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
        root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" showBaseboard onEvent={onEvent} />);
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
      expect(contextMenu.closest('[data-lath-leaf]')).toBe(header.closest('[data-lath-leaf]'));
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="passthrough" showBaseboard />);
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
    return container.querySelector<HTMLElement>('[aria-labelledby="notepad-archive-failure-title"]');
  }

  /** Answer the prompt and settle the closure it starts. `Close anyway` runs an async
   *  chain that ends on the two-phase kill's deferred removal timer, so the click's
   *  own async work is awaited BEFORE `flush()` registers the timer that has to fire
   *  after it. A bare `act(click)` leaves the two `setTimeout(0)`s racing: the
   *  removal is registered while the test awaits `flush()`, so it lands second and
   *  the leaf is still mid-fade when the assertion runs. (`Keep open` only shifts the
   *  prompt queue, so it needs no ordering — one helper still covers both.) */
  async function clickButton(label: string): Promise<void> {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((candidate) => candidate.textContent?.trim() === label);
    expect(button, `no "${label}" button`).toBeDefined();
    await act(async () => { button!.click(); });
    await flush();
  }

  /** The pane header's Kill button — a user-visible closure, which does prompt.
   *  `isUntouched` short-circuits the kill confirmation so this is one click. */
  async function clickHeaderKill(paneId: string): Promise<void> {
    const untouched = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    try {
      const button = container.querySelector<HTMLButtonElement>(
        `[data-lath-leaf="${paneId}"] button[aria-label="Kill"]`,
      );
      expect(button, `no Kill button on ${paneId}`).not.toBeNull();
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
    await act(async () => root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />));
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
  const confirmKillOverlay = () => Array.from(container.querySelectorAll('h2')).find(h => h.textContent === 'Confirm kill') ?? null;

  it('closes an untouched pane at once and stages the confirm overlay for a touched one', async () => {
    const untouched = vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(true);
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />));
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
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />));
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

  it('drops a kill gesture whose Helper inspection outlives the pane', async () => {
    vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    const helper: helpers.HelperTerminal = { id: 'helper-a', parentId: 'pane-a', command: '', status: 'off' };
    vi.spyOn(helpers, 'getHelper').mockImplementation(id => id === 'pane-a' ? helper : undefined);
    vi.spyOn(helpers, 'closeHelperParent').mockImplementation(() => {});
    const inspections: Array<(busy: boolean) => void> = [];
    vi.spyOn(helpers, 'helperHasWork').mockImplementation(() => new Promise<boolean>(resolve => { inspections.push(resolve); }));
    await act(async () => root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />));
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
    await clickHeaderKill('pane-a');
    expect(archiveFailureModal()).not.toBeNull();
    setBusy(true);
    await clickButton('Close anyway');
    expect(getNotes('pane-a')).toHaveLength(1);
    expect(dispose).not.toHaveBeenCalled();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
  });

  it('archives a closing Surface\'s notes before tearing it down', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();
    act(() => { addPlainNote('pane-a', 'keep me'); });

    await clickHeaderKill('pane-a');

    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(getNotes('pane-a')).toHaveLength(1);
    expect(archiveFailureModal()).not.toBeNull();
  });

  it('answers a refused `dor kill` with the error and raises no prompt', async () => {
    // The caller is a command, not someone looking at the Wall: a modal here
    // would block a Wall nobody is watching (docs/specs/notepad.md → "Closure").
    vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();
    act(() => { addPlainNote('pane-a', 'keep me'); });
    await clickHeaderKill('pane-a');

    await clickButton('Keep open');

    expect(archiveFailureModal()).toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(getNotes('pane-a')).toHaveLength(1);
  });

  it('Close anyway discards the notes and removes the Surface without a batch', async () => {
    vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
    });
    await flush();
    act(() => { addPlainNote('pane-a', 'expendable'); });
    await clickHeaderKill('pane-a');

    await clickButton('Close anyway');

    expect(archiveFailureModal()).toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).toBeNull();
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
      root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
    });
    await flush();
    act(() => {
      addPlainNote('pane-a', 'from a');
      addPlainNote('pane-b', 'from b');
    });

    await clickHeaderKill('pane-a');
    await clickHeaderKill('pane-b');

    // A's prompt is the one on screen; B's is behind it.
    expect(archiveFailureModal()?.textContent).toContain('a could not be written');
    await clickButton('Keep open');

    expect(archiveFailureModal()?.textContent).toContain('b could not be written');
    await clickButton('Close anyway');

    expect(archiveFailureModal()).toBeNull();
    expect(container.querySelector('[data-lath-leaf="pane-a"]')).not.toBeNull();
    expect(getNotes('pane-a')).toHaveLength(1);
    expect(container.querySelector('[data-lath-leaf="pane-b"]')).toBeNull();
  });

  it('migrates a notepad to the new id when a replacement mints one', async () => {
    await act(async () => {
      root.render(<Wall initialPaneIds={['pane-a']} initialMode="command" showBaseboard />);
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
        root.render(<Wall initialPaneIds={['pane-a', 'pane-b', 'pane-c']} initialMode="command" showBaseboard />);
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
        root.render(<Wall initialPaneIds={['pane-a', 'pane-b']} initialMode="command" showBaseboard />);
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
        root.render(<Wall initialPaneIds={['pane-a']} showBaseboard />);
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
