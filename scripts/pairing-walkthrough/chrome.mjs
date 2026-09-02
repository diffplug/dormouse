/**
 * The Pocket side's own Chrome, launched by the harness rather than by
 * `agent-browser` (`scripts/pairing-walkthrough/README.md` → Stage (b) notes).
 *
 * `agent-browser` exposes no way to pass launch flags, and the whole point of
 * the Pocket browser is three of them — the fake camera, its file, and a
 * debugging port to attach to. So the harness launches Chrome itself and
 * `agent-browser --session <s> connect <port>` attaches afterwards.
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

import { spawnLogged, waitFor } from './proc.mjs';

/** The binary inside a Chrome-for-Testing directory, per platform. */
const CFT_SUFFIXES = [
  join('Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
  join('chrome-linux64', 'chrome'),
  join('chrome-linux', 'chrome'),
];

/**
 * Where a Chrome might be, in the order this harness prefers one.
 *
 * **`agent-browser`'s own download leads**, because it is the browser the Host
 * side is already being driven with — one Chrome for both sides means one set
 * of behaviours to explain. The Playwright cache is second because
 * `@playwright/test` may have put a build there, but only as a fallback: a
 * cached Chrome for Testing on macOS can re-exec itself into whichever bundle
 * `com.google.chrome.for.testing` last ran from and then ignore
 * `--remote-debugging-port` outright, which reads as a Chrome that launched and
 * never opened its port. The env overrides come first either way.
 */
function candidates() {
  const found = [];
  const push = (path, from) => {
    if (path) found.push({ path, from });
  };
  push(process.env.AGENT_BROWSER_CHROME, 'AGENT_BROWSER_CHROME');
  push(process.env.CHROME_PATH, 'CHROME_PATH');
  for (const path of agentBrowserChromes()) push(path, "agent-browser's own download");
  for (const path of playwrightCacheChromes()) push(path, 'the Playwright browser cache');
  if (platform() === 'darwin') {
    push(
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications',
    );
    push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications');
  } else {
    for (const path of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
      push(path, '/usr/bin');
    }
  }
  return found;
}

/** Every `~/.agent-browser/browsers/chrome-<version>`, newest version first. */
function agentBrowserChromes() {
  const root = join(process.env.AGENT_BROWSER_HOME || join(homedir(), '.agent-browser'), 'browsers');
  return versionedChromes(root, /^chrome-(\d[\d.]*)$/, (name) => name.slice('chrome-'.length));
}

/** Every Chrome for Testing in the Playwright cache, newest revision first. */
function playwrightCacheChromes() {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (platform() === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : join(homedir(), '.cache', 'ms-playwright'));
  return versionedChromes(root, /^chromium-(\d+)$/, (name) => name.slice('chromium-'.length));
}

/**
 * Directories under `root` whose names match `re`, newest first, expanded into
 * every plausible binary path. Ordered by version rather than by name, since
 * `chrome-9…` sorts after `chrome-150…` as a string.
 */
function versionedChromes(root, re, versionOf) {
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const compare = (a, b) => {
    const left = versionOf(a).split('.').map(Number);
    const right = versionOf(b).split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const delta = (right[i] ?? 0) - (left[i] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  };
  return entries
    .filter((name) => re.test(name))
    .sort(compare)
    .flatMap((name) => CFT_SUFFIXES.map((suffix) => join(root, name, suffix)));
}

/** The first Chrome that exists, or a message naming everywhere that was looked. */
export function resolveChrome() {
  const tried = candidates();
  const hit = tried.find(({ path }) => existsSync(path));
  if (hit) return hit;
  throw new Error(
    'no Chrome found for the Pocket browser. Tried:\n' +
      tried.map(({ path, from }) => `  ${path}  (${from})`).join('\n') +
      '\nInstall one with `agent-browser install`, or set AGENT_BROWSER_CHROME.',
  );
}

/**
 * Launch an isolated Chrome for the Pocket side and wait for its DevTools port.
 *
 * **A profile of its own, under the run directory.** The Pocket side is a
 * different device from the Host's browser in every way that matters here — its
 * own passkeys, its own IndexedDB, its own service worker — so sharing a
 * profile with anything would make a second run start half-paired.
 *
 * The fake camera is two flags plus a file: `--use-fake-ui-for-media-stream`
 * auto-accepts the permission prompt (headless has no one to click it), and
 * `--use-file-for-fake-video-capture` replaces the synthetic rolling pattern
 * with the Y4M the QR step wrote. Chrome opens that file at `getUserMedia`
 * time, not at launch, so it may be rewritten right up to the scan.
 */
export async function launchChrome({
  binary,
  port,
  userDataDir,
  fakeVideoFile,
  width,
  height,
  logPath,
}) {
  const handle = spawnLogged(
    binary,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${fakeVideoFile}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      'about:blank',
    ],
    { logPath, prefix: 'pocket-chrome' },
  );
  const version = await waitFor(
    async () => {
      if (handle.exit) throw new Error(`Chrome exited (see ${logPath})`);
      const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
      return res?.ok ? res.json() : null;
    },
    { what: `Chrome's DevTools port :${port}`, timeoutMs: 60_000, intervalMs: 200 },
  );
  return { handle, port, version };
}
