/**
 * Shared scaffolding for the extension-host suites. Both of them need a
 * throwaway `globalStorageUri`, a poll-with-deadline, and a way to make one
 * process behave like two VS Code windows.
 */

import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  RemoteHostCommand,
  RemoteHostResult,
} from '../../lib/src/host/remote/service-protocol';
import type { PeerLinkClient, PeerLinkDeps } from '../src/peer-link';
import { createProcessedPtyStreams } from '../src/processed-pty-streams';

export async function tempStorageDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dormouse-ext-'));
}

/**
 * The one path every window of an installation contends for, mirroring
 * `socketPath()` and `peerDirPath()`. Duplicated on purpose: a derivation that
 * drifted would silently give each window its own lease and its own Host, and
 * the per-user directory is the layer that keeps another OS user from creating
 * the path first.
 */
export function derivedSocketPath(storageDir: string): string {
  const id = createHash('sha256').update(storageDir).digest('hex').slice(0, 12);
  return join(tmpdir(), `dormouse-peer-${process.getuid?.() ?? 0}`, `${id}.sock`);
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  budgetMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for a condition');
}

export function waitForFile(path: string, budgetMs?: number): Promise<void> {
  return waitFor(async () => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }, budgetMs);
}

/** A pause long enough for an in-process socket round trip to land. */
export function tick(ms = 50): Promise<unknown> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A fresh copy of a module, so one process can play several windows: the
 * extension-host modules hold their state at module scope, exactly as a real
 * extension host does.
 */
export async function freshModule<T>(loader: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return loader();
}

/** The context shape these modules read: a storage location and disposables. */
export function fakeContext(dir: string): never {
  return { globalStorageUri: { fsPath: dir }, subscriptions: [] } as never;
}

/**
 * One window as the link sees it: what its webviews would answer, what it was
 * asked to do to its own terminals, and what the broker sent it. Shared by both
 * suites, which each need a window on the far end of a real socket.
 */
export function fakeWindow(
  options: {
    entries?: unknown[];
    surfaces?: Record<string, { ptyId: string; cols: number; rows: number }>;
    /** PTY ids this window's own manager holds — what `ownsPty` answers. */
    ownPtyIds?: string[];
  } = {},
) {
  const dataListeners = new Set<(id: string, data: string) => void>();
  const exitListeners = new Set<(id: string, exitCode: number) => void>();
  const streams = createProcessedPtyStreams(
    (listener) => {
      dataListeners.add(listener);
      return () => void dataListeners.delete(listener);
    },
    (listener) => {
      exitListeners.add(listener);
      return () => void exitListeners.delete(listener);
    },
  );
  return {
    entries: options.entries ?? [],
    surfaces: options.surfaces ?? {},
    ownPtyIds: new Set(options.ownPtyIds ?? []),
    writes: [] as Array<{ ptyId: string; data: string }>,
    resizes: [] as Array<{ ptyId: string; cols: number; rows: number }>,
    invalidations: 0,
    /** Commands this window was asked to run for another one, and who asked. */
    forwarded: [] as Array<{ payload: RemoteHostCommand; from: PeerLinkClient }>,
    /** Windows whose sockets closed with commands still outstanding. */
    dropped: [] as PeerLinkClient[],
    /** What came back for commands this window forwarded to its broker. */
    results: [] as RemoteHostResult[],
    uiEvents: [] as unknown[],
    /** Windows that finished the handshake with this one as the broker. */
    joined: [] as PeerLinkClient[],
    emitData(id: string, data: string) {
      for (const listener of dataListeners) listener(id, data);
    },
    emitExit(id: string, exitCode: number) {
      for (const listener of exitListeners) listener(id, exitCode);
    },
    deps(): PeerLinkDeps {
      return {
        // One generic fan-out covers every peer operation; `op` is opaque to
        // the link, so the window answers zero or more results per request.
        brokerRequest: async (op, params) => {
          if (op === 'directory') return this.entries;
          const { surfaceId } = params as { surfaceId: string };
          const surface = this.surfaces[surfaceId];
          return surface ? [surface] : [];
        },
        invalidateDirectory: () => {
          this.invalidations += 1;
        },
        ownsPty: (ptyId) => this.ownPtyIds.has(ptyId),
        streamPty: streams.streamPty,
        writePty: (ptyId, data) => void this.writes.push({ ptyId, data }),
        resizePty: (ptyId, cols, rows) => void this.resizes.push({ ptyId, cols, rows }),
        handleForwardedCommand: (payload, from) => void this.forwarded.push({ payload, from }),
        dropForwardedCommands: (from) => void this.dropped.push(from),
        deliverCommandResult: (payload) => void this.results.push(payload),
        deliverUiEvent: (payload) => void this.uiEvents.push(payload),
        onClientAuthenticated: (client) => void this.joined.push(client),
      };
    },
  };
}

/** A sink standing in for whatever a routed PTY is streamed into. */
export function fakeSink() {
  return {
    data: [] as string[],
    exits: [] as number[],
    onData(chunk: string) {
      this.data.push(chunk);
    },
    onExit(code: number) {
      this.exits.push(code);
    },
  };
}
