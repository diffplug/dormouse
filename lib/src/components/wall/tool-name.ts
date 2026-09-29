import { viewerTitle } from 'dor/file-viewer-format';
import { toolCommandFromParams } from '../../lib/session-save';

const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/**
 * The name a serving Tool's Pane header shows (`docs/specs/dor-tool.md` ->
 * Naming): a user rename, else its target's name, else its Tool name and dedupe
 * key, else its command. Params and the rename are its only inputs, so it
 * changes only when they do; null for params that describe no Tool.
 */
export function toolSemanticName(params: Record<string, unknown> | undefined, userTitle?: string | null): string | null {
  const renamed = userTitle?.trim();
  if (renamed) return renamed;
  const { toolTarget, toolName, toolKey } = params ?? {};
  if (typeof toolTarget === 'string' && toolTarget) return viewerTitle(toolTarget);
  if (typeof toolName === 'string' && toolName) {
    // Keys are namespaced `[toolName, ...declared]`: only what follows the
    // name tells two of its Surfaces apart.
    const elements = Array.isArray(toolKey)
      ? toolKey.filter((element): element is string => typeof element === 'string')
        .map(element => ABSOLUTE_PATH.test(element) ? viewerTitle(element) : element)
      : [];
    return [toolName, ...elements.filter(element => element && element !== toolName)].join(' ');
  }
  return toolCommandFromParams(params);
}
