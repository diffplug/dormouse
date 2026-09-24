/** Resolve only the Playwright client belonging to a validated CLI installation. */
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as Playwright from 'playwright-core';
import { resolveBinaryPath, DEFAULT_PLAYWRIGHT_BIN, PLAYWRIGHT_BIN_ENV } from 'dor-lib-common';
import { isAllowedPlaywrightBinary } from '../lib/agent-browser-binary';

export interface PlaywrightInstall { binary: string; libraryPath: string; library: typeof Playwright }

// Successful resolutions, keyed by every input the search reads. The host
// resolves on each request, screenshots included, and a miss costs a PATH walk,
// realpaths, package reads and a `require`.
const installs = new Map<string, PlaywrightInstall>();

export function resolvePlaywrightInstall(hint?: string): PlaywrightInstall {
  const configured = process.env[PLAYWRIGHT_BIN_ENV];
  const cacheKey = JSON.stringify([hint ?? null, configured ?? null, process.env.PATH ?? null]);
  const cached = installs.get(cacheKey);
  // A cached install is good while its launcher exists; an uninstall re-searches.
  if (cached && existsSync(cached.binary)) return cached;
  installs.delete(cacheKey);
  const install = findPlaywrightInstall(hint, configured);
  installs.set(cacheKey, install);
  return install;
}

function findPlaywrightInstall(hint: string | undefined, configured: string | undefined): PlaywrightInstall {
  const candidates = [isAllowedPlaywrightBinary(hint, configured) ? hint : undefined, configured, DEFAULT_PLAYWRIGHT_BIN];
  for (const candidate of candidates) {
    if (!candidate) continue;
    // The file `dor playwright` spawns for this name (docs/specs/dor-cli.md → "Spawning
    // External Binaries"); an explicit path comes back verbatim, unchecked.
    const binary = resolveBinaryPath(candidate, process.env);
    if (binary === undefined || !existsSync(binary)) continue;
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
  throw new Error(`playwright CLI installation unavailable or incompatible. Install npm i -g @playwright/cli (tested with 0.1.19), or set ${PLAYWRIGHT_BIN_ENV}.`);
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
