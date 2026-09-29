import { realpath } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import {
  BUILTIN_FILE_TOOL, BUILTIN_FOLDER_TOOL, FOLDER_MATCH_SUFFIX, VIEW_FILE_ARGV, VIEW_FOLDER_ARGV, fileViewerFormat,
} from 'dor/file-viewer-format';
import { resolveLocalToolTarget } from './tool-input';
import { readUserToolFile, resolveUserTool } from './tool-user-config';

/** Dispatch is entirely user-owned. Never discover a project file here, even
 * when its Tool name shadows the rule's selected user Tool. */
export async function resolveOpenTool(
  request: { target: string; cwd: string; tool?: string; preview?: boolean },
  path: string,
): Promise<ToolLookupResult> {
  const { path: target, directory } = await resolveLocalToolTarget(request.target, request.cwd);
  const file = await readUserToolFile(path);
  const relativeBase = await realpath(request.cwd).catch(() => request.cwd);
  // A directory matches as its name suffixed with FOLDER_MATCH_SUFFIX, and only
  // against patterns ending in it (docs/specs/dor-tool.md -> Folders).
  const suffix = directory ? FOLDER_MATCH_SUFFIX : '';
  const relativePath = relative(relativeBase, target).split(sep).join('/') + suffix;
  const canonicalPath = target.split(sep).join('/') + suffix;
  const rule = file?.open.find(rule => {
    if (rule.match.endsWith(FOLDER_MATCH_SUFFIX) !== directory) return false;
    const matches = picomatch(rule.match, { windows: false });
    return rule.match.includes('/') ? matches(relativePath) || matches(canonicalPath) : matches(basename(target) + suffix);
  });
  const name = request.tool ?? (request.preview ? rule?.preview : undefined) ?? rule?.tool;
  // The built-in viewers run no user entry, but the user file was still
  // parsed to get here — its lint warnings are the user's to see.
  const builtin = (handler: 'file' | 'folder', argv: string): ToolLookupResult => ({
    status: 'ok', projectRoot: request.cwd, path: '<built-in>', name: handler, scope: 'builtin',
    run: ['dor', argv, target], key: [target], render: 'iframe', port: 'announced',
    warnings: file ? [...file.warnings] : [], target,
  });
  if (directory ? name === BUILTIN_FILE_TOOL : name === BUILTIN_FOLDER_TOOL) return { status: 'error',
    message: `${name} cannot open the ${directory ? 'folder' : 'file'} '${request.target}'; use ${directory ? BUILTIN_FOLDER_TOOL : BUILTIN_FILE_TOOL}` };
  if (directory && (!name || name === BUILTIN_FOLDER_TOOL)) return builtin('folder', VIEW_FOLDER_ARGV);
  if ((!name || name === BUILTIN_FILE_TOOL) && fileViewerFormat(target)) return builtin('file', VIEW_FILE_ARGV);
  if (name === BUILTIN_FILE_TOOL) return { status: 'error',
    message: `the built-in viewer does not support '${basename(target)}'; add an open rule to ${path} naming a user Tool` };
  const entry = name && file?.tools.get(name);
  if (!file || !entry) return { status: 'error', message: request.tool
    ? `no user Tool '${request.tool}' in ${path}`
    : `no Tool matches '${request.target}'; add an open rule to ${path}, or use dor open --tool <name> <file>` };
  const resolved = await resolveUserTool(file, path, entry, request.cwd, [target]);
  return resolved.status === 'ok' ? { ...resolved, target } : resolved;
}
