/**
 * The Pocket protocol client: a UI-free driver of the exact client flow the
 * server's `handshake.test.mjs` exercises (register → signin → pair → connect →
 * challenge → connect2 → msg), but with real `navigator.credentials` and a real
 * IndexedDB device key instead of the simulated harness.
 *
 * Everything external is injected — `fetch`, the {@link WebAuthnClient}, the
 * WebSocket factory, the device key, and localStorage-backed {@link PocketStorage}
 * — so vitest can fake all of it (`pocket-client.test.ts`).
 *
 * Correlation follows the Host's conventions (see `remote/host/remote-api.ts`):
 * a `msg` request is matched by `requestId`; events are matched by `subId`, and
 * for `directory.watch` / `surface.attach` the Host reuses the request's
 * `requestId` as that `subId`, so this client sends those two with
 * `requestId === subId`.
 */

import {
  API_ROUTES,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  SELFHOST_ACCOUNT_ID,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  hashPasskeyPublicKey,
  signDeviceChallenge,
  type ClientFrame,
  type ConnectionFailure,
  type ConnectionRequest,
  type DeviceKeyPair,
  type DirectoryEntry,
  type DirectorySnapshot,
  type HelloResult,
  type HostAclRecord,
  type HostsResponse,
  type PairingRequest,
  type RemoteEventMsg,
  type RemoteResponse,
  type ServerToClientFrame,
  type SetupBeginResponse,
  type SetupFinishResponse,
  type SigninBeginResponse,
  type SigninFinishResponse,
  type TerminalAttachResult,
  type TerminalClosedEvent,
  type TerminalDataEvent,
  type TerminalResizeEvent,
} from 'server-lib-common';
import type { WebAuthnClient } from './webauthn';
import type { RemoteWebSocket } from '../ws';

/** The slice of a WebSocket the client uses; a browser `WebSocket` satisfies it. */
export type PocketSocket = RemoteWebSocket;

/**
 * Persistent per-device state. Passkey public keys are stashed at registration
 * keyed by credential id, because the wire never returns a passkey's public key
 * on sign-in — so pairing/connecting can only build its request on the device
 * that created the passkey (a documented POC limitation).
 */
export interface PocketStorage {
  getPasskeyPublicKey(credentialId: string): string | null;
  setPasskeyPublicKey(credentialId: string, publicKey: string): void;
  isPaired(hostId: string): boolean;
  markPaired(hostId: string): void;
}

export interface PocketClientDeps {
  /** Prepended to API routes; `''` for same-origin (the served app). */
  readonly baseUrl?: string;
  /** Base for the `/ws/client` URL, e.g. `wss://host`; derived from origin in the app. */
  readonly wsBase: string;
  readonly fetch: typeof fetch;
  readonly webauthn: WebAuthnClient;
  readonly createWebSocket: (url: string) => PocketSocket;
  /** This device's key; memoized after the first call. */
  readonly deviceKey: () => Promise<DeviceKeyPair>;
  readonly storage?: PocketStorage;
}

/** Terminal stream callbacks for {@link PocketClient.attach}. */
export interface TerminalHandlers {
  /** Base64url PTY output bytes. */
  onData(bytes: string): void;
  onResize?(cols: number, rows: number): void;
  onClosed?(exitCode?: number): void;
}

export interface ConnectDecision {
  readonly allowed: boolean;
  readonly failures?: readonly ConnectionFailure[];
}

export interface PairResult {
  readonly approved: boolean;
  readonly record?: HostAclRecord;
  readonly error?: string;
}

interface Waiter {
  resolve(frame: ServerToClientFrame): void;
  reject(error: Error): void;
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

export class PocketClient {
  readonly #baseUrl: string;
  readonly #wsBase: string;
  readonly #fetch: typeof fetch;
  readonly #webauthn: WebAuthnClient;
  readonly #createWebSocket: (url: string) => PocketSocket;
  readonly #deviceKeyFactory: () => Promise<DeviceKeyPair>;
  readonly #storage: PocketStorage;

  #ws: PocketSocket | null = null;
  #sessionToken: string | null = null;
  #rpId: string | null = null;
  /** The credential id from the most recent sign-in (or registration). */
  #credentialId: string | null = null;
  #connectedHostId: string | null = null;
  #deviceKey: DeviceKeyPair | null = null;
  #onHostGone: (() => void) | null = null;

