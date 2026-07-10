import { describe, it, expect } from 'vitest';
import {
  instrumentHtml,
  isBlockedAddress,
  IFRAME_SHIM,
  errorPageHtml,
  unreachablePage,
  timedOutPage,
} from './iframe-proxy-rewrite';

describe('instrumentHtml', () => {
  it('injects the shim before </head>', () => {
    const out = instrumentHtml('<html><head><title>x</title></head><body>hi</body></html>');
    expect(out).toContain('__dormouse');
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

  it('forwards the leader chord and a pointerdown select signal', () => {
    expect(IFRAME_SHIM).toContain('__dormouse');
    expect(IFRAME_SHIM).toContain("'leader'");
    expect(IFRAME_SHIM).toContain("'pointerdown'");
    expect(IFRAME_SHIM).toContain("'location'");
    expect(IFRAME_SHIM).toContain("addEventListener('click'");
    expect(IFRAME_SHIM).toContain('pushState');
  });

  it('intercepts new-tab attempts (target=_blank / window.open) as open-window', () => {
    expect(IFRAME_SHIM).toContain("'open-window'");
    // window.open is overridden so popups become a new pane rather than vanishing.
    expect(IFRAME_SHIM).toContain('window.open=function');
  });

  it('does not report a same-frame location for modifier / non-primary clicks', () => {
    // Cmd/Ctrl/Shift/Alt+click and middle-click open a new tab/window without
    // navigating the frame, so the shim must bail rather than post a stale
    // location that would make the parent chrome URL bar lie.
    expect(IFRAME_SHIM).toContain('e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0');
  });

  it('defers the same-frame location post and skips it when the click was cancelled', () => {
    // The capture-phase post must wait a tick and respect a page that cancels
    // the click (preventDefault / fetch-instead-of-navigate), else it reports a
    // navigation that never happened.
    expect(IFRAME_SHIM).toContain('if(!e.defaultPrevented)post(\'location\'');
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
  it('renders a frameable page, escaping the target', () => {
    const html = errorPageHtml(unreachablePage(new URL('http://example.com/a"b'), 'ECONNREFUSED'));
    expect(html).toContain('Nothing responding');
    expect(html).not.toContain('a"b'); // escaped
  });

  it('renders a timed-out page that suggests reloading', () => {
    const html = errorPageHtml(timedOutPage(new URL('http://localhost:5173/')));
    expect(html).toContain('isn’t responding');
    expect(html).toMatch(/reload/i);
  });
});
