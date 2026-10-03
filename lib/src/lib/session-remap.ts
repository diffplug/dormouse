import type { LathNode } from './lath/model';
import { isLathPersistedLayout } from './lath/persistence';
import type { PersistedSession } from './session-types';
import { isRecord } from './is-record';

/**
 * A closed Workspace's record with every Surface given a fresh id, for Reopen
 * (`docs/specs/reopen.md`): the rebuilt Sessions must never share an id — a
 * PTY's, the host's — with the ones the close just killed, and its `surface:N`
 * refs start over in the Workspace it reopens as.
 */
export function withFreshSurfaceIds(session: PersistedSession, mint: () => string): PersistedSession {
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
  const { surfaceRefs: _refs, surfaceRefsNext: _next, ...rest } = session;
  const layout = session.lathLayout;
  return {
    ...rest,
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
