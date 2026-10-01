// The copy editor's DOM measurements for its placement
// (docs/specs/mouse-and-clipboard.md §4.5), apart from the component so tests
// can stand in for layout jsdom does not do. Every read is of the editor's own
// subtree; nothing here writes the editor's geometry.

/** The editor's parts, as `CopyEditor` renders them. */
export interface CopyEditorParts {
  /** The visible editor, bordered, inside any touch slop around it. */
  surface: HTMLElement;
  header: HTMLElement;
  /** The scrolling preview, its scrollbar gutter reserved. */
  preview: HTMLElement;
  footer: HTMLElement;
  /** A `w-max` row of every format's longest lines, laid out unwrapped. */
  widthProbe: HTMLElement;
  /** A hidden copy of the preview, out of flow inside the surface so it
   *  inherits the surface's type, its height left to its lines. */
  heightProbe: HTMLElement;
}

/** The surface's own borders: it clips, so it never shows a scrollbar. */
const borderX = (surface: HTMLElement) => surface.offsetWidth - surface.clientWidth;
const borderY = (surface: HTMLElement) => surface.offsetHeight - surface.clientHeight;

/** The editor's width with its longest line unwrapped: the probe, plus the
 *  preview's scrollbar gutter and the surface's borders. */
export function measureNaturalWidth({ surface, preview, widthProbe }: CopyEditorParts): number {
  return Math.ceil(widthProbe.getBoundingClientRect().width) + preview.offsetWidth - preview.clientWidth + borderX(surface);
}

/** The editor's width with a `w-max` probe of its content whole, plus the
 *  surface's borders. */
export function measureWidth(surface: HTMLElement, probe: HTMLElement): number {
  return Math.ceil(probe.getBoundingClientRect().width) + borderX(surface);
}

/** The editor's whole height at a given width, for the rendering the preview
 *  shows now: header, footer and borders as laid out, which never wrap, plus
 *  the height probe's lines rewrapped at the width the surface would give the
 *  preview. Cached per width; build a new one when the rendering changes. */
export function createHeightMeasurer({ surface, header, footer, heightProbe }: CopyEditorParts): (width: number) => number {
  const cache = new Map<number, number>();
  return (width) => {
    const w = Math.round(width);
    let height = cache.get(w);
    if (height === undefined) {
      heightProbe.style.width = `${w - borderX(surface)}px`;
      height = header.offsetHeight + footer.offsetHeight + heightProbe.offsetHeight + borderY(surface);
      cache.set(w, height);
    }
    return height;
  };
}
