import type { RingRect } from './rect-tween';
import { QUARTER_TURN } from './ring-geometry';

type Point = { x: number; y: number };
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;

/** Outer contour of two overlapping rectangles. Grid cells remove internal seams
 *  before rounding, so a smaller helper leaves a step rather than framing peers. */
export function rectUnionOutline(a: RingRect, b: RingRect) {
  const xs = [...new Set([a.left, a.left + a.width, b.left, b.left + b.width])].sort((x, y) => x - y);
  const ys = [...new Set([a.top, a.top + a.height, b.top, b.top + b.height])].sort((x, y) => x - y);
  const inside = (x: number, y: number) => [a, b].some(r => x > r.left && x < r.left + r.width && y > r.top && y < r.top + r.height);
  const filled = (i: number, j: number) => i >= 0 && j >= 0 && i < xs.length - 1 && j < ys.length - 1 && inside((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2);
  const edges: [Point, Point][] = [];
  for (let i = 0; i < xs.length - 1; i++) for (let j = 0; j < ys.length - 1; j++) {
    if (!filled(i, j)) continue;
    const tl = { x: xs[i], y: ys[j] }, tr = { x: xs[i + 1], y: ys[j] };
    const br = { x: xs[i + 1], y: ys[j + 1] }, bl = { x: xs[i], y: ys[j + 1] };
    if (!filled(i, j - 1)) edges.push([tl, tr]);
    if (!filled(i + 1, j)) edges.push([tr, br]);
    if (!filled(i, j + 1)) edges.push([br, bl]);
    if (!filled(i - 1, j)) edges.push([bl, tl]);
  }
  const points: Point[] = [];
  let edge = edges.shift();
  while (edge) {
    points.push(edge[0]);
    const next = edges.findIndex(candidate => same(candidate[0], edge![1]));
    edge = next < 0 ? undefined : edges.splice(next, 1)[0];
  }
  const corners = points.filter((p, i) => {
    const before = points[(i + points.length - 1) % points.length], after = points[(i + 1) % points.length];
    return !((before.x === p.x && p.x === after.x) || (before.y === p.y && p.y === after.y));
  });
  const rect = { left: xs[0], top: ys[0], width: xs[xs.length - 1] - xs[0], height: ys[ys.length - 1] - ys[0] };
  return { rect, points: corners.map(p => ({ x: p.x - rect.left, y: p.y - rect.top })) };
}

export function roundedUnionOutline(points: Point[], radius: number) {
  const toward = (p: Point, q: Point, distance: number) => {
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    return `${p.x + (q.x - p.x) * distance / length},${p.y + (q.y - p.y) * distance / length}`;
  };
  let perimeter = 0;
  const path = points.map((p, i) => {
    const before = points[(i + points.length - 1) % points.length], after = points[(i + 1) % points.length];
    const r = Math.min(radius, Math.hypot(p.x - before.x, p.y - before.y) / 2, Math.hypot(p.x - after.x, p.y - after.y) / 2);
    perimeter += Math.hypot(p.x - after.x, p.y - after.y) + (QUARTER_TURN - 2) * r;
    return `${i ? 'L' : 'M'}${toward(p, before, r)} Q${p.x},${p.y} ${toward(p, after, r)}`;
  }).join(' ') + ' Z';
  return { path, perimeter };
}
