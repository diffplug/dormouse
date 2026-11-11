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
  // Read concurrently, then fold in file order, which the listing and warnings keep.
  const imported = await Promise.all(file.names.map(name => {
    const spec = file.imports.get(name);
    return spec && readImportedTool(spec, path, file.dir);
  }));
  const tools = new Map<string, UserToolEntry>();
  const broken = new Map<string, BrokenToolImport>();
  const warnings = [...file.warnings];
  file.names.forEach((name, index) => {
    const result = imported[index];
    if (!result) tools.set(name, { ...file.tools.get(name)!, path, dir: file.dir, imported: false });
    else if ('reason' in result) broken.set(name, result);
    else {
      tools.set(name, result.entry);
      warnings.push(...result.warnings);
    }
  });
  return { ...file, tools, broken, warnings };
}

/** One import's entry, read as a project file's (scope `import`): so `$HERE`
 *  is its directory, and a `from` in it is an error, which keeps imports from
 *  chaining. */
async function readImportedTool(
  spec: ToolImport, userPath: string, userDir: string,
): Promise<{ entry: UserToolEntry; warnings: string[] } | BrokenToolImport> {
  const broken = (path: string, reason: string): BrokenToolImport => ({
    path, reason, message: `${userPath}: tools.${spec.name} imports '${spec.tool}': ${reason}`, description: spec.description,
  });
  const lexical = resolve(userDir, spec.from);
  let path = join(lexical, TOOL_FILE_NAME);
  try {
    // Never `realpath`: a link to a share would reach it before any check.
    // A file there fails the read below as ENOTDIR.
    const dir = (await localRealpath(lexical)).path;
    path = join(dir, TOOL_FILE_NAME);
    const file = parseToolFile(await readToolFile(path), { path, dir, scope: 'import' });
    const entry = file.tools.get(spec.tool);
    if (!entry) return broken(path, `${path}: no Tool '${spec.tool}' (declares: ${[...file.tools.keys()].join(', ') || 'none'})`);
    return {
      entry: { ...entry, name: spec.name, description: spec.description ?? entry.description, path, dir, imported: true },
      // Only its own lint: the file's other entries are not the user's.
      warnings: file.warnings.filter(warning => warning.startsWith(`${path}: tools.${spec.tool}: `)),
    };
  } catch (error) {
    if (error instanceof ToolFileError) return broken(path, error.message);
    if (error instanceof NonLocalPathError) return broken(path, `${path}: not a folder on this machine`);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return broken(path, `${path}: not found`);
    return broken(path, `${path}: cannot read (${code ?? 'unknown error'})`);
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
