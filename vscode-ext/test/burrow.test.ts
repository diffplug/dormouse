/**
 * The extension host's binding of the Burrow service: where its enrollment and
 * ACL live, which window is allowed to run it, and the provider it serves
 * remote-api v1 through. The service itself is covered in
 * `lib/src/host/remote/service.test.ts`; this is the glue that only exists here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type { EnrollmentOffer } from 'remote-lib-common';

import { ENROLLMENT_KEY } from '../../lib/src/remote/burrow/store';
import type { ExtensionMessage } from '../src/message-types';
import { FrameDecoder, encodeFrame } from '../src/peer-link-protocol';
import {
  createProcessedPtyStreams,
  type ProcessedPtyChunk,
} from '../src/processed-pty-streams';
import {
  derivedSocketPath as socketPathFor,
  fakeSink,
  fakeWindow,
  freshModule,
  removeDir,
  tempStorageDir,
  tick,
  waitFor,
} from './helpers';

type BurrowModule = typeof import('../src/burrow');
type LinkModule = typeof import('../src/peer-link');

/**
 * A well-formed `burrowId`: base64url of 16 bytes. `isEnrollment` accepts only
 * that shape, so a stored enrollment naming a shorter id reads as malformed
 * and this window never starts a Burrow.
 */
const BURROW_ID = 'S6kyjjqOS7mw3l8ye89U3g';

/**
 * The installer's offer file is the one thing an idle `status` reads off the
 * real disk, and whether the machine running these tests happens to have a
 * Dormouse Relay installed must not decide whether they pass. Mocked at the
 * module both readers share — the glue's `idleStatus` and the service's own
 * default `readOffer`.
 */
let offer: EnrollmentOffer | null = null;
vi.mock('../../lib/src/host/remote/enroll-offer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/src/host/remote/enroll-offer')>()),
  readEnrollmentOffer: () => Promise.resolve(offer),
}));

const OFFER: EnrollmentOffer = {
  origin: 'https://ned-mac.tail9c2f1.ts.net',
  token: 'a'.repeat(64),
  mintedAt: '2026-08-31T00:00:00.000Z',
};

let dir: string;
let realTmp: string | undefined;
/** Every link this test opened; the last one belongs to the module under test. */
const links: LinkModule[] = [];
let opened: LinkModule | null = null;
let squatter: Server | null = null;
const squatted: Socket[] = [];

const derivedSocketPath = (): string => socketPathFor(dir);

/** One `secrets.onDidChange` subscriber, as VS Code hands them out. */
interface SecretWatcher {
  (event: { key: string }): void;
}

interface PendingGlobalWrite {
  key: string;
  value: unknown;
  finish(): void;
}

/** The slice of `ExtensionContext` the store reads, in memory. */
function fakeContext(options: { deferGlobalWrites?: PendingGlobalWrite[] } = {}) {
  const secrets = new Map<string, string>();
  const global = new Map<string, string>();
  const watchers = new Set<SecretWatcher>();
  /** Every keychain round trip, so a test can see the memo working. */
  const reads: string[] = [];
  /** What `SecretStorage` does across every window of one extension. */
  const announce = (key: string) => {
    for (const watcher of [...watchers]) watcher({ key });
  };
  return {
    store: { secrets, global, announce, watchers, reads },
    context: {
      globalStorageUri: { fsPath: dir },
      subscriptions: [] as unknown[],
      secrets: {
        get: async (key: string) => {
          reads.push(key);
          return secrets.get(key);
        },
        store: async (key: string, value: string) => {
          secrets.set(key, value);
          announce(key);
        },
        delete: async (key: string) => {
          secrets.delete(key);
          announce(key);
        },
        onDidChange: (watcher: SecretWatcher) => {
          watchers.add(watcher);
          return { dispose: () => void watchers.delete(watcher) };
        },
      },
      globalState: {
        get: (key: string) => global.get(key),
        update: (key: string, value: unknown) => {
          const apply = () => {
            if (value === undefined) global.delete(key);
            else global.set(key, value as string);
          };
          if (!options.deferGlobalWrites) {
            apply();
            return Promise.resolve();
          }
          return new Promise<void>((resolve) => {
            options.deferGlobalWrites!.push({
              key,
              value,
              finish: () => {
                apply();
                resolve();
              },
            });
          });
        },
        keys: () => [...global.keys()],
      },
    } as never,
  };
}

function fakeDeps() {
  const posted: ExtensionMessage[] = [];
  const asked: Array<{ op: string; params: unknown }> = [];
  const chunkListeners = new Map<string, Set<(chunk: ProcessedPtyChunk) => void>>();
  const exitListeners = new Set<(id: string, exitCode: number) => void>();
  const ptyStatuses = new Map<string, { alive: boolean; exitCode?: number }>();
  const streams = createProcessedPtyStreams(
    (ptyId, onChunk) => {
      let listeners = chunkListeners.get(ptyId);
      if (!listeners) {
        listeners = new Set();
        chunkListeners.set(ptyId, listeners);
      }
      const subscribed = listeners;
      subscribed.add(onChunk);
      return () => void subscribed.delete(onChunk);
    },
    (listener) => {
      exitListeners.add(listener);
      return () => void exitListeners.delete(listener);
    },
    (id) => ptyStatuses.get(id) ?? { alive: true },
  );
  return {
    posted,
    asked,
    emitData: (id: string, data: string, textData?: string) => {
      ptyStatuses.set(id, { alive: true });
      const chunk: ProcessedPtyChunk = textData === undefined ? { data } : { data, textData };
      for (const listener of [...(chunkListeners.get(id) ?? [])]) listener(chunk);
    },
    emitExit: (id: string, exitCode: number) => {
      ptyStatuses.set(id, { alive: false, exitCode });
      for (const listener of exitListeners) listener(id, exitCode);
    },
    answers: new Map<string, unknown[]>(),
    deps(): Parameters<BurrowModule['configureBurrow']>[0] {
      return {
        brokerRequest: async (op, params) => {
          asked.push({ op, params });
          return this.answers.get(op) ?? [];
        },
        broadcastToWebviews: (message) => void posted.push(message),
        writePty: () => {},
        resizePty: () => {},
        streamPty: streams.streamPty,
      };
    },
  };
}

