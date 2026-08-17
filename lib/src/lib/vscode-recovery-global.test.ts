import { afterEach, describe, expect, it, vi } from 'vitest';
import { RECOVERY_COMMANDS_GLOBAL, readInjectedRecoveryCommands } from './vscode-recovery-global';

const inject = (value: unknown) => vi.stubGlobal(RECOVERY_COMMANDS_GLOBAL, value);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readInjectedRecoveryCommands', () => {
  it('reads the map the host injected', () => {
    inject({ 'pane-a': 'claude --resume abc', 'pane-b': 'codex resume 01JC' });

    expect(readInjectedRecoveryCommands()).toEqual({
      'pane-a': 'claude --resume abc',
      'pane-b': 'codex resume 01JC',
    });
  });

  it('returns an empty map when the host injected nothing', () => {
    // The normal case for a webview whose teardown captured no agent, and for
    // every host that does not implement capture at all.
    expect(readInjectedRecoveryCommands()).toEqual({});
    inject(null);
    expect(readInjectedRecoveryCommands()).toEqual({});
  });

  it('degrades to no recovery on a malformed payload rather than passing it on', () => {
    // These values reach restoreTerminal, so a bad shape must fail closed.
    for (const bad of ['a string', 42, ['pane-a'], true]) {
      inject(bad);
      expect(readInjectedRecoveryCommands()).toEqual({});
    }
  });

  it('drops individual entries that are not non-empty strings', () => {
    inject({ 'pane-a': 'claude --continue', 'pane-b': '', 'pane-c': 7, 'pane-d': null });

    expect(readInjectedRecoveryCommands()).toEqual({ 'pane-a': 'claude --continue' });
  });

  it('never answers a lookup with an inherited Object member', () => {
    // The caller looks up by arbitrary surface id. On a plain object literal
    // `commands['constructor']` is a *function*, which the per-entry shape check
    // above never sees (it only visits own keys) — and a function reaching
    // `normalizeResumeCommand` throws out of `restoreSession`, losing every
    // persisted pane rather than just this one.
    inject({ 'pane-a': 'claude --continue' });
    const commands = readInjectedRecoveryCommands();

    for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(commands[inherited]).toBeUndefined();
    }
  });
});
