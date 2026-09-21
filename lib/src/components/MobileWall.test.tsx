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
  disposeSession: vi.fn(),
  getActivitySnapshot: vi.fn(),
  getOrCreateTerminal: vi.fn(),
  terminalPaneStateSnapshot: new Map(),
  getTerminalPaneStateSnapshot: vi.fn(),
  markSessionAttention: vi.fn(),
  setTerminalUserTitle: vi.fn(),
  subscribeToActivity: vi.fn(() => () => {}),
  subscribeToTerminalPaneState: vi.fn(() => () => {}),
}));

vi.mock('../lib/terminal-registry', () => ({
  ...registry,
  DEFAULT_ACTIVITY_STATE: { status: 'WATCHING_DISABLED', episode: null, todo: false },
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

function headerInset(): string | null {
  return container.querySelector<HTMLElement>('.bg-header-active-bg')
    ?.querySelector('[data-alert-ring-inset]')
    ?.getAttribute('data-alert-ring-inset') ?? null;
}

function terminalPane(): HTMLElement {
  return container.querySelector<HTMLElement>('[data-testid="terminal-pane"]')!.parentElement!;
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

  it('leaves the header plain while the Session is quiet', () => {
    renderWall();

    expect(headerInset()).toBeNull();
  });

  it('wears the alarm inset on the header while the Session rings', () => {
    registry.activitySnapshot.set('pane-a', {
      status: 'ALERT_RINGING', episode: { id: 'e1', startedAt: Date.now() }, todo: false,
    });
    try {
      renderWall();
      expect(headerInset()).toBe('header-active');
    } finally {
      registry.activitySnapshot.clear();
    }
  });

  /** Mobile has no terminal context and no right-click, so attention is the
   *  whole dismissal (`docs/specs/alert.md` -> Pane Header). */
  it('attends the Session when the terminal is touched', () => {
    renderWall();

    act(() => {
      terminalPane().dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    expect(registry.markSessionAttention).toHaveBeenCalledWith('pane-a');
  });
});
