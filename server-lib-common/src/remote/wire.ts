/**
 * The wire contract for the selfhost POC (docs/specs/server.md): HTTP routes
 * and payloads, relay frames, and the terminal-only remote-api v1 messages.
 * Shared by `server`, the Host module in `lib`, and the Pocket UI so the
 * three sides cannot drift — the same pattern as HELLO_ROUTE.
 */

import type { HostAclRecord } from '../security/acl.js';
import type { ConnectionFailure, ConnectionRequest } from '../security/connection.js';
import type { PairingRequest } from '../security/pairing.js';
import type { PasskeyAssertion } from '../security/passkey.js';

// ---------------------------------------------------------------------------
// HTTP API (see server.md "HTTP API")

export const API_ROUTES = {
  setupBegin: '/api/setup/begin',
  setupFinish: '/api/setup/finish',
  signinBegin: '/api/signin/begin',
  signinFinish: '/api/signin/finish',
  hostEnroll: '/api/host/enroll',
  hosts: '/api/hosts',
} as const;

export const WS_ROUTES = {
  host: '/ws/host',
  client: '/ws/client',
} as const;

/** WS auth rides a query parameter (browsers cannot set WS headers). */
export const WS_TOKEN_PARAM = 'token';

/** The selfhost mode has exactly one account. */
export const SELFHOST_ACCOUNT_ID = 'owner';

export interface SetupBeginRequest {
  password: string;
}
export interface SetupBeginResponse {
  /** Base64url challenge for `navigator.credentials.create()`. */
  challenge: string;
  rpId: string;
  accountId: string;
}

export interface SetupFinishRequest {
  password: string;
  /** Base64url credential id (`PublicKeyCredential.id`). */
  credentialId: string;
  /** Base64url SPKI from `response.getPublicKey()`. */
  publicKey: string;
  /** Base64url `response.clientDataJSON` (type `webauthn.create`). */
  clientDataJSON: string;
  label: string;
}
export interface SetupFinishResponse {
  accountId: string;
  credentialId: string;
}

export interface SigninBeginResponse {
  /** Base64url challenge for `navigator.credentials.get()`. */
  challenge: string;
  rpId: string;
}

export interface SigninFinishRequest {
  assertion: PasskeyAssertion;
}
export interface SigninFinishResponse {
  /** Bearer token for `/api/hosts` and the `token` param of /ws/client. */
  sessionToken: string;
  accountId: string;
  expiresAt: number;
}

export interface HostEnrollRequest {
  password: string;
  label: string;
}
export interface HostEnrollResponse {
  hostId: string;
  /** Bearer credential for the `token` param of /ws/host. */
  hostToken: string;
  /** What the Host must enforce as its ConnectionPolicy. */
  origin: string;
  rpId: string;
}

export interface HostsResponse {
  hosts: Array<{ hostId: string; label: string; online: boolean }>;
}

// ---------------------------------------------------------------------------
// Relay frames (see server.md "Relay"). One JSON frame per WS message.
// `clientId` is assigned by the server per client socket; the client itself
// never sees or sends it.

/** Client → server. `msg` is only forwarded once the session is authorized. */
export type ClientFrame =
  | { t: 'pair'; hostId: string; request: PairingRequest }
  | { t: 'connect'; hostId: string }
  | { t: 'connect2'; hostId: string; request: ConnectionRequest }
  | { t: 'msg'; data: unknown };

/** Server → client. */
export type ServerToClientFrame =
  | { t: 'pair-result'; approved: boolean; record?: HostAclRecord; error?: string }
  | { t: 'challenge'; hostId: string; challenge: string; expiresAt: number }
  | { t: 'decision'; allowed: boolean; failures?: readonly ConnectionFailure[] }
  | { t: 'msg'; data: unknown }
  | { t: 'host-gone' }
  | { t: 'error'; error: string };

/** Server → host. */
export type ServerToHostFrame =
  | { t: 'pair'; clientId: string; request: PairingRequest }
  | { t: 'connect'; clientId: string }
  | { t: 'connect2'; clientId: string; request: ConnectionRequest }
  | { t: 'msg'; clientId: string; data: unknown }
  | { t: 'client-gone'; clientId: string };

/** Host → server. */
export type HostFrame =
  | { t: 'pair-result'; clientId: string; approved: boolean; record?: HostAclRecord; error?: string }
  | { t: 'challenge'; clientId: string; challenge: string; expiresAt: number }
  | { t: 'decision'; clientId: string; allowed: boolean; failures?: readonly ConnectionFailure[] }
  | { t: 'msg'; clientId: string; data: unknown };

// ---------------------------------------------------------------------------
// Remote-api v1, terminal-only (see remote-api.md "v1 scope" and server.md).
// These ride inside `msg` frames once a session is authorized.

export interface RemoteRequest {
  requestId: string;
  method: string;
  params?: unknown;
}
export interface RemoteResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}
export interface RemoteEventMsg {
  subId: string;
  event: string;
  data: unknown;
}

export const REMOTE_METHODS = {
  hello: 'hello',
  directoryWatch: 'directory.watch',
  surfaceAttach: 'surface.attach',
  surfaceDetach: 'surface.detach',
  terminalWrite: 'terminal.write',
  terminalResize: 'terminal.resize',
} as const;

export const REMOTE_EVENTS = {
  directorySnapshot: 'directory.snapshot',
  terminalData: 'terminal.data',
  terminalResize: 'terminal.resize',
  terminalSemantic: 'terminal.semantic',
  terminalClosed: 'terminal.closed',
} as const;

export interface HelloParams {
  protocolVersion: 1;
  viewer: 'phone' | 'vr' | 'desktop';
}
export interface HelloResult {
  protocolVersion: 1;
  hostId: string;
  grants: { input: boolean; layout: boolean };
}

/** Terminal-only for the POC: no browser entries, so no `url`. */
export interface DirectoryEntry {
  paneRef: string;
  surfaceId: string;
  type: 'terminal';
  title: string;
  focused: boolean;
  activity?: 'unknown' | 'prompt' | 'editing' | 'running' | 'finished';
  exitCode?: number;
  /**
   * The pane's PTY process is still alive. A registry surface whose process has
   * exited (Dormouse keeps it open showing "[Process exited…]" until closed)
   * reports `alive: false` — distinct from `exitCode`, which is the last
   * shell-integration command's status, not process lifetime.
   */
  alive: boolean;
  cwd?: string;
  ringing: boolean;
  hasTODO: boolean;
}
export interface DirectorySnapshot {
  entries: DirectoryEntry[];
}

export interface AttachParams {
  surfaceId: string;
  cols: number;
  rows: number;
}
export interface TerminalAttachResult {
  cols: number;
  rows: number;
}

export interface TerminalDataEvent {
  /** Base64url PTY output bytes. */
  bytes: string;
}
export interface TerminalResizeEvent {
  cols: number;
  rows: number;
}
export interface TerminalClosedEvent {
  exitCode?: number;
}

export interface TerminalWriteParams {
  surfaceId: string;
  /** Base64url input bytes. */
  bytes: string;
}
export interface TerminalResizeParams {
  surfaceId: string;
  cols: number;
  rows: number;
}

/**
 * Coerce a requested terminal dimension (cols or rows) to a positive integer,
 * falling back to `fallback` when the value is absent or not finite. Shared so
 * the Host api, the client adapter, and the test harness all sanitize sizes the
 * same way.
 */
export function clampTerminalDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}
