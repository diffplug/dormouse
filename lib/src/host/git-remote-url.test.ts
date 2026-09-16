import { describe, expect, it } from 'vitest';
import { canonicalRemoteUrl } from './git-remote-url';

describe('canonicalRemoteUrl', () => {
  it('collapses the spellings of one remote onto one key', () => {
    // The whole point: a worktree cloned over ssh and one cloned over https are
    // the same repo and must share a grant.
    const expected = 'https://github.com/diffplug/dormouse';
    for (const spelling of [
      'https://github.com/diffplug/dormouse',
      'https://github.com/diffplug/dormouse.git',
      'https://github.com/diffplug/dormouse/',
      'git@github.com:diffplug/dormouse.git',
      'git@github.com:diffplug/dormouse',
      'ssh://git@github.com/diffplug/dormouse.git',
      'git://github.com/diffplug/dormouse.git',
      'git+https://github.com/diffplug/dormouse.git',
      'https://GitHub.com/diffplug/dormouse',
    ]) {
      expect(canonicalRemoteUrl(spelling), spelling).toBe(expected);
    }
  });

  it('drops userinfo, which is a credential and not identity', () => {
    expect(canonicalRemoteUrl('https://ntwigg@github.com/diffplug/dormouse'))
      .toBe('https://github.com/diffplug/dormouse');
    expect(canonicalRemoteUrl('https://user:token@github.com/diffplug/dormouse'))
      .toBe('https://github.com/diffplug/dormouse');
  });

  it('keeps different hosts apart, including lookalikes', () => {
    // A github-hardcoded normalizer passes these through untouched and they end
    // up compared against whatever the caller expected.
    const real = canonicalRemoteUrl('git@github.com:diffplug/dormouse.git');
    for (const impostor of [
      'git@github.com.evil.com:diffplug/dormouse.git',
      'git@evil.com:diffplug/dormouse.git',
      'https://github.com.evil.com/diffplug/dormouse',
      'https://evil.com/diffplug/dormouse',
    ]) {
      expect(canonicalRemoteUrl(impostor), impostor).not.toBe(real);
    }
  });

  it('keeps different repos on one host apart', () => {
    expect(canonicalRemoteUrl('git@github.com:diffplug/dormouse.git'))
      .not.toBe(canonicalRemoteUrl('git@github.com:someone/dormouse.git'));
  });

  it('strips only a trailing .git, not an interior one', () => {
    expect(canonicalRemoteUrl('https://host/o/.github')).toBe('https://host/o/.github');
    expect(canonicalRemoteUrl('https://host/o/r.git.git')).toBe('https://host/o/r.git');
  });

  it('normalizes a default port but keeps a non-default one', () => {
    expect(canonicalRemoteUrl('https://host:443/o/r')).toBe('https://host/o/r');
    expect(canonicalRemoteUrl('ssh://git@host:2222/o/r')).toBe('https://host:2222/o/r');
  });

  it('declines anything it does not understand rather than guessing', () => {
    for (const raw of [
      '',
      '   ',
      'not a url',
      '/srv/repos/bare.git',            // a local path — folder trust's job
      'file:///srv/repos/bare.git',     // ditto, explicitly
      '../sibling-worktree',
      'https://github.com',             // host only, no repo
      'https://github.com/',
      'ftp://host/o/r',                 // not a scheme git addresses a host with
    ]) {
      expect(canonicalRemoteUrl(raw), JSON.stringify(raw)).toBeNull();
    }
  });

  it('declines the ambiguous host:/path form rather than picking a reading', () => {
    // git reads this as scp; a URL parser reads `/path` as a port. Declining
    // costs a folder grant; guessing wrong would mint a key for the wrong host.
    expect(canonicalRemoteUrl('host:/srv/repo.git')).toBeNull();
  });
});

describe('default ports (regression: PR #493 review)', () => {
  it('collapses an explicitly-spelled default port onto the same key', () => {
    // Without this, a worktree whose origin is spelled the long way re-prompts,
    // defeating "every worktree and clone of one repo shares a grant".
    const expected = canonicalRemoteUrl('git@github.com:diffplug/dormouse.git');
    expect(canonicalRemoteUrl('ssh://git@github.com:22/diffplug/dormouse.git')).toBe(expected);
    expect(canonicalRemoteUrl('git://github.com:9418/diffplug/dormouse.git')).toBe(expected);
    expect(canonicalRemoteUrl('https://github.com:443/diffplug/dormouse')).toBe(expected);
  });

  it('still keeps a genuinely non-default port distinct', () => {
    expect(canonicalRemoteUrl('ssh://git@host:2222/o/r')).toBe('https://host:2222/o/r');
    expect(canonicalRemoteUrl('ssh://git@host:2222/o/r')).not.toBe(canonicalRemoteUrl('ssh://git@host/o/r'));
  });
});
