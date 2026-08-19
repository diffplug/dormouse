/**
 * The bridge between the Node-resident Host service and the webview that shows
 * its UI. Shared by both ends so the contract cannot drift: the service imports
 * it to dispatch, the webview imports it to speak.
 *
 * Three message kinds, all JSON:
 *
 *   webview → service   `remoteHost:command`  { rhId, cmd, params? }
 *   service → webview   `remoteHost:result`   { rhId, result } | { rhId, error }
 *   service → webview   `remoteHost:ask`      { rhId, op, params }
 *   service → webview   `remoteHost:event`    { name, ... }
 *
 * ⚠ The correlation field is `rhId`, never `requestId`. The standalone Rust
 * bridge swallows any sidecar line whose `data.requestId` matches a pending
 * invoke (`standalone/src-tauri/src/lib.rs`), so a `requestId` here would make
 * results vanish at random.
 *
 * The service asks the webview only what the webview alone knows: what its
 * panes are called and how big its terminals are. Everything else — the relay
 * socket, the enrollment, the ACL, the access decision — is the service's, and
 * a webview answer can never widen it.
 */

import type { PairingRequest } from 'server-lib-common';
import type { RemoteHostStatus } from '../../remote/host/remote-host';

/** Transport event names for what the service sends back. */
export const REMOTE_HOST_RESULT_EVENT = 'remoteHost:result';
export const REMOTE_HOST_ASK_EVENT = 'remoteHost:ask';
export const REMOTE_HOST_EVENT_EVENT = 'remoteHost:event';

/**
 * How long the service waits for the webview to answer an ask before it
 * proceeds with what it has. An attach must not hang on a webview that is
 * mid-reload, and a directory snapshot that misses a pane is recoverable — the
 * next change re-collects.
 */
export const ASK_BUDGET_MS = 1_000;

/** webview → service. `params` is the command's own shape, below. */
export interface RemoteHostCommand {
  rhId: string;
  cmd: string;
  params?: unknown;
}

/** Validate the untrusted edge of either Host bridge before routing a command. */
export function isRemoteHostCommand(value: unknown): value is RemoteHostCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<RemoteHostCommand>;
  return typeof command.rhId === 'string' && typeof command.cmd === 'string';
}

/** service → webview, in reply to a command that has a result. */
export interface RemoteHostResult {
  rhId: string;
  result?: unknown;
  error?: string;
}

/** service → webview: answer with `answer` naming this `rhId`. */
export interface RemoteHostAsk {
  rhId: string;
  op: string;
  params: unknown;
}

/** One pairing awaiting local approval, as the webview mirrors it. */
export interface PairingQueueItem {
  clientId: string;
  /** Immutable ceremony ticket id, echoed by approve/deny. */
  pairingId: string;
  request: PairingRequest;
  requestedAt: number;
}

/**
 * service → webview, unsolicited. The queue snapshot is complete every time:
 * the service is authoritative, so the webview replaces rather than merges.
 */
export interface PairingQueueEvent {
  name: 'pairing-queue';
  queue: PairingQueueItem[];
}

/**
 * service → webview, whenever the Host's lifecycle changes whether there is one
 * at all. What a webview does for the Host costs a crossing per pane-state,
 * activity, and focus change, so an installation that never enrolled must pay
 * none of it (`lib/src/remote/host/enrolled-gate.ts`).
 */
export interface HostStatusEvent {
  name: 'status';
  enrolled: boolean;
}

// --- Command parameter shapes ---

export interface EnrollParams {
  serverUrl: string;
  password: string;
  label: string;
}

export interface ApproveParams {
  clientId: string;
  pairingId: string;
  label?: string;
}

export interface DenyParams {
  clientId: string;
  pairingId: string;
}

/** The webview names the Session and what to call it; recipients are never its call. */
export interface PushParams {
  sessionId: string;
  title: string;
}

/** One-shot hand-off of a webview-persisted Host (see `activation.ts`). */
export interface AdoptParams {
  enrollment: unknown;
  aclRecords: unknown[];
}

/**
 * Whether the service now holds this Host somewhere that survives a restart —
 * because it just wrote the enrollment, or because it already had one of its
 * own. The webview drops its localStorage copy only on `true`: behind an
 * in-memory store (the dev harness with no state directory) that copy is the
 * only one that outlives the process, and clearing it would lose the Host at
 * the next launch.
 */
export interface AdoptResult {
  persisted: boolean;
}

/** Answers an outstanding {@link RemoteHostAsk}; `rhId` is the ask's, not a new one. */
export interface AnswerParams {
  rhId: string;
  results: unknown[];
}

// --- Command results ---

export interface EnrollResult {
  hostId: string;
  serverUrl: string;
}

/**
 * What `window.dormouseRemoteHost.status()` prints. SELF_HOST.md documents these
 * field names, so they are part of the user-facing surface.
 */
export interface RemoteHostConsoleStatus {
  enrolled: boolean;
  serverUrl: string | null;
  hostId: string | null;
  /**
   * The relay socket's state. `displaced` is the one that needs acting on:
   * another Dormouse instance enrolled with the same `hostId` took the relay
   * slot, so this one stood down and no timer will bring it back — `reconnect()`
   * takes the slot back (and displaces the other one in turn).
   */
  connection: RemoteHostStatus;
  pairedClients: number;
}

/**
 * The devices a push would reach, or `null` when no Host is running — which is
 * "nowhere to push", not "the server could not be asked" (`push-devices.ts`).
 */
export type PushDevicesResult = { devices: Array<{ devicePublicKey: string; label: string }> } | null;
