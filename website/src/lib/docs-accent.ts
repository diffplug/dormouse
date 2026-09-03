/**
 * The docs pages' link colour, derived from the theme the reader picked.
 *
 * **Never** take it from `--vscode-textLink-foreground`. No bundled theme
 * defines `textLink.foreground`, so that variable always resolves to the
 * colour registry's default for the theme's *kind* — one blue on every dark
 * theme, one on every light one — and links looked identical whichever theme
 * was chosen. Every theme does carry an `accent`, which is the colour a reader
 * recognises it by.
 *
 * **Must** correct that accent for contrast before using it as body text.
 * Taken raw, 7 of the 11 bundled accents fall below WCAG AA against their own
 * background and four carry alpha, so using them directly would undo the
 * contrast work that moved these links off brand caramel in the first place.
 *
 * Correction walks the accent toward white or black — whichever the background
 * is not — and stops at the first step that clears the threshold, so a theme
 * keeps as much of its accent as contrast allows. Pinned by
 * `website/src/lib/docs-accent.test.ts`, which checks every bundled theme.
 */

/** WCAG AA for body text. */
const MIN_CONTRAST = 4.5;

type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb`, and `#rrggbbaa`; alpha separated out. */
function parseHex(color: string): { rgb: Rgb; alpha: number } | null {
  const hex = color.trim().replace(/^#/, "");
  const full =
    hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex.length === 4 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], alpha: full.length === 8 ? n(6) / 255 : 1 };
}

const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * A link colour for `accent` that is legible on `background`.
 *
 * Returns `null` when either colour is unparseable, so the caller can leave
 * the stylesheet's own fallback in place rather than guess.
 */
export function docsAccentFor(
  accent: string,
  background: string,
  minContrast = MIN_CONTRAST,
): string | null {
  const fg = parseHex(accent);
  const bg = parseHex(background);
  if (!fg || !bg) return null;

  // Alpha is against the page, so flatten before measuring anything.
  const base = fg.alpha < 1 ? mix(bg.rgb, fg.rgb, fg.alpha) : fg.rgb;
  if (contrastRatio(base, bg.rgb) >= minContrast) return toHex(base);

  const toward: Rgb = luminance(bg.rgb) < 0.5 ? [255, 255, 255] : [0, 0, 0];
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(base, toward, step / 20);
    if (contrastRatio(candidate, bg.rgb) >= minContrast) return toHex(candidate);
  }
  // Nothing on the ramp cleared it, so take the end of it — pure white or
  // black always beats any mid-point against this background.
  return toHex(toward);
}
