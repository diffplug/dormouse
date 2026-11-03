import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where a browser CLI and its launch shell run when no `dor` command named a
 * project: a directory Dormouse owns and leaves empty, since a CLI reads project
 * config from its cwd. Never the host's own cwd, which can be a workspace folder.
 * The same path every launch, because a Playwright binding pins it across
 * restarts. Throws rather than falling back when it cannot be made.
 */
export function neutralBrowserCwd(): string {
  const dir = join(homedir(), '.dormouse', 'browser-cwd');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
