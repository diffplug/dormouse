import { describe, it, expect } from 'vitest';
import {
  hasRestrictiveFrameAncestors,
  refusesFraming,
  instrumentHtml,
  isLoopbackHost,
  isBlockedAddress,
  IFRAME_SHIM,
  errorPageHtml,
  frameRefusedPage,
} from './iframe-proxy-rewrite';

describe('hasRestrictiveFrameAncestors', () => {
  it('treats a standalone * as permissive', () => {
    expect(hasRestrictiveFrameAncestors('frame-ancestors *')).toBe(false);
    expect(hasRestrictiveFrameAncestors("default-src 'self'; frame-ancestors *")).toBe(false);
  });

  it('treats a scoped wildcard source as restrictive', () => {
    // The naive `/\*/` test would wrongly pass this — it contains a `*`.
    expect(hasRestrictiveFrameAncestors('frame-ancestors https://*.example.com')).toBe(true);
  });

  it('treats self / none / scoped hosts as restrictive', () => {
    expect(hasRestrictiveFrameAncestors("frame-ancestors 'self'")).toBe(true);
    expect(hasRestrictiveFrameAncestors("frame-ancestors 'none'")).toBe(true);
    expect(hasRestrictiveFrameAncestors('frame-ancestors https://example.com')).toBe(true);
  });

  it('ignores other directives and is case/space tolerant', () => {
    expect(hasRestrictiveFrameAncestors("script-src 'self'")).toBe(false);
    expect(hasRestrictiveFrameAncestors('FRAME-ANCESTORS   *')).toBe(false);
    expect(hasRestrictiveFrameAncestors('  frame-ancestors   https://x.com  ;  ')).toBe(true);
  });
});

describe('refusesFraming', () => {
  it('refuses on any X-Frame-Options', () => {
    expect(refusesFraming({ 'x-frame-options': 'DENY' })).toBe(true);
    expect(refusesFraming({ 'x-frame-options': 'SAMEORIGIN' })).toBe(true);
  });

  it('allows when there is no framing header', () => {
    expect(refusesFraming({})).toBe(false);
    expect(refusesFraming({ 'content-security-policy': "default-src 'self'" })).toBe(false);
  });

  it('honors a restrictive CSP frame-ancestors', () => {
    expect(refusesFraming({ 'content-security-policy': "frame-ancestors 'self'" })).toBe(true);
    expect(refusesFraming({ 'content-security-policy': 'frame-ancestors *' })).toBe(false);
  });

  it('refuses if any of multiple CSP headers is restrictive', () => {
    expect(refusesFraming({
      'content-security-policy': ['frame-ancestors *', "frame-ancestors 'self'"],
    })).toBe(true);
  });
});

describe('instrumentHtml', () => {
  it('injects the shim before </head>', () => {
    const out = instrumentHtml('<html><head><title>x</title></head><body>hi</body></html>');
    expect(out).toContain("__dormouse:'leader'");
    expect(out).toMatch(/<\/script><\/head>/);
    expect(out).toContain('<title>x</title>');
  });

  it('falls back to after <body> when there is no head', () => {
    const out = instrumentHtml('<body>hi</body>');
    expect(out).toMatch(/<body>\s*<script>/);
  });

  it('strips an in-document CSP meta', () => {
    const out = instrumentHtml('<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head>');
    expect(out).not.toMatch(/http-equiv=["']?content-security-policy/i);
  });

  it('carries the leader-only shim (no focus/blur channel)', () => {
    expect(IFRAME_SHIM).toContain("__dormouse:'leader'");
    expect(IFRAME_SHIM).not.toContain('focus');
  });
});

describe('isLoopbackHost', () => {
  it('recognizes loopback hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });
  it('rejects remote hosts', () => {
    for (const h of ['example.com', '10.0.0.5', '192.168.1.2']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('isBlockedAddress', () => {
  it('blocks link-local / cloud-metadata ranges', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
  });
  it('allows ordinary hosts', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(false);
    expect(isBlockedAddress('localhost')).toBe(false);
    expect(isBlockedAddress('example.com')).toBe(false);
  });
});

describe('errorPageHtml', () => {
  it('renders a frameable page with the dor ab hint, escaping the target', () => {
    const html = errorPageHtml(frameRefusedPage(new URL('https://example.com/a"b')));
    expect(html).toContain('refuses to be embedded');
    expect(html).toContain('dor ab open');
    expect(html).not.toContain('a"b'); // escaped
  });
});
