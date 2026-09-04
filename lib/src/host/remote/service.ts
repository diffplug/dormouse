/**
 * Environment-free Burrow service shared by both Node burrows; see
 * `docs/specs/relay.md` → "Burrow side". Surface ownership is injected through
 * {@link BurrowSurfaceProvider}.
 */

import { hostname } from 'node:os';
import {
  API_ROUTES,
  MAX_PENDING_PAIRINGS,
  deriveNoiseStaticPublicKey,
  formatPairingInvitationUrl,
  isSetupTokenResponse,
  mintNoiseStaticKeyPair,
  normalizeOrigin,
  type EnrollmentOffer,
} from 'remote-lib-common';
import {
  performEnrollment,
  type BurrowEnrollCredential,
  type BurrowEnrollment,
} from '../../remote/burrow/enrollment';
import type { BurrowSurfaceProvider } from '../../remote/burrow/burrow-surface-provider';
import { burrowFetch } from '../../remote/burrow/burrow-fetch';
import type { PendingPairing } from '../../remote/burrow/pairing-approval';
import {
  loadPushDevices,
  sendPush,
  PUSH_TEST_TAG,
  PUSH_TEST_TITLE,
  type AlertPushDeps,
} from '../../remote/burrow/push-delivery';
import { RemoteApiSession } from '../../remote/burrow/remote-api';
import {
  BurrowRuntime,
  type InvitationState,
  type PairingOutcome,
  type WebSocketLike,
} from '../../remote/burrow/burrow-runtime';
import { originAllowedByConnectSrc } from './connect-src';
import { readEnrollmentOffer } from './enroll-offer';
import type { BurrowStateStore } from './burrow-state-store';
import { createSerialQueue } from './serial-queue';
import {
  BURROW_EVENT_EVENT,
  BURROW_RESULT_EVENT,
  isBurrowCommand,
  type ApproveParams,
  type DenyParams,
  type EnrollOfferParams,
  type EnrollParams,
  type EnrollResult,
  type BurrowStatusEvent,
  type InvitationEvent,
  type PairingQueueEvent,
  type PairingQueueItem,
  type PushDevicesResult,
  type PushParams,
  type PushSendSummary,
  type BurrowConsoleStatus,
  type SetupQrResult,
} from './service-protocol';

export interface BurrowServiceOptions {
  store: BurrowStateStore;
  provider: BurrowSurfaceProvider;
  /** Emit one of the `burrow:*` events to the webview. */
  sendToUi: (event: string, data: unknown) => void;
  /** The CSP-shaped allowlist this build was compiled with (`connect-src.ts`). */
  connectSrc: string;
  createWebSocket?: (url: string) => WebSocketLike;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /**
   * The installer's enrollment offer on this machine, if any. Defaults to the
   * real well-known path (`enroll-offer.ts`); injected by the tests, which must
   * not depend on whether the machine running them has a Relay installed.
   *
   * **Must never reject** — a failed read is `null`, like a file that is not
   * there. That contract is what lets the status path await it bare, so the
   * spent-offer error in `#enrollOffer` stays the one thing a caller can see go
   * wrong here.
   */
  readOffer?: () => Promise<EnrollmentOffer | null>;
}

/**
 * The hostname, or `''` where the platform will not name itself. `os.hostname`
 * throws on a machine whose name cannot be resolved, and a status read is the
 * last place that may fail — it is what the webview's enrolled gate seeds from.
 */
function safeHostname(): string {
  try {
    return hostname();
  } catch {
    return '';
  }
}

/**
 * What a Burrow with no enrollment reports. One builder, because two processes
 * answer this: the service's own `status`, and the VS Code glue for a window
 * that has no service at all (`vscode-ext/src/burrow.ts` → `idleStatus`).
 * The origin-only projection of the offer is the security-relevant half — the
 * one-time token is a bearer credential and never enters a webview
 * (`service-protocol.ts` → `BurrowConsoleStatus.offer`) — so the two must
 * not drift.
 */
