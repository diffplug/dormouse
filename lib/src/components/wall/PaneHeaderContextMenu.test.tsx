/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneProps } from './pane-props';
import { TerminalPaneHeader } from './TerminalPaneHeader';
import { WallActionsContext, type WallActions } from './wall-context';
import { ensureResizeObserver, stubWallActions as stubActions } from './wall-test-utils';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { setPlatform } from '../../lib/platform';
import type { OpenPort, PlatformAdapter } from '../../lib/platform/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function headerProps(id: string, title: string): PaneProps {
  return { id, title, params: undefined };
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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  platform = new FakePtyAdapter();
  setPlatform(platform);
  ensureResizeObserver();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  platform.reset();
});

function renderHeader(props: PaneProps, actions: WallActions) {
  act(() => {
    root.render(
      <StrictMode>
        <WallActionsContext.Provider value={actions}>
          <TerminalPaneHeader {...props} />
        </WallActionsContext.Provider>
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

  it('connects a port (dor ab open) and closes the menu on success', async () => {
    enableConnect(platform);
    platform.spawnPty('term-1');
    platform.setOpenPorts('term-1', [loopbackPort(5173, 'node')]);
    const onConnectPort = vi.fn(async () => ({ ok: true as const }));
    renderHeader(headerProps('term-1', 't'), stubActions({ onConnectPort }));

    await act(async () => { fireContextMenu(); });
    const button = menuFor('term-1')?.querySelector('button[data-port-entry="5173"]') as HTMLButtonElement;
    expect(button).not.toBeNull();

    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onConnectPort).toHaveBeenCalledWith('term-1', 'http://localhost:5173/');
    expect(menuFor('term-1')).toBeNull();
  });

  it('surfaces the failure message and keeps rows enabled when connect fails', async () => {
    enableConnect(platform);
    platform.spawnPty('term-1');
    platform.setOpenPorts('term-1', [loopbackPort(5173)]);
    const onConnectPort = vi.fn(async () => ({ ok: false as const, message: 'agent-browser open exited 1' }));
    renderHeader(headerProps('term-1', 't'), stubActions({ onConnectPort }));

    await act(async () => { fireContextMenu(); });
    const button = menuFor('term-1')?.querySelector('button[data-port-entry="5173"]') as HTMLButtonElement;
    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const menu = menuFor('term-1');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('agent-browser open exited 1');
    expect((menu?.querySelector('button[data-port-entry="5173"]') as HTMLButtonElement).disabled).toBe(false);
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
});
