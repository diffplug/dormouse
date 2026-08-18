/**
 * Shared scaffolding for the extension-host suites. Both of them need a
 * throwaway `globalStorageUri`, a poll-with-deadline, and a way to make one
 * process behave like two VS Code windows.
 */

import { vi } from 'vitest';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function tempStorageDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dormouse-ext-'));
}

export async function removeDir(dir: string): Promise<void> {
  // Retry ENOTEMPTY: a file landing while `rm` walks the directory fails the
  // rmdir, and these suites are all about modules doing filesystem work.
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
