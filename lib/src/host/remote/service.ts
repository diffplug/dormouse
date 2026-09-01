/**
 * Environment-free remote Host service shared by both Node hosts; see
 * `docs/specs/server.md` → "Host side". Surface ownership is injected through
 * {@link HostSurfaceProvider}.
 */

import { hostname } from 'node:os';
import { MAX_PENDING_PAIRINGS, type EnrollmentOffer } from 'server-lib-common';
import { filterAclRecords } from '../../remote/host/acl';
import {
  isEnrollment,
  performEnrollment,
  type HostEnrollCredential,
  type HostEnrollment,
} from '../../remote/host/enrollment';
import type { HostSurfaceProvider } from '../../remote/host/host-surface-provider';
import type { PendingPairing } from '../../remote/host/pairing-approval';
import {
  loadPushDevices,
  sendPush,
  PUSH_TEST_TAG,
  PUSH_TEST_TITLE,
  type AlertPushDeps,
} from '../../remote/host/push-delivery';
import { RemoteApiSession } from '../../remote/host/remote-api';
import { RemoteHost, type WebSocketLike } from '../../remote/host/remote-host';
import { originAllowedByConnectSrc } from './connect-src';
import { readEnrollmentOffer } from './enroll-offer';
import type { HostStateStore } from './host-state-store';
import { createSerialQueue } from './serial-queue';
import {
  REMOTE_HOST_EVENT_EVENT,
  REMOTE_HOST_RESULT_EVENT,
  isRemoteHostCommand,
  type AdoptParams,
  type AdoptResult,
  type ApproveParams,
  type DenyParams,
  type EnrollOfferParams,
  type EnrollParams,
  type EnrollResult,
  type HostStatusEvent,
  type PairingQueueEvent,
  type PairingQueueItem,
  type PushDevicesResult,
  type PushParams,
  type PushSendSummary,
  type RemoteHostConsoleStatus,
} from './service-protocol';

export interface RemoteHostServiceOptions {
  store: HostStateStore;
  provider: HostSurfaceProvider;
  /** Emit one of the `remoteHost:*` events to the webview. */
  sendToUi: (event: string, data: unknown) => void;
  /** The CSP-shaped allowlist this build was compiled with (`connect-src.ts`). */
  connectSrc: string;
  createWebSocket?: (url: string) => WebSocketLike;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /**
   * The installer's enrollment offer on this machine, if any. Defaults to the
   * real well-known path (`enroll-offer.ts`); injected by the tests, which must
   * not depend on whether the machine running them has a server installed.
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
 * What a Host with no enrollment reports. One builder, because two processes
 * answer this: the service's own `status`, and the VS Code glue for a window
 * that has no service at all (`vscode-ext/src/remote-host.ts` → `idleStatus`).
 * The origin-only projection of the offer is the security-relevant half — the
 * one-time token is a bearer credential and never enters a webview
 * (`service-protocol.ts` → `RemoteHostConsoleStatus.offer`) — so the two must
 * not drift.
 */
export function unenrolledStatus(offer: EnrollmentOffer | null): RemoteHostConsoleStatus {
  return {
    enrolled: false,
    serverUrl: null,
    hostId: null,
    connection: 'stopped',
    pairedClients: 0,
    suggestedLabel: safeHostname(),
    offer: offer ? { origin: offer.origin } : null,
  };
}

export class RemoteHostService {
  readonly #store: HostStateStore;
  readonly #provider: HostSurfaceProvider;
  readonly #sendToUi: (event: string, data: unknown) => void;
  readonly #connectSrc: string;
  readonly #createWebSocket?: (url: string) => WebSocketLike;
  readonly #fetch?: typeof globalThis.fetch;
  readonly #now: () => number;
  readonly #readOffer: () => Promise<EnrollmentOffer | null>;

  #host: RemoteHost | null = null;
  #enrollment: HostEnrollment | null = null;
  /**
   * Everything that starts or stops the Host runs one at a time on this chain.
   *
   * Each of those reads `#host`, awaits a store round trip, and then acts on
   * what it read — so overlapping them (an activation `start` and a webview's
   * `adopt`, a reconnect during an enroll) lets two of them both see no Host and
   * both build one. The second `RemoteHost` would hold a relay socket nothing
   * has a reference to and could not be stopped, and the two would displace each
   * other on the server forever.
   */
  readonly #serialize = createSerialQueue();
  /** Disposal is terminal: no in-flight store read may resurrect the Host. */
  #disposed = false;
  /**
   * Pairings awaiting local approval, service-side. The webview mirrors a
   * serializable projection of this and answers with its immutable pairing id;
   * the approve/deny closures the `RemoteHost` handed us never leave this
   * process.
   */
  readonly #pairings = new Map<string, PendingPairing>();

