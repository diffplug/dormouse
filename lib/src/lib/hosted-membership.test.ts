import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ getPlatform: vi.fn() }));

import { getPlatform } from './platform';
import { getHostedMembership } from './hosted-membership';
import { makeStubManagedVoicePort } from './platform/test-ports';
import type { PlatformAdapter } from './platform/types';

const withPlatform = (platform: Partial<PlatformAdapter> | null) =>
  vi.mocked(getPlatform).mockImplementation(() => {
    if (!platform) throw new Error('Platform not initialized');
    return platform as PlatformAdapter;
  });

afterEach(() => vi.mocked(getPlatform).mockReset());

describe('getHostedMembership', () => {
  it('is unavailable before a platform, and without a managed-voice port (self-host, VS Code, the website)', () => {
    withPlatform(null);
    expect(getHostedMembership()).toBe('unavailable');
    withPlatform({});
    expect(getHostedMembership()).toBe('unavailable');
  });

  it('is unavailable until the host answers', () => {
    withPlatform({ managedVoice: { ...makeStubManagedVoicePort(false), status: () => null } });
    expect(getHostedMembership()).toBe('unavailable');
  });

  it('follows the saved voice token in a Hosted build', () => {
    withPlatform({ managedVoice: makeStubManagedVoicePort(false) });
    expect(getHostedMembership()).toBe('not-member');
    withPlatform({ managedVoice: makeStubManagedVoicePort(true) });
    expect(getHostedMembership()).toBe('member');
  });
});
