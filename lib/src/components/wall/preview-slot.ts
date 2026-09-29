/**
 * The Workspace preview slot (`docs/specs/dor-tool.md` -> Preview slot): at most
 * one Tool Surface per Workspace whose params carry `toolPreview: true`, which
 * `dor open --preview` retargets in place. The launch orchestration lives in
 * `use-dor-control.ts`; this module holds its param reads, its decision order,
 * the retarget's leaf commit, and the one pin path.
 */
import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { getToolDirtySnapshot, subscribeToToolDirty } from '../../lib/tool-dirty-store';
import type { ToolKeyScope } from '../../lib/platform/tool-types';
import {
  isPreviewSlotParams,
  isToolParams,
  TOOL_IDENTITY_PARAMS,
  toolKeysEqual,
  toolScopeFromParams,
  type ToolIdentityParams,
} from './browser-surface';
import { stringParam } from './dor-control-shared';
import { becomeToolMeta, type LathWallEngine } from './lath-wall-engine';
import type { LeafMeta } from './lath-wall-store';
import { retireToolRun } from './use-tool-serving';

/** The canonical file an `open` gave this Tool, or null for a named Tool. */
export function toolTargetFromParams(params: unknown): string | null {
  return stringParam((params as { toolTarget?: unknown } | null | undefined)?.toolTarget) ?? null;
}

/** A resolved Tool, as a launch compares it with a Surface's params. */
export interface ResolvedTool { scope?: ToolKeyScope; name?: string; run: string | readonly string[] }

/** Whether a Tool Surface was launched from this resolved Tool: the same scope,
 *  name, and run. Its target is compared separately. */
export function runsSameTool(params: unknown, tool: ResolvedTool): boolean {
  if (!isToolParams(params) || toolScopeFromParams(params) !== tool.scope || params.toolName !== tool.name) return false;
  if (typeof tool.run === 'string') return params.toolArgv === undefined && params.command === tool.run;
  return toolKeysEqual(params.toolArgv, tool.run);
}

/** What a Tool launch does about the preview slot, in the decision order of
 *  `docs/specs/dor-tool.md` -> Preview slot. */
export type PreviewSlotDecision =
  /** Answer with this Surface as it stands, revealed — focus-neutrally when
   *  `quiet` — pinning it first when `pin`. */
  | { kind: 'existing'; id: string; quiet: boolean; pin: boolean }
  /** Run the resolved Tool in the slot in place. */
  | { kind: 'retarget'; id: string }
  /** Place the launch as usual, after pinning `pin` — the caller's own slot,
   *  whose `dor` awaiting the answer is never interrupted. */
  | { kind: 'place'; pin: string | null };

export function decidePreviewSlot(launch: {
  preview: boolean;
  fresh: boolean;
  callerId: string | undefined;
  tool: ResolvedTool;
  /** The canonical file an `open` resolved. */
  target: string | undefined;
  /** A pinned Tool with this launch's key; read only for a preview. */
  keyedMatch: () => { id: string } | null;
  slot: { id: string; params: unknown } | null;
}): PreviewSlotDecision {
  const { slot } = launch;
  const place = (pin: string | null = null): PreviewSlotDecision => ({ kind: 'place', pin });
  if (launch.preview) {
    // A pinned Tool already showing this file is revealed, never replaced.
    const pinned = launch.keyedMatch();
    if (pinned) return { kind: 'existing', id: pinned.id, quiet: true, pin: false };
    if (!slot) return place();
    if (runsSameTool(slot.params, launch.tool) && toolTargetFromParams(slot.params) === launch.target) {
      return { kind: 'existing', id: slot.id, quiet: true, pin: false };
    }
    // A request from the slot's own Session (a viewer shown in it) keeps the
    // slot: pinned, it is where the new slot splits from. Unsaved changes
    // pinned it already (`usePreviewSlotPin`).
    return slot.id === launch.callerId ? place(slot.id) : { kind: 'retarget', id: slot.id };
  }
  // Opening the file the slot shows keeps it (pin by open); `--fresh` bypasses it.
  if (launch.target === undefined || launch.fresh || !slot || toolTargetFromParams(slot.params) !== launch.target) return place();
  // From the slot's own Session, pinned, it is an ordinary keyed Tool for the
  // reuse that follows, which never interrupts the `dor` asking.
  if (slot.id === launch.callerId) return place(slot.id);
  if (runsSameTool(slot.params, launch.tool)) return { kind: 'existing', id: slot.id, quiet: false, pin: true };
  // Another Tool for the same file replaces the slot's, then pins it.
  return { kind: 'retarget', id: slot.id };
}

/**
 * A retarget's leaf commit: retire the Surface's previous run and make it the
 * resolved Tool in one leaf write, keeping its directory, a user rename, and
 * the mark — unless `pin` is given, which the write then goes through. The
 * caller has interrupted the old command; it reveals and types the new one.
 */
export function retargetToolLeaf(
  lath: LathWallEngine,
  id: string,
  tool: { title: string; identity: ToolIdentityParams },
  pin?: PreviewSlotPin['pin'],
): void {
  retireToolRun(lath, id);
  const meta = lath.getMeta(id);
  if (!meta) return;
  const kept = Object.fromEntries(Object.entries(meta.params ?? {}).filter(([name]) => !TOOL_IDENTITY_PARAMS.has(name)));
  const next = becomeToolMeta(meta, tool.title, { ...kept, ...tool.identity });
  if (pin) pin(id, next);
  else lath.store.setMeta(id, next);
}

export interface PreviewSlotPin {
  /** Clear the mark, leaving an ordinary Tool that keeps its key. Every pin —
   *  by open, by unsaved state, by the header pill — goes through here. A
   *  retarget passes the leaf it writes, which is written without the mark. */
  pin: (id: string, next?: LeafMeta) => void;
  /** The slot this Wall pinned last; runtime only, never persisted. */
  lastPinned: MutableRefObject<string | null>;
}

/** Pinning for one Wall, including the immediate pin on an unsaved-changes
 *  report. The dirty store is renderer-global; only this Wall's leaves match. */
export function usePreviewSlotPin(lath: LathWallEngine): PreviewSlotPin {
  const lastPinned = useRef<string | null>(null);
  const pin = useCallback((id: string, next?: LeafMeta) => {
    const meta = next ?? lath.getMeta(id);
    if (!meta?.params || (!next && !isPreviewSlotParams(meta.params))) return;
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