  /** Handshake frames (`pair-result`/`challenge`/`decision`) awaited FIFO by type. */
  readonly #waiters = new Map<string, Waiter[]>();
  /** In-flight remote-api requests, keyed by `requestId`. */
  readonly #pending = new Map<string, PendingRequest>();
  /** Live event subscriptions, keyed by `subId`. */
  readonly #events = new Map<string, (event: RemoteEventMsg) => void>();

  constructor(deps: PocketClientDeps) {
    this.#baseUrl = deps.baseUrl ?? '';
    this.#wsBase = deps.wsBase;
    this.#fetch = deps.fetch;
    this.#webauthn = deps.webauthn;
    this.#createWebSocket = deps.createWebSocket;
    this.#deviceKeyFactory = deps.deviceKey;
    this.#storage = deps.storage ?? localStoragePocketStorage();
  }

  get sessionToken(): string | null {
    return this.#sessionToken;
  }

  get connectedHostId(): string | null {
    return this.#connectedHostId;
  }

  isPaired(hostId: string): boolean {
    return this.#storage.isPaired(hostId);
  }

  /** Notified when the Host drops (a `host-gone` frame or a closed socket). */
  setOnHostGone(callback: (() => void) | null): void {
    this.#onHostGone = callback;
  }

  // --- Account: first-time setup + sign-in ---------------------------------

