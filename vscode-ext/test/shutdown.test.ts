import type * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({
  browser: vi.fn(), capture: vi.fn(), flush: vi.fn(), refresh: vi.fn(), graceful: vi.fn(), kill: vi.fn(), error: vi.fn(),
}));
vi.mock('../src/agent-browser-host', () => ({ closeBrowserSessions: calls.browser }));
vi.mock('../src/session-state', () => ({ captureAgentRecoveryCommands: calls.capture, refreshSavedSessionStateFromPtys: calls.refresh }));
vi.mock('../src/message-router', () => ({ flushAllSessions: calls.flush, getAlertStates: () => new Map() }));
vi.mock('../src/pty-manager', () => ({ gracefulKillLive: calls.graceful, killAll: calls.kill }));
vi.mock('../src/log', () => ({ log: { info: vi.fn(), error: calls.error } }));
import { shutdown } from '../src/shutdown';
const context = {} as vscode.ExtensionContext;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  for (const action of [calls.browser, calls.capture, calls.flush, calls.refresh, calls.graceful]) action.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); });
describe('extension shutdown', () => {
  it('starts browser cleanup alongside capture, then persists before killing', async () => {
    let finishCapture!: () => void;
    calls.capture.mockImplementation(() => new Promise<void>(resolve => { finishCapture = resolve; }));
    const done = shutdown(context);
    expect(calls.browser).toHaveBeenCalledOnce();
    expect(calls.capture).toHaveBeenCalledOnce();
    expect(calls.flush).not.toHaveBeenCalled();
    finishCapture();
    await done;
    expect(calls.capture.mock.invocationCallOrder[0]).toBeLessThan(calls.flush.mock.invocationCallOrder[0]);
    expect(calls.flush.mock.invocationCallOrder[0]).toBeLessThan(calls.refresh.mock.invocationCallOrder[0]);
    expect(calls.refresh.mock.invocationCallOrder[0]).toBeLessThan(calls.graceful.mock.invocationCallOrder[0]);
    expect(calls.graceful.mock.invocationCallOrder[0]).toBeLessThan(calls.kill.mock.invocationCallOrder[0]);
  });
  it.each(['browser', 'capture', 'flush', 'refresh', 'graceful'] as const)('continues cleanup after %s rejects', async name => {
    calls[name].mockRejectedValueOnce(new Error('unavailable during shutdown'));
    await expect(shutdown(context)).resolves.toBeUndefined();
    expect(calls.refresh).toHaveBeenCalledOnce();
    expect(calls.graceful).toHaveBeenCalledOnce();
    expect(calls.kill).toHaveBeenCalledOnce();
    expect(calls.error).toHaveBeenCalled();
  });
  it('continues after a synchronous capture failure', async () => {
    calls.capture.mockImplementationOnce(() => { throw new Error('capture failed'); });
    await shutdown(context);
    expect(calls.kill).toHaveBeenCalledOnce();
  });
  it('does not wait forever for the session storage service', async () => {
    calls.refresh.mockImplementation(() => new Promise<void>(() => {}));
    let finished = false;
    const done = shutdown(context).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(2000);
    expect(finished).toBe(true);
    await done;
    expect(calls.graceful).toHaveBeenCalledOnce();
    expect(calls.kill).toHaveBeenCalledOnce();
    expect(calls.error).toHaveBeenCalled();
  });
});