/** A fresh copy of the module pair, so one process can play several windows. */
async function freshBurrow() {
  vi.resetModules();
  const mod = (await import('../src/burrow')) as BurrowModule;
  opened = (await import('../src/peer-link')) as LinkModule;
  opened.initPeerLink(fakeContext().context);
  links.push(opened);
  return mod;
}

/**
 * The wiring `message-router.ts` does at module load. Without it a forwarded
 * command reaches the link and stops there, which is the bug this shape exists
 * to make visible.
 */
function bridgeLinkToBurrow(
  mod: BurrowModule,
  link: LinkModule,
  bound: ReturnType<typeof fakeDeps>,
): void {
  const local = bound.deps();
  link.configurePeerLink({
    brokerRequest: local.brokerRequest,
    invalidateDirectory: mod.notifyDirectoryChanged,
    ownsPty: () => false,
    streamPty: local.streamPty,
    writePty: local.writePty,
    resizePty: local.resizePty,
    handleForwardedCommand: mod.handleForwardedCommand,
    dropForwardedCommands: mod.dropForwardedCommands,
    deliverCommandResult: mod.deliverCommandResult,
    deliverUiEvent: mod.deliverUiEvent,
    onClientAuthenticated: mod.greetPeerWindow,
  });
}

/** Another window on the same socket — the link half of one, which is all the far tier is. */
async function openFarWindow(side: ReturnType<typeof fakeWindow>): Promise<LinkModule> {
  const link = await freshModule<LinkModule>(() => import('../src/peer-link'));
  link.initPeerLink(fakeContext().context);
  link.configurePeerLink(side.deps());
  links.push(link);
  await link.ensurePeerNet(() => {});
  return link;
}

/**
 * Occupy the socket, so the module under test can only ever be a client.
 *
 * It has to complete the real handshake — the token file is right there in the
 * storage dir, which is what a *legitimate* second window has too — because a
 * client that cannot verify the welcome disconnects and forwards nothing.
 */