  /** First-time setup: password-gated passkey registration. Follow with {@link signin}. */
  async setup(password: string, label: string): Promise<SetupFinishResponse> {
    const begin = await this.#api<SetupBeginResponse>(API_ROUTES.setupBegin, { password });
    this.#rpId = begin.rpId;
    const registration = await this.#webauthn.registerPasskey(
      begin.challenge,
      begin.rpId,
      begin.accountId,
    );
    const finish = await this.#api<SetupFinishResponse>(API_ROUTES.setupFinish, {
      password,
      credentialId: registration.credentialId,
      publicKey: registration.publicKey,
      clientDataJSON: registration.clientDataJSON,
      label,
    });
    // Stash the public key so this device can later build pairing/connect
    // requests (the wire never hands it back on sign-in).
    this.#storage.setPasskeyPublicKey(registration.credentialId, registration.publicKey);
    this.#credentialId = registration.credentialId;
    return finish;
  }

  /** Sign in with a discoverable passkey; keeps the session token in memory. */
  async signin(): Promise<SigninFinishResponse> {
    const begin = await this.#api<SigninBeginResponse>(API_ROUTES.signinBegin, {});
    this.#rpId = begin.rpId;
    const assertion = await this.#webauthn.getAssertion(begin.challenge, begin.rpId);
    const finish = await this.#api<SigninFinishResponse>(API_ROUTES.signinFinish, { assertion });
    this.#sessionToken = finish.sessionToken;
    this.#credentialId = assertion.credentialId;
    return finish;
  }

  async listHosts(): Promise<HostsResponse['hosts']> {
    const response = await this.#api<HostsResponse>(
      API_ROUTES.hosts,
      undefined,
      { method: 'GET', headers: { authorization: `Bearer ${this.#requireToken()}` } },
    );
    return response.hosts;
  }

  // --- Relay socket --------------------------------------------------------

  /** Open the `/ws/client` relay socket; resolves once it is open. */
  openSocket(): Promise<void> {
    const token = this.#requireToken();
    const url = `${this.#wsBase}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${encodeURIComponent(token)}`;
    const ws = this.#createWebSocket(url);
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onFrame((ev as { data?: unknown }).data));
    ws.addEventListener('close', () => this.#onClose());
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('relay socket error')));
      ws.addEventListener('close', () => reject(new Error('relay socket closed before open')));
    });
  }

  // --- Pairing + connect handshake -----------------------------------------

  /** Send a pairing request built from this device's key + passkey; awaits the Host's decision. */
  async pair(hostId: string, label: string): Promise<PairResult> {
    const { credentialId, publicKey } = this.#passkeyForRequest();
    const device = await this.#getDeviceKey();
    const request: PairingRequest = {
      accountId: SELFHOST_ACCOUNT_ID,
      passkeyCredentialId: credentialId,
      passkeyPublicKeyHash: await hashPasskeyPublicKey(publicKey),
      devicePublicKey: device.devicePublicKey,
      requestedLabel: label,
    };
    const awaited = this.#expect('pair-result');
    this.#send({ t: 'pair', hostId, request });
    const frame = (await awaited) as Extract<ServerToClientFrame, { t: 'pair-result' }>;
    if (frame.approved) this.#storage.markPaired(hostId);
    return { approved: frame.approved, record: frame.record, error: frame.error };
  }

  /**
   * Connect to a paired Host: request a challenge, then produce ONE passkey
   * assertion + one device-key signature over it (one biometric prompt), send
   * `connect2`, and await the Host's final decision.
   */
  async connect(hostId: string): Promise<ConnectDecision> {
    const device = await this.#getDeviceKey();
    const challengeAwaited = this.#expect('challenge');
    this.#send({ t: 'connect', hostId });
    const challengeFrame = (await challengeAwaited) as Extract<
      ServerToClientFrame,
      { t: 'challenge' }
    >;
    const challenge = challengeFrame.challenge;

    const assertion = await this.#webauthn.getAssertion(challenge, this.#requireRpId());
    const deviceSignature = await signDeviceChallenge(device.privateKey, {
      hostId,
      challenge,
      devicePublicKey: device.devicePublicKey,
    });
    const publicKey = this.#storage.getPasskeyPublicKey(assertion.credentialId);
    if (!publicKey) throw new Error(PASSKEY_UNAVAILABLE_MESSAGE);

    const request: ConnectionRequest = {
      accountId: SELFHOST_ACCOUNT_ID,
      devicePublicKey: device.devicePublicKey,
      challenge,
      deviceSignature,
      passkey: { publicKey, assertion },
    };
    const decisionAwaited = this.#expect('decision');
    this.#send({ t: 'connect2', hostId, request });
    const decisionFrame = (await decisionAwaited) as Extract<
      ServerToClientFrame,
      { t: 'decision' }
    >;
    if (decisionFrame.allowed) this.#connectedHostId = hostId;
    return { allowed: decisionFrame.allowed, failures: decisionFrame.failures };
  }

  // --- Remote-api v1 -------------------------------------------------------

  hello(): Promise<HelloResult> {
    return this.request<HelloResult>(REMOTE_METHODS.hello, { protocolVersion: 1, viewer: 'phone' });
  }

  /** Subscribe to the directory; returns the `subId` (call {@link unsubscribe} to stop). */
  async watchDirectory(onSnapshot: (entries: DirectoryEntry[]) => void): Promise<string> {
    const { subId } = await this.subscribe(REMOTE_METHODS.directoryWatch, {}, (event) => {
      if (event.event === REMOTE_EVENTS.directorySnapshot) {
        onSnapshot((event.data as DirectorySnapshot).entries);
      }
    });
    return subId;
  }

  /** Attach to a terminal surface with the client's size; streams via {@link TerminalHandlers}. */
  attach(
    surfaceId: string,
    cols: number,
    rows: number,
    handlers: TerminalHandlers,
  ): Promise<{ subId: string; result: TerminalAttachResult }> {
    return this.subscribe<TerminalAttachResult>(
      REMOTE_METHODS.surfaceAttach,
      { surfaceId, cols, rows },
      (event) => {
        switch (event.event) {
          case REMOTE_EVENTS.terminalData:
            handlers.onData((event.data as TerminalDataEvent).bytes);
            return;
          case REMOTE_EVENTS.terminalResize: {
            const data = event.data as TerminalResizeEvent;
            handlers.onResize?.(data.cols, data.rows);
            return;
          }
          case REMOTE_EVENTS.terminalClosed:
            handlers.onClosed?.((event.data as TerminalClosedEvent).exitCode);
            return;
          default:
            return;
        }
      },
    );
  }

  write(surfaceId: string, bytes: string): Promise<unknown> {
    return this.request(REMOTE_METHODS.terminalWrite, { surfaceId, bytes });
  }

  resize(surfaceId: string, cols: number, rows: number): Promise<unknown> {
    return this.request(REMOTE_METHODS.terminalResize, { surfaceId, cols, rows });
  }

  detach(surfaceId: string, subId?: string): Promise<unknown> {
    if (subId) this.unsubscribe(subId);
    return this.request(REMOTE_METHODS.surfaceDetach, { surfaceId });
  }

  /** Correlated request over a `msg` frame; resolves with `result` or rejects on `ok:false`. */
  request<T = unknown>(method: string, params?: unknown, requestId: string = uuid()): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, { resolve: resolve as (r: unknown) => void, reject });
    });
    this.#send({ t: 'msg', data: { requestId, method, params } });
    return promise;
  }

  /** Request that also opens an event subscription (Host reuses `requestId` as `subId`). */
  async subscribe<T = unknown>(
    method: string,
    params: unknown,
    onEvent: (event: RemoteEventMsg) => void,
  ): Promise<{ subId: string; result: T }> {
    const subId = uuid();
    this.#events.set(subId, onEvent);
    try {
      const result = await this.request<T>(method, params, subId);
      return { subId, result };
    } catch (error) {
      this.#events.delete(subId);
      throw error;
    }
  }

  unsubscribe(subId: string): void {
    this.#events.delete(subId);
  }

  close(): void {
    try {
      this.#ws?.close();
    } catch {
      // already closing
    }
    this.#ws = null;
  }

  // --- Internals -----------------------------------------------------------

  async #getDeviceKey(): Promise<DeviceKeyPair> {
    if (!this.#deviceKey) this.#deviceKey = await this.#deviceKeyFactory();
    return this.#deviceKey;
  }

  #passkeyForRequest(): { credentialId: string; publicKey: string } {
    const credentialId = this.#credentialId;
    if (!credentialId) throw new Error('sign in before pairing or connecting');
    const publicKey = this.#storage.getPasskeyPublicKey(credentialId);
    if (!publicKey) throw new Error(PASSKEY_UNAVAILABLE_MESSAGE);
    return { credentialId, publicKey };
  }

  #send(frame: ClientFrame): void {
    if (!this.#ws) throw new Error('relay socket is not open');
    this.#ws.send(JSON.stringify(frame));
  }

  #expect(type: 'pair-result' | 'challenge' | 'decision'): Promise<ServerToClientFrame> {
    return new Promise((resolve, reject) => {
      const list = this.#waiters.get(type) ?? [];
      list.push({ resolve, reject });
      this.#waiters.set(type, list);
    });
  }

  #onFrame(raw: unknown): void {
    let frame: ServerToClientFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : '') as ServerToClientFrame;
    } catch {
      return;
    }
    if (!frame || typeof (frame as { t?: unknown }).t !== 'string') return;
    switch (frame.t) {
      case 'pair-result':
      case 'challenge':
      case 'decision': {
        const waiter = this.#waiters.get(frame.t)?.shift();
        waiter?.resolve(frame);
        return;
      }
      case 'msg':
        this.#onMsg(frame.data);
        return;
      case 'host-gone':
        this.#onHostGone?.();
        this.#rejectAll(new Error('host disconnected'));
        return;
      case 'error':
        this.#rejectAll(new Error(frame.error));
        return;
      default:
        return;
    }
  }

  #onMsg(data: unknown): void {
    const response = data as RemoteResponse;
    if (response && typeof response.requestId === 'string') {
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      this.#pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error ?? 'request failed'));
      return;
    }
    const event = data as RemoteEventMsg;
    if (event && typeof event.subId === 'string') {
      this.#events.get(event.subId)?.(event);
    }
  }

  #onClose(): void {
    this.#connectedHostId = null;
    this.#rejectAll(new Error('relay socket closed'));
  }

  /** Fail every awaited handshake frame and in-flight request (avoids hangs). */
  #rejectAll(error: Error): void {
    for (const list of this.#waiters.values()) for (const waiter of list) waiter.reject(error);
    this.#waiters.clear();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  async #api<T>(route: string, body?: unknown, init?: RequestInit): Promise<T> {
    const method = init?.method ?? 'POST';
    const response = await this.#fetch(`${this.#baseUrl}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
    const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (!response.ok) throw new Error(parsed.error ?? `request failed (${response.status})`);
    return parsed;
  }

  #requireToken(): string {
    if (!this.#sessionToken) throw new Error('sign in first');
    return this.#sessionToken;
  }

  #requireRpId(): string {
    if (!this.#rpId) throw new Error('rpId unknown — begin a sign-in or setup first');
    return this.#rpId;
  }
}

export const PASSKEY_UNAVAILABLE_MESSAGE =
  "This device does not hold the passkey's public key, so it cannot pair or connect. " +
  'Pair from the device that first created the passkey (POC limitation).';

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

/** localStorage-backed {@link PocketStorage}; touches storage only when called. */
export function localStoragePocketStorage(): PocketStorage {
  const PASSKEY_PREFIX = 'dormouse-pocket:passkey:';
  const PAIRED_PREFIX = 'dormouse-pocket:paired:';
  return {
    getPasskeyPublicKey: (credentialId) =>
      globalThis.localStorage.getItem(PASSKEY_PREFIX + credentialId),
    setPasskeyPublicKey: (credentialId, publicKey) =>
      globalThis.localStorage.setItem(PASSKEY_PREFIX + credentialId, publicKey),
    isPaired: (hostId) => globalThis.localStorage.getItem(PAIRED_PREFIX + hostId) === '1',
    markPaired: (hostId) => globalThis.localStorage.setItem(PAIRED_PREFIX + hostId, '1'),
  };
}
