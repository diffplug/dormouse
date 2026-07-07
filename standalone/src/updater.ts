import { useSyncExternalStore } from 'react';
import { IS_WINDOWS, PLATFORM_STRING } from 'dormouse-lib/lib/platform';
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
  void runUpdateCheck();
}

async function runUpdateCheck(): Promise<void> {
  currentVersion = await getAppVersion();

  let hadFailureMarker = false;

  // Check for post-install markers from a previous session
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      localStorage.removeItem(STORAGE_KEY);
      const marker = JSON.parse(raw);
      if (marker.failed) {
        setState({
          status: 'post-update-failure',
          version: marker.version,
          error: marker.error,
        });
        hadFailureMarker = true;
      } else if (marker.from && marker.to) {
        setState({ status: 'post-update-success', from: marker.from, to: marker.to });
        setTimeout(() => {
          if (state.status === 'post-update-success') {
            setState({ status: 'idle' });
          }
        }, 10_000);
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
// The updater no longer owns a window-close handler — the quit orchestrator
// (standalone/src/quit.ts) intercepts every quit trigger and calls these as
// step (5) of its graceful teardown, strictly *after* the final session save has
// landed (docs/specs/auto-update.md, "Quit-time install"). There is no
// preventDefault or window.close() here: exiting the process is quit_proceed's
// job in Rust, which runs after this returns.

/** Whether an approved, downloaded update is waiting to install at quit. */
export function hasPendingUpdate(): boolean {
  return pendingUpdate !== null;
}

/**
 * Install the pending update. Called by the quit orchestrator after teardown +
 * the final save. Writes the success marker to localStorage *before* installing
 * (on Windows NSIS force-kills the process), kills the sidecar first on Windows
 * so NSIS can overwrite its still-loaded native modules, then installs; a throw
 * overwrites the marker with a failure entry. No-op in Vite dev mode.
 */
export async function installPendingUpdate(): Promise<void> {
  const update = pendingUpdate;
  if (!update) return;

  if (shouldSkipInstallInDev()) {
    console.warn('[updater] Skipping update install in dev mode. Use a packaged app to test install.');
    pendingUpdate = null;
    return;
  }

  try {
    // Write success marker BEFORE install — on Windows, NSIS force-kills the process
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      from: currentVersion,
      to: update.version,
    }));
    // On Windows the NSIS installer overwrites files inside the bundled
    // sidecar (e.g. node-pty's conpty.node). Windows refuses to overwrite a
    // native module the running sidecar still has loaded, which surfaces as
    // "Error opening file for writing". Kill the sidecar and wait for it to
    // fully exit before launching the installer. (On macOS/Linux open files
    // can be replaced in place, so this is Windows-only.)
    if (IS_WINDOWS) {
      await invokeTauri('kill_sidecar_now');
    }
    await update.install();
  } catch (e) {
    // Overwrite with failure marker
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      failed: true,
      version: update.version,
      error: String(e),
    }));
    console.error('[updater] Install failed:', e);
  }

  pendingUpdate = null;
}
