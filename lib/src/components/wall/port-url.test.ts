import { describe, expect, it } from 'vitest';
import { listenerUrlsByPort, servesLoopback } from './port-url';
import type { OpenPort } from '../../lib/platform/types';

function tcp(o: {
  address: string;
  port: number;
  family?: 'IPv4' | 'IPv6';
  pid?: number;
  processName?: string;
}): OpenPort {
  return {
    protocol: 'tcp',
    family: o.family ?? (o.address.includes(':') ? 'IPv6' : 'IPv4'),
    address: o.address,
    port: o.port,
    pid: o.pid ?? 1234,
    ...(o.processName !== undefined ? { processName: o.processName } : {}),
  };
}

// protocol is typed 'tcp'; the filter is still exercised via a cast.
const udp = (port: number): OpenPort =>
  ({ protocol: 'udp', family: 'IPv4', address: '127.0.0.1', port, pid: 1 } as unknown as OpenPort);

describe('servesLoopback', () => {
  it('is true for loopback and any-interface binds', () => {
    for (const addr of ['127.0.0.1', '::1', '0.0.0.0', '::']) expect(servesLoopback(addr)).toBe(true);
  });
  it('is false for a specific interface', () => {
    for (const addr of ['192.168.1.5', 'fe80::1']) expect(servesLoopback(addr)).toBe(false);
  });
});

describe('listenerUrlsByPort', () => {
  it.each(['127.0.0.1', '::1', '0.0.0.0', '::'])(
    'prefers a loopback-servable bind (%s) → localhost, even beside a specific one',
    (loopbackAddr) => {
      const ports = [tcp({ address: '192.168.1.5', port: 5173 }), tcp({ address: loopbackAddr, port: 5173 })];
      expect(listenerUrlsByPort(ports)).toEqual([{ port: 5173, host: 'localhost', url: 'http://localhost:5173/' }]);
    },
  );

  it('uses the specific bound address when no loopback bind exists', () => {
    expect(listenerUrlsByPort([tcp({ address: '192.168.1.5', port: 8080 })])).toEqual([
      { port: 8080, host: '192.168.1.5', url: 'http://192.168.1.5:8080/' },
    ]);
  });

  it('brackets a specific IPv6 bind', () => {
    expect(listenerUrlsByPort([tcp({ address: 'fe80::1', port: 3000 })])).toEqual([
      { port: 3000, host: '[fe80::1]', url: 'http://[fe80::1]:3000/' },
    ]);
  });

  it('breaks ties IPv4-before-IPv6 among specific binds', () => {
    const ports = [tcp({ address: 'fe80::1', port: 4000 }), tcp({ address: '10.0.0.2', port: 4000 })];
    expect(listenerUrlsByPort(ports)[0]).toEqual({ port: 4000, host: '10.0.0.2', url: 'http://10.0.0.2:4000/' });
  });

  it('breaks same-family ties by address lexicographically', () => {
    const ports = [tcp({ address: '10.0.0.9', port: 4100 }), tcp({ address: '10.0.0.2', port: 4100 })];
    expect(listenerUrlsByPort(ports)[0].host).toBe('10.0.0.2');
  });

  it('emits one entry per port even across families (dedupe)', () => {
    const ports = [tcp({ address: '127.0.0.1', port: 5173 }), tcp({ address: '::1', port: 5173 })];
    expect(listenerUrlsByPort(ports)).toEqual([{ port: 5173, host: 'localhost', url: 'http://localhost:5173/' }]);
  });

  it('sorts entries ascending by port', () => {
    const ports = [8080, 3000, 5173].map((port) => tcp({ address: '127.0.0.1', port }));
    expect(listenerUrlsByPort(ports).map((e) => e.port)).toEqual([3000, 5173, 8080]);
  });

  it('ignores non-tcp listeners', () => {
    expect(listenerUrlsByPort([udp(9000), tcp({ address: '127.0.0.1', port: 5173 })]).map((e) => e.port)).toEqual([5173]);
    expect(listenerUrlsByPort([udp(9000)])).toEqual([]);
  });

  it('carries the selected listener processName', () => {
    expect(listenerUrlsByPort([tcp({ address: '127.0.0.1', port: 5173, processName: 'node' })])[0].processName).toBe('node');
  });

  it('prefers the selected listener processName over siblings', () => {
    const ports = [
      tcp({ address: '192.168.1.5', port: 5173, processName: 'sibling' }),
      tcp({ address: '127.0.0.1', port: 5173, processName: 'chosen' }),
    ];
    expect(listenerUrlsByPort(ports)[0].processName).toBe('chosen');
  });

  it('falls back to the first defined processName when the selected listener has none', () => {
    const ports = [
      tcp({ address: '127.0.0.1', port: 5173 }),
      tcp({ address: '192.168.1.5', port: 5173, processName: 'vite' }),
    ];
    expect(listenerUrlsByPort(ports)[0].processName).toBe('vite');
  });
});
