import type { LathWallEngine } from './lath-wall-engine';
import type { RestoredSession } from '../../lib/session-restore';
import { isToolParams, toolPendingFromParams } from './browser-surface';
import { parseRenderMode } from 'dor-lib-common/browser-providers';

/** Live browser bindings travel only in the volatile transfer content, never
 * in the saved Workspace record. Cold restore must rediscover its own port. */
export type TransferredTools = Record<string, Record<string, unknown>>;

export function captureToolParams(lath: LathWallEngine, ids: readonly string[]): TransferredTools {
  const tools: TransferredTools = {};
  for (const id of ids) {
    const params = lath.getMeta(id)?.params;
    if (!params || !isToolParams(params)) continue;
    // Approval and browser startup own asynchronous work in this webview. Let
    // them settle before moving their UI and ownership to another one.
    if (toolPendingFromParams(params)) throw new Error('Approve or decline pending Tools before moving this Workspace');
    if (parseRenderMode(params.renderMode).provider && !params.session) {
      throw new Error('Wait for the Tool browser to connect before moving this Workspace');
    }
    tools[id] = { ...params };
  }
  return tools;
}

export function restoreToolParams(plan: Partial<RestoredSession>, tools: TransferredTools): void {
  // The plan may share objects with the arrival's durable record. Copy before
  // overlaying live bindings, so publishing that record cannot persist them.
  if (plan.lathLayout) {
    plan.lathLayout = { ...plan.lathLayout, leafMeta: { ...plan.lathLayout.leafMeta } };
    for (const [id, meta] of Object.entries(plan.lathLayout.leafMeta)) {
      const params = tools[id];
      if (meta.component === 'tool' && isToolParams(params)) {
        plan.lathLayout.leafMeta[id] = { ...meta, params: { ...params } };
      }
    }
  }
  plan.doors = (plan.doors ?? []).map(door => {
    const params = tools[door.id];
    return door.component === 'tool' && isToolParams(params) ? { ...door, params: { ...params } } : door;
  });
}
