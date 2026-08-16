/**
 * @vitest-environment jsdom
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResumeBanner } from './ResumeBanner';
import {
  __resetResumeOffersForTests,
  getResumeOffer,
  offerResumeCommand,
} from '../../lib/resume-offers';
import { WallActionsContext } from './wall-context';
import { stubWallActions } from './wall-test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const registry = vi.hoisted(() => ({
  paneStates: new Map<string, { activity: { kind: string } }>(),
  getTerminalPaneState: vi.fn(),
  runResumeCommand: vi.fn(),
  subscribeToTerminalPaneState: vi.fn(() => () => {}),
}));

vi.mock('../../lib/terminal-registry', () => ({
  getTerminalPaneState: registry.getTerminalPaneState,
  runResumeCommand: registry.runResumeCommand,
  subscribeToTerminalPaneState: registry.subscribeToTerminalPaneState,
}));

let container: HTMLDivElement;
let root: Root;
let wallActions: ReturnType<typeof stubWallActions>;

beforeEach(() => {
  __resetResumeOffersForTests();
  registry.paneStates.clear();
  // Mirrors the real accessor: a pane with no state reads as `unknown`.
  registry.getTerminalPaneState.mockImplementation(
    (id: string) => registry.paneStates.get(id) ?? { activity: { kind: 'unknown' } },
  );
  wallActions = stubWallActions();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(terminalId: string) {
  act(() => {
    root.render(
      <StrictMode>
        <WallActionsContext.Provider value={wallActions}>
          <ResumeBanner terminalId={terminalId} />
        </WallActionsContext.Provider>
      </StrictMode>,
    );
  });
}

function buttonLabelled(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === text);
}

describe('ResumeBanner', () => {
  it('renders nothing without a pending offer', () => {
    render('pane-a');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('offers the invocation, not the full command, once restored', () => {
    offerResumeCommand('pane-a', 'claude --resume 4f2c9b1e-6a03');
    render('pane-a');

    const run = buttonLabelled('Run claude --resume');
    expect(run).toBeTruthy();
    // The session id stays available without occupying the button.
    expect(run?.title).toBe('claude --resume 4f2c9b1e-6a03');
    expect(buttonLabelled('Dismiss')).toBeTruthy();
  });

  it('stays out of the way while a command is running', () => {
    offerResumeCommand('pane-a', 'claude --resume abc');
    registry.paneStates.set('pane-a', { activity: { kind: 'running' } });
    render('pane-a');

    expect(container.querySelectorAll('button')).toHaveLength(0);
    // Hidden, not retired: the offer survives for when the command finishes.
    expect(getResumeOffer('pane-a')).toBe('claude --resume abc');
  });

  it('shows for a shell with no OSC integration (unknown activity)', () => {
    offerResumeCommand('pane-a', 'codex resume xyz');
    registry.paneStates.set('pane-a', { activity: { kind: 'unknown' } });
    render('pane-a');

    expect(buttonLabelled('Run codex resume')).toBeTruthy();
  });

  it('runs the full command, id included, on Run', () => {
    offerResumeCommand('pane-a', 'claude --resume 4f2c9b1e-6a03');
    render('pane-a');

    act(() => {
      buttonLabelled('Run claude --resume')?.click();
    });

    expect(wallActions.onClickPanel).toHaveBeenCalledWith('pane-a');
    expect(registry.runResumeCommand).toHaveBeenCalledWith('pane-a', 'claude --resume 4f2c9b1e-6a03');
    expect(vi.mocked(wallActions.onClickPanel).mock.invocationCallOrder[0])
      .toBeLessThan(registry.runResumeCommand.mock.invocationCallOrder[0]);
  });

  it('retires the offer on Dismiss', () => {
    offerResumeCommand('pane-a', 'claude --resume abc');
    render('pane-a');

    act(() => {
      buttonLabelled('Dismiss')?.click();
    });

    expect(getResumeOffer('pane-a')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(registry.runResumeCommand).not.toHaveBeenCalled();
  });

  it('shows only in the pane the offer belongs to', () => {
    offerResumeCommand('pane-a', 'claude --resume abc');
    render('pane-b');

    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});
