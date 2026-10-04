/** The image editor's one color rule: a swatch, the hex readout, and every
 * markup object's color are sRGB CSS colors. A pixel tool writes a swatch
 * converted into the image's color space, as a canvas in that space draws an
 * object in it, so one swatch gives the same pixels either way; the eyedropper
 * reads a pixel back as sRGB, so picking then painting keeps an in-gamut color. */
import type { Rgba } from './pixels';

export interface ImageColors {
  /** `hex` (`#rrggbb`, sRGB) as an opaque pixel in the image's space. */
  toImage(hex: string): Rgba;
  /** A pixel in the image's space as sRGB, its alpha kept. */
  toSrgb(pixel: Rgba): Rgba;
}

const parseHex = (hex: string): Rgba =>
  [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];

/** Conversions between sRGB and `space`, by the browser's own color
 * management in a 1×1 canvas (`canvas` makes it), each color converted once. */
export function imageColors(space: PredefinedColorSpace, canvas = () => document.createElement('canvas')): ImageColors {
  if (space === 'srgb') return { toImage: parseHex, toSrgb: pixel => pixel };
  let ctx: CanvasRenderingContext2D | null = null;
  /** The opaque color `paint` leaves in the canvas, read back in `read`, once per `key` in `cache`. */
  const convert = (cache: Map<string, Rgba>, key: string, paint: (c: CanvasRenderingContext2D) => void, read: PredefinedColorSpace): Rgba => {
    let out = cache.get(key);
    if (!out) {
      const c = ctx ??= canvas().getContext('2d', { colorSpace: space, willReadFrequently: true })!;
      paint(c);
      const [r, g, b] = c.getImageData(0, 0, 1, 1, { colorSpace: read }).data;
      cache.set(key, out = [r, g, b, 255]);
    }
    return out;
  };
  const toImage = new Map<string, Rgba>(), toSrgb = new Map<string, Rgba>();
  return {
    toImage: hex => convert(toImage, hex, c => { c.fillStyle = hex; c.fillRect(0, 0, 1, 1); }, space),
    toSrgb(pixel) {
      const [r, g, b] = convert(toSrgb, pixel.slice(0, 3).join(), c => {
        c.putImageData(new ImageData(new Uint8ClampedArray([pixel[0], pixel[1], pixel[2], 255]), 1, 1, { colorSpace: space }), 0, 0);
      }, 'srgb');
      return [r, g, b, pixel[3]];
    },
  };
}