export function unenrolledStatus(offer: EnrollmentOffer | null): BurrowConsoleStatus {
  return {
    enrolled: false,
    relayUrl: null,
    burrowId: null,
    connection: 'stopped',
    pairedClients: 0,
    suggestedLabel: safeHostname(),
    offer: offer ? { origin: offer.origin } : null,
  };
}

export class BurrowService {
  readonly #store: BurrowStateStore;
  readonly #provider: BurrowSurfaceProvider;
  readonly #sendToUi: (event: string, data: unknown) => void;
  readonly #connectSrc: string;
  readonly #createWebSocket?: (url: string) => WebSocketLike;
  readonly #fetch?: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #readOffer: () => Promise<EnrollmentOffer | null>;

  #burrow: BurrowRuntime | null = null;
  #enrollment: BurrowEnrollment | null = null;
  /**
   * Everything that starts or stops the Burrow runs one at a time on this chain.
   *
   * Each of those reads `#burrow`, awaits a store round trip, and then acts on
   * what it read — so overlapping them (an activation `start` and a reconnect
   * during an enroll) lets two of them both see no Burrow and both build one. The second `BurrowRuntime` would hold a relay socket nothing
   * has a reference to and could not be stopped, and the two would displace each
   * other on the Relay forever.
   */
  readonly #serialize = createSerialQueue();
  /** Disposal is terminal: no in-flight store read may resurrect the Burrow. */
  #disposed = false;
  /**
   * Pairings awaiting local approval, service-side. The webview mirrors a
   * serializable projection of this and answers with its immutable pairing id;
   * the approve/deny closures the `BurrowRuntime` handed us never leave this
   * process.
   */
  readonly #pairings = new Map<string, PendingPairing>();

