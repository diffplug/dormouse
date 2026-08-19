/**
 * The extension host's binding of the Host service: where its enrollment and
 * ACL live, which window is allowed to run it, and the provider it serves
 * remote-api v1 through. The service itself is covered in
 * `lib/src/host/remote/service.test.ts`; this is the glue that only exists here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { FrameDecoder } from '../../lib/src/lib/vscode-peer-link-protocol';
import type { ExtensionMessage } from '../src/message-types';
import {
  fakeSink,
  fakeWindow,
  freshModule,
  removeDir,
  tempStorageDir,
  tick,
  waitFor,
} from './helpers';

type HostModule = typeof import('../src/remote-host');
type LinkModule = typeof import('../src/peer-link');

let dir: string;
let realTmp: string | undefined;
/** Every link this test opened; the last one belongs to the module under test. */
const links: LinkModule[] = [];
let opened: LinkModule | null = null;
let squatter: Server | null = null;
const squatted: Socket[] = [];

/** Mirrors `socketPath()` — see the note in peer-link.test.ts. */
function derivedSocketPath(): string {
  const id = createHash('sha256').update(dir).digest('hex').slice(0, 12);
  return join(dir, `dormouse-peer-${id}.sock`);
}

/** The slice of `ExtensionContext` the store reads, in memory. */
function fakeContext() {
  const secrets = new Map<string, string>();
  const global = new Map<string, string>();
  return {
    store: { secrets, global },
    context: {
      globalStorageUri: { fsPath: dir },
      subscriptions: [] as unknown[],
      secrets: {
        get: async (key: string) => secrets.get(key),
        store: async (key: string, value: string) => void secrets.set(key, value),
        delete: async (key: string) => void secrets.delete(key),
      },
      globalState: {
        get: (key: string) => global.get(key),
        update: async (key: string, value: unknown) => {
          if (value === undefined) global.delete(key);
          else global.set(key, value as string);
        },
        keys: () => [...global.keys()],
      },
    } as never,
  };
}

function fakeDeps() {
  const posted: ExtensionMessage[] = [];
  const asked: Array<{ op: string; params: unknown }> = [];
  const dataListeners = new Set<(id: string, data: string) => void>();
  const exitListeners = new Set<(id: string, exitCode: number) => void>();
  return {
    posted,
    asked,
    emitData: (id: string, data: string) => {
      for (const listener of dataListeners) listener(id, data);
    },
    emitExit: (id: string, exitCode: number) => {
      for (const listener of exitListeners) listener(id, exitCode);
    },
    answers: new Map<string, unknown[]>(),
    deps(): Parameters<HostModule['configureRemoteHost']>[0] {
      return {
        brokerRequest: async (op, params) => {
          asked.push({ op, params });
          return this.answers.get(op) ?? [];
        },
        broadcastToWebviews: (message) => void posted.push(message),
        writePty: () => {},
        resizePty: () => {},
        onProcessedPtyData: (listener) => {
          dataListeners.add(listener);
          return () => dataListeners.delete(listener);
        },
        onProcessedPtyExit: (listener) => {
          exitListeners.add(listener);
          return () => exitListeners.delete(listener);
        },
      };
    },
  };
}

