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

  it('waits for both serial port scans before timing out the child', async () => {
    vi.useFakeTimers();
    try {
      const { manager, child } = await startManager();
      const answer = manager.getOpenPorts('pane-a');
      await vi.advanceTimersByTimeAsync(6500);
      const ports = [{ address: '127.0.0.1', port: 5173, pid: 1 }];
      child.emit('message', { type: 'openPorts', id: 'pane-a', ports });
      expect(await answer).toEqual(ports);
    } finally { vi.useRealTimers(); }
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
