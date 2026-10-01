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
  widthProbe: HTMLElement;
  /** A `w-max` copy of the header and footer, as wide as any format shows them. */
  chromeProbe: HTMLElement;
  /** A hidden copy of the preview, out of flow inside the root so it inherits
   *  the root's type, its height left to its lines. */
  heightProbe: HTMLElement;
}

/** The root's own borders: it clips, so it never shows a scrollbar. */
const borderX = (root: HTMLElement) => root.offsetWidth - root.clientWidth;
const borderY = (root: HTMLElement) => root.offsetHeight - root.clientHeight;

/** The editor's width with its longest line unwrapped: the probe, plus the
 *  preview's scrollbar gutter and the root's borders. */
export function measureNaturalWidth({ root, preview, widthProbe }: CopyEditorParts): number {
  return Math.ceil(widthProbe.getBoundingClientRect().width) + preview.offsetWidth - preview.clientWidth + borderX(root);
}

/** The editor's width with its header and footer whole: the chrome probe,
 *  plus the root's borders. */
export function measureChromeWidth({ root, chromeProbe }: CopyEditorParts): number {
  return Math.ceil(chromeProbe.getBoundingClientRect().width) + borderX(root);
}

/** The editor's whole height at a given width, for the rendering the preview
 *  shows now: header, footer and borders as laid out, which never wrap, plus
 *  the height probe's lines rewrapped at the width the root would give the
 *  preview. Cached per width; build a new one when the rendering changes. */
export function createHeightMeasurer({ root, header, footer, heightProbe }: CopyEditorParts): (width: number) => number {
  const cache = new Map<number, number>();
  return (width) => {
    const w = Math.round(width);
    let height = cache.get(w);
    if (height === undefined) {
      heightProbe.style.width = `${w - borderX(root)}px`;
      height = header.offsetHeight + footer.offsetHeight + heightProbe.offsetHeight + borderY(root);
      cache.set(w, height);
    }
    return height;
  };
}
