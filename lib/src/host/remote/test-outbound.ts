/**
 * Test-only: every way a Node host process can reach the network, recorded at
 * the Node layer, for the suites that prove Settings → Network's promises
 * against the real host wiring (`docs/specs/security-local.md` -> "Network
 * policy").
 *
 * The globals the Burrow service and managed voice reach for — `fetch` and
 * `WebSocket` — are replaced by recorders that answer locally, and everything
 * underneath them is hooked too, so a path that bypasses the globals is still
 * seen: every TCP connect (`net.Socket.prototype.connect`, which `http`,
 * `https`, `tls`, and undici all end in), `tls.connect`, `dgram.createSocket`,
 * `dns` lookups and resolves, `http(s).request`/`get`, and loading the
 * `node-datachannel` addon that would open the direct path's UDP socket.
 *
 * A recorded attempt that would leave the machine is refused: its socket is
 * destroyed before it connects, so a test can never reach the real network.
 * Loopback and Unix-socket or named-pipe connects pass through untouched.
 */

import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import Module, { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

import { mintNoiseStaticKeyPair } from 'remote-lib-common';

import { FakeSocket } from '../../remote/test-fake-socket';

export interface OutboundAttempt {
  /** Which hook saw it. */
  via: string;
  /** The host it named, or null for a Unix socket or named pipe. */
  host: string | null;
}

/** What answers a recorded `fetch`; the default is a 503 with an empty JSON body. */
export type FetchAnswer = (url: URL, init?: RequestInit) => Response | Promise<Response>;

const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|localhost|::1|\[::1\]|::ffff:127(?:\.\d{1,3}){3})$/i;

/** Whether `attempt` stays on this machine: loopback, or a Unix socket or named pipe. */
export function staysLocal(attempt: OutboundAttempt): boolean {
  return attempt.host === null || LOOPBACK.test(attempt.host);
}

export interface OutboundRecorder {
  /** Every attempt, in order. */
  readonly attempts: readonly OutboundAttempt[];
  /** The attempts that would leave this machine. */
  offMachine(): OutboundAttempt[];
  /** The distinct hosts {@link offMachine} names. */
  hosts(): Set<string>;
  /** Replace what a recorded `fetch` answers. */
  answerFetch(answer: FetchAnswer): void;
  /** Restore every hook. */
  restore(): void;
}

type Restore = () => void;

function hostOfUrl(input: unknown): string | null {
  try {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as { url: string }).url,
    );
    return url.hostname;
  } catch {
    return '(unparseable)';
  }
}

/** The host or path a `net.Socket#connect` call names, in any of its argument shapes. */
function connectTarget(args: unknown[]): { host: string | null } {
  // `net.connect` hands the socket its normalized `[options, cb]` array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === 'object') {
    const options = first as { path?: unknown; host?: unknown };
    if (typeof options.path === 'string') return { host: null };
    return { host: typeof options.host === 'string' ? options.host : 'localhost' };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { host: null };
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
}

