import { realpath } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { OpenHandler, OpenHandlersRequest, OpenHandlersResponse } from 'dor/commands/types';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import {
  BUILTIN_CODE_TOOL, BUILTIN_FILE_TOOL, CODE_KIND, FOLDER_MATCH_SUFFIX, VIEW_CODE_ARGV,
  builtinFileAlternative, builtinFor, builtinHandlerKind, codeViewerFormat, describeBuiltin, fileViewerFormat,
} from 'dor-tools-builtin/file-viewer-format';
import { resolveLocalToolTarget } from './tool-input';
import type { OpenRule, ToolFile } from './tool-registry';
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
  const rule = request.tool === undefined ? (await matchingOpenRules(file?.open ?? [], request.cwd, target, directory))[0] : undefined;
  const name = request.tool ?? (request.preview ? rule?.preview : undefined) ?? rule?.tool;
  const { kind, argv, own } = builtinFor(directory);
  const builtin = (name: string, argv: string): ToolLookupResult => ({
    // The built-in viewers run no user entry, but the user file was still
    // parsed to get here — its lint warnings are the user's to see.
    status: 'ok', projectRoot: request.cwd, path: '<built-in>', name, scope: 'builtin',
    run: ['dor', argv, target], key: [target], render: 'iframe', port: 'announced',
    warnings: file ? [...file.warnings] : [], target,
  });
  const nameKind = builtinHandlerKind(name);
  if (nameKind && nameKind !== kind) return { status: 'error', message: `${name} cannot open the ${kind} '${request.target}'; use ${own}` };
  if (name === BUILTIN_CODE_TOOL) {
    return codeViewerFormat(target) ? builtin(CODE_KIND, VIEW_CODE_ARGV) : { status: 'error',
      message: `the built-in code editor opens only text, not '${basename(target)}'; add an open rule to ${path} naming a user Tool` };
  }
  if ((!name || name === own) && (directory || fileViewerFormat(target))) return builtin(kind, argv);
  if (name === BUILTIN_FILE_TOOL) return { status: 'error',
    message: `the built-in viewer does not support '${basename(target)}'; add an open rule to ${path} naming a user Tool` };
  const entry = name && file?.tools.get(name);
  if (!file || !entry) return { status: 'error', message: request.tool
    ? `no user Tool '${request.tool}' in ${path}`
    : `no Tool matches '${request.target}'; add an open rule to ${path}, or use dor open --tool <name> <file>` };
  const resolved = await resolveUserTool(file, path, entry, request.cwd, [target]);
  return resolved.status === 'ok' ? { ...resolved, target } : resolved;
}

/**
 * Every handler that could open `request.target`, for a person choosing one
 * (`docs/specs/dor-tool.md` -> Choosing a file). The first is what `dor open`
 * (or `--preview`) selects; then each later matching rule's handlers in file
 * order; then the built-ins that support it. Each name appears once.
 */
export async function listOpenHandlers(request: OpenHandlersRequest, path: string): Promise<OpenHandlersResponse> {
  const { path: target, directory } = await resolveLocalToolTarget(request.target, request.cwd);
  const file = await readUserToolFile(path);
  const rules = file?.open ?? [];
  const matched = await matchingOpenRules(rules, request.cwd, target, directory);
  const handlers = new Map<string, OpenHandler>();
  const offer = (tool: string, reason: string) => {
    if (!handlers.has(tool)) handlers.set(tool, { tool, description: describeHandler(tool, target, file), reason });
  };
  matched.forEach((rule, index) => {
    const where = `open rule ${rules.indexOf(rule) + 1}, '${rule.match}'`;
    // The first rule's preview handler is the default only for a preview.
    if (index === 0 && request.preview && rule.preview) offer(rule.preview, `preview handler of ${where}`);
    offer(rule.tool, where);
    if (rule.preview) offer(rule.preview, `preview handler of ${where}`);
  });
  const fallback = matched.length === 0 ? 'built-in; no open rule matches' : 'built-in';
  const { own } = builtinFor(directory);
  if (directory || fileViewerFormat(target)) offer(own, fallback);
  const alternative = directory ? null : builtinFileAlternative(target);
  if (alternative) offer(alternative, 'built-in');
  return {
    target,
    directory,
    handlers: [...handlers.values()],
    config: path,
    warnings: file ? [...file.warnings] : [],
  };
}

function describeHandler(tool: string, target: string, file: ToolFile | null): string {
  if (builtinHandlerKind(tool)) return describeBuiltin(tool, target);
  const run = file?.tools.get(tool)?.run;
  return typeof run === 'string' ? run : (run ?? []).join(' ');
}

/** The `open` rules matching `target`, in file order. A directory matches as
 * its name suffixed with FOLDER_MATCH_SUFFIX, and only against patterns ending
 * in it (docs/specs/dor-tool.md -> Folders). */
async function matchingOpenRules(
  rules: readonly OpenRule[], cwd: string, target: string, directory: boolean,
): Promise<OpenRule[]> {
  const relativeBase = await realpath(cwd).catch(() => cwd);
  const suffix = directory ? FOLDER_MATCH_SUFFIX : '';
  const relativePath = relative(relativeBase, target).split(sep).join('/') + suffix;
  const canonicalPath = target.split(sep).join('/') + suffix;
  return rules.filter(rule => {
    if (rule.match.endsWith(FOLDER_MATCH_SUFFIX) !== directory) return false;
    const matches = picomatch(rule.match, { windows: false });
    return rule.match.includes('/') ? matches(relativePath) || matches(canonicalPath) : matches(basename(target) + suffix);
  });
}
