// Shared plumbing for the two dev runners beside this file — `dev-standalone.mjs`
// (native Tauri) and `dev-agent-browser.mjs` (innerdogfood). Both scope a dev run
// to one worktree and both own Vite in-process, so the rules for deriving the
// worktree id and for binding/advertising the dev server live here once.
import { createServer } from 'vite';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const standaloneDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(standaloneDir, '..');

// The canonical path, so a worktree reached through a symlink is the same run
// rather than a second one with its own ports, app data and browser session.
export async function worktreeId() {
  return createHash('sha256').update(await realpath(repoRoot)).digest('hex').slice(0, 16);
}

// Own Vite in this process: listen() reports the actual bound port and close()
// tears down its watchers too. A TCP readiness probe could find another run.
// `define` is injected into the page only, never process.env.
export async function startDevVite(define) {
  const vite = await createServer({
    root: standaloneDir,
    define,
    server: {
      // Bind port 0 directly: probing and then releasing a free port races
      // other runs. strictPort so a pinned port that is taken fails the run
      // instead of silently drifting onto its neighbour's.
      host: '127.0.0.1',
      port: Number(process.env.DORMOUSE_BROWSER_DEV_VITE_PORT || 0),
      strictPort: true,
      // Share Vite's listener, including when TAURI_DEV_HOST is inherited.
      hmr: { host: 'localhost', port: 0, protocol: 'ws' },
    },
  });
  await vite.listen();
  return { vite, origin: `http://localhost:${vite.httpServer.address().port}` };
}