  constructor(options: BurrowServiceOptions) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#sendToUi = options.sendToUi;
    this.#connectSrc = options.connectSrc;
    this.#createWebSocket = options.createWebSocket;
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => Date.now());
    this.#readOffer = options.readOffer ?? (() => readEnrollmentOffer());
  }

  /** Start from a persisted enrollment, if there is one this build may reach. */
  start(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    return this.#serialize(() => this.#start());
  }

  async #start(): Promise<void> {
    const enrollment = await this.#store.loadEnrollment();
    if (!enrollment) return;
    if (!this.#allowed(enrollment.relayUrl)) {
      // Enrolled against an origin this build cannot connect to — a binary
      // downgraded from a custom build, or a moved Relay. Idle rather than
      // connect: the allowlist is the whole boundary (docs/specs/relay.md).
      console.warn(
        `[burrow] enrolled Relay ${enrollment.relayUrl} is outside this build's allowed sources (${this.#connectSrc}); staying idle`,
      );
      return;
    }
    await this.#startBurrow(enrollment);
  }

  /** Stop the Burrow and forget the connection-scoped state. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopBurrow();
  }

  async handleCommand(raw: unknown): Promise<void> {
    if (this.#disposed || !isBurrowCommand(raw)) return;
    const command = raw;
    try {
      const result = await this.#run(command.cmd, command.params);
      if (this.#disposed) return;
      this.#sendToUi(BURROW_RESULT_EVENT, { burrowRequestId: command.burrowRequestId, result });
    } catch (error) {
      if (this.#disposed) return;
      this.#sendToUi(BURROW_RESULT_EVENT, {
        burrowRequestId: command.burrowRequestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #run(cmd: string, params: unknown): Promise<unknown> {
    switch (cmd) {
      // The ones that start or stop the Burrow share the lifecycle chain with
      // `start()`; everything below only reads what they left. `reconnect` takes
      // the lease itself, for just the restart half (see `#reconnect`).
      case 'enroll':
        return this.#serialize(() => this.#enroll(params as EnrollParams));
      case 'enrollOffer':
        return this.#serialize(() => this.#enrollOffer(params as EnrollOfferParams));
      case 'status':
        return this.#status();
      case 'reconnect':
        return this.#reconnect();
      case 'clearEnrollment':
        return this.#serialize(() => this.#clearEnrollment());
      case 'setupQr':
        return this.#setupQr();
      case 'approve':
        return this.#approve(params as ApproveParams);
      case 'deny':
        return this.#deny(params as DenyParams);
      case 'push':
        return this.#push(params as PushParams);
      case 'pushTest':
        return this.#pushTest();
      case 'pushDevices':
        return this.#pushDevices();
      case 'pairingQueue':
        return this.#queueSnapshot();
      default:
        throw new Error(`unknown burrow command: ${cmd}`);
    }
  }

  // --- Commands ---

  #enroll(params: EnrollParams): Promise<EnrollResult> {
    return this.#enrollWith(params.relayUrl, { password: params.password }, params.label);
  }

  /**
   * One-click enrollment from the offer an installer left on this machine
   * (`docs/specs/relay.md` → "Remote control, in the Settings dialog").
   */
  async #enrollOffer(params: EnrollOfferParams): Promise<EnrollResult> {
    const offer = await this.#readOffer();
    if (!offer) {
      throw new Error(
        'There is no enrollment offer on this machine — it may have been redeemed already. ' +
          'Re-run the installer to mint a new one, or enroll with the setup password.',
      );
    }
    if (offer.origin !== params.origin) {
      // The webview echoes the origin its card displayed, and this is where that
      // echo is spent: an installer re-run between the render and the click
      // rewrites the file, and enrolling against the new origin would spend a
      // one-time token on a Relay the user never reviewed.
      throw new Error(
        `The enrollment offer changed — it now names ${offer.origin}, not ${params.origin}. ` +
          'Reopen this dialog to review the new one.',
      );
    }
    return await this.#enrollWith(offer.origin, { enrollToken: offer.token }, params.label);
  }

  /**
   * The one enrollment flow, whichever credential proves the right to it: the
   * allowlist gate, then the exchange, then store-first persistence and the
   * status edge the webview gate needs.
   */
  async #enrollWith(
    relayUrl: string,
    credential: BurrowEnrollCredential,
    label: string,
  ): Promise<EnrollResult> {
    if (!this.#allowed(relayUrl)) {
      // Refused before the credential leaves the machine — including an offer's
      // token, which is a bearer credential like the password. Self-hosters widen
      // the list in their own build (docs/specs/relay.md → "Where a Burrow may reach a Relay").
      throw new Error(
        `${relayUrl} is outside this build's allowed remote sources (${this.#connectSrc}). ` +
          'A self-host build bakes its own via DORMOUSE_REMOTE_CONNECT_SRC.',
      );
    }
    const enrollment = await performEnrollment(relayUrl, credential, label);
    // Persist before touching the running Burrow. The credential we just minted
    // exists nowhere else and cannot be minted again from the same exchange — a
    // spent offer's token least of all — so a save that fails after the old Burrow
    // had been stopped would strand the machine with no Burrow, a status that says
    // otherwise, and a brand-new `burrowToken` lost to the failure. Failing here
    // instead leaves the old Burrow running and everything it reports still true.
    await this.#store.saveEnrollment(enrollment);
    if (this.#burrow) {
      // Swapping one running Burrow for another. The gate the webviews arm their
      // outbound work on is edge-triggered (`enrolled-gate.ts`), and everything
      // it holds — the mirrored pairing queue, the push device list — belongs
      // to the Relay we are leaving. Without a `false` between the two Burrows
      // the gate never cycles: the Settings dialog keeps naming the old
      // Relay's devices, and a device fetch already on the wire can land after
      // the swap and put them back.
      this.#stopBurrow();
      this.#enrollment = null;
      this.#emitStatus();
    }
    await this.#startBurrow(enrollment);
    return { burrowId: enrollment.burrowId, relayUrl: enrollment.relayUrl };
  }

  /**
   * **Every await comes first; the snapshot is built after the last suspension
   * point.** A seed `status` that started while un-enrolled can be sitting in
   * the offer-file read when an enroll completes, and the webview's gate is
   * last-writer-wins over the `{ enrolled: true }` event — so a snapshot
   * assembled from an `#enrollment` sampled *before* the read would disarm that
   * gate for a poll interval (`lib/src/remote/burrow/enrolled-gate.ts`). Reading
   * `#enrollment` only below the read makes the answer name whichever
   * enrollment exists when the answer is made.
   *
   * The read itself is still skipped while enrolled — an enrolled Burrow has
   * nothing to offer, so the 2 s poll must not stat a file every tick.
   */
  async #status(): Promise<BurrowConsoleStatus> {
    const offer = this.#enrollment ? null : await this.#readOffer();
    const enrollment = this.#enrollment;
    if (!enrollment) return unenrolledStatus(offer);
    return {
      enrolled: true,
      relayUrl: enrollment.relayUrl,
      burrowId: enrollment.burrowId,
      connection: this.#burrow?.status ?? 'stopped',
      pairedClients: this.#burrow?.activeRecords.length ?? 0,
      suggestedLabel: safeHostname(),
      offer: null,
    };
  }

  /**
   * Re-open the relay socket now. The only way back from `displaced`: an evicted
   * Burrow stands down for good rather than fighting the Burrow that replaced it, so
   * returning has to be asked for.
   *
   * Only the restart takes the lifecycle lease. The status snapshot after it is
   * a plain read — one that may touch the disk for the offer file — and holding
   * the lease across it would queue every enroll/clear behind that read.
   */
  async #reconnect(): Promise<BurrowConsoleStatus> {
    await this.#serialize(async () => {
      if (this.#burrow) this.#burrow.start();
      else await this.#start();
    });
    return this.#status();
  }

  async #clearEnrollment(): Promise<Record<string, never>> {
    // The delete first, and nothing else unless it succeeded. Stopping and
    // forgetting the Burrow ahead of it would report un-enrolled while the
    // credential was still on disk, and the next launch would read it back and
    // let every paired device in again — an un-enrollment the user believes
    // happened is the one thing this command must not get wrong.
    //
    // ACL records stay keyed by their burrowId. They are unreachable without an
    // enrollment naming that burrow, and keeping them means a re-enrollment onto
    // the same burrowId does not silently de-pair every device.
    await this.#store.clearEnrollment();
    this.#stopBurrow();
    this.#enrollment = null;
    this.#emitStatus();
    return {};
  }

  /**
   * Compose this machine's pairing QR: the Relay's single-use setup token,
   * minted over the Burrow's own authenticated channel because this service is
   * the half that holds the bearer, plus an invitation the `BurrowRuntime` mints
   * locally — an id and a one-use X25519 responder key the Relay never sees.
   *
   * The URL is composed here, from the origin this Burrow enrolled against, for
   * the reason `SetupTokenResponse` carries the token alone: a URL minted
   * server-side would be one more place the deployment's own address is decided.
   */
  async #setupQr(): Promise<SetupQrResult> {
    const enrollment = this.#enrollment;
    const burrow = this.#burrow;
    if (!enrollment || !burrow) {
      throw new Error('This machine is not connected to a Dormouse Relay.');
    }
    const response = await burrowFetch(
      { enrollment, fetch: this.#fetch, errorPrefix: 'could not mint a setup code' },
      API_ROUTES.burrowSetupToken,
      // The empty POST body: this endpoint's only input is the bearer, which is
      // what says which Burrow is asking.
      {},
    );
    const body: unknown = await response.json().catch(() => null);
    // Guarded like every other 200 off this wire: an `undefined` token would go
    // into the QR, and an unbounded one throws inside the encoder.
    if (!isSetupTokenResponse(body)) {
      throw new Error('could not mint a setup code: the Relay’s answer was not a setup token.');
    }
    // The Burrow captured above, not whatever `#burrow` holds now: a swap during the
    // round trip means this code belongs to the Relay we just left, so it is
    // dropped rather than minted onto the replacement — which could not verify
    // it anyway, and whose panel must not paint a code for the old Relay.
    if (this.#burrow !== burrow) {
      throw new Error(
        'could not mint a setup code: this machine reconnected to a different Relay.',
      );
    }
    // The invitation, and the half that makes the ceremony unforgeable by the
    // Relay: its private key exists only in this Burrow's memory, and a phone
    // completing IK against the public half has proved it is talking to the
    // machine whose screen it photographed.
    const invitation = await burrow.mintInvitation(body.token, body.expiresAt);
    // `enrollment.origin` is the phone-facing WebAuthn origin — where Pocket is
    // served and where the passkey will be registered — not necessarily the
    // `relayUrl` this Burrow posts to. The formatter refuses a URL too long to
    // scan before any encoder sees it.
    return {
      url: formatPairingInvitationUrl(enrollment.origin, invitation),
      inviteId: invitation.inviteId,
      // The invitation's own expiry, which is never later than the token's.
      expiresAt: invitation.expiry * 1000,
    };
  }

  #approve(params: ApproveParams): Record<string, never> {
    // The code the person typed, straight through. The service never held the
    // expected one — the Burrow compares, once (`service-protocol.ts` →
    // `PairingQueueItem`).
    this.#pendingPairing(params.clientId, params.pairingId).approve(
      typeof params.code === 'string' ? params.code : '',
    );
    return {};
  }

  #deny(params: DenyParams): Record<string, never> {
    this.#pendingPairing(params.clientId, params.pairingId).deny();
    return {};
  }

  /** Resolve an action only against the exact request its modal displayed. */
  #pendingPairing(clientId: string, pairingId: string): PendingPairing {
    const pending = this.#pairings.get(clientId);
    if (!pending || pending.pairingId !== pairingId) {
      throw new Error('pairing request is no longer pending');
    }
    return pending;
  }

  async #push(params: PushParams): Promise<Record<string, never>> {
    const deps = this.#pushDeps();
    // No Burrow means no ACL and no Relay to post to; the ring is simply not
    // pushed. Nothing to report to the webview, which cannot act on it either.
    if (deps) {
      // A push that fails must never break the alert path.
      await sendPush(deps, params.sessionId, params.title).catch((error: unknown) => {
        console.warn('[burrow] push notification failed', error);
      });
    }
    return {};
  }

  /**
   * The Settings dialog's "Send test push".
   *
   * The inverse of {@link #push} in the one way that matters: nothing is
   * swallowed. A test whose whole purpose is to report an outcome must let the
   * failure through, so an unenrolled machine, an unreachable Relay, and a
   * fan-out that reached nobody all read differently at the button.
   */
  async #pushTest(): Promise<PushSendSummary> {
    const deps = this.#pushDeps();
    if (!deps) {
      throw new Error('This machine is not connected to a Dormouse Relay.');
    }
    // A fixed tag, so pressing the button repeatedly replaces the notification
    // on the phone rather than stacking copies — the same per-Session collapse
    // rule the ring path uses, with the test as its own "Session".
    return await sendPush(deps, PUSH_TEST_TAG, PUSH_TEST_TITLE);
  }

  async #pushDevices(): Promise<PushDevicesResult> {
    const deps = this.#pushDeps();
    if (!deps) return null;
    return { devices: await loadPushDevices(deps) };
  }

  // --- Burrow lifecycle ---

  #allowed(relayUrl: string): boolean {
    const origin = normalizeOrigin(relayUrl);
    return origin !== null && originAllowedByConnectSrc(origin, this.#connectSrc);
  }

  /**
   * The Noise static gate. **A Burrow without a usable one does not start**, and
   * so reads as un-enrolled with the Settings dialog offering enrollment again —
   * that is the entire Burrow-state version
   * (`docs/specs/remote-security-model.md` → Burrow identity).
   *
   * Two cases, and they end differently on purpose:
   *
   * - **Absent** is an enrollment from before the field existed. Minting is
   *   never retried once it has failed, so a gate without this backfill would
   *   un-enroll a machine over one transient failure. The mint is persisted
   *   before the Burrow starts, so it survives the next launch.
   * - **Present but not corresponding** is a corrupt or hand-edited state file.
   *   Starting anyway would present a Burrow identity every paired Client reads as
   *   *changed*, which looks like a different machine rather than the local
   *   damage it is — so it stays down, loudly, naming the store.
   */
  async #enrolledWithNoiseStatic(enrollment: BurrowEnrollment): Promise<BurrowEnrollment | null> {
    const { noiseStaticPrivateKey, noiseStaticPublicKey } = enrollment;
    if (noiseStaticPrivateKey !== undefined && noiseStaticPublicKey !== undefined) {
      try {
        if ((await deriveNoiseStaticPublicKey(noiseStaticPrivateKey)) === noiseStaticPublicKey) {
          return enrollment;
        }
      } catch {
        // Falls through to the same refusal: a private half that will not import
        // is as unusable as one that names a different public point.
      }
      console.warn(
        `[burrow] the stored Noise static for ${enrollment.burrowId} does not match its public half; ` +
          'this machine\'s remote-control state is corrupt. Enroll again to replace it.',
      );
      return null;
    }
    let material;
    try {
      material = await mintNoiseStaticKeyPair();
    } catch (error) {
      console.warn('[burrow] could not mint this machine\'s Noise static key', error);
      return null;
    }
    const backfilled: BurrowEnrollment = {
      ...enrollment,
      noiseStaticPrivateKey: material.privateKeyPkcs8,
      noiseStaticPublicKey: material.publicKey,
    };
    // Persisted first, for the reason enrollment persists first: a Burrow running
    // on an identity no restart can recover is one every paired Client would
    // have to pair with again after a reboot.
    await this.#store.saveEnrollment(backfilled);
    return backfilled;
  }

  async #startBurrow(incoming: BurrowEnrollment): Promise<void> {
    if (this.#disposed) return;
    const enrollment = await this.#enrolledWithNoiseStatic(incoming);
    if (!enrollment || this.#disposed) return;
    // Never two. Callers are serialized (see `#serialize`), but a Burrow left in
    // `#burrow` here would be dropped without its socket being closed, so the
    // replacement is explicit rather than implied by the assignment below.
    this.#stopBurrow();
    // The controller wants the ACL synchronously; the store is async because
    // the places it lives are. Read it before constructing, and let saves run
    // in the background — a failed write must not fail the pairing that is
    // already approved and already on the wire.
    const records = await this.#store.loadAcl(enrollment.burrowId);
    // Deactivation can land during that store round trip. Disposal is terminal:
    // constructing here would leave a relay socket alive after its owner had
    // dropped the service and could no longer stop it.
    if (this.#disposed) return;
    this.#enrollment = enrollment;
    this.#burrow = new BurrowRuntime({
      enrollment,
      createWebSocket: this.#createWebSocket,
      createSession: (opts) =>
        new RemoteApiSession({
          burrowId: opts.burrowId,
          send: opts.send,
          provider: this.#provider,
        }),
      loadAcl: () => records,
      saveAcl: (burrowId, next) => {
        void this.#store.saveAcl(burrowId, next).catch((error: unknown) => {
          console.warn('[burrow] could not persist the ACL', error);
        });
      },
      requestApproval: (pending) => this.#enqueuePairing(pending),
      dismissApproval: (clientId) => this.#resolvePairing(clientId),
      onInvitationChanged: (inviteId, state, outcome) =>
        this.#emitInvitation(inviteId, state, outcome),
      now: this.#now,
    });
    this.#burrow.start();
    this.#emitStatus();
  }

  /**
   * Tell the webviews whether there is a Burrow at all. Everything they do *for*
   * one — announcing that the directory may have changed on every pane-state,
   * activity, and focus change, watching for unattended rings — costs a
   * crossing per event on a machine that may never enroll, so they arm on this
   * and idle without it (`lib/src/remote/burrow/enrolled-gate.ts`).
   *
   * `enrolled` means the same thing as the `status` command's field of that
   * name, which is how a webview seeds before any event arrives.
   */
  #emitStatus(): void {
    if (this.#disposed) return;
    this.#sendToUi(BURROW_EVENT_EVENT, this.statusEvent());
  }

  /**
   * The status event as it stands, for a UI that arrived after the last change
   * and so has no event coming (`vscode-ext/src/burrow.ts` greets a window
   * that joins the broker with it).
   */
  statusEvent(): BurrowStatusEvent {
    return { name: 'status', enrolled: !!this.#enrollment };
  }

  #stopBurrow(): void {
    this.#burrow?.stop();
    // Invitations go with it: their one-use keys live on the `BurrowRuntime`
    // precisely so a code the old Relay's QR carried cannot complete a
    // handshake against the new one.
    this.#burrow = null;
    // `stop()` dismisses every in-flight pairing, which empties the queue and
    // pushes the empty snapshot; clear defensively in case there was no Burrow.
    if (this.#pairings.size > 0) {
      this.#pairings.clear();
      this.#emitQueue();
    }
  }

  // --- Pairing queue ---

  #enqueuePairing(pending: PendingPairing): void {
    // Bounded, like the controller's own map: this one is mirrored to the
    // webview in full on every change, so an unbounded queue costs quadratic
    // bridge traffic on top of the memory. `BurrowRuntime` evicts on its side too;
    // both are capped because either can be fed independently, and a cap that
    // only one of them honors is not a cap.
    while (this.#pairings.size >= MAX_PENDING_PAIRINGS) {
      const oldest = this.#pairings.keys().next();
      if (oldest.done) break;
      this.#pairings.delete(oldest.value);
    }
    // Coalesce by clientId: a re-sent pair for the same client replaces the old.
    this.#pairings.set(pending.clientId, pending);
    this.#emitQueue();
  }

  #resolvePairing(clientId: string): void {
    if (!this.#pairings.delete(clientId)) return;
    this.#emitQueue();
  }

  #queueSnapshot(): PairingQueueItem[] {
    // Field by field, never a spread: the pending pairing the Burrow handed us
    // carries the approve/deny closures, and a spread would try to serialize
    // them across the bridge. Naming the four is what keeps this projection the
    // whole of what a webview learns.
    return [...this.#pairings.values()].map(({ clientId, pairingId, label, requestedAt }) => ({
      clientId,
      pairingId,
      label,
      requestedAt,
    }));
  }

  /**
   * Announce that an invitation a Settings panel may be displaying changed
   * state, naming it so a panel showing a *different* code stays live.
   */
  #emitInvitation(inviteId: string, state: InvitationState, outcome?: PairingOutcome): void {
    if (this.#disposed) return;
    this.#sendToUi(BURROW_EVENT_EVENT, {
      name: 'invitation',
      inviteId,
      state,
      // Spread rather than always set: this crosses a JSON bridge, and an
      // explicit `outcome: undefined` is a key the VS Code side would drop and
      // the Tauri side would keep, leaving the two burrows sending different
      // events for the same retirement.
      ...(outcome ? { outcome } : {}),
    } satisfies InvitationEvent);
  }

  #emitQueue(): void {
    if (this.#disposed) return;
    this.#sendToUi(BURROW_EVENT_EVENT, {
      name: 'pairing-queue',
      queue: this.#queueSnapshot(),
    } satisfies PairingQueueEvent);
  }

  /** Push delivery needs a live Burrow: the ACL it reads is the running one's. */
  #pushDeps(): AlertPushDeps | null {
    const burrow = this.#burrow;
    const enrollment = this.#enrollment;
    if (!burrow || !enrollment) return null;
    return {
      enrollment,
      activeRecords: () => burrow.activeRecords,
      seal: (clientStaticPublicKey, plaintext) =>
        burrow.sealPushForClient(clientStaticPublicKey, plaintext),
      fetch: this.#fetch,
    };
  }
}
