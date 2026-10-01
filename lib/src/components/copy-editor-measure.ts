// The copy editor's DOM measurements for its placement
// (docs/specs/mouse-and-clipboard.md §4.5), apart from the component so tests
// can stand in for layout jsdom does not do. Every read is of the editor's own
// subtree; nothing here writes the editor's geometry.

/** The editor's parts, as `CopyEditor` renders them. */
export interface CopyEditorParts {
  root: HTMLElement;
  header: HTMLElement;
  /** The scrolling preview, its scrollbar gutter reserved. */
  preview: HTMLElement;
  footer: HTMLElement;
  /** A `w-max` row of every format's longest lines, laid out unwrapped. */
  probe: HTMLElement;
}

/** The root's own borders: it clips, so it never shows a scrollbar. */
const borderX = (root: HTMLElement) => root.offsetWidth - root.clientWidth;
const borderY = (root: HTMLElement) => root.offsetHeight - root.clientHeight;

/** The editor's width with its longest line unwrapped: the probe, plus the
 *  preview's scrollbar gutter and the root's borders. */
export function measureNaturalWidth({ root, preview, probe }: CopyEditorParts): number {
  return Math.ceil(probe.getBoundingClientRect().width) + preview.offsetWidth - preview.clientWidth + borderX(root);
}

/** The editor's whole height at a given width, for the rendering the preview
 *  shows now: header, footer and borders as laid out, which never wrap, plus
 *  the preview's lines rewrapped at that width. Cached per width; build a new
 *  one when the rendering changes. */
export function createHeightMeasurer({ root, header, preview, footer }: CopyEditorParts): (width: number) => number {
  const cache = new Map<number, number>();
  return (width) => {
    const w = Math.round(width);
    let height = cache.get(w);
    if (height === undefined) {
      // A detached copy of the preview, out of flow inside the root so it
      // inherits the root's type, laid out at the width the root would give it.
      const copy = preview.cloneNode(true) as HTMLElement;
      copy.setAttribute('aria-hidden', 'true');
      copy.inert = true;
      copy.style.cssText = `position:absolute;left:0;top:0;visibility:hidden;height:auto;width:${w - borderX(root)}px`;
      root.append(copy);
      height = header.offsetHeight + footer.offsetHeight + copy.offsetHeight + borderY(root);
      copy.remove();
      cache.set(w, height);
    }
    return height;
  };
}