/** Install every hook. Call {@link OutboundRecorder.restore} in `afterEach`. */
export function recordOutbound(): OutboundRecorder {
  const attempts: OutboundAttempt[] = [];
  const restores: Restore[] = [];
  const record = (via: string, host: string | null) => {
    const attempt = { via, host };
    attempts.push(attempt);
    return attempt;
  };
  const patch = <T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]) => {
    const original = target[key];
    target[key] = replacement;
    restores.push(() => {
      target[key] = original;
    });
    return original;
  };

  // Every TCP connect: http, https, tls, and undici all end here.
  const connect = net.Socket.prototype.connect;
  patch(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]) {
    const attempt = record('net.Socket#connect', connectTarget(args).host);
    if (staysLocal(attempt)) return (connect as (...a: unknown[]) => net.Socket).apply(this, args);
    process.nextTick(() => this.destroy(new Error(`outbound recorder refused ${attempt.host}`)));
    return this;
  } as typeof connect);

  const tlsConnect = tls.connect;
  patch(tls, 'connect', ((...args: unknown[]) => {
    const target = connectTarget(args);
    record('tls.connect', target.host);
    return (tlsConnect as (...a: unknown[]) => tls.TLSSocket)(...args);
  }) as typeof tls.connect);

  const createSocket = dgram.createSocket;
  patch(dgram, 'createSocket', ((...args: unknown[]) => {
    record('dgram.createSocket', '(udp)');
    return (createSocket as (...a: unknown[]) => dgram.Socket)(...args);
  }) as typeof dgram.createSocket);

  for (const key of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveSrv', 'resolveTxt'] as const) {
    const original = dns[key] as (...a: unknown[]) => unknown;
    patch(dns, key, ((host: unknown, ...rest: unknown[]) => {
      record(`dns.${key}`, typeof host === 'string' ? host : '(unknown)');
      return original(host, ...rest);
    }) as never);
    const promised = dns.promises[key] as (...a: unknown[]) => unknown;
    patch(dns.promises, key, ((host: unknown, ...rest: unknown[]) => {
      record(`dns.promises.${key}`, typeof host === 'string' ? host : '(unknown)');
      return promised(host, ...rest);
    }) as never);
  }

  for (const [name, mod] of [['http', http], ['https', https]] as const) {
    for (const key of ['request', 'get'] as const) {
      const original = mod[key] as (...a: unknown[]) => unknown;
      patch(mod, key, ((...args: unknown[]) => {
        const first = args[0];
        const host =
          typeof first === 'string' || first instanceof URL
            ? hostOfUrl(first)
            : ((first as { hostname?: string; host?: string } | undefined)?.hostname ??
              (first as { host?: string } | undefined)?.host ??
              'localhost');
        record(`${name}.${key}`, host);
        return original(...args);
      }) as never);
    }
  }
  syncBuiltinESMExports();
  restores.push(() => syncBuiltinESMExports());

  // The direct path's addon: loading it is what would open its UDP socket.
  const moduleWithLoad = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
  const load = moduleWithLoad._load;
  patch(moduleWithLoad, '_load', (request: string, ...rest: unknown[]) => {
    if (/^node-datachannel(?:\/|$)/.test(request)) {
      record('require(node-datachannel)', '(udp)');
      throw new Error('outbound recorder refused the direct-path addon');
    }
    return load.call(Module, request, ...rest);
  });

  // The globals the hosts reach for, answered locally.
  let answer: FetchAnswer = () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
  const g = globalThis as Record<string, unknown>;
  const hadFetch = 'fetch' in g;
  const fetch = g.fetch;
  g.fetch = async (input: unknown, init?: RequestInit) => {
    const attempt = record('globalThis.fetch', hostOfUrl(input));
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    if (staysLocal(attempt)) return (fetch as typeof globalThis.fetch)(input as RequestInfo, init);
    return answer(url, init);
  };
  restores.push(() => {
    if (hadFetch) g.fetch = fetch;
    else delete g.fetch;
  });

  const hadWebSocket = 'WebSocket' in g;
  const WebSocket = g.WebSocket;
  g.WebSocket = class RecordedSocket extends FakeSocket {
    constructor(url: string) {
      super();
      record('globalThis.WebSocket', hostOfUrl(url));
    }
  };
  restores.push(() => {
    if (hadWebSocket) g.WebSocket = WebSocket;
    else delete g.WebSocket;
  });

  return {
    attempts,
    offMachine: () => attempts.filter((attempt) => !staysLocal(attempt)),
    hosts: () => new Set(attempts.filter((attempt) => !staysLocal(attempt)).map((attempt) => attempt.host!)),
    answerFetch(next) {
      answer = next;
    },
    restore() {
      for (const undo of restores.splice(0).reverse()) undo();
    },
  };
}

/**
 * A real Noise static pair, for an enrollment fixture a started Burrow accepts.
 * Here so a suite outside `lib` need not depend on `remote-lib-common` itself.
 */
export function mintTestNoiseStatic(): Promise<{ privateKeyPkcs8: string; publicKey: string }> {
  return mintNoiseStaticKeyPair();
}
