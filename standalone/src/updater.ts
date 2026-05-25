import { useSyncExternalStore } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';
import { PLATFORM_STRING } from 'dormouse-lib/lib/platform';
import type { UpdateBannerState } from './UpdateBanner';

const GITHUB_REPO_URL = 'https://github.com/diffplug/dormouse';

function openUrl(url: string, context: string): void {
  open(url).catch((e) => console.error(`[updater] Failed to open ${context}:`, e));
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
  const version = (await getVersion()).trim();
  openUrl(`https://dormouse.sh/changelog/after/${encodeURIComponent(version)}`, 'changelog');
}

export async function buildDebugReport(error: string, toVersion: string): Promise<string> {
  const [fromVersion, logTail] = await Promise.all([
    getVersion().catch(() => ''),
    invoke<string>('read_update_log').catch((e) => `(failed to read log: ${String(e)})`),
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
  void runUpdateCheck();
}

async function runUpdateCheck(): Promise<void> {
  currentVersion = await getVersion();

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
    registerCloseHandler();
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 5_000));

  try {
    const update = await check();
    if (!update) {
      registerCloseHandler();
      return;
    }

    availableUpdate = update;
    setState({ status: 'available', version: update.version });
  } catch (e) {
    console.error('[updater] Check failed:', e);
  }

  registerCloseHandler();
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
  closeHandlerRegistered = false;
  listeners.clear();
}

// --- Quit-time install ---

let closeHandlerRegistered = false;

function registerCloseHandler(): void {
  if (closeHandlerRegistered) return;
  closeHandlerRegistered = true;

  getCurrentWindow().onCloseRequested(async (event) => {
    const update = pendingUpdate;
    if (!update) return;

    if (shouldSkipInstallInDev()) {
      console.warn('[updater] Skipping update install in dev mode. Use a packaged app to test install.');
      pendingUpdate = null;
      return;
    }

    event.preventDefault();

    try {
      // Write success marker BEFORE install — on Windows, NSIS force-kills the process
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        from: currentVersion,
        to: update.version,
      }));
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
    await getCurrentWindow().close();
  });
}
