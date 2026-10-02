import { realpath } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { OpenHandler, OpenHandlersRequest, OpenHandlersResponse } from 'dor/commands/types';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import { BUILTIN_HANDLERS, FOLDER_MATCH_SUFFIX, builtinHandler, defaultBuiltin } from 'dor-tools-builtin/file-viewer-format';
import { resolveLocalToolTarget } from './tool-input';
import type { OpenRule, ToolFile } from './tool-registry';
import { readUserToolFile, resolveUserTool } from './tool-user-config';

interface OpenRequest { target: string; cwd: string; tool?: string; preview?: boolean }

/** Dispatch is entirely user-owned. Never discover a project file here, even
 * when its Tool name shadows the rule's selected user Tool. */
export async function resolveOpenTool(request: OpenRequest, path: string): Promise<ToolLookupResult> {
  const { path: target, directory } = await resolveLocalToolTarget(request.target, request.cwd);
  const file = await readUserToolFile(path);
  // An explicit handler outranks every rule, so none is matched.
  const name = request.tool ?? (await openCandidates(request, file, target, directory))[0]?.tool;
  const kind = directory ? 'folder' : 'file';
  const builtin = builtinHandler('tool', name);
  if (builtin) {
    if (builtin.opens !== kind) return { status: 'error', message: `${name} cannot open the ${kind} '${request.target}'; use ${defaultBuiltin(directory).tool}` };
    if (!directory && !builtin.format(target)) return { status: 'error',
      message: `${name} does not support '${basename(target)}'; add an open rule to ${path} naming a user Tool` };
    // The built-in viewers run no user entry, but the user file was still
    // parsed to get here — its lint warnings are the user's to see.
    return {
      status: 'ok', projectRoot: request.cwd, path: '<built-in>', name: builtin.kind, scope: 'builtin',
      run: ['dor', builtin.argv, target], key: [target], render: 'iframe', port: 'announced',
      warnings: file ? [...file.warnings] : [], target,
    };
  }
  const entry = name && file?.tools.get(name);
  if (!file || !entry) return { status: 'error', message: request.tool
    ? `no user Tool '${request.tool}' in ${path}`
    : `no Tool matches '${request.target}'; add an open rule to ${path}, or use dor open --tool <name> <file>` };
  const resolved = await resolveUserTool(file, path, entry, request.cwd, [target]);
  return resolved.status === 'ok' ? { ...resolved, target } : resolved;
}

/** What could open `request.target`, for a person choosing (`docs/specs/dor-tool.md`
 * -> Choosing a file); the first is what `dor open` selects. */
export async function listOpenHandlers(request: OpenHandlersRequest, path: string): Promise<OpenHandlersResponse> {
  const { path: target, directory } = await resolveLocalToolTarget(request.target, request.cwd);
  const file = await readUserToolFile(path);
  const candidates = await openCandidates(request, file, target, directory);
  return { handlers: candidates.map(({ tool, reason }) => ({ tool, description: describeHandler(tool, target, file), reason })), config: path };
}

/**
 * The handlers for `target` in selection order, each once: the first matching
 * rule's handler (its `preview` for a preview), then each later matching rule's
 * `tool` and `preview`, then the built-ins offered for it. A rule's built-in is
 * kept even where it cannot open the target, so selecting it reports why.
 */
async function openCandidates(
  request: OpenRequest, file: ToolFile | null, target: string, directory: boolean,
): Promise<Omit<OpenHandler, 'description'>[]> {
  const rules = file?.open ?? [];
  const matched = await matchingOpenRules(rules, request.cwd, target, directory);
  const candidates = new Map<string, string>();
  const offer = (tool: string, reason: string) => { if (!candidates.has(tool)) candidates.set(tool, reason); };
  matched.forEach((rule, index) => {
    const where = `open rule ${rules.indexOf(rule) + 1}, '${rule.match}'`;
    if (index === 0 && request.preview && rule.preview) offer(rule.preview, `preview handler of ${where}`);
    offer(rule.tool, where);
    if (rule.preview) offer(rule.preview, `preview handler of ${where}`);
  });
  const kind = directory ? 'folder' : 'file';
  for (const builtin of BUILTIN_HANDLERS) {
    if (builtin.opens === kind && builtin.offered(target)) offer(builtin.tool, candidates.size ? 'built-in' : 'built-in; no open rule matches');
  }
  return [...candidates].map(([tool, reason]) => ({ tool, reason }));
}

function describeHandler(tool: string, target: string, file: ToolFile | null): string {
  const builtin = builtinHandler('tool', tool);
  if (builtin) return builtin.describe(target);
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
