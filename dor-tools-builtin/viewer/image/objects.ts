/** The image editor's markup: vector objects drawn above the raster, editable
 * until the image is saved or closed. All coordinates are image pixels. */
import type { Point, Rect } from './pixels';

interface Base { id: string; color: string; width: number }
type BoxKind = 'rect' | 'ellipse' | 'redact';
export type Shape =
  | Base & { kind: BoxKind; x: number; y: number; w: number; h: number }
  | Base & { kind: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | Base & { kind: 'highlight'; points: readonly Point[] }
  | Base & { kind: 'text'; x: number; y: number; text: string }
  | Base & { kind: 'callout'; x: number; y: number; n: number };

/** A resize handle: box corners and edge midpoints, or an arrow's ends. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'start' | 'end';

let ids = 0;
export const newId = () => `o${++ids}`;

/** Text and callouts scale with the stroke width. */
export const fontSize = (width: number) => 12 + width * 3;
const calloutRadius = (width: number) => fontSize(width) * 0.75;
const arrowHead = (width: number) => Math.max(10, width * 3.5);
const highlightWidth = (width: number) => Math.max(8, width * 4);
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const textLines = (text: string) => text.split('\n');

/** A label's measured size, from an offscreen context. */
let measurer: CanvasRenderingContext2D | null = null;
function textBox(shape: Extract<Shape, { kind: 'text' }>): Rect {
  measurer ??= document.createElement('canvas').getContext('2d');
  const size = fontSize(shape.width), lines = textLines(shape.text);
  let w = size;
  if (measurer) {
    measurer.font = `600 ${size}px ${FONT}`;
    w = Math.max(size / 2, ...lines.map(line => measurer!.measureText(line).width));
  }
  return { x: shape.x, y: shape.y, width: w, height: lines.length * size * 1.25 };
}

/** Black or white, whichever reads on `color`. */
export function contrast(color: string): string {
  const n = parseInt(color.slice(1, 7), 16);
  const lum = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  return lum > 150 ? '#000000' : '#ffffff';
}

export function bounds(shape: Shape): Rect {
  switch (shape.kind) {
    case 'rect': case 'ellipse': case 'redact':
      return normalize({ x: shape.x, y: shape.y, width: shape.w, height: shape.h });
    case 'arrow': return normalize({ x: shape.x1, y: shape.y1, width: shape.x2 - shape.x1, height: shape.y2 - shape.y1 });
    case 'highlight': {
      const xs = shape.points.map(p => p.x), ys = shape.points.map(p => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    }
    case 'text': return textBox(shape);
    case 'callout': {
      const r = calloutRadius(shape.width);
      return { x: shape.x - r, y: shape.y - r, width: 2 * r, height: 2 * r };
    }
  }
}

export function normalize(r: Rect): Rect {
  return { x: Math.min(r.x, r.x + r.width), y: Math.min(r.y, r.y + r.height), width: Math.abs(r.width), height: Math.abs(r.height) };
}

/** Draws `shape` in image coordinates on whatever transform `ctx` carries. */
export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.width;
  ctx.lineJoin = ctx.lineCap = 'round';
  switch (shape.kind) {
    case 'rect': {
      const r = normalize({ x: shape.x, y: shape.y, width: shape.w, height: shape.h });
      ctx.strokeRect(r.x, r.y, r.width, r.height);
      break;
    }
    case 'ellipse': {
      const r = normalize({ x: shape.x, y: shape.y, width: shape.w, height: shape.h });
      ctx.beginPath();
      ctx.ellipse(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, r.height / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'redact': {
      // Whole pixels, opaque: flattening leaves solid pixels, never a blend of what was under it.
      const r = normalize({ x: shape.x, y: shape.y, width: shape.w, height: shape.h });
      ctx.globalAlpha = 1;
      ctx.fillStyle = shape.color.slice(0, 7);
      ctx.fillRect(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
      break;
    }
    case 'arrow': {
      const { x1, y1, x2, y2 } = shape, angle = Math.atan2(y2 - y1, x2 - x1);
      const head = arrowHead(shape.width), len = Math.hypot(x2 - x1, y2 - y1);
      const shaft = Math.max(0, len - head * 0.8);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 + Math.cos(angle) * shaft, y1 + Math.sin(angle) * shaft);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
      ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
      ctx.closePath();
      ctx.lineWidth = Math.max(1, shape.width / 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case 'highlight': {
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = highlightWidth(shape.width);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      shape.points.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      if (shape.points.length === 1) ctx.lineTo(shape.points[0].x + 0.1, shape.points[0].y);
      ctx.stroke();
      break;
    }
    case 'text': {
      const size = fontSize(shape.width);
      ctx.font = `600 ${size}px ${FONT}`;
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(2, size / 6);
      ctx.strokeStyle = contrast(shape.color);
      textLines(shape.text).forEach((line, i) => {
        ctx.strokeText(line, shape.x, shape.y + i * size * 1.25);
        ctx.fillText(line, shape.x, shape.y + i * size * 1.25);
      });
      break;
    }
    case 'callout': {
      const r = calloutRadius(shape.width), size = fontSize(shape.width);
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r / 10);
      ctx.strokeStyle = contrast(shape.color);
      ctx.stroke();
      ctx.fillStyle = contrast(shape.color);
      ctx.font = `700 ${String(shape.n).length > 1 ? size * 0.8 : size}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(shape.n), shape.x, shape.y + size * 0.05);
      break;
    }
  }
  ctx.restore();
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether `p` touches `shape`, within `slop` image pixels of its stroke. */
export function hit(shape: Shape, p: Point, slop: number): boolean {
  const b = bounds(shape);
  switch (shape.kind) {
    case 'redact': case 'text': case 'callout':
      return p.x >= b.x - slop && p.x <= b.x + b.width + slop && p.y >= b.y - slop && p.y <= b.y + b.height + slop;
    case 'rect': {
      const tol = slop + shape.width / 2;
      const inside = p.x >= b.x - tol && p.x <= b.x + b.width + tol && p.y >= b.y - tol && p.y <= b.y + b.height + tol;
      const deep = p.x > b.x + tol && p.x < b.x + b.width - tol && p.y > b.y + tol && p.y < b.y + b.height - tol;
      return inside && !deep;
    }
    case 'ellipse': {
      const rx = b.width / 2, ry = b.height / 2;
      if (rx < 1 || ry < 1) return segmentDistance(p, { x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }) <= slop + shape.width;
      const nx = (p.x - b.x - rx) / rx, ny = (p.y - b.y - ry) / ry, d = Math.hypot(nx, ny);
      return Math.abs(d - 1) * Math.min(rx, ry) <= slop + shape.width / 2;
    }
    case 'arrow':
      return segmentDistance(p, { x: shape.x1, y: shape.y1 }, { x: shape.x2, y: shape.y2 }) <= slop + shape.width / 2 + 2;
    case 'highlight': {
      const tol = slop + highlightWidth(shape.width) / 2;
      if (shape.points.length === 1) return Math.hypot(p.x - shape.points[0].x, p.y - shape.points[0].y) <= tol;
      for (let i = 1; i < shape.points.length; i++) if (segmentDistance(p, shape.points[i - 1], shape.points[i]) <= tol) return true;
      return false;
    }
  }
}

/** The topmost shape under `p`. */
export function hitTop(shapes: readonly Shape[], p: Point, slop: number): Shape | undefined {
  for (let i = shapes.length - 1; i >= 0; i--) if (hit(shapes[i], p, slop)) return shapes[i];
  return undefined;
}

/** Where `shape`'s handles sit; text and callouts only move. */
export function handles(shape: Shape): { handle: Handle; x: number; y: number }[] {
  if (shape.kind === 'arrow') return [{ handle: 'start', x: shape.x1, y: shape.y1 }, { handle: 'end', x: shape.x2, y: shape.y2 }];
  if (shape.kind === 'text' || shape.kind === 'callout') return [];
  return boxHandles(bounds(shape));
}

/** A rectangle's corner and edge-midpoint handles. */
export function boxHandles({ x, y, width: w, height: h }: Rect): { handle: Handle; x: number; y: number }[] {
  return [
    { handle: 'nw', x, y }, { handle: 'n', x: x + w / 2, y }, { handle: 'ne', x: x + w, y },
    { handle: 'e', x: x + w, y: y + h / 2 }, { handle: 'se', x: x + w, y: y + h },
    { handle: 's', x: x + w / 2, y: y + h }, { handle: 'sw', x, y: y + h }, { handle: 'w', x, y: y + h / 2 },
  ];
}

/** `r` with the edges `handle` names dragged to `p`. */
export function resizeRect(r: Rect, handle: Handle, p: Point): Rect {
  let x0 = r.x, y0 = r.y, x1 = r.x + r.width, y1 = r.y + r.height;
  if (handle.includes('w')) x0 = p.x;
  if (handle.includes('e')) x1 = p.x;
  if (handle.startsWith('n')) y0 = p.y;
  if (handle.startsWith('s')) y1 = p.y;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** `original` reshaped by dragging `handle` to `p`. */
export function resize(original: Shape, handle: Handle, p: Point): Shape {
  if (original.kind === 'arrow') {
    return handle === 'start' ? { ...original, x1: p.x, y1: p.y } : { ...original, x2: p.x, y2: p.y };
  }
  const b = bounds(original), r = resizeRect(b, handle, p);
  switch (original.kind) {
    case 'rect': case 'ellipse': return { ...original, x: r.x, y: r.y, w: r.width, h: r.height };
    case 'redact': {
      const n = normalize(r);
      return { ...original, x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.width), h: Math.round(n.height) };
    }
    case 'highlight': {
      const sx = b.width ? r.width / b.width : 1, sy = b.height ? r.height / b.height : 1;
      return { ...original, points: original.points.map(q => ({ x: r.x + (q.x - b.x) * sx, y: r.y + (q.y - b.y) * sy })) };
    }
    default: return original;
  }
}

export function move(shape: Shape, dx: number, dy: number): Shape {
  switch (shape.kind) {
    case 'arrow': return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
    case 'highlight': return { ...shape, points: shape.points.map(p => ({ x: p.x + dx, y: p.y + dy })) };
    case 'redact': return { ...shape, x: Math.round(shape.x + dx), y: Math.round(shape.y + dy) };
    default: return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }
}

/** Whether a just-dragged shape is too small to keep: a click, not a drag. */
export function degenerate(shape: Shape, slop: number): boolean {
  if (shape.kind === 'highlight') return shape.points.length < 2;
  const b = bounds(shape);
  return b.width < slop && b.height < slop;
}

/** The number the next callout takes. */
export const nextCallout = (shapes: readonly Shape[]) =>
  shapes.reduce((n, s) => s.kind === 'callout' ? Math.max(n, s.n) : n, 0) + 1;
