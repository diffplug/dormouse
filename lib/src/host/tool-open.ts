import { realpath } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import { BUILTIN_FILE_TOOL, VIEW_FILE_ARGV, fileViewerFormat } from 'dor/file-viewer-format';
import { resolveLocalToolTarget } from './tool-input';
import { readUserToolFile, resolveUserTool } from './tool-user-config';

/** Dispatch is entirely user-owned. Never discover a project file here, even
 * when its Tool name shadows the rule's selected user Tool. */
export async function resolveOpenTool(
  request: { target: string; cwd: string; tool?: string },
  path: string,
): Promise<ToolLookupResult> {
  const target = await resolveLocalToolTarget(request.target, request.cwd);
  const file = await readUserToolFile(path);
  const relativeBase = await realpath(request.cwd).catch(() => request.cwd);
  const relativePath = relative(relativeBase, target).split(sep).join('/');
  const canonicalPath = target.split(sep).join('/');
  const name = request.tool ?? file?.open.find(rule => {
    const matches = picomatch(rule.match, { windows: false });
    return rule.match.includes('/') ? matches(relativePath) || matches(canonicalPath) : matches(basename(target));
  })?.tool;
  const entry = name && file?.tools.get(name);
  if ((!name || name === BUILTIN_FILE_TOOL) && fileViewerFormat(target)) {
    return { status: 'ok', projectRoot: request.cwd, path: '<built-in>', name: 'file', scope: 'builtin',
      run: ['dor', VIEW_FILE_ARGV, target], key: [target], render: 'iframe', port: 'announced', warnings: [] };
  }
  if (name === BUILTIN_FILE_TOOL) return { status: 'error',
    message: `the built-in viewer does not support '${basename(target)}'; add an open rule to ${path} naming a user Tool` };
  if (!file || !entry) return { status: 'error', message: request.tool
    ? `no user Tool '${request.tool}' in ${path}`
    : `no Tool matches '${request.target}'; add an open rule to ${path}, or use dor open --tool <name> <file>` };
  return resolveUserTool(file, path, entry, request.cwd, [target]);
}
