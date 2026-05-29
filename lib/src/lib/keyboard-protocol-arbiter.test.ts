import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachKeyboardProtocolArbiter } from './keyboard-protocol-arbiter';

afterEach(() => {
  vi.restoreAllMocks();
});

type PushHandler = () => boolean;
type PopHandler = (params: (number | number[])[]) => boolean;

interface MockHandlers {
  push: Array<PushHandler>;
  pop: Array<PopHandler>;
}

function buildMockTerminal(
  initial: { kittyKeyboard?: boolean; win32InputMode?: boolean } = { kittyKeyboard: true, win32InputMode: true },
): { terminal: Terminal; handlers: MockHandlers; getExt: () => Record<string, unknown> | undefined } {
  const handlers: MockHandlers = { push: [], pop: [] };
  const parser = {
    registerCsiHandler(
      id: { prefix?: string; final?: string },
      cb: (params: (number | number[])[]) => boolean,
    ) {
      if (id.prefix === '>' && id.final === 'u') handlers.push.push(cb as PushHandler);
      else if (id.prefix === '<' && id.final === 'u') handlers.pop.push(cb);
      return { dispose: vi.fn() };
    },
  };
  // A plain property suffices: the arbiter reads and reassigns the whole
  // vtExtensions object, so no getter/setter is needed to observe writes.
  const options = { vtExtensions: { ...initial } as Record<string, unknown> | undefined };
  const terminal = { parser, options } as unknown as Terminal;
  return { terminal, handlers, getExt: () => options.vtExtensions };
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
    expect(handlers.pop[0]([])).toBe(false);
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

    handlers.pop[0]([]);
    expect(getExt()).toEqual({ kittyKeyboard: true, win32InputMode: true });
  });

  it('keeps win32-input-mode disabled when an inner kitty consumer pops but an outer one is still active', () => {
    const { terminal, handlers, getExt } = buildMockTerminal({ kittyKeyboard: true, win32InputMode: true });
    attachKeyboardProtocolArbiter(terminal);

    handlers.push[0]();
    handlers.push[0]();
    expect(getExt()).toMatchObject({ win32InputMode: false });

    handlers.pop[0]([]);
    expect(getExt()).toMatchObject({ win32InputMode: false });

    handlers.pop[0]([]);
    expect(getExt()).toMatchObject({ win32InputMode: true });
  });

  it('honors the pop-count parameter on `CSI < N u`', () => {
    const { terminal, handlers, getExt } = buildMockTerminal({ kittyKeyboard: true, win32InputMode: true });
    attachKeyboardProtocolArbiter(terminal);

    handlers.push[0]();
    handlers.push[0]();
    handlers.pop[0]([2]);

    expect(getExt()).toMatchObject({ win32InputMode: true });
  });

  it('clamps depth at zero so a stray pop without a matching push is a no-op', () => {
    const { terminal, handlers, getExt } = buildMockTerminal({ kittyKeyboard: true, win32InputMode: true });
    attachKeyboardProtocolArbiter(terminal);

    handlers.pop[0]([]);
    expect(getExt()).toMatchObject({ win32InputMode: true });

    handlers.push[0]();
    expect(getExt()).toMatchObject({ win32InputMode: false });

    handlers.pop[0]([]);
    expect(getExt()).toMatchObject({ win32InputMode: true });
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
