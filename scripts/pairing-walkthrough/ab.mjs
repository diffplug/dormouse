/**
 * A session-scoped `agent-browser` wrapper for the pairing walkthrough
 * (`scripts/pairing-walkthrough/README.md`).
 *
 * One instance is one `--session`, which is one isolated browser. The Burrow runs
 * in the session the `dev:standalone:ab` harness opened; the Pocket browser is a
 * second instance with its own session name, which is why this is a class rather
 * than a module of free functions.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { exec, signalUntilGone, waitFor } from './proc.mjs';

const BIN = 'agent-browser';

/**
 * Where `agent-browser` keeps its state — daemon pid files, session configs and
 * its Chrome downloads. `agent-browser doctor` prints it as "State and socket
 * directory"; the CLI has no env var that relocates it, so neither does this.
 */
export const AGENT_BROWSER_HOME = join(homedir(), '.agent-browser');

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
  async eval(js, { strict = false } = {}) {
    const out = await this.run(['eval', '--stdin'], { input: `(() => {${js}})()` });
    // The CLI JSON-encodes whatever the expression returned, so one parse is
    // the whole transport — the body must not stringify anything itself.
    const text = out.trim();
    if (text === '' || text === 'undefined') return undefined;
    try {
      return JSON.parse(text);
    } catch {
      // Not JSON: a diagnostic the CLI printed instead of a result. `strict`
      // callers are readiness probes, and a non-empty diagnostic handed back
      // raw is *truthy* — which would read as "ready" and let a page that never
      // loaded, or a diagnostic string standing in for a pairing code, straight
      // through. So they get a throw, which `waitFor` treats as "not yet" and
      // names if it times out.
      if (strict) throw new Error(`agent-browser eval answered non-JSON: ${text}`);
      return text;
    }
  }

  async open(url) {
    return this.run(['open', url]);
  }

  /**
   * Poll `js` in the page until it answers something truthy, and hand that
   * answer back — the probe and the read the step wants are the same round
   * trip, so they cannot disagree (`proc.mjs` → `waitFor`).
   */
  waitUntil(js, options) {
    return waitFor(() => this.eval(js, { strict: true }), options);
  }

  /**
   * `keyboard <sub> <text>` — whatever has focus receives it. `inserttext` is
   * atomic where `type` reorders characters under load, so a typed command line
   * can be trusted without reading it back.
   */
  async keyboard(sub, text) {
    return this.run(['keyboard', sub, text]);
  }

  /**
   * `press <key>` — a real key event on the focused element.
   *
   * A *top-level* verb: `keyboard` takes only `type` and `inserttext`, which is
   * why driving a submit used to mean dispatching a synthetic `KeyboardEvent`.
   */
  async press(key) {
    return this.run(['press', key]);
  }

  async screenshot(path) {
    await this.run(['screenshot', path]);
    return path;
  }

  /**
   * Everything the page is currently saying, for the copy pass that reads every
   * string a user meets on this path.
   *
   * `innerText` rather than `textContent`, so it is what is *visible* and in
   * reading order. Anything announced — an error row, a live region — is
   * appended under a rule as well as left in place: a code screen's two digits
   * and an alert's sentence read identically as plain text otherwise.
   */
  async visibleText() {
    return this.eval(`const body = document.body ? document.body.innerText.trim() : '';
      const announced = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')]
        .map((el) => el.innerText.trim())
        .filter(Boolean);
      return announced.length === 0
        ? body
        : body + '\\n\\n--- announced ---\\n' + announced.join('\\n');`);
  }

  /**
   * Open `url` until it sticks.
   *
   * The first `open` against a daemon that has just been closed lands on
   * `about:blank` instead of navigating — the stray-`about:blank` race the
   * `debug-standalone-agent-browser` skill documents. Re-issuing is the fix, so
   * this issues and re-checks rather than trusting the first one.
   *
   * **Checks before it opens**, because `open` on a live page is a real
   * navigation: when the Burrow harness has already put the app there, opening
   * again would tear down the page's bridge connection and rebuild it for
   * nothing.
   */
  async openUntil(url, ready, { attempts = 6, settleMs = 1500 } = {}) {
    const isReady = () => this.eval(ready, { strict: true }).catch(() => false);
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (await isReady()) return;
      if (attempt === attempts) break;
      await this.open(url).catch(() => {});
      // Poll the same oracle rather than sleeping the settle out: a page that
      // is up in 200ms costs 200ms, and one that is not still gets its full
      // window before the next `open`.
      await waitFor(isReady, { timeoutMs: settleMs, intervalMs: 200, what: url }).catch(() => {});
    }
    throw new Error(`page at ${url} never became ready (session ${this.session})`);
  }

  /** Close the browser. Session-scoped — `close --all` would take every session. */
  async close() {
    await this.run(['close']).catch(() => {});
  }

  /**
   * Terminate the per-session daemon and forget the session.
   *
   * `close` stops Chrome but leaves the daemon alive holding its config, and
   * there is no CLI verb that stops one — so the pid file is the only handle.
   * Leaving it behind is what makes a later run inherit the wrong headed/headless
   * mode and a stale profile. The config goes too: session names carry the run's
   * timestamp, so one left behind per run is litter in the user's home directory
   * that nothing will ever read again.
   *
   * The shipped app carries the same workaround for the same reason
   * (`lib/src/host/agent-browser-burrow.ts`); a CLI that grows a `session stop`
   * retires both.
   */
  async killDaemon() {
    try {
      return await stopDaemon(join(AGENT_BROWSER_HOME, `${this.session}.pid`));
    } finally {
      rmSync(join(AGENT_BROWSER_HOME, `${this.session}.config`), { force: true });
    }
  }
}

/** SIGTERM then SIGKILL the pid in `pidFile`, answering it (or null if absent). */
async function stopDaemon(pidFile) {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const gone = () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  await signalUntilGone(
    (signal) => {
      try {
        process.kill(pid, signal);
        return true;
      } catch {
        return false;
      }
    },
    gone,
    { graceMs: 2000, killMs: 2000 },
  );
  return pid;
}
