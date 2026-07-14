import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  shellOpen: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-updater', () => ({
  check: mocks.check,
}));

vi.mock('@tauri-apps/api/app', () => ({
  getVersion: mocks.getVersion,
}));

vi.mock('@tauri-apps/plugin-shell', () => ({
  open: mocks.shellOpen,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

// Force the Windows code path so the sidecar-kill-before-install branch is
// exercised. updater.ts consumes IS_WINDOWS (gates the sidecar kill) and
// PLATFORM_STRING (debug report) from this module.
vi.mock('dormouse-lib/lib/platform', () => ({
  PLATFORM_STRING: 'Windows',
  IS_WINDOWS: true,
}));

// --- Helpers ---

const STORAGE_KEY = 'dormouse:update-result';

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
  hasPendingUpdate,
  installPendingUpdate,
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

  // The quit orchestrator (standalone/src/quit.ts) — not the updater — owns quit
  // interception now. The updater just exposes hasPendingUpdate/installPendingUpdate
  // for the orchestrator to call as the last step of its teardown.
  describe('quit-time install', () => {
    // Drive check → approve → download so an approved, downloaded update is pending.
    async function reachDownloadedUpdate(update: ReturnType<typeof makeUpdate>) {
      mocks.check.mockResolvedValue(update);
      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);
    }

    it('reports no pending update until one is approved and downloaded', async () => {
      const update = makeUpdate('0.5.0');
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      // Available but not approved → not pending.
      expect(hasPendingUpdate()).toBe(false);

      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(hasPendingUpdate()).toBe(true);
    });

    it('writes the success marker before calling install', async () => {
      const update = makeUpdate('0.5.0');
      await reachDownloadedUpdate(update);

      const order: string[] = [];
      update.install.mockImplementation(async () => {
        // The success marker must already be in localStorage when install runs.
        const marker = localStorage.getItem(STORAGE_KEY);
        order.push(marker ? 'marker-set' : 'marker-missing');
        order.push('install');
      });

      await installPendingUpdate();

      expect(order).toEqual(['marker-set', 'install']);
      // The pending update is consumed after a successful install.
      expect(hasPendingUpdate()).toBe(false);
    });

    it('kills the sidecar and waits for it before installing on Windows', async () => {
      const update = makeUpdate('0.5.0');
      await reachDownloadedUpdate(update);

      const order: string[] = [];
      mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'kill_sidecar_now') order.push('kill');
        return '';
      });
      update.install.mockImplementation(async () => {
        order.push('install');
      });

      await installPendingUpdate();

      expect(mocks.invoke).toHaveBeenCalledWith('kill_sidecar_now');
      // The kill must complete before NSIS runs, or it can't overwrite the
      // sidecar's still-loaded native modules.
      expect(order).toEqual(['kill', 'install']);
    });

    it('writes a failure marker when install throws', async () => {
      const update = makeUpdate('0.5.0');
      update.install.mockRejectedValue(new Error('install failed'));
      await reachDownloadedUpdate(update);

      await installPendingUpdate();

      const marker = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(marker.failed).toBe(true);
      expect(marker.version).toBe('0.5.0');
    });

    it('is a no-op when no update is pending', async () => {
      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      expect(hasPendingUpdate()).toBe(false);
      await installPendingUpdate();

      // Nothing installed, no marker written.
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('does not install an available update that was never approved', async () => {
      const update = makeUpdate('0.5.0');
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);

      await installPendingUpdate();

      expect(update.download).not.toHaveBeenCalled();
      expect(update.install).not.toHaveBeenCalled();
    });
  });

  describe('actions', () => {
    it('openChangelog reads the current app version and opens release notes after it', async () => {
      openChangelog();
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.shellOpen).toHaveBeenCalledWith('https://dormouse.sh/changelog/after/0.4.0');
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
