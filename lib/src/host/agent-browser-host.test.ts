import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdtempSync, promises as fsp, statSync, utimesSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { BrowserOp, BrowserRequestBinding } from '../lib/platform/browser-automation';
import { WebSocket, WebSocketServer } from 'ws';
import { createAgentBrowserProvider } from './agent-browser-host';
import { createBrowserCaptures, type BrowserCaptures } from './browser-capture';
import { createBrowserHost } from './browser-host';
import { openViewer } from './browser-host-test-utils';
import { SYNC_SETTLE_MS } from './browser-sync';
import { WINDOW_GONE_GRACE_MS } from './browser-viewer';

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

/** A browser's CDP endpoint on loopback whose pages are `pages` (URL by
 *  target id), beside a service worker, which is none: the targets it was
 *  asked to close, and what `get cdp-url` prints for it. */
async function fakeCdp(pages: Record<string, string>) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  onTestFinished(() => {
    for (const client of server.clients) client.terminate();
    server.close();
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const closed: string[] = [];
  server.on('connection', (ws) => ws.on('message', (data) => {
    const message = JSON.parse(data.toString()) as { id: number; method: string; params?: { targetId?: string } };
    const answer = (result: unknown) => ws.send(JSON.stringify({ id: message.id, result }));
    if (message.method === 'Target.getTargets') {
      answer({ targetInfos: [
        ...Object.entries(pages).map(([targetId, url]) => ({ targetId, type: 'page', url })),
        { targetId: 'sw', type: 'service_worker', url: 'https://example.com/sw.js' },
      ] });
    } else if (message.method === 'Target.closeTarget') {
      closed.push(message.params!.targetId!);
      answer({ success: true });
    } else answer({});
  }));
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/devtools/browser/fake`;
  return { closed, printed: { stdout: `${url}\n` } };
}

// A port something accepts on, standing in for a daemon's stream server.
let acceptingPort = 0;
let acceptingServer: Server | undefined;
beforeAll(async () => { ({ port: acceptingPort, server: acceptingServer } = await listen()); });
afterAll(async () => { if (acceptingServer) await closeServer(acceptingServer); });

/** Give each session a daemon its state files prove live: a pid file naming
 *  this test process, beside a stream port that accepts (the host drives no
 *  other). A test that dials the stream writes its own port afterwards. */
function running(...sessions: string[]): void {
  for (const session of sessions) {
    writeState(session, 'pid', process.pid);
    writeState(session, 'stream', acceptingPort);
  }
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

  it('closes the blank and new-tab pages a launch leaves beside its page, over the browser\'s CDP', async () => {
    // `tab list` names neither the `chrome://newtab/` page nor any page but
    // agent-browser's own. No pid file here (an older CLI): the port comes
    // from `stream status` once `open` has returned, and the sweep runs after.
    const cdp = await fakeCdp({ blank: 'about:blank', newtab: 'chrome://newtab/', real: 'https://example.com/' });
    enqueueSpawnResults([
      {}, // close
      {}, // --headed open
      { stdout: JSON.stringify({ port: 61218 }) },
      cdp.printed, // get cdp-url, to list the pages
      cdp.printed, // … to close one
      cdp.printed, // … and the other
    ]);

    const host = makeHost();
    const result = await ab(host, { op: 'launch', url: 'https://example.com/', headed: true }, { session: 'dormouse.1.default', binaryPath: '/usr/local/bin/agent-browser' });

    expect(result).toEqual({
      ok: true, stream: 61218, headed: true, session: 'dormouse.1.default', nativeIdentity: 'dormouse.1.default', binaryPath: '/usr/local/bin/agent-browser',
    });
    // Last first.
    await vi.waitFor(() => expect(cdp.closed).toEqual(['newtab', 'blank']));
  });

  it('pop-out returns the relaunched daemon\'s port while `open` is still waiting on the page', async () => {
    // The killed daemon leaves its state files behind: a dead pid and a port
    // nothing listens on. The relaunch must not read those as the new daemon.
    const session = 'dormouse.1.default';
    const stale = await closedPort();
    writeState(session, 'pid', DEAD_PID);
    writeState(session, 'stream', stale);
    const opened = deferred<SpawnResult>();
    const cdp = await fakeCdp({ blank: 'about:blank', real: 'https://example.com/' });
    const calls = mockSpawnByCommand({
      close: () => ({}),
      '--headed open': () => opened.promise,
      get: () => cdp.printed,
    });
    const host = makeHost();
    const popOut = ab(host, { op: 'launch', url: 'https://example.com/', headed: true }, { session: session });

    // While the stale files are all there is, the launch waits.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls.some((args) => args.includes('cdp-url'))).toBe(false);
    // The new daemon comes up: a fresh pid and a port that accepts connections.
    const { port, server } = await listen();
    try {
      writeState(session, 'pid', DEAD_PID + 1);
      writeState(session, 'stream', port);
      expect(await popOut).toEqual({ ok: true, stream: port, headed: true, session, nativeIdentity: session });
      // `open` has not returned, so no daemon command (the blank-tab sweep) has
      // been queued behind it.
      expect(calls.some((args) => args.includes('cdp-url'))).toBe(false);
      expect(calls.some((args) => args.includes('stream'))).toBe(false);

      opened.resolve({ code: 1, stderr: 'Operation timed out. The page may still be loading' });
      await vi.waitFor(() => expect(cdp.closed).toEqual(['blank']));
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
      expect(await popOut).toEqual({ ok: true, stream: port, headed: true, session, nativeIdentity: session });

      // The second relaunch invalidates the first one's post-open tail before
      // its close queues behind that still-pending `open` command.
      void ab(host, { op: 'launch', url: 'https://example.com/', headed: false }, { session: session });
      await vi.waitFor(() => expect(closeCount).toBe(2));
      firstOpened.resolve({ code: 1, stderr: 'Operation timed out' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls.some((args) => args.includes('cdp-url'))).toBe(false);
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
      expect(await popOut).toEqual({ ok: true, stream: port, headed: true, session, nativeIdentity: session });

      // Pane kill/render-swap enters command('close') and invalidates the
      // relaunch tail synchronously, before the close queues behind open.
      void ab(host, { op: 'close' }, { session: session });
      await vi.waitFor(() => expect(closeCount).toBe(2));
      opened.resolve({ code: 1, stderr: 'Operation timed out' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls.some((args) => args.includes('cdp-url'))).toBe(false);
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
      expect(await popOut).toEqual({ ok: true, stream: port, headed: true, session, nativeIdentity: session });

      await host.close();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(closeCount).toBe(2);
      expect(calls.some((args) => args.includes('cdp-url'))).toBe(false);
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
      ok: true, session: expect.stringMatching(/^dormouse\.1\.gui-/), nativeIdentity: session, stream: 61219, headed: false,
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
      expect(await ab(makeHost(), { op: 'launch', url: page, headed: false }, { session })).toMatchObject({ ok: true, stream: port, headed: false });
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
      expect(await ab(host, { op: 'attach', url: 'https://example.com/' }, { session })).toEqual({ ok: true, stream: port, session, nativeIdentity: session });
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
  // The proof is the one a stop needs before it signals a pid.
  it('runs no operation on a session whose state files do not prove its daemon live', async () => {
    const host = makeHost();
    const ops: BrowserOp[] = [
      { op: 'navigate', url: 'https://example.com/' },
      { op: 'history', dir: 'back' },
      { op: 'tab', action: 'select', tabId: 't1' },
      { op: 'viewport', width: 800, height: 600, dpr: 2 },
      { op: 'device', name: 'iPhone 16' },
      { op: 'edit', edit: 'copy' },
    ];
    const provider = createAgentBrowserProvider();
    const cases: [string, () => Promise<void>][] = [
      ['no state files', async () => {}],
      ['a dead pid', async () => writeState(session, 'pid', DEAD_PID)],
      ['a live pid with no stream that accepts', async () => {
        writeState(session, 'pid', process.pid);
        writeState(session, 'stream', await closedPort());
      }],
      ['a live pid and stream from before this boot', async () => {
        running(session);
        for (const ext of ['pid', 'stream']) utimesSync(join(process.env.AGENT_BROWSER_SOCKET_DIR!, `${session}.${ext}`), 0, 0);
      }],
    ];
    for (const [name, arrange] of cases) {
      await arrange();
      for (const op of ops) {
        expect(await ab(host, op, { session }), `${name}: ${JSON.stringify(op)}`).toEqual({ ok: false, error: `agent-browser session '${session}' is not running` });
      }
      // Nor a capture for a viewer socket.
      await expect(provider.screenshot({ session }, async () => '/nonexistent/shot.jpg'), name).rejects.toThrow('is not running');
    }
    expect(spawnMock).not.toHaveBeenCalled();
    // Proven live, the same operation runs.
    running(session);
    enqueueSpawnResults([{}]);
    expect(await ab(host, ops[1], { session })).toEqual({ ok: true });
  });

  it('relaunches a gone daemon at the page named, headed for a pop-out, and tracks that window for shutdown', async () => {
    writeState(session, 'pid', DEAD_PID);
    writeState(session, 'stream', await closedPort());
    const { port, server } = await listen();
    const opened = deferred<SpawnResult>();
    const cdp = await fakeCdp({ real: 'https://example.com/' });
    const calls = mockSpawnByCommand({
      '--headed open': () => {
        // This test process stands in for the relaunched daemon.
        writeState(session, 'pid', process.pid);
        writeState(session, 'stream', port);
        return opened.promise;
      },
      get: () => cdp.printed,
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
      expect(first).toEqual({ ok: true, stream: port, relaunched: true, session, nativeIdentity: session });
      expect(second).toEqual({ ok: true, stream: port, session, nativeIdentity: session });
      expect(calls).toEqual([
        ['--session', session, 'close'],
        ['--session', session, '--headed', 'open', 'https://example.com/'],
      ]);
      // Once `open` returns, the sweep finds no stray blank tab to close.
      opened.resolve({});
      await vi.waitFor(() => expect(calls).toContainEqual(['--session', session, 'get', 'cdp-url']));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(cdp.closed).toEqual([]);
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
        ok: true, session: 'dormouse.1.tool.a', nativeIdentity: 'dormouse.1.tool.a', stream: port, headed: false,
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

describe('agent-browser host viewer', () => {
  const session = 'dormouse.1.default';
  useTempSocketDir('dormouse-ab-view-test-');
  const hosts: Host[] = [];
  const servers: WebSocketServer[] = [];
  afterEach(async () => {
    await Promise.all(hosts.splice(0).map((host) => host.close()));
    for (const server of servers.splice(0)) {
      for (const client of server.clients) client.terminate();
      server.close();
    }
  });

  /** A loopback WebSocket server standing in for the daemon's stream, or for
   *  its browser's CDP endpoint. */
  async function fakeServer(onMessage: (message: Record<string, unknown>, client: WebSocket) => void = () => {}) {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    const received: Record<string, unknown>[] = [];
    let client: WebSocket | undefined;
    server.on('connection', (ws) => {
      client = ws;
      ws.on('message', (data) => {
        const message = JSON.parse(data.toString());
        received.push(message);
        onMessage(message, ws);
      });
    });
    return {
      port: (server.address() as { port: number }).port,
      received,
      connected: () => vi.waitFor(() => expect(client).toBeDefined()).then(() => client!),
      send: (message: unknown) => client!.send(typeof message === 'string' ? message : JSON.stringify(message)),
    };
  }

  /** The host's viewer socket onto a daemon streaming on `port`. */
  async function view(port: number, headed = false) {
    const host = makeHost();
    hosts.push(host);
    const { url } = await ab(host, { op: 'view', stream: port, ...(headed ? { headed } : {}) }, { session });
    return openViewer(url!);
  }

  // A frame's base64 body, large enough to be told from a control message by size.
  const frame = (fill: number, deviceWidth = 800) => ({ type: 'frame', data: Buffer.alloc(13_000, fill).toString('base64'), metadata: { deviceWidth, deviceHeight: 600 } });

  it('relays the daemon stream, dropping its unchanged re-broadcasts and decoding each changed frame once', async () => {
    running(session);
    const daemon = await fakeServer();
    writeState(session, 'stream', daemon.port);
    spawnMock.mockImplementation(async (_binary: string, args: string[]) => {
      if (args.includes('screenshot')) writeFileSync(args[3], Uint8Array.from([0xff, 0xd8, 0x99]));
      return spawnResult({});
    });
    const viewer = await view(daemon.port);
    await daemon.connected();
    const tabs = { type: 'tabs', tabs: [{ tabId: 't1', url: 'https://example.com/', title: 'Example', active: true }] };
    daemon.send({ type: 'status', connected: true, screencasting: true, viewportWidth: 800, viewportHeight: 600 });
    daemon.send(tabs);
    daemon.send(tabs);
    // Input opens the window in which every changed frame paints at once.
    viewer.send({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1 });
    await vi.waitFor(() => expect(daemon.received).toHaveLength(1));
    daemon.send(frame(1));
    daemon.send(frame(1));
    daemon.send(frame(2, 900));
    // A frame small enough to pass for a control message is deduplicated too.
    const small = { type: 'frame', data: Buffer.alloc(100, 3).toString('base64'), metadata: { deviceWidth: 900, deviceHeight: 600 } };
    daemon.send(small);
    daemon.send(small);
    // A commit edge is never deduplicated: a reload commits the same URL.
    daemon.send({ type: 'url', url: 'https://example.com/' });
    daemon.send({ type: 'url', url: 'https://example.com/' });
    await vi.waitFor(() => expect(viewer.states).toHaveLength(4));
    expect(viewer.states).toEqual([
      { type: 'status', connected: true, screencasting: true, viewportWidth: 800, viewportHeight: 600 },
      { ...tabs, tabs: [{ ...tabs.tabs[0] }] },
      { type: 'url', url: 'https://example.com/' },
      { type: 'url', url: 'https://example.com/' },
    ]);
    await vi.waitFor(() => expect(viewer.frames.filter((f) => f.kind === 'crisp').length).toBeGreaterThan(0));
    const provisional = viewer.frames.filter((f) => f.kind === 'provisional');
    expect(provisional.map((f) => [f.jpeg[0], f.jpeg.byteLength, f.size?.width])).toEqual([[1, 13_000, 800], [2, 13_000, 900], [3, 100, 900]]);
    expect([...viewer.frames.find((f) => f.kind === 'crisp')!.jpeg]).toEqual([0xff, 0xd8, 0x99]);
  });

  it.each([false, true])('routes a tab list or URL too large to tell from a frame by size as state (headed: %s)', async (headed) => {
    running(session);
    const daemon = await fakeServer();
    writeState(session, 'stream', daemon.port);
    const viewer = await view(daemon.port, headed);
    await daemon.connected();
    const tabs = Array.from({ length: 80 }, (_, i) => ({
      tabId: `t${i}`,
      title: `Tab number ${i} — ${'x'.repeat(40)}`,
      url: `https://example.com/very/long/path/segment/${i}?q=${'y'.repeat(120)}`,
      active: i === 0,
    }));
    const url = `https://example.com/?q=${'x'.repeat(20_000)}`;
    for (const message of [{ type: 'tabs', tabs }, { type: 'url', url, timestamp: 1 }]) {
      expect(JSON.stringify(message).length).toBeGreaterThan(16_384);
      daemon.send(message);
    }
    await vi.waitFor(() => expect(viewer.states).toHaveLength(2));
    expect(viewer.states).toEqual([{ type: 'tabs', tabs }, { type: 'url', url }]);
    expect(viewer.frames).toEqual([]);
  });

  it('judges sync-to-pane by the daemon\'s changed frames, never its status', async () => {
    running(session);
    const daemon = await fakeServer();
    writeState(session, 'stream', daemon.port);
    spawnMock.mockImplementation(async () => spawnResult({}));
    const viewer = await view(daemon.port);
    await daemon.connected();
    const reports = () => viewer.states.filter((state) => state.type === 'sync').map((state) => state.state);
    viewer.send({ type: 'sync', width: 900, height: 600, dpr: 2, engagement: 'e1' });
    await vi.waitFor(() => expect(spawnMock.mock.calls.map(([, args]) => args.slice(2).join(' '))).toContain('set viewport 900 600 2'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    daemon.send(frame(1, 900));
    await vi.waitFor(() => expect(reports().at(-1)).toBe('synced'));
    // The daemon's status names a viewport too: never judged.
    daemon.send({ type: 'status', connected: true, screencasting: true, viewportWidth: 1280, viewportHeight: 720 });
    await new Promise((resolve) => setTimeout(resolve, SYNC_SETTLE_MS + 100));
    expect(reports().at(-1)).toBe('synced');
    // An agent's `set viewport`, as the daemon's frames show it.
    daemon.send(frame(2, 1024));
    await vi.waitFor(() => expect(reports().at(-1)).toBe('off'));
  });

  it('sends the daemon only validated input, a paste as a key pair per character', async () => {
    running(session);
    const daemon = await fakeServer();
    writeState(session, 'stream', daemon.port);
    const viewer = await view(daemon.port);
    await daemon.connected();
    viewer.send({ type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, modifiers: 0, commands: ['selectAll'] });
    viewer.send({ type: 'input_text', text: 'x\n' });
    viewer.send({ type: 'navigate', url: 'file:///etc/passwd' });
    await vi.waitFor(() => expect(daemon.received).toHaveLength(5));
    expect(daemon.received).toEqual([
      { type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, modifiers: 0 },
      { type: 'input_keyboard', eventType: 'keyDown', key: 'x', code: '', text: 'x', windowsVirtualKeyCode: 0, modifiers: 0 },
      { type: 'input_keyboard', eventType: 'keyUp', key: 'x', code: '', text: '', windowsVirtualKeyCode: 0, modifiers: 0 },
      { type: 'input_keyboard', eventType: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, modifiers: 0 },
      { type: 'input_keyboard', eventType: 'keyUp', key: 'Enter', code: 'Enter', text: '', windowsVirtualKeyCode: 13, modifiers: 0 },
    ]);
  });

  it('tells the viewer when the daemon goes away, and ends a viewer of a port nothing streams on', async () => {
    running(session);
    const daemon = await fakeServer();
    writeState(session, 'stream', daemon.port);
    const viewer = await view(daemon.port);
    (await daemon.connected()).terminate();
    expect(await viewer.closed).toBe(1000);
    expect(viewer.states).toEqual([{ type: 'status', connected: false, screencasting: false }]);

    const nowhere = await view(await closedPort());
    expect(await nowhere.closed).toBe(1011);
    expect(nowhere.states).toEqual([]);
    // Nor anything but a TCP port.
    const offRange = await view(70_000);
    expect(await offRange.closed).toBe(1011);
  });

  // `dor ab` hands over the port it read under its own environment; under
  // the caller's own AGENT_BROWSER_SOCKET_DIR the host's state files know
  // nothing of it, or name another daemon of the same session.
  it.each([
    ['in a socket directory it does not share', false],
    ['beside a daemon of the same session name in its own', true],
  ])('watches a daemon it cannot prove live %s: every changed frame, and no capture', async (_name, sameName) => {
    if (sameName) running(session);
    const daemon = await fakeServer();
    const viewer = await view(daemon.port);
    await daemon.connected();
    for (let fill = 1; fill <= 3; fill++) daemon.send(frame(fill));
    await vi.waitFor(() => expect(viewer.frames).toHaveLength(3));
    expect(viewer.frames.map((f) => `${f.kind} ${f.jpeg[0]}`)).toEqual(['provisional 1', 'provisional 2', 'provisional 3']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawnMock).not.toHaveBeenCalled();
  });

  /** How one page of a fake browser answers the host's measure. */
  type FakePage = { visibilityState: 'visible' | 'hidden'; innerWidth: number; innerHeight: number; devicePixelRatio: number };
  const shownPage = (innerWidth = 1200): FakePage => ({ visibilityState: 'visible', innerWidth, innerHeight: 736, devicePixelRatio: 2 });

  /** A browser's CDP endpoint whose window shows `pages` (target ids), each
   *  running the host's measure against `pageState(id)` — hidden unless
   *  given; a DevTools window and a service worker beside them, which are
   *  not the window's. */
  async function fakeBrowser(pages: string[], pageState: (id: string) => FakePage | undefined = () => undefined) {
    return fakeServer((message, client) => {
      const params = message.params as { targetId?: string; expression?: string } | undefined;
      const answer = (result: unknown) => client.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'Target.getTargets') {
        answer({ targetInfos: [
          ...pages.map((id) => ({ targetId: id, type: 'page', url: `https://${id}.example/`, title: id })),
          { targetId: 'tools', type: 'page', url: 'devtools://devtools/bundled/devtools_app.html', title: 'DevTools' },
          { targetId: 'sw', type: 'service_worker', url: 'https://one.example/sw.js' },
        ] });
      } else if (message.method === 'Target.attachToTarget') answer({ sessionId: `session-${params?.targetId}` });
      else if (message.method === 'Runtime.evaluate') {
        // The host's own expression, as the page would run it.
        const { visibilityState, ...globals } = pageState((message.sessionId as string).replace('session-', '')) ?? { ...shownPage(), visibilityState: 'hidden' };
        const run = new Function('document', ...Object.keys(globals), `return (${params!.expression});`);
        answer({ result: { value: run({ visibilityState }, ...Object.values(globals)) } });
      } else answer({});
    });
  }

  /** A headed viewer on a daemon whose browser's CDP is `cdp`. */
  async function headedView(cdp: Awaited<ReturnType<typeof fakeServer>>) {
    running(session);
    const daemon = await fakeServer();
    writeState(session, 'stream', daemon.port);
    enqueueSpawnResults([{ stdout: `ws://127.0.0.1:${cdp.port}/devtools/browser/abc\n` }]);
    const viewer = await view(daemon.port, true);
    await daemon.connected();
    await cdp.connected();
    return { viewer, daemon };
  }

  const cdpVerbs = () => spawnMock.mock.calls.map((call) => [(call[1] as string[]).slice(2), call[2]]);

  it('follows a headed window\'s page over its browser\'s CDP, and sends it no frames', async () => {
    const cdp = await fakeBrowser(['one']);
    const { viewer, daemon } = await headedView(cdp);
    await vi.waitFor(() => expect(cdp.received.map((m) => m.method).slice(0, 3)).toEqual(['Target.setDiscoverTargets', 'Target.getTargets', 'Page.enable']));
    cdp.send({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'one', type: 'page', url: 'https://two.example/', title: 'Two' } } });
    cdp.send({ method: 'Page.frameNavigated', params: { frame: { parentId: 'p', url: 'https://ad.example/' } } });
    daemon.send(frame(1));
    await vi.waitFor(() => expect(viewer.states).toHaveLength(2));
    expect(viewer.states).toEqual([
      { type: 'page', url: 'https://one.example/', title: 'one' },
      { type: 'page', url: 'https://two.example/', title: 'Two' },
    ]);
    expect(viewer.frames).toEqual([]);
    // Bounded like every call a viewer makes.
    expect(cdpVerbs()).toEqual([[['get', 'cdp-url'], { timeoutMs: 10_000 }]]);
  });

  it('reports a headed window gone once its browser has no page but DevTools, asking the browser nothing', async () => {
    const cdp = await fakeBrowser(['one', 'two']);
    const { viewer, daemon } = await headedView(cdp);
    daemon.send({ type: 'status', connected: true, screencasting: false });
    await vi.waitFor(() => expect(viewer.states.map((state) => state.type)).toContain('status'));
    // The user closes the window: its browser runs on, and its stream says nothing.
    cdp.send({ method: 'Target.targetDestroyed', params: { targetId: 'one' } });
    cdp.send({ method: 'Target.targetDestroyed', params: { targetId: 'two' } });
    expect(await viewer.closed).toBe(1000);
    expect(viewer.states.at(-1)).toEqual({ type: 'status', connected: false, screencasting: false });
    // Any CLI verb would open a blank window in it.
    expect(cdpVerbs()).toEqual([[['get', 'cdp-url'], { timeoutMs: 10_000 }]]);
  });

  it('never reads a tab closed and replaced as the window closing', async () => {
    const cdp = await fakeBrowser(['one']);
    const { viewer } = await headedView(cdp);
    await vi.waitFor(() => expect(viewer.states).toHaveLength(1));
    cdp.send({ method: 'Target.targetDestroyed', params: { targetId: 'one' } });
    cdp.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'two', type: 'page', url: 'chrome://newtab/', title: 'New Tab' } } });
    await new Promise((resolve) => setTimeout(resolve, 2 * WINDOW_GONE_GRACE_MS));
    expect(viewer.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('reports gone a window that closed before its observer came', async () => {
    const { viewer } = await headedView(await fakeBrowser([]));
    expect(await viewer.closed).toBe(1000);
  });

  it('carries a headed window\'s own viewport and ratio in its status, measured on the page it shows', async () => {
    let shown = shownPage(1200);
    const cdp = await fakeBrowser(['background', 'shown', 'popup'], (id) => (id === 'shown' ? shown : id === 'popup' ? shownPage(400) : undefined));
    const { viewer, daemon } = await headedView(cdp);
    // The daemon's configured viewport, which the window does not follow.
    daemon.send({ type: 'status', connected: true, screencasting: false, viewportWidth: 1280, viewportHeight: 720 });
    await vi.waitFor(() => expect(viewer.states.filter((state) => state.type === 'status')).toContainEqual(
      { type: 'status', connected: true, screencasting: false, viewportWidth: 1200, viewportHeight: 736, devicePixelRatio: 2 },
    ));
    // The user resizes the window.
    shown = shownPage(900);
    await vi.waitFor(() => expect(viewer.states.at(-1)).toEqual(
      { type: 'status', connected: true, screencasting: false, viewportWidth: 900, viewportHeight: 736, devicePixelRatio: 2 },
    ), { timeout: 3000 });
    // Measured on the first page shown, and none past it.
    expect(cdp.received.filter((m) => m.method === 'Runtime.evaluate').map((m) => m.sessionId)).not.toContain('session-popup');
  });

  it('asks a daemon for its browser\'s CDP endpoint once, however often its window is viewed', async () => {
    const cdp = await fakeBrowser(['one']);
    running(session);
    const daemon = await fakeServer();
    writeState(session, 'stream', daemon.port);
    enqueueSpawnResults([{ stdout: `ws://127.0.0.1:${cdp.port}/devtools/browser/abc\n` }]);
    const host = makeHost();
    hosts.push(host);
    for (let i = 0; i < 2; i++) {
      const { url } = await ab(host, { op: 'view', stream: daemon.port, headed: true }, { session });
      const viewer = await openViewer(url!);
      await vi.waitFor(() => expect(viewer.states).toContainEqual({ type: 'page', url: 'https://one.example/', title: 'one' }));
      viewer.socket.close();
    }
    expect(cdpVerbs()).toEqual([[['get', 'cdp-url'], { timeoutMs: 10_000 }]]);
  });

  it('ends a viewer whose stream accepts but never answers the upgrade, closing its connection', async () => {
    const { port, server } = await listen();
    const hung: Promise<void>[] = [];
    // Read, so the host's end of the connection reaches this end.
    server.on('connection', (tcp) => { tcp.resume(); hung.push(new Promise((resolve) => tcp.once('close', () => resolve()))); });
    try {
      const viewer = await view(port);
      expect(await viewer.closed).toBe(1011);
      await vi.waitFor(() => expect(hung).toHaveLength(1));
      await hung[0];
    } finally {
      await closeServer(server);
    }
  }, 10_000);

  it('dials no CDP endpoint off loopback', async () => {
    running(session);
    const daemon = await fakeServer();
    writeState(session, 'stream', daemon.port);
    enqueueSpawnResults([{ stdout: 'ws://10.0.0.1:9222/devtools/browser/abc\n' }]);
    const log = vi.fn();
    const host = createBrowserHost({ writeClipboardText: vi.fn(), providers: { 'agent-browser': () => createAgentBrowserProvider({ log }) } });
    hosts.push(host);
    const { url } = await ab(host, { op: 'view', stream: daemon.port, headed: true }, { session });
    await openViewer(url!);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[agent-browser] refused a CDP endpoint off loopback: ws://10.0.0.1:9222/devtools/browser/abc'));
  });
});

describe('agent-browser host captures', () => {
  useTempSocketDir('dormouse-ab-shot-test-');
  const b = { session: 'dormouse.1.default', binaryPath: '/usr/local/bin/agent-browser' };
  beforeEach(() => { running(b.session); });
  // Stand in for agent-browser writing the frame where it is told, once
  // `release` lets it: each capture writes the next byte.
  function writesFrames() {
    let shots = 0;
    let gate: Promise<void> | null = null;
    let open = () => {};
    spawnMock.mockImplementation(async (_binary: string, args: string[]) => {
      await gate;
      writeFileSync(args[3], Uint8Array.from([0xff, 0xd8, ++shots]));
      return spawnResult({});
    });
    return {
      hold: () => { gate = new Promise((resolve) => { open = resolve; }); },
      release: () => { gate = null; open(); },
    };
  }
  const take = (captures: BrowserCaptures, provider = createAgentBrowserProvider()) => captures.take(b.session, (file) => provider.screenshot(b, file));

  // The frame is a picture of the user's authenticated browser, written by an
  // external process under the ambient umask. A derivable path straight in
  // os.tmpdir() let any other local account read every frame, or pre-create the
  // name as a symlink and have agent-browser clobber the target.
  it('captures into a fresh private, unguessable file per capture, read back and deleted, bounded', async () => {
    writesFrames();
    const captures = createBrowserCaptures();
    expect([...await take(captures)]).toEqual([0xff, 0xd8, 1]);
    const [binary, args, options] = spawnMock.mock.calls[0] as [string, string[], unknown];
    const file = args[3];
    expect(binary).toBe(b.binaryPath);
    expect(args).toEqual(['--session', b.session, 'screenshot', file, '--screenshot-format', 'jpeg', '--screenshot-quality', '85']);
    // Past the CLI's 25s action timeout, so a wedged capture cannot pin its slot.
    expect(options).toEqual({ timeoutMs: 30_000 });
    expect(file).not.toContain(b.session);
    expect(existsSync(file)).toBe(false);
    const dir = dirname(file);
    expect(dir).not.toBe(tmpdir());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // Never a name another capture wrote, and nothing left behind.
    expect([...await take(captures)]).toEqual([0xff, 0xd8, 2]);
    expect((spawnMock.mock.calls[1][1] as string[])[3]).not.toBe(file);
    expect(await fsp.readdir(dir)).toEqual([]);
    // No frame of the user's browser outlives the host that took it.
    await captures.remove();
    expect(existsSync(dir)).toBe(false);
  });

  it('deletes the frame of a capture that failed or was killed after writing it', async () => {
    let file = '';
    spawnMock.mockImplementation(async (_binary: string, args: string[]) => {
      file = args[3];
      writeFileSync(file, Uint8Array.from([0xff, 0xd8]));
      return { ok: false, error: { code: 'ETIMEDOUT', message: 'screenshot timed out' } };
    });
    const captures = createBrowserCaptures();
    await expect(take(captures)).rejects.toThrow('timed out');
    expect(file).not.toBe('');
    expect(existsSync(file)).toBe(false);
    await captures.remove();
  });

  it('joins a capture of the browser already running, and none it was told to forget', async () => {
    const frames = writesFrames();
    const captures = createBrowserCaptures();
    frames.hold();
    const joined = [take(captures), take(captures)];
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    // Its browser closed or relaunched: the next capture is a fresh one, in a
    // file the running one cannot overwrite.
    captures.forget(b.session);
    const fresh = take(captures);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    frames.release();
    const [first, second] = await Promise.all(joined);
    expect(second).toBe(first);
    expect(await fresh).not.toBe(first);
    expect((spawnMock.mock.calls[1][1] as string[])[3]).not.toBe((spawnMock.mock.calls[0][1] as string[])[3]);
    await captures.remove();
  });

  it('fails a capture whose directory it could not create, and retries it the next time', async () => {
    // `??=` on the mkdtemp promise would memoize a rejection, so one transient
    // EACCES/ENOSPC on tmpdir would disable screenshots for the whole process.
    const mkdtemp = vi.spyOn(fsp, 'mkdtemp').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    writesFrames();
    const captures = createBrowserCaptures();
    await expect(take(captures)).rejects.toThrow('ENOSPC');
    expect(spawnMock).not.toHaveBeenCalled(); // never spawned without a path
    mkdtemp.mockRestore();
    expect([...await take(captures)]).toEqual([0xff, 0xd8, 1]);
    await captures.remove();
  });

});

describe('agent-browser host binary', () => {
  useTempSocketDir('dormouse-ab-binary-test-');
  beforeEach(() => { running('sess'); });

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
      // The webview holds no CDP, captures nothing itself, and names no port to dial but a stream's.
      { op: 'cdpUrl' },
      { op: 'screenshot' },
      { op: 'streamUrl', port: 9222 },
      { op: 'view', stream: -1 },
      { op: 'view', stream: 1.5 },
      { op: 'view' },
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
      { op: 'view', stream: 4321 },
      { op: 'attach', url: 'https://example.com/' },
      { op: 'launch', url: 'https://example.com/', headed: true },
      { op: 'launch', url: 'https://example.com/', headed: false },
    ];
    for (const session of ['--executable-path', '-x', '../../tmp/evil', 'a/b', 'a\\b', 'a\nb', '']) {
      for (const op of ops) {
        expect(await ab(host, op, { session })).toEqual({ ok: false, error: 'a valid session name is required' });
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

