import { describe, expect, it } from 'vitest';
import { isAllowedAgentBrowserBinary } from './agent-browser-binary';

// `binaryPath` reaches the host from the webview realm and off the persisted
// session blob, and the host hands it to `spawnAndCapture`. The predicate is
// what keeps that from being an arbitrary-exec channel, so its edges are the
// test (docs/specs/dor-browser.md → "Agent-Browser Host Capabilities").
describe('isAllowedAgentBrowserBinary', () => {
  it('accepts the bare name and an absolute path to an agent-browser', () => {
    expect(isAllowedAgentBrowserBinary('agent-browser')).toBe(true);
    expect(isAllowedAgentBrowserBinary('/opt/homebrew/bin/agent-browser')).toBe(true);
    expect(isAllowedAgentBrowserBinary('/Users/me/.volta/bin/agent-browser')).toBe(true);
    // The Windows PATH shims npm/vfox install beside the POSIX executable.
    expect(isAllowedAgentBrowserBinary('C:\\Users\\me\\bin\\agent-browser.cmd')).toBe(true);
    expect(isAllowedAgentBrowserBinary('C:/Users/me/bin/AGENT-BROWSER.EXE')).toBe(true);
    expect(isAllowedAgentBrowserBinary('\\\\share\\tools\\agent-browser.bat')).toBe(true);
  });

  it('accepts the operator’s own configured path verbatim', () => {
    // Chosen deliberately in the host's environment, so it is allowed to be
    // named anything — but only by exact match, never as a prefix.
    expect(isAllowedAgentBrowserBinary('/opt/ab/run.sh', '/opt/ab/run.sh')).toBe(true);
    expect(isAllowedAgentBrowserBinary('/opt/ab/run.sh.evil', '/opt/ab/run.sh')).toBe(false);
    expect(isAllowedAgentBrowserBinary('/opt/ab/run.sh')).toBe(false);
  });

  it('refuses anything that is not an agent-browser', () => {
    for (const bad of [
      '/usr/bin/curl',
      '/bin/sh',
      '/usr/local/bin/agent-browser-evil',
      '/usr/local/bin/agent-browser.sh',
      // Relative: it would resolve against the host process's cwd, which the
      // caller does not know and must not be able to aim at.
      'bin/agent-browser',
      './agent-browser',
      '../../../usr/bin/agent-browser',
      '/opt/../usr/bin/agent-browser',
      // Control characters are how one argument becomes two.
      '/usr/local/bin/agent-browser\n/bin/sh',
      '/usr/local/bin/agent-browser\u0000',
      '',
      undefined,
      null,
      42,
      { toString: () => '/usr/local/bin/agent-browser' },
    ]) {
      expect(isAllowedAgentBrowserBinary(bad)).toBe(false);
    }
  });
});
