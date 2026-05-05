import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/addon-fit', () => {
  class FitAddon {
    fit(): void {}

    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 };
    }
  }

  return { FitAddon };
});

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    writes: string[] = [];
    private dataListeners = new Set<(data: string) => void>();
    private resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();

    parser = {
      registerCsiHandler: () => ({ dispose: () => {} }),
    };
    modes = {
      mouseTrackingMode: 'none' as const,
      bracketedPasteMode: false,
    };

    loadAddon(): void {}

    open(): void {}

    write(data: string, _callback?: () => void): void {
      this.writes.push(data);
    }

    onData(listener: (data: string) => void): { dispose: () => void } {
      this.dataListeners.add(listener);
      return {
        dispose: () => {
          this.dataListeners.delete(listener);
        },
      };
    }

    onResize(listener: (size: { cols: number; rows: number }) => void): { dispose: () => void } {
      this.resizeListeners.add(listener);
      return {
        dispose: () => {
          this.resizeListeners.delete(listener);
        },
      };
    }

    onRender(): { dispose: () => void } {
      return { dispose: () => {} };
    }

    focus(): void {}

    blur(): void {}

    dispose(): void {}

    emitInput(data: string): void {
      this.dataListeners.forEach((listener) => listener(data));
    }

    emitResize(cols: number, rows: number): void {
      this.resizeListeners.forEach((listener) => listener({ cols, rows }));
    }
  }

  return { Terminal: MockTerminal };
});

vi.mock('./platform', async () => {
  const actual = await vi.importActual<typeof import('./platform')>('./platform');
  const fakePlatform = new actual.FakePtyAdapter();
  return {
    ...actual,
    getPlatform: () => fakePlatform,
    __fakePlatform: fakePlatform,
  };
});

import * as platformModule from './platform';
import { makeAlertScenario, type FakePtyAdapter, type FakeScenario } from './platform';
import {
  DEFAULT_ACTIVITY_STATE,
  mountElement,
  clearSessionAttention,
  clearSessionTodo,
  disposeAllSessions,
  disposeSession,
  unmountElement,
  disableSessionAlert,
  dismissOrToggleAlert,
  dismissSessionAlert,
  focusSession,
  getOrCreateTerminal,
  getActivity,
  initAlertStateReceiver,
  markSessionAttention,
  markSessionTodo,
  restoreTerminal,
  swapTerminals,
  toggleSessionAlert,
  toggleSessionTodo,
} from './terminal-registry';

interface MockTerminalInstance {
  writes: string[];
  emitInput(data: string): void;
  emitResize(cols: number, rows: number): void;
}

class MockElement {
  style: Record<string, string> = {};
  parentElement: MockElement | null = null;
  children: MockElement[] = [];

  appendChild(child: MockElement): MockElement {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) {
      this.parentElement.children.splice(index, 1);
    }
    this.parentElement = null;
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  querySelectorAll(): MockElement[] {
    return [];
  }
  getBoundingClientRect(): DOMRect {
    return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
  }
}

type PlatformModuleWithMock = typeof platformModule & { __fakePlatform: FakePtyAdapter };
type TestTerminalEntry = ReturnType<typeof getOrCreateTerminal> & {
  terminal: MockTerminalInstance;
  element: MockElement;
};

const fakePlatform = (platformModule as PlatformModuleWithMock).__fakePlatform;

function createContainer(): MockElement {
  return new MockElement();
}

function createSession(id: string, scenario?: FakeScenario): TestTerminalEntry {
  fakePlatform.clearScenario(id);
  if (scenario) {
    fakePlatform.setScenario(id, scenario);
  }
  return getOrCreateTerminal(id) as TestTerminalEntry;
}

function advance(ms: number): void {
  vi.advanceTimersByTime(ms);
}

function emitOutput(id: string, data = 'output'): void {
  fakePlatform.writePty(id, data);
}

function attendSession(id: string): void {
  markSessionAttention(id);
}

function expireAttention(id?: string): void {
  clearSessionAttention(id);
}

