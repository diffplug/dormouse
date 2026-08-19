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
  /** Parked: this leaf is mounted but out of the tree, so it is on screen in the
   *  DOM sense and invisible in every other sense (docs/specs/tiling-engine.md →
   *  "Parked leaves"). Bodies that stream, poll, or paint must idle while it is
   *  true — pass it to `useSurfaceVisibility`. Absent means "not parked", so
   *  components rendered outside LathHost (Storybook, tests) need not set it. */
  parked?: boolean;
};
