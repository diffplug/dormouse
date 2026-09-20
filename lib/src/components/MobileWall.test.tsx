/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileWall } from './MobileWall';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const registry = vi.hoisted(() => ({
  activitySnapshot: new Map(),
  clearSessionTodo: vi.fn(),
  dismissSessionAlert: vi.fn(),
  disposeSession: vi.fn(),
  getActivitySnapshot: vi.fn(),
  getOrCreateTerminal: vi.fn(),
  terminalPaneStateSnapshot: new Map(),
  getTerminalPaneStateSnapshot: vi.fn(),
  setTerminalUserTitle: vi.fn(),
  subscribeToActivity: vi.fn(() => () => {}),
  subscribeToTerminalPaneState: vi.fn(() => () => {}),
}));

vi.mock('../lib/terminal-registry', () => ({
  ...registry,
  DEFAULT_ACTIVITY_STATE: { status: 'WATCHING_DISABLED', ringSeq: 0, todo: false },
}));

vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ id }: { id: string }) => <div data-testid="terminal-pane" data-session-id={id} />,
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  registry.getActivitySnapshot.mockReturnValue(registry.activitySnapshot);
  registry.getTerminalPaneStateSnapshot.mockReturnValue(registry.terminalPaneStateSnapshot);
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => null),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function renderWall(showKillButton?: boolean) {
  act(() => {
    root.render(
      <StrictMode>
        <MobileWall
          sessions={[{ id: 'pane-a', title: 'remote shell' }]}
          activeSessionId="pane-a"
          showKillButton={showKillButton}
        />
      </StrictMode>,
    );
  });
}

function header(): HTMLElement {
  return container.querySelector<HTMLElement>('.bg-header-active-bg')!;
}

function dismissButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>('[data-dismiss-alert-for="pane-a"]');
}

describe('MobileWall', () => {
  it('shows the Kill control by default', () => {
    renderWall();

    expect(container.querySelector('button[aria-label="Kill"]')).not.toBeNull();
  });

  it('can hide the local Kill control for Burrow-owned remote panes', () => {
    renderWall(false);

    expect(container.querySelector('button[aria-label="Kill"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Minimize"]')).not.toBeNull();
  });

  it('leaves the header plain and offers no dismissal while the Session is quiet', () => {
    renderWall();

    expect(header().className).not.toContain('alarm-vs');
    expect(dismissButton()).toBeNull();
  });

  /** Mobile has no terminal context, so the header carries both the alarm and
   *  the only way off it (`docs/specs/alert.md` -> Pane Header). */
  it('wears the alarm inset and the one dismissal while the Session rings', () => {
    registry.activitySnapshot.set('pane-a', { status: 'ALERT_RINGING', ringSeq: 1, todo: false });
    try {
      renderWall();

      expect(header().className).toContain('shadow-[inset_0_0_0_2px_var(--color-alarm-vs-header-active)]');
      act(() => { dismissButton()!.click(); });
      expect(registry.dismissSessionAlert).toHaveBeenCalledWith('pane-a');
    } finally {
      registry.activitySnapshot.clear();
    }
  });
});
