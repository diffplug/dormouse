import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ getPlatform: vi.fn(), getPlatformOrNull: vi.fn() }));

import { getPlatform, getPlatformOrNull } from './platform';
import { membershipOf } from './hosted-membership';
import { readBurrowStatusOnce } from '../remote/burrow/burrow-status-store';
import { makeStubManagedVoicePort } from './platform/test-ports';
import type { PlatformAdapter } from './platform/types';
import {
  enrolledStatus,
  makeStubBurrowLink,
  SELF_HOST_UNENROLLED_STATUS,
  UNENROLLED_STATUS,
} from '../host/remote/test-burrow-link';

const HOSTED_MEMBER = enrolledStatus({ relayMode: 'hosted', relayOrigin: UNENROLLED_STATUS.relayOrigin });

const withPlatform = (platform: Partial<PlatformAdapter> | null) => {
  vi.mocked(getPlatformOrNull).mockReturnValue(platform as PlatformAdapter | null);
  vi.mocked(getPlatform).mockImplementation(() => {
    if (!platform) throw new Error('Platform not initialized');
    return platform as PlatformAdapter;
  });
};

afterEach(() => {
  vi.mocked(getPlatform).mockReset();
  vi.mocked(getPlatformOrNull).mockReset();
});

describe('membershipOf', () => {
  it('is unavailable without an answer, and in a self-host build', () => {
    expect(membershipOf(null, null)).toBe('unavailable');
    expect(membershipOf(SELF_HOST_UNENROLLED_STATUS, null)).toBe('unavailable');
    expect(membershipOf(enrolledStatus(), null)).toBe('unavailable');
  });

  it('is signed out when not enrolled, or removed from the account', () => {
    expect(membershipOf(UNENROLLED_STATUS, null)).toBe('signed-out');
    expect(membershipOf({ ...HOSTED_MEMBER, connection: 'removed' }, null)).toBe('signed-out');
  });

  it('has no plan where the relay socket or speak says so', () => {
    expect(membershipOf({ ...HOSTED_MEMBER, connection: 'not-entitled' }, null)).toBe('no-plan');
    expect(membershipOf(HOSTED_MEMBER, makeStubManagedVoicePort(true, true).status())).toBe('no-plan');
  });

  it('is a member signed in with nothing saying the plan lapsed, with or without managed voice', () => {
    expect(membershipOf(HOSTED_MEMBER, null)).toBe('member');
    expect(membershipOf(HOSTED_MEMBER, makeStubManagedVoicePort(true).status())).toBe('member');
  });
});

describe('readBurrowStatusOnce', () => {
  it('is null before a platform, without a Burrow service, or when the service cannot answer', async () => {
    withPlatform(null);
    expect(await readBurrowStatusOnce()).toBeNull();
    withPlatform({});
    expect(await readBurrowStatusOnce()).toBeNull();
    withPlatform({ burrow: makeStubBurrowLink({ statusError: 'down' }) });
    expect(await readBurrowStatusOnce()).toBeNull();
  });

  it('asks the Burrow service once, with or without a managed-voice port', async () => {
    withPlatform({ burrow: makeStubBurrowLink({ status: UNENROLLED_STATUS }) });
    expect(membershipOf(await readBurrowStatusOnce(), null)).toBe('signed-out');
    withPlatform({ burrow: makeStubBurrowLink({ status: HOSTED_MEMBER }) });
    expect(membershipOf(await readBurrowStatusOnce(), null)).toBe('member');
  });
});
