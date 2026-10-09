import type { LathNode } from './lath/model';
import { isLathPersistedLayout } from './lath/persistence';
import type { PersistedSession } from './session-types';
import { isRecord } from './is-record';
import { mintSurfaceId } from './surface-ids';

/** How many ids {@link withFreshSurfaceIds} mints for `session`, so a caller
 *  can have them in hand first (`surfaceIdMinter`). */
export function freshSurfaceIdCount(session: PersistedSession): number {
  return new Set([...session.panes, ...(session.doors ?? [])].map(surface => surface.id)).size;
}

/**
 * A closed Workspace's record with every Surface given a fresh id, for Reopen
 * (`docs/specs/reopen.md`): the rebuilt Sessions must never share an id — a
 * PTY's, the host's — with the ones the close just killed, so each comes back
 * under a new id. Mints {@link freshSurfaceIdCount} ids synchronously, more
 * than the page's pool may hold, so a caller passes a `surfaceIdMinter`.
 */
export function withFreshSurfaceIds(session: PersistedSession, mint = mintSurfaceId): PersistedSession {
  const ids = new Map<string, string>();
  const fresh = (id: string): string => {
    let next = ids.get(id);
    if (next === undefined) ids.set(id, next = mint());
    return next;
  };
  for (const pane of session.panes) fresh(pane.id);
  for (const door of session.doors ?? []) fresh(door.id);
  // An id outside the record (a token's sibling that has since closed) maps to
  // nothing live either way, so it is left as written.
  const rename = (id: unknown): unknown => typeof id === 'string' ? ids.get(id) ?? id : id;
  const renameNode = (node: LathNode): LathNode => node.kind === 'leaf'
    ? { ...node, id: rename(node.id) as string }
    : { ...node, children: node.children.map(child => ({ ...child, node: renameNode(child.node) })) };
  const layout = session.lathLayout;
  return {
    ...session,
    panes: session.panes.map(pane => ({ ...pane, id: fresh(pane.id) })),
    ...(session.doors ? {
      doors: session.doors.map(door => ({
        ...door,
        id: fresh(door.id),
        ...(isRecord(door.token) ? { token: {
          ...door.token,
          leafId: rename(door.token.leafId),
          siblingId: rename(door.token.siblingId),
          ...(Array.isArray(door.token.siblingLeafIds) ? { siblingLeafIds: door.token.siblingLeafIds.map(rename) } : {}),
        } } : {}),
      })),
    } : {}),
    ...(isLathPersistedLayout(layout) ? {
      lathLayout: {
        ...layout,
        tree: { root: layout.tree.root && renameNode(layout.tree.root) },
        leafMeta: Object.fromEntries(Object.entries(layout.leafMeta).map(([id, meta]) => [rename(id) as string, meta])),
      },
    } : {}),
  };
}
