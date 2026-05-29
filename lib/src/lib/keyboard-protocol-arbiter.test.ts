import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachKeyboardProtocolArbiter } from './keyboard-protocol-arbiter';

afterEach(() => {
  vi.restoreAllMocks();
});

interface MockHandlers {
  push: Array<() => boolean>;
  pop: Array<() => boolean>;
}

function buildMockTerminal(
  initial: { kittyKeyboard?: boolean; win32InputMode?: boolean } = { kittyKeyboard: true, win32InputMode: true },
): { terminal: Terminal; handlers: MockHandlers; getExt: () => Record<string, unknown> | undefined } {
  const handlers: MockHandlers = { push: [], pop: [] };
  let vtExtensions: Record<string, unknown> | undefined = { ...initial };
  const parser = {
    registerCsiHandler(id: { prefix?: string; final?: string }, cb: () => boolean) {
      if (id.prefix === '>' && id.final === 'u') handlers.push.push(cb);
      else if (id.prefix === '<' && id.final === 'u') handlers.pop.push(cb);
      return { dispose: vi.fn() };
    },
  };
  const terminal = {
    parser,
    get options() {
      return {
        get vtExtensions() {
          return vtExtensions;
        },
        set vtExtensions(value: Record<string, unknown> | undefined) {
          vtExtensions = value;
        },
      };
    },
  } as unknown as Terminal;
  return { terminal, handlers, getExt: () => vtExtensions };
}

describe('attachKeyboardProtocolArbiter', () => {
  it('registers one kitty-push and one kitty-pop handler', () => {
    const { terminal, handlers } = buildMockTerminal();
    attachKeyboardProtocolArbiter(terminal);
    expect(handlers.push).toHaveLength(1);
    expect(handlers.pop).toHaveLength(1);
  });

  it('handlers return false so xterm still processes the kitty sequence', () => {
    const { terminal, handlers } = buildMockTerminal();
    attachKeyboardProtocolArbiter(terminal);
    expect(handlers.push[0]()).toBe(false);
    expect(handlers.pop[0]()).toBe(false);
  });

  it('disables win32-input-mode on kitty push, preserving kittyKeyboard', () => {
    const { terminal, handlers, getExt } = buildMockTerminal({ kittyKeyboard: true, win32InputMode: true });
    attachKeyboardProtocolArbiter(terminal);

    handlers.push[0]();

    expect(getExt()).toEqual({ kittyKeyboard: true, win32InputMode: false });
  });

  it('re-enables win32-input-mode on kitty pop', () => {
    const { terminal, handlers, getExt } = buildMockTerminal({ kittyKeyboard: true, win32InputMode: true });
    attachKeyboardProtocolArbiter(terminal);

    handlers.push[0]();
    expect(getExt()).toMatchObject({ win32InputMode: false });

    handlers.pop[0]();
    expect(getExt()).toEqual({ kittyKeyboard: true, win32InputMode: true });
  });

  it('dispose tears down both handlers', () => {
    const disposables: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const terminal = {
      parser: {
        registerCsiHandler() {
          const d = { dispose: vi.fn() };
          disposables.push(d);
          return d;
        },
      },
      options: { vtExtensions: { kittyKeyboard: true, win32InputMode: true } },
    } as unknown as Terminal;

    const arbiter = attachKeyboardProtocolArbiter(terminal);
    arbiter.dispose();

    expect(disposables).toHaveLength(2);
    expect(disposables[0].dispose).toHaveBeenCalledOnce();
    expect(disposables[1].dispose).toHaveBeenCalledOnce();
  });
});
