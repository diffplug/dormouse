/**
 * The published-endpoint arbitration Windows uses, driven end to end. Windows'
 * pipe names are swapped for unix sockets in a private directory (the mock
 * below keeps the real name's random part), so this runs on every platform the
 * suite does; on Windows itself the real pipe names are used. Bind-as-lease on
 * a derived path, unix's arbitration, is `peer-link.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';

import {
  FrameDecoder,
  PEER_SERVER_PROOF_DOMAIN,
  encodeFrame,
} from '../src/peer-link-protocol';
import {
  derivedSocketPath,
  fakeContext,
  fakeWindow,
  freshModule,
  removeDir,
  tempStorageDir,
  waitFor,
} from './helpers';

type LinkModule = typeof import('../src/peer-link');

/** Where the mock below puts its sockets; one directory per test. */
const endpoint = { dir: '' };

/**
 * This platform's arbitration as one window sees it: the published endpoint
 * with Windows' pipe names swapped for unix sockets (keeping the real name's
 * random part), or an older build's derived path. Registered per window, before
 * {@link freshModule} evaluates that window's copy of `peer-link`.
 */
function mockEndpoint(publishes: boolean): void {
  vi.doMock('../src/peer-endpoint', async (importOriginal) => {
    const real = await importOriginal<typeof import('../src/peer-endpoint')>();
    return {
      publishesEndpoint: () => publishes,
      freshEndpointName: () => {
        const name = real.freshEndpointName();
        return process.platform === 'win32'
          ? name
          : join(endpoint.dir, `${name.slice(name.lastIndexOf('\\') + 1)}.sock`);
      },
    };
  });
}

vi.mock('../src/log', () => ({ log: { init() {}, info() {}, error() {} } }));

let dir: string;
let realTmp: string | undefined;
const opened: LinkModule[] = [];
const servers: Server[] = [];

const endpointFile = (): string => join(dir, 'burrow.peer-endpoint');
const published = async (): Promise<string | null> =>
  readFile(endpointFile(), 'utf8').then((text) => text.trim(), () => null);

