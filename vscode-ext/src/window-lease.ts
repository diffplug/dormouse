/**
 * The I/O half of the cross-window Host lease. Rules and rationale live in
 * `lib/src/lib/vscode-window-lease.ts`; this file is the filesystem and timers
 * around them.
 *
 * The shared state is a single JSON record in the extension's
 * `globalStorageUri` — per-extension, shared by every window, and unlike
 * `globalState` it has no cross-window change event to rely on, so ownership is
 * a heartbeat with a TTL rather than a flag. A window that dies without running
 * its disposables leaves the file behind; only staleness frees it.
 *
 * Lazily started: a user who never enrolls a Host should never see this file or
 * its timer, so nothing here runs until a webview claims the `remote-host` role.
 */

import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type * as vscode from 'vscode';

import {
  LEASE_RENEW_MS,
  isWindowLeaseRecord,
  runWindowLeaseCycle,
  type WindowLeaseRecord,
} from '../../lib/src/lib/vscode-window-lease';
import { log } from './log';

const LEASE_FILE = 'remote-host.lease.json';

/**
 * How long to wait before confirming a write landed. Two windows can find the
 * same lease stale and both write; the file ends up with one of them, so the
 * writer re-reads before believing itself the owner.
 */
const CLAIM_VERIFY_MS = 250;

interface LeaseState {
  file: string;
  selfId: string;
  /** Null until the first arbitration cycle reports this window's role. */
  held: boolean | null;
  timer: ReturnType<typeof setInterval> | null;
  watcher: FSWatcher | null;
  onChange: (held: boolean) => void;
  /** A cycle is in flight; overlapping them races their temp files. */
  ticking: boolean;
}

let state: LeaseState | null = null;
let extensionContext: vscode.ExtensionContext | null = null;

/**
 * Hand the lease its storage location. Deliberately does no I/O: a user who
 * never enrolls a Host should never see the file or its timer, so arbitration
 * does not begin until {@link ensureWindowLease}.
 */
export function initWindowLease(context: vscode.ExtensionContext): void {
  extensionContext = context;
}

async function readRecord(file: string): Promise<WindowLeaseRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return isWindowLeaseRecord(parsed) ? parsed : null;
  } catch {
    // Missing, truncated mid-write, or corrupt — all mean "no live claim".
    return null;
  }
}

/**
 * Write via temp + rename so a reader never sees a half-written record. The
 * temp name is unique per write, not per window: two overlapping writes sharing
 * one name make the second rename fail with ENOENT.
 */
async function writeRecord(current: LeaseState, record: WindowLeaseRecord): Promise<void> {
  const temp = `${current.file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(record), 'utf8');
  await rename(temp, current.file);
}

function setHeld(current: LeaseState, held: boolean): void {
  if (current.held === held || state !== current) return;
  current.held = held;
  log.info(`[window-lease] ${held ? 'acquired' : 'released'} the remote-host role`);
  current.onChange(held);
}

async function tick(current: LeaseState): Promise<void> {
  // `state !== current` is how a disposed lease stops; a separate flag would be
  // a second copy of the same fact.
  if (state !== current || current.ticking) return;
  current.ticking = true;
  try {
    const held = await runWindowLeaseCycle(
      {
        read: () => readRecord(current.file),
        write: (record) => writeRecord(current, record),
        now: () => Date.now(),
        settle: () => new Promise((resolve) => setTimeout(resolve, CLAIM_VERIFY_MS)),
      },
      current.selfId,
    );
    setHeld(current, held);
  } catch (err) {
    // A lease we cannot write is a lease we cannot hold; stand down rather than
    // run a Host this window may not own.
    log.error(`[window-lease] cycle failed: ${String(err)}`);
    setHeld(current, false);
  } finally {
    current.ticking = false;
  }
}

/**
 * Start arbitrating, and report every change in this window's ownership.
 * Idempotent: repeated calls re-use the running lease and re-announce its
 * current state to the new listener.
 */
export function ensureWindowLease(onChange: (held: boolean) => void): void {
  if (state) {
    onChange(state.held ?? false);
    return;
  }
  const context = extensionContext;
  if (!context) return;

  const dir = context.globalStorageUri.fsPath;
  const current: LeaseState = {
    file: join(dir, LEASE_FILE),
    selfId: randomUUID(),
    held: null,
    timer: null,
    watcher: null,
    onChange,
    ticking: false,
  };
  state = current;

  void (async () => {
    // VS Code does not create globalStorageUri until something writes to it.
    await mkdir(dir, { recursive: true }).catch(() => {});
    if (state !== current) return;
    await tick(current);

    current.timer = setInterval(() => void tick(current), LEASE_RENEW_MS);
    try {
      // The heartbeat alone would make a clean handoff take up to a TTL; the
      // watcher turns "the holder released it" into a prompt takeover. Purely
      // an accelerator — correctness is the timer's job.
      current.watcher = watch(dir, (_event, filename) => {
        if (filename && filename !== LEASE_FILE) return;
        // The holder's own heartbeat lands here too, and re-ticking on it turns
        // the heartbeat into a write loop that re-arms itself — ~50x the
        // intended I/O, with overlapping writes colliding and each failure
        // dropping the role. Only a window waiting for the lease needs the
        // accelerator.
        if (current.held === true) return;
        void tick(current);
      });
    } catch {
      // No watcher on this platform/filesystem: the interval still converges.
    }
  })();

  context.subscriptions.push({ dispose: () => void disposeWindowLease() });
}

/** Whether this window currently owns the Host role. */
export function holdsWindowLease(): boolean {
  return state?.held === true;
}

/**
 * Stop arbitrating and, if this window is the owner, hand the role over
 * immediately rather than making the next window wait out the TTL.
 */
export async function disposeWindowLease(): Promise<void> {
  const current = state;
  if (!current) return;
  state = null;
  if (current.timer) clearInterval(current.timer);
  current.watcher?.close();

  if (current.held !== true) return;
  const record = await readRecord(current.file);
  if (record?.owner !== current.selfId) return;
  await unlink(current.file).catch(() => {});
}
