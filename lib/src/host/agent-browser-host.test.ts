import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, promises as fsp, statSync, utimesSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { BrowserOp, BrowserRequestBinding } from '../lib/platform/browser-automation';
import { createAgentBrowserProvider } from './agent-browser-host';
import { createBrowserHost } from './browser-host';

type SpawnResult = { stdout?: string; stderr?: string; code?: number };

const spawnMock = vi.hoisted(() => vi.fn());

// A pid no process on this machine can hold (macOS/Linux pid_max is far lower),
// so `process.kill(pid, 0)` answers ESRCH: "the daemon exited".
const DEAD_PID = 2147483000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const spawnResult = (result: SpawnResult) => ({
  ok: true as const,
  exitCode: result.code ?? 0,
  stdout: result.stdout ?? '',
  stderr: result.stderr ?? '',
});

/** Dispatch spawns by their subcommand (the args after `--session <name>`),
 *  for flows where `open` must stay pending while other commands answer. */
function mockSpawnByCommand(handlers: Record<string, (args: string[]) => Promise<SpawnResult> | SpawnResult>) {
  const calls: string[][] = [];
  spawnMock.mockImplementation(async (_binary: string, args: string[]) => {
    calls.push(args);
    const rest = args[0] === '--session' ? args.slice(2) : args;
    const key = rest[0] === '--headed' ? `--headed ${rest[1]}` : rest[0];
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected spawn: ${args.join(' ')}`);
    return spawnResult(await handler(args));
  });
  return calls;
}

/** A listener standing in for the daemon's stream server, so a port named in
 *  `<session>.stream` actually accepts connections. */
async function listen(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { port: address.port, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A port nothing listens on: bind, read it, release it. */
async function closedPort(): Promise<number> {
  const { port, server } = await listen();
  await closeServer(server);
  return port;
}

/** Point the host at a fresh state directory for each test of the suite, and
 *  reset the spawn mock. */
function useTempSocketDir(prefix: string): void {
  const originalSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR;
  beforeEach(() => {
    spawnMock.mockReset();
    process.env.AGENT_BROWSER_SOCKET_DIR = mkdtempSync(join(tmpdir(), prefix));
  });
  afterEach(() => {
    if (originalSocketDir === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
    else process.env.AGENT_BROWSER_SOCKET_DIR = originalSocketDir;
  });
}

function writeState(session: string, ext: 'pid' | 'stream', value: number): void {
  writeFileSync(join(process.env.AGENT_BROWSER_SOCKET_DIR!, `${session}.${ext}`), `${value}\n`);
}

/** Give each session a running daemon, as its pid file says: the host drives
 *  no other. This test process stands in for it. */
function running(...sessions: string[]): void {
  for (const session of sessions) writeState(session, 'pid', process.pid);
}

// The host spawns through dor-lib-common's spawnAndCapture; mock just that
// boundary (not its internal cross-spawn — spawnAndCapture's own behavior is
// covered by dor-lib-common's tests), keeping the package's other real exports.
vi.mock('dor-lib-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('dor-lib-common')>()),
  spawnAndCapture: spawnMock,
}));

type Host = ReturnType<typeof createBrowserHost>;

/** The shared browser host, driving agent-browser only. */
function makeHost(writeClipboardText = vi.fn()): Host {
  return createBrowserHost({ writeClipboardText, providers: { 'agent-browser': () => createAgentBrowserProvider() } });
}

/** One agent-browser request through `host`, bound to `binding`. */
function ab(host: Host, op: BrowserOp, binding: BrowserRequestBinding = {}) {
  return host.request({ provider: 'agent-browser', binding, ...op });
}

/** The same, answering a screenshot with its file — the sidecar's transport. */
function abFile(host: Host, op: BrowserOp, binding: BrowserRequestBinding = {}) {
  return host.requestFile({ provider: 'agent-browser', binding, ...op });
}

function enqueueSpawnResults(results: SpawnResult[]) {
  const queue = [...results];
  spawnMock.mockImplementation((binary: string, args: string[]) => {
    const result = queue.shift();
    if (!result) throw new Error(`unexpected spawn: ${binary} ${args.join(' ')}`);
    return Promise.resolve({
      ok: true as const,
      exitCode: result.code ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    });
  });
}

describe('agent-browser host relaunch', () => {
  useTempSocketDir('dormouse-ab-host-test-');

  it('closes a stray about:blank tab when tab list reports CLI-style id fields', async () => {
    // No pid file here (an older CLI): the port comes from `stream status` once
    // `open` has returned, and the sweep runs after that.
    enqueueSpawnResults([
      {}, // close
      {}, // --headed open
      { stdout: JSON.stringify({ port: 61218 }) },
      {
        stdout: JSON.stringify({
          tabs: [
            { id: 'blank-tab', url: 'about:blank', active: false },
            { id: 'real-tab', url: 'https://example.com/', active: true },
          ],
        }),
      },
      {}, // tab close blank-tab
    ]);

    const host = makeHost();
    const result = await ab(host, { op: 'launch', url: 'https://example.com/', headed: true }, { session: 'dormouse.1.default', binaryPath: '/usr/local/bin/agent-browser' });

    expect(result).toEqual({
      ok: true, wsPort: 61218, headed: true, session: 'dormouse.1.default', nativeIdentity: 'dormouse.1.default', binaryPath: '/usr/local/bin/agent-browser',
    });
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledWith(
        '/usr/local/bin/agent-browser',
        ['--session', 'dormouse.1.default', 'tab', 'close', 'blank-tab'],
      );
    });
  });

  it('pop-out returns the relaunched daemon\'s port while `open` is still waiting on the page', async () => {
    // The killed daemon leaves its state files behind: a dead pid and a port
    // nothing listens on. The relaunch must not read those as the new daemon.
    const session = 'dormouse.1.default';
    const stale = await closedPort();
    writeState(session, 'pid', DEAD_PID);
    writeState(session, 'stream', stale);
    const opened = deferred<SpawnResult>();
    const calls = mockSpawnByCommand({
      close: () => ({}),
      '--headed open': () => opened.promise,
      tab: (args) => (args.includes('list')
        ? { stdout: JSON.stringify({ tabs: [{ tabId: 'blank', url: 'about:blank', active: false }, { tabId: 'real', url: 'https://example.com/', active: true }] }) }
        : {}),
    });
    const host = makeHost();
    const popOut = ab(host, { op: 'launch', url: 'https://example.com/', headed: true }, { session: session });

    // While the stale files are all there is, the launch waits.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls.some((args) => args.includes('tab'))).toBe(false);
    // The new daemon comes up: a fresh pid and a port that accepts connections.
    const { port, server } = await listen();
    try {
      writeState(session, 'pid', DEAD_PID + 1);
      writeState(session, 'stream', port);
      expect(await popOut).toEqual({ ok: true, wsPort: port, headed: true, session, nativeIdentity: session });
      // `open` has not returned, so no daemon command (the blank-tab sweep) has
      // been queued behind it.
      expect(calls.some((args) => args.includes('tab'))).toBe(false);
      expect(calls.some((args) => args.includes('stream'))).toBe(false);

      opened.resolve({ code: 1, stderr: 'Operation timed out. The page may still be loading' });
      await vi.waitFor(() => {
        expect(calls).toContainEqual(['--session', session, 'tab', 'close', 'blank']);
      });
    } finally {
      await closeServer(server);
    }
  });

  it('does not run an earlier relaunch\'s blank-tab sweep after a later relaunch begins', async () => {
    const session = 'dormouse.1.default';
    const firstOpened = deferred<SpawnResult>();
    const secondClose = deferred<SpawnResult>();
    let closeCount = 0;
    const calls = mockSpawnByCommand({
      close: () => (++closeCount === 1 ? {} : secondClose.promise),
      '--headed open': () => firstOpened.promise,
      tab: () => ({
        stdout: JSON.stringify({
          tabs: [
            { tabId: 'blank', url: 'about:blank', active: false },
            { tabId: 'real', url: 'https://example.com/', active: true },
          ],
        }),
      }),
    });
    // Seed the daemon state that pop-out replaces. Wait until headed open has
    // started before publishing the successor, so a slow CI runner cannot make
    // killDaemon mistake the successor PID for the one it replaced.
    const stale = await closedPort();
    writeState(session, 'pid', DEAD_PID);
    writeState(session, 'stream', stale);
    const host = makeHost();
    const popOut = ab(host, { op: 'launch', url: 'https://example.com/', headed: true }, { session: session });
    await vi.waitFor(() => expect(calls.some((args) => args.includes('--headed'))).toBe(true));
    const { port, server } = await listen();
    try {
      writeState(session, 'pid', DEAD_PID + 1);
      writeState(session, 'stream', port);
      expect(await popOut).toEqual({ ok: true, wsPort: port, headed: true, session, nativeIdentity: session });

      // The second relaunch invalidates the first one's post-open tail before
      // its close queues behind that still-pending `open` command.
      void ab(host, { op: 'launch', url: 'https://example.com/', headed: false }, { session: session });
      await vi.waitFor(() => expect(closeCount).toBe(2));
      firstOpened.resolve({ code: 1, stderr: 'Operation timed out' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls.some((args) => args.includes('tab'))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it('does not run a relaunch blank-tab sweep after the session is explicitly closed', async () => {
    const session = 'dormouse.1.default';
    const opened = deferred<SpawnResult>();
    const explicitClose = deferred<SpawnResult>();
    let closeCount = 0;
    const calls = mockSpawnByCommand({
      close: () => (++closeCount === 1 ? {} : explicitClose.promise),
      '--headed open': () => opened.promise,
      tab: () => ({
        stdout: JSON.stringify({
          tabs: [
            { tabId: 'blank', url: 'about:blank', active: false },
            { tabId: 'real', url: 'https://example.com/', active: true },
          ],
        }),
      }),
    });
    const stale = await closedPort();
    writeState(session, 'pid', DEAD_PID);
    writeState(session, 'stream', stale);
    const host = makeHost();
    const popOut = ab(host, { op: 'launch', url: 'https://example.com/', headed: true }, { session: session });
    await vi.waitFor(() => expect(calls.some((args) => args.includes('--headed'))).toBe(true));
    const { port, server } = await listen();
    try {
      writeState(session, 'pid', DEAD_PID + 1);
      writeState(session, 'stream', port);
      expect(await popOut).toEqual({ ok: true, wsPort: port, headed: true, session, nativeIdentity: session });

      // Pane kill/render-swap enters command('close') and invalidates the
      // relaunch tail synchronously, before the close queues behind open.
      void ab(host, { op: 'close' }, { session: session });
      await vi.waitFor(() => expect(closeCount).toBe(2));
      opened.resolve({ code: 1, stderr: 'Operation timed out' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls.some((args) => args.includes('tab'))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it('does not run a relaunch blank-tab sweep during host shutdown', async () => {
    const session = 'dormouse.1.default';
    const opened = deferred<SpawnResult>();
    let closeCount = 0;
    const calls = mockSpawnByCommand({
      close: () => {
        closeCount += 1;
        // The shutdown close releases the still-pending headed open. Its
        // continuation must already be invalidated before this can happen.
        if (closeCount === 2) opened.resolve({ code: 1, stderr: 'Operation timed out' });
        return {};
      },
      '--headed open': () => opened.promise,
      tab: () => ({
        stdout: JSON.stringify({
          tabs: [
            { tabId: 'blank', url: 'about:blank', active: false },
            { tabId: 'real', url: 'https://example.com/', active: true },
          ],
        }),
      }),
    });
    const stale = await closedPort();
    writeState(session, 'pid', DEAD_PID);
    writeState(session, 'stream', stale);
    const host = makeHost();
    const popOut = ab(host, { op: 'launch', url: 'https://example.com/', headed: true }, { session: session });
    await vi.waitFor(() => expect(calls.some((args) => args.includes('--headed'))).toBe(true));
    const { port, server } = await listen();
    try {
      writeState(session, 'pid', DEAD_PID + 1);
      writeState(session, 'stream', port);
      expect(await popOut).toEqual({ ok: true, wsPort: port, headed: true, session, nativeIdentity: session });

      await host.close();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(closeCount).toBe(2);
      expect(calls.some((args) => args.includes('tab'))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it('open() treats a timed-out page load as a live launch, and a launch with no daemon as a failure', async () => {
    const host = makeHost();
    let session = '';
    // Timed out, daemon up (pid file present): the browser is on the page.
    mockSpawnByCommand({
      open: (args) => {
        session = args[1];
        writeState(session, 'pid', DEAD_PID);
        return { code: 1, stderr: 'Operation timed out. The page may still be loading' };
      },
      stream: () => ({ stdout: JSON.stringify({ port: 61219 }) }),
    });
    expect(await ab(host, { op: 'launch', url: 'https://slow.example/', headed: false })).toEqual({
      ok: true, session: expect.stringMatching(/^dormouse\.1\.gui-/), nativeIdentity: session, wsPort: 61219, headed: false,
    });

    // Failed with no daemon at all: fail, and close so nothing half-launched
    // outlives the swap.
    const calls = mockSpawnByCommand({
      open: () => ({ code: 1, stderr: 'boom' }),
      close: () => ({}),
    });
    expect(await ab(host, { op: 'launch', url: 'https://slow.example/', headed: false })).toEqual({ ok: false, error: 'boom' });
    expect(calls.some((args) => args[2] === 'close')).toBe(true);
    expect(calls.some((args) => args[2] === 'stream')).toBe(false);
  });

  it('reports a zero-exit launch that publishes no stream port without claiming it exited unsuccessfully', async () => {
    const host = makeHost();
    mockSpawnByCommand({
      open: () => ({}),
      stream: () => ({ stdout: '{}' }),
      close: () => ({}),
    });
    expect(await ab(host, { op: 'launch', url: 'https://example.com/', headed: false })).toEqual({
      ok: false,
      error: 'agent-browser published no stream port',
    });

    mockSpawnByCommand({
      close: () => ({}),
      '--headed open': () => ({}),
      stream: () => ({ stdout: '{}' }),
    });
    expect(await ab(host, { op: 'launch', url: 'https://example.com/', headed: true }, { session: 'dormouse.1.default' })).toEqual({
      ok: false,
      error: 'agent-browser published no stream port',
    });
  });
});

describe('agent-browser host daemon stop', () => {
  useTempSocketDir('dormouse-ab-host-stop-');
  const session = 'dormouse.1.tool.t';
  const page = 'http://localhost:6006/';

  it('navigates a live headless daemon a named launch reopens, stopping nothing', async () => {
    const { port, server } = await listen();
    writeState(session, 'pid', process.pid);
    writeState(session, 'stream', port);
    const calls = mockSpawnByCommand({ open: () => ({}) });
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => (signal === 0 ? realKill(pid, 0) : true));
    try {
      // A Tool re-announced: the same session, headless, another page.
      expect(await ab(makeHost(), { op: 'launch', url: page, headed: false }, { session })).toMatchObject({ ok: true, wsPort: port, headed: false });
      await vi.waitFor(() => expect(calls).toEqual([['--session', session, 'open', page]]));
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
    } finally {
      kill.mockRestore();
      await closeServer(server);
    }
  });

  it.each([
    ['names a live process from before this boot', true, true],
    ['names a live process with no stream that accepts', false, false],
  ])('never signals a pid file that %s', async (_name, streaming, preBoot) => {
    const { port, server } = await listen();
    writeState(session, 'pid', process.pid);
    writeState(session, 'stream', streaming ? port : await closedPort());
    if (preBoot) {
      for (const ext of ['pid', 'stream']) utimesSync(join(process.env.AGENT_BROWSER_SOCKET_DIR!, `${session}.${ext}`), 0, 0);
    }
    const calls = mockSpawnByCommand({ close: () => ({}), '--headed open': () => ({}), stream: () => ({ stdout: JSON.stringify({ port }) }), tab: () => ({ stdout: JSON.stringify({ tabs: [] }) }) });
    // The pid named is this test's own: record a signal rather than send it.
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => (signal === 0 ? realKill(pid, 0) : true));
    try {
      // A pop-out: the other mode, so a relaunch that stops what runs first.
      const host = makeHost();
      await ab(host, { op: 'launch', url: page, headed: true }, { session });
      // `close` starts no daemon; only the signal needs proof.
      expect(calls.filter((args) => args.includes('close'))).toEqual([['--session', session, 'close']]);
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
      await host.close();
    } finally {
      kill.mockRestore();
      await closeServer(server);
    }
  });

  it('bounds the CLI a close runs, which a hung daemon would otherwise hold forever', async () => {
    enqueueSpawnResults([{}]);
    await ab(makeHost(), { op: 'close' }, { session });
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith('agent-browser', ['--session', session, 'close'], { timeoutMs: 10_000 });
  });

  it('terminates a daemon its state files prove live before relaunching it in the other mode', async () => {
    const { port, server } = await listen();
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await new Promise((resolve) => daemon.once('spawn', resolve));
    const exited = new Promise((resolve) => daemon.once('exit', resolve));
    writeState(session, 'pid', daemon.pid!);
    writeState(session, 'stream', port);
    mockSpawnByCommand({ close: () => ({}), '--headed open': () => ({}), stream: () => ({ stdout: JSON.stringify({ port }) }), tab: () => ({ stdout: JSON.stringify({ tabs: [] }) }) });
    const kill = vi.spyOn(process, 'kill');
    try {
      const host = makeHost();
      await ab(host, { op: 'launch', url: page, headed: true }, { session });
      expect(kill).toHaveBeenCalledWith(daemon.pid, 'SIGTERM');
      await exited;
      // The port read that ends the launch is bounded by the launch's deadline.
      const status = spawnMock.mock.calls.find(([, args]) => (args as string[]).includes('stream'))!;
      expect(status[2]).toEqual({ timeoutMs: expect.any(Number) });
      expect(status[2].timeoutMs).toBeGreaterThan(0);
      expect(status[2].timeoutMs).toBeLessThanOrEqual(40_000);
      await host.close();
    } finally {
      kill.mockRestore();
      daemon.kill('SIGKILL');
      await closeServer(server);
    }
  });
});

describe('agent-browser host launch directory', () => {
  useTempSocketDir('dormouse-ab-cwd-test-');

  // agent-browser reads `./agent-browser.json` from its working directory, so
  // a GUI launch or relaunch must run where the `dor ab` that made the pane ran.
  it('opens in the binding\'s project directory, and in the host\'s once that is gone', async () => {
    const project = mkdtempSync(join(tmpdir(), 'dormouse-ab-project-'));
    const host = makeHost();
    const openCalls = () => spawnMock.mock.calls.filter(([, args]) => (args as string[]).includes('open'));
    mockSpawnByCommand({ open: () => ({ code: 1, stderr: 'boom' }), close: () => ({}) });
    await ab(host, { op: 'launch', url: 'http://localhost:5173/', headed: false }, { cwd: project });
    expect(openCalls()[0][2]).toEqual({ cwd: project });

    await fsp.rm(project, { recursive: true });
    spawnMock.mockClear();
    await ab(host, { op: 'launch', url: 'http://localhost:5173/', headed: false }, { cwd: project });
    expect(openCalls()[0]).toHaveLength(2);
  });
});

describe('agent-browser host attach', () => {
  const session = 'dormouse.1.default';
  useTempSocketDir('dormouse-ab-attach-test-');

  it('reads a live daemon\'s port from its state files and spawns nothing', async () => {
    const { port, server } = await listen();
    try {
      // This test process stands in for the live daemon.
      writeState(session, 'pid', process.pid);
      writeState(session, 'stream', port);
      const host = makeHost();
      expect(await ab(host, { op: 'attach', url: 'https://example.com/' }, { session })).toEqual({ ok: true, wsPort: port, session, nativeIdentity: session });
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it('never relaunches a daemon that is up but not streaming, nor a gone one it has no page for', async () => {
    const host = makeHost();
    writeState(session, 'pid', process.pid);
    writeState(session, 'stream', await closedPort());
    expect((await ab(host, { op: 'attach', url: 'https://example.com/' }, { session })).ok).toBe(false);

    writeState(session, 'pid', DEAD_PID);
    expect((await ab(host, { op: 'attach' }, { session })).ok).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // Any verb starts a daemon to answer when none runs, at about:blank: an
  // operation on a daemon gone while its pane was hidden, or on one in a
  // socket directory the host does not share, must start nothing.
  it('runs no operation on a session whose daemon is not running', async () => {
    const host = makeHost();
    const ops: BrowserOp[] = [
      { op: 'navigate', url: 'https://example.com/' },
      { op: 'history', dir: 'back' },
      { op: 'tab', action: 'select', tabId: 't1' },
      { op: 'viewport', width: 800, height: 600, dpr: 2 },
      { op: 'device', name: 'iPhone 16' },
      { op: 'edit', edit: 'copy' },
      { op: 'screenshot' },
    ];
    for (const pid of [undefined, DEAD_PID]) {
      if (pid !== undefined) writeState(session, 'pid', pid);
      for (const op of ops) {
        expect(await ab(host, op, { session }), JSON.stringify(op)).toEqual({ ok: false, error: `agent-browser session '${session}' is not running` });
      }
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('relaunches a gone daemon at the page named, headed for a pop-out, and tracks that window for shutdown', async () => {
    writeState(session, 'pid', DEAD_PID);
    writeState(session, 'stream', await closedPort());
    const { port, server } = await listen();
    const opened = deferred<SpawnResult>();
    const calls = mockSpawnByCommand({
      '--headed open': () => {
        // This test process stands in for the relaunched daemon.
        writeState(session, 'pid', process.pid);
        writeState(session, 'stream', port);
        return opened.promise;
      },
      tab: () => ({ stdout: JSON.stringify({ tabs: [{ tabId: 'real', url: 'https://example.com/', active: true }] }) }),
      close: () => ({}),
    });
    try {
      const host = makeHost();
      // Two panes restoring one session relaunch it once.
      const [first, second] = await Promise.all([
        ab(host, { op: 'attach', url: 'https://example.com/', headed: true }, { session }),
        ab(host, { op: 'attach', url: 'https://example.com/', headed: true }, { session }),
      ]);
      // Opened at the page, so the caller has no navigation left to run.
      // Opened at the page, so the caller has no navigation left to run; the
      // second found the browser the first brought up, at the first's page.
      expect(first).toEqual({ ok: true, wsPort: port, relaunched: true, session, nativeIdentity: session });
      expect(second).toEqual({ ok: true, wsPort: port, session, nativeIdentity: session });
      expect(calls).toEqual([
        ['--session', session, 'close'],
        ['--session', session, '--headed', 'open', 'https://example.com/'],
      ]);
      // Once `open` returns, the sweep finds no stray blank tab to close.
      opened.resolve({});
      await vi.waitFor(() => expect(calls).toContainEqual(['--session', session, 'tab', 'list', '--json']));
      expect(calls.filter((args) => args.includes('close'))).toEqual([['--session', session, 'close']]);

      await host.close();
      expect(calls).toContainEqual(['--session', session, 'close']);
    } finally {
      await closeServer(server);
    }
  });

  it('relaunches a caller-named session at the page, and refuses a malformed one', async () => {
    const host = makeHost();
    const { port, server } = await listen();
    const calls = mockSpawnByCommand({
      close: () => ({}),
      open: () => {
        writeState('dormouse.1.tool.a', 'pid', DEAD_PID);
        writeState('dormouse.1.tool.a', 'stream', port);
        return {};
      },
      stream: () => ({ stdout: JSON.stringify({ port }) }),
      tab: () => ({ stdout: JSON.stringify({ tabs: [] }) }),
    });
    try {
      const binding = { session: 'dormouse.1.tool.a' };
      expect(await ab(host, { op: 'launch', url: 'http://localhost:5173/', headed: false }, binding)).toEqual({
        ok: true, session: 'dormouse.1.tool.a', nativeIdentity: 'dormouse.1.tool.a', wsPort: port, headed: false,
      });
      // Whatever held the session is closed first, so the launch lands headless.
      expect(calls[0]).toEqual(['--session', 'dormouse.1.tool.a', 'close']);
      expect(calls).toContainEqual(['--session', 'dormouse.1.tool.a', 'open', 'http://localhost:5173/']);
      const spawned = calls.length;
      expect(await ab(host, { op: 'launch', url: 'http://localhost:5173/', headed: false }, { session: '../evil' })).toEqual({ ok: false, error: 'a valid session name is required' });
      expect(calls).toHaveLength(spawned);
    } finally {
      await closeServer(server);
    }
  });
});

describe('agent-browser host screenshot transport', () => {
  useTempSocketDir('dormouse-ab-shot-test-');
  beforeEach(() => { running('shotfile', 'dormouse.1.default', 'shotbytes', 'shutdown-sess', 'read-sess', 'queued', 'queued-bytes', 'retry-sess', 'sess', 'left', 'kept'); });

  /** agent-browser's `screenshot <path>`, writing `frames` in turn. */
  function captureFrames(...frames: number[][]): string[][] {
    const queue = [...frames];
    const calls: string[][] = [];
    spawnMock.mockImplementation(async (_binary: string, args: string[]) => {
      calls.push(args);
      if (args.includes('screenshot')) writeFileSync(args[args.indexOf('screenshot') + 1], Uint8Array.from(queue.shift() ?? [0]));
      return spawnResult({});
    });
    return calls;
  }
  const read = async (file: string) => Array.from(await fsp.readFile(file));
  const filesIn = async (dir: string) => (await fsp.readdir(dir).catch(() => [] as string[])).sort();

  it('hands the file transport a fresh file per capture, which a later capture never rewrites', async () => {
    const calls = captureFrames([1, 1], [2, 2]);
    const host = makeHost();
    const binding = { session: 'shotfile', binaryPath: '/usr/local/bin/agent-browser' };
    const first = await abFile(host, { op: 'screenshot', format: 'jpeg', quality: 85 }, binding);
    expect(first).toEqual({ ok: true, path: expect.any(String), mime: 'image/jpeg' });
    expect(calls[0]).toEqual(['--session', 'shotfile', 'screenshot', expect.any(String), '--screenshot-format', 'jpeg', '--screenshot-quality', '85']);

    // The next frame is taken while the reader has yet to read the first.
    const second = await abFile(host, { op: 'screenshot', format: 'jpeg' }, binding);
    expect(second.path).not.toBe(first.path);
    expect(await read(first.path!)).toEqual([1, 1]);
    expect(await read(second.path!)).toEqual([2, 2]);
    // Only the files handed out remain: each capture's own file went once read.
    expect(await filesIn(dirname(first.path!))).toEqual([first.path!, second.path!].map((file) => file.slice(dirname(file).length + 1)).sort());
    await host.close();
  });

  // The frame is a picture of the user's authenticated browser, written by an
  // external process under the ambient umask. A derivable path straight in
  // os.tmpdir() let any other local account read every frame, or pre-create the
  // name as a symlink and have agent-browser clobber the target.
  it('captures into a private, unguessable directory rather than a derivable tmp path', async () => {
    const calls = captureFrames([1]);
    const host = makeHost();
    const shot = await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'dormouse.1.default', binaryPath: '/usr/local/bin/agent-browser' });
    if (!shot.ok) throw new Error('expected a path');
    for (const file of [shot.path!, calls[0][3]]) {
      // Nothing about the path is derivable from the session name.
      expect(file).not.toContain('dormouse.1.default');
      expect(dirname(file)).not.toBe(tmpdir());
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    }
    await host.close();
  });

  it('answers the bytes transport with the frame, leaving no file', async () => {
    captureFrames([0xff, 0xd8, 0xff, 0x01]);
    const host = makeHost();
    const result = await ab(host, { op: 'screenshot', format: 'jpeg', quality: 85 }, { session: 'shotbytes', binaryPath: '/usr/local/bin/agent-browser' });
    expect(result.mime).toBe('image/jpeg');
    expect(Array.from(result.bytes ?? [])).toEqual([0xff, 0xd8, 0xff, 0x01]);
    const probe = await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'shotbytes' });
    expect(await filesIn(dirname(probe.path!))).toEqual([probe.path!.slice(dirname(probe.path!).length + 1)]);
    await host.close();
  });

  it('deletes frames never read when their browser closes or relaunches, and any older than every reader\'s wait', async () => {
    captureFrames([1], [2], [3], [4]);
    const host = makeHost();
    const unread = await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'left' });
    await ab(host, { op: 'close' }, { session: 'left' });
    await vi.waitFor(() => expect(existsSync(unread.path!)).toBe(false));

    // A reader that gave up never comes for its frame.
    const stale = await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'kept' });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 40_001);
    try {
      const next = await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'kept' });
      await vi.waitFor(() => expect(existsSync(stale.path!)).toBe(false));
      expect(existsSync(next.path!)).toBe(true);
    } finally {
      clock.mockRestore();
    }
    await host.close();
  });

  it('drops the capture directory on shutdown', async () => {
    captureFrames([1, 2, 3]);
    const host = makeHost();
    const shot = await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'shutdown-sess', binaryPath: '/usr/local/bin/agent-browser' });
    if (!shot.ok) throw new Error('expected a path');
    const dir = dirname(shot.path!);

    await host.close();

    // A frame of the user's authenticated browser must not outlive the process
    // that took it, waiting on whenever the OS gets round to reaping tmp.
    expect(existsSync(dir)).toBe(false);
  });

  it('joins a capture already in flight for the session instead of spawning another', async () => {
    const release = deferred<SpawnResult>();
    spawnMock.mockImplementation(async (_binary: string, args: string[]) => {
      const result = await release.promise;
      writeFileSync(args[3], Uint8Array.from([0xff, 0xd8, 0x01]));
      return spawnResult(result);
    });
    const host = makeHost();

    const paths = [
      abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'queued' }),
      abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'queued' }),
    ];
    const bytes = [
      ab(host, { op: 'screenshot', format: 'jpeg' }, { session: 'queued-bytes' }),
      ab(host, { op: 'screenshot', format: 'jpeg' }, { session: 'queued-bytes' }),
    ];
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2)); // one per session
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spawnMock).toHaveBeenCalledTimes(2);

    release.resolve({});
    // Each file caller gets its own copy, which its reader deletes.
    const [first, second] = await Promise.all(paths);
    expect(second.path).not.toBe(first.path);
    for (const result of [first, second]) expect(await read(result.path!)).toEqual([0xff, 0xd8, 0x01]);
    for (const result of await Promise.all(bytes)) {
      expect(Array.from(result.bytes ?? [])).toEqual([0xff, 0xd8, 0x01]);
    }

    // Once it has answered, the next request captures afresh.
    spawnMock.mockReset();
    captureFrames([1]);
    await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'queued' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it('joins no capture from before a close or relaunch, and bounds every capture', async () => {
    // Every screenshot hangs; closes and relaunch steps answer at once.
    const shots: string[] = [];
    spawnMock.mockImplementation(async (_binary: string, args: string[]) => {
      if (args.includes('screenshot')) {
        shots.push(args[3]);
        return new Promise(() => {});
      }
      return spawnResult({ code: args.includes('open') ? 1 : 0 });
    });
    // A relaunch kills the daemon its pid file names, so a child stands in.
    const daemons: ChildProcess[] = [];
    const daemon = () => {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
      daemons.push(child);
      writeState('wedged', 'pid', child.pid!);
    };
    onTestFinished(() => { for (const child of daemons) child.kill('SIGKILL'); });
    daemon();
    const host = makeHost();
    const capture = async () => {
      void abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'wedged' });
      await vi.waitFor(() => expect(shots.length).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 20));
    };

    await capture();
    await capture();
    expect(shots).toHaveLength(1);

    // A close ends the session those captures were for.
    await ab(host, { op: 'close' }, { session: 'wedged' });
    await capture();
    expect(shots).toHaveLength(2);

    // So does a relaunch, which reuses the session name.
    await ab(host, { op: 'launch', url: 'https://example.com/', headed: false }, { session: 'wedged' });
    daemon();
    await capture();
    expect(shots).toHaveLength(3);

    // Each replacement writes a file the capture it replaced cannot overwrite.
    expect(new Set(shots).size).toBe(3);
    // And no capture can pin the slot: the spawn itself is bounded past the
    // CLI's 25s action timeout.
    for (const call of spawnMock.mock.calls.filter((c) => (c[1] as string[]).includes('screenshot'))) {
      expect(call[2]).toEqual({ timeoutMs: 30_000 });
    }
    await host.close();
  });

  it('answers a capture-directory failure as a result, and retries the next time', async () => {
    // `??=` on the mkdtemp promise would memoize a rejection, so one transient
    // EACCES/ENOSPC on tmpdir would disable screenshots for the whole process.
    const mkdtemp = vi.spyOn(fsp, 'mkdtemp').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    const host = makeHost();

    const failed = await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'retry-sess', binaryPath: '/usr/local/bin/agent-browser' });
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toContain('ENOSPC');
    expect(spawnMock).not.toHaveBeenCalled(); // never spawned without a path

    mkdtemp.mockRestore();
    captureFrames([1]);
    const recovered = await abFile(host, { op: 'screenshot', format: 'jpeg' }, { session: 'retry-sess', binaryPath: '/usr/local/bin/agent-browser' });
    expect(recovered.ok).toBe(true);
    await host.close();
  });

  // `binaryPath` crosses from the webview realm and off the persisted session
  // blob, so an unchecked one is arbitrary local execution in the extension host
  // or the Tauri sidecar. The gate is at the spawn, so it covers attach /
  // open / popOut too — the entry points the subcommand allowlist never saw.
  it('refuses a caller-supplied binary path that is not an agent-browser', async () => {
    enqueueSpawnResults([{}]);
    const host = makeHost();

    await ab(host, { op: 'history', dir: 'reload' }, { session: 'sess', binaryPath: '/usr/bin/curl' });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Fell through to the host's own candidate rather than spawning curl.
    expect(spawnMock.mock.calls[0][0]).toBe('agent-browser');
  });

  it('accepts an absolute path to an agent-browser, including its Windows shims', async () => {
    for (const candidate of ['/opt/homebrew/bin/agent-browser', 'C:\\tools\\agent-browser.cmd']) {
      spawnMock.mockReset();
      enqueueSpawnResults([{}]);
      const host = makeHost();
      await ab(host, { op: 'history', dir: 'reload' }, { session: 'sess', binaryPath: candidate });
      expect(spawnMock.mock.calls[0][0]).toBe(candidate);
    }
  });
});

// `parseBrowserRequest` in browser-host.ts says why every field is checked.
describe('agent-browser host requests', () => {
  useTempSocketDir('dormouse-ab-argv-test-');
  const session = { session: 'dormouse.1.gui-abc' };
  beforeEach(() => { running(session.session); });

  it('renders each operation to exactly one fixed argv', async () => {
    const shapes: [BrowserOp, string[]][] = [
      [{ op: 'navigate', url: 'https://example.com/path?q=1' }, ['open', 'https://example.com/path?q=1']],
      [{ op: 'navigate', url: 'http://localhost:5173/' }, ['open', 'http://localhost:5173/']],
      [{ op: 'history', dir: 'back' }, ['back']],
      [{ op: 'history', dir: 'forward' }, ['forward']],
      [{ op: 'history', dir: 'reload' }, ['reload']],
      [{ op: 'close' }, ['close']],
      [{ op: 'tab', action: 'select', tabId: 't2' }, ['tab', 't2']],
      [{ op: 'tab', action: 'close', tabId: 't2' }, ['tab', 'close', 't2']],
      [{ op: 'viewport', width: 1280, height: 720, dpr: 2 }, ['set', 'viewport', '1280', '720', '2']],
      [{ op: 'viewport', width: 801, height: 599, dpr: 1.100000023841858 }, ['set', 'viewport', '801', '599', '1.100000023841858']],
      [{ op: 'device', name: 'iPhone 16 Pro' }, ['set', 'device', 'iPhone 16 Pro']],
      [{ op: 'device', name: 'iPad (gen 11)' }, ['set', 'device', 'iPad (gen 11)']],
    ];
    const host = makeHost();
    for (const [op, argv] of shapes) {
      spawnMock.mockReset();
      enqueueSpawnResults([{}]);
      expect(await ab(host, op, session)).toEqual({ ok: true });
      expect(spawnMock.mock.calls[0][1]).toEqual(['--session', 'dormouse.1.gui-abc', ...argv]);
    }
    // The CDP endpoint is read from what the CLI prints.
    spawnMock.mockReset();
    enqueueSpawnResults([{ stdout: 'ws://127.0.0.1:9222/devtools/browser/abc\n' }]);
    expect(await ab(host, { op: 'cdpUrl' }, session)).toEqual({ ok: true, url: 'ws://127.0.0.1:9222/devtools/browser/abc' });
    expect(spawnMock.mock.calls[0][1]).toEqual(['--session', 'dormouse.1.gui-abc', 'get', 'cdp-url']);
  });

  it('refuses any other request, including a field carrying options', async () => {
    const refused: unknown[] = [
      { op: 'navigate', url: '--executable-path=/tmp/evil' },
      { op: 'navigate', url: ' https://example.com/' },
      { op: 'navigate', url: 'file:///etc/passwd' },
      { op: 'navigate', url: 'javascript:alert(1)' },
      { op: 'viewport', width: 100, height: 100, dpr: 11 },
      { op: 'viewport', width: 100, height: 100 },
      { op: 'viewport', width: '100', height: 100, dpr: 1 },
      { op: 'history', dir: '--profile' },
      { op: 'tab', action: 'select', tabId: 'new' },
      { op: 'tab', action: 'select', tabId: '--extension' },
      { op: 'tab', action: 'close', tabId: '--args=--disable-web-security' },
      { op: 'tab', action: 'list', tabId: 't2' },
      { op: 'device', name: '--state=/tmp/s.json' },
      { op: 'screenshotTo', path: '/Users/someone/.zshrc' },
      { op: 'eval', script: 'document.cookie' },
      { op: 'constructor' },
      {},
    ];
    const host = makeHost();
    for (const op of refused) {
      const result = await host.request({ provider: 'agent-browser', binding: session, ...(op as object) });
      expect(result.ok, JSON.stringify(op)).toBe(false);
    }
    for (const raw of [null, 'navigate https://example.com/', { provider: 'lynx', binding: session, op: 'close' }]) {
      expect((await host.request(raw)).ok).toBe(false);
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses an option-shaped or path-shaped session on every operation', async () => {
    const host = makeHost();
    const ops: BrowserOp[] = [
      { op: 'close' },
      { op: 'edit', edit: 'copy' },
      { op: 'screenshot' },
      { op: 'attach', url: 'https://example.com/' },
      { op: 'launch', url: 'https://example.com/', headed: true },
      { op: 'launch', url: 'https://example.com/', headed: false },
    ];
    for (const session of ['--executable-path', '-x', '../../tmp/evil', 'a/b', 'a\\b', 'a\nb', '']) {
      for (const op of ops) {
        expect(await ab(host, op, { session })).toEqual({ ok: false, error: 'a valid session name is required' });
        expect((await abFile(host, op, { session })).ok).toBe(false);
      }
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('refuses a new session\'s URL that is not http(s), and relaunches a named one at about:blank instead', async () => {
    const host = makeHost();
    expect(await ab(host, { op: 'launch', url: '--executable-path=/tmp/evil', headed: false })).toEqual({ ok: false, error: 'Browser navigation requires an http(s) URL' });
    expect(await ab(host, { op: 'launch', url: 'file:///etc/passwd', headed: false })).toEqual({ ok: false, error: 'Browser navigation requires an http(s) URL' });
    expect(spawnMock).not.toHaveBeenCalled();

    const calls = mockSpawnByCommand({
      close: () => ({}),
      '--headed open': () => ({ code: 1, stderr: 'boom' }),
    });
    await ab(host, { op: 'launch', url: '--executable-path=/tmp/evil', headed: true }, { session: 'dormouse.1.default' });
    expect(calls).toContainEqual(['--session', 'dormouse.1.default', '--headed', 'open', 'about:blank']);
    expect(calls.flat()).not.toContain('--executable-path=/tmp/evil');
  });
});

describe('agent-browser host edit ops', () => {
  useTempSocketDir('dormouse-ab-edit-test-');
  beforeEach(() => { running('sess'); });

  // `op` is a TypeScript type, not a runtime check — it arrives from webview IPC
  // (`vscode-ext/src/message-router.ts`, `standalone/sidecar/main.js`) with no
  // validation. A plain-object lookup resolves inherited keys, so an `op` naming
  // an `Object.prototype` member selected a script the table never listed and
  // reached the daemon's `eval`, which is exactly what `EDIT_SCRIPTS`'s own
  // comment says cannot happen.
  it('refuses an edit op that is only an inherited property of the script table', async () => {
    const host = makeHost();

    for (const op of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(await ab(host, { op: 'edit', edit: op as never }, { session: 'sess' })).toEqual({
        ok: false,
        error: `unknown edit op '${op}'`,
      });
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('still runs the three ops the table does own', async () => {
    for (const op of ['selectAll', 'copy', 'cut'] as const) {
      spawnMock.mockReset();
      enqueueSpawnResults([{ stdout: JSON.stringify({ success: true, data: { result: 'x' } }) }]);
      const host = makeHost();

      expect((await ab(host, { op: 'edit', edit: op }, { session: 'sess' })).ok).toBe(true);
      // `eval` with the table's script, not a stringified prototype member.
      const args = spawnMock.mock.calls[0][1] as string[];
      expect(args.slice(0, 3)).toEqual(['--session', 'sess', 'eval']);
      expect(typeof args[3]).toBe('string');
      expect(args[3]).toContain('document');
    }
  });
});

