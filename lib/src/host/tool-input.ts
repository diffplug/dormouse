import { realpath, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasControlOrFormatCharacters, hasShellInputControls } from 'dor/commands/shell-quote';
import { CONTROL_OR_FORMAT_TEXT, resolveDedupeKey, substituteToolTokens, ToolFileError, usesTarget, type ToolEntry } from './tool-registry';

/** What one invocation's inputs resolved an entry to: the argv (or literal
 *  shell string) to run, and the rendered dedupe key. */
export interface ToolInput {
  readonly run: string | readonly string[];
  readonly key: string[] | null;
}

/** A target is one existing regular file or directory on this host, spelled
 * as a path or a local `file:` URL. Resolve symlinks before keying, so two
 * paths to the same document reveal the same Tool. */
export async function resolveLocalToolTarget(input: string, cwd: string): Promise<{ path: string; directory: boolean }> {
  if (hasShellInputControls(input) || hasShellInputControls(cwd)) {
    throw new ToolFileError('local paths cannot contain terminal control characters');
  }
  if (!input) throw new ToolFileError('expected a local path, not a URL or Surface handle');
  const local = !isAbsolute(input) && /^[a-z][a-z\d+.-]*:/i.test(input) ? localFileUrlPath(input) : input;
  // Again once decoded: a `file:` URL's escapes can spell controls, which a
  // filesystem error below would echo.
  if (hasShellInputControls(local)) throw new ToolFileError('local paths cannot contain terminal control characters');
  let path: string;
  try {
    path = await realpath(resolve(cwd, local));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new ToolFileError(`no such file or folder: ${input}`);
    throw error;
  }
  if (hasShellInputControls(path)) throw new ToolFileError('local paths cannot contain terminal control characters');
  const stats = await stat(path);
  if (!stats.isFile() && !stats.isDirectory()) throw new ToolFileError(`not a regular file or folder: ${input}`);
  return { path, directory: stats.isDirectory() };
}

/** A `file:` URL as a path on this machine: only a URL whose host is empty,
 * `localhost`, or this machine's name — whole or before its first dot — names
 * a file here (`docs/specs/dor-tool.md` -> Declaring tools). Every other URL,
 * and anything else scheme-shaped such as a Surface handle, is refused. */
function localFileUrlPath(input: string): string {
  let url: URL | null = null;
  try {
    url = new URL(input);
  } catch {
    // Not a URL at all: refused below.
  }
  if (url?.protocol !== 'file:') throw new ToolFileError('expected a local path or file: URL, not another URL or a Surface handle');
  if (!namesThisHost(url.hostname)) throw new ToolFileError(`not a file on this machine: ${input}`);
  url.hostname = '';
  try {
    return fileURLToPath(url);
  } catch {
    // An encoded separator, or a Windows URL without a drive or share.
    throw new ToolFileError(`not a local file path: ${input}`);
  }
}

/** The URL parser has already lowercased `host` and turned `localhost` into
 * the empty host. */
function namesThisHost(host: string): boolean {
  if (host === '') return true;
  const own = hostname().toLowerCase();
  const short = (value: string) => value.split('.')[0];
  return host === own || host === short(own) || short(host) === own;
}

export async function resolveToolInput(
  entry: Pick<ToolEntry, 'name' | 'run' | 'dedupeTemplate'>,
  context: { cwd: string; projectRoot: string | null; args: readonly string[] },
): Promise<ToolInput> {
  const { args } = context;
  if (args.some(arg => typeof arg !== 'string' || hasControlOrFormatCharacters(arg))) {
    throw new ToolFileError(`tool arguments cannot contain ${CONTROL_OR_FORMAT_TEXT}`);
  }
  const runList = typeof entry.run === 'string' ? [] : entry.run;
  const runHasTarget = usesTarget(runList);
  const needsTarget = runHasTarget || usesTarget(entry.dedupeTemplate ?? []);
  if (needsTarget && args.length !== 1) throw new ToolFileError('$TARGET requires exactly one local file or folder argument');
  const target = needsTarget ? (await resolveLocalToolTarget(args[0], context.cwd)).path : undefined;
  const substitution = { ...context, target };
  const key = resolveDedupeKey(entry, substitution);
  if (typeof entry.run === 'string') {
    if (args.length) throw new ToolFileError(`tool '${entry.name}': use an argument-list run to accept arguments`);
    return { run: entry.run, key };
  }
  const run = runList.flatMap(arg => arg === '$ARGS' ? [...args] : [substituteToolTokens(arg, substitution, entry.name)]);
  if (!runHasTarget && !runList.includes('$ARGS')) run.push(...args);
  if (run.some(hasControlOrFormatCharacters)) throw new ToolFileError(`tool arguments cannot contain ${CONTROL_OR_FORMAT_TEXT}`);
  if (!run[0]?.trim()) throw new ToolFileError('tool argument list must name an executable');
  return { run, key };
}
