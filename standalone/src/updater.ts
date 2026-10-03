import { useSyncExternalStore } from 'react';
import { bakedRelayMode } from 'dormouse-lib/host/relay-origin';
import { isRecord } from 'dormouse-lib/lib/is-record';
import { loadJson, saveJson } from 'dormouse-lib/lib/local-json-store';
import { getPlatformOrNull, IS_WINDOWS, PLATFORM_STRING } from 'dormouse-lib/lib/platform';
import type { UpdatesPort, UpdatesSnapshot } from 'dormouse-lib/lib/platform/types';
import { checksForUpdates, isNetworkPolicyResult, type NetworkPolicy } from 'dormouse-lib/remote/network-policy';
import type { UpdateBannerState } from './UpdateBanner';
import type { Update } from '@tauri-apps/plugin-updater';

const GITHUB_REPO_URL = 'https://github.com/diffplug/dormouse';
const BROWSER_DEV_HOST = Boolean(import.meta.env.VITE_DORMOUSE_BROWSER_DEV_HOST);

function openUrl(url: string, context: string): void {
  if (BROWSER_DEV_HOST) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  import('@tauri-apps/plugin-shell')
    .then(({ open }) => open(url))
    .catch((e) => console.error(`[updater] Failed to open ${context}:`, e));
}

async function checkForUpdate(): Promise<Update | null> {
  if (BROWSER_DEV_HOST) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  return check();
}

async function getAppVersion(): Promise<string> {
  if (BROWSER_DEV_HOST) return 'browser-dev';
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

async function invokeTauri<T>(cmd: string): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd);
}

// --- State ---

const STORAGE_KEY = 'dormouse:update-result';

/** The check clock (`docs/specs/auto-update.md` → "localStorage"). */
const CHECK_KEY = 'dormouse:update-check';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How old the last successful check is before the reminder, and how often it may show. */
const REMINDER_INTERVAL_MS = 7 * DAY_MS;
/**
 * No earlier clock reading is right — this code did not exist — so one is a
 * clock not yet set, which reads 1970 or 2000 until the network sets it.
 */
const EARLIEST_PLAUSIBLE_TIME = Date.UTC(2026, 8, 1);

let state: UpdateBannerState = { status: 'idle' };
let availableUpdate: Update | null = null;
let pendingUpdate: Update | null = null;
let downloadPromise: Promise<void> | null = null;
let currentVersion = '';
/** The check in flight, which a second asker joins. */
let checkPromise: Promise<Update | null> | null = null;
/** The hourly reminder tick, from launch on: a terminal stays open for weeks. */
let reminderTimer: ReturnType<typeof setInterval> | null = null;

const listeners = new Set<() => void>();

function shouldSkipInstallInDev(): boolean {
  return import.meta.env.DEV && import.meta.env.MODE !== 'test';
}

function setState(next: UpdateBannerState) {
  state = next;
  emit();
}

/** Tells every subscriber — the Baseboard's and the `updates` port's — to read again. */
function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Show `next`, then `idle` after 10 s unless the notice has moved on — to another like it included. */
function showBriefly(next: UpdateBannerState): void {
  setState(next);
  setTimeout(() => {
    if (state === next) setState({ status: 'idle' });
  }, 10_000);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): UpdateBannerState {
  return state;
}

export function useUpdateState(): UpdateBannerState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

// --- The check clock ---

/**
 * `checkedAt`: the last successful check. `since`: when this machine started
 * counting, the baseline before any check. `remindedAt`: the last reminder.
 */
interface CheckRecord {
  checkedAt: number | null;
  since: number;
  remindedAt: number | null;
}

const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The stored record, or `null` for none, a corrupt one included. Writes nothing. */
function peekCheckRecord(): CheckRecord | null {
  const record = loadJson(CHECK_KEY, null, (value): value is CheckRecord =>
    isRecord(value)
    && isTime(value.since)
    && (value.checkedAt === null || isTime(value.checkedAt))
    && (value.remindedAt === null || isTime(value.remindedAt)));
  // Its three fields alone, so a save built from it writes nothing else back.
  return record && { checkedAt: record.checkedAt, since: record.since, remindedAt: record.remindedAt };
}

/**
 * The stored record, else a fresh one counting from `now`, saved. **A time
 * ahead of `now` — a clock set back since — is saved as `now`**, delaying the
 * reminder a week at most rather than until the clock catches up.
 */
