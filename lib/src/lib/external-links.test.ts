import { describe, expect, it } from 'vitest';
import { classifyDisplayMatch, inspectExternalUri, normalizeExternalUri } from './external-links';

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
    expect(normalizeExternalUri('data:text/html,hello')).toBeNull();
    expect(normalizeExternalUri('blob:https://example.com/id')).toBeNull();
    expect(normalizeExternalUri('about:blank')).toBeNull();
  });

  it('rejects malformed or control-character-bearing input', () => {
    expect(normalizeExternalUri('not a url')).toBeNull();
    expect(normalizeExternalUri('https://example.com/\nnext')).toBeNull();
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
