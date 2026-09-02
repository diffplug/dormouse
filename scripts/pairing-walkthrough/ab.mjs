/**
 * A session-scoped `agent-browser` wrapper for the pairing walkthrough
 * (`scripts/pairing-walkthrough/README.md`).
 *
 * One instance is one `--session`, which is one isolated browser. The Host runs
 * in the session the `dev:standalone:ab` harness opened; stage (b)'s Pocket
 * browser is a second instance with its own session name, which is why this is
 * a class rather than a module of free functions.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { delay, exec } from './proc.mjs';

const BIN = 'agent-browser';

export class AgentBrowser {
  /** @param {string} session `--session` name. @param {string} cwd repo root. */
  constructor(session, cwd) {
    this.session = session;
    this.cwd = cwd;
  }

  /** `agent-browser --session <s> <args…>`, stdout trimmed. */
  async run(args, options = {}) {
    const { stdout } = await exec(BIN, ['--session', this.session, ...args], {
      cwd: this.cwd,
      ...options,
    });
    return stdout.trim();
  }

  /**
   * Evaluate `js` in the page and JSON-parse what it returns.
   *
   * Two rules the CLI imposes, both handled here so callers never have to think
   * about them: the page context is *persistent*, so a bare `const` at top level
   * collides with the last call's (every body is wrapped in an IIFE), and inline
   * `eval "…"` mangles quoting, so the body goes in over stdin.
   */
  async eval(js) {
    const out = await this.run(['eval', '--stdin'], { input: `(() => {${js}})()` });
    // The CLI JSON-encodes whatever the expression returned, so one parse is
    // the whole transport — the body must not stringify anything itself.
    const text = out.trim();
    if (text === '' || text === 'undefined') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON: a diagnostic, or a value the CLI printed raw. Hand it back so
      // the caller's assertion says what it saw.
      return text;
    }
  }

  async open(url) {
    return this.run(['open', url]);
  }

  async screenshot(path) {
    await this.run(['screenshot', path]);
    return path;
  }

  /**
   * Open `url` until it sticks.
   *
   * The first `open` against a daemon that has just been closed lands on
   * `about:blank` instead of navigating — the stray-`about:blank` race the
   * `debug-standalone-agent-browser` skill documents. Re-issuing is the fix, so
   * this issues and re-checks rather than trusting the first one.
   */
  async openUntil(url, ready, { attempts = 6, settleMs = 1500 } = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.open(url).catch(() => {});
      await delay(settleMs);
      if (await this.eval(ready).catch(() => false)) return;
    }
    throw new Error(`page at ${url} never became ready (session ${this.session})`);
  }

  /** Close the browser. Session-scoped — `close --all` would take every session. */
  async close() {
    await this.run(['close']).catch(() => {});
  }

  /**
   * Terminate the per-session daemon.
   *
   * `close` stops Chrome but leaves the daemon alive holding its config, and
   * there is no CLI verb that stops one — so the pid file is the only handle.
   * Leaving it behind is what makes a later run inherit the wrong headed/headless
   * mode and a stale profile.
   */
  async killDaemon() {
    const dir = process.env.AGENT_BROWSER_SOCKET_DIR || join(homedir(), '.agent-browser');
    const pidFile = join(dir, `${this.session}.pid`);
    if (!existsSync(pidFile)) return null;
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(pid, signal);
      } catch {
        return pid;
      }
      for (let i = 0; i < 20; i++) {
        await delay(100);
        try {
          process.kill(pid, 0);
        } catch {
          return pid;
        }
      }
    }
    return pid;
  }
}
