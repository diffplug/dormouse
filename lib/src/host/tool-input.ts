import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { resolveDedupeKey, substituteToolTokens, ToolFileError, usesTarget, type ToolEntry } from './tool-registry';

/** What one invocation's inputs resolved an entry to: the argv (or literal
 *  shell string) to run, and the rendered dedupe key. */
export interface ToolInput {
  readonly run: string | readonly string[];
  readonly key: string[] | null;
}

/** A target is one existing regular file on this host. Resolve symlinks before
 * keying, so two paths to the same document reveal the same Tool. */
export async function resolveLocalToolTarget(input: string, cwd: string): Promise<string> {
  if (!input || input.includes('\0') || (!isAbsolute(input) && /^[a-z][a-z\d+.-]*:/i.test(input))) {
    throw new ToolFileError('expected a local file path, not a URL or Surface handle');
  }
  let target: string;
  try {
    target = await realpath(resolve(cwd, input));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new ToolFileError(`no such file: ${input}`);
    throw error;
  }
  if (!(await stat(target)).isFile()) throw new ToolFileError(`not a regular file: ${input}`);
  return target;
}

export async function resolveToolInput(
  entry: Pick<ToolEntry, 'name' | 'run' | 'dedupeTemplate'>,
  context: { cwd: string; projectRoot: string | null; args: readonly string[] },
): Promise<ToolInput> {
  const { args } = context;
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new ToolFileError('invalid tool arguments');
  const runList = typeof entry.run === 'string' ? [] : entry.run;
  const runHasTarget = usesTarget(runList);
  const needsTarget = runHasTarget || usesTarget(entry.dedupeTemplate ?? []);
  if (needsTarget && args.length !== 1) throw new ToolFileError('$TARGET requires exactly one local file argument');
  const target = needsTarget ? await resolveLocalToolTarget(args[0], context.cwd) : undefined;
  const substitution = { ...context, target };
  const key = resolveDedupeKey(entry, substitution);
  if (typeof entry.run === 'string') {
    if (args.length) throw new ToolFileError(`tool '${entry.name}': use an argument-list run to accept arguments`);
    return { run: entry.run, key };
  }
  const run = runList.flatMap(arg => arg === '$ARGS' ? [...args] : [substituteToolTokens(arg, substitution, entry.name)]);
  if (!runHasTarget && !runList.includes('$ARGS')) run.push(...args);
  if (!run[0]?.trim()) throw new ToolFileError('tool argument list must name an executable');
  return { run, key };
}
