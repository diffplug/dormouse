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
