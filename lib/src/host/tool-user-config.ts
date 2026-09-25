import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import { resolveToolInput } from './tool-input';
import { parseBrowserSection, parseToolFile, type ToolEntry, type ToolFile } from './tool-registry';
import { readToolFile } from './tool-trust';
import { mergeBrowserConfig, toolViewport, type BrowserConfigLayer } from './browser-config';
import type { BrowserViewportConfig } from 'dor-lib-common/browser-viewports';

export function userToolConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config'), 'dormouse', 'dormouse.yml');
}

export async function readUserToolFile(path: string): Promise<ToolFile | null> {
  try {
    return parseToolFile(await readToolFile(path, { followSymlink: true }), { path, dir: dirname(path), scope: 'user' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
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

/** The `ok` result for a user Tool: no project root, no trust gate. */
export async function resolveUserTool(
  file: ToolFile, path: string, entry: ToolEntry, cwd: string, args: readonly string[],
  browserConfig: BrowserViewportConfig = mergeBrowserConfig(file.browser),
): Promise<ToolLookupResult> {
  const input = await resolveToolInput(entry, { cwd, projectRoot: null, args });
  return { status: 'ok', projectRoot: file.dir, path, name: entry.name, scope: 'user',
    ...input, render: entry.render, port: entry.port,
    viewport: toolViewport(entry.render, entry.viewport, browserConfig), warnings: [...file.warnings] };
}
