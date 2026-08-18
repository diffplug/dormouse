/**
 * The lease's filesystem half. The rules are unit-tested in
 * `lib/src/lib/vscode-window-lease.test.ts`; this drives two independent module
 * instances — standing in for two VS Code windows — against a real directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type LeaseModule = typeof import('../src/window-lease');

let dir: string;
const opened: LeaseModule[] = [];

/** A separate module instance, so each behaves like its own extension host. */
async function openWindow(): Promise<LeaseModule> {
  vi.resetModules();
  const mod: LeaseModule = await import('../src/window-lease');
  mod.initWindowLease({ globalStorageUri: { fsPath: dir }, subscriptions: [] } as never);
  opened.push(mod);
  return mod;
}

async function waitFor(predicate: () => boolean, budgetMs = 3_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the lease');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dormouse-lease-'));
});

afterEach(async () => {
  for (const mod of opened) await mod.disposeWindowLease();
  opened.length = 0;
  await rm(dir, { recursive: true, force: true });
});

describe('window lease over a real directory', () => {
  it('acquires when nothing holds it, and records an owner', async () => {
    const window = await openWindow();
    window.ensureWindowLease(() => {});

    await waitFor(() => window.holdsWindowLease());
    const record = JSON.parse(await readFile(join(dir, 'remote-host.lease.json'), 'utf8'));
    expect(typeof record.owner).toBe('string');
    expect(record.heartbeatAt).toBeGreaterThan(0);
  });

  it('grants the role to exactly one of two windows', async () => {
    const first = await openWindow();
    first.ensureWindowLease(() => {});
    await waitFor(() => first.holdsWindowLease());

    const second = await openWindow();
    second.ensureWindowLease(() => {});
    // Long enough for a claim-and-verify cycle to have run and lost.
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(first.holdsWindowLease()).toBe(true);
    expect(second.holdsWindowLease()).toBe(false);
  });

  it('hands the role over when the holder disposes', async () => {
    const first = await openWindow();
    first.ensureWindowLease(() => {});
    await waitFor(() => first.holdsWindowLease());

    const second = await openWindow();
    const changes: boolean[] = [];
    second.ensureWindowLease((held) => changes.push(held));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(second.holdsWindowLease()).toBe(false);

    // Closing the holder must not leave the role stranded until the TTL.
    await first.disposeWindowLease();
    await waitFor(() => second.holdsWindowLease());
    expect(changes).toContain(true);
  });

  it('reports the role change to its listener exactly once per transition', async () => {
    const window = await openWindow();
    const changes: boolean[] = [];
    window.ensureWindowLease((held) => changes.push(held));
    await waitFor(() => window.holdsWindowLease());
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(changes).toEqual([true]);
  });

  it('re-announces the current role to a second caller without restarting', async () => {
    const window = await openWindow();
    window.ensureWindowLease(() => {});
    await waitFor(() => window.holdsWindowLease());

    const seen: boolean[] = [];
    window.ensureWindowLease((held) => seen.push(held));
    expect(seen).toEqual([true]);
  });

  it('does nothing before it is told where to store the record', async () => {
    vi.resetModules();
    const mod: LeaseModule = await import('../src/window-lease');
    opened.push(mod);
    mod.ensureWindowLease(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mod.holdsWindowLease()).toBe(false);
  });
});