function loadCheckRecord(now: number): CheckRecord {
  const stored = peekCheckRecord();
  const upToNow = (time: number | null) => (time === null ? null : Math.min(time, now));
  const record: CheckRecord = {
    checkedAt: upToNow(stored?.checkedAt ?? null),
    since: Math.min(stored?.since ?? now, now),
    remindedAt: upToNow(stored?.remindedAt ?? null),
  };
  if (
    !stored
    || record.checkedAt !== stored.checkedAt
    || record.since !== stored.since
    || record.remindedAt !== stored.remindedAt
  ) {
    saveCheckRecord(record);
  }
  return record;
}

function saveCheckRecord(record: CheckRecord): void {
  saveJson(CHECK_KEY, record);
  publishChecks();
}

/**
 * The Baseboard's reminder, once the last successful check — or, before one,
 * the baseline — is a week old, and at most once a week. Reads local
 * timestamps and contacts nothing. **Never over a notice still showing**, which
 * a later tick waits out, **nor on a clock not yet set**, which would pull
 * every time back to its own.
 */
function remindIfDue(now: number): void {
  if (now < EARLIEST_PLAUSIBLE_TIME) return;
  const record = loadCheckRecord(now);
  const age = now - (record.checkedAt ?? record.since);
  if (age < REMINDER_INTERVAL_MS) return;
  if (record.remindedAt !== null && now - record.remindedAt < REMINDER_INTERVAL_MS) return;
  if (state.status !== 'idle' && state.status !== 'dismissed') return;
  saveCheckRecord({ ...record, remindedAt: now });
  setState({ status: 'check-due', days: Math.floor(age / DAY_MS) });
}

/** The update the user approved — downloading, or downloaded and pending — if any. */
function approvedUpdate(): Update | null {
  return pendingUpdate ?? (downloadPromise ? availableUpdate : null);
}

/**
 * One check, automatic or asked for; a second asker joins it. A success is
 * recorded, and an update it finds is offered for approval.
 */
function performCheck(): Promise<Update | null> {
  if (checkPromise) return checkPromise;
  checkPromise = (async () => {
    try {
      const update = await checkForUpdate();
      const now = Date.now();
      saveCheckRecord({ since: now, remindedAt: null, ...peekCheckRecord(), checkedAt: now });
      // An approval made while this check was in flight owns this session's
      // update: the handle it is downloading or holds must not be replaced.
      const approved = approvedUpdate();
      if (update && approved) {
        if (update !== approved) void update.close().catch(() => {});
        return approved;
      }
      if (update) {
        // One still unapproved is replaced, and its handle let go.
        const replaced = availableUpdate;
        availableUpdate = update;
        if (replaced && replaced !== update) void replaced.close().catch(() => {});
        setState({ status: 'available', version: update.version });
      }
      return update;
    } finally {
      checkPromise = null;
      publishChecks();
    }
  })();
  publishChecks();
  return checkPromise;
}

// --- The `updates` port (dormouse-lib/lib/platform/types.ts) ---

let checksSnapshot: UpdatesSnapshot | null = null;

function getChecksSnapshot(): UpdatesSnapshot {
  checksSnapshot ??= { checkedAt: peekCheckRecord()?.checkedAt ?? null, checking: checkPromise !== null };
  return checksSnapshot;
}

function publishChecks(): void {
  checksSnapshot = null;
  emit();
}

/**
 * Whether this build checks at all: never a self-host build
 * (`docs/specs/relay.md` → "Relay origin") or the browser-dev harness.
 */
function buildChecks(): boolean {
  return !BROWSER_DEV_HOST && bakedRelayMode() === 'hosted';
}

/**
 * What Settings → Network reads: the last successful check and whether one is
 * running, and Check now. `undefined` in a build that never checks, for
 * `main.tsx` to give only the window that checks.
 */
export function updatesPortForBuild(): UpdatesPort | undefined {
  return buildChecks() ? { getSnapshot: getChecksSnapshot, subscribe, checkNow } : undefined;
}

// --- Actions ---

export function dismissBanner(): void {
  setState({ status: 'dismissed' });
}

export function approveUpdate(): void {
  void downloadApprovedUpdate();
}

/**
 * Check now — the Baseboard's Check now and Try again, and Settings → Network's.
 * A click, so it checks whatever the network policy says
 * (`docs/specs/remote-network.md` → "Updates"). **An update already approved
 * is shown again rather than checked for**: a second `check()` would offer it
 * for approval twice.
 */
