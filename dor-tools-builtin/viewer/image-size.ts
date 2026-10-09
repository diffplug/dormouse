/** Default image sizes in the Markdown editor (docs/specs/dor-tools-builtin.md
 * -> Markdown editor). An image the document gives no width or height shows at
 * `defaultDisplayWidth`, a width on its element that never reaches the
 * document. */
import { $getNodeByKey, type LexicalEditor, type NodeKey } from 'lexical';
import { $isImageNode, ImageNode } from '@mdxeditor/editor';
import { defaultDisplayWidth, RESOLUTION_HEAD } from '../src/image-resolution';

/** Each image URL's default width, read once. */
const widths = new Map<string, Promise<number | null>>();

/** Forgets every default width, so each image's file is read again. */
export const forgetImageWidths = () => widths.clear();

/** The width the image at `url` shows at when its document gives none, read
 * once per URL; null for pixel for pixel. */
export function defaultWidth(url: string): Promise<number | null> {
  let width = widths.get(url);
  if (!width) widths.set(url, width = head(url).then(defaultDisplayWidth, () => null));
  return width;
}

/** The first `RESOLUTION_HEAD` bytes at `url`. A server that ignores the
 * range sends the whole file, of which this reads only the head. */
async function head(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${RESOLUTION_HEAD - 1}` } });
  if (!response.ok || !response.body) throw new Error(`${response.status}`);
  const reader = response.body.getReader(), out = new Uint8Array(RESOLUTION_HEAD);
  let length = 0;
  while (length < out.length) {
    const { done, value } = await reader.read();
    if (done) break;
    const n = Math.min(value.length, out.length - length);
    out.set(value.subarray(0, n), length);
    length += n;
  }
  void reader.cancel().catch(() => {});
  return out.subarray(0, length);
}

/** Sets or clears the default width on an image node's element, which markdown.css applies to its `<img>`. */
function show(element: HTMLElement | null, width: number | null) {
  if (!element) return;
  element.classList.toggle('md-default-size', width !== null);
  if (width === null) element.style.removeProperty('--default-width');
  else element.style.setProperty('--default-width', `${width}px`);
}

/** The image sizing of a document's editors: the root's from the start, a
 * table cell's once one of its images renders (`track`). */
export interface ImageSizing {
  /** Sizes `editor`'s images too; once per editor. */
  track(editor: LexicalEditor): void;
  /** Sizes every image again, after `urlOf` changes. */
  refresh(): void;
  /** Whether an image of `src` may show at a default width: one is unsized,
   * or none is known yet. */
  mayDefault(src: string): boolean;
}

/** Sizes `editor`'s images, and those of each editor `track` adds, reading
 * each unsized one's head from `urlOf` its source (null for none). */
export function sizeImages(editor: LexicalEditor, urlOf: (src: string) => string | null): ImageSizing {
  const editors = new Map<LexicalEditor, Set<NodeKey>>();
  /** Node `key`'s source, and whether the document gives it a size. */
  const imageOf = (editor: LexicalEditor, key: NodeKey) => editor.read(() => {
    const node = $getNodeByKey(key);
    return $isImageNode(node) ? { src: node.getSrc(), unsized: node.getWidth() === 'inherit' && node.getHeight() === 'inherit' } : null;
  });
  /** The URL whose head sizes node `key`, or null when it has a size of its own. */
  const unsizedUrl = (editor: LexicalEditor, key: NodeKey) => {
    const image = imageOf(editor, key);
    return image?.unsized ? urlOf(image.src) : null;
  };
  const apply = (editor: LexicalEditor, key: NodeKey) => {
    const url = unsizedUrl(editor, key);
    if (!url) { show(editor.getElementByKey(key), null); return; }
    // The node may have changed, or gained a size, while its head was read.
    void defaultWidth(url).then(width => { if (unsizedUrl(editor, key) === url) show(editor.getElementByKey(key), width); });
  };
  const sizing: ImageSizing = {
    track(editor) {
      if (editors.has(editor)) return;
      const keys = new Set<NodeKey>();
      editors.set(editor, keys);
      editor.registerMutationListener(ImageNode, mutations => {
        for (const [key, mutation] of mutations) {
          if (mutation === 'destroyed') keys.delete(key);
          else { keys.add(key); apply(editor, key); }
        }
      });
    },
    refresh: () => editors.forEach((keys, editor) => keys.forEach(key => apply(editor, key))),
    mayDefault(src) {
      let known = false;
      for (const [editor, keys] of editors) {
        for (const key of keys) {
          const image = imageOf(editor, key);
          if (image?.src !== src) continue;
          if (image.unsized) return true;
          known = true;
        }
      }
      return !known;
    },
  };
  sizing.track(editor);
  return sizing;
}
