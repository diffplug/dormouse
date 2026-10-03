/**
 * The built-in half of `dor open` resolution (`docs/specs/dor-tool.md` ->
 * Opening local files): pure, so the host's `lib/src/host/tool-open.ts` and the
 * website playground's snapshot answer alike.
 */
import { BUILTIN_HANDLERS, builtinHandler, defaultBuiltin, viewerTitle } from 'dor-tools-builtin/file-viewer-format';
import type { ToolLookupResult } from './platform/tool-types';

interface OpenRequest { target: string; cwd: string; tool?: string }

/** The answer when the handler `name` is a built-in, or null when it is not.
 * `target` is the canonical path `request.target` resolved to; `config` the
 * user `dormouse.yml` an error points at. */
export function builtinOpenResult(
  request: OpenRequest, name: string | undefined, target: string, directory: boolean, config: string, warnings: string[],
): ToolLookupResult | null {
  const builtin = builtinHandler('tool', name);
  if (!builtin) return null;
  const kind = directory ? 'folder' : 'file';
  if (builtin.opens !== kind) return { status: 'error', message: `${name} cannot open the ${kind} '${request.target}'; use ${defaultBuiltin(directory).tool}` };
  if (!directory && !builtin.format(target)) {
    return { status: 'error', message: `${name} does not support '${viewerTitle(target)}'; add an open rule to ${config} naming a user Tool` };
  }
  return {
    status: 'ok', projectRoot: request.cwd, path: '<built-in>', name: builtin.kind, scope: 'builtin',
    run: ['dor', builtin.argv, target], key: [target], render: 'iframe', port: 'announced', warnings, target,
  };
}

/** The error when no user Tool answers `request`. */
export function noUserToolMessage(request: OpenRequest, config: string): string {
  return request.tool
    ? `no user Tool '${request.tool}' in ${config}`
    : `no Tool matches '${request.target}'; add an open rule to ${config}, or use dor open --tool <name> <file>`;
}

/** Adds the built-ins offered for `target` to `candidates` (handler → reason),
 * after whatever the open rules offered. */
export function offerBuiltins(candidates: Map<string, string>, target: string, directory: boolean): void {
  const kind = directory ? 'folder' : 'file';
  for (const builtin of BUILTIN_HANDLERS) {
    if (builtin.opens !== kind || !builtin.offered(target) || candidates.has(builtin.tool)) continue;
    candidates.set(builtin.tool, candidates.size ? 'built-in' : 'built-in; no open rule matches');
  }
}
