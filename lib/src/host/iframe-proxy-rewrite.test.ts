import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import {
  frameAncestorsCsp,
  instrumentHtml,
  isBlockedAddress,
  iframeShim,
  normalizeEmbedderOrigins,
  errorPageHtml,
  unreachablePage,
  timedOutPage,
} from './iframe-proxy-rewrite';

const APP = 'vscode-webview://abc-123';
const PROXY = 'http://127.0.0.1:4321';
const IFRAME_SHIM = iframeShim(APP);

type ShimListener = (event: Record<string, unknown>) => void;

function shimFrame(parentOrigin: string, deliver: (data: unknown) => void) {
  const listeners = new Map<string, ShimListener[]>();
  const addEventListener = (type: string, listener: ShimListener) => {
    const current = listeners.get(type) ?? [];
    current.push(listener);
    listeners.set(type, current);
  };
  const parent = {
    postMessage(data: unknown, target: string) {
      if (target === parentOrigin) deliver(JSON.parse(JSON.stringify(data)));
    },
  };
  const window = { parent, open: undefined as unknown };
  runInNewContext(IFRAME_SHIM, {
    window,
    location: { origin: PROXY, href: `${PROXY}/story` },
    document: { readyState: 'loading' },
    history: {},
    addEventListener,
    setTimeout: () => 0,
    URL,
  });
  return {
    emit(type: string, event: Record<string, unknown>) {
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}

describe('instrumentHtml', () => {
  it('injects the shim before </head>', () => {
    const out = instrumentHtml('<html><head><title>x</title></head><body>hi</body></html>', APP);
    expect(out).toContain('__dormouse');
    expect(out).toMatch(/<\/script><\/head>/);
    expect(out).toContain('<title>x</title>');
  });

  it('falls back to after <body> when there is no head', () => {
    const out = instrumentHtml('<body>hi</body>', APP);
    expect(out).toMatch(/<body>\s*<script>/);
  });

  it('strips an in-document CSP meta', () => {
    const out = instrumentHtml('<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head>', APP);
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

// The shim reads the framed page's live URL and its anchor hrefs and hands them
// out — reads the same-origin policy would otherwise forbid. `'*'` handed them
// to whoever had framed the proxy, which the port scan makes anybody.
describe('the shim addresses the grant and app, not the world', () => {
  it('posts only to the proxy and embedder origins', () => {
    expect(IFRAME_SHIM).toContain(`var TARGET="${APP}"`);
    expect(IFRAME_SHIM).toContain('P.postMessage(m,location.origin)');
    expect(IFRAME_SHIM).toContain('P.postMessage(m,TARGET)');
    expect(IFRAME_SHIM).not.toContain("postMessage(m,'*')");
  });

  it('relays registered messages through same-origin nested frames', () => {
    const delivered: unknown[] = [];
    const outer = shimFrame(APP, (data) => delivered.push(data));
    const inner = shimFrame(PROXY, (data) => outer.emit('message', { origin: PROXY, data }));

    inner.emit('pointerdown', {});
    expect(delivered).toEqual([{ __dormouse: 'pointerdown' }]);

    outer.emit('message', { origin: PROXY, data: { __dormouse: 'unknown', secret: 'x' } });
    outer.emit('message', { origin: 'https://evil.example', data: { __dormouse: 'leader' } });
    expect(delivered).toHaveLength(1);

    outer.emit('message', {
      origin: PROXY,
      data: { __dormouse: 'location', url: `${PROXY}/next`, secret: 'x' },
    });
    expect(delivered[1]).toEqual({ __dormouse: 'location', url: `${PROXY}/next` });
  });
});

describe('normalizeEmbedderOrigins', () => {
  it('accepts the ancestor chains the shipped webviews actually have', () => {
    expect(normalizeEmbedderOrigins(['vscode-webview://abc-123', 'vscode-file://vscode-app']))
      .toEqual(['vscode-webview://abc-123', 'vscode-file://vscode-app']);
    expect(normalizeEmbedderOrigins(['tauri://localhost'])).toEqual(['tauri://localhost']);
    expect(normalizeEmbedderOrigins(['http://tauri.localhost'])).toEqual(['http://tauri.localhost']);
    expect(normalizeEmbedderOrigins(['HTTP://Tauri.Localhost:1420'])).toEqual(['http://tauri.localhost:1420']);
    expect(normalizeEmbedderOrigins(['tauri://localhost', 'tauri://localhost'])).toEqual(['tauri://localhost']);
  });

  it('refuses a chain it cannot use in full', () => {
    // All-or-nothing: a chain missing one ancestor would block Dormouse's own
    // frame, so an opaque or malformed entry means no chain at all.
    for (const bad of [
      undefined,
      [],
      ['null'],
      ['tauri://localhost', 'null'],
      ['tauri://localhost/path'],
      ['tauri://localhost; script-src *'],
      ['tauri://localhost *'],
      ["tauri://localhost'"],
      ['not-an-origin'],
      [42],
      'tauri://localhost',
      Array.from({ length: 9 }, (_, i) => `http://h${i}.test`),
    ]) {
      expect(normalizeEmbedderOrigins(bad)).toBeNull();
    }
  });

  it("allows only 'self' and every validated app ancestor", () => {
    expect(frameAncestorsCsp(['tauri://localhost']))
      .toBe("frame-ancestors 'self' tauri://localhost");
    expect(frameAncestorsCsp(['vscode-webview://abc-123', 'vscode-file://vscode-app']))
      .toBe("frame-ancestors 'self' vscode-webview://abc-123 vscode-file://vscode-app");
  });
});

describe('isBlockedAddress', () => {
  it('blocks link-local / cloud-metadata ranges', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
  });
  it('blocks the metadata endpoint under equivalent IPv4 encodings', () => {
    // Defense-in-depth: for http: upstreams the WHATWG URL parser already
    // collapses these to 169.254.169.254 before the guard sees them, so the
    // guard must not rely on that pre-normalization — it canonicalizes them
    // itself.
    expect(isBlockedAddress('2852039166')).toBe(true); // 32-bit decimal
    expect(isBlockedAddress('0xa9fea9fe')).toBe(true); // 32-bit hex
    expect(isBlockedAddress('0xA9.0xFE.0xA9.0xFE')).toBe(true); // dotted hex
    expect(isBlockedAddress('0251.0376.0251.0376')).toBe(true); // dotted octal
    expect(isBlockedAddress('169.254.43518')).toBe(true); // short form
  });
  it('blocks the metadata endpoint wrapped in IPv6', () => {
    expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true); // mapped, dotted
    expect(isBlockedAddress('::ffff:a9fe:a9fe')).toBe(true); // mapped, hex
    expect(isBlockedAddress('[::ffff:169.254.169.254]')).toBe(true); // bracketed
    expect(isBlockedAddress('::169.254.169.254')).toBe(true); // compat form
  });
  it('allows ordinary hosts', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(false);
    expect(isBlockedAddress('localhost')).toBe(false);
    expect(isBlockedAddress('example.com')).toBe(false);
    expect(isBlockedAddress('::1')).toBe(false); // loopback
    expect(isBlockedAddress('10.0.0.1')).toBe(false); // private, trusted
    expect(isBlockedAddress('169.255.0.1')).toBe(false); // just outside the /16
    expect(isBlockedAddress('2852094976')).toBe(false); // 169.255.0.0 as decimal
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
