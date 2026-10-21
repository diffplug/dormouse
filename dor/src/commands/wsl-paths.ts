/**
 * Paths across the WSL boundary for `dor agent-browser` / `dor playwright`:
 * called from WSL, `dor` and the provider CLI it runs are Windows processes
 * (docs/specs/dor-cli.md → "WSL interop"). An absolute Linux path the caller
 * names must reach the CLI as a Windows path, and a Windows path the CLI
 * reports must come back as one the caller's Linux tools open.
 */
import path from 'node:path';
import { isDirectory } from 'dor-lib-common';

/** Where a provider's arguments may name files. */
export interface PathArgs {
  /** Verbs whose positional arguments may be paths, and whose output may report one. */
  readonly verbs: ReadonlySet<string>;
  /** Options whose value may be a path. */
  readonly flags: ReadonlySet<string>;
}

/** The WSL distribution `dor` was called from: the launcher forwards it. */
export function callerWslDistro(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const distro = env.WSL_DISTRO_NAME;
  return distro && /^[A-Za-z0-9._-]+$/.test(distro) ? distro : undefined;
}

/** `/mnt/c/x` → `C:\x` (WSL's default automount), else `\\wsl.localhost\<distro>\...`. */
export function windowsPathOf(linux: string, distro: string): string {
  const mount = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(linux);
  if (mount) return `${mount[1]!.toUpperCase()}:\\${(mount[2] ?? '').replaceAll('/', '\\')}`;
  return `\\\\wsl.localhost\\${distro}${linux.replaceAll('/', '\\')}`;
}

/**
 * An absolute Linux path in a path position, as a Windows path. Only one whose
 * directory exists is translated, so an XPath (`/html/body/input`) or a regex
 * literal passes through unchanged.
 */
function windowsArg(value: string, distro: string): string {
  if (!/^\/[^/]/.test(value)) return value;
  const windows = windowsPathOf(value, distro);
  return isDirectory(path.win32.dirname(windows)) ? windows : value;
}

/** `args` with each absolute Linux path in a path position made a Windows path. */
export function windowsPathArgs(args: readonly string[], verb: string | undefined, paths: PathArgs, distro: string): string[] {
  const positional = verb !== undefined && paths.verbs.has(verb);
  return args.map((arg, i) => {
    const eq = arg.indexOf('=');
    if (arg.startsWith('-') && eq > 0 && paths.flags.has(arg.slice(0, eq))) return arg.slice(0, eq + 1) + windowsArg(arg.slice(eq + 1), distro);
    if (i > 0 && paths.flags.has(args[i - 1]!)) return windowsArg(arg, distro);
    return positional && !arg.startsWith('-') ? windowsArg(arg, distro) : arg;
  });
}

// A path the Windows CLI printed: this distro's UNC share, or a drive path.
// Single or JSON-doubled separators; ends at whitespace or a quote.
const WSL_SHARE = /\\{2,4}wsl(?:\.localhost|\$)\\{1,2}([A-Za-z0-9._-]+)((?:\\{1,2}[^\\\s"'<>|]+)*)/gi;
const DRIVE = /\b([A-Za-z]):((?:\\{1,2}[^\\\s"'<>|:*?]+)+|\\{1,2})/g;

/** `text` with each Windows path a WSL caller can reach written as a Linux path. */
export function linuxPathText(text: string, distro: string): string {
  const linux = (rest: string) => rest.split(/\\{1,2}/).join('/');
  return text
    .replace(WSL_SHARE, (match, name: string, rest: string) => name.toLowerCase() === distro.toLowerCase() ? linux(rest) || '/' : match)
    .replace(DRIVE, (_match, drive: string, rest: string) => `/mnt/${drive.toLowerCase()}${linux(rest)}`.replace(/\/$/, ''));
}