export function checkNow(): void {
  if (!buildChecks()) return;
  if (pendingUpdate) {
    setState({ status: 'downloaded', version: pendingUpdate.version });
    return;
  }
  if (downloadPromise && availableUpdate) {
    setState({ status: 'downloading', version: availableUpdate.version });
    return;
  }
  void runManualCheck();
}

async function runManualCheck(): Promise<void> {
  setState({ status: 'checking' });
  let update: Update | null;
  try {
    update = await performCheck();
  } catch (e) {
    console.error('[updater] Check failed:', e);
    setState({ status: 'check-failed' });
    return;
  }
  // An update found is already offered (`performCheck`).
  if (update) return;
  currentVersion ||= await getAppVersion().catch(() => '');
  showBriefly({ status: 'up-to-date', version: currentVersion });
}

/** Quit now and relaunch; the quit installs the pending update on its way out
 *  (docs/specs/auto-update.md → "Quit-time install"). A host refusal becomes
 *  `restart-refused`, leaving the update pending. */
export function restartToUpdate(): void {
  getPlatformOrNull()?.requestAppRestart?.()
    .then((relaunches) => {
      if (!relaunches) console.warn('[updater] Joined a quit already under way; Dormouse will not relaunch.');
    })
    .catch((e) => {
      console.error('[updater] Restart failed:', e);
      // Honor a dismissal that arrived while the host was answering.
      if (state.status === 'downloaded') {
        setState({
          status: 'restart-refused',
          version: state.version,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    });
}

export function openChangelog(): void {
  void openCurrentVersionChangelog();
}

async function openCurrentVersionChangelog(): Promise<void> {
  const version = (await getAppVersion()).trim();
  openUrl(`https://dormouse.sh/changelog/after/${encodeURIComponent(version)}`, 'changelog');
}

export async function buildDebugReport(error: string, toVersion: string): Promise<string> {
  const [fromVersion, logTail] = await Promise.all([
    getAppVersion().catch(() => ''),
    BROWSER_DEV_HOST
      ? Promise.resolve('(update log is unavailable in browser dev)')
      : invokeTauri<string>('read_update_log').catch((e) => `(failed to read log: ${String(e)})`),
  ]);

  return [
    `**App version**: ${fromVersion} → ${toVersion}`,
    `**Platform**: ${PLATFORM_STRING}`,
    `**Error**: ${error || '(none captured)'}`,
    '',
    '**Recent log:**',
    '```',
    logTail.trimEnd(),
    '```',
    '',
  ].join('\n');
}

export function openIssueSearch(error: string): void {
  // First ~80 chars of the error, no quoting — lets GitHub fuzzy-match.
  const keywords = error.slice(0, 80);
  openUrl(
    `${GITHUB_REPO_URL}/issues?q=is%3Aissue+${encodeURIComponent(keywords)}`,
    'issue search',
  );
}

// --- Lifecycle ---

export function startUpdateCheck(): void {
  if (BROWSER_DEV_HOST) return;
  // docs/specs/auto-update.md → "How it works".
  if (bakedRelayMode() !== 'hosted') {
    console.info('[updater] a self-host build: no update check');
    return;
  }
  // The reminder again, hourly, whatever the policy: it contacts nothing, and
  // never checks.
  reminderTimer ??= setInterval(() => remindIfDue(Date.now()), HOUR_MS);
  void runUpdateCheck().catch((e) => console.error('[updater] Startup failed:', e));
}

async function runUpdateCheck(): Promise<void> {
  currentVersion = await getAppVersion();

  let hadFailureMarker = false;

  // Check for post-install markers from a previous session
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      localStorage.removeItem(STORAGE_KEY);
      // Narrowed once, so every field below is an ordinary read. JSON cannot
      // produce an explicitly-present `undefined`, so `=== undefined` and
      // `!(key in marker)` agree here.
      const marker = JSON.parse(raw) as Record<string, unknown> | null;
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
        throw new Error('Invalid update marker');
      }
      if (marker.failed === true
        && typeof marker.version === 'string' && marker.version
        && (marker.error === undefined || typeof marker.error === 'string')) {
        setState({
          status: 'post-update-failure',
          version: marker.version,
          error: marker.error as string | undefined,
        });
        hadFailureMarker = true;
      } else if (marker.failed === undefined
        && typeof marker.from === 'string' && marker.from
        && typeof marker.to === 'string' && marker.to) {
        // The marker precedes install because Windows kills this process. Only
        // the version running on the next launch confirms installation worked.
        if (marker.to !== currentVersion) {
          setState({
            status: 'post-update-failure',
            version: marker.to,
            error: `Expected version ${marker.to} after update, but running ${currentVersion}.`,
          });
          hadFailureMarker = true;
        } else {
          showBriefly({ status: 'post-update-success', from: marker.from, to: marker.to });
        }
      }
    }
  } catch {
    // Corrupt marker — ignore
  }

  // Skip the auto-update probe on a failure-marker launch: prompting for the
  // same version that just failed would unmount any open debug dialog.
  if (hadFailureMarker) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 5_000));

  // Read at the check, so a change made meanwhile counts
  // (`docs/specs/remote-network.md` → "Updates").
  const policy = await readNetworkPolicy();
  // A manual approval during the delay or the policy read owns this session's
  // update; checking again would offer it for approval a second time.
  if (policy && checksForUpdates(policy) && !approvedUpdate()) {
    // An update found is offered by `performCheck`.
    await performCheck().catch((e) => console.error('[updater] Check failed:', e));
  }
  // Due only where no check has succeeded for a week: automatic checks off, or failing.
  remindIfDue(Date.now());
}

