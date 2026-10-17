/**
 * The canonical path of an existing local directory, for the terminal context
 * directory actions and Workspace auto-naming's git lookup
 * (`docs/specs/security-local.md` → "Terminal context directory actions").
 * Both take a terminal-reported cwd, so any program names the path.
 *
 * `realpath` cannot do this: it reaches each link's target while resolving it
 * (the native one opens it, the JS one `stat`s it), so a local symlink or
 * junction to `\\host\share` would reach that host before its result could be
 * checked. This resolves one component at a time with `lstat` and `readlink`,
 * which never follow a link, and refuses a link whose target is a share or
 * device path before anything follows it.
 *
 * Bundled into the standalone sidecar through `git-info.cjs` and into VS Code's
 * PTY host, which hand it to `pty-core`.
 */
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { isUncOrDevicePath } from 'dor-lib-common/browser-providers';

/** Links followed before giving up, as `ELOOP` does. */
const MAX_LINKS = 40;

/** Absolute, link-free, and an existing directory reached without touching a
 *  share or device path; else null. */
export async function canonicalLocalDirectory(input: unknown): Promise<string | null> {
  if (typeof input !== 'string' || !path.isAbsolute(input) || isUncOrDevicePath(input)) return null;
  // `..` is resolved lexically first, as `realpath` does.
  const start = path.resolve(input);
  let current = path.parse(start).root;
  let pending = components(start, current);
  let links = 0;
  try {
    while (pending.length > 0) {
      const next = path.join(current, pending.shift()!);
      if (!(await lstat(next)).isSymbolicLink()) {
        current = next;
        continue;
      }
      if (++links > MAX_LINKS) return null;
      const target = await readlink(next);
      if (isUncOrDevicePath(target)) return null;
      // A relative target resolves against the link's own directory, which
      // `current` already is, free of links.
      const resolved = path.resolve(current, target);
      // The target may itself pass through links, so walk it from its root.
      current = path.parse(resolved).root;
      pending = [...components(resolved, current), ...pending];
    }
    return (await lstat(current)).isDirectory() ? current : null;
  } catch {
    return null;
  }
}

function components(absolute: string, root: string): string[] {
  return absolute.slice(root.length).split(path.sep).filter(Boolean);
}
