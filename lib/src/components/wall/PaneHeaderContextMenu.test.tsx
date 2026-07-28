/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { DialogKeyboardContext, WallActionsContext, type WallActions } from './wall-context';
import { ensureResizeObserver, stubWallActions as stubActions } from './wall-test-utils';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import type { OpenPort, PlatformAdapter } from '../../lib/platform/types';
import { removeTerminalPaneState, resetTerminalPaneState } from '../../lib/terminal-registry';
import type { TerminalTitle, TerminalTitleSource } from '../../lib/terminal-state';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function headerProps(id: string, title: string): PaneProps {
  return { id, title, params: undefined };
}

function candidate(title: string, source: TerminalTitleSource, updatedAt: number): TerminalTitle {
  return { title, source, updatedAt };
}

function loopbackPort(port: number, processName?: string): OpenPort {
  return { protocol: 'tcp', family: 'IPv4', address: '127.0.0.1', port, pid: 100, processName };
}

/** Make the running host able to open a browser surface, so port rows are buttons. */
function enableConnect(platform: FakePtyAdapter): void {
  (platform as PlatformAdapter).agentBrowserCommand = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
}

let container: HTMLDivElement;
let root: Root;
let platform: FakePtyAdapter;
let keyboardActiveSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  ensureResizeObserver();
  keyboardActiveSpy = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  platform.reset();
  removeTerminalPaneState('term-1');
});

function renderHeader(props: PaneProps, actions: WallActions) {
  act(() => {
    root.render(
      <StrictMode>
        <DialogKeyboardContext.Provider value={keyboardActiveSpy}>
          <WallActionsContext.Provider value={actions}>
            <TerminalPaneHeader {...props} />
          </WallActionsContext.Provider>
        </DialogKeyboardContext.Provider>
      </StrictMode>,
    );
  });
}

function fireContextMenu() {
  const header = container.firstElementChild as HTMLElement;
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 12 }));
}

