// Perceptual color helpers for theme-aware "biggest delta" pickers.

/** Parse any CSS color (hex, rgb, hsl, named, color-mix…) to sRGB bytes via
 *  canvas. Returns null for an empty string; an invalid color reads as black.
 *
 *  globalCompositeOperation='copy' ensures each fillRect replaces the pixel
 *  rather than alpha-compositing over the previous fill — without it,
 *  translucent colors like `#b3880088` blend with whatever was read last and
 *  lose their saturation. The `#000` pre-fill covers invalid color strings
 *  (where fillStyle is a no-op), preventing the previous fillStyle from
 *  leaking through. */
export function rgbOf(color: string, ctx: CanvasRenderingContext2D): [number, number, number] | null {
  if (!color) return null;
  ctx.globalCompositeOperation = 'copy';
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

/** sRGB (0-255 bytes) → OKLab (Björn Ottosson's transform). */
export function rgbToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const toLinear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

/** Perceptually-uniform ΔE — Euclidean distance in OKLab. */
export function deltaEOklab(a: [number, number, number], b: [number, number, number]): number {
  const dL = a[0] - b[0], da = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** OKLab chroma √(a²+b²). ≈0 for greys, ~0.10 for visible accents, ~0.20+ for
 *  vivid sRGB colors. Independent of lightness. */
export function chromaOklab([, a, b]: [number, number, number]): number {
  return Math.sqrt(a * a + b * b);
}
