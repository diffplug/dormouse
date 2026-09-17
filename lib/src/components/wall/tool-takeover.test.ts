import { describe, expect, it } from 'vitest';
import {
  callerStillPlaceable,
  callerStillRunnable,
  isNakedToolInvocation,
  toolRerunsInCaller,
  toolTakesOverCaller,
  type ToolTakeoverGate,
} from './tool-takeover';

describe('isNakedToolInvocation', () => {
  it('accepts a `dor tool` line typed on its own', () => {
    expect(isNakedToolInvocation('dor tool storybook')).toBe(true);
    expect(isNakedToolInvocation('  dor tool storybook  ')).toBe(true);
    expect(isNakedToolInvocation('dor tool -- pnpm storybook')).toBe(true);
    expect(isNakedToolInvocation('dor tool --fresh storybook')).toBe(true);
    expect(isNakedToolInvocation('/usr/local/bin/dor tool storybook')).toBe(true);
    expect(isNakedToolInvocation('dor.cmd tool storybook')).toBe(true);
    // The shared tokenizer skips a leading assignment, as `commandArgv0` does.
    expect(isNakedToolInvocation('DEBUG=1 dor tool storybook')).toBe(true);
  });

  it('rejects a line that is not a bare `dor tool`', () => {
    expect(isNakedToolInvocation(null)).toBe(false);
    expect(isNakedToolInvocation('')).toBe(false);
    expect(isNakedToolInvocation('dor')).toBe(false);
    expect(isNakedToolInvocation('dor split')).toBe(false);
    expect(isNakedToolInvocation('dortool storybook')).toBe(false);
    // The agent case: `dor tool` runs under whatever the pane is running.
    expect(isNakedToolInvocation('claude')).toBe(false);
    expect(isNakedToolInvocation('bash deploy.sh')).toBe(false);
  });

  it('rejects anything that could be more than one command', () => {
    expect(isNakedToolInvocation('dor tool storybook && pnpm build')).toBe(false);
    expect(isNakedToolInvocation('dor tool storybook; echo done')).toBe(false);
    expect(isNakedToolInvocation('dor tool storybook | tee log')).toBe(false);
    expect(isNakedToolInvocation('dor tool storybook &')).toBe(false);
    expect(isNakedToolInvocation('dor tool storybook > log')).toBe(false);
    expect(isNakedToolInvocation('echo $(dor tool storybook)')).toBe(false);
    // Quoting is not unpicked: a conservative split beats parsing for intent.
    expect(isNakedToolInvocation('dor tool -- sh -c "a && b"')).toBe(false);
  });
});

describe.each(['tool', 'open'] as const)('toolTakesOverCaller for dor %s', (verb) => {
  const passing: ToolTakeoverGate = {
    verb,
    explicitSurface: false,
    minimized: false,
    workspaceActive: true,
    visible: true,
    kind: 'terminal',
    oscDriven: true,
    rawCommandLine: verb === 'tool' ? 'dor tool storybook' : 'dor open README.md',
    cwdMatches: true,
    helperPresent: false,
  };

  it('takes over the pane the invocation was typed in', () => {
    expect(toolTakesOverCaller(passing)).toBe(true);
  });

  it('splits when any condition fails', () => {
    const splits: Array<[string, Partial<ToolTakeoverGate>]> = [
      ['--surface named a reference', { explicitSurface: true }],
      ['--minimize asked for a background surface', { minimized: true }],
      ['the caller is minimized', { visible: false }],
      ['another Workspace is active', { workspaceActive: false }],
      ['the caller has an auxiliary helper', { helperPresent: true }],
      ['the caller is already a tool', { kind: 'tool' }],
      ['the caller is a browser', { kind: 'browser' }],
      ['the shell reports no OSC 633', { oscDriven: false }],
      ['the line is not naked', { rawCommandLine: 'claude' }],
      ['the line is compound', { rawCommandLine: `${passing.rawCommandLine} && echo done` }],
      ['the verb does not match', { rawCommandLine: verb === 'tool' ? 'dor open README.md' : 'dor tool storybook' }],
      ['--cwd named another directory', { cwdMatches: false }],
    ];
    for (const [why, override] of splits) {
      expect(toolTakesOverCaller({ ...passing, ...override }), why).toBe(false);
    }
  });

  it('re-runs in the caller only when the caller is that tool', () => {
    expect(toolRerunsInCaller({ ...passing, kind: 'tool' })).toBe(true);
    expect(toolRerunsInCaller(passing)).toBe(false);
    expect(toolRerunsInCaller({ ...passing, kind: 'tool', rawCommandLine: 'claude' })).toBe(false);
    expect(toolRerunsInCaller({ ...passing, kind: 'tool', oscDriven: false })).toBe(false);
  });

  // The pane already is the tool, so there is nothing to place and the tool
  // re-runs in its own directory — as an `adopted` match from any pane does.
  it('re-runs regardless of the conditions that only govern placement', () => {
    for (const override of [{ cwdMatches: false }, { explicitSurface: true }, { minimized: true }, { visible: false }, { workspaceActive: false }]) {
      expect(toolRerunsInCaller({ ...passing, kind: 'tool', ...override })).toBe(true);
      expect(toolTakesOverCaller({ ...passing, ...override })).toBe(false);
    }
  });
});

// What each placement re-reads once the caller's shell is back at a prompt: the
// command line has finished by then, so it is not among the conditions.
describe('after the prompt wait', () => {
  const passing: ToolTakeoverGate = {
    verb: 'tool',
    explicitSurface: false,
    minimized: false,
    workspaceActive: true,
    visible: true,
    kind: 'terminal',
    oscDriven: true,
    rawCommandLine: null,
    cwdMatches: true,
    helperPresent: false,
  };

  it('a transformation needs a surviving plain helper-less pane in place, regardless of Workspace selection', () => {
    expect(callerStillPlaceable(passing)).toBe(true);
    expect(callerStillPlaceable({ ...passing, workspaceActive: false })).toBe(true);
    for (const override of [ { visible: false }, { cwdMatches: false }, { kind: 'tool' as const }, { helperPresent: true }]) {
      expect(callerStillPlaceable({ ...passing, ...override })).toBe(false);
    }
  });

  it('a re-run needs only the pane and its directory', () => {
    expect(callerStillRunnable({ ...passing, kind: 'tool', helperPresent: true, workspaceActive: false })).toBe(true);
    expect(callerStillRunnable({ ...passing, visible: false })).toBe(false);
    expect(callerStillRunnable({ ...passing, cwdMatches: false })).toBe(false);
  });
});
