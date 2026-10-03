import { describe, expect, it } from 'vitest';
import { RETAINED_PAGES_WARN_ABOVE, coveredByZoom, isSeen, retainedPagesWarning, unseenReason, type SurfaceSightInputs } from './surface-sight';

const seen: SurfaceSightInputs = { windowShown: true, workspaceActive: true, parked: false, covered: false };

describe('surface sight', () => {
  it('is seen only with every input on screen', () => {
    expect(isSeen(seen)).toBe(true);
    expect(unseenReason({ ...seen, windowShown: false })).toBe('window');
    expect(unseenReason({ ...seen, workspaceActive: false })).toBe('workspace');
    expect(unseenReason({ ...seen, parked: true })).toBe('parked');
    expect(unseenReason({ ...seen, covered: true })).toBe('covered');
  });

  it('names a parked leaf before any other reason', () => {
    expect(unseenReason({ windowShown: false, workspaceActive: false, parked: true, covered: true })).toBe('parked');
  });

  it('covers every leaf but the zoomed one, and none without zoom', () => {
    expect(coveredByZoom('a', 'b')).toBe(true);
    expect(coveredByZoom('b', 'b')).toBe(false);
    expect(coveredByZoom('a', null)).toBe(false);
  });
});

describe('retained pages', () => {
  it('warns only past the threshold', () => {
    expect(retainedPagesWarning(RETAINED_PAGES_WARN_ABOVE)).toBe(false);
    expect(retainedPagesWarning(RETAINED_PAGES_WARN_ABOVE + 1)).toBe(true);
  });
});
