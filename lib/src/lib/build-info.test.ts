import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBuildStamp, type BuildStamp } from './build-info';

const STAMP: BuildStamp = { version: '1.2.0', commit: 'd080b4f5', commitsSinceVersion: 0, dirty: false, official: true, host: 'standalone' };

afterEach(() => vi.unstubAllGlobals());

describe('readBuildStamp', () => {
  it('reads as unstamped where the bundle carries no stamp, else reads the stamp', () => {
    expect(readBuildStamp()).toBeNull();
    vi.stubGlobal('__DORMOUSE_BUILD__', STAMP);
    expect(readBuildStamp()).toEqual(STAMP);
  });
});
