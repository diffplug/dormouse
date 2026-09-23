import { expect, it } from 'vitest';
import { ringPerimeter } from './ring-geometry';
import { rectUnionOutline, roundedUnionOutline } from './rect-union-outline';

it('removes the shared seam while retaining a smaller helper’s step', () => {
  const union = rectUnionOutline({ left: 10, top: 20, width: 100, height: 100 }, { left: 90, top: 20, width: 80, height: 50 });
  expect(union.rect).toEqual({ left: 10, top: 20, width: 160, height: 100 });
  expect(union.points).toEqual([{ x: 0, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 50 }, { x: 100, y: 50 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
  expect(roundedUnionOutline(union.points, 8).path).not.toMatch(/NaN|Infinity/);
  expect(roundedUnionOutline(union.points, 8).path).toContain('Q100,50');
});
it('keeps an inset helper inside the original outline', () => {
  const source = { left: 0, top: 0, width: 100, height: 100 };
  expect(rectUnionOutline(source, { left: 16, top: 16, width: 68, height: 30 }).points).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]);
});
it.each(['left', 'right', 'top', 'bottom'] as const)('encloses both rectangles opening %s without extra area', side => {
  const source = { left: 0, top: 0, width: 100, height: 100 };
  const helper = { left: side === 'left' ? -64 : side === 'right' ? 84 : 0, top: side === 'top' ? -64 : side === 'bottom' ? 84 : 0, width: 80, height: 80 };
  const { points } = rectUnionOutline(source, helper);
  const area = Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
  expect(area).toBe(10000 + 6400 - 16 * 80);
});

it('matches the regular ring perimeter for a rectangular union', () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 };
  const outline = roundedUnionOutline(rectUnionOutline(rect, rect).points, 8);
  expect(outline.perimeter).toBeCloseTo(ringPerimeter(rect, { tl: 8, tr: 8, bl: 8, br: 8, inset: 0 }));
});
