import { describe, expect, it } from 'vitest';
import { coveredByZoom, isSeen, type SurfaceSightInputs } from './surface-sight';

const seen: SurfaceSightInputs = { windowShown: true, workspaceActive: true, parked: false, covered: false };

describe('surface sight', () => {
  it('is seen only with every input on screen', () => {
    expect(isSeen(seen)).toBe(true);
    expect(isSeen({ ...seen, windowShown: false })).toBe(false);
    expect(isSeen({ ...seen, workspaceActive: false })).toBe(false);
    expect(isSeen({ ...seen, parked: true })).toBe(false);
    expect(isSeen({ ...seen, covered: true })).toBe(false);
  });

  it('covers every leaf but the zoomed one, and none without zoom', () => {
    expect(coveredByZoom('a', 'b')).toBe(true);
    expect(coveredByZoom('b', 'b')).toBe(false);
    expect(coveredByZoom('a', null)).toBe(false);
  });
});
