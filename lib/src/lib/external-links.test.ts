import { describe, expect, it } from 'vitest';
import { normalizeExternalUri } from './external-links';

describe('normalizeExternalUri', () => {
  it('allows http, https, and mailto URIs', () => {
    expect(normalizeExternalUri('https://example.com/docs?q=mouse')).toBe('https://example.com/docs?q=mouse');
    expect(normalizeExternalUri(' http://example.com/path ')).toBe('http://example.com/path');
    expect(normalizeExternalUri('mailto:support@example.com')).toBe('mailto:support@example.com');
  });

  it('rejects non-external and scriptable URI schemes', () => {
    expect(normalizeExternalUri('file:///etc/passwd')).toBeNull();
    expect(normalizeExternalUri('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalUri('data:text/html,hello')).toBeNull();
  });

  it('rejects malformed or control-character-bearing input', () => {
    expect(normalizeExternalUri('not a url')).toBeNull();
    expect(normalizeExternalUri('https://example.com/\nnext')).toBeNull();
    expect(normalizeExternalUri('')).toBeNull();
  });
});
