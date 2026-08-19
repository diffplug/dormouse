import { describe, expect, it, vi } from 'vitest';
// The build scripts read the `.mjs` and the Host service reads the `.ts`; the
// last describe here is what keeps them one fact.
import {
  CONNECT_SRC_SOURCE_PATTERN as BUILD_PATTERN,
  DEFAULT_REMOTE_CONNECT_SRC as BUILD_DEFAULT,
  resolveRemoteConnectSrc,
} from '../../../../scripts/csp-defaults.mjs';
import {
  CONNECT_SRC_SOURCE_PATTERN,
  DEFAULT_REMOTE_CONNECT_SRC,
  originAllowedByConnectSrc,
} from './connect-src';

const SAAS = DEFAULT_REMOTE_CONNECT_SRC;

describe('originAllowedByConnectSrc', () => {
  it('allows a sub-domain at any depth under a wildcard', () => {
    expect(originAllowedByConnectSrc('https://relay.dormouse.sh', SAAS)).toBe(true);
    expect(originAllowedByConnectSrc('https://a.b.dormouse.sh', SAAS)).toBe(true);
  });

  it('does not let a wildcard match the bare domain', () => {
    // `*.dormouse.sh` is a wildcard on purpose (per-tenant subdomains), and CSP
    // reads it as sub-domains only.
    expect(originAllowedByConnectSrc('https://dormouse.sh', SAAS)).toBe(false);
  });

  it('does not match a domain that merely ends with the source text', () => {
    expect(originAllowedByConnectSrc('https://evildormouse.sh', SAAS)).toBe(false);
    expect(originAllowedByConnectSrc('https://relay.dormouse.sh.evil.com', SAAS)).toBe(false);
  });

  it('treats https and wss as one scheme', () => {
    // A Host reaches the same server over both, and the source list names both;
    // either entry must answer for either scheme.
    expect(originAllowedByConnectSrc('https://x.example', 'wss://x.example')).toBe(true);
    expect(originAllowedByConnectSrc('wss://x.example', 'https://x.example')).toBe(true);
  });

  it('keeps http and https apart', () => {
    expect(originAllowedByConnectSrc('http://x.example', 'https://x.example')).toBe(false);
    expect(originAllowedByConnectSrc('https://x.example', 'http://x.example')).toBe(false);
    expect(originAllowedByConnectSrc('http://x.example', 'ws://x.example')).toBe(true);
  });

  it('matches an exact host', () => {
    expect(originAllowedByConnectSrc('https://x.example', 'https://x.example')).toBe(true);
    expect(originAllowedByConnectSrc('https://y.example', 'https://x.example')).toBe(false);
  });

  it('is case-insensitive about the host', () => {
    expect(originAllowedByConnectSrc('https://Relay.Dormouse.SH', SAAS)).toBe(true);
  });

  it('reads a portless source as the scheme default port', () => {
    expect(originAllowedByConnectSrc('https://x.example:443', 'https://x.example')).toBe(true);
    expect(originAllowedByConnectSrc('https://x.example:8443', 'https://x.example')).toBe(false);
    expect(originAllowedByConnectSrc('http://x.example:80', 'http://x.example')).toBe(true);
  });

  it('honours an explicit port and the `*` port', () => {
    expect(originAllowedByConnectSrc('https://x.example:8443', 'https://x.example:8443')).toBe(true);
    expect(originAllowedByConnectSrc('https://x.example:8443', 'https://x.example:*')).toBe(true);
    expect(originAllowedByConnectSrc('https://x.example', 'https://x.example:*')).toBe(true);
  });

  it('accepts any one source in the list', () => {
    const sources = 'https://a.example wss://b.example';
    expect(originAllowedByConnectSrc('https://b.example', sources)).toBe(true);
    expect(originAllowedByConnectSrc('https://c.example', sources)).toBe(false);
  });

  it('fails closed on junk', () => {
    expect(originAllowedByConnectSrc('not a url', SAAS)).toBe(false);
    expect(originAllowedByConnectSrc('https://x.example', '')).toBe(false);
    expect(originAllowedByConnectSrc('https://x.example', "'self'")).toBe(false);
    // A scheme a Host cannot speak is never a relay.
    expect(originAllowedByConnectSrc('file:///etc/passwd', 'file://')).toBe(false);
  });

  it('is the same default the build scripts bake in', () => {
    expect(DEFAULT_REMOTE_CONNECT_SRC).toBe(BUILD_DEFAULT);
  });
});

describe('the build-time check on a self-hoster’s override', () => {
  it('reads a source with exactly the grammar the matcher does', () => {
    // `scripts/csp-defaults.mjs` is a build script and cannot import this file,
    // so it keeps a copy. A copy that drifted would either fail a build over a
    // source the Host accepts, or pass one it silently never matches.
    expect(BUILD_PATTERN.source).toBe(CONNECT_SRC_SOURCE_PATTERN.source);
    expect(BUILD_PATTERN.flags).toBe(CONNECT_SRC_SOURCE_PATTERN.flags);
  });

  it('fails the build on an override the Host could never match', () => {
    // Both silently match nothing at runtime, so the binary builds green and
    // then refuses to enroll against the server it was built for.
    for (const bad of ['https://relay.example.ts.net/', 'relay.example.ts.net']) {
      expect(() =>
        resolveRemoteConnectSrc({ DORMOUSE_REMOTE_CONNECT_SRC: bad }, 'test'),
      ).toThrow(/DORMOUSE_REMOTE_CONNECT_SRC/);
      expect(originAllowedByConnectSrc('https://relay.example.ts.net', bad)).toBe(false);
    }
    // And one entry of a list is enough to fail it.
    expect(() =>
      resolveRemoteConnectSrc(
        { DORMOUSE_REMOTE_CONNECT_SRC: 'https://a.example wss://b.example/' },
        'test',
      ),
    ).toThrow();
  });

  it('passes a well-formed override through, and an unset one to the default', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const custom = 'https://relay.example.ts.net wss://relay.example.ts.net';
    expect(resolveRemoteConnectSrc({ DORMOUSE_REMOTE_CONNECT_SRC: custom }, 'test')).toBe(custom);
    expect(resolveRemoteConnectSrc({}, 'test')).toBe(DEFAULT_REMOTE_CONNECT_SRC);
    expect(resolveRemoteConnectSrc({ DORMOUSE_REMOTE_CONNECT_SRC: '  ' }, 'test')).toBe(
      DEFAULT_REMOTE_CONNECT_SRC,
    );
    log.mockRestore();
  });
});
