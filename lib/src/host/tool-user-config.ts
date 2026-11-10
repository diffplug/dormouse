import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { localRealpath, NonLocalPathError } from 'dor-lib-common/local-path';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import { resolveToolInput } from './tool-input';
import { parseBrowserSection, parseToolFile, ToolFileError, type ToolEntry, type ToolFile, type ToolImport } from './tool-registry';
import { readToolFile, TOOL_FILE_NAME } from './tool-trust';
import { mergeBrowserConfig, toolViewport, type BrowserConfigLayer } from './browser-config';
import type { BrowserViewportConfig } from 'dor-lib-common/browser-viewports';

export function userToolConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), 'dormouse', TOOL_FILE_NAME);
}

/** A user Tool and the file whose `run` it is: the user file, or the one an
 *  import read. `$HERE` is that file's directory. */
export interface UserToolEntry extends ToolEntry {
  readonly path: string;
  readonly dir: string;
  readonly imported: boolean;
}

/** An import that did not resolve. It fails only its own lookup and the opens
 *  that select it (`docs/specs/dor-tool.md` -> Declaring tools). */
export interface BrokenToolImport {
  /** The `dormouse.yml` it reads. */
  readonly path: string;
  /** Why, naming that file. */
  readonly reason: string;
  /** The lookup error, naming the user file too. */
  readonly message: string;
  readonly description: string | null;
}

/** The user file with its imports resolved. */
export interface UserToolFile extends ToolFile {
  /** Declared Tools and the imports that resolved. */
  readonly tools: ReadonlyMap<string, UserToolEntry>;
  readonly broken: ReadonlyMap<string, BrokenToolImport>;
}

export async function readUserToolFile(path: string): Promise<UserToolFile | null> {
  let file: ToolFile;
  try {
    file = parseToolFile(await readToolFile(path, { followSymlink: true }), { path, dir: dirname(path), scope: 'user' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return resolveToolImports(file, path);
}

/** Read each import's one entry. A failure breaks only that import, so a
 *  clone's update or an uninitialised submodule cannot break the rest. */
async function resolveToolImports(file: ToolFile, path: string): Promise<UserToolFile> {
  const tools = new Map<string, UserToolEntry>();
  const broken = new Map<string, BrokenToolImport>();
  const warnings = [...file.warnings];
  for (const name of file.names) {
    const declared = file.tools.get(name);
    if (declared) {
      tools.set(name, { ...declared, path, dir: file.dir, imported: false });
      continue;
    }
    const spec = file.imports.get(name)!;
    const imported = await readImport(spec, file.dir);
    if ('reason' in imported) {
      broken.set(name, { path: imported.path, reason: imported.reason,
        message: `${path}: tools.${name} imports '${spec.tool}': ${imported.reason}`, description: spec.description });
      continue;
    }
    const { entry, path: from, dir, warnings: lint } = imported;
    tools.set(name, { ...entry, name, description: spec.description ?? entry.description, path: from, dir, imported: true });
    warnings.push(...lint);
  }
  return { ...file, tools, broken, warnings };
}

/** One import's entry, read as a project file's: so `$HERE` is its directory,
 *  and a `from` in it is an error, which keeps imports from chaining. */
async function readImport(
  spec: ToolImport, userDir: string,
): Promise<{ entry: ToolEntry; path: string; dir: string; warnings: string[] } | { path: string; reason: string }> {
  const lexical = resolve(userDir, spec.from);
  let path = join(lexical, TOOL_FILE_NAME);
  try {
    // Never `realpath`: a link to a share would reach it before any check.
    // A file there fails the read below as ENOTDIR.
    const dir = (await localRealpath(lexical)).path;
    path = join(dir, TOOL_FILE_NAME);
    const file = parseToolFile(await readToolFile(path), { path, dir, scope: 'repo' });
    const entry = file.tools.get(spec.tool);
    if (!entry) return { path, reason: `${path}: no Tool '${spec.tool}' (declares: ${[...file.tools.keys()].join(', ') || 'none'})` };
    // Only its own lint: the file's other entries are not the user's.
    return { entry, path, dir, warnings: file.warnings.filter(warning => warning.startsWith(`${path}: tools.${spec.tool}: `)) };
  } catch (error) {
    if (error instanceof ToolFileError) return { path, reason: error.message };
    if (error instanceof NonLocalPathError) return { path, reason: `${path}: not a folder on this machine` };
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { path, reason: `${path}: not found` };
    return { path, reason: `${path}: cannot read (${code ?? 'unknown error'})` };
  }
}

/** Browser preferences share the user's bounded read, but malformed Tool
 * entries must not prevent an automated browser from opening. */
export async function readUserBrowserConfig(path: string): Promise<BrowserConfigLayer | undefined> {
  try {
    return parseBrowserSection(await readToolFile(path, { followSymlink: true }), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The `ok` result for a user Tool: no trust gate. */
export async function resolveUserTool(
  file: UserToolFile, entry: UserToolEntry, cwd: string, args: readonly string[],
  browserConfig: BrowserViewportConfig = mergeBrowserConfig(file.browser),
): Promise<ToolLookupResult> {
  const input = await resolveToolInput(entry, { cwd, here: entry.dir, args });
  return { status: 'ok', projectRoot: entry.dir, path: entry.path, name: entry.name, scope: 'user',
    ...input, render: entry.render, port: entry.port,
    viewport: toolViewport(entry.render, entry.viewport, browserConfig), warnings: [...file.warnings] };
}
