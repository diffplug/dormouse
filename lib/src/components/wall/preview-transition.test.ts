/**
 * @vitest-environment jsdom
 *
 * What a preview slot switch captures (`docs/specs/dor-tool.md` -> Preview
 * slot); the rendered switch is pinned by `preview-slot.test.tsx`.
 */
import { describe, expect, it, vi } from 'vitest';
import { snapshotScreencast, targetLabel } from './preview-transition';

const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height }) as DOMRect;

describe('snapshotScreencast', () => {
  const layer = { getBoundingClientRect: rect(100, 50, 800, 600) };
  const canvas = (overrides: Partial<Pick<HTMLCanvasElement, 'width' | 'height' | 'toDataURL' | 'getBoundingClientRect'>> = {}) => ({
    width: 1280,
    height: 720,
    toDataURL: vi.fn(() => 'data:image/jpeg;base64,AAAA'),
    getBoundingClientRect: rect(120, 80, 640, 360),
    ...overrides,
  });

  it('takes the frame as an image, placed where the canvas sits in its layer', () => {
    const stub = canvas();
    expect(snapshotScreencast(stub, layer)).toEqual({
      src: 'data:image/jpeg;base64,AAAA',
      rect: { left: 20, top: 30, width: 640, height: 360 },
    });
    expect(stub.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.8);
  });

  it.each([
    ['a hidden canvas', canvas({ getBoundingClientRect: rect(0, 0, 0, 0) })],
    ['a canvas that cannot encode', canvas({ toDataURL: () => { throw new Error('tainted'); } })],
    ['an encoder that returns nothing', canvas({ toDataURL: () => 'data:,' })],
  ])('takes nothing from %s', (_, stub) => {
    expect(snapshotScreencast(stub, layer)).toBeNull();
  });
});

describe('targetLabel', () => {
  it.each([
    ['/repo/docs/b.md', 'b.md'],
    ['/repo/docs/', 'docs'],
    ['C:\\repo\\b.md', 'b.md'],
    ['/', '/'],
  ])('names %s %s', (target, label) => {
    expect(targetLabel(target)).toBe(label);
  });
});
