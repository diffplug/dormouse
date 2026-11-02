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

function renderWall(showKillButton?: boolean, onShowSessions?: () => void) {
  act(() => {
    root.render(
      <StrictMode>
        <MobileWall
          sessions={[{ id: 'pane-a', title: 'remote shell' }]}
          activeSessionId="pane-a"
          showKillButton={showKillButton}
          onShowSessions={onShowSessions}
        />
      </StrictMode>,
    );
  });
}

function renderKinds(active: string, toolBrowserShown: boolean, onToolBrowserShownChange = vi.fn()) {
  act(() => {
    root.render(
      <StrictMode>
        <MobileWall
          sessions={[
            { id: 'tool', title: 'a tool', kind: 'tool' },
            { id: 'browser', title: 'a browser', kind: 'browser' },
            { id: 'term', title: 'zsh' },
          ]}
          activeSessionId={active}
          toolBrowserShown={toolBrowserShown}
          onToolBrowserShownChange={onToolBrowserShownChange}
          browser={<div data-testid="browser" />}
        />
      </StrictMode>,
    );
  });
  return { onToolBrowserShownChange };
}
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const browserLayer = () => container.querySelector<HTMLElement>('[data-mobile-browser-layer]')!;

function headerInset(): string | null {
  return container.querySelector<HTMLElement>('.bg-header-active-bg')
    ?.querySelector('[data-alert-ring-inset]')
    ?.getAttribute('data-alert-ring-inset') ?? null;
}

describe('MobileWall', () => {
  it('shows the Kill control by default', () => {
    renderWall();

    expect(container.querySelector('button[aria-label="Kill"]')).not.toBeNull();
  });

  it('can hide the local Kill control for Burrow-owned remote panes', () => {
    renderWall(false);

    expect(container.querySelector('button[aria-label="Kill"]')).toBeNull();
  });

  it('shows the Sessions screen from the Session title, which is plain text without a handler', () => {
    renderWall();
    expect(container.querySelector('button[title="Show sessions"]')).toBeNull();

    const onShowSessions = vi.fn();
    renderWall(true, onShowSessions);
    const title = container.querySelector<HTMLButtonElement>('button[title="Show sessions"]')!;
    expect(title.textContent).toContain('remote shell');
    act(() => title.click());
    expect(onShowSessions).toHaveBeenCalledOnce();
  });

  it('leaves the header plain while the Session is quiet', () => {
    renderWall();

    expect(headerInset()).toBeNull();
  });

  it('still lets a local header clear its TODO', () => {
    registry.activitySnapshot.set('pane-a', { status: 'WATCHING_DISABLED', episode: null, todo: true });
    try {
      renderWall();
      const pill = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss TODO"]');
      expect(pill).not.toBeNull();
      act(() => pill!.click());
      expect(registry.clearSessionTodo).toHaveBeenCalledWith('pane-a');
    } finally {
      registry.activitySnapshot.clear();
    }
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

  describe('browser', () => {
    it('puts a Tool\'s modes before its title, marks the one showing, and switches between them', () => {
      const { onToolBrowserShownChange } = renderKinds('tool', true);
      const browserButton = button('Browser')!;
      const terminalButton = button('Terminal')!;
      const title = container.querySelector('[title="Show sessions"], .truncate')!;
      expect(browserButton.compareDocumentPosition(terminalButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(terminalButton.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(browserButton.getAttribute('aria-pressed')).toBe('true');
      expect(terminalButton.getAttribute('aria-pressed')).toBe('false');
      expect(container.querySelector('[data-testid="terminal-pane"]')).not.toBeNull();
      expect(browserLayer().classList.contains('invisible')).toBe(false);
      act(() => terminalButton.click());
      expect(onToolBrowserShownChange).toHaveBeenCalledWith(false);

      renderKinds('tool', false, onToolBrowserShownChange);
      expect(browserLayer().classList.contains('invisible')).toBe(true);
      expect(button('Terminal')!.getAttribute('aria-pressed')).toBe('true');
      act(() => button('Browser')!.click());
      expect(onToolBrowserShownChange).toHaveBeenLastCalledWith(true);
    });

    it('mounts no terminal for a browser alone, whose glyph only names its display', () => {
      renderKinds('browser', false);
      expect(container.querySelector('[data-testid="terminal-pane"]')).toBeNull();
      expect(browserLayer().classList.contains('invisible')).toBe(false);
      expect(button('Browser')).toBeNull();
      expect(button('Terminal')).toBeNull();
      expect(container.querySelector('[data-browser-display-mode="iframe"]')).not.toBeNull();
      expect(registry.getOrCreateTerminal).not.toHaveBeenCalledWith('browser');
      expect(registry.getOrCreateTerminal).toHaveBeenCalledWith('tool');
    });

    it('wears the display it is told, a stream\'s included', () => {
      act(() => {
        root.render(
          <MobileWall
            sessions={[{ id: 'streaming', title: 'a stream', kind: 'browser' }]}
            sessionItems={[{ id: 'streaming', kind: 'browser', browserDisplay: 'agent-browser-resize', title: 'a stream', episode: null }]}
            activeSessionId="streaming"
          />,
        );
      });
      expect(container.querySelector('[data-browser-display-mode="agent-browser-resize"]')).not.toBeNull();
    });

    it('offers a close on a Tool and a browser, never a terminal, where the consumer hides kill', () => {
      const onBrowserClose = vi.fn();
      const render = (active: string) => act(() => {
        root.render(
          <MobileWall
            sessions={[{ id: 'tool', title: 'a tool', kind: 'tool' }, { id: 'browser', title: 'a browser', kind: 'browser' }, { id: 'term', title: 'zsh' }]}
            activeSessionId={active}
            showKillButton={false}
            onBrowserClose={onBrowserClose}
          />,
        );
      });
      for (const id of ['tool', 'browser']) {
        render(id);
        act(() => button('Kill')!.click());
        expect(onBrowserClose).toHaveBeenLastCalledWith(id);
      }
      expect(registry.disposeSession).not.toHaveBeenCalled();
      render('term');
      expect(button('Kill')).toBeNull();
    });

    it('leaves a plain terminal without modes', () => {
      renderKinds('term', true);
      expect(browserLayer().classList.contains('invisible')).toBe(true);
      expect(button('Browser')).toBeNull();
      expect(button('Terminal')).toBeNull();
    });
  });
});
