import { describe, expect, it } from 'vitest';
import { inspectExternalUri, normalizeExternalUri } from './external-links';

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
