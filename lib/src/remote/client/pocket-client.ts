/**
 * UI-free Pocket protocol client; `docs/specs/server.md` owns authentication
 * and pairing, while `remote-api.md` owns request/event correlation.
 */

import {
  API_ROUTES,
  PAIRING_STALE_PRESENCE_ERROR,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  SELFHOST_ACCOUNT_ID,
  UNAUTHORIZED_ERROR,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  hashPasskeyPublicKey,
  pushEndpointFingerprint,
  signDeviceChallenge,
  signPushSubscribe,
  type ClientFrame,
  type ConnectionFailure,
  type ConnectionRequest,
  type DeviceKeyPair,
  type DirectoryEntry,
  type DirectorySnapshot,
  type HelloResult,
  type HostAclRecord,
  type HostsResponse,
  type PairStatusQuery,
  type PairingRequest,
  type PushChallengeResponse,
  type PushConfigResponse,
  type PushSubscribeResponse,
  type PushSubscriptionPayload,
  type PushSubscriptionsResponse,
  type ReauthFinishResponse,
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
} from 'server-lib-common';
import type { WebAuthnClient } from './webauthn';
import type { RemoteWebSocket } from '../ws';

/** The slice of a WebSocket the client uses; a browser `WebSocket` satisfies it. */
export type PocketSocket = RemoteWebSocket;

/**
 * Persistent per-device state. Passkey public keys are cached by credential id
 * at registration *and* at sign-in — the Server returns the asserted key — so
 * any browser profile holding a synced passkey can build pair and connect
 * requests, not only the one that performed the registration.
 */
export interface PocketStorage {
  getPasskeyPublicKey(credentialId: string): string | null;
  setPasskeyPublicKey(credentialId: string, publicKey: string): void;
  /** Credential ids this device has stored a public key for (may be empty). */
  knownCredentialIds(): string[];
  isPaired(hostId: string): boolean;
  markPaired(hostId: string): void;
  unmarkPaired(hostId: string): void;
  /**
   * Digest of the delivery address last registered with the Server, or null if
   * this device has never registered one. Per device, not per Host: one
   * service-worker scope holds one subscription, so if it rotates, every Host
   * row for this device is stale at once.
   */
  getRegisteredPushEndpoint(): string | null;
  setRegisteredPushEndpoint(fingerprint: string): void;
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
  onClosed?(exitCode?: number): void;
}

export interface ConnectDecision {
  readonly allowed: boolean;
  readonly failures?: readonly ConnectionFailure[];
  /** True when a denial means the local paired marker is stale and the user can re-pair. */
  readonly pairingStale?: boolean;
}

export interface PairResult {
  readonly approved: boolean;
  readonly record?: HostAclRecord;
  readonly error?: string;
}

/** Shown when the Server no longer accepts our session token. */
export const SESSION_EXPIRED_MESSAGE = 'Your session expired. Sign in again to continue.';