/** A fresh copy of the module pair, so one process can play several windows. */
async function freshHost() {
  vi.resetModules();
  const mod = (await import('../src/remote-host')) as HostModule;
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
function bridgeLinkToHost(
  mod: HostModule,
  link: LinkModule,
  bound: ReturnType<typeof fakeDeps>,
): void {
  const local = bound.deps();
  link.configurePeerLink({
    brokerRequest: local.brokerRequest,
    invalidateDirectory: mod.notifyDirectoryChanged,
    onProcessedPtyData: local.onProcessedPtyData,
    onProcessedPtyExit: local.onProcessedPtyExit,
    writePty: local.writePty,
    resizePty: local.resizePty,
    handleForwardedCommand: mod.handleForwardedCommand,
    dropForwardedCommands: mod.dropForwardedCommands,
    deliverCommandResult: mod.deliverCommandResult,
    deliverUiEvent: mod.deliverUiEvent,
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

/** Occupy the socket, so the module under test can only ever be a client. */
async function otherWindowHoldsTheHost(): Promise<{ frames: Array<{ kind: string }> }> {
  const frames: Array<{ kind: string }> = [];
  // Sockets are kept so cleanup can drop them: `close()` waits for every live
  // connection, and this stand-in has no lifecycle of its own to end them.
  const server = createServer((socket) => {
    squatted.push(socket);
    const decoder = new FrameDecoder();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const frame of decoder.push(chunk)) frames.push(frame as { kind: string });
    });
  });
  await new Promise<void>((resolve) => server.listen(derivedSocketPath(), resolve));
  squatter = server;
  return { frames };
}

function results(posted: ExtensionMessage[]) {
  return posted
    .filter((message) => message.type === 'remoteHost:result')
    .map((message) => (message as { payload: { rhId: string; error?: string } }).payload);
}

beforeEach(async () => {
  dir = await tempStorageDir();
  realTmp = process.env.TMPDIR;
  process.env.TMPDIR = dir;
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
  await removeDir(dir);
});

describe('host state store', () => {
  it('round-trips the enrollment through SecretStorage', async () => {
    const { VsCodeHostStateStore } = await import('../src/remote-host-store');
    const { context, store } = fakeContext();
    const target = new VsCodeHostStateStore(context);
    const enrollment = {
      serverUrl: 'https://relay.dormouse.sh',
      hostId: 'host-1',
      hostToken: 'token',
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

  it('reads an enrollment the webview-resident Host left behind', async () => {
    // The legacy path wrote the same JSON string under the same key through
    // `store:write`, so an already-enrolled installation needs no migration.
    const { VsCodeHostStateStore } = await import('../src/remote-host-store');
    const { context, store } = fakeContext();
    const enrollment = {
      serverUrl: 'https://relay.dormouse.sh',
      hostId: 'host-1',
      hostToken: 'token',
      origin: 'https://relay.dormouse.sh',
      rpId: 'relay.dormouse.sh',
    };
    store.secrets.set('dormouse.remote-host.enrollment', JSON.stringify(enrollment));
    store.global.set(
      'dormouse.remote-host.acl.host-1',
      JSON.stringify([{ hostId: 'host-1', devicePublicKey: 'device-1' }]),
    );

    const target = new VsCodeHostStateStore(context);
    expect(await target.loadEnrollment()).toEqual(enrollment);
    expect(await target.loadAcl('host-1')).toEqual([
      { hostId: 'host-1', devicePublicKey: 'device-1' },
    ]);
  });

  it('drops records that name a different host, and unreadable values', async () => {
    const { VsCodeHostStateStore } = await import('../src/remote-host-store');
    const { context, store } = fakeContext();
    const target = new VsCodeHostStateStore(context);

    await target.saveAcl('host-1', [{ hostId: 'host-2' } as never, { hostId: 'host-1' } as never]);
    expect(await target.loadAcl('host-1')).toEqual([{ hostId: 'host-1' }]);

    store.secrets.set('dormouse.remote-host.enrollment', 'not json');
    expect(await target.loadEnrollment()).toBeNull();
    store.global.set('dormouse.remote-host.acl.host-9', 'not json');
    expect(await target.loadAcl('host-9')).toEqual([]);
  });
});

describe('remote host service glue', () => {
  it('bootstraps the contention on the first enroll, then runs the command', async () => {
    const mod = await freshHost();
    const bound = fakeDeps();
    mod.configureRemoteHost(bound.deps());
    // No enrollment yet, so activation binds nothing.
    mod.initRemoteHost(fakeContext().context);
    expect(opened!.isPeerBroker()).toBe(false);

    mod.handleRemoteHostCommand({
      rhId: 'rh-1',
      cmd: 'enroll',
      params: { serverUrl: 'https://evil.example', password: 'p', label: 'Laptop' },
    });

    await waitFor(() => results(bound.posted).length > 0);
    // The service ran it (and refused the origin), rather than the interim
    // "another window" answer — which is what proves this window took the Host.
    expect(opened!.isPeerBroker()).toBe(true);
    expect(results(bound.posted)[0]).toMatchObject({
      rhId: 'rh-1',
      error: expect.stringContaining('allowed remote sources'),
    });
  });

  it('forwards a command to the window that holds the Host', async () => {
    const squat = await otherWindowHoldsTheHost();
    const mod = await freshHost();
    const bound = fakeDeps();
    mod.configureRemoteHost(bound.deps());
    mod.initRemoteHost(fakeContext().context);

    // Nothing has contended yet, so there is no Host here and no socket to
    // reach one through. Refusing beats a silent drop: the console hook would
    // otherwise hang for its whole timeout.
    mod.handleRemoteHostCommand({ rhId: 'rh-1', cmd: 'status' });
    expect(results(bound.posted)).toEqual([
      { rhId: 'rh-1', error: 'no remote Host is reachable' },
    ]);

    // `enroll` bootstraps the contention, which this window loses — so even the
    // bootstrap ends up forwarded rather than starting a second Host.
    const params = { serverUrl: 'https://relay.dormouse.sh', password: 'p', label: 'Laptop' };
    mod.handleRemoteHostCommand({ rhId: 'rh-2', cmd: 'enroll', params });

    await waitFor(() => squat.frames.some((frame) => frame.kind === 'command'));
    expect(squat.frames.find((frame) => frame.kind === 'command')).toEqual({
      kind: 'command',
      payload: { rhId: 'rh-2', cmd: 'enroll', params },
    });
    expect(opened!.isPeerBroker()).toBe(false);
    // The broker answers it; this window must not answer it too.
    expect(results(bound.posted)).toHaveLength(1);
  });

  it('hands the broker\'s answers and events to its own webviews', async () => {
    const mod = await freshHost();
    const bound = fakeDeps();
    mod.configureRemoteHost(bound.deps());

    mod.deliverCommandResult({ rhId: 'rh-1', result: { enrolled: true } });
    mod.deliverUiEvent({ name: 'pairing-queue', queue: [] });

    // Broadcast, like a local result: only the adapter that minted the `rhId`
    // holds a pending command for it, and any webview may show the modal.
    expect(bound.posted).toEqual([
      { type: 'remoteHost:result', payload: { rhId: 'rh-1', result: { enrolled: true } } },
      { type: 'remoteHost:event', payload: { name: 'pairing-queue', queue: [] } },
    ]);
  });

  it('ignores a malformed command rather than answering one', async () => {
    const mod = await freshHost();
    const bound = fakeDeps();
    mod.configureRemoteHost(bound.deps());
    mod.handleRemoteHostCommand(undefined);
    mod.handleRemoteHostCommand({ rhId: 'rh-1' } as never);
    expect(bound.posted).toEqual([]);
  });
});

describe('remote host provider', () => {
  it('streams a PTY without stripping it again', async () => {
    // The extension host already ran the protocol parser once per chunk and
    // answered its queries; a second parser here would answer everything twice
    // and corrupt the PTY. What arrives is what the local xterm renders.
    const mod = await freshHost();
    const bound = fakeDeps();
    const provider = mod.createRemoteHostProvider(bound.deps());
    const seen: string[] = [];
    const exits: number[] = [];
    const stop = provider.streamPty('pty-1', {
      onData: (data) => void seen.push(data),
      onExit: (code) => void exits.push(code),
    });

    bound.emitData('pty-1', 'hello\x1b]0;title\x07');
    bound.emitData('pty-other', 'not mine');
    bound.emitExit('pty-other', 3);
    bound.emitExit('pty-1', 7);

    expect(seen).toEqual(['hello\x1b]0;title\x07']);
    expect(exits).toEqual([7]);

    stop();
    bound.emitData('pty-1', 'after');
    expect(seen).toHaveLength(1);
  });

  it('asks the webviews for the directory and for an attach', async () => {
    const mod = await freshHost();
    const bound = fakeDeps();
    bound.answers.set('directory', [{ surfaceId: 'surface-1' }]);
    bound.answers.set('surfaceOp', [{ ptyId: 'pty-1', cols: 100, rows: 30 }]);
    const provider = mod.createRemoteHostProvider(bound.deps());

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
    const mod = await freshHost();
    const bound = fakeDeps();
    const provider = mod.createRemoteHostProvider(bound.deps());
    expect(await provider.resolveSurface('nobody', {})).toBeNull();
  });

  it('leaves the last known size standing when a resize goes unanswered', async () => {
    const mod = await freshHost();
    const bound = fakeDeps();
    bound.answers.set('surfaceOp', [{ ptyId: 'pty-1', cols: 100, rows: 30 }]);
    const provider = mod.createRemoteHostProvider(bound.deps());
    const handle = (await provider.resolveSurface('surface-1', { cols: 100, rows: 30 }))!;

    bound.answers.set('surfaceOp', []);
    expect(await handle.resize(120, 40)).toEqual({ cols: 100, rows: 30 });
    expect(handle.cols).toBe(100);
  });

  it('drives a PTY of its own through the pty manager', async () => {
    const mod = await freshHost();
    const bound = fakeDeps();
    const drove: unknown[] = [];
    const provider = mod.createRemoteHostProvider({
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
    const mod = await freshHost();
    const bound = fakeDeps();
    const provider = mod.createRemoteHostProvider(bound.deps());
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
    const mod = await freshHost();
    const bound = fakeDeps();
    mod.configureRemoteHost(bound.deps());
    bridgeLinkToHost(mod, opened!, bound);
    await opened!.ensurePeerNet(() => {});
    const link = await openFarWindow(far);
    return { mod, bound, link };
  }

  it('serves a directory of every window, this one first', async () => {
    const far = fakeWindow({ entries: [{ surfaceId: 'far-1' }] });
    const { mod, bound } = await brokerWith(far);
    bound.answers.set('directory', [{ surfaceId: 'near-1' }]);
    const provider = mod.createRemoteHostProvider(bound.deps());

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
    const provider = mod.createRemoteHostProvider(bound.deps());

    // The attach is what teaches the link where that PTY lives; everything
    // after it is routed by that.
    await waitFor(async () => !!(await provider.resolveSurface('far-1', { cols: 80, rows: 24 })));

    const sink = fakeSink();
    const stop = provider.streamPty('pty-far', sink);
    await tick();
    far.emitData('pty-far', 'from the other window');
    await waitFor(() => sink.data.length > 0);

    provider.writePty('pty-far', 'ls\r');
    provider.resizePty('pty-far', 120, 40);
    await waitFor(() => far.writes.length > 0 && far.resizes.length > 0);
    expect(far.writes).toEqual([{ ptyId: 'pty-far', data: 'ls\r' }]);
    expect(far.resizes).toEqual([{ ptyId: 'pty-far', cols: 120, rows: 40 }]);

    stop();
    await tick();
    far.emitData('pty-far', 'after the unsubscribe');
    await tick(100);
    expect(sink.data).toEqual(['from the other window']);
  });

  it('answers a forwarded command over the link and nowhere else', async () => {
    const mod = await freshHost();
    const bound = fakeDeps();
    mod.configureRemoteHost(bound.deps());
    bridgeLinkToHost(mod, opened!, bound);
    mod.initRemoteHost(fakeContext().context);
    // The enroll bootstrap is the shortest way to a bound socket with a running
    // service; the origin is refused, which does not stop it running.
    mod.handleRemoteHostCommand({
      rhId: 'rh-0',
      cmd: 'enroll',
      params: { serverUrl: 'https://evil.example', password: 'p', label: 'Laptop' },
    });
    await waitFor(() => opened!.isPeerBroker());

    const far = fakeWindow();
    const link = await openFarWindow(far);
    expect(link.forwardCommand({ rhId: 'rh-9', cmd: 'status' })).toBe(true);

    await waitFor(() => far.results.length > 0);
    expect(far.results[0]).toMatchObject({ rhId: 'rh-9', result: { enrolled: false } });
    // Not broadcast here as well: an `rhId` belongs to one window's adapter, so
    // a copy would settle nothing and would show that window's Host state to
    // webviews that never asked.
    expect(results(bound.posted).some((result) => result.rhId === 'rh-9')).toBe(false);
  });
});
