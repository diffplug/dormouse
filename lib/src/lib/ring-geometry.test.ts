import { describe, expect, it } from 'vitest';
import {
  CORNER_EDGES,
  RING_PIECES,
  cornerPath,
  edgePath,
  isRingCorner,
  ringPerimeter,
  roundedRectPath,
  type RingCorner,
} from './ring-geometry';
import type { RingRect, RingShape } from './rect-tween';

const RECT: RingRect = { top: 0, left: 0, width: 200, height: 120 };
const SHAPE: RingShape = { tl: 12, tr: 12, br: 12, bl: 12, inset: 4 };
/** A door: square bottom corners, so two of the four arcs are degenerate. */
const DOOR: RingShape = { tl: 8, tr: 8, br: 0, bl: 0, inset: 1 };

/** Every coordinate pair in a path string, in order. */
function points(d: string): [number, number][] {
  return [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

describe('ring-geometry', () => {
  it('cuts the smear pieces from the same anchors as the ring outline', () => {
    // The whole point of one shared point set: every smear endpoint must land ON
    // the outline. If these drift the smear detaches from the ring behind it, and
    // nothing else in the suite would catch a 1px gap.
    const outline = new Set(points(roundedRectPath(RECT, SHAPE)).map(String));
    for (const piece of RING_PIECES) {
      const d = isRingCorner(piece)
        ? cornerPath(piece, RECT, SHAPE, 1, 1)
        : edgePath(piece, RECT, SHAPE);
      for (const p of points(d)) {
        expect(outline.has(String(p))).toBe(true);
      }
    }
  });

  it('joins each edge end to the corner that continues it', () => {
    for (const corner of Object.keys(CORNER_EDGES) as RingCorner[]) {
      const [vertical, horizontal] = CORNER_EDGES[corner];
      const arc = points(cornerPath(corner, RECT, SHAPE, 1, 1));
      const ends = [...points(edgePath(vertical, RECT, SHAPE)), ...points(edgePath(horizontal, RECT, SHAPE))];
      // The arc's two tangent points are each shared with one of its neighbours.
      for (const end of [arc[0], arc[2]]) {
        expect(ends.some(([x, y]) => x === end[0] && y === end[1])).toBe(true);
      }
    }
  });

  it('pre-divides a corner so a sibling scale(a, b) restores it exactly', () => {
    // The load-bearing half of the taper: `d` is authored in pre-scale space, and
    // multiplying back by (a, b) must reproduce the unscaled arc to the last bit.
    const [a, b] = [6, 2.5];
    const scaled = points(cornerPath('tr', RECT, SHAPE, a, b));
    const plain = points(cornerPath('tr', RECT, SHAPE, 1, 1));
    scaled.forEach(([x, y], k) => {
      expect(x * a).toBeCloseTo(plain[k][0], 9);
      expect(y * b).toBeCloseTo(plain[k][1], 9);
    });
  });

  it('collapses a zero-radius corner to a point without going negative', () => {
    // Doors have square bottom corners, and the inset can exceed the radius —
    // `Math.max(0, r - inset)` must not fold the arc back on itself.
    const arc = points(cornerPath('br', RECT, DOOR, 1, 1));
    const [from, ctrl, to] = arc;
    expect(from).toEqual(ctrl);
    expect(to).toEqual(ctrl);
    // ...and the outline still closes over the same corner.
    expect(points(roundedRectPath(RECT, DOOR))).toContainEqual(ctrl);
  });

  describe('ringPerimeter', () => {
    /** Walk the emitted `d` and measure it by brute force: straight runs exactly,
     *  quadratic corners by dense flattening. Independent of QUARTER_TURN, so this
     *  catches a wrong constant rather than restating it. */
    function measure(d: string, steps = 20_000): number {
      const tokens = d.trim().split(/(?=[MLQZ])/).map((t) => t.trim()).filter(Boolean);
      const nums = (t: string) => [...t.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as const);
      let cur: readonly [number, number] = [0, 0];
      let start: readonly [number, number] = [0, 0];
      let total = 0;
      const hyp = (a: readonly [number, number], b: readonly [number, number]) => Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (const token of tokens) {
        const op = token[0];
        const pts = nums(token);
        if (op === 'M') { cur = pts[0]; start = pts[0]; continue; }
        if (op === 'L') { total += hyp(cur, pts[0]); cur = pts[0]; continue; }
        if (op === 'Z') { total += hyp(cur, start); cur = start; continue; }
        // Q: flatten the quadratic finely.
        const [ctrl, end] = pts;
        let prev = cur;
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const mt = 1 - t;
          const p = [
            mt * mt * cur[0] + 2 * mt * t * ctrl[0] + t * t * end[0],
            mt * mt * cur[1] + 2 * mt * t * ctrl[1] + t * t * end[1],
          ] as const;
          total += hyp(prev, p);
          prev = p;
        }
        cur = end;
      }
      return total;
    }

    it('matches a brute-force measurement of the path it emits', () => {
      for (const shape of [SHAPE, DOOR, { ...SHAPE, inset: 0 }, { ...SHAPE, tl: 30, br: 2 }]) {
        expect(ringPerimeter(RECT, shape)).toBeCloseTo(measure(roundedRectPath(RECT, shape)), 4);
      }
    });

    it('is not the quarter-CIRCLE length — the corners are quadratics', () => {
      // A 3% trap: swapping in PI/2 would silently shift every dash.
      const square: RingShape = { tl: 20, tr: 20, br: 20, bl: 20, inset: 0 };
      const circleApprox = 2 * (RECT.width + RECT.height) + (Math.PI / 2 - 2) * 80;
      expect(ringPerimeter(RECT, square)).not.toBeCloseTo(circleApprox, 1);
      expect(ringPerimeter(RECT, square)).toBeCloseTo(measure(roundedRectPath(RECT, square)), 4);
    });

    it('reduces to the plain rectangle when every corner is square', () => {
      const sharp: RingShape = { tl: 0, tr: 0, br: 0, bl: 0, inset: 3 };
      expect(ringPerimeter(RECT, sharp)).toBeCloseTo(2 * ((RECT.width - 6) + (RECT.height - 6)), 9);
    });
  });

  it('insets the outline symmetrically on every side', () => {
    const xs = points(roundedRectPath(RECT, SHAPE)).map(([x]) => x);
    const ys = points(roundedRectPath(RECT, SHAPE)).map(([, y]) => y);
    expect(Math.min(...xs)).toBe(SHAPE.inset);
    expect(Math.max(...xs)).toBe(RECT.width - SHAPE.inset);
    expect(Math.min(...ys)).toBe(SHAPE.inset);
    expect(Math.max(...ys)).toBe(RECT.height - SHAPE.inset);
  });
});
