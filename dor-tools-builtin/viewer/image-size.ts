/** Default image sizes in the Markdown editor (docs/specs/dor-tools-builtin.md
 * -> Markdown editor). An image the document gives no width or height shows at
 * `defaultDisplayWidth`, a width on its wrapper that never reaches the
 * document. */
import { useLayoutEffect, type RefObject } from 'react';
import { defaultDisplayWidth, RESOLUTION_HEAD } from '../src/image-resolution';

/** Each image URL's default width, read once, and those read so far. */
const widths = new Map<string, Promise<number | null>>();
const known = new Map<string, number | null>();

/** Forgets every default width, so each image's file is read again. */
export function forgetImageWidths(): void {
  widths.clear();
  known.clear();
}

/** The width the image at `url` shows at when its document gives none, read
 * once per URL; null for pixel for pixel. */
export function defaultWidth(url: string): Promise<number | null> {
  let width = widths.get(url);
  if (!width) {
    const read: Promise<number | null> = head(url).then(defaultDisplayWidth, () => null).then(found => {
      if (widths.get(url) === read) known.set(url, found);
      return found;
    });
    widths.set(url, width = read);
  }
  return width;
}

/** Sets the default width of the image at `url` on the wrapper of `ref`'s
 * element (MDXEditor's, around the `<img>`), which markdown.css applies to
 * the image: before paint when it is already read, else once it is; and
 * clears it when `url` goes null, as the image gains a size. */
export function useDefaultWidth(ref: RefObject<HTMLElement | null>, url: string | null): void {
  useLayoutEffect(() => {
    const wrapper = ref.current?.parentElement;
    if (!wrapper || !url) return;
    const show = (width: number | null) => {
      wrapper.classList.toggle('md-default-size', width !== null);
      if (width === null) wrapper.style.removeProperty('--default-width');
      else wrapper.style.setProperty('--default-width', `${width}px`);
    };
    let live = true;
    const read = known.get(url);
    if (read !== undefined) show(read);
    else void defaultWidth(url).then(width => { if (live) show(width); });
    return () => { live = false; show(null); };
  }, [ref, url]);
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
