import { describe, expect, it } from 'vitest';
// The build scripts read the `.mjs` and the Host service reads the `.ts`; the
// last test here is what keeps them one fact.
import { DEFAULT_REMOTE_CONNECT_SRC as BUILD_DEFAULT } from '../../../../scripts/csp-defaults.mjs';
import { DEFAULT_REMOTE_CONNECT_SRC, originAllowedByConnectSrc } from './connect-src';

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
