/**
 * @vitest-environment jsdom
 *
 * What a preview slot switch captures (`docs/specs/dor-tool.md` -> Preview
 * slot); the rendered switch is pinned by `preview-slot.test.tsx`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { snapshotScreencast } from './preview-transition';

const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height }) as DOMRect;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('snapshotScreencast', () => {
  const layer = { getBoundingClientRect: rect(100, 50, 800, 600) };
  const canvas = (box = rect(120, 80, 640, 360)) => Object.assign(document.createElement('canvas'), {
    width: 1280,
    height: 720,
    getBoundingClientRect: box,
  });
  const drawing = () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as RenderingContext);
    return drawImage;
  };

  it('copies the frame into a canvas of its size, placed where the canvas sits in its layer', () => {
    const drawImage = drawing();
    const source = canvas();
    const snapshot = snapshotScreencast(source, layer)!;
    expect(snapshot.rect).toEqual({ left: 20, top: 30, width: 640, height: 360 });
    expect(snapshot.canvas).not.toBe(source);
    expect([snapshot.canvas.width, snapshot.canvas.height]).toEqual([1280, 720]);
    expect(drawImage).toHaveBeenCalledWith(source, 0, 0);
  });

  it('takes nothing from a hidden canvas', () => {
    const drawImage = drawing();
    expect(snapshotScreencast(canvas(rect(0, 0, 0, 0)), layer)).toBeNull();
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('takes nothing without a 2d context', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(snapshotScreencast(canvas(), layer)).toBeNull();
  });
});
