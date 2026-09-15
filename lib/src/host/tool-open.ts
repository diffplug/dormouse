import { basename, posix, relative, sep } from 'node:path';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import { resolveLocalToolTarget, resolveToolInput } from './tool-input';
import { readUserToolFile } from './tool-user-config';
import { fileViewerFormat } from 'dor/file-viewer-format';

/** Dispatch is entirely user-owned. Never discover a project file here, even
 * when its Tool name shadows the rule's selected user Tool. */
export async function resolveOpenTool(
  request: { target: string; cwd: string; tool?: string },
  path: string,
): Promise<ToolLookupResult> {
  const target = await resolveLocalToolTarget(request.target, request.cwd);
  const file = await readUserToolFile(path);
  const relativePath = relative(request.cwd, target).split(sep).join('/');
  const name = request.tool ?? file?.open.find(rule =>
    posix.matchesGlob(rule.match.includes('/') ? relativePath : basename(target), rule.match))?.tool;
  const entry = name && file?.tools.get(name);
  if ((!name || name === 'builtin:file') && fileViewerFormat(target)) {
    return { status: 'ok', projectRoot: request.cwd, path: '<built-in>', name: 'file', scope: 'builtin',
      run: ['dor', '__view-file', target], key: [target], render: 'iframe', port: 'announced', warnings: [] };
  }
  if (!file || !entry) return { status: 'error', message: request.tool
    ? `no user Tool '${request.tool}' in ${path}`
    : `no Tool matches '${request.target}'; add an open rule to ${path}, or use dor open --tool <name> <file>` };
  const input = await resolveToolInput(entry, { cwd: request.cwd, projectRoot: null, args: [target] });
  return { status: 'ok', projectRoot: file.dir, path, name: entry.name, scope: 'user',
    ...input, render: entry.render, port: entry.port, warnings: [...file.warnings] };
}
