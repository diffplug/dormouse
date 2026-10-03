import { realpath } from 'node:fs/promises';
import { basename, relative, sep } from 'node:path';
import picomatch from 'picomatch';
import type { OpenHandler, OpenHandlersRequest, OpenHandlersResponse } from 'dor/commands/types';
import type { ToolLookupResult } from '../lib/platform/tool-types';
import { FOLDER_MATCH_SUFFIX, builtinHandler } from 'dor-tools-builtin/file-viewer-format';
import { builtinOpenResult, noUserToolMessage, offerBuiltins } from '../lib/tool-open-builtin';
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
  // The built-in viewers run no user entry, but the user file was still
  // parsed to get here — its lint warnings are the user's to see.
  const builtin = builtinOpenResult(request, name, target, directory, path, file ? [...file.warnings] : []);
  if (builtin) return builtin;
  const entry = name && file?.tools.get(name);
  if (!file || !entry) return { status: 'error', message: noUserToolMessage(request, path) };
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
  offerBuiltins(candidates, target, directory);
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
