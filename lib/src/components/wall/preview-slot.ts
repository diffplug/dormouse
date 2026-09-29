/**
 * The Workspace preview slot (`docs/specs/dor-tool.md` -> Preview slot): at most
 * one Tool Surface per Workspace whose params carry `toolPreview: true`, which
 * `dor open --preview` retargets in place. The launch orchestration lives in
 * `use-dor-control.ts`; this module holds its param reads and the one pin path.
 */
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { getToolDirtySnapshot, subscribeToToolDirty } from '../../lib/tool-dirty-store';
import type { ToolKeyScope } from '../../lib/platform/tool-types';
import { isPreviewSlotParams, isToolParams, toolScopeFromParams } from './browser-surface';
import type { LathWallEngine } from './lath-wall-engine';

/** The canonical file an `open` gave this Tool, or null for a named Tool. */
export function toolTargetFromParams(params: unknown): string | null {
  const target = (params as { toolTarget?: unknown } | null | undefined)?.toolTarget;
  return typeof target === 'string' ? target : null;
}

/** Whether a Tool Surface was launched from this resolved Tool: the same scope,
 *  name, and run. Its target is compared separately. */
export function runsSameTool(
  params: unknown,
  tool: { scope?: ToolKeyScope; name?: string; run: string | readonly string[] },
): boolean {
  if (!isToolParams(params) || toolScopeFromParams(params) !== tool.scope || params.toolName !== tool.name) return false;
  const argv = params.toolArgv;
  if (typeof tool.run === 'string') return argv === undefined && params.command === tool.run;
  const run = tool.run;
  return Array.isArray(argv) && argv.length === run.length && argv.every((arg, index) => arg === run[index]);
}

export interface PreviewSlotPin {
  /** Clear the mark, leaving an ordinary Tool that keeps its key. Every pin —
   *  by open, by unsaved state, by the header pill — goes through here. */
  pin: (id: string) => void;
  /** The slot this Wall pinned last; runtime only, never persisted. */
  lastPinned: MutableRefObject<string | null>;
}

/** Pinning for one Wall, including the immediate pin on an unsaved-changes
 *  report. The dirty store is renderer-global; only this Wall's leaves match. */
export function usePreviewSlotPin(lath: LathWallEngine): PreviewSlotPin {
  const lastPinned = useRef<string | null>(null);
  const pin = useCallback((id: string) => {
    const meta = lath.getMeta(id);
    if (!meta?.params || !isPreviewSlotParams(meta.params)) return;
    const { toolPreview: _toolPreview, ...params } = meta.params;
    lath.store.setMeta(id, { ...meta, params });
    lastPinned.current = id;
  }, [lath]);
  useEffect(() => {
    const pinDirty = () => {
      for (const [id, dirty] of getToolDirtySnapshot()) if (dirty) pin(id);
    };
    pinDirty();
    return subscribeToToolDirty(pinDirty);
  }, [pin]);
  return useMemo(() => ({ pin, lastPinned }), [pin]);
}
