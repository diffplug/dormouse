import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('caps even a single oversized output chunk and retains absolute stream positions', async () => {
    const { manager, child } = await startManager();
    const data = 'prefix' + 'x'.repeat(1_000_000);
    child.emit('message', { type: 'data', id: 'pane-a', data });
    expect(manager.getReplayData('pane-a')).toBe('x'.repeat(1_000_000));
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
