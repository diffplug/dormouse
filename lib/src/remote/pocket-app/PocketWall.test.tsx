/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  writeUserInput: vi.fn(),
}));
vi.mock('../../lib/mouse-selection', () => ({
  getMouseSelectionSnapshot: () => fake.mouse,
  subscribeToMouseSelection: () => () => {},
  setOverride: vi.fn(),
}));
vi.mock('../../lib/clipboard', () => ({ doPaste: vi.fn() }));
vi.mock('./pocket-theme', () => ({ usePocketTheme: vi.fn() }));
vi.mock('../../components/TerminalPane', () => ({
  TerminalPane: ({ id }: { id: string }) => <div data-terminal={id} />,
}));
vi.mock('../../components/MobileTerminalUi', () => ({
  MobileTerminalUi: ({ terminal }: { terminal: React.ReactNode }) => <>{terminal}</>,
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
