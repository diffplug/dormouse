import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  onCloseRequested: vi.fn(),
  windowClose: vi.fn(),
  shellOpen: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: mocks.check,
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: mocks.getVersion,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onCloseRequested: mocks.onCloseRequested,
    close: mocks.windowClose,
  }),
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: mocks.shellOpen,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

// --- Helpers ---

const STORAGE_KEY = 'mouseterm:update-result';

function makeUpdate(version = '0.5.0') {
  return {
    version,
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
  };
}

// Import after mocks
import {
  startUpdateCheck,
  approveUpdate,
  openChangelog,
  buildDebugReport,
  _resetForTesting,
} from './updater';

describe('updater', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    localStorage.clear();
    _resetForTesting();
    mocks.getVersion.mockResolvedValue('0.4.0');
    mocks.check.mockResolvedValue(null);
    mocks.onCloseRequested.mockResolvedValue(vi.fn());
    mocks.windowClose.mockResolvedValue(undefined);
    mocks.shellOpen.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue('');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('post-install markers', () => {
    it('reads a success marker and clears it from localStorage', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ from: '0.3.0', to: '0.4.0' }));

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(0);

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('reads a failure marker and clears it from localStorage', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ failed: true, version: '0.5.0', error: 'oops' }));

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(0);

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('still runs update check after reading a success marker', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ from: '0.3.0', to: '0.4.0' }));

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.check).toHaveBeenCalledOnce();
    });

    it('skips the update check when the marker is a failure', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ failed: true, version: '0.5.0', error: 'EACCES' }),
      );

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.check).not.toHaveBeenCalled();
    });
  });

  describe('update check', () => {
    it('waits 5 seconds before checking', async () => {
      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(mocks.check).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.check).toHaveBeenCalledOnce();
    });

    it('does not download until the user approves the update', async () => {
      const update = makeUpdate();
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(update.download).not.toHaveBeenCalled();

      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(update.download).toHaveBeenCalledOnce();
    });

    it('does not crash on check failure', async () => {
      mocks.check.mockRejectedValue(new Error('network'));

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      // No throw, no crash
      expect(mocks.check).toHaveBeenCalledOnce();
    });

    it('does not crash on download failure', async () => {
      const update = makeUpdate();
      update.download.mockRejectedValue(new Error('disk full'));
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(update.download).toHaveBeenCalledOnce();
    });
  });

  describe('quit-time install', () => {
    it('registers a close handler', async () => {
      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.onCloseRequested).toHaveBeenCalledOnce();
    });

    it('writes success marker before calling install', async () => {
      const update = makeUpdate('0.5.0');
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);

      // Get the close handler
      const closeHandler = mocks.onCloseRequested.mock.calls[0][0];
      const event = { preventDefault: vi.fn() };

      // Track the order of operations
      const order: string[] = [];
      update.install.mockImplementation(async () => {
        // At this point, localStorage should already be set
        const marker = localStorage.getItem(STORAGE_KEY);
        order.push(marker ? 'marker-set' : 'marker-missing');
        order.push('install');
      });

      await closeHandler(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(order).toEqual(['marker-set', 'install']);
      expect(mocks.windowClose).toHaveBeenCalled();
    });

    it('writes failure marker when install throws', async () => {
      const update = makeUpdate('0.5.0');
      update.install.mockRejectedValue(new Error('install failed'));
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);

      const closeHandler = mocks.onCloseRequested.mock.calls[0][0];
      const event = { preventDefault: vi.fn() };

      await closeHandler(event);

      const raw = localStorage.getItem(STORAGE_KEY);
      const marker = JSON.parse(raw!);
      expect(marker.failed).toBe(true);
      expect(marker.version).toBe('0.5.0');
      expect(mocks.windowClose).toHaveBeenCalled();
    });

    it('does not install an available update before approval', async () => {
      const update = makeUpdate('0.5.0');
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      const closeHandler = mocks.onCloseRequested.mock.calls[0][0];
      const event = { preventDefault: vi.fn() };

      await closeHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(update.download).not.toHaveBeenCalled();
      expect(update.install).not.toHaveBeenCalled();
    });

    it('does not prevent close when no update is pending', async () => {
      mocks.check.mockResolvedValue(null);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      const closeHandler = mocks.onCloseRequested.mock.calls[0][0];
      const event = { preventDefault: vi.fn() };

      await closeHandler(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
    });
  });

  describe('actions', () => {
    it('openChangelog calls shell open', () => {
      openChangelog();
      expect(mocks.shellOpen).toHaveBeenCalledWith('https://mouseterm.com/changelog');
    });
  });

  describe('buildDebugReport', () => {
    it('assembles a markdown body with version, platform, error, and log', async () => {
      mocks.getVersion.mockResolvedValue('0.7.0');
      mocks.invoke.mockResolvedValue('[42] [app] setup started\n[42] [sidecar] spawned');

      vi.useRealTimers();
      const body = await buildDebugReport('EACCES: permission denied', '0.8.0');

      expect(mocks.invoke).toHaveBeenCalledWith('read_update_log');
      expect(body).toContain('**App version**: 0.7.0 → 0.8.0');
      expect(body).toContain('**Error**: EACCES: permission denied');
      expect(body).toContain('**Recent log:**');
      expect(body).toContain('[sidecar] spawned');
    });

    it('embeds a placeholder when read_update_log fails', async () => {
      mocks.getVersion.mockResolvedValue('0.7.0');
      mocks.invoke.mockRejectedValue(new Error('no such file'));

      vi.useRealTimers();
      const body = await buildDebugReport('boom', '0.8.0');

      expect(body).toContain('failed to read log');
      expect(body).toContain('**Error**: boom');
    });
  });
});