async function otherWindowHoldsTheBurrow(): Promise<{ frames: Array<{ kind: string }> }> {
  const frames: Array<{ kind: string }> = [];
  const { createHmac } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const path = derivedSocketPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Sockets are kept so cleanup can drop them: `close()` waits for every live
  // connection, and this stand-in has no lifecycle of its own to end them.
  const server = createServer((socket) => {
    squatted.push(socket);
    const decoder = new FrameDecoder();
    socket.setEncoding('utf8');
    socket.write(encodeFrame({ kind: 'challenge', nonce: 'broker-nonce' }));
    socket.on('data', (chunk: string) => {
      for (const frame of decoder.push(chunk)) {
        const typed = frame as { kind: string; nonce?: string };
        frames.push(typed);
        if (typed.kind !== 'hello') continue;
        void (async () => {
          const token = (await readFile(join(dir, 'burrow.peer-token'), 'utf8')).trim();
          socket.write(
            encodeFrame({
              kind: 'welcome',
              proof: createHmac('sha256', token)
                .update(`server:${typed.nonce ?? ''}`)
                .digest('base64url'),
            }),
          );
        })();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  squatter = server;
  return { frames };
}

function results(posted: ExtensionMessage[]) {
  return posted
    .filter((message) => message.type === 'burrow:result')
    .map((message) => (message as { payload: { burrowRequestId: string; error?: string } }).payload);
}

beforeEach(async () => {
  dir = await tempStorageDir();
  realTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  offer = null;
});

afterEach(async () => {
  // Clients before the broker: disposing the broker first sends every client
  // back into the contention, which recreates files under `dir` as it is
  // removed.
  for (const link of [...links].reverse()) await link.disposePeerLink();
  links.length = 0;
  opened = null;
  for (const socket of squatted) socket.destroy();
  squatted.length = 0;
  if (squatter) await new Promise((resolve) => squatter!.close(resolve));
  squatter = null;
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  vi.unstubAllGlobals();
  await removeDir(dir);
});

/**
 * A complete `BurrowAclRecord`. The store's read-back guard checks the whole
 * shape, not just `burrowId` — a partial object is dropped, which is the point
 * (`docs/specs/security-remote.md` -> "Trust boundary"), so fixtures have to be real records. The
 * two E2E fields are base64url of exactly 32 bytes, i.e. 43 characters, and a
 * fixture shorter than that is dropped rather than tested.
 */
function aclRecord(burrowId: string, client: string) {
  const pad = (text: string): string => text.padEnd(43, 'A').slice(0, 43);
  return {
    burrowId,
    accountId: 'owner',
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: 'hash-1',
    clientStaticPublicKey: pad(`client-${client}`),
    deliveryId: pad(`delivery-${client}`),
    approvedAt: 1,
    approvedBy: 'burrow-user',
    label: 'iPhone Safari',
    revokedAt: null,
  };
}

describe('burrow state store', () => {
  it('round-trips the enrollment through SecretStorage', async () => {
    const { VsCodeBurrowStateStore } = await import('../src/burrow-store');
    const { context, store } = fakeContext();
    const target = new VsCodeBurrowStateStore(context);
    const enrollment = {
      relayUrl: 'https://relay.dormouse.sh',
      burrowId: BURROW_ID,
      burrowToken: 'token',
      origin: 'https://relay.dormouse.sh',
      rpId: 'relay.dormouse.sh',
    };

    await target.saveEnrollment(enrollment);
    // The bearer credential belongs in the keychain, never in globalState.
    expect(store.global.size).toBe(0);
    expect(await target.loadEnrollment()).toEqual(enrollment);

    await target.clearEnrollment();
    expect(await target.loadEnrollment()).toBeNull();
  });

  it('reads an enrollment the webview-resident Burrow left behind', async () => {
    // The legacy path wrote the same JSON string under the same key through
    // `store:write`, so an already-enrolled installation needs no migration.
    const { VsCodeBurrowStateStore } = await import('../src/burrow-store');
    const { context, store } = fakeContext();
    const enrollment = {
      relayUrl: 'https://relay.dormouse.sh',
      burrowId: BURROW_ID,
      burrowToken: 'token',
      origin: 'https://relay.dormouse.sh',
      rpId: 'relay.dormouse.sh',
    };
    store.secrets.set('dormouse.burrow.enrollment', JSON.stringify(enrollment));
    store.global.set(
      `dormouse.burrow.acl.${BURROW_ID}`,
      JSON.stringify([aclRecord(BURROW_ID, 'client-1')]),
    );

    const target = new VsCodeBurrowStateStore(context);
    expect(await target.loadEnrollment()).toEqual(enrollment);
    expect(await target.loadAcl(BURROW_ID)).toEqual([aclRecord(BURROW_ID, 'client-1')]);
  });

  it('forgets a failed keychain read instead of memoizing it', async () => {
    // A locked or keyring-less keychain rejects `secrets.get`; that says
    // nothing about what the store holds. A memoized rejection would leave an
    // enrolled window silently Burrow-less until reload — `onDidChange` only
    // fires on a write, so nothing else ever retries the read.
    const { VsCodeBurrowStateStore } = await import('../src/burrow-store');
    const { context, store } = fakeContext();
    const enrollment = {
      relayUrl: 'https://relay.dormouse.sh',
      burrowId: BURROW_ID,
      burrowToken: 'token',
      origin: 'https://relay.dormouse.sh',
      rpId: 'relay.dormouse.sh',
    };
    store.secrets.set('dormouse.burrow.enrollment', JSON.stringify(enrollment));
    const workingGet = context.secrets.get;
    context.secrets.get = async () => {
      throw new Error('keychain is locked');
    };

    const target = new VsCodeBurrowStateStore(context);
    await expect(target.loadEnrollment()).rejects.toThrow('keychain is locked');

    context.secrets.get = workingGet;
    expect(await target.loadEnrollment()).toEqual(enrollment);
  });

  it('re-reads the enrollment after another window changed it', async () => {
    // The memo is a keychain round trip saved, but `SecretStorage` is shared by
    // every window of the extension: without invalidation a window that read it
    // once could keep serving a Burrow another window cleared, or never see one
    // another window created.
    const { VsCodeBurrowStateStore } = await import('../src/burrow-store');
    const { context, store } = fakeContext();
    const changes: number[] = [];
    const target = new VsCodeBurrowStateStore(context, () => changes.push(1));
    const enrollment = {
      relayUrl: 'https://relay.dormouse.sh',
      burrowId: BURROW_ID,
      burrowToken: 'token',
      origin: 'https://relay.dormouse.sh',
      rpId: 'relay.dormouse.sh',
    };
    store.secrets.set(ENROLLMENT_KEY, JSON.stringify(enrollment));

    expect(await target.loadEnrollment()).toEqual(enrollment);
    // Memoized: a second read costs no round trip.
    await target.loadEnrollment();
    expect(store.reads).toHaveLength(1);

    // Another window cleared it.
    store.secrets.delete(ENROLLMENT_KEY);
    store.announce(ENROLLMENT_KEY);
    expect(await target.loadEnrollment()).toBeNull();
    expect(store.reads).toHaveLength(2);
    expect(changes).toHaveLength(1);

    // Some other secret changing is none of its business.
    store.secrets.set(ENROLLMENT_KEY, JSON.stringify(enrollment));
    store.announce('some.other.secret');
    expect(await target.loadEnrollment()).toBeNull();
    expect(store.reads).toHaveLength(2);

    target.dispose();
    store.announce(ENROLLMENT_KEY);
    expect(changes).toHaveLength(1);
  });

  it('drops records that name a different burrow, and unreadable values', async () => {
    const { VsCodeBurrowStateStore } = await import('../src/burrow-store');
    const { context, store } = fakeContext();
    const target = new VsCodeBurrowStateStore(context);

    await target.saveAcl('burrow-1', [
      aclRecord('burrow-2', 'client-2') as never,
      aclRecord('burrow-1', 'client-1') as never,
      // Right burrow, wrong shape: the guard is the whole record, not just the
      // burrowId, because `globalState` is hand-editable and a record written
      // before the end-to-end cutover has neither E2E field.
      { burrowId: 'burrow-1', clientStaticPublicKey: 42 } as never,
    ]);
    expect(await target.loadAcl('burrow-1')).toEqual([aclRecord('burrow-1', 'client-1')]);

    store.secrets.set('dormouse.burrow.enrollment', 'not json');
    expect(await target.loadEnrollment()).toBeNull();
    store.global.set('dormouse.burrow.acl.burrow-9', 'not json');
    expect(await target.loadAcl('burrow-9')).toEqual([]);
  });

  it('serializes ACL snapshots so an older approval cannot land last', async () => {
    const { VsCodeBurrowStateStore } = await import('../src/burrow-store');
    const pending: PendingGlobalWrite[] = [];
    const { context } = fakeContext({ deferGlobalWrites: pending });
    const target = new VsCodeBurrowStateStore(context);
    const first = [aclRecord('burrow-1', 'client-1')] as never;
    const second = [aclRecord('burrow-1', 'client-1'), aclRecord('burrow-1', 'client-2')] as never;

    const firstSave = target.saveAcl('burrow-1', first);
    const secondSave = target.saveAcl('burrow-1', second);
    await tick();
    expect(pending).toHaveLength(1);

    pending[0]!.finish();
    await firstSave;
    await tick();
    expect(pending).toHaveLength(2);
    pending[1]!.finish();
    await secondSave;

    expect(await target.loadAcl('burrow-1')).toEqual(second);
  });
});

describe('burrow service glue', () => {
  it('bootstraps the contention on the first enroll, then runs the command', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    // No enrollment yet, so activation binds nothing.
    mod.initBurrow(fakeContext().context);
    expect(opened!.isPeerBroker()).toBe(false);

    mod.handleBurrowCommand({
      burrowRequestId: 'rh-1',
      cmd: 'enroll',
      params: { relayUrl: 'https://evil.example', password: 'p', label: 'Laptop' },
    });

    await waitFor(() => results(bound.posted).length > 0);
    // The service ran it (and refused the origin), rather than the interim
    // "another window" answer — which is what proves this window took the Burrow.
    expect(opened!.isPeerBroker()).toBe(true);
    expect(results(bound.posted)[0]).toMatchObject({
      burrowRequestId: 'rh-1',
      error: expect.stringContaining('allowed remote sources'),
    });
  });

  it('bootstraps the contention on enrollOffer too, or the card cannot be pressed', async () => {
    // The one-click card renders off the idle `status` above, on a machine with
    // no Burrow in any window. If only `enroll` bootstrapped, pressing Enroll
    // would be refused "no Burrow is reachable" every time.
    offer = OFFER;
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    mod.initBurrow(fakeContext().context);
    expect(opened!.isPeerBroker()).toBe(false);

    mod.handleBurrowCommand({
      burrowRequestId: 'rh-1',
      cmd: 'enrollOffer',
      params: { origin: OFFER.origin, label: 'Laptop' },
    });

    await waitFor(() => results(bound.posted).length > 0);
    expect(opened!.isPeerBroker()).toBe(true);
    // The service ran it and refused the origin this build was not built for —
    // which is the proof it reached a service at all.
    expect(results(bound.posted)[0]).toMatchObject({
      burrowRequestId: 'rh-1',
      error: expect.stringContaining('allowed remote sources'),
    });
  });

  it('forwards a command to the window that holds the Burrow', async () => {
    const squat = await otherWindowHoldsTheBurrow();
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    mod.initBurrow(fakeContext().context);

    // Nothing has contended yet, so there is no Burrow here and no socket to
    // reach one through. `status` is answered as an idle service would rather
    // than refused: this window sees no enrollment, which is what "not enrolled"
    // *is*, and an error there tells `enrolled-gate.ts` nothing it can act on.
    // The offer is read from the disk of this same process, so the one-click
    // card renders on exactly the machines it is for — un-enrolled ones.
    offer = OFFER;
    mod.handleBurrowCommand({ burrowRequestId: 'rh-1', cmd: 'status' });
    await waitFor(() => results(bound.posted).length > 0);
    expect(results(bound.posted)).toEqual([
      {
        burrowRequestId: 'rh-1',
        result: {
          enrolled: false,
          relayUrl: null,
          burrowId: null,
          connection: 'stopped',
          pairedClients: 0,
          suggestedLabel: `${hostname()} (VS Code)`,
          offer: { origin: OFFER.origin },
        },
      },
    ]);
    // A service→webview shape: the one-time token is not in it (docs/specs/security-remote.md -> "Trust boundary").
    expect(JSON.stringify(bound.posted)).not.toContain(OFFER.token);

    // `enroll` bootstraps the contention, which this window loses — so even the
    // bootstrap ends up forwarded rather than starting a second Burrow.
    const params = { relayUrl: 'https://relay.dormouse.sh', password: 'p', label: 'Laptop' };
    mod.handleBurrowCommand({ burrowRequestId: 'rh-2', cmd: 'enroll', params });

    await waitFor(() => squat.frames.some((frame) => frame.kind === 'command'));
    expect(squat.frames.find((frame) => frame.kind === 'command')).toEqual({
      kind: 'command',
      payload: { burrowRequestId: 'rh-2', cmd: 'enroll', params },
    });
    expect(opened!.isPeerBroker()).toBe(false);
    // The broker answers it; this window must not answer it too.
    expect(results(bound.posted)).toHaveLength(1);
  });

  it('hands the broker\'s answers and events to its own webviews', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());

    mod.deliverCommandResult({ burrowRequestId: 'rh-1', result: { enrolled: true } });
    mod.deliverUiEvent({ name: 'pairing-queue', queue: [] });

    // Broadcast, like a local result: only the adapter that minted the `burrowRequestId`
    // holds a pending command for it, and any webview may show the modal.
    expect(bound.posted).toEqual([
      { type: 'burrow:result', payload: { burrowRequestId: 'rh-1', result: { enrolled: true } } },
      { type: 'burrow:event', payload: { name: 'pairing-queue', queue: [] } },
    ]);
  });

  it('ignores a malformed command rather than answering one', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    mod.handleBurrowCommand(undefined);
    mod.handleBurrowCommand({ burrowRequestId: 'rh-1' } as never);
    expect(bound.posted).toEqual([]);
  });

  it('holds a command that arrives while the contention is still settling', async () => {
    // An enrolled machine contends at activation, and that takes a bind and a
    // handshake. Refusing in that window tells the webview it has no Burrow
    // seconds before it gets one, and the gates that arm on that answer stay
    // down until the whole window reloads.
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    const { context, store } = fakeContext();
    // Outside this build's allowed sources, so the service starts and idles
    // rather than opening a real relay socket.
    store.secrets.set(
      ENROLLMENT_KEY,
      JSON.stringify({
        relayUrl: 'https://relay.example.com',
        burrowId: BURROW_ID,
        burrowToken: 'token',
        origin: 'https://relay.example.com',
        rpId: 'relay.example.com',
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mod.initBurrow(context);
    // Enough microtasks for the enrollment probe to land and the contention to
    // start, and far too few for any of its filesystem work to finish.
    for (let i = 0; i < 8; i++) await Promise.resolve();

    mod.handleBurrowCommand({ burrowRequestId: 'rh-1', cmd: 'status' });
    expect(results(bound.posted)).toEqual([]);

    await waitFor(() => results(bound.posted).length > 0);
    // Answered by the Burrow this window went on to run, not refused.
    expect(results(bound.posted)[0]).toMatchObject({ burrowRequestId: 'rh-1' });
    expect(results(bound.posted)[0]!.error).toBeUndefined();
    expect(opened!.isPeerBroker()).toBe(true);
    warn.mockRestore();
  });

  it('refuses at once when the contention can never settle', async () => {
    // Deactivation, or a window with no storage location: `ensurePeerNet`
    // returns without a role and no settle notification is coming. A held
    // command would sit out its whole queue budget before anyone told the
    // webview there is nothing to reach.
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    mod.initBurrow(fakeContext().context);
    await opened!.disposePeerLink();

    mod.handleBurrowCommand({
      burrowRequestId: 'rh-1',
      cmd: 'enroll',
      params: { relayUrl: 'https://relay.dormouse.sh', password: 'p', label: 'Laptop' },
    });

    await tick(0);
    expect(results(bound.posted)).toEqual([{ burrowRequestId: 'rh-1', error: 'no Burrow is reachable' }]);
  });

  it('answers the read-only commands like an idle service when there is no Burrow at all', async () => {
    // A window that never enrolled is the ordinary state, not a failure — it
    // contends the moment an enrollment exists anywhere, so reaching the
    // refusal means there genuinely is none. Erroring there broke each
    // caller's contract: `pushDevices` answers `null` for "nowhere to push"
    // and rejects only when the Relay could not be asked, so the Settings
    // dialog was reporting an unreachable Relay on an un-enrolled machine.
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    mod.initBurrow(fakeContext().context);
    await tick();

    // Including the offer, which both sides read from the same file.
    offer = OFFER;
    mod.handleBurrowCommand({ burrowRequestId: 'rh-status', cmd: 'status' });
    mod.handleBurrowCommand({ burrowRequestId: 'rh-pushDevices', cmd: 'pushDevices' });
    mod.handleBurrowCommand({ burrowRequestId: 'rh-pairingQueue', cmd: 'pairingQueue' });
    // Everything else still says there is nothing to reach.
    mod.handleBurrowCommand({ burrowRequestId: 'rh-clear', cmd: 'clearEnrollment' });
    expect(results(bound.posted).find((r) => r.burrowRequestId === 'rh-clear')).toEqual({
      burrowRequestId: 'rh-clear',
      error: 'no Burrow is reachable',
    });

    // And they are exactly what a real service with nothing in its store says,
    // which is the answer the sidecar's webviews get for the same commands.
    const { BurrowService } = await import('../../lib/src/host/remote/service');
    const { createEphemeralBurrowStateStore } = await import(
      '../../lib/src/host/remote/burrow-state-store'
    );
    const sent: Array<{ event: string; data: { burrowRequestId: string; result?: unknown } }> = [];
    const idle = new BurrowService({
      store: createEphemeralBurrowStateStore(() => {}),
      provider: {
        collectDirectory: async () => [],
        watchDirectory: () => () => {},
        resolveSurface: async () => null,
        writePty: () => {},
        resizePty: () => {},
        streamPty: () => () => {},
      },
      appName: 'VS Code',
      sendToUi: (event, data) => void sent.push({ event, data: data as never }),
      connectSrc: 'https://*.dormouse.sh wss://*.dormouse.sh',
    });
    await idle.start();
    for (const cmd of ['status', 'pushDevices', 'pairingQueue']) {
      await idle.handleCommand({ burrowRequestId: `rh-${cmd}`, cmd });
    }
    idle.dispose();
    // The glue's `status` is the one idle answer that reads a file, so it
    // settles a tick later than the two that do not.
    await waitFor(() => results(bound.posted).length === 4);

    const byId = (entries: Array<{ burrowRequestId: string; result?: unknown }>) =>
      Object.fromEntries(
        entries.filter((entry) => entry.burrowRequestId !== 'rh-clear').map((entry) => [entry.burrowRequestId, entry.result]),
      );
    expect(byId(results(bound.posted))).toEqual(
      byId(sent.filter((message) => message.event === 'burrow:result').map((m) => m.data)),
    );
  });

  it('contends when another window enrolls, without a reload', async () => {
    // This window was un-enrolled at activation, so it never contended and has
    // no socket and no broker to hear from. The shared `SecretStorage` is the
    // only signal it gets that a Burrow now exists.
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    const { context, store } = fakeContext();
    mod.initBurrow(context);
    await tick();
    expect(opened!.isPeerBroker()).toBe(false);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.secrets.set(
      ENROLLMENT_KEY,
      JSON.stringify({
        relayUrl: 'https://relay.example.com',
        burrowId: BURROW_ID,
        burrowToken: 'token',
        origin: 'https://relay.example.com',
        rpId: 'relay.example.com',
      }),
    );
    store.announce(ENROLLMENT_KEY);

    await waitFor(() => opened!.isPeerBroker());
    warn.mockRestore();
  });
});

describe('the relay socket', () => {
  /** A `ws` server that greets, echoes one frame, and closes with a code. */
  async function wsServer() {
    const { WebSocketServer } = await import('ws');
    const server = new WebSocketServer({ burrow: '127.0.0.1', port: 0 });
    await new Promise((resolve) => server.on('listening', resolve));
    server.on('connection', (socket) => {
      socket.send('hello from the relay');
      socket.on('message', () => socket.close(4001, 'done'));
    });
    const { port } = server.address() as { port: number };
    return { url: `ws://127.0.0.1:${port}`, close: () => server.close() };
  }

  it('uses the bundled ws where the extension host has no global WebSocket', async () => {
    // `globalThis.WebSocket` arrived in Node 22, and `engines.vscode` is
    // `^1.85.0` — VS Code 1.85 shipped Node 18, so the supported range spans
    // the boundary and the fallback is the only implementation on the old side.
    const mod = await freshBurrow();
    const relay = await wsServer();
    vi.stubGlobal('WebSocket', undefined);
    try {
      const socket = mod.createRelaySocket(relay.url);
      const received: string[] = [];
      const closes: number[] = [];
      // Exactly the surface `BurrowRuntime` reads, and nothing more.
      socket.addEventListener('message', (ev) => {
        received.push(String((ev as { data?: unknown }).data));
      });
      socket.addEventListener('close', (ev) => {
        closes.push(Number((ev as { code?: unknown }).code));
      });
      await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
      expect(socket.readyState).toBe(1);

      await waitFor(() => received.length > 0);
      expect(received).toEqual(['hello from the relay']);

      socket.send(JSON.stringify({ t: 'hello' }));
      await waitFor(() => closes.length > 0);
      expect(closes).toEqual([4001]);
    } finally {
      relay.close();
    }
  });

  it('prefers whatever the extension host already provides', async () => {
    const mod = await freshBurrow();
    const built: string[] = [];
    class PlatformSocket {
      constructor(url: string) {
        built.push(url);
      }
    }
    vi.stubGlobal('WebSocket', PlatformSocket);
    expect(mod.createRelaySocket('wss://relay.dormouse.sh/ws/burrow')).toBeInstanceOf(PlatformSocket);
    expect(built).toEqual(['wss://relay.dormouse.sh/ws/burrow']);
  });
});

describe('burrow provider', () => {
  it('streams a PTY without stripping it again', async () => {
    // The extension host already ran the protocol parser once per chunk and
    // answered its queries; a second parser here would answer everything twice
    // and corrupt the PTY. What arrives is what the local xterm renders.
    const mod = await freshBurrow();
    const bound = fakeDeps();
    const provider = mod.createBurrowProvider(bound.deps());
    const seen: ProcessedPtyChunk[] = [];
    const exits: number[] = [];
    const stream = provider.streamPty('pty-1', {
      onData: (chunk) => void seen.push(chunk),
      onExit: (code) => void exits.push(code),
    });
    await stream.ready;

    bound.emitData('pty-1', 'hello\x1b]0;title\x07', 'hello');
    bound.emitData('pty-other', 'not mine');
    bound.emitExit('pty-other', 3);
    bound.emitExit('pty-1', 7);

    // Both projections reach the provider: the parser computed them once, and
    // the Client needs the same pair the local xterm's consumers get.
    expect(seen).toEqual([{ data: 'hello\x1b]0;title\x07', textData: 'hello' }]);
    expect(exits).toEqual([7]);

    stream.stop();
    bound.emitData('pty-1', 'after');
    expect(seen).toHaveLength(1);
  });

  it('replays a local PTY exit that preceded provider subscription', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    const provider = mod.createBurrowProvider(bound.deps());
    bound.emitExit('pty-1', 23);

    const sink = fakeSink();
    const stream = provider.streamPty('pty-1', sink);
    await stream.ready;

    expect(sink.exits).toEqual([23]);
    stream.stop();
  });

  it('asks the webviews for the directory and for an attach', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    bound.answers.set('directory', [{ surfaceId: 'surface-1' }]);
    bound.answers.set('surfaceOp', [{ ptyId: 'pty-1', cols: 100, rows: 30 }]);
    const provider = mod.createBurrowProvider(bound.deps());

    expect(await provider.collectDirectory()).toEqual([{ surfaceId: 'surface-1' }]);

    const handle = await provider.resolveSurface('surface-1', { cols: 100, rows: 30 });
    expect(handle).toMatchObject({ ptyId: 'pty-1', cols: 100, rows: 30 });
    // Attach-is-the-resize: the size rides the attach, because the owner is the
    // only one that can reach its xterm.
    expect(bound.asked.at(-1)).toEqual({
      op: 'surfaceOp',
      params: { surfaceId: 'surface-1', op: 'attach', cols: 100, rows: 30 },
    });
  });

  it('reports no surface when nobody answers', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    const provider = mod.createBurrowProvider(bound.deps());
    expect(await provider.resolveSurface('nobody', {})).toBeNull();
  });

  it('leaves the last known size standing when a resize goes unanswered', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    bound.answers.set('surfaceOp', [{ ptyId: 'pty-1', cols: 100, rows: 30 }]);
    const provider = mod.createBurrowProvider(bound.deps());
    const handle = (await provider.resolveSurface('surface-1', { cols: 100, rows: 30 }))!;

    bound.answers.set('surfaceOp', []);
    expect(await handle.resize(120, 40)).toEqual({ cols: 100, rows: 30 });
    expect(handle.cols).toBe(100);
  });

  it('drives a PTY of its own through the pty manager', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    const drove: unknown[] = [];
    const provider = mod.createBurrowProvider({
      ...bound.deps(),
      writePty: (id, data) => void drove.push({ id, data }),
      resizePty: (id, cols, rows) => void drove.push({ id, cols, rows }),
    });

    // The link only claims a PTY an attach routed to another window, so a local
    // one can never be taken from under the manager that owns it.
    provider.writePty('pty-1', 'ls\r');
    provider.resizePty('pty-1', 120, 40);
    expect(drove).toEqual([
      { id: 'pty-1', data: 'ls\r' },
      { id: 'pty-1', cols: 120, rows: 40 },
    ]);
  });

  it('fires every directory watcher on an invalidation, and stops after unsubscribe', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    const provider = mod.createBurrowProvider(bound.deps());
    let fired = 0;
    const stop = provider.watchDirectory(() => {
      fired += 1;
    });

    mod.notifyDirectoryChanged();
    expect(fired).toBe(1);

    stop();
    mod.notifyDirectoryChanged();
    expect(fired).toBe(1);
  });
});

