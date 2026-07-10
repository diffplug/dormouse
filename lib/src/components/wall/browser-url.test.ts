import { describe, expect, it } from 'vitest';
import { hostPathDisplay, loopbackPort, normalizeNavUrl, pathDisplay } from './browser-url';

describe('hostPathDisplay', () => {
  it('drops the scheme and a bare root path', () => {
    expect(hostPathDisplay('http://localhost:5173/')).toBe('localhost:5173');
    expect(hostPathDisplay('https://example.com')).toBe('example.com');
  });

  it('keeps a non-root path but not the query/hash', () => {
    expect(hostPathDisplay('http://localhost:5173/app/page?x=1#frag')).toBe('localhost:5173/app/page');
  });

  it('includes the query when asked (iframe titles do)', () => {
    expect(hostPathDisplay('http://localhost:5173/app?x=1', true)).toBe('localhost:5173/app?x=1');
    expect(hostPathDisplay('http://localhost:5173/?id=story', true)).toBe('localhost:5173?id=story');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(hostPathDisplay('not a url')).toBe('not a url');
    expect(hostPathDisplay('')).toBe('');
  });
});

describe('pathDisplay', () => {
  it('returns the path only, dropping scheme/host', () => {
    expect(pathDisplay('http://localhost:5173/app')).toBe('/app');
    expect(pathDisplay('http://localhost:5173/app/page')).toBe('/app/page');
  });

  it('returns "/" for a root URL', () => {
    expect(pathDisplay('http://localhost:5173/')).toBe('/');
    expect(pathDisplay('http://localhost:5173')).toBe('/');
  });

  it('falls back to the raw string when unparseable', () => {
    expect(pathDisplay('not a url')).toBe('not a url');
    expect(pathDisplay('')).toBe('');
  });
});

describe('normalizeNavUrl', () => {
  it('keeps an explicit scheme untouched', () => {
    expect(normalizeNavUrl('https://example.com')).toBe('https://example.com');
    expect(normalizeNavUrl('http://localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(normalizeNavUrl('about:blank')).toBe('about:blank');
  });

  it('adds http:// for loopback hosts (https just SSL-errors there)', () => {
    expect(normalizeNavUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeNavUrl('127.0.0.1:6006/x')).toBe('http://127.0.0.1:6006/x');
    expect(normalizeNavUrl('app.localhost:3000')).toBe('http://app.localhost:3000');
  });

  it('adds http:// for any host with an explicit port (matches the dor CLI)', () => {
    // The port is the dev/infra-server signal — LAN and Tailnet hosts speak http.
    expect(normalizeNavUrl('example.com:8080')).toBe('http://example.com:8080');
    expect(normalizeNavUrl('box.tailnet.ts.net:3000')).toBe('http://box.tailnet.ts.net:3000');
    expect(normalizeNavUrl('192.168.1.5:8080/path?q=1')).toBe('http://192.168.1.5:8080/path?q=1');
  });

  it('adds https:// for a bare remote host with no port', () => {
    expect(normalizeNavUrl('example.com')).toBe('https://example.com');
    expect(normalizeNavUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });

  it('trims and treats empty input as no navigation', () => {
    expect(normalizeNavUrl('   ')).toBe('');
    expect(normalizeNavUrl('')).toBe('');
    expect(normalizeNavUrl('  example.com  ')).toBe('https://example.com');
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