/**
 * The Server rejected our session token, so nothing works until the user signs
 * in again. Distinct from an ordinary failure because the UI must react rather
 * than report: sessions live only in the Server's memory (docs/specs/server.md),
 * so they die on a 12h expiry *and* on every Server restart, and an installed
 * Pocket has no address bar to reload from. Left as a message, the user is
 * stuck holding a dead token with force-quitting the app as the only way out.
 *
 * {@link PocketClient} clears the token before throwing this, so recovery is
 * exactly "sign in again" with the passkey and paired-host markers intact.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE);
    this.name = 'SessionExpiredError';
  }
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

  /**
   * In-flight frame waiters, keyed by what identifies the answer.
   *
   * For the handshake (`pair-result`/`challenge`/`decision`) that is the frame
   * type alone: it awaits exactly one of each in strict sequence and the App's
   * single-flight guard forbids overlap, so at most one waiter per type is ever
   * pending — {@link #expect} throws if a second is registered rather than
   * silently queueing it. Pair-status answers key on the host as well, since
   * the Hosts view asks every online Host at once.
   */
  readonly #waiters = new Map<string, Waiter>();
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

  /**
   * Digest of the delivery address this device last registered, for detecting
   * a push service that rotated the endpoint behind our back. Null until the
   * first successful registration — which reads as "no opinion", so a device
   * that registered before this was recorded is not made to re-register.
   */
  registeredPushEndpoint(): string | null {
    return this.#storage.getRegisteredPushEndpoint();
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
    // Cache immediately so this profile can build pairing/connect requests;
    // sign-in also refreshes this value from the Server's verified response.
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
    // Signing in is enough to pair from here. The Server returns the asserted
    // passkey's public key, so a browser profile that never performed the
    // registration — an iOS Home Screen install, a second browser — can still
    // build pair and connect requests instead of being pushed into creating a
    // redundant second passkey.
    this.#storage.setPasskeyPublicKey(assertion.credentialId, finish.passkeyPublicKey);
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

  // --- Web Push ------------------------------------------------------------

  /**
   * The VAPID public key a browser needs before it can subscribe, or `null`
   * when the server has push disabled. Unauthenticated — the key is public by
   * construction.
   */
  async getPushConfig(): Promise<string | null> {
    const response = await this.#api<PushConfigResponse>(
      API_ROUTES.pushConfig,
      undefined,
      { method: 'GET' },
    );
    return response.applicationServerKey;
  }

  /**
   * The Hosts **this device** is already registered to receive push from.
   *
   * The Server answers with the whole account's registrations and the filter
   * happens here, so there is no endpoint that reports on a `devicePublicKey`
   * the caller does not hold. Lets a reloaded Pocket show "Alerts on." instead
   * of re-offering an action already taken.
   */
  async listPushSubscribedHosts(): Promise<string[]> {
    const response = await this.#api<PushSubscriptionsResponse>(
      API_ROUTES.pushSubscriptions,
      undefined,
      { method: 'GET', headers: { authorization: `Bearer ${this.#requireToken()}` } },
    );
    const { devicePublicKey } = await this.#getDeviceKey();
    return response.subscriptions
      .filter((s) => s.devicePublicKey === devicePublicKey)
      .map((s) => s.hostId);
  }

  /**
   * Register a browser push subscription against `hostId`, signing it with this
   * device's key so the Server can bind it to the same Client identity the
   * Host's ACL records. Subscriptions are per (host, device): a phone paired
   * with two laptops subscribes twice.
   *
   * The signature covers the endpoint, so a captured one cannot be reused to
   * register a different endpoint under this identity.
   */
  async subscribeToPush(
    hostId: string,
    subscription: PushSubscriptionPayload,
  ): Promise<PushSubscribeResponse> {
    const token = this.#requireToken();
    const auth = { authorization: `Bearer ${token}` };
    const { challenge } = await this.#api<PushChallengeResponse>(
      API_ROUTES.pushChallenge,
      undefined,
      { headers: auth },
    );
    const deviceKey = await this.#getDeviceKey();
    const signature = await signPushSubscribe(deviceKey.privateKey, {
      hostId,
      challenge,
      devicePublicKey: deviceKey.devicePublicKey,
      endpoint: subscription.endpoint,
    });
    const result = await this.#api<PushSubscribeResponse>(
      API_ROUTES.pushSubscribe,
      { hostId, devicePublicKey: deviceKey.devicePublicKey, challenge, signature, subscription },
      { headers: auth },
    );
    // Recorded only once the Server has the row, mirroring how `pair` marks a
    // Host paired: this is a note about what the Server holds, not about what
    // the browser minted.
    this.#storage.setRegisteredPushEndpoint(
      await pushEndpointFingerprint(subscription.endpoint),
    );
    return result;
  }

  // --- Relay socket --------------------------------------------------------

  /** True while a live relay socket exists; false after any close. */
  get socketOpen(): boolean {
    return this.#ws !== null;
  }

  /** Open the `/ws/client` relay socket; resolves once it is open. */
  async openSocket(): Promise<void> {
    try {
      await this.#openSocket();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error instanceof SessionExpiredError) throw error;
      await this.#diagnoseSocketFailure(error);
    }
  }

  #openSocket(): Promise<void> {
    const token = this.#requireToken();
    const url = `${this.#wsBase}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${encodeURIComponent(token)}`;
    const ws = this.#createWebSocket(url);
    this.#ws = ws;
    const isCurrent = () => this.#ws === ws;
    ws.addEventListener('message', (ev) => {
      if (!isCurrent()) return;
      this.#onFrame((ev as { data?: unknown }).data);
    });
    ws.addEventListener('close', () => this.#onClose(ws));
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        if (!isCurrent()) {
          reject(new Error('relay socket superseded'));
          return;
        }
        resolve();
      });
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
    let result = await this.#sendPair(hostId, request);
    if (!result.approved && result.error === PAIRING_STALE_PRESENCE_ERROR) {
      // Pairing presence went stale (> PAIRING_PRESENCE_WINDOW_MS since the
      // last server-verified assertion). One WebAuthn prompt refreshes the
      // session's stamp; then retry once. (remote-security-model.md, Pairing.)
      await this.#reauth();
      result = await this.#sendPair(hostId, request);
    }
    if (result.approved) this.#storage.markPaired(hostId);
    return result;
  }

  /**
   * Ask a connected Host whether it already holds an ACL record for this
   * Client, and reconcile the local marker with the answer.
   *
   * The marker alone is a guess — a Host ACL reset, a hand-edited record, or a
   * pairing approved from a different browser profile all leave it wrong — so
   * the Host's answer wins and the cache converges on it. Advisory only: it
   * decides which button the row offers, never whether a connection is allowed
   * (`docs/specs/remote-security-model.md`). Rejects when the Host cannot be
   * asked, which leaves the marker untouched as the fallback.
   */
  async queryPaired(hostId: string): Promise<boolean> {
    const { credentialId } = this.#passkeyForRequest();
    const device = await this.#getDeviceKey();
    const query: PairStatusQuery = {
      passkeyCredentialId: credentialId,
      devicePublicKey: device.devicePublicKey,
    };
    const awaited = this.#expect(pairStatusKey(hostId), PAIR_STATUS_TIMEOUT_MS);
    this.#send({ t: 'pair-status', hostId, query });
    const frame = (await awaited) as Extract<ServerToClientFrame, { t: 'pair-status-result' }>;
    // Write-on-change only: the common answer confirms the marker, and
    // localStorage writes are synchronous.
    if (frame.paired !== this.#storage.isPaired(hostId)) {
      if (frame.paired) this.#storage.markPaired(hostId);
      else this.#storage.unmarkPaired(hostId);
    }
    return frame.paired;
  }

  async #sendPair(hostId: string, request: PairingRequest): Promise<PairResult> {
    const awaited = this.#expect('pair-result');
    this.#send({ t: 'pair', hostId, request });
    const frame = (await awaited) as Extract<ServerToClientFrame, { t: 'pair-result' }>;
    return { approved: frame.approved, record: frame.record, error: frame.error };
  }

  /** Refresh the session's server-verified presence with one WebAuthn prompt. */
  async #reauth(): Promise<void> {
    const auth = { authorization: `Bearer ${this.#requireToken()}` };
    const begin = await this.#api<SigninBeginResponse>(API_ROUTES.reauthBegin, {}, { headers: auth });
    const assertion = await this.#webauthn.getAssertion(begin.challenge, begin.rpId);
    await this.#api<ReauthFinishResponse>(API_ROUTES.reauthFinish, { assertion }, { headers: auth });
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

    // Scope the assertion to credentials this device has a stored public key for.
    // With several synced passkeys for one rpId, an empty allowCredentials lets
    // the OS pick a credential whose public key we never stored — an unverifiable
    // dead end below. An empty list here (first-time flows) preserves discovery.
    const assertion = await this.#webauthn.getAssertion(
      challenge,
      this.#requireRpId(),
      this.#storage.knownCredentialIds(),
    );
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
    const pairingStale =
      !decisionFrame.allowed && hasRecoverablePairingFailure(decisionFrame.failures);
    if (decisionFrame.allowed) {
      this.#connectedHostId = hostId;
    } else if (pairingStale) {
      this.#storage.unmarkPaired(hostId);
    }
    return {
      allowed: decisionFrame.allowed,
      failures: decisionFrame.failures,
      ...(pairingStale ? { pairingStale: true } : {}),
    };
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
    const ws = this.#ws;
    // Tear down BEFORE closing the socket: nulling #ws is what makes #onClose's
    // generation guard reject the close that follows, which is the only thing
    // keeping an intentional close from firing `host-gone`. Real sockets emit
    // that event asynchronously, but test fakes may emit it synchronously from
    // close(), so the ordering has to hold rather than merely usually hold.
    this.#teardown('relay socket closed', { notifyGone: false });
    try {
      ws?.close();
    } catch {
      // already closing
    }
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

  #expect(key: string, timeoutMs?: number): Promise<ServerToClientFrame> {
    if (this.#waiters.has(key)) throw new Error(`already awaiting a '${key}' frame`);
    return new Promise((resolve, reject) => {
      if (timeoutMs === undefined) {
        this.#waiters.set(key, { resolve, reject });
        return;
      }
      // A Host that predates the frame silently drops it, so an undeadlined
      // waiter would strand this key (and throw on the next ask) until the
      // socket died. The deadline reclaims the key; #settle's drop-unawaited
      // guard absorbs an answer that arrives after it.
      const timer = setTimeout(() => {
        this.#waiters.delete(key);
        reject(new Error(`timed out awaiting a '${key}' frame`));
      }, timeoutMs);
      this.#waiters.set(key, {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
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
      case 'decision':
        this.#settle(frame.t, frame);
        return;
      case 'pair-status-result':
        this.#settle(pairStatusKey(frame.hostId), frame);
        return;
      case 'msg':
        this.#onMsg(frame.data);
        return;
      case 'host-gone':
        this.#connectedHostId = null;
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

  /** Hand a frame to whoever is awaiting `key`; an unawaited answer is dropped. */
  #settle(key: string, frame: ServerToClientFrame): void {
    const waiter = this.#waiters.get(key);
    if (!waiter) return;
    this.#waiters.delete(key);
    waiter.resolve(frame);
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

  #onClose(ws: PocketSocket): void {
    // Generation guard, and the whole test for "was this close intentional?":
    // `close()` tears down and nulls #ws *before* calling `ws.close()`, and a
    // reconnect overwrites #ws with the new socket, so neither an intentional
    // close nor a superseded socket's late close gets past this line. Anything
    // that does is the socket dying on us (server restart, network drop).
    if (this.#ws !== ws) return;
    // An unexpected drop of an established session is still host loss — the app
    // must leave the wall instead of idling on a dead stream — even without a
    // `host-gone` frame.
    this.#teardown('relay socket closed', { notifyGone: this.#connectedHostId !== null });
  }

  /**
   * Reset all socket-bound state and fail pending work. The one real difference
   * between an intentional {@link close} and an unexpected drop is whether to
   * fire `onHostGone`, made explicit here via `notifyGone`.
   */
  #teardown(reason: string, { notifyGone }: { notifyGone: boolean }): void {
    this.#ws = null; // never reuse a closed socket; openSocket() makes a fresh one
    this.#connectedHostId = null;
    this.#rejectAll(new Error(reason));
    if (notifyGone) this.#onHostGone?.();
  }

  /** Fail every awaited handshake frame and in-flight request (avoids hangs). */
  #rejectAll(error: Error): void {
    for (const waiter of this.#waiters.values()) waiter.reject(error);
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
    // Only the session gate's 401 means "sign in again" — a wrong setup
    // password and a rejected device signature answer 401 too, and bouncing the
    // user to sign-in for those would be a worse bug than the one this fixes.
    if (response.status === 401 && parsed.error === UNAUTHORIZED_ERROR) {
      // Drop the token here rather than at the call site: every later request
      // and every relay upgrade would fail the same way, and keeping it would
      // let the UI believe it is still signed in.
      this.#sessionToken = null;
      throw new SessionExpiredError();
    }
    if (!response.ok) throw new Error(parsed.error ?? `request failed (${response.status})`);
    return parsed;
  }

  /**
   * Turn a relay-socket failure into a {@link SessionExpiredError} when the
   * session is the reason. A rejected WS upgrade reaches the browser as a bare
   * `error` event with no status, so the only way to tell "session died" from
   * "network is down" is to ask an authenticated route — which answers the
   * question and costs one request on a path that has already failed.
   */
  async #diagnoseSocketFailure(original: Error): Promise<never> {
    if (this.#sessionToken === null) throw original;
    try {
      await this.#api<HostsResponse>(API_ROUTES.hosts, undefined, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.#sessionToken}` },
      });
    } catch (err) {
      if (err instanceof SessionExpiredError) throw err;
      // Probe failed for its own reason — report the socket failure, which is
      // what the user actually hit.
    }
    throw original;
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
  "This app no longer has the signed-in passkey's public key, so it cannot pair or connect. " +
  'Sign in again to restore it.';

const RECOVERABLE_PAIRING_FAILURES = new Set<ConnectionFailure>([
  'passkey-not-paired',
  'device-not-paired',
  'pairing-mismatch',
]);

export function hasRecoverablePairingFailure(
  failures: readonly ConnectionFailure[] | undefined,
): boolean {
  return failures?.some((failure) => RECOVERABLE_PAIRING_FAILURES.has(failure)) ?? false;
}

/** Waiter key for a pair-status answer; several hosts may be in flight at once. */
function pairStatusKey(hostId: string): string {
  return `pair-status:${hostId}`;
}

/**
 * Deadline on the advisory pair-status ask. Generous for a tailnet round trip,
 * short enough that one unanswering Host cannot starve the serial Hosts-view
 * sweep for the whole visit.
 */
const PAIR_STATUS_TIMEOUT_MS = 5_000;

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

/** localStorage-backed {@link PocketStorage}; touches storage only when called. */
export function localStoragePocketStorage(): PocketStorage {
  const PASSKEY_PREFIX = 'dormouse-pocket:passkey:';
  const PAIRED_PREFIX = 'dormouse-pocket:paired:';
  const PUSH_ENDPOINT_KEY = 'dormouse-pocket:push-endpoint';
  return {
    getPasskeyPublicKey: (credentialId) =>
      globalThis.localStorage.getItem(PASSKEY_PREFIX + credentialId),
    setPasskeyPublicKey: (credentialId, publicKey) =>
      globalThis.localStorage.setItem(PASSKEY_PREFIX + credentialId, publicKey),
    knownCredentialIds: () => {
      const store = globalThis.localStorage;
      const ids: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key?.startsWith(PASSKEY_PREFIX)) ids.push(key.slice(PASSKEY_PREFIX.length));
      }
      return ids;
    },
    isPaired: (hostId) => globalThis.localStorage.getItem(PAIRED_PREFIX + hostId) === '1',
    markPaired: (hostId) => globalThis.localStorage.setItem(PAIRED_PREFIX + hostId, '1'),
    unmarkPaired: (hostId) => globalThis.localStorage.removeItem(PAIRED_PREFIX + hostId),
    getRegisteredPushEndpoint: () => globalThis.localStorage.getItem(PUSH_ENDPOINT_KEY),
    setRegisteredPushEndpoint: (fingerprint) =>
      globalThis.localStorage.setItem(PUSH_ENDPOINT_KEY, fingerprint),
  };
}
