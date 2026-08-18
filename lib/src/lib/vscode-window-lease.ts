/**
 * The decision half of the cross-window Host lease (docs/specs/vscode.md →
 * "Remote Host: store and lease").
 *
 * VS Code runs one extension host per window, so the in-window webview lease
 * cannot see another window. Without a second tier every window elects its own
 * Host, they all connect `/ws/host` with the same enrollment, and the server
 * displaces whoever connected first (`server/src/relay.ts`) — whose `close`
 * handler reconnects and displaces the next one, forever, each window arming
 * its own alarm push.
 *
 * Arbitration therefore has to happen on state every window can see. The I/O
 * half lives in `vscode-ext/src/window-lease.ts`, which keeps a heartbeat
 * record in the extension's `globalStorageUri`; this module holds the rules,
 * which is where the interesting cases are (staleness, self-ownership, a clock
 * that jumped). It is pure so those cases are testable without a filesystem.
 */

/** One window's claim on being the Host, as persisted in the lease file. */
export interface WindowLeaseRecord {
  /** Random per-extension-host id — identifies the window, not the machine. */
  owner: string;
  /** When the owner last proved it was alive, as epoch ms. */
  heartbeatAt: number;
}

/**
 * How long a record outlives its last heartbeat. A window that is killed
 * without running its disposables (a crash, a force-quit) leaves the file
 * behind, so the only thing that frees it is age.
 */
export const LEASE_TTL_MS = 15_000;

/** How often the holder re-stamps its heartbeat, and others re-check. */
export const LEASE_RENEW_MS = 5_000;

export function isWindowLeaseRecord(value: unknown): value is WindowLeaseRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as WindowLeaseRecord;
  return typeof record.owner === 'string' && Number.isFinite(record.heartbeatAt);
}

/**
 * `take` — write our own record; `hold` — ours already, re-stamp it;
 * `wait` — someone else holds a live claim.
 */
export type WindowLeaseAction = 'take' | 'hold' | 'wait';

export function decideWindowLease(
  record: WindowLeaseRecord | null,
  selfId: string,
  now: number,
  ttlMs = LEASE_TTL_MS,
): WindowLeaseAction {
  if (!record) return 'take';
  if (record.owner === selfId) return 'hold';
  // A heartbeat far in the future is as unusable as one far in the past: the
  // clock moved under us, and treating it as live would deadlock every window
  // out of the role until the skew elapsed.
  if (Math.abs(now - record.heartbeatAt) > ttlMs) return 'take';
  return 'wait';
}

/**
 * The filesystem the lease cycle needs, so the protocol can be exercised
 * without one. `settle` is the pause between claiming and believing the claim.
 */
export interface WindowLeaseIo {
  read(): Promise<WindowLeaseRecord | null>;
  write(record: WindowLeaseRecord): Promise<void>;
  now(): number;
  settle(): Promise<void>;
}

/**
 * Run one arbitration cycle and report whether this window holds the role
 * afterwards.
 *
 * A fresh claim is confirmed by re-reading, because two windows can judge the
 * same record stale in the same instant and both write — the file keeps one of
 * them, and the loser must not believe it won. Renewing an existing claim skips
 * that round trip: the record already named us, so a takeover would have to
 * have happened inside this cycle, and the next one catches it.
 *
 * Write failures propagate; a lease you cannot write is one you cannot hold.
 */
export async function runWindowLeaseCycle(
  io: WindowLeaseIo,
  selfId: string,
  ttlMs = LEASE_TTL_MS,
): Promise<boolean> {
  const action = decideWindowLease(await io.read(), selfId, io.now(), ttlMs);
  if (action === 'wait') return false;

  await io.write({ owner: selfId, heartbeatAt: io.now() });
  if (action === 'hold') return true;

  await io.settle();
  const confirmed = await io.read();
  return confirmed?.owner === selfId;
}