  constructor(options: RemoteHostServiceOptions) {
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
    if (!this.#allowed(enrollment.serverUrl)) {
      // Enrolled against an origin this build cannot connect to — a binary
      // downgraded from a custom build, or a moved server. Idle rather than
      // connect: the allowlist is the whole boundary (docs/specs/server.md).
      console.warn(
        `[remote-host] enrolled server ${enrollment.serverUrl} is outside this build's allowed sources (${this.#connectSrc}); staying idle`,
      );
      return;
    }
    await this.#startHost(enrollment);
  }

  /** Stop the Host and forget the connection-scoped state. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopHost();
  }

  async handleCommand(raw: unknown): Promise<void> {
    if (this.#disposed || !isRemoteHostCommand(raw)) return;
    const command = raw;
    try {
      const result = await this.#run(command.cmd, command.params);
      if (this.#disposed) return;
      this.#sendToUi(REMOTE_HOST_RESULT_EVENT, { rhId: command.rhId, result });
    } catch (error) {
      if (this.#disposed) return;
      this.#sendToUi(REMOTE_HOST_RESULT_EVENT, {
        rhId: command.rhId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #run(cmd: string, params: unknown): Promise<unknown> {
    switch (cmd) {
      // The ones that start or stop the Host share the lifecycle chain with
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
      case 'adopt':
        return this.#serialize(() => this.#adopt(params as AdoptParams));
      default:
        throw new Error(`unknown remote-host command: ${cmd}`);
    }
  }

  // --- Commands ---

  #enroll(params: EnrollParams): Promise<EnrollResult> {
    return this.#enrollWith(params.serverUrl, { password: params.password }, params.label);
  }

  /**
   * One-click enrollment from the offer an installer left on this machine
   * (`docs/specs/server.md` → "Remote control, in the Settings dialog").
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
      // one-time token on a server the user never reviewed.
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
    serverUrl: string,
    credential: HostEnrollCredential,
    label: string,
  ): Promise<EnrollResult> {
    if (!this.#allowed(serverUrl)) {
      // Refused before the credential leaves the machine — including an offer's
      // token, which is a bearer credential like the password. Self-hosters widen
      // the list in their own build (docs/specs/server.md → "Where a Host may reach a relay server").
      throw new Error(
        `${serverUrl} is outside this build's allowed remote sources (${this.#connectSrc}). ` +
          'A self-host build bakes its own via DORMOUSE_REMOTE_CONNECT_SRC.',
      );
    }
    const enrollment = await performEnrollment(serverUrl, credential, label);
    // Persist before touching the running Host. The credential we just minted
    // exists nowhere else and cannot be minted again from the same exchange — a
    // spent offer's token least of all — so a save that fails after the old Host
    // had been stopped would strand the machine with no Host, a status that says
    // otherwise, and a brand-new `hostToken` lost to the failure. Failing here
    // instead leaves the old Host running and everything it reports still true.
    await this.#store.saveEnrollment(enrollment);
    if (this.#host) {
      // Swapping one running Host for another. The gate the webviews arm their
      // outbound work on is edge-triggered (`enrolled-gate.ts`), and everything
      // it holds — the mirrored pairing queue, the push device list — belongs
      // to the server we are leaving. Without a `false` between the two Hosts
      // the gate never cycles: the Settings dialog keeps naming the old
      // server's devices, and a device fetch already on the wire can land after
      // the swap and put them back.
      this.#stopHost();
      this.#enrollment = null;
      this.#emitStatus();
    }
    await this.#startHost(enrollment);
    return { hostId: enrollment.hostId, serverUrl: enrollment.serverUrl };
  }

  /**
   * **Every await comes first; the snapshot is built after the last suspension
   * point.** A seed `status` that started while un-enrolled can be sitting in
   * the offer-file read when an enroll completes, and the webview's gate is
   * last-writer-wins over the `{ enrolled: true }` event — so a snapshot
   * assembled from an `#enrollment` sampled *before* the read would disarm that
   * gate for a poll interval (`lib/src/remote/host/enrolled-gate.ts`). Reading
   * `#enrollment` only below the read makes the answer name whichever
   * enrollment exists when the answer is made.
   *
   * The read itself is still skipped while enrolled — an enrolled Host has
   * nothing to offer, so the 2 s poll must not stat a file every tick.
   */
  async #status(): Promise<RemoteHostConsoleStatus> {
    const offer = this.#enrollment ? null : await this.#readOffer();
    const enrollment = this.#enrollment;
    if (!enrollment) return unenrolledStatus(offer);
    return {
      enrolled: true,
      serverUrl: enrollment.serverUrl,
      hostId: enrollment.hostId,
      connection: this.#host?.status ?? 'stopped',
      pairedClients: this.#host?.activeRecords.length ?? 0,
      suggestedLabel: safeHostname(),
      offer: null,
    };
  }

