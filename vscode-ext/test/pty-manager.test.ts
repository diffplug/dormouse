import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PTY_HIGH_WATERMARK_CHARS, PTY_LOW_WATERMARK_CHARS } from '../../lib/src/lib/pty-flow';

const mocks = vi.hoisted(() => ({ fork: vi.fn() }));
vi.mock('child_process', () => ({ fork: mocks.fork }));
vi.mock('vscode', () => ({ workspace: {} }));

class FakeChild extends EventEmitter {
  connected = true;
  stderr = new EventEmitter();
  send = vi.fn();
  kill = vi.fn();
}

async function startManager() {
  const child = new FakeChild();
  mocks.fork.mockReturnValue(child);
  const manager = await import('../src/pty-manager');
  manager.setExtensionPath('/extension');
  manager.spawn('pane-a');
  child.emit('message', { type: 'ready' });
  return { manager, child };
}

describe('PTY manager lifetime and buffers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('forks the pty host in the extension’s own directory, never the inherited cwd', async () => {
    await startManager();
    expect(mocks.fork.mock.calls[0]![2]).toMatchObject({ cwd: '/extension' });
  });

  it('waits for both serial port scans before timing out the child', async () => {
    vi.useFakeTimers();
    try {
      const { manager, child } = await startManager();
      const answer = manager.getOpenPorts('pane-a');
      const request = child.send.mock.calls.at(-1)![0];
      await vi.advanceTimersByTimeAsync(6500);
      const ports = [{ address: '127.0.0.1', port: 5173, pid: 1 }];
      child.emit('message', { type: 'openPortsMany', ports: { 'pane-a': ports }, requestId: request.requestId });
      expect(await answer).toEqual(ports);
    } finally { vi.useRealTimers(); }
  });

  it('asks the child once for a batch and answers by request id', async () => {
    const { manager, child } = await startManager();
    const answer = manager.getOpenPortsMany(['pane-a', 'pane-b']);
    const request = child.send.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ type: 'getOpenPortsMany', ids: ['pane-a', 'pane-b'] });
    const ports = { 'pane-a': [{ address: '127.0.0.1', port: 5173, pid: 1 }], 'pane-b': [] };
    child.emit('message', { type: 'openPortsMany', ports, requestId: 'someone-else' });
    child.emit('message', { type: 'openPortsMany', ports, requestId: request.requestId });
    expect(await answer).toEqual(ports);
  });

  it('asks the child once for every cwd a save probes', async () => {
    const { manager, child } = await startManager();
    const answer = manager.getCwds(['pane-a', 'pane-b', 'pane-c']);
    const request = child.send.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ type: 'getCwds', ids: ['pane-a', 'pane-b', 'pane-c'] });
    const cwds = { 'pane-a': '/repo', 'pane-b': '/tmp', 'pane-c': null };
    child.emit('message', { type: 'cwds', cwds: { 'pane-a': '/elsewhere' }, requestId: 'someone-else' });
    child.emit('message', { type: 'cwds', cwds, requestId: request.requestId });
    expect(await answer).toEqual(cwds);
    expect(child.send).toHaveBeenCalledTimes(2);
  });

  it('caps even a single oversized output chunk and retains absolute stream positions', async () => {
    const { manager, child } = await startManager();
    const data = 'prefix' + 'x'.repeat(1_000_000);
    child.emit('message', { type: 'data', id: 'pane-a', data });
    expect(manager.getScrollback('pane-a')).toBe('x'.repeat(1_000_000));
    expect(manager.getScrollbackReceived('pane-a')).toBe(data.length);
    expect(manager.getScrollbackSince('pane-a', data.length - 3)).toBe('xxx');
    child.emit('message', { type: 'data', id: 'pane-a', data: 'end' });
    expect(manager.getScrollbackSince('pane-a', data.length)).toBe('end');
  });

  it('gracefully kills every live PTY by id and resolves on its own ack', async () => {
    const { manager, child } = await startManager();
    manager.spawn('pane-b');
    manager.spawn('pane-c');
    manager.spawn('pane-d');
    child.emit('message', { type: 'exit', id: 'pane-c', exitCode: 0 });
    manager.kill('pane-d');
    let settled = false;
    const done = manager.gracefulKillLive(2000).then(() => { settled = true; });
    const request = child.send.mock.calls.at(-1)![0];
    expect(request).toMatchObject({ type: 'gracefulKill', ids: ['pane-a', 'pane-b'], timeout: 2000 });
    child.emit('message', { type: 'gracefulKillDone', requestId: 'someone-else' });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('message', { type: 'gracefulKillDone', requestId: request.requestId });
    await done;
  });

  it('queues a graceful kill behind a spawn the child is not ready for', async () => {
    const child = new FakeChild();
    mocks.fork.mockReturnValue(child);
    const manager = await import('../src/pty-manager');
    manager.setExtensionPath('/extension');
    manager.spawn('pane-a');
    void manager.gracefulKillLive(2000);
    expect(child.send).not.toHaveBeenCalled();
    child.emit('message', { type: 'ready' });
    expect(child.send.mock.calls.map(([msg]) => msg.type)).toEqual(['spawn', 'gracefulKill']);
  });

  it('stops waiting for an ack once the child exits', async () => {
    vi.useFakeTimers();
    try {
      const { manager, child } = await startManager();
      let settled = false;
      void manager.gracefulKillLive(2000).then(() => { settled = true; });
      child.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('answers a pending request at once when the child exits before replying', async () => {
    vi.useFakeTimers();
    try {
      const { manager, child } = await startManager();
      let shells: unknown;
      void manager.getAvailableShells().then((answer) => { shells = answer; });
      child.emit('exit', 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(shells).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('forwards a Burrow repaint to the PTY child that owns all size writers', async () => {
    const { manager, child } = await startManager();
    manager.resize('pane-a', 80, 24, true);
    expect(child.send).toHaveBeenLastCalledWith({
      type: 'resize', id: 'pane-a', cols: 80, rows: 24, repaint: true,
    });
  });

  it('marks live PTYs exited after child failure while retaining transcripts and prior exits', async () => {
    const { manager, child } = await startManager();
    const onExit = vi.fn();
    manager.addCallbacks({ onData: vi.fn(), onExit });
    manager.spawn('pane-b');
    child.emit('message', { type: 'data', id: 'pane-a', data: 'history' });
    child.emit('message', { type: 'exit', id: 'pane-b', exitCode: 7 });
    onExit.mockClear();
    child.emit('exit', null);

    expect(manager.getPtyStatus('pane-a')).toEqual({ alive: false, exitCode: 1 });
    expect(manager.getPtyStatus('pane-b')).toEqual({ alive: false, exitCode: 7 });
    expect(manager.getScrollback('pane-a')).toBe('history');
    expect(onExit.mock.calls).toEqual([['pane-a', 1]]);
  });

  it('keeps a replacement spawned synchronously by an exit callback alive', async () => {
    const { manager, child } = await startManager();
    manager.spawn('pane-b');
    const replacement = new FakeChild();
    mocks.fork.mockReturnValue(replacement);
    const onExit = vi.fn((id: string) => {
      if (id !== 'pane-a') return;
      expect(manager.getPtyStatus('pane-b')?.alive).toBe(false);
      manager.spawn('pane-new');
    });
    manager.addCallbacks({ onData: vi.fn(), onExit });
    child.emit('exit', 1);

    expect(manager.getPtyStatus('pane-new')?.alive).toBe(true);
    expect(onExit.mock.calls).toEqual([['pane-a', 1], ['pane-b', 1]]);
  });

  it('ignores a retired child’s late output and exit after a replacement starts', async () => {
    const { manager, child } = await startManager();
    manager.killAll();
    const replacement = new FakeChild();
    mocks.fork.mockReturnValue(replacement);
    manager.spawn('pane-new');
    child.emit('message', { type: 'data', id: 'pane-a', data: 'late' });
    child.emit('exit', 1);
    replacement.emit('message', { type: 'ready' });
    replacement.emit('message', { type: 'data', id: 'pane-new', data: 'new' });

    expect(manager.hasPty('pane-a')).toBe(false);
    expect(manager.getPtyStatus('pane-new')).toEqual({ alive: true, exitCode: undefined });
    expect(manager.getScrollback('pane-new')).toBe('new');
    expect(replacement.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'spawn', id: 'pane-new' }));
  });
});

// docs/specs/transport.md -> "Output flow control": counted here, where the
// webview's share is posted; carried out in the child, where node-pty runs.
describe('output flow control', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  const flowCalls = (child: FakeChild) => child.send.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg.type === 'pause' || msg.type === 'resume' || msg.type === 'spawn' || msg.type === 'kill' || msg.type === 'interrupt')
    .map((msg) => `${msg.type} ${msg.id ?? msg.ids}`);

  it('pauses the child’s PTY once its webview owes past the high watermark, and resumes it as it acknowledges', async () => {
    const { manager, child } = await startManager();
    manager.sentOutput('pane-a', PTY_HIGH_WATERMARK_CHARS);
    manager.sentOutput('pane-a', 1);
    manager.sentOutput('pane-a', 1);
    manager.acknowledgeOutput('pane-a', PTY_HIGH_WATERMARK_CHARS + 2 - PTY_LOW_WATERMARK_CHARS);
    expect(flowCalls(child)).toEqual(['spawn pane-a', 'pause pane-a', 'resume pane-a']);
  });

  it('forgives and resumes at a respawn, a webview reset and the capture’s interrupt; forgets a killed PTY', async () => {
    const { manager, child } = await startManager();
    manager.sentOutput('pane-a', PTY_HIGH_WATERMARK_CHARS + 1);
    manager.spawn('pane-a');
    manager.sentOutput('pane-a', PTY_HIGH_WATERMARK_CHARS + 1);
    manager.resetOutputFlow(['pane-a']);
    manager.sentOutput('pane-a', PTY_HIGH_WATERMARK_CHARS + 1);
    void manager.interrupt(['pane-a']);
    manager.sentOutput('pane-a', PTY_HIGH_WATERMARK_CHARS + 1);
    manager.kill('pane-a');
    manager.acknowledgeOutput('pane-a', PTY_HIGH_WATERMARK_CHARS + 1);
    expect(flowCalls(child)).toEqual([
      'spawn pane-a',
      'pause pane-a', 'resume pane-a', 'spawn pane-a',
      'pause pane-a', 'resume pane-a',
      'pause pane-a', 'resume pane-a', 'interrupt pane-a',
      'pause pane-a', 'kill pane-a',
    ]);
  });

  it('on Windows, resumes a paused PTY before writing input to it', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let started: Awaited<ReturnType<typeof startManager>>;
    try {
      started = await startManager();
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
    const { manager, child } = started;
    manager.sentOutput('pane-a', PTY_HIGH_WATERMARK_CHARS + 1);
    manager.write('pane-a', '\x03');
    expect(child.send.mock.calls.map(([msg]) => msg.type)).toEqual(['spawn', 'pause', 'resume', 'input']);
    // A paced slice the child writes after the grace resumes it again.
    manager.spawn('pane-b');
    manager.sentOutput('pane-b', PTY_HIGH_WATERMARK_CHARS + 1);
    child.emit('message', { type: 'inputWritten', id: 'pane-b' });
    expect(child.send.mock.calls.map(([msg]) => `${msg.type} ${msg.id}`).slice(-3)).toEqual(['spawn pane-b', 'pause pane-b', 'resume pane-b']);
  });

  it('never forks a child just to pause a PTY in one that is gone', async () => {
    const { manager, child } = await startManager();
    child.emit('exit', 1);
    manager.sentOutput('pane-a', PTY_HIGH_WATERMARK_CHARS + 1);
    expect(mocks.fork).toHaveBeenCalledTimes(1);
  });
});
