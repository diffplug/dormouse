import { existsSync, mkdtempSync, promises as fsp, statSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'net';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentBrowserHost } from './agent-browser-host';

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

/** A port nothing listens on: bind, read it, release it. */
async function closedPort(): Promise<number> {
  const { port, server } = await listen();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function writeState(session: string, ext: 'pid' | 'stream', value: number): void {
  writeFileSync(join(process.env.AGENT_BROWSER_SOCKET_DIR!, `${session}.${ext}`), `${value}\n`);
}

// The host spawns through dor-lib-common's spawnAndCapture; mock just that
// boundary (not its internal cross-spawn — spawnAndCapture's own behavior is
// covered by dor-lib-common's tests), keeping the package's other real exports
// (e.g. parseStreamPort).
vi.mock('dor-lib-common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('dor-lib-common')>()),
  spawnAndCapture: spawnMock,
}));

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
  const originalSocketDir = process.env.AGENT_BROWSER_SOCKET_DIR;

  beforeEach(() => {
    spawnMock.mockReset();
    process.env.AGENT_BROWSER_SOCKET_DIR = mkdtempSync(join(tmpdir(), 'dormouse-ab-host-test-'));
  });

  afterEach(() => {
    if (originalSocketDir === undefined) delete process.env.AGENT_BROWSER_SOCKET_DIR;
    else process.env.AGENT_BROWSER_SOCKET_DIR = originalSocketDir;
  });

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

    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const result = await host.popOut('dormouse.1.default', { url: 'https://example.com/' }, '/usr/local/bin/agent-browser');

    expect(result).toEqual({ ok: true, wsPort: 61218 });
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
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const popOut = host.popOut(session, { url: 'https://example.com/' });

    // While the stale files are all there is, the launch waits.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(calls.some((args) => args.includes('tab'))).toBe(false);
    // The new daemon comes up: a fresh pid and a port that accepts connections.
    const { port, server } = await listen();
    try {
      writeState(session, 'pid', DEAD_PID + 1);
      writeState(session, 'stream', port);
      expect(await popOut).toEqual({ ok: true, wsPort: port });
      // `open` has not returned, so no daemon command (the blank-tab sweep) has
      // been queued behind it.
      expect(calls.some((args) => args.includes('tab'))).toBe(false);
      expect(calls.some((args) => args.includes('stream'))).toBe(false);

      opened.resolve({ code: 1, stderr: 'Operation timed out. The page may still be loading' });
      await vi.waitFor(() => {
        expect(calls).toContainEqual(['--session', session, 'tab', 'close', 'blank']);
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const popOut = host.popOut(session, { url: 'https://example.com/' });
    await vi.waitFor(() => expect(calls.some((args) => args.includes('--headed'))).toBe(true));
    const { port, server } = await listen();
    try {
      writeState(session, 'pid', DEAD_PID + 1);
      writeState(session, 'stream', port);
      expect(await popOut).toEqual({ ok: true, wsPort: port });

      // The second relaunch invalidates the first one's post-open tail before
      // its close queues behind that still-pending `open` command.
      void host.popIn(session, { url: 'https://example.com/' });
      await vi.waitFor(() => expect(closeCount).toBe(2));
      firstOpened.resolve({ code: 1, stderr: 'Operation timed out' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(calls.some((args) => args.includes('tab'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('open() treats a timed-out page load as a live launch, and a launch with no daemon as a failure', async () => {
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
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
    expect(await host.open('https://slow.example/', {})).toEqual({ ok: true, session: expect.stringMatching(/^dormouse\.1\.gui-/), wsPort: 61219 });

    // Failed with no daemon at all: fail, and close so nothing half-launched
    // outlives the swap.
    const calls = mockSpawnByCommand({
      open: () => ({ code: 1, stderr: 'boom' }),
      close: () => ({}),
    });
    expect(await host.open('https://slow.example/', {})).toEqual({ ok: false, error: 'boom' });
    expect(calls.some((args) => args[2] === 'close')).toBe(true);
    expect(calls.some((args) => args[2] === 'stream')).toBe(false);
  });

  it('reports a zero-exit launch that publishes no stream port without claiming it exited unsuccessfully', async () => {
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    mockSpawnByCommand({
      open: () => ({}),
      stream: () => ({ stdout: '{}' }),
      close: () => ({}),
    });
    expect(await host.open('https://example.com/', {})).toEqual({
      ok: false,
      error: 'open published no stream port',
    });

    mockSpawnByCommand({
      close: () => ({}),
      '--headed open': () => ({}),
      stream: () => ({ stdout: '{}' }),
    });
    expect(await host.popOut('dormouse.1.default', { url: 'https://example.com/' })).toEqual({
      ok: false,
      error: 'popOut open published no stream port',
    });
  });
});

describe('agent-browser host screenshot transport', () => {
  // Block body (not `() => spawnMock.mockReset()`): an arrow returning the mock
  // makes vitest register it as a teardown hook and call it — a phantom spawn.
  beforeEach(() => { spawnMock.mockReset(); });

  it('screenshotToFile returns the path + mime without reading the bytes', async () => {
    // Only the CLI spawn happens — no file is written by the mock.
    enqueueSpawnResults([{}]); // screenshot exits 0

    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const result = await host.screenshotToFile('shotfile', { format: 'jpeg', quality: 85 }, '/usr/local/bin/agent-browser');

    expect(result.ok).toBe(true);
    const shotPath = result.ok ? result.path : '';
    expect(result).toEqual({ ok: true, path: shotPath, mime: 'image/jpeg' });
    // The capture never touched the filesystem: the path points at a file that
    // does not exist (the mock spawned nothing that would create it).
    expect(existsSync(shotPath)).toBe(false);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('/usr/local/bin/agent-browser', [
      '--session', 'shotfile', 'screenshot', shotPath,
      '--screenshot-format', 'jpeg', '--screenshot-quality', '85',
    ]);
  });

  // The frame is a picture of the user's authenticated browser, written by an
  // external process under the ambient umask. A derivable path straight in
  // os.tmpdir() let any other local account read every frame, or pre-create the
  // name as a symlink and have agent-browser clobber the target.
  it('captures into a private, unguessable directory rather than a derivable tmp path', async () => {
    enqueueSpawnResults([{}, {}]);
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });

    const first = await host.screenshotToFile('dormouse.1.default', { format: 'jpeg' }, '/usr/local/bin/agent-browser');
    const second = await host.screenshotToFile('dormouse.1.default', { format: 'jpeg' }, '/usr/local/bin/agent-browser');
    if (!first.ok || !second.ok) throw new Error('expected both captures to resolve a path');

    // Nothing about the path is derivable from the session name.
    expect(first.path).not.toContain('dormouse.1.default');
    expect(first.path).not.toBe(join(tmpdir(), 'dormouse-ab-shot-dormouse.1.default.jpg'));
    // Still reused per session, so one file per frame does not accumulate.
    expect(second.path).toBe(first.path);

    const dir = dirname(first.path);
    expect(dir).not.toBe(tmpdir());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('screenshot() still reads the file and returns the raw bytes', async () => {
    const payload = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0x03]);
    // Stand in for agent-browser writing the frame: the host chooses the path,
    // so learn it from a capture first, then write there.
    enqueueSpawnResults([{}, {}]);
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const located = await host.screenshotToFile('shotbytes', { format: 'jpeg', quality: 85 }, '/usr/local/bin/agent-browser');
    if (!located.ok) throw new Error('expected a path');
    writeFileSync(located.path, payload);

    const result = await host.screenshot('shotbytes', { format: 'jpeg', quality: 85 }, '/usr/local/bin/agent-browser');

    expect(result.ok).toBe(true);
    expect(result.mime).toBe('image/jpeg');
    expect(Array.from(result.bytes ?? [])).toEqual(Array.from(payload));
    await host.closePoppedOut(); // drops the capture directory
  });

  it('drops the capture directory on shutdown', async () => {
    enqueueSpawnResults([{}]);
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const shot = await host.screenshotToFile('shutdown-sess', { format: 'jpeg' }, '/usr/local/bin/agent-browser');
    if (!shot.ok) throw new Error('expected a path');
    writeFileSync(shot.path, Uint8Array.from([1, 2, 3])); // stand in for the capture
    const dir = dirname(shot.path);

    await host.closePoppedOut();

    // A frame of the user's authenticated browser must not outlive the process
    // that took it, waiting on whenever the OS gets round to reaping tmp.
    expect(existsSync(dir)).toBe(false);
  });

  it('removes the frame once its bytes have been read', async () => {
    enqueueSpawnResults([{}, {}]);
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
    const located = await host.screenshotToFile('read-sess', { format: 'jpeg' }, '/usr/local/bin/agent-browser');
    if (!located.ok) throw new Error('expected a path');
    writeFileSync(located.path, Uint8Array.from([0xff, 0xd8]));

    await host.screenshot('read-sess', { format: 'jpeg' }, '/usr/local/bin/agent-browser');

    // `screenshot()` owns the file's whole life — the bytes went to the webview.
    expect(existsSync(located.path)).toBe(false);
    await host.closePoppedOut();
  });

  it('answers a capture-directory failure as a result, and retries the next time', async () => {
    // `??=` on the mkdtemp promise would memoize a rejection, so one transient
    // EACCES/ENOSPC on tmpdir would disable screenshots for the whole process.
    const mkdtemp = vi.spyOn(fsp, 'mkdtemp').mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });

    const failed = await host.screenshotToFile('retry-sess', { format: 'jpeg' }, '/usr/local/bin/agent-browser');
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toContain('ENOSPC');
    expect(spawnMock).not.toHaveBeenCalled(); // never spawned without a path

    mkdtemp.mockRestore();
    enqueueSpawnResults([{}]);
    const recovered = await host.screenshotToFile('retry-sess', { format: 'jpeg' }, '/usr/local/bin/agent-browser');
    expect(recovered.ok).toBe(true);
    await host.closePoppedOut();
  });

  // `binaryPath` crosses from the webview realm and off the persisted session
  // blob, so an unchecked one is arbitrary local execution in the extension host
  // or the Tauri sidecar. The gate is at the spawn, so it covers streamStatus /
  // open / popOut too — the entry points the subcommand allowlist never saw.
  it('refuses a caller-supplied binary path that is not an agent-browser', async () => {
    enqueueSpawnResults([{}]);
    const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });

    await host.command('sess', ['tab', 'list'], '/usr/bin/curl');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Fell through to the host's own candidate rather than spawning curl.
    expect(spawnMock.mock.calls[0][0]).toBe('agent-browser');
  });

  it('accepts an absolute path to an agent-browser, including its Windows shims', async () => {
    for (const candidate of ['/opt/homebrew/bin/agent-browser', 'C:\\tools\\agent-browser.cmd']) {
      spawnMock.mockReset();
      enqueueSpawnResults([{}]);
      const host = createAgentBrowserHost({ writeClipboardText: vi.fn() });
      await host.command('sess', ['tab', 'list'], candidate);
      expect(spawnMock.mock.calls[0][0]).toBe(candidate);
    }
  });
});