/**
 * The network policy, from the Burrow service that holds it. **`null` — read as
 * Nothing — for a read that fails**, or a platform with no service.
 */
async function readNetworkPolicy(): Promise<NetworkPolicy | null> {
  try {
    const result = await getPlatformOrNull()?.burrow?.command('networkPolicy');
    if (isNetworkPolicyResult(result)) return result.policy;
    console.warn('[updater] No network policy to read; not checking.');
  } catch (e) {
    console.warn('[updater] Could not read the network policy; not checking:', e);
  }
  return null;
}

async function downloadApprovedUpdate(): Promise<void> {
  if (downloadPromise) {
    await downloadPromise;
    return;
  }

  const update = availableUpdate;
  if (!update) return;

  setState({ status: 'downloading', version: update.version });

  downloadPromise = (async () => {
    try {
      await update.download();
      availableUpdate = null;
      pendingUpdate = update;
      // Honor a dismissal that arrived during the download — install still
      // happens on quit because pendingUpdate is set.
      if (state.status === 'downloading') {
        setState({ status: 'downloaded', version: update.version });
      }
    } catch (e) {
      console.error('[updater] Download failed:', e);
      if (state.status === 'downloading' && availableUpdate === update) {
        setState({ status: 'available', version: update.version });
      }
    } finally {
      downloadPromise = null;
    }
  })();

  await downloadPromise;
}

// --- Test support ---

/** @internal Reset all module state for testing. */
export function _resetForTesting(): void {
  state = { status: 'idle' };
  availableUpdate = null;
  pendingUpdate = null;
  downloadPromise = null;
  currentVersion = '';
  checkPromise = null;
  checksSnapshot = null;
  if (reminderTimer) clearInterval(reminderTimer);
  reminderTimer = null;
  listeners.clear();
}

// --- Quit-time install ---
//
// Called by the quit orchestrator (standalone/src/quit.ts) as the final
// teardown step, strictly *after* the final session save has landed. Exiting
// the process is quit_proceed's job in Rust, which runs after this returns.

/** Whether an approved, downloaded update is waiting to install at quit. */
export function hasPendingUpdate(): boolean {
  return pendingUpdate !== null;
}

/** Install the pending update; ordering and Windows constraints are owned by
 *  docs/specs/auto-update.md ("Quit-time install"). No-op in Vite dev mode. */
export async function installPendingUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;

  if (shouldSkipInstallInDev()) {
    console.warn('[updater] Skipping update install in dev mode. Use a packaged app to test install.');
    pendingUpdate = null;
    return;
  }

  try {
    // Write success marker BEFORE install — on Windows install() never returns
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      from: currentVersion,
      to: update.version,
    }));
    // Windows refuses to overwrite the native modules the live sidecar has
    // loaded, so NSIS fails unless the sidecar is fully gone first. macOS/Linux
    // replace open files in place. Why, in full: docs/specs/auto-update.md
    // ("Sidecar teardown on Windows").
    if (IS_WINDOWS) {
      await invokeTauri('kill_sidecar_now');
    }
    await update.install();
  } catch (e) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      failed: true,
      version: update.version,
      error: String(e),
    }));
    console.error('[updater] Install failed:', e);
  }

  pendingUpdate = null;
}