function minimizeSession(id: string): void {
  unmountElement(id);
  clearSessionAttention(id);
}

function reattachDoorViaEnter(id: string): void {
  mountElement(id, createContainer() as unknown as HTMLElement);
  markSessionAttention(id);
}

function reattachDoorViaD(id: string): void {
  mountElement(id, createContainer() as unknown as HTMLElement);
}

// Timing helpers based on cfg.alert values:
// busyCandidateGap=1500, busyConfirmGap=500, mightNeedAttention=2000, needsAttentionConfirm=3000

function driveToBusy(id: string): void {
  emitOutput(id, 'prompt> ');
  advance(1_600);
  emitOutput(id, 'working...');
  emitOutput(id, 'more work');
  expect(getActivity(id).status).toBe('BUSY');
}

function driveToRingingNeedsAttention(id: string): void {
  driveToBusy(id);
  expireAttention(id);
  advance(2_000);
  expect(getActivity(id).status).toBe('MIGHT_NEED_ATTENTION');
  advance(3_000);
  expect(getActivity(id).status).toBe('ALERT_RINGING');
}

describe('terminal-registry alert behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakePlatform.reset();
    initAlertStateReceiver();

    const documentElement = new MockElement();
    vi.stubGlobal('document', {
      createElement: () => new MockElement(),
      documentElement,
    });
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: () => '#000000',
    }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });

  afterEach(() => {
    disposeAllSessions();
    fakePlatform.reset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Story 1: quick response never becomes busy', () => {
    const id = 'story-1';
    createSession(
      id,
      makeAlertScenario([{ at: 0, data: 'prompt> quick result\r\nprompt> ' }], {
        name: 'quick-response',
      }),
    );
    toggleSessionAlert(id);
    attendSession(id);

    advance(12_000);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: false,
    });
  });

  it('Story 2: long-running work becomes busy, then completes unattended', () => {
    const id = 'story-2';
    createSession(
      id,
      makeAlertScenario([
        { at: 0, data: 'prompt> ' },
        { at: 1_600, data: 'working...' },
        { at: 1_800, data: 'more work' },
      ], { name: 'long-running' }),
    );
    toggleSessionAlert(id);
    attendSession(id);

    advance(1_800);
    expect(getActivity(id)).toMatchObject({ status: 'BUSY' });

    expireAttention(id);
    advance(2_000);
    expect(getActivity(id).status).toBe('MIGHT_NEED_ATTENTION');

    advance(3_000);
    expect(getActivity(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: false,
    });
  });

  it('Story 3: busy session pauses, then resumes', () => {
    const id = 'story-3';
    createSession(id);
    toggleSessionAlert(id);

    driveToBusy(id);
    advance(2_000);
    expect(getActivity(id).status).toBe('MIGHT_NEED_ATTENTION');

    emitOutput(id, 'still running');

    expect(getActivity(id)).toMatchObject({ status: 'BUSY' });
  });

  it('Story 4: completion while still attended does not ring', () => {
    const id = 'story-4';
    createSession(id);
    toggleSessionAlert(id);
    attendSession(id);

    driveToBusy(id);
    advance(2_000);
    advance(3_000);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: false,
    });
  });

  it('Story 5: user attends to a ringing pane — turns TODO on', () => {
    const id = 'story-5';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    attendSession(id);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
  });

  it('Story 6: dismiss resets to NOTHING_TO_SHOW and turns TODO on; can ring again later', () => {
    const id = 'story-6';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    dismissSessionAlert(id);

    expect(getActivity(id)).toMatchObject({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });

    driveToBusy(id);
    expireAttention(id);
    advance(2_000);
    advance(3_000);

    expect(getActivity(id)).toMatchObject({
      status: 'ALERT_RINGING',
      todo: true,
    });
  });

  it('Story 7: marking TODO clears ring and resets status, leaves alerts enabled', () => {
    const id = 'story-7';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    markSessionTodo(id);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
  });

  it('Story 8: disable alerts clears ring and stops tracking', () => {
    const id = 'story-8';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    disableSessionAlert(id);

    expect(getActivity(id)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });

    emitOutput(id, 'new cycle');
    emitOutput(id, 'more work');
    advance(12_000);

    expect(getActivity(id)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });
  });

  it('Story 9: new output while ringing latches until user attends', () => {
    const id = 'story-9';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    emitOutput(id, 'shell prompt');
    expect(getActivity(id).status).toBe('ALERT_RINGING');

    attendSession(id);
    expect(getActivity(id).status).toBe('NOTHING_TO_SHOW');

    emitOutput(id, 'next task');
    advance(1_600);
    emitOutput(id, 'still going');
    emitOutput(id, 'more work');
    expect(getActivity(id).status).toBe('BUSY');
  });

  it('Story 10: minimize preserves state, click reattach clears ring', () => {
    const id = 'story-10';
    createSession(id);
    toggleSessionAlert(id);
    attendSession(id);

    minimizeSession(id);
    driveToRingingNeedsAttention(id);

    expect(getActivity(id)).toMatchObject({ status: 'ALERT_RINGING' });

    reattachDoorViaEnter(id);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
  });

  it('Story 11: minimize preserves state, d reattach does not clear ring', () => {
    const id = 'story-11';
    createSession(id);
    toggleSessionAlert(id);
    attendSession(id);

    minimizeSession(id);
    driveToRingingNeedsAttention(id);
    reattachDoorViaD(id);

    expect(getActivity(id)).toEqual({
      status: 'ALERT_RINGING',
      todo: false,
    });
  });

  it('Story 12: resize noise never creates a false alert', () => {
    const id = 'story-12';
    const entry = createSession(id);
    toggleSessionAlert(id);

    entry.terminal.emitResize(120, 40);
    emitOutput(id, 'redraw noise');
    advance(12_000);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: false,
    });
  });

  it('Story 13: multiple sessions ring independently', () => {
    const alpha = 'story-13-a';
    const beta = 'story-13-b';
    createSession(alpha);
    createSession(beta);
    toggleSessionAlert(alpha);
    toggleSessionAlert(beta);

    driveToRingingNeedsAttention(alpha);
    driveToRingingNeedsAttention(beta);

    dismissSessionAlert(alpha);
    attendSession(beta);

    expect(getActivity(alpha)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
    expect(getActivity(beta)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
  });

  it('Story 14: destroying a session clears alert, TODO, and attention state', () => {
    const id = 'story-14';
    createSession(id);
    toggleSessionAlert(id);
    driveToRingingNeedsAttention(id);
    toggleSessionTodo(id);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });

    disposeSession(id);
    expect(getActivity(id)).toEqual(DEFAULT_ACTIVITY_STATE);

    createSession(id);
    toggleSessionAlert(id);
    driveToBusy(id);
    expireAttention(id);
    advance(2_000);
    advance(3_000);

    expect(getActivity(id)).toEqual({
      status: 'ALERT_RINGING',
      todo: false,
    });
  });

  it('marks attention from terminal input and clears ringing immediately', () => {
    const id = 'input-attention';
    const entry = createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    entry.terminal.emitInput('x');

    // Typing while ringing: attend clears ring, turns TODO on.
    // Plain 'x' is not Enter, so TODO stays on.
    expect(getActivity(id).status).toBe('NOTHING_TO_SHOW');
    expect(getActivity(id).todo).toBe(true);
  });

  it('Enter that dismisses a ringing alert leaves the auto-created TODO visible', () => {
    const id = 'enter-dismisses-ringing';
    const entry = createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    entry.terminal.emitInput('\r');

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
  });

  it('no monitor is created until alert is enabled', () => {
    const id = 'no-monitor';
    createSession(id);

    emitOutput(id, 'prompt> ');
    advance(1_200);
    emitOutput(id, 'working...');
    emitOutput(id, 'more work');
    advance(12_000);

    expect(getActivity(id)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });
  });

  it('enabling alert starts tracking fresh from that moment', () => {
    const id = 'fresh-start';
    createSession(id);

    emitOutput(id, 'old output');
    advance(5_000);

    toggleSessionAlert(id);

    expect(getActivity(id).status).toBe('NOTHING_TO_SHOW');

    emitOutput(id, 'prompt> ');
    advance(1_600);
    emitOutput(id, 'working...');
    emitOutput(id, 'more work');
    expect(getActivity(id).status).toBe('BUSY');
  });

  it('Enter (\\r) in passthrough clears an on-TODO', () => {
    const id = 'enter-clears-todo';
    const entry = createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    attendSession(id);
    expect(getActivity(id).todo).toBe(true);

    entry.terminal.emitInput('\r');
    expect(getActivity(id).todo).toBe(false);
  });

  it('printable input without Enter does not clear a TODO', () => {
    const id = 'printable-keeps-todo';
    const entry = createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    attendSession(id);
    expect(getActivity(id).todo).toBe(true);

    entry.terminal.emitInput('hello');
    expect(getActivity(id).todo).toBe(true);
  });

  it('focus-report control sequences do not clear a TODO', () => {
    const id = 'todo-focus-report';
    const entry = createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    attendSession(id);
    expect(getActivity(id).todo).toBe(true);

    entry.terminal.emitInput('\x1b[I');

    expect(getActivity(id).todo).toBe(true);
  });

  it('preserves keyboard CSI input during restore replay while dropping query replies', () => {
    const id = 'restore-replay-input';
    const received: string[] = [];
    const entry = restoreTerminal(id, { scrollback: 'saved output' }) as TestTerminalEntry;
    fakePlatform.setInputHandler(id, (data) => received.push(data));

    entry.terminal.emitInput('\x1b[A');
    entry.terminal.emitInput('\x1b[?1;2c');
    entry.terminal.emitInput('\x1b[4;600;800t');
    entry.terminal.emitInput('\x1b[?2004;1$y');
    entry.terminal.emitInput('\x1b]10;rgb:aaaa/bbbb/cccc\x07');
    fakePlatform.clearInputHandler(id);

    expect(received).toEqual(['\x1b[A']);
  });

  it('drops DCS status-string replies during replay', () => {
    const id = 'restore-replay-dcs-input';
    const received: string[] = [];
    const entry = restoreTerminal(id, { scrollback: 'saved output' }) as TestTerminalEntry;
    fakePlatform.setInputHandler(id, (data) => received.push(data));

    // xterm.js emits DECRPSS replies for replayed DECRQSS queries such as
    // DCS $ q m ST. These are terminal reports, not user input for the shell.
    entry.terminal.emitInput('\x1bP1$r0m\x1b\\');
    entry.terminal.emitInput('\x1bP1$r24;80r\x1b\\');
    entry.terminal.emitInput('\x1bP0$r\x1b\\');
    entry.terminal.emitInput('a');
    fakePlatform.clearInputHandler(id);

    expect(received).toEqual(['a']);
  });

  it('drops DA3 (DECRPTUI) and DECREQTPARM replies during replay', () => {
    const id = 'restore-replay-da3-input';
    const received: string[] = [];
    const entry = restoreTerminal(id, { scrollback: 'saved output' }) as TestTerminalEntry;
    fakePlatform.setInputHandler(id, (data) => received.push(data));

    // DA3 (CSI = c) → DECRPTUI: DCS ! | <hex id> ST.
    entry.terminal.emitInput('\x1bP!|00000000\x1b\\');
    // DECREQTPARM (CSI x) → CSI Sol;Par;Nbits;Xspeed;Rspeed;Clkmul;Flags x.
    entry.terminal.emitInput('\x1b[2;1;1;112;112;1;0x');
    entry.terminal.emitInput('a');
    fakePlatform.clearInputHandler(id);

    expect(received).toEqual(['a']);
  });


  it('toggleSessionTodo cycles: false → true → false', () => {
    const id = 'toggle-cycle';
    createSession(id);

    expect(getActivity(id).todo).toBe(false);

    toggleSessionTodo(id);
    expect(getActivity(id).todo).toBe(true);

    toggleSessionTodo(id);
    expect(getActivity(id).todo).toBe(false);
  });

  it('new output while ringing without attention does not turn TODO on', () => {
    const id = 'ringing-output-no-todo';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    emitOutput(id, 'next task');

    expect(getActivity(id)).toEqual({
      status: 'ALERT_RINGING',
      todo: false,
    });
  });

  it('disabling alerts while ringing does not turn TODO on', () => {
    const id = 'disable-no-todo';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    disableSessionAlert(id);

    expect(getActivity(id)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });
  });

  it('alert button enables alerts from ALERT_DISABLED', () => {
    const id = 'alert-button-enable';
    createSession(id);

    dismissOrToggleAlert(id, 'ALERT_DISABLED');

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: false,
    });
  });

  it('alert button disables alerts from enabled non-ringing states', () => {
    const id = 'alert-button-disable';
    createSession(id);
    toggleSessionAlert(id);
    driveToBusy(id);

    dismissOrToggleAlert(id, 'BUSY');

    expect(getActivity(id)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });
  });

  it('alert button dismisses ringing alerts and turns TODO on', () => {
    const id = 'alert-button-dismiss';
    createSession(id);
    toggleSessionAlert(id);
    driveToRingingNeedsAttention(id);

    dismissOrToggleAlert(id, 'ALERT_RINGING');

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
  });

  it('clicking a bell rendered as ringing does not disable alerts after attention already reset it', () => {
    const id = 'displayed-ringing-dismiss';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    markSessionAttention(id);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });

    dismissOrToggleAlert(id, 'ALERT_RINGING');

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
  });

  it('a bell click immediately after attention clears ringing is treated as a dismiss, not disable', () => {
    const id = 'recent-ringing-dismiss';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    markSessionAttention(id);

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });

    expect(dismissOrToggleAlert(id, 'NOTHING_TO_SHOW')).toBe('dismissed');
    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: true,
    });
  });

  it('programmatic terminal focus does not count as attention', () => {
    const id = 'focus-without-attention';
    createSession(id);
    toggleSessionAlert(id);

    driveToRingingNeedsAttention(id);
    focusSession(id, true);

    expect(getActivity(id)).toEqual({
      status: 'ALERT_RINGING',
      todo: false,
    });
  });

  it('ignores prompt redraw output immediately after a resize', () => {
    const id = 'resize-debounce';
    const session = createSession(id);
    toggleSessionAlert(id);
    markSessionAttention(id);

    session.terminal.emitResize(120, 30);
    emitOutput(id, 'prompt redraw');
    advance(1_600);
    emitOutput(id, 'working...');

    expect(getActivity(id)).toEqual({
      status: 'NOTHING_TO_SHOW',
      todo: false,
    });
  });

  it('routes alert state updates to the swapped-in pane entry', () => {
    const alpha = 'swap-alpha';
    const beta = 'swap-beta';
    createSession(alpha);
    createSession(beta);

    toggleSessionAlert(alpha);
    markSessionAttention(alpha);
    swapTerminals(alpha, beta);

    emitOutput(alpha, 'prompt> ');
    advance(1_600);
    emitOutput(alpha, 'working...');
    emitOutput(alpha, 'more work');

    expect(getActivity(alpha)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });
    expect(getActivity(beta)).toEqual({
      status: 'BUSY',
      todo: false,
    });
  });

  it('routes alert actions to the swapped-in pane entry', () => {
    const alpha = 'swap-action-alpha';
    const beta = 'swap-action-beta';
    createSession(alpha);
    createSession(beta);

    markSessionTodo(alpha);
    swapTerminals(alpha, beta);

    expect(getActivity(alpha)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });
    expect(getActivity(beta)).toEqual({
      status: 'ALERT_DISABLED',
      todo: true,
    });

    clearSessionTodo(beta);

    expect(getActivity(alpha)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });
    expect(getActivity(beta)).toEqual({
      status: 'ALERT_DISABLED',
      todo: false,
    });
  });
});
