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
 * Correction walks the accent toward whichever of white or black contrasts
 * more with the background, stopping at the first step that clears the
 * threshold, so a theme keeps as much of its accent as contrast allows.
 * Pinned by
 * `website/src/lib/docs-accent.test.ts`, which checks every bundled theme.
 */

/** WCAG AA for body text. */
const MIN_CONTRAST = 4.5;

type Rgb = [number, number, number];

/** `#rgb`, `#rrggbb`, and `#rrggbbaa`; alpha separated out. */
function parseHex(color: string): { rgb: Rgb; alpha: number } | null {
  const hex = color.trim().replace(/^#/, "");
  // `#rgb` and `#rgba` both expand by doubling each digit.
  const full = hex.length === 3 || hex.length === 4 ? [...hex].map((c) => c + c).join("") : hex;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { rgb: [n(0), n(2), n(4)], alpha: full.length === 8 ? n(6) / 255 : 1 };
}

const toHex = ([r, g, b]: Rgb) =>
  `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;

/** Rounded, because `toHex` rounds: an unrounded candidate can clear the
 *  threshold while the colour actually returned falls under it. Covers the
 *  alpha flatten too, which goes through here. */
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
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

/** The opaque colour CSS paints when `foreground` is drawn over `background`
 *  at `opacity`. This keeps contrast derivations on the same surface the
 *  browser renders for Tailwind's colour/opacity utilities. */
export function compositeColor(
  foreground: string,
  background: string,
  opacity: number,
): string | null {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return null;
  return toHex(mix(bg.rgb, fg.rgb, Math.min(1, Math.max(0, fg.alpha * opacity))));
}

/**
 * Both colours as opaque RGB, or `null` when either is unreadable.
 *
 * Alpha is against the page, so a translucent foreground is flattened onto the
 * background before anything measures it.
 */
function flatten(
  foreground: string,
  background: string,
): { base: Rgb; bg: Rgb } | null {
  const fg = parseHex(foreground);
  const bg = parseHex(background);
  if (!fg || !bg) return null;
  return { base: fg.alpha < 1 ? mix(bg.rgb, fg.rgb, fg.alpha) : fg.rgb, bg: bg.rgb };
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
  const flat = flatten(accent, background);
  if (!flat) return null;
  const { base, bg } = flat;
  if (contrastRatio(base, bg) >= minContrast) return toHex(base);

  // Whichever end contrasts more, measured rather than guessed from a
  // luminance midpoint: that is not where the crossover sits, and a mid-tone
  // background is neither light nor dark.
  const white: Rgb = [255, 255, 255];
  const black: Rgb = [0, 0, 0];
  const toward: Rgb = contrastRatio(white, bg) >= contrastRatio(black, bg) ? white : black;

  // The last step is `toward` itself, so the best available colour is always
  // among these — there is nothing left to fall back to.
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(base, toward, step / 20);
    if (contrastRatio(candidate, bg) >= minContrast) return toHex(candidate);
  }
  return toHex(toward);
}

/**
 * The quietest version of `foreground` that still clears body-text AA on
 * `background`.
 *
 * Element opacity made the same text land at a different effective contrast on
 * every reader-picked theme. Returning an opaque colour makes the role stable
 * across nested and tinted surfaces; typography carries any hierarchy a theme
 * whose base foreground is already near 4.5:1 cannot safely express in colour.
 */
export function docsMutedTextFor(
  foreground: string,
  background: string,
  minContrast = MIN_CONTRAST,
): string | null {
  const flat = flatten(foreground, background);
  if (!flat) return null;
  const { base, bg } = flat;

  // Already too faint to be body text: there is nothing to quieten, so borrow
  // the accent path's boost away from the background instead.
  if (contrastRatio(base, bg) < minContrast) {
    return docsAccentFor(toHex(base), background, minContrast);
  }

  let quietest = base;
  for (let step = 1; step <= 100; step += 1) {
    const candidate = mix(base, bg, step / 100);
    if (contrastRatio(candidate, bg) < minContrast) break;
    quietest = candidate;
  }
  return toHex(quietest);
}
