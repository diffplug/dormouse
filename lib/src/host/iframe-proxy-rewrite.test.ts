import { runInNewContext } from 'node:vm';
import { describe, it, expect } from 'vitest';
import {
  frameAncestorsCsp,
  instrumentHtml,
  isBlockedAddress,
  iframeShim,
  normalizeEmbedderOrigins,
  errorPageHtml,
  declaresUtf16,
  startsWithUtf16Bom,
  unreachablePage,
  timedOutPage,
  tunnelSocketShim,
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
  const focus = { held: false, calls: 0 };
  const window = { parent, open: undefined as unknown, focus() { focus.held = true; focus.calls++; } };
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const root = {
    style: { setProperty: (k: string, v: string) => properties.set(k, v), removeProperty: (k: string) => properties.delete(k), colorScheme: '' },
    classList: { toggle: (k: string, enabled: boolean) => enabled ? classes.add(k) : classes.delete(k) },
  };
  const dispatched: string[] = [];
  runInNewContext(IFRAME_SHIM, {
    window,
    location: { origin: PROXY, href: `${PROXY}/story` },
    document: { readyState: 'loading', documentElement: root, body: root, hasFocus: () => focus.held },
    CustomEvent: class { constructor(public type: string) {} },
    dispatchEvent: (event: { type: string }) => dispatched.push(event.type),
    history: {},
    addEventListener,
    setTimeout: () => 0,
    URL,
  });
  return {
    parent, properties, classes, root, dispatched, focus,
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

  it('never places the shim ahead of the doctype or a meta charset when both head and body tags are omitted', () => {
    const shim = /<script>\(function\(\)\{/;
    expect(instrumentHtml('<!doctype html><title>x</title><p>hi', APP)).toMatch(/^<!doctype html><script>/);
    const withCharset = instrumentHtml('<!DOCTYPE html><html lang="ja"><head><meta charset="shift_jis"><title>x</title><p>hi', APP);
    expect(withCharset.indexOf('<meta charset="shift_jis">')).toBeLessThan(withCharset.search(shim));
    expect(withCharset).toMatch(/<meta charset="shift_jis"><script>/);
    // No prologue at all: nothing to stay behind but a UTF-8 BOM (latin1-decoded).
    expect(instrumentHtml('<p>hi', APP)).toMatch(/^<script>/);
    expect(instrumentHtml('\xEF\xBB\xBF<p>hi', APP)).toMatch(/^\xEF\xBB\xBF<script>/);
    // `<header>` is not `<head>`.
    expect(instrumentHtml('<!doctype html><header>h</header>', APP)).toMatch(/^<!doctype html><script>/);
  });

  it('strips an in-document CSP meta', () => {
    const out = instrumentHtml('<head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head>', APP);
    expect(out).not.toMatch(/http-equiv=["']?content-security-policy/i);
  });

  it('retains an opted-in document policy while injecting the shim', () => {
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">';
    const out = instrumentHtml(`<head>${policy}</head>`, APP, true);
    expect(out).toContain(policy);
    expect(out).toContain('__dormouse');
  });

  it('forwards the leader chord and a pointerdown select signal', () => {
    expect(IFRAME_SHIM).toContain('__dormouse');
    expect(IFRAME_SHIM).toContain("'leader'");
    expect(IFRAME_SHIM).toContain("'pointerdown'");
    expect(IFRAME_SHIM).toContain("'location'");
    expect(IFRAME_SHIM).toContain("addEventListener('click'");
    expect(IFRAME_SHIM).toContain('pushState');
  });

  it('posts the leader for a left-then-right tap, and not when another key falls between', () => {
    const delivered: unknown[] = [];
    const frame = shimFrame(APP, (data) => delivered.push(data));
    const key = (k: string, location = 0) => frame.emit('keydown', { key: k, location });
    const leaders = () => delivered.filter(d => (d as { __dormouse: string }).__dormouse === 'leader').length;
    key('Shift', 1); key('Shift', 2);
    key('Meta', 1); key('Meta', 2);
    expect(leaders()).toBe(2);
    // "I Am": typing, not the gesture.
    key('Shift', 1); key('I'); key(' '); key('Shift', 2);
    key('Meta', 1); key('c'); key('Meta', 2);
    expect(leaders()).toBe(2);
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

  it('accepts theme data only from its embedder, replaces old variables and leaves page styling alone', () => {
    const frame = shimFrame(APP, () => {});
    frame.properties.set('background', 'pink');
    const data = { __dormouse: 'theme', kind: 'vscode-dark', scheme: 'dark', vars: {
      '--vscode-editor-background': '#123456', 'background': 'red', '--private': 'secret',
    } };
    frame.emit('message', { source: {}, origin: APP, data });
    frame.emit('message', { source: frame.parent, origin: 'https://elsewhere.test', data });
    expect(frame.dispatched).toHaveLength(0);
    frame.emit('message', { source: frame.parent, origin: APP, data });
    expect(frame.properties.get('--vscode-editor-background')).toBe('#123456');
    expect(frame.properties.get('background')).toBe('pink');
    expect(frame.properties.has('--private')).toBe(false);
    frame.emit('message', { source: frame.parent, origin: APP, data: {
      ...data, kind: 'vscode-light', scheme: 'light', vars: { '--vscode-editor-foreground': '#111111' },
    } });
    expect(frame.properties.has('--vscode-editor-background')).toBe(false);
    expect(frame.classes).toEqual(new Set(['vscode-light']));
    expect(frame.root.style.colorScheme).toBe('light');
    // A repeated load request delivering the same theme restyles nothing.
    frame.emit('message', { source: frame.parent, origin: APP, data: {
      ...data, kind: 'vscode-light', scheme: 'light', vars: { '--vscode-editor-foreground': '#111111' },
    } });
    expect(frame.dispatched).toEqual(['dormouse:theme', 'dormouse:theme']);
  });

  it('flags the document\'s own load reports, and only those', () => {
    const delivered: Array<Record<string, unknown>> = [];
    const frame = shimFrame(APP, (data) => delivered.push(data as Record<string, unknown>));
    frame.emit('DOMContentLoaded', {});
    frame.emit('pageshow', {});
    frame.emit('popstate', {});
    expect(delivered.filter(data => data.__dormouse !== 'theme-request')).toEqual([
      { __dormouse: 'location', url: `${PROXY}/story`, loaded: true },
      { __dormouse: 'location', url: `${PROXY}/story`, loaded: true },
      { __dormouse: 'location', url: `${PROXY}/story` },
    ]);
  });

  // The app does not focus a frame for this message, and a page that cancels the
  // press gets no focus from the browser, so the frame takes it itself. Focusing
  // a frame that holds focus can blank it on WebKit.
  it('takes focus from inside on a press, only when the frame lacks it', () => {
    const frame = shimFrame(APP, () => {});
    frame.emit('pointerdown', {});
    expect(frame.focus.calls).toBe(1);
    frame.emit('pointerdown', {});
    expect(frame.focus.calls).toBe(1);
  });

  it('relays pane-level messages but not nested locations through same-origin frames', () => {
    const delivered: unknown[] = [];
    const outer = shimFrame(APP, (data) => delivered.push(data));
    const inner = shimFrame(PROXY, (data) => outer.emit('message', { origin: PROXY, data }));
    delivered.length = 0; // The outer document asks the app for its initial theme.

    inner.emit('pointerdown', {});
    expect(delivered).toEqual([{ __dormouse: 'pointerdown' }]);

    outer.emit('message', { origin: PROXY, data: { __dormouse: 'unknown', secret: 'x' } });
    outer.emit('message', { origin: 'https://evil.example', data: { __dormouse: 'leader' } });
    expect(delivered).toHaveLength(1);

    outer.emit('message', {
      origin: PROXY,
      data: { __dormouse: 'location', url: `${PROXY}/next`, secret: 'x' },
    });
    expect(delivered).toHaveLength(1);

    outer.emit('message', {
      origin: PROXY,
      data: { __dormouse: 'open-window', url: `${PROXY}/next`, secret: 'x' },
    });
    expect(delivered[1]).toEqual({ __dormouse: 'open-window', url: `${PROXY}/next` });
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
  it.each([
    'fd00:ec2::254', // AWS
    'FD00:0EC2:0:0:0:0:0:0254', // the same, uppercase and in full
    '[fd00:ec2::254%en0]',
    'fd20:ce::254', // Google Cloud
    '100.100.100.200', // Alibaba Cloud
    '192.0.0.192', // Oracle Cloud
    '168.63.129.16', // Azure
    '0xa8.63.129.16',
    '::ffff:100.100.100.200',
  ])('blocks the cloud metadata address %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
  // Each form names the embedded address or hands it to a translator, so the
  // connection ends at the IPv4 address however the IPv6 literal reads.
  it.each([
    ['mapped, in full', '0:0:0:0:0:ffff:a9fe:a9fe'],
    ['translated (SIIT)', '::ffff:0:a9fe:a9fe'],
    ['NAT64', '64:ff9b::a9fe:a9fe'],
    ['NAT64, dotted', '64:ff9b::169.254.169.254'],
    ['NAT64, a fixed address', '64:ff9b::a83f:8110'],
    ['local NAT64 /48', '64:ff9b:1:a83f:81:1000::'],
    ['local NAT64 /56', '64:ff9b:1:a9:fe:a9fe::'],
    ['local NAT64 /64', '64:ff9b:1:0:a9:fea9:fe00:0'],
    ['local NAT64 /96', '64:ff9b:1::a9fe:a9fe'],
    ['a network-specific NAT64 /96', '2001:db8:64:1::a9fe:a9fe'],
    ['Oracle Cloud’s IPv6 metadata', 'fd00:c1::a9fe:a9fe'],
  ])('blocks a metadata address embedded in IPv6: %s', (_form, address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });
  it.each([
    'fd00:ec2::253', // the neighbouring DNS resolver
    'fd00:ec2::1',
    'fd20:ce::253',
    '100.100.100.199',
    '192.0.0.193',
    '168.63.129.17',
    '64:ff9b::808:808', // a public address through NAT64
    '2001:db8::1',
    '2001:db8:1:2:3:4:a9fe:a9fe', // low bits that merely look like one
    'fe7f::1',
    'fec0::1',
    '::',
    '::1',
    '1:2:3',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    'not:an:address',
  ])('does not block %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
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

describe('UTF-16 detection', () => {
  it('reads every WHATWG UTF-16 label, quoted or not, and nothing else', () => {
    for (const label of ['utf-16', 'UTF-16LE', 'utf-16be', 'unicode', 'unicodeFFFE', 'unicodefeff', 'ucs-2', 'iso-10646-ucs-2', 'csUnicode']) {
      expect(declaresUtf16(`text/html; charset=${label}`), label).toBe(true);
      expect(declaresUtf16(`text/html;charset="${label}"`), label).toBe(true);
    }
    for (const type of ['text/html', 'text/html; charset=utf-8', 'text/html; charset=Shift_JIS', 'text/html; charset=utf-16x']) {
      expect(declaresUtf16(type), type).toBe(false);
    }
  });

  it('knows a UTF-16 byte-order mark in either byte order', () => {
    expect(startsWithUtf16Bom(Uint8Array.from([0xff, 0xfe, 0x3c, 0]))).toBe(true);
    expect(startsWithUtf16Bom(Uint8Array.from([0xfe, 0xff, 0, 0x3c]))).toBe(true);
    expect(startsWithUtf16Bom(Uint8Array.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(startsWithUtf16Bom(Uint8Array.from([0xff]))).toBe(false);
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

  it('follows the system color scheme instead of hardcoding a dark page', () => {
    const html = errorPageHtml(unreachablePage(new URL('http://localhost:5173/'), 'ECONNREFUSED'));
    expect(html).toContain('color-scheme: light dark');
    expect(html).not.toMatch(/#[0-9a-f]{6}\b/i);
  });

  it('asks about a dev server only when the upstream is this machine', () => {
    for (const local of ['http://localhost:5173/', 'http://127.0.0.2:8000/', 'http://app.localhost:3000/', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]:8080/']) {
      expect(unreachablePage(new URL(local), 'ECONNREFUSED').message, local).toContain('dev server');
      expect(timedOutPage(new URL(local)).message, local).toContain('dev server');
    }
    const remote = new URL('http://box.ts.net:3000/');
    expect(unreachablePage(remote, 'ETIMEDOUT').message).not.toContain('dev server');
    expect(unreachablePage(remote, 'ETIMEDOUT').message).toContain('reachable from this machine');
    expect(timedOutPage(remote).message).not.toContain('dev server');
  });
});

describe('instrumentHtml on a tunneled grant', () => {
  const socketShimAt = (html: string) => html.indexOf(tunnelSocketShim());

  it('shims the socket ahead of the page\'s own head scripts', () => {
    const out = instrumentHtml('<!doctype html><html><head><script>new WebSocket("/hmr")</script></head><body>', APP, false, true);
    expect(socketShimAt(out)).toBeGreaterThan(-1);
    expect(socketShimAt(out)).toBeLessThan(out.indexOf('new WebSocket("/hmr")'));
    expect(out.startsWith('<!doctype html><html><head><script>')).toBe(true);
  });

  it('reads a tag\'s spelling in a script\'s text as text', () => {
    const script = `<script>const template = "<meta charset='utf-8'>";</script>`;
    const out = instrumentHtml(`<!doctype html><head>${script}</head>`, APP, false, true);
    expect(out).toContain(script);
    expect(socketShimAt(out)).toBeLessThan(out.indexOf(script));
  });

  it('finds a charset past a title and comments, whose text it skips', () => {
    const out = instrumentHtml('<!-- a --><html><head><title><meta charset="x"></title>\n<meta charset="utf-8"><script>a</script>', APP, false, true);
    expect(socketShimAt(out)).toBeGreaterThan(out.indexOf('<meta charset="utf-8">'));
    expect(socketShimAt(out)).toBeLessThan(out.indexOf('<script>a</script>'));
  });

  it('reads a quoted `>` as part of its attribute', () => {
    const html = '<!doctype html><html class="[&>body]:m-0"><head><meta content="a>b" charset="utf-8"><script>a</script>';
    const out = instrumentHtml(html, APP, false, true);
    expect(out).toContain('<html class="[&>body]:m-0">');
    expect(out).toContain('<meta content="a>b" charset="utf-8">');
    expect(socketShimAt(out)).toBeGreaterThan(out.indexOf('charset="utf-8">'));
    expect(socketShimAt(out)).toBeLessThan(out.indexOf('<script>a</script>'));
    const body = instrumentHtml('<body class="[&>p]:m-0">hi', APP);
    expect(body).toContain('<body class="[&>p]:m-0"><script>');
  });

  it('stays ahead of a first script, unless a charset stands behind it', () => {
    const first = instrumentHtml('<head><script>a</script><title>t</title></head>', APP, false, true);
    expect(socketShimAt(first)).toBeLessThan(first.indexOf('<script>a</script>'));
    const late = instrumentHtml('<head><script>a</script><meta charset="utf-8"><script>b</script></head>', APP, false, true);
    expect(socketShimAt(late)).toBeGreaterThan(late.indexOf('<meta charset="utf-8">'));
    expect(socketShimAt(late)).toBeLessThan(late.indexOf('<script>b</script>'));
  });

  it('keeps the doctype and charset first, and shims nothing on a local pane', () => {
    const out = instrumentHtml('<!doctype html><head><meta charset="utf-8"><script>a</script>', APP, false, true);
    expect(socketShimAt(out)).toBeGreaterThan(out.indexOf('<meta charset="utf-8">'));
    expect(socketShimAt(instrumentHtml('<head></head>', APP))).toBe(-1);
  });
});

describe('tunnelSocketShim', () => {
  /** The shim in a page of its own: every socket's far port, and what `pagehide` would do. */
  function page() {
    const listeners = new Map<string, () => void>();
    const relayed: { ports: MessagePort[] }[] = [];
    const window: { WebSocket: unknown } = { WebSocket: class {} };
    const navigator = { serviceWorker: { controller: { postMessage: (_message: unknown, ports: MessagePort[]) => relayed.push({ ports }) } } };
    class CloseEvent extends Event {}
    new Function('window', 'navigator', 'location', 'addEventListener', 'CloseEvent', tunnelSocketShim())(
      window, navigator, { href: 'https://f.example/', host: 'f.example', origin: 'https://f.example' },
      (type: string, listener: () => void) => listeners.set(type, listener), CloseEvent,
    );
    const open = () => {
      const Socket = window.WebSocket as new (url: string) => { send(data: string): void; close(code?: number): void; readyState: number; onopen: (() => void) | null };
      const socket = new Socket('/hmr');
      const far = relayed[relayed.length - 1]!.ports[0]!;
      const heard: string[] = [];
      far.onmessage = (event: MessageEvent<{ kind: string }>) => heard.push(event.data.kind);
      return { socket, far, heard };
    };
    return { open, pagehide: () => listeners.get('pagehide')!() };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('sends a close behind the sends before it', async () => {
    const { socket, far, heard } = page().open();
    far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    socket.send('commit');
    socket.close(1000);
    await settle();
    expect(heard).toEqual(['send', 'close']);
    far.close();
  });

  it('closes every socket the page holds as it goes, and only once', async () => {
    const shim = page();
    const first = shim.open();
    const second = shim.open();
    first.far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    // Its own close still queued behind its sends.
    first.socket.close();
    shim.pagehide();
    await settle();
    expect(first.heard).toEqual(['close']);
    // Still connecting: the far end hears it once its open settles.
    expect(second.heard).toEqual(['close']);
    first.far.close();
    second.far.close();
  });

  it('takes a send\'s bytes at the call, as a native socket does', async () => {
    const { socket, far } = page().open();
    const sent: ArrayBuffer[] = [];
    far.onmessage = (event: MessageEvent<{ data: ArrayBuffer }>) => sent.push(event.data.data);
    far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    const bytes = new Uint8Array([1, 2, 3]);
    socket.send(bytes as never);
    bytes.fill(9);
    await settle();
    expect([...new Uint8Array(sent[0]!)]).toEqual([1, 2, 3]);
    far.close();
  });

  it('sends another window\'s buffer as the binary it is', async () => {
    const { socket, far } = page().open();
    const sent: { data: ArrayBuffer; binary: boolean }[] = [];
    far.onmessage = (event: MessageEvent<{ data: ArrayBuffer; binary: boolean }>) => sent.push(event.data);
    far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    socket.send(runInNewContext('new Uint8Array([1, 2, 3]).buffer') as never);
    await settle();
    expect(sent[0]!.binary).toBe(true);
    expect([...new Uint8Array(sent[0]!.data)]).toEqual([1, 2, 3]);
    far.close();
  });

  it('keeps a Blob ahead of the close that follows it, even as the page goes', async () => {
    const shim = page();
    const { socket, far, heard } = shim.open();
    far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    socket.send(new Blob(['later']) as never);
    shim.pagehide();
    await settle();
    expect(heard).toEqual(['send', 'close']);
    far.close();
  });

  it('dispatches on the socket, so a listener\'s this and target are it', async () => {
    const { socket, far } = page().open() as unknown as { far: MessagePort; socket: EventTarget & { send(data: string): void } };
    const seen: unknown[] = [];
    socket.addEventListener('open', function listener(this: unknown, event) { seen.push(this, event.target, event.currentTarget); });
    far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    expect(seen).toEqual([socket, socket, socket]);
    far.close();
  });

  it('refuses a close a native socket refuses, rather than sticking in CLOSING', async () => {
    const { socket, far, heard } = page().open();
    far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    expect(() => socket.close(1001)).toThrow('Invalid close code');
    expect(() => (socket.close as (code: number, reason: string) => void)(1000, 'x'.repeat(124))).toThrow('too long');
    expect(socket.readyState).toBe(1);
    await settle();
    expect(heard).toEqual([]);
    far.close();
  });

  it('reports what it has not sent yet, for a page that throttles by it', async () => {
    const { socket, far } = page().open() as unknown as { far: MessagePort; socket: { send(data: unknown): void; bufferedAmount: number } };
    far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    socket.send('abc');
    socket.send(new Blob(['de']));
    expect(socket.bufferedAmount).toBe(5);
    far.postMessage({ kind: 'sent', bytes: 3 });
    await settle();
    expect(socket.bufferedAmount).toBe(2);
    far.close();
  });

  it('stays closed when the open arrives after a close', async () => {
    const { socket, far } = page().open();
    let opened = false;
    socket.onopen = () => { opened = true; };
    socket.close();
    far.postMessage({ kind: 'open', protocol: '', extensions: '' });
    await settle();
    expect(opened).toBe(false);
    expect(socket.readyState).toBe(2);
    far.close();
  });
});
