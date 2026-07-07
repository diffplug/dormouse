/** Props every pane body / header component receives, engine-agnostic
 *  (docs/specs/tiling-engine.md → "Pane props contract"). The dockview adapters in
 *  `dockview-panel-adapters.tsx` build these from a dockview panel object today;
 *  the LathHost binding will supply them directly. Writes go through
 *  `PaneWriteContext` (see `wall-context.tsx`), not through these props. */
export type PaneProps = {
  id: string;
  /** Engine-tracked title — the *fallback* display; live titles come from the
   *  terminal-state stores. */
  title: string | undefined;
  params: Record<string, unknown> | undefined;
  /** Engine visibility (dockview: active tab in its group; Lath: always true).
   *  Document visibility is NOT folded in here — `useSurfaceVisibility` combines
   *  the two. */
  panelVisible: boolean;
  /** Element to receive the pane-spawn animation class (dockview: the group
   *  element; Lath: the leaf div). Null when unavailable. */
  getAnimEl: () => HTMLElement | null;
};
