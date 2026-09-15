import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { resolveDedupeKey, ToolFileError, type ToolEntry } from './tool-registry';

/** A target is one existing regular file on this host. Resolve symlinks before
 * keying, so two paths to the same document reveal the same Tool. */
export async function resolveLocalToolTarget(input: string, cwd: string): Promise<string> {
  if (!input || input.includes('\0') || (!isAbsolute(input) && /^[a-z][a-z\d+.-]*:/i.test(input))) {
    throw new ToolFileError('expected a local file path, not a URL or Surface handle');
  }
  const target = await realpath(resolve(cwd, input));
  if (!(await stat(target)).isFile()) throw new ToolFileError(`not a regular file: ${input}`);
  return target;
}

export async function resolveToolInput(
  entry: Pick<ToolEntry, 'name' | 'run' | 'dedupeTemplate'>,
  context: { cwd: string; projectRoot: string | null; args: readonly string[] },
): Promise<{ run: string | readonly string[]; key: string[] | null }> {
  const { args } = context;
  if (args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new ToolFileError('invalid tool arguments');
  const templates = [...(typeof entry.run === 'string' ? [] : entry.run), ...(entry.dedupeTemplate ?? [])];
  const needsTarget = templates.some(arg => /\$TARGET\b/.test(arg));
  if (needsTarget && args.length !== 1) throw new ToolFileError('$TARGET requires exactly one local file argument');
  const target = needsTarget ? await resolveLocalToolTarget(args[0], context.cwd) : undefined;
  const key = resolveDedupeKey(entry, { ...context, target });
  if (typeof entry.run === 'string') {
    if (args.length) throw new ToolFileError(`tool '${entry.name}': use an argument-list run to accept arguments`);
    return { run: entry.run, key };
  }
  const run = entry.run.flatMap(arg => arg === '$ARGS' ? [...args] : [arg.replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, token => {
    if (token === '$TARGET') return target!;
    if (token === '$CWD') return context.cwd;
    if (token === '$PROJECT_ROOT' && context.projectRoot !== null) return context.projectRoot;
    throw new ToolFileError(`unknown substitution '${token}'`);
  })]);
  if (!entry.run.some(arg => arg === '$ARGS' || /\$TARGET\b/.test(arg))) run.push(...args);
  if (!run[0]?.trim()) throw new ToolFileError('tool argument list must name an executable');
  return { run, key };
}