/**
 * The second tier, over a real socket: this module as the broker window and a
 * link-only stand-in as the window whose terminals it is serving.
 */
describe('serving the other windows', () => {
  /** Bind the socket, wire the link as the router does, and let a peer join. */
  async function brokerWith(far: ReturnType<typeof fakeWindow>) {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    bridgeLinkToBurrow(mod, opened!, bound);
    await opened!.ensurePeerNet(() => {});
    const link = await openFarWindow(far);
    return { mod, bound, link };
  }

  it('serves a directory of every window, this one first', async () => {
    const far = fakeWindow({ entries: [{ surfaceId: 'far-1' }] });
    const { mod, bound } = await brokerWith(far);
    bound.answers.set('directory', [{ surfaceId: 'near-1' }]);
    const provider = mod.createBurrowProvider(bound.deps());

    // Both tiers at once: whatever the phone is asking about lives in exactly
    // one webview of one window, so a serial ask would spend the near tier's
    // whole budget before the owner is reached.
    await waitFor(async () => (await provider.collectDirectory()).length === 2);
    expect(await provider.collectDirectory()).toEqual([
      { surfaceId: 'near-1' },
      { surfaceId: 'far-1' },
    ]);
  });

  it('attaches, streams, and drives a terminal that lives in another window', async () => {
    const far = fakeWindow({
      entries: [{ surfaceId: 'far-1' }],
      surfaces: { 'far-1': { ptyId: 'pty-far', cols: 80, rows: 24 } },
    });
    const { mod, bound } = await brokerWith(far);
    const provider = mod.createBurrowProvider(bound.deps());

    // The attach is what teaches the link where that PTY lives; everything
    // after it is routed by that.
    let handle: Awaited<ReturnType<typeof provider.resolveSurface>> = null;
    await waitFor(async () => {
      handle = await provider.resolveSurface('far-1', { cols: 80, rows: 24 });
      return handle !== null;
    });

    const sink = fakeSink();
    const stream = provider.streamPty(handle!.ptyId, sink);
    await stream.ready;
    far.emitData('pty-far', 'from the other window');
    await waitFor(() => sink.data.length > 0);

    provider.writePty(handle!.ptyId, 'ls\r');
    provider.resizePty(handle!.ptyId, 120, 40);
    await waitFor(() => far.writes.length > 0 && far.resizes.length > 0);
    expect(far.writes).toEqual([{ ptyId: 'pty-far', data: 'ls\r' }]);
    expect(far.resizes).toEqual([{ ptyId: 'pty-far', cols: 120, rows: 40 }]);

    stream.stop();
    await tick();
    far.emitData('pty-far', 'after the unsubscribe');
    await tick(100);
    expect(sink.data).toEqual(['from the other window']);
  });

  it('binds a duplicate restored PTY id to the peer whose surface answer was selected', async () => {
    let firstSurfaceOps = 0;
    let secondSurfaceOps = 0;
    const restoredSurface = { ptyId: 'restored-pty', cols: 80, rows: 24 };
    const first = fakeWindow({
      entries: [{ surfaceId: 'restored-surface' }],
      surfaces: new Proxy(
        { 'restored-surface': restoredSurface },
        {
          get: (target, property, receiver) => {
            if (property === 'restored-surface') firstSurfaceOps += 1;
            return Reflect.get(target, property, receiver) as typeof restoredSurface;
          },
        },
      ),
    });
    const second = fakeWindow({
      entries: [{ surfaceId: 'restored-surface' }],
      surfaces: new Proxy(
        { 'restored-surface': restoredSurface },
        {
          get: (target, property, receiver) => {
            if (property === 'restored-surface') secondSurfaceOps += 1;
            return Reflect.get(target, property, receiver) as typeof restoredSurface;
          },
        },
      ),
    });
    const { mod, bound } = await brokerWith(first);
    await openFarWindow(second);
    const localFallbacks: unknown[] = [];
    const providerDeps = bound.deps();
    providerDeps.writePty = (ptyId, data) => void localFallbacks.push({ ptyId, data });
    providerDeps.resizePty = (ptyId, cols, rows) =>
      void localFallbacks.push({ ptyId, cols, rows });
    const provider = mod.createBurrowProvider(providerDeps);

    const handle = await provider.resolveSurface('restored-surface', { cols: 80, rows: 24 });
    expect(handle).not.toBeNull();
    // The key held by SurfaceHandle is provider-local, not the colliding id
    // understood inside either peer window.
    expect(handle!.ptyId).not.toBe('restored-pty');

    // The read-only resolve reaches both duplicate claimants; the mutating
    // attach and every follow-up address only the retained first peer.
    expect([firstSurfaceOps, secondSurfaceOps]).toEqual([2, 1]);
    await handle!.resize(100, 30);
    expect([firstSurfaceOps, secondSurfaceOps]).toEqual([3, 1]);

    const sink = fakeSink();
    const stream = provider.streamPty(handle!.ptyId, sink);
    await stream.ready;
    first.emitData('restored-pty', 'selected peer');
    second.emitData('restored-pty', 'other peer');
    await waitFor(() => sink.data.length > 0);
    expect(sink.data).toEqual(['selected peer']);

    provider.writePty(handle!.ptyId, 'pwd\r');
    await waitFor(() => first.writes.length > 0);
    expect(first.writes).toEqual([{ ptyId: 'restored-pty', data: 'pwd\r' }]);
    expect(second.writes).toEqual([]);

    first.emitExit('restored-pty', 17);
    await waitFor(() => sink.exits.length > 0);
    provider.writePty(handle!.ptyId, 'after exit');
    provider.resizePty(handle!.ptyId, 120, 40);
    expect(localFallbacks).toEqual([]);
    stream.stop();
  });

  it('tells a joining window whether there is a Burrow, without waiting for a change', async () => {
    // `status` events are emitted when the Burrow's lifecycle changes, and a
    // window connecting changes nothing — so a window opened after the
    // enrollment would sit disarmed until the user reloaded it.
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    bridgeLinkToBurrow(mod, opened!, bound);
    mod.initBurrow(fakeContext().context);
    mod.handleBurrowCommand({
      burrowRequestId: 'rh-0',
      cmd: 'enroll',
      params: { relayUrl: 'https://evil.example', password: 'p', label: 'Laptop' },
    });
    await waitFor(() => opened!.isPeerBroker());

    const far = fakeWindow();
    await openFarWindow(far);

    await waitFor(() => far.uiEvents.length > 0);
    // Addressed to the window that joined, and nothing else is invented for it.
    expect(far.uiEvents).toEqual([{ name: 'status', enrolled: false }]);
  });

  it('answers a forwarded command over the link and nowhere else', async () => {
    const mod = await freshBurrow();
    const bound = fakeDeps();
    mod.configureBurrow(bound.deps());
    bridgeLinkToBurrow(mod, opened!, bound);
    mod.initBurrow(fakeContext().context);
    // The enroll bootstrap is the shortest way to a bound socket with a running
    // service; the origin is refused, which does not stop it running.
    mod.handleBurrowCommand({
      burrowRequestId: 'rh-0',
      cmd: 'enroll',
      params: { relayUrl: 'https://evil.example', password: 'p', label: 'Laptop' },
    });
    await waitFor(() => opened!.isPeerBroker());

    const far = fakeWindow();
    const link = await openFarWindow(far);
    expect(link.forwardCommand({ burrowRequestId: 'rh-9', cmd: 'status' })).toBe(true);

    await waitFor(() => far.results.length > 0);
    expect(far.results[0]).toMatchObject({ burrowRequestId: 'rh-9', result: { enrolled: false } });
    // Not broadcast here as well: an `burrowRequestId` belongs to one window's adapter, so
    // a copy would settle nothing and would show that window's Burrow state to
    // webviews that never asked.
    expect(results(bound.posted).some((result) => result.burrowRequestId === 'rh-9')).toBe(false);
  });
});