  /**
   * Re-open the relay socket now. The only way back from `displaced`: an evicted
   * Host stands down for good rather than fighting the Host that replaced it, so
   * returning has to be asked for.
   *
   * Only the restart takes the lifecycle lease. The status snapshot after it is
   * a plain read — one that may touch the disk for the offer file — and holding
   * the lease across it would queue every enroll/adopt/clear behind that read.
   */
  async #reconnect(): Promise<RemoteHostConsoleStatus> {
    await this.#serialize(async () => {
      if (this.#host) this.#host.start();
      else await this.#start();
    });
    return this.#status();
  }

  async #clearEnrollment(): Promise<Record<string, never>> {
    // The delete first, and nothing else unless it succeeded. Stopping and
    // forgetting the Host ahead of it would report un-enrolled while the
    // credential was still on disk, and the next launch would read it back and
    // let every paired device in again — an un-enrollment the user believes
    // happened is the one thing this command must not get wrong.
    //
    // ACL records stay keyed by their hostId. They are unreachable without an
    // enrollment naming that host, and keeping them means a re-enrollment onto
    // the same hostId does not silently de-pair every device.
    await this.#store.clearEnrollment();
    this.#stopHost();
    this.#enrollment = null;
    this.#emitStatus();
    return {};
  }

  #approve(params: ApproveParams): Record<string, never> {
    this.#pendingPairing(params.clientId, params.pairingId).approve(params.label);
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
    // No Host means no ACL and no server to post to; the ring is simply not
    // pushed. Nothing to report to the webview, which cannot act on it either.
    if (deps) {
      // A push that fails must never break the alert path.
      await sendPush(deps, params.sessionId, params.title).catch((error: unknown) => {
        console.warn('[remote-host] push notification failed', error);
      });
    }
    return {};
  }

  /**
   * The Settings dialog's "Send test push".
   *
   * The inverse of {@link #push} in the one way that matters: nothing is
   * swallowed. A test whose whole purpose is to report an outcome must let the
   * failure through, so an unenrolled machine, an unreachable server, and a
   * fan-out that reached nobody all read differently at the button.
   */
  async #pushTest(): Promise<PushSendSummary> {
    const deps = this.#pushDeps();
    if (!deps) {
      throw new Error('This machine is not connected to a Dormouse server.');
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

  async #adopt(params: AdoptParams): Promise<AdoptResult> {
    const existing = await this.#store.loadEnrollment();
    // A store that keeps nothing across restarts (the dev harness) can run the
    // Host for this session but must not be treated as having taken custody of
    // it: the webview's copy is then the only one that survives.
    const durable = this.#store.persistent;
    let persisted = existing ? durable : false;

    if (!existing && isEnrollment(params.enrollment)) {
      const enrollment = params.enrollment;
      // The same gate as `#enroll`, for the same reason: a Host handed over from
      // an older build's localStorage may name a relay this build is not allowed
      // to reach, and adopting it would connect there anyway.
      if (!this.#allowed(enrollment.serverUrl)) {
        throw new Error(
          `${enrollment.serverUrl} is outside this build's allowed remote sources (${this.#connectSrc}). ` +
            'A self-host build bakes its own via DORMOUSE_REMOTE_CONNECT_SRC.',
        );
      }
      // Records first, enrollment last. A failed ACL write then fails the whole
      // adopt while the store still holds no enrollment, so the next launch
      // re-adopts from the webview's copy and retries cleanly — the other order
      // leaves a Host running with every paired device silently dropped.
      const records = filterAclRecords(enrollment.hostId, params.aclRecords ?? []);
      if (records.length > 0) await this.#store.saveAcl(enrollment.hostId, records);
      await this.#store.saveEnrollment(enrollment);
      persisted = durable;
    }
    // Either way there may now be a Host to run: an adoption just supplied one,
    // and a rejected adoption means the store already had one this service may
    // not have started yet (a webview that reloads before `start()` lands).
    if (!this.#host) await this.#start();
    return { persisted };
  }

  // --- Host lifecycle ---

  #allowed(serverUrl: string): boolean {
    try {
      return originAllowedByConnectSrc(new URL(serverUrl).origin, this.#connectSrc);
    } catch {
      return false;
    }
  }

  async #startHost(enrollment: HostEnrollment): Promise<void> {
    if (this.#disposed) return;
    // Never two. Callers are serialized (see `#serialize`), but a Host left in
    // `#host` here would be dropped without its socket being closed, so the
    // replacement is explicit rather than implied by the assignment below.
    this.#stopHost();
    // The controller wants the ACL synchronously; the store is async because
    // the places it lives are. Read it before constructing, and let saves run
    // in the background — a failed write must not fail the pairing that is
    // already approved and already on the wire.
    const records = await this.#store.loadAcl(enrollment.hostId);
    // Deactivation can land during that store round trip. Disposal is terminal:
    // constructing here would leave a relay socket alive after its owner had
    // dropped the service and could no longer stop it.
    if (this.#disposed) return;
    this.#enrollment = enrollment;
    this.#host = new RemoteHost({
      enrollment,
      createWebSocket: this.#createWebSocket,
      createSession: (opts) =>
        new RemoteApiSession({
          hostId: opts.hostId,
          send: opts.send,
          provider: this.#provider,
        }),
      loadAcl: () => records,
      saveAcl: (hostId, next) => {
        void this.#store.saveAcl(hostId, next).catch((error: unknown) => {
          console.warn('[remote-host] could not persist the ACL', error);
        });
      },
      requestApproval: (pending) => this.#enqueuePairing(pending),
      dismissApproval: (clientId) => this.#resolvePairing(clientId),
      now: this.#now,
    });
    this.#host.start();
    this.#emitStatus();
  }

  /**
   * Tell the webviews whether there is a Host at all. Everything they do *for*
   * one — announcing that the directory may have changed on every pane-state,
   * activity, and focus change, watching for unattended rings — costs a
   * crossing per event on a machine that may never enroll, so they arm on this
   * and idle without it (`lib/src/remote/host/enrolled-gate.ts`).
   *
   * `enrolled` means the same thing as the `status` command's field of that
   * name, which is how a webview seeds before any event arrives.
   */
  #emitStatus(): void {
    if (this.#disposed) return;
    this.#sendToUi(REMOTE_HOST_EVENT_EVENT, this.statusEvent());
  }

  /**
   * The status event as it stands, for a UI that arrived after the last change
   * and so has no event coming (`vscode-ext/src/remote-host.ts` greets a window
   * that joins the broker with it).
   */
  statusEvent(): HostStatusEvent {
    return { name: 'status', enrolled: !!this.#enrollment };
  }

  #stopHost(): void {
    this.#host?.stop();
    this.#host = null;
    // `stop()` dismisses every in-flight pairing, which empties the queue and
    // pushes the empty snapshot; clear defensively in case there was no Host.
    if (this.#pairings.size > 0) {
      this.#pairings.clear();
      this.#emitQueue();
    }
  }

  // --- Pairing queue ---

  #enqueuePairing(pending: PendingPairing): void {
    // Bounded, like the controller's own map: this one is mirrored to the
    // webview in full on every change, so an unbounded queue costs quadratic
    // bridge traffic on top of the memory. `RemoteHost` evicts on its side too;
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
    return [...this.#pairings.values()].map(({ clientId, pairingId, request, requestedAt }) => ({
      clientId,
      pairingId,
      request,
      requestedAt,
    }));
  }

  #emitQueue(): void {
    if (this.#disposed) return;
    this.#sendToUi(REMOTE_HOST_EVENT_EVENT, {
      name: 'pairing-queue',
      queue: this.#queueSnapshot(),
    } satisfies PairingQueueEvent);
  }

  /** Push delivery needs a live Host: the ACL it reads is the running one's. */
  #pushDeps(): AlertPushDeps | null {
    const host = this.#host;
    const enrollment = this.#enrollment;
    if (!host || !enrollment) return null;
    return {
      enrollment,
      activeRecords: () => host.activeRecords,
      fetch: this.#fetch,
    };
  }
}
