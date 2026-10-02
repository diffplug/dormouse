import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { networkPolicyResult, type NetworkLevel } from 'dormouse-lib/remote/network-policy';

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  getVersion: vi.fn(),
  shellOpen: vi.fn(),
  invoke: vi.fn(),
  requestAppRestart: vi.fn(),
  /** The Burrow link's `command`, which answers `networkPolicy`. */
  burrowCommand: vi.fn(),
  /** The webview's baked mode, which gates every check. */
  relayMode: 'hosted' as 'hosted' | 'self-host',
  platform: null as {
    requestAppRestart?: () => Promise<boolean>;
    burrow?: { command: (cmd: string) => Promise<unknown> };
  } | null,
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
  getPlatformOrNull: () => mocks.platform,
}));

vi.mock('dormouse-lib/host/relay-origin', () => ({
  bakedRelayMode: () => mocks.relayMode,
}));

// --- Helpers ---

const STORAGE_KEY = 'dormouse:update-result';
const CHECK_KEY = 'dormouse:update-check';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** What a Hosted build's `networkPolicy` answers for `policy`. */
function networkPolicy(policy: { level: NetworkLevel; autoUpdate: boolean }) {
  return networkPolicyResult({ allowed: [], ...policy }, 'hosted', []);
}

/** The level the lifecycle cases run under: automatic checks on. */
const CHECKS_ON = networkPolicy({ level: 'local', autoUpdate: true });

