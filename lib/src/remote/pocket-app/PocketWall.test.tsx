/** @vitest-environment jsdom */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DirectoryEntry } from 'remote-lib-common';
import type { RemotePtyAdapter } from '../client/remote-adapter';
import { PocketWall } from './PocketWall';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const fake = vi.hoisted(() => ({
  activity: new Map(),
  panes: new Map(),
  mouse: new Map(),
  clearTodo: vi.fn(),
}));
vi.mock('../../lib/terminal-registry', () => ({
  DEFAULT_ACTIVITY_STATE: { status: 'WATCHING_DISABLED', episode: null, todo: false },
  getActivitySnapshot: () => fake.activity,
  getTerminalPaneStateSnapshot: () => fake.panes,
  subscribeToActivity: () => () => {},
  subscribeToTerminalPaneState: () => () => {},
  clearSessionTodo: fake.clearTodo,
  disposeSession: vi.fn(),
  getOrCreateTerminal: vi.fn(),
  getTerminalInstance: () => null,
  setTerminalUserTitle: vi.fn(),
  refitSession: vi.fn(),
  getTerminalFontSize: () => 13,
  setTerminalFontSize: vi.fn(),
  writeUserInput: vi.fn(),
}));
vi.mock('../../lib/mouse-selection', () => ({
  getMouseSelectionSnapshot: () => fake.mouse,
  subscribeToMouseSelection: () => () => {},
  setOverride: vi.fn(),
}));
vi.mock('../../lib/clipboard', () => ({ doPaste: vi.fn() }));
vi.mock('./pocket-theme', () => ({ usePocketTheme: vi.fn(), restorePocketTheme: vi.fn(), applyPocketTheme: vi.fn() }));
vi.mock('../../components/TerminalPane', () => ({
  TerminalPane: ({ id }: { id: string }) => <div data-terminal={id} />,
}));
vi.mock('../../components/MobileTerminalUi', () => ({
  MobileTerminalUi: ({ terminal, browserShown, sessionsHeader }: { terminal: React.ReactNode; browserShown?: boolean; sessionsHeader?: React.ReactNode }) => (
    <div data-browser-shown={browserShown ? 'true' : 'false'}>{sessionsHeader}{terminal}</div>
  ),
  paneMouseOverride: () => false,
}));

let container: HTMLDivElement;
let root: Root;
let snapshot: DirectoryEntry[];
let publish: (entries: DirectoryEntry[]) => void;
let adapter: RemotePtyAdapter;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  snapshot = [{ paneRef: 'remote', surfaceId: 'remote', type: 'terminal', title: 'Computer terminal',
    focused: false, alive: true, ringing: true, hasTODO: true, cwd: '/computer/project' }];
  adapter = {
    getDirectoryEntries: () => snapshot,
    subscribeDirectory: (listener: typeof publish) => { publish = listener; return () => {}; },
    setActivePane: vi.fn(async () => {}),
    clearActivePane: vi.fn(async () => {}),
  } as unknown as RemotePtyAdapter;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fake.activity.clear();
  vi.clearAllMocks();
});

async function render() {
  await act(async () => root.render(<PocketWall adapter={adapter} />));
}

it('uses the Burrow snapshot for the visible header alarm, TODO, and secondary text', async () => {
  await render();
  expect(container.querySelector('[data-alert-ring-inset]')).not.toBeNull();
  expect(container.querySelector('[data-session-todo-for="remote"]')).not.toBeNull();
  expect(container.textContent).toContain('/computer/project');
});

it('keeps remote TODO display-only because the protocol has no dismiss operation', async () => {
  await render();
  const pill = container.querySelector<HTMLElement>('[data-session-todo-for="remote"]');
  expect(pill).not.toBeNull();
  expect(pill?.tagName).toBe('SPAN');
  act(() => pill?.click());
  expect(fake.clearTodo).not.toHaveBeenCalled();
});

it('removes the remote alarm when the next snapshot clears it, even if local state rings', async () => {
  fake.activity.set('remote', { status: 'ALERT_RINGING', episode: null, todo: false });
  await render();
  expect(container.querySelector('[data-alert-ring-inset]')).not.toBeNull();
  await act(async () => publish(snapshot.map((entry) => ({ ...entry, ringing: false, hasTODO: false }))));
  expect(container.querySelector('[data-alert-ring-inset]')).toBeNull();
});

