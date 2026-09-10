/** Resolve only the Playwright client belonging to a validated CLI installation. */
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as Playwright from 'playwright-core';
import { isAllowedPlaywrightBinary } from '../lib/agent-browser-binary';

export interface PlaywrightInstall { binary: string; libraryPath: string; library: typeof Playwright }
export function resolvePlaywrightInstall(hint?: string): PlaywrightInstall {
  const configured = process.env.DORMOUSE_PLAYWRIGHT_BIN;
  const candidates = [isAllowedPlaywrightBinary(hint, configured) ? hint : undefined, configured, 'playwright-cli'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const paths = candidate.includes('/') || candidate.includes('\\') ? [candidate] : (process.env.PATH ?? '').split(path.delimiter).flatMap(dir => process.platform === 'win32' ? ['.cmd', '.exe', '.bat'].map(ext => path.join(dir, candidate + ext)) : [path.join(dir, candidate)]);
    for (const binary of paths) {
      if (!existsSync(binary)) continue;
      let dir = path.dirname(realpathSync(binary));
      // npm symlinks, pnpm .bin shims, and Windows npm .cmd launchers.
      for (let depth = 0; depth < 6; depth++) {
        for (const root of [dir, path.join(dir, 'node_modules', '@playwright', 'cli'), path.join(dir, '..', '@playwright', 'cli')]) {
          try {
            const pkg = path.join(root, 'package.json');
            if (JSON.parse(readFileSync(pkg, 'utf8')).name !== '@playwright/cli') continue;
            const require = createRequire(pkg);
            const libraryPath = path.dirname(require.resolve('playwright-core/package.json'));
            const library = require('playwright-core') as typeof Playwright;
            if (typeof library.chromium?.connect !== 'function') continue;
            return { binary, libraryPath: realpathSync(libraryPath), library };
          } catch { /* Try the next installation layout. */ }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  throw new Error('Playwright CLI installation unavailable or incompatible. Install npm i -g @playwright/cli (tested with 0.1.19), or set DORMOUSE_PLAYWRIGHT_BIN.');
}
export function playwrightWorkspace(cwd: string): string | undefined {
  let dir = realpathSync(cwd);
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, '.playwright'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
