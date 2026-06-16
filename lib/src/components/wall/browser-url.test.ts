import { describe, expect, it } from 'vitest';
import { hostPathDisplay, loopbackPort } from './browser-url';

describe('hostPathDisplay', () => {
  it('drops the scheme and a bare root path', () => {
    expect(hostPathDisplay('http://localhost:5173/')).toBe('localhost:5173');
    expect(hostPathDisplay('https://example.com')).toBe('example.com');
  });

  it('keeps a non-root path but not the query/hash', () => {
    expect(hostPathDisplay('http://localhost:5173/app/page?x=1#frag')).toBe('localhost:5173/app/page');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(hostPathDisplay('not a url')).toBe('not a url');
    expect(hostPathDisplay('')).toBe('');
  });
});

describe('loopbackPort', () => {
  it('extracts the port from loopback hosts', () => {
    expect(loopbackPort('http://localhost:5173/')).toBe(5173);
    expect(loopbackPort('http://127.0.0.1:6006')).toBe(6006);
    expect(loopbackPort('http://app.localhost:3000')).toBe(3000);
    expect(loopbackPort('http://[::1]:8080/')).toBe(8080);
  });

  it('defaults the port from the scheme when absent', () => {
    expect(loopbackPort('http://localhost')).toBe(80);
    expect(loopbackPort('https://localhost')).toBe(443);
  });

  it('returns null for non-loopback hosts', () => {
    expect(loopbackPort('http://example.com:5173')).toBeNull();
    expect(loopbackPort('http://192.168.1.5:5173')).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(loopbackPort('localhost:5173')).toBeNull();
    expect(loopbackPort('')).toBeNull();
  });
});
