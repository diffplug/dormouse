import { describe, expect, it } from 'vitest';
import { classifyDisplayMatch, inspectExternalUri, localFileLinkPreviewPath, normalizeExternalUri } from './external-links';

describe('normalizeExternalUri', () => {
  it('allows absolute external URIs after inspection', () => {
    expect(normalizeExternalUri('https://example.com/docs?q=mouse')).toBe('https://example.com/docs?q=mouse');
    expect(normalizeExternalUri(' http://example.com/path ')).toBe('http://example.com/path');
    expect(normalizeExternalUri('mailto:support@example.com')).toBe('mailto:support@example.com');
    expect(normalizeExternalUri('file:///Users/dev/report.html')).toBe('file:///Users/dev/report.html');
    expect(normalizeExternalUri('vscode://file/Users/dev/project/src/App.tsx:4:2')).toBe('vscode://file/Users/dev/project/src/App.tsx:4:2');
  });

  it('rejects browser-executable or opaque pseudo schemes', () => {
    expect(normalizeExternalUri('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalUri('vbscript:msgbox(1)')).toBeNull();
    expect(normalizeExternalUri('data:text/html,hello')).toBeNull();
    expect(normalizeExternalUri('blob:https://example.com/id')).toBeNull();
    expect(normalizeExternalUri('about:blank')).toBeNull();
  });

  it('refuses the Windows handlers that run code from a link, in any case', () => {
    for (const uri of [
      'ms-msdt:x', 'MS-MSDT:x', 'search-ms:query=x', 'search:query=x', 'ms-officecmd:x',
      'ms-appinstaller:x', 'ms-its:x', 'its:x', 'mk:x', 'hcp://x',
    ]) {
      expect(normalizeExternalUri(uri), uri).toBeNull();
      expect(inspectExternalUri(uri), uri).toMatchObject({ status: 'blocked', reason: expect.stringContaining('never opens') });
    }
  });

  it('rejects malformed or control-character-bearing input', () => {
    expect(normalizeExternalUri('not a url')).toBeNull();
    expect(normalizeExternalUri('https://example.com/\nnext')).toBeNull();
    expect(normalizeExternalUri('https://example.com/\u202etxt.exe')).toBeNull();
    expect(normalizeExternalUri('https://exa\u200bmple.com/')).toBeNull();
    expect(normalizeExternalUri('https://exa\u00admple.com/')).toBeNull();
    expect(normalizeExternalUri('https://example.com/\u{e0041}')).toBeNull();
    expect(normalizeExternalUri('')).toBeNull();
  });

  it('returns a displayable blocked reason', () => {
    expect(inspectExternalUri('javascript:alert(1)')).toMatchObject({
      status: 'blocked',
      scheme: 'javascript',
      displayUri: 'javascript:alert(1)',
      reason: expect.stringContaining('javascript:'),
    });
  });
});

describe('inspectExternalUri scheme tiers', () => {
  it('opens http, https, mailto, and file without the other-app warning', () => {
    for (const uri of ['https://example.com/', 'http://example.com/', 'mailto:a@example.com', 'file:///tmp/x.md']) {
      expect(inspectExternalUri(uri), uri).toMatchObject({ status: 'openable', otherApp: false });
    }
  });

  it('marks every other scheme as handing the link to another app', () => {
    for (const [uri, scheme] of [
      ['vscode://file/x.ts:1', 'vscode'],
      ['tel:+15551234', 'tel'],
      ['slack://open', 'slack'],
      ['ms-settings:display', 'ms-settings'],
    ]) {
      expect(inspectExternalUri(uri), uri).toMatchObject({ status: 'openable', otherApp: true, scheme });
    }
  });

  it('still judges an other-app link deceptive when its text names a different host', () => {
    expect(classifyDisplayMatch('vscode://evil.example/x', 'https://github.com/diffplug')).toBe('deceptive');
  });
});

describe('classifyDisplayMatch', () => {
  it('returns match when displayed text equals the URL', () => {
    expect(classifyDisplayMatch('https://example.com/foo', 'https://example.com/foo')).toBe('match');
  });

  it('returns match when displayed text is empty (terminal auto-detected URL)', () => {
    expect(classifyDisplayMatch('https://example.com/foo', '')).toBe('match');
    expect(classifyDisplayMatch('https://example.com/foo', '   ')).toBe('match');
  });

  it('normalizes a trailing slash and case before deciding match', () => {
    expect(classifyDisplayMatch('https://example.com/foo/', 'https://example.com/foo')).toBe('match');
    expect(classifyDisplayMatch('HTTPS://Example.com/Foo', 'https://example.com/Foo')).toBe('match');
  });

  it('returns plain when displayed text is a human label', () => {
    expect(classifyDisplayMatch('https://ci.example.com/x', 'see the report')).toBe('plain');
    expect(classifyDisplayMatch('https://github.com/foo', 'Click here')).toBe('plain');
  });

  it('returns plain when the displayed URL has the same host as the actual URL', () => {
    // Same host, different path — the label is a shorthand, not deceptive.
    expect(classifyDisplayMatch('https://github.com/foo', 'github.com')).toBe('plain');
    expect(classifyDisplayMatch('https://github.com/foo', 'https://github.com')).toBe('plain');
  });

  it('flags deceptive when the displayed URL targets a different host', () => {
    expect(classifyDisplayMatch('https://evil.com/phish', 'https://goog1e.com')).toBe('deceptive');
    expect(classifyDisplayMatch('https://evil.com/phish', 'goog1e.com')).toBe('deceptive');
    expect(classifyDisplayMatch('https://evil.com/phish', 'https://google.com/maps')).toBe('deceptive');
  });

  it('flags subdomain mismatch as deceptive (conservative side of the false-positive line)', () => {
    expect(classifyDisplayMatch('https://github.com/foo', 'docs.github.com')).toBe('deceptive');
  });

  it.each([
    ['a trailing dot', 'github.com.'],
    ['a port', 'github.com:443'],
    ['a subdomain, port, and path', 'www.github.com:443/login'],
    ['a port on a full URL', 'https://github.com:8443'],
    ['a dotted address and port', '192.168.0.1:8080'],
    ['localhost and a port', 'localhost:3000'],
    ['angle brackets', '<https://github.com>'],
    ['parentheses', '(github.com)'],
    ['square brackets', '[github.com]'],
    ['quotes', '"github.com"'],
    ['trailing punctuation', 'github.com,'],
    ['a scheme-relative name', '//github.com'],
    ['a fullwidth dot', 'github\uff0ecom'],
    ['an ideographic dot', 'github\u3002com'],
    ['fullwidth letters', '\uff47\uff49\uff54\uff48\uff55\uff42.com'],
    ['a zero-width space', 'git\u200bhub.com'],
    ['a soft hyphen', 'git\u00adhub.com'],
    ['a trailing no-break space', 'github.com\u00a0'],
    ['a tag character', 'github.com\u{e0041}'],
    ['a Cyrillic homoglyph', 'g\u0456thub.com'],
  ])('flags a different host spelled with %s as deceptive', (_, display) => {
    expect(classifyDisplayMatch('https://evil.example/login', display)).toBe('deceptive');
  });

  it.each([
    ['a trailing dot', 'github.com.'],
    ['a port', 'github.com:8443'],
    ['brackets', '(https://github.com)'],
    ['a fullwidth dot', 'github\uff0ecom'],
    ['a zero-width space', 'git\u200bhub.com'],
  ])('keeps the same host spelled with %s plain', (_, display) => {
    expect(classifyDisplayMatch('https://github.com/x', display)).toBe('plain');
  });

  it('compares hosts without a port or root dot on the target', () => {
    expect(classifyDisplayMatch('https://github.com:8443/x', 'github.com')).toBe('plain');
    expect(classifyDisplayMatch('https://github.com./x', 'github.com')).toBe('plain');
    expect(classifyDisplayMatch('https://m\u00fcnchen.example/x', 'M\u00dcNCHEN.example')).toBe('plain');
  });

  it.each(['Visit github.com', '12.5%', '$1.50', 'v1.2.3', 'Next...', 'etc.', 'note:12', './build.sh', '~/a.txt', '(see the report)'])(
    'keeps text that names no host plain: %s',
    (display) => {
      expect(classifyDisplayMatch('https://evil.example/login', display)).toBe('plain');
    },
  );

  it('keeps a file link whose text names the file plain, a line number included', () => {
    expect(classifyDisplayMatch('file:///repo/README.md', 'README.md')).toBe('plain');
    expect(classifyDisplayMatch('file:///repo/README.md', 'README.md:42')).toBe('plain');
    expect(classifyDisplayMatch('file:///repo/README.md', '(./README.md)')).toBe('plain');
    expect(classifyDisplayMatch('file:///repo/foo.js/README.md', 'foo.js/README.md:42')).toBe('plain');
    expect(classifyDisplayMatch('file:///repo/notes.txt', 'github.com:443')).toBe('deceptive');
  });

  it.each(['_app.tsx', '@types.d.ts', '-v1.md', '#notes.md', 'cafe\u0301.md', 'cafe\u0301.md:7'])(
    'keeps a file link plain when its text is the name as listed, even where normalizing would change it: %s',
    (name) => {
      const uri = `file:///repo/${encodeURIComponent(name.replace(/:\d+$/, ''))}`;
      expect(classifyDisplayMatch(uri, name)).toBe('plain');
    },
  );

  it('reads a separator as a space, not as nothing', () => {
    expect(classifyDisplayMatch('https://evil.example/login', 'Visit\u2028github.com')).toBe('plain');
  });

  it('classifies a long run of punctuation without backtracking over it', () => {
    const started = performance.now();
    expect(classifyDisplayMatch('https://evil.example/login', `a${'!'.repeat(200_000)}a`)).toBe('plain');
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('treats label with embedded URL as plain unless the bare-domain pattern matches', () => {
    // "Click for https://goog1e.com/free" contains a URL but is itself not URL-shaped.
    // Conservative call: classify as plain. (We'd need to scan for embedded URLs to flag.)
    expect(classifyDisplayMatch('https://evil.com/phish', 'Click for free money')).toBe('plain');
  });
});

describe('localFileLinkPreviewPath', () => {
  const uri = 'file://host.local/x/README.md';

  it('accepts display text naming the whole path or its trailing components', () => {
    expect(localFileLinkPreviewPath(uri, 'README.md')).toBe('/x/README.md');
    expect(localFileLinkPreviewPath(uri, ' x/README.md ')).toBe('/x/README.md');
    expect(localFileLinkPreviewPath(uri, '/x/README.md')).toBe('/x/README.md');
    expect(localFileLinkPreviewPath('file:///x/README.md', 'README.md')).toBe('/x/README.md');
  });

  it('rejects text that is not a whole-component suffix of the path', () => {
    expect(localFileLinkPreviewPath(uri, 'EADME.md')).toBeNull();
    expect(localFileLinkPreviewPath(uri, '/README.md')).toBeNull();
    expect(localFileLinkPreviewPath(uri, 'readme.md')).toBeNull();
    expect(localFileLinkPreviewPath(uri, 'see the docs')).toBeNull();
  });

  it('rejects empty display text', () => {
    expect(localFileLinkPreviewPath(uri, '')).toBeNull();
    expect(localFileLinkPreviewPath(uri, '  ')).toBeNull();
    expect(localFileLinkPreviewPath(uri, '*')).toBeNull();
    expect(localFileLinkPreviewPath('file:///', '')).toBeNull();
    expect(localFileLinkPreviewPath('file:///', '/')).toBe('/');
  });

  it('strips one ls -F classifier', () => {
    expect(localFileLinkPreviewPath(uri, 'README.md*')).toBe('/x/README.md');
    expect(localFileLinkPreviewPath('file:///x/src', 'src/')).toBe('/x/src');
    expect(localFileLinkPreviewPath('file:///x/src/', 'src/')).toBe('/x/src');
    expect(localFileLinkPreviewPath(uri, 'README.md**')).toBeNull();
    expect(localFileLinkPreviewPath('file:///x/a=', 'a=')).toBe('/x/a=');
  });

  it('compares against the percent-decoded path', () => {
    expect(localFileLinkPreviewPath('file:///x/my%20notes.md', 'my notes.md')).toBe('/x/my notes.md');
    expect(localFileLinkPreviewPath('file:///x/my%20notes.md', 'my%20notes.md')).toBeNull();
    expect(localFileLinkPreviewPath('file:///x/%E0%A4%A', 'x')).toBeNull();
  });

  it('rejects a path carrying control characters', () => {
    expect(localFileLinkPreviewPath('file:///x/a%1Bb', 'a\x1bb')).toBeNull();
    expect(localFileLinkPreviewPath('file:///x/a%0Ab', 'a\nb')).toBeNull();
  });

  it('rejects every other scheme and an IP-literal host', () => {
    expect(localFileLinkPreviewPath('https://example.com/x/README.md', 'README.md')).toBeNull();
    expect(localFileLinkPreviewPath('vscode://file/x/README.md', 'README.md')).toBeNull();
    expect(localFileLinkPreviewPath('file://[::1]/x/README.md', 'README.md')).toBeNull();
    expect(localFileLinkPreviewPath('not a url', 'not a url')).toBeNull();
  });
});
