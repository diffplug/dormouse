/** Props every pane body / header component receives
 *  (docs/specs/tiling-engine.md → "Pane props contract"). LathHost supplies these
 *  directly from the leaf's `leafMeta`. Writes go through `PaneWriteContext`
 *  (see `wall-context.tsx`), not through these props. */
export type PaneProps = {
  id: string;
  /** Engine-tracked title — the *fallback* display; live titles come from the
   *  terminal-state stores. */
  title: string | undefined;
  params: Record<string, unknown> | undefined;
};