function menuFor(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-pane-context-menu-for="${id}"]`);
}

describe('PaneHeaderContextMenu — pane header right-click', () => {
  it('opens on header contextmenu showing the surface ref from resolveSurfaceRef', async () => {
    const resolveSurfaceRef = vi.fn(() => 'surface:3');
    renderHeader(headerProps('term-1', 'title'), stubActions({ resolveSurfaceRef }));

    await act(async () => { fireContextMenu(); });

    const menu = menuFor('term-1');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('surface:3');
    expect(resolveSurfaceRef).toHaveBeenCalledWith('term-1');
  });

  it('shows a spinner while the scan is pending, then port entries after it resolves', async () => {
    platform.spawnPty('term-1');
    let resolvePorts!: (ports: OpenPort[]) => void;
    platform.getOpenPorts = () => new Promise<OpenPort[]>((res) => { resolvePorts = res; });
    renderHeader(headerProps('term-1', 't'), stubActions());

    act(() => { fireContextMenu(); });
    const menu = menuFor('term-1');
    expect(menu?.querySelector('.animate-spin')).not.toBeNull();
    expect(menu?.textContent).toContain('scanning ports');

    await act(async () => { resolvePorts([loopbackPort(5173, 'node')]); });
    expect(menu?.querySelector('.animate-spin')).toBeNull();
    expect(menu?.textContent).toContain('localhost:5173');
    expect(menu?.textContent).toContain('node');
  });

  it('fires the connect and closes the menu immediately (loading feedback lives in the pane)', async () => {
    enableConnect(platform);
    platform.spawnPty('term-1');
    platform.setOpenPorts('term-1', [loopbackPort(5173, 'node')]);
    const onConnectPort = vi.fn();
    renderHeader(headerProps('term-1', 't'), stubActions({ onConnectPort }));

    await act(async () => { fireContextMenu(); });
    const button = menuFor('term-1')?.querySelector('button[data-port-entry="5173"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onConnectPort).toHaveBeenCalledWith('term-1', 'http://localhost:5173/');
    expect(menuFor('term-1')).toBeNull();
  });

  it('shows an empty state when the scan finds no listening ports', async () => {
    platform.spawnPty('term-1');
    renderHeader(headerProps('term-1', 't'), stubActions());

    await act(async () => { fireContextMenu(); });
    expect(menuFor('term-1')?.textContent).toContain('no listening ports');
  });

  it('renders port rows as inert labels (no buttons) when the host cannot connect', async () => {
    platform.spawnPty('term-1');
    platform.setOpenPorts('term-1', [loopbackPort(5173, 'node')]);
    renderHeader(headerProps('term-1', 't'), stubActions());

    await act(async () => { fireContextMenu(); });
    const menu = menuFor('term-1');
    expect(menu?.querySelector('button[data-port-entry="5173"]')).toBeNull();
    expect(menu?.querySelector('[data-port-entry="5173"]')).not.toBeNull();
    expect(menu?.textContent).toContain('localhost:5173');
  });

  it('dismisses on Escape and on an outside pointerdown', async () => {
    renderHeader(headerProps('term-1', 't'), stubActions());

    await act(async () => { fireContextMenu(); });
    expect(menuFor('term-1')).not.toBeNull();
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(menuFor('term-1')).toBeNull();

    await act(async () => { fireContextMenu(); });
    expect(menuFor('term-1')).not.toBeNull();
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    expect(menuFor('term-1')).toBeNull();
  });

  it('opens the one context menu when a title-span right-click bubbles up', async () => {
    renderHeader(headerProps('term-1', 'title'), stubActions());

    const titleSpan = container.querySelector('[data-pane-title-for="term-1"]') as HTMLElement;
    expect(titleSpan).not.toBeNull();
    await act(async () => {
      titleSpan.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 12 }));
    });

    expect(menuFor('term-1')).not.toBeNull();
  });

  it('renders the header row (display title + surface ref) and the title-candidates table inline', async () => {
    const resolveSurfaceRef = vi.fn(() => 'surface:7');
    resetTerminalPaneState('term-1', {
      title: candidate('Pinned API', 'user', 6_000),
      titleCandidates: {
        user: candidate('Pinned API', 'user', 6_000),
        osc0: candidate('dev server', 'osc0', 1_000),
        osc99: candidate('Codex waiting', 'osc99', 4_000),
      },
    });
    renderHeader(headerProps('term-1', 't'), stubActions({ resolveSurfaceRef }));

    await act(async () => { fireContextMenu(); });

    const menu = menuFor('term-1');
    expect(menu).not.toBeNull();
    // Header row: current display title + surface ref.
    expect(menu?.textContent).toContain('Pinned API');
    expect(menu?.textContent).toContain('surface:7');
    // Candidates table: one row per channel (source label + candidate title).
    expect(menu?.textContent).toContain('OSC 0');
    expect(menu?.textContent).toContain('dev server');
    expect(menu?.textContent).toContain('OSC 99');
    expect(menu?.textContent).toContain('Codex waiting');
    expect(menu?.textContent).not.toContain('No title candidates');
  });

  it('shows the empty title-candidates line when the pane has no candidates', async () => {
    renderHeader(headerProps('term-1', 't'), stubActions());

    await act(async () => { fireContextMenu(); });
    expect(menuFor('term-1')?.textContent).toContain('No title candidates');
  });

  it('closes the menu when the header close button is clicked', async () => {
    renderHeader(headerProps('term-1', 't'), stubActions());

    await act(async () => { fireContextMenu(); });
    const closeButton = menuFor('term-1')?.querySelector('button[aria-label="Close menu"]') as HTMLButtonElement;
    expect(closeButton).not.toBeNull();

    await act(async () => { closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(menuFor('term-1')).toBeNull();
  });
});

const DEFAULT_KB_PORTS: OpenPort[] = [loopbackPort(3000, 'alpha'), loopbackPort(5173, 'beta')];

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
}

/** Enable connect, spawn a pty with `ports`, render, and open the menu. */
async function openConnectableMenu(
  onConnectPort: ReturnType<typeof vi.fn> = vi.fn(),
  ports: OpenPort[] = DEFAULT_KB_PORTS,
): Promise<ReturnType<typeof vi.fn>> {
  enableConnect(platform);
  platform.spawnPty('term-1');
  platform.setOpenPorts('term-1', ports);
  renderHeader(headerProps('term-1', 't'), stubActions({ onConnectPort }));
  await act(async () => { fireContextMenu(); });
  return onConnectPort;
}

describe('PaneHeaderContextMenu — keyboard access', () => {
  it('takes DOM focus on the menu container when it opens', async () => {
    await openConnectableMenu();
    expect(document.activeElement).toBe(menuFor('term-1'));
  });

  it('reports dialog-keyboard-active while open and inactive once closed', async () => {
    await openConnectableMenu();
    expect(keyboardActiveSpy).toHaveBeenLastCalledWith(true);

    act(() => { window.dispatchEvent(keydown('Escape')); });
    expect(menuFor('term-1')).toBeNull();
    expect(keyboardActiveSpy).toHaveBeenLastCalledWith(false);
  });

  it('renders digit chips and connects the nth port row when its digit is pressed, then closes', async () => {
    const onConnectPort = vi.fn();
    await openConnectableMenu(onConnectPort);
    // First 9 connectable rows carry a digit accelerator chip.
    expect(menuFor('term-1')?.textContent).toContain('[1]');
    expect(menuFor('term-1')?.textContent).toContain('[2]');

    act(() => { window.dispatchEvent(keydown('2')); });
    // Ports sort ascending: 3000 → [1], 5173 → [2].
    expect(onConnectPort).toHaveBeenCalledWith('term-1', 'http://localhost:5173/');
    expect(menuFor('term-1')).toBeNull();
  });

  it('drops a digit press while the port scan is still running', async () => {
    enableConnect(platform);
    platform.spawnPty('term-1');
    platform.getOpenPorts = () => new Promise<OpenPort[]>(() => {}); // never resolves
    const onConnectPort = vi.fn();
    renderHeader(headerProps('term-1', 't'), stubActions({ onConnectPort }));

    act(() => { fireContextMenu(); });
    expect(menuFor('term-1')?.textContent).toContain('scanning ports');

    act(() => { window.dispatchEvent(keydown('1')); });
    expect(onConnectPort).not.toHaveBeenCalled();
    expect(menuFor('term-1')).not.toBeNull();
  });

  it('ignores an out-of-range digit', async () => {
    const onConnectPort = vi.fn();
    await openConnectableMenu(onConnectPort);

    act(() => { window.dispatchEvent(keydown('5')); });
    expect(onConnectPort).not.toHaveBeenCalled();
    expect(menuFor('term-1')).not.toBeNull();
  });

  it('renders no digit chips and ignores digits on an inert host', async () => {
    platform.spawnPty('term-1');
    platform.setOpenPorts('term-1', DEFAULT_KB_PORTS);
    const onConnectPort = vi.fn();
    renderHeader(headerProps('term-1', 't'), stubActions({ onConnectPort }));

    await act(async () => { fireContextMenu(); });
    expect(menuFor('term-1')?.textContent).not.toContain('[1]');

    act(() => { window.dispatchEvent(keydown('1')); });
    expect(onConnectPort).not.toHaveBeenCalled();
    expect(menuFor('term-1')).not.toBeNull();
  });

  it('roves focus across port rows with the arrow keys, wrapping at the ends', async () => {
    await openConnectableMenu();
    const menu = menuFor('term-1')!;
    const rows = menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]');
    expect(rows.length).toBe(2);

    act(() => { window.dispatchEvent(keydown('ArrowDown')); });
    expect(document.activeElement).toBe(rows[0]);
    act(() => { window.dispatchEvent(keydown('ArrowDown')); });
    expect(document.activeElement).toBe(rows[1]);
    act(() => { window.dispatchEvent(keydown('ArrowDown')); });
    expect(document.activeElement).toBe(rows[0]); // wraps past the last
    act(() => { window.dispatchEvent(keydown('ArrowUp')); });
    expect(document.activeElement).toBe(rows[1]); // wraps before the first
  });

  it('cycles focus through every focusable with Tab, including the close button', async () => {
    await openConnectableMenu();
    const menu = menuFor('term-1')!;
    const closeBtn = menu.querySelector<HTMLButtonElement>('button[aria-label="Close menu"]')!;
    const rows = Array.from(menu.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]'));
    const order = [closeBtn, rows[0], rows[1]];

    // From the container, Tab lands on the first focusable and wraps through all.
    for (const expected of [...order, order[0]]) {
      act(() => { window.dispatchEvent(keydown('Tab')); });
      expect(document.activeElement).toBe(expected);
    }
  });

  it('restores focus to the previously focused element when it closes', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    await openConnectableMenu();
    expect(document.activeElement).toBe(menuFor('term-1'));

    act(() => { window.dispatchEvent(keydown('Escape')); });
    expect(menuFor('term-1')).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('survives a scroll originating inside the menu but dismisses on an outside scroll', async () => {
    await openConnectableMenu();
    const menu = menuFor('term-1')!;

    act(() => { menu.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(menuFor('term-1')).not.toBeNull();

    act(() => { window.dispatchEvent(new Event('scroll')); });
    expect(menuFor('term-1')).toBeNull();
  });
});
