import { useSyncExternalStore } from 'react';
import { getPlatformOrNull, IS_WINDOWS, PLATFORM_STRING } from 'dormouse-lib/lib/platform';
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

let state: UpdateBannerState = { status: 'idle' };
let availableUpdate: Update | null = null;
let pendingUpdate: Update | null = null;
let downloadPromise: Promise<void> | null = null;
let currentVersion = '';

const listeners = new Set<() => void>();

function shouldSkipInstallInDev(): boolean {
  return import.meta.env.DEV && import.meta.env.MODE !== 'test';
}

function setState(next: UpdateBannerState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
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

// --- Actions ---

export function dismissBanner(): void {
  setState({ status: 'dismissed' });
}

export function approveUpdate(): void {
  void downloadApprovedUpdate();
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
          setState({ status: 'post-update-success', from: marker.from, to: marker.to });
          setTimeout(() => {
            if (state.status === 'post-update-success') {
              setState({ status: 'idle' });
            }
          }, 10_000);
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

  try {
    const update = await checkForUpdate();
    if (!update) {
      return;
    }

    availableUpdate = update;
    setState({ status: 'available', version: update.version });
  } catch (e) {
    console.error('[updater] Check failed:', e);
  }
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
