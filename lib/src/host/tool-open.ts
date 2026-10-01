import { realpath } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import { BUILTIN_FILE_TOOL, FOLDER_MATCH_SUFFIX, builtinFor, fileViewerFormat } from 'dor-tools-builtin/file-viewer-format';
import { resolveLocalToolTarget } from './tool-input';
import type { OpenRule } from './tool-registry';
import { readUserToolFile, resolveUserTool } from './tool-user-config';

/** Dispatch is entirely user-owned. Never discover a project file here, even
 * when its Tool name shadows the rule's selected user Tool. */
export async function resolveOpenTool(
  request: { target: string; cwd: string; tool?: string; preview?: boolean },
  path: string,
): Promise<ToolLookupResult> {
  const { path: target, directory } = await resolveLocalToolTarget(request.target, request.cwd);
  const file = await readUserToolFile(path);
  // An explicit handler outranks every rule, so none is matched.
  const rule = request.tool === undefined ? await matchOpenRule(file?.open ?? [], request.cwd, target, directory) : undefined;
  const name = request.tool ?? (request.preview ? rule?.preview : undefined) ?? rule?.tool;
  const { kind, argv, own, other } = builtinFor(directory);
  if (name === other) return { status: 'error', message: `${name} cannot open the ${kind} '${request.target}'; use ${own}` };
  if ((!name || name === own) && (directory || fileViewerFormat(target))) {
    // The built-in viewers run no user entry, but the user file was still
    // parsed to get here — its lint warnings are the user's to see.
    return {
      status: 'ok', projectRoot: request.cwd, path: '<built-in>', name: kind, scope: 'builtin',
      run: ['dor', argv, target], key: [target], render: 'iframe', port: 'announced',
      warnings: file ? [...file.warnings] : [], target,
    };
  }
  if (name === BUILTIN_FILE_TOOL) return { status: 'error',
    message: `the built-in viewer does not support '${basename(target)}'; add an open rule to ${path} naming a user Tool` };
  const entry = name && file?.tools.get(name);
  if (!file || !entry) return { status: 'error', message: request.tool
    ? `no user Tool '${request.tool}' in ${path}`
    : `no Tool matches '${request.target}'; add an open rule to ${path}, or use dor open --tool <name> <file>` };
  const resolved = await resolveUserTool(file, path, entry, request.cwd, [target]);
  return resolved.status === 'ok' ? { ...resolved, target } : resolved;
}

/** The first `open` rule matching `target`. A directory matches as its name
 * suffixed with FOLDER_MATCH_SUFFIX, and only against patterns ending in it
 * (docs/specs/dor-tool.md -> Folders). */
async function matchOpenRule(
  rules: readonly OpenRule[], cwd: string, target: string, directory: boolean,
): Promise<OpenRule | undefined> {
  const relativeBase = await realpath(cwd).catch(() => cwd);
  const suffix = directory ? FOLDER_MATCH_SUFFIX : '';
  const relativePath = relative(relativeBase, target).split(sep).join('/') + suffix;
  const canonicalPath = target.split(sep).join('/') + suffix;
  return rules.find(rule => {
    if (rule.match.endsWith(FOLDER_MATCH_SUFFIX) !== directory) return false;
    const matches = picomatch(rule.match, { windows: false });
    return rule.match.includes('/') ? matches(relativePath) || matches(canonicalPath) : matches(basename(target) + suffix);
  });
}