const page = { render: 'iframe' as const, url: 'http://localhost:5173/' };
const browsers = () => ({
  session: { request: vi.fn(), subscribe: vi.fn(() => new Promise(() => {})), unsubscribe: vi.fn() },
  burrowId: 'burrow-1',
  frameDomain: 'frames.example',
  transport: { path: 'relay' as const, cause: null },
  onReconnect: vi.fn(),
});
async function renderWith(entries: DirectoryEntry[]) {
  snapshot = entries;
  await act(async () => root.render(<PocketWall adapter={adapter} browsers={browsers()} />));
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

it('holds no terminal while a Tool shows its browser, and attaches it on the switch', async () => {
  await renderWith([{ ...snapshot[0], browser: page }]);
  expect(adapter.setActivePane).not.toHaveBeenCalled();
  expect(adapter.clearActivePane).toHaveBeenCalled();
  expect(container.querySelector('[data-browser-shown]')?.getAttribute('data-browser-shown')).toBe('true');
  await act(async () => button('Terminal')!.click());
  expect(adapter.setActivePane).toHaveBeenCalledWith('remote', undefined, undefined);
  expect(container.querySelector('[data-browser-shown]')?.getAttribute('data-browser-shown')).toBe('false');
});

it('never attaches a browser alone, which has no terminal', async () => {
  await renderWith([{ ...snapshot[0], type: 'browser', browser: page }]);
  expect(adapter.setActivePane).not.toHaveBeenCalled();
  expect(container.querySelector('[data-terminal]')).toBeNull();
  expect(button('Kill')).not.toBeNull();
});

it('attaches a terminal and offers no close on it, with frames on or off', async () => {
  await renderWith(snapshot);
  expect(adapter.setActivePane).toHaveBeenCalled();
  expect(button('Kill')).toBeNull();
});

it('offers no close without frames, whatever the directory says', async () => {
  snapshot = [{ ...snapshot[0], browser: page }];
  await render();
  expect(button('Kill')).toBeNull();
});

it('hands the Sessions screen the header its consumer gave', async () => {
  await act(async () => root.render(<PocketWall adapter={adapter} sessionsHeader={<p>Studio iMac</p>} />));
  expect(container.textContent).toContain('Studio iMac');
});

it('opens a frame on a live client under StrictMode, whose effects run twice', async () => {
  const session = browsers().session;
  snapshot = [{ ...snapshot[0], browser: page }];
  await act(async () => root.render(
    <StrictMode>
      <PocketWall
        adapter={adapter}
        browsers={{ ...browsers(), session, transport: { path: 'direct', cause: null } }}
      />
    </StrictMode>,
  ));
  await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 10); }));
  expect(session.subscribe).toHaveBeenCalledWith('frame.open', expect.objectContaining({ surfaceId: 'remote' }), expect.any(Function), expect.any(String));
});

describe('a framed page the listing misses', () => {
  const closedEvent = { subId: 'frame', event: 'frame.closed', data: { reason: 'surface-gone' } };
  const bootstrap = () => container.querySelector('iframe[title="Frame bootstrap"]');
  async function opened() {
    let onEvent: (event: unknown) => void = () => {};
    const session = {
      request: vi.fn(async () => ({})),
      subscribe: vi.fn(async (_method: string, _params: unknown, listener: (event: unknown) => void, subId: string) => {
        onEvent = listener;
        return { subId, result: { path: '/' } };
      }),
      unsubscribe: vi.fn(),
    };
    const listed = { ...snapshot[0]!, browser: page };
    snapshot = [listed];
    await act(async () => root.render(
      <PocketWall adapter={adapter} browsers={{ ...browsers(), session, transport: { path: 'direct', cause: null } } as never} />,
    ));
    await act(() => new Promise<void>((resolve) => { setTimeout(resolve, 10); }));
    expect(bootstrap()).not.toBeNull();
    return { session, listed, close: () => act(async () => onEvent(closedEvent)) };
  }

  it('keeps its document through an empty listing, so its edits survive the next', async () => {
    const { session, listed } = await opened();
    const document = bootstrap();
    await act(async () => publish([]));
    expect(bootstrap()).toBe(document);
    await act(async () => publish([listed]));
    expect(bootstrap()).toBe(document);
    expect(session.subscribe).toHaveBeenCalledOnce();
    expect(session.request).not.toHaveBeenCalledWith('frame.close', expect.anything());
  });

  it('drops it once the Burrow says the page went', async () => {
    const { close } = await opened();
    await act(async () => publish([]));
    await close();
    expect(container.querySelector('[data-mobile-browser-layer] iframe')).toBeNull();
    expect(container.textContent).not.toContain('no longer open');
  });
});
