/** LathHost's read-only leaf projection; writes use `PaneWriteContext`. */
export type PaneProps = {
  id: string;
  /** Engine-tracked title — the *fallback* display; live titles come from the
   *  terminal-state stores. */
  title: string | undefined;
  params: Record<string, unknown> | undefined;
  /** Mounted outside the tree; streaming bodies must idle via `useSurfaceVisibility`. */
  parked?: boolean;
};
