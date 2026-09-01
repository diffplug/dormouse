import { describe, expect, it } from 'vitest';
import { isNakedToolInvocation, toolTakesOverCaller, type ToolTakeoverGate } from './tool-takeover';

describe('isNakedToolInvocation', () => {
  it('accepts a `dor tool` line typed on its own', () => {
    expect(isNakedToolInvocation('dor tool storybook')).toBe(true);
    expect(isNakedToolInvocation('  dor tool storybook  ')).toBe(true);
    expect(isNakedToolInvocation('dor tool -- pnpm storybook')).toBe(true);
    expect(isNakedToolInvocation('dor tool --fresh storybook')).toBe(true);
    expect(isNakedToolInvocation('/usr/local/bin/dor tool storybook')).toBe(true);
    expect(isNakedToolInvocation('C:\\tools\\dor.cmd tool storybook')).toBe(true);
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

describe('toolTakesOverCaller', () => {
  const passing: ToolTakeoverGate = {
    callerId: 'pane-a',
    explicitSurface: false,
    minimized: false,
    visible: true,
    component: 'terminal',
    oscDriven: true,
    rawCommandLine: 'dor tool storybook',
    cwdMatches: true,
  };

  it('takes over the pane the invocation was typed in', () => {
    expect(toolTakesOverCaller(passing)).toBe(true);
  });

  it('splits when any condition fails', () => {
    const splits: Array<[string, Partial<ToolTakeoverGate>]> = [
      ['no caller (dor ran outside Dormouse)', { callerId: undefined }],
      ['--surface named a reference', { explicitSurface: true }],
      ['--minimize asked for a background surface', { minimized: true }],
      ['the caller is minimized', { visible: false }],
      ['the caller is already a tool', { component: 'tool' }],
      ['the caller is a browser', { component: 'browser' }],
      ['the shell reports no OSC 633', { oscDriven: false }],
      ['the line is not naked', { rawCommandLine: 'claude' }],
      ['--cwd named another directory', { cwdMatches: false }],
    ];
    for (const [why, override] of splits) {
      expect(toolTakesOverCaller({ ...passing, ...override }), why).toBe(false);
    }
  });
});
