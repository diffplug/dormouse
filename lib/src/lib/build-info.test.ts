import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTag, installKind, readBuildStamp, type BuildStamp } from './build-info';

const STAMP: BuildStamp = { version: '1.2.0', commit: 'd080b4f5', commitsSinceVersion: 0, dirty: false, official: true };

afterEach(() => vi.unstubAllGlobals());

describe('readBuildStamp', () => {
  it('reads as unstamped where the bundle carries no stamp', () => {
    expect(readBuildStamp()).toBeNull();
  });

  it('reads a stamp of the right shape and refuses anything else', () => {
    vi.stubGlobal('__DORMOUSE_BUILD__', STAMP);
    expect(readBuildStamp()).toEqual(STAMP);
    vi.stubGlobal('__DORMOUSE_BUILD__', { ...STAMP, official: 'yes' });
    expect(readBuildStamp()).toBeNull();
  });
});

describe('buildTag', () => {
  it('names commits past the tag, and an unknown count as such', () => {
    expect(buildTag(STAMP)).toBe('1.2.0');
    expect(buildTag({ ...STAMP, commitsSinceVersion: 14 })).toBe('1.2.0+14');
    expect(buildTag({ ...STAMP, commitsSinceVersion: null })).toBe('1.2.0+?');
  });
});

describe('installKind', () => {
  it('ranks playground, then self-host, then official, then development', () => {
    expect(installKind('playground', STAMP, null)).toBe('playground');
    expect(installKind('standalone', STAMP, 'self-host')).toBe('self-host');
    expect(installKind('standalone', STAMP, 'hosted')).toBe('official');
    expect(installKind('vscode', STAMP, null)).toBe('official');
    expect(installKind('standalone', { ...STAMP, official: false }, 'hosted')).toBe('development');
    expect(installKind('standalone', null, 'hosted')).toBe('development');
  });
});
