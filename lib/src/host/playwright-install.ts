/** Resolve only the Playwright client belonging to a validated CLI installation. */
import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { localRealpathSync } from 'dor-lib-common/local-path';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as Playwright from 'playwright-core';
import { envValue, resolveBinaryPath, DEFAULT_PLAYWRIGHT_BIN, PLAYWRIGHT_BIN_ENV } from 'dor-lib-common';
import { isAllowedPlaywrightBinary } from '../lib/agent-browser-binary';

export interface PlaywrightInstall { binary: string; libraryPath: string; library: typeof Playwright }

// Successful resolutions, keyed by every input the search reads. The host
// resolves on each request, screenshots included, and a miss costs a PATH walk,
// realpaths, package reads and a `require`.
const installs = new Map<string, PlaywrightInstall>();

export function resolvePlaywrightInstall(hint?: string, env: NodeJS.ProcessEnv = process.env): PlaywrightInstall {
  const configured = env[PLAYWRIGHT_BIN_ENV];
  const isWindows = process.platform === 'win32';
  const cacheKey = JSON.stringify([hint ?? null, configured ?? null, envValue(env, 'PATH', isWindows) ?? null, envValue(env, 'PATHEXT', isWindows) ?? null]);
  const cached = installs.get(cacheKey);
  // A cached install is good while its launcher exists; an uninstall re-searches.
  if (cached && existsSync(cached.binary)) return cached;
  installs.delete(cacheKey);
  const install = findPlaywrightInstall(hint, configured, env);
  installs.set(cacheKey, install);
  return install;
}

function findPlaywrightInstall(hint: string | undefined, configured: string | undefined, env: NodeJS.ProcessEnv): PlaywrightInstall {
  const candidates = [isAllowedPlaywrightBinary(hint, configured) ? hint : undefined, configured, DEFAULT_PLAYWRIGHT_BIN];
  for (const candidate of candidates) {
    if (!candidate) continue;
    // The file `dor playwright` spawns for this name (docs/specs/dor-cli.md → "Spawning
    // External Binaries"); an absolute explicit path comes back verbatim,
    // unchecked, and a relative one not at all.
    const binary = resolveBinaryPath(candidate, env);
    if (binary === undefined) continue;
    // Every path here resolves through `localRealpathSync`, which refuses a
    // link to a share or device path before following it.
    const launcher = localRealpathOrUndefined(binary);
    const cliRoot = launcher === undefined ? undefined : launcherPackage(launcher);
    if (cliRoot === undefined) continue;
    const coreDirs = playwrightCoreDirs(cliRoot);
    if (coreDirs.length === 0) continue;
    try {
      const require = createRequire(path.join(cliRoot, 'package.json'));
      // Node's own lookup continues into every ancestor's node_modules, so accept
      // only the copy that belongs to this installation.
      const libraryPath = localRealpathOrUndefined(path.dirname(require.resolve('playwright-core/package.json')));
      if (libraryPath === undefined || !coreDirs.some(dir => samePath(dir, libraryPath))) continue;
      const library = require('playwright-core') as typeof Playwright;
      if (typeof library.chromium?.connect !== 'function') continue;
      return { binary, libraryPath, library };
    } catch { /* Try the next candidate. */ }
  }
  throw new Error(`playwright CLI installation unavailable or incompatible. Install npm i -g @playwright/cli (tested with 0.1.19), or set ${PLAYWRIGHT_BIN_ENV}.`);
}

/**
 * The real path of the `@playwright/cli` package `launcher` (already a real
 * path) belongs to, or undefined. Only layouts a package manager produces are
 * accepted, and never a directory above the installation: a launcher that does
 * not match one fails rather than searching upward.
 */
function launcherPackage(launcher: string): string | undefined {
  const dir = path.dirname(launcher);
  // The package's own bin file: an npm, yarn, or bun bin symlink (whose target
  // may sit in a subdirectory of the package), or a linked checkout.
  const own = binOwner(launcher) ?? (isCliPackage(dir, launcher) ? dir : undefined);
  if (own !== undefined) return own;
  // An npm launcher beside its node_modules (`npm i -g` on Windows), or a
  // node_modules/.bin shim (pnpm, and npm or yarn on Windows).
  const besides = [path.join(dir, 'node_modules', '@playwright', 'cli')];
  if (path.basename(dir) === '.bin' && path.basename(path.dirname(dir)) === 'node_modules') {
    besides.push(path.join(path.dirname(dir), '@playwright', 'cli'));
  }
  for (const root of besides) {
    const real = localRealpathOrUndefined(root);
    if (real !== undefined && isCliPackage(real)) return real;
  }
  // A shim naming a bin file below its own directory (`pnpm add -g`).
  const target = shimTarget(launcher);
  return target === undefined ? undefined : binOwner(target);
}

/** The package root when `file` is the bin of an `@playwright/cli` installed under node_modules. */
function binOwner(file: string): string | undefined {
  const parts = file.split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || parts[at + 1] !== '@playwright' || parts[at + 2] !== 'cli') return undefined;
  const root = parts.slice(0, at + 3).join(path.sep);
  return isCliPackage(root, file) ? root : undefined;
}

/** Whether `root` holds `@playwright/cli`, and `bin` (when given) is one of its bin files. */
function isCliPackage(root: string, bin?: string): boolean {
  let pkg: { name?: unknown; bin?: unknown };
  try { pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return false; }
  if (pkg.name !== '@playwright/cli') return false;
  if (bin === undefined) return true;
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : pkg.bin && typeof pkg.bin === 'object' ? Object.values(pkg.bin) : [];
  return bins.some(entry => typeof entry === 'string' && samePath(path.resolve(root, entry), bin));
}

// The quoted script path a pnpm, cmd-shim, or PowerShell shim runs, relative to
// the shim's own directory.
const SHIM_TARGET = /"(?:\$basedir|%~dp0|%dp0%)[\\/]([^"]*node_modules[^"]*)"/g;
const MAX_SHIM_BYTES = 64 * 1024;

/**
 * The bin file a shim runs, when it names exactly one script and that script
 * lies below the shim's own directory. The shim is the launcher itself, so
 * reading it trusts nothing the spawn does not.
 */
function shimTarget(shim: string): string | undefined {
  let text: string;
  try {
    if (statSync(shim).size > MAX_SHIM_BYTES) return undefined;
    text = readFileSync(shim, 'utf8');
  } catch { return undefined; }
  const targets = new Set(Array.from(text.matchAll(SHIM_TARGET), match => match[1]));
  if (targets.size !== 1) return undefined;
  const segments = [...targets][0].split(/[\\/]/);
  if (segments.includes('..')) return undefined;
  return localRealpathOrUndefined(path.join(path.dirname(shim), ...segments));
}

/**
 * Where an installation's `playwright-core` may live: nested in the CLI package,
 * or beside it in the same node_modules (npm and yarn hoisting, pnpm's linked
 * dependencies).
 */
function playwrightCoreDirs(cliRoot: string): string[] {
  const dirs = [path.join(cliRoot, 'node_modules', 'playwright-core')];
  const scope = path.dirname(cliRoot);
  const modules = path.dirname(scope);
  if (path.basename(scope) === '@playwright' && path.basename(modules) === 'node_modules') dirs.push(path.join(modules, 'playwright-core'));
  return dirs.flatMap(dir => localRealpathOrUndefined(dir) ?? []);
}

function localRealpathOrUndefined(file: string): string | undefined {
  try { return localRealpathSync(file).path; } catch { return undefined; }
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