/** A name nothing has bound, on whichever namespace this platform dials. */
let spare = 0;
const spareName = (): string =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\dormouse-peer-test-${process.pid}-${++spare}`
    : join(endpoint.dir, `spare-${++spare}.sock`);

async function openWindow(
  side = fakeWindow(),
  { olderBuild = false }: { olderBuild?: boolean } = {},
): Promise<LinkModule> {
  mockEndpoint(!olderBuild);
  const mod = await freshModule<LinkModule>(() => import('../src/peer-link'));
  mod.initPeerLink(fakeContext(dir));
  mod.configurePeerLink(side.deps());
  opened.push(mod);
  return mod;
}

/** Whether `mod` is a client that can reach its broker. */
const reachesBroker = (mod: LinkModule): boolean =>
  !mod.isPeerBroker() && mod.forwardCommand({ burrowRequestId: 'probe', cmd: 'status' });

function listen(server: Server, path: string): Promise<void> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => resolve());
  });
}

beforeEach(async () => {
  dir = await tempStorageDir();
  // Short, for macOS's ~104-byte socket path cap; private, like the real names.
  endpoint.dir = process.platform === 'win32' ? '' : await mkdtemp('/tmp/dpe-');
  realTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
});

afterEach(async () => {
  for (const mod of [...opened].reverse()) await mod.disposePeerLink();
  opened.length = 0;
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  await removeDir(dir);
  if (endpoint.dir) await removeDir(endpoint.dir);
});

describe('published endpoint', () => {
  it('mints a fresh, unpredictable pipe name every time', async () => {
    const { freshEndpointName } = await vi.importActual<typeof import('../src/peer-endpoint')>(
      '../src/peer-endpoint',
    );
    const names = new Set(Array.from({ length: 32 }, () => freshEndpointName()));
    expect(names.size).toBe(32);
    for (const name of names) expect(name).toMatch(/^\\\\\.\\pipe\\dormouse-peer-[0-9a-f]{32}$/);
  });

  it('binds a fresh name for every broker, never the derived one, and retracts it on close', async () => {
    const first = await openWindow();
    await first.ensurePeerNet(() => {});
    expect(first.isPeerBroker()).toBe(true);
    const firstName = await published();
    expect(firstName).toBeTruthy();
    expect(firstName).not.toBe(derivedSocketPath(dir));

    // Windows that need the broker find it through the file.
    const peer = await openWindow(fakeWindow({ entries: [{ surfaceId: 'far-1' }] }));
    await peer.ensurePeerNet(() => {});
    expect(reachesBroker(peer)).toBe(true);

    await peer.disposePeerLink();
    await first.disposePeerLink();
    expect(await published()).toBeNull();

    const second = await openWindow();
    await second.ensurePeerNet(() => {});
    expect(second.isPeerBroker()).toBe(true);
    const secondName = await published();
    expect(secondName).toBeTruthy();
    expect(secondName).not.toBe(firstName);
    expect(secondName).not.toBe(derivedSocketPath(dir));
  }, 15_000);

  it.skipIf(process.platform === 'win32')('publishes the name in a file only this user can read', async () => {
    const broker = await openWindow();
    await broker.ensurePeerNet(() => {});
    expect((await stat(endpointFile())).mode & 0o777).toBe(0o600);
  });

  it('is not held off by another account that took the derived name first', async () => {
    // The squat this design closes: anything can sit on the derived name, and
    // a new build brokers on its own fresh name regardless.
    const squatted: Socket[] = [];
    const squatter = createServer((socket) => void squatted.push(socket));
    const legacy = derivedSocketPath(dir);
    if (process.platform !== 'win32') await mkdir(dirname(legacy), { recursive: true, mode: 0o700 });
    await listen(squatter, legacy);

    const broker = await openWindow();
    const peer = await openWindow(fakeWindow({ entries: [{ surfaceId: 'far-1' }] }));
    await broker.ensurePeerNet(() => {});
    await peer.ensurePeerNet(() => {});
    expect(broker.isPeerBroker()).toBe(true);
    expect(reachesBroker(peer)).toBe(true);
    expect(await broker.remoteRequest('directory', {})).toEqual([{ surfaceId: 'far-1' }]);
    for (const socket of squatted) socket.destroy();
  }, 15_000);

  it('retires a stale file naming a broker that is gone', async () => {
    const dead = spareName();
    await writeFile(endpointFile(), dead, { mode: 0o600 });

    const mod = await openWindow();
    const roles: boolean[] = [];
    await mod.ensurePeerNet((held) => roles.push(held));

    expect(roles).toEqual([true]);
    const now = await published();
    expect(now).toBeTruthy();
    expect(now).not.toBe(dead);
  }, 15_000);

  it('retires a published name that something other than a broker bound after it died', async () => {
    // Windows lists every pipe to every account, so a dead broker's name can be
    // taken by someone else. Retrying it forever would be the same denial as
    // squatting a derived name; it never proves the token, so it is retired.
    const taken = spareName();
    const received: unknown[] = [];
    const squatter = createServer((socket) => {
      const decoder = new FrameDecoder();
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        for (const frame of decoder.push(chunk)) {
          received.push(frame);
          socket.write(encodeFrame({ kind: 'welcome', proof: 'made up' }));
        }
      });
      socket.write(encodeFrame({ kind: 'challenge', nonce: 'squatter-nonce' }));
    });
    await listen(squatter, taken);
    await writeFile(endpointFile(), taken, { mode: 0o600 });

    const side = fakeWindow({ entries: [{ surfaceId: 'secret-1' }] });
    const mod = await openWindow(side);
    await mod.ensurePeerNet(() => {});

    expect(mod.isPeerBroker()).toBe(true);
    expect(await published()).not.toBe(taken);
    // It was told nothing but hellos, which carry no token.
    const token = (await readFile(join(dir, 'burrow.peer-token'), 'utf8')).trim();
    expect(received.every((frame) => (frame as { kind: string }).kind === 'hello')).toBe(true);
    expect(JSON.stringify(received)).not.toContain(token);
    expect(side.requests).toEqual([]);
  }, 15_000);

  it('settles windows starting together into one broker that the others reach', async () => {
    // With the derived name squatted, the file alone has to elect one broker:
    // nothing can join through that name instead.
    const legacy = derivedSocketPath(dir);
    if (process.platform !== 'win32') await mkdir(dirname(legacy), { recursive: true, mode: 0o700 });
    await listen(createServer((socket) => socket.destroy()), legacy);
    const windows = [await openWindow(), await openWindow(), await openWindow()];
    const roles: boolean[] = [];
    await Promise.all(windows.map((mod) => mod.ensurePeerNet((held) => roles.push(held))));

    await waitFor(() => windows.every((mod) => mod.isPeerBroker() || reachesBroker(mod)), 10_000);
    expect(windows.filter((mod) => mod.isPeerBroker())).toHaveLength(1);
    expect(roles).toEqual([true]);
  }, 20_000);

  it('brings connected peers to a fresh broker when theirs dies and leaves its file behind', async () => {
    // A broker whose extension host crashed: its pipe is gone, its file is not.
    const token = 'shared-token';
    await writeFile(join(dir, 'burrow.peer-token'), token, { mode: 0o600 });
    const crashed = spareName();
    const accepted: Socket[] = [];
    const broker = createServer((socket) => {
      accepted.push(socket);
      const decoder = new FrameDecoder();
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        for (const frame of decoder.push(chunk)) {
          const hello = frame as { kind: string; nonce: string };
          if (hello.kind !== 'hello') continue;
          const proof = createHmac('sha256', token)
            .update(PEER_SERVER_PROOF_DOMAIN + hello.nonce)
            .digest('base64url');
          socket.write(encodeFrame({ kind: 'welcome', proof }));
        }
      });
      socket.write(encodeFrame({ kind: 'challenge', nonce: 'broker-nonce' }));
    });
    await listen(broker, crashed);
    await writeFile(endpointFile(), crashed, { mode: 0o600 });

    const sides = [
      fakeWindow({ entries: [{ surfaceId: 'b-1' }] }),
      fakeWindow({ entries: [{ surfaceId: 'c-1' }] }),
    ];
    const peers = [await openWindow(sides[0]), await openWindow(sides[1])];
    await Promise.all(peers.map((mod) => mod.ensurePeerNet(() => {})));
    expect(peers.every(reachesBroker)).toBe(true);

    servers.splice(servers.indexOf(broker), 1);
    for (const socket of accepted) socket.destroy();
    await new Promise((resolve) => broker.close(resolve));
    expect(await published()).toBe(crashed);

    await waitFor(() => peers.some((mod) => mod.isPeerBroker()), 10_000);
    const [elected] = peers.filter((mod) => mod.isPeerBroker());
    const other = peers.find((mod) => mod !== elected)!;
    await waitFor(() => reachesBroker(other), 10_000);
    expect(peers.filter((mod) => mod.isPeerBroker())).toHaveLength(1);
    expect(await published()).not.toBe(crashed);

    // And a window opened afterwards finds the new broker too.
    const late = await openWindow(fakeWindow({ entries: [{ surfaceId: 'd-1' }] }));
    await late.ensurePeerNet(() => {});
    expect(reachesBroker(late)).toBe(true);
    await waitFor(async () => (await elected.remoteRequest('directory', {})).length === 2, 10_000);
  }, 30_000);
});

describe('alongside older builds', () => {
  it('joins an older build’s broker on the derived name instead of electing a second one', async () => {
    const older = await openWindow(fakeWindow(), { olderBuild: true });
    await older.ensurePeerNet(() => {});
    expect(older.isPeerBroker()).toBe(true);

    const roles: boolean[] = [];
    const newer = await openWindow(fakeWindow({ entries: [{ surfaceId: 'far-1' }] }));
    await newer.ensurePeerNet((held) => roles.push(held));

    expect(roles).toEqual([]);
    expect(reachesBroker(newer)).toBe(true);
    expect(await older.remoteRequest('directory', {})).toEqual([{ surfaceId: 'far-1' }]);
    // It retracted the name it briefly published, so later windows are not sent there.
    expect(await published()).toBeNull();
  }, 15_000);

  it('lets an older build’s window join a newer broker through the derived name', async () => {
    const newer = await openWindow();
    await newer.ensurePeerNet(() => {});
    expect(newer.isPeerBroker()).toBe(true);

    const roles: boolean[] = [];
    const older = await openWindow(fakeWindow({ entries: [{ surfaceId: 'far-1' }] }), { olderBuild: true });
    await older.ensurePeerNet((held) => roles.push(held));

    expect(roles).toEqual([]);
    expect(reachesBroker(older)).toBe(true);
    expect(await newer.remoteRequest('directory', {})).toEqual([{ surfaceId: 'far-1' }]);
  }, 15_000);
});
