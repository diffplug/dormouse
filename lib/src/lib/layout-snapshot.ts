import { type SerializedDockview } from 'dockview-react';

export function cloneLayout(layout: SerializedDockview): SerializedDockview {
  return structuredClone(layout);
}

/** Strip size data from the grid tree so we only compare structure.
 *  dockview branch nodes hold their children under `data` (an array); leaf
 *  nodes hold their view membership under `data` (an object). We drop each
 *  node's own `size` and recurse into branch children so nested resizes don't
 *  leak into the structural signature. Leaf `data` is preserved so panel
 *  grouping still counts. */
function stripSizes(node: any): any {
  const { size, ...rest } = node;
  if (Array.isArray(rest.data)) {
    return { ...rest, data: rest.data.map(stripSizes) };
  }
  return rest;
}

/** Structural fingerprint of a layout — ignores sizes/proportions so resizing
 *  doesn't invalidate a snapshot. Only compares tree shape and panel membership. */
export function getLayoutStructureSignature(layout: SerializedDockview): string {
  return JSON.stringify({
    root: stripSizes(layout.grid.root),
    orientation: layout.grid.orientation,
    panels: Object.keys(layout.panels).sort(),
  });
}
