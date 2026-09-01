import { useMemo } from 'react';
import { encode } from 'uqr';

/**
 * A QR code as inline SVG, for the Settings dialog's phone-setup panel
 * (`docs/specs/server.md` → "Remote control, in the Settings dialog").
 *
 * `uqr` is a pure, dependency-free encoder: it answers a boolean matrix and
 * this module does the drawing, so nothing here reaches for a canvas, an image
 * decoder, or a network round trip.
 */

/**
 * Quiet zone, in modules. Four is what the QR specification requires, and
 * scanners genuinely enforce it — `uqr` defaults to one, which reads as a code
 * that "sometimes" scans depending on what sits next to it.
 */
const QUIET_ZONE_MODULES = 4;

/**
 * Error correction level. `M` (15%) over the library's default `L` because this
 * code is read off a laptop screen at an angle, in whatever light the room has.
 */
const ERROR_CORRECTION = 'M' as const;

/*
 * The one place in `lib/src` that names a color literally, against DESIGN.md's
 * "never hardcode colors". A QR is read by a phone camera rather than by a
 * person: scanners expect dark modules on a light ground, many refuse an
 * inverted code outright, and no theme token can promise either the polarity or
 * the contrast ratio in both light and dark. Painting the tile itself is what
 * makes the code scannable whatever surface it lands on — the honest trade for
 * a control whose whole job is to be machine-readable.
 */
const QR_LIGHT = '#ffffff';
const QR_DARK = '#000000';

/**
 * The dark modules as one SVG path, in module units, so the whole code is a
 * single DOM node instead of one `<rect>` per module (a version-4 code is ~1200
 * of them). Horizontal runs are merged, which is most of the win.
 */
function modulesToPath(matrix: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.length; y++) {
    const row = matrix[y]!;
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      parts.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  }
  return parts.join('');
}

export function QrCode({
  value,
  /** Rendered edge length in px, quiet zone included. */
  size = 168,
  label,
  className,
}: {
  value: string;
  size?: number;
  /** Accessible name; the code itself is an image with no text in it. */
  label: string;
  className?: string;
}) {
  const qr = useMemo(
    () => encode(value, { border: QUIET_ZONE_MODULES, ecc: ERROR_CORRECTION }),
    [value],
  );
  const path = useMemo(() => modulesToPath(qr.data), [qr]);

  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      // Modules are whole pixels only when the browser is told not to smooth
      // them; an antialiased edge is exactly the blur a scanner trips over.
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={qr.size} height={qr.size} fill={QR_LIGHT} />
      <path d={path} fill={QR_DARK} />
    </svg>
  );
}