function makeUpdate(version = '0.5.0') {
  return {
    version,
    download: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

// Import after mocks
import {
  startUpdateCheck,
  approveUpdate,
  dismissBanner,
  openChangelog,
  buildDebugReport,
  useUpdateState,
  hasPendingUpdate,
  installPendingUpdate,
  restartToUpdate,
  checkNow,
  updatesPortForBuild,
  _resetForTesting,
} from './updater';
import { UpdateBanner, type UpdateBannerState } from './UpdateBanner';

function readBannerState(): UpdateBannerState {
  let state!: UpdateBannerState;
  function Probe() {
    state = useUpdateState();
    return null;
  }
  const root = createRoot(document.createElement('div'));
  flushSync(() => root.render(createElement(Probe)));
  root.unmount();
  return state;
}

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
    mocks.relayMode = 'hosted';
    mocks.burrowCommand.mockImplementation(async (cmd: string) =>
      cmd === 'networkPolicy' ? CHECKS_ON : null,
    );
    mocks.platform = { requestAppRestart: mocks.requestAppRestart, burrow: { command: mocks.burrowCommand } };
  });

  it('does not reoffer an approved download when the delayed launch check begins', async () => {
    mocks.check.mockResolvedValue(makeUpdate('0.5.0'));
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(0);
    checkNow();
    await vi.advanceTimersByTimeAsync(0);
    approveUpdate();
    await vi.advanceTimersByTimeAsync(0);
    expect(hasPendingUpdate()).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.check).toHaveBeenCalledOnce();
    expect(readBannerState()).toEqual({ status: 'downloaded', version: '0.5.0' });
  });

  it('does not reoffer an approval while its download is pending at the launch check', async () => {
    const update = makeUpdate('0.5.0');
    update.download.mockImplementation(() => new Promise<void>(() => {}));
    mocks.check.mockResolvedValue(update);
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(0);
    checkNow();
    await vi.advanceTimersByTimeAsync(0);
    approveUpdate();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(readBannerState()).toEqual({ status: 'downloading', version: '0.5.0' });
  });

  it('keeps an approval made while the delayed launch policy read is pending', async () => {
    let answerPolicy!: (value: typeof CHECKS_ON) => void;
    mocks.burrowCommand.mockImplementation(() => new Promise(resolve => { answerPolicy = resolve; }));
    mocks.check.mockResolvedValue(makeUpdate('0.5.0'));
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(5_000);
    checkNow();
    await vi.advanceTimersByTimeAsync(0);
    approveUpdate();
    await vi.advanceTimersByTimeAsync(0);
    answerPolicy(CHECKS_ON);
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.check).toHaveBeenCalledOnce();
    expect(readBannerState()).toEqual({ status: 'downloaded', version: '0.5.0' });
  });

  // Drive check → approve → download so an approved, downloaded update is pending.
  async function reachDownloadedUpdate(update: ReturnType<typeof makeUpdate>) {
    mocks.check.mockResolvedValue(update);
    startUpdateCheck();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(0);
    approveUpdate();
    await vi.advanceTimersByTimeAsync(0);
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('post-install markers', () => {
    it('reads a success marker and clears it from localStorage', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ from: '0.3.0', to: '0.4.0' }));

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(0);

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(readBannerState()).toEqual({ status: 'post-update-success', from: '0.3.0', to: '0.4.0' });
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

    it('reports an unconfirmed install as failure and skips the update check', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ from: '0.4.0', to: '0.5.0' }));

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(readBannerState()).toEqual({
        status: 'post-update-failure',
        version: '0.5.0',
        error: 'Expected version 0.5.0 after update, but running 0.4.0.',
      });
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(mocks.check).not.toHaveBeenCalled();
    });

    it.each([
      'invalid JSON', 'null', '[]',
      JSON.stringify({ failed: true, version: {} }),
      JSON.stringify({ failed: true, version: '0.5.0', error: {} }),
      JSON.stringify({ failed: 'yes', version: '0.5.0' }),
      JSON.stringify({ from: {}, to: '0.4.0' }),
      JSON.stringify({ from: '0.3.0', to: [] }),
    ])('ignores a corrupt marker without suppressing checks: %s', async (raw) => {
      localStorage.setItem(STORAGE_KEY, raw);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(readBannerState()).toEqual({ status: 'idle' });
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(mocks.check).toHaveBeenCalledOnce();
    });
  });

  describe('update check', () => {
    it('handles a failed app-version lookup without an unhandled rejection', async () => {
      mocks.getVersion.mockRejectedValueOnce(new Error('version unavailable'));

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);

      expect(mocks.check).not.toHaveBeenCalled();
      expect(readBannerState()).toEqual({ status: 'idle' });
    });
    it('waits 5 seconds before checking', async () => {
      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(mocks.check).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.check).toHaveBeenCalledOnce();
    });

    // docs/specs/burrow-service.md → "Relay origin".
    it('never checks in a self-host build', async () => {
      mocks.relayMode = 'self-host';
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mocks.check).not.toHaveBeenCalled();
      expect(mocks.getVersion).not.toHaveBeenCalled();
      expect(readBannerState()).toEqual({ status: 'idle' });
      info.mockRestore();
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

    it('does not crash on download failure, and leaves no pending install', async () => {
      const update = makeUpdate();
      update.download.mockRejectedValue(new Error('disk full'));
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(update.download).toHaveBeenCalledOnce();
      // A failed download must revert the banner (downloading → available) and
      // leave pendingUpdate null, so nothing bogus tries to install at quit.
      // See updater.ts downloadApprovedUpdate's catch branch.
      expect(hasPendingUpdate()).toBe(false);
    });

    it('retries the download when approval fires again after a failure', async () => {
      const update = makeUpdate();
      update.download.mockRejectedValue(new Error('disk full'));
      mocks.check.mockResolvedValue(update);

      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);
      expect(update.download).toHaveBeenCalledOnce();

      // availableUpdate survives a failed download, so a second approval
      // re-attempts it rather than silently no-op'ing.
      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(update.download).toHaveBeenCalledTimes(2);
    });
  });

  // docs/specs/remote-network.md → "Updates".
  describe('under the network policy', () => {
    /** Launch, and wait out the 5 s before the check. */
    async function launch() {
      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
    }

    function policyIs(answer: unknown) {
      mocks.burrowCommand.mockImplementation(async () => answer);
    }

    it.each([
      ['Nothing', networkPolicy({ level: 'nothing', autoUpdate: true })],
      ['automatic checks off', networkPolicy({ level: 'local', autoUpdate: false })],
      ['an answer that is not a policy', { policy: { level: 'local', autoUpdate: true } }],
    ])('never checks on its own under %s', async (_case, answer) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      policyIs(answer);
      await launch();
      expect(mocks.burrowCommand).toHaveBeenCalledWith('networkPolicy');
      expect(mocks.check).not.toHaveBeenCalled();
    });

    it('checks on its own under Local networks with automatic checks on', async () => {
      await launch();
      expect(mocks.check).toHaveBeenCalledOnce();
    });

    it.each([
      ['a read that fails', () => mocks.burrowCommand.mockRejectedValue(new Error('no answer'))],
      ['no Burrow service', () => { mocks.platform = { requestAppRestart: mocks.requestAppRestart }; }],
    ])('reads %s as Nothing', async (_case, arrange) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      arrange();
      await launch();
      expect(mocks.check).not.toHaveBeenCalled();
    });

    describe('the reminder, with automatic checks off', () => {
      /** When the launch below evaluates the reminder: after its 5 s. */
      let at: number;

      beforeEach(() => {
        policyIs(networkPolicy({ level: 'nothing', autoUpdate: false }));
        vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
        at = Date.now() + 5_000;
      });

      const clock = () => JSON.parse(localStorage.getItem(CHECK_KEY)!) as Record<string, number | null>;
      const setClock = (record: { checkedAt: number | null; since: number; remindedAt: number | null }) =>
        localStorage.setItem(CHECK_KEY, JSON.stringify(record));

      it('starts the clock at the first launch, and says nothing', async () => {
        await launch();
        expect(clock()).toEqual({ checkedAt: null, since: at, remindedAt: null });
        expect(readBannerState()).toEqual({ status: 'idle' });
      });

      it('reminds once the last successful check is 7 days old, and not a moment before', async () => {
        setClock({ checkedAt: at - 7 * DAY + 1, since: at - 30 * DAY, remindedAt: null });
        await launch();
        expect(readBannerState()).toEqual({ status: 'idle' });
        expect(clock().remindedAt).toBeNull();

        _resetForTesting();
        at = Date.now() + 5_000;
        setClock({ checkedAt: at - 7 * DAY, since: at - 30 * DAY, remindedAt: null });
        await launch();
        expect(readBannerState()).toEqual({ status: 'check-due', days: 7 });
        expect(clock().remindedAt).toBe(at);
        expect(mocks.check).not.toHaveBeenCalled();
      });

      it('counts from the first launch before any check', async () => {
        setClock({ checkedAt: null, since: at - 9 * DAY, remindedAt: null });
        await launch();
        expect(readBannerState()).toEqual({ status: 'check-due', days: 9 });
      });

      it('reminds at most once a week', async () => {
        setClock({ checkedAt: at - 20 * DAY, since: at - 30 * DAY, remindedAt: at - 7 * DAY + 1 });
        await launch();
        expect(readBannerState()).toEqual({ status: 'idle' });

        _resetForTesting();
        at = Date.now() + 5_000;
        setClock({ checkedAt: at - 20 * DAY, since: at - 30 * DAY, remindedAt: at - 7 * DAY });
        await launch();
        expect(readBannerState()).toEqual({ status: 'check-due', days: 20 });
      });

      it('stays quiet after a dismissal until the week is out', async () => {
        setClock({ checkedAt: null, since: at - 8 * DAY, remindedAt: null });
        await launch();
        dismissBanner();
        const remindedAt = clock().remindedAt!;

        _resetForTesting();
        vi.setSystemTime(remindedAt + 6 * DAY);
        await launch();
        expect(readBannerState()).toEqual({ status: 'idle' });

        _resetForTesting();
        vi.setSystemTime(remindedAt + 7 * DAY - 5_000);
        await launch();
        expect(readBannerState()).toEqual({ status: 'check-due', days: 15 });
      });

      it('restarts a clock it cannot read', async () => {
        localStorage.setItem(CHECK_KEY, JSON.stringify({ checkedAt: 'yesterday', since: 1, remindedAt: null }));
        await launch();
        expect(readBannerState()).toEqual({ status: 'idle' });
        expect(clock()).toEqual({ checkedAt: null, since: at, remindedAt: null });
      });

      it('never reminds while automatic checks run, which record each check', async () => {
        policyIs(CHECKS_ON);
        setClock({ checkedAt: null, since: at - 30 * DAY, remindedAt: null });
        await launch();
        expect(mocks.check).toHaveBeenCalledOnce();
        expect(readBannerState()).toEqual({ status: 'idle' });
        expect(clock()).toEqual({ checkedAt: at, since: at - 30 * DAY, remindedAt: null });
      });

      it('never covers a notice still showing: the launch’s after an update', async () => {
        // Its 10 s outlast the 5 s before the reminder; the next hourly tick has it.
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ from: '0.3.0', to: '0.4.0' }));
        setClock({ checkedAt: at - 8 * DAY, since: at - 30 * DAY, remindedAt: null });
        await launch();
        expect(readBannerState()).toEqual({ status: 'post-update-success', from: '0.3.0', to: '0.4.0' });
        expect(clock().remindedAt).toBeNull();

        await vi.advanceTimersByTimeAsync(HOUR);
        expect(readBannerState()).toEqual({ status: 'check-due', days: 8 });
      });

      it.each([
        ['the last check', { checkedAt: 300, since: -400, remindedAt: null }, { checkedAt: 0, since: -400, remindedAt: null }, 7],
        ['the baseline', { checkedAt: null, since: 300, remindedAt: null }, { checkedAt: null, since: 0, remindedAt: null }, 7],
        ['the last reminder', { checkedAt: -20, since: -400, remindedAt: 300 }, { checkedAt: -20, since: -400, remindedAt: 0 }, 27],
      ])('saves %s ahead of the clock as now, so a clock set back delays the reminder a week at most', async (_case, stored, saved, days) => {
        const inDays = (offset: number | null) => (offset === null ? null : at + offset * DAY);
        setClock({ checkedAt: inDays(stored.checkedAt), since: inDays(stored.since)!, remindedAt: inDays(stored.remindedAt) });
        await launch();
        // The others kept.
        expect(clock()).toEqual({ checkedAt: inDays(saved.checkedAt), since: inDays(saved.since), remindedAt: inDays(saved.remindedAt) });
        expect(readBannerState()).toEqual({ status: 'idle' });

        await vi.advanceTimersByTimeAsync(7 * DAY + HOUR);
        expect(readBannerState()).toEqual({ status: 'check-due', days });
      });

      it('leaves the clock alone while the time reads as never set', async () => {
        const record = { checkedAt: at - 3 * DAY, since: at - 30 * DAY, remindedAt: null };
        setClock(record);
        vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
        await launch();
        expect(clock()).toEqual(record);

        // Once the network sets it, the week counts from the real check.
        vi.setSystemTime(at + 5 * DAY);
        await vi.advanceTimersByTimeAsync(HOUR);
        expect(readBannerState()).toEqual({ status: 'check-due', days: 8 });
      });

      it('reminds at launch after an automatic check that failed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        policyIs(CHECKS_ON);
        mocks.check.mockRejectedValue(new Error('offline'));
        setClock({ checkedAt: at - 9 * DAY, since: at - 30 * DAY, remindedAt: null });
        await launch();
        expect(mocks.check).toHaveBeenCalledOnce();
        expect(readBannerState()).toEqual({ status: 'check-due', days: 9 });
      });

      describe('while the app runs', () => {
        // The ticks count from `startUpdateCheck`, 5 s before `at`.

        it('reminds on an hourly tick, at most once a week, and never checks', async () => {
          setClock({ checkedAt: null, since: at - 6 * DAY, remindedAt: null });
          await launch();
          mocks.burrowCommand.mockClear();

          // The tick 24 h on is 5 s short of the week; the one after is past it.
          await vi.advanceTimersByTimeAsync(DAY);
          expect(readBannerState()).toEqual({ status: 'idle' });
          await vi.advanceTimersByTimeAsync(HOUR);
          expect(readBannerState()).toEqual({ status: 'check-due', days: 7 });
          const remindedAt = clock().remindedAt!;
          dismissBanner();

          await vi.advanceTimersByTimeAsync(6 * DAY);
          expect(readBannerState()).toEqual({ status: 'dismissed' });
          await vi.advanceTimersByTimeAsync(DAY);
          expect(readBannerState()).toEqual({ status: 'check-due', days: 14 });
          expect(clock().remindedAt).toBe(remindedAt + 7 * DAY);
          // Local timestamps alone: not even the policy is asked.
          expect(mocks.check).not.toHaveBeenCalled();
          expect(mocks.burrowCommand).not.toHaveBeenCalled();
        });

        it('leaves a notice the user has not dismissed', async () => {
          vi.spyOn(console, 'error').mockImplementation(() => {});
          mocks.check.mockRejectedValue(new Error('offline'));
          setClock({ checkedAt: null, since: at - 30 * DAY, remindedAt: at - 7 * DAY + HOUR / 2 });
          await launch();
          checkNow();
          await vi.advanceTimersByTimeAsync(0);

          await vi.advanceTimersByTimeAsync(HOUR);
          expect(readBannerState()).toEqual({ status: 'check-failed' });
          dismissBanner();
          await vi.advanceTimersByTimeAsync(HOUR);
          expect(readBannerState()).toEqual({ status: 'check-due', days: 30 });
        });

        it('reminds with automatic checks on too, whose launch check failed', async () => {
          vi.spyOn(console, 'error').mockImplementation(() => {});
          policyIs(CHECKS_ON);
          mocks.check.mockRejectedValue(new Error('offline'));
          setClock({ checkedAt: null, since: at - 6 * DAY, remindedAt: null });
          await launch();
          expect(readBannerState()).toEqual({ status: 'idle' });

          await vi.advanceTimersByTimeAsync(DAY + HOUR);
          expect(readBannerState()).toEqual({ status: 'check-due', days: 7 });
          expect(mocks.check).toHaveBeenCalledOnce();
        });
      });
    });
  });

  describe('check now', () => {
    const clock = () => JSON.parse(localStorage.getItem(CHECK_KEY) ?? 'null') as { checkedAt: number | null } | null;

    beforeEach(() => {
      // A click checks whatever the policy says.
      mocks.burrowCommand.mockImplementation(async () => networkPolicy({ level: 'nothing', autoUpdate: false }));
    });

    it('checks under Nothing, says it is up to date, and records the check', async () => {
      const port = updatesPortForBuild()!;
      const seen: Array<{ checkedAt: number | null; checking: boolean }> = [];
      port.subscribe(() => seen.push(port.getSnapshot()));
      expect(port.getSnapshot()).toBe(port.getSnapshot());

      checkNow();
      expect(readBannerState()).toEqual({ status: 'checking' });
      expect(port.getSnapshot().checking).toBe(true);
      await vi.advanceTimersByTimeAsync(0);

      const now = Date.now();
      expect(mocks.check).toHaveBeenCalledOnce();
      expect(readBannerState()).toEqual({ status: 'up-to-date', version: '0.4.0' });
      expect(clock()?.checkedAt).toBe(now);
      expect(port.getSnapshot()).toEqual({ checkedAt: now, checking: false });
      expect(seen).toContainEqual({ checkedAt: null, checking: true });
      expect(seen[seen.length - 1]).toEqual({ checkedAt: now, checking: false });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(readBannerState()).toEqual({ status: 'idle' });
    });

    it('offers an update it finds for approval', async () => {
      const update = makeUpdate('0.5.0');
      mocks.check.mockResolvedValue(update);

      checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(readBannerState()).toEqual({ status: 'available', version: '0.5.0' });

      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);
      expect(update.download).toHaveBeenCalledOnce();
    });

    it('lets go of an unapproved update a later check replaces', async () => {
      const first = makeUpdate('0.5.0');
      const second = makeUpdate('0.5.1');
      mocks.check.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

      checkNow();
      await vi.advanceTimersByTimeAsync(0);
      checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(readBannerState()).toEqual({ status: 'available', version: '0.5.1' });
      expect(first.close).toHaveBeenCalledOnce();

      approveUpdate();
      await vi.advanceTimersByTimeAsync(0);
      expect(second.download).toHaveBeenCalledOnce();
      expect(first.download).not.toHaveBeenCalled();
    });

    it('shows a second up-to-date its own 10 s', async () => {
      checkNow();
      await vi.advanceTimersByTimeAsync(8_000);
      checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(readBannerState()).toEqual({ status: 'up-to-date', version: '0.4.0' });

      // Past the first one's 10 s, inside the second's.
      await vi.advanceTimersByTimeAsync(4_000);
      expect(readBannerState()).toEqual({ status: 'up-to-date', version: '0.4.0' });
      await vi.advanceTimersByTimeAsync(6_000);
      expect(readBannerState()).toEqual({ status: 'idle' });
    });

    it('says a failed check failed, and records none', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      mocks.check.mockRejectedValue(new Error('offline'));

      checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(readBannerState()).toEqual({ status: 'check-failed' });
      expect(clock()).toBeNull();
      expect(updatesPortForBuild()!.getSnapshot()).toEqual({ checkedAt: null, checking: false });
    });

    it('joins a check in flight, the launch’s included', async () => {
      mocks.burrowCommand.mockImplementation(async () => CHECKS_ON);
      let answer!: (update: null) => void;
      mocks.check.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
      startUpdateCheck();
      await vi.advanceTimersByTimeAsync(5_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.check).toHaveBeenCalledOnce();

      checkNow();
      checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.check).toHaveBeenCalledOnce();
      expect(readBannerState()).toEqual({ status: 'checking' });

      answer(null);
      await vi.advanceTimersByTimeAsync(0);
      expect(readBannerState()).toEqual({ status: 'up-to-date', version: '0.4.0' });
    });

    it('shows an approved update again rather than checking for it', async () => {
      mocks.burrowCommand.mockImplementation(async () => CHECKS_ON);
      const update = makeUpdate('0.5.0');
      let finish!: () => void;
      update.download.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
      await reachDownloadedUpdate(update);
      dismissBanner();

      checkNow();
      expect(readBannerState()).toEqual({ status: 'downloading', version: '0.5.0' });
      finish();
      await vi.advanceTimersByTimeAsync(0);
      dismissBanner();

      checkNow();
      expect(readBannerState()).toEqual({ status: 'downloaded', version: '0.5.0' });
      expect(mocks.check).toHaveBeenCalledOnce();
    });

    it('is no port, and checks nothing, in a self-host build', async () => {
      mocks.relayMode = 'self-host';
      expect(updatesPortForBuild()).toBeUndefined();
      checkNow();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.check).not.toHaveBeenCalled();
      expect(readBannerState()).toEqual({ status: 'idle' });
    });
  });

  // The quit orchestrator (standalone/src/quit.ts) — not the updater — owns quit
  // interception now. The updater just exposes hasPendingUpdate/installPendingUpdate
  // for the orchestrator to call as the last step of its teardown.
  describe('quit-time install', () => {
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
    it('restartToUpdate asks the host for a restart, which installs on the way out', async () => {
      mocks.requestAppRestart.mockResolvedValue(true);
      restartToUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.requestAppRestart).toHaveBeenCalledExactlyOnceWith();
    });

    it.each([
      ['a Tauri string', 'Restart needs a packaged build; restart the dev command instead'],
      ['an Error', new Error('Restart needs a packaged build; restart the dev command instead')],
    ])('a restart the host refuses with %s becomes restart-refused and still installs at quit', async (_kind, rejection) => {
      const update = makeUpdate('0.5.0');
      await reachDownloadedUpdate(update);
      mocks.requestAppRestart.mockRejectedValue(rejection);

      restartToUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(readBannerState()).toEqual({
        status: 'restart-refused',
        version: '0.5.0',
        reason: 'Restart needs a packaged build; restart the dev command instead',
      });
      expect(hasPendingUpdate()).toBe(true);

      // Dismissing hides the notice only, like `downloaded`.
      dismissBanner();
      expect(readBannerState()).toEqual({ status: 'dismissed' });
      expect(hasPendingUpdate()).toBe(true);
      await installPendingUpdate();
      expect(update.install).toHaveBeenCalledOnce();
    });

    it('keeps a dismissal that lands before the refusal', async () => {
      await reachDownloadedUpdate(makeUpdate('0.5.0'));
      let refuse!: (reason: string) => void;
      mocks.requestAppRestart.mockReturnValue(new Promise<boolean>((_resolve, reject) => { refuse = reject; }));

      restartToUpdate();
      dismissBanner();
      refuse('Dormouse cannot find its own executable to relaunch');
      await vi.advanceTimersByTimeAsync(0);

      expect(readBannerState()).toEqual({ status: 'dismissed' });
      expect(hasPendingUpdate()).toBe(true);
    });

    it('leaves the notice as is when the restart joins a plain quit', async () => {
      await reachDownloadedUpdate(makeUpdate('0.5.0'));
      mocks.requestAppRestart.mockResolvedValue(false);

      restartToUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(readBannerState()).toEqual({ status: 'downloaded', version: '0.5.0' });
    });

    it.each([
      ['no restart method', {}],
      ['no platform', null],
    ])('restartToUpdate is a no-op on a host with %s', async (_kind, platform) => {
      await reachDownloadedUpdate(makeUpdate('0.5.0'));
      mocks.platform = platform;

      restartToUpdate();
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.requestAppRestart).not.toHaveBeenCalled();
      expect(readBannerState()).toEqual({ status: 'downloaded', version: '0.5.0' });
    });

    it('offers Restart now only on a downloaded update the host has not refused', () => {
      const onRestart = vi.fn();
      const render = (state: UpdateBannerState) => {
        const container = document.createElement('div');
        const root = createRoot(container);
        flushSync(() => root.render(createElement(UpdateBanner, {
          state,
          onDismiss: vi.fn(),
          onApproveUpdate: vi.fn(),
          onRestart,
          onOpenChangelog: vi.fn(),
          onOpenDebug: vi.fn(),
          onCheckNow: vi.fn(),
        })));
        return { container, unmount: () => root.unmount() };
      };
      const restartButton = (container: HTMLElement) =>
        [...container.querySelectorAll('button')].find((button) => button.textContent === 'Restart now');

      const available = render({ status: 'available', version: '0.5.0' });
      expect(restartButton(available.container)).toBeUndefined();
      available.unmount();

      const downloaded = render({ status: 'downloaded', version: '0.5.0' });
      restartButton(downloaded.container)!.click();
      expect(onRestart).toHaveBeenCalledOnce();
      downloaded.unmount();

      const refused = render({ status: 'restart-refused', version: '0.5.0', reason: 'no executable' });
      expect(refused.container.textContent).toContain(
        "Update downloaded (v0.5.0) — will install when you quit (couldn't restart: no executable)",
      );
      expect(restartButton(refused.container)).toBeUndefined();
      expect([...refused.container.querySelectorAll('button')].map((b) => b.textContent)).toContain('Changelog');
      refused.unmount();
    });

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
